#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// scripts/gen-screener-universe.mjs — REGENERA el universo del screener
// corriendo los criterios de liquidez contra el symbol map US de HOY
// (expansión de universo v2, 2026-08-06). NADA a mano.
//
// Qué hace, en dos fases (para respetar el cap Finnhub 60/min):
//   FASE 0 — symbol map US de Finnhub → gate de TIPOS (equity común + ADR +
//            REIT, el mismo gate del guard, vía gateByType). Sale el pool de
//            candidatos (~miles).
//   FASE 1 — LIQUIDEZ (Yahoo, NO cuenta al cap de Finnhub): por candidato,
//            ADV en dólares (chart 3mo, misma cuenta que /ticker-search?
//            liquidity=) + último cierre (precio). Filtra precio≥$1 y ADV≥$1M,
//            rankea por ADV desc, y se queda con top (N × margen).
//   FASE 2 — CAP (Finnhub profile2, 1 llamada/finalista → ~N calls, ~8 min a
//            1.2s de spacing, MUY bajo 60/min): capitalización de los
//            finalistas. Filtra cap≥--min-cap, re-rankea por ADV, corta a N.
//
// El orden (liquidez barata primero, cap caro solo a los finalistas) mantiene
// las llamadas Finnhub en ~N, no en miles. Es un job OFFLINE reanudable
// (checkpoint en disco): el symbol map US no cambia intradía y los
// fundamentales son trimestrales, así que correrlo de vez en cuando basta.
//
// USO:
//   FINNHUB_API_KEY=... node scripts/gen-screener-universe.mjs \
//       --n=300 --min-cap=2e9 [--write] [--checkpoint=path.json] [--limit-scan=N]
//
//   (sin --write imprime el array y el diagnóstico, no toca el archivo)
//   (--limit-scan acota la FASE 1 para pruebas / tandas)
//
// ENV: FINNHUB_API_KEY (obligatorio).
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gateByType, selectUniverse, formatUniverseArray, DEFAULT_MIN_CAP_USD } from '../api/_lib/screener-universe-gen.js';
import { ARENA_RULES } from '../api/_lib/arena-guard.js';
import { ADV_THRESHOLD_USD } from '../api/ticker-search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNIVERSE_FILE = resolve(__dirname, '../api/_lib/screener-universe.js');
const YH = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const FINNHUB = 'https://finnhub.io/api/v1';

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { n: 300, minCap: DEFAULT_MIN_CAP_USD, write: false, checkpoint: null, limitScan: Infinity, spacingMs: 1200 };
  for (const arg of argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'write') a.write = true;
    else if (k === 'n') a.n = Number(v);
    else if (k === 'min-cap') a.minCap = v === 'none' ? null : Number(v);
    else if (k === 'checkpoint') a.checkpoint = v;
    else if (k === 'limit-scan') a.limitScan = Number(v);
    else if (k === 'spacing-ms') a.spacingMs = Number(v);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.error(...m); // diagnóstico a stderr; el array va a stdout

// ── FX spot → USD (cache en proceso), misma lógica que ticker-search ──
const fxCache = new Map();
async function fxToUsd(currency) {
  if (!currency || currency === 'USD') return 1;
  if (fxCache.has(currency)) return fxCache.get(currency);
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(currency + 'USD=X')}?range=1d&interval=1d`, YH);
    if (!r.ok) return null;
    const data = await r.json();
    const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const val = Number.isFinite(rate) && rate > 0 ? rate : null;
    fxCache.set(currency, val);
    return val;
  } catch { return null; }
}

// ── FASE 1: ADV en dólares + último cierre desde un solo chart Yahoo 3mo ──
// Misma cuenta que ticker-search.liquidityCheck (Σ cierre·volumen / n) pero
// devolviendo TAMBIÉN el precio, para no gastar una llamada extra por el precio.
async function advAndPrice(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`, YH);
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const volumes = q.volume || [];
    let sum = 0, n = 0, lastClose = null;
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] > 0 && volumes[i] > 0) { sum += closes[i] * volumes[i]; n++; }
      if (closes[i] > 0) lastClose = closes[i];
    }
    if (n < 5) return null;
    const currency = result.meta?.currency || 'USD';
    const rate = await fxToUsd(currency);
    if (rate == null) return null;
    return { adv_usd: Math.round((sum / n) * rate), price: lastClose != null ? lastClose * rate : null };
  } catch { return null; }
}

// ── FASE 2: capitalización (Finnhub profile2 → marketCapitalization en M USD) ──
async function capUsd(symbol, key) {
  try {
    const r = await fetch(`${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`);
    if (!r.ok) return null;
    const p = await r.json();
    return Number.isFinite(p?.marketCapitalization) ? p.marketCapitalization * 1_000_000 : null;
  } catch { return null; }
}

