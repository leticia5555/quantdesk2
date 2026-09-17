// ═══════════════════════════════════════════════════════════════
// tests/arena-churn.test.mjs — el churn del primer día en vivo.
//
// EL CASO (2026-09-17, primera sesión con ARENA_CONTRATO=objetivo):
//
//   · claude corrió 16:06, 16:16 y 16:21 — tres veces en quince minutos, y
//     cada corrida mandó órdenes.
//   · deepseek vendió 278 NKE @36.08 a las 18:53 y recompró 275 @36.56 a las
//     18:58. Misma posición, cinco minutos, medio dólar más cara, sin ningún
//     evento en NKE.
//
// EL COOLDOWN SÍ ESTABA PUESTO. Lo que cambió es qué significa una corrida.
//
// Con el contrato viejo, un disparador de NVDA despertaba una revisión SOBRE
// NVDA: un enfriamiento por `agente|ticker` era exactamente la llave correcta.
// Con el contrato objetivo, `runArenaDecide` ni siquiera pasa el `event`: la
// corrida produce un PORTAFOLIO COMPLETO y el motor rebalancea el libro
// entero. Tres tickers distintos = tres rebalanceos completos, y ningún
// cooldown en medio porque cada ticker tiene su propio reloj.
//
// Y el ida y vuelta de NKE tiene su propia mecánica: la banda de
// no-negociación frena pata por pata, pero un CIERRE COMPLETO está exento a
// propósito ("salir del 1.5%" es una decisión, no drift). Un objetivo puso NKE
// en 0 —cierre, exento— y el siguiente la volvió a poner. Las dos patas eran
// legales por separado; lo que faltaba era un juicio sobre el rebalanceo
// COMPLETO.
//
// Correr con `node tests/arena-churn.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { applyCaps, WATCH_RULES } from '../api/_lib/arena-watch.js';
import { frenoPorTurnoverMinimo, TURNOVER_MINIMO_DISPARADOR } from '../api/_lib/arena-objetivo-vivo.js';
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const disp = (agent_id, symbol, type = 'move_since_pronouncement') =>
  ({ agent_id, symbol, type, owner: 'position', detail: {} });

console.log('\n── cuando la corrida es global, el enfriamiento es global ──');
{
  const ahora = new Date('2026-09-17T16:21:00Z');
  const hace5 = Date.parse('2026-09-17T16:16:00Z');
  const ctx = { lastRunAt: { 'claude|AMD': hace5 }, lastRunAgentAt: { claude: hace5 }, now: ahora };

  // EL BUG, tal como pasó: claude corrió a las 16:16 por AMD y a las 16:21
  // dispara COP. Con la llave por ticker, COP no sabe nada de AMD.
  const viejo = applyCaps([disp('claude', 'COP')], { ...ctx, corridaGlobal: false });
  ok(viejo.runs.length === 1,
    'con una corrida POR NOMBRE, un disparador de otro ticker sí puede correr — la llave por ticker era correcta para ese contrato');

  const nuevo = applyCaps([disp('claude', 'COP')], { ...ctx, corridaGlobal: true });
  ok(nuevo.runs.length === 0,
    'con una corrida GLOBAL, no: es el mismo libro que se rebalanceó hace 5 minutos');
  ok(/rebalancea el libro entero/.test(nuevo.journal[0].skip_reason),
    'y el motivo lo dice con esas palabras, no "cooldown" a secas', nuevo.journal[0].skip_reason);

  // El cooldown por ticker NO se va: sigue protegiendo al mismo nombre.
  const mismo = applyCaps([disp('claude', 'AMD')], { ...ctx, corridaGlobal: false });
  ok(mismo.runs.length === 0 && /cooldown 20m/.test(mismo.journal[0].skip_reason),
    'el cooldown por ticker sigue en pie: son dos protecciones distintas, no una que reemplaza a la otra');

  // Y pasado el enfriamiento, vuelve a correr: esto frena churn, no la liga.
  const despues = applyCaps([disp('claude', 'COP')], {
    lastRunAt: {}, lastRunAgentAt: { claude: Date.parse('2026-09-17T15:30:00Z') },
    corridaGlobal: true, now: ahora,
  });
  ok(despues.runs.length === 1,
    '51 minutos después sí corre: el enfriamiento acota la frecuencia, no apaga el vigilante');
}

