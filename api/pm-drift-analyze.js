// ═══════════════════════════════════════════════════════════════════
// /api/pm-drift-analyze — "PM-DRIFT", backtest pre-registrado.
//
// ¿Δ = p(T-24h) − p(T-72h) del "Yes" de Polymarket agrega información SOBRE
// p(T-24h) para predecir el beat? Criterios CONGELADOS en
// _lib/pm-drift-analyze.js (CRITERIOS_PM_DRIFT). Ver docs/pm-drift-scope.md.
//
//   GET /api/pm-drift-analyze?solo=cobertura&format=md  → paso 1: baja lo que
//        falte del CLOB (dentro del presupuesto) y dice cuántos mercados
//        tienen los 3 precios, cuántos faltan y por qué. Sin veredicto.
//   GET /api/pm-drift-analyze?format=md                 → resultado completo
//   GET /api/pm-drift-analyze                           → JSON
//   &obs=1      → detalle mercado a mercado
//   &bajar=0    → no toca el CLOB: solo lo que ya está en pm_price_hist
//
// ── Lo que escribe ─────────────────────────────────────────────────
// SOLO pm_price_hist y pm_price_hist_fetch (tablas nuevas). Sobre
// pm_earnings_markets, pm_earnings_markets_v2 y pead_event_hour: un SELECT.
// Un historial ya bajado ('ok', aunque venga vacío) no se vuelve a pedir;
// un error sí se reintenta en la próxima corrida. Un 429 corta la corrida.
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
  CRITERIOS_PM_DRIFT, SCHEMA, SQL_UNIVERSO, SQL_ESTADOS, sqlPuntos, sqlInsertPuntos, sqlRegistraDescarga,
  construyeUniverso, normalizaPuntos, corre, bajaHistoriales, renderResumenMarkdown,
} from './_lib/pm-drift-analyze.js';

export const maxDuration = 300;

const PRESUPUESTO_DESCARGA_MS = 200000;
const LOTE_PUNTOS = 100;     // market_ids por SELECT de pm_price_hist
const LOTE_INSERT = 400;     // puntos por INSERT (3 params c/u)

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
    await sqlBatch(SCHEMA.map((s) => [s, []]));

    // ── 1. Universo: v2 ∪ v1 + hora del reporte. UN SELECT. ──
    const filas = await sql(SQL_UNIVERSO);
    const u = construyeUniverso(filas);

    // ── 2. Lo que ya se bajó; lo que falta se pide al CLOB. ──
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
      // En cobertura no hay veredicto: solo se dice si la frontera falló o falta bajar.
      if (!['FALLA DE FRONTERA', 'COBERTURA INCOMPLETA'].includes(resultado.estado)) {
        resultado.estado = 'COBERTURA LISTA';
        resultado.motivo = 'todos los historiales bajados; abre el link sin ?solo=cobertura para el resultado';
      }
    }

    const salida = {
      pregunta: '¿El movimiento del precio del Yes de Polymarket antes del reporte (Δ = p24 − p72) agrega información sobre p24 para predecir el beat?',
      generado_en: new Date().toISOString(),
      solo_cobertura: soloCobertura,
      criterios: CRITERIOS_PM_DRIFT,
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
    return res.status(500).json({ error: 'pm-drift-analyze: ' + ((err && err.message) || 'unknown') });
  }
}
