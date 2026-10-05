// ═══════════════════════════════════════════════════════════════════════
// EL SQL DEL MAPA, CONTRA UN POSTGRES DE VERDAD
//
// Por qué existe este archivo: `/api/mercado-mapa` llegó a producción con un
// `filter (where ...)` colgado de un `row_number()`. `FILTER` sólo existe en
// agregados, así que Postgres ni siquiera llegó a planear — reventó en el
// parser con "syntax error at or near filter". Un error de SINTAXIS, el más
// barato de atrapar, y el mapa entero se cayó en el teléfono.
//
// Se coló porque NINGUNA prueba tocaba el SQL: las demás mockean `sql()` y
// verifican el armado, que es lo correcto para la lógica y completamente
// ciego para la consulta. El único que parseaba era Postgres en producción.
//
// Acá no se parsea el texto con una expresión regular —eso atraparía este bug
// y ninguno más—: se levanta un Postgres, se crea el esquema CON LA DDL REAL
// DEL REPO, y se hace `PREPARE` de cada consulta. `PREPARE` parsea Y resuelve
// nombres, así que también falla si una columna no existe o si la DDL y la
// consulta se desincronizan.
//
// SI NO HAY POSTGRES EN LA MÁQUINA, ESTE ARCHIVO FALLA EN VOZ ALTA en lugar de
// saltarse en silencio: una prueba que se auto-desactiva es peor que no
// tenerla, porque deja la suite en verde afirmando algo que no midió. El
// mensaje dice qué instalar. Para saltarla a propósito hay que decirlo:
// SIN_POSTGRES=1.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQL_MAPA_US } from '../api/mercado-mapa.js';
import { SCHEMA_PRECIOS_US } from '../api/_lib/mercado-precios.js';
import { SCHEMA_UNIVERSO_US, SQL_CAP_US } from '../api/mercado-r0.js';

const PUERTO = 55433;

/** El directorio de binarios del Postgres instalado, o null. */
function binDePostgres() {
  const raices = ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt'];
  for (const raiz of raices) {
    if (!existsSync(raiz)) continue;
    for (const v of readdirSync(raiz).sort().reverse()) {
      const bin = join(raiz, v, 'bin');
      if (existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'pg_ctl'))) return bin;
    }
  }
  for (const bin of ['/usr/bin', '/usr/local/bin']) {
    if (existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'pg_ctl'))) return bin;
  }
  return null;
}

/**
 * Los $1/$2/$3 con literales, porque `create table as` no acepta parámetros.
 * Lo que se prueba acá es la FORMA de la consulta; que los parámetros liguen
 * lo verifica el PREPARE de arriba, que sí los declara con su tipo.
 */
const conLiterales = (q) => q.replace(/\$1/g, "'2026-01-01'").replace(/\$2/g, '23');

const SIN_POSTGRES = process.env.SIN_POSTGRES === '1';
const BIN = SIN_POSTGRES ? null : binDePostgres();

