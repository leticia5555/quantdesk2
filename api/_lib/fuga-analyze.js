// ═══════════════════════════════════════════════════════════════════
// api/_lib/fuga-analyze.js — "FUGA PRE-EARNINGS" (sexto backtest de la serie)
//
// Pregunta pre-registrada (docs/fuga-backtest-scope.md): si una acción le gana
// al SPY por ≥6% en las 5 sesiones previas a su reporte, ¿eso predice la
// reacción AL reporte (H1, "alguien sabe algo")? Nula: la reacción es
// independiente del run-up; lo que haya es momentum de corto plazo o ruido.
//
// Lógica PURA (cero I/O): recibe eventos de `pead_earnings` + horas de
// `pead_event_hour` + series diarias ajustadas de Yahoo ya alineadas al
// calendario de SPY, y devuelve el veredicto contra CRITERIOS_FUGA, congelados
// ANTES de correr. El endpoint /api/fuga-analyze solo hace de plomería.
//
// ── La única especificación principal ──────────────────────────────
//   D (detección) = última sesión cuyo CIERRE ocurre ANTES del anuncio.
//                   BMO → última sesión < E ;  AMC → última sesión ≤ E.
//   Salida        = primer cierre DESPUÉS del anuncio.
//                   BMO → primera sesión ≥ E ; AMC → primera sesión > E.
//                   (E = reported_date; en fin de semana/feriado las dos
//                   reglas caen solas en la sesión correcta.)
//   DMH           → como BMO: el anuncio salió con el mercado abierto, así
//                   que el cierre de E ya lo incorpora. Tratarlo como AMC
//                   (lo que hace el PEAD para su entrada AL OPEN) metería
//                   look-ahead acá, porque la señal usaría el cierre de E.
//   Sin hora      → como AMC en la principal (convención del encargo).
//                   OJO: en este backtest AMC NO es la opción conservadora
//                   (si el reporte en realidad fue BMO, el cierre de E ya
//                   vio el anuncio). Por eso la sensibilidad "sin hora
//                   descartados" es obligatoria y el reporte cuenta cuántos
//                   eventos llevan hora imputada.
//   Señal         = excess_k = ret(acción, D−k→D) − ret(SPY, D−k→D), k = 5.
//   Grupos        = SEÑAL excess ≥ +6% · CONTROL |excess| < 2% ·
//                   CORTO excess ≤ −6% (informativo, no decide).
//   Métrica       = reacción anormal = ret(acción) − ret(SPY), cierre D →
//                   cierre de salida (1 sesión).
//   Costos        = 10 bp por lado sobre el lado largo:
//                   neto = close_s·(1−c) / (close_D·(1+c)) − 1 − ret(SPY).
//
// ── PLACEBO ────────────────────────────────────────────────────────
// Misma señal en sesiones D' que NO caen en [iE−10, iE+3] de NINGÚN reporte
// del símbolo (iE = primera sesión ≥ E, cualquier hora). Se toman TODAS las
// elegibles dentro de la ventana de análisis (determinista, y ≥ N(SEÑAL) en
// cualquier universo realista); si fueran menos que N(SEÑAL), el reporte lo
// marca.
//
// ── Clustering ─────────────────────────────────────────────────────
// Los reportes se apelotonan por temporada. Antes de cualquier t, los eventos
// se PROMEDIAN por fecha de D: la unidad del t es la fecha, no el evento. Las
// diferencias SEÑAL−CONTROL y SEÑAL−PLACEBO son Welch sobre esas series.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────── CRITERIOS (congelados) ───────────────────
// Un solo objeto. Mover una portería se ve en el diff y rompe el test que los
// pinea (tests/fuga-analyze.test.mjs).
const CRITERIOS_FUGA = {
  // Candado de muestra: por debajo → INCONCLUSO, sin importar los números.
  min_senal: 30,
  min_control: 100,
  // GO requiere las tres; GO FRÁGIL si pasan las tres pero el t de (1) o el
  // de (2) queda en [t_minimo, t_solido).
  //   (1) t(SEÑAL) ≥ 2 con media > 0
  //   (2) t(SEÑAL − PLACEBO) ≥ 2 con diferencia > 0   (fuga, no momentum)
  //   (3) reacción anormal NETA de costos ≥ +0.30 % por operación
  // Lectura conservadora de una ambigüedad del encargo, fijada antes de ver
  // datos: GO FRÁGIL también exige (3) — un edge que no paga costos no es GO
  // de ningún tipo.
  t_minimo: 2,
  t_solido: 2.5,
  neto_min_por_operacion: 0.0030,
  // t ≤ −2 en (1) → se reporta como hallazgo ("el run-up se revierte"); sigue
  // siendo NO-GO para la idea long.
  t_reversion: -2,
  // Especificación
  ventana_formacion: 5,
  umbral_senal: 0.06,
  umbral_control: 0.02,
  tenencia: 1,
  placebo_antes: 10,
  placebo_despues: 3,
  costo_por_lado: 0.0010,
  anios_ventana: 3,
  // Sensibilidades: se reportan, NO deciden, NO se promueven.
  sens_ventana_formacion: 10,
  sens_umbrales: [0.04, 0.08],
  sens_tenencia: 3,
};

