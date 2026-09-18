// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-admission.js — FILTRO DE ADMISIÓN del universo del Arena.
//
// EL BUG QUE LO ORIGINA (journal del 14): DDDX, un OTC de $0.01, llegó al
// buffet y el PM lo consideró. No entró por el canal de movers —ése ya filtra
// precio ≥ $5 desde julio— sino por el canal INSIDER, que no filtraba NADA:
// `trimInsiders` tomaba los Form 4 de la SEC tal cual, y la SEC no distingue
// entre un director de Apple comprando $2M y el dueño de una shell OTC
// comprándose $3,000 de su propia empresa. Los canales tenían criterios de
// admisión distintos —uno estricto, dos inexistentes— y el más flojo mandaba.
//
// Acá vive UN solo criterio, y lo aplican TODOS los canales:
//
//   precio ≥ $5 · market cap ≥ $1B · volumen en dólares ≥ $10M/día (20 sesiones)
//
// FAIL CLOSED, y esto es una decisión de producto, no un accidente: un ticker
// cuyos datos de admisión NO se pueden resolver NO entra. La alternativa
// ("si no sé, que pase") es exactamente cómo entró DDDX. Un nombre rechazado
// por falta de datos se journalea con `reason: 'data_unavailable'` y aparte de
// los rechazados por criterio, para que se vea si el filtro está tirando cosas
// buenas por una falla de cobertura y no por micro-cap.
//
// POINT-IN-TIME: el volumen se computa sobre velas CERRADAS (`completedSlice`),
// nunca con la del día que se opera.
//
// COSTO: ~26 llamadas a Finnhub profile2 + ~8 series de Yahoo por corrida, con
// caché por día en memoria. El deep dive gasta ~20 más; el total queda bajo el
// cap de 60/min del tier gratis. Los movers ya traen precio y volumen del
// endpoint, así que de ésos solo se pide el market cap.
//
// ESE COSTO ES EL DEL BUFFET, y no escala: el universo de B1 son ~600 nombres,
// y 600 profile2 a 60/min son 10 minutos dentro de una función de 300s. Por eso
// `_lib/arena-universe.js` NO llega acá con las manos vacías: prellena `known`
// con precio y volumen medidos en lote por Alpaca (6 requests para 600 nombres)
// y con el market cap de los constituyentes de índice, que su pertenencia ya
// acredita. Este módulo no sabe nada de eso — sigue pidiendo solo lo que le
// falta. Si agregás un canal grande, prellenalo vos también; acá no hay batch.
// ═══════════════════════════════════════════════════════════════

import { extractYahooCandles, toYahooSymbol } from '../candles.js';

// Techo de llamadas a profile2 por lote. El tier gratis de Finnhub corta a 60
// por minuto y el deep dive del mismo run gasta ~20, así que 40 deja margen.
// Lo que queda afuera se journalea como `rate_budget` y NO como falta de datos.
export const FINNHUB_CALL_BUDGET = (() => {
  const n = Number(process.env.ARENA_FINNHUB_CALL_BUDGET);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 40;
})();

export const ADMISSION = {
  min_price: 5,
  min_market_cap_usd: 1_000_000_000,
  min_dollar_volume: 10_000_000,
  volume_lookback_days: 20,
};

// ── EL PISO DE VOLUMEN DEPENDE DEL FEED ──────────────────────────────
// EL BUG: el universo rechazó a AIG por "$8.7M/día". AIG negocia cientos de
// millones. El volumen salía del feed IEX, que es UNA bolsa — ~2-3% del volumen
// consolidado—, así que el piso de $10M se estaba aplicando sobre el 2-3% del
// volumen real: en la práctica pedía ~$400M consolidados. El filtro no medía
// liquidez, medía cuota de mercado de IEX. Y lo traicionero es que el PRECIO de
// IEX está bien: solo el volumen es una fracción, así que todo se veía correcto
// salvo el número que decidía.
//
// EL FACTOR ES UNA APROXIMACIÓN Y SE DECLARA COMO TAL. La cuota de IEX no es
// una constante: varía por nombre y por día. $0.3M sobre IEX ≈ $10M
// consolidados asumiendo ~3%, que es el extremo GENEROSO del rango (2-3%) —
// deliberadamente, porque errar hacia dejar entrar un nombre algo menos líquido
// es más barato que volver a tirar a la mitad del S&P 500. El journal dice qué
// feed contestó y qué piso se aplicó, para que nadie lea "$0.3M" y crea que el
// Arena opera microcaps.
export const MIN_DOLLAR_VOLUME_POR_FEED = {
  sip: 10_000_000,
  delayed_sip: 10_000_000,
  iex: Number(process.env.ARENA_MIN_DOLLAR_VOLUME_IEX) || 300_000,
};

