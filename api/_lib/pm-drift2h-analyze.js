// ═══════════════════════════════════════════════════════════════════
// api/_lib/pm-drift2h-analyze.js — "PM-DRIFT2H", backtest pre-registrado.
//
// PM-DRIFT (#350) reportó Δ2 = p(T-2h) − p(T-24h) como secundario, pero
// controlando por logit(p24): eso pregunta si Δ2 agrega algo a un precio
// VIEJO. La pregunta bien hecha es contra el último precio disponible:
//
//   resultado ~ logit(p2h) + Δ2
//
// sin los mercados con hora de reporte imputada (con hora imputada, el T-2h
// de un BMO real cae después del reporte), y la simulación compra A PRECIO
// p2h. Ver docs/pm-drift2h-scope.md.
//
// Precios: la caché, la regla (punto anterior, hueco ≤ 3h) y la hora del
// reporte de PM-DRIFT, importadas. Fechas: las de la tabla o, si no hay, las
// de pm_v2_hist (pm-trimestre-av.js). PM-DRIFT no se toca. PURO.
//
// CRITERIOS_PM_DRIFT2H se fijó ANTES de correr y el test lo pinea.
// ═══════════════════════════════════════════════════════════════════

import {
  CRITERIOS_PM_DRIFT, horaDelReporte, observacion as observacionDrift, logit, logistica,
} from './pm-drift-analyze.js';

const CRITERIOS_PM_DRIFT2H = Object.freeze({
  min_volumen_usd: 500,
  excluir_hora_imputada: true,
  umbral_drift_pts: 5,                // Δ2 ≥ +5 → Yes a p2h; Δ2 ≤ −5 → No a (1 − p2h)
  apuesta_usd: 1,
  costo_por_operacion_usd: 0.02,
  logit_clip: 0.01,
  min_n: 150,                         // N con Δ2 válido (sin hora imputada)
  t_go: 2.5,                          // coef Δ2 > 0 con t ≥ 2.5
  hipotesis_previa: 'NO-GO (Claude, chat): esperamos que p2h ya incluya el movimiento de las últimas 22 horas.',
});

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// base = baseMercados(...) de pm-trimestre-av.js.
function construyeUniverso(base, C = CRITERIOS_PM_DRIFT2H) {
  const universo = [];
  const excluidos = { ...base.excluidos, sin_fecha_reporte: 0, hora_imputada: 0 };
  for (const m of base.mercados) {
    if (!m.fecha) { excluidos.sin_fecha_reporte++; continue; }
    const rep = horaDelReporte(m.fecha, m.hour, CRITERIOS_PM_DRIFT);
    if (C.excluir_hora_imputada && rep.imputada) { excluidos.hora_imputada++; continue; }
    universo.push({
      market_id: m.market_id, symbol: m.symbol, cosecha: m.cosecha, fecha: m.fecha, fuente_fecha: m.fuente_fecha,
      hora: m.hour, hora_efectiva: rep.hora_efectiva, hora_imputada: rep.imputada, reporte_ms: rep.ms,
      token: m.token, y: m.y, volume: m.volume,
    });
  }
  return { universo, excluidos, filas: base.filas,
    por_fuente_fecha: { tabla: universo.filter((m) => m.fuente_fecha === 'tabla').length, av_hist: universo.filter((m) => m.fuente_fecha === 'av_hist').length } };
}

const valida = (o) => o.p2 !== null && o.d2 !== null;

function regresion(obs, C = CRITERIOS_PM_DRIFT2H) {
  const v = obs.filter(valida);
  const r = logistica(v.map((o) => [logit(o.p2, C.logit_clip), o.d2]), v.map((o) => o.y), v.map((o) => o.fecha));
  if (!r.convergio) return { n: v.length, convergio: false, motivo: r.motivo, coef: null, se: null, t: null };
  const f = (x) => (x === null ? null : Number(x.toFixed(6)));
  return { n: r.n, grupos: r.grupos, convergio: true, intercepto: f(r.coef[0]), coef_logit_p2: f(r.coef[1]),
    coef: f(r.coef[2]), se: f(r.se[2]), t: r.t[2] === null ? null : f(r.t[2]) };
}

