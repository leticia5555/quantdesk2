// ═══════════════════════════════════════════════════════════════
// tests/arena-watch.test.mjs — el VIGILANTE (cadencia por evento).
//
// Un DÍA SINTÉTICO DE MERCADO VOLÁTIL, de punta a punta: cuatro nombres que se
// mueven de cuatro maneras distintas, más un candidato del buffet que se
// dispara, y dos ticks separados para ver el cooldown y los sticky en acción.
//
// Lo que esta suite protege (y que ninguna otra puede):
//   1. Los SEIS disparadores, cada uno aislado en su propio nombre, para que un
//      cambio de umbral no pueda romper uno sin que se note.
//   2. Los TOPES: 12 corridas/agente/día, cooldown de 20 min por ticker, y
//      sticky (un hecho del día no se cobra dos veces). Es lo único que impide
//      que un día loco queme el presupuesto.
//   3. TODO disparador se journalea, dispare o no — con su razón.
//   4. La corrida acotada: se salta el SCOUT, ejecuta INTRADÍA a marketable
//      limit (compra ARRIBA, venta ABAJO) y descarta lo que quede fuera del
//      slate.
//   5. Los SIETE por igual, control incluido: mismo camino, mismos umbrales,
//      mismos topes.
//   6. El vigilante en sí NO gasta un token.
// Correr con `node tests/arena-watch.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.FINNHUB_API_KEY = 'fh-test';
process.env.ARENA_ENABLED = '1';
process.env.ARENA_WATCH_START = '2026-09-15';
// Los dos agentes de Anthropic: el insignia y el CONTROL. El control es el que
// importa acá — si el vigilante lo tratara distinto (otro umbral, otro tope,
// otra ruta), dejaría de ser el piso de ruido y la liga entera perdería su
// única referencia. Los otros cinco corren por OpenRouter, misma función.
process.env.ARENA_LEAGUE = 'claude,control';
process.env.ALPACA_PAPER_KEY = 'PK_CLAUDE'; process.env.ALPACA_PAPER_SECRET = 'S_CLAUDE';
process.env.ALPACA_CONTROL_KEY = 'PK_CTRL'; process.env.ALPACA_CONTROL_SECRET = 'S_CTRL';

import {
  WATCH_RULES, evaluateTriggers, applyCaps, floorReviewDue, sessionPhase,
  markPrice, pointsToLevel, marketableLimit, estimateWorstCaseCost, watchCadenceActive,
  buildTriggerHeadline,
} from '../api/_lib/arena-watch.js';
import { ARENA_AGENTS } from '../api/_lib/arena-registry.js';
import { runArenaWatch } from '../api/arena-watch.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ═══ EL DÍA SINTÉTICO ════════════════════════════════════════════════
// Martes 2026-09-15 — el primer día de la cadencia nueva, a propósito.
// 09:50 ET (13:50 UTC, EDT): 20 minutos de sesión, ANTES de la revisión de piso.
const TICK_1 = new Date('2026-09-15T13:50:00Z');
// 10:05 ET: +15 minutos. Ya pasó la apertura +30 → toca la revisión de piso.
const TICK_2 = new Date('2026-09-15T14:05:00Z');
const TODAY = '2026-09-15';
const SESSION = { date: TODAY, open: '09:30', close: '16:00' };

// Cuatro nombres, cuatro maneras de moverse. Cada uno aísla UN disparador para
// que el test diga qué se rompió, no solo que algo se rompió.
//
//   NVDA — cae 6% desde el cierre de ayer Y va a 3.6× su volumen Y reporta hoy.
//          Tres disparadores sobre el mismo nombre: deben AGRUPARSE en una sola
//          corrida, no cobrar tres.
//   KO   — se mueve 0.2% (no dispara por precio) pero cotiza a 1.5 puntos de su
//          stop catastrófico. Aísla near_catastrophic.
//   MU   — se mueve 0.2% pero está a ~1.2 puntos de su trailing ARMADO.
//          Aísla near_trailing.
//   PLTR — NO está en ningún libro. Candidato del buffet, +7%. Aísla buffet_move
//          y prueba que un nombre sin dueño despierta a la liga entera.
const QUOTES = {
  NVDA: { price: 188, prev_close: 200, day_volume: 360e6, avg_volume_20d: 100e6 },
  KO: { price: 47.5, prev_close: 47.6, day_volume: 10e6, avg_volume_20d: 12e6 },
  MU: { price: 121, prev_close: 121.2, day_volume: 5e6, avg_volume_20d: 8e6 },
  PLTR: { price: 21.4, prev_close: 20, day_volume: 30e6, avg_volume_20d: 40e6 },
};

const POSITIONS = [
  { symbol: 'NVDA', qty: '20', avg_entry_price: '150', market_value: '3760', current_price: '188', unrealized_plpc: '0.2533' },
  { symbol: 'KO', qty: '50', avg_entry_price: '60', market_value: '2375', current_price: '47.5', unrealized_plpc: '-0.2083' },
  { symbol: 'MU', qty: '10', avg_entry_price: '100', market_value: '1210', current_price: '121', unrealized_plpc: '0.21' },
];

