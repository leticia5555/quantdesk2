// ═══════════════════════════════════════════════════════════════
// /api/movers — Top gainers/losers/most active
// Dos universos (toggle en el tab MOVERS):
//   default            → WATCHLIST: quotes de la lista curada (Finnhub)
//   ?universe=market   → MARKET: mercado US completo (Alpha Vantage)
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

// ═══ Sonda Yahoo (plan A, en pausa) — se conserva a propósito ═════
// Plan A era Yahoo predefined screeners (day_gainers + day_losers +
// most_actives en una llamada), pero el gate falló: el smoke desde Vercel
// real (jul 2026) dio 429 en /v1/test/getcrumb — Yahoo rate-limita el
// cookie+crumb dance desde IPs de datacenter, aunque el v8/chart sin auth
// sí funciona. La sonda ?smoke=market queda en el código para re-testear
// si Yahoo se ablanda algún día; el universo MARKET corre con el plan B
// (Alpha Vantage, más abajo).

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

// ═══ Universo MARKET — Plan B activo: Alpha Vantage TOP_GAINERS_LOSERS ═══
// Una sola llamada devuelve gainers + losers + most active del mercado US
// completo. Trade-offs aceptados del free tier: sin nombre de empresa ni
// high/low, y data efectivamente EOD — observado en prod que last_updated
// se queda en el cierre anterior con el mercado abierto. El s-maxage=3600
// es solo mecánica de caché (25 req/día gratis → ~24 hits reales/día como
// techo); la UI etiqueta la frescura de la DATA ("datos al cierre"), no
// la del caché.

// Warrants/rights/units ('ABC+', 'XYZ^', 'AB-C') y sub-$1: el raw de AV
// viene dominado por ese ruido; sin filtro la vista MARKET sería inusable.
const AV_JUNK_TICKER = /[^A-Z.]/;

function mapAvList(list) {
  return (Array.isArray(list) ? list : []).map(e => {
    const price = Number(e.price);
    const change = Number(e.change_amount);
    const changePct = Number(String(e.change_percentage || '').replace('%', ''));
    const volume = Number(e.volume);
    if (!e.ticker || !Number.isFinite(price) || !Number.isFinite(changePct)) return null;
    return {
      symbol: e.ticker,
      price: +price.toFixed(2),
      change: Number.isFinite(change) ? +change.toFixed(2) : null,
      changePct: +changePct.toFixed(2),
      high: null,   // AV free no los da — trade-off documentado del plan B
      low: null,
      prevClose: Number.isFinite(change) ? +(price - change).toFixed(2) : null,
      volume: Number.isFinite(volume) ? volume : null,
    };
  }).filter(q => q && !AV_JUNK_TICKER.test(q.symbol) && q.price >= 1);
}

// Exportada para tests: JSON crudo de AV → contrato de movers, o null si
// el payload no es el esperado. Ojo: AV responde 200 con {Information}
// cuando rate-limita, así que "200 OK" no garantiza datos.
export function mapAlphaVantageMovers(json) {
  if (!json || !Array.isArray(json.top_gainers)) return null;
  const gainers = mapAvList(json.top_gainers).slice(0, 10);
  const losers = mapAvList(json.top_losers).slice(0, 10);
  const actives = mapAvList(json.most_actively_traded).slice(0, 10);
  if (!gainers.length && !losers.length && !actives.length) return null;
  return { gainers, losers, actives, last_updated: json.last_updated || null };
}

async function buildMarketMovers() {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return { error: 'ALPHAVANTAGE_API_KEY not set' };
  try {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${key}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return { error: `Alpha Vantage HTTP ${r.status}` };
    const j = await r.json();
    const mapped = mapAlphaVantageMovers(j);
    if (!mapped) {
      const note = j && (j.Note || j.Information || j['Error Message']);
      return { error: note ? 'Alpha Vantage: ' + String(note).slice(0, 140) : 'Alpha Vantage: unexpected payload' };
    }
    return { data: mapped };
  } catch (err) {
    return {
      error: err && err.name === 'TimeoutError'
        ? 'Alpha Vantage timeout (10s)'
        : 'Alpha Vantage: ' + String((err && err.message) || err)
    };
  }
}

// ═══ Universo WATCHLIST (comportamiento original, intacto) ═════════

async function buildWatchlistMovers(finnhubKey) {
  if (!finnhubKey) {
    return { gainers: [], losers: [], volatile: [], error: 'FINNHUB_API_KEY not set' };
  }

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

  return {
    gainers,
    losers,
    volatile,
    total_scanned: all.length,
    watchlist_size: WATCHLIST.length,
    generated_at: new Date().toISOString()
  };
}

// ═══ Handler ═══════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Sonda del plan A (Yahoo crumb dance) — en vivo, sin cache.
  if (req.query && req.query.smoke) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await runMarketSmoke());
  }

  const universe = String((req.query && req.query.universe) || 'watchlist').toLowerCase();

  try {
    if (universe === 'market') {
      const market = await buildMarketMovers();
      if (market.data) {
        // 25 req/día del free tier de AV → 1h de edge cache es el techo honesto.
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json({
          universe: 'market',
          source: 'Alpha Vantage TOP_GAINERS_LOSERS',
          ...market.data,
          generated_at: new Date().toISOString()
        });
      }
      // Degradación VISIBLE: nunca panel vacío ni fallo silencioso — la UI
      // muestra banner de fallback con la razón y renderiza la watchlist.
      const wl = await buildWatchlistMovers(process.env.FINNHUB_API_KEY);
      if (!wl.error) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({
        universe: 'watchlist',
        universe_fallback: true,
        fallback_reason: market.error,
        ...wl
      });
    }

    const wl = await buildWatchlistMovers(process.env.FINNHUB_API_KEY);
    // Cache compartido en el edge: los quotes no cambian en <60s y esto
    // evita que cada visitante re-queme el presupuesto de 60 req/min.
    if (!wl.error) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ universe: 'watchlist', ...wl });

  } catch (err) {
    return res.status(200).json({
      gainers: [], losers: [], volatile: [],
      error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
    });
  }
}