// $1 al precio p2h; costo fijo por operación.
//   Δ2 ≥ +u → Yes a p2h: y/p2 − 1 ;  Δ2 ≤ −u → No a (1 − p2h): (1−y)/(1−p2) − 1
function simulacion(obs, C = CRITERIOS_PM_DRIFT2H) {
  const u = C.umbral_drift_pts;
  const ops = [];
  for (const o of obs) {
    if (!valida(o)) continue;
    let lado = null;
    if (o.d2 >= u && o.p2 > 0) lado = 'yes';
    else if (o.d2 <= -u && o.p2 < 1) lado = 'no';
    if (!lado) continue;
    const bruto = lado === 'yes' ? C.apuesta_usd * (o.y / o.p2 - 1) : C.apuesta_usd * ((1 - o.y) / (1 - o.p2) - 1);
    ops.push({ lado, bruto, neto: bruto - C.costo_por_operacion_usd, gana: lado === 'yes' ? o.y === 1 : o.y === 0 });
  }
  const s = (k) => ops.reduce((a, x) => a + x[k], 0);
  return {
    operaciones: ops.length,
    compra_yes: ops.filter((x) => x.lado === 'yes').length,
    compra_no: ops.filter((x) => x.lado === 'no').length,
    aciertos: ops.filter((x) => x.gana).length,
    bruto_usd: Number(s('bruto').toFixed(4)),
    costos_usd: Number((ops.length * C.costo_por_operacion_usd).toFixed(4)),
    neto_usd: Number(s('neto').toFixed(4)),
    neto_por_apuesta: ops.length ? Number((s('neto') / ops.length).toFixed(4)) : null,
  };
}

// Mitades: la regla de PM-DRIFT (mediana = fecha del medio, la menor si N es
// par; 1ª = ≤ mediana), sobre las observaciones con Δ2.
function mitades(obs) {
  const v = obs.filter(valida);
  if (!v.length) return { mediana: null, antes: [], despues: [] };
  const fechas = v.map((o) => o.fecha).sort();
  const mediana = fechas[Math.floor((fechas.length - 1) / 2)];
  return { mediana, antes: v.filter((o) => o.fecha <= mediana), despues: v.filter((o) => o.fecha > mediana) };
}

const ESTADOS = Object.freeze({ FRONTERA: 'FALLA DE FRONTERA', INCOMPLETA: 'COBERTURA INCOMPLETA', INCONCLUSO: 'INCONCLUSO', GO: 'GO', NOGO: 'NO-GO' });

// GO solo si coef Δ2 > 0 con t ≥ 2.5 Y neto > 0 en ambas mitades. Sin GO FRÁGIL.
function veredicto({ n, regresion: r, mitad_antes: m1, mitad_despues: m2 }, C = CRITERIOS_PM_DRIFT2H) {
  const cumple = {
    n_suficiente: n >= C.min_n,
    t: r && r.convergio ? r.t : null,
    sim_neta_antes: m1 ? m1.simulacion.neto_usd : null,
    sim_neta_despues: m2 ? m2.simulacion.neto_usd : null,
  };
  if (!cumple.n_suficiente) return { veredicto: ESTADOS.INCONCLUSO, motivo: `N con Δ2 válido = ${n} < ${C.min_n}`, cumple };
  const ok = r && r.convergio && r.coef > 0 && r.t >= C.t_go && cumple.sim_neta_antes > 0 && cumple.sim_neta_despues > 0;
  if (ok) return { veredicto: ESTADOS.GO, motivo: `t = ${r.t.toFixed(2)} ≥ ${C.t_go} y neto > 0 en ambas mitades`, cumple };
  const fallas = [];
  if (!(r && r.convergio)) fallas.push(`regresión sin convergencia (${r ? r.motivo : 'sin datos'})`);
  else if (!(r.t >= C.t_go)) fallas.push(`t = ${r.t === null ? '—' : r.t.toFixed(2)} < ${C.t_go}`);
  if (!(cumple.sim_neta_antes > 0)) fallas.push('simulación neta ≤ 0 en la 1ª mitad');
  if (!(cumple.sim_neta_despues > 0)) fallas.push('simulación neta ≤ 0 en la 2ª mitad');
  return { veredicto: ESTADOS.NOGO, motivo: fallas.join('; '), cumple };
}

function cobertura(universo, obsPorId, estados) {
  const c = { universo: universo.length, con_p2: 0, con_p24: 0, con_delta2: 0, pendiente_descarga: 0, error_descarga: 0,
    faltan: { t24: {}, t2: {} }, puntos_totales: 0 };
  for (const m of universo) {
    const est = estados.get(m.market_id);
    if (!est) { c.pendiente_descarga++; continue; }
    if (est !== 'ok') { c.error_descarga++; continue; }
    const o = obsPorId.get(m.market_id);
    if (!o) continue;
    if (o.p2 !== null) c.con_p2++;
    if (o.p24 !== null) c.con_p24++;
    if (o.d2 !== null) c.con_delta2++;
    if (o.motivo24) c.faltan.t24[o.motivo24] = (c.faltan.t24[o.motivo24] || 0) + 1;
    if (o.motivo2) c.faltan.t2[o.motivo2] = (c.faltan.t2[o.motivo2] || 0) + 1;
  }
  return c;
}

