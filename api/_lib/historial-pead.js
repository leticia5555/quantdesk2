// ═══════════════════════════════════════════════════════════════════
// api/_lib/historial-pead.js — UNA sola fuente de verdad para los beats de la
// tab EARNINGS.
//
// ── POR QUÉ EXISTE (NFLX, 2026-10-20) ──────────────────────────────────
// En la misma pantalla la tarjeta de Polymarket decía "superó 15 de 20" y el
// panel EPS HISTORY decía "0/4 beats, avg −7.1%". Las dos cosas eran ciertas
// sobre fuentes distintas, y ninguna de las dos lo decía:
//
//   · La tarjeta lee `pead_earnings` (Alpha Vantage, con fecha de REPORTE).
//   · El panel leía Finnhub `/stock/earnings`, cuyo `period` es el CIERRE del
//     trimestre fiscal (2026-06-30), no el día del reporte (2026-07-16). La
//     "reacción post-earnings" se medía del 30 al 1 de julio: un día cualquiera
//     de la vida de la acción. De ahí el "±2.5% avg" contra ~7% real.
//   · El revenue venía de `/stock/financials-reported`, que para un 10-Q trae
//     el acumulado del AÑO FISCAL (6 o 9 meses), no el trimestre: Q2 2026 =
//     $24.81B es el primer semestre; Q3 2025 = $33.13B es la suma exacta de
//     los tres trimestres de 2025 (10.54 + 11.08 + 11.51). Además el concepto
//     se elegía con `includes('revenue')`, que también agarra CostOfRevenue.
//
// Lo que hace este módulo:
//   1. `leeHistoricoPead` — el SELECT que usan la tarjeta Y el panel. Si algún
//      día cambia, cambia para los dos.
//   2. El panel calcula sus beats con `estadisticasHistoricas`, la MISMA
//      función que la tarjeta. Mismo dato, misma ventana, mismo número.
//   3. Reacción al precio desde la FECHA DE REPORTE (con hora BMO/AMC).
//   4. Revenue trimestral real: el del calendario de Finnhub (3 meses) o el
//      de financials-reported DESACUMULADO por su `startDate`; nunca el YTD.
//   5. `evaluaConsistencia` — lo que el veredicto de IA consulta antes de
//      opinar. Datos que se contradicen → no hay veredicto (fail-closed).
//
// Finnhub queda como RESPALDO, etiquetado, para símbolos que no están en Neon.
// ═══════════════════════════════════════════════════════════════════

import { sql as sqlNeon } from './db.js';
import { estadisticasHistoricas, sorpresaPct } from './earnings-beat.js';

export const FUENTE_PEAD = 'pead_earnings';
export const FUENTE_FINNHUB = 'finnhub';

