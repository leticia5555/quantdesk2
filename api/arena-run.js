// ═══════════════════════════════════════════════════════════════
// /api/arena-run — el tick del ARENA: Agente #6 "Claude PM".
//
// Un LLM portfolio manager estilo Rallies/nof1 con la etiqueta honesta de
// la casa: experimento SIN validación estadística, libro EXCLUSIVO en la
// cuenta Alpaca paper existente — la flota validada sigue en el simulador
// (agents-run) y no se tocan.
//
//   GET  ?phase=decide (default) → cron post-cierre (22:40 UTC L-V). DOS
//        fases (SCAN → DEEP DIVE), ambas con el MISMO modelo (ANTHROPIC_MODEL,
//        Haiku por defecto) para no contaminar la línea base del agente #6:
//        1. contexto: cuenta/posiciones/órdenes desde Alpaca + el buffet
//           (movers market, earnings de la semana, insider buys del tracker,
//           y el canal SCREENER — value/momentum precomputado en Neon, leído
//           sin llamadas en la corrida) + plan anterior reinyectado (nof1).
//        2. SCAN (LLM #1): sobre el buffet, el SCOUT nombra hasta 5 tickers.
//           Un FLOOR determinista reserva ≤2 slots para el screener cuando
//           dispara (atribución: mide el canal, no el sesgo del scout). Cero
//           candidatos finales → ok_no_candidates. Malformado →
//           aborted_scan_malformed_json. Cada candidato/acción journalea su
//           canal + origin (scout_picked/floor_reserved) para el post-mortem.
//        3. DEEP DIVE (determinista, _lib/finnhub-dive.js): por cada candidato
//           trae de Finnhub fundamentales (P/E, market cap, márgenes, deuda),
//           analyst recommendations y titulares recientes. Free tier; best-effort.
//        4. DIVE (LLM #2): con esos datos decide → JSON estricto
//           { plan, actions[] }. Malformado → run abortado, CERO órdenes.
//        5. risk guard determinista (_lib/arena-guard.js) — descarta, no
//           ajusta. SIN CAMBIOS: valida las órdenes finales como siempre.
//        6. aprobadas → órdenes LÍMITE day a Alpaca (fill al open
//           siguiente); todo (prompts de ambas fases, candidatos, datos
//           Finnhub, respuestas completas, aprobadas/descartadas con razón)
//           queda en arena_journal.context.
//   GET  ?phase=reconcile → cron matutino (14:40 UTC L-V): trae los fills
//        reales (precio/timestamp) de las órdenes enviadas y los guarda en
//        el journal. Compatible con el diseño de reconciliación de Fase 1.
//
// GATES (en orden): CRON_SECRET (si existe) → ARENA_ENABLED=1 (el switch
// que prende Lety cuando el smoke de /api/alpaca?smoke=1 esté verde en
// prod) → keys de Alpaca → ANTHROPIC_API_KEY (créditos pendientes: sin
// key el run se journalea como abortado honesto, cero órdenes).
//
// ENV VARS: ARENA_ENABLED · ALPACA_PAPER_KEY/SECRET · ANTHROPIC_API_KEY ·
//           FINNHUB_API_KEY (symbol map del guard + deep dive de candidatos) ·
//           DATABASE_URL · CRON_SECRET (opc) ·
//           PUBLIC_BASE_URL (dominio público estable para el self-fetch; ver
//           resolveBaseUrl — VERCEL_URL está detrás de Deployment Protection)
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { sql, ensureSchema } from './_lib/db.js';
import { guardedClaudeCall } from './_lib/ai-guard.js';
import { ANTHROPIC_MODEL } from './_lib/model.js';
import { getSymbolMap, getSymbolTypes } from './earnings.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { getAccount, getPositions, getOrders, getOrder, createLimitOrder, alpacaCreds } from './_lib/alpaca.js';
import { parseScanResponse, parsePlanResponse, validateActions, applyScreenerFloor, ARENA_RULES, isLeveragedInverseETF } from './_lib/arena-guard.js';
import { buildRiskExits, EXIT_RULES } from './_lib/arena-exits.js';
import { fetchDeepDive } from './_lib/finnhub-dive.js';
import { beat } from './_lib/heartbeat.js';
import { readScreenerRows } from './_lib/screener-db.js';
import { computeScreens, screenerRankedSymbols, screenerDataState } from './_lib/screens.js';

// Re-export: la detección de leveraged/inverse vive en el guard (hogar de las
// reglas de universo); el buffet (trimMovers) la reusa y los tests de
// arena-run la importan desde acá.
export { isLeveragedInverseETF };

// v2: flujo de DOS fases (SCAN → DEEP DIVE). v1 era un solo LLM call sobre el
// buffet. El bump permite distinguir corridas del harness viejo vs nuevo en
// el post-mortem a 30 días.
export const PROMPT_VERSION = 'arena-pm-v2';

// El SCOUT nombra hasta este número de tickers para el deep dive. Es también
// el tope de llamadas a Finnhub por corrida (4 endpoints × 5 = ~20, bajo el
// cap de 60/min del tier gratis).
export const MAX_CANDIDATES = 5;

// FLOOR del canal screener — TIME-BOXED del trial (~30 días). Reserva hasta 2
// de los 5 slots de candidatos para el screener cuando alguna screen dispara,
// para que la atribución mida la CALIDAD DEL CANAL y no el sesgo del scout
// (sin floor, un scout sesgado a lo noticioso podría no elegir screener en
// semanas → mediríamos su sesgo). A los 30 días, con datos, baja a 0 →
// free-choice puro. El flag `origin` (scout_picked/floor_reserved) separa las
// dos métricas de atribución.
export const SCREENER_FLOOR = 2;

// ── SCAN (fase 1): el SCOUT filtra el buffet a ≤5 tickers a investigar. ──
// No decide órdenes: solo nombra candidatos. El schema es contrato.
export function buildScanSystemPrompt() {
  return `You are the SCOUT for QuantDesk Arena, an LLM-run PAPER trading experiment. This is STEP 1 of 2: triage, not trading.

Your job: from today's market context (movers, earnings, insider buys, and a deterministic value/momentum screener that surfaces solid companies at a good price even when they made no news today) AND the current portfolio, pick up to ${MAX_CANDIDATES} US-listed common-stock tickers worth a deep-dive before the next open. A ticker is worth a deep-dive if there is a plausible reason to BUY it, or if it is an existing holding you might TRIM or EXIT. You do NOT have full fundamentals yet — that is step 2; the screener already carries the metrics that qualified each name (P/E, ROE, debt, % above moving average). Here you are only deciding what deserves the research budget.

RULES:
- US-listed common equities only. No warrants/units/rights, no sub-$1 stocks, no crypto, no options.
- At most ${MAX_CANDIDATES} candidates. Fewer is fine. An EMPTY list is valid and correct when nothing today warrants research — do not pad it.
- Only pick tickers grounded in the context or the portfolio below. Do not invent tickers or prices.

OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no prose outside JSON):
{"scan_thesis": "<why these tickers, or why none, 1-4 sentences>", "candidates": ["TICKER", ...]}`;
}

