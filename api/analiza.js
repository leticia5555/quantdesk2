// ═══════════════════════════════════════════════════════════════════════
// /api/analiza — R6: todo lo que la ficha de ticker necesita, en UNA llamada.
//
//   GET /api/analiza?ticker=NVDA
//
// LO QUE ESTE ENDPOINT NO HACE:
//   · NO llama a ninguna IA. El encargo permite IA en `/analiza` SÓLO al
//     pulsar "Analizar con agentes", que es el flujo ANALYZE que ya existe en
//     `app.html` y que esta pantalla ENLAZA, no incorpora;
//   · NO devuelve porcentajes de periodo pre-cocinados: manda las series y la
//     pantalla las pasa por `qdPeriodChange` (regla 1);
//   · NO se llama a sí mismo por HTTP (la cicatriz del 401 en preview).
//
// CADA BLOQUE VIAJA CON SU FUENTE Y, SI FALTA, CON SU CAUSA. Un bloque caído
// no tumba los otros seis: eso es todo el diseño de este archivo.
// ═══════════════════════════════════════════════════════════════════════

import candlesHandler from './candles.js';
import insiderHandler from './insider.js';
import earningsHandler from './earnings.js';
import historiaHandler from './historia.js';
import noticiasHandler from './noticias.js';
import banxicoHandler from './banxico.js';
import { enProceso } from './mercado-paneles.js';
import { tickersDeFila } from './_lib/noticias.js';
import {
  serieDeRendimiento, upaRealVsEstimado, trimestresDeCompanyFacts, linkDeFiling,
  recomendaciones, precioObjetivo, tablaValuacion, tablaValuacionFinnhub, netoInsiders, DE_PAGO,
} from './_lib/analiza.js';
import { urlCompanyFacts, UA_DEFAULT, URL_TICKERS } from './_lib/edgar.js';

const TICKER_OK = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;

/**
 * UN FALLO TÉCNICO, DICHO PARA QUIEN LEE LA PANTALLA.
 *
 * "lectura fallida: Falta DATABASE_URL (connection string)" es exacto y no
 * le sirve a nadie que esté mirando una ficha de NVIDIA: nombra una variable
 * de entorno nuestra. La regla de Lety es que lo que se ve en pantalla va sin
 * jerga; la regla 2 es que el hueco diga su causa. Las dos se cumplen
 * diciendo QUÉ no se pudo hacer, y dejando el detalle técnico en `title`.
 */
function enCastellano(error) {
  const t = String(error || '');
  if (/DATABASE_URL|connection string|ECONNREFUSED|connect|Neon/i.test(t)) {
    return 'no se pudo leer nuestra base de datos en este momento';
  }
  if (/no contestó en \d+ ?ms|timeout|abort/i.test(t)) return 'la fuente no contestó a tiempo';
  if (/HTTP 4\d\d|HTTP 5\d\d/.test(t)) return t;   // ya es legible: "Yahoo respondió HTTP 429"
  return t;
}
// El benchmark del encargo: S&P 500 para lo de EE.UU., IPC para lo de México.
const BENCH_US = '^GSPC';
const BENCH_MX = '^MXX';

async function serie(symbol, rango = '5y') {
  const r = await enProceso(candlesHandler, { symbol, interval: '1d', range: rango }, { topeMs: 9000 });
  if (r.error) return { velas: [], motivo: r.error, fuente: null };
  const j = r.json || {};
  if (!Array.isArray(j.candles) || !j.candles.length) {
    return { velas: [], motivo: j.error || 'la fuente no devolvió velas', fuente: j.source || null };
  }
  return { velas: j.candles, moneda: j.currency || null, rango: j.range || rango,
    fuente: `${j.source || 'yahoo'}:v8/chart (interval=1d, range=${j.range || rango})`, motivo: null };
}

/**
 * Los hechos de EDGAR. Se pide DIRECTO porque es la única fuente que da el
 * `accn` con el que se cita el 10-Q, y porque `companyfacts` no tiene
 * endpoint propio en este repo (lo que hay es `companyconcept`, que trae un
 * concepto y acá hacen falta dos).
 */
