// ═══════════════════════════════════════════════════════════════
// Tests del cron de precompute del SCREENER (api/arena-screener.js) y su
// capa de datos (_lib/screener-db.js), con TODO el I/O mockeado a nivel
// fetch (Neon + Finnhub + Yahoo). Cubre el fix de tickers muertos:
//   - runRefresh marca `not_found` (terminal) los símbolos ausentes del
//     symbol map US de Finnhub, SIN gastarles llamadas Finnhub/Yahoo.
//   - fail-safe: si el map no cargó (Finnhub caído) NO delistea a ciegas.
//   - pickStaleSymbols excluye `not_found` de la rotación.
//   - seedScreenerLedger cuenta las filas REALMENTE insertadas (returning).
//   - screenerStats expone el conteo de not_found.
//   - job=audit reporta el universo vs. el symbol map.
// Correr con `node tests/screener-refresh.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { runRefresh, mergeEstimateHistory, default as handler } from '../api/arena-screener.js';
import { seedScreenerLedger, pickStaleSymbols, screenerStats } from '../api/_lib/screener-db.js';
import { _resetSymbolMapCache } from '../api/earnings.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.FINNHUB_API_KEY = 'fh-test';
process.env.ARENA_SCREENER_ENABLED = '1';

// ── estado mutable del mock ──
let pendingRows = [];          // lo que devuelve pickStaleSymbols
let symbolList = [];           // lo que devuelve /stock/symbol (symbol map US)
let seedReturnRows = [];       // filas que "returning" del seed devuelve
let dataDown = false;          // true → Finnhub metric + Yahoo caídos (sin datos)
let ledgerStats = { total: 0, done: 0, pending: 0, error: 0, not_found: 0 };
const marks = [];              // updates al ledger: { symbol, params }
const upserts = [];            // upserts a arena_screener: symbol
const metricCalls = [];        // URLs de Finnhub /stock/metric
const temporalCalls = [];      // URLs de la capa temporal (earnings/financials/calendar/recommendation)
let lastUpsertParams = null;   // params del último insert into arena_screener
const yahooCalls = [];         // URLs de Yahoo chart
let lastSelectQuery = '';      // última query select capturada

// serie Yahoo sintética (60 cierres viejos → completedSlice los conserva)
const DAY = 86400000;
const t0 = Date.UTC(2026, 0, 1);
const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
const timestamps = closes.map((_, i) => (t0 + i * DAY) / 1000);

const jsonReply = (obj, status = 200) => ({
  ok: status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});
