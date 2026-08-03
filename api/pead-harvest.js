// ═══════════════════════════════════════════════════════════════════
// api/pead-harvest.js — cron de cosecha del dataset PEAD (Fase 1).
//
//   GET /api/pead-harvest?job=earnings   (default) — goteo de AV, ≤5 símbolos
//   GET /api/pead-harvest?job=hour                 — etiqueta BMO/AMC vía SEC
//   GET /api/pead-harvest?job=seed                 — siembra el ledger v0
//   GET /api/pead-harvest?job=status               — stats (sin escribir)
//
// GATES (en orden): CRON_SECRET (si existe) → PEAD_HARVEST_ENABLED=1.
// El goteo respeta AV free = 25 req/día (guard pead_api_budget) y ~5/min
// (≤5 símbolos por invocación, ~11s de espacio). El job `earnings` NO vive en
// vercel.json: lo dispara GitHub Actions 5 veces al día (12,14,16,18,20 UTC) =
// 25 símbolos/día — el Hobby de Vercel limita crons a 1×/día. Ver docs/crons.md
// y docs/pead-backtest-scope.md §"Plan de cosecha". (El job `hour` sí sigue en
// vercel.json: es 1×/día.)
//
// ENV VARS: ALPHAVANTAGE_API_KEY · DATABASE_URL · CRON_SECRET (opc) ·
//           PEAD_HARVEST_ENABLED
// ═══════════════════════════════════════════════════════════════════

import {
  ensurePeadSchema, seedLedger, pickPending, markLedger, ledgerStats,
  upsertEarnings, eventsMissingHour, upsertEventHour, budgetUsed, budgetAdd,
} from './_lib/pead-db.js';
import { fetchEarnings } from './_lib/av-earnings.js';
import { classifyHourFromET, match8K, collect8Ks, loadTickerMap } from './_lib/pead-hour.js';
import { v0LedgerEntries } from './_lib/pead-universe.js';
import { beat } from './_lib/heartbeat.js';

const DAILY_CAP = 25;          // AV free tier
const PER_RUN = 5;             // ≤5/invocación → ~5/min, cabe en 60s
const SPACING_MS = 11000;      // ~11s entre llamadas AV
const HOUR_BATCH = 40;         // eventos SEC por corrida (SEC es ilimitado)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utcDay = () => new Date().toISOString().split('T')[0];

// ─────────────────── job: earnings (goteo AV) ───────────────────
async function runEarningsHarvest(apiKey) {
  const day = utcDay();
  const used = await budgetUsed(day);
  const remaining = DAILY_CAP - used;
  if (remaining <= 0) {
    return { job: 'earnings', skipped: 'daily_cap_reached', used, cap: DAILY_CAP };
  }

  const batch = Math.min(PER_RUN, remaining);
  const pending = await pickPending(batch);
  if (!pending.length) {
    return { job: 'earnings', done: true, note: 'no pending symbols', ledger: await ledgerStats() };
  }

  const results = [];
  for (let i = 0; i < pending.length; i++) {
    const { symbol, attempts } = pending[i];
    const res = await fetchEarnings(symbol, apiKey);
    // El presupuesto se gasta con la llamada, haya datos o no.
    await budgetAdd(day, 1);

    if (res.status === 'ok') {
      const n = await upsertEarnings(symbol, res.events);
      await markLedger(symbol, { status: 'done', quarters_fetched: n, error_msg: null });
      results.push({ symbol, status: 'done', quarters: n });
    } else if (res.status === 'rate_limited') {
      // No marcar done: dejar pending, reintentar en la próxima corrida.
      await markLedger(symbol, { attempts: attempts + 1, error_msg: 'rate_limited' });
      results.push({ symbol, status: 'rate_limited' });
      break; // si AV ya nos limita, no gastar el resto del batch
    } else if (res.status === 'empty') {
      await markLedger(symbol, { status: 'delisted', error_msg: res.message || 'no data' });
      results.push({ symbol, status: 'empty' });
    } else {
      await markLedger(symbol, { attempts: attempts + 1, error_msg: res.message || res.status });
      results.push({ symbol, status: res.status });
    }

    if (i < pending.length - 1) await sleep(SPACING_MS);
  }

  return {
    job: 'earnings', day, used: await budgetUsed(day), cap: DAILY_CAP,
    processed: results, ledger: await ledgerStats(),
  };
}

