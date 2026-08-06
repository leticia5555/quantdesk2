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
  upsertScreener, markScreenerLedger, screenerStats,
} from './_lib/screener-db.js';
import { universeLedgerEntries, auditUniverse } from './_lib/screener-universe.js';
import { fetchFundamentals } from './_lib/finnhub-dive.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { getSymbolMap, getSymbolTypes } from './earnings.js';
import { beat } from './_lib/heartbeat.js';

// El refresh procesa ≤30 símbolos con ~1.2s de espacio entre cada uno + I/O de
// Finnhub/Yahoo: en la práctica pasa de los 60s del default de Vercel y muere con
// 504 FUNCTION_INVOCATION_TIMEOUT. La cuenta es plan Pro (tope 300s), así que
// subimos el límite de ESTA función a 5 min. (vercel.json fija 60s file-wide para
// api/*.js; este export por-archivo lo sobreescribe solo aquí.)
export const maxDuration = 300;

// PER_RUN=80: con maxDuration=300 (arriba) el wall real es 300s, no los 60s del
// default de Vercel para el que se calibró el 30 viejo. A ~2-2.5s/símbolo
// (SPACING + I/O de Finnhub/Yahoo) → ~200s, con margen para cold start. 80/run ×
// 6 runs/día (cron cada 4h) = 480/día → el universo v2 (~300) se cicla en <1 día.
// El cap Finnhub 60/min NO es el cuello: el SPACING de 1.2s ya topa en ~50/min
// pase lo que pase con el tamaño del universo. (Un run que roce los 300s muere
// con 504, pero el ledger es reanudable —pickStaleSymbols drena lo más viejo—
// así que el fallo es benigno, sin pérdida de datos.)
const PER_RUN = 80;
const SPACING_MS = 1200;    // ~1.2s entre símbolos → ~50/min, muy bajo el cap Finnhub 60/min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// media de los últimos n cierres completos; null si no hay suficiente historia.
function meanLast(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

async function priceAndMAs(symbol, now) {
  try {
    const raw = await fetchDailySeries(symbol, '1y'); // ~252 sesiones → alcanza para MA200
    const series = raw ? completedSlice(raw, now) : null;
    const closes = series && Array.isArray(series.closes) ? series.closes : [];
    if (!closes.length) return { last_close: null, ma50: null, ma200: null };
    return {
      last_close: closes[closes.length - 1],
      ma50: meanLast(closes, 50),
      ma200: meanLast(closes, 200),
    };
  } catch (e) {
    return { last_close: null, ma50: null, ma200: null };
  }
}

async function runRefresh(finnhubKey, now) {
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
      const [fund, px] = await Promise.all([
        fetchFundamentals(symbol, finnhubKey),   // Finnhub stock/metric
        priceAndMAs(symbol, now),                 // Yahoo daily series
      ]);
      if (!fund && px.last_close == null) {
        // En el map pero sin datos HOY → transitorio (rate limit / cobertura
        // temporal). Reintentable: 'error', nunca 'not_found'.
        await markScreenerLedger(symbol, { status: 'error', attempts: attempts + 1, error_msg: 'sin datos (Finnhub+Yahoo) — transitorio' });
        results.push({ symbol, status: 'error' });
      } else {
        const f = fund || {};
        await upsertScreener(symbol, {
          security_type: types[symbol] || null,
          last_close: px.last_close, ma50: px.ma50, ma200: px.ma200,
          pe_ttm: f.peTTM ?? null, ps_ttm: f.psTTM ?? null,
          gross_margin: f.grossMarginTTM ?? null, net_margin: f.netMarginTTM ?? null,
          debt_to_equity: f.debtToEquity ?? null, roe_ttm: f.roeTTM ?? null,
          rev_growth_yoy: f.revenueGrowthTTMYoy ?? null,
        });
        await markScreenerLedger(symbol, { status: 'done', error_msg: null });
        results.push({ symbol, status: 'done' });
      }
    } catch (e) {
      await markScreenerLedger(symbol, { status: 'error', attempts: attempts + 1, error_msg: String((e && e.message) || e) });
      results.push({ symbol, status: 'error' });
    }
    if (i < pending.length - 1) await sleep(SPACING_MS);
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
