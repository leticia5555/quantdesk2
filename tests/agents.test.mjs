// ═══════════════════════════════════════════════════════════════
// Unit tests de los agentes de paper trading: motor de simulación
// (_lib/sim.js) con series sintéticas deterministas + capa Neon
// (_lib/db.js) con fetch mockeado. Sin red.
// Correr con `node tests/agents.test.mjs`; sale ≠ 0 si algo falla.
// ═══════════════════════════════════════════════════════════════

import {
  ASSUMPTIONS, NOTIONAL_FRACTION, fillPrice, commission, legValue,
  completedSlice, runAgent,
} from '../api/_lib/sim.js';
import { sql, sqlEndpoint, coerce } from '../api/_lib/db.js';
import { migrationSource } from '../api/agents.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function freshAgent(over = {}) {
  return { id: 'a1', status: 'alive', cash: 10000, equity: 10000, equity_peak: 10000, last_run_date: null, ...over };
}
function series(closes, startIdx = 0) {
  return { dates: closes.map((_, i) => 'D' + String(i + startIdx).padStart(3, '0')), closes };
}

// ─────────────────── señales: entrada, salida, contabilidad ───────────────────
console.log('sim: señal breakout — ciclo completo con contabilidad exacta');
{
  // breakout lookback=4: entra en D005 (11 > máx 10), sale en D009 (9 < mín(13,12.5))
  const closes = [10, 10, 10, 10, 10, 11, 12, 13, 12.5, 9];
  const edge = { id: 'e1', engine: 'signals', config: { ticker: 'TST', rule: 'breakout', direction: 'long', range: '2y', params: { lookback: 4 } } };
  const agent = freshAgent();
  const ev = runAgent(agent, [edge], [], { TST: series(closes) });

  ok(ev.opened.length === 1 && ev.closed.length === 1, 'un trade completo', JSON.stringify([ev.opened.length, ev.closed.length]));
  const pos = ev.closed[0];
  ok(pos.entry_date === 'D005' && pos.exit_date === 'D009', 'fechas de entrada/salida correctas', pos.entry_date + '/' + pos.exit_date);

  // contabilidad dígito a dígito
  const fillIn = 11 * (1 + ASSUMPTIONS.slippage_per_side);
  const notional = 10000 * NOTIONAL_FRACTION;              // 2000 (2% riesgo / stop 10%)
  const qty = notional / fillIn;
  ok(near(pos.entry_price, fillIn), 'fill de entrada = cierre + slippage adverso', pos.entry_price);
  ok(near(pos.qty, qty), 'sizing 2% riesgo → notional 20% del equity', pos.qty);
  const fillOut = 9 * (1 - ASSUMPTIONS.slippage_per_side);
  const expectedPnl = qty * fillOut - notional - commission(notional) - commission(qty * fillOut);
  ok(near(pos.pnl, expectedPnl), 'pnl = proceeds − notional − comisiones', pos.pnl + ' vs ' + expectedPnl);
  ok(pos.pnl < 0, 'el trade perdedor pierde (los edges malos pierden visiblemente)');

  // identidad: sin posiciones abiertas, equity == cash
  ok(near(agent.equity, agent.cash), 'equity == cash al quedar plano', agent.equity + ' vs ' + agent.cash);
  ok(ev.equityRows.length === 10 && agent.last_run_date === 'D009', 'una fila de equity por día procesado');
  ok(near(ev.equityRows[0].equity, 10000), 'equity arranca en $10,000');

  // idempotencia: re-correr no duplica nada
  const ev2 = runAgent(agent, [edge], [], { TST: series(closes) });
  ok(!ev2.opened.length && !ev2.closed.length && !ev2.equityRows.length, 'catch-up idempotente: segunda corrida = no-op');
}

