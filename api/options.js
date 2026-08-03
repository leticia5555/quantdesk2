// ═══════════════════════════════════════════════════════════════════
// /api/options — sentimiento de opciones REAL desde Yahoo Finance (gratis,
// sin key). Reemplaza el bloque de opciones inventado por IA del tab SMART $.
//
//   GET /api/options?ticker=TSLA → cadena de la expiración más cercana:
//        put/call ratio (por interés abierto), IV at-the-money, max pain
//        y strikes clave por OI. Todo calculado del chain real.
//   GET /api/options?smoke=1&ticker=TSLA → smoke de la fuente, en vivo.
//
// Fuente: Yahoo v7 options (misma familia que /api/candles y /api/price).
// Honestidad: es la EXPIRACIÓN MÁS CERCANA (front expiry), no todo el
// tablero. El put/call va por interés abierto (OI), no por volumen. Sin
// histórico de IV no inventamos "IV percentile". Fuente caída o ticker sin
// opciones → payload vacío honesto, nunca 500 HTML.
// ═══════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML de error */ }
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Yahoo cae/rota entre hosts; probamos ambos antes de rendirnos.
async function fetchOptionChain(ticker) {
  for (const host of HOSTS) {
    const r = await fetchJson(`${host}/v7/finance/options/${encodeURIComponent(ticker)}`);
    const res = r.json && r.json.optionChain && Array.isArray(r.json.optionChain.result) ? r.json.optionChain.result[0] : null;
    if (res && Array.isArray(res.options) && res.options.length) return { host, res, status: r.status };
    if (r.status === 404) return { host, res: null, status: 404 }; // sin opciones: no reintentar otro host
  }
  return { host: null, res: null, status: 0 };
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// ── Max pain ────────────────────────────────────────────────────────
// Strike que minimiza el valor intrínseco total pagado a los tenedores de
// opciones al vencimiento: Σ callOI·max(0,S−K) + Σ putOI·max(0,K−S), sobre
// el set de strikes. Es el nivel donde más opciones expiran sin valor —
// "imán" clásico. Exportado para test sin red.
export function computeMaxPain(calls, puts) {
  const strikes = [...new Set([...calls, ...puts].map((o) => num(o.strike)).filter((s) => s > 0))].sort((a, b) => a - b);
  if (!strikes.length) return null;
  let best = null, bestPay = Infinity;
  for (const S of strikes) {
    let pay = 0;
    for (const c of calls) { const k = num(c.strike); if (S > k) pay += num(c.openInterest) * (S - k); }
    for (const p of puts) { const k = num(p.strike); if (k > S) pay += num(p.openInterest) * (k - S); }
    if (pay < bestPay) { bestPay = pay; best = S; }
  }
  return best;
}

// ── Resumen del chain ───────────────────────────────────────────────
// Exportado para test. spot = precio subyacente (para ATM/ITM).
export function summarizeChain(calls, puts, spot) {
  calls = Array.isArray(calls) ? calls : [];
  puts = Array.isArray(puts) ? puts : [];
  const sumOI = (arr) => arr.reduce((s, o) => s + num(o.openInterest), 0);
  const callOI = sumOI(calls), putOI = sumOI(puts);
  const callVol = calls.reduce((s, o) => s + num(o.volume), 0);
  const putVol = puts.reduce((s, o) => s + num(o.volume), 0);
  const putCallOI = callOI > 0 ? +(putOI / callOI).toFixed(2) : null;
  const putCallVol = callVol > 0 ? +(putVol / callVol).toFixed(2) : null;

  // IV at-the-money: promedio de la IV del call y put de strike más cercano al spot.
  const nearest = (arr) => arr.slice().filter((o) => num(o.strike) > 0)
    .sort((a, b) => Math.abs(num(a.strike) - spot) - Math.abs(num(b.strike) - spot))[0];
  const atmCall = nearest(calls), atmPut = nearest(puts);
  const ivs = [atmCall, atmPut].filter(Boolean).map((o) => num(o.impliedVolatility)).filter((v) => v > 0);
  const atmIv = ivs.length ? +((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100).toFixed(1) : null;

  // Strikes clave: top por OI (calls y puts juntos), etiquetados.
  const tagged = [
    ...calls.map((o) => ({ type: 'CALL', strike: num(o.strike), oi: num(o.openInterest), vol: num(o.volume) })),
    ...puts.map((o) => ({ type: 'PUT', strike: num(o.strike), oi: num(o.openInterest), vol: num(o.volume) })),
  ].filter((o) => o.strike > 0 && o.oi > 0).sort((a, b) => b.oi - a.oi).slice(0, 5);

  // Actividad inusual: algún strike con volumen > 1.5× su OI y OI relevante.
  const unusual = tagged.some((o) => o.oi >= 500 && o.vol > o.oi * 1.5);

  const maxPain = computeMaxPain(calls, puts);

  let sentiment = 'NEUTRAL';
  if (putCallOI != null) {
    if (putCallOI > 1.1) sentiment = 'BEARISH';
    else if (putCallOI < 0.7) sentiment = 'BULLISH';
  }

  return {
    put_call_oi: putCallOI,
    put_call_volume: putCallVol,
    call_oi: callOI,
    put_oi: putOI,
    atm_iv_pct: atmIv,
    max_pain: maxPain,
    key_strikes: tagged,
    unusual_activity: unusual,
    options_sentiment: sentiment,
  };
}

async function build(ticker) {
  const { res, status } = await fetchOptionChain(ticker);
  if (!res || !Array.isArray(res.options) || !res.options.length) {
    return { ticker, available: false, status, source: 'Yahoo Finance options',
      note: status === 404 ? 'Sin cadena de opciones para este ticker.' : 'Fuente de opciones no disponible.',
      generated_at: new Date().toISOString() };
  }
  const chain = res.options[0]; // expiración más cercana
  // Spot del quote embebido; si falta, el borde ITM/OTM del chain (el mayor
  // strike de call ITM ≈ spot) como respaldo para el cálculo ATM.
  let spot = num(res.quote && (res.quote.regularMarketPrice || res.quote.postMarketPrice));
  if (!spot) {
    const itmCalls = (chain.calls || []).filter((c) => c.inTheMoney).map((c) => num(c.strike));
    if (itmCalls.length) spot = Math.max(...itmCalls);
  }
  const summary = summarizeChain(chain.calls, chain.puts, spot);
  return {
    ticker,
    available: true,
    source: 'Yahoo Finance options',
    spot: spot || null,
    expiration: chain.expirationDate ? new Date(chain.expirationDate * 1000).toISOString().slice(0, 10) : null,
    scope: 'front expiry (expiración más cercana)',
    note: 'Put/Call por interés abierto (OI) del front expiry. IV = at-the-money. Max pain calculado del chain.',
    ...summary,
    generated_at: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const ticker = String(q.ticker || '').toUpperCase().trim();

  if (q.smoke) {
    res.setHeader('Cache-Control', 'no-store');
    const sym = ticker || 'TSLA';
    try {
      const { host, res: chain, status } = await fetchOptionChain(sym);
      return res.status(200).json({
        smoke: true, ticker: sym, host, status,
        expirations: chain ? (chain.expirationDates || []).length : 0,
        front_calls: chain && chain.options && chain.options[0] ? (chain.options[0].calls || []).length : 0,
        front_puts: chain && chain.options && chain.options[0] ? (chain.options[0].puts || []).length : 0,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(200).json({ smoke: true, ticker: sym, error: String((err && err.message) || err) });
    }
  }

  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // Yahoo cubre opciones US; LATAM/cripto no tienen chain listado.
  if (/\.(MX|SA|SN|BA)$/i.test(ticker) || ticker.includes('/USD') || ticker.includes('-USD')) {
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({ ticker, available: false, source: 'Yahoo Finance options',
      note: 'Cobertura de opciones limitada a US-listadas.', generated_at: new Date().toISOString() });
  }

  try {
    const payload = await build(ticker);
    res.setHeader('Cache-Control', payload.available
      ? 's-maxage=600, stale-while-revalidate=1200' : 'no-store');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(200).json({ ticker, available: false, error: 'Server exception: ' + String((err && err.message) || err), generated_at: new Date().toISOString() });
  }
}
