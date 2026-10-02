// ═══════════════════════════════════════════════════════════════════
// api/_lib/reaccion.js — LÓGICA PURA del experimento "reaccion".
//
// La pregunta: dado un reporte de resultados, ¿cuál de estas señales explica
// mejor el movimiento cierre(T-1) → apertura(T+1) de la acción?
//
//   A) sorpresa de EPS       (reportado vs estimado) — en pead_earnings
//   B) sorpresa de INGRESOS  (reportado vs estimado) — hay que conseguirla
//   C) GUÍA de la empresa    (rango prometido vs consenso del trimestre que
//                             viene) — hay que conseguirla
//
// Caso que lo motiva: Nike superó EPS +9%, falló ingresos −1%, dio guía floja,
// y la acción cayó 5%. Tres resultados distintos del mismo reporte.
//
// ── PRE-REGISTRADO ─────────────────────────────────────────────────
// Todo umbral, toda definición y toda regla de qué entra al análisis vive en
// CRITERIOS_REACCION y está pineada por test ANTES de correr. El pre-registro
// escrito está en docs/reaccion-scope.md. Mover una portería rompe un test y
// se ve en el diff.
//
// Sin red y sin DB: fixtures en los tests.
// ═══════════════════════════════════════════════════════════════════

import { sorpresaPct } from './earnings-beat.js';
import { winsoriza, CRITERIOS_F2 } from './earnings-beat-analyze.js';

const CRITERIOS_REACCION = {
  version: 1,

  // ── VARIABLE DEPENDIENTE ──
  // retorno cierre(T-1) → apertura(T+1) de la acción MENOS el de SPY en el
  // mismo tramo. Sin el ajuste se mediría el mercado, no el reporte.
  //   T-1 = la última sesión ESTRICTAMENTE anterior a la fecha del reporte.
  //   T+1 = la primera sesión ESTRICTAMENTE posterior.
  // El calendario de sesiones es el de SPY (como en el PEAD): una vela que le
  // falta a la acción en una fecha de SPY NO se rellena, el evento se descarta.
  ajuste: 'retorno_accion_menos_retorno_spy',

  // ── LAS SEÑALES ──
  // EPS: la decisión de winsorización ya estaba congelada por INTC (±100%).
  // Se IMPORTA, no se copia: si alguien la moviera en un lado y no en el otro,
  // los dos experimentos medirían cosas distintas sin decirlo.
  winsor_eps_pct: CRITERIOS_F2.winsor_sorpresa_pct,
  // Ingresos: SIN winsorizar. Un estimado de ingresos de una empresa del
  // universo son miles de millones, el denominador no puede rondar el cero.
  // Por eso una sorpresa de más de ±50% no es un dato: es un error de unidad o
  // de período, y se DESCARTA con su motivo en vez de recortarse.
  max_sorpresa_ingresos_pct: 50,

  // ── QUÉ FRENTE ENTRA AL ANÁLISIS ──
  // Un frente con menos de 50% de cobertura sobre los eventos NO entra, y se
  // dice por qué.
  min_cobertura_frente: 0.50,

  // ── REGLA DE ESTIMADOS (la misma de siempre) ──
  // Un estimado sirve SOLO si es anterior al reporte. "El estimado de hoy" no
  // sirve. Ver `clasificaFuenteEstimado`.

  // ── CANDADOS ──
  min_eventos: 100,         // por señal, y para el conjunto

  // ── CUÁNDO UNA SEÑAL "EXPLICA" ──
  min_abs_r: 0.20,
  max_p_valor: 0.05,

  // ── EL R² CONJUNTO ──
  // Si todas juntas explican menos que esto, el veredicto es "la reacción es
  // mayormente impredecible con datos públicos del reporte". Es un HALLAZGO,
  // no un fracaso.
  umbral_r2_conjunto: 0.10,

  // ── INGRESOS REPORTADOS EN EDGAR ──
  // Tags us-gaap que se prueban EN ESTE ORDEN; se usa el primero que tenga
  // hechos trimestrales. El orden cubre el cambio de ASC 606 (2018).
  tags_ingresos: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
  ],
  // Un hecho es "trimestral" si su duración cae acá (días).
  dias_trimestre: [75, 105],
  dias_nueve_meses: [255, 285],
  dias_anio: [350, 380],
  // El `end` del hecho contra el fiscal_date_ending del evento.
  tolerancia_fin_de_periodo_dias: 7,
  // Acuerdo entre el ingreso reportado de la fuente de estimados y el de EDGAR.
  tolerancia_acuerdo_ingresos_pct: 1,

  // ── GUÍA ──
  simbolos_guia: 10,
  filings_guia_por_simbolo: 4,
  max_parrafos_por_filing: 8,
  max_chars_parrafo: 900,

  // ── CRUCE fuente ↔ evento ──
  // La fila de la fuente contra el report_date del evento: ±1 día, la misma
  // tolerancia que el cruce del earnings-beat (un reporte después del cierre
  // puede quedar fechado el día siguiente según la fuente).
  tolerancia_cruce_dias: 1,

  // ── FUENTE DE INGRESOS ESTIMADOS ──
  // Si califica más de una: la de MAYOR cobertura; empate → la que trae fecha
  // de corte. NUNCA se mezclan dos fuentes: cada una define "consenso" a su
  // manera y mezclarlas inventa una serie que no existe en ningún lado.
  regla_fuente_ingresos: 'mayor_cobertura__empate_gana_la_que_tiene_fecha__nunca_mezclar',
};

// ─────────────────── utilidades ───────────────────