const isoDe = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const dias = (a, b) => (Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;
const n = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// ── 1. EL SELECT COMPARTIDO ────────────────────────────────────────────
// La tarjeta (api/earnings-beat.js → vistaLive) y el panel (api/earnings.js)
// leen exactamente esto. `fiscal_date_ending` sobra para la tarjeta y no le
// estorba; es lo que el panel usa para rotular el trimestre.
export async function leeHistoricoPead(simbolos, { sql = sqlNeon } = {}) {
  const lista = [...new Set((simbolos || []).map((s) => String(s).toUpperCase()))];
  const porSimbolo = new Map();
  if (!lista.length) return porSimbolo;
  const ph = lista.map((_, i) => `$${i + 1}`).join(', ');
  const filas = await sql(
    `select symbol, to_char(reported_date, 'YYYY-MM-DD') as reported_date,
            to_char(fiscal_date_ending, 'YYYY-MM-DD') as fiscal_date_ending,
            reported_eps, estimated_eps, surprise_pct
       from pead_earnings
      where symbol in (${ph})
      order by reported_date desc`,
    lista
  );
  for (const f of filas || []) {
    if (!porSimbolo.has(f.symbol)) porSimbolo.set(f.symbol, []);
    porSimbolo.get(f.symbol).push(f);
  }
  return porSimbolo;
}

// La hora del anuncio vive en otra tabla y en otro job (SEC 8-K). Va aparte a
// propósito: si esa tabla faltara, el SELECT de arriba —el de la tarjeta— no
// tiene por qué caerse con ella.
export async function leeHorasPead(simbolo, { sql = sqlNeon } = {}) {
  const filas = await sql(
    `select to_char(reported_date, 'YYYY-MM-DD') as reported_date, hour
       from pead_event_hour where symbol = $1`,
    [String(simbolo).toUpperCase()]
  );
  const m = new Map();
  for (const f of filas || []) if (f.reported_date) m.set(f.reported_date, f.hour || null);
  return m;
}

// ── 3. REACCIÓN DESDE LA FECHA DE REPORTE ──────────────────────────────
// precios: [{date:'YYYY-MM-DD', close}] ascendente.
//   bmo  → cierre previo al reporte → cierre del día del reporte
//   amc  → cierre del día del reporte → cierre siguiente
//   otro → cierre previo → cierre siguiente (2 sesiones; se dice)
export function reaccionAlReporte(precios, fechaReporte, hora) {
  const f = isoDe(fechaReporte);
  if (!f || !Array.isArray(precios) || !precios.length) return null;
  const antesDe = (d) => { let r = null; for (const p of precios) { if (p.date < d) r = p; else break; } return r; };
  const hastaInclusive = (d) => { let r = null; for (const p of precios) { if (p.date <= d) r = p; else break; } return r; };
  const desde = (d) => precios.find((p) => p.date >= d) || null;
  const despuesDe = (d) => precios.find((p) => p.date > d) || null;
  let antes, despues, base;
  if (hora === 'bmo') { antes = antesDe(f); despues = desde(f); base = 'bmo: cierre previo → cierre del día'; }
  else if (hora === 'amc') { antes = hastaInclusive(f); despues = despuesDe(f); base = 'amc: cierre del día → cierre siguiente'; }
  else { antes = antesDe(f); despues = despuesDe(f); base = 'hora desconocida: cierre previo → cierre siguiente (2 sesiones)'; }
  if (!antes || !despues || !(antes.close > 0) || antes.date === despues.date) return null;
  // Un hueco de más de una semana alrededor del reporte = no hay precio de ESE
  // evento (la serie empieza después, o le faltan días). Mejor nada.
  if (dias(despues.date, antes.date) > 7) return null;
  return { pct: +(((despues.close - antes.close) / antes.close) * 100).toFixed(2), base, desde: antes.date, hasta: despues.date };
}

// ── 4. REVENUE TRIMESTRAL ──────────────────────────────────────────────
// Conceptos aceptados, por prioridad. Lista CERRADA: `includes('revenue')`
// también agarraba `CostOfRevenue` y `RevenueRemainingPerformanceObligation`.
const CONCEPTOS_REVENUE = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'RevenuesNetOfInterestExpense',
];
const nombreConcepto = (c) => String(c || '').replace(/^[a-z-]+[_:]/i, '');

// Finnhub financials-reported → [{endDate, revenue, base}] con el valor de TRES
// MESES. Un 10-Q trae el acumulado del año fiscal; se reconoce por su
// `startDate` (span > ~100 días) y se le resta el acumulado anterior del mismo
// año fiscal (mismo startDate). Sin startDate, o sin el acumulado anterior, no
// se adivina: ese trimestre queda sin revenue.
export function revenueTrimestral(reportes) {
  const leidos = [];
  for (const r of reportes || []) {
    const ic = (r && r.report && Array.isArray(r.report.ic)) ? r.report.ic : [];
    let item = null;
    for (const c of CONCEPTOS_REVENUE) {
      item = ic.find((x) => x && nombreConcepto(x.concept) === c && Number.isFinite(Number(x.value)));
      if (item) break;
    }
    const fin = isoDe(r && r.endDate), ini = isoDe(r && r.startDate);
    if (!item || !fin) continue;
    leidos.push({ fin, ini, valor: Number(item.value) });
  }
  const salida = [];
  for (const x of leidos) {
    if (!x.ini) continue;
    const span = dias(x.fin, x.ini);
    if (span <= 100) { salida.push({ endDate: x.fin, revenue: x.valor, base: '3 meses' }); continue; }
    // Acumulado: el anterior es el del MISMO año fiscal con el cierre más
    // cercano por debajo, y tiene que estar ~un trimestre antes.
    const previo = leidos
      .filter((y) => y.ini === x.ini && y.fin < x.fin)
      .sort((a, b) => b.fin.localeCompare(a.fin))[0];
    if (!previo) continue;
    const salto = dias(x.fin, previo.fin);
    if (salto < 70 || salto > 110) continue;
    const q = x.valor - previo.valor;
    if (q > 0) salida.push({ endDate: x.fin, revenue: q, base: 'acumulado fiscal desacumulado' });
  }
  return salida;
}

