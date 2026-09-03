// ═══════════════════════════════════════════════════════════════════
// api/arena-screener.js — cron de precompute del canal SCREENER del Arena.
//
//   GET /api/arena-screener?job=refresh  (default) — refresca ≤PER_RUN símbolos
//   GET /api/arena-screener?job=seed               — siembra el ledger (universo)
//   GET /api/arena-screener?job=status             — stats (sin escribir)
//   GET /api/arena-screener?job=audit              — universo vs. symbol map US
//        de Finnhub: reporta los tickers muertos (delisted/renombrados) sin
//        escribir. El refresh los marca `not_found` solo; audit es el diagnóstico.
//
// Llena arena_screener con métricas por símbolo: fundamentales (Finnhub
// stock/metric, reusa fetchFundamentals) + precio/MA (Yahoo, plumbing del
// simulador). El arena-run SOLO LEE esa tabla → cero llamadas en la corrida.
// Los fundamentales cambian por trimestre: refresh lento OK. Se drena por
// antigüedad (refreshed_at más viejo / nunca) → universo completo cada ~1 día.
//
// GATES (en orden): CRON_SECRET (si existe) → ARENA_SCREENER_ENABLED=1.
// ENV VARS: FINNHUB_API_KEY · DATABASE_URL · CRON_SECRET (opc) ·
//           ARENA_SCREENER_ENABLED
// ═══════════════════════════════════════════════════════════════════

import {
  ensureScreenerSchema, seedScreenerLedger, pickStaleSymbols,
  upsertScreener, markScreenerLedger, screenerStats, readEstimateHistory,
} from './_lib/screener-db.js';
import { universeLedgerEntries, auditUniverse } from './_lib/screener-universe.js';
import { fetchFundamentals, fetchEarningsHistory, fetchNextEstimate, fetchRecommendations } from './_lib/finnhub-dive.js';
import { priceMomentum, recommendationTrend } from './_lib/temporal-fundamentals.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { getSymbolMap, getSymbolTypes } from './earnings.js';
import { beat } from './_lib/heartbeat.js';

// El refresh procesa ≤30 símbolos con ~1.2s de espacio entre cada uno + I/O de
// Finnhub/Yahoo: en la práctica pasa de los 60s del default de Vercel y muere con
// 504 FUNCTION_INVOCATION_TIMEOUT. La cuenta es plan Pro (tope 300s), así que
// subimos el límite de ESTA función a 5 min. (vercel.json fija 60s file-wide para
// api/*.js; este export por-archivo lo sobreescribe solo aquí.)
export const maxDuration = 300;

const PER_RUN = 30;         // ≤30 símbolos/invocación (universo ~150 → ~1 día con 6 corridas)
// Espacio entre símbolos. La aritmética CAMBIÓ con la capa temporal: antes era
// 1 request Finnhub por símbolo (stock/metric) y 1.2s bastaba (≈50 req/min).
// Ahora son CINCO (metric + earnings + financials-reported + calendar/earnings
// + recommendation), así que 1.2s daría ~250 req/min y reventaría el cap de
// 60/min del tier gratis. 5.5s → ~54 req/min, bajo el cap; 30 símbolos ≈ 165s
// + I/O, holgado dentro de los 300s de la función.
const SPACING_MS = 5500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// media de los últimos n cierres completos; null si no hay suficiente historia.
function meanLast(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

// La MISMA serie de 1 año sirve para las medias móviles Y para el MOMENTUM
// (retornos 1m/3m/6m + distancia al máximo de 52 semanas): un solo fetch.
async function priceAndMAs(symbol, now) {
  const empty = { last_close: null, ma50: null, ma200: null, momentum: null };
  try {
    const raw = await fetchDailySeries(symbol, '1y'); // ~252 sesiones → alcanza para MA200
    const series = raw ? completedSlice(raw, now) : null;
    const closes = series && Array.isArray(series.closes) ? series.closes : [];
    if (!closes.length) return empty;
    return {
      last_close: closes[closes.length - 1],
      ma50: meanLast(closes, 50),
      ma200: meanLast(closes, 200),
      momentum: priceMomentum(series),
    };
  } catch (e) {
    return empty;
  }
}

// Snapshot nuevo del estimado de consenso → historial acumulado.
//
// La serie tiene que llegar hasta ~90 días atrás (la ventana larga de
// `estimateRevisions`), pero NO hace falta resolución diaria en la cola: la
// ventana de 90d acepta 45-135 días, así que un punto por semana la cubre. Se
// RALEA en vez de truncar — truncar a N entradas recientes dejaría la ventana
// de 90 días permanentemente muda (el bug obvio de "guardar las últimas 12").
//
//   · un snapshot por DÍA como máximo (el cron corre cada 4h; el mismo día pisa),
//   · resolución diaria en los últimos RECENT_DAYS,
//   · un punto por semana más atrás, hasta HORIZON_DAYS,
//   · tope duro de MAX_ESTIMATE_SNAPSHOTS entradas.
const MAX_ESTIMATE_SNAPSHOTS = 30;
const RECENT_DAYS = 10;
const HORIZON_DAYS = 130;

export function mergeEstimateHistory(history, snapshot) {
  const valid = (h) => h && typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date);
  const list = (Array.isArray(history) ? history : []).filter(valid);
  const merged = snapshot && valid(snapshot)
    ? [snapshot, ...list.filter((h) => h.date !== snapshot.date)]
    : list;
  const sorted = merged.sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) return [];

  const newest = Date.parse(sorted[0].date);
  const out = [];
  const weeks = new Set();
  for (const h of sorted) {
    const age = (newest - Date.parse(h.date)) / 86400000;
    if (age > HORIZON_DAYS) break;
    if (age <= RECENT_DAYS) { out.push(h); continue; }
    const week = Math.floor(age / 7);
    if (weeks.has(week)) continue; // ya hay un punto de esa semana (el más nuevo)
    weeks.add(week);
    out.push(h);
    if (out.length >= MAX_ESTIMATE_SNAPSHOTS) break;
  }
  return out.slice(0, MAX_ESTIMATE_SNAPSHOTS);
}

