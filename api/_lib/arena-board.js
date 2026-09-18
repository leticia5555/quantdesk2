// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-board.js — B2: EL TABLERO.
//
// Lo que los siete agentes miran, IDÉNTICO para todos, en el prefijo cacheado.
// Reemplaza al buffet como "lo que el PM ve": el buffet era una lista de
// candidatos que nosotros elegimos; el tablero es el MERCADO, y quién es
// candidato lo decide él.
//
//   · índices y VIX
//   · calor por sector (11 ETFs, 1d / 5d / 1m)
//   · top 30 gainers y losers DEL UNIVERSO (no del mercado entero)
//   · top 20 por RVOL (volumen del día contra su promedio de 20 sesiones)
//   · breakouts de 52 semanas
//   · earnings de los próximos 5 días
//   · titulares de M&A / upgrades / downgrades
//
// El LIBRO de cada agente y sus últimas 3 decisiones NO están acá: son lo único
// que varía entre agentes, así que van del lado volátil del corte de caché. Si
// entraran, los siete tendrían prefijos distintos y la caché no serviría para
// nada (ver D2 y el encabezado de ANTHROPIC_CACHE_MIN_TOKENS en el registry).
//
// ── EL PRESUPUESTO DE TOKENS ES UNA REGLA, NO UNA ESPERANZA ──────────
// 3-4K tokens. Si una sección crece, otra cede. Por eso el renderizador es
// TABULAR y no JSON: `NVDA 189.2 +8.1 3.2x` son ~12 tokens; el mismo dato como
// `{"symbol":"NVDA","price":189.2,"change_pct":8.1,"rvol":3.2}` son ~30. Sobre
// 100 filas eso es la diferencia entre caber y no caber. Se MIDE y se journalea
// (`tokens_est` por sección), y `trimToBudget` recorta por la cola cuando se
// pasa — nunca en el medio, para que lo que quede siga siendo legible.
//
// ── DE DÓNDE SALE CADA COSA (y qué NO se paga por corrida) ───────────
// El universo y su rango de 52 semanas los precomputa el cron pre-apertura
// (_lib/arena-universe.js). El tablero solo agrega lo INTRADÍA: snapshots de
// precio/volumen y titulares. Sin eso, cada corrida pagaría ~600 símbolos ×
// 52 barras tres veces al día para un dato que no cambia dentro del día.
//
// ── POINT-IN-TIME, con una asimetría deliberada ──────────────────────
// Los retornos de sector y el rango de 52 semanas salen de velas CERRADAS. El
// precio del día y el RVOL son VIVOS a propósito: el PM está decidiendo ahora y
// necesita saber qué está pasando ahora. La diferencia está etiquetada en el
// propio tablero para que no la tenga que adivinar.
// ═══════════════════════════════════════════════════════════════

import { getSnapshots, getSnapshotsConFeed, getAvgDailyVolume, getNews } from './alpaca.js';

// Los 11 sectores GICS. Se listan ACÁ y no se importan de /api/sectors porque
// aquel set trae 13 (agrega SOXX e IBIT, que no son sectores GICS sino los dos
// movers de titular de una audiencia retail). Un "calor por sector" con 13
// filas donde dos no son sectores mide otra cosa.
export const SECTOR_ETFS = [
  { etf: 'XLK', name: 'Technology' },
  { etf: 'XLF', name: 'Financials' },
  { etf: 'XLV', name: 'Healthcare' },
  { etf: 'XLY', name: 'Consumer Disc' },
  { etf: 'XLP', name: 'Consumer Staples' },
  { etf: 'XLE', name: 'Energy' },
  { etf: 'XLI', name: 'Industrials' },
  { etf: 'XLB', name: 'Materials' },
  { etf: 'XLU', name: 'Utilities' },
  { etf: 'XLRE', name: 'Real Estate' },
  { etf: 'XLC', name: 'Communication' },
];