async function hechosEdgar(cik) {
  if (!cik) return { facts: null, motivo: 'no sabemos el CIK de esta emisora: EDGAR se consulta por CIK, no por ticker' };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(urlCompanyFacts(cik), {
      signal: ctl.signal,
      headers: { 'user-agent': process.env.SEC_USER_AGENT || UA_DEFAULT, accept: 'application/json' },
    }).finally(() => clearTimeout(t));
    if (!r.ok) return { facts: null, motivo: `EDGAR respondió HTTP ${r.status}` };
    return { facts: await r.json(), motivo: null };
  } catch (e) {
    return { facts: null, motivo: e && e.name === 'AbortError' ? 'EDGAR no contestó en 9 s' : String((e && e.message) || e) };
  }
}

/**
 * EL CIK, DESDE EL TICKER.
 *
 * EDGAR se consulta por CIK y `quoteSummary` no lo trae, así que esta ficha
 * nació aceptándolo por query. En producción eso significó que
 * `/analiza/NVDA` dijera "EDGAR no devolvió conceptos us-gaap" mientras
 * `&cik=1045810` traía los trimestres perfectos (Lety, 2026-10-20): un hueco
 * en pantalla cuyo único motivo era que nadie había escrito el número a mano.
 *
 * El mapa lo publica la propia SEC en `company_tickers.json`, que es el mismo
 * archivo que ya baja `api/_lib/edgar.js` para la ingesta de Historia. Acá se
 * baja una vez por instancia y se guarda en memoria: son ~1 MB y 10.000
 * emisoras, y volver a pedirlo en cada ficha sería castigar a la SEC por una
 * respuesta que no cambia en todo el día.
 *
 * Lo que NO hace: adivinar. Si el ticker no está en el archivo —una emisora
 * mexicana, un ETF extranjero— devuelve null con su causa, y el bloque de
 * financieros lo dice. Un CIK inventado citaría el 10-Q de otra empresa.
 */
const TTL_TICKERS_MS = 12 * 3600e3;
let mapaTickers = { at: 0, por: null, motivo: null };

async function cikDeTicker(ticker) {
  const sym = String(ticker || '').toUpperCase().trim();
  if (!sym) return { cik: null, motivo: 'sin ticker' };
  // `.MX` no está en el archivo de la SEC: la BMV no reporta a EDGAR.
  if (/\.MX$/.test(sym)) {
    return { cik: null, nombre: null,
      motivo: 'las emisoras de la BMV no reportan a la SEC: no hay 10-Q que citar' };
  }
  if (!mapaTickers.por || Date.now() - mapaTickers.at > TTL_TICKERS_MS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(URL_TICKERS, {
        signal: ctl.signal,
        headers: { 'user-agent': process.env.SEC_USER_AGENT || UA_DEFAULT, accept: 'application/json' },
      }).finally(() => clearTimeout(t));
      if (!r.ok) throw new Error(`la SEC respondió HTTP ${r.status} al pedir la lista de emisoras`);
      const j = await r.json();
      const por = new Map();
      for (const fila of Object.values(j || {})) {
        if (!fila || !fila.ticker || fila.cik_str == null) continue;
        por.set(String(fila.ticker).toUpperCase(), { cik: String(fila.cik_str), nombre: fila.title || '' });
      }
      if (!por.size) throw new Error('la lista de emisoras de la SEC bajó vacía');
      mapaTickers = { at: Date.now(), por, motivo: null };
    } catch (e) {
      // El mapa viejo sigue sirviendo: una caída de la SEC no tiene por qué
      // apagar el bloque de financieros de todas las fichas.
      const dicho = e && e.name === 'AbortError' ? 'la SEC no contestó en 9 s' : String((e && e.message) || e);
      if (!mapaTickers.por) return { cik: null, motivo: dicho };
      mapaTickers.motivo = dicho;
    }
  }
  const hit = mapaTickers.por.get(sym);
  return hit
    ? { cik: hit.cik, nombre: hit.nombre, motivo: null, fuente: 'sec:company_tickers' }
    : { cik: null, nombre: null, motivo: `${sym} no está en la lista de emisoras que reportan a la SEC` };
}

