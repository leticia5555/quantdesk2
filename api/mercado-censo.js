// ═══════════════════════════════════════════════════════════════════
// /api/mercado-censo — FASE 0 de /mercado: censo + smoke. SOLO LEE.
//
//   GET ?job=censo   → preguntas 1 y 2 (Neon: universo US, capitalización MX)
//   GET ?job=smoke   → preguntas 3 a 9 (fuentes en vivo) + el smoke de la 10
//   GET ?job=todo    → las dos, y el tablero de compuertas completo
//
// POR QUÉ ESTE ENDPOINT EXISTE. Dos razones, y ninguna es "porque sí":
//
//   1. El sandbox donde se escribe este código NO llega a Yahoo, Finnhub ni
//      EDGAR — el proxy de egress de la organización contesta 403 al CONNECT
//      (evidencia en docs/mercado-fase0.md §0). Tampoco llega a Neon.
//   2. Aunque llegara, la pregunta 3 del censo es "¿cuánto tarda ESTO desde
//      donde vive el producto?" y la 8 es "¿Yahoo nos rate-limita desde una IP
//      de datacenter?". Las dos son preguntas sobre el SITIO. Medirlas desde
//      otra máquina contestaría otra pregunta.
//
// Mismo patrón que /api/bmv-inspect (censo de Fase 1b) y /api/stock-tracker
// ?smoke=1: el instrumento vive en el repo, se corre desde prod, y el JSON
// crudo se pega en el documento.
//
// LO QUE NO HACE, A PROPÓSITO: no escribe una sola fila (ni siquiera cachés),
// no llama a ninguna IA, no dibuja nada, y no toca app.html. La Fase 0 es
// censo y smoke — el producto empieza en R1 y solo si estas compuertas abren.
//
// GATE: ARENA_ADMIN_KEY. No es un endpoint de producto y gasta cuota de
// Finnhub y de Alpha Vantage; la misma llave y el mismo helper que
// /api/arena-smoke y /api/arena-reset.
//
// ENV VARS: ARENA_ADMIN_KEY (obl) · DATABASE_URL · FINNHUB_API_KEY ·
//           XBRL_CONTACT (opc, para el User-Agent de la SEC)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { readDayCache } from './_lib/arena-buffet-cache.js';
// El canal se importa de su dueño en vez de repetir la cadena: si el Arena le
// cambia el nombre, este censo se entera por el import y no por un hueco.
import { SECTOR_CHANNEL, sectorFromIndustry } from './_lib/arena-meta.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import {
  CRITERIOS, CAMPOS_METRIC,
  censoUniversoUs, capMxCandidatas, veredictoCapMx,
  presupuestoPrecios, censoRetornoTotal, anclaYtd,
  coberturaMetric, ventanaUpa, proximoReporte,
  coberturaCompanyFacts, censoForm4, veredictoFuente, tablaFuentes, tablero,
} from './_lib/mercado-fase0.js';
import FUENTES_NOTICIAS from './_lib/news-sources.json' with { type: 'json' };

// El censo abre ~40 requests contra cuatro fuentes con cortesía de por medio.
// vercel.json declara `functions` para api/*.js: este número y el de allá
// tienen que decir lo mismo o no sirve de nada (la lección de arena-smoke).
export const maxDuration = 300;

const SEC_UA = 'QuantDesk research@quantdesk.app';
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// La muestra del smoke (§2.10 del encargo): 3 US, 3 MX, 3 índices. Curada y
// fija para que dos corridas sean comparables.
const MUESTRA_US = ['AAPL', 'NVDA', 'JPM'];
const MUESTRA_MX = ['WALMEX.MX', 'FEMSAUBD.MX', 'GMEXICOB.MX'];
const MUESTRA_IDX = ['^GSPC', '^MXX', '^N225'];
// El ticker al que se le pide la ficha COMPLETA (metric + UPA + companyfacts
// + recommendation). AAPL: cobertura máxima en las cuatro fuentes, así que un
// hueco acá es un hueco de la fuente y no del nombre.
const TICKER_FICHA = 'AAPL';
const CIK_FICHA = '0000320193';       // Apple Inc — CIK permanente, no es una fecha
// Las 5 emisoras que el encargo pide verificar contra su cap pública.
const MX_VERIFICAR = ['WALMEX', 'FEMSA', 'AMX', 'GMEXICO', 'GFNORTE'];

