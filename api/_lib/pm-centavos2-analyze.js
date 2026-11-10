// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-centavos2-analyze.js — "PM-CENTAVOS2", backtest pre-registrado.
//
// PM-CENTAVOS (#351) salió degenerado: Polymarket fija la barra = el
// consenso de su descripción, así que los 183 mercados tenían gap = 0. Acá el
// consenso es el FINAL: el estimatedEPS de Alpha Vantage (pm_v2_hist) para el
// trimestre que el mercado pregunta, el que había al día del reporte.
//
//   gap = barra − estimatedEPS(AV), en centavos.
//
// Estudio PROPIO (criterios propios, alineados con su hipótesis, fijados
// antes de ver un número): base gap = 0; la variable que decide es
// 1[gap ≥ +1] (barra arriba del consenso final → Yes sobrevalorado).
// De PM-CENTAVOS se reusan solo la plomería y las reglas neutrales: lectura
// de la barra, redondeo del gap, tramos de la tabla, precio a T-24h, mitades.
// PM-CENTAVOS no se toca. PURO. Ver docs/pm-centavos2-scope.md.
//
// CRITERIOS_PM_CENTAVOS2 se fijó ANTES de correr y el test lo pinea.
// ═══════════════════════════════════════════════════════════════════

import { CRITERIOS_PM_DRIFT, horaDelReporte, logit, logistica } from './pm-drift-analyze.js';
import {
  barraDelMercado, consensoDeDescripcion, gapCentavos, tramoGap, observacion, cobertura, tablaGap, mitades,
} from './pm-centavos-analyze.js';

const CRITERIOS_PM_CENTAVOS2 = Object.freeze({
  // Universo y precio (mismas reglas neutrales que PM-CENTAVOS / PM-DRIFT)
  min_volumen_usd: 500,
  gap_tope: 4,                       // tabla: ≤−4, −3 … +3, ≥+4
  horas_antes_precio: 24,
  max_hueco_horas: 3,
  logit_clip: 0.01,
  // Simulación: gap ≥ +1 → No a (1 − p24); gap ≤ −1 → Yes a p24; gap = 0 no apuesta.
  sim_no_si_gap_min: 1,
  sim_yes_si_gap_max: -1,
  apuesta_usd: 1,
  costo_por_operacion_usd: 0.02,
  // Veredicto: decide coef(1[gap ≥ +1]).
  min_n_gap_pos: 40,
  t_go: -2.5,                        // t ≤ −2.5
  t_fragil: -2,                      // −2.5 < t ≤ −2
  hipotesis_previa: 'Barra arriba del consenso final (gap ≥ +1) → % real de Yes POR DEBAJO del precio; consenso final arriba de la barra (gap ≤ −1) → POR ARRIBA.',
});

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const valida = (o) => o.p24 !== null && o.gap !== null;