// ── symbol map US (nombre + tipo) ────────────────────────────────────
async function fetchSymbolMap(key) {
  const r = await fetch(`${FINNHUB}/stock/symbol?exchange=US&token=${key}`);
  if (!r.ok) throw new Error(`symbol map HTTP ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) throw new Error('symbol map vacío');
  const map = {}, types = {};
  for (const s of list) {
    if (!s || !s.symbol) continue;
    if (s.description) map[s.symbol] = s.description;
    if (s.type) types[s.symbol] = s.type;
  }
  return { map, types, total: list.length };
}

// ── checkpoint (reanudable) ──────────────────────────────────────────
function loadCheckpoint(path) {
  if (path && existsSync(path)) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch {} }
  return { liquidity: {} };
}
function saveCheckpoint(path, cp) {
  if (path) { try { writeFileSync(path, JSON.stringify(cp)); } catch (e) { log('  checkpoint no guardado:', e.message); } }
}

// ── escribe el array regenerado en screener-universe.js ──────────────
function writeUniverseFile(symbols) {
  const src = readFileSync(UNIVERSE_FILE, 'utf8');
  const arrayBody = formatUniverseArray(symbols);
  const stamp = `  // ── Regenerado por scripts/gen-screener-universe.mjs (expansión v2). NO editar a mano. ──`;
  const replaced = src.replace(
    /const US_SCREENER_UNIVERSE = \[[\s\S]*?\n\];/,
    `const US_SCREENER_UNIVERSE = [\n${stamp}\n${arrayBody}\n];`
  );
  if (replaced === src) throw new Error('no se encontró el bloque US_SCREENER_UNIVERSE para reemplazar');
  writeFileSync(UNIVERSE_FILE, replaced);
}

async function main() {
  const args = parseArgs(process.argv);
  const key = process.env.FINNHUB_API_KEY;
  if (!key) { log('ERROR: FINNHUB_API_KEY no configurada.'); process.exit(1); }

  log(`\n═══ Regeneración del universo del screener (v2) ═══`);
  log(`  N=${args.n}  min-cap=${args.minCap == null ? 'sin piso' : args.minCap}  min-price=$${ARENA_RULES.min_price}  min-adv=$${ADV_THRESHOLD_USD}  write=${args.write}`);

  // FASE 0 — symbol map + gate de tipos
  log('\nFASE 0 — symbol map US + gate de tipos (equity común + ADR + REIT)…');
  const { map, types, total } = await fetchSymbolMap(key);
  const candidates = gateByType(map, types);
  log(`  symbol map: ${total} símbolos → ${candidates.length} candidatos tras el gate de tipos`);

  // FASE 1 — liquidez (Yahoo) para todo el pool
  const cp = loadCheckpoint(args.checkpoint);
  const scan = candidates.slice(0, args.limitScan === Infinity ? candidates.length : args.limitScan);
  log(`\nFASE 1 — liquidez (ADV + precio) de ${scan.length} candidatos vía Yahoo…`);
  const liquid = [];
  for (let i = 0; i < scan.length; i++) {
    const c = scan[i];
    let m = cp.liquidity[c.symbol];
    if (m === undefined) {
      m = await advAndPrice(c.symbol);
      cp.liquidity[c.symbol] = m; // cachea también el null (no re-escanea muertos)
      if (i % 25 === 0) { saveCheckpoint(args.checkpoint, cp); log(`  …${i}/${scan.length}`); }
      await sleep(200); // cortesía con Yahoo (no es el cap de Finnhub)
    }
    if (m && m.adv_usd >= ADV_THRESHOLD_USD && m.price != null && m.price >= ARENA_RULES.min_price) {
      liquid.push({ ...c, adv_usd: m.adv_usd, price: m.price });
    }
  }
  saveCheckpoint(args.checkpoint, cp);
  liquid.sort((a, b) => b.adv_usd - a.adv_usd);
  const margin = Math.ceil(args.n * 1.3);
  const finalists = liquid.slice(0, margin);
  log(`  ${liquid.length} pasan precio+ADV → ${finalists.length} finalistas (top N×1.3) van a la fase de cap`);

  // FASE 2 — cap (Finnhub) solo para los finalistas, a 60/min con margen
  log(`\nFASE 2 — capitalización de ${finalists.length} finalistas vía Finnhub (spacing ${args.spacingMs}ms → ~${Math.round(60000 / args.spacingMs)}/min)…`);
  const rows = [];
  for (let i = 0; i < finalists.length; i++) {
    const f = finalists[i];
    const cap = args.minCap == null ? null : await capUsd(f.symbol, key);
    rows.push({ ...f, cap_usd: cap });
    if (args.minCap != null && i < finalists.length - 1) await sleep(args.spacingMs);
  }

  // Selección determinista (misma lógica testeada, sin red)
  const { symbols, stats } = selectUniverse(rows, {
    n: args.n, minPrice: ARENA_RULES.min_price, minAdvUsd: ADV_THRESHOLD_USD, minCapUsd: args.minCap,
  });

  log('\n═══ Resultado ═══');
  log(JSON.stringify(stats, null, 2));

  if (args.write) {
    writeUniverseFile(symbols);
    log(`\n✓ ${symbols.length} símbolos escritos en ${UNIVERSE_FILE}`);
    log('  Reseedeá el ledger: GET /api/arena-screener?job=seed (o esperá la siembra perezosa del refresh).');
  } else {
    log('\n(dry-run — sin --write. Array regenerado a stdout:)');
    console.log(formatUniverseArray(symbols));
  }
}

main().catch((e) => { log('ERROR:', e && e.message ? e.message : e); process.exit(1); });