function corre({ universo, puntosPorId, estados, C = CRITERIOS_PM_DRIFT2H }) {
  const obs = [];
  const obsPorId = new Map();
  let puntosTotales = 0;
  for (const m of universo) {
    if (estados.get(m.market_id) !== 'ok') continue;
    const pts = puntosPorId.get(m.market_id) || [];
    puntosTotales += pts.length;
    const o = { ...observacionDrift(m, pts, CRITERIOS_PM_DRIFT), fuente_fecha: m.fuente_fecha };
    obs.push(o);
    obsPorId.set(m.market_id, o);
  }
  const cob = cobertura(universo, obsPorId, estados);
  cob.puntos_totales = puntosTotales;
  if (!universo.length) return { estado: ESTADOS.FRONTERA, motivo: 'universo vacío: no hay mercados resueltos con liquidez, fecha y hora de reporte', cobertura: cob, obs };
  if (puntosTotales === 0 && cob.pendiente_descarga === 0) return { estado: ESTADOS.FRONTERA, motivo: 'cero puntos de precio del CLOB para todo el universo', cobertura: cob, obs };
  if (cob.pendiente_descarga > 0) return { estado: ESTADOS.INCOMPLETA, motivo: `faltan ${cob.pendiente_descarga} historiales por bajar: vuelve a abrir el link`, cobertura: cob, obs };

  const v = obs.filter(valida);
  const m = mitades(v);
  const orden = (g) => [...g].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const mitad = (g) => { const o = orden(g); return { n: o.length, desde: o.length ? o[0].fecha : null, hasta: o.length ? o[o.length - 1].fecha : null, regresion: regresion(o, C), simulacion: simulacion(o, C) }; };
  const res = {
    n: v.length,
    por_fuente_fecha: { tabla: v.filter((o) => o.fuente_fecha === 'tabla').length, av_hist: v.filter((o) => o.fuente_fecha === 'av_hist').length },
    delta2_medio: media(v.map((o) => o.d2)),
    regresion: regresion(v, C),
    simulacion: simulacion(v, C),
    mediana_fecha: m.mediana,
    mitad_antes: mitad(m.antes),
    mitad_despues: mitad(m.despues),
    // Referencia, NO decide: la especificación vieja de PM-DRIFT (logit(p24) + Δ2) sobre esta muestra.
    referencia_logit_p24: (() => {
      const r = logistica(v.map((o) => [logit(o.p24, C.logit_clip), o.d2]), v.map((o) => o.y), v.map((o) => o.fecha));
      return r.convergio ? { coef: Number(r.coef[2].toFixed(6)), t: r.t[2] === null ? null : Number(r.t[2].toFixed(6)), n: r.n } : { convergio: false, motivo: r.motivo };
    })(),
  };
  const ver = veredicto(res, C);
  return { estado: ver.veredicto, motivo: ver.motivo, cumple: ver.cumple, cobertura: cob, ...res, obs };
}

// ─────────────────── markdown ───────────────────

const f2 = (x, d = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const usd = (x) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toFixed(2));
const kv = (o) => Object.entries(o || {}).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';

