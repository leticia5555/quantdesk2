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
// CONTRATO DE DATOS (por qué el % de periodo dejó de romperse):
// este endpoint NO devuelve ningún porcentaje pre-cocinado. Solo entrega
// el precio actual y la SERIE cronológica de cierres diarios (~3 meses,
// con timestamp por punto). TODO porcentaje se calcula en el cliente con
// UNA sola función compartida (qdPeriodChange) contra el ancla del
// periodo elegido (1S/1M/3M) y se pinta SIEMPRE con su etiqueta. Antes el
// servidor mandaba un changePct que, para símbolos sin
// regularMarketPreviousClose (índices/futuros/FX), caía a
// chartPreviousClose — el cierre de HACE 30 DÍAS del rango — y se pintaba
// como si fuera diario (KOSPI −21.97% "hoy"). Al no exponer ningún % ya
// no hay nada que etiquetar mal: la serie es la única verdad.
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

// Redondeo por CIFRAS SIGNIFICATIVAS, no por decimales fijos. El bug de
// los "escalones cuadrados" de EUR/USD nacía de `toFixed(v<1?6:2)`: EUR/USD
// ≈ 1.0850 es >1, así que se aplastaba a 1.08 y toda la variación mensual
// (2ª–4ª cifra decimal) colapsaba en 2 o 3 valores repetidos → una línea
// plana con escalones. toPrecision(6) preserva la variación real de FX
// (1.0850 → 1.085) sin arrastrar decimales de ruido en índices grandes
// (38500.0 → 38500). +() normaliza el string de vuelta a número.
function sig6(v) { return +v.toPrecision(6); }

// v8/finance/chart (range=3mo, interval=1d) → { price, currency,
// series:[{t,c}] }. NO devuelve porcentaje alguno: el % por periodo lo
// calcula el cliente (qdPeriodChange) desde la serie. Devuelve null salvo
// que haya precio actual Y al menos 2 cierres reales (sin serie no hay
// periodo que calcular) — jamás se inventa un dato.
export function extractMacro(chartJson) {
  const r = chartJson?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  if (!Number.isFinite(price) || price <= 0) return null;

  // Serie cronológica: cierre diario finito + su timestamp (Yahoo mete
  // nulls en huecos de sesión; se descartan alineando close↔timestamp).
  const ts = r?.timestamp || [];
  const closesRaw = r?.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < closesRaw.length; i++) {
    const c = closesRaw[i], t = ts[i];
    if (Number.isFinite(c) && c > 0 && Number.isFinite(t)) series.push({ t, c: sig6(c) });
  }
  // Sin ≥2 puntos no hay ventana de periodo (ni 1S) → el cliente omitiría
  // la tarjeta igual; se devuelve null para no mandar ruido.
  if (series.length < 2) return null;

  return {
    price: sig6(price),
    currency: meta.currency || null,
    // ~3 meses de diario (~66 sesiones) alcanza para 1S/1M/3M holgado.
    series: series.slice(-70),
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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
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
