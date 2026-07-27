// ═══════════════════════════════════════════════════════════════════
// api/arena-screener.js — cron de precompute del canal SCREENER del Arena.
//
//   GET /api/arena-screener?job=refresh  (default) — refresca ≤PER_RUN símbolos
//   GET /api/arena-screener?job=seed               — siembra el ledger (universo)
//   GET /api/arena-screener?job=status             — stats (sin escribir)
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
import { universeLedgerEntries } from './_lib/screener-universe.js';
import { fetchFundamentals } from './_lib/finnhub-dive.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { getSymbolTypes } from './earnings.js';

const PER_RUN = 30;         // ≤30 símbolos/invocación → ~40s, cabe en 60s
const SPACING_MS = 1200;    // ~1.2s entre símbolos → muy bajo el cap Finnhub 60/min

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

  const types = (await getSymbolTypes(finnhubKey).catch(() => null)) || {};
  const results = [];
  for (let i = 0; i < pending.length; i++) {
    const { symbol, attempts } = pending[i];
    try {
      const [fund, px] = await Promise.all([
        fetchFundamentals(symbol, finnhubKey),   // Finnhub stock/metric
        priceAndMAs(symbol, now),                 // Yahoo daily series
      ]);
      if (!fund && px.last_close == null) {
        await markScreenerLedger(symbol, { status: 'error', attempts: attempts + 1, error_msg: 'sin datos (Finnhub+Yahoo)' });
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

    // default: refresh
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) return res.status(200).json({ job: 'refresh', error: 'FINNHUB_API_KEY not set' });
    // Siembra perezosa: si el ledger está vacío, sembrar el universo antes de refrescar.
    const stats = await screenerStats();
    if (!stats.ledger.total) await seedScreenerLedger(universeLedgerEntries());
    return res.status(200).json(await runRefresh(finnhubKey, new Date()));
  } catch (err) {
    return res.status(500).json({ error: 'arena-screener: ' + (err && err.message ? err.message : 'unknown') });
  }
}

export { runRefresh };
