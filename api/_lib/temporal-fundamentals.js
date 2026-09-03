// ═══════════════════════════════════════════════════════════════════
// api/_lib/temporal-fundamentals.js — la DIMENSIÓN TIEMPO de los
// fundamentales del Arena. JS puro, sin I/O, sin LLM.
//
// HALLAZGO T1 que motiva el módulo (2026-09-03): el PM ve FOTOS, no
// PELÍCULAS. Compró LULU el 4-ago como "value" con la foto que le daba el
// deep dive (P/E ~10, ROE 31%, cero deuda) y el 3-sep la empresa reportó
// revenue miss + guía recortada (−15% post-market). LULU venía
// DESACELERANDO varios trimestres — un dato que NUNCA viajó al prompt,
// porque `stock/metric` es un snapshot puntual: no trae serie histórica ni
// momentum de precio. El mismo día, el PM propuso rotar a ZM con
// exactamente la misma foto (P/E 8.64, ROE 32%, cero deuda).
//
// La respuesta NO es un parche al prompt ("acuérdate de mirar la
// tendencia"): es DATO. Este módulo deriva, de fuentes que ya usamos y que
// están en el tier gratis de Finnhub, tres cosas que el PM no tenía:
//
//   1. HISTORIAL DE EARNINGS (≤8 trimestres) → crecimiento de ingresos YoY
//      por trimestre + sorpresa de EPS por trimestre, con FECHA (mismo
//      patrón `relativeDayLabel` que ya usan los earnings del buffet), y
//      dos etiquetas derivadas: `revenue_trend` (accelerating / stable /
//      decelerating N trimestres seguidos) y `revisions` (up / neutral /
//      down).
//   2. MOMENTUM DE PRECIO → retorno 1m/3m/6m, distancia al máximo de 52
//      semanas y si el cierre está sobre la SMA200. DESCRIPTIVO: la SMA200
//      NO es breaker (acta dualmom — un gate de tendencia por nombre no se
//      valida con la evidencia que tenemos; ver docs/dualmom-backtest-scope.md).
//   3. FLAG `falling_knife` (cuchillo cayendo) → barato + cayendo +
//      deteriorándose, las tres a la vez. Es una ETIQUETA de datos que se
//      le MUESTRA al PM y se journalea; el rechazo duro lo aplica el guard
//      (`_lib/arena-guard.js`), no este módulo.
//
// VOCABULARIO: los identificadores van en inglés como todo el resto del
// código (`channels`, `origin`, `screener_qualifiers`); la prosa —razones
// del guard, docs— va en español. Correspondencia con los nombres del
// reglamento: tendencia_ingresos = `revenue_trend`, revisiones =
// `revisions`, cuchillo cayendo = `falling_knife`.
// ═══════════════════════════════════════════════════════════════════

import { relativeDayLabel } from './ai-guard.js';

