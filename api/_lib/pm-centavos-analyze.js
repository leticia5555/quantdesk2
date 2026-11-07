// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-centavos-analyze.js — "PM-CENTAVOS", backtest pre-registrado.
//
// ¿La distancia en CENTAVOS entre la barra del mercado de Polymarket y el
// consenso que el propio mercado declara en su descripción predice el
// resultado MEJOR que el precio del mercado a T-24h? Ver
// docs/pm-centavos-scope.md.
//
// Motivación (escrita el 6-nov, ANTES de correr): en la semana 2–5 nov, 3 de
// los 4 errores del mercado fueron por 0–1 centavo (ON 0.90 vs 0.90, SYY 1.19
// vs 1.20, FNF 1.32 vs 1.33). Referencia: Degeorge, Patel & Zeckhauser (1999),
// las empresas aterrizan pegadas al consenso. La barra es estricta (empate =
// No), así que cuando barra = consenso, "aterrizar en el consenso" es un No.
//
// Este archivo es PURO (sin red, sin DB). El precio a T-24h sale de la MISMA
// caché y la MISMA regla que PM-DRIFT (pm_price_hist; T-24h desde la hora del
// reporte, punto anterior más cercano, hueco ≤ 3h): se importa de
// pm-drift-analyze.js, no se copia. La logística con errores agrupados
// también (está pineada contra statsmodels en los tests de PM-DRIFT).
//
// ── LO QUE NO SE MUEVE ─────────────────────────────────────────────
// CRITERIOS_PM_CENTAVOS se fijó ANTES de correr y
// tests/pm-centavos-analyze.test.mjs lo pinea valor por valor. Cambiar un
// umbral después de ver el resultado invalida el estudio: se corre otro
// estudio con otro nombre, no se edita este.
// ═══════════════════════════════════════════════════════════════════

import {
  CRITERIOS_PM_DRIFT, horaDelReporte, precioEn, logit, logistica, mitades as mitadesDrift,
} from './pm-drift-analyze.js';
import { umbralDelSlug } from './earnings-beat.js';

const CRITERIOS_PM_CENTAVOS = Object.freeze({
  // Universo
  min_volumen_usd: 500,
  // Gap = barra − consenso, en centavos, redondeado al centavo (mitades
  // lejos del cero: +0.5 → +1, −0.5 → −1).
  // Tabla: ≤−4, −3, −2, −1, 0, +1, +2, +3, ≥+4.
  gap_tope: 4,
  // Precio: T-24h desde la hora del reporte, con la regla de PM-DRIFT.
  horas_antes_precio: 24,
  max_hueco_horas: 3,
  logit_clip: 0.01,
  // Simulación en papel
  sim_no_si_gap: 0,              // gap = 0 …
  sim_no_p24_min: 0.70,          // … y p24 ≥ 0.70 → compra No a (1 − p24)
  sim_yes_si_gap_max: -1,        // gap ≤ −1 …
  sim_yes_p24_max: 0.70,         // … y p24 ≤ 0.70 → compra Yes a p24
  apuesta_usd: 1,
  costo_por_operacion_usd: 0.02,
  // Veredicto
  min_n_gap0: 40,
  t_go: 2.5,
  t_fragil: 2,
  hipotesis_previa: 'En gap = 0, el % real de Yes está POR DEBAJO del precio medio del mercado a T-24h.',
});

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const H = 3600 * 1000;

// ─────────────────── lectura de barra y consenso ───────────────────

// Un monto con signo: "$0.43", "-$0.05", "$-0.05", "($0.05)", "−$0.05".
const MONTO = String.raw`(\(?\s*[-−–]?\s*\$\s*[-−–]?\s*\d+(?:\.\d+)?\s*\)?)`;
// Plantilla nueva: «The Street consensus estimate for X's non-GAAP EPS for the
// relevant quarter is $0.43 as of market creation».
const CONSENSO_PLANTILLA = new RegExp(String.raw`\bconsensus estimate for [^.$]{1,120}? is\s+` + MONTO + String.raw`\s+as of market creation`, 'i');

// Plantilla vieja: el monto a ≤ 60 caracteres de "consensus" (como el patrón
// consensus_monto del lector v1, pero entendiendo también "-$0.05").
const CONSENSO_CERCA = new RegExp(String.raw`\bconsensus\b[^.$]{0,60}?` + MONTO, 'i');