const neonRows = (fields, rows) => jsonReply({ fields: fields.map((name) => ({ name, dataTypeID: name === 'attempts' || name.match(/total|done|pending|error|not_found|rows/) ? 23 : 25 })), rows });

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  // ── Neon (SQL sobre HTTP) ──
  if (u.includes('neon.tech')) {
    const body = JSON.parse(opts.body || '{}');
    if (body.queries) return jsonReply({ results: body.queries.map(() => ({ fields: [], rows: [] })) }); // schema batch
    const q = body.query || '';
    if (q.includes('insert into arena_screener_ledger')) {
      lastSelectQuery = q; // capturamos para asserts del returning
      return neonRows(['symbol'], seedReturnRows.map((s) => [s]));
    }
    if (q.includes('update arena_screener_ledger')) { marks.push({ query: q, params: body.params }); return neonRows([], []); }
    if (q.includes('select l.symbol')) { lastSelectQuery = q; return neonRows(['symbol', 'attempts'], pendingRows.map((r) => [r.symbol, String(r.attempts)])); }
    if (q.includes('insert into arena_screener')) { upserts.push(body.params[0]); lastUpsertParams = body.params; return neonRows([], []); }
    if (q.includes('from arena_screener_ledger')) {
      const s = ledgerStats;
      return neonRows(['total', 'done', 'pending', 'error', 'not_found'], [[s.total, s.done, s.pending, s.error, s.not_found].map(String)]);
    }
    if (q.includes('from arena_screener')) return neonRows(['rows', 'oldest', 'newest'], [['0', null, null]]);
    return neonRows([], []);
  }

  // ── Finnhub symbol map (getSymbolMap/getSymbolTypes) ──
  if (u.includes('finnhub.io/api/v1/stock/symbol')) {
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => symbolList };
  }
  // ── Finnhub fundamentals (NO debe llamarse para tickers muertos) ──
  if (u.includes('finnhub.io/api/v1/stock/metric')) {
    metricCalls.push(u);
    if (dataDown) return { ok: false, status: 500, headers: { get: () => 'text/plain' }, json: async () => null, text: async () => '' };
    return jsonReply({ metric: { peTTM: 18, roeTTM: 25, 'totalDebt/totalEquityQuarterly': 0.4 } });
  }
  // ── Finnhub: capa TEMPORAL del cron (historial + estimados + ratings) ──
  if (u.includes('finnhub.io/api/v1/stock/earnings')) {
    temporalCalls.push(u);
    return jsonReply([{ year: 2026, quarter: 2, period: '2026-06-30', actual: 2.2, estimate: 2.0, surprisePercent: 10 }]);
  }
  if (u.includes('finnhub.io/api/v1/stock/financials-reported')) {
    temporalCalls.push(u);
    const rev = (v) => ({ report: { ic: [{ concept: 'us-gaap_Revenues', value: v }] } });
    return jsonReply({ data: [
      { year: 2026, quarter: 2, endDate: '2026-06-30', filedDate: '2026-07-20', ...rev(1100) },
      { year: 2025, quarter: 2, endDate: '2025-06-30', filedDate: '2025-07-20', ...rev(1000) },
    ] });
  }
  if (u.includes('finnhub.io/api/v1/calendar/earnings')) {
    temporalCalls.push(u);
    return jsonReply({ earningsCalendar: [{ date: '2026-10-28', quarter: 3, year: 2026, epsEstimate: 2.4, revenueEstimate: 1200 }] });
  }
  if (u.includes('finnhub.io/api/v1/stock/recommendation')) {
    temporalCalls.push(u);
    return jsonReply([{ period: '2026-09-01', strongBuy: 5, buy: 5, hold: 5, sell: 0, strongSell: 0 }]);
  }
  // ── Yahoo daily series (NO debe llamarse para tickers muertos) ──
  if (u.includes('yahoo')) {
    yahooCalls.push(u);
    if (dataDown) return { ok: false, status: 500, headers: { get: () => 'text/plain' }, json: async () => null, text: async () => '' };
    return jsonReply({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } });
  }
  throw new Error('fetch inesperado en el test: ' + u);
};