const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const dia = (x) => {
  if (!x) return null;
  const s = String(x).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const diasEntre = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

// ─────────────────── la variable dependiente ───────────────────

// serie: { fechas: [ISO...], opens: [...], closes: [...] } (yahoo-daily, ya
// ajustada: el open lleva el mismo factor que el close, así que un día ex-
// dividendo no inventa un retorno).
function indicePorFecha(serie) {
  const m = new Map();
  if (!serie || !Array.isArray(serie.fechas)) return m;
  for (let i = 0; i < serie.fechas.length; i++) m.set(serie.fechas[i], i);
  return m;
}

function retornoVentana(serieAccion, serieSpy, reportDate) {
  const T = dia(reportDate);
  if (!T) return { ok: false, motivo: 'sin_fecha_de_reporte' };
  if (!serieSpy || !Array.isArray(serieSpy.fechas) || !serieSpy.fechas.length) {
    return { ok: false, motivo: 'sin_serie_spy' };
  }
  if (!serieAccion || !Array.isArray(serieAccion.fechas) || !serieAccion.fechas.length) {
    return { ok: false, motivo: 'sin_serie_accion' };
  }

  // El calendario es el de SPY. ESTRICTO en los dos lados: T-1 < T < T+1.
  let previa = null, siguiente = null;
  for (const f of serieSpy.fechas) {
    if (f < T) previa = f;
    else if (f > T && siguiente === null) siguiente = f;
  }
  if (!previa) return { ok: false, motivo: 'sin_sesion_previa', T };
  if (!siguiente) return { ok: false, motivo: 'sin_sesion_siguiente', T };

  const iS = indicePorFecha(serieSpy), iA = indicePorFecha(serieAccion);
  const sP = iS.get(previa), sN = iS.get(siguiente);
  const aP = iA.get(previa), aN = iA.get(siguiente);
  // Una vela que le falta a la acción NO se rellena con la de al lado: eso
  // movería la ventana sin decirlo.
  if (aP === undefined) return { ok: false, motivo: 'sin_vela_cierre_previo', fecha: previa, T };
  if (aN === undefined) return { ok: false, motivo: 'sin_vela_apertura_siguiente', fecha: siguiente, T };

  const cA = serieAccion.closes[aP], oA = serieAccion.opens[aN];
  const cS = serieSpy.closes[sP], oS = serieSpy.opens[sN];
  if (![cA, oA, cS, oS].every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, motivo: 'precio_invalido', T };
  }
  const rA = oA / cA - 1, rS = oS / cS - 1;
  return {
    ok: true, T,
    cierre_previo: previa, apertura_siguiente: siguiente,
    sesiones_en_ventana: [...iS.keys()].filter((f) => f > previa && f < siguiente).length,
    ret_accion: rA, ret_spy: rS,
    ret_ajustado: rA - rS,
  };
}

// ─────────────────── las sorpresas ───────────────────

// A) EPS: la sorpresa se calcula LOCAL con |est| en el denominador (la de AV
// trae el signo mal con estimados negativos) y se winsoriza con la decisión de
// INTC.
function sorpresaEps(reportado, estimado, { tope = CRITERIOS_REACCION.winsor_eps_pct } = {}) {
  const s = sorpresaPct(num(reportado), num(estimado));
  if (s === null) return { ok: false, motivo: 'sin_eps_comparable' };
  return { ok: true, cruda: s, winsorizada: winsoriza(s, tope), recortada: Math.abs(s) > tope };
}

// B) INGRESOS: sin winsorizar, con el guardia de unidad/período.
function sorpresaIngresos(reportado, estimado, { max = CRITERIOS_REACCION.max_sorpresa_ingresos_pct } = {}) {
  const r = num(reportado), e = num(estimado);
  if (r === null || e === null) return { ok: false, motivo: 'sin_ingresos_comparables' };
  if (e <= 0) return { ok: false, motivo: 'estimado_de_ingresos_no_positivo' };
  const s = sorpresaPct(r, e);
  if (s === null) return { ok: false, motivo: 'sin_ingresos_comparables' };
  if (Math.abs(s) > max) {
    return { ok: false, motivo: 'sorpresa_de_ingresos_implausible', valor: +s.toFixed(2), max,
      detalle: `Una sorpresa de ingresos de ${s.toFixed(1)}% no es un dato: es casi seguro un error de unidad o de período entre el estimado y el reportado.` };
  }
  return { ok: true, valor: s };
}

// ─────────────────── la regla de estimados ───────────────────
//
// "Sirve solo si el estimado es anterior al reporte. El estimado de hoy no
// sirve." Se aplica mirando la FORMA de lo que devuelve la fuente, porque
// ninguna fuente lo dice en letras. Tres clases, y solo dos sirven:
//
//   · pit_con_fecha        — cada estimado trae su fecha de corte, anterior al
//                            reporte. El mejor caso.
//   · estimado_del_evento  — el estimado viene GUARDADO JUNTO al resultado del
//                            mismo reporte (la fila tiene el real y el estimado
//                            de ese período, pegados a la fecha del reporte).
//                            Es el consenso con el que se llegó al reporte. Es
//                            EXACTAMENTE la misma clase de dato que el
//                            `estimatedEPS` de Alpha Vantage que usa la señal A:
//                            si esta clase no sirviera, la A tampoco.
//   · estimado_de_hoy      — una fila por período fiscal con el número vigente,
//                            sin real al lado y con filas para períodos futuros.
//                            Es la forma de `analyst-estimates` de FMP. NO sirve.
//
// Lo que no encaja en ninguna se declara `no_concluyente` con la fila cruda.
const CLAVES_FECHA_DE_CORTE = ['asOfDate', 'as_of_date', 'estimateDate', 'estimate_date', 'lastUpdated', 'updatedAt'];
const CLAVES_ESTIMADO_INGRESOS = ['revenueEstimated', 'revenueEstimate', 'estimatedRevenueAvg', 'revenue_estimate_average', 'revenueAvg'];
const CLAVES_REAL_INGRESOS = ['revenueActual', 'revenue', 'reportedRevenue', 'revenue_actual'];
const CLAVES_FECHA_REPORTE = ['date', 'reportDate', 'reportedDate', 'report_date'];

const primeraClave = (fila, claves) => claves.find((k) => fila && Object.prototype.hasOwnProperty.call(fila, k)) || null;