// ─────────────────── estadística ───────────────────

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function varianza(a) {
  if (a.length < 2) return null;
  const m = media(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
}

function mediana(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// t de la media. null (no NaN, no 0) si no hay con qué: un t inventado es
// peor que uno ausente.
function tMedia(a) {
  const v = varianza(a);
  if (v == null || !(v > 0)) return null;
  return media(a) / Math.sqrt(v / a.length);
}

// Welch: (m1−m2) / √(s1²/n1 + s2²/n2).
function tWelch(a, b) {
  const va = varianza(a), vb = varianza(b);
  if (va == null || vb == null) return null;
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? (media(a) - media(b)) / se : null;
}

// Promedio por fecha de D: la unidad del t.
function porFecha(obs, campo = 'abnormal') {
  const m = new Map();
  for (const o of obs) {
    if (!m.has(o.fecha_d)) m.set(o.fecha_d, []);
    m.get(o.fecha_d).push(o[campo]);
  }
  return [...m.keys()].sort().map((f) => media(m.get(f)));
}

function resumenGrupo(obs) {
  const abn = obs.map((o) => o.abnormal);
  const net = obs.map((o) => o.abnormal_neto);
  const cl = porFecha(obs, 'abnormal');
  return {
    n: obs.length,
    n_fechas: cl.length,
    media: media(abn),
    mediana: mediana(abn),
    pct_positivos: obs.length ? abn.filter((x) => x > 0).length / obs.length : null,
    media_neta: media(net),
    media_por_fecha: media(cl),
    t: tMedia(cl),
  };
}

// ─────────────────── calendario ───────────────────

// Primera posición con calendario[i] > fecha (estricto) o ≥ fecha.
function primeraSesion(calendario, fecha, estricto) {
  let lo = 0, hi = calendario.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ok = estricto ? calendario[mid] > fecha : calendario[mid] >= fecha;
    if (ok) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Hora efectiva. 'amc' (principal): null → amc · 'drop': null → fuera ·
// 'bmo' (exploratorio): null → bmo. DMH SIEMPRE → bmo (ver cabecera).
function horaEfectiva(hour, politica) {
  const h = (hour || '').toLowerCase();
  if (h === 'bmo' || h === 'dmh') return 'bmo';
  if (h === 'amc') return 'amc';
  if (politica === 'drop') return null;
  return politica === 'bmo' ? 'bmo' : 'amc';
}

const TIENE_HORA = (h) => ['bmo', 'amc', 'dmh'].includes((h || '').toLowerCase());

// { iD, iSalida } — iSalida es el primer cierre posterior al anuncio. Los dos
// son consecutivos por construcción. -1 si no existen en el calendario.
function sesionesEvento(calendario, reportedDate, hora) {
  const iSalida = primeraSesion(calendario, reportedDate, hora === 'amc');
  const iD = iSalida - 1;
  return {
    iD: iD >= 0 && iD < calendario.length ? iD : -1,
    iSalida: iSalida < calendario.length ? iSalida : -1,
  };
}

// ─────────────────── medición ───────────────────

const ok = (x) => x != null && Number.isFinite(x) && x > 0;

// Exceso de formación con cierres REALES (sin arrastrar): si falta una vela
// la observación se cae con su motivo — rellenarla movería la ventana sin decirlo.
function exceso(closes, spy, iD, k) {
  const i0 = iD - k;
  if (i0 < 0) return { motivo: 'sin_historia_formacion' };
  if (!ok(closes[iD])) return { motivo: 'sin_vela_d' };
  if (!ok(closes[i0])) return { motivo: 'sin_vela_formacion' };
  if (!ok(spy[iD]) || !ok(spy[i0])) return { motivo: 'sin_spy' };
  return { valor: (closes[iD] / closes[i0] - 1) - (spy[iD] / spy[i0] - 1) };
}

// Reacción cierre(iD) → cierre(iFin). iFin = primer cierre post + tenencia − 1.
function reaccion(closes, spy, iD, iFin, costo) {
  if (iFin < 0 || iFin >= closes.length) return { motivo: 'sin_salida' };
  if (!ok(closes[iFin])) return { motivo: 'sin_vela_salida' };
  if (!ok(spy[iFin])) return { motivo: 'sin_spy' };
  const rS = closes[iFin] / closes[iD] - 1;
  const rM = spy[iFin] / spy[iD] - 1;
  const neto = (closes[iFin] * (1 - costo)) / (closes[iD] * (1 + costo)) - 1;
  return { bruto: rS, spy: rM, abnormal: rS - rM, abnormal_neto: neto - rM };
}

function clasifica(x, umbral, umbralControl) {
  if (x >= umbral) return 'senal';
  if (x <= -umbral) return 'corto';
  if (Math.abs(x) < umbralControl) return 'control';
  return 'intermedio';
}

// ─────────────────── muestra de eventos ───────────────────

function construyeEventos({ eventos, calendario, seriesAlineadas, spyCloses, politicaHora = 'amc',
  k, tenencia, umbral, umbralControl, costo, desde = null }) {
  const descartes = {
    fuera_de_ventana: 0, sin_hora_descartada: 0, sin_serie: 0, sin_sesion: 0,
    sin_historia_formacion: 0, sin_vela_d: 0, sin_vela_formacion: 0,
    sin_salida: 0, sin_vela_salida: 0, sin_spy: 0,
  };
  const grupos = { senal: [], control: [], corto: [], intermedio: [] };
  for (const ev of eventos) {
    if (desde && ev.reported_date < desde) { descartes.fuera_de_ventana++; continue; }
    const hora = horaEfectiva(ev.hour, politicaHora);
    if (!hora) { descartes.sin_hora_descartada++; continue; }
    const s = seriesAlineadas[ev.symbol];
    if (!s) { descartes.sin_serie++; continue; }
    const { iD, iSalida } = sesionesEvento(calendario, ev.reported_date, hora);
    if (iD < 0 || iSalida < 0) { descartes.sin_sesion++; continue; }
    const ex = exceso(s.closes, spyCloses, iD, k);
    if (ex.motivo) { descartes[ex.motivo]++; continue; }
    const re = reaccion(s.closes, spyCloses, iD, iSalida + tenencia - 1, costo);
    if (re.motivo) { descartes[re.motivo]++; continue; }
    const obs = {
      symbol: ev.symbol, reported_date: ev.reported_date,
      hour: ev.hour || null, hora_efectiva: hora, hora_imputada: !TIENE_HORA(ev.hour),
      fecha_d: calendario[iD], fecha_salida: calendario[iSalida + tenencia - 1],
      exceso: ex.valor, ...re,
    };
    grupos[clasifica(ex.valor, umbral, umbralControl)].push(obs);
  }
  return { grupos, descartes };
}

// ─────────────────── placebo ───────────────────

// Índices prohibidos por símbolo: [iE−antes, iE+después] de CADA reporte de
// la tabla (no solo los de la ventana: un reporte de fuera también contamina
// las sesiones vecinas). iE = primera sesión ≥ E, sin importar la hora.
function zonasProhibidas(eventos, calendario, antes, despues) {
  const out = {};
  for (const ev of eventos) {
    const iE = primeraSesion(calendario, ev.reported_date, false);
    if (!out[ev.symbol]) out[ev.symbol] = new Set();
    for (let i = iE - antes; i <= iE + despues; i++) if (i >= 0 && i < calendario.length) out[ev.symbol].add(i);
  }
  return out;
}

function construyePlacebo({ eventos, calendario, seriesAlineadas, spyCloses, k, tenencia, umbral,
  antes, despues, costo, desde = null }) {
  const prohibidas = zonasProhibidas(eventos, calendario, antes, despues);
  const iDesde = desde ? primeraSesion(calendario, desde, false) : 0;
  const conteo = { sesiones_evaluadas: 0, excluidas_por_reporte: 0, sin_datos: 0, con_senal: 0 };
  const obs = [];
  const simbolos = [...new Set(eventos.map((e) => e.symbol))].sort();
  for (const sym of simbolos) {
    const s = seriesAlineadas[sym];
    if (!s) continue;
    const proh = prohibidas[sym] || new Set();
    for (let i = Math.max(iDesde, k); i + tenencia < calendario.length; i++) {
      conteo.sesiones_evaluadas++;
      // La sesión de tenencia tampoco puede caer en zona de reporte (con
      // antes ≥ tenencia ya queda cubierto, pero se verifica explícito).
      let tocada = false;
      for (let j = i; j <= i + tenencia; j++) if (proh.has(j)) { tocada = true; break; }
      if (tocada) { conteo.excluidas_por_reporte++; continue; }
      const ex = exceso(s.closes, spyCloses, i, k);
      if (ex.motivo) { conteo.sin_datos++; continue; }
      if (ex.valor < umbral) continue;
      const re = reaccion(s.closes, spyCloses, i, i + tenencia, costo);
      if (re.motivo) { conteo.sin_datos++; continue; }
      conteo.con_senal++;
      obs.push({ symbol: sym, fecha_d: calendario[i], fecha_salida: calendario[i + tenencia], exceso: ex.valor, ...re });
    }
  }
  return { obs, conteo };
}

// ─────────────────── veredicto ───────────────────

// Separado para poder probar cada frontera de los criterios sin fabricar series.
function veredicto({ n_senal, n_control, t_senal, media_senal, t_dif_placebo, dif_placebo, neto_senal }, c = CRITERIOS_FUGA) {
  const cumple = {
    muestra: n_senal >= c.min_senal && n_control >= c.min_control,
    c1_senal: t_senal != null && media_senal > 0 && t_senal >= c.t_minimo,
    c2_vs_placebo: t_dif_placebo != null && dif_placebo > 0 && t_dif_placebo >= c.t_minimo,
    c3_neto: neto_senal != null && neto_senal >= c.neto_min_por_operacion,
  };
  const reversion = t_senal != null && t_senal <= c.t_reversion;
  let v;
  if (!cumple.muestra) v = 'INCONCLUSO';
  else if (cumple.c1_senal && cumple.c2_vs_placebo && cumple.c3_neto) {
    v = Math.min(t_senal, t_dif_placebo) >= c.t_solido ? 'GO' : 'GO FRÁGIL';
  } else v = 'NO-GO';
  return { veredicto: v, cumple, hallazgo_reversion: cumple.muestra && reversion };
}

// ─────────────────── una corrida completa ───────────────────

function corre({ eventos, calendario, seriesAlineadas, spyCloses, desde = null, criterios = CRITERIOS_FUGA,
  politicaHora = 'amc', k, umbral, tenencia, filtroSenal = null }) {
  const c = criterios;
  k = k ?? c.ventana_formacion;
  umbral = umbral ?? c.umbral_senal;
  tenencia = tenencia ?? c.tenencia;
  const base = { calendario, seriesAlineadas, spyCloses, k, tenencia, umbral, costo: c.costo_por_lado, desde };

  const { grupos, descartes } = construyeEventos({ ...base, eventos, politicaHora, umbralControl: c.umbral_control });
  // El split BMO/AMC filtra los eventos con señal; CONTROL y PLACEBO quedan enteros.
  const senal = filtroSenal ? grupos.senal.filter(filtroSenal) : grupos.senal;
  const placebo = construyePlacebo({ ...base, eventos, antes: c.placebo_antes, despues: c.placebo_despues });

  const S = resumenGrupo(senal), C = resumenGrupo(grupos.control), P = resumenGrupo(placebo.obs);
  const clS = porFecha(senal), clC = porFecha(grupos.control), clP = porFecha(placebo.obs);
  const dif = {
    senal_menos_control: { dif: S.media_por_fecha != null && C.media_por_fecha != null ? S.media_por_fecha - C.media_por_fecha : null, t: tWelch(clS, clC) },
    senal_menos_placebo: { dif: S.media_por_fecha != null && P.media_por_fecha != null ? S.media_por_fecha - P.media_por_fecha : null, t: tWelch(clS, clP) },
  };
  const v = veredicto({
    n_senal: S.n, n_control: C.n, t_senal: S.t, media_senal: S.media_por_fecha,
    t_dif_placebo: dif.senal_menos_placebo.t, dif_placebo: dif.senal_menos_placebo.dif,
    neto_senal: S.media_neta,
  }, c);

  return {
    especificacion: { politica_hora: politicaHora, ventana_formacion: k, umbral, tenencia },
    cobertura: {
      descartes,
      senal: senal.length,
      control: grupos.control.length,
      corto: grupos.corto.length,
      intermedio: grupos.intermedio.length,
      placebo: placebo.obs.length,
      placebo_conteo: placebo.conteo,
      placebo_menor_que_senal: placebo.obs.length < senal.length,
      senal_hora_imputada: senal.filter((o) => o.hora_imputada).length,
      senal_por_hora: { bmo: senal.filter((o) => o.hora_efectiva === 'bmo').length, amc: senal.filter((o) => o.hora_efectiva === 'amc').length },
    },
    grupos: { senal: S, control: C, placebo: P, corto_informativo: resumenGrupo(grupos.corto) },
    diferencias: dif,
    ...v,
    _obs: { senal, control: grupos.control, corto: grupos.corto, placebo: placebo.obs },
  };
}

// ─────────────────── resumen en español ───────────────────

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : (x * 100).toFixed(d) + '%');
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/d' : x.toFixed(d));
const marca = (b) => (b ? '✅' : '❌');

function filaGrupo(nombre, g) {
  return `| ${nombre} | ${g.n} | ${g.n_fechas} | ${pct(g.media)} | ${pct(g.mediana)} | ${pct(g.pct_positivos, 1)} | ${pct(g.media_por_fecha)} | ${num(g.t)} | ${pct(g.media_neta)} |`;
}

function lineaCorta(titulo, r) {
  const g = r.grupos.senal;
  return `**${titulo}** → ${r.veredicto} (no decide) · SEÑAL n=${g.n} media ${pct(g.media)} t ${num(g.t)}`
    + ` · S−P ${pct(r.diferencias.senal_menos_placebo.dif)} t ${num(r.diferencias.senal_menos_placebo.t)}`
    + ` · S−C ${pct(r.diferencias.senal_menos_control.dif)} t ${num(r.diferencias.senal_menos_control.t)}`
    + ` · neto ${pct(g.media_neta)}`;
}

function renderCobertura(s, L) {
  const p = s.principal, cv = p.cobertura, d = s.datos;
  L.push('## 1. Cobertura (PARAR y revisar antes de leer resultados)');
  L.push('');
  L.push(`- Eventos en la tabla (ventana + colchón): ${d.eventos_en_tabla} · símbolos ${d.simbolos}`
    + (d.sin_precios.length ? ` · sin precios en Yahoo: ${d.sin_precios.join(', ')}` : ''));
  L.push(`- Ventana de análisis: ${d.ventana_analisis.desde} → ${d.ventana_analisis.hasta} · eventos en ventana: ${d.en_ventana}`);
  L.push(`- Con hora: ${d.con_hora} (${pct(d.pct_con_hora, 1)}; BMO ${d.por_hora.bmo} · AMC ${d.por_hora.amc} · DMH→BMO ${d.por_hora.dmh}) · sin hora (imputados AMC): ${d.sin_hora}`);
  L.push(`- SEÑAL ${cv.senal} (hora imputada ${cv.senal_hora_imputada}; BMO ${cv.senal_por_hora.bmo} · AMC ${cv.senal_por_hora.amc}) · CONTROL ${cv.control} · CORTO ${cv.corto} · intermedio (2–6%) ${cv.intermedio}`);
  L.push(`- PLACEBO ${cv.placebo} · sesiones evaluadas ${cv.placebo_conteo.sesiones_evaluadas} · excluidas por cercanía a reporte ${cv.placebo_conteo.excluidas_por_reporte} · sin datos ${cv.placebo_conteo.sin_datos}`);
  L.push(`- Exclusiones de eventos: ${Object.entries(cv.descartes).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (cv.placebo_menor_que_senal) L.push('> ⚠️ PLACEBO tiene menos observaciones que SEÑAL: el criterio (2) pierde potencia.');
  L.push('');
}

function renderResumenMarkdown(s) {
  const c = s.criterios, p = s.principal, L = [];
  L.push('# FUGA PRE-EARNINGS — ¿el run-up previo predice la reacción?');
  L.push('');
  L.push(`Generado ${s.generado_en} · solo lectura · criterios congelados en \`CRITERIOS_FUGA\``);
  L.push('');
  renderCobertura(s, L);
  if (s.solo_cobertura) {
    L.push('_Solo cobertura (?solo=cobertura). Quita el parámetro para ver resultados._');
    return L.join('\n');
  }
  L.push(`## 2. VEREDICTO: ${p.veredicto}`);
  L.push('');
  if (p.hallazgo_reversion) {
    L.push(`> **HALLAZGO:** t(SEÑAL) = ${num(p.grupos.senal.t)} ≤ ${c.t_reversion} — el run-up se REVIERTE en el reporte. Sigue siendo NO-GO para la idea long.`);
    L.push('');
  }
  L.push('| Criterio | Resultado | ¿Pasa? |');
  L.push('|---|---|---|');
  L.push(`| Candado: SEÑAL ≥ ${c.min_senal} y CONTROL ≥ ${c.min_control} | ${p.grupos.senal.n} / ${p.grupos.control.n} | ${marca(p.cumple.muestra)} |`);
  L.push(`| (1) media SEÑAL > 0 con t ≥ ${c.t_minimo} (por fecha) | ${pct(p.grupos.senal.media_por_fecha)} · t ${num(p.grupos.senal.t)} | ${marca(p.cumple.c1_senal)} |`);
  L.push(`| (2) SEÑAL − PLACEBO > 0 con t ≥ ${c.t_minimo} (Welch) | ${pct(p.diferencias.senal_menos_placebo.dif)} · t ${num(p.diferencias.senal_menos_placebo.t)} | ${marca(p.cumple.c2_vs_placebo)} |`);
  L.push(`| (3) neto de costos ≥ ${pct(c.neto_min_por_operacion)} por operación | ${pct(p.grupos.senal.media_neta)} | ${marca(p.cumple.c3_neto)} |`);
  L.push('');
  L.push(`GO exige (1)(2)(3) con ambos t ≥ ${c.t_solido}; con alguno en [${c.t_minimo}, ${c.t_solido}) → GO FRÁGIL.`);
  L.push('');
  L.push('## 3. Grupos (reacción anormal vs SPY, cierre D → primer cierre post-anuncio)');
  L.push('');
  L.push('| Grupo | N | fechas | media | mediana | % pos | media por fecha | t (por fecha) | media neta |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  L.push(filaGrupo('SEÑAL (≥ +6%)', p.grupos.senal));
  L.push(filaGrupo('CONTROL (|x| < 2%)', p.grupos.control));
  L.push(filaGrupo('PLACEBO (≥ +6%, fuera de reportes)', p.grupos.placebo));
  L.push(filaGrupo('CORTO (≤ −6%, informativo)', p.grupos.corto_informativo));
  L.push('');
  L.push(`- SEÑAL − CONTROL: ${pct(p.diferencias.senal_menos_control.dif)} · t Welch ${num(p.diferencias.senal_menos_control.t)}`);
  L.push(`- SEÑAL − PLACEBO: ${pct(p.diferencias.senal_menos_placebo.dif)} · t Welch ${num(p.diferencias.senal_menos_placebo.t)}`);
  L.push('- Si SEÑAL ≈ PLACEBO, lo que haya es momentum, no fuga.');
  L.push('');
  L.push('## 4. Sensibilidades (se reportan, NO deciden, NO se promueven)');
  L.push('');
  for (const x of s.sensibilidades) { L.push(lineaCorta(x.nombre, x.resultado)); L.push(''); }
  L.push('## 5. EXPLORATORIO (etiquetado, no decide)');
  L.push('');
  for (const x of s.exploratorio) {
    L.push(`**[EXPLORATORIO] ${x.nombre}** — ${x.por_que}`);
    L.push(`- ${lineaCorta('Resultado', x.resultado)}`);
    L.push('');
  }
  L.push('## 6. Caveats pre-registrados');
  L.push('');
  L.push('- Universo actual hacia atrás = survivorship que infla: un GO con t apenas arriba de 2 es FRÁGIL por construcción.');
  L.push('- ~3 años = un solo régimen alcista: un NO-GO aquí es más creíble que un GO.');
  L.push('- Tenencia de 1 sesión con cierres: entramos ANTES del gap a propósito, así que esta vez el gap sí se cobra (ese es el punto de la idea).');
  L.push('- Sin hora → AMC NO es conservador en este diseño (si fue BMO, el cierre de E ya vio el anuncio): mirar "sin hora descartados".');
  return L.join('\n');
}

export {
  CRITERIOS_FUGA,
  media, varianza, mediana, tMedia, tWelch, porFecha, resumenGrupo,
  primeraSesion, horaEfectiva, sesionesEvento, exceso, reaccion, clasifica,
  construyeEventos, zonasProhibidas, construyePlacebo, veredicto, corre,
  renderResumenMarkdown, TIENE_HORA, pct, num,
};