// Niveles del día, como los computa `levelsForAgent`:
//   KO: stop catastrófico = 60 × (1 − 0.22) = 46.80 → 47.5 está a 1.50 puntos.
//   MU: pico 130 desde entrada 100 → armado (100×1.15 = 115 ≤ 130),
//       nivel = 130 × 0.92 = 119.60 → 121 está a 1.17 puntos.
//   NVDA: pico 165 < 172.5 → trailing NO armado (nada que medir ahí).
const LEVELS = {
  NVDA: { trailing: { armed: false, arm_level: 172.5, level: null }, catastrophic_level: 117 },
  KO: { trailing: { armed: false, arm_level: 69, level: null }, catastrophic_level: 46.8 },
  MU: { trailing: { armed: true, arm_level: 115, level: 119.6 }, catastrophic_level: 78 },
};

const DAY_EVENTS = {
  NVDA: { earnings: { date: TODAY, time: 'AMC' }, filing_8k: null },
  KO: { earnings: null, filing_8k: { filed_at: TODAY + 'T12:10:00.000Z', items: '5.02', accession: '0000-1' } },
};

// ═══ A) LOS SEIS DISPARADORES, sobre los SIETE agentes ═══════════════
console.log('vigilante: los seis disparadores en un día volátil');
{
  // Los SIETE de la parrilla, control incluido, con el MISMO libro: si el
  // vigilante tratara a alguno distinto, los conteos por agente diferirían.
  const agents = ARENA_AGENTS.map((a) => ({ id: a.id, halted: false }));
  const books = Object.fromEntries(agents.map((a) => [a.id, { positions: POSITIONS, meta: LEVELS }]));
  const t = evaluateTriggers({ agents, books, quotes: QUOTES, marks: {}, dayEvents: DAY_EVENTS, buffet: ['PLTR'] });

  const forClaude = t.filter((x) => x.agent_id === 'claude');
  const types = (sym) => forClaude.filter((x) => x.symbol === sym).map((x) => x.type).sort();

  ok(types('NVDA').join(',') === 'event_earnings,move_since_pronouncement,volume_spike',
    'NVDA dispara los TRES que le corresponden: ±3% desde el cierre, earnings del día y volumen 3.6×', JSON.stringify(types('NVDA')));
  ok(types('KO').join(',') === 'event_8k,near_catastrophic',
    'KO dispara por el 8-K del día y por estar a 1.5 puntos del stop catastrófico — y NO por precio (se movió 0.2%)', JSON.stringify(types('KO')));
  ok(types('MU').join(',') === 'near_trailing',
    'MU dispara SOLO por acercarse a su trailing ARMADO', JSON.stringify(types('MU')));
  ok(types('PLTR').join(',') === 'buffet_move',
    'PLTR (no está en el libro) dispara como candidato del buffet a +7%', JSON.stringify(types('PLTR')));

  const nvda = forClaude.find((x) => x.type === 'move_since_pronouncement');
  ok(nvda.detail.move_pct === -6 && nvda.detail.mark === 200 && nvda.detail.mark_source === 'prev_close',
    'sin marca previa, el ancla del ±3% es el CIERRE ANTERIOR — el número que el PM tuvo enfrente la última vez',
    JSON.stringify(nvda.detail));
  const ko = forClaude.find((x) => x.type === 'near_catastrophic');
  ok(ko.detail.points_to_level === 1.5 && ko.detail.crossed === false,
    'la distancia al stop se reporta en PUNTOS porcentuales, ya calculada', JSON.stringify(ko.detail));

  // Paridad: los siete, mismo conteo. Es la condición #6 del encargo.
  const porAgente = {};
  for (const x of t) porAgente[x.agent_id] = (porAgente[x.agent_id] || 0) + 1;
  const conteos = [...new Set(Object.values(porAgente))];
  ok(Object.keys(porAgente).length === 7 && conteos.length === 1,
    'LOS SIETE POR IGUAL, control incluido: mismo libro → mismo número de disparadores, sin excepciones',
    JSON.stringify(porAgente));

  // Un agente DETENIDO por el breaker no se despierta: su muerte es el
  // resultado del experimento, no algo que un tick deba deshacer.
  const conHalt = agents.map((a) => (a.id === 'control' ? { ...a, halted: true } : a));
  const t2 = evaluateTriggers({ agents: conHalt, books, quotes: QUOTES, marks: {}, dayEvents: DAY_EVENTS, buffet: ['PLTR'] });
  ok(!t2.some((x) => x.agent_id === 'control'), 'un agente HALTED por el breaker no recibe disparadores');

  // Un nombre sin precio vivo no se evalúa: hueco honesto, nunca un evento
  // inventado sobre un dato que no llegó.
  const t3 = evaluateTriggers({ agents: [{ id: 'claude' }], books: { claude: { positions: POSITIONS, meta: LEVELS } }, quotes: { KO: QUOTES.KO }, marks: {}, dayEvents: {}, buffet: [] });
  ok(!t3.some((x) => x.symbol === 'NVDA' || x.symbol === 'MU'),
    'sin precio vivo de Alpaca un nombre NO se evalúa (fail-safe: un dato faltante no inventa un disparador)');

  // La marca se mueve con el pronunciamiento: ése es el mecanismo de re-armado.
  const marks = { 'claude|NVDA': { price: 189, marked_at: TICK_1.toISOString() } };
  const t4 = evaluateTriggers({ agents: [{ id: 'claude' }], books: { claude: { positions: POSITIONS, meta: LEVELS } }, quotes: QUOTES, marks, dayEvents: {}, buffet: [] });
  ok(!t4.some((x) => x.symbol === 'NVDA' && x.type === 'move_since_pronouncement'),
    'con una marca reciente a 189, el mismo precio de 188 ya NO dispara: el ±3% se mide desde el último pronunciamiento, no desde el cierre');
}

