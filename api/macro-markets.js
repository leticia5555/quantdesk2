// ═══════════════════════════════════════════════════════════════
// /api/macro-markets — un solo batch para el tab MACRO (SOLO display).
// Vol (VIX), rendimientos del Tesoro, FX global, commodities, índices
// globales por región y futuros de EE.UU. — TODO desde Yahoo v8 chart,
// la misma fuente sin key que ya usan /api/tape y /api/candles (cero
// Finnhub: Finnhub no cubre ^índices, =F futuros ni =X divisas).
//
// Sin parámetros: la lista es fija y curada, así TODOS los usuarios
// comparten UNA sola entrada de caché CDN (s-maxage). El servidor abre
// ~19 fetches a Yahoo SOLO en un cache-miss (cada ~2 min); el cliente
// hace 1 request. El click de cada tarjeta cae a /api/candles (mismo
// símbolo Yahoo) — cero llamadas extra hasta que se abre el modal.
//
// Por tarjeta: precio, cierre previo, % de cambio de sesión y una
// sparkline de ~30 días (cierres diarios). El cliente aplica el ÷10 de
// los rendimientos (^TNX/^TYX vienen ×10) con heurística robusta y
// calcula el spread 10Y-2Y — transforms de display, no de datos.
// ═══════════════════════════════════════════════════════════════

// Universo fijo. El orden/agrupado y las etiquetas viven en el cliente;
// aquí solo importa el conjunto de símbolos Yahoo a poblar.
export const MACRO_SYMBOLS = [
  '^VIX',                       // volatilidad
  '^TNX', '2YY=F', '^TYX',      // rendimientos: 10Y, 2Y (futuro CBOT, % directo), 30Y
  'DX-Y.NYB', 'JPY=X', 'EURUSD=X', // FX global: DXY, USD/JPY, EUR/USD
  'CL=F', 'BZ=F',               // commodities: WTI, Brent
  '^N225', '^KS11', '^HSI',     // Asia
  '^GDAXI', '^FTSE',            // Europa
  '^MXX', '^BVSP',              // LATAM
  'ES=F', 'NQ=F', 'YM=F',       // futuros EE.UU.
];

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

// v8/finance/chart (range=1mo, interval=1d) → { price, prevClose,
// changePct, spark:[cierres], currency }. Devuelve null salvo que haya
// precio Y cierre previo reales — jamás se inventa un +0.00%.
export function extractMacro(chartJson) {
  const r = chartJson?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;

  // Sparkline: cierres diarios finitos (Yahoo mete nulls en huecos).
  const closesRaw = r?.indicators?.quote?.[0]?.close || [];
  const spark = [];
  for (const c of closesRaw) {
    if (Number.isFinite(c) && c > 0) spark.push(+c.toFixed(c < 1 ? 6 : 2));
  }

  const dp = price < 1 ? 6 : 2;
  return {
    price: +price.toFixed(dp),
    prevClose: +prevClose.toFixed(dp),
    changePct: +(((price - prevClose) / prevClose) * 100).toFixed(2),
    spark: spark.slice(-30),
    currency: meta.currency || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const data = {};
  await Promise.all(MACRO_SYMBOLS.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) return;
      const m = extractMacro(await r.json());
      if (m) data[sym] = m;
    } catch (e) { /* símbolo omitido → el cliente conserva/omite la tarjeta */ }
  }));

  // Caché CDN compartida: 1 request por ventana para toda la base de
  // usuarios. TTL corto — es un dashboard, no un motor de fills.
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  // Siempre 200: un símbolo ausente es "sin dato", no un error global.
  return res.status(200).json({ data, generated_at: new Date().toISOString() });
}