// ── Punto 0.10 (adenda) · los feeds de noticias ──────────────────────
//
// La lista YA NO se inventa ni se pasa por parámetro: vive en el registro
// `api/_lib/news-sources.json`, que es el mismo archivo que la adenda pide
// para R3b ("agregar una fuente = una fila"). Nace acá, en la Fase 0, con el
// resultado del smoke vacío; la corrida lo llena.
//
// Lo que NO está verificado es cada URL: son CANDIDATAS. Ninguna se probó
// desde este contenedor (no tiene egress). Por eso el smoke prueba las
// candidatas EN ORDEN y reporta cuál respondió — un NO-GO de "ninguna de las
// 3 rutas sirve" es un hecho medido; uno de "probé una URL adivinada" no lo
// sería. Es el mismo patrón que `vc-feed.js` ya usa con latamlist y contxto.
//
// `?feeds=nombre=url|mx` sigue existiendo como ANULACIÓN puntual, para probar
// una ruta nueva sin redeploy. Sin el parámetro corre el registro completo.
const BLOG_UA = 'Mozilla/5.0 (compatible; QuantDesk/1.0; research@quantdesk.app)';

// `?feeds=nombre=url|mx,otro=url` → lista ad-hoc, sin redeploy.
// Una entrada mal formada NO se descarta en silencio: se reporta, porque un
// feed que falta por un typo se lee igual que un feed que no existe.
export function parseFeedsParam(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return { feeds: null, invalidas: [] };
  const feeds = [], invalidas = [];
  for (const parte of txt.split(',')) {
    const t = parte.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) { invalidas.push({ entrada: t, motivo: 'falta el "=" entre nombre y url' }); continue; }
    const nombre = t.slice(0, i).trim();
    let url = t.slice(i + 1).trim();
    let pais = 'us';
    const bar = url.lastIndexOf('|');
    if (bar > 0) { pais = url.slice(bar + 1).trim().toLowerCase() || 'us'; url = url.slice(0, bar).trim(); }
    if (!/^https?:\/\//i.test(url)) { invalidas.push({ entrada: t, motivo: 'la url no empieza con http(s)://' }); continue; }
    feeds.push({ nombre, url, pais });
  }
  return { feeds: feeds.length ? feeds : null, invalidas };
}