// base = baseMercados(...) de pm-trimestre-av.js. Exclusiones propias, en orden.
function construyeUniverso(base, C = CRITERIOS_PM_CENTAVOS2) {
  const universo = [];
  const excluidos = { ...base.excluidos, sin_fecha_reporte: 0, sin_barra: 0, sin_estimado_av: 0 };
  const motivos_sin_fecha = {};
  const motivos_sin_estimado = {};
  for (const m of base.mercados) {
    if (!m.fecha) { excluidos.sin_fecha_reporte++; motivos_sin_fecha[m.motivo_fecha] = (motivos_sin_fecha[m.motivo_fecha] || 0) + 1; continue; }
    const barra = barraDelMercado(m);
    if (!barra) { excluidos.sin_barra++; continue; }
    if (!m.av || m.av.estimated_eps === null) {
      excluidos.sin_estimado_av++;
      const k = m.motivo_av || 'estimado_nulo';
      motivos_sin_estimado[k] = (motivos_sin_estimado[k] || 0) + 1;
      continue;
    }
    const rep = horaDelReporte(m.fecha, m.hour, CRITERIOS_PM_DRIFT);
    const gap = gapCentavos(barra.valor, m.av.estimated_eps);
    const desc = consensoDeDescripcion(m.descripcion);
    universo.push({
      market_id: m.market_id, symbol: m.symbol, cosecha: m.cosecha, fecha: m.fecha, fuente_fecha: m.fuente_fecha,
      hora_efectiva: rep.hora_efectiva, hora_imputada: rep.imputada, reporte_ms: rep.ms,
      token: m.token, y: m.y, volume: m.volume,
      barra: barra.valor, barra_fuente: barra.fuente,
      consenso: m.av.estimated_eps, fiscal_quarter_end: m.av.fiscal_quarter_end,
      consenso_descripcion: desc ? desc.valor : null,
      gap, tramo: tramoGap(gap, C),
    });
  }
  const por_fuente_fecha = { tabla: universo.filter((m) => m.fuente_fecha === 'tabla').length, av_hist: universo.filter((m) => m.fuente_fecha === 'av_hist').length };
  return { universo, excluidos, motivos_sin_fecha, motivos_sin_estimado, por_fuente_fecha, filas: base.filas };
}

// ─────────────────── pruebas ───────────────────

// resultado ~ logit(p24) + 1[gap ≥ +1] + 1[gap ≤ −1]. Base: gap = 0.
const VARIABLES = Object.freeze(['logit_p24', 'gap_pos', 'gap_neg']);
function regresion(obs, C = CRITERIOS_PM_CENTAVOS2) {
  const v = obs.filter(valida);
  const r = logistica(v.map((o) => [logit(o.p24, C.logit_clip), o.gap >= 1 ? 1 : 0, o.gap <= -1 ? 1 : 0]), v.map((o) => o.y), v.map((o) => o.fecha));
  if (!r.convergio) return { n: v.length, convergio: false, motivo: r.motivo, coefs: null, gap_pos: null, gap_neg: null };
  const f = (x) => (x === null || x === undefined ? null : Number(x.toFixed(6)));
  const coefs = { intercepto: { coef: f(r.coef[0]), se: f(r.se[0]), t: f(r.t[0]) } };
  VARIABLES.forEach((k, i) => { coefs[k] = { coef: f(r.coef[i + 1]), se: f(r.se[i + 1]), t: f(r.t[i + 1]) }; });
  return { n: r.n, grupos: r.grupos, convergio: true, coefs, gap_pos: coefs.gap_pos, gap_neg: coefs.gap_neg };
}

