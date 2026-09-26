// ═══════════════════════════════════════════════════════════════
// tests/arena-journal-columnas.test.mjs — LA LISTA DE COLUMNAS NO SE
// ESCRIBE DOS VECES.
//
// ── POR QUÉ ESTE ARCHIVO, Y POR QUÉ NO ALCANZA CON TENER CUIDADO ─────
// `arena_journal` tuvo DOS escritores de corridas completas con su lista de
// columnas escrita a mano cada uno. La del contrato objetivo se fue quedando
// atrás, UNA COLUMNA POR VEZ, y cada hueco se descubrió por un síntoma
// distinto, meses después:
//
//   `account`      el equity y las posiciones de una ronda viva quedaban solo
//                  dentro del texto del prompt
//   `error`        84 corridas abortadas en diez días con la ficha diciendo
//                  `error: null`; los racimos que cancelaron la sonda de ruta
//                  salieron de la base a mano
//   `prompt_hash`  encontrado el 2026-09-26 al hacer la constante compartida.
//                  Nadie lo había extrañado todavía — que es peor, no mejor
//
// Tres veces el mismo hueco en el mismo lugar. Acordarse falló dos veces.
// Esto es la SEGUNDA MITAD de B41 aplicada a su caso más reincidente: la
// función compartida existe (`escribirCorrida`), y ésta es la prueba que falla
// si alguien vuelve a bifurcarla.
//
// Lo que fija:
//   1. NADIE ESCRIBE UNA CORRIDA CON SU PROPIA LISTA. Un `insert into
//      arena_journal` con las columnas de una corrida tiene que pasar por la
//      constante — y el fallo NOMBRA la columna que falta.
//   2. LAS DIFERENCIAS LEGÍTIMAS ESTÁN DECLARADAS, Y UNA CUARTA FALLA.
//      `arena_shadow_journal` difiere a propósito en tres columnas. Están
//      enumeradas con su motivo; la que aparezca sin declarar rompe.
//   3. LOS ANUNCIOS SON OTRA COSA. Las filas de `agent_id='league'` llevan
//      ocho columnas a propósito: no tienen modelo, ni órdenes, ni libro.
//
// Correr con `node tests/arena-journal-columnas.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { COLUMNAS_CORRIDA, COLUMNAS_ANUNCIO } from '../api/_lib/arena-journal.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const ROOT = new URL('../api/', import.meta.url).pathname;

// Todo `insert into <tabla> (...)` de api/, con su archivo y su lista.
function inserts(tabla) {
  const out = [];
  (function walk(d) {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const src = readFileSync(p, 'utf8');
      const re = new RegExp('insert into ' + tabla + '\\s*\\(([^)]*)\\)', 'g');
      let m;
      while ((m = re.exec(src))) {
        const bruto = m[1];
        out.push({
          file: p.slice(ROOT.length - 4),
          // Un insert que INTERPOLA la constante no tiene lista propia: es el
          // caso bueno. Se marca como tal en vez de intentar parsear el
          // `${...}`, que daría una lista falsa y un fallo que confunde.
          interpolado: bruto.includes('${'),
          cols: bruto.includes('${') ? [] : bruto.split(',').map((c) => c.trim()).filter(Boolean),
        });
      }
    }
  })(ROOT);
  return out;
}

const dif = (a, b) => a.filter((x) => !b.includes(x));

// ── 1) NADIE ESCRIBE UNA CORRIDA A MANO ──────────────────────────────
console.log('\n── los insert de arena_journal ──');
{
  const todos = inserts('arena_journal');
  ok(todos.length > 0, 'se encontraron inserts para inspeccionar', String(todos.length));

  // Un insert que interpola la constante es el caso BUENO y no tiene lista
  // que revisar. Tiene que haber exactamente uno, y en el módulo compartido.
  const compartidos = todos.filter((i) => i.interpolado);
  ok(compartidos.length === 1 && /_lib\/arena-journal\.js$/.test(compartidos[0].file),
    'hay UN insert de corrida y usa la constante compartida',
    compartidos.map((c) => c.file).join(', ') || '(ninguno interpola la constante)');

  // Una CORRIDA escrita A MANO se reconoce por llevar `model`: un anuncio no
  // tiene modelo. No por el número de columnas, que es justo lo que se
  // desincroniza. CUALQUIERA que aparezca acá es la bifurcación volviendo.
  const aMano = todos.filter((i) => !i.interpolado && i.cols.includes('model'));
  ok(aMano.length === 0,
    'nadie escribe una corrida con su propia lista de columnas',
    aMano.length
      ? aMano.map((c) => `${c.file} — le ${dif(COLUMNAS_CORRIDA, c.cols).length ? 'faltan ' + dif(COLUMNAS_CORRIDA, c.cols).join(', ') : 'sobran ' + dif(c.cols, COLUMNAS_CORRIDA).join(', ')}`).join(' · ')
      : undefined);

  const anuncios = todos.filter((i) => !i.interpolado && !i.cols.includes('model'));

  for (const a of anuncios) {
    const faltan = dif(COLUMNAS_ANUNCIO, a.cols);
    const sobran = dif(a.cols, COLUMNAS_ANUNCIO);
    ok(faltan.length === 0 && sobran.length === 0,
      `anuncio en ${a.file}: la forma corta declarada`,
      faltan.length ? 'le faltan ' + faltan.join(', ') : 'le sobran ' + sobran.join(', '));
  }
}

