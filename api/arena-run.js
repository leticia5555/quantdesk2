// ═══════════════════════════════════════════════════════════════
// /api/arena-run — el tick del ARENA: la LIGA multi-modelo.
//
// LLMs portfolio manager estilo Rallies/nof1 con la etiqueta honesta de la
// casa: experimento SIN validación estadística. Cada agente activo (registry
// en _lib/arena-registry.js: Claude/OpenAI/control en Fase A) corre el MISMO
// harness sobre SU propio libro Alpaca paper — para comparar el MODELO, no el
// prompt ni el presupuesto. `runArenaLeague` orquesta a todos en paralelo con
// el buffet/deep-dive/cierres compartidos por corrida; `runArenaDecide` es la
// decisión de UN agente (default el insignia `claude`, cuyo historial —Agente
// #6— se preserva). La flota validada sigue en el simulador (agents-run), aparte.
// Doc de la liga: docs/arena-liga-scope.md.
//
//   GET  ?phase=decide (default) → cron post-cierre (22:40 UTC L-V). Corre la
//        LIGA: por CADA agente activo, DOS fases (SCAN → DEEP DIVE) con SU
//        modelo (Anthropic directo u OpenRouter) y temperatura fija 0.7:
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
//   GET  ?phase=morning → CORRIDA POR EVENTO (14:50 UTC L-V, Temporada 2 #7).
//        NO es una segunda corrida diaria: solo gasta LLM si una posición del
//        libro de algún agente acaba de reportar (AMC de la sesión anterior o
//        BMO de hoy). Se salta el SCOUT (el evento ya define el slate), no
//        re-evalúa la red determinista (decide con cierres COMPLETOS, y a media
//        mañana no hay uno nuevo) y SUPRIME las compras: existe para decidir
//        sobre lo que ya se tiene. Sin evento → una fila marcadora de liga.
//
// TEMPORADA 2 (2026-09-13, reglamento completo en docs/arena.md): memoria de
// compromisos con fecha, recién-reportados 2 sesiones en el buffet, trailing
// stop, time stop a 45 días, salidas marketable, flag de ratios outlier,
// corrida por evento, NO breaker SMA200 y pronunciamiento obligatorio por
// posición. El cambio de reglas se anuncia en el journal (announceT2Rules).
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
import { getSymbolMap, getSymbolTypes, MEGA_CAPS } from './earnings.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { getAccount, getPositions, getOrders, getOrder, createLimitOrder, alpacaCreds, getCalendar } from './_lib/alpaca.js';
import { parseScanResponse, parsePlanResponse, validateActions, applyScreenerFloor, ARENA_RULES, isLeveragedInverseETF, NON_EQUITY_TYPES, EXCLUDED_SECURITY_TYPES } from './_lib/arena-guard.js';
import { buildRiskExits, EXIT_RULES } from './_lib/arena-exits.js';
// TEMPORADA 2: la memoria del agente (compromisos con fecha, historia de cada
// posición, auditoría del pronunciamiento). JS puro, sin I/O — ver el encabezado
// de _lib/arena-memory.js para el porqué de cada pieza.
import {
  reconstructPositionOpens, buildPositionMeta, peaksFromMeta,
  normalizeCommitments, normalizeCommitmentUpdates, foldCommitments, auditCommitments,
  normalizePositionsReview, auditPositionReview,
} from './_lib/arena-memory.js';
import { fetchDeepDive } from './_lib/finnhub-dive.js';
import { auditPlanPercentages } from './_lib/prose-audit.js';
import { relativeDayLabel } from './_lib/ai-guard.js';
import { beat } from './_lib/heartbeat.js';
import { readScreenerRows } from './_lib/screener-db.js';
// Caché POR DÍA de los canales cuyo contenido es un hecho del día (insiders).
import { cachedDayFetch } from './_lib/arena-buffet-cache.js';
// BUFFET v1.5: el universo del día con ojos propios (screener de Alpaca:
// movers + most-actives + máx/mín de 52 semanas, deduplicado con banderas).
import { buildBuffetV15, BUFFET_V15_TARGET } from './_lib/arena-buffet.js';
// B1: el universo del día (~600), precomputado por su cron pre-apertura.
import { loadUniverse } from './_lib/arena-universe.js';
// B6: los rieles, para que el prompt del contrato nuevo diga los MISMOS números
// que el validador hace cumplir. Dos fuentes para el mismo tope es cómo el
// prompt termina prometiendo algo que el harness rechaza.
import { RAILS } from './_lib/arena-rails.js';
import { usaObjetivo, contratoActivo } from './_lib/arena-objetivo-vivo.js';
import { runAgenteObjetivo } from './arena-shadow.js';
// B2: EL TABLERO — lo que los siete miran, idéntico, en el prefijo cacheado.
import { buildBoard, renderBoard, BOARD_TOKEN_HARD_CAP, SECTOR_ETFS } from './_lib/arena-board.js';
// B3: las HERRAMIENTAS y el loop de tool use (uno para los dos proveedores).
import { createToolExecutor, TOOL_BUDGET } from './_lib/arena-tools.js';
import { sectorFromGics, sectorFromIndustry } from './_lib/arena-meta.js';
import {
  currentTier, recordRunSpend, callCost, tierAnnouncementId, tierAnnouncementText, DAILY_BUDGET_USD,
} from './_lib/arena-budget.js';
import { runToolLoop } from './_lib/arena-tool-loop.js';
// A4c: el filtro de admisión del universo, UNO para todos los canales.
import { ADMISSION, resolveAdmission, partitionByAdmission } from './_lib/arena-admission.js';
import { computeScreens, screenerRankedSymbols, screenerDataState } from './_lib/screens.js';
// LIGA multi-modelo: el registry (quién compite, con qué modelo/cuenta/persona)
// y el dispatch de proveedor (Anthropic directo vs OpenRouter, forma normalizada).
import { callArenaLLM, providerKey, effectiveParams, sameParams, withDeadline, cachePrefixReport, anthropicCostUsd } from './_lib/arena-model.js';
// TITULAR de la corrida (voz del arquetipo). Llamada APARTE y POSTERIOR: el
// arquetipo NUNCA entra al prompt que decide — ver el candado del control en el
// encabezado de _lib/arena-voice.js.
import { generateHeadline } from './_lib/arena-voice.js';
import { ARENA_AGENTS, ARENA_SEASON, ARENA_MAX_TOKENS, ARENA_EFFORT, ARENA_TEMPERATURE, ARENA_AGENT_DEADLINE_MS, ANTHROPIC_CACHE_MIN_TOKENS, activeAgents, agentById, agentAlpacaCreds, isSeasonFinalDay, seasonDay, seasonStatus, modelSlugResolved, FLAGSHIP_AGENT_ID } from './_lib/arena-registry.js';
// CADENCIA POR EVENTO: el corte de fecha y las constantes del vigilante.
// El runner solo necesita saber CUÁNDO deja de correr el cron nocturno y qué
// dice el reglamento nuevo; la lógica de disparadores vive en su módulo.
import { WATCH_RULES, watchCadenceActive, watchStartDate } from './_lib/arena-watch.js';
// EL CORTE: baseline por agente (reset) + el piso del pico del breaker.
// Ver _lib/arena-baseline.js — SEASON_CUTOFF sigue siendo el suelo, el baseline
// solo lo puede mover hacia ADELANTE.
import { effectiveCutoff, breakerPeak, RESET_BASELINE_USD, readBaselines } from './_lib/arena-baseline.js';

// Re-export: la detección de leveraged/inverse vive en el guard (hogar de las
// reglas de universo); el buffet (trimMovers) la reusa y los tests de
// arena-run la importan desde acá.
export { isLeveragedInverseETF };

// El decide corre N agentes en paralelo, cada uno con buffet (self-fetch) +
// deep dive Finnhub + DOS llamadas LLM (SCAN, DIVE); ya peleaba contra el
// default de 60s de Vercel, y el reconcile pre-decide (true-up del journal
// antes de reinyectar el plan) le suma un pase más de órdenes. La cuenta es
// plan Pro (tope 300s) → le damos aire. Misma medicina que pead-harvest y
// arena-screener. El reconcile matutino (mismo handler, phase=reconcile) hereda
// el cap; no le estorba (termina en segundos).
export const maxDuration = 300;

// v3-t2: TEMPORADA 2 (2026-09-13) — memoria de compromisos, pronunciamiento
// obligatorio por posición, trailing/time stop, salidas marketable y corrida
// matutina por evento. v2 era el flujo de DOS fases (SCAN → DEEP DIVE); v1, un
// solo LLM call sobre el buffet. El bump permite cortar el post-mortem por
// temporada: las métricas de T1 y T2 NO son comparables (cambió el reglamento).
export const PROMPT_VERSION = 'arena-pm-v3-t2';

// ── REGLAMENTO DE LA TEMPORADA 2 ─────────────────────────────────────
// El cambio de reglas se ANUNCIA en el journal con fecha, una sola vez (fila
// idempotente por este id, agent_id='league'): sin ese corte, el post-mortem
// compara peras con manzanas. Mismo patrón que el corte BUFFET_QUALITY_DEPLOY
// del endpoint de auditoría, pero registrado por el propio runner en vez de
// deducido de un merge.
export const T2_RULES_VERSION = /* date-lint-ok: no es una referencia a "hoy" — es la fecha en que se cambió el reglamento, un hecho histórico fijo que ancla el corte del post-mortem */ '2026-09-13';
export const T2_ANNOUNCEMENT_ID = 'arena-reglamento-t2-' + T2_RULES_VERSION;
export const T2_RULES_TEXT = [
  `TEMPORADA 2 del Arena — reglamento vigente desde ${T2_RULES_VERSION}. Aplica IGUAL a los siete agentes de la liga.`,
  '1) MEMORIA DE COMPROMISOS: lo que el PM promete queda guardado con fecha y vuelve en la corrida siguiente con obligación de pronunciarse (cumplido/vigente/cancelado). Fix de la amnesia NVDA/CRM.',
  '2) RECIÉN-REPORTADOS: una empresa que acaba de reportar permanece 2 sesiones más en el buffet, con su fecha de reporte y sus cifras — antes desaparecía el mismo día y la tesis quedaba sin cerrar.',
  '3) TRAILING STOP determinista: un pico de +15% desde la entrada ARMA un trailing del 8% sobre ese pico. Por construcción nunca vende en pérdida: protege ganancia, no es un stop apretado.',
  '4) TIME STOP a 45 días: no vende — OBLIGA a pronunciarse sobre la posición.',
  '5) SALIDAS A MARKETABLE LIMIT: la venta del PM se envía por debajo del mercado para que LLENE. Cicatriz GOOGL: una venta decidida que expira sin llenar no es una venta.',
  '6) RATIOS OUTLIER marcados como "posible artefacto contable" (caso LYFT): el número viaja igual, con la bandera al lado.',
  '7) CORRIDA MATUTINA POR EVENTO: si una posición del libro reportó, hay una corrida extra por la mañana para reaccionar al movimiento — solo sobre esos nombres, sin abrir riesgo nuevo.',
  '8) NO hay breaker por SMA200: descartado explícitamente (NO-GO del backtest dual-momentum). El gate de tendencia no entra al Arena.',
  '9) PRONUNCIAMIENTO OBLIGATORIO por posición en cada corrida: hold/trim/exit + razón, con días en posición, P/L y distancia al pico ya calculados en el contexto.',
  'OBJETIVO DECLARADO: que el agente venda cuando debe y recuerde lo que prometió. NO que opere más seguido — ninguna regla de arriba premia la frecuencia.',
].join('\n');

// El SCOUT nombra hasta este número de tickers para el deep dive. Es también
// el tope de llamadas a Finnhub por corrida (4 endpoints × 5 = ~20, bajo el
// cap de 60/min del tier gratis).
// ── CORTE POR TEMPORADA (fix del journal del 14) ─────────────────────
// TODA la memoria que se le reinyecta al PM se corta en el arranque de la
// temporada vigente. Antes NO se cortaba en ninguna de las cuatro consultas:
//   · el PLAN ANTERIOR salía del último `decide` sin importar de qué temporada;
//   · los FILLS para reconstruir aperturas miraban 180 días;
//   · los COMPROMISOS abiertos miraban 60 días;
//   · el PICO de equity del breaker no tenía corte ninguno.
//
// Eso producía dos bugs distintos:
//   (a) EL PM RECUERDA UNA TEMPORADA QUE YA NO EXISTE. El 14 —primer día de la
//       T2— el plan reinyectado era el último de la T1, y los fills de 180 días
//       traían posiciones de un libro que se había aplanado. Un PM narrando
//       "ZM filled at $95.5" sobre un libro que no tiene ZM es exactamente esa
//       forma: el dato es real, pero es de otra temporada (ver §A4a del doc).
//   (b) EL BREAKER DISPARARÍA EL DÍA DEL RESET. `max(equity)` sin corte
//       arrastra el pico de la temporada anterior. Un libro que se aplana a
//       $100k desde un pico de, digamos, $130k arranca con drawdown de −23% →
//       corte amplio y el agente HALTED en su primera corrida de la temporada.
//       Esto habría pasado el lunes 21 con el reset a $100k.
//
// La fecha sale del registry (ARENA_SEASON.start), no de una consulta por la
// fila `season_started`: es la verdad declarada, y así el corte funciona aunque
// el anuncio no se haya escrito todavía.
const SEASON_CUTOFF = ARENA_SEASON.start;

export const MAX_CANDIDATES = 5;

// FLOOR del canal screener — TIME-BOXED del trial (~30 días). Reserva hasta 2
// de los 5 slots de candidatos para el screener cuando alguna screen dispara,
// para que la atribución mida la CALIDAD DEL CANAL y no el sesgo del scout
// (sin floor, un scout sesgado a lo noticioso podría no elegir screener en
// semanas → mediríamos su sesgo). A los 30 días, con datos, baja a 0 →
// free-choice puro. El flag `origin` (scout_picked/floor_reserved) separa las
// dos métricas de atribución.
export const SCREENER_FLOOR = 2;

// ── EL PREFIJO CACHEABLE (fix del smoke del 2026-09-15) ──────────────
// El smoke reportó `cache_read: 0` Y `cache_write: 0` en los dos agentes de
// Anthropic. No era que la caché estuviera mal configurada — el payload manda
// `cache_control` desde siempre (ver buildAnthropicPayload). Era que el bloque
// marcado NO LLEGABA AL MÍNIMO CACHEABLE: el system del SCAN medía ~330 tokens
// contra un piso de 1.024. Por debajo del piso el proveedor ignora el marcador
// en silencio: no escribe caché, no cobra de más, y no avisa. Cero ahorro, cero
// error, cero pista.
//
// El arreglo NO es inflar el prompt: es PONER CADA COSA DE SU LADO DEL CORTE.
// Estos bloques —el reglamento, cómo leer cada campo, el formato de salida— son
// BYTE-IDÉNTICOS para los siete agentes y no cambian entre corridas. Estaban en
// el turno del USUARIO, o sea del lado volátil, viajando enteros y a precio
// completo en cada una de las ~12 corridas diarias × 7 agentes. Del lado
// estable se escriben una vez y se leen ~10× más barato.
//
// LA REGLA DE ORO, y el orden del prompt que sale de ella:
//     system (reglamento + cómo leer) → [BREAKPOINT] → fecha + libro + buffet
// Estable antes del último `cache_control`, volátil después. Al revés —la fecha
// o el libro adentro del bloque marcado— la caché se invalida cada día o cada
// agente, y el ahorro vuelve a ser cero.
//
// El piso del proveedor vive en el registry (_lib/arena-registry.js) porque
// _lib/arena-model.js también lo necesita y definirlo acá crearía un ciclo.
//
// ── ACÁ HABÍA UN `export { ANTHROPIC_CACHE_MIN_TOKENS }` Y TUMBÓ EL VIGILANTE ──
//
//   /api/arena-run.js:6
//   TypeError: Cannot redefine property: ANTHROPIC_CACHE_MIN_TOKENS
//
// `import { X }` + `export { X }` del MISMO binding en un archivo es legal en
// ESM y explota al transpilarse a CommonJS: la interoperabilidad define `X`
// sobre `exports` como propiedad NO configurable al resolver el import, y el
// re-export vuelve a llamar a `Object.defineProperty` sobre esa misma clave.
// El segundo tira TypeError.
//
// Como revienta al CARGAR el módulo, no al usar el símbolo, se llevó puesto a
// todo el que importa este archivo — y el que lo importa es `/api/arena-watch`,
// que contestó 500 en CADA tick. El vigilante estuvo muerto.
//
// El re-export no servía para nada, además: NADIE lo importaba desde acá.
// `arena-smoke` ya lo trae del registry, que es donde vive. Si algún día hace
// falta re-exportarlo, la forma que SÍ sobrevive al transpilado es
// `export { X } from './_lib/arena-registry.js'` — que no crea el binding local
// y por lo tanto no define la propiedad dos veces.

// Estimador de tokens. ~4 chars por token en inglés — deliberadamente tosco:
// sirve para saber si un bloque está CERCA del piso, no para facturar. El
// número que manda siempre es el `usage` del proveedor, y por eso el smoke
// reporta los dos al lado (`tokens_est` y `cache.write`): si divergen mucho, el
// que está mal es el estimador, no la caché.
export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

// Los bloques ESTABLES del contexto, compartidos por las dos fases. Viven acá,
// juntos y nombrados, por dos razones: (a) son lo que se movió al prefijo
// cacheado y tiene que ser fácil ver que ninguno trae un dato del día; (b) un
// test los recorre para verificar justo eso.
export const STABLE_BLOCKS = {
  board: "THE MARKET BOARD — the board is the market, not a list of picks. Nobody pre-selected anything in it for you: it shows what moved, what traded, what broke its range, what reports soon and what was written about, and WHICH of those deserve attention is your call. Read the column labels: a price marked `live` is the current trade and a return marked `CLOSED bars` is through the last completed session — they are different clocks and you should not mix them in one sentence. RVOL is today's volume over its 20-session average, and INTRADAY IT READS LOW because the day is not over while the average is of full sessions: a 1.0 at mid-morning is already heavy volume. A section the board says was TRUNCATED is not empty — it did not fit, so do not conclude there was nothing there. A name absent from the board is not a name that did nothing: the board shows the extremes of a ~600 name universe, not all of it.",
  universe: "TODAY'S UNIVERSE — `universe.candidates` is the day's investable list, rebuilt this morning from three DIFFERENT questions, not one: which names MOVED (the day's biggest gainers and losers), which names TRADED (highest dollar volume — a name can move 8% on no volume, or trade $2B without moving), and which names BROKE their range (at or within `universe.near_52w_pct`% of a 52-week high or low, computed from CLOSED weekly bars, so the current week is excluded). Every candidate carries `flags` naming which of those it came from. A name with SEVERAL flags is not louder, it is DIFFERENT: it moved AND traded AND broke out. Every name here already passed one admission filter (price, market cap, dollar volume) — the list is not filtered for quality, only for being investable, so a name appearing is not a recommendation. `counts` tells you how many were dropped before you saw it.",
  equity: 'EQUITY — `equity_total_incl_cash` is the TOTAL value of the book: your positions PLUS your cash. `cash_included_in_equity` is the part of that same total that is not invested — it is NOT an extra amount on top. Do not add them together, and size positions as a fraction of the total.',
  earnings_timing: 'EARNINGS TIMING — each entry in `earnings_this_week` carries `when`, the distance from today ALREADY COMPUTED for you ("in 2 days (Wed Aug 26, AMC)", "today (Mon Aug 24, BMO)"). Use that label as-is when you mention a report; do not re-derive it from `date`, and never call a report scheduled for a later date "today" or "tonight". BMO = before the market opens that day, AMC = after it closes.',
  already_reported: 'ALREADY REPORTED — `recently_reported` holds companies whose number is ALREADY OUT (within the last 2 sessions), with the actual EPS and the surprise vs estimate already computed. These are here on purpose: if a previous plan of yours was waiting on one of these reports, the wait is over — that name is worth a deep-dive so you can close the loop instead of leaving the thesis hanging.',
  position_history_scan: 'POSITION HISTORY — each holding carries `days_in_position`, `peak_since_entry`, `from_peak_pct`, `trailing_stop` and `time_stop`, all already computed. A holding whose `time_stop.due` is true, or that is far below its peak, is a legitimate deep-dive candidate: you will have to state hold/trim/exit for every position later, and this is the step where you buy the research to do it well.',
  position_history_dive: 'POSITION HISTORY — each holding carries numbers that are ALREADY COMPUTED for you: `days_in_position` (calendar days since this position was opened; null = it predates the journal and could not be reconstructed — say so rather than guessing), `peak_since_entry` (highest completed close since entry, floored at your cost), `from_peak_pct` (how far below that peak it trades now), `trailing_stop` (armed and its sell level, or the level at which it would arm) and `time_stop` ({days, limit, due}). Quote these as given; do NOT recompute or invent them.',
  notes: 'NOTES: null fields mean the datum was unavailable (do not guess it). Analyst price targets are NOT provided; use the recommendation buy/hold/sell split as the rating signal. marketCapM is in millions USD.',
  ratio_sanity: 'RATIO SANITY — a candidate may carry `fundamentals_quality`, flagging ratios outside any plausible range (a P/E in the hundreds, a negative debt/equity, a margin above 100%). Those numbers are almost always an accounting artifact — a one-off charge or negative book equity — not a description of the business. If a ratio is flagged, either leave it out of your reasoning or say explicitly that it may be an artifact. Never build a thesis on a flagged ratio as if it were a clean fundamental.',
  earnings_out: 'EARNINGS ALREADY OUT — a candidate whose `earnings` carries `reported: true` has ALREADY reported (with `sessions_since_report`, the actual EPS and the surprise vs estimate, all given to you). If you were waiting on that number, the wait is over: close the loop in this run rather than deferring it again.',
  news_recency: 'NEWS RECENCY — each news item carries a `date` (YYYY-MM-DD). Before you describe any headline, compare its date to today\'s date (given in the system prompt): state how long ago it happened ("N days ago", the weekday) and reserve "today" for a date that equals today. A headline dated before today is NOT today\'s news — do not narrate a report from several days ago as if it broke today.',
  earnings_timing_dive: 'EARNINGS TIMING — a candidate flagged by the earnings channel carries `earnings: {date, time, when}`, where `when` is the distance from today ALREADY COMPUTED for you ("in 2 days (Wed Aug 26, AMC)", "tomorrow (Tue Aug 25, BMO)"). Quote that label as-is; do not re-derive it from `date`, and never describe a report scheduled for a later date as happening "today" or "tonight" — if your plan holds cash for a post-earnings dislocation, say which day the catalyst actually lands on. BMO = before that day\'s open, AMC = after that day\'s close. A candidate WITHOUT an `earnings` field has no report date in your data: do not assert one from memory.',
  figures: 'FIGURES — when your plan cites a number (a %, a price, a P&L), use ONLY the figures given to you here or in the PORTFOLIO above, verbatim. Each holding carries `pnl_since_entry_pct`, already formatted ("+6.1%"): that is profit/loss SINCE YOUR ENTRY, not today\'s price move — quote it as-is if you mention it. Do NOT compute, rescale, round, or invent percentages you were not given.',
};

// ── SCAN (fase 1): el SCOUT filtra el buffet a ≤5 tickers a investigar. ──
// No decide órdenes: solo nombra candidatos. El schema es contrato.
export function buildScanSystemPrompt() {
  return `You are the SCOUT for QuantDesk Arena, an LLM-run PAPER trading experiment. This is STEP 1 of 2: triage, not trading.

Your job: from today's market context (movers, earnings, insider buys, and a deterministic value/momentum screener that surfaces solid companies at a good price even when they made no news today) AND the current portfolio, pick up to ${MAX_CANDIDATES} US-listed common-stock tickers worth a deep-dive before the next open. A ticker is worth a deep-dive if there is a plausible reason to BUY it, or if it is an existing holding you might TRIM or EXIT. You do NOT have full fundamentals yet — that is step 2; the screener already carries the metrics that qualified each name (P/E, ROE, debt, % above moving average). Here you are only deciding what deserves the research budget.

RULES:
- US-listed common equities only. No warrants/units/rights, no sub-$1 stocks, no crypto, no options.
- At most ${MAX_CANDIDATES} candidates. Fewer is fine. An EMPTY list is valid and correct when nothing today warrants research — do not pad it.
- Only pick tickers grounded in the context or the portfolio below. Do not invent tickers or prices.

HOW TO READ WHAT YOU ARE GIVEN (these fields are pre-computed for you — quote them, do not re-derive them):
${STABLE_BLOCKS.board}
${STABLE_BLOCKS.universe}
${STABLE_BLOCKS.equity}
${STABLE_BLOCKS.earnings_timing}
${STABLE_BLOCKS.already_reported}
${STABLE_BLOCKS.position_history_scan}
Sections listed in "unavailable" failed to load today — do not guess their content.

OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no prose outside JSON):
{"scan_thesis": "<why these tickers, or why none, 1-4 sentences>", "candidates": ["TICKER", ...]}
Pick up to ${MAX_CANDIDATES} tickers worth a deep-dive, or none. ONE JSON object, nothing else.`;
}

