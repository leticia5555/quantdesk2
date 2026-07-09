// ═══════════════════════════════════════════════════════════════
// Test de integración de /api/agents-run: processAgents() de punta a punta
// con TODO el I/O mockeado a nivel fetch — el Neon fake responde el formato
// wire real (fields + rows en array-mode, valores como texto) y el Yahoo
// fake sirve una serie sintética. Se validan las queries que se persisten.
// Correr con `node tests/agents-run.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { processAgents } from '../api/agents-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';

// ── serie Yahoo sintética: breakout garantizado ──
// 40 velas: 30 planas en 100, salto a 111 (rompe máx 20d) y deriva arriba.
const DAY = 86400000;
const t0 = Date.UTC(2026, 4, 1); // 2026-05-01, muy anterior a "hoy"
const closes = [];
for (let i = 0; i < 30; i++) closes.push(100);
for (let i = 0; i < 10; i++) closes.push(111 + i);
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

// ── edge y agente canned (lo que devolvería la DB) ──
const EDGE_ROW_FIELDS = [
  { name: 'id', dataTypeID: 25 }, { name: 'user_id', dataTypeID: 25 },
  { name: 'engine', dataTypeID: 25 }, { name: 'config', dataTypeID: 3802 },
];
const edgeConfig = JSON.stringify({ ticker: 'TST', rule: 'breakout', direction: 'long', range: '2y', params: { lookback: 20 } });

const batches = [];
global.fetch = async (url, opts) => {
  if (String(url).includes('yahoo')) {
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } }) };
  }
  // Neon fake
  const body = JSON.parse(opts.body);
  if (body.queries) { // batch de persistencia
    batches.push(body.queries);
    return { ok: true, json: async () => ({ results: body.queries.map(() => ({ fields: [], rows: [] })) }) };
  }
  const q = body.query;
  if (q.includes('from edges')) {
    return { ok: true, json: async () => ({ fields: EDGE_ROW_FIELDS, rows: [['e1', 'u1', 'signals', edgeConfig]] }) };
  }
  if (q.includes('from positions')) {
    return { ok: true, json: async () => ({ fields: [], rows: [] }) };
  }
  return { ok: true, json: async () => ({ fields: [], rows: [] }) };
};

const agent = {
  id: 'a1', user_id: 'u1', name: 'Test', status: 'alive',
  cash: 10000, equity: 10000, equity_peak: 10000, capital_start: 10000, last_run_date: null,
};
const summary = await processAgents([agent]);

console.log('agents-run: integración con Neon + Yahoo fake');
ok(summary.agents_processed === 1, 'procesó el agente', JSON.stringify(summary));
ok(summary.errors.length === 0, 'sin errores', JSON.stringify(summary.errors));
ok(summary.days === 40, 'procesó las 40 velas', summary.days);
ok(summary.opened === 1, 'el breakout abrió una posición', summary.opened);

const flat = batches.flat();
const agentUpdate = flat.find((it) => it.query.includes('update agents'));
ok(!!agentUpdate, 'persistió el update del agente');
ok(agentUpdate && agentUpdate.params[4] === '2026-06-09', 'last_run_date = última vela procesada', agentUpdate && agentUpdate.params[4]);
ok(agentUpdate && agentUpdate.params[5] === 'alive', 'sigue vivo (subió, no murió)');

const posUpserts = flat.filter((it) => it.query.includes('insert into positions'));
ok(posUpserts.length === 1, 'un upsert de posición', posUpserts.length);
ok(posUpserts[0] && posUpserts[0].params[11] === 'open', 'la posición queda abierta (deriva alcista sin salida)');

const eqInserts = flat.filter((it) => it.query.includes('insert into equity_history'));
ok(eqInserts.length === 40, 'una fila de equity por vela', eqInserts.length);
const lastEq = eqInserts[eqInserts.length - 1].params[2];
ok(lastEq > 10000, 'el equity final refleja la posición ganadora', lastEq);

// idempotencia a nivel integración: el agente ya avanzó; re-correr = no-op
const batchesBefore = batches.length;
const summary2 = await processAgents([agent]);
ok(summary2.agents_processed === 0 && batches.length === batchesBefore,
  're-correr sin velas nuevas no persiste nada (cron + catch-up no se duplican)');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