// ── 2) EL ESCRITOR COMPARTIDO USA LA CONSTANTE, NO UNA COPIA ─────────
// Una constante que existe pero que el insert no usa es peor que no tenerla:
// parece resuelto.
console.log('\n── la constante es la que viaja al SQL ──');
{
  const src = readFileSync(new URL('../api/_lib/arena-journal.js', import.meta.url), 'utf8');
  ok(/insert into arena_journal \(\$\{COLUMNAS_CORRIDA\.join\(', '\)\}\)/.test(src),
    'el insert interpola la constante en vez de repetir los nombres');
  ok(/COLUMNAS_CORRIDA\.map\(\(_, i\) => '\$' \+ \(i \+ 1\)\)/.test(src),
    'y los placeholders se derivan de ella: una columna nueva no puede quedar sin su $N');
  ok(/COLUMNAS_CORRIDA\.map\(\(c\) => valores\[c\]\)/.test(src),
    'y los valores se ordenan POR la constante: agregar una columna al medio no desalinea el resto');

  // La que se perdió tres veces, nombrada: si alguien la saca, el fallo la dice.
  for (const c of ['account', 'error', 'prompt_hash']) {
    ok(COLUMNAS_CORRIDA.includes(c),
      `la constante lleva \`${c}\` — se perdió por escribir la lista dos veces`);
  }

  // Los dos escritores del contrato pasan por acá.
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(/import \{ escribirCorrida \} from '\.\/_lib\/arena-journal\.js'/.test(run),
    'arena-run importa el escritor compartido');
  ok((run.match(/await escribirCorrida\(/g) || []).length === 2,
    'y los DOS escritores de corridas lo usan: el de acciones y el del objetivo',
    String((run.match(/await escribirCorrida\(/g) || []).length));
}

// ── 3) LA SOMBRA DIFIERE A PROPÓSITO, Y ESTÁ DECLARADO ───────────────
// `arena_shadow_journal` NO tiene que ser idéntica: es otra tabla y otro
// contrato. Pero la diferencia se DECLARA acá con su motivo, y una cuarta que
// aparezca sin motivo rompe la prueba. Es la única forma de que "difieren a
// propósito" no se vuelva la excusa que tapa el próximo hueco.
console.log('\n── la sombra: qué difiere, y por qué ──');
{
  const DIFERENCIAS_DECLARADAS = {
    // Columnas propias de la sombra (en arena_journal viven dentro de `context`).
    target: 'la sombra tiene el portafolio objetivo como COLUMNA; en arena_journal va dentro de context',
    rebalance: 'ídem: el rebalanceo es columna allá y va en context acá',
    // Y una que la sombra NO tiene.
    actions: 'la sombra NUNCA manda una orden (su broker lanza en toda escritura), así que no hay órdenes que guardar',
  };

  const sombra = inserts('arena_shadow_journal');
  ok(sombra.length === 1, 'un solo escritor para la sombra', String(sombra.length));
  const cols = sombra[0] ? sombra[0].cols : [];

  const soloSombra = dif(cols, COLUMNAS_CORRIDA);
  const soloVivo = dif(COLUMNAS_CORRIDA, cols);
  const sinDeclarar = [...soloSombra, ...soloVivo].filter((c) => !DIFERENCIAS_DECLARADAS[c]);

  ok(sinDeclarar.length === 0,
    'toda diferencia entre el journal vivo y el de sombra está declarada con su motivo',
    sinDeclarar.length
      ? 'SIN DECLARAR: ' + sinDeclarar.join(', ') + ' — o la columna falta de verdad, o hay que decir acá por qué no va'
      : undefined);

  // Y al revés: una diferencia declarada que ya NO existe es un comentario que
  // miente. Se saca cuando se resuelve, no se deja "por las dudas".
  const obsoletas = Object.keys(DIFERENCIAS_DECLARADAS)
    .filter((c) => !soloSombra.includes(c) && !soloVivo.includes(c));
  ok(obsoletas.length === 0,
    'y ninguna diferencia declarada quedó obsoleta',
    obsoletas.length ? 'ya no difieren: ' + obsoletas.join(', ') : undefined);

  // Lo que las DOS tienen que llevar sí o sí. Es el caso que nos costó tres
  // incidentes: la sombra tenía `error` y el vivo no.
  for (const c of ['id', 'run_date', 'agent_id', 'phase', 'status', 'model', 'error', 'account', 'context', 'prompt_hash']) {
    ok(cols.includes(c) && COLUMNAS_CORRIDA.includes(c),
      `\`${c}\` está en los DOS journals`,
      `vivo=${COLUMNAS_CORRIDA.includes(c)} sombra=${cols.includes(c)}`);
  }
}

// ── 4) LA PRUEBA SE ROMPE DE VERDAD ──────────────────────────────────
// Una prueba de listas que no se probó contra una lista rota es una prueba que
// dice que sí a todo.
console.log('\n── y falla cuando tiene que fallar ──');
{
  const rota = COLUMNAS_CORRIDA.filter((c) => c !== 'error');
  const faltan = dif(COLUMNAS_CORRIDA, rota);
  ok(faltan.length === 1 && faltan[0] === 'error',
    'sacando una columna, la comparación la NOMBRA — no dice solo "difieren"', faltan.join(', '));

  const conExtra = [...COLUMNAS_CORRIDA, 'inventada'];
  ok(dif(conExtra, COLUMNAS_CORRIDA).join(',') === 'inventada',
    'y una columna de más también se nombra: los dos sentidos, no solo el que nos mordió');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