// Una entrada de `?feeds=` se vuelve una fuente del registro, para que el
// resto del censo no tenga que distinguir de dónde vino.
export function fuenteAdHoc(f) {
  return {
    id: f.nombre, nombre: f.nombre,
    idioma: f.pais === 'mx' || f.pais === 'es' ? 'es' : 'en',
    tipo: 'medio', seccion: f.pais === 'mx' ? 'mexico_latam' : 'mercado',
    feeds: [f.url],
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fetch instrumentado ──────────────────────────────────────────────
// Devuelve SIEMPRE una forma: { ok, status, ms, json, error }. Una fuente
// caída es un dato del censo, no una excepción que se lleve la corrida.
async function medir(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML de error o atom */ }
    return {
      ok: r.ok, status: r.status, ms: Date.now() - t0, json,
      // El cuerpo crudo solo cuando falla, y recortado: sirve para diagnosticar
      // sin inflar el JSON del censo.
      cuerpo: r.ok ? undefined : text.slice(0, 300),
      texto: json ? undefined : text,
    };
  } catch (e) {
    const err = e && e.name === 'TimeoutError' ? `timeout (${timeoutMs}ms)` : String((e && e.message) || e);
    return { ok: false, status: 0, ms: Date.now() - t0, json: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PARTE A — el censo de Neon (preguntas 1 y 2)
// ═══════════════════════════════════════════════════════════════════

// Q1. Las tres tablas que hoy saben algo del universo US. Cada lectura traga
// su error por separado: que falte `arena_universe` no puede borrar lo que sí
// dijo `arena_market_cap`.
async function censoQ1(ahora) {
  const errores = {};
  const leer = async (nombre, q, params = []) => {
    try { return await sql(q, params); } catch (e) { errores[nombre] = String((e && e.message) || e); return []; }
  };

  const [screener, caps, universoRows] = await Promise.all([
    leer('arena_screener', 'select symbol, refreshed_at from arena_screener'),
    leer('arena_market_cap', 'select symbol, market_cap, fetched_at from arena_market_cap'),
    leer('arena_universe', 'select key, payload, source, built_at from arena_universe'),
  ]);

  // El universo del Arena guarda su payload como jsonb; los símbolos pueden
  // venir en `symbols` o dentro de `admitidos`. Se aceptan las dos formas y se
  // reporta de cuál salió — adivinar la forma es cómo se pierde una corrida.
  const universo = [];
  const formas = {};
  for (const row of universoRows) {
    const p = row && row.payload;
    if (!p) continue;
    const arr = Array.isArray(p.symbols) ? p.symbols
      : Array.isArray(p.admitidos) ? p.admitidos
        : Array.isArray(p) ? p : null;
    if (!arr) { formas[row.key] = 'forma no reconocida'; continue; }
    formas[row.key] = `${arr.length} símbolos`;
    for (const s of arr) universo.push(typeof s === 'string' ? s : (s && s.symbol));
  }

  // El sector NO vive en una columna: vive en la caché por día del buffet
  // (canal assets:sector), como { SYMBOL: 'industria de Finnhub' }, y se mapea
  // a ETF en tiempo de corrida. Ese es justo el hallazgo de Q1.
  //
  // Y NO guarda el sector: guarda la INDUSTRIA cruda de Finnhub, que se mapea
  // a uno de los 11 ETFs con reglas por palabra clave (arena-meta). Se usa la
  // misma función que el Arena —no una copia— y se cuenta lo que NINGUNA regla
  // toca: una falla de cobertura tiene que verse como falla de cobertura.
  let sectores = {};
  let industrias = {};
  let sinMapear = [];
  let sectorFuente = 'arena_buffet_cache (canal assets:sector, día de hoy)';
  try {
    const cache = await readDayCache(SECTOR_CHANNEL, ahora);
    industrias = (cache && cache.payload) || {};
    if (!cache) sectorFuente += ' — VACÍA hoy';
    for (const [sym, ind] of Object.entries(industrias)) {
      const { etf } = sectorFromIndustry(ind);
      if (etf) sectores[sym] = etf;
      else sinMapear.push({ symbol: sym, industria: ind });
    }
  } catch (e) { errores.sector_cache = String((e && e.message) || e); }

  const r = censoUniversoUs({ screener, caps, sectores, universo: universo.filter(Boolean), ahora });
  return {
    ...r,
    fuentes: {
      arena_screener: `${screener.length} filas (sin columna de cap ni de sector)`,
      arena_market_cap: `${caps.length} filas`,
      arena_universe: formas,
      sector: sectorFuente,
      sector_industrias_en_cache: Object.keys(industrias).length,
      sector_sin_mapear: sinMapear.length,
      sector_sin_mapear_ejemplos: sinMapear.slice(0, 10),
    },
    errores: Object.keys(errores).length ? errores : undefined,
  };
}

// Q2. La capitalización MX y la trampa de las series.
//
// La REFERENCIA pública sale de Yahoo (`marketCap` del quoteSummary del
// ticker .MX). No es un capricho: es la única cap pública que se puede pedir
// en batch, y el encargo pide un error % contra "la capitalización pública".
// Si Yahoo no contesta, la emisora queda `sin_referencia` — que NO es lo
// mismo que un error de 0%.
async function censoQ2(ahora) {
  const errores = {};
  const salida = { emisoras: [], resumen: {} };

  // Último reporte XBRL por emisora: las acciones en circulación.
  let acciones = [];
  try {
    acciones = await sql(
      `select distinct on (clave) clave, anio, trimestre, acciones_circulacion,
              acciones_circulacion_tag, acciones_circulacion_motivo, fecha_publicacion
         from xbrl_reports
        order by clave, anio desc, trimestre desc`);
  } catch (e) { errores.xbrl_reports = String((e && e.message) || e); }

  // Último cierre por SERIE. La llave de bmv_precios es (emisora_serie, fecha)
  // justamente porque una emisora puede tener varias series — ese diseño ya
  // está, y es lo que hace posible medir esta pregunta en vez de adivinarla.
  let precios = [];
  try {
    precios = await sql(
      `select distinct on (emisora_serie) emisora, emisora_serie, fecha, cierre
         from bmv_precios
        order by emisora_serie, fecha desc`);
  } catch (e) { errores.bmv_precios = String((e && e.message) || e); }

  const preciosPorEmisora = new Map();
  for (const p of precios) {
    const k = String(p.emisora || '').toUpperCase();
    if (!preciosPorEmisora.has(k)) preciosPorEmisora.set(k, []);
    preciosPorEmisora.get(k).push(p);
  }
  const accionesPor = new Map(acciones.map((a) => [String(a.clave || '').toUpperCase(), a]));

  // La referencia pública, solo para las 5 que el encargo nombra. Cortesía de
  // 1 req/s: cinco requests, cinco segundos.
  //
  // DOS COSAS QUE LA CORRIDA DEL 2026-09-20 DEJÓ CLARAS Y QUE ESTE BLOQUE
  // ARRASTRABA MAL:
  //
  // 1. El símbolo se armaba con `series[0]`, que es la serie ALFABÉTICAMENTE
  //    primera, no la líquida. Salió `AMXA.MX` (serie A) en vez de la que
  //    opera, y `FEMSAB.MX` — una serie que ni siquiera aparece entre las
  //    candidatas con precio. Ahora sale de `serie_liquida` del registro.
  // 2. Da igual, porque **Yahoo quoteSummary devuelve 401 Invalid Crumb**
  //    desde Vercel: las cinco emisoras fallaron, y el precio objetivo de
  //    AAPL también. No es el símbolo `.MX`, es el endpoint entero. Se deja
  //    la llamada porque un 401 medido es un dato, pero la referencia de
  //    verdad vive ahora en _lib/mercado-cap-referencia.json (R0c).
  const serieLiquidaDe = new Map(EMISORAS.emisoras.map((e) => [String(e.clave).toUpperCase(), e.serie_liquida]));
  const referencias = {};
  for (const clave of MX_VERIFICAR) {
    const series = preciosPorEmisora.get(clave) || [];
    const liquida = serieLiquidaDe.get(clave);
    const serie = series.find((x) => x.emisora_serie === liquida) || series[0];
    // El símbolo Yahoo de una emisora BMV es emisora+serie+'.MX'.
    const symYahoo = serie ? `${serie.emisora_serie}.MX` : `${clave}.MX`;
    const r = await medir(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symYahoo)}?modules=price,summaryDetail`,
      { headers: { 'User-Agent': YAHOO_UA } });
    const res = r.json && r.json.quoteSummary && r.json.quoteSummary.result && r.json.quoteSummary.result[0];
    const cap = res && res.price && res.price.marketCap
      && (res.price.marketCap.raw != null ? num(res.price.marketCap.raw) : num(res.price.marketCap));
    referencias[clave] = {
      symbol_yahoo: symYahoo, status: r.status, ms: r.ms,
      market_cap: cap ?? null,
      divisa: (res && res.price && res.price.currency) || null,
      error: r.error || (cap == null ? `sin marketCap en la respuesta (HTTP ${r.status})` : undefined),
    };
    await dormir(1000);
  }

  let verificadas = 0, punteadas = 0;
  for (const em of EMISORAS.emisoras) {
    const clave = String(em.clave).toUpperCase();
    const a = accionesPor.get(clave);
    const cand = capMxCandidatas({
      clave,
      acciones_circulacion: a ? a.acciones_circulacion : null,
      precios: preciosPorEmisora.get(clave) || [],
    });
    const ref = referencias[clave] ? referencias[clave].market_cap : null;
    const v = veredictoCapMx(cand, ref);
    // Sin referencia no se afirma nada: ni verificada ni descartada por error.
    const estado = ref == null ? 'sin_referencia' : v.estado;
    if (estado === 'verificada') verificadas++;
    if (estado === 'gris_punteado') punteadas++;
    salida.emisoras.push({
      clave, sector: em.sector, nombre: em.nombre,
      acciones_circulacion: cand.acciones,
      tag_acciones: a ? a.acciones_circulacion_tag : null,
      motivo_acciones: a ? a.acciones_circulacion_motivo : null,
      periodo: a ? `${a.anio}T${a.trimestre}` : null,
      series: cand.n_series,
      candidatas: cand.candidatas,
      referencia_publica: ref,
      estado,
      error_pct: v.error_pct == null ? null : +v.error_pct.toFixed(2),
      multiplo_vs_referencia: v.multiplo_vs_referencia == null ? null : +v.multiplo_vs_referencia.toFixed(3),
      motivo: estado === 'sin_referencia' ? 'no se pidió/no llegó capitalización pública de esta emisora' : v.motivo,
    });
  }

  salida.resumen = {
    emisoras: salida.emisoras.length,
    con_acciones: salida.emisoras.filter((e) => e.acciones_circulacion != null).length,
    con_precio: salida.emisoras.filter((e) => e.series > 0).length,
    con_varias_series: salida.emisoras.filter((e) => e.series > 1).length,
    verificadas, gris_punteado: punteadas,
    sin_referencia: salida.emisoras.length - verificadas - punteadas,
  };
  salida.referencias = referencias;
  salida.errores = Object.keys(errores).length ? errores : undefined;
  // G2 mide sobre las que SÍ se pudieron comparar: declarar verde un mapa
  // porque nadie lo contradijo sería el error que esta fase existe para evitar.
  salida.verde = verificadas >= Math.min(CRITERIOS.g2_min_emisoras_verificadas, MX_VERIFICAR.length)
    && MX_VERIFICAR.every((c) => {
      const e = salida.emisoras.find((x) => x.clave === c);
      return e && e.estado === 'verificada';
    });
  salida.razones = MX_VERIFICAR
    .map((c) => salida.emisoras.find((x) => x.clave === c))
    .filter((e) => !e || e.estado !== 'verificada')
    .map((e) => (e ? `${e.clave}: ${e.motivo || e.estado}` : 'emisora ausente de emisoras.json'));
  return salida;
}

// ═══════════════════════════════════════════════════════════════════
// PARTE B — el smoke en vivo (preguntas 3 a 10)
// ═══════════════════════════════════════════════════════════════════

// Q3 · precios en batch: se MIDE, no se estima. Se bajan los 9 símbolos de la
// muestra y se extrapola el presupuesto con el ms/símbolo observado.
async function smokeQ3() {
  const simbolos = [...MUESTRA_US, ...MUESTRA_MX, ...MUESTRA_IDX];
  const t0 = Date.now();
  const res = await Promise.all(simbolos.map((s) => medir(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d&events=div%2Csplit`,
    { headers: { 'User-Agent': YAHOO_UA } })));
  const msTotal = Date.now() - t0;
  const ok = res.filter((r) => r.ok && r.json);
  const msPorSimbolo = ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : null;

  const porSimbolo = simbolos.map((s, i) => ({
    symbol: s, status: res[i].status, ms: res[i].ms,
    puntos: (res[i].json && res[i].json.chart && res[i].json.chart.result
      && res[i].json.chart.result[0] && res[i].json.chart.result[0].timestamp || []).length,
    error: res[i].error || (res[i].ok ? undefined : `HTTP ${res[i].status}`),
  }));

  const presupuesto = presupuestoPrecios({
    n_us: 150, n_mx: 30, n_idx: 20,
    ms_por_simbolo: msPorSimbolo == null ? 250 : msPorSimbolo,
    concurrencia: 8,
  });

  const caidos = porSimbolo.filter((p) => !p.puntos);
  return {
    simbolos: simbolos.length, ok: ok.length,
    ms_total_9_en_paralelo: msTotal,
    ms_por_simbolo_observado: msPorSimbolo,
    por_simbolo: porSimbolo,
    presupuesto_extrapolado_200: presupuesto,
    verde: caidos.length === 0,
    razones: caidos.length ? [`${caidos.length} símbolos sin serie: ${caidos.map((c) => c.symbol).join(', ')}`] : [],
    _charts: Object.fromEntries(simbolos.map((s, i) => [s, res[i].json])),  // se consume en Q4, no se devuelve
  };
}