// ── DIVE (fase 2): las reglas del PM. Mismo contrato que el v1 single-call,
// para que el guard downstream no cambie una línea. El schema es contrato. ──
// `persona` es la ÚNICA parte del prompt que varía entre agentes de la liga
// (identidad, decisión #6): el resto es idéntico para medir el MODELO, no el
// prompt. `claude` y `control` comparten persona ("Claude PM") — eso hace del
// control un piso de ruido válido. Default "Claude PM" = comportamiento v1.
export function buildDiveSystemPrompt(persona = 'Claude PM') {
  return `You are "${persona}", the portfolio manager of QuantDesk Arena — a PUBLIC experiment: an LLM managing a real Alpaca PAPER account (simulated money, real market quotes). Your reasoning is published verbatim next to every trade. This is STEP 2 of 2: you now have deep-dive data (fundamentals, analyst recommendations, recent news) for the candidates your scout flagged.

HARD RULES (a deterministic risk guard enforces them AFTER you — violations are discarded and logged, never fixed for you):
- Universe: US-listed common equities only. No warrants, no units, no rights, no sub-$1 stocks, no crypto, no options, no shorting. Long only.
- Max ${ARENA_RULES.max_positions} simultaneous positions. Max ${ARENA_RULES.max_position_fraction * 100}% of equity per position. Keep at least ${ARENA_RULES.min_cash_fraction * 100}% of equity in cash.
- LIMIT orders only, good for the day, executed at the NEXT market open. Set limit_price within ±${ARENA_RULES.price_band * 100}% of the last close you are given — wider is auto-discarded.
- Base your decisions on the deep-dive data and portfolio provided. Do not invent prices, news or fundamentals, and do not introduce tickers you were given no data for.

SEASON 2 RULES (deterministic layers that run around you — know them so your plan is consistent with what the book actually does):
- A TRAILING STOP protects gains without you: once a position's peak since entry reaches +${(EXIT_RULES.trailing_arm_gain * 100).toFixed(0)}%, it is armed, and a close ${(EXIT_RULES.trailing_give_back * 100).toFixed(0)}% below that peak sells the whole position at the next open. By construction it can only sell at a profit. Each holding shows you whether it is armed and at what level.
- A TIME STOP at ${EXIT_RULES.time_stop_days} days does NOT sell: it obliges you to speak. Any holding with time_stop.due = true must get an explicit hold/trim/exit with a reason.
- Your SELL orders are sent as MARKETABLE limits (priced below the market so they FILL). Your limit_price is still checked against the ±${ARENA_RULES.price_band * 100}% band as a sanity check on your price anchoring, but do not try to squeeze a better exit price by resting above the market — a sell that does not fill is not a sell.
- You are NOT being asked to trade more often. Holding everything and placing zero orders is a fully valid outcome, every single day. What you are asked for is to DECIDE explicitly and to REMEMBER what you said you would do.

RESEARCH BEFORE YOU DECIDE (tools):
You have tools. Use them, or do not — an empty research budget is not a failure, and a run where you looked at the board and already knew what to do is a legitimate run. What is NOT legitimate is deciding on a name you have no data for.
- \`screener\` answers "which names look like X" over today's universe. \`ficha\` is the expensive one: the full sheet for ONE name — use it on names you are seriously considering, not to browse. \`noticias\` gets headlines for a ticker or a topic. \`sector\` opens one sector.
- YOUR BUDGET IS ENFORCED BY THE HARNESS, not by your own restraint. When it runs out, the next call comes back saying so and returns no data. Spend it on the decisions that are actually close; a name you were never going to buy does not deserve a \`ficha\`.
- Tool results are TRUNCATED to fit a token budget, and a truncated result SAYS SO inside itself. A list that was cut is not a list that ended: never conclude "there are no names that qualify" from a result that says it was truncated.
- Your research sequence is published. Someone will read what you chose to look at, in order. That is not a reason to perform — it is a reason to look at what actually matters to the decision.
- When you are done researching, answer with the JSON. Do not narrate your tool use in \`plan\`; the sequence is already recorded.

MANDATORY, EVERY RUN:
1. positions_review — ONE entry per position currently in the portfolio: stance "hold", "trim" or "exit", plus a reason that cites the numbers you were given (days in position, P&L since entry, distance from peak). A position you do not mention counts as a position you forgot.
2. commitment_updates — ONE entry per open commitment listed in the context, using its exact id: "cumplido" (you did it, or the condition resolved), "vigente" (still waiting — say what you are still waiting for), or "cancelado" (you are dropping it — say why).
3. commitments — anything you promise in this plan ("I will revisit X after earnings", "holding cash for Y") goes here as a structured item so it comes back to you next run. If your plan makes a promise and this array is empty, the promise does not exist.

HOW TO READ WHAT YOU ARE GIVEN (pre-computed for you — quote these as given, do not re-derive or rescale them):
${STABLE_BLOCKS.equity}
${STABLE_BLOCKS.position_history_dive}
${STABLE_BLOCKS.notes}
${STABLE_BLOCKS.ratio_sanity}
${STABLE_BLOCKS.earnings_out}
${STABLE_BLOCKS.news_recency}
${STABLE_BLOCKS.earnings_timing_dive}
${STABLE_BLOCKS.figures}
PRICING RULE — READ CAREFULLY: for each candidate, "last_close" is the reference price and "limit_range" {low, high} is the ONLY band the risk guard accepts (±${ARENA_RULES.price_band * 100}% of last_close). Your limit_price MUST fall inside [limit_range.low, limit_range.high] or the order is auto-discarded. Do NOT anchor your limit on 52-week highs/lows, analyst targets, or any other figure — only on last_close. If last_close is null you have no valid reference for that ticker: do not place an order for it.

OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no prose outside JSON):
{"plan": "<your portfolio thesis for today, 2-6 sentences>", "positions_review": [{"symbol": "TICKER", "stance": "hold"|"trim"|"exit", "reason": "<1-2 sentences citing the numbers given>"}], "commitment_updates": [{"id": "<the exact id given>", "status": "cumplido"|"vigente"|"cancelado", "note": "<1 sentence>"}], "commitments": [{"symbol": "TICKER or null", "text": "<what you are committing to>", "due": "YYYY-MM-DD or null"}], "actions": [{"symbol": "TICKER", "side": "buy"|"sell", "notional": <USD number>, "limit_price": <number>, "conviction": <1-5>, "reasoning": "<1-2 sentences, specific>"}]}
An empty actions array is a valid, often correct decision — but plan must then explain why you are holding. positions_review and commitment_updates are NOT optional when there are positions or open commitments.`;
}

// ── B10 · EL PROMPT DEL CONTRATO NUEVO (portafolio objetivo) ─────────
// MISMO prompt, mismos parámetros por familia, mismo tablero y mismas
// herramientas para los siete. Lo único que varía es la `persona` (decisión #6
// de la liga) — y `claude`/`control` la comparten byte a byte, que es lo que
// hace válido al control.
//
// Reusa STABLE_BLOCKS: la mitad de este prompt es el MISMO texto que el del
// contrato viejo, y eso es deliberado. Lo que cambia es el MANDATO y el FORMATO
// DE SALIDA; cómo leer el tablero y los campos no tiene por qué cambiar, y
// duplicar esos bloques sería crear dos versiones de la misma explicación que
// después divergen.
//
// LA OMISIÓN SE DICE TRES VECES, en tres lugares distintos del prompt. No es
// redundancia por nerviosismo: es la regla cuya incomprensión liquida un libro
// entero en la primera corrida, y el único costo de repetirla son ~40 tokens
// del lado cacheado.
export function buildTargetSystemPrompt(persona = 'Claude PM', rails = RAILS) {
  const pct = (x) => (x * 100).toFixed(0);
  return `You are "${persona}", the portfolio manager of QuantDesk Arena — a PUBLIC experiment: an LLM managing a real Alpaca PAPER account (simulated money, real market quotes). Your reasoning is published verbatim next to every position.

YOUR MANDATE: maximize the equity of this book over FOUR WEEKS. Not today, not this quarter — four weeks. You may go long and short.

WHAT YOU RETURN IS A BOOK, NOT ORDERS. You do not place trades. You state the portfolio you want to hold, as weights, and a deterministic engine works out the difference against what you actually hold and executes it.

⚠️ WHAT YOU DO NOT MENTION, YOU SELL. A ticker absent from your \`pesos\` is a ticker you are closing. There is no "leave it as it is" — every position you want to keep must be restated, every run, with its weight. This is the single most important rule of the format: read it twice.

RAILS (a deterministic layer enforces them AFTER you — a target that violates ANY of them is discarded ENTIRELY, not scaled down, and the run places nothing):
- Per name: LONG at most ${pct(rails.max_long_weight)}% of equity, SHORT at most ${pct(rails.max_short_weight)}%. The short cap is half the long cap on purpose — see below.
- Gross exposure (the sum of absolute weights) at most ${pct(rails.max_gross)}%: no leverage. Net exposure between ${pct(rails.min_net)}% and ${pct(rails.max_net)}%.
- Total short at most ${pct(rails.max_short_gross)}%. Per sector at most ${pct(rails.max_sector)}% (names with no sector data share one "UNKNOWN" bucket with the same cap).
- Minimum ${pct(rails.min_position)}% per position: anything smaller does not move the book and only adds execution noise. There is NO cap on the NUMBER of positions.
- Shorts only on names confirmed shortable AND easy-to-borrow, priced at or above $${rails.min_short_price}. If that confirmation is missing the short is rejected — absence of data is not permission.
- Cash is whatever is left: 0-100%. A book that is 100% cash is a legitimate decision.

WHY THE SHORT CAP IS HALF: a long that goes wrong SHRINKS — a 25% long that falls 50% becomes ~14% of the book and the rail holds itself. A short that goes wrong GROWS: a 25% short whose underlying rises 50% becomes ~37% and keeps growing, breaching its own rail with nobody doing anything, and the loss has no theoretical ceiling. If a short of yours grows past its rail, the engine TRIMS it back without asking you, and you will see it done in your next prompt.

HOW THE ENGINE EXECUTES YOUR BOOK (so your plan is consistent with what actually happens):
- A move smaller than ${pct(rails.no_trade_band)} percentage points is NOT traded: that is price drift, not a decision. A full exit is always executed, however small.
- Order of execution: sells, then covers, then buys, then new shorts. Your open orders that contradict today's book are cancelled.
- Deterministic stops run around you: a catastrophic stop per position, a trailing stop that by construction can only exit at a profit, and a book-level drawdown breaker. They can close a position without you; you will see it as a fact in your next prompt.

HOW TO READ WHAT YOU ARE GIVEN (pre-computed for you — quote these as given, do not re-derive or rescale them):
${STABLE_BLOCKS.board}
${STABLE_BLOCKS.equity}
${STABLE_BLOCKS.position_history_dive}
${STABLE_BLOCKS.notes}
${STABLE_BLOCKS.ratio_sanity}
${STABLE_BLOCKS.news_recency}
${STABLE_BLOCKS.figures}

RESEARCH BEFORE YOU DECIDE: you have tools. Not researching is a legitimate run; deciding on a name you have no data for is not. Your budget is enforced by the harness, not by your restraint — when it runs out the next call returns no data and says so. Truncated results SAY they were truncated: never read a cut list as a list that ended. Your research sequence is published.

OUTPUT: respond with ONE JSON object and NOTHING else (no markdown fences, no prose outside JSON):
{"plan": "<your thesis for the book as a whole, 2-6 sentences>", "pesos": {"TICKER": <signed percent, negative = short>}, "cash": <percent>, "tesis": {"TICKER": "<1-2 sentences: why this name, why this size>"}, "positions_review": [{"symbol": "TICKER", "stance": "hold"|"trim"|"exit", "reason": "<cites the numbers you were given>"}], "commitment_updates": [{"id": "<exact id given>", "status": "cumplido"|"vigente"|"cancelado", "note": "<1 sentence>"}], "commitments": [{"symbol": "TICKER or null", "text": "<what you commit to>", "due": "YYYY-MM-DD or null"}]}

⚠️ \`pesos\` MUST BE PRESENT even when empty. \`{}\` means "liquidate everything, go to cash" — a real and sometimes correct decision. Omitting the field entirely is not that; it is a malformed answer and the run is aborted with nothing placed.
⚠️ Once more, because it decides your whole book: ANY TICKER YOU HOLD AND DO NOT LIST IN \`pesos\` WILL BE SOLD. Restate everything you want to keep.
Trading more is not the objective. Stating explicitly what you want to hold, and why, is.`;
}

// Universo por TIPO de instrumento para el buffet: reusa los MISMOS sets del
// guard (equity común/ADR/REIT dentro; warrants/units/rights/preferentes y
// fondos ETP/CEF/OEF fuera). type vacío/desconocido → se permite (mismo
// fail-open del guard, que re-filtra downstream de forma autoritativa). El
// sufijo del ticker (WARRANT_LIKE) no atrapa a WLDSW/IPCXU —sin separador—,
// pero el `type` del symbol map sí los marca.
const isNonEquityBuffetType = (t) => !!t && (NON_EQUITY_TYPES.has(t) || EXCLUDED_SECURITY_TYPES.has(t));

// ── contexto: recortes compactos del buffet (tokens de Haiku, no de Opus) ──
function trimMovers(data, symbolTypes) {
  if (!data || data.universe !== 'market') return null;
  // Filtra ANTES de recortar: (a) micro-caps <$5 (curación del buffet, más
  // estricta que el piso de $1 del guard: el top_losers de AV está dominado
  // por small caps a -30/-40% que sepultaban a las mega-caps), (b) ETFs
  // apalancados/inversos (misma detección que el guard, aquí solo por ticker
  // porque el feed no trae nombres) y (c) no-equity por `type` del symbol map
  // (warrants/units/rights que el feed de AV cuela: WLDSW, IPCXU…). El guard
  // vuelve a filtrar (b)/(c) autoritativamente; esto es best-effort para no
  // gastarle un slot del buffet al PM con algo que no puede comprar.
  const pick = (l, n) => (l || [])
    .filter((m) => m && typeof m.price === 'number' && m.price >= 5)
    .filter((m) => !isLeveragedInverseETF(m.symbol))
    .filter((m) => !isNonEquityBuffetType(symbolTypes && symbolTypes[String(m.symbol || '').trim().toUpperCase()]))
    .slice(0, n)
    .map((m) => ({ symbol: m.symbol, price: m.price, changePct: m.changePct }));
  // `actives` a top-8 (gainers/losers a 5, que el ranking por % ya prioriza):
  // es donde las mega-caps con movimiento fuerte quedaban fuera del top-5 al
  // ser desplazadas por leveraged ETFs y small caps (TSLA -14.5%, 24-jul).
  return { gainers: pick(data.gainers, 5), losers: pick(data.losers, 5), actives: pick(data.actives, 8) };
}
// ── T2 #2: los RECIÉN-REPORTADOS se quedan 2 sesiones en el buffet ───
// La T1 solo miraba hacia adelante (`/api/earnings?from=hoy`): el día que NVDA
// reportaba, NVDA salía del buffet. El PM había escrito "espero el reporte para
// decidir", el reporte llegaba… y el nombre ya no estaba en su contexto. La
// tesis quedaba abierta para siempre y la prosa del día siguiente ni lo
// mencionaba. Ahora la ventana del calendario se abre hacia ATRÁS y lo
// reportado permanece RECENT_REPORT_SESSIONS sesiones más, con la cifra al lado.
export const RECENT_REPORT_SESSIONS = 2;

// Sesiones de mercado (L-V) transcurridas entre `dateStr` y hoy. Mismo día = 0,
// siguiente día hábil = 1. APROXIMACIÓN DELIBERADA: no descuenta festivos —
// errar por ese lado solo mantiene un nombre un día MÁS en el buffet, que es la
// dirección segura para una regla cuyo propósito es no olvidar. Negativo = la
// fecha es futura. null si no parsea.
export function sessionsAgo(dateStr, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const from = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (to === from) return 0;
  const sign = to > from ? 1 : -1;
  let count = 0;
  for (let t = Math.min(from, to) + 86400000; t <= Math.max(from, to); t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return sign * count;
}

// ¿Este reporte YA ocurrió a la hora de esta corrida? Importa porque la corrida
// matutina (14:50 UTC) y la de decide (22:40 UTC) ven el mismo calendario en
// momentos distintos del día: un AMC de HOY ya pasó a las 22:40, pero NO a las
// 14:50. La hora de corte (21 UTC) cubre el cierre de NYSE en verano e invierno.
export function hasReported(e, now = new Date()) {
  const d = String((e && e.date) || '').slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (!d) return false;
  if (d < today) return true;
  if (d > today) return false;
  return String((e && e.time) || '').toUpperCase() === 'BMO' || now.getUTCHours() >= 21;
}

// Sorpresa de EPS ya calculada (%). La casa NO delega aritmética al modelo: si
// el PM va a decir "reportó 12% arriba del estimado", el 12% sale de aquí.
// null si falta un lado o el estimado es 0 (una división que no significa nada).
function epsSurprisePct(est, actual) {
  const e = Number(est), a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a) || e === 0) return null;
  return +(((a - e) / Math.abs(e)) * 100).toFixed(1);
}

