// ═══════════════════════════════════════════════════════════════
// /api/tape — Quotes batched para la cinta superior (SOLO display).
// % intradía en vivo: regularMarketPrice vs previous close del quote
// de Yahoo (sin API key). Con mercado cerrado Yahoo entrega el cambio
// de la última sesión; en cripto el previous close es el del día UTC
// anterior (cambio 24h estándar).
// Los motores, validadores y fills de agentes NO usan este endpoint —
// siguen en velas diarias cerradas vía /api/price.
// ═══════════════════════════════════════════════════════════════

const MAX_SYMBOLS = 20;

// La app usa 'BTC/USD' para cripto; Yahoo espera 'BTC-USD'
export function toYahooSymbol(sym) {
  const t = String(sym || '').toUpperCase().trim();
  return t.endsWith('/USD') ? t.replace('/USD', '-USD') : t;
}

// Extrae el quote de la cinta desde un payload v8/finance/chart de Yahoo.
// Devuelve null salvo que haya precio Y previous close reales — la cinta
// mantiene su último valor en vez de inventar un +0.00%.
export function extractQuote(chartJson) {
  const meta = chartJson?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
  return {
    price: +price.toFixed(price < 1 ? 6 : 2),
    prevClose: +prevClose.toFixed(prevClose < 1 ? 6 : 2),
    changePct: +(((price - prevClose) / prevClose) * 100).toFixed(2),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const raw = String((req.query && req.query.symbols) || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required, e.g. ?symbols=NVDA,AAPL,BTC/USD' });

  const symbols = [...new Set(raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))]
    .slice(0, MAX_SYMBOLS);

  const quotes = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const ySym = toYahooSymbol(sym);
      // range=1d → chartPreviousClose = cierre de la sesión anterior
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=1d&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
      );
      if (!r.ok) return;
      const q = extractQuote(await r.json());
      if (q) quotes[sym] = q;
    } catch (e) { /* símbolo omitido → la cinta conserva el último valor */ }
  }));

  // Siempre 200: un símbolo ausente significa "conserva el último valor mostrado"
  return res.status(200).json({ quotes, generated_at: new Date().toISOString() });
}