// Índices por ETF, porque son negociables y Alpaca los sirve con el mismo
// snapshot que todo lo demás. El VIX NO lo es (es un índice calculado), así que
// viaja su ETF de futuros y SE DICE que es un proxy: llamarle "VIX" a VIXY
// sería un número correcto con la etiqueta equivocada.
export const INDEX_ETFS = [
  { etf: 'SPY', name: 'S&P 500' },
  { etf: 'QQQ', name: 'Nasdaq 100' },
  { etf: 'DIA', name: 'Dow 30' },
  { etf: 'IWM', name: 'Russell 2000' },
];
export const VIX_PROXY = { etf: 'VIXY', name: 'VIX (proxy: VIXY, futuros de corto plazo — NO es el índice)' };

export const TOP_MOVERS = 30;
export const TOP_RVOL = 20;
export const NEAR_52W_PCT = 2;

// Presupuesto del tablero. 3-4K es el objetivo del encargo; el techo duro es
// algo más alto para que un día con mucho movimiento no pierda una sección
// entera, y se journalea cuando se pasa del objetivo.
export const BOARD_TOKEN_TARGET = 4000;
export const BOARD_TOKEN_HARD_CAP = (() => {
  const n = Number(process.env.ARENA_BOARD_TOKEN_CAP);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 5000;
})();

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

// Palabras que marcan un titular de M&A / upgrade / downgrade. Es un filtro
// TONTO Y EXPLICABLE a propósito: el tablero no clasifica noticias, solo elige
// cuáles de los titulares del día caben en el espacio que tiene. Un falso
// positivo cuesta una línea; un clasificador que nadie puede auditar cuesta la
// confianza en el tablero entero.
// EL ORDEN IMPORTA, y es la parte que se equivocó primero: las acciones de
// RATING van ANTES que M&A. "Broker upgrades NVDA to Buy" contiene "to buy" y
// caía en M&A — o sea, el tablero publicaba una fusión que no existía. Las
// palabras `upgrade`/`downgrade` son inequívocas; `to buy` no lo es, así que
// pierde contra ellas. Primera coincidencia gana.
const TEMAS = [
  { tag: 'UP', re: /\b(upgrade[sd]?|raises? (price )?target|initiat\w+ .{0,20}\bbuy\b|outperform)\b/i },
  { tag: 'DOWN', re: /\b(downgrade[sd]?|cuts? (price )?target|lowers? (price )?target|underperform)\b/i },
  { tag: 'M&A', re: /\b(acquir\w*|merger|merges|to buy|takeover|buyout|stake in|deal to)\b/i },
];

export function clasificarTitular(headline) {
  for (const t of TEMAS) if (t.re.test(headline || '')) return t.tag;
  return null;
}

// ── retornos de un ETF desde barras diarias CERRADAS ─────────────────
// 1d / 5d / 1m (21 sesiones). Devuelve null en el plazo que no tenga historia
// suficiente en vez de inventarlo con menos barras.
export function returnsFromCloses(closes) {
  const c = (closes || []).filter((x) => Number.isFinite(x) && x > 0);
  const last = c[c.length - 1];
  if (!last) return { d1: null, d5: null, m1: null };
  const pct = (n) => {
    const prev = c[c.length - 1 - n];
    return Number.isFinite(prev) && prev > 0 ? +(((last - prev) / prev) * 100).toFixed(2) : null;
  };
  return { d1: pct(1), d5: pct(5), m1: pct(21) };
}

// ── RVOL ─────────────────────────────────────────────────────────────
// Volumen del día contra el promedio de 20 sesiones CERRADAS (la barra de hoy
// se excluye del promedio en getAvgDailyVolume — compararla contra un promedio
// que ya la incluye diluiría justo el pico que se quiere detectar).
//
// INTRADÍA EL NÚMERO ESTÁ SESGADO HACIA ABAJO y hay que decirlo: a las 10:30 el
// volumen del día lleva una hora acumulada contra un promedio de sesiones
// COMPLETAS, así que un RVOL de 1.0 a esa hora ya es mucho volumen. El tablero
// lo etiqueta en vez de "corregirlo" con una curva intradía inventada.
// ── CUÁNTO LLEVA LA SESIÓN ───────────────────────────────────────────
// Fracción del horario regular (9:30-16:00 ET) transcurrida, 0 a 1. Antes del
// open es 0; después del cierre, 1.
//
// NO se usa para "corregir" el RVOL: el volumen intradía es de forma de U
// —pesado en el open y en el cierre— así que dividir por la fracción de RELOJ
// sobreestimaría el RVOL temprano tanto como la medición cruda lo subestima.
// Cambiar un sesgo conocido por otro inventado no es un arreglo.
//
// Se usa para DECIR a qué hora se midió, que es lo que vuelve interpretable el
// número — y para que el screener sepa cuándo un umbral absoluto no significa
// nada todavía.
export function fraccionDeSesion(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const min = et.getHours() * 60 + et.getMinutes();
  const abre = 9 * 60 + 30;
  const cierra = 16 * 60;
  if (min <= abre) return 0;
  if (min >= cierra) return 1;
  return +((min - abre) / (cierra - abre)).toFixed(3);
}

