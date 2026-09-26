// ═══════════════════════════════════════════════════════════════════
// api/_lib/fmp-grades.js — frontera de red con FMP `/stable/grades-historical`.
//
// ESTE ES EL ÚNICO DATO POINT-IN-TIME QUE SE ENCONTRÓ. Una fila por MES con los
// conteos de strongBuy/buy/hold/sell/strongSell, y las filas viejas NO se
// sobrescriben — verificado con NKE: 6 strongBuy + 20 buy en dic-2025 contra
// 1 + 10 en sep-2026.
//
// `analyst-estimates` de FMP NO sirve para esto: una fila por período fiscal con
// el número de HOY, igual que Alpha Vantage. Un backtest con eso mide el futuro.
//
// ── LO QUE SE HEREDA DE api/_lib/arena-universe.js ─────────────────
// Esa frontera ya pagó las lecciones de FMP y acá se aplican las mismas:
//
//   1. **HTTP 200 con un objeto de error.** Es el caso que más engaña: FMP
//      contesta 200 y en el cuerpo pone `Error Message`. Sin mirarlo, "FMP no
//      contestó" se vuelve indistinguible de "FMP contestó y dijo por qué".
//   2. **Los primeros bytes SIEMPRE**, salga bien o mal: es donde FMP explica.
//   3. **La env var vive por ENTORNO en Vercel.** Que `FMP_API_KEY` esté en
//      Production no la pone en Preview — y sin key el diagnóstico tiene que
//      decir eso y no "sin datos".
//   4. **No lanza.** Clasifica y devuelve el motivo. Una fuente caída se
//      DECLARA; nunca se inventa.
//
// La key es la MISMA `FMP_API_KEY` que ya usa el universo de la arena: no hace
// falta una env var nueva si ya está puesta en el entorno donde corre esto.
//
// ENV VARS: FMP_API_KEY
// ═══════════════════════════════════════════════════════════════════

const BASE = 'https://financialmodelingprep.com/stable';

// Tope de filas por símbolo. La serie es mensual, así que 1000 son ~83 años:
// alto a propósito, porque la Fase 0 tiene que MEDIR hasta dónde llega la
// historia y un límite bajo contestaría la pregunta con el límite. Es la
// cicatriz del `limit=5` del censo de Polymarket, que disfrazó un tope propio
// de un hallazgo sobre la fuente.
const LIMIT_ALTO = 1000;

const VALID_TICKER = /^[A-Z][A-Z.\-]{0,9}$/;

// Una sola forma de fila, con los cinco conteos numéricos y la fecha en ISO.
// Lo que no se puede leer se descarta CONTADO, no en silencio.
function normalizaGrades(crudo) {
  const filas = [], descartes = { sin_fecha: 0, sin_conteos: 0 };
  for (const g of Array.isArray(crudo) ? crudo : []) {
    const fecha = g && g.date ? String(g.date).slice(0, 10) : null;
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { descartes.sin_fecha++; continue; }
    const num = (x) => { const v = Number(x); return Number.isFinite(v) && v >= 0 ? v : 0; };
    const fila = {
      date: fecha,
      strongBuy: num(g.analystRatingsStrongBuy ?? g.strongBuy),
      buy: num(g.analystRatingsBuy ?? g.buy),
      hold: num(g.analystRatingsHold ?? g.hold),
      sell: num(g.analystRatingsSell ?? g.sell),
      strongSell: num(g.analystRatingsStrongSell ?? g.strongSell),
    };
    if (!(fila.strongBuy + fila.buy + fila.hold + fila.sell + fila.strongSell)) { descartes.sin_conteos++; continue; }
    filas.push(fila);
  }
  // Más viejo primero: es el orden en que se lee una serie.
  filas.sort((a, b) => a.date.localeCompare(b.date));
  return { filas, descartes };
}

// Devuelve SIEMPRE un objeto con `ok` y, si falló, el motivo y la muestra del
// cuerpo. Nunca lanza.
async function gradesHistorical(symbol, {
  apiKey = process.env.FMP_API_KEY, limit = LIMIT_ALTO, timeoutMs = 15000, fetchImpl = fetch,
} = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!VALID_TICKER.test(sym)) return { ok: false, symbol: sym, motivo: 'ticker_invalido' };
  if (!apiKey) {
    return { ok: false, symbol: sym, motivo: 'sin_key',
      detalle: 'process.env.FMP_API_KEY está vacía EN ESTE ENTORNO. En Vercel una env var vive por entorno: que esté en Production no la pone en Preview.' };
  }

  const url = `${BASE}/grades-historical?symbol=${encodeURIComponent(sym)}&limit=${limit}`;
  const t0 = Date.now();
  try {
    const r = await fetchImpl(`${url}&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const texto = await r.text().catch(() => '');
    const muestra = String(texto || '').slice(0, 200);
    const ms = Date.now() - t0;
    // El 429 se distingue del resto: es el dato que la Fase 0 vino a medir.
    if (r.status === 429) {
      return { ok: false, symbol: sym, motivo: 'rate_limit', status: 429, ms, body_sample: muestra,
        retry_after: (r.headers && r.headers.get && r.headers.get('retry-after')) || null };
    }
    if (!r.ok) return { ok: false, symbol: sym, motivo: 'http_error', status: r.status, ms, body_sample: muestra };

    let j = null;
    try { j = JSON.parse(texto); } catch { return { ok: false, symbol: sym, motivo: 'json_invalido', status: r.status, ms, body_sample: muestra }; }

    if (!Array.isArray(j)) {
      // HTTP 200 con objeto de error: el caso que más engaña.
      const msg = (j && (j['Error Message'] || j.error || j.message)) || null;
      return { ok: false, symbol: sym, status: r.status, ms,
        motivo: msg ? 'fmp_error_message' : 'cuerpo_no_es_lista', fmp_message: msg, body_sample: muestra };
    }

    const { filas, descartes } = normalizaGrades(j);
    return {
      ok: true, symbol: sym, status: r.status, ms,
      recibidas: j.length, filas, descartes,
      // Hasta dónde llega la historia: lo que la Fase 0 tiene que reportar.
      desde: filas.length ? filas[0].date : null,
      hasta: filas.length ? filas[filas.length - 1].date : null,
      meses: filas.length,
      // Si `recibidas` toca el límite, la historia puede estar CORTADA por el
      // límite y no por la fuente. Se avisa en vez de concluir.
      posible_tope: j.length >= limit,
      limit,
    };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, symbol: sym, ms: Date.now() - t0,
      motivo: /abort|timeout/i.test(m) ? 'timeout' : 'red', detalle: m.slice(0, 200) };
  }
}

export { gradesHistorical, normalizaGrades, BASE, LIMIT_ALTO, VALID_TICKER };
