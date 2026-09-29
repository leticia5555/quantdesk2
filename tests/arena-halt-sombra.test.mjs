// ═══════════════════════════════════════════════════════════════
// tests/arena-halt-sombra.test.mjs — EL FRENO PARA LAS ÓRDENES, NO
// PARA LA VERIFICACIÓN.
//
// LA PREGUNTA (Lety, 2026-09-29, con los siete agentes en `halted = true`
// después de que la T3 arrancara sola): *"¿el halt bloquea el humo? Si es la
// misma función, para correr la prueba tendría que levantar el freno — con el
// de arriba todavía roto. Eso es volver a abrir el agujero justo cuando estoy
// tratando de cerrarlo."*
//
// LA RESPUESTA ES NO, y este archivo la vuelve durable. El día que se
// preguntó, la respuesta era correcta POR ACCIDENTE: el chequeo vivía en
// `runArenaDecide` —un LLAMADOR— y `arena-shadow` no pasaba por ahí. Con dos
// llamadores seguros no había agujero, pero un tercero con `vivo: true` lo
// reabría. Que es textualmente el escenario del que advierte el comentario de
// `runArenaDecide`: *"la guarda va en la función que DECIDE, no sólo en un
// llamador"*.
//
// Ahora el chequeo está DENTRO de `runAgenteObjetivo`, atado a `vivo`.
//
// Lo que fija:
//   1. CON HALT, UNA CORRIDA VIVA NO DECIDE. Sin depender del llamador.
//   2. CON HALT, LA SOMBRA SÍ CORRE. Es lo que hace verificable el sistema
//      sin levantar el freno.
//   3. EL BYPASS ES `vivo`, NO UN PARÁMETRO SUELTO. Para eludir el halt hay
//      que pedir `vivo: false`, y eso trae el broker que lanza en el mismo
//      paquete: la excepción y la garantía son el MISMO valor.
//   4. Y LA LECTURA DEL ESTADO FALLA ABIERTA, a propósito y declarado.
//
// Correr con `node tests/arena-halt-sombra.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { leerEstadoAgente } from '../api/_lib/arena-baseline.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const leer = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const shadow = leer('api/arena-shadow.js');
const run = leer('api/arena-run.js');