// ═══ B) TOPES Y COOLDOWN ════════════════════════════════════════════
console.log('\nvigilante: topes y cooldown (que un día loco no queme tokens)');
{
  const agents = [{ id: 'claude', halted: false }];
  const books = { claude: { positions: POSITIONS, meta: LEVELS } };
  const triggers = evaluateTriggers({ agents, books, quotes: QUOTES, marks: {}, dayEvents: DAY_EVENTS, buffet: ['PLTR'] });

  // (1) AGRUPACIÓN: 6 disparadores sobre 4 nombres → UNA corrida, no seis.
  const { runs, journal } = applyCaps(triggers, { now: TICK_1 });
  ok(triggers.length === 7 && runs.length === 1 && runs[0].agent_id === 'claude',
    'los SIETE disparadores del mismo agente en el mismo tick → UNA corrida agrupada, no siete', JSON.stringify({ disparadores: triggers.length, corridas: runs.length }));
  ok(runs[0].symbols.sort().join(',') === 'KO,MU,NVDA,PLTR',
    'la corrida queda ACOTADA a los cuatro tickers que dispararon', JSON.stringify(runs[0].symbols));
  ok(journal.length === triggers.length && journal.every((j) => j.fired),
    'y los siete quedan journaleados', JSON.stringify({ journal: journal.length, triggers: triggers.length }));

  // (2) COOLDOWN: 20 minutos por ticker.
  const hace5min = Object.fromEntries(['NVDA', 'KO', 'MU', 'PLTR'].map((s) => ['claude|' + s, TICK_1.getTime() - 5 * 60000]));
  const r2 = applyCaps(triggers, { now: TICK_1, lastRunAt: hace5min });
  ok(r2.runs.length === 0, 'todo en cooldown → cero corridas', JSON.stringify(r2.runs));
  ok(r2.journal.every((j) => !j.fired && /cooldown/.test(j.skip_reason)),
    'pero los siete SÍ se journalean, con "cooldown" como razón: un disparo frenado deja rastro',
    JSON.stringify(r2.journal.map((j) => j.skip_reason)));
  const r2b = applyCaps(triggers, { now: new Date(TICK_1.getTime() + 21 * 60000), lastRunAt: hace5min });
  ok(r2b.runs.length === 1, 'pasados los 20 minutos el ticker vuelve a poder despertar al agente');

  // (3) STICKY: el hecho del DÍA no se cobra dos veces.
  const yaDisparo = new Set(['claude|NVDA|event_earnings', 'claude|KO|event_8k', 'claude|MU|near_trailing', 'claude|NVDA|volume_spike', 'claude|KO|near_catastrophic']);
  const r3 = applyCaps(triggers, { now: TICK_1, firedToday: yaDisparo });
  const stickySaltados = r3.journal.filter((j) => /sticky/.test(j.skip_reason || ''));
  ok(stickySaltados.length === 5,
    'earnings, 8-K, volumen y cercanía a stops disparan UNA vez por nombre por día', String(stickySaltados.length));
  ok(r3.runs.length === 1 && r3.runs[0].symbols.sort().join(',') === 'NVDA,PLTR',
    'los de PRECIO (±3% y buffet ±5%) NO son sticky: se re-arman contra la marca', JSON.stringify(r3.runs.map((r) => r.symbols)));

  // (4) TOPE DIARIO: 12 corridas por agente.
  const r4 = applyCaps(triggers, { now: TICK_1, runsToday: { claude: WATCH_RULES.max_runs_per_agent_day } });
  ok(r4.runs.length === 0 && r4.journal.every((j) => /tope diario/.test(j.skip_reason || '')),
    `al llegar a ${WATCH_RULES.max_runs_per_agent_day} corridas el agente no se despierta más hoy, y cada disparo frenado dice por qué`,
    JSON.stringify(r4.journal.map((j) => j.skip_reason).slice(0, 2)));
  const r4b = applyCaps(triggers, { now: TICK_1, runsToday: { claude: WATCH_RULES.max_runs_per_agent_day - 1 } });
  ok(r4b.runs.length === 1, 'con una corrida disponible, la agrupación consume UNA sola (no una por ticker)');

  // (5) TOPE POR TICK: la lambda tiene 300s.
  const muchos = ARENA_AGENTS.map((a) => ({ id: a.id, halted: false }));
  const libros = Object.fromEntries(muchos.map((a) => [a.id, { positions: POSITIONS, meta: LEVELS }]));
  const todos = evaluateTriggers({ agents: muchos, books: libros, quotes: QUOTES, marks: {}, dayEvents: DAY_EVENTS, buffet: ['PLTR'] });
  const r5 = applyCaps(todos, { now: TICK_1, rules: { ...WATCH_RULES, max_runs_per_tick: 3 } });
  ok(r5.runs.length === 3 && r5.journal.some((j) => /tope por tick/.test(j.skip_reason || '')),
    'el tope por tick recorta y lo diferido queda journaleado (la condición sigue en pie para el tick siguiente)',
    JSON.stringify({ corridas: r5.runs.length }));
}

