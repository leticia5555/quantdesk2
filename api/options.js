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
    // UN RECORTE DEL CUERPO cuando no es JSON. Un 401 de Yahoo viene con una
    // página HTML o con un JSON de error, y eso es lo único que dice si pide
    // `crumb`, si bloqueó por región o si es otra cosa. Sin el recorte, el
    // diagnóstico se queda en "no era JSON" y hay que adivinar.
    return { ok: r.ok, status: r.status, json,
      cuerpo: json ? null : String(text || '').slice(0, 200), bytes: (text || '').length };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Yahoo cae/rota entre hosts; probamos ambos antes de rendirnos.
// EXPORTADA: el snapshot de apertura del Arena necesita la cadena CRUDA para
// derivar la probabilidad implícita, que no es parte del resumen público.
/**
 * LA CADENA DE OPCIONES, Y SI NO SE PUDO, QUÉ CONTESTÓ CADA HOST.
 *
 * Lety, contra producción (2026-10-22): `?ticker=NVDA` devolvía
 * `available: false, "Fuente de opciones no disponible"` y con eso no se
 * puede hacer nada. La versión anterior devolvía UN solo `status` —el del
 * último host probado—, así que si query1 daba 401 y query2 daba 429, lo que
 * llegaba era "429" y la causa real se perdía.
 *
 * `intentos` lleva, por host: el código, si el cuerpo era JSON, el tamaño, y
 * el mensaje de error que Yahoo pone en el cuerpo cuando rechaza. Es la
 * diferencia entre "Yahoo cerró el endpoint" y "nuestro contenedor no tiene
 * salida", que se arreglan en lugares distintos.
 *
 * SOSPECHA, y va dicha para que se pueda confirmar o descartar: `/v7/` es la
 * familia de endpoints que Yahoo cerró detrás de cookie + `crumb`. El
 * `/v8/finance/chart` que usa el resto de esta casa sigue abierto; `/v7/` no.
 * Si los intentos vuelven con 401 o con un cuerpo que no es JSON, es eso.
 */
export async function fetchOptionChain(ticker) {
  const intentos = [];
  for (const host of HOSTS) {
    const r = await fetchJson(`${host}/v7/finance/options/${encodeURIComponent(ticker)}`);
    const res = r.json && r.json.optionChain && Array.isArray(r.json.optionChain.result) ? r.json.optionChain.result[0] : null;
    intentos.push({
      host,
      status: r.status ?? 0,
      json: !!r.json,
      // El cuerpo de un rechazo de Yahoo trae su propia explicación
      // (`finance.error.description`), y es la que dice si pide `crumb`.
      error_yahoo: (r.json && r.json.finance && r.json.finance.error
        && (r.json.finance.error.description || r.json.finance.error.code)) || null,
      error_red: r.error || null,
      bytes: r.bytes ?? null,
      cuerpo: r.cuerpo || null,
      resultados: res ? 1 : 0,
      vencimientos: res && Array.isArray(res.expirationDates) ? res.expirationDates.length : 0,
    });
    if (res && Array.isArray(res.options) && res.options.length) return { host, res, status: r.status, intentos };
    if (r.status === 404) return { host, res: null, status: 404, intentos }; // sin opciones: no reintentar otro host
  }
  return { host: null, res: null, status: intentos.length ? intentos[intentos.length - 1].status : 0, intentos };
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
  const { res, status, intentos } = await fetchOptionChain(ticker);
  if (!res || !Array.isArray(res.options) || !res.options.length) {
    return { ticker, available: false, status, source: 'Yahoo Finance options',
      // QUÉ contestó cada host, no sólo que no se pudo (regla 2: la causa
      // real). Sin esto, "no disponible" podía ser Yahoo cerrado, el ticker
      // sin opciones, o nuestra salida de red, y las tres se arreglan en
      // lugares distintos.
      intentos,
      note: status === 404 ? 'Sin cadena de opciones para este ticker.'
        : (intentos || []).some((i) => i.status === 401 || i.status === 403)
          ? 'Yahoo rechazó la petición (401/403): el endpoint /v7/ exige cookie y crumb desde su cambio de acceso. Hace falta otra fuente o autenticar.'
          : (intentos || []).some((i) => i.status === 429)
            ? 'Yahoo contestó 429 (demasiadas peticiones): es cuota, no cierre. Reintentar más tarde.'
            : (intentos || []).every((i) => i.status === 0)
              ? 'No hubo respuesta de ningún host de Yahoo: parece falta de salida de red, no un rechazo.'
              : 'Fuente de opciones no disponible.',
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
      const { host, res: chain, status, intentos } = await fetchOptionChain(sym);
      return res.status(200).json({
        smoke: true, ticker: sym, host, status, intentos,
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
