// ═══════════════════════════════════════════════════════════════════
// /api/libro-report — el reporte del Libro. SOLO LECTURA.
//
// Tres números arriba del pliegue y nada más:
//   1. ¿Le gané al piso?   retorno del libro − retorno de SPY (mismo periodo).
//   2. ¿Cuánto me asusté?  max drawdown desde el pico, en % y días bajo el agua.
//   3. ¿Fue suerte?        percentil contra 1,000 libros al azar (mismo # de
//                          operaciones, mismos símbolos elegibles, fechas al
//                          azar, mismos costos). 40–60 → "indistinguible de
//                          suerte", con esas palabras.
// Debajo: tabla por estrategia.
//
//   GET /api/libro-report            → JSON
//   GET /api/libro-report?format=md  → markdown en español
//
// Gate: ADMIN_SECRET / CRON_SECRET (Bearer, x-admin-key o ?secret=). Es la
// cuenta real de Lety: el reporte no es público.
//
// Los símbolos elegibles del Monte Carlo = los que aparecen en libro_ordenes
// (si hay). Precios de Yahoo en vivo (_lib/yahoo-daily.js), no se guardan.
//
// ENV VARS: DATABASE_URL · ADMIN_SECRET (o CRON_SECRET)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { ensureLibroSchema, leerEstado, metricas, percentilSuerte, retornoMedioPorOperacion, renderReporteMarkdown } from './_lib/libro.js';
import { libroLiveEnabled, libroModo } from './_lib/libro-alpaca.js';
import { bajaSeries } from './_lib/yahoo-daily.js';

// 120s, como en `main`. Esta rama lo había bajado a 60 con la nota «una
// entrada propia rompe el build (unused_function)», y eso era cierto el
// 2026-10-18: `api/libro-report.js` todavía no existía, así que su patrón en
// `vercel.json` no casaba con nada. Hoy el archivo existe, `main` tiene la
// entrada de 120s y despliega verde. Bajar el techo a la mitad era el
// workaround de un error que ya no pasa, no una decisión sobre cuánto tarda
// el reporte — así que se conserva el 120 de `main` (resuelto al traer `main`
// a esta rama, 2026-10-23).
export const maxDuration = 120;

function secretoAdmin() { return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null; }
function autorizado(req, q) {
  const s = secretoAdmin();
  if (!s) return false;
  const h = (req.headers && req.headers.authorization) || '';
  return h === `Bearer ${s}` || (req.headers && req.headers['x-admin-key']) === s || String((q && q.secret) || '') === s;
}

export async function armarReporte({ now = new Date(), bajar = bajaSeries } = {}) {
  await ensureLibroSchema();
  const [equityDiario, estrategias, ordenes, spyUnidades, equityInicial, halt] = await Promise.all([
    sql(`select to_char(fecha, 'YYYY-MM-DD') as fecha, equity, cash, spy_close, posiciones from libro_equity_diario order by fecha asc`),
    sql(`select * from libro_estrategias order by created_at asc`),
    sql(`select * from libro_ordenes order by enviada_at asc`),
    leerEstado('spy_unidades'), leerEstado('equity_inicial'), leerEstado('LIBRO_HALT'),
  ]);
  const m = metricas({ equityDiario, spyUnidades: spyUnidades == null ? null : Number(spyUnidades), equityInicial: equityInicial == null ? null : Number(equityInicial) });
  const { ops, media } = retornoMedioPorOperacion(ordenes);
  let suerte = { aplica: false, motivo: '0 operaciones cerradas' };
  if (ops.length) {
    const simbolos = [...new Set(ops.map((o) => o.symbol))];
    let series = {};
    try { series = await bajar(simbolos, '1y'); } catch (e) { series = {}; }
    suerte = percentilSuerte({ ops, series, retornoReal: media });
  }
  return {
    generated_at: now.toISOString(), cuenta: libroModo(), envio: libroLiveEnabled() ? 'ENCENDIDO' : 'SOMBRA', halt: halt === '1',
    numeros: { le_gane_al_piso: m.exceso, cuanto_me_asuste: m.max_drawdown, fue_suerte: suerte },
    metricas: m, estrategias, ordenes: ordenes.length, operaciones_cerradas: ops.length,
    markdown: renderReporteMarkdown({ m, suerte, estrategias, ordenes, halt: halt === '1', live: libroLiveEnabled(), cuenta: libroModo(), now }),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const q = req.query || {};
  if (!autorizado(req, q)) return res.status(401).json({ error: 'No autorizado.' });
  try {
    const r = await armarReporte();
    if (String(q.format || '').toLowerCase() === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(200).send(r.markdown);
    }
    return res.status(200).json(r);
  } catch (err) {
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