// ═══ C) REVISIÓN DE PISO ════════════════════════════════════════════
console.log('\nvigilante: revisión de piso a la apertura +30');
{
  const agents = [{ id: 'claude', halted: false }, { id: 'control', halted: false }, { id: 'grok', halted: true }];
  const antes = sessionPhase(TICK_1, SESSION);
  const despues = sessionPhase(TICK_2, SESSION);
  ok(antes.open && antes.minutes_since_open === 20, 'el tick de 09:50 ET va 20 minutos dentro de la sesión', JSON.stringify(antes));
  ok(despues.minutes_since_open === 35, 'el de 10:05 ET va 35', JSON.stringify(despues));

  ok(floorReviewDue({ phase: antes, agents }).length === 0,
    `antes de la apertura +${WATCH_RULES.floor_after_open_minutes} min no hay revisión de piso`);
  const due = floorReviewDue({ phase: despues, agents });
  ok(due.join(',') === 'claude,control',
    'pasada la apertura +30, el agente al que ningún disparador tocó se pronuncia igual — y el HALTED no', JSON.stringify(due));
  ok(floorReviewDue({ phase: despues, agents, runsToday: { claude: 1 } }).join(',') === 'control',
    'el que YA fue despertado hoy por un disparador no necesita el piso: ya se pronunció');
  ok(floorReviewDue({ phase: despues, agents, floorDone: new Set(['claude', 'control']) }).length === 0,
    'y el piso corre UNA vez al día aunque el vigilante pase cada 5 minutos');

  // Mercado cerrado / fuera de sesión: el vigilante no inventa una sesión.
  ok(!sessionPhase(new Date('2026-09-15T12:00:00Z'), SESSION).open, 'a las 08:00 ET el mercado no está abierto');
  ok(!sessionPhase(TICK_1, null).open, 'sin fila de calendario (festivo) no hay sesión');
  ok(sessionPhase(new Date('2026-09-15T17:00:00Z'), { date: TODAY, open: '09:30', close: '13:00' }).open === false,
    'un MEDIO DÍA (cierre 13:00) se respeta: el horario sale del calendario de Alpaca, no está hardcodeado');
}

// ═══ D) PIEZAS FINAS + COSTO ════════════════════════════════════════
console.log('\nvigilante: marcas, marketable limit y costo del peor caso');
{
  ok(markPrice(null, 200).source === 'prev_close' && markPrice({ price: 190 }, 200).source === 'pronouncement',
    'la marca prefiere el último pronunciamiento y cae al cierre anterior — nunca inventa un precio');
  ok(markPrice(null, null) === null, 'sin ninguna referencia, la marca es null (no un cero que se lea como un hecho)');
  ok(Math.round(pointsToLevel(100, 98) * 100) / 100 === 2.04 && pointsToLevel(97, 98) < 0,
    'la distancia al nivel es en PUNTOS porcentuales y se vuelve negativa al cruzarlo', String(pointsToLevel(100, 98)));

  ok(marketableLimit(100, 'buy', 0.04) === 104 && marketableLimit(100, 'sell', 0.04) === 96,
    'marketable: la compra sale ARRIBA y la venta ABAJO — para que ejecuten en el momento');
  ok(marketableLimit(0, 'buy', 0.04) === null, 'sin referencia válida no se precia una orden');

  const est = estimateWorstCaseCost(ARENA_AGENTS);
  ok(est.per_agent.length === 7 && est.unpriced.length === 0,
    'el costo del peor caso se CALCULA para los siete (nada de un número escrito a mano en un doc)', JSON.stringify(est.unpriced));
  ok(est.assumptions.runs_per_agent_per_day === WATCH_RULES.max_runs_per_agent_day && est.assumptions.watchdog_llm_calls === 0,
    'el peor caso son los 12 topes por agente, y el vigilante en sí aporta CERO llamadas al LLM');
  ok(est.daily_usd > 0 && est.daily_usd < 5,
    'el peor caso absoluto de los siete cabe en unos pocos dólares al día — el tope es lo que lo garantiza', String(est.daily_usd));
  console.log(`         (peor caso calculado: $${est.daily_usd}/día, ~$${est.monthly_usd}/mes con los 7 al tope)`);

  ok(watchCadenceActive(new Date('2026-09-14T22:40:00Z')) === false,
    'el LUNES 14 la cadencia nueva todavía NO rige: la corrida de esa noche corre con el reglamento viejo');
  ok(watchCadenceActive(new Date('2026-09-15T13:50:00Z')) === true, 'el MARTES 15 sí');

  const titular = buildTriggerHeadline([
    { symbol: 'NVDA', type: 'move_since_pronouncement', detail: { price: 188, mark: 200, mark_source: 'prev_close', move_pct: -6 } },
  ]);
  ok(/ACOTADA a NVDA/.test(titular) && /-6%/.test(titular),
    'el encabezado que recibe el PM dice qué lo despertó y cuál es el alcance', titular);
}

// ═══ E) DE PUNTA A PUNTA sobre el día sintético ═════════════════════
console.log('\nvigilante: el tick completo, con todo el I/O mockeado');

// Estado persistente simulado (lo que en prod vive en Neon). Que sea STATEFUL
// es el punto: así el segundo tick ve lo que el primero escribió, que es
// exactamente donde viven el cooldown y los sticky.
const db = { watch: [], marks: [], events: [], meta: new Map(), journal: [] };
let llmCalls = [];
let orderPosts = [];
let dataCalls = [];

