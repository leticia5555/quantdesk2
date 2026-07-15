// ═══════════════════════════════════════════════════════════════
// api/_lib/sim.js — motor de paper trading de los agentes.
//
// Un agente es un contenedor de edges de la biblioteca. Este módulo simula
// sus trades con velas DIARIAS de Yahoo Finance, un día a la vez, con
// contabilidad explícita y supuestos conservadores VISIBLES (exportados en
// ASSUMPTIONS y mostrados en la UI — honestidad ante todo):
//
//   - Fill al CIERRE diario ± slippage 0.10% adverso por lado
//   - Comisión 0.05% del notional por lado
//   - Sizing: 2% de riesgo por trade con stop supuesto de 10%
//     → notional = 20% del equity por posición de señal
//   - Sin apalancamiento: si no hay cash para el notional, no se abre
//   - Cortos modelados con colateral completo (cash -= notional al abrir;
//     valor de mercado = qty·(2·entrada − cierre))
//   - MUERTE: si el equity cae 20% desde su pico, el agente muere ese día:
//     se cierran todas las posiciones al cierre y queda congelado
//
// Edges de SEÑALES: se reusa buildRule() del propio endpoint — las señales
// son causales, así que la regla se construye UNA vez sobre la serie
// completa y se evalúa barra por barra sin fuga de futuro.
//
// Edges de PARES: regla estándar de spread z-score (el validador juzga la
// cointegración; la regla de trading es la de libro de texto):
//   - hedge (α, β) por OLS rodante sobre las últimas 250 barras (log)
//   - z sobre las últimas 60 barras del spread
//   - entra cuando |z| ≥ 2 (z alto → short Y / long X; z bajo → al revés)
//   - sale cuando z cruza 0 · stop cuando |z| ≥ 4
//   - dos legs de 10% del equity cada uno (dollar-neutral 50/50; β solo
//     se usa para la señal — simplificación v1, documentada)
//
// Solo se procesan BARRAS COMPLETAS: la vela del día en curso (Yahoo la
// manda parcial durante la sesión) se excluye hasta pasado el cierre.
// ═══════════════════════════════════════════════════════════════

import { buildRule } from '../signal-backtester.js';
import { buildSpread, zscoreLast, toLog } from '../pairs-validator.js';
import { CRYPTO, toYahooSymbol } from './crypto-map.js';

const ASSUMPTIONS = {
  capital_start: 10000,
  slippage_per_side: 0.001,
  commission_per_side: 0.0005,
  risk_per_trade: 0.02,
  assumed_stop: 0.10,          // → notional 20% del equity por señal
  death_drawdown: 0.20,        // -20% desde el peak = muerte
  pair_ols_window: 250,
  pair_z_window: 60,
  pair_z_entry: 2,
  pair_z_stop: 4,
  pair_leg_fraction: 0.10,     // 10% del equity por leg (2 legs)
  fills: 'cierre diario Yahoo Finance',
};

const NOTIONAL_FRACTION = ASSUMPTIONS.risk_per_trade / ASSUMPTIONS.assumed_stop; // 0.20

// ─────────────────── fills y contabilidad ───────────────────

// Precio ejecutado: el slippage siempre va EN CONTRA.
function fillPrice(close, side) {
  return side === 'buy'
    ? close * (1 + ASSUMPTIONS.slippage_per_side)
    : close * (1 - ASSUMPTIONS.slippage_per_side);
}
function commission(notional) { return Math.abs(notional) * ASSUMPTIONS.commission_per_side; }

// Valor de mercado de un leg. Long: qty·close. Short (colateral completo):
// el colateral qty·entrada más el pnl qty·(entrada − close).
function legValue(direction, qty, entry, close) {
  return direction === 'long' ? qty * close : qty * (2 * entry - close);
}

// ─────────────────── series ───────────────────