export function rvol(dayVolume, avgVolume) {
  // `== null` PRIMERO: Number(null) es 0 y 0 es finito, así que sin esta guarda
  // un símbolo SIN volumen del día salía con RVOL 0 — que se lee como "hoy no
  // se negoció nada", una afirmación fuerte y falsa sobre un dato ausente. Es
  // la misma trampa que el costo sin precio en el smoke.
  if (dayVolume == null || avgVolume == null) return null;
  const d = Number(dayVolume), a = Number(avgVolume);
  if (!Number.isFinite(d) || !Number.isFinite(a) || a <= 0) return null;
  return +(d / a).toFixed(2);
}

const pctChange = (price, prev) => {
  const p = Number(price), q = Number(prev);
  if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) return null;
  return +(((p - q) / q) * 100).toFixed(2);
};

// ── ARMADO ───────────────────────────────────────────────────────────
// `universe` es lo que dejó el cron pre-apertura (símbolos + rango de 52
// semanas). Sin él el tablero SIGUE saliendo, más chico y diciéndolo: la regla
// D1 ("el tablero nunca se bloquea") aplica también acá.
export async function buildBoard({
  universe = null, creds, now = new Date(), earnings = [], deps = {},
} = {}) {
  const snaps = deps.getSnapshots || getSnapshots;
  const avgVol = deps.getAvgDailyVolume || getAvgDailyVolume;
  // El RVOL es un COCIENTE: volumen de hoy (snapshots) sobre el promedio de 20
  // sesiones (bars). Los dos tienen que salir del MISMO feed o el número no
  // significa nada — dividir volumen consolidado entre volumen de IEX daría un
  // RVOL inflado ~30-50×. Por eso el snapshot del universo se resuelve PRIMERO
  // y su feed se le pasa al promedio, en vez de que cada uno elija por su lado.
  // Un `deps.getSnapshots` inyectado (tests) no conoce feeds: se envuelve.
  const snapsConFeed = deps.getSnapshotsConFeed
    || (deps.getSnapshots ? async (sy, c) => ({ data: await deps.getSnapshots(sy, c), feed: null }) : getSnapshotsConFeed);
  const news = deps.getNews || getNews;
  const bars = deps.getDailyCloses || getDailyCloses;

  const errors = {};
  const symbols = (universe && universe.symbols) || [];
  const f52 = (universe && universe.fifty_two_week) || {};
  const etfs = [...INDEX_ETFS.map((x) => x.etf), VIX_PROXY.etf, ...SECTOR_ETFS.map((x) => x.etf)];

  // Este await va ANTES del Promise.all a propósito: el promedio de volumen
  // necesita saber qué feed contestó acá. Es un viaje serializado en un camino
  // que corre antes de la apertura y tiene presupuesto de sobra; el precio de
  // paralelizarlo sería un RVOL que no se puede leer.
  const uni = symbols.length
    ? await snapsConFeed(symbols, creds).catch((e) => { errors.snapshots = String((e && e.message) || e); return { data: {}, feed: null }; })
    : { data: {}, feed: null };
  const snapUni = uni.data || {};
  const feedUsado = uni.feed || null;

  const [snapEtf, avg, closes, titulares] = await Promise.all([
    snaps(etfs, creds).catch((e) => { errors.etf_snapshots = String((e && e.message) || e); return {}; }),
    symbols.length ? avgVol(symbols, { days: 20, today: now.toISOString().slice(0, 10), creds, feed: feedUsado }).catch((e) => { errors.avg_volume = String((e && e.message) || e); return {}; }) : Promise.resolve({}),
    bars(etfs, { creds, now, days: 40, feed: feedUsado }).catch((e) => { errors.sector_bars = String((e && e.message) || e); return {}; }),
    news({ symbols: [], limit: 50, creds }).catch((e) => { errors.news = String((e && e.message) || e); return []; }),
  ]);

  // ── índices y VIX ──
  const indices = INDEX_ETFS.map(({ etf, name }) => {
    const s = snapEtf[etf] || null;
    return { etf, name, price: s ? s.price : null, change_pct: s ? pctChange(s.price, s.prev_close) : null };
  });
  const vs = snapEtf[VIX_PROXY.etf] || null;
  const vix = { etf: VIX_PROXY.etf, name: VIX_PROXY.name, price: vs ? vs.price : null, change_pct: vs ? pctChange(vs.price, vs.prev_close) : null };

  // ── calor por sector ──
  const sectors = SECTOR_ETFS.map(({ etf, name }) => ({ etf, name, ...returnsFromCloses(closes[etf]) }))
    .sort((a, b) => (b.d1 ?? -999) - (a.d1 ?? -999));

  // ── el universo, con su foto del día ──
  const filas = [];
  for (const sym of symbols) {
    const s = snapUni[sym];
    if (!s) continue;                                  // sin precio vivo no entra: no se inventa
    const chg = pctChange(s.price, s.prev_close);
    const r = rvol(s.day_volume, avg[sym]);
    const w = f52[sym] || null;
    filas.push({
      symbol: sym, price: s.price, change_pct: chg, rvol: r,
      pct_from_high: w ? w.pct_from_high : null, pct_from_low: w ? w.pct_from_low : null,
    });
  }

  const conCambio = filas.filter((f) => f.change_pct != null);
  // Desempate por símbolo en los tres rankings: sin orden total, dos corridas
  // con los mismos datos devuelven listas distintas y el replay deja de
  // reproducir la corrida (misma razón que en el buffet v1.5).
  const porCambio = (dir) => [...conCambio]
    .sort((a, b) => (dir * (b.change_pct - a.change_pct)) || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, TOP_MOVERS);
  const gainers = porCambio(1);
  const losers = porCambio(-1);
  const rvolTop = filas.filter((f) => f.rvol != null)
    .sort((a, b) => (b.rvol - a.rvol) || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, TOP_RVOL);

  const breakouts = {
    high: filas.filter((f) => f.pct_from_high != null && f.pct_from_high >= -NEAR_52W_PCT)
      .sort((a, b) => (b.pct_from_high - a.pct_from_high) || (a.symbol < b.symbol ? -1 : 1)).slice(0, TOP_MOVERS),
    low: filas.filter((f) => f.pct_from_low != null && f.pct_from_low <= NEAR_52W_PCT)
      .sort((a, b) => (a.pct_from_low - b.pct_from_low) || (a.symbol < b.symbol ? -1 : 1)).slice(0, TOP_MOVERS),
  };

  // ── titulares ──
  // Solo los que caen en un tema Y tocan un nombre del universo: un titular
  // sobre una empresa que el PM no puede comprar es ruido que paga tokens.
  const enUniverso = new Set(symbols);
  const headlines = [];
  for (const n of titulares) {
    const tag = clasificarTitular(n.headline);
    if (!tag) continue;
    const syms = (n.symbols || []).filter((s) => enUniverso.has(s));
    if (symbols.length && !syms.length) continue;
    headlines.push({ tag, symbols: syms.slice(0, 3), headline: n.headline.slice(0, 120), at: n.created_at });
    if (headlines.length >= 15) break;
  }

  return {
    built_at: now.toISOString(),
    universe_size: symbols.length,
    covered: filas.length,
    indices, vix, sectors, gainers, losers, rvol: rvolTop, breakouts,
    // A qué hora se midió el RVOL. Sin esto, un rv0.3 a las 10:30 y un rv0.3 a
    // las 15:45 se leen igual y significan cosas opuestas.
    sesion_pct: fraccionDeSesion(now),
    // Y CON QUÉ FEED. El RVOL es un cociente feed-consistente (numerador y
    // denominador del mismo lado), pero el volumen ABSOLUTO no: sobre IEX es
    // el ~2-3% del consolidado. Sin este campo, dos días medidos con feeds
    // distintos se leen como si fueran el mismo experimento.
    feed_datos: feedUsado,
    // Los que están en el TOP de RVOL del día. El RANKING no sufre el sesgo
    // intradía —todos se miden a la misma hora— así que es la forma
    // interpretable de preguntar "¿está operando raro?" antes del cierre.
    rvol_top: rvolTop.map((f) => f.symbol),
    earnings: (earnings || []).slice(0, 20),
    headlines,
    errors,
    // Diagnóstico honesto: cuántos nombres del universo se quedaron sin foto.
    // Un tablero que cubre 120 de 600 no es el mismo tablero, y el post-mortem
    // tiene que poder verlo sin reconstruirlo.
    coverage_pct: symbols.length ? +((filas.length / symbols.length) * 100).toFixed(1) : null,
  };
}

