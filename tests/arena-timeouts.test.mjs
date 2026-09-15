// ═══════════════════════════════════════════════════════════════
// Tests del PRESUPUESTO DE TIEMPO del Arena.
//
// El bug que originó esta suite: /api/arena-smoke moría con
// FUNCTION_INVOCATION_TIMEOUT. La causa NO era el código — era que
// `vercel.json` declaraba `api/*.js: { maxDuration: 60 }`, y ese glob tapaba
// el `export const maxDuration = 300` de NUEVE endpoints. Cada uno creía tener
// 300s y tenía 60.
//
// Por eso el primer test de acá no prueba JavaScript: prueba que los dos
// lugares donde se declara el techo digan lo MISMO. Es un lint, y existe
// porque esa desincronización no da error en ninguna parte — ni en build, ni
// en deploy, ni en import. Solo se manifiesta como una función muerta en
// producción, que es el peor lugar para enterarse.
//
// Correr con `node tests/arena-timeouts.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from 'node:fs';
import { withDeadline } from '../api/_lib/arena-model.js';
import { ARENA_LLM_TIMEOUT_MS, ARENA_AGENT_DEADLINE_MS } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── vercel.json vs. el maxDuration de cada archivo ──');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
const fns = vercel.functions || {};

// Lo que cada endpoint declara en su propio archivo.
const declarado = {};
for (const f of readdirSync(new URL('../api/', import.meta.url))) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(new URL('../api/' + f, import.meta.url), 'utf8');
  const m = /^export const maxDuration = (\d+);/m.exec(src);
  if (m) declarado[f] = Number(m[1]);
}
ok(Object.keys(declarado).length >= 9, `se encontraron los endpoints con maxDuration propio (${Object.keys(declarado).length})`);

// El techo EFECTIVO: la entrada específica de vercel.json, o el glob.
const glob = (fns['api/*.js'] || {}).maxDuration;
ok(glob === 60, 'el glob api/*.js sigue siendo el default de 60s', glob);
for (const [f, quiere] of Object.entries(declarado)) {
  const entrada = fns['api/' + f];
  const efectivo = entrada ? entrada.maxDuration : glob;
  ok(efectivo === quiere,
    `api/${f}: el archivo pide ${quiere}s y vercel.json concede ${efectivo}s`,
    entrada ? undefined : 'NO tiene entrada propia en vercel.json: se le aplica el glob');
}

console.log('\n── Los presupuestos encajan uno dentro del otro ──');
const maxSmoke = declarado['arena-smoke.js'];
ok(ARENA_LLM_TIMEOUT_MS < ARENA_AGENT_DEADLINE_MS,
  `una conexión (${ARENA_LLM_TIMEOUT_MS}ms) cabe dentro del agente (${ARENA_AGENT_DEADLINE_MS}ms)`);
ok(ARENA_AGENT_DEADLINE_MS < maxSmoke * 1000,
  `el agente (${ARENA_AGENT_DEADLINE_MS}ms) cabe dentro de la función (${maxSmoke * 1000}ms) con margen para journalear`);
ok(maxSmoke * 1000 - ARENA_AGENT_DEADLINE_MS >= 30000,
  'queda al menos 30s de margen entre el deadline del agente y la muerte de la función',
  `${maxSmoke * 1000 - ARENA_AGENT_DEADLINE_MS}ms`);

console.log('\n── withDeadline: devuelve fila, no excepción ──');
const lento = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

const gano = await withDeadline(lento(10, 'listo'), 500, () => 'TIMEOUT');
ok(gano === 'listo', 'el trabajo que termina a tiempo gana la carrera', gano);

const perdio = await withDeadline(lento(500, 'listo'), 20, () => ({ status: 'timeout' }));
ok(perdio && perdio.status === 'timeout', 'el trabajo lento devuelve la fila de timeout', JSON.stringify(perdio));

// Lo importante: NO rechaza. Un throw acá tumbaría a los otros seis agentes.
let rechazo = false;
try { await withDeadline(lento(500, 'x'), 10, () => ({ status: 'timeout' })); } catch { rechazo = true; }
ok(!rechazo, 'un timeout NO rechaza la promesa (no tumba al resto de la liga)');