// Cierres diarios de Yahoo (mismo plumbing que los motores).
async function fetchDailySeries(ticker, range = '2y') {
  const symbol = toYahooSymbol(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const raw = result.indicators?.quote?.[0]?.close || [];
  const dates = [], closes = [];
  for (let i = 0; i < ts.length; i++) {
    if (raw[i] == null || raw[i] <= 0) continue;
    dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    closes.push(raw[i]);
  }
  return closes.length ? { dates, closes } : null;
}

// La vela del día en curso está incompleta hasta el cierre: se corta todo
// lo que sea >= la fecha UTC actual antes de las 22:00 UTC (cierre NYSE
// 20/21 UTC según horario de verano; 22 es conservador).
function completedSlice(series, now = new Date()) {
  const todayUtc = now.toISOString().slice(0, 10);
  const includeToday = now.getUTCHours() >= 22;
  let end = series.dates.length;
  while (end > 0 && (series.dates[end - 1] > todayUtc || (series.dates[end - 1] === todayUtc && !includeToday))) end--;
  return { dates: series.dates.slice(0, end), closes: series.closes.slice(0, end) };
}

// Último cierre conocido <= la fecha dada (para marcar posiciones en días
// donde ese símbolo no tuvo vela).
function closeAt(series, date) {
  let best = null;
  for (let i = series.dates.length - 1; i >= 0; i--) {
    if (series.dates[i] <= date) { best = series.closes[i]; break; }
  }
  return best;
}

// ─────────────────── evaluación de edges ───────────────────

// Prepara un edge para evaluación barra a barra. Devuelve null si faltan
// series (símbolo sin datos): el edge simplemente no opera.
function prepareEdge(edge, seriesBySymbol) {
  if (edge.engine === 'signals') {
    const c = edge.config || {};
    const series = seriesBySymbol[c.ticker];
    // Con poca historia la regla causal simplemente no dispara — no hace
    // falta un mínimo arbitrario, solo que la serie exista.
    if (!series || series.closes.length < 2) return null;
    const p = c.params || {};
    const [entry, exit_] = buildRule(series.closes, c.rule, c.direction || 'long', {
      rsiPeriod: p.rsiPeriod, entryLevel: p.entryLevel, exitLevel: p.exitLevel,
      fast: p.fast, slow: p.slow, signalPeriod: p.signal,
      period: p.period, mult: p.mult, lookback: p.lookback,
    });
    const idxByDate = {};
    series.dates.forEach((d, i) => { idxByDate[d] = i; });
    return { kind: 'signals', edge, series, entry, exit: exit_, idxByDate };
  }

  // pairs: series alineadas por fecha común, en log.
  const sx = seriesBySymbol[edge.config.x];
  const sy = seriesBySymbol[edge.config.y];
  if (!sx || !sy) return null;
  const setX = new Map(sx.dates.map((d, i) => [d, i]));
  const dates = [], xC = [], yC = [];
  sy.dates.forEach((d, i) => {
    if (setX.has(d)) { dates.push(d); xC.push(sx.closes[setX.get(d)]); yC.push(sy.closes[i]); }
  });
  if (dates.length < ASSUMPTIONS.pair_z_window + 10) return null;
  const idxByDate = {};
  dates.forEach((d, i) => { idxByDate[d] = i; });
  return {
    kind: 'pairs', edge, dates, xCloses: xC, yCloses: yC,
    xLog: toLog(xC), yLog: toLog(yC), idxByDate,
  };
}

// z-score del par en la barra i (OLS rodante 250 + z rodante 60, causal).
function pairZ(prep, i) {
  const start = Math.max(0, i + 1 - ASSUMPTIONS.pair_ols_window);
  if (i + 1 - start < ASSUMPTIONS.pair_z_window) return null;
  try {
    const [spread] = buildSpread(prep.xLog.slice(start, i + 1), prep.yLog.slice(start, i + 1));
    return zscoreLast(spread, ASSUMPTIONS.pair_z_window);
  } catch (e) {
    return null; // OLS degenerado (varianza cero): el par no opera ese día
  }
}

// ─────────────────── el día de un agente ───────────────────

let seq = 0;
function newId() { return 'p' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6); }