function trimEarnings(data, now = new Date()) {
  // Relevancia, NO orden alfabético del feed. El calendario de Finnhub llega
  // ordenado por fecha, pero DENTRO de cada día viene alfabético — así que un
  // slice(0,12) crudo se llenaba de nombres del principio del abecedario, casi
  // siempre micro-caps ilíquidas (AAM sin nombre, AAUAF minera OTC…) y
  // sepultaba a las que la audiencia realmente sigue. Rankeamos por cap con la
  // señal disponible, sin cap real en el feed: (0) mega-caps del MISMO set
  // curado que el calendario público (?mega=1), (1) el resto que al menos
  // resuelve nombre en el symbol map US (equity real), (2) las que ni nombre
  // tienen (company null → OTC/no-US). Mismos 12 slots; el orden por fecha se
  // preserva dentro de cada tier (sort estable por índice de llegada). No es un
  // gate duro: si un día no hay 12 mega/named, el tier 2 rellena — el canal
  // nunca queda vacío por esto (p.ej. si el symbol map estuviera caído).
  //
  // `when` — DÍAS RELATIVOS YA CALCULADOS ("in 2 days (Wed Aug 26, AMC)"). El
  // feed solo trae fecha absoluta, y con eso el PM narró unos earnings a dos
  // días como "post-market today" (NVDA 8/26 escrito el 8/24) mientras fechaba
  // bien, en el mismo párrafo, las noticias que sí traían antigüedad. La
  // aritmética de calendario no se delega al modelo: sale de acá resuelta. La
  // fecha absoluta se conserva al lado (auditoría y el ancla dura del label).
  const rank = (e) => (MEGA_CAPS.has(e.ticker) ? 0 : (e.company ? 1 : 2));
  const byRelevance = ((data && data.earnings) || [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e);

  const base = (e) => ({
    ticker: e.ticker,
    company: e.company,
    date: e.date,
    time: e.time,
    when: relativeDayLabel(e.date, now, e.time && e.time !== 'TBD' ? e.time : null),
  });

  // Dos listas con SLOTS PROPIOS: si los reportados compitieran por los 12
  // slots de la agenda, una semana cargada volvería a expulsarlos — justo el
  // olvido que la regla T2 #2 existe para evitar.
  const upcoming = [];
  const reported = [];
  for (const e of byRelevance) {
    if (!hasReported(e, now)) {
      if (upcoming.length < 12) upcoming.push(base(e));
      continue;
    }
    const ago = sessionsAgo(e.date, now);
    if (ago == null || ago > RECENT_REPORT_SESSIONS) continue; // fuera de la ventana de memoria
    if (reported.length >= 8) continue;
    reported.push({
      ...base(e),
      sessions_since_report: ago,
      eps_est: e.eps_est ?? null,
      eps_actual: e.eps_actual ?? null,
      eps_surprise_pct: epsSurprisePct(e.eps_est, e.eps_actual),
      revenue_est: e.revenue_est ?? null,
      revenue_actual: e.revenue_actual ?? null,
    });
  }
  return { upcoming, reported };
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
function buildChannels({ movers, earnings, reported, insiders, screener }) {
  const map = {};
  const add = (sym, channel) => {
    const s = String(sym || '').trim().toUpperCase();
    if (!s) return null;
    if (!map[s]) map[s] = { channels: [], screens: [], qualifiers: {} };
    if (!map[s].channels.includes(channel)) map[s].channels.push(channel);
    return map[s];
  };
  if (movers) for (const list of [movers.gainers, movers.losers, movers.actives]) for (const m of (list || [])) add(m.symbol, 'movers');
  for (const e of (earnings || [])) {
    const entry = add(e.ticker, 'earnings');
    // El CUÁNDO viaja pegado al canal: es el único puente por el que la fecha
    // del reporte llega a la fase DIVE (que recibe candidatos + deep dive, no
    // el buffet). Sin esto el PM decidía "guardar pólvora para la dislocación
    // post-earnings" sabiendo que el ticker salió del canal earnings pero sin
    // el día — y lo rellenaba de memoria, a veces con "today".
    if (entry && !entry.earnings) entry.earnings = { date: e.date, time: e.time, when: e.when };
  }
  // T2 #2: los recién-reportados son canal `earnings` igual que la agenda, pero
  // su meta dice que el número YA SALIÓ (`reported:true` + sesiones desde el
  // reporte). Es el puente por el que el DIVE —que ve candidatos, no el buffet—
  // se entera de que el catalizador que el PM estaba esperando ya ocurrió.
  for (const e of (reported || [])) {
    const entry = add(e.ticker, 'earnings');
    if (entry) {
      entry.earnings = {
        date: e.date, time: e.time, when: e.when, reported: true,
        sessions_since_report: e.sessions_since_report,
        ...(e.eps_est != null || e.eps_actual != null
          ? { eps_est: e.eps_est, eps_actual: e.eps_actual, eps_surprise_pct: e.eps_surprise_pct }
          : {}),
      };
    }
  }
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

// ── PRESUPUESTO POR CANAL DEL BUFFET ─────────────────────────────────
// Los 12s planos servían cuando las tres fuentes eran rápidas. `insiders` no
// lo es, y no por culpa nuestra: /api/stock-tracker?cat=insider baja el feed
// Atom de Form 4 de SEC EDGAR y después inspecciona hasta SCAN_CAP=60 XML
// sueltos de sec.gov/Archives. Con la caché EN MEMORIA fría —o sea, en cada
// lambda nueva— son ~61 requests a un servidor que throttlea a propósito, y
// 12s no alcanzan ni de casualidad.
//
// Los canales se piden EN PARALELO (Promise.all más abajo), así que subirle el
// techo a insiders cuesta wall-clock solo si es el más lento: el costo del
// buffet es max(canales), no la suma.
//
// Esto NO es la cura, es el torniquete. La cura es precomputar insiders en su
// propio cron y leerlo de Neon, como ya hace el canal screener (readScreenerRows,
// cero llamadas a terceros en la corrida). Mientras tanto, 30s hacen que un
// EDGAR lento deje de costar un canal entero del buffet.
const BUFFET_TIMEOUT_MS = {
  insiders: Number(process.env.ARENA_BUFFET_TIMEOUT_INSIDERS_MS) || 30000,
};

// Canales que se piden UNA VEZ POR DÍA y después se leen de Neon. `insiders` es
// el caso que lo motivó (ver el bloque de arriba y _lib/arena-buffet-cache.js):
// su contenido es un hecho del día, así que pedirlo doce veces es pagar doce
// veces por el mismo dato — y doce oportunidades de que EDGAR se caiga.
//
// `movers` y `earnings` NO entran: los dos cambian dentro del día y cachearlos
// por día le daría al PM de la tarde el mercado de la mañana. La caché existe
// para los canales cuyo contenido no se mueve, no para todos los lentos.
// BUFFET v1.5 — el canal de OJOS PROPIOS. Se puede apagar con
// ARENA_BUFFET_V15=0 sin deploy: es un canal nuevo sobre una API de Alpaca que
// todavía no corrió un día entero en producción, y un canal nuevo que se cae
// no puede costar el buffet entero. Prendido por default (entra como
// rules_changed); su caída ya está cubierta — sale en `unavailable` con su
// error, igual que cualquier otro canal.
const BUFFET_V15_ENABLED = process.env.ARENA_BUFFET_V15 !== '0';

// B2 · EL TABLERO. Freno de mano propio, separado del de v1.5: son dos piezas
// distintas (una elige candidatos, la otra muestra el mercado) y tienen que
// poder apagarse por separado. Prendido por default.
const BOARD_ENABLED = process.env.ARENA_BOARD !== '0';

// B3 · LAS HERRAMIENTAS. Freno de mano propio: es el cambio más grande del
// contrato con el modelo (deja de ser una llamada y pasa a ser una
// conversación), y tiene que poder apagarse sin deploy si un proveedor se porta
// distinto de lo esperado en producción. Apagado vuelve al DIVE de una sola
// llamada, que es el camino que lleva meses corriendo.
const TOOLS_ENABLED = process.env.ARENA_TOOLS !== '0';

const DAY_CACHED_CHANNELS = new Set(
  String(process.env.ARENA_BUFFET_DAY_CACHE || 'insiders').split(',').map((x) => x.trim()).filter(Boolean),
);
const BUFFET_TIMEOUT_DEFAULT_MS = Number(process.env.ARENA_BUFFET_TIMEOUT_MS) || 12000;
const buffetTimeout = (canal) => BUFFET_TIMEOUT_MS[canal] || BUFFET_TIMEOUT_DEFAULT_MS;

async function fetchJson(url, timeoutMs = BUFFET_TIMEOUT_DEFAULT_MS) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  // T2 #2: la ventana del calendario se abre 5 días hacia ATRÁS (cubre un fin de
  // semana largo) para traer a los que YA reportaron. El recorte fino a
  // RECENT_REPORT_SESSIONS sesiones lo hace trimEarnings, no la URL.
  const weekStart = new Date(now.getTime() - 5 * 86400000);
  const targets = {
    movers: baseUrl + '/api/movers?universe=market',
    earnings: baseUrl + `/api/earnings?from=${iso(weekStart)}&to=${iso(weekEnd)}`,
    insiders: baseUrl + '/api/stock-tracker?cat=insider',
  };
  const out = {};
  // Procedencia por canal: 'cache' (entrada de hoy en Neon), 'fetch' (se pidió
  // de verdad) o 'none' (se cayó). Viaja al journal, no al prompt: el PM no
  // necesita saber de dónde salió el dato, pero el post-mortem sí — un canal
  // servido de caché y uno recién traído no se leen igual cuando algo falla.
  const channel_source = {};
  await Promise.all(Object.entries(targets).map(async ([k, url]) => {
    const techo = buffetTimeout(k);
    const pedir = () => fetchJson(url, techo);

    // CANALES CACHEADOS POR DÍA (hoy: insiders). Los Form 4 son un hecho del
    // DÍA: el mismo contenido para la corrida de las 14:00 y la de las 20:00.
    // Pedirlo una vez y leerlo de Neon el resto del día convierte ~61 requests
    // a SEC EDGAR por lambda en una lectura de tabla. Ver _lib/arena-buffet-cache.js.
    if (DAY_CACHED_CHANNELS.has(k)) {
      const r = await cachedDayFetch(k, pedir, { now });
      out[k] = r.data;
      channel_source[k] = { source: r.source, fetched_at: r.fetched_at };
      if (r.error) {
        out[k + '_error'] = r.error.includes('timeout') || /Timeout/i.test(r.error)
          ? `timeout (${Math.round(techo / 1000)}s) — SEC EDGAR: feed Atom + hasta 60 XML de Form 4 con caché fría. No había entrada de HOY en la caché por día.`
          : r.error;
      }
      return;
    }

    try { out[k] = await pedir(); channel_source[k] = { source: 'fetch' }; }
    catch (err) {
      out[k] = null;
      channel_source[k] = { source: 'none' };
      // El error REAL del fetch (status HTTP o timeout), con el techo que se
      // aplicó — un "timeout (12s)" fijo mentía apenas los techos dejaron de
      // ser iguales, y mandaba a buscar el problema al lugar equivocado.
      out[k + '_error'] = err && err.name === 'TimeoutError'
        ? `timeout (${Math.round(techo / 1000)}s)`
        : String((err && err.message) || err);
    }
  }));
  const fetch_errors = {};
  for (const k of Object.keys(targets)) if (out[k + '_error']) fetch_errors[k] = out[k + '_error'];

  // Tipo de instrumento por símbolo — comparte fetch/cache con el guard (0
  // requests con cache caliente; getSymbolTypes nunca lanza, cae a null si el
  // symbol map no cargó todavía). Alimenta el filtro de universo del buffet de
  // movers: fuera warrants/units/rights que el sufijo del ticker no atrapa.
  const symbolTypes = await getSymbolTypes(process.env.FINNHUB_API_KEY);

  const movers = trimMovers(out.movers, symbolTypes);
  const { upcoming: earnings_this_week, reported: recently_reported } = trimEarnings(out.earnings, now);
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

  // ── BUFFET v1.5: el UNIVERSO DEL DÍA (screener de Alpaca) ────────
  // Tres preguntas que /api/movers no contestaba: qué se movió (hasta 50 por
  // lado, contra los 8 de antes), qué se NEGOCIÓ (most-actives: un nombre puede
  // mover 8% sin volumen, o negociar $2.000M sin moverse) y qué rompió su rango
  // de 52 semanas. Trae su propio filtro de admisión —el MISMO módulo— y
  // deduplica con banderas, así que un nombre que aparece en tres canales es
  // una entrada con tres banderas y no tres entradas.
  //
  // Va APARTE de `movers` en vez de reemplazarlo: son fuentes distintas y el
  // post-mortem tiene que poder comparar qué aportó cada una antes de que
  // alguien decida apagar la vieja.
  //
  // B1: el UNIVERSO (~600) se LEE, no se construye acá. Lo arma el cron
  // pre-apertura (/api/arena-universe) porque ~600 nombres × precio, volumen y
  // market cap no cabe dentro de una corrida. Si el cron no corrió, se usa el de
  // AYER **y se dice** — no se reconstruye a medias, que daría un universo mitad
  // fresco y mitad viejo sin manera de saber cuál nombre es cuál.
  //
  // Y NUNCA BLOQUEA (D1): sin universo guardado, el buffet v1.5 sigue armándose
  // con los movers del día como siempre. Un universo más chico es un sesgo
  // declarado; un tablero que no sale es una corrida perdida.
  let universeBase = null;
  try { universeBase = await loadUniverse({ now }); }
  catch (e) { fetch_errors.universe_load = String((e && e.message) || e); }

  let universe = null;
  if (BUFFET_V15_ENABLED) {
    try {
      universe = await buildBuffetV15({ creds: alpacaCreds(), finnhubKey: process.env.FINNHUB_API_KEY, now });
      for (const u of universe.unavailable || []) unavailable.push('universe:' + u);
      for (const [k, v] of Object.entries(universe.errors || {})) fetch_errors['universe:' + k] = v;
      channel_source.universe = { source: 'fetch', built_at: universe.built_at };
    } catch (e) {
      // Un canal NUEVO no puede tumbar el buffet que ya funcionaba.
      fetch_errors.universe = String((e && e.message) || e);
      unavailable.push('universe');
      channel_source.universe = { source: 'none' };
    }
  }

  // ── FILTRO DE ADMISIÓN (A4c) ─────────────────────────────────────
  // Se aplica DESPUÉS de armar cada canal y ANTES de construir el índice de
  // atribución, sobre TODOS los canales a la vez. Antes cada canal tenía su
  // propio criterio (movers ≥$5, insiders y screener ninguno) y el más flojo
  // decidía qué veía el PM — así entró DDDX, un OTC de $0.01, por el canal
  // insider. Ver el encabezado de _lib/arena-admission.js.
  const moversKnown = {};
  for (const list of [movers && movers.gainers, movers && movers.losers, movers && movers.actives]) {
    for (const m of (list || [])) {
      // Los movers ya traen precio del endpoint; el volumen en dólares del día
      // NO sirve como criterio (es de una sola sesión y encima la viva), así
      // que solo se reusa el precio y el promedio de 20 se pide igual.
      if (m && m.symbol && Number.isFinite(m.price)) moversKnown[String(m.symbol).toUpperCase()] = { price: m.price };
    }
  }
  const candidateSyms = [
    ...Object.keys(moversKnown),
    ...(notable_insider_buys || []).map((i) => i && i.ticker),
    ...['value', 'momentum'].flatMap((n) => ((screener || {})[n] || []).map((c) => c && c.symbol)),
  ].filter(Boolean);

  const admissionRejected = [];
  let admissionData = {};
  try {
    admissionData = await resolveAdmission(candidateSyms, { finnhubKey: process.env.FINNHUB_API_KEY, now });
  } catch (e) {
    // El filtro no puede tumbar la corrida. Si no se pudo resolver NADA, se
    // journalea y los canales pasan como antes — degradar a "sin filtro" es
    // peor que degradar a "sin buffet", pero mentir sobre ello sería lo peor.
    fetch_errors.admission = String((e && e.message) || e);
  }
  const filtered = Object.keys(admissionData).length > 0;
  if (filtered) {
    for (const list of ['gainers', 'losers', 'actives']) {
      if (!movers || !movers[list]) continue;
      const { admitted, rejected } = partitionByAdmission(movers[list], admissionData, (m) => m.symbol);
      movers[list] = admitted;
      admissionRejected.push(...rejected.map((r) => ({ ...r, channel: 'movers' })));
    }
    {
      const { admitted, rejected } = partitionByAdmission(notable_insider_buys, admissionData, (i) => i.ticker);
      notable_insider_buys.length = 0;
      notable_insider_buys.push(...admitted);
      admissionRejected.push(...rejected.map((r) => ({ ...r, channel: 'insider' })));
    }
    for (const name of ['value', 'momentum']) {
      if (!screener || !screener[name]) continue;
      const { admitted, rejected } = partitionByAdmission(screener[name], admissionData, (c) => c.symbol);
      screener[name] = admitted;
      admissionRejected.push(...rejected.map((r) => ({ ...r, channel: 'screener:' + name })));
    }
  }

  // ── B2 · EL TABLERO ───────────────────────────────────────────────
  // Se arma DESPUÉS del universo y de los earnings porque los usa a los dos, y
  // ANTES del índice de atribución porque sus nombres también cuentan como
  // procedencia. Solo agrega lo INTRADÍA: el universo y el rango de 52 semanas
  // ya vienen precomputados del cron pre-apertura.
  let board = null;
  let boardRender = null;
  if (BOARD_ENABLED) {
    try {
      board = await buildBoard({
        universe: universeBase, creds: alpacaCreds(), now,
        earnings: earnings_this_week,
      });
      boardRender = renderBoard(board, { budget: BOARD_TOKEN_HARD_CAP });
      for (const [k, v] of Object.entries(board.errors || {})) fetch_errors['board:' + k] = v;
    } catch (e) {
      // El tablero es la pieza más nueva y la más cara: su caída NO puede
      // costar la corrida. Sin él, el prompt vuelve a los canales de siempre.
      fetch_errors.board = String((e && e.message) || e);
      unavailable.push('board');
    }
  }

  const channelsByTicker = buildChannels({ movers, earnings: earnings_this_week, reported: recently_reported, insiders: notable_insider_buys, screener });
  // El universo v1.5 también entra al índice de atribución: sin esto, una
  // acción sobre un nombre que solo llegó por ese canal se journalearía con
  // `channels: []`, o sea como un pick sin anclar — y el post-mortem no podría
  // medir qué aportó el canal nuevo, que es la razón de tenerlo aparte.
  for (const c of (universe && universe.candidates) || []) {
    if (!c || !c.symbol) continue;
    if (!channelsByTicker[c.symbol]) channelsByTicker[c.symbol] = { channels: [], screens: [], qualifiers: {} };
    const entry = channelsByTicker[c.symbol];
    if (!entry.channels.includes('universe')) entry.channels.push('universe');
    entry.universe_flags = c.flags;
  }

  return {
    // B2 · EL TABLERO, ya renderizado. Va como TEXTO y no como objeto porque
    // el renderizador es quien respeta el presupuesto de tokens: serializar el
    // objeto acá lo saltaría y el prefijo cacheado crecería sin control.
    board: boardRender ? { text: boardRender.text, tokens_est: boardRender.tokens_est } : null,
    // Los OBJETOS crudos del tablero y del universo. NO viajan al prompt (no
    // están en SHARED_BUFFET_FIELDS): son para las HERRAMIENTAS de B3, que
    // filtran sobre estructuras y no sobre el texto renderizado. Serializarlos
    // al prompt duplicaría el tablero y reventaría el presupuesto de tokens.
    board_raw: board,
    universe_raw: universeBase,
    // La medición completa del tablero, para el journal: qué sección creció,
    // qué se recortó y cuánto del universo quedó cubierto.
    board_meta: boardRender ? {
      ...boardRender, text: undefined,
      universe_size: board.universe_size, covered: board.covered, coverage_pct: board.coverage_pct,
      errors: board.errors,
    } : null,
    movers, earnings_this_week,
    // BUFFET v1.5 — SOLO la parte que ve el PM. El diagnóstico (unavailable,
    // errors, admission.rejected) se queda afuera a propósito: ya viaja en
    // `fetch_errors`/`unavailable` de arriba, y este bloque va al PREFIJO
    // CACHEADO, donde cada byte se paga una vez pero se manda siempre.
    universe: universe ? {
      version: universe.version,
      built_at: universe.built_at,
      near_52w_pct: universe.near_52w_pct,
      counts: universe.counts,
      candidates: universe.candidates,
      // B1: el universo estable sobre el que estas banderas son banderas. Va el
      // RESUMEN, no los ~600 símbolos: la lista entera son ~5K tokens en el
      // prefijo cacheado, y lo que el PM necesita saber es de qué tamaño y de
      // qué frescura es el universo del que salieron sus candidatos, no
      // recitarlo. Las herramientas de B3 son las que lo van a consultar entero.
      base: universeBase ? {
        source: universeBase.universe_source,
        built_at: universeBase.built_at,
        market_day: universeBase.loaded_from,
        is_today: universeBase.is_today,
        size: (universeBase.symbols || []).length,
        from_index: (universeBase.from_index || []).length,
        from_day: (universeBase.from_day || []).length,
        ...(universeBase.note ? { note: universeBase.note } : {}),
      } : null,
    } : null,
    // El diagnóstico completo del canal nuevo, para el journal.
    universe_diagnostics: universe ? {
      unavailable: universe.unavailable, errors: universe.errors, admission: universe.admission,
      last_updated: universe.last_updated,
      base: universeBase ? {
        universe_source: universeBase.universe_source, loaded_from: universeBase.loaded_from,
        is_today: universeBase.is_today, counts: universeBase.counts, indices: universeBase.indices,
        caveat: universeBase.caveat,
      } : { loaded: false, note: 'El cron pre-apertura no dejó universo. El buffet corre solo con los nombres del día.' },
    } : null,
    // Rechazados por admisión, con su motivo y su canal. NO viaja al prompt
    // (el PM no necesita la lista de lo que no vio) — se journalea, y es cómo
    // se audita si el filtro está tirando micro-caps (lo que debe) o nombres
    // buenos por falta de datos (lo que hay que arreglar).
    admission: {
      applied: filtered,
      rules: ADMISSION,
      rejected: admissionRejected,
      rejected_count: admissionRejected.length,
      data_unavailable: admissionRejected.filter((r) => r.reason === 'data_unavailable').length,
    },
    // T2 #2: los que YA reportaron, con su cifra y cuántas sesiones pasaron.
    recently_reported,
    notable_insider_buys,
    screener,
    screener_state,
    unavailable,
    // Diagnóstico: status HTTP/timeout real por endpoint caído. NO viaja al
    // prompt del LLM (buildSharedContext lo excluye) — se journalea.
    fetch_errors,
    // De dónde salió cada canal: caché del día, fetch nuevo, o caído. Tampoco
    // viaja al prompt.
    channel_source,
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

// La aclaración del equity, en las DOS fases (un PM que entiende mal cuánta
// pólvora tiene decide mal el tamaño en todas ellas).
// La aclaración del equity vive en STABLE_BLOCKS.equity y viaja en el SYSTEM de
// las dos fases (prefijo cacheado). Se deja el alias para los tests y los
// llamadores que la importen por nombre; el texto es UNO solo.
const EQUITY_NOTE = STABLE_BLOCKS.equity;

// Snapshot del libro compartido por ambas fases.
// `meta` (T2) le cuelga a cada posición su HISTORIA — días en posición, pico
// desde la entrada, distancia a ese pico, estado del trailing y del time stop —
// todo YA CALCULADO (_lib/arena-memory.js). Sin esto, el pronunciamiento
// obligatorio de la regla #9 sería el PM adivinando cuánto lleva con un nombre.
// Un dato que no se pudo derivar viaja como null y el prompt dice qué significa.
function portfolioSnapshot({ account, positions, openOrders, meta = {} }) {
  return {
    // FIX del journal del 14: el campo se llamaba `equity` a secas y el PM lo
    // leía como "lo que tengo invertido", sumándole el cash por su cuenta al
    // razonar sobre cuánta pólvora le quedaba. El nombre ahora carga la
    // semántica (mismo criterio que `pnl_since_entry_pct`): equity TOTAL, que
    // YA INCLUYE el cash. `cash` es la parte de ese total que está sin
    // invertir, no un extra que se suma.
    equity_total_incl_cash: Number(account.equity),
    cash_included_in_equity: Number(account.cash),
    positions: (positions || []).map((p) => {
      const m = meta[String(p.symbol || '').trim().toUpperCase()] || null;
      return {
        symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        // Pre-formateado + rotulado (ver fmtSignedPct): P&L desde entrada, no día.
        pnl_since_entry_pct: fmtSignedPct(p.unrealized_plpc),
        ...(m ? {
          opened_on: m.opened_at,
          days_in_position: m.days_in_position,
          peak_since_entry: m.peak_since_entry,
          from_peak_pct: m.from_peak_pct,
          trailing_stop: m.trailing
            ? (m.trailing.armed
              ? { armed: true, sells_below: m.trailing.level }
              : { armed: false, arms_above: m.trailing.arm_level })
            : null,
          time_stop: m.time_stop,
        } : {}),
      };
    }),
    open_orders: (openOrders || []).map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, limit_price: o.limit_price, status: o.status })),
  };
}

// ── user prompt del SCAN: portfolio + plan anterior + el buffet completo. ──
export function buildScanUserPrompt({ account, positions, openOrders, buffet, previous, meta = {} }) {
  // fetch_errors y channelsByTicker son diagnóstico/atribución interna (se
  // journalean); el LLM solo necesita `unavailable`. Se excluyen del prompt.
  // DEL LADO VOLÁTIL DEL CORTE, y solo esto: el libro de ESTE agente y su plan
  // anterior. Lo único del prompt que NO comparte con los otros seis.
  //
  // El buffet salió de acá y se fue al prefijo cacheado (buildSharedContext):
  // es el MISMO objeto para los siete agentes de la corrida —`getBuffet` lo
  // computa una vez y los demás reusan la promesa—, así que del lado volátil se
  // pagaba siete veces por el mismo texto. Y lo que explicaba cómo leerlo se
  // fue al system (STABLE_BLOCKS), que no cambia ni entre corridas ni entre días.
  return [
    'PORTFOLIO (Alpaca paper, live):', JSON.stringify(portfolioSnapshot({ account, positions, openOrders, meta })),
    '',
    'PREVIOUS PLAN (yours, from the last run — build on it or change course):',
    previous ? JSON.stringify(previous) : 'none — this is your first run.',
    '',
    `Pick up to ${MAX_CANDIDATES} tickers worth a deep-dive, or none. ONE JSON object, nothing else.`,
  ].join('\n');
}

// ── EL CONTEXTO COMPARTIDO: la parte del prompt que es de LA CORRIDA, no de
// un agente. Va en el prefijo cacheado, después del reglamento y antes del
// breakpoint. Es lo que hace que el prefijo cruce el mínimo cacheable del
// modelo y, de paso, que los siete agentes paguen UNA vez por el mismo buffet
// en lugar de siete.
//
// CANDADO: acá NO puede entrar nada que dependa del agente. Si entrara, cada
// agente tendría un prefijo distinto y la caché no serviría para nada — que es
// exactamente el estado del que venimos. Hay un test que lo verifica. ──
// ALLOWLIST, no denylist. Antes era `const {fetch_errors, ...resto} = buffet`,
// o sea: todo lo que alguien agregara al buffet viajaba al prompt por default y
// había que acordarse de excluirlo. Con el buffet ahora en el PREFIJO CACHEADO
// eso pasó de ser un desperdicio a ser un riesgo: un campo nuevo que dependa del
// agente rompe el prefijo compartido y la caché deja de servir, en silencio.
// Acá hay que ENUMERAR lo que entra, y un campo nuevo se queda afuera hasta que
// alguien decida lo contrario.
export const SHARED_BUFFET_FIELDS = [
  'universe',            // BUFFET v1.5: ~100 nombres del día con sus banderas
  'movers', 'earnings_this_week', 'recently_reported',
  'notable_insider_buys', 'screener', 'screener_state', 'unavailable',
];

export function buildSharedContext(buffet) {
  const partes = [];
  // B2 · EL TABLERO primero: es el encuadre del mercado y lo que el PM mira
  // antes que nada. Va como TEXTO tabular ya renderizado — el renderizador es
  // quien respeta el presupuesto de tokens, y volver a serializarlo acá lo
  // saltaría.
  if (buffet && buffet.board && buffet.board.text) {
    partes.push('== MARKET BOARD == (identical for every agent in this run; you decide what deserves attention)');
    partes.push(buffet.board.text);
    partes.push('');
  }
  // Los canales que el tablero NO cubre (insider buys, el screener
  // determinista, y los movers de la fuente vieja mientras se comparan las
  // dos). Siguen en JSON: son pocas filas con campos heterogéneos, donde la
  // tabla no compra nada.
  const buffetForLlm = {};
  for (const k of SHARED_BUFFET_FIELDS) if (buffet && buffet[k] !== undefined) buffetForLlm[k] = buffet[k];
  // OJO: el literal 'MARKET CONTEXT' es CONTRATO. `_lib/arena-audit.js` lo usa
  // como marcador para reconstruir el buffet de una corrida (jsonAfterMarker), y
  // las filas ya journaleadas lo tienen. Renombrarlo deja ciega la auditoría de
  // todo el histórico sin que nada falle a la vista.
  partes.push('MARKET CONTEXT (QuantDesk channels the board does not cover; identical for every agent in this run)');
  partes.push(JSON.stringify(buffetForLlm));
  return partes.join('\n');
}

// ── user prompt del DIVE: portfolio + tesis del scout + candidatos CON su
// deep-dive de Finnhub (fundamentales, recommendations, titulares) Y el ÚLTIMO
// CIERRE + rango de límite ya calculado. Antes el PM no tenía el cierre y
// adivinaba el límite (anclaba en el 52w-high, el único número tipo-precio de
// Finnhub) → el guard lo descartaba por banda. Ahora se le da EL MISMO cierre
// contra el que el guard valida, con el rango ±2% ya hecho (sin aritmética). ──
export function buildDiveUserPrompt({ account, positions, openOrders, previous, scanThesis, candidates, deepDive, closes, channels, priceBand = ARENA_RULES.price_band, meta = {}, commitments = [], event = null }) {
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
    // `earnings` viaja SOLO si el candidato salió del canal earnings de esta
    // corrida: trae la fecha del reporte con los días relativos ya calculados
    // (`when`), que es lo único que ancla la prosa del PM cuando decide
    // reservar cash "para la dislocación post-earnings".
    const meta = ch
      ? {
        channel: ch.channels,
        ...(ch.screens && ch.screens.length ? { screen: ch.screens, screener_qualifiers: ch.qualifiers } : {}),
        ...(ch.earnings ? { earnings: ch.earnings } : {}),
      }
      : {};
    return { ticker: t, last_close: close, limit_range, ...meta, ...((deepDive && deepDive[t]) || null) };
  });
  // T2 #1: los compromisos ABIERTOS, con su id, su fecha y su edad. Es la
  // memoria que el modelo no tiene: lo que prometió y todavía no cerró.
  const commitmentBlock = (commitments || []).length
    ? [
      'OPEN COMMITMENTS (things YOU said you would do, in your own previous runs — each carries the id you must use to answer):',
      JSON.stringify((commitments || []).map((c) => ({
        id: c.id, on: c.on, symbol: c.symbol, text: c.text,
        due: c.due, age_days: c.age_days, overdue: c.overdue,
        ...(c.reaffirmed ? { times_reaffirmed: c.reaffirmed } : {}),
      }))),
      'You MUST return a commitment_updates entry for EVERY id above. "vigente" is a legitimate answer when you are still waiting — but then say what for. Silence on a commitment is how a thesis dies unnoticed; it is recorded as non-compliance.',
      '',
    ]
    : ['OPEN COMMITMENTS: none open right now. Anything you promise in today\'s plan goes into `commitments` so it comes back to you.', ''];

  // Corrida por EVENTO: el encuadre cambia — no es la revisión diaria. Las tres
  // formas (matutina post-earnings, disparador del vigilante, revisión de piso)
  // difieren en lo que el PM PUEDE hacer, así que el encuadre lo dice explícito
  // en vez de dejar que descubra por descarte qué acciones se le van a tirar.
  const policy = eventPolicy(event);
  const scope = (candidates || []).join(', ');
  const eventBlock = event
    ? [
      event.type === 'watch_trigger'
        ? `TRIGGERED RUN — this is NOT your daily review. ${event.headline}`
        : event.type === 'watch_floor'
          ? `FLOOR REVIEW — the watchdog saw nothing that concerns you today, so this is your scheduled pronouncement on the book. ${event.headline || ''}`.trim()
          : `EVENT-DRIVEN MORNING RUN — this is NOT your daily review. ${event.headline}`,
      `SCOPE: this run is limited to ${scope}. Any action on a different ticker is discarded by the risk layer — you were given no fresh data for anything else, so do not spend actions there.`,
      policy.allow_buys
        ? 'You MAY open a new position here if the full rulebook supports it: this run exists because something moved, and a name you do not own that moved is a buy decision or it is nothing. The same position limits, cash floor and price band apply as always.'
        : 'NEW POSITIONS ARE NOT PART OF THIS RUN — any buy will be discarded by the risk layer, so do not spend actions on them. You are here to decide about what you already own.',
      policy.intraday
        ? 'THE MARKET IS OPEN AND YOUR ORDERS EXECUTE NOW, not at the next open: they are sent as marketable limits and are expected to fill within minutes. Price accordingly, and do not write a plan that assumes you get to see another close first.'
        : 'Your orders rest until the next open, as always.',
      'Doing nothing is a valid outcome — this run is not a quota to fill. What is not valid is being woken by something specific and saying nothing about it.',
      '',
    ]
    : [];

  return [
    ...eventBlock,
    'PORTFOLIO (Alpaca paper, live):', JSON.stringify(portfolioSnapshot({ account, positions, openOrders, meta })),
    '',
    ...commitmentBlock,
    'PREVIOUS PLAN (yours, from the last run — build on it or change course, but acknowledge it):',
    previous ? JSON.stringify(previous) : 'none — this is your first run.',
    '',
    'SCOUT THESIS (why these tickers were flagged for deep-dive):',
    scanThesis || '(none provided)',
    '',
    'DEEP-DIVE DATA (Finnhub; per candidate: last_close, limit_range, profile, fundamentals, analyst recommendation counts, recent news headlines, and — when the candidate came from the earnings calendar — its upcoming report).',
    ...(policy.intraday
      // Honestidad de etiqueta: intradía ese campo NO es un cierre, es el
      // último trade. El nombre del campo se conserva (es contrato con el
      // guard y con el journal), pero el PM tiene que saber qué está mirando.
      ? ['INTRADAY REFERENCE — the market is open, so "last_close" for each candidate is its LIVE last trade from Alpaca, not yesterday\'s close. It is the same number the risk guard checks your limit against, so anchor on it and nothing else.']
      : []),
    JSON.stringify(research),
    '',
    event
      ? 'Decide now, with the market open. Remember: ONE JSON object with plan, positions_review, commitment_updates, commitments and actions — nothing else.'
      : 'Decide your actions for the next market open. Remember: ONE JSON object with plan, positions_review (one entry per position), commitment_updates (one per open commitment id), commitments and actions — nothing else. Trading more is not the objective; deciding explicitly and remembering what you promised is.',
    ...(event ? ['Being woken more often is not permission to trade more often — it is an obligation to decide more often. The book is scored on results, not on activity.'] : []),
  ].join('\n');
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Serie diaria COMPLETA por símbolo (velas cerradas) — la MISMA fuente/valor
// contra el que el guard valida la banda ±2% (fetchDailySeries + completedSlice,
// plumbing Yahoo del simulador). De aquí salen DOS cosas con un solo request:
//   - el ÚLTIMO cierre: el que se le muestra al PM en el DIVE y el que valida el
//     guard (el mismo número, cero desfase);
//   - el PICO desde la entrada de cada holding (T2 #3), que es toda la serie
//     acotada por la fecha de apertura.
// La ventana es 1a (era 3m): el trailing necesita cubrir el tiempo que el libro
// lleva con el nombre, y el time stop vive a 45 días. Es el MISMO request a
// Yahoo, solo con más velas — no agrega llamadas ni latencia por símbolo.
// null si no hay serie (→ el guard descarta, fail closed).
async function completedSeries(symbol, now) {
  try {
    const raw = await fetchDailySeries(symbol, '1y');
    const series = raw ? completedSlice(raw, now) : null;
    if (series && series.closes.length) return series;
  } catch (e) { /* sin serie → fail closed */ }
  return null;
}