function renderResumenMarkdown(s) {
  const L = [];
  const C = s.criterios || CRITERIOS_PM_DRIFT2H;
  const r = s.resultado || {};
  const c = r.cobertura || {};
  const u = s.universo || {};
  L.push('# PM-DRIFT2H — resultado ~ logit(p2h) + Δ2, sin horas imputadas');
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
  if (u.por_fuente_fecha) L.push(`- Fecha de reporte: tabla ${u.por_fuente_fecha.tabla} · av_hist ${u.por_fuente_fecha.av_hist}`);
  L.push('');
  L.push('## Cobertura');
  if (s.descarga) {
    const d = s.descarga;
    L.push(`- Esta corrida bajó: ${d.intentados} intentos · ${d.ok} ok (${d.vacios} vacíos) · ${d.errores} errores · ${d.puntos} puntos${d.ratelimit ? ' · **cortado por 429**' : ''}${d.por_presupuesto ? ` · ${d.por_presupuesto} quedan para la próxima` : ''}`);
  }
  L.push(`- Con p2h: ${c.con_p2 ?? '—'} · con p24: ${c.con_p24 ?? '—'} · **con Δ2: ${c.con_delta2 ?? '—'}** (mínimo ${C.min_n})`);
  L.push(`- Faltan p24: ${kv(c.faltan && c.faltan.t24)} · faltan p2h: ${kv(c.faltan && c.faltan.t2)}`);
  L.push(`- Pendientes de bajar: ${c.pendiente_descarga ?? '—'} · error de descarga: ${c.error_descarga ?? '—'} · puntos en caché: ${c.puntos_totales ?? '—'}`);
  L.push('');
  if (s.solo_cobertura || !r.regresion) {
    L.push('_Sin resultados en este modo/estado. Los criterios están congelados en `CRITERIOS_PM_DRIFT2H`._');
    return L.join('\n');
  }
  const reg = (x) => (x && x.convergio ? `coef ${f2(x.coef, 4)} · se ${f2(x.se, 4)} · **t ${f2(x.t)}** · N ${x.n} · grupos ${x.grupos}` : `sin convergencia (${x ? x.motivo : '—'}) · N ${x ? x.n : 0}`);
  L.push(`## a) Regresión logística: resultado ~ logit(p2h) + Δ2 — N ${r.n} (tabla ${r.por_fuente_fecha.tabla} · av_hist ${r.por_fuente_fecha.av_hist}) · Δ2 medio ${f2(r.delta2_medio)} pts`);
  L.push(`- Δ2 (por punto): ${reg(r.regresion)}`);
  if (r.regresion.convergio) L.push(`- logit(p2h): ${f2(r.regresion.coef_logit_p2, 4)} · intercepto ${f2(r.regresion.intercepto, 4)}`);
  L.push('- Errores agrupados por fecha de reporte.');
  const ref = r.referencia_logit_p24 || {};
  L.push(`- Referencia (NO decide), especificación vieja logit(p24) + Δ2 en esta muestra: ${ref.convergio === false ? `sin convergencia (${ref.motivo})` : `coef ${f2(ref.coef, 4)} · t ${f2(ref.t)}`}`);
  L.push('');
  const sim = (x) => `${x.operaciones} ops (${x.compra_yes} Yes / ${x.compra_no} No) · aciertos ${x.aciertos} · bruto ${usd(x.bruto_usd)} · costos ${usd(-x.costos_usd)} · **neto ${usd(x.neto_usd)}** (${f2(x.neto_por_apuesta, 4)}/apuesta)`;
  L.push(`## b) Simulación a precio p2h (Δ2 ≥ +${C.umbral_drift_pts} → Yes; Δ2 ≤ −${C.umbral_drift_pts} → No; $${C.apuesta_usd}/apuesta, $${C.costo_por_operacion_usd} por operación)`);
  L.push(`- Todo: ${sim(r.simulacion)}`);
  L.push('');
  L.push(`## c) Fuera de muestra (mediana de fecha: ${r.mediana_fecha})`);
  for (const [nom, m] of [['1ª mitad (≤ mediana)', r.mitad_antes], ['2ª mitad (> mediana)', r.mitad_despues]]) {
    L.push(`- **${nom}** — N ${m.n} · ${m.desde || '—'} → ${m.hasta || '—'}`);
    L.push(`  - regresión: ${reg(m.regresion)}`);
    L.push(`  - simulación: ${sim(m.simulacion)}`);
  }
  L.push('');
  L.push('## Veredicto');
  const k = r.cumple || {};
  L.push(`- N con Δ2 ≥ ${C.min_n}: ${k.n_suficiente ? '✅' : '❌'} (${r.n})`);
  L.push(`- coef Δ2 > 0 con t ≥ ${C.t_go}: ${r.regresion.convergio && r.regresion.coef > 0 && r.regresion.t >= C.t_go ? '✅' : '❌'} (t = ${f2(k.t)})`);
  L.push(`- neto > 0 en ambas mitades: ${k.sim_neta_antes > 0 ? '✅' : '❌'} ${usd(k.sim_neta_antes)} / ${k.sim_neta_despues > 0 ? '✅' : '❌'} ${usd(k.sim_neta_despues)}`);
  L.push('');
  L.push(`**${r.estado}** — ${r.motivo}`);
  L.push('');
  L.push('_Criterios congelados antes de correr (`CRITERIOS_PM_DRIFT2H` en `api/_lib/pm-drift2h-analyze.js`, pineados por test). Ver docs/pm-drift2h-scope.md._');
  return L.join('\n');
}

export { CRITERIOS_PM_DRIFT2H, ESTADOS, construyeUniverso, regresion, simulacion, mitades, veredicto, cobertura, corre, renderResumenMarkdown };
