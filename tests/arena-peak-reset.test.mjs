// ═══════════════════════════════════════════════════════════════
// tests/arena-peak-reset.test.mjs — el breaker NO mata al agente en el reset.
//
// EL BUG (encontrado el 15, habría disparado el lunes 21): el high-water-mark
// del breaker sale de `max(account->>'equity')` sobre arena_journal, y esa
// consulta solo estaba acotada por `resumed_at` — que existe para el halt/resume
// manual, NO para la temporada. Con el `season_started` que aplana las siete
// cuentas y resetea a $100k, el pico de la temporada ANTERIOR seguía contando:
//
//     pico $130k vs equity $100k → drawdown −23% → risk_broad_cut
//     → liquidación + HALT PERSISTENTE, en la PRIMERA corrida de la temporada.
//
// Y el halt se revive a mano. El relanzamiento habría durado una corrida.
//
// ESTE TEST ES DE COMPORTAMIENTO, no un lint: corre runArenaDecide de verdad
// contra un journal que tiene una fila de $130k de la temporada anterior. El
// mock de Neon aplica el corte COMO LO HARÍA POSTGRES —filtra por el parámetro
// `run_date >= $n` si la consulta lo trae— así que:
//
//   · con el corte (código actual)      → peak = 100k → drawdown 0 → corre normal
//   · sin el corte (si alguien lo saca)  → peak = 130k → broadcut → ESTE TEST FALLA
//
// Por eso vive en la suite permanente: es el guardián de que el próximo
// `season_started` no liquide a los siete.
// Correr con `node tests/arena-peak-reset.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ALPACA_PAPER_KEY = 'PKTEST';
process.env.ALPACA_PAPER_SECRET = 'SECRETTEST';
process.env.FINNHUB_API_KEY = 'fh-test';
process.env.ARENA_ALLOW_UNVERIFIED_SLUGS = '1';
// SIN ANTHROPIC_API_KEY a propósito: la red de riesgo se evalúa ANTES del LLM,
// así que el run llega hasta el punto que importa y después aborta barato.
delete process.env.ANTHROPIC_API_KEY;

import { runArenaDecide } from '../api/arena-run.js';
import { ARENA_SEASON, agentById } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const BASE_URL = 'http://qd.test';
const DAY = 86400000;

// ── El journal: una fila GORDA de la temporada anterior y una del reset ──
// $130k es el pico de la T2; $100k es el equity del día del reset.
const SEASON_START = ARENA_SEASON.start;
const diaAnterior = new Date(Date.parse(SEASON_START + 'T00:00:00Z') - 10 * DAY).toISOString().slice(0, 10);
const JOURNAL_EQUITY = [
  { run_date: diaAnterior, equity: 130000 },   // temporada ANTERIOR
  { run_date: SEASON_START, equity: 100000 },  // el reset
];

// Modo del mock: 'con_corte' honra el parámetro de fecha (lo que hace Postgres
// con el SQL actual); 'sin_corte' lo ignora (el bug, para probar que el test
// detectaría la regresión).
let modo = 'con_corte';