// ── Caches del RUN: dedupe de datos de MERCADO entre agentes ──────────
// Un símbolo se pide UNA vez por corrida aunque N agentes lo necesiten. Se
// cachea la PROMESA (in-flight), no el valor, así dos agentes concurrentes no
// disparan dos fetches del mismo símbolo. El cierre de Yahoo y el deep dive de
// Finnhub son idénticos para todos (datos de mercado); lo que difiere por agente
// es su libro y la decisión del LLM, no estos números.
function cachedSeries(caches, symbol, now) {
  if (!caches.series.has(symbol)) caches.series.set(symbol, completedSeries(symbol, now));
  return caches.series.get(symbol);
}
async function cachedClose(caches, symbol, now) {
  const series = await cachedSeries(caches, symbol, now);
  return series ? series.closes[series.closes.length - 1] : null;
}
async function cachedDeepDive(caches, symbols, finnhubKey, now) {
  const per = await Promise.all((symbols || []).map(async (sym) => {
    if (!caches.dive.has(sym)) {
      caches.dive.set(sym, fetchDeepDive([sym], finnhubKey, now).then((r) => ({ data: r.data[sym] ?? null, err: r.errors[sym] })));
    }
    const { data, err } = await caches.dive.get(sym);
    return { sym, data, err };
  }));
  const data = {};
  const errors = {};
  for (const { sym, data: d, err } of per) { data[sym] = d; if (err) errors[sym] = err; }
  return { data, errors };
}

// ── B9 · EL CONTADOR DE GASTO DE LA CORRIDA VIVA ─────────────────────
// Una corrida son DOS llamadas al LLM como mínimo (scan + dive) y hasta once
// con herramientas. Cada una se registra por separado, porque el escalón lo
// decide el ACUMULADO del día: un total que se escribe una vez al final llega
// tarde para frenar la corrida que lo disparó.
//
// EL ID LLEVA LA FASE, y no es cosmético: `arena_spend` tiene el id como clave
// primaria con `on conflict do nothing`. Sin el sufijo, el dive chocaría con el
// scan de la misma corrida y su gasto se descartaría EN SILENCIO — el breaker
// vería la mitad de lo que la liga gastó de verdad.
//
// LA PROCEDENCIA DEL NÚMERO VIAJA CON EL NÚMERO (`callCost`): lo que cobró el
// proveedor gana siempre; una estimación de catálogo se marca como estimación;
// y si no hay ninguna de las dos se guarda null, que `todaySpend` cuenta como
// `partial` para que el breaker sepa que está mirando un total incompleto en
// vez de creerse un total que no lo es.
// El cuerpo CRUDO de una llamada fallida, para el journal. Tres agentes
// abortaron con "HTTP 200" y el error decía el status y nada más: sin el cuerpo,
// diagnosticar eso es adivinar. Se acota a 800 caracteres en el origen.
function detalleFalloLlm(llm) {
  return {
    status: llm && llm.status, detail: (llm && llm.error_detail) || null,
    provider_error: (llm && llm.provider_error) || null,
    raw_body: (llm && llm.raw_body) || null,
    timed_out: !!(llm && llm.timedOut), stale: !!(llm && llm.stale),
    retry_failed: !!(llm && llm.retry_failed),
    // CUÁL reloj cortó, no solo que cortó. Una env var y el reparto del loop
    // se ven idénticos en `timed_out` y se arreglan en lugares opuestos.
    techo_ms: (llm && llm.techo_ms) ?? null,
    techo_origen: (llm && llm.techo_origen) || null,
  };
}

async function registrarGasto({ agent, runId, phase, llm, now, toolCalls = 0, loop = null }) {
  try {
    // Con herramientas el gasto de la fase es el de TODAS las vueltas, no el de
    // la última: el prompt entero viaja en cada una. `runToolLoop` devuelve el
    // acumulado precisamente para esto.
    const usage = (loop && loop.usage_total) || (llm && llm.data && llm.data.usage) || {};
    const llmCalls = (loop && loop.usage_total && loop.usage_total.calls) || 1;
    const reportado = loop && Number.isFinite(loop.cost_usd_total) ? loop.cost_usd_total
      : (llm && llm.data && Number.isFinite(llm.data.cost_usd) ? llm.data.cost_usd : null);
    // NO se va a buscar el catálogo de precios de OpenRouter acá. Se probó y se
    // sacó: `openRouterPrices` cachea en el proceso, pero los cinco agentes de
    // OpenRouter corren EN PARALELO y los cinco fallan la caché a la vez — cinco
    // requests simultáneas a openrouter.ai/api/v1/models por ronda, en el camino
    // que decide si la liga sigue gastando. El costo real ya viene en la misma
    // respuesta (`usage.cost`, que pedimos con `usage: {include: true}`); si el
    // proveedor no lo mandó, queda null y `todaySpend` marca el total como
    // `partial` — el breaker sabe que está mirando un total incompleto en vez de
    // creerse uno que no lo es. El costo estimado por catálogo vive en el smoke,
    // que corre solo y puede pagar esa llamada.
    const costo = callCost({
      anthropicUsd: agent.provider === 'anthropic' ? anthropicCostUsd(agent.model, usage) : null,
      providerUsd: reportado,
    });
    await recordRunSpend({
      agentId: agent.id, runId: `${runId}:${phase}`, phase, usd: costo.usd, usdSource: costo.source,
      tokens: {
        input: usage.input_tokens, output: usage.output_tokens,
        cache_read: usage.cache_read_input_tokens, cache_write: usage.cache_creation_input_tokens,
      },
      llmCalls, toolCalls, now,
    });
    return costo;
  } catch (e) { return null; }   // el contador JAMÁS frena una corrida
}