// "($0.05)" es negativo, como en el lector v1 (notación contable).
function montoConSigno(s) {
  const t = String(s || '');
  const m = /(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const negativo = /[-−–]/.test(t) || /\(/.test(t);
  return negativo ? -v : v;
}

// El consenso que el MERCADO DECLARA en su descripción. Solo cuenta un monto
// pegado a la palabra "consensus" (plantilla nueva, o a ≤ 60 caracteres). Un "estimate"/"EPS" suelto NO es consenso:
// suele ser la propia barra, y eso fabricaría gap = 0.
function consensoDeDescripcion(descripcion) {
  const d = String(descripcion || '');
  if (!d) return null;
  const p = CONSENSO_PLANTILLA.exec(d);
  if (p) {
    const v = montoConSigno(p[1]);
    if (v !== null) return { valor: v, patron: 'plantilla' };
  }
  const m = CONSENSO_CERCA.exec(d);
  if (m) {
    const v = montoConSigno(m[1]);
    if (v !== null) return { valor: v, patron: 'consensus_monto' };
  }
  return null;
}

// La barra: el umbral del slug ("…-1pt33", "…-neg-0pt03"). Si el slug no la
// trae, el monto de la PREGUNTA ("…EPS above $1.33?"). Nunca la descripción:
// ahí el monto suele ser el consenso y fabricaría gap = 0.
function barraDelMercado({ slug, question } = {}) {
  const s = umbralDelSlug(slug);
  if (s !== null) return { valor: s, fuente: 'slug' };
  const m = new RegExp(MONTO).exec(String(question || ''));
  const v = m ? montoConSigno(m[1]) : null;
  return v !== null ? { valor: v, fuente: 'pregunta' } : null;
}

// gap = barra − consenso, en centavos enteros. toFixed(6) quita el ruido de
// coma flotante (1.33 − 1.32 = 0.01000000000000009); las mitades se redondean
// lejos del cero. Nunca devuelve −0.
function gapCentavos(barra, consenso) {
  const b = num(barra), c = num(consenso);
  if (b === null || c === null) return null;
  const x = Number(((b - c) * 100).toFixed(6));
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r;
}

// Etiqueta del tramo de la tabla.
function tramoGap(g, C = CRITERIOS_PM_CENTAVOS) {
  if (g === null || g === undefined) return null;
  if (g <= -C.gap_tope) return `≤−${C.gap_tope}`;
  if (g >= C.gap_tope) return `≥+${C.gap_tope}`;
  return g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '0';
}
function tramosGap(C = CRITERIOS_PM_CENTAVOS) {
  const t = [`≤−${C.gap_tope}`];
  for (let g = -C.gap_tope + 1; g < C.gap_tope; g++) t.push(tramoGap(g, C));
  t.push(`≥+${C.gap_tope}`);
  return t;
}

// ─────────────────── universo ───────────────────

// filas = SELECT de la unión v2 + v1 (v2 primero). Dedup por market_id: gana
// la primera (v2). Cada exclusión con su motivo, en este orden.
function construyeUniverso(filas, C = CRITERIOS_PM_CENTAVOS) {
  const vistos = new Set();
  const universo = [];
  const excluidos = { duplicado: 0, no_resuelto: 0, liquidez: 0, sin_consenso: 0, sin_barra: 0, sin_token: 0, sin_fecha_reporte: 0 };
  for (const f of filas || []) {
    const id = f && f.market_id != null ? String(f.market_id) : null;
    if (!id) continue;
    if (vistos.has(id)) { excluidos.duplicado++; continue; }
    vistos.add(id);
    const outcome = String(f.outcome || '').toLowerCase();
    if (outcome !== 'yes' && outcome !== 'no') { excluidos.no_resuelto++; continue; }
    const vol = num(f.volume);
    if (vol === null || vol < C.min_volumen_usd) { excluidos.liquidez++; continue; }
    // Solo el consenso de la DESCRIPCIÓN. La columna consensus_pm no lo
    // sustituye: el estudio es sobre lo que el mercado declara.
    const cons = consensoDeDescripcion(f.descripcion);
    if (!cons) { excluidos.sin_consenso++; continue; }
    const barra = barraDelMercado(f);
    if (!barra) { excluidos.sin_barra++; continue; }
    if (!f.yes_token_id) { excluidos.sin_token++; continue; }
    if (!f.report_date) { excluidos.sin_fecha_reporte++; continue; }
    const fecha = String(f.report_date).slice(0, 10);
    const rep = horaDelReporte(fecha, f.hour, CRITERIOS_PM_DRIFT);
    const gap = gapCentavos(barra.valor, cons.valor);
    universo.push({
      market_id: id, symbol: f.symbol || null, cosecha: f.cosecha || null, fecha,
      hora_efectiva: rep.hora_efectiva, hora_imputada: rep.imputada, reporte_ms: rep.ms,
      token: String(f.yes_token_id),
      y: outcome === 'yes' ? 1 : 0, volume: vol,
      barra: barra.valor, barra_fuente: barra.fuente, consenso: cons.valor, consenso_patron: cons.patron,
      gap, tramo: tramoGap(gap, C),
    });
  }
  return { universo, excluidos, filas: (filas || []).length };
}

// Mercado + sus puntos → observación con p24.
function observacion(m, puntos, C = CRITERIOS_PM_CENTAVOS) {
  const pr = precioEn(puntos, m.reporte_ms - C.horas_antes_precio * H, { maxHuecoHoras: C.max_hueco_horas });
  return {
    market_id: m.market_id, symbol: m.symbol, fecha: m.fecha, hora_imputada: m.hora_imputada, y: m.y,
    barra: m.barra, consenso: m.consenso, gap: m.gap, tramo: m.tramo,
    p24: pr.precio, motivo24: pr.motivo || null,
    // mitadesDrift filtra por `d`: acá la observación válida es la que tiene p24.
    d: pr.precio,
  };
}

// ─────────────────── pruebas ───────────────────

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// a) Tabla por gap.
function tablaGap(obs, C = CRITERIOS_PM_CENTAVOS) {
  return tramosGap(C).map((tramo) => {
    const g = obs.filter((o) => o.p24 !== null && o.tramo === tramo);
    const tasa = media(g.map((o) => o.y));
    const p = media(g.map((o) => o.p24));
    return { tramo, n: g.length, tasa_yes: tasa, p24_medio: p, diferencia: tasa === null ? null : tasa - p };
  });
}

// b) resultado ~ logit(p24) + 1[gap=0] + 1[gap=−1] + 1[gap≥+1].
// Categoría base: gap ≤ −2. Errores agrupados por fecha de reporte.
const VARIABLES = Object.freeze(['logit_p24', 'gap0', 'gap_m1', 'gap_pos']);
function filaX(o, C) {
  return [logit(o.p24, C.logit_clip), o.gap === 0 ? 1 : 0, o.gap === -1 ? 1 : 0, o.gap >= 1 ? 1 : 0];
}
function regresion(obs, C = CRITERIOS_PM_CENTAVOS) {
  const v = obs.filter((o) => o.p24 !== null && o.gap !== null);
  const r = logistica(v.map((o) => filaX(o, C)), v.map((o) => o.y), v.map((o) => o.fecha));
  if (!r.convergio) return { n: v.length, convergio: false, motivo: r.motivo, coefs: null, gap0: null };
  const f = (x) => (x === null || x === undefined ? null : Number(x.toFixed(6)));
  const coefs = { intercepto: { coef: f(r.coef[0]), se: f(r.se[0]), t: f(r.t[0]) } };
  VARIABLES.forEach((k, i) => { coefs[k] = { coef: f(r.coef[i + 1]), se: f(r.se[i + 1]), t: f(r.t[i + 1]) }; });
  return { n: r.n, grupos: r.grupos, convergio: true, coefs, gap0: coefs.gap0 };
}

// c) Simulación en papel. $1 al precio p24, costo fijo por operación.
//   gap = 0  y p24 ≥ 0.70 → compra No a (1 − p24): gana (1−y)/(1−p24) − 1
//   gap ≤ −1 y p24 ≤ 0.70 → compra Yes a p24:      gana y/p24 − 1
function simulacion(obs, C = CRITERIOS_PM_CENTAVOS) {
  const ops = [];
  for (const o of obs) {
    if (o.p24 === null || o.gap === null) continue;
    let lado = null;
    if (o.gap === C.sim_no_si_gap && o.p24 >= C.sim_no_p24_min && o.p24 < 1) lado = 'no';
    else if (o.gap <= C.sim_yes_si_gap_max && o.p24 <= C.sim_yes_p24_max && o.p24 > 0) lado = 'yes';
    if (!lado) continue;
    const bruto = lado === 'yes' ? C.apuesta_usd * (o.y / o.p24 - 1) : C.apuesta_usd * ((1 - o.y) / (1 - o.p24) - 1);
    ops.push({ lado, bruto, neto: bruto - C.costo_por_operacion_usd, gana: lado === 'yes' ? o.y === 1 : o.y === 0 });
  }
  const s = (k, g = ops) => g.reduce((a, x) => a + x[k], 0);
  const lado = (l) => { const g = ops.filter((x) => x.lado === l); return { n: g.length, aciertos: g.filter((x) => x.gana).length, neto_usd: Number(s('neto', g).toFixed(4)) }; };
  return {
    operaciones: ops.length,
    compra_no: lado('no'),
    compra_yes: lado('yes'),
    aciertos: ops.filter((x) => x.gana).length,
    bruto_usd: Number(s('bruto').toFixed(4)),
    costos_usd: Number((ops.length * C.costo_por_operacion_usd).toFixed(4)),
    neto_usd: Number(s('neto').toFixed(4)),
    neto_por_apuesta: ops.length ? Number((s('neto') / ops.length).toFixed(4)) : null,
  };
}

// d) Mitades por fecha: la MISMA regla que PM-DRIFT (mediana = la fecha del
// medio de las observaciones válidas, la menor si N es par; 1ª = ≤ mediana).
function mitades(obs) {
  return mitadesDrift(obs.filter((o) => o.p24 !== null && o.gap !== null));
}

// ─────────────────── veredicto ───────────────────

const ESTADOS = Object.freeze({
  FRONTERA: 'FALLA DE FRONTERA', INCOMPLETA: 'COBERTURA INCOMPLETA',
  INCONCLUSO: 'INCONCLUSO', GO: 'GO', FRAGIL: 'GO FRÁGIL', NOGO: 'NO-GO',
});

// "Negativo con t ≥ 2.5" = coef < 0 y |t| ≥ 2.5 (o sea t ≤ −2.5).
function veredicto({ n_gap0, regresion: r, mitad_antes: m1, mitad_despues: m2 }, C = CRITERIOS_PM_CENTAVOS) {
  const g0 = r && r.convergio ? r.gap0 : null;
  const cumple = {
    n_suficiente: n_gap0 >= C.min_n_gap0,
    coef_negativo: !!(g0 && g0.coef < 0),
    t: g0 ? g0.t : null,
    t_abs: g0 && g0.t !== null ? Math.abs(g0.t) : null,
    sim_neta_antes: m1 ? m1.simulacion.neto_usd : null,
    sim_neta_despues: m2 ? m2.simulacion.neto_usd : null,
  };
  if (!cumple.n_suficiente) return { veredicto: ESTADOS.INCONCLUSO, motivo: `N(gap = 0) = ${n_gap0} < ${C.min_n_gap0}`, cumple };
  const sims = cumple.sim_neta_antes > 0 && cumple.sim_neta_despues > 0;
  const base = cumple.coef_negativo && sims;
  if (base && cumple.t_abs >= C.t_go) return { veredicto: ESTADOS.GO, motivo: `coef(gap=0) < 0 con t = ${cumple.t.toFixed(2)} (|t| ≥ ${C.t_go}) y simulación neta > 0 en ambas mitades`, cumple };
  if (base && cumple.t_abs >= C.t_fragil) return { veredicto: ESTADOS.FRAGIL, motivo: `coef(gap=0) < 0 con ${C.t_fragil} ≤ |t| = ${cumple.t_abs.toFixed(2)} < ${C.t_go}`, cumple };
  const fallas = [];
  if (!(r && r.convergio)) fallas.push(`regresión sin convergencia (${r ? r.motivo : 'sin datos'})`);
  else if (!cumple.coef_negativo) fallas.push('coeficiente de gap=0 ≥ 0');
  else if (!(cumple.t_abs >= C.t_fragil)) fallas.push(`|t| = ${cumple.t_abs === null ? '—' : cumple.t_abs.toFixed(2)} < ${C.t_fragil}`);
  if (!(cumple.sim_neta_antes > 0)) fallas.push('simulación neta ≤ 0 en la 1ª mitad');
  if (!(cumple.sim_neta_despues > 0)) fallas.push('simulación neta ≤ 0 en la 2ª mitad');
  return { veredicto: ESTADOS.NOGO, motivo: fallas.join('; '), cumple };
}

// ─────────────────── corrida ───────────────────

function cobertura(universo, obsPorId, estados) {
  const c = { universo: universo.length, con_p24: 0, pendiente_descarga: 0, error_descarga: 0, faltan_p24: {}, puntos_totales: 0,
    sin_hora_imputada_amc: universo.filter((m) => m.hora_imputada).length };
  for (const m of universo) {
    const est = estados.get(m.market_id);
    if (!est) { c.pendiente_descarga++; continue; }
    if (est !== 'ok') { c.error_descarga++; continue; }
    const o = obsPorId.get(m.market_id);
    if (!o) continue;
    if (o.p24 !== null) c.con_p24++;
    else c.faltan_p24[o.motivo24] = (c.faltan_p24[o.motivo24] || 0) + 1;
  }
  return c;
}

function corre({ universo, puntosPorId, estados, C = CRITERIOS_PM_CENTAVOS }) {
  const obs = [];
  const obsPorId = new Map();
  let puntosTotales = 0;
  for (const m of universo) {
    if (estados.get(m.market_id) !== 'ok') continue;
    const pts = puntosPorId.get(m.market_id) || [];
    puntosTotales += pts.length;
    const o = observacion(m, pts, C);
    obs.push(o);
    obsPorId.set(m.market_id, o);
  }
  const cob = cobertura(universo, obsPorId, estados);
  cob.puntos_totales = puntosTotales;

  if (!universo.length) return { estado: ESTADOS.FRONTERA, motivo: 'universo vacío: no hay mercados resueltos con liquidez, consenso, barra y fecha de reporte', cobertura: cob, obs };
  if (puntosTotales === 0 && cob.pendiente_descarga === 0) {
    return { estado: ESTADOS.FRONTERA, motivo: 'cero puntos de precio del CLOB para todo el universo', cobertura: cob, obs };
  }
  if (cob.pendiente_descarga > 0) {
    return { estado: ESTADOS.INCOMPLETA, motivo: `faltan ${cob.pendiente_descarga} historiales por bajar: vuelve a abrir el link`, cobertura: cob, obs };
  }

  const validas = obs.filter((o) => o.p24 !== null && o.gap !== null);
  const m = mitades(validas);
  const ordenFecha = (g) => [...g].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const mitad = (g) => {
    const o = ordenFecha(g);
    return { n: o.length, desde: o.length ? o[0].fecha : null, hasta: o.length ? o[o.length - 1].fecha : null,
      n_gap0: o.filter((x) => x.gap === 0).length, regresion: regresion(o, C), simulacion: simulacion(o, C) };
  };
  const tabla = tablaGap(validas, C);
  const t0 = tabla.find((t) => t.tramo === '0');
  const res = {
    n_validas: validas.length,
    n_gap0: validas.filter((o) => o.gap === 0).length,
    tabla,
    regresion: regresion(validas, C),
    simulacion: simulacion(validas, C),
    mediana_fecha: m.mediana,
    mitad_antes: mitad(m.antes),
    mitad_despues: mitad(m.despues),
    // Reportado, NO decide.
    hipotesis_previa: {
      texto: C.hipotesis_previa,
      tasa_yes_gap0: t0 ? t0.tasa_yes : null,
      p24_medio_gap0: t0 ? t0.p24_medio : null,
      se_cumple: t0 && t0.n ? t0.tasa_yes < t0.p24_medio : null,
    },
  };
  const v = veredicto(res, C);
  return { estado: v.veredicto, motivo: v.motivo, cumple: v.cumple, cobertura: cob, ...res, obs };
}

// ─────────────────── SQL ───────────────────
// Solo SELECT sobre v1/v2/pead_event_hour. La caché de precios es la de
// PM-DRIFT (pm_price_hist / pm_price_hist_fetch, mismo SCHEMA).

const COLS_U = `market_id, symbol, slug, question, raw->>'description' as descripcion,
       to_char(report_date, 'YYYY-MM-DD') as report_date, outcome, volume, yes_token_id`;
const SQL_UNIVERSO = `select u.*, h.hour from (
    select ${COLS_U}, 'v2' as cosecha, 0 as orden from pm_earnings_markets_v2
    union all
    select ${COLS_U}, 'v1' as cosecha, 1 as orden from pm_earnings_markets m
     where not exists (select 1 from pm_earnings_markets_v2 v where v.market_id = m.market_id)
  ) u
  left join pead_event_hour h on h.symbol = u.symbol and h.reported_date = to_date(u.report_date, 'YYYY-MM-DD')
  order by u.orden, u.market_id`;

// ─────────────────── markdown ───────────────────

const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%');
const pp = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pts');
const f2 = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const usd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toFixed(2));

function renderResumenMarkdown(s) {
  const L = [];
  const C = s.criterios || CRITERIOS_PM_CENTAVOS;
  const r = s.resultado || {};
  const c = r.cobertura || {};
  L.push('# PM-CENTAVOS — ¿la distancia en centavos barra − consenso predice mejor que el precio?');
  L.push('');
  L.push(`Generado: ${s.generado_en}`);
  L.push('');
  L.push(`## Estado: **${r.estado}**${s.solo_cobertura ? ' (modo cobertura: sin veredicto)' : ''}`);
  if (r.motivo) L.push(`> ${r.motivo}`);
  L.push('');
  L.push(`Hipótesis previa registrada: ${C.hipotesis_previa}`);
  L.push('');
  const u = s.universo || {};
  L.push('## Universo');
  L.push(`- Filas leídas (v2 ∪ v1): **${u.filas ?? '—'}** → universo: **${c.universo ?? '—'}**`);
  if (u.excluidos) {
    const e = u.excluidos;
    L.push(`- Excluidos: duplicados ${e.duplicado} · no resueltos ${e.no_resuelto} · liquidez < $${C.min_volumen_usd} ${e.liquidez} · sin consenso en la descripción ${e.sin_consenso} · sin barra ${e.sin_barra} · sin token ${e.sin_token} · sin fecha de reporte ${e.sin_fecha_reporte}`);
  }
  L.push(`- Sin hora de reporte (imputados AMC 16:00 ET, regla de PM-DRIFT): ${c.sin_hora_imputada_amc ?? '—'}`);
  L.push('');
  L.push('## Cobertura del precio a T-24h');
  if (s.descarga) {
    const d = s.descarga;
    L.push(`- Esta corrida bajó: ${d.intentados} intentos · ${d.ok} ok (${d.vacios} vacíos) · ${d.errores} errores · ${d.puntos} puntos${d.ratelimit ? ' · **cortado por 429**' : ''}${d.por_presupuesto ? ` · ${d.por_presupuesto} quedan para la próxima` : ''}`);
  }
  const fp = c.faltan_p24 || {};
  L.push(`- Con p24: **${c.con_p24 ?? '—'}** · sin p24: sin historial ${fp.sin_historial || 0} · sin punto anterior ${fp.sin_punto_anterior || 0} · hueco > 3h ${fp.hueco_mayor_3h || 0}`);
  L.push(`- Pendientes de bajar: ${c.pendiente_descarga ?? '—'} · error de descarga: ${c.error_descarga ?? '—'} · puntos en caché: ${c.puntos_totales ?? '—'}`);
  L.push('');
  if (s.solo_cobertura || !r.tabla) {
    L.push('_Sin resultados en este modo/estado. Los criterios están congelados en `CRITERIOS_PM_CENTAVOS`._');
    return L.join('\n');
  }

  L.push(`## a) Tabla por gap (barra − consenso, centavos; empate = No) — N ${r.n_validas}`);
  L.push('| gap | N | % Yes real | p24 medio | Yes real − p24 |');
  L.push('|---|---|---|---|---|');
  for (const t of r.tabla) L.push(`| ${t.tramo} | ${t.n} | ${pct(t.tasa_yes)} | ${pct(t.p24_medio)} | ${pp(t.diferencia)} |`);
  L.push('');
  const coef = (x) => (x ? `coef ${f2(x.coef, 4)} · se ${f2(x.se, 4)} · **t ${f2(x.t)}**` : '—');
  const reg = (x, pre = '') => {
    if (!x || !x.convergio) return [`${pre}- sin convergencia (${x ? x.motivo : '—'}) · N ${x ? x.n : 0}`];
    return [
      `${pre}- N ${x.n} · grupos (fechas) ${x.grupos}`,
      `${pre}- 1[gap = 0]: ${coef(x.coefs.gap0)}`,
      `${pre}- 1[gap = −1]: ${coef(x.coefs.gap_m1)}`,
      `${pre}- 1[gap ≥ +1]: ${coef(x.coefs.gap_pos)}`,
      `${pre}- logit(p24): ${coef(x.coefs.logit_p24)} · intercepto ${f2(x.coefs.intercepto.coef, 4)}`,
    ];
  };
  L.push('## b) Regresión logística: resultado ~ logit(p24) + 1[gap=0] + 1[gap=−1] + 1[gap≥+1]');
  L.push('Base: gap ≤ −2. Errores agrupados por fecha de reporte.');
  L.push(...reg(r.regresion));
  L.push('');
  const sim = (x) => `${x.operaciones} ops (No ${x.compra_no.n}: ${x.compra_no.aciertos} aciertos, ${usd(x.compra_no.neto_usd)} · Yes ${x.compra_yes.n}: ${x.compra_yes.aciertos} aciertos, ${usd(x.compra_yes.neto_usd)}) · bruto ${usd(x.bruto_usd)} · costos ${usd(-x.costos_usd)} · **neto ${usd(x.neto_usd)}** (${f2(x.neto_por_apuesta, 4)}/apuesta)`;
  L.push(`## c) Simulación en papel ($${C.apuesta_usd}/apuesta, $${C.costo_por_operacion_usd} por operación)`);
  L.push(`- Reglas: gap = 0 y p24 ≥ ${C.sim_no_p24_min.toFixed(2)} → No a (1 − p24); gap ≤ −1 y p24 ≤ ${C.sim_yes_p24_max.toFixed(2)} → Yes a p24.`);
  L.push(`- Todo: ${sim(r.simulacion)}`);
  L.push('');
  L.push(`## d) Fuera de muestra (mediana de fecha: ${r.mediana_fecha})`);
  for (const [nom, m] of [['1ª mitad (≤ mediana)', r.mitad_antes], ['2ª mitad (> mediana)', r.mitad_despues]]) {
    L.push(`- **${nom}** — N ${m.n} · gap=0: ${m.n_gap0} · ${m.desde || '—'} → ${m.hasta || '—'}`);
    L.push('  - regresión:');
    L.push(...reg(m.regresion, '    '));
    L.push(`  - simulación: ${sim(m.simulacion)}`);
  }
  L.push('');
  const h = r.hipotesis_previa || {};
  L.push('## Hipótesis previa (se reporta, NO decide)');
  L.push(`- En gap = 0: % Yes real ${pct(h.tasa_yes_gap0)} vs p24 medio ${pct(h.p24_medio_gap0)} → ${h.se_cumple === null ? '—' : h.se_cumple ? '✅ por debajo, como se esperaba' : '❌ no está por debajo'}`);
  L.push('');
  L.push('## Veredicto');
  const k = r.cumple || {};
  L.push(`- N(gap = 0) ≥ ${C.min_n_gap0}: ${k.n_suficiente ? '✅' : '❌'} (${r.n_gap0})`);
  L.push(`- coef(gap = 0) < 0: ${k.coef_negativo ? '✅' : '❌'} · t = ${f2(k.t)} (GO |t| ≥ ${C.t_go}; FRÁGIL |t| ≥ ${C.t_fragil})`);
  L.push(`- simulación neta > 0 en ambas mitades: ${k.sim_neta_antes > 0 ? '✅' : '❌'} ${usd(k.sim_neta_antes)} / ${k.sim_neta_despues > 0 ? '✅' : '❌'} ${usd(k.sim_neta_despues)}`);
  L.push('');
  L.push(`**${r.estado}** — ${r.motivo}`);
  L.push('');
  L.push('_Criterios congelados antes de correr (`CRITERIOS_PM_CENTAVOS` en `api/_lib/pm-centavos-analyze.js`, pineados por test). Ver docs/pm-centavos-scope.md._');
  return L.join('\n');
}

export {
  CRITERIOS_PM_CENTAVOS, ESTADOS, VARIABLES,
  consensoDeDescripcion, barraDelMercado, gapCentavos, tramoGap, tramosGap,
  construyeUniverso, observacion, cobertura,
  tablaGap, regresion, simulacion, mitades, veredicto, corre,
  SQL_UNIVERSO, renderResumenMarkdown,
};