// ─────────────────── job: hour (SEC 8-K → BMO/AMC) ───────────────────
async function runHourTagging() {
  const missing = await eventsMissingHour(HOUR_BATCH);
  if (!missing.length) return { job: 'hour', done: true, note: 'no events missing hour' };

  const tickerMap = await loadTickerMap();

  // Agrupar por símbolo → una carga de submissions por símbolo, no por evento.
  const bySymbol = new Map();
  for (const ev of missing) {
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev.reported_date);
  }

  const summary = { tagged: 0, unmatched: 0, no_cik: 0, symbols: 0 };
  for (const [symbol, dates] of bySymbol) {
    summary.symbols++;
    const hit = tickerMap[symbol.toUpperCase()];
    if (!hit) {
      // Sin CIK (p.ej. ADR que presenta 6-K) → dejar sin hora; el respaldo de
      // gap se resuelve en tiempo de análisis con precios. Marcamos null-source.
      for (const d of dates) {
        await upsertEventHour({ symbol, reported_date: d, hour: null, source: null });
        summary.no_cik++;
      }
      continue;
    }
    const paddedCik = hit.cik.padStart(10, '0');
    const sinceDate = dates.slice().sort()[0];
    let index = [];
    try {
      index = await collect8Ks(paddedCik, sinceDate);
    } catch (e) {
      continue; // reintenta en la próxima corrida
    }
    for (const d of dates) {
      const f = match8K(index, d, 1);
      if (f && f.acceptanceDateTime) {
        const hour = classifyHourFromET(f.acceptanceDateTime);
        await upsertEventHour({
          symbol, reported_date: d, hour, source: 'sec_8k',
          accepted_at_et: f.acceptanceDateTime, accession: f.accession,
        });
        summary.tagged++;
      } else {
        // Sin 8-K casado → null; el análisis aplicará la heurística de gap.
        await upsertEventHour({ symbol, reported_date: d, hour: null, source: null });
        summary.unmatched++;
      }
    }
  }
  return { job: 'hour', ...summary };
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
  const job = String((req.query && req.query.job) || 'earnings').toLowerCase();

  if (process.env.PEAD_HARVEST_ENABLED !== '1') {
    if (job === 'earnings' || job === 'hour') await beat('pead:' + job, 'disabled');
    return res.status(200).json({ disabled: true, hint: 'PEAD_HARVEST_ENABLED != 1' });
  }
  try {
    await ensurePeadSchema();

    if (job === 'seed') {
      const inserted = await seedLedger(v0LedgerEntries());
      return res.status(200).json({ job: 'seed', inserted, ledger: await ledgerStats() });
    }
    if (job === 'status') {
      return res.status(200).json({ job: 'status', day: utcDay(), used: await budgetUsed(utcDay()), cap: DAILY_CAP, ledger: await ledgerStats() });
    }
    if (job === 'hour') {
      const out = await runHourTagging();
      await beat('pead:hour', 'ok', { tagged: out.tagged ?? null, done: out.done ?? null });
      return res.status(200).json(out);
    }

    // default: earnings
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) return res.status(200).json({ job: 'earnings', error: 'ALPHAVANTAGE_API_KEY not set' });
    // Siembra perezosa: si el ledger está vacío, sembrar v0 antes de gotear.
    const stats = await ledgerStats();
    if (stats.pending + stats.done + stats.error + stats.delisted === 0) {
      await seedLedger(v0LedgerEntries());
    }
    const out = await runEarningsHarvest(apiKey);
    await beat('pead:earnings', out.skipped ? 'skipped' : 'ok', { used: out.used ?? null, ledger: out.ledger ?? null });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'pead-harvest: ' + (err && err.message ? err.message : 'unknown') });
  }
}

export { runEarningsHarvest, runHourTagging };