async function journalInsert(row) {
  // agent_id va AL FINAL ($14): mantiene el orden histórico de columnas
  // (id…context) para no romper lectores por posición. null → 'claude' (insignia).
  await sql(
    `insert into arena_journal (id, run_date, phase, status, prompt_version, prompt_hash, model, plan, llm_response, actions, account, error, context, agent_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.id, row.run_date, row.phase, row.status, row.prompt_version ?? null, row.prompt_hash ?? null,
     row.model ?? null, row.plan ?? null, row.llm_response ?? null,
     row.actions ? JSON.stringify(row.actions) : null,
     row.account ? JSON.stringify(row.account) : null, row.error ?? null,
     row.context ? JSON.stringify(row.context) : null,
     row.agent_id ?? FLAGSHIP_AGENT_ID]);
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
// ── EL JOURNAL DEL CONTRATO NUEVO ────────────────────────────────────
// `runAgenteObjetivo` escribe con la forma del journal de sombra (que tiene
// columnas propias: target, rebalance). Acá se traduce a `arena_journal`, que
// es el que leen /liga y el post-mortem: sin esta traducción, una corrida VIVA
// del contrato nuevo no aparecería en ningún tablero.
async function journalObjetivoVivo(row) {
  try {
    await sql(
      // ── `account` NO ESTABA, Y SE PERDÍA CADA RONDA ─────────────────
      // `arena_journal` tiene la columna desde siempre y el contrato viejo la
      // escribía; el objetivo no. Resultado: el equity, el cash y las
      // posiciones de una ronda VIVA quedaban sólo dentro del texto del
      // prompt. Es el estado de ese día: si no se guarda cuando pasa, mañana
      // no existe.
      `insert into arena_journal (id, run_date, phase, status, prompt_version, model, plan, llm_response, actions, context, agent_id, account)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (id) do nothing`,
      [row.id, row.run_date, row.phase || 'decide', row.status, row.prompt_version, row.model,
       row.plan || null, row.llm_response || null,
       // Las ÓRDENES como `actions`, que es lo que /liga ya sabe renderizar. El
       // portafolio objetivo y el rebalanceo van en `context`: son del contrato
       // nuevo y ninguna vista vieja los espera.
       JSON.stringify(((row.context && row.context.ejecucion && row.context.ejecucion.enviadas) || []).map((o) => ({
         symbol: o.symbol, side: o.side, qty: o.qty, limit_price: o.limit_price,
         result: o.result, order_status: o.order_status || null,
         alpaca_order_id: o.alpaca_order_id || null, client_order_id: o.client_order_id || null,
         origin: 'objetivo',
         reasoning: o.intencion ? `rebalanceo hacia el objetivo (${o.intencion}, ${((o.delta_weight || 0) * 100).toFixed(2)}pp)` : null,
         ...(o.error ? { error: o.error } : {}),
       }))),
       JSON.stringify({ ...(row.context || {}), target: row.target || null, rebalance: row.rebalance || null, contrato: contratoActivo() }),
       row.agent_id,
       row.account ? JSON.stringify(row.account) : null],
    );
  } catch (e) {
    // NO se traga: una corrida que operó y no se journaleó es peor que una que
    // no operó — las órdenes existen en Alpaca y no hay fila que las explique.
    throw new Error('no se pudo journalear la corrida del contrato objetivo: ' + String((e && e.message) || e));
  }
}

async function submitRiskExits(approved, runDate, creds) {
  const actions = [];
  let submitted = 0;
  for (const a of approved) {
    const clientOrderId = `arena:${runDate}:${a.symbol}:exit`;
    try {
      const order = await createLimitOrder({ symbol: a.symbol, qty: a.qty, side: 'sell', limit_price: a.limit_price, client_order_id: clientOrderId }, creds);
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
export async function getArenaState(agentId = FLAGSHIP_AGENT_ID) {
  try {
    const rows = await sql(`select halted, halted_at, halted_reason, resumed_at,
                                   baseline_at, baseline_equity, baseline_id
                            from arena_state where agent_id = $1`, [agentId]);
    return rows[0] || { halted: false, halted_at: null, halted_reason: null, resumed_at: null, baseline_at: null, baseline_equity: null, baseline_id: null };
  } catch (e) {
    // Fail-safe: si el estado no se puede leer, NO se asume detenido (no se
    // congela el agente por un hipo de DB) — el breaker se re-evaluará igual.
    return { halted: false, halted_at: null, halted_reason: null, resumed_at: null };
  }
}

// ── EL CORTE EFECTIVO de un agente ───────────────────────────────────
// Dos números derivados del estado, usados por LAS DOS rutas que miran el
// pasado (runArenaDecide y runArenaRiskNet). Viven acá, juntos, porque el bug
// que arreglan es precisamente que estaban repartidos: el corte por temporada
// se aplicó en `decide` y NO en la red determinista, así que la red seguía
// midiendo el drawdown contra el pico de una temporada muerta.
//
//   · `date`  — corte de FECHA para la memoria del PM (plan anterior, fills,
//               compromisos). MAX(arranque de temporada, baseline del reset).
//   · `since` — corte de INSTANTE para el pico del breaker. El más reciente
//               entre `resumed_at` (reanimación tras un halt) y `baseline_at`
//               (aplanado deliberado). null = sin corte.
//   · `floor` — el PISO del pico: el equity declarado de arranque.
export function agentCutoff(state = {}) {
  const date = effectiveCutoff(SEASON_CUTOFF, state.baseline_at);
  const ts = [state.resumed_at, state.baseline_at]
    .map((v) => (v ? Date.parse(new Date(v).toISOString()) : NaN))
    .filter((n) => Number.isFinite(n));
  const since = ts.length ? new Date(Math.max(...ts)).toISOString() : null;
  const floor = state.baseline_equity != null ? Number(state.baseline_equity) : RESET_BASELINE_USD;
  return { date, since, floor };
}

// Asegura una fila de estado por agente activo (idempotente). El halt/resume
// son UPDATEs por agent_id; sin fila previa un UPDATE no persistiría (afecta 0
// filas). La fila legada del Agente #6 ya quedó marcada `claude` en la migración;
// ésta siembra las de los agentes nuevos. Requiere el índice único de agent_id.
export async function ensureAgentStateRows(agentIds) {
  for (const id of agentIds) {
    try {
      await sql(`insert into arena_state (agent_id, halted) values ($1, false) on conflict (agent_id) do nothing`, [id]);
    } catch (e) { /* best-effort: si falla, el UPDATE del halt igual reintenta */ }
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
export async function runArenaResume({ agentId = FLAGSHIP_AGENT_ID, now = new Date() } = {}) {
  const state = await getArenaState(agentId);
  if (!state.halted) return { resumed: false, agent: agentId, reason: 'el agente no estaba detenido' };
  await sql(`update arena_state set halted = false, resumed_at = $1 where agent_id = $2`, [now.toISOString(), agentId]);
  await journalInsert({
    id: 'arena-resume-' + agentId + '-' + now.toISOString(), run_date: now.toISOString().slice(0, 10),
    phase: 'decide', prompt_version: PROMPT_VERSION, model: null, status: 'resumed', agent_id: agentId,
    plan: `Agente REACTIVADO manualmente tras el halt del ${state.halted_at || 's/f'} (${state.halted_reason || 'drawdown'}). El pico del breaker se re-basa al equity actual — el experimento reanuda desde aquí.`,
  });
  return { resumed: true, agent: agentId, halted_since: state.halted_at };
}

// ── POLÍTICA de la corrida por evento ────────────────────────────────
// Hay tres formas de despertar al PM fuera de la revisión diaria, y difieren en
// cuatro decisiones. Se resuelven AQUÍ, en un solo lugar, en vez de repartir
// `if (event.type === ...)` por el runner:
//
//   allow_buys    ¿puede ABRIR riesgo nuevo?
//   allow_unheld  ¿el slate puede traer nombres que NO tiene?
//   slate_only    ¿se descarta cualquier acción fuera del slate?
//   intraday      ¿la orden debe EJECUTAR ya (marketable), o descansa al open?
//
//   post_earnings_morning (T2 #7) — reacción al número sobre lo que YA tiene.
//     Cerrada en las cuatro: sin compras, solo el libro, y la orden `day`
//     descansa hasta la apertura (decide a media mañana con cierres de ayer).
//   watch_trigger — el vigilante detectó algo. Reglamento COMPLETO sobre
//     el/los nombres que dispararon: puede comprar (un candidato del buffet que
//     se movió 5% es una compra o no es nada), puede traer nombres que no tiene,
//     NO puede irse a otro lado, y ejecuta EN EL MOMENTO a marketable limit.
//   watch_floor (cadencia #6) — la revisión de piso de la apertura +30. Es
//     la revisión diaria mudada de horario: reglamento completo sobre TODO el libro. No abre
//     posiciones nuevas (para eso están los disparadores y el buffet), pero sí
//     ejecuta intradía: se decide con el mercado abierto.
//
// `event = null` → corrida normal: la política neutra, nada cambia.
export function eventPolicy(event) {
  if (!event) return { tag: 'd', allow_buys: true, allow_unheld: true, slate_only: false, intraday: false };
  switch (event.type) {
    case 'watch_trigger':
      return { tag: 'w', allow_buys: true, allow_unheld: true, slate_only: true, intraday: true };
    case 'watch_floor':
      return { tag: 'f', allow_buys: false, allow_unheld: false, slate_only: true, intraday: true };
    case 'post_earnings_morning':
    default:
      return { tag: 'm', allow_buys: false, allow_unheld: false, slate_only: true, intraday: false };
  }
}

// ── fase DECIDE ──────────────────────────────────────────────────────
// `event` (T2 #7) convierte la corrida en una POR EVENTO, no la revisión diaria:
//   { type:'post_earnings_morning', symbols:[...], reports:{SYM:{...}}, headline }
// En ese modo NO hay buffet ni SCAN (el evento YA define el slate: los nombres
// del libro que acaban de reportar), NO se re-evalúa la red determinista (el
// trailing y el stop catastrófico deciden con CIERRES completos, y a media
// mañana no hay uno nuevo: re-evaluarlos solo duplicaría las órdenes que la
// corrida de las 22:40 ya emitió) y NO se abren posiciones nuevas. La corrida
// existe para que el PM reaccione al número sobre lo que YA tiene — no para
// operar más seguido.
export async function runArenaDecide({ baseUrl, now = new Date(), agent = agentById(FLAGSHIP_AGENT_ID), getBuffet, caches, event = null, tier = null } = {}) {
  // ── LA BANDERA DEL CONTRATO OBJETIVO ────────────────────────────────
  // Va PRIMERO y con un `return`: con la bandera apagada, ni una línea de lo
  // que sigue cambia. Eso es lo que hace que "apagarla" sea de verdad volver al
  // comportamiento de ayer y no a una versión parecida.
  //
  // Y lo que corre del otro lado es LA MISMA función que la sombra
  // (`runAgenteObjetivo` con `vivo: true`), no una copia: lo que llegó a 7/7 en
  // sombra es exactamente lo que se enciende.
  if (usaObjetivo()) {
    const buffet = await (getBuffet ? getBuffet() : gatherContext({ baseUrl, now }));
    // ── EL `event` NO SE PASA, Y ESO ES LO QUE HAY QUE SABER ──────────
    // El contrato objetivo produce un PORTAFOLIO COMPLETO: no existe la
    // corrida "sobre NVDA". Por eso un disparador de NVDA rebalancea el libro
    // entero — y por eso el enfriamiento del vigilante pasó a ser por agente
    // (ver WATCH_RULES.cooldown_agent_minutes).
    //
    // Lo que SÍ viaja es que la corrida nació de un disparador: con eso el
    // motor exige un piso de movimiento antes de mandar órdenes. Una ronda
    // fija puede expresar un ajuste chico —son tres al día—; un disparador que
    // mueve el 1% del equity es churn con otro nombre.
    return runAgenteObjetivo({
      agent, buffet, now, tier, vivo: true,
      esDisparador: !!event,
      journalInsert: journalObjetivoVivo,
      runId: 'arena-' + agent.id + '-objetivo-' + now.toISOString(),
    });
  }

  const runDate = now.toISOString().slice(0, 10);
  const agentId = agent.id;
  // Política de la corrida por evento (ver eventPolicy). En la corrida normal
  // es la neutra y nada de esto aplica.
  const policy = eventPolicy(event);
  // Tag de la corrida dentro del día: 'd' decide, 'm' matutina por evento, 'w'
  // vigilante, 'f' revisión de piso. Entra en el id de los compromisos Y en el
  // client_order_id, para que dos corridas del mismo día sobre el mismo símbolo
  // no colisionen (con la cadencia por evento eso pasa TODOS los días).
  const runTag = policy.tag;
  // El id lleva el TIPO de corrida: con la cadencia por evento un agente puede
  // tener varias filas el mismo día y "arena-claude-<iso>" ya no las distingue
  // de un vistazo en el journal.
  const runKind = event ? (event.type === 'post_earnings_morning' ? 'morning' : event.type) : null;
  const base = { id: 'arena-' + agentId + (runKind ? '-' + runKind : '') + '-' + now.toISOString(), run_date: runDate, phase: 'decide', prompt_version: PROMPT_VERSION, model: agent.model, agent_id: agentId };

  // Caches del RUN (compartidos entre agentes por el orquestador): el buffet, los
  // cierres de Yahoo y los deep-dives de Finnhub son datos de MERCADO idénticos
  // para todos → se piden UNA vez por símbolo, no una por agente (dedupe con
  // in-flight promise). Standalone (un agente suelto / tests): locales, sin compartir.
  caches = caches || { series: new Map(), dive: new Map() };
  getBuffet = getBuffet || (() => gatherContext({ baseUrl, now }));
  const creds = agentAlpacaCreds(agent);

  // ── HALT del breaker (POR AGENTE): si este agente está DETENIDO, no corre
  // decide ni journalea (la muerte se journaleó UNA vez al dispararse el
  // broadcut; nada de filas diarias). Reactivación solo manual (runArenaResume). ──
  const state = await getArenaState(agentId);
  if (state.halted) {
    return { status: 'halted', halted_since: state.halted_at, reason: state.halted_reason };
  }

  // El CORTE de este agente: hasta dónde mira su memoria y cuál es el piso de
  // su pico. Sale del estado (baseline del último reset + resumed_at), no de
  // una constante — un reset a mitad de temporada tiene que mover los dos.
  const cutoff = agentCutoff(state);

  // ── B9 · EL PRESUPUESTO, EN EL CAMINO VIVO ───────────────────────────
  // El orquestador (la liga o el vigilante) resuelve el escalón UNA vez por tick
  // y lo pasa: siete agentes preguntándole a Neon lo mismo en paralelo serían
  // siete consultas para un número que es de la liga entera, no de nadie en
  // particular. Si no vino (un agente suelto, un test, un dispatch a mano) se
  // resuelve acá: una corrida sin techo porque entró por otra puerta sería
  // exactamente el agujero que este bloque tapa.
  const presupuesto = tier || await currentTier(now);
  // `effort` null en el escalón 0 = NO se pisa el default del registry. En el 1
  // y el 2 baja a 'low', que es la perilla de profundidad de esta liga (la
  // temperatura no lo es, y en Fable ni siquiera viaja).
  const effortDeCorrida = presupuesto.effort || undefined;

  if (!creds) {
    await journalInsert({ ...base, status: 'aborted_no_alpaca_keys', error: `Faltan ALPACA_${agent.alpaca}_KEY/SECRET.` });
    return { status: 'aborted_no_alpaca_keys', orders: 0 };
  }

  // Estado real del libro DEL AGENTE + plan anterior + PICO de equity + reintentos
  // previos, en paralelo. El buffet (self-fetch caro) y el LLM se posponen: si el
  // circuit breaker dispara un CORTE AMPLIO no se gastan ni el buffet ni el LLM.
  const [account, positions, openOrders, prevRows, peakRows, riskRows, fillRows, commitmentRows] = await Promise.all([
    getAccount(creds), getPositions(creds), getOrders('open', 100, creds),
    // EXCLUSIÓN DE FILAS OPERATIVAS. Varias filas llevan `plan` sin ser una
    // decisión del PM (el leaderboard las publica, por eso tienen texto). Si una
    // entrara aquí, el plan reinyectado al día siguiente sería el anuncio y no el
    // último plan REAL — justo la continuidad estilo nof1 que este campo da.
    //
    // `season_start` se conserva en la lista AUNQUE el mecanismo manual que la
    // escribía ya no exista: las filas que alcanzó a insertar siguen en el
    // journal para siempre, y borrar el código no borra el rastro.
    //
    // Las de liga (`season_started`, `rules_changed`, `season_winner`) ya
    // quedarían fuera por el filtro de `agent_id`, que solo trae filas del
    // agente real. Se nombran igual: que la consulta siga siendo correcta no
    // debe depender de que nadie journalee una de ésas con un agent_id concreto.
    //
    // ── B4 · EL CAMBIO DE CONTRATO DE LA NOCTURNA ────────────────────
    // La nocturna pasa a ser REPORTE, sin decisiones. Eso mueve una pieza que
    // no salta a la vista: el "plan anterior" que se le reinyecta al PM dejó de
    // ser el de la nocturna y pasó a ser el de la última RONDA FIJA.
    //
    // Sin este filtro, el PM de la apertura+30 recibiría como "su plan
    // anterior" el REPORTE de anoche — un texto que describe el día que pasó y
    // no decide nada. Construir sobre eso es construir sobre una crónica.
    //
    // `report` se excluye junto a las filas operativas, por el mismo motivo por
    // el que están ellas: llevan `plan` (el leaderboard las publica) sin ser
    // una decisión del PM.
    sql(`select run_date, plan, actions, status from arena_journal
         where phase = 'decide' and plan is not null and agent_id = $1
           and status not in ('season_start', 'season_started', 'rules_changed', 'season_winner', 'report', 'nightly_report')
           and run_date >= $2::date
         order by created_at desc limit 1`, [agentId, cutoff.date]),
    // High-water-mark del libro: el máximo equity journaleado POR ESTE AGENTE,
    // ACOTADO por resumed_at (tras revivir, el pico se re-basa al equity de ese
    // momento — si no, el broadcut re-dispararía sobre una cuenta ya liquidada).
    // null en el primer run → pico = equity.
    sql(`select max((account->>'equity')::numeric) as peak from arena_journal
         where account is not null and agent_id = $1 and run_date >= $3::date
           and ($2::timestamptz is null or created_at > $2::timestamptz)`, [agentId, cutoff.since, cutoff.date]),
    // Stops catastróficos recientes de ESTE agente que NO llenaron → escalan la banda.
    sql(`select actions from arena_journal where status = 'risk_exit' and agent_id = $1
         and created_at > now() - interval '7 days' order by created_at desc`, [agentId]),
    // ── T2: MEMORIA (ver _lib/arena-memory.js) ──
    // (a) FILLS históricos → fecha de apertura de cada posición viva (días en
    //     posición para el time stop, y la ventana del pico para el trailing).
    //     180 días cubre de sobra un time stop de 45. Se piden SOLO `actions`:
    //     el `context` de esas filas trae los prompts completos y pesa.
    sql(`select run_date, actions from arena_journal
         where phase = 'decide' and agent_id = $1 and actions is not null
         and run_date >= $2::date
         and created_at > now() - interval '180 days' order by created_at asc`, [agentId, cutoff.date]),
    // (b) COMPROMISOS journaleados → el fold determina cuáles siguen abiertos.
    //     Se proyecta SOLO context->'commitments' (no el context entero).
    sql(`select run_date, context->'commitments' as commitments from arena_journal
         where phase = 'decide' and agent_id = $1 and context ? 'commitments'
         and run_date >= $2::date
         and created_at > now() - interval '60 days' order by created_at asc`, [agentId, cutoff.date]),
  ]);
  const equity = Number(account.equity);
  const dbPeak = peakRows[0] && peakRows[0].peak != null ? Number(peakRows[0].peak) : 0;
  // Monótono e incluye el equity de hoy, con el PISO del baseline declarado: un
  // libro recién aplanado no arranca midiendo el drawdown contra el pico del
  // libro anterior (ver _lib/arena-baseline.js).
  const peak = breakerPeak({ dbPeak, equity, baselineEquity: cutoff.floor });
  const accountSnapshot = { equity, cash: Number(account.cash), positions: positions.length };
  const previous = prevRows[0]
    ? { date: prevRows[0].run_date, plan: prevRows[0].plan,
        orders: (prevRows[0].actions || []).map((a) => ({ symbol: a.symbol, side: a.side, result: a.result, order_status: a.order_status || null, filled_avg_price: a.filled_avg_price || null, reason: a.reason || null })) }
    : null;

  // ── T2: la HISTORIA de cada posición, derivada (sin schema nuevo) ────
  // La serie diaria completa por holding da DOS cosas de un solo request: el
  // último cierre (lo de siempre: stop catastrófico + semilla del guard) y el
  // PICO desde la entrada (trailing stop). La fecha de apertura sale de los
  // fills del propio journal; sin ella, `days_in_position` y el pico quedan en
  // null y ni el trailing ni el time stop disparan — fail-safe explícito: una
  // regla nueva NO liquida una posición sobre un dato que no se pudo derivar.
  const heldSymbols = [...new Set((positions || []).map((p) => (p && p.symbol ? String(p.symbol).trim().toUpperCase() : '')).filter(Boolean))];
  const heldSeriesArr = await Promise.all(heldSymbols.map((s) => cachedSeries(caches, s, now)));
  const heldCloses = {};
  const seriesBySymbol = {};
  heldSymbols.forEach((s, i) => {
    const series = heldSeriesArr[i];
    seriesBySymbol[s] = series;
    heldCloses[s] = series ? series.closes[series.closes.length - 1] : null;
  });
  const opens = reconstructPositionOpens(fillRows);
  const positionMeta = buildPositionMeta({ positions, opens, seriesBySymbol, now });

  // ── T2 #1: compromisos ABIERTOS (el fold sobre el journal del agente) ──
  const memory = foldCommitments(
    (commitmentRows || []).map((r) => ({ run_date: r.run_date, context: { commitments: r.commitments } })),
    { now },
  );

  // ── SALIDAS DE RIESGO deterministas (breaker + stop catastrófico + trailing) ──
  // Se computan ANTES del LLM: son la red de seguridad del libro y tienen
  // precedencia. Todas deciden con el último cierre COMPLETO (misma fuente que
  // valida el guard), así que en la corrida POR EVENTO —media mañana, sin cierre
  // nuevo— NO se re-evalúan: repetirían las órdenes de la corrida anterior.
  const escalation = event ? {} : escalationFromRiskRows(riskRows, heldSymbols);
  const risk = event
    ? { stage: 'none', drawdown: 0, approved: [], discarded: [] }
    : buildRiskExits({ equity, peak, positions, closes: heldCloses, escalation, peaks: peaksFromMeta(positionMeta) });
  const riskContext = {
    peak, drawdown: +risk.drawdown.toFixed(4), stage: risk.stage, escalation,
    // El corte con el que se midió ese pico. Sin esto, un drawdown journaleado
    // no se puede auditar: no se sabe contra qué ventana se calculó.
    cutoff: { since: cutoff.since, from_date: cutoff.date, baseline_equity: cutoff.floor, baseline_id: state.baseline_id || null },
    bands: { breaker: EXIT_RULES.exit_band_breaker, catastrophic: EXIT_RULES.exit_band_catastrophic, trailing: EXIT_RULES.exit_band_trailing },
    approved: risk.approved, discarded: risk.discarded,
    ...(event ? { skipped: 'corrida por evento: la red determinista decide con cierres completos, no intradía' } : {}),
  };

  // ── CORTE AMPLIO (drawdown ≥ 20% desde el pico): liquida todo, SIN LLM ──
  // Análogo del DEATH -20% de la flota validada. No se abre riesgo nuevo en un
  // −20%, así que ni se pega al buffet ni se gasta Anthropic.
  if (risk.stage === 'broadcut') {
    const { actions: riskActions, submitted } = await submitRiskExits(risk.approved, runDate, creds);
    const plan = `CIRCUIT BREAKER — corte amplio. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); se liquidan ${risk.approved.length} posiciones con marketable limit y se salta el LLM (no se abre riesgo nuevo en un −20%).`;
    await journalInsert({ ...base, account: accountSnapshot, status: 'risk_broad_cut', plan, actions: [...riskActions, ...riskDiscardActions(risk.discarded)], context: { risk: riskContext } });
    // DETIENE al agente (persistente): esta es la ÚNICA fila de la muerte. Las
    // corridas siguientes salen por el gate de halt, sin journalear. Revivir es
    // manual (runArenaResume) — el −20% es el resultado del experimento.
    const haltReason = `circuit breaker: drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)})`;
    await sql(`update arena_state set halted = true, halted_at = $1, halted_reason = $2 where agent_id = $3`, [now.toISOString(), haltReason, agentId]);
    return { status: 'risk_broad_cut', orders: submitted, risk_exits: submitted, breaker_stage: 'broadcut', drawdown: +risk.drawdown.toFixed(4), halted: true };
  }

  // ── Delever / stops catastróficos: ejecuta la RED DE SEGURIDAD antes del LLM
  // y en su PROPIA fila de journal. Así un stop que disparó se ejecuta AUNQUE el
  // LLM luego aborte (sin API key, error, o "nada que investigar" — resultados
  // normales que NO deben frenar la red). stage 'none' → no-op (0 exits). ──
  let riskSubmitted = 0;
  if (risk.approved.length || risk.discarded.length) {
    const { actions: riskActions, submitted } = await submitRiskExits(risk.approved, runDate, creds);
    riskSubmitted = submitted;
    // El plan sintético nombra la regla que REALMENTE disparó (un nombre puede
    // caer en más de una; se reporta la más severa que haya en el lote).
    const codes = new Set(risk.approved.flatMap((a) => a.reason_codes || []));
    const plan = risk.stage === 'delever'
      ? `CIRCUIT BREAKER — desapalancando. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); recorto PRO-RATA cada posición con marketable limit.`
      : codes.has('catastrophic_stop')
        ? `STOP CATASTRÓFICO — ${risk.approved.length} posición(es) cerró bajo su nivel ancho (~${(EXIT_RULES.catastrophic_stop_pct * 100).toFixed(0)}% desde la entrada); se liquida(n) con marketable limit en la apertura.`
        : `TRAILING STOP — ${risk.approved.length} posición(es) devolvió ${(EXIT_RULES.trailing_give_back * 100).toFixed(0)}% desde su pico tras haber ganado ${(EXIT_RULES.trailing_arm_gain * 100).toFixed(0)}%+; se liquida(n) con marketable limit en la apertura, con la ganancia adentro.`;
    await journalInsert({ ...base, id: base.id + ':risk', account: accountSnapshot, status: 'risk_exit', plan, actions: [...riskActions, ...riskDiscardActions(risk.discarded)], context: { risk: riskContext } });
  }

  // ── Buffet + SCAN, o el SLATE DEL EVENTO (T2 #7) ────────────────
  // Corrida normal: buffet (self-fetch COMPARTIDO entre agentes — el primero
  // que llega lo computa, los demás reusan la promesa) → SCOUT → floor.
  // Corrida por evento: el slate YA está dado (los nombres del LIBRO que acaban
  // de reportar). Sin buffet y SIN la llamada del scout: no hay nada que
  // triagear, y gastarla sería pagar por elegir lo que el evento ya eligió.
  let buffet = null;
  let channels = {};
  let scanHash = null;
  let scanText = null;
  let scanThesis = null;
  let candidateSymbols = [];
  let candidateOrigins = new Map();
  let floorReason = null;

  const context = {
    // Salidas de riesgo del run (stage/drawdown/pico + exits deterministas):
    // por qué desapalancó o qué stop disparó, sin depender de las acciones.
    risk: riskContext,
    // T2: la historia derivada de cada posición (días, pico, trailing, time
    // stop) y los compromisos abiertos que se le pusieron enfrente al PM.
    positions_meta: positionMeta,
    commitments: { open: memory.open, dropped: memory.dropped },
    ...(event ? { event: { type: event.type, symbols: event.symbols, reports: event.reports || null } } : {}),
  };

  const apiKey = providerKey(agent);

  // ── CANDADO DE SLUG NO VERIFICADO ────────────────────────────────
  // Antes de gastar un token: si el slug del modelo de este agente no está
  // confirmado contra el catálogo de su proveedor y no hay `ARENA_MODEL_<ID>`
  // puesta, el agente NO corre. Un slug inventado no falla barato — falla con
  // un 404 por corrida, todos los días, y el journal se llena de abortos que
  // parecen del modelo y son nuestros. /api/arena-smoke resuelve el slug real
  // contra el catálogo y dice exactamente qué env var poner.
  if (!modelSlugResolved(agent)) {
    await journalInsert({
      ...base, account: accountSnapshot, context, status: 'aborted_unverified_model',
      error: `El slug '${agent.model}' de ${agentId} no está verificado contra el catálogo de ${agent.provider} y no hay ARENA_MODEL_${agentId.toUpperCase()}. Corré /api/arena-smoke para resolverlo.`,
    });
    return { status: 'aborted_unverified_model', orders: 0, risk_exits: riskSubmitted };
  }

  if (event) {
    // El slate del evento. Dos políticas, según quién despertó al agente:
    //   - corrida matutina post-earnings (T2 #7): se INTERSECTA con el libro
    //     vivo. Si el nombre ya no está (se vendió ayer), no hay nada sobre qué
    //     pronunciarse, y esa corrida NUNCA abre riesgo nuevo.
    //   - corrida por DISPARADOR del vigilante: un candidato del buffet que
    //     se movió 5% NO está en el libro — ése es justo el punto. El slate
    //     viaja tal cual y el reglamento completo decide qué hacer con él.
    const held = new Set(heldSymbols);
    const slateRaw = (event.symbols || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    candidateSymbols = policy.allow_unheld ? [...new Set(slateRaw)] : slateRaw.filter((x) => held.has(x));
    candidateOrigins = new Map(candidateSymbols.map((sym) => [sym, event.type]));
    // Atribución: de dónde salió cada nombre del slate. En la matutina son del
    // LIBRO + canal earnings, con la cifra del reporte pegada (lo que el DIVE
    // necesita para cerrar la tesis); en la del vigilante, del libro o del
    // buffet según lo tenga o no, con el disparador al lado.
    const triggersBySymbol = {};
    for (const t of (event.triggers || [])) {
      if (!t || !t.symbol) continue;
      (triggersBySymbol[t.symbol] = triggersBySymbol[t.symbol] || []).push({ type: t.type, detail: t.detail });
    }
    for (const sym of candidateSymbols) {
      channels[sym] = {
        channels: held.has(sym) ? ['portfolio', ...(event.type === 'post_earnings_morning' ? ['earnings'] : ['watch'])] : ['watch', 'buffet'],
        screens: [], qualifiers: {},
        earnings: (event.reports || {})[sym] || null,
        ...(triggersBySymbol[sym] ? { watch_triggers: triggersBySymbol[sym] } : {}),
      };
    }
    context.scan = { skipped: event.type, slate: candidateSymbols.map((symbol) => ({ symbol, origin: event.type })) };
    if (!apiKey) {
      await journalInsert({ ...base, account: accountSnapshot, context, status: 'aborted_no_api_key', error: `Falta la API key de ${agent.provider} (${agentId}).` });
      return { status: 'aborted_no_api_key', orders: 0, risk_exits: 0 };
    }
    if (candidateSymbols.length === 0) {
      await journalInsert({
        ...base, account: accountSnapshot, context, status: 'ok_no_candidates',
        plan: event.type === 'watch_floor'
          ? 'Revisión de piso: el libro está vacío, no hay posiciones sobre las que pronunciarse.'
          : 'Corrida por evento: ninguno de los nombres del slate sigue en el libro de este agente.',
      });
      return { status: 'ok_no_candidates', orders: 0, candidates: 0, trigger: event.type, risk_exits: 0, breaker_stage: 'none' };
    }
  } else {
    buffet = await getBuffet();

    // Atribución del canal 'portfolio', POR AGENTE. El índice base de gatherContext
    // solo conoce el buffet (compartido). Los candidatos que el scout re-elige del
    // LIBRO (un holding a recortar/salir, o una orden abierta a re-anclar) no están
    // en el buffet → sin esto salían con channels:[]. Se marca sobre un CLON del
    // índice (el libro difiere por agente; mutar el compartido contaminaría a los
    // demás), antes de construir prompts/atribuir.
    channels = buffet.channelsByTicker ? structuredClone(buffet.channelsByTicker) : {};
    addPortfolioChannels(channels, { positions, openOrders });

    // ── FASE 1: SCAN ────────────────────────────────────────────────
    // EL CORTE DE CACHÉ, explícito: `[reglamento, contexto compartido]` va del
    // lado estable (idéntico para los siete de esta corrida) y el libro del
    // agente del lado volátil. Ver el bloque de ANTHROPIC_CACHE_MIN_TOKENS.
    const scanSystem = buildScanSystemPrompt();
    const scanShared = buildSharedContext(buffet);
    const scanUser = buildScanUserPrompt({ account, positions, openOrders, buffet, previous, meta: positionMeta });
    // El hash sigue cubriendo TODO lo que se le mandó al modelo: mover un bloque
    // de lado del corte no puede cambiar la huella de la corrida, o el
    // post-mortem dejaría de poder comparar dos corridas con el mismo prompt.
    scanHash = sha256(scanSystem + '\n---\n' + scanShared + '\n---\n' + scanUser);

    // context journaleado desde el arranque; se enriquece por fase. El
    // post-mortem del 24-jul quedó ciego (fetch_errors sin guardar, del prompt
    // solo el hash). Ahora queda el texto completo de AMBAS fases, más los
    // candidatos y los datos Finnhub — reconstruir qué vio el PM no es arqueología.
    context.unavailable = buffet.unavailable;
    context.fetch_errors = buffet.fetch_errors;
    context.admission = buffet.admission;
    context.scan = { prompt: { system: scanSystem, shared: scanShared, user: scanUser }, hash: scanHash, model: agent.model };
    context.scan.cache_prefix = cachePrefixReport(agent, [scanSystem, scanShared]);

    if (!apiKey) {
      // Dependencia documentada: sin la key del proveedor del agente (ANTHROPIC_API_KEY
      // para claude/control, OPENROUTER_API_KEY para el resto) el run queda
      // journaleado, con cero órdenes — el cron puede quedar prendido sin gastar.
      await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_no_api_key', error: `Falta la API key de ${agent.provider} (${agentId}).` });
      return { status: 'aborted_no_api_key', orders: 0, risk_exits: riskSubmitted };
    }

    // Techo compartido por ambas fases (ARENA_MAX_TOKENS, default 6000). El 500
    // de antes era un techo para un modelo que no razona: en uno que sí, los
    // tokens de pensamiento salen del MISMO presupuesto y la respuesta se corta
    // antes del JSON. Ver la nota de ARENA_MAX_TOKENS en el registry.
    const scanLlm = await callArenaLLM({ agent, system: [scanSystem, scanShared], messages: [{ role: 'user', content: scanUser }], maxTokens: ARENA_MAX_TOKENS, now, effort: effortDeCorrida });
    // El gasto se registra ANTES de cualquier salida por error: una corrida que
    // abortó igual quemó tokens, y un contador que solo cuenta los éxitos
    // subestima justo los días caros (los que abortan son los días raros).
    await registrarGasto({ agent, runId: base.id, phase: 'scan', llm: scanLlm, now });
    // OBSERVABILIDAD DEL SCAN. El DIVE journaleaba stop_reason/truncated desde
    // siempre; el SCAN no, y por eso un aborto de la fase 1 era indistinguible
    // entre "parloteó fuera del JSON" y "se quedó sin tokens". Los abortos de
    // grok del 14 y el 15 se diagnosticaron a ciegas por esto mismo.
    context.scan.stop_reason = (scanLlm.data && scanLlm.data.stop_reason) || null;
    context.scan.truncated = context.scan.stop_reason === 'max_tokens';
    // Los parámetros efectivos de ESTA corrida, en la fila de ESTA corrida.
    // El anuncio de reglamento los fija una vez; acá quedan por corrida, que es
    // lo que hace auditable un cambio de env var a mitad de temporada.
    context.params = effectiveParams(agent, ARENA_MAX_TOKENS);
    if (scanLlm.data && scanLlm.data.usage) context.scan.usage = scanLlm.data.usage;
    if (scanLlm.refusal) {
      // Rechazo del clasificador: su propio status. No es un JSON malformado.
      context.scan.refusal = scanLlm.refusal_details || true;
      await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_llm_refusal', error: 'el modelo rechazó la petición (stop_reason=refusal) [fase scan]' });
      return { status: 'aborted_llm_refusal', orders: 0, risk_exits: riskSubmitted };
    }
    if (scanLlm.stale || scanLlm.status !== 200 || !scanLlm.data) {
      const reason = (scanLlm.stale
        ? 'fechas rotas tras retry (guard anti-alucinación)'
        : 'HTTP ' + scanLlm.status + ' de ' + agent.provider + (scanLlm.error_detail ? ': ' + scanLlm.error_detail : '')) + ' [fase scan]';
      context.scan.llm_error = detalleFalloLlm(scanLlm);
      await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_llm_error', error: reason });
      return { status: 'aborted_llm_error', orders: 0, risk_exits: riskSubmitted };
    }
    scanText = (scanLlm.data.content || []).map((b) => b.text || '').join('').trim();
    context.scan.response = scanText;

    const scan = parseScanResponse(scanText, MAX_CANDIDATES);
    if (!scan.ok) {
      // Regla de la casa: JSON malformado = run abortado honesto, CERO órdenes.
      await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'aborted_scan_malformed_json', llm_response: scanText, error: scan.error });
      return { status: 'aborted_scan_malformed_json', orders: 0, risk_exits: riskSubmitted };
    }
    scanThesis = scan.thesis;
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
    candidateSymbols = slate.candidates.map((c) => c.symbol);
    candidateOrigins = new Map(slate.candidates.map((c) => [c.symbol, c.origin]));
    floorReason = slate.floor.reason;

    // Cero candidatos FINALES (scout no vio nada Y el screener no aportó) → nada
    // que investigar. Estado DISTINTO de ok_no_actions (hubo candidatos y el DIVE
    // holdeó). `floor.reason` distingue POR QUÉ el screener no aportó: datos
    // frescos sin qualifiers (`no_qualifying_candidates`) vs. canal sin datos
    // (`screener_disabled/empty/stale/unavailable`) — el bug de origen era leer
    // "tabla vacía por flag faltante" como "ninguna acción calificó". No gasta el
    // DIVE ni pega a Finnhub.
    if (candidateSymbols.length === 0) {
      await journalInsert({ ...base, prompt_hash: scanHash, account: accountSnapshot, context, status: 'ok_no_candidates', plan: scan.thesis || 'Scout found nothing worth a deep-dive today.', llm_response: scanText });
      return { status: 'ok_no_candidates', orders: riskSubmitted, candidates: 0, floor: floorReason, risk_exits: riskSubmitted, breaker_stage: risk.stage };
    }
  }

  // ── FASE 2a: DEEP DIVE (determinista, Finnhub — sin LLM) ─────────
  const dive = await cachedDeepDive(caches, candidateSymbols, process.env.FINNHUB_API_KEY, now);
  // Último cierre por candidato — MISMA fuente/valor que validará el guard, así
  // el PM ve exactamente el cierre contra el que se calcula la banda ±2% (sin
  // desfase). Cacheado por el run (dedupe entre agentes); se reusa para el guard.
  const closeArr = await Promise.all(candidateSymbols.map((t) => cachedClose(caches, t, now)));
  const candidateCloses = {};
  candidateSymbols.forEach((t, i) => { candidateCloses[t] = closeArr[i]; });

  // ── CADENCIA #5: INTRADÍA, la referencia de precio es el precio VIVO ──
  // La corrida nocturna ancla todo al último cierre completo: es el número más
  // reciente que existe cuando el mercado ya cerró. Con el mercado ABIERTO ese
  // número es viejo — justamente porque algo se movió es que el vigilante
  // despertó al agente. Así que en una corrida intradía el precio vivo de
  // Alpaca (el que el vigilante ya midió) sustituye al cierre en los TRES
  // lugares que importan, y en los tres tiene que ser el MISMO número:
  //   (a) lo que se le MUESTRA al PM en el DIVE,
  //   (b) contra lo que el guard valida la banda ±2%,
  //   (c) contra lo que se calcula el marketable limit de envío.
  // Sin esto, un nombre que subió 4% desde el cierre tendría toda orden
  // descartada por "fuera de banda" — el guard rechazaría precisamente las
  // corridas que la cadencia nueva existe para producir.
  const livePrices = {};
  if (policy.intraday) {
    for (const [sym, px] of Object.entries((event && event.prices) || {})) {
      const n = Number(px);
      if (Number.isFinite(n) && n > 0) livePrices[String(sym).toUpperCase()] = n;
    }
    for (const t of candidateSymbols) if (livePrices[t] != null) candidateCloses[t] = livePrices[t];
    context.intraday = {
      prices: livePrices,
      note: 'corrida intradía: la referencia de precio es el último trade de Alpaca, no el cierre completo',
    };
  }

  // ── FASE 2b: DIVE (LLM #2 — decide órdenes) ─────────────────────
  // La persona del agente es lo ÚNICO que varía del prompt (identidad, decisión #6).
  const diveSystem = buildDiveSystemPrompt(agent.persona);
  const diveUser = buildDiveUserPrompt({
    account, positions, openOrders, previous, scanThesis, candidates: candidateSymbols,
    deepDive: dive.data, closes: candidateCloses, channels,
    // T2: la historia de cada posición + los compromisos abiertos + el encuadre
    // de la corrida por evento. Es el prompt completo que la auditoría guarda.
    meta: positionMeta, commitments: memory.open, event,
  });
  // El contexto compartido (tablero + canales) también va al prefijo cacheado
  // del DIVE: es el MISMO texto que ya vio en el SCAN y es idéntico para los
  // siete, así que la caché lo cubre y el modelo no pierde el tablero al pasar
  // de fase. Se calcula UNA vez — lo usan el hash, la medición de caché y la
  // llamada.
  const diveShared = buffet ? buildSharedContext(buffet) : null;
  const diveHash = sha256(diveSystem + '\n---\n' + (diveShared || '') + '\n---\n' + diveUser);
  // shown_closes: el cierre que se le MOSTRÓ al PM por candidato — para auditar
  // desfases contra lo que valida el guard (deberían coincidir siempre).
  context.dive = { prompt: { system: diveSystem, shared: diveShared, user: diveUser }, hash: diveHash, model: agent.model, finnhub: dive.data, finnhub_errors: dive.errors, shown_closes: candidateCloses };
  // El prefijo cacheable de ESTA llamada, medido. Si no llega al piso del
  // modelo, el marcador se ignora EN SILENCIO — journalearlo es lo que convierte
  // ese silencio en algo que se puede leer después (ver cachePrefixReport).
  // Se mide el prefijo tal como VIAJA. Medir solo el system diría que cabe
  // holgado y ocultaría que el tablero también está del lado cacheado.
  context.dive.cache_prefix = cachePrefixReport(agent, diveShared ? [diveSystem, diveShared] : diveSystem);
  // prompt_hash de la fila = el del DIVE (la fase que produce las órdenes).
  const withPrompt = { ...base, prompt_hash: diveHash, account: accountSnapshot, context };

  // maxTokens 3000 (era 1500). El contrato de la T2 pide, además del plan y las
  // acciones, un pronunciamiento por posición y uno por compromiso abierto: con
  // 8 holdings eso ya no cabía en 1500 tokens, y una respuesta CORTADA a la
  // mitad es JSON inválido → `aborted_malformed_json`, cero órdenes. Subir el
  // techo es más barato que perder una corrida entera.
  // ── B3 · LA INVESTIGACIÓN ────────────────────────────────────────
  // Con herramientas, el DIVE deja de ser UNA llamada y pasa a ser una
  // conversación: el modelo pide, el harness ejecuta, el modelo decide. El tope
  // es del harness (ver _lib/arena-tools.js) y la secuencia se journalea entera.
  //
  // El PRESUPUESTO depende del tipo de corrida: 8 en una ronda fija, 3 en una
  // por disparador. Una corrida por disparador está acotada a un nombre — no
  // necesita explorar, necesita decidir sobre lo que ya se le dijo que mire.
  // El tope de herramientas es el MENOR de dos: el del tipo de corrida (8 en una
  // ronda fija, 3 por disparador) y el que deja el escalón del presupuesto (3 en
  // el 1, CERO en el 2). El mínimo, y no el del escalón a secas: el breaker
  // puede APRETAR, nunca aflojar. Si algún día un escalón permitiera más que el
  // tipo de corrida, tomar el del escalón haría que el breaker REGALARA
  // llamadas — un freno que acelera.
  const toolBudgetCorrida = event ? TOOL_BUDGET.triggered : TOOL_BUDGET.fixed_round;
  const toolBudget = Math.min(toolBudgetCorrida, presupuesto.tools_max);
  // Las estructuras sobre las que filtran las herramientas. Son los objetos
  // CRUDOS, no el texto renderizado: `screener({min_rvol:3})` filtra filas, no
  // parsea una tabla. Una corrida por evento no tiene buffet (su slate lo dio
  // el disparador), así que ahí no hay herramientas — y está bien: esa corrida
  // existe para decidir sobre un nombre, no para explorar.
  const boardForTools = (buffet && buffet.board_raw) || null;
  const universeForTools = (buffet && buffet.universe_raw) || null;
  let executor = null;
  let diveLlm;
  // El resultado del loop sobrevive al bloque porque el contador de gasto lo
  // necesita: sin él contaría una llamada de nueve.
  let diveLoop = null;
  if (TOOLS_ENABLED && boardForTools && toolBudget > 0) {
    // El sector de cada nombre sale del deep dive que ya se pagó (Finnhub
    // profile2). Un nombre sin clasificar devuelve null y el filtro por sector
    // simplemente no lo incluye — no se inventa un sector.
    // ── EL SECTOR SALE DEL UNIVERSO, NO DE UN startsWith ──────────────
    // Esto mapeaba la industria de Finnhub al ETF comparando los primeros SEIS
    // caracteres del nombre del sector. "Information Technology" vs "Technology"
    // no coinciden, así que devolvía null para casi todo — y `sector({etf})`
    // daba 0 filas porque ningún nombre tenía sector.
    //
    // El universo ya guarda la clasificación GICS del CSV de IVV. Es el dato
    // correcto y ya está pago.
    const sectoresUni = (buffet && buffet.universe_raw && buffet.universe_raw.sectores) || {};
    const sectorPorSimbolo = {};
    for (const [tk, gics] of Object.entries(sectoresUni)) {
      const etf = sectorFromGics(gics);
      if (etf) sectorPorSimbolo[tk] = etf;
    }
    // Para los nombres del día, que no están en ningún índice, se sigue usando
    // la industria del deep dive — pero con el mapeo por REGLAS, no con un
    // startsWith de seis caracteres.
    for (const [tk, d] of Object.entries(dive.data || {})) {
      if (sectorPorSimbolo[tk]) continue;
      const ind = d && d.profile && d.profile.industry;
      const etf = ind ? sectorFromIndustry(ind).etf : null;
      if (etf) sectorPorSimbolo[tk] = etf;
    }
    executor = createToolExecutor({
      budget: toolBudget,
      board: boardForTools, universe: universeForTools, creds, now,
      deps: { sectorOf: (sym) => sectorPorSimbolo[sym] || null },
    });
    const loop = await runToolLoop({
      agent, system: [diveSystem, diveShared].filter(Boolean),
      messages: [{ role: 'user', content: diveUser }],
      executor, maxTokens: ARENA_MAX_TOKENS, now, effort: effortDeCorrida,
    });
    diveLoop = loop;
    diveLlm = loop.llm;
    context.dive.tools = {
      budget: toolBudget, used: executor.used, intentos: executor.intentos, turns: loop.turns, stopped_by: loop.stopped_by,
      // La secuencia COMPLETA (con los resultados) para el replay; el resumen
      // publicable se deriva de acá en /liga.
      sequence: executor.sequence,
      summary: executor.summary(),
    };
  } else {
    diveLlm = await callArenaLLM({
      agent, system: diveShared ? [diveSystem, diveShared] : diveSystem,
      messages: [{ role: 'user', content: diveUser }], maxTokens: ARENA_MAX_TOKENS, now, effort: effortDeCorrida,
    });
    context.dive.tools = {
      enabled: false,
      reason: !TOOLS_ENABLED ? 'ARENA_TOOLS=0'
        : (toolBudget <= 0 ? `presupuesto en escalón ${presupuesto.tier}: sin herramientas` : 'sin tablero en esta corrida'),
    };
  }
  context.params = effectiveParams(agent, ARENA_MAX_TOKENS, effortDeCorrida);
  // Qué escalón regía ESTA corrida, con lo que el escalón cambió. Sin esto, una
  // corrida con 3 herramientas en vez de 8 se lee como un modelo que investigó
  // poco en vez de como un presupuesto que apretó.
  context.budget = {
    tier: presupuesto.tier, spent_before_usd: presupuesto.spent_usd, budget_usd: presupuesto.budget_usd,
    tools_max_por_escalon: presupuesto.tools_max, tools_max_por_tipo: toolBudgetCorrida, tools_max: toolBudget,
    effort: presupuesto.effort || null, cut: presupuesto.cut || null,
    spend_partial: !!presupuesto.spend_partial, spend_unavailable: !!presupuesto.spend_unavailable,
    note: presupuesto.note || null,
  };
  await registrarGasto({ agent, runId: base.id, phase: 'dive', llm: diveLlm, now, toolCalls: executor ? executor.used : 0, loop: diveLoop });
  if (diveLlm.data && diveLlm.data.usage) context.dive.usage = diveLlm.data.usage;
  if (diveLlm.refusal) {
    context.dive.refusal = diveLlm.refusal_details || true;
    await journalInsert({ ...withPrompt, status: 'aborted_llm_refusal', error: 'el modelo rechazó la petición (stop_reason=refusal) [fase dive]' });
    return { status: 'aborted_llm_refusal', orders: 0, risk_exits: riskSubmitted };
  }
  if (diveLlm.stale || diveLlm.status !== 200 || !diveLlm.data) {
    const reason = (diveLlm.stale
      ? 'fechas rotas tras retry (guard anti-alucinación)'
      : 'HTTP ' + diveLlm.status + ' de ' + agent.provider + (diveLlm.error_detail ? ': ' + diveLlm.error_detail : '')) + ' [fase dive]';
    context.dive.llm_error = detalleFalloLlm(diveLlm);
    await journalInsert({ ...withPrompt, status: 'aborted_llm_error', error: reason });
    return { status: 'aborted_llm_error', orders: 0, risk_exits: riskSubmitted };
  }
  const responseText = (diveLlm.data.content || []).map((b) => b.text || '').join('').trim();
  // POR QUÉ PARÓ de escribir. Un `aborted_malformed_json` tiene dos causas muy
  // distintas —el modelo envolvió/parloteó fuera del JSON, o se quedó SIN TOKENS
  // a mitad del objeto— y el journal no las distinguía: quedaba el texto crudo y
  // un "JSON inválido: Unexpected end of JSON input" que hay que interpretar a
  // mano. Ahora la razón viaja en la fila.
  const stopReason = (diveLlm.data && diveLlm.data.stop_reason) || null;
  const truncated = stopReason === 'max_tokens';
  context.dive.stop_reason = stopReason;
  context.dive.response_chars = responseText.length;
  context.dive.truncated = truncated;

  const parsed = parsePlanResponse(responseText);
  if (!parsed.ok) {
    const why = truncated
      ? `${parsed.error} — la respuesta se CORTÓ por límite de tokens (stop_reason=max_tokens, ${responseText.length} chars): no es que el modelo no sepa el formato, es que no le alcanzó el cupo.`
      : `${parsed.error} (stop_reason=${stopReason || 'desconocido'}, ${responseText.length} chars)`;
    await journalInsert({ ...withPrompt, status: 'aborted_malformed_json', llm_response: responseText, error: why });
    return { status: 'aborted_malformed_json', orders: 0, risk_exits: riskSubmitted, truncated };
  }

  // Auditoría post-hoc de los % de la prosa (JOURNAL-ONLY, instrumento de
  // medición — ver _lib/prose-audit.js). NO censura ni corrige el plan, NO
  // afecta órdenes ni el status: solo deja rastro de qué porcentajes del plan
  // no corresponden a un número que el PM realmente vio. La referencia es el
  // prompt del DIVE DE ESTE agente (diveSystem + diveUser), no un global: cada
  // agente de la LIGA se audita contra lo que SU propio PM tuvo enfrente.
  // Es lo único que detecta la FABRICACIÓN pura (un % sin ancla). Arranca sin
  // ser visible: la meta ~2 semanas es medir la tasa de falsos positivos.
  context.plan_number_audit = auditPlanPercentages(parsed.plan, diveSystem + '\n' + diveUser);

  // ── T2 #1 y #9: MEMORIA Y PRONUNCIAMIENTO (journal-only, igual que arriba) ──
  // Se normaliza lo que el modelo emitió, se guarda para el fold de la próxima
  // corrida y se MIDE el incumplimiento. No censura, no corrige y NO cambia el
  // status del run: un PM que se olvida de una posición igual opera — pero el
  // olvido queda contado, con nombre y apellido, y es comparable entre los siete
  // agentes de la liga (que es justo lo que el experimento quiere medir).
  const review = normalizePositionsReview(parsed.positions_review);
  const updates = normalizeCommitmentUpdates(parsed.commitment_updates);
  const created = normalizeCommitments(parsed.commitments, { runDate, tag: runTag });
  // En la corrida por evento el pronunciamiento obligatorio se limita a los
  // nombres del evento (es una reacción a un reporte, no la revisión diaria).
  const reviewRequired = event ? candidateSymbols : heldSymbols;
  context.positions_review = review;
  context.position_review_audit = auditPositionReview(reviewRequired, review, positionMeta);
  context.commitments = {
    open: memory.open,          // lo que se le puso enfrente (con id)
    updates,                    // cómo respondió a cada uno
    created,                    // lo que prometió hoy (vuelve la próxima corrida)
    audit: auditCommitments(memory.open, updates),
    dropped: memory.dropped,
  };

  // Referencias deterministas para el guard: symbol map + tipo (comparten
  // fetch/cache: 1 request en frío) + último cierre por símbolo propuesto.
  const symbolMap = await getSymbolMap(process.env.FINNHUB_API_KEY);
  const symbolTypes = await getSymbolTypes(process.env.FINNHUB_API_KEY);
  // Arranca de los cierres YA mostrados al PM (mismo valor exacto → sin desfase
  // entre lo que vio y lo que se valida); solo busca símbolos de acciones que
  // no eran candidatos (p.ej. vender una posición que el scan no nombró).
  const lastCloses = { ...heldCloses, ...candidateCloses, ...livePrices };
  const symbols = [...new Set(parsed.actions.map((a) => a && typeof a.symbol === 'string' ? a.symbol.trim().toUpperCase() : '').filter(Boolean))];
  for (const s of symbols) {
    if (s in lastCloses) continue; // ya lo tenemos del deep dive (o null, fail closed)
    lastCloses[s] = await cachedClose(caches, s, now);
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
    // cadencia #5: intradía la COMPRA también se envía marketable (la venta ya lo
    // era). El guard sigue siendo el mismo fail-closed; solo cambia el precio
    // de ENVÍO, y queda journaleado por orden.
    intraday: policy.intraday,
  });

  // Atribución por acción (determinista, no confía en el LLM): de qué canal(es)
  // salió el ticker + `origin` (scout_picked/floor_reserved) + screen y
  // qualifiers si vino del screener. Usa el índice CLONADO por agente (con las
  // marcas 'portfolio' de SU libro). A los 30 días: qué canal produjo decisiones.
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
    // Corrida por evento que NO abre riesgo nuevo (matutina post-earnings T2 #7,
    // revisión de piso cadencia #6): existen para decidir sobre lo que YA se tiene, no
    // para dar oportunidades extra de comprar. La del VIGILANTE sí compra — un
    // candidato del buffet que se movió 5% es una compra o no es nada.
    if (event && !policy.allow_buys && a.side === 'buy') {
      overridden.push({ ...a, result: 'discarded', reason: `${a.symbol}: compra suprimida — corrida por evento (${event.type}), que solo decide sobre posiciones ya abiertas` });
      continue;
    }
    // ALCANCE de la corrida acotada (cadencia #5): el disparador definió el slate y
    // fuera de él no hay contexto fresco — el PM no vio el buffet ni un deep
    // dive de ese otro nombre. Se descarta explícito y journaleado, no en
    // silencio: "el agente quiso irse a otro lado" es un dato del experimento.
    if (event && policy.slate_only && !new Set(candidateSymbols).has(a.symbol)) {
      overridden.push({ ...a, result: 'discarded', reason: `${a.symbol}: fuera del alcance de la corrida — acotada a ${candidateSymbols.join(', ')} (${event.type})` });
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
  // El client_order_id nació con la cadencia de UNA corrida por día:
  // `arena:<fecha>:<símbolo>:<lado>` era único por construcción. Con la cadencia
  // por evento un agente puede pronunciarse dos veces sobre el mismo nombre el
  // mismo día, y Alpaca rechaza el id repetido — la segunda orden, la que el
  // disparador produjo, moriría con un 422. El tag de corrida + el minuto ET la
  // desambiguan sin perder la legibilidad del id.
  const orderTag = policy.tag === 'd' ? '' : `:${policy.tag}${String(now.toISOString().slice(11, 16)).replace(':', '')}`;
  for (const a of llmApproved) {
    const clientOrderId = `arena:${runDate}:${a.symbol}:${a.side}${orderTag}`;
    try {
      const order = await createLimitOrder({ symbol: a.symbol, qty: a.qty, side: a.side, limit_price: a.limit_price, client_order_id: clientOrderId }, creds);
      journalActions.push(attribute({ ...a, result: 'approved', alpaca_order_id: order.id, client_order_id: clientOrderId, order_status: order.status }));
      submitted++;
    } catch (err) {
      journalActions.push(attribute({ ...a, result: 'submit_failed', client_order_id: clientOrderId, reason: String((err && err.message) || err) }));
    }
  }

  // ── TITULAR de la corrida (voz del arquetipo) ───────────────────
  // DESPUÉS de decidir y ejecutar: narra lo que YA pasó y no puede cambiarlo.
  // Vive en `context.headline` y NO en la columna `plan` — el "PREVIOUS PLAN"
  // de la corrida siguiente lee `plan`, así que narrar no contamina el próximo
  // juicio. Best-effort: si falla, headline null y el run sigue igual.
  context.headline = await generateHeadline({
    agent, plan: parsed.plan, actions: journalActions,
    equity, positions: positions.length, breakerStage: risk.stage,
    callLLM: callArenaLLM, now,
  });

  // El status de ESTA fila describe la decisión del PM: ok = envió órdenes;
  // ok_no_actions = holdeó (las salidas de riesgo van en su fila aparte).
  const status = submitted === 0 ? 'ok_no_actions' : 'ok';
  await journalInsert({ ...withPrompt, status, plan: parsed.plan, llm_response: responseText, actions: journalActions });
  // `orders` suma el run completo (PM + red de seguridad); `candidates` = slate final.
  return {
    status, orders: submitted + riskSubmitted, approved: llmApproved.length, discarded: discarded.length,
    candidates: candidateSymbols.length, floor: floorReason, risk_exits: riskSubmitted,
    // Equity del cierre de ESTA corrida: es lo que rankea el ganador de la
    // temporada sin re-consultar Alpaca siete veces al final.
    equity,
    headline: context.headline ? context.headline.text : null,
    breaker_stage: risk.stage, drawdown: +risk.drawdown.toFixed(4),
    ...(event ? { trigger: event.type } : {}),
    // Cumplimiento del reglamento T2 en esta corrida (lo que el post-mortem
    // compara entre modelos): posiciones no pronunciadas y compromisos ignorados.
    review_missing: context.position_review_audit.missing.length,
    commitments_missing: context.commitments.audit.missing.length,
  };
}

// ── cadencia #8: LA RED DETERMINISTA, SOLA (sin LLM, sin buffet) ───────────
// La red de seguridad —breaker de portafolio, stop catastrófico y trailing—
// vivía DENTRO de la corrida nocturna. Al retirar ese cron se habría ido con
// él, que es el modo más caro de fallar: el libro se quedaría sin stops y nadie
// lo notaría hasta el primer desastre. Así que se extrae y corre por su cuenta,
// UNA vez al día, en el tick de la revisión de piso.
//
// POR QUÉ UNA VEZ AL DÍA Y NO CADA 5 MINUTOS: las tres reglas deciden con el
// ÚLTIMO CIERRE COMPLETO, no con el precio vivo, y eso no es una limitación que
// haya que arreglar — es la regla (ver el encabezado de _lib/arena-exits.js:
// sistemas de fin de día, el gap es costo inevitable). Un stop intradía sería
// un stop APRETADO, justo lo que Kaminski & Lo desaconsejan y lo que el libro
// decidió no usar. Lo intradía es que el PM pueda reaccionar ANTES que la red
// (disparador `near_trailing`/`near_catastrophic`), no que la red se vuelva
// nerviosa.
//
// CERO tokens: no hay llamada al LLM en este camino, ni siquiera el titular.
export async function runArenaRiskNet({ agent, now = new Date(), caches } = {}) {
  const runDate = now.toISOString().slice(0, 10);
  const agentId = agent.id;
  caches = caches || { series: new Map(), dive: new Map() };
  const base = { id: 'arena-' + agentId + '-risknet-' + now.toISOString(), run_date: runDate, phase: 'decide', prompt_version: PROMPT_VERSION, model: null, agent_id: agentId };

  const state = await getArenaState(agentId);
  if (state.halted) return { status: 'halted', agent: agentId, orders: 0 };
  const creds = agentAlpacaCreds(agent);
  if (!creds) return { status: 'aborted_no_alpaca_keys', agent: agentId, orders: 0 };

  // EL MISMO CORTE que usa `decide`. Que acá faltara era un bug con dientes: el
  // fix del pico por temporada se aplicó en la decisión del PM y NO en la red
  // determinista, así que la red —la única pieza que NO se puede apagar— seguía
  // midiendo el drawdown contra el pico de un libro que ya no existía y podía
  // disparar un corte amplio sobre una cuenta recién aplanada.
  const cutoff = agentCutoff(state);

  // Las mismas consultas que hace el prólogo de runArenaDecide. Se repiten a
  // propósito en vez de factorizarse a medias: esta función tiene que poder
  // correr SOLA, sin el resto del pipeline, y una abstracción compartida entre
  // "la red de seguridad" y "la decisión del PM" es exactamente el acoplamiento
  // que hizo que la red dependiera del cron nocturno para empezar.
  const [account, positions, peakRows, riskRows, fillRows] = await Promise.all([
    getAccount(creds), getPositions(creds),
    sql(`select max((account->>'equity')::numeric) as peak from arena_journal
         where account is not null and agent_id = $1 and run_date >= $3::date
           and ($2::timestamptz is null or created_at > $2::timestamptz)`, [agentId, cutoff.since, cutoff.date]),
    sql(`select actions from arena_journal where status = 'risk_exit' and agent_id = $1
         and created_at > now() - interval '7 days' order by created_at desc`, [agentId]),
    sql(`select run_date, actions from arena_journal
         where phase = 'decide' and agent_id = $1 and actions is not null
         and run_date >= $2::date
         and created_at > now() - interval '180 days' order by created_at asc`, [agentId, cutoff.date]),
  ]);

  const equity = Number(account.equity);
  const dbPeak = peakRows[0] && peakRows[0].peak != null ? Number(peakRows[0].peak) : 0;
  const peak = breakerPeak({ dbPeak, equity, baselineEquity: cutoff.floor });
  const accountSnapshot = { equity, cash: Number(account.cash), positions: positions.length };

  const heldSymbols = [...new Set((positions || []).map((p) => (p && p.symbol ? String(p.symbol).trim().toUpperCase() : '')).filter(Boolean))];
  const heldSeriesArr = await Promise.all(heldSymbols.map((s) => cachedSeries(caches, s, now)));
  const heldCloses = {};
  const seriesBySymbol = {};
  heldSymbols.forEach((s, i) => {
    seriesBySymbol[s] = heldSeriesArr[i];
    heldCloses[s] = heldSeriesArr[i] ? heldSeriesArr[i].closes[heldSeriesArr[i].closes.length - 1] : null;
  });
  const positionMeta = buildPositionMeta({ positions, opens: reconstructPositionOpens(fillRows), seriesBySymbol, now });

  const escalation = escalationFromRiskRows(riskRows, heldSymbols);
  const risk = buildRiskExits({ equity, peak, positions, closes: heldCloses, escalation, peaks: peaksFromMeta(positionMeta) });
  const riskContext = {
    peak, drawdown: +risk.drawdown.toFixed(4), stage: risk.stage, escalation,
    // El corte con el que se midió ese pico. Sin esto, un drawdown journaleado
    // no se puede auditar: no se sabe contra qué ventana se calculó.
    cutoff: { since: cutoff.since, from_date: cutoff.date, baseline_equity: cutoff.floor, baseline_id: state.baseline_id || null },
    bands: { breaker: EXIT_RULES.exit_band_breaker, catastrophic: EXIT_RULES.exit_band_catastrophic, trailing: EXIT_RULES.exit_band_trailing },
    approved: risk.approved, discarded: risk.discarded,
    standalone: 'red determinista corrida sola (cadencia por evento): decide con cierres completos, sin LLM',
  };

  if (!risk.approved.length && !risk.discarded.length) {
    // Nada que hacer: NO se journalea una fila por agente por día diciendo "no
    // pasó nada". El latido del cron ya prueba que la red corrió; una fila
    // diaria vacía por siete agentes solo ensuciaría las cards.
    return { status: 'ok_no_exits', agent: agentId, orders: 0, breaker_stage: risk.stage, drawdown: +risk.drawdown.toFixed(4), equity };
  }

  const { actions: riskActions, submitted } = await submitRiskExits(risk.approved, runDate, creds);
  const codes = new Set(risk.approved.flatMap((a) => a.reason_codes || []));
  const plan = risk.stage === 'broadcut'
    ? `CIRCUIT BREAKER — corte amplio. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); se liquidan ${risk.approved.length} posiciones con marketable limit.`
    : risk.stage === 'delever'
      ? `CIRCUIT BREAKER — desapalancando. Drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)}); recorto PRO-RATA cada posición con marketable limit.`
      : codes.has('catastrophic_stop')
        ? `STOP CATASTRÓFICO — ${risk.approved.length} posición(es) cerró bajo su nivel ancho (~${(EXIT_RULES.catastrophic_stop_pct * 100).toFixed(0)}% desde la entrada); se liquida(n) con marketable limit.`
        : `TRAILING STOP — ${risk.approved.length} posición(es) devolvió ${(EXIT_RULES.trailing_give_back * 100).toFixed(0)}% desde su pico tras haber ganado ${(EXIT_RULES.trailing_arm_gain * 100).toFixed(0)}%+; se liquida(n) con marketable limit, con la ganancia adentro.`;

  await journalInsert({
    ...base, account: accountSnapshot,
    status: risk.stage === 'broadcut' ? 'risk_broad_cut' : 'risk_exit',
    plan, actions: [...riskActions, ...riskDiscardActions(risk.discarded)],
    context: { risk: riskContext, positions_meta: positionMeta },
  });

  // El broadcut DETIENE al agente, igual que en la corrida nocturna: la muerte
  // del −20% es el resultado del experimento, y revivir es manual.
  if (risk.stage === 'broadcut') {
    const haltReason = `circuit breaker: drawdown ${(risk.drawdown * 100).toFixed(1)}% desde el pico de equity (${peak.toFixed(0)})`;
    await sql(`update arena_state set halted = true, halted_at = $1, halted_reason = $2 where agent_id = $3`, [now.toISOString(), haltReason, agentId]);
    return { status: 'risk_broad_cut', agent: agentId, orders: submitted, halted: true, breaker_stage: 'broadcut', drawdown: +risk.drawdown.toFixed(4), equity };
  }
  return { status: 'risk_exit', agent: agentId, orders: submitted, risk_exits: submitted, breaker_stage: risk.stage, drawdown: +risk.drawdown.toFixed(4), equity };
}

// ── ORQUESTADOR de la LIGA (fase decide para TODOS los agentes activos) ──
// Corre cada agente activo (registry / ARENA_LEAGUE) sobre SU cuenta con SU
// modelo. En PARALELO: el trabajo caro y compartido —el buffet (self-fetch), los
// cierres de Yahoo, los deep-dives de Finnhub— se computa UNA vez por corrida y
// se comparte vía `getBuffet` + `caches` (dedupe con in-flight promise), así el
// wall-clock ≈ el de UN agente sin importar N, y el burst a Finnhub queda acotado
// a la UNIÓN de candidatos, no a la suma. Un agente que truena (sin keys, error
// de proveedor) NO tumba a los demás: su fila sale con su propio status.
// ── ¿mercado cerrado hoy? (festivo vía calendario de Alpaca) ─────────────────
// El calendario de trading es en horario del Este (NYSE); la fecha "de hoy" se
// calcula en America/New_York para no equivocarse por el offset UTC ni por DST.
// El cron de decide corre 22:40 UTC (post-cierre) → misma fecha en ET.
function easternDate(now) {
  // en-CA da 'YYYY-MM-DD'.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Devuelve { closed, reason, date } — reason ∈ open | holiday | weekend | calendar_error.
// El cron de decide ya dispara SOLO L-V (`40 22 * * 1-5`), así que el fin de
// semana es terreno de un workflow_dispatch manual: NO se maneja con una rama
// aparte (sería redundante con el cron). El valor que este chequeo agrega sobre
// el cron es el FESTIVO entre semana. Un solo camino de control: si el
// calendario de Alpaca no trae sesión hoy → cerrado (la etiqueta weekend/holiday
// es solo informativa para el journal).
//   - Calendario CAÍDO → fail-OPEN: corre igual (`reason='calendar_error'`). El
//     costo de correr de más son centavos y órdenes que se encolan al siguiente
//     open; el de NO correr es perder un día del experimento. El fail-closed del
//     Arena aplica a la validez de ÓRDENES (el guard), no a la detección de
//     calendario.
// `cal`/`creds` inyectables para tests (sin red).
export async function marketClosedReason({ now = new Date(), cal = getCalendar, creds = alpacaCreds() } = {}) {
  const date = easternDate(now);
  try {
    const sessions = await cal(date, date, creds);
    if (Array.isArray(sessions) && sessions.length > 0) return { closed: false, reason: 'open', date };
    // Vacío = sin sesión hoy. dow sobre la fecha ET (mediodía UTC evita cruce de día).
    const dow = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Dom, 6=Sáb
    return { closed: true, reason: (dow === 0 || dow === 6) ? 'weekend' : 'holiday', date };
  } catch (e) {
    return { closed: false, reason: 'calendar_error', date, error: String((e && e.message) || e) };
  }
}

// ── ANUNCIO del reglamento T2 en el journal (idempotente, con fecha) ──
// El cambio de reglas se registra UNA vez, como fila de liga. Sin este corte el
// post-mortem mezclaría dos reglamentos distintos en la misma serie. La
// idempotencia es del id (clave primaria) + `on conflict do nothing`: se puede
// llamar en cada corrida sin ensuciar nada. Best-effort: si falla, la corrida
// sigue — un anuncio perdido no justifica perder un día del experimento.
export async function announceT2Rules(now = new Date()) {
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
      [T2_ANNOUNCEMENT_ID, T2_RULES_VERSION, PROMPT_VERSION, T2_RULES_TEXT,
       JSON.stringify({ rules_version: T2_RULES_VERSION, prompt_version: PROMPT_VERSION, applies_to: activeAgents().map((a) => a.id) })],
    );
  } catch (e) { /* best-effort: el anuncio no bloquea la corrida */ }
}

// ── ANUNCIO DEL CONTRATO OBJETIVO (v4) ───────────────────────────────
// Mismo mecanismo que el reglamento T2: UNA fila de liga, idempotente por id.
// Va con el id que pidió Lety para que el post-mortem pueda partir exactamente
// acá: todo lo anterior es contrato de ACCIONES y todo lo posterior es contrato
// de PORTAFOLIO OBJETIVO, y mezclarlos en una serie sería comparar dos
// experimentos.
//
// Se anuncia solo cuando la bandera está encendida, y en la primera corrida que
// la vea. Anunciarlo con la bandera apagada sería declarar un cambio que no
// ocurrió.
export const CONTRATO_ANNOUNCEMENT_ID = 'arena-contrato-objetivo-2026-09-17';
export const CONTRATO_RULES_VERSION = 'v4';

export const CONTRATO_RULES_TEXT = [
  'REGLAMENTO v4 — CONTRATO DE PORTAFOLIO OBJETIVO. Desde esta corrida el PM ya no propone ACCIONES sueltas ("compra 30 de NVDA"): declara el LIBRO QUE QUIERE TENER, en pesos. El motor calcula la diferencia contra el libro real y manda las órdenes que faltan.',
  'LA REGLA QUE CAMBIA TODO: lo que tenés y NO listás, se vende. Omitir un nombre es decidir salir de él. En el contrato viejo, no mencionar una posición la dejaba quieta; acá la cierra. Un PM que se olvida de una posición la liquida.',
  'CÓMO SE EJECUTA: pesos objetivo − pesos reales = patas. Lo que libera capacidad va primero (ventas y coberturas), lo que la consume después, y dentro de cada grupo por tamaño. Un movimiento menor a la banda de no-negociación NO se ejecuta: expresa el drift del precio, no una decisión. Un cierre completo nunca se frena, aunque sea chico.',
  'ÓRDENES: límite marketable SIEMPRE, cantidad entera, precio del mismo snapshot que validó los rieles. JAMÁS a mercado — la regla de la casa no cambia con el contrato.',
  'LOS RIELES SIGUEN SIENDO LOS MISMOS, más uno: R11 exige que Alpaca confirme que el símbolo es OPERABLE (largos y cortos). Y antes de los rieles, cada ticker del objetivo se normaliza y se valida contra el universo del día: si alguno no existe, se rechaza el objetivo ENTERO — una cartera a la que se le saca una pata ya no es la que el PM decidió.',
  'CANDADO DE EJECUCIÓN: si alguna orden no corresponde a ningún peso del objetivo ni a ninguna posición del libro, o si su lado contradice el movimiento del peso, NO se manda NINGUNA orden de esa corrida. Un motor que inventa una orden no se corrige mandando las otras bien.',
  'LONG-ONLY, sin cambios: la T2 no habilita cortos. Una pata de corto que aparezca en el rebalanceo es un bug y se descarta en vez de mandarse.',
  'QUÉ NO CAMBIA: las nueve reglas de la T2, la cadencia por evento, el presupuesto de gasto en escalones, el baseline por agente y la red de riesgo determinista. Este anuncio cambia CÓMO SE EXPRESA la decisión, no qué se le permite decidir.',
  'EL CORTE: las métricas de antes y después de esta fila NO son comparables en turnover ni en número de órdenes — el contrato viejo proponía acciones y éste propone un libro. El return sí es comparable: el baseline no se movió.',
  'Experimento sin validación estadística, paper trading, no es asesoría.',
].join('\n');

export async function announceContratoObjetivo(now = new Date(), env = process.env) {
  if (!usaObjetivo(env)) return false;
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
      [CONTRATO_ANNOUNCEMENT_ID, now.toISOString().slice(0, 10), PROMPT_VERSION, CONTRATO_RULES_TEXT,
       JSON.stringify({
         rules_version: CONTRATO_RULES_VERSION,
         contrato: contratoActivo(env),
         prompt_version: PROMPT_VERSION,
         applies_to: activeAgents().map((a) => a.id),
         // Qué mirar para abortar, escrito EN el anuncio: si hay que apagar la
         // bandera a mitad de ronda, el criterio tiene que estar donde se está
         // mirando y no en un chat de ayer.
         aborto: [
           'más de DOS agentes con status rejected_rails en la misma ronda',
           'cualquier orden que no corresponda a un peso (el candado la frena sola y lo journalea como `freno`)',
         ],
         apagado: 'ARENA_CONTRATO=0 en Vercel. Se toma sin deploy y vuelve al contrato de acciones sin tocar nada más.',
       })],
    );
    return true;
  } catch (e) { return false; }
}

// ── ESCALÓN DEL PRESUPUESTO (B9) — anuncio con fecha ─────────────────
// MISMO mecanismo que los otros anuncios: una fila de liga, idempotente por id.
// Acá la idempotencia es por (día, escalón) y no por temporada: el breaker puede
// subir de escalón cualquier día, y sin este corte un día que terminó con menos
// corridas de lo normal no se distingue de un día en que los modelos decidieron
// menos. Uno es el presupuesto; el otro es el experimento.
export async function announceSpendTier(info, now = new Date()) {
  if (!info || !info.tier) return false;   // el escalón 0 es lo normal: no se anuncia
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
      [tierAnnouncementId(info.tier, now), now.toISOString().slice(0, 10), PROMPT_VERSION,
       tierAnnouncementText(info),
       JSON.stringify({
         budget: {
           tier: info.tier, spent_usd: info.spent_usd, budget_usd: info.budget_usd,
           pct_of_budget: info.pct_of_budget, tools_max: info.tools_max, effort: info.effort,
           fixed_rounds: info.fixed_rounds, buffet_triggers: info.buffet_triggers,
           own_book_triggers: info.own_book_triggers, risk_net: info.risk_net,
           cut: info.cut, spend_partial: info.spend_partial, spend_unavailable: info.spend_unavailable,
         },
       })],
    );
    return true;
  } catch (e) { return false; }   // best-effort: el anuncio no bloquea la corrida
}

// ── CAMBIO DE CADENCIA (anuncio de reglamento, con fecha) ────────
// El MISMO mecanismo que el anuncio de la T2: una fila de LIGA, idempotente por
// id, con status `rules_changed`. Sin este corte el post-mortem compararía
// corridas de dos cadencias distintas —una decisión diaria post-cierre contra
// N decisiones intradía por evento— como si fueran la misma población.
//
// La fecha NO es la del deploy: es `watchStartDate()`, el día en que el modelo
// por evento entra en vigor.
//
// FUNCIONES, no constantes. Antes esto derivaba de la constante `WATCH_START` y
// eso era un bug: `ARENA_WATCH_START` movía la COMPUERTA pero no el anuncio, así
// que con la env var puesta el `rules_changed` quedaba fechado —y con el id— del
// default, y el corte del post-mortem apuntaba a un día en el que no cambió
// nada. La env var existe justamente para mover el corte sin deploy; si el
// registro del corte no la sigue, la env var miente. Ahora las tres cosas
// (compuerta, id y fecha del anuncio) salen del MISMO `watchStartDate()`.
export function cadenceVersion() { return watchStartDate(); }
export function cadenceAnnouncementId() { return 'arena-cadencia-evento-' + cadenceVersion(); }
export function cadenceRulesText() { return [
  `CAMBIO DE CADENCIA del Arena — vigente desde ${cadenceVersion()}. Aplica IGUAL a los siete agentes de la liga, control incluido.`,
  'El reglamento de las 9 reglas de la Temporada 2 NO cambia: sigue vigente completo en cada corrida. Lo que cambia es CUÁNDO se corre.',
  '1) SE RETIRA LA CORRIDA NOCTURNA. La decisión diaria post-cierre (22:40 UTC) deja de ser el latido del experimento. También se retira la corrida matutina post-earnings: el reporte del día pasa a ser uno de los disparadores.',
  `2) VIGILANTE SIN LLM: cada ${WATCH_RULES.tick_minutes} minutos en horario de mercado se leen, vía Alpaca, los precios de las posiciones de los siete libros y de los candidatos del buffet. Mirar cuesta CERO tokens; pensar se paga solo cuando hay motivo.`,
  `3) SEIS DISPARADORES despiertan al agente dueño de la posición: movimiento ≥ ±${(WATCH_RULES.move_since_mark * 100).toFixed(0)}% desde su último pronunciamiento; llegar a ${WATCH_RULES.near_stop_points} puntos del trailing armado o del stop catastrófico; earnings u 8-K del día; volumen ≥ ${WATCH_RULES.volume_multiple}× su promedio de ${WATCH_RULES.volume_lookback_days} días; y un candidato del buffet moviéndose ≥ ±${(WATCH_RULES.buffet_move * 100).toFixed(0)}% (ése despierta a toda la liga: la oportunidad no tiene dueño).`,
  '4) TODO DISPARADOR SE JOURNALEA con su razón — haya corrida o no, y decida el agente operar o no. Un disparo frenado por cooldown o por tope queda con su motivo escrito.',
  '5) CORRIDA ACOTADA al ticker que disparó, con el REGLAMENTO COMPLETO. Fuera de ese slate toda acción se descarta. Las órdenes EJECUTAN EN EL MOMENTO, a marketable limit (la compra intradía también se re-precia, no solo la venta): una decisión tomada por un movimiento de las 10:15 que se ejecuta mañana no es una reacción.',
  `6) REVISIÓN DE PISO a la apertura +${WATCH_RULES.floor_after_open_minutes} min: el agente al que ningún disparador tocó se pronuncia igual sobre sus posiciones. El pronunciamiento obligatorio de la T2 #9 sobrevive al cambio de cadencia — un día tranquilo no deja al libro sin revisar.`,
  `7) TOPES, para que un día loco no queme tokens ni convierta al PM en day trader: máximo ${WATCH_RULES.max_runs_per_agent_day} corridas por agente por día (la de piso cuenta) y ${WATCH_RULES.cooldown_minutes} minutos de cooldown por ticker. Los disparadores de HECHO del día (earnings, 8-K, volumen, cercanía a un stop) disparan UNA vez por nombre por día; los de PRECIO se re-arman contra el último pronunciamiento.`,
  '8) LA RED DETERMINISTA NO SE MUEVE. Breaker, stop catastrófico y trailing siguen decidiendo con CIERRES COMPLETOS, una vez al día, en la revisión de piso — no intradía. El disparador de "a 2 puntos del stop" existe para que el PM pueda reaccionar ANTES que la red, no para que la red opine más seguido.',
  'OBJETIVO DECLARADO: que el agente decida cuando el mercado lo obliga, no cuando el reloj lo permite. Ser despertado más seguido NO es permiso para operar más seguido — ninguna regla de arriba premia la frecuencia, y dos de ellas la castigan.',
].join('\n'); }

