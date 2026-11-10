// ═══════════════════════════════════════════════════════════════════
// /api/pm-drift2h-analyze — backtest pre-registrado.
// PM-DRIFT2H: resultado ~ logit(p2h) + Δ2, sin horas imputadas; simulación a precio p2h. Ver docs/pm-drift2h-scope.md.
//
//   ?solo=cobertura&format=md → baja lo que falte del CLOB y dice cuántos
//                               quedan. Sin veredicto.
//   ?format=md                → resultado · sin format → JSON
//   &obs=1 → detalle por mercado · &bajar=0 → no toca el CLOB
//
// Fechas: las de la tabla o, si no hay, las de pm_v2_hist (misma regla que
// /api/pm-fechas-av, calculada en el momento). Precios: la caché de PM-DRIFT
// (pm_price_hist / pm_price_hist_fetch): es lo ÚNICO que escribe. Sobre v1,
// v2, pm_v2_hist y pead_event_hour: SELECT.
// ENV: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './_lib/db.js';
import { clob } from './_lib/polymarket.js';
import { abre, responde, soloCobertura } from './_lib/pm-backtest-http.js';
import { cargaBase, baseMercados } from './_lib/pm-trimestre-av.js';
import { preciosDelUniverso } from './_lib/pm-precios-cache.js';
import { CRITERIOS_PM_DRIFT2H, construyeUniverso, corre, renderResumenMarkdown } from './_lib/pm-drift2h-analyze.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  const op = abre(req, res);
  if (!op) return;
  try {
    const carga = await cargaBase({ sql });
    const base = baseMercados(carga.filas, { histPorSimbolo: carga.histPorSimbolo, horas: carga.horas, min_volumen_usd: CRITERIOS_PM_DRIFT2H.min_volumen_usd });
    const u = construyeUniverso(base);
    const { estados, puntosPorId, descarga } = await preciosDelUniverso(u.universo, { sql, sqlBatch, clob, bajar: op.bajar });
    const resultado = corre({ universo: u.universo, puntosPorId, estados });
    const obs = resultado.obs;
    delete resultado.obs;
    if (op.soloCobertura) soloCobertura(resultado);
    const { universo, ...resto } = u;
    const salida = {
      pregunta: '¿Δ2 = p2h − p24 agrega información sobre p2h para predecir el resultado (sin horas imputadas)?',
      generado_en: new Date().toISOString(),
      solo_cobertura: op.soloCobertura,
      criterios: CRITERIOS_PM_DRIFT2H,
      universo: { ...resto, n: universo.length },
      descarga,
      resultado,
      veredicto: op.soloCobertura ? null : resultado.estado,
    };
    if (op.conObs) salida.obs = obs;
    return responde(res, op, salida, renderResumenMarkdown);
  } catch (err) {
    return res.status(500).json({ error: 'pm-drift2h-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