function clasificaFuenteEstimado(filas, { hoy = null } = {}) {
  const lista = Array.isArray(filas) ? filas.filter((f) => f && typeof f === 'object') : [];
  if (!lista.length) return { clase: 'no_concluyente', motivo: 'sin_filas', fila_cruda: null };
  const muestra = lista[0];
  const kEst = primeraClave(muestra, CLAVES_ESTIMADO_INGRESOS);
  if (!kEst) {
    return { clase: 'no_concluyente', motivo: 'sin_campo_de_ingresos_estimados',
      claves_vistas: Object.keys(muestra).slice(0, 25), fila_cruda: muestra };
  }
  const kCorte = primeraClave(muestra, CLAVES_FECHA_DE_CORTE);
  const kReal = primeraClave(muestra, CLAVES_REAL_INGRESOS);
  const kFecha = primeraClave(muestra, CLAVES_FECHA_REPORTE);
  // ── LA FECHA DE CORTE TIENE QUE SER ANTERIOR AL REPORTE ──
  // Dos cicatrices en una regla:
  //   · la del PIT de AV: una clave con nombre de revisión que era un conteo
  //     — por eso el valor tiene que SER una fecha;
  //   · la de FMP: `/stable/earnings` trae `lastUpdated`, que es cuándo FMP
  //     tocó la fila por última vez — DESPUÉS del reporte, cuando llegó el
  //     real. Tomarla como fecha de corte llamaría "point-in-time" a lo
  //     contrario.
  // Así que solo cuenta si, en las filas que traen las dos fechas, el corte es
  // ESTRICTAMENTE anterior a la fecha del reporte en TODAS.
  let cortePosterior = 0;
  if (kCorte && kFecha) {
    const ambas = lista.filter((f) => dia(f[kCorte]) && dia(f[kFecha]));
    const anteriores = ambas.filter((f) => dia(f[kCorte]) < dia(f[kFecha]));
    cortePosterior = ambas.length - anteriores.length;
    if (ambas.length && cortePosterior === 0) {
      return { clase: 'pit_con_fecha', campo_estimado: kEst, campo_fecha_de_corte: kCorte, campo_fecha: kFecha,
        filas_verificadas: ambas.length, fila_cruda: muestra };
    }
  }
  // ¿Hay filas para períodos FUTUROS? Es la firma de "el estimado de hoy".
  const diaHoy = hoy ? dia(hoy) : null;
  const futuras = diaHoy && kFecha ? lista.filter((f) => dia(f[kFecha]) && dia(f[kFecha]) > diaHoy).length : 0;
  const conReal = kReal ? lista.filter((f) => num(f[kReal]) !== null).length : 0;

  if (kReal && kFecha && conReal > 0) {
    return { clase: 'estimado_del_evento', campo_estimado: kEst, campo_real: kReal, campo_fecha: kFecha,
      filas_con_real: conReal, filas_futuras: futuras,
      // Si había una clave con pinta de fecha de corte y NO contó, se dice cuál
      // y por qué: es exactamente el dato que alguien va a querer "aprovechar".
      clave_de_corte_descartada: kCorte && cortePosterior ? { campo: kCorte, filas_con_corte_no_anterior: cortePosterior,
        motivo: 'la fecha no es anterior al reporte: es cuándo se actualizó la fila, no cuándo se fijó el estimado' } : null,
      nota: 'El estimado viene pegado al resultado del mismo reporte. Es la misma clase de dato que el estimatedEPS de Alpha Vantage que usa la señal A: si esta no sirviera, aquella tampoco.',
      fila_cruda: muestra };
  }
  return { clase: 'estimado_de_hoy', campo_estimado: kEst, filas_futuras: futuras,
    motivo: kReal ? 'sin_fecha_de_reporte_en_la_fila' : 'sin_valor_real_al_lado: una fila por período con el número vigente',
    fila_cruda: muestra };
}
const CLASES_QUE_SIRVEN = new Set(['pit_con_fecha', 'estimado_del_evento']);

// ─────────────────── ingresos reportados en EDGAR (XBRL) ───────────────────
//
// companyconcept devuelve hechos con `start`, `end`, `val`, `form`, `filed`.
// Trimestral = duración de ~90 días. El Q4 casi nunca viene suelto: viene el
// AÑO en el 10-K, y se DERIVA mecánicamente como año − nueve meses. Sin LLM:
// es una resta, y se marca que es derivado.
function ingresosTrimestralesXbrl(hechos, { criterios = CRITERIOS_REACCION } = {}) {
  const lista = (Array.isArray(hechos) ? hechos : []).filter((h) => h && num(h.val) !== null && dia(h.end));
  const dur = (h) => (dia(h.start) ? diasEntre(dia(h.end), dia(h.start)) : null);
  const en = (d, [a, b]) => d !== null && d >= a && d <= b;

  // Un mismo período aparece en varios filings (el 10-Q y el 10-K siguiente):
  // se queda el filing MÁS VIEJO, que es el primero en que el dato existió.
  const unico = (filtro) => {
    const m = new Map();
    for (const h of lista.filter(filtro)) {
      const k = `${dia(h.start)}|${dia(h.end)}`;
      const prev = m.get(k);
      if (!prev || String(h.filed || '') < String(prev.filed || '')) m.set(k, h);
    }
    return [...m.values()];
  };
  const trimestrales = unico((h) => en(dur(h), criterios.dias_trimestre));
  const nueveMeses = unico((h) => en(dur(h), criterios.dias_nueve_meses));
  const anuales = unico((h) => en(dur(h), criterios.dias_anio));

  const out = trimestrales.map((h) => ({ fin: dia(h.end), inicio: dia(h.start), valor: num(h.val),
    form: h.form || null, filed: dia(h.filed), derivado: false }));
  const finesYa = new Set(out.map((x) => x.fin));
  // Q4 = año − 9M, cuando los dos arrancan el mismo día.
  for (const a of anuales) {
    const fin = dia(a.end);
    if (finesYa.has(fin)) continue;
    const nm = nueveMeses.find((n) => dia(n.start) === dia(a.start));
    if (!nm) continue;
    out.push({ fin, inicio: dia(nm.end), valor: num(a.val) - num(nm.val),
      form: a.form || null, filed: dia(a.filed), derivado: true, formula: 'anual − nueve_meses' });
  }
  return out.sort((x, y) => x.fin.localeCompare(y.fin));
}

// El ingreso trimestral cuyo fin de período coincide con el del evento.
function ingresoDelEvento(trimestres, fiscalDateEnding, { tol = CRITERIOS_REACCION.tolerancia_fin_de_periodo_dias } = {}) {
  const f = dia(fiscalDateEnding);
  if (!f) return null;
  let mejor = null, d0 = Infinity;
  for (const t of trimestres || []) {
    const d = Math.abs(diasEntre(t.fin, f));
    if (d <= tol && d < d0) { mejor = t; d0 = d; }
  }
  return mejor;
}

