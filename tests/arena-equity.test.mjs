// ═══════════════════════════════════════════════════════════════
// tests/arena-equity.test.mjs — el EQUITY INTRADÍA y su gráfica.
//
// Lo que se blinda:
//
//   1. EL MÁXIMO ES EL DE LAS MUESTRAS, y la respuesta lo dice. Con muestreo
//      cada 5 min, un pico entre dos muestras no está. Para la capa de toma de
//      ganancias eso convierte "¿tocó +X%?" en un PISO, no en la respuesta
//      exacta — y un análisis que no lo sepa va a sacar conclusiones de una
//      resolución que no tiene.
//   2. UN EQUITY NO NUMÉRICO NO SE GUARDA COMO 0. Un cero en esta serie se lee
//      como una cuenta vaciada, que es un evento real y grave.
//   3. LA ESCRITURA ES IDEMPOTENTE POR MINUTO: si el cron dispara dos veces en
//      el mismo minuto, no se dibuja un escalón que no existió.
//   4. NO PUEDE TUMBAR EL TICK. Esto cuelga del mismo cron que dispara la red
//      determinista: perder una muestra es perder un punto de una gráfica;
//      tumbar el tick es perder un stop.
//   5. LA GRÁFICA se ejercita, no se grepea.
//
// Correr con `node tests/arena-equity.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serieDe, minutoDe, MUESTREO_MS, snapshotCuenta } from '../api/_lib/arena-equity.js';
import { COLUMNAS_CORRIDA } from '../api/_lib/arena-journal.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) LA SERIE Y SU MÁXIMO ──────────────────────────────────────────
console.log('\n── apertura, máximo y lo que se devolvió ──');
{
  const filas = [
    { minuto: '2026-09-17T13:30:00Z', equity: '100000', cash: '20000', posiciones: 5 },
    { minuto: '2026-09-17T14:00:00Z', equity: '102400', cash: '20000', posiciones: 5 },
    // El pico, a media sesión.
    { minuto: '2026-09-17T15:30:00Z', equity: '103800', cash: '20000', posiciones: 5 },
    { minuto: '2026-09-17T19:55:00Z', equity: '101100', cash: '20000', posiciones: 5 },
  ];
  const s = serieDe(filas);
  ok(s.n === 4, 'los cuatro puntos', String(s.n));
  ok(s.apertura.equity === 100000, 'la apertura es la PRIMERA muestra del día');
  ok(s.maximo.equity === 103800 && s.maximo.ts === '2026-09-17T15:30:00Z',
    'el máximo del día, con la hora a la que pasó — sin la hora, un máximo no se puede cruzar con nada');
  ok(s.maximo.pct_desde_apertura === 3.8,
    'y en % contra la apertura, que es el denominador de "¿llegó a +X% HOY?"', String(s.maximo.pct_desde_apertura));
  ok(s.ultimo.pct_desde_apertura === 1.1, 'el último, también contra la apertura');
  ok(s.devuelto_desde_maximo_pct === -2.601,
    'y cuánto se devolvió desde el pico: es la pregunta que motivó toda la serie',
    String(s.devuelto_desde_maximo_pct));

  // Fuera de orden: la serie NO puede depender de que la DB los entregue ordenados.
  const revuelto = serieDe([filas[3], filas[1], filas[0], filas[2]]);
  ok(revuelto.apertura.equity === 100000 && revuelto.ultimo.equity === 101100,
    'y con las filas revueltas da lo mismo: se ordena por tiempo, no por llegada');
}

console.log('\n── casos que rompen una gráfica ingenua ──');
{
  ok(serieDe([]).n === 0 && serieDe([]).maximo === null,
    'sin muestras no hay máximo: null, no un 0 que se lea como una cuenta vaciada');
  const una = serieDe([{ minuto: '2026-09-17T13:30:00Z', equity: '100000' }]);
  ok(una.apertura.equity === 100000 && una.maximo.equity === 100000 && una.devuelto_desde_maximo_pct === 0,
    'con UNA muestra, apertura = máximo = último y cero devuelto');
  const sucia = serieDe([
    { minuto: '2026-09-17T13:30:00Z', equity: 'no-es-un-numero' },
    { minuto: '2026-09-17T13:35:00Z', equity: '100' },
  ]);
  ok(sucia.n === 1 && sucia.apertura.equity === 100,
    'una fila con equity no numérico se descarta, NO se cuenta como 0');
}

