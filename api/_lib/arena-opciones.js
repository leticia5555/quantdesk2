// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-opciones.js — LA PROBABILIDAD IMPLÍCITA.
//
// "¿Qué probabilidad le asigna el mercado de opciones a que esta acción
// termine arriba del precio al que entré?"
//
// ── DOS MÉTODOS, Y SE DECLARA CUÁL SE USÓ ────────────────────────────
//
// 1. CDF DEL MERCADO (`cdf`) — el bueno, y es MODEL-FREE. La derivada del
//    precio de un call respecto del strike es −(1 − CDF): o sea que con dos
//    strikes contiguos que encierran el precio de entrada, la probabilidad
//    sale del mercado directamente, sin suponer ninguna distribución.
//
//        P(S_T > K) ≈ 1 + (C(K₂) − C(K₁)) / (K₂ − K₁)
//
// 2. BLACK-SCHOLES (`bs`) — el respaldo. Cuando no hay strikes utilizables
//    alrededor de la entrada, N(d₂) con la IV at-the-money. Supone lognormal,
//    que es justamente lo que el método 1 no necesita suponer.
//
// Se prefiere el 1 y se cae al 2, y `metodo` viaja en el resultado: son
// números distintos y promediarlos entre sí sería mezclar dos cosas.
//
// ── LAS TRES HONESTIDADES QUE VAN EN EL PAYLOAD ──────────────────────
//
// · ES RISK-NEUTRAL, no la probabilidad real. Es lo que el mercado COBRA, no
//   lo que el mercado CREE: incluye la prima de riesgo. Sistemáticamente
//   sobreestima la probabilidad de caídas.
// · EL HORIZONTE ES EL DEL VENCIMIENTO MÁS CERCANO, que suele ser días. NO es
//   "va a terminar arriba algún día": es "al cierre de ese viernes".
// · r = 0. Inventar una tasa para un horizonte de días mueve el número menos
//   que el spread de la cadena, y una tasa inventada se ve como un dato.
//
// ENV VARS: ninguna. Puro cálculo.
// ═══════════════════════════════════════════════════════════════

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

