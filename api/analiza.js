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
  recomendaciones, precioObjetivo, tablaValuacion, netoInsiders, DE_PAGO,
} from './_lib/analiza.js';
import { urlCompanyFacts, UA_DEFAULT } from './_lib/edgar.js';

const TICKER_OK = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
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
async function quoteSummary(ticker) {
  const modulos = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price,recommendationTrend';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modulos}`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
    }).finally(() => clearTimeout(t));
    if (!r.ok) {
      return { res: null, motivo: r.status === 401 || r.status === 403
        ? `Yahoo quoteSummary respondió HTTP ${r.status}: pide crumb desde el servidor (es el NO-GO de la Fase 0.8)`
        : `Yahoo quoteSummary respondió HTTP ${r.status}` };
    }
    const j = await r.json();
    const uno = j && j.quoteSummary && Array.isArray(j.quoteSummary.result) && j.quoteSummary.result[0];
    return uno ? { res: uno, motivo: null } : { res: null, motivo: 'Yahoo contestó sin módulos para este ticker' };
  } catch (e) {
    return { res: null, motivo: e && e.name === 'AbortError' ? 'Yahoo no contestó en 9 s' : String((e && e.message) || e) };
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
    const perfil = (yj && yj.assetProfile) || {};
    const precio = (yj && yj.price) || {};
    // El CIK no viene en quoteSummary: se acepta por query para poder citar
    // EDGAR mientras no tengamos el mapa ticker→CIK en esta pantalla. Sin él
    // el bloque de financieros lo DICE en vez de quedarse mudo.
    const cik = q.cik || null;
    const edgar = await hechosEdgar(cik);

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
      upa: upaRealVsEstimado((cal.json && cal.json.earnings) || []),
      proximo_reporte: (() => {
        const es = (cal.json && cal.json.earnings) || [];
        const hoy = new Date().toISOString().slice(0, 10);
        const sig = es.filter((e) => e.date >= hoy && e.eps_actual == null)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
        return sig ? { fecha: sig.date, cuando: sig.time, eps_estimado: sig.eps_est, fuente: 'finnhub:earnings' }
          : { fecha: null, motivo: cal.error || 'la fuente no trae un reporte futuro para este ticker' };
      })(),

      // ── ESTADOS FINANCIEROS, CITANDO SU FILING ────────────────────
      financieros: {
        ...financieros,
        cik: cik || null,
        motivo: financieros.motivo || edgar.motivo || null,
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
        },
        de_pago: DE_PAGO,
      },

      valuacion: { filas: tablaValuacion(yj), fuente: 'yahoo:quoteSummary', motivo: yj ? null : yahoo.motivo },

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
        motivo: hist.error || null,
      },

      noticias: {
        filas: notasDelTicker.slice(0, 8),
        de: todasLasNotas.length,
        fuente: 'neon:mercado_noticias',
        metodo: 'cruce con el arreglo de tickers que calculó el job de noticias, sin IA',
        motivo: notasDelTicker.length ? null : 'ninguna nota de las últimas 72 horas menciona este ticker',
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