export async function announceEventCadence(now = new Date()) {
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
      [cadenceAnnouncementId(), cadenceVersion(), PROMPT_VERSION, cadenceRulesText(),
        JSON.stringify({
          rules_version: cadenceVersion(), supersedes: T2_RULES_VERSION, prompt_version: PROMPT_VERSION,
          cadence: 'event_driven', watch_rules: WATCH_RULES, applies_to: activeAgents().map((a) => a.id),
        })],
    );
  } catch (e) { /* best-effort: el anuncio no bloquea la corrida */ }
}

// ── CAMBIO DE MODELOS (anuncio de reglamento, con fecha) ─────────
// MISMO mecanismo que el anuncio de la T2 y el de la cadencia: una fila de
// LIGA, idempotente por id, con status `rules_changed`. Existe porque el
// post-mortem NO puede comparar las corridas de antes y las de después como si
// fueran la misma población: cambió el modelo de los siete a la vez, cambió el
// techo de salida y cambió la perilla de profundidad. Sin este corte, un salto
// de equity el 16 se leería como mérito del PM cuando puede ser mérito del
// modelo nuevo.
//
// La fecha es la del CAMBIO (el día en que corre la primera nocturna con los
// modelos nuevos), y el id la fija: la fila entra una sola vez.
export const MODELS_VERSION = /* date-lint-ok: fecha del cambio de modelos, hecho histórico fijo que ancla el corte del post-mortem */ '2026-09-15';
export const MODELS_ANNOUNCEMENT_ID = 'arena-modelos-' + MODELS_VERSION;

