// ═══════════════════════════════════════════════════════════════════
// /api/earnings-beat-v2 — earnings-beat v2: "barra vs consenso vigente".
//
//   GET ?format=md                 mercados ABIERTOS hoy, por |desacuerdo| desc
//   GET ?resueltos=1&format=md     ya resueltos, con acierto_v2 y acierto_pm
//   GET ?validacion=1&format=md    el set congelado de 22 + veredicto pre-registrado
//   GET ?job=diario                (cron) recalcula pm_earnings_v2_features y,
//                                  con EARNINGS_V2_VIGENTE_ENABLED=1, captura el
//                                  consenso vigente de Alpha Vantage
//
// Las vistas son SOLO LECTURA y calculan en vivo desde las tablas fuente
// (pm_earnings_markets, pead_earnings, pm_known_gaps, pm_company_guidance,
// pm_v2_validation) más el consenso vigente ya capturado. El job es el único
// que escribe, y solo en pm_earnings_v2_features.
//
// Papel. Esto NO va a la tab EARNINGS hasta que haya veredicto
// (docs/earnings-beat-v2.md).
//
// ── Alpha Vantage ──────────────────────────────────────────────────
// El cupo diario (25) es compartido y hoy es del wheel (docs/wheel-fase0.md
// §4.3). Por eso la captura está APAGADA por default y, prendida, gasta como
// mucho AV_POR_CORRIDA llamadas y respeta el mismo guard pead_api_budget.
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opc) · ALPHAVANTAGE_API_KEY (opc) ·
//           EARNINGS_V2_VIGENTE_ENABLED (opc, '1' prende la captura)
// ═══════════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { beat } from './_lib/heartbeat.js';
import { normalizaMercado, indiceYes } from './_lib/earnings-beat.js';
import { fetchEarnings } from './_lib/av-earnings.js';
import { budgetUsed, budgetAdd, ensurePeadSchema } from './_lib/pead-db.js';
import {
  VALIDACION_V2, CORTE_VALIDACION, CRITERIOS_V2, UNIVERSO,
  leeMercado, filaV2, trimestreDelReporte, veredictoV2, acierto, renderMd, estimadoVigenteDeAv,
} from './_lib/earnings-beat-v2.js';
import { ensureSchemaV2, upsertFeatures, guardaVigente } from './_lib/earnings-beat-v2-db.js';

export const maxDuration = 300;
export { CONSULTAS };

const AV_TOPE_DIARIO = 25;
const AV_POR_CORRIDA = 5;
const AV_ESPACIO_MS = 11000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ─────────────────── carga ───────────────────

const SELECT_MERCADO = `select market_id, symbol, slug, question,
       to_char(coalesce(report_date, resolved_date), 'YYYY-MM-DD') as fecha,
       outcome, yes_price_t24h, yes_price_estado, consensus_pm, raw
  from pm_earnings_markets`;

// Todas las consultas en un solo lugar, para que tests/earnings-beat-v2.test.mjs
// las PREPARE contra un Postgres real (el SQL sin verificar es cómo el mapa
// llegó roto a producción). `n` = cuántos símbolos van en el IN.
const ph = (n, desde = 1) => Array.from({ length: n }, (_, i) => `$${i + desde}`).join(', ');
const CONSULTAS = {
  historial: (n) => `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date, reported_eps, estimated_eps
      from pead_earnings where symbol in (${ph(n)}) order by reported_date desc`,
  gaps: (n) => `select symbol, to_char(quarter_end, 'YYYY-MM-DD') as quarter_end, concepto, brecha_por_accion,
             afecta, tipo, fuente_url, verificada
      from pm_known_gaps where symbol in (${ph(n)})`,
  guias: (n) => `select symbol, to_char(quarter_end, 'YYYY-MM-DD') as quarter_end, metrica, alcance, guia_min, guia_max,
             ytd_reportado, trimestres_restantes, fuente_url, verificada
      from pm_company_guidance where symbol in (${ph(n)})`,
  vigentes: () => `select market_id, consenso_vigente from pm_earnings_v2_features where consenso_vigente is not null`,
  abiertos: () => `${SELECT_MERCADO}
     where abierto = true and coalesce(report_date, resolved_date) >= current_date
     order by coalesce(report_date, resolved_date) asc`,
  resueltos: () => `${SELECT_MERCADO}
     where outcome is not null
     order by coalesce(report_date, resolved_date) desc limit $1`,
  semillas: () => `select symbol, to_char(fecha_mercado, 'YYYY-MM-DD') as fecha, market_id,
            metrica_barra, barra, consenso_creacion, prob_pm_t24, outcome, actual_eps
       from pm_v2_validation`,
  validacion: (n) => `${SELECT_MERCADO}
     where symbol in (${ph(n)}) and coalesce(report_date, resolved_date) between '2026-10-19' and '2026-11-06'`, /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
};