const DIVE = JSON.stringify({
  plan: 'NVDA cae 6% camino a su reporte de esta tarde: recorto a la mitad antes del número. PLTR rompió al alza y entro chico. KO y MU se quedan.',
  positions_review: [
    { symbol: 'NVDA', stance: 'trim', reason: 'no quiero el tamaño completo entrando al reporte de hoy AMC' },
    { symbol: 'KO', stance: 'hold', reason: 'cerca del stop catastrófico pero la tesis no cambió con el 8-K' },
    { symbol: 'MU', stance: 'hold', reason: 'a 1.2 puntos del trailing; si lo cruza, que lo cierre la regla' },
  ],
  commitment_updates: [],
  commitments: [],
  actions: [
    { symbol: 'NVDA', side: 'sell', notional: 1880, limit_price: 188, conviction: 4, reasoning: 'recorte previo al reporte' },
    { symbol: 'PLTR', side: 'buy', notional: 2140, limit_price: 21.4, conviction: 3, reasoning: 'ruptura con volumen' },
    // AAPL está DENTRO de banda a propósito: tiene que morir por estar fuera
    // del slate, no por un descarte del guard — si el guard la matara antes, el
    // test no probaría nada sobre el alcance de la corrida acotada.
    { symbol: 'AAPL', side: 'buy', notional: 5000, limit_price: 90, conviction: 2, reasoning: 'me gusta aparte' },
  ],
});

// Serie diaria por símbolo: el pico desde la entrada sale de aquí. MU llega a
// 130 (arma el trailing); NVDA se queda en 165 (no arma).
const DAY = 86400000;
const t0 = Date.UTC(2026, 6, 1);
function serieDe(sym) {
  const pico = { MU: 130, NVDA: 165, KO: 61, PLTR: 20.5 }[sym] || 100;
  const base = { MU: 100, NVDA: 150, KO: 58, PLTR: 18 }[sym] || 90;
  const closes = Array.from({ length: 40 }, (_, i) => base + ((i % 7) * (pico - base)) / 7);
  closes[20] = pico;
  closes[closes.length - 1] = QUOTES[sym] ? QUOTES[sym].prev_close : base;
  return { timestamps: closes.map((_, i) => (t0 + i * DAY) / 1000), closes };
}

// Fills históricos: sin ellos no hay fecha de apertura, y sin fecha de apertura
// el pico no se puede acotar → el trailing nunca armaría (fail-safe del T2 #3).
const FILLS = [{
  run_date: '2026-07-02',
  actions: [
    { symbol: 'MU', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 10, filled_avg_price: 100, filled_at: '2026-07-02T13:35:00Z' },
    { symbol: 'NVDA', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 20, filled_avg_price: 150, filled_at: '2026-07-02T13:35:00Z' },
    { symbol: 'KO', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 50, filled_avg_price: 60, filled_at: '2026-07-02T13:35:00Z' },
  ],
}];

const F = { text: 25, num: 1700, bool: 16, ts: 1184, json: 3802, int: 23 };
const table = (fields, rows) => ({ fields: fields.map(([name, t]) => ({ name, dataTypeID: t })), rows });