// Q4 · retorno total con dividendos + el hueco de YTD.
function smokeQ4(charts, ahora) {
  const porSimbolo = {};
  const razones = [];
  for (const [sym, json] of Object.entries(charts || {})) {
    if (!json) { porSimbolo[sym] = { ok: false, motivo: 'sin payload' }; continue; }
    const rt = censoRetornoTotal(json);
    const r = json.chart && json.chart.result && json.chart.result[0];
    const ts = (r && r.timestamp) || [];
    const closes = (r && r.indicators && r.indicators.quote && r.indicators.quote[0]
      && r.indicators.quote[0].close) || [];
    const serie = ts.map((t, i) => ({ t, c: num(closes[i]) })).filter((p) => p.c != null && p.c > 0);
    porSimbolo[sym] = { ...rt, ytd: anclaYtd(serie, ahora) };
    if (!rt.ok) razones.push(`${sym}: ${rt.motivo}`);
    if (!porSimbolo[sym].ytd.cubre) razones.push(`${sym}: YTD — ${porSimbolo[sym].ytd.motivo}`);
  }
  return { por_simbolo: porSimbolo, verde: razones.length === 0, razones };
}

// Q5 · fundamentales · Q6 · UPA · Q8 · analistas — todo de Finnhub, un ticker.
async function smokeFinnhub(finnhubKey) {
  if (!finnhubKey) {
    const falta = { verde: false, razones: ['FINNHUB_API_KEY no configurada'] };
    return { q5: falta, q6: falta, q8: falta };
  }
  const B = 'https://finnhub.io/api/v1';
  const t = encodeURIComponent(TICKER_FICHA);
  const hoy = new Date();
  const hasta = new Date(hoy.getTime() + 120 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const [metric, eps, cal, rec, target] = await Promise.all([
    medir(`${B}/stock/metric?symbol=${t}&metric=all&token=${finnhubKey}`),
    medir(`${B}/stock/earnings?symbol=${t}&token=${finnhubKey}`),
    medir(`${B}/calendar/earnings?from=${iso(hoy)}&to=${iso(hasta)}&symbol=${t}&token=${finnhubKey}`),
    medir(`${B}/stock/recommendation?symbol=${t}&token=${finnhubKey}`),
    // Se prueba A PROPÓSITO aunque _lib/finnhub-dive.js lo dé por premium:
    // api/memo.js y api/fundamental-agent.js SÍ lo llaman, así que hay dos
    // afirmaciones opuestas en el repo y una de las dos está mal. El censo
    // dirime con el status code, no con el comentario de nadie.
    medir(`${B}/stock/price-target?symbol=${t}&token=${finnhubKey}`),
  ]);

  const cob = coberturaMetric(metric.json, CAMPOS_METRIC);
  const q5 = {
    ticker: TICKER_FICHA, status: metric.status, ms: metric.ms,
    ...cob,
    razones: cob.verde ? [] : [`${cob.presentes}/${cob.total} campos (piso ${CRITERIOS.g5_min_campos_metric}); faltan: ${cob.ausentes.join(', ')}`],
  };

  const upa = ventanaUpa(eps.json);
  const q6 = {
    ticker: TICKER_FICHA, status: eps.status, ms: eps.ms,
    ...upa,
    proximo_reporte: proximoReporte(cal.json, TICKER_FICHA),
    calendario_status: cal.status,
    razones: upa.verde ? [] : [`${upa.con_actual_y_estimate} trimestres con actual+estimate (piso ${CRITERIOS.g6_min_trimestres_upa})`],
  };

  const recOk = Array.isArray(rec.json) && rec.json.length > 0;
  const targetOk = target.ok && target.json && num(target.json.targetMean) != null;
  const q8 = {
    recommendation: {
      status: rec.status, ms: rec.ms, filas: Array.isArray(rec.json) ? rec.json.length : 0,
      mas_reciente: recOk ? rec.json[0] : null, ok: recOk,
    },
    price_target_finnhub: {
      status: target.status, ms: target.ms, ok: targetOk,
      // Un 403 acá NO es una falla del censo: es la respuesta. Confirma que el
      // panel de precio objetivo va punteado "fuente de pago".
      lectura: targetOk ? 'GO: el tier actual SÍ devuelve precio objetivo'
        : `NO-GO: HTTP ${target.status} — el panel va punteado "fuente de pago"`,
      cuerpo: target.cuerpo,
    },
    // La calificación con NOMBRE DE CASA queda punteada por DECISIÓN, no por
    // falta de intento: el encargo la congela en §3.R6 y no se sondea.
    calificacion_con_casa: 'no se sondea: decisión congelada del encargo — panel punteado "no lo mostramos, es dato de pago"',
    verde: recOk,
    razones: recOk ? [] : [`recommendation HTTP ${rec.status} sin filas`],
  };
  return { q5, q6, q8, _yahooTargetPendiente: true };
}

// Q8 (segunda mitad) · precio objetivo por Yahoo quoteSummary, DESDE VERCEL.
// El encargo pide GO/NO-GO por escrito y la respuesta depende de la IP: el
// smoke de /api/movers (jul 2026) ya documentó un 429 en el crumb dance desde
// Vercel. Acá se prueba la ruta SIN crumb, que es la que usa /api/fundamentals.
async function smokeQ8Yahoo() {
  const r = await medir(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${TICKER_FICHA}?modules=financialData,recommendationTrend`,
    { headers: { 'User-Agent': YAHOO_UA } });
  const res = r.json && r.json.quoteSummary && r.json.quoteSummary.result && r.json.quoteSummary.result[0];
  const fd = (res && res.financialData) || null;
  const leer = (k) => (fd && fd[k] && (fd[k].raw != null ? num(fd[k].raw) : num(fd[k]))) ?? null;
  const objetivos = fd ? {
    bajo: leer('targetLowPrice'), promedio: leer('targetMeanPrice'),
    alto: leer('targetHighPrice'), actual: leer('currentPrice'),
    n_analistas: leer('numberOfAnalystOpinions'),
  } : null;
  const ok = !!(objetivos && objetivos.promedio != null);
  return {
    ruta: 'v10/quoteSummary sin crumb (la misma de /api/fundamentals)',
    status: r.status, ms: r.ms, objetivos,
    veredicto: ok ? 'GO: Yahoo devuelve precio objetivo desde Vercel'
      : `NO-GO: HTTP ${r.status} — el panel de precio objetivo va punteado "fuente de pago"`,
    cuerpo: r.cuerpo,
    ok,
  };
}

// Q7 · ingresos/utilidad por trimestre con cita al 10-Q/10-K.
async function smokeQ7() {
  const r = await medir(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK_FICHA}.json`,
    { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' }, timeoutMs: 30000 });
  if (!r.json) {
    return { cik: CIK_FICHA, status: r.status, ms: r.ms, verde: false,
      razones: [r.error || `companyfacts HTTP ${r.status}`] };
  }
  const c = coberturaCompanyFacts(r.json);
  return {
    cik: CIK_FICHA, ticker: TICKER_FICHA, status: r.status, ms: r.ms,
    // El tamaño importa: un companyfacts de una mega-cap pesa decenas de MB y
    // eso decide si R6 lo puede pedir en vivo o necesita precálculo.
    bytes_aprox: r.texto ? r.texto.length : null,
    ...c,
    razones: c.verde ? [] : [`ingresos ${c.trimestres_ingresos_con_cita} / utilidad ${c.trimestres_utilidad_con_cita} trimestres con cita (piso ${CRITERIOS.g7_min_trimestres_facts})`],
  };
}

// Q9 · Form 4 completo: ¿el feed trae TODOS los códigos, "le quedan" y la
// hora de aceptación? Se pregunta a las dos fuentes que el repo ya usa, que
// no son intercambiables: Finnhub normaliza, EDGAR es el original.
async function smokeQ9(finnhubKey) {
  const salida = {};

  if (finnhubKey) {
    const desde = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const hasta = new Date().toISOString().slice(0, 10);
    const r = await medir(
      `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${encodeURIComponent(TICKER_FICHA)}&from=${desde}&to=${hasta}&token=${finnhubKey}`);
    const datos = (r.json && r.json.data) || [];
    salida.finnhub = { status: r.status, ms: r.ms, ...censoForm4(datos),
      // El campo `share` de Finnhub es el remanente y `change` el movimiento;
      // confundirlos infló un valor ~1000× una vez (ver api/insider.js).
      nota_campos: 'share = remanente ("le quedan"), change = movimiento' };
  } else {
    salida.finnhub = { verde: false, razones: ['FINNHUB_API_KEY no configurada'] };
  }

  // EDGAR: el atom de Form 4 recién aceptados. Confirma que la hora de
  // aceptación existe en el original aunque Finnhub no la exponga.
  const atom = await medir(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=40&output=atom',
    { headers: { 'User-Agent': SEC_UA }, timeoutMs: 20000 });
  const texto = atom.texto || '';
  salida.edgar_atom = {
    status: atom.status, ms: atom.ms,
    entries: (texto.match(/<entry>/g) || []).length,
    // <updated> del atom es la hora de aceptación del filing: el orden que R5
    // pide ("por hora de filing ↓") sale de ahí.
    con_updated: (texto.match(/<updated>/g) || []).length,
    ok: atom.ok && /<entry>/.test(texto),
  };

  const fVerde = salida.finnhub && salida.finnhub.verde;
  const razones = [];
  if (!fVerde) razones.push(...(salida.finnhub.razones || [
    `Finnhub: códigos=[${(salida.finnhub.codigos || []).join(',')}] le_quedan=${salida.finnhub.con_le_quedan}/${salida.finnhub.transacciones} hora_aceptacion=${salida.finnhub.con_hora_aceptacion}/${salida.finnhub.transacciones}`]));
  if (!salida.edgar_atom.ok) razones.push(`EDGAR atom HTTP ${atom.status}`);
  salida.verde = razones.length === 0;
  salida.razones = razones;
  return salida;
}

// Punto 0.10 (adenda) · la tabla GO/NO-GO por fuente.
//
// Tres cosas que la adenda pregunta por fuente, y que se miden distinto:
//   · ¿tiene RSS/Atom público?      → responde alguna candidata con un feed
//   · ¿responde sin Cloudflare?     → el 403 se nombra por su nombre
//   · ¿trae imagen? ¿categoría?     → se cuentan sobre los items reales
//
// Además, aparte, el canal `/news` de Finnhub: no es un feed y no compite con
// ellos, pero es lo único de noticias generales que el repo puede pedir hoy.
async function smokeQ11(fuentes, finnhubKey) {
  const veredictos = [];
  // De a 4 fuentes, con pausa entre tandas: son ~30 dominios ajenos y un
  // censo no es una razón para golpearlos. El timeout por candidata es de 5 s,
  // el mismo que la adenda fija para el cron de R3b — así el censo mide bajo
  // la condición en la que el producto va a correr, no bajo una más generosa.
  for (let i = 0; i < fuentes.length; i += 4) {
    const tanda = await Promise.all(fuentes.slice(i, i + 4).map(async (f) => {
      if (f.asumido_no || !(f.feeds || []).length) return veredictoFuente(f, []);
      const ua = f.ua === 'sec' ? SEC_UA : BLOG_UA;
      const intentos = [];
      for (const url of f.feeds) {
        const r = await medir(url, { headers: { 'User-Agent': ua }, timeoutMs: 5000 });
        intentos.push({ url, resp: { ...r, texto: r.texto || r.cuerpo || '' } });
        // Si ésta ya sirve, no se golpea la siguiente: la candidata 2 existe
        // por si la 1 falla, no para completar una estadística.
        const v = veredictoFuente(f, intentos);
        if (v.veredicto === 'GO') return v;
      }
      return veredictoFuente(f, intentos);
    }));
    veredictos.push(...tanda);
    if (i + 4 < fuentes.length) await dormir(500);
  }

  const tabla = tablaFuentes(veredictos);

  // El canal de Finnhub, medido aparte.
  let finnhub = { ok: false, motivo: 'FINNHUB_API_KEY no configurada' };
  if (finnhubKey) {
    const r = await medir(`https://finnhub.io/api/v1/news?category=general&token=${finnhubKey}`);
    const arr = Array.isArray(r.json) ? r.json : [];
    const conLink = arr.filter((n) => n && n.url).length;
    const conHora = arr.filter((n) => n && Number.isFinite(Number(n.datetime)) && Number(n.datetime) > 0).length;
    const conImagen = arr.filter((n) => n && n.image).length;
    const fuentesFh = [...new Set(arr.map((n) => n && n.source).filter(Boolean))].sort();
    finnhub = {
      status: r.status, ms: r.ms, items: arr.length,
      con_link: conLink, con_hora: conHora, con_imagen: conImagen,
      fuentes_distintas: fuentesFh.length, fuentes: fuentesFh.slice(0, 25),
      ok: arr.length > 0 && conLink === arr.length && conHora === arr.length,
      nota: 'el censo lista las `source` distintas para poder ver si alguna es mexicana: /news?category=general es prensa financiera en inglés',
    };
  }

  return {
    ...tabla,
    finnhub_news: finnhub,
    registro: 'api/_lib/news-sources.json',
    aviso_candidatas: 'las URLs del registro son CANDIDATAS sin verificar (este contenedor no tiene egress). Un NO-GO acá significa "ninguna de las N rutas probadas sirve", no "la fuente no existe": puede ser la ruta. Las que salgan GO se congelan en el registro con su url ganadora.',
  };
}

// ═══════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  // Censo: nada de esto se cachea. Una foto vieja de una compuerta es peor
  // que no tenerla — decide una rebanada entera.
  res.setHeader('Cache-Control', 'no-store');

  const job = String((req.query && req.query.job) || 'todo').toLowerCase();
  if (!['censo', 'smoke', 'todo'].includes(job)) {
    return res.status(400).json({ error: 'job debe ser censo | smoke | todo' });
  }

  const ahora = new Date();
  const t0 = Date.now();
  const out = {
    fase: 0, area: 'mercado', job,
    generado_en: ahora.toISOString(),
    criterios: CRITERIOS,
    doc: 'docs/mercado-fase0.md',
  };
  const parciales = {};

  try {
    if (job === 'censo' || job === 'todo') {
      const [q1, q2] = await Promise.all([censoQ1(ahora), censoQ2(ahora)]);
      out.q1_universo_us = q1;      parciales.g1 = q1;
      out.q2_capitalizacion_mx = q2; parciales.g2 = q2;
    }

    if (job === 'smoke' || job === 'todo') {
      const finnhubKey = process.env.FINNHUB_API_KEY;
      const q3 = await smokeQ3();
      const charts = q3._charts; delete q3._charts;
      out.q3_precios_batch = q3;    parciales.g3 = q3;

      const q4 = smokeQ4(charts, ahora);
      out.q4_retorno_total = q4;    parciales.g4 = q4;

      const [fh, q7, q8y, q9] = await Promise.all([
        smokeFinnhub(finnhubKey), smokeQ7(), smokeQ8Yahoo(), smokeQ9(finnhubKey),
      ]);
      delete fh._yahooTargetPendiente;
      out.q5_fundamentales = fh.q5; parciales.g5 = fh.q5;
      out.q6_upa = fh.q6;           parciales.g6 = fh.q6;
      out.q7_ingresos_utilidad = q7; parciales.g7 = q7;
      out.q8_analistas = { ...fh.q8, price_target_yahoo: q8y };
      // G8 es verde si `recommendation` sirve. El precio objetivo es GO/NO-GO
      // por separado y su NO-GO no tumba la compuerta: el encargo ya tiene
      // decidido qué hacer con un NO-GO (panel punteado), así que es una
      // bifurcación, no un bloqueo.
      parciales.g8 = { verde: fh.q8.verde, razones: fh.q8.razones };
      out.q9_form4 = q9;            parciales.g9 = q9;

      // Punto 0.10 de la adenda. La lista sale de `?feeds=` si vino; si no,
      // de FEEDS_DEFAULT, y el JSON dice cuál usó.
      const { feeds: feedsParam, invalidas } = parseFeedsParam(req.query && req.query.feeds);
      const fuentes = feedsParam ? feedsParam.map(fuenteAdHoc) : FUENTES_NOTICIAS.fuentes;
      const q11 = await smokeQ11(fuentes, finnhubKey);
      q11.origen_lista = feedsParam
        ? 'parámetro ?feeds= (anulación ad-hoc)'
        : `registro api/_lib/news-sources.json (${FUENTES_NOTICIAS.fuentes.length} fuentes de la adenda)`;
      if (invalidas.length) q11.entradas_invalidas = invalidas;
      out.q11_feeds_noticias = q11; parciales.g11 = q11;

      // G10 es el smoke mismo: que las 9 cotizaciones de la muestra hayan
      // llegado con su serie.
      parciales.g10 = {
        verde: q3.verde && q4.verde,
        razones: [...q3.razones, ...q4.razones],
      };
      out.q10_smoke = {
        us: MUESTRA_US, mx: MUESTRA_MX, indices: MUESTRA_IDX,
        ficha_completa: TICKER_FICHA,
        fuentes_en_punto_0_10: q11.fuentes,
        verde: parciales.g10.verde, razones: parciales.g10.razones,
      };
    }
  } catch (e) {
    out.excepcion = String((e && e.stack) || e);
  }

  out.tablero = tablero(parciales);
  out.ms_total = Date.now() - t0;
  return res.status(200).json(out);
}
