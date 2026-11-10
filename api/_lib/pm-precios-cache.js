// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-precios-cache.js — historiales del Yes desde la caché de
// PM-DRIFT (pm_price_hist / pm_price_hist_fetch): baja lo que falte del CLOB
// (bajaHistoriales de PM-DRIFT) y devuelve los puntos por mercado.
//
// Es la misma plomería que tienen los endpoints de PM-DRIFT y PM-CENTAVOS
// (esos no se tocan). Deps inyectadas para poder probarla.
//   universo: [{ market_id, token, fecha }]
// ═══════════════════════════════════════════════════════════════════

import {
  SCHEMA as SCHEMA_CACHE, SQL_ESTADOS, sqlPuntos, sqlInsertPuntos, sqlRegistraDescarga, normalizaPuntos, bajaHistoriales,
} from './pm-drift-analyze.js';

async function preciosDelUniverso(universo, { sql, sqlBatch, clob, bajar = true, presupuestoMs = 200000, lotePuntos = 100, loteInsert = 400 }) {
  await sqlBatch(SCHEMA_CACHE.map((s) => [s, []]));
  const estados = new Map((await sql(SQL_ESTADOS)).map((r) => [String(r.market_id), r.estado]));
  let descarga = null;
  if (bajar) {
    const pendientes = universo.filter((m) => estados.get(m.market_id) !== 'ok');
    if (pendientes.length) {
      descarga = await bajaHistoriales(pendientes, {
        clob, presupuestoMs,
        guarda: async (x) => {
          const qs = [];
          for (let i = 0; i < x.puntos.length; i += loteInsert) {
            const { query, params } = sqlInsertPuntos(x.market_id, x.puntos.slice(i, i + loteInsert));
            qs.push([query, params]);
          }
          const reg = sqlRegistraDescarga(x);
          qs.push([reg.query, reg.params]);
          await sqlBatch(qs);
          if (x.estado === 'ok' || estados.get(x.market_id) !== 'ok') estados.set(x.market_id, x.estado);
        },
      });
    }
  }
  const ids = universo.filter((m) => estados.get(m.market_id) === 'ok').map((m) => m.market_id);
  const crudos = new Map();
  for (let i = 0; i < ids.length; i += lotePuntos) {
    const lote = ids.slice(i, i + lotePuntos);
    for (const r of await sql(sqlPuntos(lote.length), lote)) {
      const k = String(r.market_id);
      if (!crudos.has(k)) crudos.set(k, []);
      crudos.get(k).push({ t: Number(r.t), p: Number(r.p) });
    }
  }
  const puntosPorId = new Map([...crudos].map(([k, v]) => [k, normalizaPuntos(v)]));
  return { estados, puntosPorId, descarga };
}

export { preciosDelUniverso };