// Cierres diarios por símbolo, para los retornos de sector. Vive acá y no en
// alpaca.js porque es una forma que solo el tablero usa (getAvgDailyVolume ya
// cubre el caso "volumen" desde el mismo endpoint).
// El feed sale del veredicto compartido del módulo de Alpaca, no de
// `alpacaDataFeed()`: el calor por sector compara el retorno de cada ETF
// contra los demás, y aunque un retorno es casi invariante al feed, mezclar
// cierres de IEX con precios consolidados en la misma página es justo el tipo
// de inconsistencia que después nadie puede explicar.
async function getDailyCloses(symbols, { creds, now = new Date(), days = 40, feed: feedPedido = null } = {}) {
  const { alpacaDataBase, alpacaCreds, conFeedDeDatos } = await import('./alpaca.js');
  const hoy = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - (days + 15) * 86400000).toISOString().slice(0, 10);
  const c = creds || alpacaCreds();
  if (!c) throw new Error('Faltan keys de Alpaca para las barras del tablero.');

  const pedir = async (feed) => {
    const url = `${alpacaDataBase()}/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(','))}&timeframe=1Day&start=${start}&limit=${(days + 15) * symbols.length}&feed=${feed}`;
    const r = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': c.key, 'APCA-API-SECRET-KEY': c.secret },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      // El status tiene que VIAJAR en el error: sin él, `conFeedDeDatos` no
      // puede distinguir "no tenés SIP" (baja a IEX) de "Alpaca se cayó" (se
      // propaga), y trataría las dos igual.
      const err = new Error('Alpaca data ' + r.status);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };

  const j = feedPedido ? await pedir(feedPedido) : (await conFeedDeDatos(pedir)).data;
  const out = {};
  for (const [sym, list] of Object.entries((j && j.bars) || {})) {
    // La barra de HOY se excluye: los retornos del calor por sector se miden
    // con velas cerradas (point-in-time), a diferencia del precio del día.
    out[String(sym).toUpperCase()] = (Array.isArray(list) ? list : [])
      .filter((b) => b && String(b.t || '').slice(0, 10) !== hoy)
      .map((b) => Number(b.c)).filter((x) => Number.isFinite(x) && x > 0);
  }
  return out;
}