// ── DIVE (fase 2): las reglas del PM. Mismo contrato que el v1 single-call,
// para que el guard downstream no cambie una línea. El schema es contrato. ──
export function buildDiveSystemPrompt() {
  return `You are "Claude PM", the portfolio manager of QuantDesk Arena — a PUBLIC experiment: an LLM managing a real Alpaca PAPER account (simulated money, real market quotes). Your reasoning is published verbatim next to every trade. This is STEP 2 of 2: you now have deep-dive data (fundamentals, analyst recommendations, recent news) for the candidates your scout flagged.

HARD RULES (a deterministic risk guard enforces them AFTER you — violations are discarded and logged, never fixed for you):
- Universe: US-listed common equities only. No warrants, no units, no rights, no sub-$1 stocks, no crypto, no options, no shorting. Long only.
- Max ${ARENA_RULES.max_positions} simultaneous positions. Max ${ARENA_RULES.max_position_fraction * 100}% of equity per position. Keep at least ${ARENA_RULES.min_cash_fraction * 100}% of equity in cash.
- LIMIT orders only, good for the day, executed at the NEXT market open. Set limit_price within ±${ARENA_RULES.price_band * 100}% of the last close you are given — wider is auto-discarded.
- Base your decisions on the deep-dive data and portfolio provided. Do not invent prices, news or fundamentals, and do not introduce tickers you were given no data for.

OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no prose outside JSON):
{"plan": "<your portfolio thesis for today, 2-6 sentences>", "actions": [{"symbol": "TICKER", "side": "buy"|"sell", "notional": <USD number>, "limit_price": <number>, "conviction": <1-5>, "reasoning": "<1-2 sentences, specific>"}]}
An empty actions array is a valid, often correct decision — but plan must then explain why you are holding.`;
}

// ── contexto: recortes compactos del buffet (tokens de Haiku, no de Opus) ──
function trimMovers(data) {
  if (!data || data.universe !== 'market') return null;
  // Filtra ANTES de recortar: (a) micro-caps <$5 (curación del buffet, más
  // estricta que el piso de $1 del guard: el top_losers de AV está dominado
  // por small caps a -30/-40% que sepultaban a las mega-caps) y (b) ETFs
  // apalancados/inversos (misma detección que el guard, aquí solo por ticker
  // porque el feed no trae nombres). El guard vuelve a filtrar (b) con la
  // señal por nombre; esto es best-effort para no gastarle un slot al PM.
  const pick = (l, n) => (l || [])
    .filter((m) => m && typeof m.price === 'number' && m.price >= 5)
    .filter((m) => !isLeveragedInverseETF(m.symbol))
    .slice(0, n)
    .map((m) => ({ symbol: m.symbol, price: m.price, changePct: m.changePct }));
  // `actives` a top-8 (gainers/losers a 5, que el ranking por % ya prioriza):
  // es donde las mega-caps con movimiento fuerte quedaban fuera del top-5 al
  // ser desplazadas por leveraged ETFs y small caps (TSLA -14.5%, 24-jul).
  return { gainers: pick(data.gainers, 5), losers: pick(data.losers, 5), actives: pick(data.actives, 8) };
}
function trimEarnings(data) {
  return ((data && data.earnings) || []).slice(0, 12).map((e) => ({ ticker: e.ticker, company: e.company, date: e.date, time: e.time }));
}
function trimInsiders(data) {
  return ((data && data.items) || []).slice(0, 8).map((i) => ({ insider: i.insider, role: i.role, ticker: i.ticker, value: i.value, tradeDate: i.tradeDate }));
}
// ── atribución de canal (determinista, no confía en el LLM) ──────────
// symbol → { channels:[...], screens:[...], qualifiers:{...} } a partir de qué
// secciones YA TRIMMEADAS del buffet contienen cada ticker (lo que el PM ve).
// A los 30 días: GROUP BY channel sobre las acciones del journal → qué canal
// produjo decisiones y cuál fue ruido. NO viaja al prompt (buildScanUserPrompt
// lo excluye) — es índice de journaling.
function buildChannels({ movers, earnings, insiders, screener }) {
  const map = {};
  const add = (sym, channel) => {
    const s = String(sym || '').trim().toUpperCase();
    if (!s) return null;
    if (!map[s]) map[s] = { channels: [], screens: [], qualifiers: {} };
    if (!map[s].channels.includes(channel)) map[s].channels.push(channel);
    return map[s];
  };
  if (movers) for (const list of [movers.gainers, movers.losers, movers.actives]) for (const m of (list || [])) add(m.symbol, 'movers');
  for (const e of (earnings || [])) add(e.ticker, 'earnings');
  for (const i of (insiders || [])) add(i.ticker, 'insider');
  for (const name of ['value', 'momentum']) {
    for (const c of ((screener || {})[name] || [])) {
      const entry = add(c.symbol, 'screener');
      if (entry && !entry.screens.includes(name)) entry.screens.push(name);
      if (entry) Object.assign(entry.qualifiers, c.qualifiers || {});
    }
  }
  return map;
}