// ─────────────────── GUÍA: el párrafo crudo, sin interpretar ───────────────────
//
// CERO llamadas a LLM. Se convierte el HTML del Exhibit 99.1 a texto, se parte
// en párrafos, y se devuelven los que calzan con PATRONES fijos. Lo que se
// devuelve es el párrafo tal cual: nada de "la guía fue floja".
const PATRONES_GUIA = [
  { id: 'palabra_guia', re: /\b(outlook|guidance)\b/i },
  { id: 'verbo_futuro_con_metrica', re: /\b(expects?|anticipates?|projects?|forecasts?|now sees|sees)\b[^.]{0,100}\b(revenues?|sales|earnings|eps|margins?)\b/i },
  { id: 'periodo_futuro_con_metrica', re: /\b(fiscal\s+(year\s+)?20\d\d|full[- ]year|next quarter|(first|second|third|fourth)[- ]quarter(\s+of)?\s+(fiscal\s+)?20\d\d)\b[^.]{0,80}\b(revenues?|sales|eps|earnings per share)\b/i },
  { id: 'rango_monetario', re: /\$\s?\d[\d.,]*\s?(billion|million|b|m)?\s?(to|-|–|and)\s?\$\s?\d/i },
  { id: 'rango_porcentual', re: /\b(low|mid|high)[- ](single|double)[- ]digits?\b|\b\d+(\.\d+)?\s?%?\s?(to|-|–)\s?\d+(\.\d+)?\s?(%|percent)/i },
];
// El párrafo de safe harbor calza con casi todo ("expects", "anticipates") y no
// es guía. Se MARCA por regex, no se borra: decidir que no es guía sería
// interpretar.
const RE_SAFE_HARBOR = /forward[- ]looking statements?|safe harbor|private securities litigation reform act/i;

function htmlATexto(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\s*br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n\n');
  t = t.replace(/<[^>]+>/g, ' ');
  const ent = { '&nbsp;': ' ', '&#160;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&#8217;': '’', '&#8216;': '‘', '&#8220;': '“', '&#8221;': '”', '&#8211;': '–', '&#8212;': '—', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—' };
  t = t.replace(/&[#a-z0-9]+;/gi, (m) => (ent[m.toLowerCase()] !== undefined ? ent[m.toLowerCase()] : ' '));
  return t;
}

function parrafosDeGuia(html, { criterios = CRITERIOS_REACCION } = {}) {
  const parrafos = htmlATexto(html).split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 40);
  const out = [];
  for (const p of parrafos) {
    const patrones = PATRONES_GUIA.filter((x) => x.re.test(p)).map((x) => x.id);
    if (!patrones.length) continue;
    out.push({
      parrafo: p.length > criterios.max_chars_parrafo ? p.slice(0, criterios.max_chars_parrafo) + '…' : p,
      recortado: p.length > criterios.max_chars_parrafo,
      patrones,
      parece_safe_harbor: RE_SAFE_HARBOR.test(p),
    });
    if (out.length >= criterios.max_parrafos_por_filing) break;
  }
  return out;
}

// ¿Cuál de los archivos del filing es el Exhibit 99.1? Por NOMBRE, con reglas
// fijas y declaradas; si ninguna calza, el .htm más grande que no sea el
// documento primario. Se dice qué regla lo encontró.
const RE_EX991 = /ex[-_]?99[-_.]?0?1\b|exhibit[-_]?99[-_.]?1|ex991|ex-99\.1|dex991/i;
function eligeExhibit991(items, documentoPrimario) {
  const htm = (items || []).filter((i) => i && /\.html?$/i.test(i.name || '') && i.name !== documentoPrimario);
  const porNombre = htm.find((i) => RE_EX991.test(i.name));
  if (porNombre) return { nombre: porNombre.name, regla: 'nombre_ex99_1' };
  const grande = htm.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
  if (grande) return { nombre: grande.name, regla: 'htm_mas_grande_que_no_es_el_primario' };
  return { nombre: null, regla: 'sin_candidato' };
}

// ─────────────────── estadística ───────────────────
//
// Beta incompleta regularizada (Numerical Recipes, fracción continua de Lentz).
// Con eso sale la cola de la t de Student SIN aproximarla con la normal: con
// n ≈ 100 la diferencia es chica, pero con un tercil de 30 no lo es, y el
// p-valor se compara contra un umbral.
function lnGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function betaIncompleta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
// p-valor a DOS colas de una t con `df` grados de libertad.
function pValorT(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return null;
  return Math.max(0, Math.min(1, betaIncompleta(df / 2, 0.5, df / (df + t * t))));
}

// Pearson con su n, su t y su p (dos colas, t de Student con n−2).
function pearson(xs, ys) {
  const pares = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pares.push([xs[i], ys[i]]);
  }
  const n = pares.length;
  if (n < 3) return { n, r: null, t: null, p_valor: null, motivo: 'menos_de_3_pares' };
  const mx = pares.reduce((a, [x]) => a + x, 0) / n;
  const my = pares.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pares) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return { n, r: null, t: null, p_valor: null, motivo: 'sin_varianza' };
  const r = sxy / Math.sqrt(sxx * syy);
  if (Math.abs(r) >= 1) return { n, r, t: Infinity, p_valor: 0, motivo: null };
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return { n, r, t, p_valor: pValorT(t, n - 2), motivo: null };
}

// Mínimos cuadrados con intercepto, por ecuaciones normales y eliminación de
// Gauss-Jordan con pivoteo parcial. Son 2–4 columnas: no hace falta más.
function ols(filasX, ys) {
  const n = ys.length;
  const k = (filasX[0] || []).length + 1;
  if (n <= k) return { n, r2: null, beta: null, motivo: 'menos_filas_que_columnas' };
  const X = filasX.map((f) => [1, ...f]);
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b];
      A[a][k] += X[i][a] * ys[i];
    }
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return { n, r2: null, beta: null, motivo: 'colinealidad' };
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  const beta = A.map((fila, i) => fila[k] / fila[i]);
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const yhat = X[i].reduce((a, x, j) => a + x * beta[j], 0);
    ssr += (ys[i] - yhat) ** 2;
    sst += (ys[i] - my) ** 2;
  }
  return { n, r2: sst ? 1 - ssr / sst : null, beta, motivo: sst ? null : 'sin_varianza' };
}

// ═══════════════════════════════════════════════════════════════════
// EL ANÁLISIS Y EL VEREDICTO
//
// Orden NO negociable:
//   1. La variable dependiente: sin precios no hay nada que explicar.
//   2. La cobertura de cada frente: <50% NO entra, y se dice por qué.
//   3. El candado de cada señal: <100 eventos es INCONCLUSO, no "casi".
//   4. Recién ahí, los números.
// ═══════════════════════════════════════════════════════════════════