// ── RENDER ───────────────────────────────────────────────────────────
// Tabular, no JSON. Ver el encabezado: sobre 100 filas la diferencia entre las
// dos formas es la diferencia entre caber en el presupuesto y no caber.
const n2 = (v) => (v == null ? '—' : (typeof v === 'number' ? v.toFixed(2) : String(v)));
const sg = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1));

function fila(f) {
  return `${f.symbol} ${n2(f.price)} ${sg(f.change_pct)}%` + (f.rvol != null ? ` rv${f.rvol}` : '');
}

export function renderBoard(board, { budget = BOARD_TOKEN_HARD_CAP } = {}) {
  const secciones = [];
  const push = (titulo, cuerpo) => { if (cuerpo && cuerpo.length) secciones.push({ titulo, texto: `${titulo}\n${cuerpo}` }); };

  push('== INDICES (live price, % vs previous close) ==',
    [...board.indices.map((i) => `${i.etf} ${i.name} ${n2(i.price)} ${sg(i.change_pct)}%`),
      `${board.vix.etf} ${board.vix.name} ${n2(board.vix.price)} ${sg(board.vix.change_pct)}%`].join('\n'));

  push('== SECTOR HEAT (11 GICS ETFs; returns from CLOSED daily bars: 1d / 5d / 1m) ==',
    board.sectors.map((s) => `${s.etf} ${s.name} ${sg(s.d1)} ${sg(s.d5)} ${sg(s.m1)}`).join('\n'));

  push(`== TOP ${TOP_MOVERS} GAINERS (universe only; live price, % vs prev close, rv = RVOL) ==`,
    board.gainers.map(fila).join('\n'));
  push(`== TOP ${TOP_MOVERS} LOSERS ==`, board.losers.map(fila).join('\n'));
  push(`== TOP ${TOP_RVOL} UNUSUAL VOLUME (RVOL = today's volume / 20-session average; INTRADAY THIS IS BIASED LOW — the day is not over, the average is of full sessions) ==`,
    board.rvol.map((f) => `${f.symbol} ${n2(f.price)} ${sg(f.change_pct)}% rv${f.rvol}`).join('\n'));

  push('== AT 52-WEEK HIGHS (within 2%; range from CLOSED weekly bars) ==',
    board.breakouts.high.map((f) => `${f.symbol} ${n2(f.price)} ${sg(f.pct_from_high)}% from high`).join('\n'));
  push('== AT 52-WEEK LOWS (within 2%) ==',
    board.breakouts.low.map((f) => `${f.symbol} ${n2(f.price)} +${n2(f.pct_from_low)}% from low`).join('\n'));

  push('== EARNINGS, NEXT 5 SESSIONS (when = distance from today, already computed) ==',
    (board.earnings || []).map((e) => `${e.ticker} ${e.when || e.date || ''}${e.time ? ' ' + e.time : ''}`).join('\n'));

  push('== HEADLINES (M&A / upgrades / downgrades, today, universe names only) ==',
    (board.headlines || []).map((h) => `[${h.tag}] ${h.symbols.join(',')} ${h.headline}`).join('\n'));

  return trimToBudget(secciones, budget, board);
}

