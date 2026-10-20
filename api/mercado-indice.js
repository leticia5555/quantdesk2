// ═══════════════════════════════════════════════════════════════════════
// /api/mercado-indice — R4: todo lo que la ficha del artboard 6 necesita,
// en UNA llamada (regla 7).
//
//   GET /api/mercado-indice?idx=SPX&rango=1y
//
// LO QUE ESTE ENDPOINT NO HACE:
//   · NO devuelve un solo porcentaje de periodo. Manda la serie y la pantalla
//     la pasa por `qdPeriodChange` (regla 1). Un % pre-cocinado en el servidor
//     es justo lo que hace que dos pantallas digan números distintos del mismo
//     índice;
//   · NO llama a ninguna IA (regla 6);
//   · NO se llama a sí mismo por HTTP. Importa los handlers y los corre EN
//     PROCESO: el preview de Vercel está protegido y un `fetch` al propio
//     origen vuelve con 401 (la cicatriz de #273).
//
// CADA BLOQUE VIAJA CON SU FUENTE Y, SI FALTA, CON SU CAUSA (reglas 2 y 3).
// Un bloque que no llegó se declara; nunca se rellena con el de al lado.
// ═══════════════════════════════════════════════════════════════════════

import candlesHandler from './candles.js';
import noticiasHandler from './noticias.js';
import banxicoHandler from './banxico.js';
import { enProceso } from './mercado-paneles.js';
import { indiceDe, INDICES } from './_lib/mercado-indice.js';

// El rango por default de la ficha. Un año es lo que la fuente trae hoy sin
// pedirle nada nuevo; `?rango=` lo cambia y la pantalla ofrece los que la
// serie recibida alcanza, no los que querríamos tener.
const RANGO_DEFECTO = '1y';
const RANGOS = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

/** La serie del índice, como velas OHLC. Nunca lanza: devuelve su causa. */
async function serieDe(symbol, rango) {
  const r = await enProceso(candlesHandler, { symbol, interval: '1d', range: rango }, { topeMs: 8000 });
  if (r.error) return { velas: [], motivo: r.error, fuente: null };
  const j = r.json || {};
  if (!Array.isArray(j.candles) || !j.candles.length) {
    return { velas: [], motivo: j.error || 'la fuente no devolvió velas', fuente: j.source || null };
  }
  return {
    velas: j.candles,
    moneda: j.currency || null,
    fuente: `${j.source || 'yahoo'}:v8/chart (interval=1d, range=${j.range || rango})`,
    rango: j.range || rango,
    motivo: null,
  };
}