export function modelsRulesText() {
  const rows = activeAgents().map((a) => `   · ${a.name}: ${a.model_label} (${a.provider === 'anthropic' ? 'API Anthropic directa' : 'OpenRouter'})`);
  return [
    `CAMBIO DE MODELOS del Arena — vigente desde ${MODELS_VERSION}. Aplica a los siete agentes de la liga, control incluido.`,
    'El reglamento de la Temporada 2 y la cadencia por evento NO cambian. Lo que cambia es QUIÉN decide.',
    '1) LA PARRILLA COMPLETA SUBE DE MODELO:',
    ...rows,
    `2) TECHO DE SALIDA ÚNICO de ${ARENA_MAX_TOKENS} tokens para las DOS fases (antes 500 en el scan y 3000 en el dive). En un modelo de razonamiento los tokens de pensamiento se cuentan contra el mismo techo: 500 cortaba la respuesta antes del JSON y la corrida moría como "formato inválido" sin serlo.`,
    `3) PROFUNDIDAD POR EFFORT, no por temperatura: effort '${ARENA_EFFORT}' para todos los que lo soportan.`,
    '4) MISMOS PARÁMETROS POR FAMILIA; `claude` y `control` IDÉNTICOS. La temperatura dejó de ser universal porque dejó de existir en una de las familias: Claude Fable 5.1 rechaza `temperature` con 400 (el sampling no es configurable ahí). Así que la regla ya no es "un número igual para los siete" sino: dentro de cada familia, parámetros idénticos; y entre el insignia y su control, idénticos byte a byte — que es donde se mide el ruido y lo único que esa comparación necesita. Los parámetros EFECTIVOS de cada agente van journaleados en esta misma fila, agente por agente: quien lea el post-mortem no tiene que adivinar con qué corrió cada uno.',
    '5) CACHÉ DE PROMPT encendida donde el proveedor la soporta (Anthropic explícita, OpenAI automática). El reglamento es idéntico entre corridas y entre agentes: pagarlo entero cada vez era regalar dinero. NO cambia ni una palabra de lo que el modelo lee.',
    '6) NADA MÁS CAMBIA. Mismo prompt, mismo buffet, mismo guard determinista, mismas cuentas, misma red de seguridad.',
    'LÍMITE DECLARADO: las métricas de antes y después de esta fecha NO son comparables. El corte queda escrito acá para que el post-mortem no las mezcle.',
  ].join('\n');
}

export async function announceModelChange(now = new Date()) {
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
      [MODELS_ANNOUNCEMENT_ID, MODELS_VERSION, PROMPT_VERSION, modelsRulesText(),
        JSON.stringify({
          rules_version: MODELS_VERSION, supersedes: cadenceVersion(), prompt_version: PROMPT_VERSION,
          change: 'models', max_tokens: ARENA_MAX_TOKENS, effort: ARENA_EFFORT,
          // Parámetros EFECTIVOS por agente (lo que de verdad viaja a la API).
          // `temperature: null` = el parámetro no se manda, NO que sea 0.
          models: activeAgents().map((a) => ({ id: a.id, ...effectiveParams(a) })),
          // El invariante que hace válido al control, afirmado en la fila del
          // anuncio: si algún día deja de ser true, el piso de ruido dejó de
          // medir ruido y el post-mortem tiene que saberlo desde acá.
          control_params_identical: sameParams(agentById('claude'), agentById('control')),
          applies_to: activeAgents().map((a) => a.id),
        })],
    );
  } catch (e) { /* best-effort: el anuncio no bloquea la corrida */ }
}

// ── APERTURA DE TEMPORADA — UN SOLO MECANISMO, AUTOMÁTICO ────────────
// Hubo dos durante unas horas: éste y uno manual (`?action=announce`, una fila
// `season_start` POR AGENTE) que llegó por otra rama. Se queda éste y el otro se
// retira en este mismo PR. Por qué:
//   - UNA fila de LIGA, no siete por agente: el arranque de temporada es un
//     hecho de la liga entera, igual que `skipped_market_closed`. Siete copias
//     del mismo texto ensucian la card de cada agente y el post-mortem.
//   - AUTOMÁTICO: si la apertura depende de que alguien acuerde curlear un
//     endpoint, el día que se olvide la temporada arranca sin rastro — y el
//     rastro es justamente el punto.
//   - `agent_id='league'` lo mantiene FUERA del plan anterior que se le
//     reinyecta al PM, sin depender de una exclusión por status.
//
// La fecha es la del PRIMER día en que corre: el id es fijo, así que la fila
// entra una sola vez y su `run_date`/`created_at` SON la fecha de apertura.
//
// GUARDA: solo se anuncia con los SIETE activos. Con `ARENA_LEAGUE` recortado,
// anunciar "arranca la liga completa" sería falso — y como el id es idempotente,
// quedaría sellado el día equivocado para siempre.
export const SEASON_OPEN_ID = 'arena-temporada-' + ARENA_SEASON.id + '-apertura';

export async function announceSeasonOpen(now = new Date()) {
  const agents = activeAgents();
  if (agents.length < ARENA_AGENTS.length) {
    return { announced: false, reason: 'liga incompleta', active: agents.length, total: ARENA_AGENTS.length };
  }
  const casa = { us: '🇺🇸', china: '🇨🇳', control: 'control' };
  const roster = agents.map((a) => `${a.name} (${a.model_label}, ${casa[a.house] || a.house})`).join(' · ');
  const plan = [
    `${ARENA_SEASON.name.toUpperCase()} — ARRANCA LA LIGA COMPLETA. Los ${agents.length} agentes corren desde hoy el MISMO harness, la MISMA temperatura y el MISMO reglamento (vigente desde ${T2_RULES_VERSION}), cada uno sobre su propio libro Alpaca paper.`,
    `En pista: ${roster}.`,
    `Ventana de la temporada: ${ARENA_SEASON.start} → ${ARENA_SEASON.end} (${ARENA_SEASON.weeks} semanas de mercado). El último día se declara al ganador por equity.`,
    'El CONTROL (Haiku-B) comparte modelo, prompt y temperatura con Claude y solo cambia de cuenta: es el piso de ruido. Sin él, cualquier diferencia entre modelos podría ser el orden de los fills y nada más.',
    'Experimento sin validación estadística, paper trading, no es asesoría.',
  ].join('\n');
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','season_started',$3,$4,$5,'league') on conflict (id) do nothing`,
      [SEASON_OPEN_ID, now.toISOString().slice(0, 10), PROMPT_VERSION, plan,
       JSON.stringify({
         season: ARENA_SEASON, rules_version: T2_RULES_VERSION, opened_on: now.toISOString().slice(0, 10),
         agents: agents.map((a) => ({ id: a.id, name: a.name, model: a.model, house: a.house, control: !!a.control })),
       })],
    );
    return { announced: true, agents: agents.length };
  } catch (e) { return { announced: false, reason: String((e && e.message) || e) }; }
}

// ── CIERRE DE TEMPORADA: el ganador, declarado el ÚLTIMO día ─────────
// Una liga sin final es una foto sin consecuencia: el "líder" de hoy no
// significa nada si nunca se cierra la ventana. La temporada (ARENA_SEASON,
// en el registry) dura 4 semanas de mercado y el último día —un viernes, para
// que exista la corrida— se journalea el ranking final.
//
// Se rankea por RETORNO contra el baseline PROPIO de cada agente, con el MISMO
// caveat que publica el leaderboard: `claude` arrastra días de ventaja de la
// Temporada 1. Un agente sin equity (sin keys, Alpaca caída) NO se rankea ni se
// inventa un cero: sale aparte, nombrado.
//
// Por retorno y no por equity bruto porque las siete cuentas NO arrancan del
// mismo capital: aplanar a mercado deja un residuo distinto en cada libro, y el
// reset re-basa a ese equity real. Con capital de arranque igual los dos
// criterios dan el MISMO ganador (ordenar por retorno es una transformación
// monótona de ordenar por equity), así que esto no reescribe ninguna temporada
// de capital uniforme — solo evita coronar al que arrancó con más plata.
export const BASELINE_EQUITY = (() => {
  const n = Number(process.env.ARENA_BASELINE_EQUITY);
  return Number.isFinite(n) && n > 0 ? n : 100000; // las cuentas paper arrancan en $100k
})();
export const SEASON_WINNER_ID = 'arena-temporada-' + ARENA_SEASON.id + '-ganador';

// Puro: resultados de la corrida → { standings, sin_equity, winner }.
// `baseline` acepta un número (el de siempre, para todos) o un MAPA
// { agent_id: equity de arranque }. El mapa gana cuando existe la entrada del
// agente; si no, cae al número global.
export function rankSeasonStandings(results = [], baseline = BASELINE_EQUITY) {
  const esMapa = baseline && typeof baseline === 'object';
  const baseDe = (id) => {
    const n = Number(esMapa ? baseline[id] : baseline);
    return Number.isFinite(n) && n > 0 ? n : BASELINE_EQUITY;
  };
  const conEquity = [];
  const sinEquity = [];
  for (const r of results) {
    const eq = Number(r && r.equity);
    if (Number.isFinite(eq) && eq > 0) {
      const b = baseDe(r.id);
      conEquity.push({
        id: r.id, name: r.name, equity: +eq.toFixed(2),
        baseline_equity: +b.toFixed(2),
        return_pct: +(((eq - b) / b) * 100).toFixed(2),
        status: r.status || null,
      });
    } else {
      sinEquity.push({ id: r.id, name: r.name, status: r.status || null, error: r.error || null });
    }
  }
  // Empate de retorno → desempata el equity. Dos agentes con el mismo retorno y
  // distinto capital no están empatados de verdad, pero tampoco hay razón para
  // que el orden entre ellos sea el de llegada del array.
  conEquity.sort((a, b) => (b.return_pct !== a.return_pct ? b.return_pct - a.return_pct : b.equity - a.equity));
  conEquity.forEach((r, i) => { r.rank = i + 1; });
  return { standings: conEquity, sin_equity: sinEquity, winner: conEquity[0] || null };
}