console.log('\n── varios disparadores del MISMO tick siguen siendo UNA corrida ──');
{
  // Esto ya era así y tiene que seguir: tres disparadores a la vez no son tres
  // corridas, son una con tres motivos. Si el cooldown de agente lo rompiera,
  // estaría cambiando churn por ceguera.
  const r = applyCaps([disp('claude', 'NVDA'), disp('claude', 'AMD'), disp('claude', 'COP')], {
    lastRunAt: {}, lastRunAgentAt: {}, corridaGlobal: true, now: new Date('2026-09-17T16:21:00Z'),
  });
  ok(r.runs.length === 1 && r.runs[0].symbols.length === 3,
    'tres disparadores en el mismo tick = UNA corrida con tres motivos', JSON.stringify(r.runs[0] && r.runs[0].symbols));
}

console.log('\n── el piso de movimiento: un disparador no opera por un ajuste cosmético ──');
{
  ok(TURNOVER_MINIMO_DISPARADOR === 0.05, 'el piso por defecto es 5% del equity', String(TURNOVER_MINIMO_DISPARADOR));

  ok(frenoPorTurnoverMinimo({ turnover: 0.01 }, { esDisparador: false }) === null,
    'una RONDA FIJA puede expresar un ajuste chico: son tres al día, es el latido de la liga');

  const f = frenoPorTurnoverMinimo({ turnover: 0.01 }, { esDisparador: true });
  ok(f && f.freno === 'turnover_bajo_el_minimo',
    'un DISPARADOR que mueve el 1% del equity no manda nada: es churn con otro nombre');
  ok(/no justifica el costo de operar/.test(f.detalle) && /journaleado igual/.test(f.detalle),
    'y el motivo dice las dos cosas: por qué no se operó, y que la decisión SÍ quedó journaleada', f.detalle);

  ok(frenoPorTurnoverMinimo({ turnover: 0.22 }, { esDisparador: true }) === null,
    'un disparador con una decisión de verdad sí opera — esto no es un freno de mano');
  ok(frenoPorTurnoverMinimo({ turnover: null }, { esDisparador: true }) === null,
    'y sin turnover no se frena nada: un dato ausente nunca bloquea una decisión (fail open acá, porque lo contrario congela la liga por un hueco de cálculo)');
  ok(frenoPorTurnoverMinimo(null, { esDisparador: true }) === null, 'ni sin rebalanceo');
}

console.log('\n── el motor lo respeta, y lo journalea ──');
{
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  ok(/const frenoTurnover = frenoPorTurnoverMinimo\(rebalance, \{ esDisparador \}\)/.test(shadow),
    'el motor lo evalúa sobre el rebalanceo completo');
  ok(/modo: frenoTurnover \? 'sin_operar'/.test(shadow),
    'y el modo lo dice: `sin_operar` no es `dry` — dry es la bandera, esto es una decisión de la corrida');
  ok(shadow.indexOf('const frenoTurnover') < shadow.indexOf('} else if (mandaOrdenes())'),
    'se evalúa ANTES de mandar, no después de leer el journal');

  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(/esDisparador: !!event/.test(run),
    'y la corrida sabe si nació de un disparador — el `event` no se pasa al modelo, pero sí a esta regla');
}

console.log('\n── la última corrida y el último plan no son lo mismo ──');
{
  // deepseek, control y qwen salieron como "Sin plan publicado aún" el mismo
  // día en que operaron: la tarjeta leía `limit 1` y esa última corrida abortó.
  const lb = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');
  ok(/order by created_at desc limit 12/.test(lb),
    'el leaderboard trae varias corridas, no sólo la última');
  ok(/out\.ultimo_plan = \{/.test(lb) && /conPlan\.created_at !== jr\[0\]\.created_at/.test(lb),
    'y publica el último plan BUENO sólo cuando es OTRA corrida — si la última ya trae plan, un duplicado invita a mostrarlo dos veces');

  const html = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');
  ok(/a\.ultimo_plan/.test(html) && /abortó/.test(html),
    'la tarjeta muestra el último plan con su hora Y dice que la última corrida abortó — sustituir uno por otro escondería el aborto');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