// `spacingMs` inyectable: los tests corren sin la espera real (el espaciado
// existe por el cap de Finnhub, no por lógica). Producción usa el default.
async function runRefresh(finnhubKey, now, { spacingMs = SPACING_MS } = {}) {
  const pending = await pickStaleSymbols(PER_RUN);
  if (!pending.length) return { job: 'refresh', done: true, note: 'ledger vacío — corré ?job=seed', stats: await screenerStats() };

  // El symbol map US de Finnhub sirve para DOS cosas (mismo fetch/cache → 0
  // requests extra entre map y types): el tipo de instrumento y —nuevo— detectar
  // tickers muertos. Ausente del map = ya no cotiza (delisted/renombrado): se
  // marca terminal y NO se le gastan llamadas. Si el map NO cargó (Finnhub caído)
  // no delisteamos a ciegas: se trata todo como transitorio (fail-safe).
  const symbolMap = (await getSymbolMap(finnhubKey).catch(() => null)) || {};
  const types = (await getSymbolTypes(finnhubKey).catch(() => null)) || {};
  const mapLoaded = Object.keys(symbolMap).length > 0;

  const results = [];
  for (let i = 0; i < pending.length; i++) {
    const { symbol, attempts } = pending[i];
    // Ticker muerto (delisted/renombrado): terminal `not_found`, sin gastar
    // Finnhub/Yahoo ni reintentar cada ciclo. Distinto de 'error' (transitorio).
    if (mapLoaded && !(symbol in symbolMap)) {
      await markScreenerLedger(symbol, { status: 'not_found', error_msg: 'ausente del symbol map US de Finnhub (delisted o cambió de símbolo)' });
      results.push({ symbol, status: 'not_found' });
      continue;
    }
    try {
      const [fund, px, hist, estimate, recs, prevEstimates] = await Promise.all([
        fetchFundamentals(symbol, finnhubKey),      // Finnhub stock/metric (la FOTO)
        priceAndMAs(symbol, now),                   // Yahoo daily series (MAs + momentum)
        fetchEarningsHistory(symbol, finnhubKey),   // la PELÍCULA: ingresos YoY + sorpresa EPS
        fetchNextEstimate(symbol, finnhubKey, now), // estimado del próximo reporte (para revisiones)
        fetchRecommendations(symbol, finnhubKey),   // serie de ratings → tendencia (fallback día 0)
        readEstimateHistory(symbol).catch(() => []),
      ]);
      if (!fund && px.last_close == null) {
        // En el map pero sin datos HOY → transitorio (rate limit / cobertura
        // temporal). Reintentable: 'error', nunca 'not_found'.
        await markScreenerLedger(symbol, { status: 'error', attempts: attempts + 1, error_msg: 'sin datos (Finnhub+Yahoo) — transitorio' });
        results.push({ symbol, status: 'error' });
      } else {
        const f = fund || {};
        const m = px.momentum || null;
        await upsertScreener(symbol, {
          security_type: types[symbol] || null,
          last_close: px.last_close, ma50: px.ma50, ma200: px.ma200,
          pe_ttm: f.peTTM ?? null, ps_ttm: f.psTTM ?? null,
          gross_margin: f.grossMarginTTM ?? null, net_margin: f.netMarginTTM ?? null,
          debt_to_equity: f.debtToEquity ?? null, roe_ttm: f.roeTTM ?? null,
          rev_growth_yoy: f.revenueGrowthTTMYoy ?? null,
          // ── capa temporal: SERIES crudas, no etiquetas (los umbrales se
          // aplican al leer, así cambiarlos no obliga a re-crawlear) ──
          rev_yoy_history: hist && hist.revenueHistory && hist.revenueHistory.length ? hist.revenueHistory : null,
          eps_surprise_history: hist && hist.epsSurprises && hist.epsSurprises.length ? hist.epsSurprises : null,
          // Tendencia del rating (hoy vs. 30/90d). El deep dive del run la
          // recalcula fresca para sus ≤5 candidatos; el cron la cubre para TODO
          // el universo — que es lo que necesitan el SCAN y las posiciones del
          // libro, que nunca pasan por el deep dive.
          rec_trend: recommendationTrend(recs, { now }),
          estimate_history: mergeEstimateHistory(prevEstimates, estimate),
          ret_1m: m ? m.ret_1m : null, ret_3m: m ? m.ret_3m : null, ret_6m: m ? m.ret_6m : null,
          dist_52w_high_pct: m ? m.dist_52w_high_pct : null,
        });
        await markScreenerLedger(symbol, { status: 'done', error_msg: null });
        results.push({ symbol, status: 'done' });
      }
    } catch (e) {
      await markScreenerLedger(symbol, { status: 'error', attempts: attempts + 1, error_msg: String((e && e.message) || e) });
      results.push({ symbol, status: 'error' });
    }
    if (i < pending.length - 1 && spacingMs > 0) await sleep(spacingMs);
  }
  return { job: 'refresh', processed: results, stats: await screenerStats() };
}

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
  if (process.env.ARENA_SCREENER_ENABLED !== '1') {
    await beat('screener:refresh', 'disabled');
    return res.status(200).json({ disabled: true, hint: 'ARENA_SCREENER_ENABLED != 1' });
  }

  const job = String((req.query && req.query.job) || 'refresh').toLowerCase();
  try {
    await ensureScreenerSchema();

    if (job === 'seed') {
      const inserted = await seedScreenerLedger(universeLedgerEntries());
      return res.status(200).json({ job: 'seed', inserted, stats: await screenerStats() });
    }
    if (job === 'status') {
      return res.status(200).json({ job: 'status', stats: await screenerStats() });
    }
    if (job === 'audit') {
      // Auditoría read-only del universo contra el symbol map US de Finnhub.
      const finnhubKey = process.env.FINNHUB_API_KEY;
      if (!finnhubKey) return res.status(200).json({ job: 'audit', error: 'FINNHUB_API_KEY not set' });
      const symbolMap = await getSymbolMap(finnhubKey);
      // Sin map (Finnhub caído) NO auditamos: todo el universo se vería "missing"
      // y sería un falso positivo peligroso (marcaría vivos como muertos).
      if (!symbolMap || !Object.keys(symbolMap).length) {
        return res.status(200).json({ job: 'audit', error: 'symbol map US no disponible (Finnhub caído) — no se audita a ciegas' });
      }
      return res.status(200).json({ job: 'audit', ...auditUniverse(symbolMap) });
    }

    // default: refresh
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) return res.status(200).json({ job: 'refresh', error: 'FINNHUB_API_KEY not set' });
    // Siembra perezosa: si el ledger está vacío, sembrar el universo antes de refrescar.
    const stats = await screenerStats();
    if (!stats.ledger.total) await seedScreenerLedger(universeLedgerEntries());
    const out = await runRefresh(finnhubKey, new Date());
    await beat('screener:refresh', 'ok', { processed: out && out.processed ? out.processed.length : null });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'arena-screener: ' + (err && err.message ? err.message : 'unknown') });
  }
}

export { runRefresh };