// El scout también nombra candidatos del LIBRO, no solo del buffet: el prompt del
// SCAN le da el portfolio y le pide considerar holdings a recortar/salir. Esos
// símbolos (posiciones abiertas u órdenes abiertas por re-anclar) NO están en
// ninguna sección del buffet → sin este paso salían con channels:[] y el
// post-mortem a 30 días los perdía (bug 2026-07-27: AXP tenía orden abierta y
// GNTX era holding → ambos []; solo MU, del screener, traía canal). Marca el
// canal 'portfolio' sobre el MISMO índice de buildChannels (lo muta y lo
// devuelve). Un candidato puede acumular 'movers'+'portfolio' si está en ambos.
export function addPortfolioChannels(map, { positions = [], openOrders = [] } = {}) {
  const m = map || {};
  const mark = (sym) => {
    const s = String(sym || '').trim().toUpperCase();
    if (!s) return;
    if (!m[s]) m[s] = { channels: [], screens: [], qualifiers: {} };
    if (!m[s].channels.includes('portfolio')) m[s].channels.push('portfolio');
  };
  for (const p of (positions || [])) mark(p && p.symbol);
  for (const o of (openOrders || [])) mark(o && o.symbol);
  return m;
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Buffet vía self-fetch a NUESTROS endpoints (reusa su cache CDN y sus
// fallbacks). Cada fuente caída se reporta como no disponible — el PM
// opera con menos contexto, nunca con contexto inventado.
export async function gatherContext({ baseUrl, now = new Date() }) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const weekEnd = new Date(now.getTime() + 7 * 86400000);
  // VC salió del buffet: son empresas privadas que el PM no puede comprar; el
  // espacio le sirve más al canal screener. El endpoint /vc-feed sigue vivo
  // para el resto de la app.
  const targets = {
    movers: baseUrl + '/api/movers?universe=market',
    earnings: baseUrl + `/api/earnings?from=${iso(now)}&to=${iso(weekEnd)}`,
    insiders: baseUrl + '/api/stock-tracker?cat=insider',
  };
  const out = {};
  await Promise.all(Object.entries(targets).map(async ([k, url]) => {
    try { out[k] = await fetchJson(url); }
    catch (err) {
      out[k] = null;
      // El error REAL del fetch (status HTTP o timeout), no solo "no disponible".
      out[k + '_error'] = err && err.name === 'TimeoutError'
        ? 'timeout (12s)'
        : String((err && err.message) || err);
    }
  }));
  const fetch_errors = {};
  for (const k of Object.keys(targets)) if (out[k + '_error']) fetch_errors[k] = out[k + '_error'];

  const movers = trimMovers(out.movers);
  const earnings_this_week = trimEarnings(out.earnings);
  const notable_insider_buys = trimInsiders(out.insiders);

  // Canal SCREENER (estado-driven): se LEE de Neon (precomputado por el cron
  // arena-screener) y se computan las screens en código — CERO llamadas
  // Finnhub/Yahoo en la corrida. Best-effort: tabla vacía (cron aún no corrió,
  // o ninguna screen dispara) → screener vacío, no es error. Solo una excepción
  // de DB cuenta como caído.
  //
  // `screener_state` distingue POR QUÉ el canal llegó vacío (vacía/apagada/
  // rancia/caída vs. datos frescos sin qualifiers) → el floor lo usa para no
  // reportar `no_qualifying_candidates` cuando la verdad es "no hubo datos".
  // El flag del cron se lee aquí mismo: es del proyecto Vercel, así que el
  // arena-run ve si `ARENA_SCREENER_ENABLED` faltaba (el caso del bug).
  let screener = { value: [], momentum: [] };
  let screener_state = 'unavailable';
  const screenerEnabled = process.env.ARENA_SCREENER_ENABLED === '1';
  const unavailable = Object.keys(targets).filter((k) => !out[k]);
  try {
    const screenerRows = await readScreenerRows();
    screener = computeScreens(screenerRows);
    screener_state = screenerDataState(screenerRows, { now, enabled: screenerEnabled });
  } catch (e) {
    fetch_errors.screener = String((e && e.message) || e);
    unavailable.push('screener');
    screener_state = 'unavailable';
  }

  const channelsByTicker = buildChannels({ movers, earnings: earnings_this_week, insiders: notable_insider_buys, screener });

  return {
    movers, earnings_this_week, notable_insider_buys,
    screener,
    screener_state,
    unavailable,
    // Diagnóstico: status HTTP/timeout real por endpoint caído. NO viaja al
    // prompt del LLM (buildScanUserPrompt lo excluye) — se journalea.
    fetch_errors,
    // Índice de atribución por ticker. NO viaja al prompt — para el journal.
    channelsByTicker,
  };
}

// Fracción cruda de Alpaca (unrealized_plpc: 0.061) → string YA formateado y
// rotulado ("+6.1%"). El PM recibía la fracción pelada y en la prosa (a) la
// mal-escalaba al narrarla (0.061 → "0.61%") y (b) la confundía con el cambio
// del día. El string lleva signo y %, y el NOMBRE del campo (pnl_since_entry_pct)
// fija la semántica —P&L desde entrada, no movimiento intradía— para que el PM
// no tenga que formatear ni adivinar la escala. Mismo valor que la tabla del
// panel (agPct también hace ×100). null si Alpaca no trajo el dato.
function fmtSignedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const pct = n * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// Snapshot del libro compartido por ambas fases.
function portfolioSnapshot({ account, positions, openOrders }) {
  return {
    equity: Number(account.equity),
    cash: Number(account.cash),
    positions: (positions || []).map((p) => ({
      symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
      market_value: Number(p.market_value),
      // Pre-formateado + rotulado (ver fmtSignedPct): P&L desde entrada, no día.
      pnl_since_entry_pct: fmtSignedPct(p.unrealized_plpc),
    })),
    open_orders: (openOrders || []).map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, limit_price: o.limit_price, status: o.status })),
  };
}

// ── user prompt del SCAN: portfolio + plan anterior + el buffet completo. ──
export function buildScanUserPrompt({ account, positions, openOrders, buffet, previous }) {
  // fetch_errors y channelsByTicker son diagnóstico/atribución interna (se
  // journalean); el LLM solo necesita `unavailable`. Se excluyen del prompt.
  const { fetch_errors, channelsByTicker, ...buffetForLlm } = buffet || {};
  return [
    'PORTFOLIO (Alpaca paper, live):', JSON.stringify(portfolioSnapshot({ account, positions, openOrders })),
    '',
    'PREVIOUS PLAN (yours, from the last run — build on it or change course):',
    previous ? JSON.stringify(previous) : 'none — this is your first run.',
    '',
    'MARKET CONTEXT (QuantDesk endpoints; sections listed in "unavailable" failed today — do not guess their content):',
    JSON.stringify(buffetForLlm),
    '',
    `Pick up to ${MAX_CANDIDATES} tickers worth a deep-dive, or none. Remember: ONE JSON object, nothing else.`,
  ].join('\n');
}