console.log('sim: stop del 10% (sin señal de salida de la regla)');
{
  // RSI long: 30 barras planas, caída sostenida → entra por rsi<30 y la
  // caída sigue sin rebote (rsi nunca >70): sale por el stop de 10%.
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100);
  for (let i = 0; i < 30; i++) closes.push(100 * Math.pow(0.985, i + 1));
  const edge = { id: 'e2', engine: 'signals', config: { ticker: 'TST', rule: 'rsi', direction: 'long', range: '2y', params: { rsiPeriod: 14, entryLevel: 30, exitLevel: 70 } } };
  const agent = freshAgent();
  const ev = runAgent(agent, [edge], [], { TST: series(closes) });
  ok(ev.closed.length >= 1, 'hubo al menos un trade');
  ok(ev.closed[0].exit_reason === 'stop', 'salida por stop, no por regla', ev.closed[0].exit_reason);
  const p = ev.closed[0];
  ok(p.exit_price <= p.stop_price, 'el fill de salida está en/bajo el stop', p.exit_price + ' vs stop ' + p.stop_price);
}

console.log('sim: MUERTE a -20% del peak — congelado');
{
  // Posición abierta heredada de DB: 100 acciones a $100. equity = cash + 100·close.
  // peak 10500 → muere cuando equity <= 8400 → close <= 79.
  const openPos = {
    id: 'p0', agent_id: 'a1', edge_id: 'e3', symbol: 'TST', direction: 'long', legs: null,
    qty: 100, entry_price: 100, entry_date: 'D000', stop_price: 1, // stop lejano: que mate el drawdown, no el stop
    notional: 10000, status: 'open',
  };
  const agent = freshAgent({ cash: 500, equity: 10500, equity_peak: 10500, last_run_date: 'D000' });
  // RSI(14) sobre 6 barras: sin historia suficiente, la regla nunca dispara
  // ni entrada ni salida — la posición heredada queda a merced del drawdown.
  const edge = { id: 'e3', engine: 'signals', config: { ticker: 'TST', rule: 'rsi', direction: 'long', range: '2y', params: { rsiPeriod: 14, entryLevel: 30, exitLevel: 70 } } };
  const closes = [100, 95, 88, 75, 70, 65];
  const ev = runAgent(agent, [edge], [openPos], { TST: series(closes) });

  ok(ev.died === true, 'el agente muere');
  ok(ev.died_on === 'D003', 'muere el día que el equity cruza -20% del peak (close 75)', ev.died_on);
  const closedByDeath = ev.closed.find((p) => p.exit_reason === 'muerte');
  ok(!!closedByDeath, 'la posición se liquida con exit_reason=muerte');
  ok(near(agent.equity, agent.cash), 'tras liquidar todo, equity == cash');
  ok(agent.last_run_date === 'D003', 'no procesa días después de morir (congelado)', agent.last_run_date);
  ok(ev.equityRows[ev.equityRows.length - 1].date === 'D003', 'la última fila de equity es el día de la muerte');

  // congelado: una corrida sobre el agente muerto es no-op
  const ev2 = runAgent({ ...agent, status: 'dead' }, [edge], [], { TST: series(closes) });
  ok(!ev2.equityRows.length && !ev2.opened.length, 'muerto = congelado: correr de nuevo no hace nada');
}