// Abre/cierra posiciones de UN edge en la fecha D. Muta state.
function stepEdge(prep, date, state, events) {
  const open = state.positions.find((p) => p.edge_id === prep.edge.id && p.status === 'open');

  if (prep.kind === 'signals') {
    const i = prep.idxByDate[date];
    if (i === undefined) return;
    const close = prep.series.closes[i];
    const dir = prep.edge.config.direction || 'long';

    if (open) {
      const stopHit = dir === 'long' ? close <= open.stop_price : close >= open.stop_price;
      if (prep.exit(i) || stopHit) {
        closePosition(state, open, close, date, stopHit && !prep.exit(i) ? 'stop' : 'regla', events);
      }
      return;
    }
    if (prep.entry(i) && !prep.exit(i)) {
      const notional = state.equity * NOTIONAL_FRACTION;
      const side = dir === 'long' ? 'buy' : 'sell';
      const fill = fillPrice(close, side);
      const comm = commission(notional);
      if (state.cash < notional + comm || notional <= 0) return; // sin apalancamiento
      const qty = notional / fill;
      state.cash -= notional + comm;
      const pos = {
        id: newId(), agent_id: state.agent.id, edge_id: prep.edge.id,
        symbol: prep.edge.config.ticker, direction: dir, legs: null,
        qty, entry_price: fill, entry_date: date,
        stop_price: dir === 'long' ? fill * (1 - ASSUMPTIONS.assumed_stop) : fill * (1 + ASSUMPTIONS.assumed_stop),
        notional, status: 'open', entry_commission: comm,
      };
      state.positions.push(pos);
      events.opened.push(pos);
    }
    return;
  }

  // pares
  const i = prep.idxByDate[date];
  if (i === undefined) return;
  const z = pairZ(prep, i);
  if (z === null) return;
  const xClose = prep.xCloses[i], yClose = prep.yCloses[i];

  if (open) {
    const crossed = open.direction === 'short_spread' ? z <= 0 : z >= 0;
    const stopHit = Math.abs(z) >= ASSUMPTIONS.pair_z_stop &&
      (open.direction === 'short_spread' ? z > 0 : z < 0);
    if (crossed || stopHit) {
      closePairPosition(state, open, xClose, yClose, date, stopHit ? 'stop' : 'regla', events);
    }
    return;
  }
  if (Math.abs(z) >= ASSUMPTIONS.pair_z_entry) {
    // z alto: Y cara vs X → short Y / long X. z bajo: al revés.
    const dirSpread = z > 0 ? 'short_spread' : 'long_spread';
    const legNotional = state.equity * ASSUMPTIONS.pair_leg_fraction;
    const legs = [
      { symbol: prep.edge.config.y, direction: dirSpread === 'short_spread' ? 'short' : 'long' },
      { symbol: prep.edge.config.x, direction: dirSpread === 'short_spread' ? 'long' : 'short' },
    ];
    let totalCost = 0;
    for (const leg of legs) {
      const close = leg.symbol === prep.edge.config.y ? yClose : xClose;
      leg.entry = fillPrice(close, leg.direction === 'long' ? 'buy' : 'sell');
      leg.qty = legNotional / leg.entry;
      leg.notional = legNotional;
      totalCost += legNotional + commission(legNotional);
    }
    if (state.cash < totalCost || legNotional <= 0) return;
    state.cash -= totalCost;
    const pos = {
      id: newId(), agent_id: state.agent.id, edge_id: prep.edge.id,
      symbol: prep.edge.config.y + '~' + prep.edge.config.x, direction: dirSpread,
      legs, qty: 1, entry_price: z, entry_date: date,   // entry_price = z de entrada (documentado)
      stop_price: null, notional: legNotional * 2, status: 'open',
      entry_commission: commission(legNotional) * 2,
    };
    state.positions.push(pos);
    events.opened.push(pos);
  }
}

function closePosition(state, pos, close, date, reason, events) {
  const side = pos.direction === 'long' ? 'sell' : 'buy';
  const fill = fillPrice(close, side);
  const value = legValue(pos.direction, pos.qty, pos.entry_price, fill);
  const comm = commission(pos.qty * fill);
  state.cash += value - comm;
  pos.status = 'closed';
  pos.exit_price = fill;
  pos.exit_date = date;
  pos.exit_reason = reason;
  pos.pnl = value - pos.notional - (pos.entry_commission || 0) - comm;
  events.closed.push(pos);
}

function closePairPosition(state, pos, xClose, yClose, date, reason, events) {
  let value = 0, comm = 0;
  for (const leg of pos.legs) {
    const close = leg.symbol === pos.symbol.split('~')[0] ? yClose : xClose;
    const fill = fillPrice(close, leg.direction === 'long' ? 'sell' : 'buy');
    value += legValue(leg.direction, leg.qty, leg.entry, fill);
    comm += commission(leg.qty * fill);
    leg.exit = fill;
  }
  state.cash += value - comm;
  pos.status = 'closed';
  pos.exit_price = null;
  pos.exit_date = date;
  pos.exit_reason = reason;
  pos.pnl = value - pos.notional - (pos.entry_commission || 0) - comm;
  events.closed.push(pos);
}