/** El FIX de Banxico para la columna en pesos. Su ausencia se declara. */
async function fixDeBanxico() {
  // `days=420` como el mapa: la serie del FIX tiene que cubrir el año que
  // cubre la del índice, o la columna en pesos quedaría más corta que la de
  // la izquierda sin decir por qué.
  const r = await enProceso(banxicoHandler, { series: 'USDMXN', days: '420' }, { topeMs: 6000 });
  if (r.error) return { serie: [], motivo: r.error };
  const j = r.json || {};
  const pts = Array.isArray(j.points) ? j.points : [];
  if (pts.length < 2) {
    return { serie: [], motivo: `el SIE devolvió ${pts.length} punto(s): sin dos no hay periodo que convertir` };
  }
  return {
    // Mediodía UTC y no medianoche: es lo que ya hace `traerFix` en
    // `mercado.html`, y dos conversiones distintas de la misma fecha son dos
    // series que no se alinean.
    serie: pts.map((p) => ({ t: Date.parse(p.date + 'T12:00:00Z') / 1000, c: Number(p.value) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c)),
    valor: j.latest ? Number(j.latest.value) : (pts.length ? Number(pts[pts.length - 1].value) : null),
    fecha: j.latest ? j.latest.date : (pts.length ? pts[pts.length - 1].date : null),
    fuente: 'banxico:SF43718 (FIX)',
    motivo: null,
  };
}

/**
 * Las noticias del índice, de la MISMA tabla que /mercado y R3b.
 *
 * El encargo lo pide explícito: "una sola fuente de verdad". El filtro es por
 * texto del titular contra el nombre del índice y su símbolo — sin IA
 * (regla 6) y sin clasificador: es una coincidencia declarada, y por eso el
 * bloque dice CÓMO filtró.
 */
async function noticiasDe(ix) {
  const r = await enProceso(noticiasHandler, { limite: '60' }, { topeMs: 6000 });
  if (r.error) return { filas: [], motivo: r.error };
  const todas = (r.json && r.json.noticias) || [];
  const agujas = [ix.nombre.toLowerCase(), ix.id.toLowerCase()];
  // "IPC" también es el índice de precios al consumidor; para México se exige
  // que el titular hable de la BOLSA. Sin esto, la ficha del IPC se llenaba de
  // inflación — la misma sigla, otro dato.
  const filas = todas.filter((n) => {
    const t = String(n.titular || '').toLowerCase();
    if (ix.id === 'IPC') return /\bipc\b/.test(t) && /(bolsa|bmv|mercado|acciones|índice|indice)/.test(t);
    return agujas.some((a) => t.includes(a));
  });
  return {
    filas: filas.slice(0, 8),
    total: filas.length,
    de: todas.length,
    fuente: 'neon:mercado_noticias',
    metodo: `coincidencia del titular con "${ix.nombre}" o "${ix.id}"`
      + (ix.id === 'IPC' ? ' y una palabra de bolsa, porque IPC también es el índice de precios' : ''),
    motivo: filas.length ? null : 'ninguna nota de las últimas 72 horas menciona este índice',
  };
}

export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = (req && req.query) || {};
  const ix = indiceDe(q.idx);
  if (!ix) {
    res.setHeader('Cache-Control', 'no-store');
    // Con la lista: quien pidió mal tiene que poder corregir sin leer el código.
    return res.status(404).json({
      error: `no conozco el índice "${q.idx || ''}"`,
      conocidos: INDICES.map((i) => i.id),
    });
  }
  const rango = RANGOS.has(String(q.rango)) ? String(q.rango) : RANGO_DEFECTO;

  try {
    // En paralelo: tres fuentes distintas, y la caída de una no puede dejar
    // sin ficha a las otras dos.
    const [serie, fix, noticias] = await Promise.all([
      serieDe(ix.symbol, rango),
      fixDeBanxico(),
      noticiasDe(ix),
    ]);

    // ── COMPONENTES: LO QUE NO TENEMOS, DECLARADO ─────────────────────
    // El peso OFICIAL de un índice lo publica quien lo calcula y no lo
    // tenemos para ninguno de los nueve. Tampoco tenemos la membresía
    // verificada: la del S&P 500 y la del Nasdaq 100 salen de las tenencias
    // de un ETF, que es la fuente D1 del Arena — y el Arena está en otra
    // sesión, así que esta rebanada NO lo toca.
    //
    // Entonces se dice. Un panel de componentes inventado a partir del
    // universo del screener sería el error más caro posible acá: parecería
    // la composición del índice y no lo es.
    const componentes = {
      componentes: [],
      metodo: null,
      fuente: null,
      motivo: ix.holdings
        ? 'la membresía verificada de este índice sale de las tenencias del ETF que lo replica'
          + ` (${ix.etf}), que hoy sólo lee el Arena. Queda pendiente de conectar: ver el PR.`
        : `no tenemos una lista de miembros verificada de ${ix.nombre}, y el universo del screener NO es la composición del índice`,
    };

    const hayAlgo = serie.velas.length > 0;
    res.setHeader('Cache-Control', hayAlgo
      ? 'public, s-maxage=300, stale-while-revalidate=900'
      : 'no-store');
    return res.status(200).json({
      indice: ix,
      // La serie, cruda. El % lo calcula la pantalla con `qdPeriodChange`.
      serie,
      fix,
      noticias,
      componentes,
      // Lo que esta ficha NO puede decir y por qué. Va en la respuesta y no
      // en el HTML para que se vea desde la API: un hueco declarado en la
      // pantalla y mudo en el JSON se arregla dos veces.
      sin_dato: {
        pu_agregado: 'el P/U agregado necesita el `metric` de Finnhub por componente, y sin la lista de componentes no hay sobre qué agregarlo',
        cap_total: 'la capitalización total del índice necesita la lista de componentes, y no la tenemos verificada',
      },
      generado_en: new Date().toISOString(),
      ms: Date.now() - t0,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    // La LECTURA se queda en 200 con la causa adentro: el llamador es la
    // pantalla, y un 500 le quitaría la ficha entera en vez de dejarle decir
    // qué pasó. (Los JOBS sí responden 5xx — acá no hay ninguno.)
    return res.status(200).json({
      indice: ix, error: String((e && e.message) || e), ms: Date.now() - t0,
    });
  }
}