const SENALES = [
  { id: 'A', clave: 'eps', nombre: 'sorpresa de EPS (winsorizada ±100%)' },
  { id: 'B', clave: 'ingresos', nombre: 'sorpresa de INGRESOS' },
  { id: 'C', clave: 'guia', nombre: 'GUÍA vs consenso del trimestre siguiente' },
];

// El valor numérico de cada señal en un evento, o null.
const valorDe = (e, clave) => {
  if (clave === 'eps') return e.eps && e.eps.ok ? e.eps.winsorizada : null;
  if (clave === 'ingresos') return e.ingresos && e.ingresos.ok ? e.ingresos.valor : null;
  if (clave === 'guia') return e.guia && e.guia.ok ? e.guia.valor : null;
  return null;
};
const retDe = (e) => (e.ret && e.ret.ok ? e.ret.ret_ajustado : null);

// eventos: [{ symbol, report_date, ret, eps, ingresos, guia }]
// motivosNoEntra: { ingresos: '…', guia: '…' } — por qué un frente no tiene
// datos, dicho por quien lo midió (el censo), no adivinado acá.
function analizaReaccion(eventos, { criterios = CRITERIOS_REACCION, motivosNoEntra = {} } = {}) {
  const lista = Array.isArray(eventos) ? eventos : [];
  const total = lista.length;
  const empresasTodas = [...new Set(lista.map((e) => e.symbol))].sort();

  // ── 1. La variable dependiente ──
  const conRet = lista.filter((e) => retDe(e) !== null);
  const coberturaPrecios = total ? conRet.length / total : 0;
  const descartesRet = {};
  for (const e of lista) if (!(e.ret && e.ret.ok)) {
    const m = (e.ret && e.ret.motivo) || 'sin_ventana';
    descartesRet[m] = (descartesRet[m] || 0) + 1;
  }
  const base = {
    criterios, eventos_totales: total, empresas_totales: empresasTodas.length,
    precios: { con_retorno: conRet.length, cobertura: +coberturaPrecios.toFixed(3), descartes: descartesRet },
    advertencias: advertenciasFijas(),
  };
  if (coberturaPrecios < criterios.min_cobertura_frente) {
    return { ...base, senales: [], conjunto: null, tres_piezas: null, exploratorio: null,
      veredicto: 'INCONCLUSO',
      titular: `INCONCLUSO: solo ${conRet.length} de ${total} eventos tienen la ventana de precios completa (${(coberturaPrecios * 100).toFixed(0)}%, el mínimo es ${criterios.min_cobertura_frente * 100}%). Sin la variable dependiente no hay nada que explicar.`,
      advertencia_seleccion: null };
  }

  // ── 2 y 3. Cada señal: cobertura, candado, números ──
  const senales = SENALES.map((sen) => {
    const con = lista.filter((e) => valorDe(e, sen.clave) !== null);
    const cobertura = total ? con.length / total : 0;
    const out = { id: sen.id, clave: sen.clave, nombre: sen.nombre,
      eventos_con_senal: con.length, cobertura: +cobertura.toFixed(3) };
    if (cobertura < criterios.min_cobertura_frente) {
      return { ...out, estado: 'NO_ENTRA',
        porque: `Cobertura ${(cobertura * 100).toFixed(0)}% (${con.length} de ${total}), bajo el mínimo de ${criterios.min_cobertura_frente * 100}%.`
          + (motivosNoEntra[sen.clave] ? ` ${motivosNoEntra[sen.clave]}` : '') };
    }
    const pares = lista.filter((e) => valorDe(e, sen.clave) !== null && retDe(e) !== null);
    const empresas = [...new Set(pares.map((e) => e.symbol))].sort();
    if (pares.length < criterios.min_eventos) {
      return { ...out, estado: 'INCONCLUSO', n: pares.length, empresas,
        porque: `Solo ${pares.length} eventos con la señal Y la ventana de precios; el candado son ${criterios.min_eventos}.` };
    }
    const c = pearson(pares.map((e) => valorDe(e, sen.clave)), pares.map(retDe));
    const explica = c.r !== null && Math.abs(c.r) >= criterios.min_abs_r && c.p_valor < criterios.max_p_valor;
    return { ...out, estado: explica ? 'EXPLICA' : 'NO_EXPLICA', n: c.n, empresas,
      r: c.r === null ? null : +c.r.toFixed(4),
      p_valor: c.p_valor === null ? null : +c.p_valor.toFixed(4),
      r2_sola: c.r === null ? null : +(c.r * c.r).toFixed(4),
      porque: c.r === null ? `Sin varianza: ${c.motivo}.`
        : `r = ${c.r.toFixed(3)} (umbral |r| ≥ ${criterios.min_abs_r}) ${Math.abs(c.r) >= criterios.min_abs_r ? '✓' : '✗'} · p = ${c.p_valor.toFixed(4)} (umbral < ${criterios.max_p_valor}) ${c.p_valor < criterios.max_p_valor ? '✓' : '✗'} · n = ${c.n}.` };
  });

  // ── 4. El conjunto: con las señales que ENTRARON (cobertura ≥ 50%) ──
  const entraron = senales.filter((x) => x.estado !== 'NO_ENTRA');
  let conjunto = null;
  if (entraron.length) {
    const completos = lista.filter((e) => retDe(e) !== null && entraron.every((x) => valorDe(e, x.clave) !== null));
    const nombres = entraron.map((x) => x.id).join(' + ');
    if (completos.length < criterios.min_eventos) {
      conjunto = { senales: entraron.map((x) => x.id), n: completos.length, r2: null, estado: 'INCONCLUSO',
        porque: `Solo ${completos.length} eventos con ${nombres} y la ventana de precios completos; el candado son ${criterios.min_eventos}.` };
    } else {
      const m = ols(completos.map((e) => entraron.map((x) => valorDe(e, x.clave))), completos.map(retDe));
      const r2 = m.r2;
      const impredecible = r2 !== null && r2 < criterios.umbral_r2_conjunto;
      // "Las tres juntas" solo se dice si son las tres. Con menos, se nombra con
      // cuáles se midió: decir "las tres" con una sola sería mentir con el plural.
      const conCuales = entraron.length === SENALES.length ? 'las tres señales juntas'
        : entraron.length === 1 ? `solo con ${entraron[0].nombre} (las demás no entraron)`
          : `con ${nombres} (${SENALES.length - entraron.length} no entró)`;
      conjunto = {
        senales: entraron.map((x) => x.id), n: m.n,
        r2: r2 === null ? null : +r2.toFixed(4),
        estado: r2 === null ? 'INCONCLUSO' : impredecible ? 'MAYORMENTE_IMPREDECIBLE' : 'EXPLICA_PARTE',
        porque: r2 === null ? `La regresión no se pudo resolver: ${m.motivo}.`
          : impredecible
            ? `R² = ${(r2 * 100).toFixed(1)}% ${conCuales}, bajo el umbral de ${criterios.umbral_r2_conjunto * 100}%: la reacción es mayormente impredecible con datos públicos del reporte. Es un HALLAZGO, no un fracaso.`
            : `R² = ${(r2 * 100).toFixed(1)}% ${conCuales}: explican esa parte del movimiento ajustado por mercado; el resto queda sin explicar.`,
      };
    }
  }

  // "≥100 eventos con las tres piezas, o INCONCLUSO para la parte que falte".
  const tres = lista.filter((e) => retDe(e) !== null && SENALES.every((x) => valorDe(e, x.clave) !== null));
  const faltan = SENALES.filter((x) => !lista.some((e) => valorDe(e, x.clave) !== null)).map((x) => x.id);
  const tresPiezas = {
    n: tres.length,
    estado: tres.length >= criterios.min_eventos ? 'COMPLETO' : 'INCONCLUSO',
    porque: tres.length >= criterios.min_eventos
      ? `${tres.length} eventos con las tres piezas.`
      : `${tres.length} eventos con las tres piezas (candado ${criterios.min_eventos}): el análisis de las tres juntas es INCONCLUSO`
        + (faltan.length ? `; falta la señal ${faltan.join(' y ')} en todos los eventos.` : '.'),
  };

  // ── EXPLORATORIO, aparte: acierto direccional ──
  const exploratorio = aciertoDireccional(lista);

  // ── El veredicto en letras ──
  const titulares = senales.map((x) => `${x.id} (${x.nombre}): ${x.estado.replace('_', ' ')}`);
  const veredicto = conjunto && conjunto.estado === 'MAYORMENTE_IMPREDECIBLE' ? 'MAYORMENTE_IMPREDECIBLE'
    : senales.some((x) => x.estado === 'EXPLICA') ? 'ALGUNA_SENAL_EXPLICA'
      : senales.every((x) => x.estado === 'NO_ENTRA' || x.estado === 'INCONCLUSO') ? 'INCONCLUSO'
        : 'NINGUNA_SENAL_EXPLICA';

  return {
    ...base, senales, conjunto, tres_piezas: tresPiezas, exploratorio,
    veredicto,
    titular: conjunto && conjunto.estado === 'MAYORMENTE_IMPREDECIBLE'
      ? `La reacción es mayormente impredecible con datos públicos del reporte (${conjunto.porque.split(':')[0]}).`
      : titulares.join(' · '),
    advertencia_seleccion: advertenciaDeSeleccion(senales, empresasTodas),
  };
}

