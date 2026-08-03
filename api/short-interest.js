// ═══════════════════════════════════════════════════════════════════
// /api/short-interest — short-selling pressure from FINRA, gratis y sin
// key. Reemplaza el "SHORT INTEREST" inventado por IA del tab SMART $.
//
//   GET /api/short-interest?ticker=TSLA → serie de short VOLUME diario
//        (Reg SHO) de los últimos ~días hábiles: ratio short/total,
//        promedios 5d/20d, tendencia y serie para sparkline.
//   GET /api/short-interest?smoke=1     → smoke de la fuente, en vivo.
//
// ── Qué es (y qué NO es) ────────────────────────────────────────────
// FINRA publica DOS cosas distintas, ambas relacionadas con cortos:
//
//   1. SHORT INTEREST (Regla 4560): posición corta agregada, reportada
//      2 veces al mes (fechas de liquidación ~15 y fin de mes), publicada
//      ~8 días hábiles después. Da "% del float en corto" y "días para
//      cubrir". Vive tras el FINRA Query API (OAuth) — credencial pública
//      gratis pero requiere client_id/secret. Ruta de upgrade, no MVP.
//
//   2. SHORT VOLUME (Reg SHO): del volumen de HOY, qué fracción se ejecutó
//      como venta en corto. Archivo consolidado NMS diario, descarga
//      directa SIN key ni auth. Es lo que consumimos aquí.
//
// Honestidad de métrica: NO es "% del float en corto" ni "días para
// cubrir" — es presión de venta en corto intradía, diaria. Se etiqueta
// como SHORT VOLUME · Reg SHO, nunca como short interest clásico. Un
// ratio de 45% NO significa 45% del float corto (los market makers marcan
// muchas ventas como "short" al proveer liquidez). La señal útil es la
// TENDENCIA y el nivel relativo, que sí es real y se actualiza a diario.
//
// Principios (mismos de stock-tracker/vc-feed):
//   - Solo datos reales del archivo FINRA. Nada de IA.
//   - Caché doble: memoria por instancia (mapas full-market por fecha,
//     reutilizados entre tickers) + CDN s-maxage/swr.
//   - Fuente caída o ticker sin cobertura → payload vacío honesto, nunca
//     500 HTML.
// ═══════════════════════════════════════════════════════════════════

// UA identificado (cortesía; FINRA CDN no lo exige pero es buena praxis).
const UA = 'QuantDesk research@quantdesk.app';
// Archivo consolidado NMS (listadas: NYSE/Nasdaq/etc). CNMS = Consolidated NMS.
const FILE_BASE = 'https://cdn.finra.org/equity/regsho/daily/CNMSshvol';
// Días hábiles a intentar hacia atrás y tope de archivos a juntar. El
// archivo de un día se publica ~T+1 por la tarde (ET), así que arrancamos
// en ayer. LOOKBACK cubre findes + feriados para juntar MAX_FILES reales.
const LOOKBACK_DAYS = 34;
const MAX_FILES = 15;

// ── Caché en memoria por instancia ──────────────────────────────────
// dateStr(YYYYMMDD) → { ok, map: Map<symbol,{short,total}> } | { ok:false }
// Los archivos son idénticos para todos los tickers de un día: el primer
// request de instancia los baja, los siguientes leen de memoria.
let fileCache = new Map();
const FILE_CACHE_MAX = 40; // poda simple: no crecer sin fin en instancias warm

// Hooks de test (no se usan en producción).
export function _resetShortInterestCache() { fileCache = new Map(); }