// $1 al precio p24, costo fijo por operación. gap = 0 no apuesta.
//   gap ≥ +1 → No a (1 − p24): (1−y)/(1−p24) − 1
//   gap ≤ −1 → Yes a p24:      y/p24 − 1
function simulacion(obs, C = CRITERIOS_PM_CENTAVOS2) {
  const ops = [];
  for (const o of obs) {
    if (!valida(o)) continue;
    let lado = null;
    if (o.gap >= C.sim_no_si_gap_min && o.p24 < 1) lado = 'no';
    else if (o.gap <= C.sim_yes_si_gap_max && o.p24 > 0) lado = 'yes';
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

// Hipótesis previa (NO decide): Yes real − p24 en gap ≥ +1 y en gap ≤ −1.
function chequeaHipotesis(obs) {
  const v = obs.filter(valida);
  const grupo = (g, esperado) => {
    const tasa = media(g.map((o) => o.y));
    const p = media(g.map((o) => o.p24));
    const dif = tasa === null ? null : tasa - p;
    return { n: g.length, tasa_yes: tasa, p24_medio: p, diferencia: dif, se_cumple: dif === null ? null : esperado === 'arriba' ? dif > 0 : dif < 0 };
  };
  return { gap_pos: grupo(v.filter((o) => o.gap >= 1), 'abajo'), gap_neg: grupo(v.filter((o) => o.gap <= -1), 'arriba') };
}

// Informativo: cuánto se movió el consenso entre la creación (descripción) y
// el reporte (AV), en centavos.
function movimientoConsenso(universo) {
  const v = universo.filter((m) => m.consenso_descripcion !== null);
  const movs = v.map((m) => gapCentavos(m.consenso, m.consenso_descripcion));
  return { n: v.length, igual: movs.filter((x) => x === 0).length, subio: movs.filter((x) => x > 0).length, bajo: movs.filter((x) => x < 0).length };
}

// ─────────────────── veredicto ───────────────────

const ESTADOS = Object.freeze({
  FRONTERA: 'FALLA DE FRONTERA', INCOMPLETA: 'COBERTURA INCOMPLETA',
  INCONCLUSO: 'INCONCLUSO', GO: 'GO', FRAGIL: 'GO FRÁGIL', NOGO: 'NO-GO',
});

// Decide coef(1[gap ≥ +1]): negativo con t ≤ −2.5 (GO) o −2.5 < t ≤ −2
// (FRÁGIL), y simulación neta > 0 en ambas mitades. coef(gap ≤ −1) NO decide.
function veredicto({ n_gap_pos, regresion: r, mitad_antes: m1, mitad_despues: m2 }, C = CRITERIOS_PM_CENTAVOS2) {
  const g = r && r.convergio ? r.gap_pos : null;
  const cumple = {
    n_suficiente: n_gap_pos >= C.min_n_gap_pos,
    coef_negativo: !!(g && g.coef < 0),
    t: g ? g.t : null,
    sim_neta_antes: m1 ? m1.simulacion.neto_usd : null,
    sim_neta_despues: m2 ? m2.simulacion.neto_usd : null,
  };
  if (!cumple.n_suficiente) return { veredicto: ESTADOS.INCONCLUSO, motivo: `N(gap ≥ +1) = ${n_gap_pos} < ${C.min_n_gap_pos}`, cumple };
  const base = cumple.coef_negativo && cumple.t !== null && cumple.sim_neta_antes > 0 && cumple.sim_neta_despues > 0;
  if (base && cumple.t <= C.t_go) return { veredicto: ESTADOS.GO, motivo: `coef(gap ≥ +1) < 0 con t = ${cumple.t.toFixed(2)} ≤ ${C.t_go} y simulación neta > 0 en ambas mitades`, cumple };
  if (base && cumple.t <= C.t_fragil) return { veredicto: ESTADOS.FRAGIL, motivo: `coef(gap ≥ +1) < 0 con ${C.t_go} < t = ${cumple.t.toFixed(2)} ≤ ${C.t_fragil}`, cumple };
  const fallas = [];
  if (!(r && r.convergio)) fallas.push(`regresión sin convergencia (${r ? r.motivo : 'sin datos'})`);
  else if (!cumple.coef_negativo) fallas.push('coeficiente de gap ≥ +1 ≥ 0');
  else if (!(cumple.t <= C.t_fragil)) fallas.push(`t = ${cumple.t === null ? '—' : cumple.t.toFixed(2)} > ${C.t_fragil}`);
  if (!(cumple.sim_neta_antes > 0)) fallas.push('simulación neta ≤ 0 en la 1ª mitad');
  if (!(cumple.sim_neta_despues > 0)) fallas.push('simulación neta ≤ 0 en la 2ª mitad');
  return { veredicto: ESTADOS.NOGO, motivo: fallas.join('; '), cumple };
}

// ─────────────────── corrida ───────────────────

function corre({ universo, puntosPorId, estados, C = CRITERIOS_PM_CENTAVOS2 }) {
  const obs = [];
  const obsPorId = new Map();
  let puntosTotales = 0;
  for (const m of universo) {
    if (estados.get(m.market_id) !== 'ok') continue;
    const pts = puntosPorId.get(m.market_id) || [];
    puntosTotales += pts.length;
    const o = { ...observacion(m, pts, C), fuente_fecha: m.fuente_fecha };
    obs.push(o);
    obsPorId.set(m.market_id, o);
  }
  const cob = cobertura(universo, obsPorId, estados);
  cob.puntos_totales = puntosTotales;
  const movimiento_consenso = movimientoConsenso(universo);
  if (!universo.length) return { estado: ESTADOS.FRONTERA, motivo: 'universo vacío: no hay mercados resueltos con liquidez, barra, fecha y estimado de AV', cobertura: cob, movimiento_consenso, obs };
  if (puntosTotales === 0 && cob.pendiente_descarga === 0) return { estado: ESTADOS.FRONTERA, motivo: 'cero puntos de precio del CLOB para todo el universo', cobertura: cob, movimiento_consenso, obs };
  if (cob.pendiente_descarga > 0) return { estado: ESTADOS.INCOMPLETA, motivo: `faltan ${cob.pendiente_descarga} historiales por bajar: vuelve a abrir el link`, cobertura: cob, movimiento_consenso, obs };

  const validas = obs.filter(valida);
  const m = mitades(validas);
  const ordenFecha = (g) => [...g].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const mitad = (g) => {
    const o = ordenFecha(g);
    return { n: o.length, desde: o.length ? o[0].fecha : null, hasta: o.length ? o[o.length - 1].fecha : null,
      n_gap_pos: o.filter((x) => x.gap >= 1).length, regresion: regresion(o, C), simulacion: simulacion(o, C) };
  };
  const res = {
    n_validas: validas.length,
    n_gap_pos: validas.filter((o) => o.gap >= 1).length,
    n_gap0: validas.filter((o) => o.gap === 0).length,
    n_gap_neg: validas.filter((o) => o.gap <= -1).length,
    por_fuente_fecha: { tabla: validas.filter((o) => o.fuente_fecha === 'tabla').length, av_hist: validas.filter((o) => o.fuente_fecha === 'av_hist').length },
    tabla: tablaGap(validas, C),                    // reporta, NO decide
    regresion: regresion(validas, C),
    simulacion: simulacion(validas, C),
    mediana_fecha: m.mediana,
    mitad_antes: mitad(m.antes),
    mitad_despues: mitad(m.despues),
    hipotesis_previa: { texto: C.hipotesis_previa, ...chequeaHipotesis(validas) },   // NO decide
    movimiento_consenso,
  };
  const v = veredicto(res, C);
  return { estado: v.veredicto, motivo: v.motivo, cumple: v.cumple, cobertura: cob, ...res, obs };
}

// ─────────────────── markdown ───────────────────

const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%');
const pp = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pts');
const f2 = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const usd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toFixed(2));
const kv = (o) => Object.entries(o || {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';

function renderResumenMarkdown(s) {
  const L = [];
  const C = s.criterios || CRITERIOS_PM_CENTAVOS2;
  const r = s.resultado || {};
  const c = r.cobertura || {};
  const u = s.universo || {};
  L.push('# PM-CENTAVOS2 — barra − consenso FINAL de Alpha Vantage, en centavos');
  L.push('');
  L.push(`Generado: ${s.generado_en}`);
  L.push('');
  L.push(`## Estado: **${r.estado}**${s.solo_cobertura ? ' (modo cobertura: sin veredicto)' : ''}`);
  if (r.motivo) L.push(`> ${r.motivo}`);
  L.push('');
  L.push(`Hipótesis previa registrada: ${C.hipotesis_previa}`);
  L.push('');
  L.push('## Universo');
  L.push(`- Filas leídas (v2 ∪ v1): **${u.filas ?? '—'}** → universo: **${c.universo ?? '—'}**`);
  if (u.excluidos) L.push(`- Excluidos: ${kv(u.excluidos)}`);
  if (u.motivos_sin_fecha) L.push(`- Sin fecha de reporte, por qué: ${kv(u.motivos_sin_fecha)}`);
  if (u.motivos_sin_estimado) L.push(`- Sin estimatedEPS de AV, por qué: ${kv(u.motivos_sin_estimado)}`);
  if (u.por_fuente_fecha) L.push(`- Fecha de reporte: tabla ${u.por_fuente_fecha.tabla} · av_hist ${u.por_fuente_fecha.av_hist}`);
  L.push(`- Sin hora de reporte (imputados AMC 16:00 ET): ${c.sin_hora_imputada_amc ?? '—'}`);
  L.push('');
  L.push('## Cobertura del precio a T-24h');
  if (s.descarga) {
    const d = s.descarga;
    L.push(`- Esta corrida bajó: ${d.intentados} intentos · ${d.ok} ok (${d.vacios} vacíos) · ${d.errores} errores · ${d.puntos} puntos${d.ratelimit ? ' · **cortado por 429**' : ''}${d.por_presupuesto ? ` · ${d.por_presupuesto} quedan para la próxima` : ''}`);
  }
  const fp = c.faltan_p24 || {};
  L.push(`- Con p24: **${c.con_p24 ?? '—'}** · sin p24: sin historial ${fp.sin_historial || 0} · sin punto anterior ${fp.sin_punto_anterior || 0} · hueco > 3h ${fp.hueco_mayor_3h || 0}`);
  L.push(`- Pendientes de bajar: ${c.pendiente_descarga ?? '—'} · error de descarga: ${c.error_descarga ?? '—'} · puntos en caché: ${c.puntos_totales ?? '—'}`);
  const mc = r.movimiento_consenso;
  if (mc) L.push(`- Consenso de la descripción → AV final (informativo): N ${mc.n} · igual ${mc.igual} · subió ${mc.subio} · bajó ${mc.bajo}`);
  L.push('');
  if (s.solo_cobertura || !r.tabla) {
    L.push('_Sin resultados en este modo/estado. Los criterios están congelados en `CRITERIOS_PM_CENTAVOS2`._');
    return L.join('\n');
  }
  L.push(`## a) Tabla por gap (barra − estimatedEPS AV, centavos; empate = No) — se reporta, NO decide`);
  L.push(`N ${r.n_validas} (tabla ${r.por_fuente_fecha.tabla} · av_hist ${r.por_fuente_fecha.av_hist}) · gap ≥ +1: ${r.n_gap_pos} · gap = 0: ${r.n_gap0} · gap ≤ −1: ${r.n_gap_neg}`);
  L.push('');
  L.push('| gap | N | % Yes real | p24 medio | Yes real − p24 |');
  L.push('|---|---|---|---|---|');
  for (const t of r.tabla) L.push(`| ${t.tramo} | ${t.n} | ${pct(t.tasa_yes)} | ${pct(t.p24_medio)} | ${pp(t.diferencia)} |`);
  L.push('');
  const coef = (x) => (x ? `coef ${f2(x.coef, 4)} · se ${f2(x.se, 4)} · **t ${f2(x.t)}**` : '—');
  const reg = (x, pre = '') => {
    if (!x || !x.convergio) return [`${pre}- sin convergencia (${x ? x.motivo : '—'}) · N ${x ? x.n : 0}`];
    return [
      `${pre}- N ${x.n} · grupos (fechas) ${x.grupos}`,
      `${pre}- 1[gap ≥ +1] (decide): ${coef(x.coefs.gap_pos)}`,
      `${pre}- 1[gap ≤ −1] (se reporta, no decide): ${coef(x.coefs.gap_neg)}`,
      `${pre}- logit(p24): ${coef(x.coefs.logit_p24)} · intercepto ${f2(x.coefs.intercepto.coef, 4)}`,
    ];
  };
  L.push('## b) Regresión logística: resultado ~ logit(p24) + 1[gap ≥ +1] + 1[gap ≤ −1]');
  L.push('Base: gap = 0. Errores agrupados por fecha de reporte.');
  L.push(...reg(r.regresion));
  L.push('');
  const sim = (x) => `${x.operaciones} ops (No ${x.compra_no.n}: ${x.compra_no.aciertos} aciertos, ${usd(x.compra_no.neto_usd)} · Yes ${x.compra_yes.n}: ${x.compra_yes.aciertos} aciertos, ${usd(x.compra_yes.neto_usd)}) · bruto ${usd(x.bruto_usd)} · costos ${usd(-x.costos_usd)} · **neto ${usd(x.neto_usd)}** (${f2(x.neto_por_apuesta, 4)}/apuesta)`;
  L.push(`## c) Simulación en papel ($${C.apuesta_usd}/apuesta, $${C.costo_por_operacion_usd} por operación)`);
  L.push('- Reglas: gap ≥ +1 → No a (1 − p24); gap ≤ −1 → Yes a p24; gap = 0 → no se apuesta.');
  L.push(`- Todo: ${sim(r.simulacion)}`);
  L.push('');
  L.push(`## d) Fuera de muestra (mediana de fecha: ${r.mediana_fecha})`);
  for (const [nom, m] of [['1ª mitad (≤ mediana)', r.mitad_antes], ['2ª mitad (> mediana)', r.mitad_despues]]) {
    L.push(`- **${nom}** — N ${m.n} · gap ≥ +1: ${m.n_gap_pos} · ${m.desde || '—'} → ${m.hasta || '—'}`);
    L.push('  - regresión:');
    L.push(...reg(m.regresion, '    '));
    L.push(`  - simulación: ${sim(m.simulacion)}`);
  }
  L.push('');
  const h = r.hipotesis_previa || {};
  const lin = (nom, g, esp) => `- ${nom}: N ${g.n} · % Yes real ${pct(g.tasa_yes)} vs p24 medio ${pct(g.p24_medio)} (${pp(g.diferencia)}) → ${g.se_cumple === null ? '—' : g.se_cumple ? `✅ ${esp}, como se esperaba` : `❌ no está ${esp}`}`;
  L.push('## Hipótesis previa (se reporta, NO decide)');
  if (h.gap_pos) L.push(lin('gap ≥ +1', h.gap_pos, 'por debajo'));
  if (h.gap_neg) L.push(lin('gap ≤ −1', h.gap_neg, 'por arriba'));
  L.push('');
  L.push('## Veredicto');
  const k = r.cumple || {};
  L.push(`- N(gap ≥ +1) ≥ ${C.min_n_gap_pos}: ${k.n_suficiente ? '✅' : '❌'} (${r.n_gap_pos})`);
  L.push(`- coef(gap ≥ +1) < 0: ${k.coef_negativo ? '✅' : '❌'} · t = ${f2(k.t)} (GO t ≤ ${C.t_go}; FRÁGIL t ≤ ${C.t_fragil})`);
  L.push(`- simulación neta > 0 en ambas mitades: ${k.sim_neta_antes > 0 ? '✅' : '❌'} ${usd(k.sim_neta_antes)} / ${k.sim_neta_despues > 0 ? '✅' : '❌'} ${usd(k.sim_neta_despues)}`);
  L.push('');
  L.push(`**${r.estado}** — ${r.motivo}`);
  L.push('');
  L.push('_Limitación: estimatedEPS es el consenso al día del reporte; se asume que a T-24h ya era prácticamente ese número. Un GO se confirma hacia adelante con pm_v2_consenso_snap._');
  L.push('');
  L.push('_Criterios congelados antes de correr (`CRITERIOS_PM_CENTAVOS2` en `api/_lib/pm-centavos2-analyze.js`, pineados por test). Ver docs/pm-centavos2-scope.md._');
  return L.join('\n');
}

export {
  CRITERIOS_PM_CENTAVOS2, ESTADOS, VARIABLES,
  construyeUniverso, regresion, simulacion, chequeaHipotesis, movimientoConsenso, veredicto, corre, renderResumenMarkdown,
};