// Journalea el cierre. Idempotente por id: si el último día corren decide y la
// matutina, o el cron se repite, la fila entra UNA vez y no cambia de ganador.
export async function declareSeasonWinner(results, now = new Date()) {
  if (!isSeasonFinalDay(now)) return { declared: false, reason: 'no es el último día de la temporada' };
  // Baselines reales por agente. Best-effort: si la DB no contesta, cae al
  // global — un cierre de temporada no se cancela porque falte un denominador,
  // pero el denominador correcto es el que escribió el reset.
  let baselines = BASELINE_EQUITY;
  try {
    const map = await readBaselines(results.map((r) => r && r.id).filter(Boolean));
    const porId = {};
    for (const [id, r] of Object.entries(map || {})) {
      if (r && r.baseline_equity != null) porId[id] = Number(r.baseline_equity);
    }
    if (Object.keys(porId).length) baselines = porId;
  } catch { /* cae al global */ }
  const { standings, sin_equity, winner } = rankSeasonStandings(results, baselines);
  if (!winner) return { declared: false, reason: 'ningún agente reportó equity: no se declara un ganador inventado' };
  const podio = standings.slice(0, 3).map((r) => `${r.rank}. ${r.name} ${r.equity} (${r.return_pct >= 0 ? '+' : ''}${r.return_pct}%)`).join(' · ');
  const plan = [
    `${ARENA_SEASON.name.toUpperCase()} — CIERRE. Gana ${winner.name} con ${winner.return_pct >= 0 ? '+' : ''}${winner.return_pct}% (equity ${winner.equity} sobre un baseline de ${winner.baseline_equity}).`,
    `Podio: ${podio}.`,
    sin_equity.length ? `Sin equity reportado (no rankean): ${sin_equity.map((r) => r.name || r.id).join(', ')}.` : null,
    `Ventana: ${ARENA_SEASON.start} → ${ARENA_SEASON.end} (${ARENA_SEASON.weeks} semanas de mercado).`,
    'CAVEATS, los de siempre: paper trading, una sola temporada, sin validación estadística, y el agente insignia arrastra días de ventaja de la Temporada 1. Se gana por RETORNO contra el baseline propio, no por equity bruto: las siete cuentas no arrancaron del mismo capital y coronar al que arrancó con más plata no mediría nada. Esto no es asesoría.',
  ].filter(Boolean).join('\n');
  try {
    await sql(
      `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
       values ($1,$2,'decide','season_winner',$3,$4,$5,'league') on conflict (id) do nothing`,
      [SEASON_WINNER_ID, now.toISOString().slice(0, 10), PROMPT_VERSION, plan,
       JSON.stringify({ season: ARENA_SEASON, metric: ARENA_SEASON.metric, baseline: baselines, winner, standings, sin_equity })],
    );
    return { declared: true, winner };
  } catch (e) { return { declared: false, reason: String((e && e.message) || e) }; }
}

// ── T2 #7: disparadores de la CORRIDA MATUTINA POR EVENTO ────────────
// Qué cuenta como "acaba de reportar" a media mañana, medido contra la corrida
// de decide de las 22:40 UTC de ayer:
//   - HOY antes del open (BMO): ningún decide lo vio. Entra.
//   - LA SESIÓN ANTERIOR después del cierre (AMC/TBD): el decide de anoche vio
//     el número, pero el precio recién reacciona en el open de HOY. Entra.
//   - Ayer BMO ya repreció ayer y el decide de anoche cerró con ese precio
//     adentro. NO entra — sería una corrida extra sin evento nuevo.
// Devuelve { SYMBOL: {date,time,when,reported,sessions_since_report,eps…} }.
export function postEarningsTriggers(earnings, now = new Date()) {
  const out = {};
  for (const e of earnings || []) {
    const ticker = String((e && e.ticker) || '').trim().toUpperCase();
    if (!ticker) continue;
    const date = String(e.date || '').slice(0, 10);
    const time = String(e.time || '').toUpperCase();
    const ago = sessionsAgo(date, now);
    const todayBeforeOpen = ago === 0 && time === 'BMO';
    const prevAfterClose = ago === 1 && (time === 'AMC' || time === 'TBD' || time === '');
    if (!todayBeforeOpen && !prevAfterClose) continue;
    out[ticker] = {
      date, time: e.time, when: relativeDayLabel(date, now, time && time !== 'TBD' ? time : null),
      reported: true, sessions_since_report: ago,
      eps_est: e.eps_est ?? null, eps_actual: e.eps_actual ?? null,
      eps_surprise_pct: epsSurprisePct(e.eps_est, e.eps_actual),
      revenue_est: e.revenue_est ?? null, revenue_actual: e.revenue_actual ?? null,
    };
  }
  return out;
}

// Calendario de earnings SOLO (la corrida por evento no necesita el buffet
// entero: su slate ya está dado por el evento). Un fallo se degrada a lista
// vacía → ningún disparador → la corrida no ocurre. Nunca inventa un reporte.
async function fetchEarningsWindow(baseUrl, now) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = iso(new Date(now.getTime() - 5 * 86400000));
  const to = iso(now);
  try {
    const data = await fetchJson(baseUrl + `/api/earnings?from=${from}&to=${to}`);
    return (data && data.earnings) || [];
  } catch (e) { return []; }
}

// ── CORRIDA MATUTINA POR EVENTO POST-EARNINGS (T2 #7) ────────────────
// Corre a media mañana (cron aparte, ver vercel.json) y SOLO si alguna posición
// del libro de algún agente reportó. No es una segunda corrida diaria: es la
// reacción al número sobre lo que ya se tiene. Si nadie del libro reportó, se
// journalea UNA fila marcadora de liga y no se gasta ni un token.
//
// El chequeo de mercado cerrado se hace igual que en decide (global, una vez):
// un festivo entre semana no tiene open al que reaccionar.
export async function runArenaMorning({ baseUrl, now = new Date() } = {}) {
  const agents = activeAgents();
  if (!agents.length) return { agents: [], league: [], status: 'no_agents' };

  // CADENCIA: el reporte del día pasó a ser un DISPARADOR del vigilante (event_earnings),
  // que además lo detecta a los 5 minutos en vez de a las 14:50 UTC fijas. Esta
  // corrida queda retirada por la misma fecha que la nocturna.
  if (watchCadenceActive(now)) return supersededByWatch({ phase: 'morning', now, trigger: 'post_earnings_morning' });

  const market = await marketClosedReason({ now });
  if (market.closed) {
    await journalInsert({
      id: 'arena-league-morning-' + now.toISOString(), run_date: now.toISOString().slice(0, 10),
      phase: 'decide', prompt_version: PROMPT_VERSION, agent_id: 'league',
      status: 'skipped_market_closed', error: market.reason,
      context: { market_check: { reason: market.reason, date: market.date }, trigger: 'post_earnings_morning' },
    });
    return { agents: [], league: [], status: 'skipped_market_closed', market_closed: market };
  }

  await announceT2Rules(now);
  // El contrato objetivo se anuncia junto al reglamento T2 y solo si la bandera
  // está encendida: es idempotente por id, así que se puede llamar en cada
  // corrida sin ensuciar el journal.
  await announceContratoObjetivo(now);
  await announceSeasonOpen(now);
  // Corte del post-mortem por CAMBIO DE MODELOS (idempotente por id).
  await announceModelChange(now);
  await ensureAgentStateRows(agents.map((a) => a.id));

  const reports = postEarningsTriggers(await fetchEarningsWindow(baseUrl, now), now);
  const reported = Object.keys(reports);

  // ¿Alguien del libro de algún agente está en esa lista? Las posiciones se
  // consultan por agente (cada uno su cuenta); un agente sin keys se salta sin
  // tumbar a los demás, igual que en decide.
  const perAgent = await Promise.all(agents.map(async (agent) => {
    const creds = agentAlpacaCreds(agent);
    if (!creds || !reported.length) return { agent, symbols: [] };
    try {
      const positions = await getPositions(creds);
      const held = new Set((positions || []).map((p) => String((p && p.symbol) || '').trim().toUpperCase()));
      return { agent, symbols: reported.filter((sym) => held.has(sym)) };
    } catch (e) { return { agent, symbols: [], error: String((e && e.message) || e) }; }
  }));

  const withEvent = perAgent.filter((x) => x.symbols.length);
  if (!withEvent.length) {
    // Fila marcadora de LIGA: "hoy no hubo evento" es un hecho de la liga, no de
    // cada agente. Deja auditable que la corrida SÍ ocurrió y por qué no operó
    // — sin una fila por agente que ensucie las cards.
    await journalInsert({
      id: 'arena-league-morning-' + now.toISOString(), run_date: now.toISOString().slice(0, 10),
      phase: 'decide', prompt_version: PROMPT_VERSION, agent_id: 'league',
      status: 'skipped_no_post_earnings_event',
      plan: reported.length
        ? `Corrida matutina por evento: reportaron ${reported.join(', ')}, pero ninguno está en el libro de un agente activo. Sin evento que atender, no se gasta LLM.`
        : 'Corrida matutina por evento: ningún reporte en la ventana (hoy BMO / sesión anterior AMC). Sin evento, no se corre.',
      context: { trigger: 'post_earnings_morning', reported, reports },
    });
    return { agents: [], league: [], status: 'skipped_no_post_earnings_event', reported };
  }

  // Caches del run: los deep dives de los nombres reportados y sus series son
  // datos de mercado idénticos para todos los agentes que los tengan.
  const caches = { series: new Map(), dive: new Map() };
  // El escalón del presupuesto, UNA vez para toda la matutina (ver B9).
  const presupuesto = await currentTier(now);
  await announceSpendTier(presupuesto, now);
  const results = await Promise.all(withEvent.map(async ({ agent, symbols }) => {
    const event = {
      type: 'post_earnings_morning',
      symbols,
      reports: Object.fromEntries(symbols.map((sym) => [sym, reports[sym]])),
      headline: `${symbols.join(', ')} — que tienes en el libro — ya reportó: ${symbols.map((sym) => `${sym} ${reports[sym].when}`).join(' · ')}.`,
    };
    try {
      // Mismo reloj que la liga: es el mismo runArenaDecide, con los mismos
      // dos tiros al LLM por agente.
      const r = await withDeadline(
        runArenaDecide({ baseUrl, now, agent, caches, event, tier: presupuesto }),
        ARENA_AGENT_DEADLINE_MS,
        () => ({ status: 'timeout', orders: 0,
          error: `el agente no terminó en ${Math.round(ARENA_AGENT_DEADLINE_MS / 1000)}s (scan+dive). Los demás siguieron.` }),
      );
      return { id: agent.id, name: agent.name, model: agent.model, event_symbols: symbols, ...r };
    } catch (err) {
      return { id: agent.id, name: agent.name, status: 'error', orders: 0, error: String((err && err.message) || err) };
    }
  }));
  return { agents: results, league: results.map((r) => r.id), status: 'ok', trigger: 'post_earnings_morning', reported };
}

// ── CADENCIA #1: el cron NOCTURNO, retirado por fecha (no por borrado) ────────
// El corte se hace EN CÓDIGO y no quitando la entrada de vercel.json a
// propósito. Quitar el cron hace que el cambio dependa del MINUTO del deploy:
// si este PR sale un lunes a las 19:00 UTC, la corrida de esa misma noche
// (22:40) desaparece sin que nadie lo haya pedido, y el corte del post-mortem
// queda en una fecha que no es la anunciada. Con el gate por fecha ET, el
// deploy puede caer cuando sea: el día 14 corre como siempre y el 15 no.
// La entrada del cron se queda hasta que el vigilante lleve una semana verde;
// mientras tanto late igual (distingue "el cron corrió" de "el cron operó").
async function supersededByWatch({ phase, now, trigger }) {
  await announceEventCadence(now);
  await announceModelChange(now);
  await journalInsert({
    id: 'arena-league-' + phase + '-superseded-' + now.toISOString(),
    run_date: now.toISOString().slice(0, 10), phase: 'decide', prompt_version: PROMPT_VERSION,
    agent_id: 'league', status: 'skipped_superseded_by_watch',
    plan: `Corrida ${phase} retirada: desde ${watchStartDate()} el Arena corre por EVENTO. Al libro lo despierta el vigilante (/api/arena-watch) cuando el mercado hace algo que le concierne, y la revisión de piso de la apertura +${WATCH_RULES.floor_after_open_minutes} min cubre al agente que nadie tocó. Cero tokens en esta fila.`,
    context: { superseded_by: 'arena:watch', cadence_start: watchStartDate(), ...(trigger ? { trigger } : {}) },
  });
  return { agents: [], league: [], status: 'skipped_superseded_by_watch', cadence_start: watchStartDate() };
}

export async function runArenaLeague({ baseUrl, now = new Date() } = {}) {
  const agents = activeAgents();
  if (!agents.length) return { agents: [], league: [] };

  // Cadencia por evento vigente → el cron nocturno no decide nada (ni gasta).
  if (watchCadenceActive(now)) return supersededByWatch({ phase: 'decide', now });

  // ── Mercado cerrado hoy: chequeo GLOBAL, UNA vez antes del loop ──────────
  // "Mercado cerrado" es un hecho de la LIGA ENTERA, no de cada agente: se
  // resuelve aquí, antes de tocar el buffet/LLM de nadie. Si está cerrado
  // (festivo, o fin de semana en un dispatch manual), NINGÚN agente corre el
  // pipeline y se journalea UNA SOLA fila marcadora global
  // (status=skipped_market_closed, agent_id='league', cero órdenes). Fila
  // presente = la liga decidió no operar hoy; que el cron SÍ corrió lo sigue
  // distinguiendo el latido (`beat('arena:decide')`), no las filas del journal.
  // El reconcile es aparte (idempotente): en un festivo simplemente no hay
  // fills nuevos, así que no se toca aquí.
  const market = await marketClosedReason({ now });
  if (market.closed) {
    await journalInsert({
      id: 'arena-league-' + now.toISOString(),
      run_date: now.toISOString().slice(0, 10), phase: 'decide', prompt_version: PROMPT_VERSION,
      // agent_id='league' es un sentinela, NO un agente real: la fila no aparece
      // en ninguna card por-agente y el post-mortem la agrupa aparte.
      agent_id: 'league', status: 'skipped_market_closed', error: market.reason,
      context: { market_check: { reason: market.reason, date: market.date } },
    });
    return { agents: [], league: [], status: 'skipped_market_closed', market_closed: market };
  }

  // El reglamento de la Temporada 2 queda anunciado en el journal con fecha,
  // UNA sola vez (idempotente por id): el post-mortem necesita el corte para no
  // mezclar dos reglamentos en la misma serie.
  await announceT2Rules(now);
  // El contrato objetivo se anuncia junto al reglamento T2 y solo si la bandera
  // está encendida: es idempotente por id, así que se puede llamar en cada
  // corrida sin ensuciar el journal.
  await announceContratoObjetivo(now);
  await announceSeasonOpen(now);
  // Corte del post-mortem por CAMBIO DE MODELOS (idempotente por id).
  await announceModelChange(now);

  // Siembra una fila de estado por agente (el halt/resume son UPDATE por agent_id).
  await ensureAgentStateRows(agents.map((a) => a.id));

  let buffetPromise = null;
  const getBuffet = () => (buffetPromise = buffetPromise || gatherContext({ baseUrl, now }));
  const caches = { series: new Map(), dive: new Map() };

  // ── B9 · EL ESCALÓN, UNA VEZ PARA LA LIGA ENTERA ─────────────────────
  // Se resuelve ACÁ y no dentro de cada agente: el gasto acumulado es de la
  // liga, no de nadie en particular, y siete agentes preguntando lo mismo en
  // paralelo son siete consultas para un número idéntico. Además los deja a los
  // siete corriendo bajo el MISMO escalón, que es lo que hace comparable la
  // ronda: si el agente 1 corriera en escalón 0 y el 7 en escalón 1 porque el
  // gasto cruzó el umbral en el medio, la ronda mezclaría dos regímenes.
  const presupuesto = await currentTier(now);
  await announceSpendTier(presupuesto, now);

  // RELOJ POR AGENTE. El try/catch de acá abajo ya aislaba los ERRORES de un
  // agente; lo que no aislaba era su LENTITUD. Con Fable y Astra una corrida
  // tarda bastante más que con Haiku, y un solo agente colgado se lleva puesta
  // la función entera: los otros seis pierden su decisión aunque la hubieran
  // terminado. El deadline convierte eso en una fila `timeout` journaleable.
  const results = await Promise.all(agents.map(async (agent) => {
    try {
      const r = await withDeadline(
        runArenaDecide({ baseUrl, now, agent, getBuffet, caches, tier: presupuesto }),
        ARENA_AGENT_DEADLINE_MS,
        () => ({ status: 'timeout', orders: 0,
          error: `el agente no terminó en ${Math.round(ARENA_AGENT_DEADLINE_MS / 1000)}s (scan+dive). Los demás siguieron.` }),
      );
      return { id: agent.id, name: agent.name, model: agent.model, ...r };
    } catch (err) {
      return { id: agent.id, name: agent.name, status: 'error', orders: 0, error: String((err && err.message) || err) };
    }
  }));

  // Cierre de temporada: solo el ÚLTIMO día, con el equity que cada agente
  // acaba de reportar (cero llamadas extra a Alpaca).
  const season = { id: ARENA_SEASON.id, status: seasonStatus(now), day: seasonDay(now), start: ARENA_SEASON.start, end: ARENA_SEASON.end };
  const closing = await declareSeasonWinner(results, now);
  return {
    agents: results, league: results.map((r) => r.id), season,
    budget: {
      tier: presupuesto.tier, spent_before_usd: presupuesto.spent_usd, budget_usd: presupuesto.budget_usd,
      pct_of_budget: presupuesto.pct_of_budget, tools_max: presupuesto.tools_max,
      effort: presupuesto.effort || null, label: presupuesto.label, note: presupuesto.note || null,
    },
    ...(closing.declared ? { season_winner: closing.winner } : {}),
  };
}

// ── fase RECONCILE ───────────────────────────────────────────────────
// Fills reales (precio/timestamp de Alpaca) → journal. Estados terminales se
// dejan de consultar.
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day']);

// ── LA VENTANA ERA DE 7 DÍAS Y PERDÍA DATOS PARA SIEMPRE ─────────────
// Una orden que no se conciliara dentro de esos 7 días se quedaba con
// `order_status: 'accepted'` PARA SIEMPRE: sin `filled_avg_price` y sin
// `filled_at`. O sea, una posición sin precio ni hora de entrada — que es
// justo lo que hace falta para estudiar una decisión después. Alpaca sigue
// teniendo la orden; simplemente nadie se la volvía a pedir.
//
// El arreglo NO es sólo estirar la ventana. La ventana existía para acotar el
// trabajo, y el acotador correcto no es la fecha: es "¿queda algo por
// conciliar en esta fila?". Con el `exists` de abajo, una fila cuyas órdenes
// están todas en estado terminal no se trae aunque sea de ayer, y una con una
// orden viva se trae aunque sea de hace un mes. El costo en Alpaca no cambia
// —el bucle ya saltaba las terminales—; lo que cambia es que dejan de
// perderse las que quedaron colgadas.
//
// La ventana se conserva, mucho más ancha, como tope duro: una fila con una
// orden que Alpaca ya no reconoce no puede quedarse en la cola para siempre.
export const RECONCILE_VENTANA_DIAS = Number(process.env.ARENA_RECONCILE_DIAS) || 60;

export async function runArenaReconcile({ now = new Date() } = {}) {
  const rows = await sql(
    `select id, agent_id, actions from arena_journal
     where phase = 'decide' and actions is not null
       and created_at > now() - ($1 || ' days')::interval
       -- Sólo filas con algo REALMENTE pendiente: una orden con id de Alpaca
       -- cuyo estado no es terminal (o que todavía no tiene estado).
       and jsonb_typeof(actions) = 'array'
       and exists (
         select 1 from jsonb_array_elements(actions) a
         where a->>'alpaca_order_id' is not null
           and coalesce(a->>'order_status', '') <> all($2::text[])
       )
     order by created_at desc`,
    [String(RECONCILE_VENTANA_DIAS), [...TERMINAL]]);
  const summary = {
    rows_checked: rows.length, orders_checked: 0, updated: 0, filled: 0,
    // Con qué ventana corrió. Sin esto, "0 filas" no distingue "no había nada
    // pendiente" de "la ventana dejó todo afuera".
    ventana_dias: RECONCILE_VENTANA_DIAS,
  };

  for (const row of rows) {
    // Las órdenes viven en la cuenta Alpaca DEL AGENTE de la fila → se consultan
    // con SUS creds. Fila legada sin agent_id → el insignia. Sin keys → se salta.
    const agent = agentById(row.agent_id || FLAGSHIP_AGENT_ID);
    const creds = agent ? agentAlpacaCreds(agent) : null;
    if (!creds) continue;
    let changed = false;
    const actions = row.actions || [];
    for (const a of actions) {
      if (!a || !a.alpaca_order_id || TERMINAL.has(a.order_status)) continue;
      summary.orders_checked++;
      try {
        const o = await getOrder(a.alpaca_order_id, creds);
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
    if (phase === 'reconcile' || phase === 'decide' || phase === 'morning') await beat('arena:' + phase, 'disabled');
    return res.status(200).json({ disabled: true, hint: 'ARENA_ENABLED != 1 — smoke de /api/alpaca?smoke=1 primero.' });
  }

  try {
    await ensureSchema();
    const phase = String((req.query && req.query.phase) || 'decide').toLowerCase();
    const action = String((req.query && req.query.action) || '').toLowerCase();
    // Agente objetivo para resume/status (default el insignia). La liga es
    // por-agente: ?agent=openai reactiva/consulta SOLO a ese.
    const agentId = String((req.query && req.query.agent) || FLAGSHIP_AGENT_ID).toLowerCase();
    // Reactivación MANUAL tras un halt del breaker (−20%). Requiere CRON_SECRET
    // (ya validado arriba) — solo Lety revive al agente, y queda documentado.
    if (action === 'resume') {
      const result = await runArenaResume({ agentId });
      return res.status(200).json({ action: 'resume', ...result });
    }
    if (action === 'status') {
      // Sin ?agent: el estado de TODOS los agentes activos. Con ?agent: uno.
      if (req.query && req.query.agent) {
        return res.status(200).json({ action: 'status', agent: agentId, state: await getArenaState(agentId) });
      }
      const agents = activeAgents();
      const states = {};
      await Promise.all(agents.map(async (a) => { states[a.id] = await getArenaState(a.id); }));
      return res.status(200).json({ action: 'status', states });
    }
    if (phase === 'reconcile') {
      const summary = await runArenaReconcile({});
      await beat('arena:reconcile', 'ok', { halted: summary && summary.halted });
      return res.status(200).json({ phase, ...summary });
    }
    // ── T2 #7: corrida MATUTINA POR EVENTO post-earnings ──────────────
    // Cron aparte (vercel.json, 14:50 UTC L-V, 10 min después del reconcile).
    // Solo corre el pipeline si alguna posición del libro reportó; si no,
    // journalea la fila marcadora y sale. El reconcile previo hace que los
    // fills de la apertura ya estén en el journal cuando el PM decide.
    if (phase === 'morning') {
      let preMorningReconcile = null;
      try { preMorningReconcile = await runArenaReconcile({}); }
      catch (e) { preMorningReconcile = { error: String((e && e.message) || e) }; }
      const summary = await runArenaMorning({ baseUrl: resolveBaseUrl(req) });
      await beat('arena:morning', 'ok', { agents: summary && summary.agents ? summary.agents.length : 0 });
      return res.status(200).json({ phase: 'morning', ...summary, pre_morning_reconcile: preMorningReconcile });
    }
    // ── Reconcile PRE-DECIDE (true-up del journal antes de reinyectar el plan) ──
    // Los fills que aterrizan DESPUÉS del reconcile de las 14:40 eran invisibles
    // para el decide de las 22:40: GOOGL llenó 16:54 y el PM la narró "pending
    // order, monitor" sin analizarla. Las posiciones live YA viajaban al prompt
    // (portfolioSnapshot); el único surface stale es `previous.orders`, que el
    // decide lee del journal y que solo el reconcile actualiza. Correrlo aquí,
    // justo antes de la liga, hace que el fill tardío llegue al journal a tiempo
    // para que el plan reinyectado lo refleje. Barato: solo re-consulta las
    // órdenes que el pase de las 14:40 dejó no-terminales (justo las que pudieron
    // llenar tarde). NO late `arena:reconcile` — ese heartbeat es del cron de las
    // 14:40; latirlo aquí enmascararía un cron matutino muerto. Best-effort: un
    // tropiezo del reconcile no debe frenar la decisión del día.
    let preDecideReconcile = null;
    try { preDecideReconcile = await runArenaReconcile({}); }
    catch (e) { preDecideReconcile = { error: String((e && e.message) || e) }; }

    const baseUrl = resolveBaseUrl(req);
    const summary = await runArenaLeague({ baseUrl });
    // Latido del cron (detecta un cron muerto). La liga corre N agentes → el
    // payload cuenta cuántos decidieron, no las acciones de uno solo.
    await beat('arena:decide', 'ok', { agents: summary && summary.agents ? summary.agents.length : null });
    return res.status(200).json({ phase: 'decide', ...summary, pre_decide_reconcile: preDecideReconcile, rules: ARENA_RULES });
  } catch (err) {
    return res.status(500).json({ error: 'arena-run: ' + (err && err.message ? err.message : 'unknown') });
  }
}