test('mercado-mapa: el SQL se prepara contra un Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(
    BIN,
    'no se encontró un Postgres instalado (initdb/pg_ctl). Esta prueba NO se salta sola: ' +
      'el SQL sin verificar fue exactamente cómo el mapa llegó roto a producción. ' +
      'Instalá postgresql (apt install postgresql, o brew install postgresql) — ' +
      'o, si sabés lo que estás haciendo, corré con SIN_POSTGRES=1.',
  );

  const dir = mkdtempSync(join(tmpdir(), 'qd-pg-'));
  const datos = join(dir, 'datos');
  // initdb se niega a correr como root, así que si lo somos delegamos en un
  // usuario sin privilegios. Es la misma configuración en los dos casos.
  const comoRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const USUARIO = 'pgtest';
  const corre = (cmd) => {
    if (!comoRoot) return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return execSync(`su ${USUARIO} -c ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: 'pipe' });
  };
  if (comoRoot) {
    try { execSync(`id -u ${USUARIO}`, { stdio: 'ignore' }); }
    catch { execSync(`useradd -m ${USUARIO}`, { stdio: 'ignore' }); }
    execSync(`chown -R ${USUARIO} ${dir} && chmod 700 ${dir}`);
  }

  t.after(() => {
    try { corre(`${join(BIN, 'pg_ctl')} -D ${datos} -m immediate -w stop`); } catch { /* ya estaba caído */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* da igual */ }
  });

  corre(`${join(BIN, 'initdb')} -D ${datos} -A trust -U postgres`);
  corre(
    `${join(BIN, 'pg_ctl')} -D ${datos} ` +
      `-o "-k ${dir} -p ${PUERTO} -c listen_addresses=''" -l ${join(dir, 'log')} -w start`,
  );

  /** Corre SQL y devuelve la salida; lanza con el error de Postgres si falla. */
  const psql = (sql) =>
    // `-q` es necesario, no cosmético: sin él psql mezcla las etiquetas de
    // comando ("INSERT 0 1150", "SELECT 24") con las filas, y el test contaría
    // ruido como si fueran datos.
    execFileSync(join(BIN, 'psql'), ['-h', dir, '-p', String(PUERTO), '-U', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });

  await t.test('la DDL real del repo crea el esquema', () => {
    // Si la DDL no corre, lo que siga no prueba nada: se para acá.
    psql([...SCHEMA_UNIVERSO_US, ...SCHEMA_PRECIOS_US].map((q) => q + ';').join('\n'));
    const tablas = psql(
      "select table_name from information_schema.tables where table_schema='public' order by 1;",
    ).trim().split('\n');
    assert.deepEqual(tablas, ['mercado_precios_us', 'mercado_universo_us']);
  });

  await t.test('cada consulta del mapa US PREPARA: parsea y resuelve sus columnas', () => {
    // PREPARE es la prueba entera: parsea el texto Y liga cada columna contra
    // el esquema. El `filter` sobre row_number() moría acá, en el parser.
    psql(`prepare universo as ${SQL_MAPA_US.universo};`);
    psql(`prepare precios(date, int) as ${SQL_MAPA_US.precios(true)};`);
  });

  await t.test('SIN la columna `volumen`, el mapa sigue leyendo', async () => {
    // EL CASO QUE HABRÍA TUMBADO PRODUCCIÓN. `volumen` nació con R3(a) y la crea
    // el job de precios; este endpoint sólo LEE y se despliega al mismo tiempo.
    // En la ventana entre el deploy y la primera corrida del job, la consulta
    // pedía una columna que nadie había creado y `/mercado` devolvía
    // "column p.volumen does not exist" — la pantalla entera en blanco.
    // Lo vio Lety en el preview, que comparte base con producción (2026-10-05).
    //
    // Se prueba con una base de verdad SIN la columna, que es como está prod
    // antes del primer job.
    // Cada `psql` abre su propia conexión, así que el `search_path` va en CADA
    // llamada: si no, las tablas se crean en `public` y el caso no se prueba.
    psql('create schema sincol;');
    psql(`set search_path to sincol;
          create table mercado_precios_us (
            symbol text not null, fecha date not null,
            cierre numeric, cierre_ajustado numeric,
            primary key (symbol, fecha));
          create table mercado_universo_us (
            symbol text primary key, nombre text, sector_etf text, market_cap numeric);`);
    // Con la columna nombrada: truena, que es el bug.
    assert.throws(
      () => psql(`set search_path to sincol; prepare p_con(date, int) as ${SQL_MAPA_US.precios(true)};`),
      /volumen/,
      'si esto deja de tronar, la prueba dejó de probar el caso');
    // Sin nombrarla: pasa, y `volumen` llega como null para todas las filas.
    psql(`set search_path to sincol; prepare p_sin(date, int) as ${SQL_MAPA_US.precios(false)};`);
    psql(`set search_path to sincol;
          insert into mercado_universo_us values ('AAA','A','XLK',1e9);
          insert into mercado_precios_us values ('AAA','2026-09-18',100,100);`);
    const filas = psql(`set search_path to sincol;
      ${conLiterales(SQL_MAPA_US.precios(false))};`).trim().split('\n');
    assert.equal(filas.length, 1);
    // symbol|fecha|cierre|cierre_ajustado|volumen — el último campo, vacío.
    assert.match(filas[0], /^AAA\|2026-09-18\|100\|100\|$/, filas[0]);
    psql('set search_path to public; drop schema sincol cascade;');
  });

  await t.test('cada consulta de los jobs de cap PREPARA también', () => {
    // Los jobs que Lety corre a mano no estaban cubiertos, y son los que más
    // cambian: `?job=razon-adr` estrenó una ventana con TRES parámetros y un
    // `$3` sin ligar sólo se habría visto como un 500 en el navegador.
    psql(`prepare insumos_todos as ${SQL_CAP_US.insumos(false)};`);
    psql(`prepare insumos_con_sector as ${SQL_CAP_US.insumos(true)};`);
    psql(`prepare ventana(text[], date, date) as ${SQL_CAP_US.ventana_referencias};`);
    psql(`prepare razon(text[]) as ${SQL_CAP_US.razon_universo};`);
  });

  await t.test('las escrituras del job de EDGAR también PREPARAN', () => {
    // El job escribía con SQL en línea, así que una columna mal escrita no la
    // veía nadie hasta que Lety corriera el job contra producción y recibiera
    // un 500. Ahora las dos sentencias viven en `SQL_CAP_US` y se preparan
    // DESDE AHÍ: copiarlas acá habría dejado que las dos copias se separaran.
    psql(`prepare edgar_conteo(text, numeric, date, date, text, text) as ${SQL_CAP_US.edgar_conteo};`);
    psql(`prepare edgar_clases(text, int, numeric, date) as ${SQL_CAP_US.edgar_clases};`);
  });

  await t.test('con la tabla terminando el VIERNES, la consulta devuelve la serie y el ancla YTD', () => {
    // El caso del reporte: es lunes, la cosecha no guardó la barra de hoy, la
    // tabla termina el viernes. La consulta tiene que traer datos igual.
    psql(`
      insert into mercado_universo_us(symbol, nombre, sector_etf, market_cap)
        select 'S'||g, 'Nombre '||g, 'XLK', 1000000-g from generate_series(1,5) g;
      insert into mercado_precios_us(symbol, fecha, cierre, cierre_ajustado)
        select u.symbol, d::date, 100 + extract(doy from d)/10, 100 + extract(doy from d)/10
          from mercado_universo_us u,
               generate_series(date '2025-11-03', date '2026-09-18', interval '1 day') d
         where extract(isodow from d) < 6;
    `);
    const filas = psql(`
      create temp table r as ${conLiterales(SQL_MAPA_US.precios(true))};
      select symbol || '|' || count(*) || '|' || min(fecha) || '|' || max(fecha)
        from r group by symbol order by symbol;
    `).trim().split('\n');

    assert.equal(filas.length, 5, 'los cinco símbolos traen serie');
    for (const f of filas) {
      const [, n, primera, ultima] = f.split('|');
      // 23 cierres recientes + 1 ancla YTD.
      assert.equal(n, '24');
      assert.equal(primera, '2025-12-31', 'el ancla YTD es el último cierre del año pasado');
      assert.equal(ultima, '2026-09-18', 'la serie termina el viernes, que es lo que hay');
    }
  });

  await t.test('un símbolo sin historia del año pasado NO recibe un ancla YTD inventada', () => {
    // Éste es el motivo del `and previa`. Sin él, la fila 1 del orden sería un
    // cierre de ESTE año haciéndose pasar por ancla, y el YTD saldría corto
    // con etiqueta larga — el bug del % de periodo, otra vez.
    psql(`
      insert into mercado_universo_us(symbol, nombre, sector_etf, market_cap)
        values ('NUEVA', 'Salió a bolsa en agosto', 'XLK', 999999);
      insert into mercado_precios_us(symbol, fecha, cierre, cierre_ajustado)
        select 'NUEVA', d::date, 50, 50
          from generate_series(date '2026-08-03', date '2026-09-18', interval '1 day') d
         where extract(isodow from d) < 6;
    `);
    const previas = psql(`
      create temp table r2 as ${conLiterales(SQL_MAPA_US.precios(true))};
      select count(*) from r2 where symbol = 'NUEVA' and fecha < '2026-01-01';
    `).trim();
    assert.equal(previas, '0', 'ni una fila del año pasado: no hay, y no se inventa');
  });

  await t.test('la consulta NO trae la ventana entera: ~24 filas por símbolo, no ~220', () => {
    // La razón de ser de las funciones de ventana. Con 300 símbolos, traer
    // todo desde diciembre eran ~60,000 filas por petición.
    const total = psql(`
      create temp table r3 as ${conLiterales(SQL_MAPA_US.precios(true))};
      select count(*) from r3;
    `).trim();
    const enTabla = psql('select count(*) from mercado_precios_us;').trim();
    assert.ok(Number(total) <= 6 * 24, `${total} filas para 6 símbolos`);
    assert.ok(Number(total) < Number(enTabla) / 3, `${total} de ${enTabla}: la consulta acota de verdad`);
  });

  await t.test('la ventana de referencias abre a los DOS lados de la captura', () => {
    // Que PREPARE pase no alcanza: la ventana de #259 sólo miraba hacia atrás, y
    // la pregunta "¿hay un cierre vecino que reconcilie?" necesita los dos
    // lados. Acá se mide con filas de verdad, no leyendo el texto de la
    // consulta. (Cada llamada a psql es una sesión nueva, así que la consulta va
    // con literales en vez de un EXECUTE: el PREPARE de arriba ya ligó los tipos.)
    const conFecha = (q, dia) => q
      .replace(/\$1/g, "'{S1}'").replace(/\$2/g, `'${dia}'`).replace(/\$3/g, `'${dia}'`);
    const fechasDe = (dia) => psql(`${conFecha(SQL_CAP_US.ventana_referencias, dia)};`)
      .trim().split('\n').map((l) => l.split('|')[1]).filter(Boolean).sort();

    // La tabla de esta prueba va del 2025-11-03 al 2026-09-18 en días hábiles.
    const alrededorDel10 = fechasDe('2026-09-10');
    assert.ok(alrededorDel10.length > 0, 'la ventana trajo filas');
    assert.ok(alrededorDel10[0] < '2026-09-10', `hacia atrás: ${alrededorDel10[0]}`);
    assert.ok(
      alrededorDel10[alrededorDel10.length - 1] > '2026-09-10',
      `hacia adelante: ${alrededorDel10[alrededorDel10.length - 1]}`,
    );
  });

});