// ── UMBRALES (constantes, congelables antes del día 0 de la liga) ────
// Todos viven aquí: el guard los importa, no los redefine. Cambiar un
// umbral es cambiar UN número en UN archivo, y el journal ya guarda las
// series crudas → un umbral nuevo se puede re-evaluar sobre lo journaleado
// sin re-crawlear nada.
export const TEMPORAL_RULES = {
  // ── tendencia de ingresos ──
  // Un trimestre "desacelera" si su YoY cae al menos esto (en PUNTOS
  // PORCENTUALES) contra el trimestre anterior. 1.0 pp filtra el ruido de
  // redondeo/mix sin filtrar una desaceleración real (LULU: 7-10 pp por
  // trimestre; ZM: ~1-3 pp sostenidos).
  trend_min_delta_pp: 1.0,
  // Trimestres consecutivos desacelerando que el GUARD exige para rechazar
  // una compra value. 1 solo trimestre es ruido; 2 seguidos ya es tendencia.
  decel_min_quarters: 2,
  // Máximo de trimestres que se derivan/journalean (el pedido: 8).
  max_quarters: 8,

  // ── revisiones ──
  // Cambio del consenso (fracción, −0.05 = −5%) que marca revisión al alza /
  // a la baja cuando la fuente es la REVISIÓN DE ESTIMADOS (mismo periodo
  // fiscal, ventana 30/90d).
  revision_estimate_down: -0.03,
  revision_estimate_up: 0.03,
  // Ventanas de comparación de estimados, en días (el pedido: 30/90).
  revision_window_days: [30, 90],
  // Tolerancia al buscar el snapshot de una ventana: un snapshot a 25-45
  // días cuenta como "30 días". Sin esto, un cron que corrió un día tarde
  // deja la ventana sin dato.
  revision_window_slack: 0.5,
  // Cambio del SCORE de recomendaciones (escala −2..+2) que marca la
  // dirección cuando la fuente es el rating de analistas (fallback día 0).
  revision_rating_down: -0.10,
  revision_rating_up: 0.10,

  // ── cuchillo cayendo ──
  // "Barato" = P/E en el tercil más barato del universo del screener.
  falling_knife_pe_percentile: 33,
  // Fallback cuando el universo no tiene distribución de P/E utilizable
  // (tabla vacía/rancia): P/E absoluto por debajo de esto cuenta como barato.
  falling_knife_pe_absolute: 15,
  // "Cayendo" = retorno 3m o 6m por debajo de estos umbrales (fracciones).
  falling_knife_ret_3m: -0.10,
  falling_knife_ret_6m: -0.15,
};

// Ventanas de retorno en SESIONES de bolsa (no días de calendario: la serie
// es de cierres diarios, ~21 sesiones por mes).
const LOOKBACK_SESSIONS = { ret_1m: 21, ret_3m: 63, ret_6m: 126 };
const SESSIONS_52W = 252;
const SMA_LONG = 200;
// Mínimo de sesiones para que la "distancia al máximo de 52 semanas" tenga
// sentido: con 20 velas el máximo no es un máximo anual, es ruido.
const MIN_SESSIONS_52W = 60;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const round4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Etiqueta de trimestre fiscal legible ("FY2026 Q2"). Se construye siempre
// desde los datos — nunca un literal (lint anti "relojes rotos").
export function quarterLabel(year, quarter) {
  if (!year || !quarter) return null;
  return `FY${year} Q${quarter}`;
}

// ─────────────────────────────────────────────────────────────────────
// 1. HISTORIAL DE EARNINGS
// ─────────────────────────────────────────────────────────────────────

// Conceptos XBRL de la línea de INGRESOS, por prioridad. La búsqueda laxa
// (`includes('revenue')`) se come `CostOfRevenue` y `DeferredRevenue`, que
// no son la top-line: la lista explícita va primero y el fallback excluye
// los conceptos que sabemos que NO son ingresos del periodo.
const REVENUE_CONCEPTS = [
  'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax',
  'us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax',
  'us-gaap_Revenues',
  'us-gaap_SalesRevenueNet',
  'us-gaap_SalesRevenueGoodsNet',
  'us-gaap_RevenuesNetOfInterestExpense',
];
const REVENUE_EXCLUDE = /(cost|deferred|unearned|remaining|percentage|expense|deprecia|unbilled|contractwithcustomerliability)/i;