// ── N(x): la normal estándar acumulada ───────────────────────────────
// Abramowitz & Stegun 7.1.26 sobre erf. Error < 1.5e-7, determinista y sin
// dependencias — que es lo que hace falta para que el journal sea reproducible.
export function normalCdf(x) {
  if (!Number.isFinite(x)) return null;
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

// ── MÉTODO 2: N(d₂) ──────────────────────────────────────────────────
// P(S_T > K) bajo lognormal con r = 0.
export function probBlackScholes({ spot, strike, iv, dias }) {
  const S = num(spot); const K = num(strike); const sigma = num(iv);
  const T = num(dias) != null ? num(dias) / 365 : null;
  if (S == null || K == null || sigma == null || T == null) return null;
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) return null;
  const d2 = (Math.log(S / K) - (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const p = normalCdf(d2);
  return p == null ? null : +p.toFixed(4);
}

// ── MÉTODO 1: LA CDF DEL MERCADO ─────────────────────────────────────
// Los dos strikes que ENCIERRAN el precio de entrada. Se exige que los dos
// tengan precio utilizable y que el call más caro sea el del strike más bajo:
// una cadena que viola esa monotonía está rota (mid cruzado, sin liquidez), y
// una probabilidad sacada de ahí sale fuera de [0,1] o directamente al revés.
export function probDesdeCadena(calls = [], strike) {
  const K = num(strike);
  if (K == null || K <= 0) return null;

  const precio = (o) => {
    // Mid del bid/ask cuando los dos existen; si no, el último negociado. Un
    // `lastPrice` viejo es peor que un mid, pero es mejor que nada — y se
    // prefiere en ese orden, no se promedian.
    const bid = num(o && o.bid); const ask = num(o && o.ask);
    if (bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
    const last = num(o && o.lastPrice);
    return last != null && last > 0 ? last : null;
  };

  const puntos = (calls || [])
    .map((c) => ({ k: num(c && c.strike), c: precio(c) }))
    .filter((p) => p.k != null && p.k > 0 && p.c != null)
    .sort((a, b) => a.k - b.k);
  if (puntos.length < 2) return null;

  let bajo = null; let alto = null;
  for (let i = 0; i < puntos.length - 1; i++) {
    if (puntos[i].k <= K && puntos[i + 1].k >= K) { bajo = puntos[i]; alto = puntos[i + 1]; break; }
  }
  if (!bajo || !alto || alto.k === bajo.k) return null;
  // Monotonía: un call con strike más alto no puede valer más.
  if (alto.c > bajo.c) return null;

  const p = 1 + (alto.c - bajo.c) / (alto.k - bajo.k);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  return +p.toFixed(4);
}

// Días hasta el vencimiento, desde un epoch en segundos (el formato de Yahoo).
export function diasHasta(expEpochSec, ahora = Date.now()) {
  const ms = num(expEpochSec) != null ? num(expEpochSec) * 1000 : null;
  if (ms == null) return null;
  const d = (ms - ahora) / 86400000;
  // Un vencimiento que ya pasó no es un horizonte: es una cadena vieja.
  return d > 0 ? +d.toFixed(3) : null;
}

// ── EL BLOQUE COMPLETO, para journalear ──────────────────────────────
// `chainRes` = el `optionChain.result[0]` crudo de Yahoo.
export function opcionesDeApertura(chainRes, { entrada, ahora = Date.now() } = {}) {
  const K = num(entrada);
  const chain = chainRes && Array.isArray(chainRes.options) && chainRes.options[0] ? chainRes.options[0] : null;
  if (!chain || K == null) {
    return { disponible: false, motivo: !chain ? 'sin cadena de opciones para este símbolo' : 'sin precio de entrada' };
  }

  const calls = chain.calls || [];
  const puts = chain.puts || [];
  let spot = num(chainRes.quote && (chainRes.quote.regularMarketPrice || chainRes.quote.postMarketPrice));
  if (spot == null) {
    const itm = calls.filter((c) => c.inTheMoney).map((c) => num(c.strike)).filter((x) => x != null);
    if (itm.length) spot = Math.max(...itm);
  }

  // IV at-the-money: el promedio del call y el put más cercanos al spot.
  const cercano = (arr) => {
    if (spot == null) return null;
    let mejor = null; let dist = Infinity;
    for (const o of arr) {
      const k = num(o && o.strike);
      if (k == null) continue;
      const d = Math.abs(k - spot);
      if (d < dist) { dist = d; mejor = o; }
    }
    return mejor;
  };
  const ivs = [cercano(calls), cercano(puts)].map((o) => num(o && o.impliedVolatility)).filter((v) => v != null && v > 0);
  const iv = ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(4) : null;

  const dias = diasHasta(chain.expirationDate, ahora);

  const pCdf = probDesdeCadena(calls, K);
  const pBs = probBlackScholes({ spot, strike: K, iv, dias });
  const p = pCdf != null ? pCdf : pBs;
  const metodo = pCdf != null ? 'cdf' : (pBs != null ? 'bs' : null);

  return {
    disponible: p != null,
    entrada: K,
    spot,
    iv_atm: iv,
    vencimiento: chain.expirationDate ? new Date(chain.expirationDate * 1000).toISOString().slice(0, 10) : null,
    dias_al_vencimiento: dias,
    prob_arriba_de_entrada: p,
    metodo,
    // Los dos, cuando los dos se pueden: son números distintos y guardarlos
    // juntos es lo único que después permite comparar los métodos.
    prob_cdf: pCdf, prob_bs: pBs,
    strikes: calls.length,
    nota: p == null
      ? 'No se pudo derivar la probabilidad: sin strikes utilizables alrededor de la entrada ni IV at-the-money.'
      : `Probabilidad RISK-NEUTRAL de cerrar arriba de $${K} el ${chain.expirationDate ? new Date(chain.expirationDate * 1000).toISOString().slice(0, 10) : '?'} (${dias != null ? dias.toFixed(1) : '?'} días). Es lo que el mercado COBRA, no lo que cree: incluye prima de riesgo. Método ${metodo === 'cdf' ? 'CDF del mercado (model-free)' : 'Black-Scholes N(d₂) con IV ATM (supone lognormal)'}. r = 0.`,
  };
}