// ── EXPLORATORIO: ¿beat → la acción sube? ──
// Etiquetado aparte y FUERA del veredicto: es el número que sirve para
// contenido, no una prueba. Se mide sobre el retorno AJUSTADO (la variable del
// análisis) y sobre el CRUDO (lo que "subió la acción" significa en una nota).
function aciertoDireccional(lista) {
  const medir = (clave) => {
    const conAmbos = lista.filter((e) => valorDe(e, clave) !== null && e.ret && e.ret.ok && valorDe(e, clave) !== 0);
    if (!conAmbos.length) return null;
    const beats = conAmbos.filter((e) => valorDe(e, clave) > 0);
    const misses = conAmbos.filter((e) => valorDe(e, clave) < 0);
    const pct = (xs, f) => (xs.length ? +(xs.filter(f).length / xs.length).toFixed(3) : null);
    return {
      n: conAmbos.length, beats: beats.length, misses: misses.length,
      ajustado: {
        beat_y_sube: pct(beats, (e) => e.ret.ret_ajustado > 0),
        miss_y_baja: pct(misses, (e) => e.ret.ret_ajustado < 0),
        acierto_global: pct(conAmbos, (e) => Math.sign(e.ret.ret_ajustado) === Math.sign(valorDe(e, clave))),
      },
      crudo: {
        beat_y_sube: pct(beats, (e) => e.ret.ret_accion > 0),
        miss_y_baja: pct(misses, (e) => e.ret.ret_accion < 0),
        acierto_global: pct(conAmbos, (e) => Math.sign(e.ret.ret_accion) === Math.sign(valorDe(e, clave))),
      },
    };
  };
  return {
    etiqueta: 'EXPLORATORIO — no entra al veredicto',
    nota: 'Tasa de acierto direccional: ¿la señal positiva vino con la acción arriba? Es el número para contenido, no una prueba: no controla tamaño de la sorpresa ni del movimiento. El "ajustado" resta SPY; el "crudo" es lo que "subió la acción" significa en una nota.',
    eps: medir('eps'),
    ingresos: medir('ingresos'),
  };
}

// ── LAS ADVERTENCIAS ──
// Las dos que el encargo pidió dejar escritas, más la de la ventana, que es una
// decisión del pre-registro con un costo que se tiene que ver.
function advertenciasFijas() {
  return {
    pead: 'El PEAD ya demostró que el movimiento ocurre de noche. Aunque algo explique la reacción, OPERARLA es otra pregunta y NO está contestada acá: explicar el gap después de que pasó no es poder capturarlo antes.',
    ventana: 'La ventana cierre(T-1) → apertura(T+1) no depende de si el reporte fue antes o después de la apertura, y por eso se eligió. El costo: incluye una sesión COMPLETA (el día T). Si el reporte fue después del cierre, esa sesión es ruido previo al reporte; si fue antes de la apertura, es la reacción del día más la deriva. Ese ruido baja las correlaciones; no las sube.',
  };
}