// Recorta POR LA COLA, nunca en el medio: una sección a medias es una lista que
// el PM lee como completa. Se quita la última sección entera y se DICE cuál.
// El orden de `secciones` es el orden de importancia — los índices y el calor
// por sector son el encuadre y se van al final de la fila de recorte.
export function trimToBudget(secciones, budget, board) {
  const quitadas = [];
  let usadas = [...secciones];
  const armar = () => usadas.map((s) => s.texto).join('\n\n');
  while (usadas.length > 2 && estimateTokens(armar()) > budget) {
    quitadas.push(usadas.pop().titulo.replace(/^== | ==$/g, ''));
  }
  let texto = armar();
  if (quitadas.length) {
    texto += `\n\n(BOARD TRUNCATED to fit its token budget: ${quitadas.length} section(s) dropped — ${quitadas.join('; ')}. They are not empty, they did not fit.)`;
  }
  const tokens = estimateTokens(texto);
  // EL PISO GANA SOBRE EL PRESUPUESTO, y se declara. El recorte nunca baja de
  // dos secciones (índices + calor por sector): un tablero vacío es peor que
  // uno recortado, porque el PM no tiene ni el encuadre. Pero si ese piso deja
  // el texto por encima del presupuesto, `budget_respected:false` lo dice —
  // devolver un número que se pasó sin avisar es cómo un presupuesto deja de
  // ser una regla.
  const pisoMordio = usadas.length <= 2 && tokens > budget;
  return {
    text: texto,
    tokens_est: tokens,
    budget,
    budget_respected: tokens <= budget,
    floor_hit: pisoMordio,
    ...(pisoMordio ? { floor_note: `El presupuesto (${budget}) no alcanza ni para el encuadre mínimo (${tokens} tokens). No se recorta más: se devuelve el piso y se declara que se pasó.` } : {}),
    over_target: tokens > BOARD_TOKEN_TARGET,
    dropped: quitadas,
    sections: usadas.map((s) => ({ titulo: s.titulo.replace(/^== | ==$/g, ''), tokens_est: estimateTokens(s.texto) })),
    coverage_pct: board ? board.coverage_pct : null,
  };
}
