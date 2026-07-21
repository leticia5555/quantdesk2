// ═══════════════════════════════════════════════════════════════
// /api/movers — Top gainers/losers/most active
// Computes from quotes of curated tickers (Finnhub free tier)
// ═══════════════════════════════════════════════════════════════

// Curated list — most-watched US large caps + popular mid/small + LATAM.
// MÁXIMO 55: Finnhub free = 60 req/min. La lista anterior tenía 84 y los
// ~24 quotes del final recibían 429 EN SILENCIO — por eso MU (puesto #62)
// nunca aparecía en Top Losers aunque cayera -10%. Con ≤55 la cobertura
// es completa y determinista en cada corrida.
const WATCHLIST = [
  // Mega-cap tech
  'NVDA','MSFT','AAPL','GOOGL','META','AMZN','TSLA','AVGO','ORCL','NFLX',
  // Semiconductors (antes al final de la lista, en la zona rate-limitada)
  'TSM','ASML','MU','QCOM','INTC','MRVL','AMD',
  // Other large cap
  'CRM','SHOP','PLTR','SNOW','UBER','COIN',
  // Retail favorites + meme
  'GME','HOOD','SOFI','RIVN','HIMS','RKLB',
  // Healthcare / biotech
  'LLY','PFE','UNH',
  // Finance
  'JPM','BAC','GS','V','PYPL',
  // Energy / industrial / consumer
  'XOM','BA','CAT','WMT','NKE','DIS',
  // ETFs popular
  'SPY','QQQ','IWM','ARKK',
  // LATAM ADRs (highly liquid)
  'MELI','NU','GLOB','VALE','PBR','ITUB','AMX','FMX'
];

// ═══ Universo MARKET (screeners predefinidos de Yahoo) — smoke gate ═══
// Aprobado: day_gainers + day_losers + most_actives en UNA sola llamada.
// A diferencia del v8/chart que ya usamos sin auth, /v1/finance/screener
// exige cookie + crumb. El dance se valida con ?smoke=market desde deploy
// real ANTES de construir toggle/UI (patrón stock-tracker). En la
// implementación real la sesión se cachea en scope de módulo (sobrevive
// lambda caliente) y la respuesta va con s-maxage — el smoke corre todo
// en vivo a propósito.

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MARKET_SCR_IDS = ['day_gainers', 'day_losers', 'most_actives'];

async function fetchYahooSession() {
  // Paso 1: fc.yahoo.com responde 404 pero setea la cookie de sesión.
  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': YAHOO_UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const rawCookies = typeof r1.headers.getSetCookie === 'function'
    ? r1.headers.getSetCookie()
    : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
  const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

  // Paso 2: crumb ligado a esa cookie.
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookie },
    signal: AbortSignal.timeout(10000),
  });
  const crumb = (await r2.text()).trim();
  const crumbOk = r2.ok && crumb.length > 0 && crumb.length < 64 && !/Too Many|<html/i.test(crumb);

  return {
    cookie, crumb,
    ok: cookie.length > 0 && crumbOk,
    steps: {
      cookie: { status: r1.status, got_cookie: cookie.length > 0, cookies_seen: rawCookies.length },
      crumb: { status: r2.status, ok: crumbOk, crumb_len: crumb.length },
    },
  };
}

async function fetchMarketScreeners(session, host) {
  const url = `https://${host}/v1/finance/screener/predefined/saved` +
    `?formatted=false&scrIds=${MARKET_SCR_IDS.join(',')}&count=10&crumb=${encodeURIComponent(session.crumb)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, 'Cookie': session.cookie },
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  const results = json?.finance?.result || [];
  return {
    host, status: r.status, ok: r.ok && results.length > 0,
    screeners: results.map(s => ({
      id: s.id || s.canonicalName,
      count: (s.quotes || []).length,
      // Muestra mapeada al contrato actual de movers + extras que ganaríamos
      sample: (s.quotes || []).slice(0, 2).map(q => ({
        symbol: q.symbol,
        name: q.shortName || q.longName || null,
        price: q.regularMarketPrice ?? null,
        change: q.regularMarketChange ?? null,
        changePct: q.regularMarketChangePercent ?? null,
        volume: q.regularMarketVolume ?? null,
        prevClose: q.regularMarketPreviousClose ?? null,
      })),
    })),
    error_body: r.ok ? undefined : text.slice(0, 300),
  };
}

async function runMarketSmoke() {
  const t0 = Date.now();
  const out = { smoke: 'market', generated_at: new Date().toISOString() };
  try {
    const session = await fetchYahooSession();
    out.session = session.steps;
    if (!session.ok) {
      out.verdict = 'FAIL: sin sesión (cookie/crumb)';
      out.ms = Date.now() - t0;
      return out;
    }
    let scr = await fetchMarketScreeners(session, 'query1.finance.yahoo.com');
    if (!scr.ok) {
      out.query1_failed = scr;
      scr = await fetchMarketScreeners(session, 'query2.finance.yahoo.com');
    }
    out.screener = scr;
    const ids = (scr.screeners || []).map(s => s.id);
    const allThree = MARKET_SCR_IDS.every(id => ids.includes(id));
    const allHaveQuotes = (scr.screeners || []).length > 0 && scr.screeners.every(s => s.count > 0);
    out.verdict = scr.ok && allThree && allHaveQuotes
      ? 'PASS: cookie + crumb + 3 screeners con quotes'
      : `FAIL: screener ok=${scr.ok} ids=[${ids.join(',')}]`;
  } catch (err) {
    out.verdict = 'FAIL: exception';
    out.error = err && err.name === 'TimeoutError' ? 'timeout (10s)' : String((err && err.message) || err);
  }
  out.ms = Date.now() - t0;
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Gate del universo MARKET: valida el crumb dance desde Vercel real.
  if (req.query && req.query.smoke) {
    res.setHeader('Cache-Control', 'no-store'); // en vivo siempre — cacheado pierde sentido
    return res.status(200).json(await runMarketSmoke());
  }

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return res.status(200).json({ gainers: [], losers: [], volatile: [], error: 'FINNHUB_API_KEY not set' });
  }

  try {
    // Fetch all quotes in parallel (Finnhub free has 60 req/min, we send ~80 — OK if cached)
    const quotePromises = WATCHLIST.map(async (sym) => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`
        );
        if (!r.ok) return null;
        const q = await r.json();
        // q.c = current, q.dp = % change, q.d = $ change, q.h = high, q.l = low, q.pc = prev close
        if (!q || typeof q.c !== 'number' || q.c === 0) return null;
        return {
          symbol: sym,
          price: +q.c.toFixed(2),
          change: q.d != null ? +q.d.toFixed(2) : null,
          changePct: q.dp != null ? +q.dp.toFixed(2) : null,
          high: q.h || null,
          low: q.l || null,
          prevClose: q.pc || null
        };
      } catch (e) {
        return null;
      }
    });

    const all = (await Promise.all(quotePromises))
      .filter(q => q != null && q.changePct != null);

    // Top gainers (highest positive change)
    const gainers = [...all]
      .filter(q => q.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 10);

    // Top losers (most negative)
    const losers = [...all]
      .filter(q => q.changePct < 0)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 10);

    // Most volatile (highest abs change, regardless of direction)
    const volatile = [...all]
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 10);

    // Cache compartido en el edge: los quotes no cambian en <60s y esto
    // evita que cada visitante re-queme el presupuesto de 60 req/min.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      gainers,
      losers,
      volatile,
      total_scanned: all.length,
      watchlist_size: WATCHLIST.length,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(200).json({
      gainers: [], losers: [], volatile: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