// ── user prompt del DIVE: portfolio + tesis del scout + candidatos CON su
// deep-dive de Finnhub (fundamentales, recommendations, titulares) Y el ÚLTIMO
// CIERRE + rango de límite ya calculado. Antes el PM no tenía el cierre y
// adivinaba el límite (anclaba en el 52w-high, el único número tipo-precio de
// Finnhub) → el guard lo descartaba por banda. Ahora se le da EL MISMO cierre
// contra el que el guard valida, con el rango ±2% ya hecho (sin aritmética). ──
export function buildDiveUserPrompt({ account, positions, openOrders, previous, scanThesis, candidates, deepDive, closes, channels, priceBand = ARENA_RULES.price_band }) {
  const round2 = (n) => Math.round(n * 100) / 100;
  // Nota de datos ausentes para el modelo: price target es Premium (no lo
  // traemos), y un candidato puede no tener cobertura Finnhub ni cierre.
  const research = (candidates || []).map((t) => {
    const close = closes && typeof closes[t] === 'number' ? closes[t] : null;
    const limit_range = close != null
      ? { low: round2(close * (1 - priceBand)), high: round2(close * (1 + priceBand)) }
      : null;
    // Procedencia del candidato (de qué canal salió + qualifiers del screener,
    // que son RATIOS, no precio — el candado de precio se mantiene: last_close
    // es el fresco, el screener nunca aporta un precio absoluto).
    const ch = channels && channels[t] ? channels[t] : null;
    const meta = ch
      ? { channel: ch.channels, ...(ch.screens && ch.screens.length ? { screen: ch.screens, screener_qualifiers: ch.qualifiers } : {}) }
      : {};
    return { ticker: t, last_close: close, limit_range, ...meta, ...((deepDive && deepDive[t]) || null) };
  });
  return [
    'PORTFOLIO (Alpaca paper, live):', JSON.stringify(portfolioSnapshot({ account, positions, openOrders })),
    '',
    'PREVIOUS PLAN (yours, from the last run — build on it or change course, but acknowledge it):',
    previous ? JSON.stringify(previous) : 'none — this is your first run.',
    '',
    'SCOUT THESIS (why these tickers were flagged for deep-dive):',
    scanThesis || '(none provided)',
    '',
    'DEEP-DIVE DATA (Finnhub; per candidate: last_close, limit_range, profile, fundamentals, analyst recommendation counts, recent news headlines).',
    `PRICING RULE — READ CAREFULLY: for each candidate, "last_close" is the reference close and "limit_range" {low, high} is the ONLY band the risk guard accepts (±${priceBand * 100}% of last_close). Your limit_price MUST fall inside [limit_range.low, limit_range.high] or the order is auto-discarded. Do NOT anchor your limit on 52-week highs/lows, analyst targets, or any other figure — only on last_close. If last_close is null you have no valid reference for that ticker: do not place an order for it.`,
    'NOTES: null fields mean the datum was unavailable (do not guess it). Analyst price targets are NOT provided; use the recommendation buy/hold/sell split as the rating signal. marketCapM is in millions USD.',
    'NEWS RECENCY — each news item carries a `date` (YYYY-MM-DD). Before you describe any headline, compare its date to today\'s date (given in the system prompt): state how long ago it happened ("N days ago", the weekday) and reserve "today" for a date that equals today. A headline dated before today is NOT today\'s news — do not narrate a report from several days ago as if it broke today.',
    'FIGURES — when your plan cites a number (a %, a price, a P&L), use ONLY the figures given to you here or in the PORTFOLIO above, verbatim. Each holding carries `pnl_since_entry_pct`, already formatted ("+6.1%"): that is profit/loss SINCE YOUR ENTRY, not today\'s price move — quote it as-is if you mention it. Do NOT compute, rescale, round, or invent percentages you were not given.',
    JSON.stringify(research),
    '',
    'Decide your actions for the next market open. Remember: ONE JSON object, nothing else.',
  ].join('\n');
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Último cierre COMPLETO por símbolo — LA MISMA fuente/valor contra el que el
// guard valida la banda ±2% (fetchDailySeries + completedSlice, plumbing Yahoo
// del simulador). Se usa dos veces por corrida: para MOSTRARLE el cierre al PM
// en el DIVE y para que el guard valide — el mismo número, cero desfase.
// null si no hay serie (→ el guard descarta, fail closed).
async function lastCompletedClose(symbol, now) {
  try {
    const raw = await fetchDailySeries(symbol, '3mo');
    const series = raw ? completedSlice(raw, now) : null;
    if (series && series.closes.length) return series.closes[series.closes.length - 1];
  } catch (e) { /* sin cierre → fail closed */ }
  return null;
}

async function journalInsert(row) {
  await sql(
    `insert into arena_journal (id, run_date, phase, status, prompt_version, prompt_hash, model, plan, llm_response, actions, account, error, context)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.id, row.run_date, row.phase, row.status, row.prompt_version ?? null, row.prompt_hash ?? null,
     row.model ?? null, row.plan ?? null, row.llm_response ?? null,
     row.actions ? JSON.stringify(row.actions) : null,
     row.account ? JSON.stringify(row.account) : null, row.error ?? null,
     row.context ? JSON.stringify(row.context) : null]);
}

// ── SALIDAS DE RIESGO (deterministas, no del LLM) ────────────────────
// Journaling de una salida de riesgo: canal 'risk_exit' + origin (reason_code
// más severo) + reason_codes + reasoning sintético (verbatim en la card). El
// post-mortem a 30 días agrupa por canal igual que las decisiones del PM.
function attributeRiskExit(a, extra) {
  return {
    symbol: a.symbol, side: 'sell', qty: a.qty, limit_price: a.limit_price,
    notional: +(a.qty * a.limit_price).toFixed(2), reference: a.reference,
    channels: ['risk_exit'], origin: a.origin, reason_codes: a.reason_codes,
    exit_band: a.exit_band, exit_attempt: a.exit_attempt, // medibles: banda usada + # de intento
    reasoning: a.reasoning, conviction: null,
    ...extra,
  };
}

// Ejecuta las ventas de riesgo con MARKETABLE LIMIT ancho (EXIT_PRICE_BAND, no
// ±2%) + day. client_order_id con segmento `:exit` — distinto de `:buy`/`:sell`,
// así una salida determinista NO colisiona con una venta del PM del mismo
// símbolo el mismo día (dos ventas mismo día antes compartían client_order_id).
async function submitRiskExits(approved, runDate) {
  const actions = [];
  let submitted = 0;
  for (const a of approved) {
    const clientOrderId = `arena:${runDate}:${a.symbol}:exit`;
    try {
      const order = await createLimitOrder({ symbol: a.symbol, qty: a.qty, side: 'sell', limit_price: a.limit_price, client_order_id: clientOrderId });
      actions.push(attributeRiskExit(a, { result: 'approved', alpaca_order_id: order.id, client_order_id: clientOrderId, order_status: order.status }));
      submitted++;
    } catch (err) {
      actions.push(attributeRiskExit(a, { result: 'submit_failed', client_order_id: clientOrderId, reason: String((err && err.message) || err) }));
    }
  }
  return { actions, submitted };
}

// Salidas de riesgo descartadas (p.ej. sin referencia de precio) → journal.
function riskDiscardActions(discarded) {
  return (discarded || []).map((d) => ({
    symbol: d.symbol, side: 'sell', qty: d.qty, channels: ['risk_exit'],
    origin: d.origin, reason_codes: d.reason_codes, result: 'discarded', reason: d.reason,
  }));
}

// ── estado del agente: HALT del breaker −20% (persistente) ───────────
// El broadcut DETIENE al agente (análogo del DEATH -20% de la flota: mata, no
// vacía y ya). Reactivación MANUAL (runArenaResume) — nunca automática.
export async function getArenaState() {
  try {
    const rows = await sql(`select halted, halted_at, halted_reason, resumed_at from arena_state where id = 1`);
    return rows[0] || { halted: false, halted_at: null, halted_reason: null, resumed_at: null };
  } catch (e) {
    // Fail-safe: si el estado no se puede leer, NO se asume detenido (no se
    // congela el agente por un hipo de DB) — el breaker se re-evaluará igual.
    return { halted: false, halted_at: null, halted_reason: null, resumed_at: null };
  }
}

// Órdenes NO llenadas (terminal): un stop catastrófico que quedó así → escala la
// banda en la próxima corrida. 'filled'/'partially_filled' NO cuentan.
const EXIT_NONFILL = new Set(['expired', 'canceled', 'rejected', 'done_for_day', 'replaced']);

// symbol → # de stops catastróficos que NO llenaron en la ventana (para escalar
// la banda). Lee filas risk_exit recientes; cuenta submit_failed y aprobadas con
// order_status terminal-no-llenado. El reconcile ya actualiza order_status.
function escalationFromRiskRows(riskRows, symbols) {
  const counts = {};
  const want = new Set(symbols);
  for (const row of (riskRows || [])) {
    for (const a of (row.actions || [])) {
      if (!a || !want.has(a.symbol)) continue;
      if (!(a.reason_codes || []).includes('catastrophic_stop')) continue;
      if (a.result === 'submit_failed' || (a.result === 'approved' && EXIT_NONFILL.has(a.order_status))) {
        counts[a.symbol] = (counts[a.symbol] || 0) + 1;
      }
    }
  }
  return counts;
}

// ── REACTIVACIÓN manual tras un halt del breaker ─────────────────────
// Limpia el flag y re-basa el pico (resumed_at): el drawdown se medirá desde el
// equity de AHORA, no desde el pico viejo (si no, el broadcut re-dispararía al
// instante sobre una cuenta ya liquidada). Journalea una fila 'resumed' — la
// decisión de revivir al agente queda documentada.
export async function runArenaResume({ now = new Date() } = {}) {
  const state = await getArenaState();
  if (!state.halted) return { resumed: false, reason: 'el agente no estaba detenido' };
  await sql(`update arena_state set halted = false, resumed_at = $1 where id = 1`, [now.toISOString()]);
  await journalInsert({
    id: 'arena-resume-' + now.toISOString(), run_date: now.toISOString().slice(0, 10),
    phase: 'decide', prompt_version: PROMPT_VERSION, model: null, status: 'resumed',
    plan: `Agente REACTIVADO manualmente tras el halt del ${state.halted_at || 's/f'} (${state.halted_reason || 'drawdown'}). El pico del breaker se re-basa al equity actual — el experimento reanuda desde aquí.`,
  });
  return { resumed: true, halted_since: state.halted_at };
}

// ── fase DECIDE ──────────────────────────────────────────────────────
export async function runArenaDecide({ baseUrl, now = new Date() }) {
  const runDate = now.toISOString().slice(0, 10);
  const base = { id: 'arena-' + now.toISOString(), run_date: runDate, phase: 'decide', prompt_version: PROMPT_VERSION, model: ANTHROPIC_MODEL };

  // ── HALT del breaker: si el agente está DETENIDO, no corre decide ni
  // journalea (la muerte se journaleó UNA vez al dispararse el broadcut; nada de
  // filas diarias). Reactivación solo manual (runArenaResume). ──
  const state = await getArenaState();
  if (state.halted) {
    return { status: 'halted', halted_since: state.halted_at, reason: state.halted_reason };
  }

  if (!alpacaCreds()) {
    await journalInsert({ ...base, status: 'aborted_no_alpaca_keys', error: 'Faltan ALPACA_PAPER_KEY/SECRET.' });
    return { status: 'aborted_no_alpaca_keys', orders: 0 };
  }

  // Estado real del libro + plan anterior + PICO de equity + reintentos previos,
  // en paralelo. El buffet (self-fetch caro) y el LLM se posponen: si el circuit
  // breaker dispara un CORTE AMPLIO no se gastan ni el buffet ni Anthropic.
  const [account, positions, openOrders, prevRows, peakRows, riskRows] = await Promise.all([
    getAccount(), getPositions(), getOrders('open'),
    sql(`select run_date, plan, actions, status from arena_journal
         where phase = 'decide' and plan is not null order by created_at desc limit 1`),
    // High-water-mark del libro: el máximo equity journaleado, ACOTADO por
    // resumed_at (tras revivir, el pico se re-basa al equity de ese momento — si
    // no, el broadcut re-dispararía sobre una cuenta ya liquidada). El Arena no
    // tenía pico propio (equity_peak de la DB es de la FLOTA, otra tabla). null
    // en el primer run → pico = equity.
    sql(`select max((account->>'equity')::numeric) as peak from arena_journal
         where account is not null and ($1::timestamptz is null or created_at > $1::timestamptz)`, [state.resumed_at]),
    // Stops catastróficos recientes que NO llenaron → escalan la banda (cond. #1).
    sql(`select actions from arena_journal where status = 'risk_exit'
         and created_at > now() - interval '7 days' order by created_at desc`),
  ]);
  const equity = Number(account.equity);
  const dbPeak = peakRows[0] && peakRows[0].peak != null ? Number(peakRows[0].peak) : 0;
  const peak = Math.max(dbPeak, equity); // monótono; incluye el equity de hoy
  const accountSnapshot = { equity, cash: Number(account.cash), positions: positions.length };
  const previous = prevRows[0]
    ? { date: prevRows[0].run_date, plan: prevRows[0].plan,
        orders: (prevRows[0].actions || []).map((a) => ({ symbol: a.symbol, side: a.side, result: a.result, order_status: a.order_status || null, filled_avg_price: a.filled_avg_price || null, reason: a.reason || null })) }
    : null;

  // ── SALIDAS DE RIESGO deterministas (circuit breaker + stop catastrófico) ──
  // Se computan ANTES del LLM: son la red de seguridad del libro y tienen
  // precedencia. El stop catastrófico necesita el último cierre COMPLETO por
  // holding (misma fuente que valida el guard). Estos cierres se reusan luego
  // como semilla del guard (sin re-fetch).
  const heldSymbols = [...new Set((positions || []).map((p) => (p && p.symbol ? String(p.symbol).trim().toUpperCase() : '')).filter(Boolean))];
  const heldCloseArr = await Promise.all(heldSymbols.map((s) => lastCompletedClose(s, now)));
  const heldCloses = {};
  heldSymbols.forEach((s, i) => { heldCloses[s] = heldCloseArr[i]; });
  // Escalamiento por nombre: cuántas veces un stop catastrófico previo no llenó.
  const escalation = escalationFromRiskRows(riskRows, heldSymbols);
  const risk = buildRiskExits({ equity, peak, positions, closes: heldCloses, escalation });
  const riskContext = { peak, drawdown: +risk.drawdown.toFixed(4), stage: risk.stage, escalation, bands: { breaker: EXIT_RULES.exit_band_breaker, catastrophic: EXIT_RULES.exit_band_catastrophic }, approved: risk.approved, discarded: risk.discarded };

  // ── CORTE AMPLIO (drawdown ≥ 20% desde el pico): liquida todo, SIN LLM ──
  // Análogo del DEATH -20% de la flota validada. No se abre riesgo nuevo en un
  // −20%, así que ni se pega al buffet ni se gasta Anthropic.
  if (risk.stage === 'broadcut') {
    const { actions: riskActions, submitted } = await submitRiskExits(risk.approved, runDate);
    const plan = `CIRCUIT BREAKER — corte amplio. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); se liquidan ${risk.approved.length} posiciones con marketable limit y se salta el LLM (no se abre riesgo nuevo en un −20%).`;
    await journalInsert({ ...base, account: accountSnapshot, status: 'risk_broad_cut', plan, actions: [...riskActions, ...riskDiscardActions(risk.discarded)], context: { risk: riskContext } });
    // DETIENE al agente (persistente): esta es la ÚNICA fila de la muerte. Las
    // corridas siguientes salen por el gate de halt, sin journalear. Revivir es
    // manual (runArenaResume) — el −20% es el resultado del experimento.
    const haltReason = `circuit breaker: drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)})`;
    await sql(`update arena_state set halted = true, halted_at = $1, halted_reason = $2 where id = 1`, [now.toISOString(), haltReason]);
    return { status: 'risk_broad_cut', orders: submitted, risk_exits: submitted, breaker_stage: 'broadcut', drawdown: +risk.drawdown.toFixed(4), halted: true };
  }

  // ── Delever / stops catastróficos: ejecuta la RED DE SEGURIDAD antes del LLM
  // y en su PROPIA fila de journal. Así un stop que disparó se ejecuta AUNQUE el
  // LLM luego aborte (sin API key, error, o "nada que investigar" — resultados
  // normales que NO deben frenar la red). stage 'none' → no-op (0 exits). ──
  let riskSubmitted = 0;
  if (risk.approved.length || risk.discarded.length) {
    const { actions: riskActions, submitted } = await submitRiskExits(risk.approved, runDate);
    riskSubmitted = submitted;
    const plan = risk.stage === 'delever'
      ? `CIRCUIT BREAKER — desapalancando. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); recorto las posiciones más débiles con marketable limit.`
      : `STOP CATASTRÓFICO — ${risk.approved.length} posición(es) cerró bajo su nivel ancho (~${(EXIT_RULES.catastrophic_stop_pct * 100).toFixed(0)}% desde la entrada); se liquida(n) con marketable limit en la apertura.`;
    await journalInsert({ ...base, id: base.id + ':risk', account: accountSnapshot, status: 'risk_exit', plan, actions: [...riskActions, ...riskDiscardActions(risk.discarded)], context: { risk: riskContext } });
  }

  // No hubo corte amplio → ahora sí el buffet (self-fetch) para el LLM.
  const buffet = await gatherContext({ baseUrl, now });

  // Atribución del canal 'portfolio': el índice de canales de gatherContext solo
  // conoce el buffet. Los candidatos que el scout re-elige del LIBRO (un holding
  // a recortar/salir, o una orden abierta a re-anclar) no están en el buffet, así
  // que sin esto salían con channels:[]. Se marca acá —donde ya tenemos posiciones
  // y órdenes abiertas— sobre el mismo índice, antes de construir prompts/atribuir.
  addPortfolioChannels(buffet.channelsByTicker, { positions, openOrders });

  // ── FASE 1: SCAN ────────────────────────────────────────────────
  const scanSystem = buildScanSystemPrompt();
  const scanUser = buildScanUserPrompt({ account, positions, openOrders, buffet, previous });
  const scanHash = sha256(scanSystem + '\n---\n' + scanUser);

  // context journaleado desde el arranque; se enriquece por fase. El
  // post-mortem del 24-jul quedó ciego (fetch_errors sin guardar, del prompt
  // solo el hash). Ahora queda el texto completo de AMBAS fases, más los
  // candidatos y los datos Finnhub — reconstruir qué vio el PM no es arqueología.
  const context = {
    unavailable: buffet.unavailable,
    fetch_errors: buffet.fetch_errors,
    // Salidas de riesgo del run (stage/drawdown/pico + exits deterministas):
    // por qué desapalancó o qué stop disparó, sin depender de las acciones.
    risk: riskContext,
    scan: { prompt: { system: scanSystem, user: scanUser }, hash: scanHash, model: ANTHROPIC_MODEL },
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Dependencia documentada: la primera corrida real necesita créditos
    // de Anthropic. Sin key el run queda journaleado, con cero órdenes.
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_no_api_key', error: 'Falta ANTHROPIC_API_KEY (créditos pendientes).' });
    return { status: 'aborted_no_api_key', orders: 0, risk_exits: riskSubmitted };
  }

  const scanLlm = await guardedClaudeCall({
    apiKey,
    payload: { model: ANTHROPIC_MODEL, max_tokens: 500, system: scanSystem, messages: [{ role: 'user', content: scanUser }] },
    now,
  });
  if (scanLlm.stale || scanLlm.status !== 200 || !scanLlm.data) {
    const reason = (scanLlm.stale ? 'fechas rotas tras retry (guard anti-alucinación)' : 'HTTP ' + scanLlm.status + ' de Anthropic') + ' [fase scan]';
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_llm_error', error: reason });
    return { status: 'aborted_llm_error', orders: 0, risk_exits: riskSubmitted };
  }
  const scanText = (scanLlm.data.content || []).map((b) => b.text || '').join('').trim();
  context.scan.response = scanText;

  const scan = parseScanResponse(scanText, MAX_CANDIDATES);
  if (!scan.ok) {
    // Regla de la casa: JSON malformado = run abortado honesto, CERO órdenes.
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_scan_malformed_json', llm_response: scanText, error: scan.error });
    return { status: 'aborted_scan_malformed_json', orders: 0, risk_exits: riskSubmitted };
  }
  context.scan.thesis = scan.thesis;
  context.scan.candidates = scan.candidates; // picks crudos del scout

  // ── FLOOR del screener ──────────────────────────────────────────
  // Reserva hasta SCREENER_FLOOR slots para el canal screener cuando alguna
  // screen dispara (evita que el sesgo del scout lo starve → mediría el sesgo,
  // no la calidad del canal). Cada candidato final lleva `origin`
  // (scout_picked / floor_reserved) para separar las dos métricas de atribución.
  // Determinista y auditable; time-boxed (a los 30 días, SCREENER_FLOOR=0).
  const screenerRanked = screenerRankedSymbols(buffet.screener || { value: [], momentum: [] });
  const slate = applyScreenerFloor(scan.candidates, screenerRanked, { floor: SCREENER_FLOOR, maxCandidates: MAX_CANDIDATES, screenerState: buffet.screener_state });
  context.scan.floor = slate.floor;       // { applied, reserved, reason, floor } — journaleado SIEMPRE (cond. #3)
  context.scan.screener_state = buffet.screener_state; // vacía/apagada/rancia/caída/fresh — por qué el canal llegó (o no) con datos
  context.scan.slate = slate.candidates;  // [{ symbol, origin }] — la lista final
  const candidateSymbols = slate.candidates.map((c) => c.symbol);
  const candidateOrigins = new Map(slate.candidates.map((c) => [c.symbol, c.origin]));

  // Cero candidatos FINALES (scout no vio nada Y el screener no aportó) → nada
  // que investigar. Estado DISTINTO de ok_no_actions (hubo candidatos y el DIVE
  // holdeó). `floor.reason` distingue POR QUÉ el screener no aportó: datos
  // frescos sin qualifiers (`no_qualifying_candidates`) vs. canal sin datos
  // (`screener_disabled/empty/stale/unavailable`) — el bug de origen era leer
  // "tabla vacía por flag faltante" como "ninguna acción calificó". No gasta el
  // DIVE ni pega a Finnhub.
  if (candidateSymbols.length === 0) {
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'ok_no_candidates', plan: scan.thesis || 'Scout found nothing worth a deep-dive today.', llm_response: scanText });
    return { status: 'ok_no_candidates', orders: riskSubmitted, candidates: 0, floor: slate.floor.reason, risk_exits: riskSubmitted, breaker_stage: risk.stage };
  }

  // ── FASE 2a: DEEP DIVE (determinista, Finnhub — sin LLM) ─────────
  const dive = await fetchDeepDive(candidateSymbols, process.env.FINNHUB_API_KEY, now);
  // Último cierre por candidato — MISMA fuente/valor que validará el guard, así
  // el PM ve exactamente el cierre contra el que se calcula la banda ±2% (sin
  // desfase). Se reusa abajo para el guard, sin re-fetch.
  const closeArr = await Promise.all(candidateSymbols.map((t) => lastCompletedClose(t, now)));
  const candidateCloses = {};
  candidateSymbols.forEach((t, i) => { candidateCloses[t] = closeArr[i]; });

  // ── FASE 2b: DIVE (LLM #2 — decide órdenes) ─────────────────────
  const diveSystem = buildDiveSystemPrompt();
  const diveUser = buildDiveUserPrompt({ account, positions, openOrders, previous, scanThesis: scan.thesis, candidates: candidateSymbols, deepDive: dive.data, closes: candidateCloses, channels: buffet.channelsByTicker });
  const diveHash = sha256(diveSystem + '\n---\n' + diveUser);
  // shown_closes: el cierre que se le MOSTRÓ al PM por candidato — para auditar
  // desfases contra lo que valida el guard (deberían coincidir siempre).
  context.dive = { prompt: { system: diveSystem, user: diveUser }, hash: diveHash, model: ANTHROPIC_MODEL, finnhub: dive.data, finnhub_errors: dive.errors, shown_closes: candidateCloses };
  // prompt_hash de la fila = el del DIVE (la fase que produce las órdenes).
  const withPrompt = { ...base, prompt_hash: diveHash, account: accountSnapshot, context };

  const diveLlm = await guardedClaudeCall({
    apiKey,
    payload: { model: ANTHROPIC_MODEL, max_tokens: 1500, system: diveSystem, messages: [{ role: 'user', content: diveUser }] },
    now,
  });
  if (diveLlm.stale || diveLlm.status !== 200 || !diveLlm.data) {
    const reason = (diveLlm.stale ? 'fechas rotas tras retry (guard anti-alucinación)' : 'HTTP ' + diveLlm.status + ' de Anthropic') + ' [fase dive]';
    await journalInsert({ ...withPrompt, status: 'aborted_llm_error', error: reason });
    return { status: 'aborted_llm_error', orders: 0, risk_exits: riskSubmitted };
  }
  const responseText = (diveLlm.data.content || []).map((b) => b.text || '').join('').trim();

  const parsed = parsePlanResponse(responseText);
  if (!parsed.ok) {
    await journalInsert({ ...withPrompt, status: 'aborted_malformed_json', llm_response: responseText, error: parsed.error });
    return { status: 'aborted_malformed_json', orders: 0, risk_exits: riskSubmitted };
  }

  // Referencias deterministas para el guard: symbol map + tipo (comparten
  // fetch/cache: 1 request en frío) + último cierre por símbolo propuesto.
  const symbolMap = await getSymbolMap(process.env.FINNHUB_API_KEY);
  const symbolTypes = await getSymbolTypes(process.env.FINNHUB_API_KEY);
  // Arranca de los cierres YA mostrados al PM (mismo valor exacto → sin desfase
  // entre lo que vio y lo que se valida); solo busca símbolos de acciones que
  // no eran candidatos (p.ej. vender una posición que el scan no nombró).
  const lastCloses = { ...heldCloses, ...candidateCloses };
  const symbols = [...new Set(parsed.actions.map((a) => a && typeof a.symbol === 'string' ? a.symbol.trim().toUpperCase() : '').filter(Boolean))];
  for (const s of symbols) {
    if (s in lastCloses) continue; // ya lo tenemos del deep dive (o null, fail closed)
    lastCloses[s] = await lastCompletedClose(s, now);
  }

  // El flujo de dos fases NO toca el guard: valida las órdenes finales con las
  // mismas reglas (universo, leveraged/inverse, security_type, banda, sizing,
  // cash, long-only). Los datos Finnhub del deep dive son contexto para el LLM,
  // no entran aquí — el guard sigue determinista, fail-closed, y no confía en
  // los candidatos del scan.
  const { approved, discarded } = validateActions({
    actions: parsed.actions,
    equity: account.equity, cash: account.cash,
    positions, symbolMap, symbolTypes, lastCloses,
  });

  // Atribución por acción (determinista, no confía en el LLM): de qué canal(es)
  // salió el ticker + `origin` (scout_picked/floor_reserved) + screen y
  // qualifiers si vino del screener. A los 30 días: qué canal produjo decisiones.
  const channels = buffet.channelsByTicker || {};
  const attribute = (a) => {
    const sym = a && typeof a.symbol === 'string' ? a.symbol.trim().toUpperCase() : '';
    const ch = sym ? channels[sym] : null;
    const enriched = { ...a, channels: ch ? ch.channels : [], origin: candidateOrigins.get(sym) || null };
    if (ch && ch.screens && ch.screens.length) { enriched.screens = ch.screens; enriched.screener_qualifiers = ch.qualifiers; }
    return enriched;
  };

  // ── PRECEDENCIA de las salidas de riesgo sobre las acciones del PM ──
  // Una salida determinista GANA sobre lo que el LLM propuso para ese nombre
  // (no se ejecutan las dos). Y en stage 'delever' se SUPRIMEN las compras del
  // PM: el breaker está subiendo efectivo, comprar lo contradiría. Las ventas
  // discrecionales del PM sí pasan (con su banda ±2% del guard).
  const riskSet = new Set(risk.approved.map((a) => a.symbol));
  const llmApproved = [];
  const overridden = [];
  for (const a of approved) {
    if (riskSet.has(a.symbol)) {
      overridden.push({ ...a, result: 'discarded', reason: `${a.symbol}: salida de riesgo determinista (${risk.stage}) tiene precedencia sobre la acción del PM` });
      continue;
    }
    if (risk.stage === 'delever' && a.side === 'buy') {
      overridden.push({ ...a, result: 'discarded', reason: `${a.symbol}: compra suprimida — el breaker está desapalancando (drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico)` });
      continue;
    }
    llmApproved.push(a);
  }

  // Ejecución del PM (límite ±2%, client_order_id `:buy`/`:sell`). Las salidas
  // de riesgo ya se ejecutaron y journalearon arriba, en su propia fila.
  const journalActions = [
    ...discarded.map((d) => attribute({ ...(d.action && typeof d.action === 'object' ? d.action : { raw: d.action }), result: 'discarded', reason: d.reason })),
    ...overridden.map((o) => attribute(o)),
  ];
  let submitted = 0;
  for (const a of llmApproved) {
    const clientOrderId = `arena:${runDate}:${a.symbol}:${a.side}`;
    try {
      const order = await createLimitOrder({ symbol: a.symbol, qty: a.qty, side: a.side, limit_price: a.limit_price, client_order_id: clientOrderId });
      journalActions.push(attribute({ ...a, result: 'approved', alpaca_order_id: order.id, client_order_id: clientOrderId, order_status: order.status }));
      submitted++;
    } catch (err) {
      journalActions.push(attribute({ ...a, result: 'submit_failed', client_order_id: clientOrderId, reason: String((err && err.message) || err) }));
    }
  }

  // El status de ESTA fila describe la decisión del PM: ok = envió órdenes;
  // ok_no_actions = holdeó (las salidas de riesgo van en su fila aparte).
  const status = submitted === 0 ? 'ok_no_actions' : 'ok';
  await journalInsert({ ...withPrompt, status, plan: parsed.plan, llm_response: responseText, actions: journalActions });
  // `orders` suma el run completo (PM + red de seguridad); `candidates` = slate final.
  return { status, orders: submitted + riskSubmitted, approved: llmApproved.length, discarded: discarded.length, candidates: candidateSymbols.length, floor: slate.floor.reason, risk_exits: riskSubmitted, breaker_stage: risk.stage, drawdown: +risk.drawdown.toFixed(4) };
}

// ── fase RECONCILE ───────────────────────────────────────────────────
// Fills reales (precio/timestamp de Alpaca) → journal. Estados terminales
// se dejan de consultar; lo demás se re-chequea hasta 7 días.
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day']);

export async function runArenaReconcile({ now = new Date() } = {}) {
  const rows = await sql(
    `select id, actions from arena_journal
     where phase = 'decide' and actions is not null and created_at > now() - interval '7 days'
     order by created_at desc`);
  const summary = { rows_checked: rows.length, orders_checked: 0, updated: 0, filled: 0 };

  for (const row of rows) {
    let changed = false;
    const actions = row.actions || [];
    for (const a of actions) {
      if (!a || !a.alpaca_order_id || TERMINAL.has(a.order_status)) continue;
      summary.orders_checked++;
      try {
        const o = await getOrder(a.alpaca_order_id);
        if (o.status !== a.order_status || o.filled_at !== a.filled_at) {
          a.order_status = o.status;
          a.filled_qty = o.filled_qty != null ? Number(o.filled_qty) : null;
          a.filled_avg_price = o.filled_avg_price != null ? Number(o.filled_avg_price) : null;
          a.filled_at = o.filled_at || null;
          changed = true;
          if (o.status === 'filled') summary.filled++;
        }
      } catch (e) { /* orden no consultable hoy: se reintenta en el próximo cron */ }
    }
    if (changed) {
      await sql(`update arena_journal set actions = $2 where id = $1`, [row.id, JSON.stringify(actions)]);
      summary.updated++;
    }
  }
  return summary;
}

// ── baseUrl del self-fetch al buffet ─────────────────────────────────
// PUBLIC_BASE_URL (dominio público estable, p.ej. https://quantdesk2.vercel.app)
// PRIMERO: VERCEL_URL es la URL *generada* del deployment y está detrás de
// Vercel Deployment Protection → devuelve 401 al self-fetch de la lambda (la
// causa raíz del 24-jul: los 4 endpoints "cayeron" con 401 y el Arena quedó
// 100% cash). El alias público no está protegido. Fallbacks conservados para
// dev/preview local. Pendiente A1 (refactor): llamadas in-process sin red.
export function resolveBaseUrl(req) {
  const proto = ((req && req.headers && req.headers['x-forwarded-proto']) || 'https');
  const host = req && req.headers && req.headers.host;
  const raw = process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : proto + '://' + host);
  return String(raw).replace(/\/+$/, '');
}

// ── handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  // El switch de Lety: los crons de vercel.json disparan desde el deploy,
  // pero el Arena no opera hasta ARENA_ENABLED=1 (post smoke verde).
  if (process.env.ARENA_ENABLED !== '1') {
    const phase = String((req.query && req.query.phase) || 'decide').toLowerCase();
    if (phase === 'reconcile' || phase === 'decide') await beat('arena:' + phase, 'disabled');
    return res.status(200).json({ disabled: true, hint: 'ARENA_ENABLED != 1 — smoke de /api/alpaca?smoke=1 primero.' });
  }

  try {
    await ensureSchema();
    const phase = String((req.query && req.query.phase) || 'decide').toLowerCase();
    const action = String((req.query && req.query.action) || '').toLowerCase();
    // Reactivación MANUAL tras un halt del breaker (−20%). Requiere CRON_SECRET
    // (ya validado arriba) — solo Lety revive al agente, y queda documentado.
    if (action === 'resume') {
      const result = await runArenaResume({});
      return res.status(200).json({ action: 'resume', ...result });
    }
    if (action === 'status') {
      return res.status(200).json({ action: 'status', state: await getArenaState() });
    }
    if (phase === 'reconcile') {
      const summary = await runArenaReconcile({});
      await beat('arena:reconcile', 'ok', { halted: summary && summary.halted });
      return res.status(200).json({ phase, ...summary });
    }
    const baseUrl = resolveBaseUrl(req);
    const summary = await runArenaDecide({ baseUrl });
    await beat('arena:decide', 'ok', { actions: summary && summary.actions ? summary.actions.length : null });
    return res.status(200).json({ phase: 'decide', ...summary, rules: ARENA_RULES });
  } catch (err) {
    return res.status(500).json({ error: 'arena-run: ' + (err && err.message ? err.message : 'unknown') });
  }
}
