// ═══════════════════════════════════════════════════════════════════
// api/_lib/av-earnings.js — Alpha Vantage EARNINGS: fetch + parse.
//
// Fuente primaria de earnings del backtest PEAD (Fase 0: AV GO con ~30 años).
// UNA llamada por símbolo devuelve TODO el historial trimestral.
//
// TRAMPA de AV free tier: cuando te rate-limita NO devuelve HTTP 429 — devuelve
// HTTP 200 con un JSON {"Note": ...} o {"Information": ...} y sin datos. Si no
// lo detectás, grabás un símbolo vacío como 'done'. parseEarnings() distingue
// los tres casos: ok / rate-limited / vacío. JS puro y testeable (sin red).
// ═══════════════════════════════════════════════════════════════════

const AV_BASE = 'https://www.alphavantage.co/query';

function num(v) {
  if (v == null || v === 'None' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Clasifica la respuesta cruda de AV. Devuelve:
//   { status: 'rate_limited' }                    → dejar pending, reintentar
//   { status: 'empty' }                           → símbolo sin datos (delisted?)
//   { status: 'ok', events: [...] }               → upsert
function parseEarnings(body) {
  if (!body || typeof body !== 'object') return { status: 'empty', events: [] };

  // Rate-limit / info: AV manda Note, Information, o "Error Message".
  if (body.Note || body.Information) {
    return { status: 'rate_limited', message: String(body.Note || body.Information) };
  }
  if (body['Error Message']) {
    return { status: 'empty', events: [], message: String(body['Error Message']) };
  }

  const q = Array.isArray(body.quarterlyEarnings) ? body.quarterlyEarnings : [];
  if (!q.length) return { status: 'empty', events: [] };

  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const events = q
    .map((row) => {
      const reported_date = row && row.reportedDate;
      const fiscal_date_ending = row && row.fiscalDateEnding;
      // AV usa 'None'/'' como sentinela de nulo — validar formato de fecha.
      if (!isDate(reported_date) || !isDate(fiscal_date_ending)) return null;
      const reported_eps = num(row.reportedEPS);
      const estimated_eps = num(row.estimatedEPS);
      const surprise = num(row.surprise);
      // AV ya trae surprisePercentage, pero lo recomputamos de forma consistente
      // con el resto del proyecto ((actual-est)/|est|) cuando hay datos.
      let surprise_pct = num(row.surprisePercentage);
      if (surprise_pct == null && reported_eps != null && estimated_eps != null && estimated_eps !== 0) {
        surprise_pct = ((reported_eps - estimated_eps) / Math.abs(estimated_eps)) * 100;
      }
      return { fiscal_date_ending, reported_date, reported_eps, estimated_eps, surprise, surprise_pct };
    })
    .filter(Boolean);

  return events.length ? { status: 'ok', events } : { status: 'empty', events: [] };
}

// I/O: una llamada. Devuelve el resultado de parseEarnings o un status de red.
async function fetchEarnings(symbol, apiKey, { timeoutMs = 15000 } = {}) {
  const url = `${AV_BASE}?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { status: 'neterror', message: String(e && e.message ? e.message : e) };
  }
  if (!r.ok) return { status: 'httperror', message: `HTTP ${r.status}` };
  let body = null;
  try {
    body = await r.json();
  } catch (e) {
    return { status: 'empty', events: [], message: 'non-JSON' };
  }
  return parseEarnings(body);
}

export { parseEarnings, fetchEarnings, num };