/**
 * LOS MÓDULOS CRUDOS DE YAHOO, y por qué no se usa `/api/fundamentals`.
 *
 * Ese endpoint existe y funciona, pero hace dos cosas que acá serían un
 * problema: APLANA la respuesta a su propio puñado de campos —se pierden el
 * precio objetivo y la tendencia de recomendaciones, que son dos de los tres
 * paneles de analistas— y calcula "múltiplos promedio por sector" con una
 * tabla aproximada. Esa aproximación es legítima donde ya vive; en `/mercado`
 * no se estima un número y se pinta como dato (regla 2).
 *
 * LA FASE 0.8 YA ANTICIPÓ EL RESULTADO: `quoteSummary` pide un crumb desde el
 * servidor y es probable que conteste 401 desde Vercel. Cuando eso pase, los
 * paneles van punteados CON esa causa, que es exactamente lo que el encargo
 * manda hacer con un dato que no se puede sostener.
 */
const TTL_YAHOO_MS = 10 * 60e3;          // una ficha recargada no vuelve a pedir
const ESPERAS_MS = [600, 1800];          // dos reintentos, creciendo
const cacheYahoo = new Map();            // ticker → { at, res }

const duerme = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `quoteSummary` CON CACHÉ, REINTENTO Y RESPUESTA VIEJA ANTES QUE NADA.
 *
 * Lety, 2026-10-20: *"Yahoo `quoteSummary` da 429: agrega caché y reintento
 * con espera."* El 429 no es el NO-GO de la Fase 0.8 —ése era el 401 por el
 * crumb—: es Yahoo diciendo "vas muy rápido", y tiene arreglo.
 *
 * Las tres capas, en orden:
 *
 *   1. CACHÉ de diez minutos por ticker. Es la que de verdad quita los 429:
 *      cada recarga de la ficha era otra petición por el mismo dato, que no
 *      cambia en diez minutos.
 *   2. REINTENTO con espera creciente, sólo ante 429 y 5xx. Un 401 o un 404
 *      no mejoran por insistir, y reintentarlos es castigar a la fuente que
 *      ya contestó lo que tenía que contestar. `Retry-After` manda si viene.
 *   3. LA RESPUESTA VIEJA, dicha como vieja. Si todo falla y hay algo
 *      guardado, se devuelve con su edad para que la pantalla diga "de hace
 *      12 minutos" en vez de apagar tres paneles. Un dato de hace un rato,
 *      declarado, es mejor que un hueco; un dato de hace un rato CALLADO
 *      sería lo de siempre y no se hace.
 */
async function quoteSummary(ticker) {
  const guardado = cacheYahoo.get(ticker);
  if (guardado && Date.now() - guardado.at < TTL_YAHOO_MS) {
    return { res: guardado.res, motivo: null, de_cache: true };
  }
  const modulos = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price,recommendationTrend';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modulos}`;
  let ultimo = 'Yahoo no contestó';

  for (let intento = 0; intento <= ESPERAS_MS.length; intento++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      }).finally(() => clearTimeout(t));

      if (r.ok) {
        const j = await r.json();
        const uno = j && j.quoteSummary && Array.isArray(j.quoteSummary.result) && j.quoteSummary.result[0];
        if (!uno) return { res: null, motivo: 'Yahoo contestó sin módulos para este ticker' };
        cacheYahoo.set(ticker, { at: Date.now(), res: uno });
        return { res: uno, motivo: null, intentos: intento + 1 };
      }

      if (r.status === 401 || r.status === 403) {
        ultimo = `Yahoo respondió HTTP ${r.status}: pide una credencial que sólo le da a un navegador, no a un servidor como el nuestro`;
        break;   // insistir no lo arregla
      }
      if (r.status === 429) {
        ultimo = 'Yahoo respondió HTTP 429: está limitando las peticiones';
      } else if (r.status >= 500) {
        ultimo = `Yahoo respondió HTTP ${r.status}`;
      } else {
        ultimo = `Yahoo respondió HTTP ${r.status}`;
        break;   // 404 y compañía: tampoco mejoran
      }
      if (intento < ESPERAS_MS.length) {
        // `Retry-After` en segundos, si viene; acotado para no colgar la
        // ficha entera esperando a una fuente que ya dijo que no.
        const pedido = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
        const espera = Number.isFinite(pedido) && pedido > 0
          ? Math.min(pedido * 1000, 3000) : ESPERAS_MS[intento];
        await duerme(espera);
      }
    } catch (e) {
      ultimo = e && e.name === 'AbortError' ? 'Yahoo no contestó en 9 s' : String((e && e.message) || e);
      if (intento < ESPERAS_MS.length) await duerme(ESPERAS_MS[intento]);
    }
  }

  if (guardado) {
    const minutos = Math.round((Date.now() - guardado.at) / 60000);
    return {
      res: guardado.res, motivo: null, vieja: true, edad_min: minutos,
      aviso: `${ultimo}; se muestra la última respuesta buena, de hace ${minutos} min`,
    };
  }
  return { res: null, motivo: ultimo };
}