// ── Fetch con timeout ───────────────────────────────────────────────
async function fetchText(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/plain, */*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Fechas ──────────────────────────────────────────────────────────
// YYYYMMDD de una Date (UTC — el nombre del archivo es por fecha de mercado).
function ymd(date) {
  return date.getUTCFullYear().toString()
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0');
}
// YYYYMMDD → YYYY-MM-DD (para display) y → epoch segundos (para LWC).
export function ymdToIso(s) {
  return s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}
function ymdToEpoch(s) {
  return Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 1000);
}
// Fechas hábiles candidatas (findes fuera; feriados se detectan por 404).
// Arranca en `startDaysAgo` (default 1 = ayer) porque el archivo de hoy no
// existe hasta la tarde ET.
export function candidateDates(now, startDaysAgo = 1, lookback = LOOKBACK_DAYS) {
  const out = [];
  for (let i = startDaysAgo; i <= startDaysAgo + lookback; i++) {
    const d = new Date(now.getTime() - i * 864e5);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // domingo/sábado
    out.push(ymd(d));
  }
  return out;
}

// ── Parseo del archivo FINRA ────────────────────────────────────────
// Layout (pipe-delimited): Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
// Primera línea es header; puede haber un trailer de conteo al final.
// Devuelve Map<symbol, {short, total}>. Exportado para tests sin red.
export function parseRegShoFile(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const p = line.split('|');
    if (p.length < 5) continue;              // trailer / línea corta
    const sym = (p[1] || '').toUpperCase().trim();
    if (!sym || sym === 'SYMBOL') continue;  // header
    if (!/^\d{8}$/.test((p[0] || '').trim())) continue; // exige Date válida en col 0
    const short = parseInt(p[2], 10);
    const total = parseInt(p[4], 10);
    if (!Number.isFinite(total) || total <= 0) continue;
    map.set(sym, { short: Number.isFinite(short) ? short : 0, total });
  }
  return map;
}

// Baja+parsea un día (con caché de instancia). Devuelve el registro cacheado.
async function getDay(dateStr) {
  const hit = fileCache.get(dateStr);
  if (hit) return hit;
  const r = await fetchText(FILE_BASE + dateStr + '.txt');
  let rec;
  if (!r.ok) {
    // 404 → día sin archivo (feriado o aún no publicado): marca miss liviano.
    rec = { ok: false, status: r.status, map: null };
  } else {
    const map = parseRegShoFile(r.text);
    rec = { ok: map.size > 0, status: r.status, map, symbols: map.size };
  }
  if (fileCache.size >= FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(dateStr, rec);
  return rec;
}

// ── Métricas de la serie ────────────────────────────────────────────
function avg(nums) {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// serie ascendente [{ymd, ratio, short, total}] → resumen + tendencia.
export function summarize(series) {
  if (!series.length) return null;
  const ratios = series.map((s) => s.ratio);
  const latest = series[series.length - 1];
  const last5 = avg(ratios.slice(-5));
  const last20 = avg(ratios.slice(-20));
  // Tendencia: media reciente (≤5d) vs media previa (los anteriores), con
  // banda muerta de 3 puntos porcentuales para no llamar "cambio" al ruido.
  const recent = avg(ratios.slice(-5));
  const prior = avg(ratios.slice(0, Math.max(1, series.length - 5)));
  let trend = 'STABLE';
  if (recent != null && prior != null) {
    const diff = (recent - prior) * 100;
    if (diff > 3) trend = 'INCREASING';
    else if (diff < -3) trend = 'DECREASING';
  }
  return {
    latestRatio: +(latest.ratio * 100).toFixed(1),   // % del volumen que fue short el último día
    latestDate: ymdToIso(latest.ymd),
    avg5: last5 != null ? +(last5 * 100).toFixed(1) : null,
    avg20: last20 != null ? +(last20 * 100).toFixed(1) : null,
    trend,
    days: series.length,
    latestShortVol: latest.short,
    latestTotalVol: latest.total,
  };
}

async function buildTicker(ticker) {
  const dates = candidateDates(new Date());
  const series = [];
  const scan = { attempted: 0, files_ok: 0, missing: 0 };
  // Batches de 5 con piso de 400ms — cortés con el CDN y rápido en warm.
  for (let i = 0; i < dates.length && series.length < MAX_FILES; i += 5) {
    const chunk = dates.slice(i, i + 5);
    const t0 = Date.now();
    const recs = await Promise.all(chunk.map(async (d) => ({ d, rec: await getDay(d) })));
    for (const { d, rec } of recs) {
      scan.attempted++;
      if (!rec.ok || !rec.map) { scan.missing++; continue; }
      scan.files_ok++;
      const row = rec.map.get(ticker);
      if (row && row.total > 0) {
        series.push({ ymd: d, ratio: row.short / row.total, short: row.short, total: row.total });
      }
      if (series.length >= MAX_FILES) break;
    }
    const left = 400 - (Date.now() - t0);
    if (left > 0 && i + 5 < dates.length && series.length < MAX_FILES) {
      await new Promise((r) => setTimeout(r, left));
    }
  }
  // Ascendente por fecha para la sparkline y los promedios.
  series.sort((a, b) => a.ymd.localeCompare(b.ymd));
  const summary = summarize(series);
  return {
    ticker,
    metric: 'short_volume',
    source: 'FINRA Reg SHO (consolidated NMS, daily short-sale volume)',
    note: 'Short VOLUME diario (fracción del volumen ejecutada como venta en corto), NO short interest del float ni días para cubrir. La señal es la tendencia y el nivel relativo.',
    upgrade_note: 'Short interest clásico (% del float, días para cubrir, bimensual) requiere el FINRA Query API (credencial pública gratis, OAuth).',
    summary,
    // Serie para Lightweight Charts: {t: epoch, c: ratio en %}.
    series: series.map((s) => ({ t: ymdToEpoch(s.ymd), c: +(s.ratio * 100).toFixed(2) })),
    scan,
    stale: false,
    generated_at: new Date().toISOString(),
  };
}

// ── Smoke (?smoke=1) ────────────────────────────────────────────────
async function runSmoke() {
  const dates = candidateDates(new Date());
  const tried = [];
  let firstOk = null;
  for (const d of dates.slice(0, 6)) {
    const r = await fetchText(FILE_BASE + d + '.txt', 9000);
    const map = r.ok ? parseRegShoFile(r.text) : null;
    const rec = { date: ymdToIso(d), url: FILE_BASE + d + '.txt', ok: r.ok, status: r.status, symbols: map ? map.size : 0, has_TSLA: !!(map && map.get('TSLA')) };
    tried.push(rec);
    if (r.ok && map && map.size > 0) { firstOk = { ...rec, tsla: map.get('TSLA') || null }; break; }
  }
  return { smoke: true, source: 'FINRA Reg SHO consolidated NMS daily', first_ok: firstOk, tried, generated_at: new Date().toISOString() };
}

// ── Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};

  if (q.smoke) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.status(200).json(await runSmoke());
    } catch (err) {
      return res.status(200).json({ smoke: true, error: String((err && err.message) || err) });
    }
  }

  const ticker = String(q.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // Solo acciones US-listadas: el archivo consolidado NMS no cubre LATAM/cripto.
  if (/\.(MX|SA|SN|BA)$/i.test(ticker) || ticker.includes('/USD') || ticker.includes('-USD')) {
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({
      ticker, metric: 'short_volume', summary: null, series: [],
      source: 'FINRA Reg SHO (consolidated NMS)',
      note: 'Cobertura limitada a acciones US-listadas (NMS).',
      stale: false, generated_at: new Date().toISOString(),
    });
  }

  try {
    const payload = await buildTicker(ticker);
    // Sin serie pero fuentes OK = ticker sin cobertura en el archivo (no error).
    // Sin serie y todos los archivos caídos = fuente caída.
    const allMissing = payload.scan && payload.scan.files_ok === 0;
    res.setHeader('Cache-Control', allMissing ? 'no-store' : 's-maxage=3600, stale-while-revalidate=7200');
    if (allMissing) payload.error = 'FINRA Reg SHO files unavailable';
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(200).json({
      ticker, metric: 'short_volume', summary: null, series: [],
      error: 'Server exception: ' + String((err && err.message) || err),
      stale: false, generated_at: new Date().toISOString(),
    });
  }
}