// Fila de pm_earnings_markets → entrada de filaV2 (sin historial).
function mercadoDesdeFila(r, vigentes) {
  const norm = normalizaMercado(r.raw && typeof r.raw === 'object' ? r.raw : {}) || {};
  const m = { slug: r.slug || norm.slug, pregunta: r.question || norm.pregunta, descripcion: norm.descripcion };
  const lec = leeMercado(m);
  // prob PM: el precio VÁLIDO a T-24h (mismo candado que v1). Si todavía no
  // existe (mercado abierto), el último outcomePrices de Gamma, marcado.
  let prob_pm_t24 = r.yes_price_estado === 'valido' && r.yes_price_t24h !== null ? Number(r.yes_price_t24h) : null;
  let prob_pm_fuente = prob_pm_t24 !== null ? 't24h' : null;
  if (prob_pm_t24 === null && !r.outcome) {
    const iy = indiceYes(norm.outcomes);
    const p = iy === null ? null : norm.precios_outcome[iy];
    if (p !== null && p !== undefined) { prob_pm_t24 = p; prob_pm_fuente = 'gamma_ahora'; }
  }
  return {
    market_id: r.market_id, symbol: r.symbol, fecha: r.fecha,
    metrica_barra: lec.metrica_barra, barra: lec.barra,
    consenso_creacion: lec.consenso_creacion ?? (r.consensus_pm !== null ? Number(r.consensus_pm) : null),
    consenso_vigente: vigentes.get(r.market_id) ?? null,
    prob_pm_t24, prob_pm_fuente, outcome: r.outcome,
  };
}

async function contexto(mercados) {
  const simbolos = [...new Set(mercados.map((m) => m.symbol).filter(Boolean))];
  if (!simbolos.length) return { hist: new Map(), gaps: [], guias: [] };
  const [hist, gaps, guias] = await Promise.all([
    sql(CONSULTAS.historial(simbolos.length), simbolos),
    sql(CONSULTAS.gaps(simbolos.length), simbolos).catch(() => []),
    sql(CONSULTAS.guias(simbolos.length), simbolos).catch(() => []),
  ]);
  const porSim = new Map();
  for (const h of hist) {
    if (!porSim.has(h.symbol)) porSim.set(h.symbol, []);
    porSim.get(h.symbol).push(h);
  }
  return { hist: porSim, gaps, guias };
}

function construyeFilas(mercados, ctx) {
  return mercados.map((m) => {
    const q = trimestreDelReporte(m.fecha);
    const gaps = ctx.gaps.filter((g) => g.symbol === m.symbol && g.quarter_end === q);
    // La guía de la MISMA métrica que la barra, si la hay; si no, la que haya.
    const guias = ctx.guias.filter((g) => g.symbol === m.symbol && g.quarter_end === q);
    const guia = guias.find((g) => g.metrica === m.metrica_barra) || guias[0] || null;
    const f = filaV2({ mercado: m, historial: ctx.hist.get(m.symbol) || [], gaps, guia });
    return { ...f, prob_pm_fuente: m.prob_pm_fuente || null };
  });
}

