// ═══════════════════════════════════════════════════════════════════
// api/_lib/screener-db.js — capa de datos del canal SCREENER del Arena.
//
// El cron arena-screener precomputa métricas por símbolo (fundamentales de
// Finnhub + precio/MA de Yahoo) en Neon. El arena-run SOLO LEE esta tabla —
// cero llamadas Finnhub/Yahoo en la corrida (que no cabe en la lambda de 60s).
// Mismo patrón que pead-db.js: tabla de datos + ledger reanudable.
//
// Dos tablas:
//   arena_screener        — una fila por símbolo con las métricas frescas.
//   arena_screener_ledger — estado del refresh por símbolo (reanudable).
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './db.js';

const SCREENER_SCHEMA = [
  `create table if not exists arena_screener (
     symbol          text primary key,
     security_type   text,
     last_close      numeric,
     ma50            numeric,
     ma200           numeric,
     pe_ttm          numeric,
     ps_ttm          numeric,
     gross_margin    numeric,
     net_margin      numeric,
     debt_to_equity  numeric,
     roe_ttm         numeric,
     rev_growth_yoy  numeric,
     refreshed_at    timestamptz
   )`,
  `create table if not exists arena_screener_ledger (
     symbol          text primary key,
     status          text not null default 'pending',
     attempts        int  not null default 0,
     last_attempt_at timestamptz,
     error_msg       text
   )`,
];

let screenerSchemaReady = false;
export async function ensureScreenerSchema() {
  if (screenerSchemaReady) return;
  await sqlBatch(SCREENER_SCHEMA.map((q) => [q, []]));
  screenerSchemaReady = true;
}

// Siembra idempotente del ledger (on conflict do nothing — no pisa estado).
export async function seedScreenerLedger(entries) {
  if (!entries || !entries.length) return 0;
  const values = entries.map((_, i) => `($${i + 1})`).join(', ');
  const params = entries.map((e) => e.symbol);
  const r = await sql(
    `insert into arena_screener_ledger (symbol) values ${values}
     on conflict (symbol) do nothing`, params);
  return (r && r.length) || 0;
}

// Símbolos a refrescar: los más viejos primero (refreshed_at null = nunca).
// LEFT JOIN a la tabla de datos → nulls first drena primero lo que falta.
export async function pickStaleSymbols(n = 40) {
  const rows = await sql(
    `select l.symbol, l.attempts
       from arena_screener_ledger l
       left join arena_screener s on s.symbol = l.symbol
      order by s.refreshed_at asc nulls first, l.attempts asc
      limit $1`, [n]);
  return rows.map((r) => ({ symbol: r.symbol, attempts: Number(r.attempts) || 0 }));
}

// Upsert de métricas frescas. `m` = { security_type, last_close, ma50, ma200,
// pe_ttm, ps_ttm, gross_margin, net_margin, debt_to_equity, roe_ttm, rev_growth_yoy }.
export async function upsertScreener(symbol, m) {
  await sql(
    `insert into arena_screener
       (symbol, security_type, last_close, ma50, ma200, pe_ttm, ps_ttm,
        gross_margin, net_margin, debt_to_equity, roe_ttm, rev_growth_yoy, refreshed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     on conflict (symbol) do update set
       security_type = excluded.security_type,
       last_close = excluded.last_close, ma50 = excluded.ma50, ma200 = excluded.ma200,
       pe_ttm = excluded.pe_ttm, ps_ttm = excluded.ps_ttm,
       gross_margin = excluded.gross_margin, net_margin = excluded.net_margin,
       debt_to_equity = excluded.debt_to_equity, roe_ttm = excluded.roe_ttm,
       rev_growth_yoy = excluded.rev_growth_yoy, refreshed_at = now()`,
    [symbol, m.security_type ?? null, m.last_close ?? null, m.ma50 ?? null, m.ma200 ?? null,
     m.pe_ttm ?? null, m.ps_ttm ?? null, m.gross_margin ?? null, m.net_margin ?? null,
     m.debt_to_equity ?? null, m.roe_ttm ?? null, m.rev_growth_yoy ?? null]);
}

export async function markScreenerLedger(symbol, patch = {}) {
  const sets = ['last_attempt_at = now()'];
  const params = [symbol];
  let i = 2;
  for (const [k, v] of Object.entries(patch)) {
    if (!['status', 'attempts', 'error_msg'].includes(k)) continue;
    sets.push(`${k} = $${i++}`);
    params.push(v);
  }
  await sql(`update arena_screener_ledger set ${sets.join(', ')} where symbol = $1`, params);
}

// Lectura para el arena-run: TODAS las filas con métricas (las que la screen
// evalúa). Numéricos parseados a Number (Neon los devuelve como string).
export async function readScreenerRows() {
  const rows = await sql(`select * from arena_screener`);
  const nz = (v) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    symbol: r.symbol,
    security_type: r.security_type,
    last_close: nz(r.last_close), ma50: nz(r.ma50), ma200: nz(r.ma200),
    pe_ttm: nz(r.pe_ttm), ps_ttm: nz(r.ps_ttm),
    gross_margin: nz(r.gross_margin), net_margin: nz(r.net_margin),
    debt_to_equity: nz(r.debt_to_equity), roe_ttm: nz(r.roe_ttm),
    rev_growth_yoy: nz(r.rev_growth_yoy), refreshed_at: r.refreshed_at,
  }));
}

export async function screenerStats() {
  const [led] = await sql(
    `select count(*)::int total,
            count(*) filter (where status = 'done')::int done,
            count(*) filter (where status = 'pending')::int pending,
            count(*) filter (where status = 'error')::int error
       from arena_screener_ledger`);
  const [dat] = await sql(
    `select count(*)::int rows, min(refreshed_at) oldest, max(refreshed_at) newest
       from arena_screener`);
  return { ledger: led || {}, data: dat || {} };
}