// ── 2. EL PAYLOAD DEL PANEL, DESDE pead_earnings ───────────────────────
// filas: las de `leeHistoricoPead` para un símbolo. horas: Map fecha→bmo/amc.
// calendario: entradas pasadas de Finnhub calendar/earnings (date, revenueActual).
// revenues: salida de `revenueTrimestral`.
export function historiaDesdePead({ simbolo, filas, horas = new Map(), precios = null, calendario = [], revenues = [], ultimos = 8 }) {
  const stats = estadisticasHistoricas(filas);
  const ordenadas = (filas || [])
    .filter((f) => f && isoDe(f.reported_date))
    .sort((a, b) => isoDe(b.reported_date).localeCompare(isoDe(a.reported_date)));

  const revenueDe = (f) => {
    const rep = isoDe(f.reported_date), fin = isoDe(f.fiscal_date_ending);
    const cal = (calendario || []).find((c) => isoDe(c.date) && Math.abs(dias(isoDe(c.date), rep)) <= 3 && n(c.revenueActual) > 0);
    if (cal) return { valor: n(cal.revenueActual), base: 'Finnhub calendar (trimestre)' };
    if (fin) {
      const r = (revenues || []).find((x) => Math.abs(dias(x.endDate, fin)) <= 10);
      if (r) return { valor: r.revenue, base: 'Finnhub financials-reported (' + r.base + ')' };
    }
    return null;
  };
  const conRevenue = ordenadas.map((f) => ({ f, rev: revenueDe(f) }));

  const history = conRevenue.slice(0, ultimos).map(({ f, rev }) => {
    const rep = isoDe(f.reported_date), fin = isoDe(f.fiscal_date_ending);
    const est = n(f.estimated_eps), act = n(f.reported_eps);
    const pct = sorpresaPct(act, est);
    const hora = horas.get(rep) || null;
    const re = reaccionAlReporte(precios, rep, hora);
    // YoY contra el trimestre que cerró ~un año antes.
    let yoy = null;
    if (rev && fin) {
      const prev = conRevenue.find((x) => x.rev && isoDe(x.f.fiscal_date_ending)
        && Math.abs(dias(fin, isoDe(x.f.fiscal_date_ending)) - 365) <= 15);
      if (prev && prev.rev.valor > 0) yoy = +(((rev.valor - prev.rev.valor) / prev.rev.valor) * 100).toFixed(1);
    }
    return {
      period: fin,                 // cierre del trimestre fiscal
      report_date: rep,            // día del reporte: de acá sale la reacción
      hour: hora,
      quarter: null, year: null,   // el trimestre se nombra por su cierre (ver api/_lib/analiza.js)
      eps_estimate: est,
      eps_actual: act,
      surprise_pct: pct === null ? null : +pct.toFixed(2),
      // Igual que la tarjeta: beat = reportado > estimado, no el signo de un %.
      beat: est !== null && act !== null ? act > est : null,
      stock_reaction_pct: re ? re.pct : null,
      reaction_basis: re ? re.base : null,
      revenue_actual: rev ? rev.valor : null,
      revenue_basis: rev ? rev.base : null,
      revenue_yoy_pct: yoy,
    };
  });

  return armaPayload({
    simbolo, fuente: FUENTE_PEAD, respaldo: false, stats, history,
    fuente_texto: 'Alpha Vantage EARNINGS vía pead_earnings (la misma base que la tarjeta de Polymarket)',
  });
}

// ── RESPALDO: Finnhub, para símbolos que no están en Neon ──────────────
// quarters: /stock/earnings. calendario: calendar/earnings PASADO del símbolo,
// que sí trae la fecha de reporte. Sin fecha de reporte, NO hay reacción: el
// `period` de Finnhub es el cierre fiscal y medir desde ahí fue el bug.
export function historiaDesdeFinnhub({ simbolo, quarters, precios = null, calendario = [], revenues = [], ultimos = 8 }) {
  const qs = (quarters || []).filter(Boolean);
  const reporteDe = (q) => {
    const c = (calendario || []).find((x) => x && x.year === q.year && x.quarter === q.quarter && isoDe(x.date));
    return c ? { date: isoDe(c.date), hour: c.hour || null, revenue: n(c.revenueActual) } : null;
  };
  const filas = qs.map((q) => ({
    // Solo para ORDENAR: estadisticasHistoricas necesita una fecha.
    reported_date: (reporteDe(q) || {}).date || isoDe(q.period),
    reported_eps: q.actual, estimated_eps: q.estimate, surprise_pct: q.surprisePercent,
  }));
  const stats = estadisticasHistoricas(filas);
  const history = qs.slice(0, ultimos).map((q) => {
    const est = n(q.estimate), act = n(q.actual);
    const pct = sorpresaPct(act, est);
    const rep = reporteDe(q);
    const re = rep ? reaccionAlReporte(precios, rep.date, rep.hour) : null;
    const fin = isoDe(q.period);
    let rev = rep && rep.revenue > 0 ? { valor: rep.revenue, base: 'Finnhub calendar (trimestre)' } : null;
    if (!rev && fin) {
      const r = (revenues || []).find((x) => Math.abs(dias(x.endDate, fin)) <= 10);
      if (r) rev = { valor: r.revenue, base: 'Finnhub financials-reported (' + r.base + ')' };
    }
    return {
      period: fin, report_date: rep ? rep.date : null, hour: rep ? rep.hour : null,
      quarter: q.quarter || null, year: q.year || null,
      eps_estimate: est, eps_actual: act,
      surprise_pct: pct === null ? null : +pct.toFixed(2),
      beat: est !== null && act !== null ? act > est : null,
      stock_reaction_pct: re ? re.pct : null,
      reaction_basis: re ? re.base : (rep ? null : 'sin fecha de reporte: Finnhub solo da el cierre fiscal'),
      revenue_actual: rev ? rev.valor : null,
      revenue_basis: rev ? rev.base : null,
      revenue_yoy_pct: null,
    };
  });
  return armaPayload({
    simbolo, fuente: FUENTE_FINNHUB, respaldo: true, stats, history,
    fuente_texto: 'Finnhub /stock/earnings — RESPALDO: el símbolo no está en pead_earnings',
  });
}