async function vigentesGuardados() {
  const rows = await sql(CONSULTAS.vigentes()).catch(() => []);
  return new Map(rows.map((r) => [r.market_id, Number(r.consenso_vigente)]));
}

async function mercadosAbiertos(vigentes) {
  const rows = await sql(CONSULTAS.abiertos());
  return rows.map((r) => mercadoDesdeFila(r, vigentes));
}

async function mercadosResueltos(vigentes, limite) {
  const rows = await sql(CONSULTAS.resueltos(), [limite]);
  return rows.map((r) => mercadoDesdeFila(r, vigentes));
}

// Los 22. La semilla de pm_v2_validation manda en la resolución (no depende de
// que Polymarket los marque) y completa la barra de los que no están en
// pm_earnings_markets (fuera del universo v1). El market_id se busca por
// símbolo + fecha (± 1 día: Polymarket fecha el mercado por el día de la
// resolución y pead_earnings por el del reporte).
async function mercadosValidacion(vigentes) {
  const semillas = await sql(CONSULTAS.semillas()).catch(() => []);
  const porClave = new Map(semillas.map((s) => [`${s.symbol}|${s.fecha}`, s]));
  const simbolos = [...new Set(VALIDACION_V2.map((v) => v.symbol))];
  const pm = await sql(CONSULTAS.validacion(simbolos.length), simbolos);
  return VALIDACION_V2.map(({ symbol, fecha }) => {
    const s = porClave.get(`${symbol}|${fecha}`) || {};
    const r = (s.market_id && pm.find((x) => x.market_id === s.market_id))
      || pm.find((x) => x.symbol === symbol && Math.abs(Date.parse(x.fecha) - Date.parse(fecha)) <= 86400000);
    const base = r ? mercadoDesdeFila(r, vigentes) : { market_id: null, symbol, fecha, consenso_vigente: null, prob_pm_t24: null };
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    return {
      ...base,
      symbol, fecha,
      metrica_barra: base.metrica_barra || s.metrica_barra || null,
      barra: base.barra ?? num(s.barra),
      consenso_creacion: base.consenso_creacion ?? num(s.consenso_creacion),
      prob_pm_t24: base.prob_pm_fuente === 't24h' ? base.prob_pm_t24 : num(s.prob_pm_t24) ?? null,
      prob_pm_fuente: base.prob_pm_fuente === 't24h' ? 't24h' : s.prob_pm_t24 !== null && s.prob_pm_t24 !== undefined ? 'semilla' : null,
      outcome: s.outcome || base.outcome || null,
      actual_eps: num(s.actual_eps),
    };
  });
}

// ─────────────────── job diario ───────────────────

async function jobDiario() {
  await ensureSchemaV2();
  const vigentes = await vigentesGuardados();
  const abiertos = await mercadosAbiertos(vigentes);
  const valid = (await mercadosValidacion(vigentes)).filter((m) => m.market_id);
  const todos = [...new Map([...abiertos, ...valid].map((m) => [m.market_id, m])).values()];
  const filas = construyeFilas(todos, await contexto(todos));
  const escritas = await upsertFeatures(filas);

  const captura = { activa: process.env.EARNINGS_V2_VIGENTE_ENABLED === '1', intentos: [] };
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (captura.activa && !apiKey) captura.error = 'ALPHAVANTAGE_API_KEY no está';
  if (captura.activa && apiKey) {
    await ensurePeadSchema();
    const dia = new Date().toISOString().slice(0, 10);
    const libres = AV_TOPE_DIARIO - (await budgetUsed(dia));
    // Los más cercanos primero, solo en universo y con > 24h por delante.
    const manana = Date.now() + 24 * 3600 * 1000;
    const cola = filas
      .filter((f) => !f.fuera_universo && f.market_id && Date.parse(f.fecha + 'T00:00:00Z') > manana)
      .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
      .slice(0, Math.max(0, Math.min(AV_POR_CORRIDA, libres)));
    const porSimbolo = new Map();
    for (let i = 0; i < cola.length; i++) {
      const f = cola[i];
      let res = porSimbolo.get(f.symbol);
      if (!res) {
        if (porSimbolo.size) await sleep(AV_ESPACIO_MS);
        res = await fetchEarnings(f.symbol, apiKey);
        await budgetAdd(dia, 1);
        porSimbolo.set(f.symbol, res);
      }
      if (res.status !== 'ok') { captura.intentos.push({ symbol: f.symbol, estado: res.status }); continue; }
      const v = estimadoVigenteDeAv(res.events, f.quarter_end);
      if (v.valor === null) { captura.intentos.push({ symbol: f.symbol, estado: v.motivo }); continue; }
      const n = await guardaVigente(f.market_id, v.valor);
      captura.intentos.push({ symbol: f.symbol, estado: n ? 'capturado' : 'pasado_t24h', valor: v.valor });
    }
    captura.cupo_libre_antes = libres;
  }
  return { job: 'diario', features_escritas: escritas, abiertos: abiertos.length, validacion_con_market_id: valid.length, captura };
}