// Las reglas de admisión ajustadas al feed que de verdad contestó.
// Devuelve { ...ADMISSION, min_dollar_volume, feed, volume_note }.
export function reglasParaFeed(feed, base = ADMISSION) {
  const f = String(feed || '').toLowerCase();
  const piso = MIN_DOLLAR_VOLUME_POR_FEED[f];
  if (!piso) {
    // Feed desconocido → se queda el piso consolidado. Aflojar sin saber sobre
    // qué universo de volumen se está midiendo sería aflojar a ciegas.
    return { ...base, feed: f || null, volume_note: `Feed desconocido (${feed}): se aplica el piso consolidado de $${(base.min_dollar_volume / 1e6).toFixed(0)}M sin ajustar.` };
  }
  const consolidado = f === 'iex';
  return {
    ...base,
    min_dollar_volume: piso,
    feed: f,
    volume_note: consolidado
      ? `Volumen medido sobre el feed IEX (~2-3% del consolidado), así que el piso es $${(piso / 1e6).toFixed(1)}M sobre IEX ≈ $10M consolidados. Es una APROXIMACIÓN: la cuota de IEX varía por nombre y por día. NO significa que el Arena acepte nombres de $0.3M/día reales.`
      : `Volumen consolidado (feed ${f}): el piso es el real, $${(piso / 1e6).toFixed(0)}M/día.`,
  };
}

// Caché por DÍA. La admisión es una propiedad lenta del nombre (market cap y
// volumen medio no cambian de una corrida a la otra); recalcularla en cada tick
// del vigilante sería quemar el rate limit de Finnhub sin aprender nada.
const cache = new Map(); // 'YYYY-MM-DD:SYMBOL' → { price, marketCap, dollarVolume }
const dayKey = (sym, now) => now.toISOString().slice(0, 10) + ':' + sym;

export function _resetAdmissionCache() { cache.clear(); }

// ── El criterio, puro y testeable sin red ────────────────────────────
export function isAdmissible(d, rules = ADMISSION) {
  if (!d || !d.symbol) return { ok: false, reason: 'sin símbolo' };
  const miss = [];
  if (!Number.isFinite(d.price)) miss.push('precio');
  if (!Number.isFinite(d.marketCap)) miss.push('market cap');
  if (!Number.isFinite(d.dollarVolume)) miss.push('volumen en dólares');
  if (miss.length) {
    return { ok: false, reason: 'data_unavailable', missing: miss };
  }
  if (d.price < rules.min_price) {
    return { ok: false, reason: `precio $${d.price.toFixed(2)} < $${rules.min_price}` };
  }
  if (d.marketCap < rules.min_market_cap_usd) {
    return { ok: false, reason: `market cap $${(d.marketCap / 1e6).toFixed(0)}M < $${(rules.min_market_cap_usd / 1e9).toFixed(0)}B` };
  }
  if (d.dollarVolume < rules.min_dollar_volume) {
    return { ok: false, reason: `volumen $${(d.dollarVolume / 1e6).toFixed(1)}M/día < $${(rules.min_dollar_volume / 1e6).toFixed(0)}M` };
  }
  return { ok: true };
}

// ── Resolución de datos (best-effort, nunca lanza) ───────────────────
function safeJson(r) {
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}