function armaPayload({ simbolo, fuente, respaldo, stats, history, fuente_texto }) {
  const v = stats && !stats.sin_datos ? stats.ventana : null;
  const sp = stats && !stats.sin_datos ? stats.sorpresa : null;
  const reac = history.filter((h) => h.stock_reaction_pct !== null);
  const payload = {
    ticker: simbolo,
    source: fuente,
    source_label: fuente_texto,
    fallback: respaldo,
    history,
    // EL TITULAR ES LA VENTANA, igual que la tarjeta: mismos beats, mismo total,
    // mismo % (redondeado igual). Ver tests/earnings-tab-coherencia.test.mjs.
    beats: v ? v.beats : 0,
    total: v ? v.total : 0,
    beat_rate_pct: v && v.pct !== null ? v.pct : 0,
    window_quarters: v ? v.trimestres : null,
    median_surprise_pct: sp ? sp.mediana_pct : null,
    avg_surprise_pct: sp && sp.promedio_pct !== null ? sp.promedio_pct : 0,
    // El panel muestra el movimiento ABSOLUTO medio; el con signo se conserva
    // para quien ya lo consumía.
    avg_abs_stock_reaction_pct: reac.length ? +(reac.reduce((a, h) => a + Math.abs(h.stock_reaction_pct), 0) / reac.length).toFixed(2) : null,
    avg_stock_reaction_pct: reac.length ? +(reac.reduce((a, h) => a + h.stock_reaction_pct, 0) / reac.length).toFixed(2) : null,
    reactions_count: reac.length,
    historico: stats,
  };
  payload.consistencia = evaluaConsistencia(payload);
  return payload;
}

// ── 5. ¿SE PUEDE OPINAR SOBRE ESTOS DATOS? ─────────────────────────────
// `bloquea: true` → el veredicto de IA NO se pide. Lo que no bloquea se
// muestra igual, para que el lector sepa con qué está mirando.
export function evaluaConsistencia(p) {
  const problemas = [];
  const h = (p && p.history) || [];
  if (!p || !p.total) {
    problemas.push({ codigo: 'sin_trimestres', bloquea: true, texto: 'no hay trimestres con estimado y reportado para contar beats' });
  }
  for (const q of h) {
    if (q.eps_estimate !== null && q.eps_actual !== null && q.beat !== (q.eps_actual > q.eps_estimate)) {
      problemas.push({ codigo: 'beat_contradice_cifras', bloquea: true, texto: `${q.report_date || q.period}: el BEAT/MISS no coincide con estimado ${q.eps_estimate} vs reportado ${q.eps_actual}` });
    }
    if (q.stock_reaction_pct !== null && !q.report_date) {
      problemas.push({ codigo: 'reaccion_sin_fecha_de_reporte', bloquea: true, texto: `${q.period}: reacción medida sin fecha de reporte` });
    }
  }
  // Un trimestre que factura el doble (o la mitad) que la mediana de la serie es
  // la firma del acumulado fiscal (el $24.81B de NFLX), no del negocio.
  const revs = h.map((q) => q.revenue_actual).filter((x) => x > 0).sort((a, b) => a - b);
  if (revs.length >= 3) {
    const med = revs.length % 2 ? revs[(revs.length - 1) / 2] : (revs[revs.length / 2 - 1] + revs[revs.length / 2]) / 2;
    const raros = h.filter((q) => q.revenue_actual > 0 && (q.revenue_actual > med * 1.6 || q.revenue_actual < med * 0.5));
    for (const q of raros) {
      problemas.push({ codigo: 'revenue_fuera_de_escala', bloquea: true, texto: `${q.period}: revenue ${(q.revenue_actual / 1e9).toFixed(2)}B contra una mediana de ${(med / 1e9).toFixed(2)}B` });
    }
  }
  if (p && p.fallback) {
    problemas.push({ codigo: 'fuente_de_respaldo', bloquea: false, texto: 'el símbolo no está en pead_earnings: los beats salen de Finnhub (respaldo)' });
  }
  return { ok: !problemas.some((x) => x.bloquea), problemas };
}