const jsonReply = (obj) => ({
  ok: true, status: 200,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const closes = Array.from({ length: 30 }, () => 100);
const timestamps = closes.map((_, i) => (Date.UTC(2026, 4, 1) + i * DAY) / 1000);

const journalInserts = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body);
    const q = body.query || '';

    if (q.includes("max((account->>'equity')")) {
      // ── EL CORAZÓN DEL TEST ──
      // Postgres filtraría por `run_date >= $n::date` si la consulta lo trae.
      // El mock hace lo mismo: así el test mide el SQL real, no una constante.
      const traeCorte = /run_date\s*>=\s*\$\d+::date/.test(q);
      const filas = (traeCorte && modo === 'con_corte')
        ? JOURNAL_EQUITY.filter((r) => r.run_date >= SEASON_START)
        : JOURNAL_EQUITY;
      const peak = filas.length ? Math.max(...filas.map((r) => r.equity)) : null;
      return jsonReply({ fields: [{ name: 'peak', dataTypeID: 1700 }], rows: [[peak == null ? null : String(peak)]] });
    }
    if (q.includes('from arena_state')) {
      return jsonReply({
        fields: [{ name: 'halted', dataTypeID: 16 }, { name: 'halted_at', dataTypeID: 1184 }, { name: 'halted_reason', dataTypeID: 25 }, { name: 'resumed_at', dataTypeID: 1184 }],
        rows: [['f', null, null, null]],
      });
    }
    if (q.includes('insert into arena_journal')) { journalInserts.push(body); return jsonReply({ fields: [], rows: [] }); }
    if (q.includes('update arena_state') || q.includes('update arena_journal')) return jsonReply({ fields: [], rows: [] });
    return jsonReply({ fields: [], rows: [] });
  }

  // Alpaca: una posición, equity YA reseteado a $100k.
  if (u.includes('alpaca')) {
    if (u.includes('/v2/account')) return jsonReply({ equity: '100000', cash: '100000', account_number: 'PA-TEST' });
    if (u.includes('/v2/positions')) return jsonReply([{ symbol: 'AAPL', qty: '1', avg_entry_price: '100', market_value: '100', unrealized_plpc: '0' }]);
    if (u.includes('/v2/orders')) return jsonReply([]);
    if (u.includes('/v2/calendar')) return jsonReply([{ date: new Date().toISOString().slice(0, 10), open: '09:30', close: '16:00' }]);
    return jsonReply({});
  }
  if (u.includes('yahoo')) {
    return jsonReply({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes, open: closes, high: closes, low: closes, volume: closes.map(() => 1e6) }] } }] } });
  }
  if (u.includes('finnhub')) {
    if (u.includes('profile2')) return jsonReply({ marketCapitalization: 3_000_000 });
    if (u.includes('stock/symbol')) return jsonReply([{ symbol: 'AAPL', type: 'Common Stock', description: 'APPLE INC' }]);
    return jsonReply({});
  }
  if (u.startsWith(BASE_URL)) return jsonReply({ universe: 'market', gainers: [], losers: [], actives: [] });
  return jsonReply({});
};

const agent = agentById('claude');

console.log('reset de temporada: el pico viejo NO dispara el breaker');
{
  modo = 'con_corte';
  journalInserts.length = 0;
  const r = await runArenaDecide({ baseUrl: BASE_URL, agent });

  ok(r.status !== 'risk_broad_cut',
    'con el corte por temporada, el reset a $100k NO dispara el corte amplio', r.status);
  ok(r.halted !== true, 'y el agente NO queda HALTED en su primera corrida de la temporada', String(r.halted));
  ok(r.drawdown === 0 || r.drawdown === undefined,
    'el drawdown del primer día es 0: el pico ES el equity de hoy', String(r.drawdown));
  ok(!journalInserts.some((b) => /risk_broad_cut/.test(JSON.stringify(b.params || []))),
    'no se journaleó ninguna fila de corte amplio');
  // El run sigue su curso y aborta barato por falta de key — prueba que llegó
  // MÁS ALLÁ de la red de riesgo en vez de morir antes por otra razón.
  ok(r.status === 'aborted_no_api_key',
    'el run continuó hasta el gate de API key (llegó más allá de la red de riesgo)', r.status);
}

console.log('\nregresión: si alguien saca el corte, el breaker vuelve a matar');
{
  // Se simula el SQL viejo (mock ignorando el parámetro de fecha). Si este
  // bloque dejara de dar broadcut, el test de arriba sería un falso verde:
  // querría decir que el escenario ya no es peligroso por otra razón y que el
  // primer assert no está midiendo lo que cree medir.
  modo = 'sin_corte';
  journalInserts.length = 0;
  const r = await runArenaDecide({ baseUrl: BASE_URL, agent });

  ok(r.status === 'risk_broad_cut',
    'sin corte, el pico de $130k contra $100k SÍ dispara el corte amplio', r.status);
  ok(r.halted === true, 'y el agente queda HALTED — que es exactamente lo que el corte evita', String(r.halted));
  ok(Math.abs(r.drawdown - 0.2308) < 0.001,
    'el drawdown calculado sin corte es −23.08%, por encima del umbral de −20%', String(r.drawdown));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : `\n${failures} FAIL`);
process.exit(failures ? 1 : 0);