// Precio del último cierre COMPLETO + volumen en dólares promedio de las
// últimas N sesiones cerradas. Una sola request por símbolo.
export async function fetchPriceAndVolume(symbol, now = new Date(), fetchImpl = fetch) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?range=3mo&interval=1d`;
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    const j = await safeJson(r);
    // `extractYahooCandles` devuelve { candles, currency }, NO un array pelado.
    const extracted = extractYahooCandles(j);
    const candles = extracted && extracted.candles;
    if (!candles || !candles.length) return { price: null, dollarVolume: null };
    // Solo velas CERRADAS: la del día en curso no cuenta (point-in-time).
    const todayUtc = now.toISOString().slice(0, 10);
    const closed = candles.filter((c) => {
      const d = new Date((c.t || 0) * 1000).toISOString().slice(0, 10);
      return d < todayUtc || (d === todayUtc && now.getUTCHours() >= 22);
    });
    if (!closed.length) return { price: null, dollarVolume: null };
    const last = closed[closed.length - 1];
    const window = closed.slice(-ADMISSION.volume_lookback_days);
    const dvs = window.map((c) => (Number(c.c) || 0) * (Number(c.v) || 0)).filter((x) => x > 0);
    const dollarVolume = dvs.length ? dvs.reduce((a, b) => a + b, 0) / dvs.length : null;
    return { price: Number(last.c) || null, dollarVolume };
  } catch (_) { return { price: null, dollarVolume: null }; }
}

// Market cap en USD desde Finnhub profile2 (`marketCapitalization` viene en
// MILLONES — el ×1e6 es la trampa clásica de ese campo).
//
// ── POR QUÉ AHORA DEJA RASTRO ────────────────────────────────────────
// Esto devolvía `null` en cinco situaciones —sin key, HTTP de error, 429 por
// rate limit, cuerpo sin el campo, timeout— y las cinco terminaban en el mismo
// `data_unavailable`. Cuando el canal del día entregó 100 candidatos y se
// admitieron CERO, no había forma de saber si el problema era Finnhub, la
// cuota, o que los nombres no eran acciones.
//
// EL 429 ES EL QUE MÁS IMPORTA. El tier gratis corta a 60 llamadas por minuto.
// Un lote de 100 nombres del día, aunque salga de a 4 en paralelo, cruza ese
// techo a la mitad: los primeros ~60 resuelven y el resto recibe 429. Visto
// desde afuera eso se lee como "Finnhub no tiene estos nombres", que es una
// conclusión falsa sobre el DATO cuando en realidad es un límite NUESTRO.
export async function fetchMarketCap(symbol, finnhubKey, fetchImpl = fetch, diag = null) {
  const anota = (fila) => { if (Array.isArray(diag)) diag.push({ symbol, ...fila }); };
  if (!finnhubKey) { anota({ ok: false, reason: 'sin_key' }); return null; }
  try {
    const r = await fetchImpl(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`,
      { signal: AbortSignal.timeout(12000) });
    if (!r || !r.ok) {
      const status = (r && r.status) || 0;
      anota({ ok: false, reason: status === 429 ? 'rate_limit' : 'http_error', status });
      return null;
    }
    const j = await safeJson(r);
    const m = j && Number(j.marketCapitalization);
    if (!Number.isFinite(m) || m <= 0) {
      // Finnhub devuelve `{}` para lo que no cubre. Eso NO es un fallo nuestro
      // y conviene distinguirlo de un 429: "no lo tiene" vs "no nos dejó pedir".
      anota({ ok: false, reason: j && Object.keys(j).length ? 'sin_market_cap' : 'sin_cobertura', status: r.status });
      return null;
    }
    anota({ ok: true, status: r.status });
    return m * 1e6;
  } catch (e) {
    const msg = String((e && e.message) || e);
    anota({ ok: false, reason: /abort|timeout/i.test(msg) ? 'timeout' : 'red', detail: msg });
    return null;
  }
}