// Un reporte de `financials-reported` → su línea de ingresos (o null).
function revenueOfReport(report) {
  const ic = (report && report.report && report.report.ic) || [];
  const byConcept = new Map();
  for (const item of ic) {
    if (!item || typeof item.concept !== 'string') continue;
    const v = num(item.value);
    if (v == null || v <= 0) continue;
    if (!byConcept.has(item.concept)) byConcept.set(item.concept, v);
  }
  for (const c of REVENUE_CONCEPTS) if (byConcept.has(c)) return byConcept.get(c);
  // Fallback: cualquier concepto revenue/sales que no esté en la lista negra.
  // Se toma el MAYOR: la top-line domina a los desgloses por segmento.
  let best = null;
  for (const [concept, v] of byConcept) {
    if (!/revenue|sales/i.test(concept) || REVENUE_EXCLUDE.test(concept)) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

// `stock/financials-reported?freq=quarterly` → ingresos por trimestre fiscal
// con su YoY (mismo trimestre del año anterior). Devuelve los ≤max más
// recientes primero. Sin comparable YoY → `yoy_pct: null` (no se inventa).
export function parseRevenueHistory(finResp, { maxQuarters = TEMPORAL_RULES.max_quarters } = {}) {
  const reports = (finResp && Array.isArray(finResp.data) ? finResp.data : []);
  const byKey = new Map(); // "year-Qn" → { revenue, end_date, filed }
  for (const r of reports) {
    const year = num(r && r.year);
    const quarter = num(r && r.quarter);
    if (!year || !quarter || quarter < 1 || quarter > 4) continue; // quarter 0 = anual
    const key = `${year}-Q${quarter}`;
    if (byKey.has(key)) continue; // el feed llega desc: el primero es el más nuevo
    const revenue = revenueOfReport(r);
    if (revenue == null) continue;
    byKey.set(key, {
      revenue,
      end_date: isDate(r.endDate) ? r.endDate : null,
      filed: isDate(r.filedDate) ? r.filedDate : null,
    });
  }
  const rows = [...byKey.entries()]
    .map(([key, v]) => {
      const [y, q] = key.split('-Q');
      return { year: +y, quarter: +q, ...v };
    })
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter);

  return rows.slice(0, maxQuarters).map((r) => {
    const prev = byKey.get(`${r.year - 1}-Q${r.quarter}`);
    const yoy = prev && prev.revenue > 0 ? ((r.revenue - prev.revenue) / prev.revenue) * 100 : null;
    return {
      year: r.year, quarter: r.quarter, label: quarterLabel(r.year, r.quarter),
      period_end: r.end_date, filed: r.filed,
      revenue: r.revenue,
      yoy_pct: round1(yoy),
    };
  });
}

// `stock/earnings` → sorpresa de EPS por trimestre (≤max, más reciente
// primero). Finnhub ya trae `surprisePercent`; se recomputa igual que el
// resto del proyecto ((actual − est)/|est|) cuando falta.
export function parseEpsSurprises(earningsResp, { maxQuarters = TEMPORAL_RULES.max_quarters } = {}) {
  const list = Array.isArray(earningsResp) ? earningsResp : [];
  return list
    .map((q) => {
      const actual = num(q && q.actual);
      const estimate = num(q && q.estimate);
      let pct = num(q && q.surprisePercent);
      if (pct == null && actual != null && estimate != null && estimate !== 0) {
        pct = ((actual - estimate) / Math.abs(estimate)) * 100;
      }
      return {
        year: num(q && q.year), quarter: num(q && q.quarter),
        label: quarterLabel(num(q && q.year), num(q && q.quarter)),
        period: isDate(q && q.period) ? q.period : null,
        eps_actual: actual, eps_estimate: estimate,
        surprise_pct: round1(pct),
      };
    })
    .filter((q) => q.year && q.quarter)
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
    .slice(0, maxQuarters);
}

// ── etiqueta `revenue_trend` ────────────────────────────────────────
// Cuenta trimestres CONSECUTIVOS (desde el más reciente hacia atrás) cuyo
// YoY cayó/subió al menos `trend_min_delta_pp` contra el trimestre previo.
// Devuelve { label, consecutive_quarters, deltas_pp }.
//   'decelerating' → ≥1 trimestre consecutivo a la baja
//   'accelerating' → ≥1 a la alza
//   'stable'       → el último cambio cabe dentro de la tolerancia
//   'no_data'      → menos de 2 trimestres con YoY
export function revenueTrendLabel(revHistory, rules = TEMPORAL_RULES) {
  const withYoy = (revHistory || []).filter((q) => q && q.yoy_pct != null);
  if (withYoy.length < 2) {
    return { label: 'no_data', consecutive_quarters: 0, deltas_pp: [], quarters_with_yoy: withYoy.length };
  }
  const tol = rules.trend_min_delta_pp;
  const deltas = [];
  for (let i = 0; i < withYoy.length - 1; i++) {
    deltas.push(round1(withYoy[i].yoy_pct - withYoy[i + 1].yoy_pct));
  }
  const dir = deltas[0] <= -tol ? 'decelerating' : deltas[0] >= tol ? 'accelerating' : 'stable';
  if (dir === 'stable') return { label: 'stable', consecutive_quarters: 0, deltas_pp: deltas, quarters_with_yoy: withYoy.length };
  let run = 0;
  for (const d of deltas) {
    if (dir === 'decelerating' ? d <= -tol : d >= tol) run++;
    else break;
  }
  return { label: dir, consecutive_quarters: run, deltas_pp: deltas, quarters_with_yoy: withYoy.length };
}

// ─────────────────────────────────────────────────────────────────────
// 2. REVISIONES (dos fuentes, en orden de preferencia)
// ─────────────────────────────────────────────────────────────────────
//
// LÍMITE CONOCIDO DEL TIER GRATIS: Finnhub NO expone la GUÍA de la empresa
// (guidance) ni sus endpoints de revisión de estimados (`stock/revenue-estimate`,
// `stock/eps-estimate` son Premium — misma política que `stock/price-target`,
// que tampoco llamamos). Así que:
//
//   (a) FUENTE PRIMARIA — revisión REAL de estimados, construida por
//       NOSOTROS: el cron del screener guarda, en cada refresh, el estimado
//       de consenso del PRÓXIMO reporte (`calendar/earnings`, gratis) con su
//       periodo fiscal. Comparar el estimado de hoy contra el snapshot de
//       hace 30/90 días DEL MISMO PERIODO FISCAL es una revisión de
//       estimados de verdad. Empieza vacía y se vuelve utilizable a los ~30
//       días de acumulación (ver docs/arena.md → "reglamento v2").
//   (b) FALLBACK DÍA 0 — tendencia del RATING de analistas
//       (`stock/recommendation`, gratis, ya lo trae el deep dive): score
//       neto (−2..+2) de hoy contra el de hace 30/90 días. NO es una
//       revisión de estimados; es un proxy, y viaja etiquetado como tal
//       (`source`) para que nadie lo lea como otra cosa.

// Reparto de recomendaciones → score neto en [−2, +2].
export function recommendationScore(r) {
  if (!r) return null;
  const sb = num(r.strongBuy) || 0, b = num(r.buy) || 0, h = num(r.hold) || 0;
  const s = num(r.sell) || 0, ss = num(r.strongSell) || 0;
  const total = sb + b + h + s + ss;
  if (total <= 0) return null;
  return round2((2 * sb + b - s - 2 * ss) / total);
}

// Elige, de una lista ordenada desc por fecha, la entrada más cercana a
// `targetDays` antes de la de referencia (con la tolerancia de la ventana).
function pickWindow(entries, refTime, targetDays, slack) {
  let best = null;
  for (const e of entries) {
    const age = (refTime - e.time) / 86400000;
    if (age <= 0) continue;
    if (age < targetDays * (1 - slack) || age > targetDays * (1 + slack)) continue;
    const dist = Math.abs(age - targetDays);
    if (!best || dist < best.dist) best = { ...e, dist, age_days: Math.round(age) };
  }
  return best;
}

// `stock/recommendation` (array de periodos mensuales) → tendencia del rating.
export function recommendationTrend(recResp, { now = new Date(), rules = TEMPORAL_RULES } = {}) {
  const entries = (Array.isArray(recResp) ? recResp : [])
    .map((r) => ({ period: r && r.period, score: recommendationScore(r), time: Date.parse(r && r.period) }))
    .filter((e) => isDate(e.period) && e.score != null && Number.isFinite(e.time))
    .sort((a, b) => b.time - a.time);
  if (!entries.length) return null;
  const ref = entries[0];
  const out = { period_now: ref.period, score_now: ref.score };
  for (const days of rules.revision_window_days) {
    const w = pickWindow(entries.slice(1), ref.time, days, rules.revision_window_slack);
    out[`score_${days}d`] = w ? w.score : null;
    out[`period_${days}d`] = w ? w.period : null;
    out[`delta_${days}d`] = w ? round2(ref.score - w.score) : null;
  }
  return out;
}

// Historial de estimados acumulado por nosotros → revisión real.
// `history`: [{ date, period, eps, revenue }] (más reciente primero o no,
// se ordena aquí). `period` = el trimestre fiscal al que apunta el estimado:
// solo se comparan snapshots del MISMO periodo (comparar el estimado del
// Q3 contra el del Q2 no es una revisión, es otro número).
export function estimateRevisions(history, { now = new Date(), rules = TEMPORAL_RULES } = {}) {
  const entries = (Array.isArray(history) ? history : [])
    .map((h) => ({ ...h, time: Date.parse(h && h.date) }))
    .filter((h) => isDate(h.date) && Number.isFinite(h.time) && (num(h.eps) != null || num(h.revenue) != null))
    .sort((a, b) => b.time - a.time);
  if (!entries.length) return null;
  const ref = entries[0];
  const sameTarget = entries.slice(1).filter((e) => String(e.period || '') === String(ref.period || ''));
  const out = { period_target: ref.period || null, as_of: ref.date, eps_now: num(ref.eps), revenue_now: num(ref.revenue) };
  let any = false;
  for (const days of rules.revision_window_days) {
    const w = pickWindow(sameTarget, ref.time, days, rules.revision_window_slack);
    const epsPrev = w ? num(w.eps) : null;
    const revPrev = w ? num(w.revenue) : null;
    const epsChg = epsPrev != null && epsPrev > 0 && num(ref.eps) != null ? (num(ref.eps) - epsPrev) / epsPrev : null;
    const revChg = revPrev != null && revPrev > 0 && num(ref.revenue) != null ? (num(ref.revenue) - revPrev) / revPrev : null;
    out[`eps_change_${days}d`] = round4(epsChg);
    out[`revenue_change_${days}d`] = round4(revChg);
    if (epsChg != null || revChg != null) any = true;
  }
  return any ? out : null;
}

// Etiqueta `revisions` — up / neutral / down / no_data, con su FUENTE.
// Preferencia: revisión de estimados (real) > tendencia de rating (proxy).
// Dentro de cada fuente, preferencia por la ventana LARGA (90d): una
// revisión sostenida pesa más que el ruido de un mes.
export function revisionsLabel({ estimates = null, rating = null } = {}, rules = TEMPORAL_RULES) {
  const pick = (long, short) => (long != null ? long : short);

  if (estimates) {
    // El estimado de EPS manda; el de ingresos desempata cuando no hay EPS.
    const chg = pick(
      estimates.eps_change_90d != null ? estimates.eps_change_90d : estimates.revenue_change_90d,
      estimates.eps_change_30d != null ? estimates.eps_change_30d : estimates.revenue_change_30d,
    );
    if (chg != null) {
      const label = chg <= rules.revision_estimate_down ? 'down' : chg >= rules.revision_estimate_up ? 'up' : 'neutral';
      return { label, source: 'estimate_revision', change: chg, detail: estimates };
    }
  }
  if (rating) {
    const delta = pick(rating.delta_90d, rating.delta_30d);
    if (delta != null) {
      const label = delta <= rules.revision_rating_down ? 'down' : delta >= rules.revision_rating_up ? 'up' : 'neutral';
      return { label, source: 'analyst_rating_trend', change: delta, detail: rating };
    }
  }
  return { label: 'no_data', source: null, change: null, detail: null };
}

// ─────────────────────────────────────────────────────────────────────
// 3. MOMENTUM DE PRECIO (descriptivo — la SMA200 NO es breaker)
// ─────────────────────────────────────────────────────────────────────
// `series`: { dates:[], closes:[] } YA recortada a velas COMPLETAS
// (completedSlice) — la misma serie de Yahoo con la que el guard valida la
// banda ±2%, así el momentum y el precio de referencia no se desfasan.
export function priceMomentum(series) {
  const closes = series && Array.isArray(series.closes) ? series.closes : [];
  const dates = series && Array.isArray(series.dates) ? series.dates : [];
  if (!closes.length) return null;
  const last = closes[closes.length - 1];
  if (!(last > 0)) return null;

  const ret = (sessions) => {
    const i = closes.length - 1 - sessions;
    if (i < 0) return null;
    const base = closes[i];
    return base > 0 ? round4(last / base - 1) : null;
  };
  const window52 = closes.slice(-SESSIONS_52W);
  const high52 = window52.length >= MIN_SESSIONS_52W ? Math.max(...window52) : null;
  const smaWindow = closes.slice(-SMA_LONG);
  const sma200 = smaWindow.length >= SMA_LONG ? smaWindow.reduce((a, b) => a + b, 0) / SMA_LONG : null;

  return {
    ret_1m: ret(LOOKBACK_SESSIONS.ret_1m),
    ret_3m: ret(LOOKBACK_SESSIONS.ret_3m),
    ret_6m: ret(LOOKBACK_SESSIONS.ret_6m),
    // Negativo = por debajo del máximo. null si no hay ~3 meses de historia.
    dist_52w_high_pct: high52 && high52 > 0 ? round1((last / high52 - 1) * 100) : null,
    // DESCRIPTIVO: nunca gatilla un rechazo (acta dualmom). null = sin 200 velas.
    above_sma200: sma200 != null ? last > sma200 : null,
    sessions: closes.length,
    as_of: dates.length ? dates[dates.length - 1] : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. CUCHILLO CAYENDO
// ─────────────────────────────────────────────────────────────────────

// Percentil del P/E dentro del universo (0 = el más barato). `universePes`
// son los P/E positivos del screener; sin distribución utilizable devuelve null
// y el flag cae al umbral absoluto.
export function pePercentile(pe, universePes) {
  const pes = (universePes || []).map(num).filter((v) => v != null && v > 0);
  const p = num(pe);
  if (p == null || p <= 0 || pes.length < 20) return null;
  const below = pes.filter((v) => v < p).length;
  return round1((below / pes.length) * 100);
}

// Barato + cayendo + deteriorándose = cuchillo cayendo. Las TRES a la vez:
// una acción barata que sube no es un cuchillo, y una que cae con ingresos
// acelerando es (posiblemente) una oportunidad. Devuelve el flag y las
// razones EN TEXTO — es lo que se le muestra al PM y lo que se journalea.
export function fallingKnife({ peTtm, peRank, momentum, trend, revisions }, rules = TEMPORAL_RULES) {
  const pe = num(peTtm);
  const rank = num(peRank);
  const cheap = pe != null && pe > 0 && (rank != null
    ? rank <= rules.falling_knife_pe_percentile
    : pe < rules.falling_knife_pe_absolute);

  const r3 = momentum ? num(momentum.ret_3m) : null;
  const r6 = momentum ? num(momentum.ret_6m) : null;
  const falling = (r3 != null && r3 <= rules.falling_knife_ret_3m)
    || (r6 != null && r6 <= rules.falling_knife_ret_6m);

  const decel = !!(trend && trend.label === 'decelerating');
  const revDown = !!(revisions && revisions.label === 'down');
  const deteriorating = decel || revDown;

  const flag = cheap && falling && deteriorating;
  if (!flag) {
    return { flag: false, reasons: [], checks: { cheap, falling, deteriorating } };
  }
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const reasons = [];
  reasons.push(rank != null
    ? `barata: P/E ${pe} (percentil ${rank} del universo, umbral ≤${rules.falling_knife_pe_percentile})`
    : `barata: P/E ${pe} (< ${rules.falling_knife_pe_absolute}, sin distribución del universo)`);
  const legs = [];
  if (r3 != null && r3 <= rules.falling_knife_ret_3m) legs.push(`3m ${pct(r3)}`);
  if (r6 != null && r6 <= rules.falling_knife_ret_6m) legs.push(`6m ${pct(r6)}`);
  reasons.push(`cayendo: retorno ${legs.join(' / ')}`);
  if (decel) reasons.push(`ingresos desacelerando ${trend.consecutive_quarters} trimestre(s) seguido(s)`);
  if (revDown) reasons.push(`revisiones a la baja (${revisions.source})`);
  return { flag: true, reasons, checks: { cheap, falling, deteriorating } };
}

// ─────────────────────────────────────────────────────────────────────
// 5. ENSAMBLE
// ─────────────────────────────────────────────────────────────────────

// Todo junto: series crudas → etiquetas + flag. Sin I/O; el caller (el cron
// del screener o el deep dive del run) trae los insumos ya bajados.
export function deriveTemporal({
  revenueHistory = [], epsSurprises = [], recTrend = null, estimateHistory = null,
  momentum = null, peTtm = null, universePes = null, peRank = null,
  now = new Date(), rules = TEMPORAL_RULES,
} = {}) {
  const trend = revenueTrendLabel(revenueHistory, rules);
  const estimates = estimateRevisions(estimateHistory, { now, rules });
  const revisions = revisionsLabel({ estimates, rating: recTrend }, rules);
  const rank = peRank != null ? peRank : pePercentile(peTtm, universePes);
  const knife = fallingKnife({ peTtm, peRank: rank, momentum, trend, revisions }, rules);

  const latest = revenueHistory && revenueHistory.length ? revenueHistory[0] : null;
  return {
    revenue_trend: {
      label: trend.label,
      consecutive_quarters: trend.consecutive_quarters,
      deltas_pp: trend.deltas_pp,
      quarters_with_yoy: trend.quarters_with_yoy,
    },
    revenue_yoy_history: revenueHistory || [],
    eps_surprise_history: epsSurprises || [],
    revisions,
    // Finnhub free NO expone la guía de la empresa: se declara ausente en vez
    // de dejar que el PM la rellene de memoria.
    guidance: { direction: null, available: false, note: 'Finnhub free tier no expone guidance' },
    momentum: momentum || null,
    pe_ttm: num(peTtm),
    pe_percentile: rank,
    falling_knife: knife,
    as_of: {
      fundamentals: latest ? (latest.filed || latest.period_end || null) : null,
      momentum: momentum ? momentum.as_of || null : null,
    },
  };
}

// Re-ancla un temporal YA derivado a un momentum MÁS FRESCO. Las etiquetas de
// negocio (tendencia de ingresos, revisiones) cambian por trimestre y valen lo
// que valen precomputadas; el PRECIO cambia todos los días, y en la corrida ya
// tenemos la serie de Yahoo del día. El flag de cuchillo cayendo se recalcula
// con el momentum nuevo — si no, un nombre que rebotó seguiría marcado.
export function withMomentum(t, momentum, rules = TEMPORAL_RULES) {
  if (!t) return null;
  if (!momentum) return t;
  const knife = fallingKnife({
    peTtm: t.pe_ttm, peRank: t.pe_percentile, momentum,
    trend: t.revenue_trend, revisions: t.revisions,
  }, rules);
  return {
    ...t, momentum, falling_knife: knife,
    as_of: { ...(t.as_of || {}), momentum: momentum.as_of || null },
  };
}

// ── vista para el PROMPT: compacta y con los números YA FORMATEADOS ──
// Misma medicina que `pnl_since_entry_pct` del libro: el PM recibía
// fracciones peladas y las re-escalaba mal en la prosa. Aquí los retornos
// salen con signo y % ("−18.0%"), los trimestres con su FECHA relativa ya
// calculada (mismo patrón `relativeDayLabel` que los earnings del buffet), y
// las etiquetas como texto. Nada de aritmética delegada al modelo.
export function temporalForPrompt(t, now = new Date(), { maxQuarters = 4 } = {}) {
  if (!t) return null;
  const pct = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  const pp = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
  const m = t.momentum || null;
  const trend = t.revenue_trend || {};
  const trendText = trend.label === 'decelerating'
    ? `decelerating (${trend.consecutive_quarters} consecutive quarter(s))`
    : trend.label === 'accelerating'
      ? `accelerating (${trend.consecutive_quarters} consecutive quarter(s))`
      : trend.label;

  return {
    revenue_trend: trendText,
    revenue_yoy_by_quarter: (t.revenue_yoy_history || []).slice(0, maxQuarters).map((q) => ({
      quarter: q.label,
      yoy: pp(q.yoy_pct),
      reported: q.filed ? relativeDayLabel(q.filed, now) : null,
    })),
    eps_surprise_by_quarter: (t.eps_surprise_history || []).slice(0, maxQuarters).map((q) => ({
      quarter: q.label, surprise: pp(q.surprise_pct),
    })),
    estimate_revisions: t.revisions ? t.revisions.label : 'no_data',
    estimate_revisions_source: t.revisions ? t.revisions.source : null,
    guidance_direction: t.guidance ? t.guidance.direction : null,
    price_momentum: m ? {
      return_1m: pct(m.ret_1m), return_3m: pct(m.ret_3m), return_6m: pct(m.ret_6m),
      vs_52w_high: m.dist_52w_high_pct == null ? null : `${m.dist_52w_high_pct.toFixed(1)}%`,
      above_sma200: m.above_sma200,
      as_of: m.as_of || null,
    } : null,
    falling_knife: !!(t.falling_knife && t.falling_knife.flag),
    falling_knife_why: t.falling_knife && t.falling_knife.flag ? t.falling_knife.reasons.join(' + ') : null,
    fundamentals_as_of: t.as_of ? t.as_of.fundamentals : null,
  };
}

// Versión TITULAR (para el SCAN y para las posiciones del libro): las
// etiquetas y los retornos, sin las series por trimestre. El SCAN hace TRIAGE
// sobre decenas de tickers — ahí el detalle por trimestre solo gasta tokens;
// la serie completa viaja en el DIVE, donde se decide.
export function temporalHeadline(t) {
  if (!t) return null;
  const pct = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  const m = t.momentum || null;
  const trend = t.revenue_trend || {};
  const out = {
    revenue_trend: trend.label === 'decelerating' || trend.label === 'accelerating'
      ? `${trend.label} (${trend.consecutive_quarters}q)`
      : trend.label,
    estimate_revisions: t.revisions ? t.revisions.label : 'no_data',
    // El 1m es el que contesta "¿esta posición lleva un mes cayendo?" — la
    // pregunta exacta del punto 9 del reglamento T2.
    return_1m: m ? pct(m.ret_1m) : null,
    return_3m: m ? pct(m.ret_3m) : null,
    return_6m: m ? pct(m.ret_6m) : null,
    vs_52w_high: m && m.dist_52w_high_pct != null ? `${m.dist_52w_high_pct.toFixed(1)}%` : null,
    above_sma200: m ? m.above_sma200 : null,
    as_of: (t.as_of && (t.as_of.momentum || t.as_of.fundamentals)) || null,
  };
  if (t.falling_knife && t.falling_knife.flag) out.falling_knife = true;
  return out;
}

// ── ¿la tesis de esta compra es "value"? ─────────────────────────────
// Dos señales, la determinista primero:
//   (1) el candidato salió de la screen VALUE (dato del canal, no del LLM);
//   (2) el `reasoning` de la acción usa lenguaje de valoración.
// (2) sobre-dispara a propósito ("shareholder value" cuenta): solo importa
// cuando la señal temporal YA está en rojo, que es justo el caso donde
// preferimos rechazar de más. El PM siempre puede re-proponer la compra sin
// tesis de valuación... y ahí el flag de cuchillo cayendo la vuelve a atrapar.
const VALUE_THESIS_RE = /\b(value|valuation|undervalued|under-?valued|cheap(er)?|bargain|discounted|deep value|mispriced|multiple|p\/?e\b|margin of safety|barat[oa]s?|infravalorad[oa]s?|descuento|múltiplo|valuación)\b/i;

export function isValueThesis(action, meta = {}) {
  const screens = (meta && Array.isArray(meta.screens)) ? meta.screens : [];
  if (screens.includes('value')) return { value: true, why: 'screen value' };
  const text = action && typeof action.reasoning === 'string' ? action.reasoning : '';
  if (VALUE_THESIS_RE.test(text)) return { value: true, why: 'lenguaje de valuación en el reasoning' };
  return { value: false, why: null };
}
