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
// Criterios IGUALES a PM-CENTAVOS: se reusa CRITERIOS_PM_CENTAVOS valor por
// valor (el test lo exige) y sus funciones (tabla, regresión, simulación,
// mitades, veredicto). Lo único propio: el texto de la hipótesis previa y su
// chequeo, que se reporta y NO decide. Ver docs/pm-centavos2-scope.md.
//
// PM-CENTAVOS no se toca. Este archivo es PURO.
// ═══════════════════════════════════════════════════════════════════

import { CRITERIOS_PM_DRIFT, horaDelReporte } from './pm-drift-analyze.js';
import {
  CRITERIOS_PM_CENTAVOS, barraDelMercado, consensoDeDescripcion, gapCentavos, tramoGap, corre as correCentavos,
} from './pm-centavos-analyze.js';

const CRITERIOS_PM_CENTAVOS2 = Object.freeze({
  ...CRITERIOS_PM_CENTAVOS,
  hipotesis_previa: 'Con el consenso FINAL de AV: gap ≤ 0 (consenso igual o arriba de la barra) → el % real de Yes está POR ENCIMA del precio; gap ≥ +1 (barra arriba del consenso) → POR DEBAJO.',
});

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

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

// Hipótesis previa (NO decide): Yes real − p24 en gap ≤ 0 y en gap ≥ +1.
function chequeaHipotesis(obs) {
  const v = obs.filter((o) => o.p24 !== null && o.gap !== null);
  const grupo = (g, esperado) => {
    const tasa = media(g.map((o) => o.y));
    const p = media(g.map((o) => o.p24));
    const dif = tasa === null ? null : tasa - p;
    return { n: g.length, tasa_yes: tasa, p24_medio: p, diferencia: dif, se_cumple: dif === null ? null : esperado === 'arriba' ? dif > 0 : dif < 0 };
  };
  return { gap_le_0: grupo(v.filter((o) => o.gap <= 0), 'arriba'), gap_ge_1: grupo(v.filter((o) => o.gap >= 1), 'abajo') };
}

// Informativo: cuánto se movió el consenso entre la creación (descripción) y
// el reporte (AV), en centavos.
function movimientoConsenso(universo) {
  const v = universo.filter((m) => m.consenso_descripcion !== null);
  const movs = v.map((m) => gapCentavos(m.consenso, m.consenso_descripcion));
  return { n: v.length, igual: movs.filter((x) => x === 0).length, subio: movs.filter((x) => x > 0).length, bajo: movs.filter((x) => x < 0).length };
}

function corre({ universo, puntosPorId, estados, C = CRITERIOS_PM_CENTAVOS2 }) {
  const r = correCentavos({ universo, puntosPorId, estados, C });
  if (r.tabla) r.hipotesis_previa = { texto: C.hipotesis_previa, ...chequeaHipotesis(r.obs) };
  r.movimiento_consenso = movimientoConsenso(universo);
  const fuente = new Map(universo.map((m) => [m.market_id, m.fuente_fecha]));
  const validas = r.obs.filter((o) => o.p24 !== null && o.gap !== null);
  r.por_fuente_fecha = {
    tabla: validas.filter((o) => fuente.get(o.market_id) === 'tabla').length,
    av_hist: validas.filter((o) => fuente.get(o.market_id) === 'av_hist').length,
  };
  return r;
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
    L.push('_Sin resultados en este modo/estado. Criterios = `CRITERIOS_PM_CENTAVOS` (congelados)._');
    return L.join('\n');
  }
  L.push(`## a) Tabla por gap (barra − estimatedEPS AV, centavos; empate = No) — N ${r.n_validas} (tabla ${r.por_fuente_fecha.tabla} · av_hist ${r.por_fuente_fecha.av_hist})`);
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
  L.push(`- Reglas (las de PM-CENTAVOS): gap = 0 y p24 ≥ ${C.sim_no_p24_min.toFixed(2)} → No a (1 − p24); gap ≤ −1 y p24 ≤ ${C.sim_yes_p24_max.toFixed(2)} → Yes a p24.`);
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
  const lin = (nom, g, esp) => `- ${nom}: N ${g.n} · % Yes real ${pct(g.tasa_yes)} vs p24 medio ${pct(g.p24_medio)} (${pp(g.diferencia)}) → ${g.se_cumple === null ? '—' : g.se_cumple ? `✅ ${esp}, como se esperaba` : `❌ no está ${esp}`}`;
  L.push('## Hipótesis previa (se reporta, NO decide)');
  if (h.gap_le_0) L.push(lin('gap ≤ 0', h.gap_le_0, 'por encima'));
  if (h.gap_ge_1) L.push(lin('gap ≥ +1', h.gap_ge_1, 'por debajo'));
  L.push('');
  L.push('## Veredicto (criterios de PM-CENTAVOS)');
  const k = r.cumple || {};
  L.push(`- N(gap = 0) ≥ ${C.min_n_gap0}: ${k.n_suficiente ? '✅' : '❌'} (${r.n_gap0})`);
  L.push(`- coef(gap = 0) < 0: ${k.coef_negativo ? '✅' : '❌'} · t = ${f2(k.t)} (GO |t| ≥ ${C.t_go}; FRÁGIL |t| ≥ ${C.t_fragil})`);
  L.push(`- simulación neta > 0 en ambas mitades: ${k.sim_neta_antes > 0 ? '✅' : '❌'} ${usd(k.sim_neta_antes)} / ${k.sim_neta_despues > 0 ? '✅' : '❌'} ${usd(k.sim_neta_despues)}`);
  L.push('');
  L.push(`**${r.estado}** — ${r.motivo}`);
  L.push('');
  L.push('_Criterios congelados antes de correr: los de `CRITERIOS_PM_CENTAVOS`, reusados en `CRITERIOS_PM_CENTAVOS2` (pineado por test). Ver docs/pm-centavos2-scope.md._');
  return L.join('\n');
}

export { CRITERIOS_PM_CENTAVOS2, construyeUniverso, chequeaHipotesis, movimientoConsenso, corre, renderResumenMarkdown };