console.log('sim: pares — z-score entra en divergencia, sale en convergencia');
{
  // Par cointegrado sintético: y = 1.4·x con ruido chico determinista.
  // Divergencia del 6% en y durante las barras 320..344, luego converge.
  const n = 400, xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    const x = 100 + 8 * Math.sin(i / 17) + 2 * Math.sin(i / 3.1);
    const noise = 1 + 0.002 * Math.sin(i / 1.7);
    let y = 1.4 * x * noise;
    if (i >= 320 && i < 345) y *= 1.06;   // y se encarece → z alto → short spread
    xs.push(x); ys.push(y);
  }
  const edge = { id: 'e4', engine: 'pairs', config: { x: 'XX', y: 'YY', range: '2y' } };
  const agent = freshAgent();
  const ev = runAgent(agent, [edge], [], { XX: series(xs), YY: series(ys) });

  ok(ev.opened.length >= 1, 'la divergencia dispara una entrada', ev.opened.length);
  const pos = ev.opened[0];
  ok(pos.direction === 'short_spread', 'y cara → short del spread', pos.direction);
  ok(Array.isArray(pos.legs) && pos.legs.length === 2, 'dos legs');
  const yLeg = pos.legs.find((l) => l.symbol === 'YY'), xLeg = pos.legs.find((l) => l.symbol === 'XX');
  ok(yLeg.direction === 'short' && xLeg.direction === 'long', 'short Y / long X');
  ok(near(yLeg.notional, 10000 * ASSUMPTIONS.pair_leg_fraction, 1), 'cada leg ~10% del equity', yLeg.notional);

  const closedRule = ev.closed.find((p) => p.direction === 'short_spread' && p.exit_reason === 'regla');
  ok(!!closedRule, 'sale cuando z cruza 0 (convergencia)');
  ok(closedRule && closedRule.pnl > 0, 'la convergencia del par deja pnl positivo', closedRule && closedRule.pnl);
  ok(near(agent.equity, agent.cash + 0, 1e-6) || ev.stillOpen.length > 0, 'contabilidad consistente al final');
}

console.log('sim: barra del día en curso excluida hasta el cierre');
{
  const s = { dates: ['2026-07-08', '2026-07-09'], closes: [1, 2] };
  const during = completedSlice(s, new Date('2026-07-09T15:00:00Z'));
  const after = completedSlice(s, new Date('2026-07-09T22:30:00Z'));
  ok(during.dates.length === 1 && during.dates[0] === '2026-07-08', 'a media sesión, la vela de hoy se excluye');
  ok(after.dates.length === 2, 'después de las 22 UTC, la vela de hoy cuenta');
}

// ─────────────────── capa Neon (fetch mockeado) ───────────────────
console.log('db: protocolo SQL-over-HTTP de Neon');
{
  ok(sqlEndpoint('postgres://user:pass@ep-abc-123.us-east-2.aws.neon.tech/neondb?sslmode=require') ===
     'https://api.us-east-2.aws.neon.tech/sql',
    'endpoint: primer label del host → api. + /sql');

  ok(coerce('42', 23) === 42 && coerce('1.5', 1700) === 1.5, 'coerción numérica por OID');
  ok(coerce('t', 16) === true && coerce(null, 23) === null, 'boolean y null');
  ok(coerce('{"a":1}', 3802).a === 1, 'jsonb parseado');

  process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({
      command: 'SELECT', rowCount: 1,
      fields: [{ name: 'id', dataTypeID: 25 }, { name: 'equity', dataTypeID: 1700 }, { name: 'config', dataTypeID: 3802 }],
      rows: [['a1', '10123.45', '{"ticker":"AAPL"}']],
    }) };
  };
  const rows = await sql('select * from agents where user_id = $1', ['u1']);
  ok(captured.url === 'https://api.us-east-2.aws.neon.tech/sql', 'POST al endpoint correcto', captured.url);
  ok(captured.headers['Neon-Connection-String'] === process.env.DATABASE_URL &&
     captured.headers['Neon-Raw-Text-Output'] === 'true' && captured.headers['Neon-Array-Mode'] === 'true',
    'headers del protocolo del driver');
  ok(captured.body.query.startsWith('select') && captured.body.params[0] === 'u1', 'body {query, params}');
  ok(rows.length === 1 && rows[0].equity === 10123.45 && rows[0].config.ticker === 'AAPL',
    'filas array → objetos con tipos coercionados', JSON.stringify(rows[0]));
  global.fetch = realFetch;
}

console.log('agents: marca de procedencia en la migración');
{
  ok(migrationSource('quantdesk-app-v0') === 'localStorage:quantdesk-app-v0', 'marca la procedencia');
  ok(migrationSource('localStorage:quantdesk-app-v0') === 'localStorage:quantdesk-app-v0', 're-migrar no duplica el prefijo');
  ok(migrationSource(null) === 'localStorage:quantdesk-app-v0', 'source ausente usa el default del schema');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
