// ═══════════════════════════════════════════════════════════════
// tests/arena-t3-apertura.test.mjs — EL PLAN DE APERTURA, CONTRA EL CÓDIGO.
//
// `docs/arena-t3-apertura.md` afirma cosas sobre lo que el reset hace y no
// hace. Un plan escrito una vez y no verificado es una descripción de cómo
// era el código el día que alguien lo leyó — y este repo ya se comió esa
// factura (B37: una afirmación sobre comportamiento observable dice contra
// qué árbol se verificó, o no se escribe).
//
// Acá el árbol es `main`, y la verificación corre en cada suite.
//
// Lo que fija:
//   1. EL RESET NO BORRA NADA. Cero DELETE, cero TRUNCATE. Es la promesa
//      central del plan: la T2 se sella, no se borra.
//   2. TOCA EXACTAMENTE CUATRO SITIOS, y están enumerados.
//   3. EL BENCHMARK ES POR TEMPORADA, y el aviso sube a `warnings`.
//   4. LOS SIETE SE RE-BASAN JUNTOS, control incluido, en el mismo bucle.
//   5. EL HUMO NO PUEDE OPERAR: corre por el camino cuyo broker LANZA.
//
// Correr con `node tests/arena-t3-apertura.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { competidores } from '../api/_lib/arena-registry.js';
import { claveBenchmark } from '../api/_lib/arena-benchmark.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const leer = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const reset = leer('api/arena-reset.js');

// ── 1) EL RESET NO BORRA NADA ────────────────────────────────────────
console.log('\n── la T2 se sella, no se borra ──');
{
  // Sin comentarios: un `-- delete` en una nota no es una escritura, pero un
  // DELETE de verdad sí, y hay que distinguirlos para que la prueba no mienta
  // en ninguna de las dos direcciones.
  const codigo = reset.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const destructivos = (codigo.match(/\b(delete\s+from|truncate)\b/gi) || []);
  ok(destructivos.length === 0,
    'cero DELETE y cero TRUNCATE en todo el endpoint', destructivos.join(', '));

  // Las tablas que el plan promete intactas. Que no aparezcan NOMBRADAS en el
  // endpoint es la forma más fuerte de la promesa: no se las puede tocar sin
  // mencionarlas.
  const INTACTAS = ['arena_shadow_journal', 'arena_equity_intraday', 'arena_aperturas',
    'arena_noise_floor', 'arena_spend', 'arena_watch_events', 'arena_watch_mark',
    'arena_universe', 'arena_screener', 'arena_market_cap', 'arena_buffet_cache'];
  const mencionadas = INTACTAS.filter((t) => new RegExp('\\b' + t + '\\b').test(codigo));
  ok(mencionadas.length === 0,
    `las ${INTACTAS.length} tablas que el plan promete intactas no se nombran siquiera`,
    mencionadas.join(', '));
}

