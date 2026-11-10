// ═══════════════════════════════════════════════════════════════════
// /api/pm-fechas-av — relleno de report_date desde pm_v2_hist (AV EARNINGS).
//
// Para cada mercado resuelto de v2 ∪ v1 (liquidez ≥ $500, con token): si la
// tabla no trae report_date, toma el PRIMER reporte de AV en o después de la
// creación del mercado (regla en _lib/pm-trimestre-av.js). Guarda el
// resultado, con su fuente ('tabla' | 'av_hist') y el motivo si no hubo, en
// pm_fecha_av (tabla nueva). Es la COBERTURA de PM-CENTAVOS2 y PM-DRIFT2H.
//
//   GET /api/pm-fechas-av?format=md   → resumen
//   &escribir=0                        → no escribe pm_fecha_av
//   &obs=1                             → detalle por mercado (JSON)
//
// Escribe SOLO pm_fecha_av. Sobre v1, v2, pm_v2_hist, pead_event_hour y
// pead_earnings: SELECT. ENV: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './_lib/db.js';
import { abre, responde } from './_lib/pm-backtest-http.js';
import {
  CRITERIOS_TRIMESTRE_AV, cargaBase, baseMercados, resumenFechas, renderFechasMarkdown, SCHEMA_FECHAS, sqlUpsertFechas,
} from './_lib/pm-trimestre-av.js';

export const maxDuration = 120;
const LOTE_UPSERT = 200;

export default async function handler(req, res) {
  const op = abre(req, res);
  if (!op) return;
  const escribir = String((req.query || {}).escribir || '1') !== '0';
  try {
    const carga = await cargaBase({ sql, conPead: true });
    const base = baseMercados(carga.filas, { histPorSimbolo: carga.histPorSimbolo, horas: carga.horas });
    const resumen = resumenFechas(base, { histPorSimbolo: carga.histPorSimbolo, peadPorSimbolo: carga.peadPorSimbolo });
    let escrito = 0;
    if (escribir && base.mercados.length) {
      await sqlBatch(SCHEMA_FECHAS.map((s) => [s, []]));
      const qs = [];
      for (let i = 0; i < base.mercados.length; i += LOTE_UPSERT) {
        const { query, params } = sqlUpsertFechas(base.mercados.slice(i, i + LOTE_UPSERT));
        qs.push([query, params]);
      }
      await sqlBatch(qs);
      escrito = base.mercados.length;
    }
    const salida = { generado_en: new Date().toISOString(), criterios: CRITERIOS_TRIMESTRE_AV, escrito, resumen };
    if (op.conObs) salida.obs = base.mercados.map(({ descripcion, ...m }) => m);
    return responde(res, op, salida, renderFechasMarkdown);
  } catch (err) {
    return res.status(500).json({ error: 'pm-fechas-av: ' + ((err && err.message) || 'unknown') });
  }
}