// ── 2) y 3) LA ESCRITURA ─────────────────────────────────────────────
console.log('\n── la muestra se ancla al minuto (idempotencia) ──');
{
  ok(minutoDe(new Date('2026-09-17T14:03:47.812Z')) === '2026-09-17T14:03:00.000Z',
    'los segundos se truncan: dos disparos del cron en el mismo minuto son UN punto',
    minutoDe(new Date('2026-09-17T14:03:47.812Z')));
  const src = readFileSync(new URL('../api/_lib/arena-equity.js', import.meta.url), 'utf8');
  ok(/primary key \(agent_id, minuto\)/.test(src) && /on conflict \(agent_id, minuto\) do nothing/.test(src),
    'y la DB lo hace cumplir: llave por (agente, minuto) y `do nothing` — el primero del minuto gana');
  ok(/if \(!Number\.isFinite\(e\)\) return \{ guardado: false/.test(src),
    'un equity no numérico NO se guarda: un cero acá se lee como una cuenta vaciada');
  ok(/catch \(err\) \{\s*return \{ guardado: false/.test(src),
    'y toda la escritura traga su error y lo devuelve como dato');
}

// ── 4) NO PUEDE TUMBAR EL TICK ───────────────────────────────────────
console.log('\n── la observabilidad no puede costar una operación ──');
{
  const watch = readFileSync(new URL('../api/arena-watch.js', import.meta.url), 'utf8');
  ok(/registrarEquity\(/.test(watch), 'el tick muestrea');
  // `registrarEquity` nunca lanza (todo su cuerpo está en try/catch), así que
  // un fallo de Neon no puede abortar el tick que dispara la red determinista.
  const equity = readFileSync(new URL('../api/_lib/arena-equity.js', import.meta.url), 'utf8');
  const cuerpo = equity.slice(equity.indexOf('export async function registrarEquity'), equity.indexOf('// ── LA SERIE DE UN DÍA'));
  ok(/try \{/.test(cuerpo) && /catch \(err\)/.test(cuerpo),
    'y la función que llama nunca lanza: perder una muestra es perder un punto de una gráfica, tumbar el tick es perder un stop');
  // Y el muestreo va ANTES de las decisiones del tick, con los libros ya leídos.
  ok(watch.indexOf('registrarEquity(') < watch.indexOf('evaluateTriggers('),
    'se muestrea antes de evaluar disparadores: el equity del tick es el de ANTES de lo que el tick haga');
  ok(/equity: \{\s*\n\s*guardadas:/.test(watch),
    'el tick reporta cuántas muestras entraron y cuáles no — un contador que sólo cuenta éxitos hace que una serie con huecos se vea completa');
}

// ── 5) LA RESOLUCIÓN SE DECLARA ──────────────────────────────────────
console.log('\n── el máximo es el de las MUESTRAS, y se dice ──');
{
  const ep = readFileSync(new URL('../api/liga-equity.js', import.meta.url), 'utf8');
  ok(/muestreo:/.test(ep) && /intervalo_ms: MUESTREO_MS/.test(ep),
    'la respuesta publica su resolución');
  ok(/es un PISO/.test(ep),
    'y dice qué significa para "¿tocó +X% hoy?": si las muestras dicen que sí, sí; si dicen que no, pudo haber pasado igual');
  ok(MUESTREO_MS === 300000, 'el intervalo declarado son los 5 min del tick', String(MUESTREO_MS));
  // Sobre el CÓDIGO, no sobre los comentarios: la cabecera nombra arena-watch
  // justamente para decir de dónde salen las muestras.
  const codigo = ep.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/\bbeat\(/.test(codigo) && !/from '\.\/arena-(run|watch)/.test(codigo),
    'y el endpoint no late ni importa nada del camino de decisión');
}

// ── 6) LA GRÁFICA, EJERCITADA ────────────────────────────────────────
console.log('\n── la gráfica dibuja (y no divide por cero) ──');
{
  const html = readFileSync(new URL('../equity.html', import.meta.url), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0]
    .replace('load();', '')
    .replace(/setInterval\([\s\S]*?\},60000\);/, '')
    .replace(/\$\('refreshNote'\)\.textContent=.*?;\n/g, '');
  const shim = `
const nodes={};
function mk(){return{textContent:'',innerHTML:'',value:'',className:'',
  addEventListener(){},querySelectorAll(){return[];},insertAdjacentHTML(){}};}
global.document={getElementById(id){return nodes[id]||(nodes[id]=mk());}};
`;
  const dir = mkdtempSync(join(tmpdir(), 'eq-'));
  const ruta = join(dir, 'page.mjs');
  writeFileSync(ruta, shim + js + '\nexport { chart, normaliza, filaHtml };\n');
  const { chart, normaliza, filaHtml } = await import('file://' + ruta);

  const data = {
    dia: '2026-09-17',
    por_agente: {
      claude: {
        agente: { id: 'claude', nombre: 'Claude', modelo: 'Claude Sonnet 4.6', control: false },
        puntos: [
          { ts: '2026-09-17T13:30:00Z', equity: 100000 },
          { ts: '2026-09-17T15:30:00Z', equity: 103800 },
          { ts: '2026-09-17T19:55:00Z', equity: 101100 },
        ],
        apertura: { ts: '2026-09-17T13:30:00Z', equity: 100000 },
        maximo: { ts: '2026-09-17T15:30:00Z', equity: 103800, pct_desde_apertura: 3.8 },
        ultimo: { ts: '2026-09-17T19:55:00Z', equity: 101100, pct_desde_apertura: 1.1 },
        devuelto_desde_maximo_pct: -2.601, retorno_temporada_pct: 1.1,
      },
    },
  };
  const series = normaliza(data);
  ok(series.length === 1 && series[0].puntos.length === 3, 'la serie se normaliza');
  ok(series[0].maxPunto && series[0].maxPunto.equity === 103800,
    'y el punto del máximo se localiza para marcarlo en la gráfica');

  const svg = chart(series);
  ok(/<svg/.test(svg) && /<path class="line"/.test(svg), 'sale un SVG con su línea');
  ok(/<circle class="peak"/.test(svg), 'con el máximo marcado');
  ok(!/NaN|Infinity/.test(svg), 'y sin NaN ni Infinity en las coordenadas', svg.slice(0, 120));

  // El caso que rompe una gráfica ingenua: UNA sola muestra → rango plano.
  const plana = normaliza({ por_agente: { claude: { ...data.por_agente.claude,
    puntos: [{ ts: '2026-09-17T13:30:00Z', equity: 100000 }] } } });
  const svgPlano = chart(plana);
  ok(/<svg/.test(svgPlano) && !/NaN|Infinity/.test(svgPlano),
    'con una sola muestra el rango es plano y NO se divide por cero — es el primer tick de cada mañana');

  ok(/Sin muestras para este día/.test(chart([])), 'y sin series se dice, en vez de dibujar un marco vacío');

  const fila = filaHtml(series[0]);
  ok(/máximo del día/.test(fila) && /103,800|103800/.test(fila.replace(/,/g, ',')), 'la fila muestra el máximo del día');
  ok(/pico → ahora/.test(fila), 'y cuánto se devolvió desde el pico');
}

// ═══════════════════════════════════════════════════════════════
// EL LIBRO CON EL QUE SE DECIDIÓ, EN ESTRUCTURA.
//
// El camino vivo del contrato objetivo NO escribía `account`: el equity, el
// cash y las posiciones de una ronda viva quedaban SÓLO dentro del texto del
// prompt. Prosa, no dato — y es el estado de ESE día: si no se guarda cuando
// pasa, mañana no existe.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el snapshot del libro ──');
{
  const snap = snapshotCuenta(
    { equity: '101234.5', cash: '20000' },
    [{ symbol: 'nvda', qty: '12', avg_entry_price: '180.6', market_value: '2178', unrealized_plpc: '0.043', current_price: '181.5' }],
  );
  ok(snap.equity === 101234.5 && snap.cash === 20000,
    'equity y cash numéricos: Alpaca los manda como strings y un string no se promedia');
  ok(snap.positions === 1 && snap.holdings.length === 1,
    'la forma VIEJA se conserva (`positions` es un CONTEO) y el detalle va al lado');
  ok(snap.holdings[0].symbol === 'NVDA' && snap.holdings[0].avg_entry_price === 180.6,
    'con el precio de entrada, que es la mitad del contexto de una decisión');
  ok(snap.holdings[0].unrealized_plpc === 0.043,
    'y el P&L al momento de decidir: sin él, "compró NVDA" no dice si ya la tenía ganando');

  // Un campo ausente viaja null, nunca 0.
  const parcial = snapshotCuenta({ equity: '100' }, [{ symbol: 'ZM' }]);
  ok(parcial.cash === null && parcial.holdings[0].avg_entry_price === null,
    'lo que Alpaca no manda viaja null — un 0 en un precio de entrada se lee como una posición regalada');

  // El conteo y el detalle NO pueden diferir.
  const sucio = snapshotCuenta({ equity: '100' }, [{ symbol: 'NVDA' }, {}, { symbol: '' }]);
  ok(sucio.positions === sucio.holdings.length && sucio.positions === 1,
    '`positions` se deriva de `holdings`: un 3 al lado de un holding manda a buscar un bug que no existe');

  ok(snapshotCuenta({}, []).positions === 0 && snapshotCuenta({}, null).holdings.length === 0,
    'y sin posiciones no revienta: una cuenta 100% en cash es un estado normal');
}

console.log('\n── y se escribe en los DOS caminos ──');
{
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  // ── ACTUALIZADA DOS VECES EL 2026-09-26, CON EL MOTIVO ───────────
  // (1) Clavaba la lista de columnas COMPLETA y en orden, y se rompió al
  //     agregar `error` — o sea, al ARREGLAR el bug hermano. Estaba midiendo
  //     la forma del INSERT, no la propiedad.
  // (2) Después el INSERT se fue de arena-run.js entero: `account`, `error` y
  //     `prompt_hash` se habían perdido las tres por tener la lista escrita a
  //     mano dos veces, así que ahora hay UNA constante compartida
  //     (`COLUMNAS_CORRIDA`) y los dos escritores la importan. Ver B41.
  //
  // La propiedad que este archivo cuida sigue siendo la misma —que el camino
  // vivo guarde el libro— y ahora se verifica donde vive: en la constante y en
  // el escritor compartido. La divergencia entre listas la cubre
  // tests/arena-journal-columnas.test.mjs, que nombra la columna que falta.
  ok(COLUMNAS_CORRIDA.includes('account'),
    'el camino VIVO del contrato objetivo escribe `account` — antes tenía 11 columnas y ésta no era una de ellas',
    COLUMNAS_CORRIDA.join(', '));
  const jrn = readFileSync(new URL('../api/_lib/arena-journal.js', import.meta.url), 'utf8');
  ok(/account: json\(row\.account\)/.test(jrn),
    'y le pasa el valor: la columna en la lista sin su parámetro sería el mismo hueco');
  ok(/await escribirCorrida\(/.test(run),
    'y el camino vivo pasa por el escritor compartido, no por un insert propio');
  const shadowLib = readFileSync(new URL('../api/_lib/arena-shadow.js', import.meta.url), 'utf8');
  ok(/alter table arena_shadow_journal add column if not exists account jsonb/.test(shadowLib),
    'y la tabla de PRUEBA gana la columna con una migración idempotente');
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const n = (shadow.match(/account: cuenta/g) || []).length;
  ok(n >= 5,
    'el snapshot va en TODAS las salidas posteriores a leer el libro, incluidas las abortadas: una corrida que falló igual tenía un libro',
    String(n));
}

// ═══════════════════════════════════════════════════════════════
// LA VENTANA DEL RECONCILE PERDÍA ENTRADAS PARA SIEMPRE.
//
// Una orden no conciliada en 7 días se quedaba con `order_status: 'accepted'`
// sin `filled_avg_price` ni `filled_at`: una posición sin precio ni hora de
// entrada, que es justo lo que hace falta para estudiarla después.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el reconcile deja de perder fills ──');
{
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  // Acotado a la función del reconcile: hay OTRAS ventanas de 7 días en el
  // archivo (stops recientes que no llenaron) que son recencia deliberada y no
  // tienen nada que ver con ésta. La reconstrucción de aperturas usa 180 días.
  const reconcile = run.slice(run.indexOf('export async function runArenaReconcile'));
  ok(!/interval '7 days'/.test(reconcile),
    'la ventana de 7 días del reconcile ya no está');
  ok(/RECONCILE_VENTANA_DIAS = Number\(process\.env\.ARENA_RECONCILE_DIAS\) \|\| 60/.test(run),
    'la ventana se ensancha a 60 días y es env-overridable sin deploy');
  // El acotador correcto no es la fecha: es si queda algo por conciliar.
  ok(/from jsonb_array_elements\(actions\) a/.test(run) && /a->>'alpaca_order_id' is not null/.test(run),
    'pero el acotador de verdad es "¿queda una orden viva en esta fila?", no la fecha');
  ok(/coalesce\(a->>'order_status', ''\) <> all\(\$2::text\[\]\)/.test(run),
    'las filas con todo en estado terminal no se traen aunque sean de ayer — el costo en Alpaca no sube');
  ok(/jsonb_typeof\(actions\) = 'array'/.test(run),
    'con guarda de tipo: una fila cuyo `actions` no sea un array reventaría la consulta entera');
  ok(/ventana_dias: RECONCILE_VENTANA_DIAS/.test(run),
    'y el resumen dice con qué ventana corrió: "0 filas" no distingue "nada pendiente" de "la ventana dejó todo afuera"');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