function neon(query, params) {
  const q = String(query || '');
  if (/^\s*insert into arena_journal/i.test(q)) { db.journal.push({ q, params }); return table([], []); }
  if (/from arena_state/i.test(q)) return table([['halted', F.bool], ['halted_at', F.ts], ['halted_reason', F.text], ['resumed_at', F.ts]], [['f', null, null, null]]);
  if (/^\s*insert into arena_state/i.test(q)) return table([], []);
  if (/^\s*insert into arena_watch_mark/i.test(q)) {
    db.marks = db.marks.filter((m) => !(m.agent_id === params[0] && m.symbol === params[1]));
    db.marks.push({ agent_id: params[0], symbol: params[1], price: params[2], marked_at: params[3] });
    return table([], []);
  }
  if (/from arena_watch_mark/i.test(q)) {
    return table([['agent_id', F.text], ['symbol', F.text], ['price', F.num], ['marked_at', F.ts]],
      db.marks.map((m) => [m.agent_id, m.symbol, String(m.price), m.marked_at]));
  }
  if (/^\s*insert into arena_watch_events/i.test(q)) {
    db.events = db.events.filter((e) => !(e.symbol === params[1] && e.kind === params[2]));
    db.events.push({ run_date: params[0], symbol: params[1], kind: params[2], detail: params[3], seen_at: params[4] });
    return table([], []);
  }
  if (/from arena_watch_events/i.test(q)) {
    return table([['symbol', F.text], ['kind', F.text], ['detail', F.json], ['seen_at', F.ts]],
      db.events.map((e) => [e.symbol, e.kind, e.detail, e.seen_at]));
  }
  if (/^\s*insert into arena_watch_meta/i.test(q)) { db.meta.set(params[0], params[1]); return table([], []); }
  if (/from arena_watch_meta/i.test(q)) {
    const v = db.meta.get(params[0]);
    return table([['value', F.json]], v === undefined ? [] : [[v]]);
  }
  if (/^\s*insert into arena_watch\b/i.test(q)) {
    db.watch.push({ run_date: params[0], agent_id: params[1], symbol: params[2], trigger_type: params[3], fired: params[4], skip_reason: params[5], detail: params[6], fired_at: params[7] });
    return table([], []);
  }
  if (/from arena_watch\b/i.test(q)) {
    const agg = new Map();
    for (const w of db.watch) {
      const k = [w.agent_id, w.symbol, w.trigger_type, w.fired].join('|');
      const prev = agg.get(k);
      if (!prev || w.fired_at > prev.last_at) agg.set(k, { ...w, last_at: w.fired_at });
    }
    return table([['agent_id', F.text], ['symbol', F.text], ['trigger_type', F.text], ['fired', F.bool], ['last_at', F.ts]],
      [...agg.values()].map((w) => [w.agent_id, w.symbol, w.trigger_type, w.fired ? 't' : 'f', w.last_at]));
  }
  if (/from arena_screener\b/i.test(q)) {
    // PLTR califica por MOMENTUM: close > ma50 > ma200 y no está extendido.
    return table([['symbol', F.text], ['security_type', F.text], ['last_close', F.num], ['ma50', F.num], ['ma200', F.num], ['refreshed_at', F.ts]],
      [['PLTR', 'Common Stock', '20', '18', '16', TICK_1.toISOString()]]);
  }
  if (/count\(\*\)::int as n from arena_journal/i.test(q)) {
    const n = {};
    for (const j of db.journal) {
      const ctx = j.params[12];
      if (!ctx) continue;
      let parsed = null;
      try { parsed = JSON.parse(ctx); } catch (e) { parsed = null; }
      const type = parsed && parsed.event && parsed.event.type;
      if (type === 'watch_trigger' || type === 'watch_floor') n[j.params[13]] = (n[j.params[13]] || 0) + 1;
    }
    return table([['agent_id', F.text], ['n', F.int]], Object.entries(n).map(([a, c]) => [a, String(c)]));
  }
  if (/actions from arena_journal/i.test(q)) {
    return table([['run_date', F.text], ['actions', F.json]], FILLS.map((f) => [f.run_date, JSON.stringify(f.actions)]));
  }
  if (/max\(\(account/i.test(q)) return table([['peak', F.num]], [['100000']]);
  return table([], []);
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const reply = (obj, status = 200) => ({
    ok: status < 300, status, headers: { get: () => 'application/json' },
    json: async () => obj, text: async () => JSON.stringify(obj),
  });

  if (u.includes('api.anthropic.com')) {
    const body = JSON.parse(opts.body || '{}');
    const sys = String(body.system || '');
    const phase = sys.includes('TU VOZ:') ? 'headline' : (sys.includes('SCOUT') ? 'scan' : 'dive');
    llmCalls.push({ phase, user: String(body.messages[0].content) });
    return reply({
      content: [{ type: 'text', text: phase === 'headline' ? 'Recorto NVDA antes del número: el tamaño completo no me deja dormir.' : DIVE }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 },
    });
  }
  if (u.includes('data.alpaca.markets')) {
    dataCalls.push(u);
    const syms = (new URL(u).searchParams.get('symbols') || '').split(',').filter(Boolean);
    if (u.includes('/snapshots')) {
      const out = {};
      for (const s of syms) {
        const q = QUOTES[s];
        if (!q) continue;
        out[s] = {
          latestTrade: { p: q.price, t: TICK_1.toISOString() },
          dailyBar: { c: q.price, o: q.prev_close, v: q.day_volume, t: TODAY + 'T13:30:00Z' },
          prevDailyBar: { c: q.prev_close, v: q.avg_volume_20d, t: '2026-09-14T13:30:00Z' },
        };
      }
      return reply({ snapshots: out });
    }
    if (u.includes('/bars')) {
      const bars = {};
      for (const s of syms) {
        const q = QUOTES[s];
        if (!q) continue;
        bars[s] = Array.from({ length: 20 }, (_, i) => ({ t: `2026-08-${String(i + 1).padStart(2, '0')}T13:30:00Z`, v: q.avg_volume_20d }));
      }
      return reply({ bars });
    }
    return reply({ message: 'ruta de datos inesperada' }, 404);
  }
  if (u.includes('paper-api.alpaca.markets')) {
    if (u.includes('/v2/calendar')) return reply([SESSION]);
    if (u.endsWith('/v2/account')) return reply({ status: 'ACTIVE', equity: '100000', cash: '90000' });
    if (u.endsWith('/v2/positions')) return reply(POSITIONS);
    if (u.includes('/v2/orders?')) return reply([]);
    if (u.endsWith('/v2/orders') && method === 'POST') {
      const body = JSON.parse(opts.body);
      orderPosts.push(body);
      return reply({ id: 'ord-' + orderPosts.length, status: 'accepted', ...body });
    }
    return reply({ message: 'ruta alpaca inesperada: ' + u }, 404);
  }
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return reply(['NVDA', 'KO', 'MU', 'PLTR', 'AAPL'].map((s) => ({ symbol: s, description: s + ' INC', type: 'Common Stock' })));
  }
  if (u.includes('finnhub.io/api/v1/stock/metric')) return reply({ metric: { peTTM: 25 } });
  if (u.includes('finnhub.io/api/v1/stock/profile2')) return reply({ name: 'Test Co', marketCapitalization: 100000 });
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) return reply([{ period: '2026-09-01', strongBuy: 5, buy: 5, hold: 2, sell: 0, strongSell: 0 }]);
  if (u.includes('finnhub.io/api/v1/company-news')) return reply([]);
  if (u.includes('query1.finance.yahoo.com') || u.includes('yahoo')) {
    const m = u.match(/chart\/([A-Z.]+)/i);
    const s = serieDe(m ? m[1].toUpperCase() : 'NVDA');
    return reply({ chart: { result: [{ timestamp: s.timestamps, indicators: { quote: [{ close: s.closes }] } }] } });
  }
  if (u.includes('www.sec.gov/files/company_tickers.json')) {
    return reply({ 0: { cik_str: 21344, ticker: 'KO', title: 'Coca Cola Co' }, 1: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA Corp' } });
  }
  if (u.includes('data.sec.gov/submissions/')) {
    const esKO = u.includes('0000021344');
    return reply({
      filings: {
        recent: {
          form: ['8-K', '10-Q'],
          items: ['5.02', ''],
          acceptanceDateTime: [esKO ? TODAY + 'T12:10:00.000Z' : '2026-08-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z'],
          filingDate: [esKO ? TODAY : '2026-08-01', '2026-07-01'],
          accessionNumber: ['0000-1', '0000-2'],
        },
      },
    });
  }
  if (u.includes('/api/earnings')) {
    return reply({ earnings: [{ ticker: 'NVDA', company: 'NVIDIA', date: TODAY, time: 'AMC', eps_est: 1.2 }] });
  }
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    if (body.queries) return reply({ results: body.queries.map((x) => neon(x.query, x.params)) });
    return reply(neon(body.query, body.params));
  }
  if (u.includes('/api/movers') || u.includes('/api/stock-tracker')) {
    throw new Error('el vigilante NO debe pedir el buffet completo por tick: ' + u);
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

const BASE_URL = 'http://qd.test';

// ── TICK 1: 09:50 ET, antes de la revisión de piso ──────────────────
{
  llmCalls = []; orderPosts = []; dataCalls = [];
  const r = await runArenaWatch({ baseUrl: BASE_URL, now: TICK_1 });

  ok(r.status === 'ok', 'el tick corre con el mercado abierto', JSON.stringify({ status: r.status, error: r.error }));
  ok(r.runs.length === 2 && r.runs.map((x) => x.id).sort().join(',') === 'claude,control',
    'los DOS agentes se despiertan — el control por el mismo camino y con los mismos umbrales que el insignia',
    JSON.stringify(r.runs.map((x) => x.id)));
  ok(r.floor_runs.length === 0, 'antes de la apertura +30 no hay revisión de piso', JSON.stringify(r.floor_runs));

  // La RED DETERMINISTA corre en el PRIMER tick de la sesión, no en el de piso:
  // decide con el cierre de ayer (el mismo dato que tenía la corrida nocturna),
  // así que esperar media hora solo retrasaría el fill.
  ok(r.risk_net.length === 2 && r.risk_net.every((x) => x.status === 'ok_no_exits'),
    'la RED DETERMINISTA corre desde el primer tick, para los dos agentes — no se fue con el cron nocturno',
    JSON.stringify(r.risk_net.map((x) => x.status)));

  // El vigilante mide con DOS requests multi-símbolo, no uno por nombre.
  ok(dataCalls.length === 2 && dataCalls.some((u) => u.includes('/snapshots')) && dataCalls.some((u) => u.includes('/bars')),
    'mirar el mercado cuesta DOS llamadas multi-símbolo (snapshot + volumen), no una por ticker', String(dataCalls.length));

  // CERO tokens del vigilante: las únicas llamadas al LLM son las corridas que
  // despertó, y ninguna es un SCAN (el disparador ya definió el slate).
  const scans = llmCalls.filter((c) => c.phase === 'scan');
  const dives = llmCalls.filter((c) => c.phase === 'dive');
  ok(scans.length === 0, 'CERO llamadas al SCOUT: el disparador ya eligió los nombres, pagar por elegirlos otra vez sería tirar tokens');
  ok(dives.length === 2, 'una sola llamada de decisión por agente despertado (no una por ticker)', String(dives.length));

  const user = dives[0].user;
  ok(/ACOTADA a /.test(user) && /SCOPE: this run is limited to/.test(user),
    'el prompt le dice al PM qué lo despertó y que la corrida está acotada a esos nombres');
  ok(/YOUR ORDERS EXECUTE NOW/.test(user) && /marketable limits/.test(user),
    'y que sus órdenes ejecutan EN EL MOMENTO, no en la apertura siguiente');
  ok(/INTRADAY REFERENCE/.test(user) && /"last_close":188/.test(user.replace(/\s/g, '')),
    'la referencia de precio que ve el PM es el precio VIVO (188), no el cierre de ayer (200)');
  ok(/You MAY open a new position/.test(user),
    'y el reglamento COMPLETO aplica: puede comprar — un candidato del buffet que se movió 5% es una compra o no es nada');

  // ── Órdenes: intradía y marketable en AMBOS lados ──
  const porAgente = orderPosts.length / 2;
  ok(porAgente === 2, 'dos órdenes por agente: la venta de NVDA y la compra de PLTR (la de AAPL murió fuera del slate)', String(orderPosts.length));
  const venta = orderPosts.find((o) => o.symbol === 'NVDA');
  const compra = orderPosts.find((o) => o.symbol === 'PLTR');
  ok(venta && Number(venta.limit_price) === 180.48,
    'la VENTA sale marketable por DEBAJO del precio vivo (188 × 0.96), para que llene ya', venta && venta.limit_price);
  ok(compra && Number(compra.limit_price) === 22.26,
    'la COMPRA sale marketable por ARRIBA (21.4 × 1.04): intradía, un límite pasivo no ejecuta — descansa', compra && compra.limit_price);
  ok(orderPosts.every((o) => o.type === 'limit' && o.time_in_force === 'day'),
    'y siguen siendo órdenes LÍMITE day: la regla de la casa no se rompe para ejecutar rápido');
  ok(!orderPosts.some((o) => o.symbol === 'AAPL'),
    'AAPL —que el PM quiso comprar fuera del slate— NO llega al mercado');
  ok(orderPosts.every((o) => /:w1350$/.test(o.client_order_id)),
    'el client_order_id lleva el tag de la corrida y el minuto: dos corridas del mismo día sobre el mismo nombre ya no colisionan',
    JSON.stringify(orderPosts.map((o) => o.client_order_id)));

  // ── Journaling: TODO disparador, con su razón ──
  const deClaude = db.watch.filter((w) => w.agent_id === 'claude');
  ok(deClaude.length === 7 && deClaude.every((w) => w.fired),
    'los siete disparadores de este agente quedan journaleados con su detalle', JSON.stringify(deClaude.map((w) => w.trigger_type)));
  ok(deClaude.some((w) => w.trigger_type === 'event_8k' && w.symbol === 'KO'),
    'incluido el 8-K, que salió de SEC EDGAR y no de un precio');
  const fila = db.journal.find((j) => j.params.length === 14 && /watch_trigger/.test(String(j.params[12] || '')));
  const ctx = JSON.parse(fila.params[12]);
  ok(ctx.event.type === 'watch_trigger' && ctx.event.symbols.length === 4,
    'la fila del journal guarda el evento que disparó la corrida y su alcance', JSON.stringify(ctx.event.symbols));
  ok(ctx.scan && ctx.scan.skipped === 'watch_trigger' && !ctx.scan.prompt,
    'y dice explícitamente que el SCAN se saltó (no que falló)', JSON.stringify(ctx.scan));
  ok(ctx.intraday && ctx.intraday.prices.NVDA === 188,
    'el precio vivo con el que se decidió queda auditable en el journal', JSON.stringify(ctx.intraday && ctx.intraday.prices));
  const descartada = (JSON.parse(fila.params[9]) || []).find((a) => a.symbol === 'AAPL');
  ok(descartada && descartada.result === 'discarded' && /fuera del alcance/.test(descartada.reason),
    'el intento de irse fuera del slate queda journaleado con su razón — no desaparece en silencio', descartada && descartada.reason);

  // Las marcas quedaron re-fijadas sobre TODO el slate.
  ok(db.marks.filter((m) => m.agent_id === 'claude').length === 4,
    'la marca del ±3% se re-fija sobre los cuatro nombres del slate: el agente se pronunció sobre todos');
}

// ── TICK 2: 10:05 ET — cooldown, sticky y revisión de piso ──────────
{
  llmCalls = []; orderPosts = [];
  const r = await runArenaWatch({ baseUrl: BASE_URL, now: TICK_2 });

  ok(r.status === 'ok', 'el segundo tick corre', r.status);
  ok(r.runs.length === 0,
    '15 minutos después NADIE se despierta: los de precio ya tienen marca nueva y los demás están en cooldown o ya dispararon hoy',
    JSON.stringify(r.runs.map((x) => ({ id: x.id, s: x.symbols }))));
  ok(llmCalls.filter((c) => c.phase === 'dive').length === 0 || r.floor_runs.length > 0,
    'y si no hubo corrida por disparador, el gasto del tick es cero o el de la revisión de piso');
  ok(r.triggers_skipped.length > 0 && r.triggers_skipped.every((t) => t.reason),
    'cada disparo frenado queda listado CON su razón (cooldown / sticky / tope)',
    JSON.stringify(r.triggers_skipped.slice(0, 3)));

  // El piso NO corre para quien ya fue despertado hoy — que es justo el caso.
  ok(r.floor_runs.length === 0,
    'la revisión de piso no toca a quien un disparador ya despertó hoy: ya se pronunció sobre su libro',
    JSON.stringify(r.floor_runs));
  ok(Array.isArray(r.risk_net) && r.risk_net.length === 0,
    'y la RED DETERMINISTA no se repite: ya corrió en el primer tick, y el vigilante pasa cada 5 minutos',
    JSON.stringify(r.risk_net));
  ok(llmCalls.length === 0,
    'el tick entero no gasta un solo token: ni el vigilante ni la red determinista llaman a un modelo', String(llmCalls.length));
}

// ── TICK 3: mismo estado, pero con la cadencia todavía sin arrancar ──
{
  const r = await runArenaWatch({ baseUrl: BASE_URL, now: new Date('2026-09-14T13:50:00Z') });
  ok(r.status === 'pending_cadence',
    'el LUNES 14 el vigilante no hace NADA: el cron puede estar desplegado días antes sin tocar la corrida de esa noche', r.status);
}

// ── TICK 4: festivo / fuera de sesión ───────────────────────────────
{
  llmCalls = [];
  const r = await runArenaWatch({ baseUrl: BASE_URL, now: new Date('2026-09-15T12:00:00Z') });
  ok(r.status === 'skipped_market_closed' && llmCalls.length === 0,
    'fuera del horario de sesión el tick sale con una llamada al calendario y cero gasto', r.status);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
