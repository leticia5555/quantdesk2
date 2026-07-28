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
import { fetchDeepDive } from './_lib/finnhub-dive.js';
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

// Snapshot del libro compartido por ambas fases.
function portfolioSnapshot({ account, positions, openOrders }) {
  return {
    equity: Number(account.equity),
    cash: Number(account.cash),
    positions: (positions || []).map((p) => ({
      symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
      market_value: Number(p.market_value), unrealized_plpc: Number(p.unrealized_plpc),
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

// ── fase DECIDE ──────────────────────────────────────────────────────
export async function runArenaDecide({ baseUrl, now = new Date() }) {
  const runDate = now.toISOString().slice(0, 10);
  const base = { id: 'arena-' + now.toISOString(), run_date: runDate, phase: 'decide', prompt_version: PROMPT_VERSION, model: ANTHROPIC_MODEL };

  if (!alpacaCreds()) {
    await journalInsert({ ...base, status: 'aborted_no_alpaca_keys', error: 'Faltan ALPACA_PAPER_KEY/SECRET.' });
    return { status: 'aborted_no_alpaca_keys', orders: 0 };
  }

  // Estado real del libro + buffet + plan anterior, en paralelo.
  const [account, positions, openOrders, buffet, prevRows] = await Promise.all([
    getAccount(), getPositions(), getOrders('open'),
    gatherContext({ baseUrl, now }),
    sql(`select run_date, plan, actions, status from arena_journal
         where phase = 'decide' and plan is not null order by created_at desc limit 1`),
  ]);
  const accountSnapshot = { equity: Number(account.equity), cash: Number(account.cash), positions: positions.length };
  const previous = prevRows[0]
    ? { date: prevRows[0].run_date, plan: prevRows[0].plan,
        orders: (prevRows[0].actions || []).map((a) => ({ symbol: a.symbol, side: a.side, result: a.result, order_status: a.order_status || null, filled_avg_price: a.filled_avg_price || null, reason: a.reason || null })) }
    : null;

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
    scan: { prompt: { system: scanSystem, user: scanUser }, hash: scanHash, model: ANTHROPIC_MODEL },
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Dependencia documentada: la primera corrida real necesita créditos
    // de Anthropic. Sin key el run queda journaleado, con cero órdenes.
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_no_api_key', error: 'Falta ANTHROPIC_API_KEY (créditos pendientes).' });
    return { status: 'aborted_no_api_key', orders: 0 };
  }

  const scanLlm = await guardedClaudeCall({
    apiKey,
    payload: { model: ANTHROPIC_MODEL, max_tokens: 500, system: scanSystem, messages: [{ role: 'user', content: scanUser }] },
    now,
  });
  if (scanLlm.stale || scanLlm.status !== 200 || !scanLlm.data) {
    const reason = (scanLlm.stale ? 'fechas rotas tras retry (guard anti-alucinación)' : 'HTTP ' + scanLlm.status + ' de Anthropic') + ' [fase scan]';
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_llm_error', error: reason });
    return { status: 'aborted_llm_error', orders: 0 };
  }
  const scanText = (scanLlm.data.content || []).map((b) => b.text || '').join('').trim();
  context.scan.response = scanText;

  const scan = parseScanResponse(scanText, MAX_CANDIDATES);
  if (!scan.ok) {
    // Regla de la casa: JSON malformado = run abortado honesto, CERO órdenes.
    await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_scan_malformed_json', llm_response: scanText, error: scan.error });
    return { status: 'aborted_scan_malformed_json', orders: 0 };
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
    return { status: 'ok_no_candidates', orders: 0, candidates: 0, floor: slate.floor.reason };
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
    return { status: 'aborted_llm_error', orders: 0 };
  }
  const responseText = (diveLlm.data.content || []).map((b) => b.text || '').join('').trim();

  const parsed = parsePlanResponse(responseText);
  if (!parsed.ok) {
    await journalInsert({ ...withPrompt, status: 'aborted_malformed_json', llm_response: responseText, error: parsed.error });
    return { status: 'aborted_malformed_json', orders: 0 };
  }

  // Referencias deterministas para el guard: symbol map + tipo (comparten
  // fetch/cache: 1 request en frío) + último cierre por símbolo propuesto.
  const symbolMap = await getSymbolMap(process.env.FINNHUB_API_KEY);
  const symbolTypes = await getSymbolTypes(process.env.FINNHUB_API_KEY);
  // Arranca de los cierres YA mostrados al PM (mismo valor exacto → sin desfase
  // entre lo que vio y lo que se valida); solo busca símbolos de acciones que
  // no eran candidatos (p.ej. vender una posición que el scan no nombró).
  const lastCloses = { ...candidateCloses };
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

  // Ejecución: límite + day, client_order_id determinista (idempotencia).
  const journalActions = discarded.map((d) => attribute({ ...(d.action && typeof d.action === 'object' ? d.action : { raw: d.action }), result: 'discarded', reason: d.reason }));
  let submitted = 0;
  for (const a of approved) {
    const clientOrderId = `arena:${runDate}:${a.symbol}:${a.side}`;
    try {
      const order = await createLimitOrder({ symbol: a.symbol, qty: a.qty, side: a.side, limit_price: a.limit_price, client_order_id: clientOrderId });
      journalActions.push(attribute({ ...a, result: 'approved', alpaca_order_id: order.id, client_order_id: clientOrderId, order_status: order.status }));
      submitted++;
    } catch (err) {
      journalActions.push(attribute({ ...a, result: 'submit_failed', client_order_id: clientOrderId, reason: String((err && err.message) || err) }));
    }
  }

  // ok = se enviaron órdenes; ok_no_actions = hubo candidatos e investigación,
  // pero el DIVE decidió holdear (distinto de ok_no_candidates).
  const status = approved.length === 0 ? 'ok_no_actions' : 'ok';
  await journalInsert({ ...withPrompt, status, plan: parsed.plan, llm_response: responseText, actions: journalActions });
  // `candidates` = tamaño del slate final (scout + floor), no solo los picks del scout.
  return { status, orders: submitted, approved: approved.length, discarded: discarded.length, candidates: candidateSymbols.length, floor: slate.floor.reason };
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
    return res.status(200).json({ disabled: true, hint: 'ARENA_ENABLED != 1 — smoke de /api/alpaca?smoke=1 primero.' });
  }

  try {
    await ensureSchema();
    const phase = String((req.query && req.query.phase) || 'decide').toLowerCase();
    if (phase === 'reconcile') {
      const summary = await runArenaReconcile({});
      return res.status(200).json({ phase, ...summary });
    }
    const baseUrl = resolveBaseUrl(req);
    const summary = await runArenaDecide({ baseUrl });
    return res.status(200).json({ phase: 'decide', ...summary, rules: ARENA_RULES });
  } catch (err) {
    return res.status(500).json({ error: 'arena-run: ' + (err && err.message ? err.message : 'unknown') });
  }
}