// ── 1) LA GUARDA ESTÁ EN LA FUNCIÓN QUE DECIDE ───────────────────────
console.log('\n── el halt vive donde se decide, no en el llamador ──');
{
  const fn = shadow.slice(shadow.indexOf('export async function runAgenteObjetivo'));
  ok(/if \(vivo\) \{\s*\n\s*const estadoHalt = await getArenaState\(agent\.id\);/.test(fn.slice(0, 4000)),
    '`runAgenteObjetivo` chequea el halt cuando corre en vivo');
  ok(/status: 'halted'/.test(fn.slice(0, 4000)),
    'y devuelve un estado NOMBRADO, no una corrida vacía que parezca normal');

  // El llamador sigue chequeando: las dos, no una. Un doble chequeo acá no es
  // redundancia inútil — `runArenaDecide` corta ANTES de pagar el buffet.
  ok(/const estadoHalt = await getArenaState\(agent\.id\);/.test(run),
    'y `runArenaDecide` lo sigue chequeando antes, para no pagar el buffet de un agente detenido');
}

// ── 2) LA SOMBRA CORRE CON EL HALT PUESTO ────────────────────────────
// Ésta es la propiedad que decide el orden de una mañana de reapertura: si el
// humo exigiera levantar el freno, verificar el sistema y protegerlo serían
// incompatibles.
console.log('\n── con los siete detenidos, el humo igual corre ──');
{
  const fn = shadow.slice(shadow.indexOf('export async function runAgenteObjetivo'));
  const bloque = fn.slice(0, 4000);
  ok(/if \(vivo\) \{/.test(bloque) && !/if \(!vivo\)/.test(bloque.slice(bloque.indexOf('if (vivo) {'), bloque.indexOf('if (vivo) {') + 400)),
    'el chequeo está DENTRO de `if (vivo)`: una corrida de sombra ni lo consulta');
  ok(/no puede mandar órdenes, así que el freno no le aplica/.test(bloque),
    'y la respuesta del halt lo dice, para que nadie crea que el humo está bloqueado también');
}

// ── 3) EL BYPASS ES `vivo`, ATADO AL BROKER QUE LANZA ────────────────
// Si el bypass fuera un parámetro aparte (`saltarHalt: true`), cualquiera
// podría pedirlo en una corrida viva. Atado a `vivo`, pedir el bypass es pedir
// el broker que no puede escribir.
console.log('\n── la excepción y la garantía son el mismo valor ──');
{
  ok(/export function runShadowAgent\(args\) \{\s*\n\s*return runAgenteObjetivo\(\{ \.\.\.args, vivo: false \}\);/.test(shadow),
    '`runShadowAgent` fija `vivo: false` de forma literal: el endpoint no puede pedir una corrida viva');
  ok(/const broker = vivo \? alpaca : \(deps\.shadowBroker \|\| shadowBroker\)\(alpaca\)/.test(shadow),
    'y el MISMO `vivo` elige el broker: con `false`, toda escritura LANZA');

  // No hay una segunda puerta.
  ok(!/saltarHalt|skipHalt|ignorarHalt|forzar/.test(shadow),
    'no existe ningún parámetro para saltarse el halt aparte de `vivo`');

  // Y solo hay DOS llamadores: el vivo (que chequea antes) y la sombra.
  const llamadores = (shadow.match(/runAgenteObjetivo\(/g) || []).length
    + (run.match(/runAgenteObjetivo\(/g) || []).length;
  ok(llamadores === 3, 'dos llamadores más la definición: si aparece un tercero, esta línea avisa', String(llamadores));
  ok(/return runAgenteObjetivo\(\{[\s\S]{0,200}vivo: true/.test(run),
    'y el único `vivo: true` está en runArenaDecide, después del halt');
}

// ── 4) LA LECTURA FALLA ABIERTA, Y ESTÁ DECLARADO ────────────────────
// Congelar un agente por un hipo de Neon es peor que dejarlo correr una
// ronda: el breaker se re-evalúa en la siguiente. La dirección de la falla es
// una decisión, así que se verifica.
console.log('\n── si Neon no contesta, no se congela a nadie ──');
{
  const baseline = leer('api/_lib/arena-baseline.js');
  ok(/FAIL-SAFE DECLARADO/.test(baseline), 'la dirección de la falla está escrita, no implícita');
  const fn = baseline.slice(baseline.indexOf('export async function leerEstadoAgente'));
  ok(/catch \{\s*\n\s*return VACIO;/.test(fn.slice(0, 900)) && /halted: false/.test(fn.slice(0, 900)),
    'y ante un error devuelve `halted: false`, no `true`');

  // Un agente que no existe en la tabla tampoco está detenido.
  ok(typeof leerEstadoAgente === 'function', 'la función es la compartida, importable desde los dos caminos');
}

// ── 5) EL ESTADO SALE DEL MÓDULO COMPARTIDO ──────────────────────────
// ── CORRECCIÓN DEL MISMO DÍA ────────────────────────────────────────
// Escribí que mover `getArenaState` a `_lib/` evitaba un ciclo de imports.
// Esta prueba se puso roja y tenía razón: **el ciclo YA EXISTE**.
// `arena-shadow.js:38` importa `gatherContext`, `buildTargetSystemPrompt` y
// PROMPT_VERSION de `arena-run.js`, y `arena-run.js` importa
// `runAgenteObjetivo` de `arena-shadow.js`. ESM lo resuelve y los dos cargan.
//
// O sea que el motivo que di era falso. El movimiento sigue siendo correcto
// por OTRO motivo, que es el de B41: el lector de estado lo usan los DOS
// caminos, así que vive donde ninguno de los dos manda — y no se agrega una
// arista más a un ciclo que ya está apretado.
//
// (El ciclo en sí es una deuda real: dos de los archivos más grandes del
// arena importándose mutuamente. No se toca hoy; queda anotado.)
console.log('\n── el estado sale del módulo compartido ──');
{
  ok(/from '\.\/_lib\/arena-baseline\.js'/.test(shadow),
    'arena-shadow lee el estado de _lib/arena-baseline.js, no de arena-run');
  ok(!/getArenaState[^=]*=[^=]*from '\.\/arena-run\.js'/.test(shadow)
    && !/import \{[^}]*getArenaState[^}]*\} from '\.\/arena-run\.js'/.test(shadow),
    'y NO lo importa de arena-run, que habría apretado más el ciclo');

  // El ciclo que YA existe, declarado para que nadie lo descubra creyéndolo nuevo.
  const cicloIda = /import \{ runAgenteObjetivo \} from '\.\/arena-shadow\.js'/.test(run);
  const cicloVuelta = /from '\.\/arena-run\.js'/.test(shadow);
  ok(cicloIda && cicloVuelta,
    'el ciclo arena-run ↔ arena-shadow existe desde antes y está declarado acá: si algún día se rompe, esta línea avisa que se puede simplificar');

  // Y la definición NO quedó duplicada: se movió, no se copió.
  const baseline = leer('api/_lib/arena-baseline.js');
  ok(/export async function leerEstadoAgente/.test(baseline)
    && !/from arena_state where agent_id = \$1`, \[agentId\]\);\s*\n\s*return rows\[0\] \|\| \{ halted: false/.test(run),
    'el cuerpo se MOVIÓ: arena-run reexporta, no tiene su propia copia de la consulta');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
