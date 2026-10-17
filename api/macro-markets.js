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
  // ── LOS CRUCES QUE R2 NECESITA PARA EL RENDIMIENTO EN PESOS ──────────
  // El encargo pide que el toggle MXN recalcule el rendimiento de TODO activo,
  // "también el Nikkei, el DAX, etc.". Para eso hace falta el cruce de su
  // moneda contra el peso, y sin la serie de esa moneda contra el dólar el
  // rendimiento en pesos sale "—" con causa (regla 2) en lugar de salir.
  // El yen y el euro ya estaban arriba; faltaban la libra (FTSE), el won
  // (KOSPI), el dólar de Hong Kong (HSI) y el real (BOVESPA). El peso NO va
  // acá: viene del FIX de Banxico, que es la fuente oficial y trae su fecha.
  'GBPUSD=X', 'KRW=X', 'HKD=X', 'BRL=X',
  // Y los de los índices que entraron con el artboard 4: sin el cruce de su
  // moneda, el S&P/TSX, el COLCAP, Shanghái, el Nifty y el ASX no pueden
  // convertirse a pesos y su cuadro diría "—" con causa. Todos en la forma
  // "unidades por dólar", igual que JPY=X.
  'CAD=X', 'CNY=X', 'INR=X', 'AUD=X',
  'CL=F', 'BZ=F',               // commodities: WTI, Brent
  '^N225', '^KS11', '^HSI',     // Asia
  '^GDAXI', '^FTSE',            // Europa
  '^MXX', '^BVSP',              // LATAM
  // ── LOS ÍNDICES DEL ARTBOARD 4 (Mundo) ──────────────────────────────
  // El mockup pide 14 índices por región y el endpoint traía 7. Los que
  // faltaban, con el ticker que Yahoo usa para cada uno:
  '^GSPC', '^NDX',              // EE.UU. — el ÍNDICE, no el futuro (ES=F/NQ=F
                                //   siguen arriba porque el tab MACRO los usa)
  '^GSPTSE',                    // Canadá — S&P/TSX
  '^FCHI',                      // Francia — CAC 40
  '000001.SS',                  // China — Shanghai Composite
  '^NSEI',                      // India — Nifty 50
  '^AXJO',                      // Australia — ASX 200
  // SUDAMÉRICA SE QUEDA EN BRASIL. `^COLCAP` no existe en Yahoo, y `^IPSA`
  // tampoco: los dos devolvieron 404, comprobados por Lety contra producción
  // (2026-09-29 y 2026-10-02). Se fueron el índice y su cruce `CLP=X`, que ya
  // no convierte nada. No se sustituyen por un ticker parecido: un índice que
  // no se pudo comprobar no entra al mapa.
  // Cripto, FX y materias primas de la última región del mockup.
  'BTC-USD',                    // Bitcoin — Lety confirmó que Yahoo lo tiene
  'MXN=X',                      // USD/MXN de mercado, para el CUADRO. La
                                //   conversión a pesos usa el FIX de Banxico,
                                //   que es otra cosa y trae su fecha.
  'GC=F',                       // Oro — futuro COMEX, USD/oz
  'ES=F', 'NQ=F', 'YM=F',       // futuros EE.UU.
];

// ── POR QUÉ 1 AÑO Y NO 3 MESES ────────────────────────────────────────
// Eran `range=3mo`: ~70 puntos, con los que 1D/1S/1M/3M se pueden calcular y
// **YTD no**. Es el mismo problema que el mapa de R1 tuvo y resolvió pidiendo
// un año. Decisión de Lety (2026-09-29): subir a 1y, que es aditivo — el tab
// MACRO de `app.html` calcula sus periodos desde la serie con `qdPeriodChange`,
// que ancla por FECHA, así que una serie más larga no le cambia ningún número;
// sólo habilita los que antes no alcanzaban.
//
// El costo: ~250 puntos × 23 símbolos en una respuesta que ya estaba cacheada
// para toda la base de usuarios. Sigue siendo UN request por ventana de 2
// minutos, que es lo que la regla 7 pide.
const RANGO = '1y';

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
    // ── LA FECHA DEL PRECIO, QUE FALTABA ────────────────────────────────
    // `price` es el último precio de mercado y la serie diaria termina en el
    // último CIERRE: cuando la sesión de hoy ya corrió pero el cierre todavía
    // no entró a la serie, son de días distintos. Sin este timestamp no hay
    // manera de saberlo, y el cliente terminaba mostrando el precio de hoy con
    // el % de ayer — el KOSPI en 6,870.81 con el −2.70% del lunes.
    precio_t: Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : null,
    currency: meta.currency || null,
    // Un AÑO de diario, no ~3 meses. Esto estaba en `slice(-70)` y dejaba sin
    // efecto el `range=1y`: el fetch pedía un año y el recorte devolvía 70
    // puntos, con los que el ancla de fin de año no existe y YTD sale "—".
    // 280 = las ~252 sesiones de un año más margen.
    series: series.slice(-280),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const data = {};
  // POR QUÉ FALTA UN SÍMBOLO. Antes se omitía en silencio, y desde el cliente
  // "no llegó" tenía tres causas indistinguibles: el ticker no existe, Yahoo
  // falló, o la respuesta vino sin serie utilizable. Con `^IPSA` costó una
  // ronda entera no poder decidir entre "ticker malo" y "caché vieja". Ahora
  // cada omisión viaja con su razón, y el cuadro gris puede decirla.
  const omitidos = {};
  await Promise.all(MACRO_SYMBOLS.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${RANGO}&interval=1d`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) {
        // 404 = el ticker no existe en Yahoo. 429 = nos frenaron. Son cosas
        // distintas y se arreglan distinto.
        omitidos[sym] = `Yahoo respondió HTTP ${r.status}`;
        return;
      }
      const m = extractMacro(await r.json());
      if (m) data[sym] = m;
      else omitidos[sym] = 'Yahoo contestó 200 pero sin precio o con menos de 2 cierres';
    } catch (e) {
      omitidos[sym] = `no se pudo consultar: ${String((e && e.message) || e)}`;
    }
  }));

  // Caché CDN compartida: 1 request por ventana para toda la base de
  // usuarios. TTL corto — es un dashboard, no un motor de fills.
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  // Siempre 200: un símbolo ausente es "sin dato", no un error global.
  return res.status(200).json({ data, omitidos, generated_at: new Date().toISOString() });
}