// ─────────────────── handler ───────────────────

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
  res.setHeader('Cache-Control', 'no-store');
  const esMd = ['md', 'markdown'].includes(String(q.format || '').toLowerCase());
  const md = (txt) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(txt); };

  try {
    if (String(q.job || '') === 'diario') {
      const out = await jobDiario();
      await beat('earnings-beat:v2', 'ok', { features: out.features_escritas, captura: out.captura.activa });
      return res.status(200).json(out);
    }

    const vigentes = await vigentesGuardados();

    if (String(q.validacion || '') === '1') {
      const mercados = await mercadosValidacion(vigentes);
      const filas = construyeFilas(mercados, await contexto(mercados));
      const veredicto = veredictoV2(filas);
      const salida = { vista: 'validacion', corte: CORTE_VALIDACION, criterios: CRITERIOS_V2, veredicto, filas };
      if (esMd) return md(renderMd({ titulo: `earnings-beat v2 — set de validación (corte ${CORTE_VALIDACION})`, filas, veredicto }));
      return res.status(200).json(salida);
    }

    if (String(q.resueltos || '') === '1') {
      const limite = Math.min(500, Math.max(1, Number(q.limite) || 200));
      const mercados = await mercadosResueltos(vigentes, limite);
      const filas = construyeFilas(mercados, await contexto(mercados))
        .map((f) => ({ ...f, acierto_v2: acierto(f.prob_v2, f.outcome), acierto_pm: acierto(f.prob_pm_t24, f.outcome) }));
      if (esMd) return md(renderMd({ titulo: 'earnings-beat v2 — resueltos', filas }));
      return res.status(200).json({ vista: 'resueltos', n: filas.length, filas });
    }

    const mercados = await mercadosAbiertos(vigentes);
    const filas = construyeFilas(mercados, await contexto(mercados))
      .sort((a, b) => Math.abs(b.desacuerdo ?? -1) - Math.abs(a.desacuerdo ?? -1));
    if (esMd) {
      return md(renderMd({
        titulo: `earnings-beat v2 — abiertos al ${new Date().toISOString().slice(0, 10)}`, filas,
        notas: ['prob PM: precio válido a T-24h si ya existe; si no, el último de Gamma (`prob_pm_fuente = gamma_ahora`).',
          `Fuera del universo de ${UNIVERSO.size}: no están en pm_earnings_markets, así que no aparecen acá.`],
      }));
    }
    return res.status(200).json({ vista: 'abiertos', n: filas.length, filas });
  } catch (err) {
    if (String(q.job || '') === 'diario') await beat('earnings-beat:v2', 'error', { error: String((err && err.message) || err).slice(0, 200) });
    return res.status(500).json({ error: 'earnings-beat-v2: ' + ((err && err.message) || 'unknown') });
  }
}