// SESGO DE SELECCIÓN: si una señal solo cubre parte del universo, se dice de
// qué empresas son. Calculado con los números de la corrida.
function advertenciaDeSeleccion(senales, empresasTodas) {
  const parciales = senales.filter((x) => Array.isArray(x.empresas) && x.empresas.length < empresasTodas.length);
  if (!parciales.length) return null;
  return parciales.map((x) => {
    const faltan = empresasTodas.filter((s) => !x.empresas.includes(s));
    return `SESGO DE SELECCIÓN en ${x.id} (${x.nombre}): los ${x.n} eventos vienen de ${x.empresas.length} de ${empresasTodas.length} empresas. `
      + `Un resultado sobre ${x.id} vale para ESAS empresas, no para el universo. `
      + `Con datos: ${x.empresas.join(' ')}. Sin datos: ${faltan.join(' ') || '—'}.`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// LOS RESÚMENES EN ESPAÑOL
// ═══════════════════════════════════════════════════════════════════

const pctTxt = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const veredictoFrente = (f) => (f ? (f.entra ? '**ENTRA** al análisis' : '**NO ENTRA** al análisis') : '—');

function renderCensoMd(c) {
  const L = [];
  L.push('# reaccion — FASE 0: censo de datos');
  L.push('');
  L.push(`Generado: ${c.generado_en || '—'} · frente: **${c.frente}** · sin análisis y sin veredicto de señal`);
  L.push('');
  const ev = c.eventos || {};
  L.push(`Eventos: **${ev.total ?? '—'}** de ${ev.empresas ?? '—'} empresas · con EPS comparable (señal A, de pead_earnings): **${ev.con_eps ?? '—'}** (${pctTxt(ev.cobertura_eps)})`);
  L.push('');
  L.push(`Regla congelada: un frente con menos de **${(c.criterios || CRITERIOS_REACCION).min_cobertura_frente * 100}%** de cobertura NO entra al análisis, y se dice por qué.`);
  L.push('');

  const fr = c.frentes || {};
  if (fr.precios) {
    const x = fr.precios;
    L.push(`## Precios (variable dependiente) — ${veredictoFrente(x)}`);
    L.push('');
    L.push(`Ventana cierre(T-1) → apertura(T+1), calendario de SPY. Completa en **${x.con_retorno} de ${x.total}** eventos (${pctTxt(x.cobertura)}).`);
    if (x.series) L.push(`Series bajadas: ${x.series.ok} de ${x.series.pedidas} símbolos + SPY ${x.series.spy ? 'ok' : '**FALLÓ**'}.`);
    if (x.con_hora !== undefined) L.push(`Con hora del reporte (BMO/AMC) conocida: ${x.con_hora} de ${x.total} — no entra a la variable, se reporta por la nota de la ventana.`);
    if (x.descartes && Object.keys(x.descartes).length) {
      L.push('');
      L.push('| Motivo | Eventos |');
      L.push('|---|---|');
      for (const [k, v] of Object.entries(x.descartes).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    }
    if ((x.simbolos_sin_serie || []).length) L.push(`\nSin serie de Yahoo: \`${x.simbolos_sin_serie.join(' ')}\``);
    L.push('');
    L.push(`> ${x.porque}`);
    L.push('');
  }

  if (fr.ingresos) {
    const x = fr.ingresos;
    L.push(`## Ingresos (señal B) — ${veredictoFrente(x)}`);
    L.push('');
    L.push('### Estimados: ¿hay una fuente gratis con el estimado ANTERIOR al reporte?');
    L.push('');
    L.push('| Fuente | HTTP | Motivo | Clase | ¿Sirve? |');
    L.push('|---|---|---|---|---|');
    for (const sd of (x.estimados && x.estimados.sondas) || []) {
      L.push(`| ${sd.fuente} | ${sd.status ?? '—'} | ${sd.motivo || (sd.ok ? 'ok' : '—')} | ${sd.clase || '—'} | ${sd.sirve ? 'sí' : 'NO'} |`);
    }
    for (const sd of (x.estimados && x.estimados.sondas) || []) {
      if (!sd.detalle && !sd.fila_cruda && !sd.body_sample) continue;
      L.push('');
      L.push(`**${sd.fuente}**${sd.detalle ? ` — ${sd.detalle}` : ''}`);
      if (sd.nota) L.push(`> ${sd.nota}`);
      const crudo = sd.fila_cruda ? JSON.stringify(sd.fila_cruda) : sd.body_sample;
      if (crudo) { L.push('```'); L.push(String(crudo).slice(0, 600)); L.push('```'); }
    }
    const es = x.estimados || {};
    if ((es.cobertura_por_fuente || []).length) {
      L.push('');
      L.push('| Fuente que califica | Eventos con estimado Y real | Cobertura |');
      L.push('|---|---|---|');
      for (const f of es.cobertura_por_fuente) L.push(`| ${f.fuente} | ${f.con_dato} de ${f.total} | ${pctTxt(f.cobertura)} |`);
    }
    L.push('');
    L.push(`Fuente elegida: **${es.elegida || 'ninguna'}** — ${es.porque_eleccion || '—'}`);
    const rep = x.reportados_edgar;
    if (rep) {
      L.push('');
      L.push('### Reportados en EDGAR (XBRL, sin LLM)');
      L.push('');
      L.push(`Símbolos con ingreso trimestral en XBRL: **${rep.simbolos_con_dato} de ${rep.simbolos_pedidos}** · eventos con su trimestre: **${rep.eventos_con_dato} de ${rep.total}** (${pctTxt(rep.cobertura)}), de esos **${rep.q4_derivados}** con Q4 DERIVADO (anual − nueve meses).`);
      if (rep.tags_usados) L.push(`Tag usado por símbolo: ${Object.entries(rep.tags_usados).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
      if (rep.acuerdo_con_fuente) L.push(`Acuerdo con el ingreso real de la fuente elegida (±${CRITERIOS_REACCION.tolerancia_acuerdo_ingresos_pct}%): **${rep.acuerdo_con_fuente.coinciden} de ${rep.acuerdo_con_fuente.comparados}**.`);
      L.push('');
      L.push('> Los ingresos REPORTADOS solos no hacen una sorpresa: sin el estimado anterior al reporte, no hay contra qué compararlos. Por eso este conteo es una auditoría de la fuente elegida, no la señal.');
    }
    L.push('');
    L.push(`> ${x.porque}`);
    L.push('');
  }

  if (fr.guia) {
    const x = fr.guia;
    L.push(`## Guía (señal C) — ${veredictoFrente(x)}`);
    L.push('');
    L.push(`8-K con Item 2.02 de **${(x.simbolos || []).length}** símbolos · filings leídos: **${x.filings_leidos}** · con al menos un párrafo de guía que NO parece safe harbor: **${x.filings_con_guia}**. CERO llamadas a LLM.`);
    L.push('');
    L.push(`> ${x.porque}`);
    for (const sim of x.simbolos || []) {
      L.push('');
      L.push(`### ${sim.symbol}${sim.motivo ? ` — ${sim.motivo}` : ''}`);
      for (const f of sim.filings || []) {
        L.push('');
        L.push(`**${f.fecha}** · [${f.exhibit || 'sin exhibit'}](${f.url || '#'}) · regla: ${f.regla_exhibit || '—'}${f.error ? ` · ⚠ ${f.error}` : ''}`);
        if (!(f.parrafos || []).length) { L.push(''); L.push('_(ningún párrafo calzó con los patrones)_'); continue; }
        for (const pr of f.parrafos) {
          L.push('');
          L.push(`> ${pr.parece_safe_harbor ? '_[parece safe harbor]_ ' : ''}${pr.parrafo}`);
          L.push(`> — patrones: ${pr.patrones.join(', ')}`);
        }
      }
    }
    L.push('');
  }

  const adv = c.advertencias || {};
  if (c.advertencia_seleccion) { L.push(`> ⚠ ${c.advertencia_seleccion}`); L.push(''); }
  if (adv.ventana) { L.push(`> ${adv.ventana}`); L.push(''); }
  L.push('---');
  L.push('');
  L.push('Este censo NO dictamina ninguna señal: mide si hay con qué. Los criterios de la Fase 1 ya están congelados en `CRITERIOS_REACCION` (`api/_lib/reaccion.js`) y en `docs/reaccion-scope.md`.');
  return L.join('\n');
}

function renderAnalisisMd(a) {
  const c = a.criterios || CRITERIOS_REACCION;
  const L = [];
  L.push('# reaccion — ¿qué parte del reporte explica el movimiento?');
  L.push('');
  L.push(`Generado: ${a.generado_en || '—'} · análisis **pre-registrado**`);
  L.push('');
  L.push(`## VEREDICTO: ${String(a.veredicto || '—').replace(/_/g, ' ')}`);
  L.push('');
  L.push(a.titular || '');
  L.push('');
  const adv = a.advertencias || {};
  if (adv.pead) L.push(`> ⚠ ${adv.pead}`);
  if (a.advertencia_seleccion) { L.push('>'); for (const linea of a.advertencia_seleccion.split('\n')) L.push(`> ⚠ ${linea}`); }
  if (adv.ventana) { L.push('>'); L.push(`> ${adv.ventana}`); }
  L.push('');

  L.push('## Variable dependiente');
  L.push('');
  L.push(`Retorno cierre(T-1) → apertura(T+1) de la acción **menos el de SPY**. Ventana completa en **${a.precios.con_retorno} de ${a.eventos_totales}** eventos (${pctTxt(a.precios.cobertura)}), ${a.empresas_totales} empresas.`);
  L.push('');

  if ((a.senales || []).length) {
    L.push('## Cada señal por separado');
    L.push('');
    L.push('| Señal | Cobertura | n | r | p | R² sola | Estado |');
    L.push('|---|---|---|---|---|---|---|');
    for (const x of a.senales) {
      L.push(`| ${x.id} — ${x.nombre} | ${pctTxt(x.cobertura)} | ${x.n ?? '—'} | ${x.r ?? '—'} | ${x.p_valor ?? '—'} | ${x.r2_sola ?? '—'} | **${x.estado.replace('_', ' ')}** |`);
    }
    L.push('');
    for (const x of a.senales) L.push(`- **${x.id}**: ${x.porque}`);
    L.push('');
    L.push(`Una señal "explica" si |r| ≥ ${c.min_abs_r} **y** p < ${c.max_p_valor} (dos colas, t de Student), con ≥ ${c.min_eventos} eventos.`);
    L.push('');
  }

  if (a.conjunto) {
    L.push('## Juntas');
    L.push('');
    L.push(`Señales en la regresión: **${a.conjunto.senales.join(' + ')}** · n = ${a.conjunto.n} · R² = **${a.conjunto.r2 === null ? '—' : (a.conjunto.r2 * 100).toFixed(1) + '%'}**`);
    L.push('');
    L.push(a.conjunto.porque);
    L.push('');
  }
  if (a.tres_piezas) { L.push(`**Las tres piezas:** ${a.tres_piezas.porque}`); L.push(''); }

  const ex = a.exploratorio;
  if (ex && (ex.eps || ex.ingresos)) {
    L.push(`## ${ex.etiqueta}`);
    L.push('');
    L.push(`> ${ex.nota}`);
    L.push('');
    L.push('| Señal | n | beat → sube (ajust.) | miss → baja (ajust.) | acierto (ajust.) | beat → sube (crudo) | miss → baja (crudo) | acierto (crudo) |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const [k, v] of [['EPS', ex.eps], ['Ingresos', ex.ingresos]]) {
      if (!v) continue;
      L.push(`| ${k} | ${v.n} | ${pctTxt(v.ajustado.beat_y_sube)} | ${pctTxt(v.ajustado.miss_y_baja)} | ${pctTxt(v.ajustado.acierto_global)} | ${pctTxt(v.crudo.beat_y_sube)} | ${pctTxt(v.crudo.miss_y_baja)} | ${pctTxt(v.crudo.acierto_global)} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('**Los criterios estaban congelados antes de correr esto** (`CRITERIOS_REACCION` en `api/_lib/reaccion.js`, pre-registro en `docs/reaccion-scope.md`). El veredicto lo lee quien abre esta página; el endpoint no se auto-aprueba.');
  return L.join('\n');
}

export {
  CRITERIOS_REACCION, num, dia, diasEntre, renderCensoMd, renderAnalisisMd,
  SENALES, analizaReaccion, aciertoDireccional, advertenciasFijas, advertenciaDeSeleccion,
  retornoVentana, sorpresaEps, sorpresaIngresos,
  clasificaFuenteEstimado, CLASES_QUE_SIRVEN,
  ingresosTrimestralesXbrl, ingresoDelEvento,
  PATRONES_GUIA, RE_SAFE_HARBOR, htmlATexto, parrafosDeGuia, eligeExhibit991,
  lnGamma, betaIncompleta, pValorT, pearson, ols,
};