// Resuelve los datos de admisión de un lote. `known` trae lo que el canal ya
// sabe (los movers vienen con precio y volumen del endpoint: eso ahorra una
// request por nombre y no se vuelve a pedir).
// `mcapCache` es la caché PERSISTIDA del market cap ({ leer, guardar }), que
// se INYECTA en vez de importarse: este módulo sigue sin conocer la DB y se
// prueba entero sin Neon. Sin ella el comportamiento es el de siempre.
export async function resolveAdmission(symbols, { finnhubKey, now = new Date(), known = {}, fetchImpl = fetch, concurrency = 4, maxFinnhub = FINNHUB_CALL_BUDGET, diag = null, mcapCache = null } = {}) {
  const out = {};
  const todo = [];
  let gastadas = 0;
  for (const raw of symbols || []) {
    const sym = String(raw || '').trim().toUpperCase();
    if (!sym || out[sym]) continue;
    const hit = cache.get(dayKey(sym, now));
    if (hit) { out[sym] = hit; continue; }
    out[sym] = null;
    todo.push(sym);
  }

  // ── LA FOTO PERSISTIDA, ANTES DE GASTAR UNA SOLA LLAMADA ───────────
  // Se lee en UN viaje para todo el lote. Lo que venga de acá entra por la
  // misma puerta que `known`: ni siquiera cuenta contra el presupuesto, porque
  // no se pide nada. Los nombres del borde del piso vuelven vacíos a propósito
  // (su foto vence en un día) y ésos sí se preguntan.
  const persistidos = mcapCache && mcapCache.leer ? await mcapCache.leer(todo).catch(() => ({})) : {};
  let deCache = 0;
  const frescos = {};
  // Lotes chicos y secuenciales entre lotes: el tier gratis de Finnhub corta a
  // 60/min y un burst de 30 en paralelo lo roza con el deep dive del mismo run.
  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);
    await Promise.all(batch.map(async (sym) => {
      const k = known[sym] || {};
      const needPV = !Number.isFinite(k.price) || !Number.isFinite(k.dollarVolume);
      // EL PRESUPUESTO DE LLAMADAS. Si el lote pide más profile2 de los que
      // caben en el tier gratis, las que sobran NO se piden — y se journalean
      // como `rate_budget`, no como "el nombre no tiene datos". La diferencia
      // es entre "no lo sabemos porque no preguntamos" y "preguntamos y no
      // está": la primera es nuestra y se arregla subiendo el plan o bajando el
      // lote; la segunda es del nombre.
      let mcapPromise;
      if (Number.isFinite(k.marketCap)) mcapPromise = Promise.resolve(k.marketCap);
      else if (Number.isFinite(persistidos[sym])) {
        deCache++;
        if (Array.isArray(diag)) diag.push({ symbol: sym, ok: true, reason: 'cache_persistida', detail: 'no se pidió a Finnhub: la foto guardada en Neon sigue vigente' });
        mcapPromise = Promise.resolve(persistidos[sym]);
      } else if (gastadas >= maxFinnhub) {
        if (Array.isArray(diag)) diag.push({ symbol: sym, ok: false, reason: 'rate_budget', detail: `no se pidió: el lote ya gastó ${maxFinnhub} llamadas a Finnhub` });
        mcapPromise = Promise.resolve(null);
      } else { gastadas++; mcapPromise = fetchMarketCap(sym, finnhubKey, fetchImpl, diag); }

      const [pv, mcap] = await Promise.all([
        needPV ? fetchPriceAndVolume(sym, now, fetchImpl) : Promise.resolve({ price: k.price, dollarVolume: k.dollarVolume }),
        mcapPromise,
      ]);
      const row = {
        symbol: sym,
        price: Number.isFinite(pv.price) ? pv.price : (Number.isFinite(k.price) ? k.price : null),
        dollarVolume: Number.isFinite(pv.dollarVolume) ? pv.dollarVolume : null,
        marketCap: Number.isFinite(mcap) ? mcap : null,
      };
      out[sym] = row;
      cache.set(dayKey(sym, now), row);
      // Solo se persiste lo que se acaba de PEDIR. Reescribir una foto que vino
      // de la caché le renovaría la fecha sin haber mirado nada — una foto que
      // no envejece nunca es peor que no tener caché.
      if (Number.isFinite(mcap) && !Number.isFinite(persistidos[sym]) && !Number.isFinite(k.marketCap)) frescos[sym] = mcap;
    }));
  }
  if (mcapCache && mcapCache.guardar && Object.keys(frescos).length) {
    await mcapCache.guardar(frescos).catch(() => 0);
  }
  if (Array.isArray(diag) && deCache) {
    diag.push({ symbol: null, ok: true, reason: 'cache_persistida_resumen', detail: `${deCache} nombres resueltos desde Neon sin gastar cuota de Finnhub (de ${todo.length} del lote)` });
  }
  return out;
}

// Parte una lista de items en admitidos y rechazados, conservando el porqué de
// cada rechazo. `symbolOf` dice de qué campo sacar el ticker (los canales
// tienen forma distinta: `symbol` en movers, `ticker` en insiders/earnings).
export function partitionByAdmission(items, data, symbolOf = (x) => x && x.symbol, rules = ADMISSION) {
  const admitted = [];
  const rejected = [];
  for (const it of items || []) {
    const sym = String(symbolOf(it) || '').trim().toUpperCase();
    const verdict = isAdmissible({ symbol: sym, ...(data[sym] || {}) }, rules);
    if (verdict.ok) admitted.push(it);
    else rejected.push({ symbol: sym, reason: verdict.reason, ...(verdict.missing ? { missing: verdict.missing } : {}) });
  }
  return { admitted, rejected };
}