// ── 2) LOS CUATRO SITIOS QUE SÍ TOCA ─────────────────────────────────
console.log('\n── y lo que sí escribe, enumerado ──');
{
  ok(/insert into arena_journal/.test(reset), 'arena_journal: el anuncio');
  ok((reset.match(/insert into arena_journal/g) || []).length === 1,
    'UNA sola fila, no una por agente: el reset es un hecho de la liga');
  ok(/on conflict \(id\) do nothing/.test(reset), 'e idempotente por id');

  ok(/setBaseline\(/.test(reset), 'arena_state: el baseline, vía setBaseline');
  ok(/pauseWatch|resumeWatch/.test(reset), 'arena_flags: la pausa del vigilante');
  ok(/abrirBenchmark\(/.test(reset), 'arena_benchmark: el SPY de la temporada');

  // El plan dice CUATRO. Si mañana alguien agrega un quinto destino, esto se
  // pone rojo y el plan se actualiza — que es el punto.
  const baseline = leer('api/_lib/arena-baseline.js');
  ok(/insert into arena_state/.test(baseline) && /on conflict \(agent_id\) do update/.test(baseline),
    'setBaseline es un UPSERT por agente: pisa el baseline viejo, y por eso el plan pide la copia previa');
}

// ── 3) EL BENCHMARK, POR TEMPORADA ───────────────────────────────────
console.log('\n── el SPY arranca el mismo día que los agentes ──');
{
  ok(claveBenchmark('T2') !== claveBenchmark('T3'),
    'dos temporadas no comparten clave: la T3 abre su propia entrada',
    `${claveBenchmark('T2')} vs ${claveBenchmark('T3')}`);

  const bm = leer('api/_lib/arena-benchmark.js');
  ok(/const ya = await leerBenchmark\(\{ season \}\);\s*\n\s*if \(ya\) return/.test(bm),
    'y adentro de UNA temporada la idempotencia sigue: no se re-abre a un precio nuevo');
  ok(/update arena_benchmark set key = \$1, season = \$2/.test(bm) && /not exists/.test(bm),
    'la fila de la T2 migra a su temporada en vez de quedar huérfana, y la migración se puede repetir');

  ok(/hay que mover ARENA_SEASON\.id/.test(reset),
    'si el benchmark ya existía, el reset dice exactamente qué revisar');
  ok(/if \(out\.benchmark\.warning\) out\.warnings\.push/.test(reset),
    'y ese aviso sube a `warnings`: `ya_estaba` es un camino de ÉXITO y salía mudo');
}

// ── 4) LOS SIETE JUNTOS, CONTROL INCLUIDO ────────────────────────────
// Si el control se re-basara en otro momento que claude, el par que mide el
// piso de ruido arrancaría desfasado — y esa es la única referencia contra la
// que vale un delta entre modelos.
console.log('\n── control no es un caso especial ──');
{
  ok(/const agents = only \? \[agentById\(only\)\]\.filter\(Boolean\) : activeAgents\(\)/.test(reset),
    'el reset recorre activeAgents(): un solo bucle, un solo instante');
  const ids = competidores().map((a) => a.id);
  ok(ids.includes('control') && ids.includes('claude'),
    'y control y claude están los dos en el padrón', ids.join(','));
  ok(!/agent\.control|a\.control\b/.test(reset),
    'el endpoint no tiene ninguna rama por `control`: no puede tratarlo distinto');
}

// ── 5) EL HUMO NO PUEDE OPERAR ───────────────────────────────────────
// El plan manda correr los siete por `/api/arena-shadow` ANTES del reset, con
// las cuentas ya recargadas. Eso solo es seguro si ese camino no puede mandar
// una orden — y la garantía no es una bandera, es que el broker LANZA.
console.log('\n── la corrida de humo no toca ninguna cuenta ──');
{
  const shadow = leer('api/arena-shadow.js');
  ok(/const broker = vivo \? alpaca : \(deps\.shadowBroker \|\| shadowBroker\)\(alpaca\)/.test(shadow),
    'sin `vivo`, el broker es el que lanza en cualquier escritura');
  ok(/const only = String\(q\.agent \|\| ''\)\.toLowerCase\(\)/.test(shadow),
    'y se puede correr UNO por vez, que es como lo pide el plan');

  // Es la MISMA función que corre en vivo: un humo que corriera otro código no
  // probaría nada de lo que importa.
  const run = leer('api/arena-run.js');
  ok(/return runAgenteObjetivo\(\{[\s\S]{0,200}vivo: true/.test(run),
    'la liga viva corre la MISMA función que el humo, con `vivo: true`');
}

// ── 6) EL PLAN Y EL CÓDIGO NO SE DESINCRONIZAN ───────────────────────
console.log('\n── el doc dice lo que el código hace ──');
{
  const plan = leer('docs/arena-t3-apertura.md');
  ok(/El reset no tiene un solo `DELETE`/.test(plan), 'el plan afirma lo que la sección 1 verifica');
  ok(/benchmark:spy:T3|benchmark\.temporada.*T3/s.test(plan), 'y nombra la clave nueva');
  ok(/arena-smoke\?catalog=1/.test(plan) && /arena-shadow\?agent=/.test(plan),
    'con los comandos reales, no una descripción');
  ok(/be7c849/.test(plan) && /b309a36/.test(plan) && /9ea5858/.test(plan) && /95b7a2c/.test(plan),
    'y los cuatro commits de verificación, por SHA');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