// ── 1) runRefresh: ticker muerto (ausente del map) → not_found, sin fetch ──
console.log('screener-refresh: ticker muerto → not_found (terminal, sin gastar Finnhub/Yahoo)');
_resetSymbolMapCache();
symbolList = [
  { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
  { symbol: 'MSFT', description: 'MICROSOFT CORP', type: 'Common Stock' },
]; // HES ausente a propósito (delisted por Chevron)
pendingRows = [{ symbol: 'AAPL', attempts: 0 }, { symbol: 'HES', attempts: 1 }];
marks.length = 0; metricCalls.length = 0; yahooCalls.length = 0; upserts.length = 0; temporalCalls.length = 0;
const r1 = await runRefresh(process.env.FINNHUB_API_KEY, new Date('2026-07-27T23:00:00Z'), { spacingMs: 0 });
const temporalAfter1 = [...temporalCalls]; // snapshot: los escenarios siguientes reusan el array

const hesMark = marks.find((m) => m.params[0] === 'HES');
const aaplMark = marks.find((m) => m.params[0] === 'AAPL');
ok(hesMark && hesMark.params.includes('not_found'), 'HES (ausente del map) → marcado not_found', JSON.stringify(hesMark && hesMark.params));
ok(aaplMark && aaplMark.params.includes('done'), 'AAPL (en el map) → procesado y marcado done', JSON.stringify(aaplMark && aaplMark.params));
ok(!metricCalls.some((u) => u.includes('symbol=HES')), 'NO se llamó a Finnhub /stock/metric para el ticker muerto', JSON.stringify(metricCalls));
ok(!yahooCalls.some((u) => u.includes('HES')), 'NO se llamó a Yahoo para el ticker muerto');
ok(metricCalls.some((u) => u.includes('symbol=AAPL')) && yahooCalls.some((u) => u.includes('AAPL')), 'SÍ se pegó a Finnhub+Yahoo para el ticker vivo');
ok(upserts.includes('AAPL') && !upserts.includes('HES'), 'solo el ticker vivo entra a arena_screener', JSON.stringify(upserts));
ok(r1.processed.find((p) => p.symbol === 'HES').status === 'not_found' && r1.processed.find((p) => p.symbol === 'AAPL').status === 'done', 'processed refleja not_found vs done', JSON.stringify(r1.processed));

// ── 2) fail-safe: Finnhub caído (map vacío + sin datos) → error transitorio,
// NUNCA not_found (no delisteamos todo el universo por un outage). ──
console.log('screener-refresh: Finnhub caído (map vacío) → error transitorio, NO not_found');
_resetSymbolMapCache();
symbolList = [];  // /stock/symbol devuelve lista vacía → cache no se puebla → mapLoaded=false
dataDown = true;  // metric + Yahoo caídos → sin datos
pendingRows = [{ symbol: 'HES', attempts: 2 }];
marks.length = 0; metricCalls.length = 0;
await runRefresh(process.env.FINNHUB_API_KEY, new Date('2026-07-27T23:00:00Z'), { spacingMs: 0 });
dataDown = false;
const hesMark2 = marks.find((m) => m.params[0] === 'HES');
ok(hesMark2 && !hesMark2.params.includes('not_found'), 'con el map caído, HES NO se marca not_found (fail-safe: un outage no delistea)', JSON.stringify(hesMark2 && hesMark2.params));
ok(hesMark2 && hesMark2.params.includes('error'), 'con el map caído y sin datos → error transitorio (reintentable)', JSON.stringify(hesMark2 && hesMark2.params));

// ── 2-bis) capa TEMPORAL: el cron precomputa la película, no solo la foto ──
console.log('screener-refresh: la capa temporal (series por trimestre + momentum + estimados) se guarda');
ok(temporalAfter1.some((u) => u.includes('stock/earnings') && u.includes('symbol=AAPL')) &&
   temporalAfter1.some((u) => u.includes('financials-reported') && u.includes('symbol=AAPL')) &&
   temporalAfter1.some((u) => u.includes('calendar/earnings') && u.includes('symbol=AAPL')) &&
   temporalAfter1.some((u) => u.includes('stock/recommendation') && u.includes('symbol=AAPL')),
  'el refresh pide las 4 fuentes temporales del tier gratis para el ticker vivo', JSON.stringify(temporalAfter1.length));
ok(!temporalAfter1.some((u) => u.includes('symbol=HES')), 'al ticker muerto NO se le gasta ninguna llamada temporal', JSON.stringify(temporalAfter1));
// El upsert lleva 20 params + refreshed_at por now(): [13]=rev_yoy_history,
// [14]=eps_surprise_history, [15]=rec_trend, [16]=estimate_history, [17..19]=retornos, [20]=dist 52s.
const upRev = JSON.parse(lastUpsertParams[12]);
ok(Array.isArray(upRev) && upRev[0].yoy_pct === 10, 'se guarda el historial de ingresos con su YoY (1100 vs 1000 = +10%)', JSON.stringify(upRev));
ok(JSON.parse(lastUpsertParams[13])[0].surprise_pct === 10, 'se guarda la sorpresa de EPS por trimestre', lastUpsertParams[13]);
ok(JSON.parse(lastUpsertParams[14]).score_now === 1.0, 'se guarda la tendencia del rating (score neto)', lastUpsertParams[14]);
const upEst = JSON.parse(lastUpsertParams[15]);
ok(Array.isArray(upEst) && upEst.length === 1 && upEst[0].eps === 2.4 && upEst[0].period === '2026-10-28',
  'se acumula el snapshot del estimado del próximo reporte, con su periodo fiscal', lastUpsertParams[15]);
// La serie del mock tiene 60 sesiones: alcanza para el retorno 1m y para el
// máximo de 52 semanas, no para 3m/6m — que salen null, nunca inventados.
ok(lastUpsertParams[16] != null && lastUpsertParams[19] != null && lastUpsertParams[17] === null,
  'se guardan los retornos de momentum derivados de la MISMA serie de Yahoo (y null donde no hay historia)', JSON.stringify(lastUpsertParams.slice(16, 20)));

console.log('screener-refresh: mergeEstimateHistory (un punto por día reciente, semanal atrás, ventana de 90d viva)');
const DAY_MS = 86400000;
const dAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const snap = (date, eps) => ({ date, period: 'P1', eps, revenue: 100 });
ok(mergeEstimateHistory([snap(dAgo(31), 3)], snap(dAgo(0), 2)).length === 2, 'un día nuevo agrega entrada');
ok(mergeEstimateHistory([snap(dAgo(0), 3)], snap(dAgo(0), 2))[0].eps === 2, 'el mismo día PISA (el cron corre cada 4h, no queremos 6 filas/día)');
// 120 días de snapshots diarios: la serie se RALEA, pero el punto de ~90 días
// SOBREVIVE — si no, la ventana larga de `estimateRevisions` quedaría muda.
const daily = Array.from({ length: 120 }, (_, i) => snap(dAgo(i + 1), 3 - i * 0.01));
const thinned = mergeEstimateHistory(daily, snap(dAgo(0), 2.5));
ok(thinned.length <= 30, 'la serie se acota (no crece sin límite)', String(thinned.length));
ok(thinned.slice(0, 5).every((h, i) => h.date === dAgo(i)), 'resolución DIARIA en los últimos días', JSON.stringify(thinned.slice(0, 5).map((h) => h.date)));
const ages = thinned.map((h) => Math.round((Date.parse(thinned[0].date) - Date.parse(h.date)) / DAY_MS));
ok(ages.some((a) => a >= 45 && a <= 135), 'queda al menos un punto dentro de la ventana de 90 días (45-135d)', JSON.stringify(ages));
ok(ages.some((a) => a >= 15 && a <= 45), 'queda al menos un punto dentro de la ventana de 30 días (15-45d)', JSON.stringify(ages));
ok(!ages.some((a) => a > 130), 'nada más viejo que el horizonte se conserva', JSON.stringify(ages));
ok(mergeEstimateHistory([], null).length === 0, 'sin snapshot nuevo no rompe');
ok(mergeEstimateHistory([{ date: 'basura' }, null], snap(dAgo(0), 1)).length === 1, 'entradas inválidas se descartan sin romper');

// ── 3) seedScreenerLedger: cuenta las filas REALMENTE insertadas ──
console.log('screener-refresh: seed cuenta inserciones reales (fix inserted:0)');
seedReturnRows = ['AAPL', 'MSFT']; // 3 entries, 1 chocó → returning trae 2
const inserted = await seedScreenerLedger([{ symbol: 'AAPL' }, { symbol: 'MSFT' }, { symbol: 'DUP' }]);
ok(inserted === 2, 'inserted = filas del returning (2), no 0', String(inserted));
ok(lastSelectQuery.includes('returning'), 'el insert del seed usa returning (para contar)', lastSelectQuery.slice(0, 80));
ok(await seedScreenerLedger([]) === 0, 'seed vacío → 0 sin tocar la DB');

// ── 4) pickStaleSymbols EXCLUYE not_found de la rotación ──
console.log('screener-refresh: pickStaleSymbols excluye not_found');
pendingRows = [{ symbol: 'AAPL', attempts: 0 }];
await pickStaleSymbols(30);
ok(lastSelectQuery.includes("is distinct from 'not_found'"), 'la query de rotación filtra los not_found', lastSelectQuery.replace(/\s+/g, ' ').slice(0, 160));

// ── 5) screenerStats expone el conteo de not_found ──
console.log('screener-refresh: screenerStats expone not_found');
ledgerStats = { total: 151, done: 140, pending: 5, error: 4, not_found: 2 };
const stats = await screenerStats();
ok(stats.ledger.not_found === 2, 'stats.ledger.not_found refleja los tickers muertos', JSON.stringify(stats.ledger));

// ── 6) job=audit reporta el universo vs. el symbol map (read-only) ──
console.log('screener-refresh: job=audit (universo vs. symbol map, read-only)');
_resetSymbolMapCache();
symbolList = [{ symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' }]; // casi todo el universo ausente
const marksBeforeAudit = marks.length;
let auditResp = null;
const res = { setHeader() {}, status() { return this; }, json(o) { auditResp = o; return this; }, end() { return this; } };
await handler({ method: 'GET', query: { job: 'audit' }, headers: {} }, res);
ok(auditResp && auditResp.job === 'audit' && Array.isArray(auditResp.missing), 'audit devuelve { job, total, present, missing }', JSON.stringify(auditResp && Object.keys(auditResp)));
ok(auditResp.missing.includes('MSFT'), 'audit reporta los miembros del universo ausentes del map (MSFT no está en el map del test)', JSON.stringify(auditResp.missing.slice(0, 5)));
ok(!auditResp.missing.includes('AAPL'), 'audit NO reporta el ticker vivo (AAPL, único presente en el map)');
ok(marks.length === marksBeforeAudit, 'audit es read-only: no escribe en el ledger');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