/**
 * EL RELEVO: los fundamentales de Finnhub, que el mapa ya usa.
 *
 * Sólo se pide cuando Yahoo no dejó nada, y se dice en la tabla de dónde
 * salió cada número. Sin llave configurada, no se inventa: se declara.
 */
async function metricDeFinnhub(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { metric: null, motivo: 'no hay llave de Finnhub configurada en el entorno' };
  // La BMV no está en Finnhub con el sufijo `.MX` del ticker de Yahoo.
  if (/\.MX$/.test(ticker)) {
    return { metric: null, motivo: 'Finnhub no cubre las emisoras de la BMV con este símbolo' };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`,
      { signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return { metric: null, motivo: `Finnhub respondió HTTP ${r.status}` };
    const j = await r.json();
    return (j && j.metric)
      ? { metric: j, motivo: null }
      : { metric: null, motivo: 'Finnhub contestó sin fundamentales para este ticker' };
  } catch (e) {
    return { metric: null, motivo: e && e.name === 'AbortError'
      ? 'Finnhub no contestó en 7 s' : String((e && e.message) || e) };
  }
}

async function fixDeBanxico() {
  const r = await enProceso(banxicoHandler, { series: 'USDMXN', days: '2000' }, { topeMs: 6000 });
  if (r.error) return { serie: [], motivo: r.error };
  const pts = (r.json && r.json.points) || [];
  if (pts.length < 2) return { serie: [], motivo: `el SIE devolvió ${pts.length} punto(s)` };
  return {
    serie: pts.map((p) => ({ t: Date.parse(p.date + 'T12:00:00Z') / 1000, c: Number(p.value) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c)),
    valor: r.json.latest ? Number(r.json.latest.value) : null,
    fecha: r.json.latest ? r.json.latest.date : null,
    fuente: 'banxico:SF43718 (FIX)', motivo: null,
  };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = (req && req.query) || {};
  const ticker = String(q.ticker || '').toUpperCase().trim();
  if (!ticker || !TICKER_OK.test(ticker)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'ticker requerido, p. ej. ?ticker=NVDA' });
  }
  const esMx = /\.MX$/.test(ticker);
  const bench = esMx ? BENCH_MX : BENCH_US;

  try {
    // Las siete lecturas, en paralelo. Una caída NO tumba a las otras: cada
    // una devuelve su propio `{ ..., motivo }`.
    const [px, benchPx, yahoo, insiders, cal, hist, news, fix] = await Promise.all([
      serie(ticker),
      serie(bench),
      quoteSummary(ticker),
      enProceso(insiderHandler, { ticker }, { topeMs: 9000 }),
      enProceso(earningsHandler, { ticker }, { topeMs: 9000 }),
      enProceso(historiaHandler, { ticker, lang: 'es' }, { topeMs: 9000 }),
      enProceso(noticiasHandler, { limite: '80' }, { topeMs: 6000 }),
      fixDeBanxico(),
    ]);

    const yj = yahoo.res || null;
    // El relevo sólo se pide si hizo falta: una petición de más a Finnhub por
    // cada ficha sería gastar el cupo que el mapa necesita.
    const finnhub = yj ? { metric: null, motivo: null } : await metricDeFinnhub(ticker);
    const perfil = (yj && yj.assetProfile) || {};
    const precio = (yj && yj.price) || {};
    // El CIK: el de la query manda —sirve para forzar uno concreto— y si no
    // viene, se resuelve desde el ticker contra la lista de la SEC.
    const porTicker = q.cik ? { cik: null, motivo: null } : await cikDeTicker(ticker);
    const cik = q.cik || porTicker.cik || null;
    const edgar = await hechosEdgar(cik);
    // Si no hay CIK, el motivo que se dice es el de la RESOLUCIÓN, que es el
    // que explica de verdad por qué no hay 10-Q: "no sabemos el CIK" no
    // distingue una emisora de la BMV de una caída de la SEC.
    const motivoCik = cik ? null : (porTicker.motivo || 'no sabemos el CIK de esta emisora');

    // Noticias del ticker: de la MISMA tabla que /mercado y R3b. El cruce es
    // por el arreglo `tickers` que ya calculó el job — sin IA (regla 6).
    const todasLasNotas = (news.json && news.json.noticias) || [];
    const notasDelTicker = todasLasNotas
      .map((n) => ({ ...n, tickers: tickersDeFila(n.tickers) }))
      .filter((n) => (n.tickers || []).includes(ticker.replace(/\.MX$/, '')));

    const insTx = (insiders.json && insiders.json.transactions) || [];
    const facts = edgar.facts;
    const financieros = trimestresDeCompanyFacts(facts);

    const cuerpo = {
      ticker,
      nombre: precio.longName || precio.shortName || perfil.longName || null,
      bolsa: precio.exchangeName || precio.exchange || (esMx ? 'BMV' : null),
      sector: perfil.sector || null,
      moneda: px.moneda || (esMx ? 'MXN' : 'USD'),
      es_mexicana: esMx,

      // ── PRECIO Y RENDIMIENTO ──────────────────────────────────────
      serie: px,
      // Lo que la serie permite afirmar: total (con dividendos) o de precio.
      rendimiento: serieDeRendimiento(px.velas),
      benchmark: {
        symbol: bench,
        nombre: esMx ? 'IPC' : 'S&P 500',
        serie: benchPx,
        rendimiento: serieDeRendimiento(benchPx.velas),
      },
      fix,

      // ── UPA ───────────────────────────────────────────────────────
      // LA LLAVE ES `history`, NO `earnings`.
      //
      // `/api/earnings?ticker=` devuelve `{ ticker, history, next_earnings, … }`
      // desde que existe, con `period` y `eps_estimate` adentro. Esta ficha
      // pedía `earnings`, `date` y `eps_est` —nombres que yo supuse— así que
      // el bloque de UPA salía "sin trimestres" para NVDA, que tiene años de
      // historial (Lety, 2026-10-20). El endpoint estaba contestando bien.
      upa: upaRealVsEstimado((cal.json && cal.json.history) || [], { motivoFuente: cal.error || (cal.json && cal.json.error) || null }),
      // Y el próximo reporte YA VIENE RESUELTO por el endpoint, con su
      // calendario propio: no hay que deducirlo filtrando el historial, que
      // además nunca trae fechas futuras.
      proximo_reporte: (() => {
        const sig = cal.json && cal.json.next_earnings;
        if (!sig || !sig.date) {
          return { fecha: null, motivo: cal.error || (cal.json && cal.json.error)
            || 'el calendario no trae un reporte futuro confirmado para este ticker' };
        }
        return {
          fecha: sig.date,
          cuando: sig.time || null,
          dias: sig.days_away != null ? sig.days_away : null,
          eps_estimado: sig.eps_estimate != null ? sig.eps_estimate : null,
          trimestre: sig.quarter != null && sig.year != null ? `${sig.year} T${sig.quarter}` : null,
          fuente: 'finnhub:calendar/earnings',
        };
      })(),

      // ── ESTADOS FINANCIEROS, CITANDO SU FILING ────────────────────
      financieros: {
        ...financieros,
        cik: cik || null,
        cik_fuente: q.cik ? 'pedido en la URL' : (porTicker.fuente || null),
        motivo: cik ? (financieros.motivo || edgar.motivo || null) : motivoCik,
        filas: (financieros.filas || []).map((f) => ({
          ...f,
          ingresos_link: linkDeFiling(cik, f.ingresos_accn),
          utilidad_link: linkDeFiling(cik, f.utilidad_accn),
        })),
      },

      // ── ANALISTAS ─────────────────────────────────────────────────
      analistas: {
        precio_objetivo: yj ? precioObjetivo(yj.financialData)
          : { disponible: false, motivo: yahoo.motivo },
        recomendaciones: {
          ...recomendaciones((yj && yj.recommendationTrend && yj.recommendationTrend.trend) || []),
          motivo: yj ? null : yahoo.motivo,
          aviso: yahoo.aviso || null,
        },
        de_pago: DE_PAGO,
      },

      // LA VALUACIÓN, CON RELEVO. Si Yahoo no dejó nada —429 que no cedió,
      // o el 401 del crumb— la tabla se arma con los fundamentales de
      // Finnhub, que es la fuente que el mapa ya usa. Cada fila dice de
      // cuál de las dos salió: son dos proveedores y pueden no coincidir al
      // segundo decimal.
      valuacion: yj
        ? { filas: tablaValuacion(yj), fuente: 'yahoo:quoteSummary',
            motivo: null, vieja: yahoo.vieja || false, aviso: yahoo.aviso || null }
        : (finnhub.metric
          ? { filas: tablaValuacionFinnhub(finnhub.metric), fuente: 'finnhub:metric',
              motivo: null, relevo: true,
              aviso: `Yahoo no contestó (${yahoo.motivo}); la valuación viene de Finnhub` }
          : { filas: tablaValuacion(null), fuente: null,
              motivo: `${yahoo.motivo}; el relevo tampoco: ${finnhub.motivo}` }),

      insiders: {
        ultimas: insTx.slice(0, 3),
        neto_90: netoInsiders(insTx),
        total: insTx.length,
        fuente: (insiders.json && insiders.json.source) || 'finnhub:insider-transactions',
        motivo: insTx.length ? null : (insiders.error || (insiders.json && insiders.json.summary) || 'la fuente no devolvió transacciones'),
      },

      historia: {
        hitos: (hist.json && (hist.json.hitos || hist.json.eventos || [])) || [],
        fuente: 'neon:historia',
        motivo: hist.error ? enCastellano(hist.error) : null,
        // El texto crudo no se tira: va al `title` y a la consola, para quien
        // esté arreglando el problema. Lo que no hace es ocupar el renglón.
        motivo_tecnico: hist.error || null,
      },

      noticias: {
        filas: notasDelTicker.slice(0, 8),
        de: todasLasNotas.length,
        fuente: 'neon:mercado_noticias',
        metodo: 'cruce con el arreglo de tickers que calculó el job de noticias, sin IA',
        motivo: news.error
          ? enCastellano(news.error)
          : (notasDelTicker.length ? null : 'ninguna nota de las últimas 72 horas menciona este ticker'),
        motivo_tecnico: news.error || null,
      },

      // La pantalla enlaza el flujo de agentes; acá NO se llama (regla 6).
      agentes: { ruta: `/app?tab=analyze&ticker=${encodeURIComponent(ticker)}`,
                 nota: 'el análisis con agentes vive en la terminal y sólo corre al pulsarlo' },

      generado_en: new Date().toISOString(),
      ms: Date.now() - t0,
    };

    res.setHeader('Cache-Control', px.velas.length
      ? 'public, s-maxage=300, stale-while-revalidate=900' : 'no-store');
    return res.status(200).json(cuerpo);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    // La LECTURA se queda en 200 con la causa adentro: un 500 le quitaría la
    // ficha entera a la pantalla en vez de dejarle decir qué pasó.
    return res.status(200).json({ ticker, error: String((e && e.message) || e), ms: Date.now() - t0 });
  }
}
