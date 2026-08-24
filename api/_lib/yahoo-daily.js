// ═══════════════════════════════════════════════════════════════════
// api/_lib/yahoo-daily.js — velas diarias AJUSTADAS de Yahoo.
//
// Única frontera de precios de los backtests (PEAD y rotación): los precios
// NO viven en Neon, se bajan en vivo. Se extrajo de api/pead-analyze.js
// cuando el segundo backtest necesitó exactamente el mismo fetch — una sola
// implementación del ajuste por dividendos, no dos que se desincronizan.
//
// El chart v8 devuelve `quote[0]` (o/h/l/c ajustados SOLO por splits) y
// `adjclose[0]` (cierre ajustado por splits Y dividendos). Mezclarlos rompe
// la serie: un open sin ajustar contra un close ajustado inventa un retorno
// del tamaño del dividendo el día ex. Se deriva el factor del día,
// f = adjclose/close, y se aplica AL OPEN también — así open y close quedan
// en la misma escala y el retorno intradía/overnight es el real.
// ═══════════════════════════════════════════════════════════════════

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const CONCURRENCIA = 8;      // Yahoo aguanta de sobra; 8 mantiene el fetch cortés
const REINTENTOS = 2;

function extraeSerieAjustada(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(ts) || !q) return null;
  const fechas = [], opens = [], closes = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], c = q.close?.[i];
    if (![o, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    const a = Array.isArray(adj) ? adj[i] : null;
    const f = Number.isFinite(a) && a > 0 ? a / c : 1;
    fechas.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    opens.push(o * f);
    closes.push(c * f);
  }
  return fechas.length ? { fechas, opens, closes } : null;
}

async function bajaSerie(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=1d&range=${encodeURIComponent(range)}&events=div%2Csplit`;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    const r = await fetch(url, { headers: UA }).catch(() => null);
    if (r && r.ok) {
      const serie = extraeSerieAjustada(await r.json().catch(() => null));
      if (serie) return serie;
    }
    if (intento < REINTENTOS) await new Promise((s) => setTimeout(s, 300 * (intento + 1)));
  }
  return null;
}

// Baja N símbolos con concurrencia acotada. Los que fallan vuelven como null
// y el que llama los reporta — un símbolo silenciosamente ausente es una
// muestra distinta a la que dice el JSON.
async function bajaSeries(symbols, range) {
  const out = {};
  const cola = [...symbols];
  const worker = async () => {
    while (cola.length) {
      const s = cola.shift();
      out[s] = await bajaSerie(s, range);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, symbols.length) }, worker));
  return out;
}

export { extraeSerieAjustada, bajaSerie, bajaSeries, UA, CONCURRENCIA, REINTENTOS };
