// ═══════════════════════════════════════════════════════════════════
// /api/pm-centavos-analyze — "PM-CENTAVOS", backtest pre-registrado.
//
// ¿gap = barra − consenso (en centavos; el consenso que declara la
// descripción del mercado) predice el resultado mejor que el precio del Yes a
// T-24h? Criterios CONGELADOS en _lib/pm-centavos-analyze.js
// (CRITERIOS_PM_CENTAVOS). Ver docs/pm-centavos-scope.md.
//
//   GET /api/pm-centavos-analyze?solo=cobertura&format=md → paso 1: baja lo
//        que falte del CLOB y dice cuántos tienen p24. Sin veredicto.
//   GET /api/pm-centavos-analyze?format=md                → resultado
//   GET /api/pm-centavos-analyze                          → JSON
//   &obs=1      → detalle mercado a mercado
//   &bajar=0    → no toca el CLOB: solo lo que ya está en pm_price_hist
//
// ── Lo que escribe ─────────────────────────────────────────────────
// Nada propio. El precio a T-24h sale de la caché de PM-DRIFT
// (pm_price_hist / pm_price_hist_fetch, mismo SCHEMA, misma descarga): lo que
// PM-DRIFT ya bajó no se vuelve a pedir, y lo que baje este endpoint le sirve
// a PM-DRIFT. Sobre pm_earnings_markets, pm_earnings_markets_v2 y
// pead_event_hour: un SELECT.
//
// ── Gate ───────────────────────────────────────────────────────────
// Con CRON_SECRET puesta, sin el secret (header `Authorization: Bearer ...`
// o `?secret=`) → 401. Respuesta `no-store`.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════════

import { sql, sqlBatch } from './_lib/db.js';
import { clob } from './_lib/polymarket.js';
import {
  SCHEMA as SCHEMA_CACHE, SQL_ESTADOS, sqlPuntos, sqlInsertPuntos, sqlRegistraDescarga, normalizaPuntos, bajaHistoriales,
} from './_lib/pm-drift-analyze.js';
import {
  CRITERIOS_PM_CENTAVOS, SQL_UNIVERSO, construyeUniverso, corre, renderResumenMarkdown,
} from './_lib/pm-centavos-analyze.js';

export const maxDuration = 300;

const PRESUPUESTO_DESCARGA_MS = 200000;
const LOTE_PUNTOS = 100;
const LOTE_INSERT = 400;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const porHeader = (req.headers && req.headers.authorization) === `Bearer ${secret}`;
    const porQuery = String(q.secret || '') === secret;
    if (!porHeader && !porQuery) return res.status(401).json({ error: 'No autorizado.' });
  }

  const format = String(q.format || 'json').toLowerCase();
  const soloCobertura = String(q.solo || '') === 'cobertura';
  const conObs = String(q.obs || '') === '1';
  const bajar = String(q.bajar || '1') !== '0';

  try {
    await sqlBatch(SCHEMA_CACHE.map((s) => [s, []]));

    // ── 1. Universo: v2 ∪ v1 + hora del reporte. UN SELECT. ──
    const filas = await sql(SQL_UNIVERSO);
    const u = construyeUniverso(filas);

    // ── 2. Precios: lo que falte se pide al CLOB (caché de PM-DRIFT). ──
    const estados = new Map((await sql(SQL_ESTADOS)).map((r) => [String(r.market_id), r.estado]));
    let descarga = null;
    if (bajar) {
      const pendientes = u.universo.filter((m) => estados.get(m.market_id) !== 'ok');
      if (pendientes.length) {
        descarga = await bajaHistoriales(pendientes, {
          clob, presupuestoMs: PRESUPUESTO_DESCARGA_MS,
          guarda: async (x) => {
            const qs = [];
            for (let i = 0; i < x.puntos.length; i += LOTE_INSERT) {
              const { query, params } = sqlInsertPuntos(x.market_id, x.puntos.slice(i, i + LOTE_INSERT));
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

    // ── 3. Historiales desde pm_price_hist ──
    const ids = u.universo.filter((m) => estados.get(m.market_id) === 'ok').map((m) => m.market_id);
    const crudos = new Map();
    for (let i = 0; i < ids.length; i += LOTE_PUNTOS) {
      const lote = ids.slice(i, i + LOTE_PUNTOS);
      for (const r of await sql(sqlPuntos(lote.length), lote)) {
        const k = String(r.market_id);
        if (!crudos.has(k)) crudos.set(k, []);
        crudos.get(k).push({ t: Number(r.t), p: Number(r.p) });
      }
    }
    const puntosPorId = new Map([...crudos].map(([k, v]) => [k, normalizaPuntos(v)]));

    // ── 4. Análisis ──
    const resultado = corre({ universo: u.universo, puntosPorId, estados });
    const obs = resultado.obs;
    delete resultado.obs;
    if (soloCobertura) {
      for (const k of Object.keys(resultado)) if (!['estado', 'motivo', 'cobertura'].includes(k)) delete resultado[k];
      if (!['FALLA DE FRONTERA', 'COBERTURA INCOMPLETA'].includes(resultado.estado)) {
        resultado.estado = 'COBERTURA LISTA';
        resultado.motivo = 'todos los historiales bajados; abre el link sin ?solo=cobertura para el resultado';
      }
    }

    const salida = {
      pregunta: '¿La distancia en centavos entre la barra de Polymarket y el consenso de la descripción predice el resultado mejor que el precio a T-24h?',
      generado_en: new Date().toISOString(),
      solo_cobertura: soloCobertura,
      criterios: CRITERIOS_PM_CENTAVOS,
      universo: { filas: u.filas, excluidos: u.excluidos, n: u.universo.length },
      descarga,
      resultado,
      veredicto: soloCobertura ? null : resultado.estado,
    };
    if (conObs) salida.obs = obs;

    res.setHeader('Cache-Control', 'no-store');
    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(renderResumenMarkdown(salida));
    }
    return res.status(200).json(salida);
  } catch (err) {
    return res.status(500).json({ error: 'pm-centavos-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