// Valor de mercado total de las posiciones abiertas en la fecha D.
function markPositions(state, date, seriesBySymbol) {
  let total = 0;
  for (const pos of state.positions) {
    if (pos.status !== 'open') continue;
    if (pos.legs) {
      for (const leg of pos.legs) {
        const c = closeAt(seriesBySymbol[leg.symbol] || { dates: [], closes: [] }, date);
        total += c != null ? legValue(leg.direction, leg.qty, leg.entry, c) : leg.notional;
      }
    } else {
      const c = closeAt(seriesBySymbol[pos.symbol] || { dates: [], closes: [] }, date);
      total += c != null ? legValue(pos.direction, pos.qty, pos.entry_price, c) : pos.notional;
    }
  }
  return total;
}

// ─────────────────── correr un agente ───────────────────

// agent: fila de DB {id, status, cash, equity, equity_peak, last_run_date, ...}
// edges: filas de edges asignados. openPositions: filas open (legs ya parseadas).
// seriesBySymbol: {SYMBOL: {dates, closes}} YA cortado a barras completas.
// Devuelve mutaciones para persistir. Determinista e idempotente: solo
// procesa fechas ESTRICTAMENTE posteriores a last_run_date.
function runAgent(agent, edges, openPositions, seriesBySymbol) {
  const events = { opened: [], closed: [], equityRows: [], died: false };
  if (agent.status !== 'alive') return events; // muerto = congelado

  const state = {
    agent,
    cash: Number(agent.cash),
    equity: Number(agent.equity),
    peak: Number(agent.equity_peak),
    positions: openPositions.map((p) => ({ ...p, qty: Number(p.qty), entry_price: Number(p.entry_price), notional: Number(p.notional), stop_price: p.stop_price != null ? Number(p.stop_price) : null })),
  };

  const preps = edges.map((e) => prepareEdge(e, seriesBySymbol)).filter(Boolean);

  // Calendario: unión de fechas de todas las series involucradas.
  const calendar = [...new Set(preps.flatMap((p) => (p.kind === 'signals' ? p.series.dates : p.dates)))].sort();
  const pending = calendar.filter((d) => !agent.last_run_date || d > agent.last_run_date);

  for (const date of pending) {
    for (const prep of preps) stepEdge(prep, date, state, events);

    state.equity = state.cash + markPositions(state, date, seriesBySymbol);
    if (state.equity > state.peak) state.peak = state.equity;

    // MUERTE: -20% desde el peak. Se liquida todo al cierre de ese día.
    if (state.equity <= state.peak * (1 - ASSUMPTIONS.death_drawdown)) {
      for (const pos of state.positions.filter((p) => p.status === 'open')) {
        if (pos.legs) {
          const [ySym, xSym] = pos.symbol.split('~');
          const yC = closeAt(seriesBySymbol[ySym], date), xC = closeAt(seriesBySymbol[xSym], date);
          if (yC != null && xC != null) closePairPosition(state, pos, xC, yC, date, 'muerte', events);
        } else {
          const c = closeAt(seriesBySymbol[pos.symbol], date);
          if (c != null) closePosition(state, pos, c, date, 'muerte', events);
        }
      }
      state.equity = state.cash + markPositions(state, date, seriesBySymbol);
      events.equityRows.push({ date, equity: state.equity });
      events.died = true;
      events.died_on = date;
      agent.last_run_date = date;
      break;
    }

    events.equityRows.push({ date, equity: state.equity });
    agent.last_run_date = date;
  }

  agent.cash = state.cash;
  agent.equity = state.equity;
  agent.equity_peak = state.peak;
  events.stillOpen = state.positions.filter((p) => p.status === 'open');
  return events;
}

export {
  ASSUMPTIONS, NOTIONAL_FRACTION, fillPrice, commission, legValue,
  fetchDailySeries, completedSlice, closeAt, prepareEdge, pairZ,
  runAgent, CRYPTO,
};