// El timer se limpia: si quedara vivo, la función serverless no puede terminar
// y Vercel la mantiene abierta hasta el maxDuration aunque ya haya respondido.
const t0 = Date.now();
await withDeadline(lento(5, 'ya'), 60000, () => 'TIMEOUT');
ok(Date.now() - t0 < 1000, 'el reloj se cancela cuando el trabajo gana (no deja el proceso colgado)');

console.log('\n── Un agente lento no se lleva a los demás ──');
// La forma exacta del smoke: allSettled sobre probes con deadline propio.
const agentes = [
  { id: 'rapido', ms: 5 },
  { id: 'colgado', ms: 10000 },
  { id: 'tambien_rapido', ms: 5 },
];
const inicio = Date.now();
const filas = (await Promise.allSettled(agentes.map((a) => withDeadline(
  lento(a.ms, { agent: a.id, ok: true }),
  50,
  () => ({ agent: a.id, ok: false, failure: 'timeout' }),
)))).map((r) => r.value);
ok(filas.length === 3, 'salen las tres filas, ninguna se pierde');
ok(filas.filter((f) => f.ok).length === 2, 'los dos rápidos reportan ok');
ok(filas.find((f) => f.agent === 'colgado').failure === 'timeout', 'el colgado reporta failure:timeout');
ok(Date.now() - inicio < 2000, 'la corrida NO esperó los 10s del colgado', `${Date.now() - inicio}ms`);

console.log('\n── No quedan timeouts hardcodeados en el dispatch ──');
const model = readFileSync(new URL('../api/_lib/arena-model.js', import.meta.url), 'utf8');
ok(!/AbortSignal\.timeout\(\s*\d+\s*\)/.test(model),
  'arena-model.js no tiene AbortSignal.timeout con un número pegado (eran 45000 y 180000, asimétricos)');
// >= 2: los dos proveedores. Puede haber más llamadas parametrizadas
// (openRouterPrices baja el catálogo con su propio techo nombrado); lo que se
// prohíbe es el NÚMERO PEGADO, que es lo que chequea la aserción de arriba.
ok((model.match(/AbortSignal\.timeout\(timeoutMs\)/g) || []).length >= 2,
  'los dos proveedores usan el MISMO presupuesto parametrizado');
// La ventana era de 600 chars y la firma de `openRouterFetch` creció al
// aceptar `tools`/`toolChoice` (B3), así que el AbortSignal quedó a ~680. Se
// ensancha en vez de reformatear el código para que quepa en el test: lo que
// este lint tiene que garantizar es que el fetch de OpenRouter use el techo
// PARAMETRIZADO, no que la función mida menos de N caracteres.
ok(/openRouterFetch[\s\S]{0,1200}AbortSignal\.timeout\(timeoutMs\)/.test(model), 'openRouterFetch lo usa');
ok(/anthropicFetch[\s\S]{0,400}AbortSignal\.timeout\(timeoutMs\)/.test(model), 'anthropicFetch lo usa');

console.log('\n── El smoke corre en paralelo, no en serie ──');
const smoke = readFileSync(new URL('../api/arena-smoke.js', import.meta.url), 'utf8');
ok(/Promise\.allSettled\(/.test(smoke), 'usa Promise.allSettled');
ok(!/for \(const a of probeable\)/.test(smoke), 'ya no hay bucle secuencial sobre los agentes');
ok(/const streaming = String\(q\.stream/.test(smoke), 'existe el modo ?stream=1');
ok(/application\/x-ndjson/.test(smoke), 'el streaming es NDJSON');

console.log('\n── La nocturna y el vigilante tienen el mismo reloj ──');
for (const [f, etiqueta] of [['arena-run.js', 'la nocturna'], ['arena-watch.js', 'el vigilante']]) {
  const src = readFileSync(new URL('../api/' + f, import.meta.url), 'utf8');
  ok(/withDeadline\(/.test(src), `${etiqueta} (${f}) envuelve runArenaDecide con withDeadline`);
  ok(/ARENA_AGENT_DEADLINE_MS/.test(src), `${etiqueta} usa el MISMO presupuesto que la liga`);
  ok(/status: 'timeout'/.test(src), `${etiqueta} journalea status:'timeout', no un error genérico`);
}

console.log(failures ? `\n${failures} FALLAS\n` : '\nTodo en verde\n');
process.exit(failures ? 1 : 0);
