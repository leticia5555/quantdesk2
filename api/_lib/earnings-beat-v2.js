// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat-v2.js — earnings-beat v2: "barra vs consenso vigente".
//
// NO es otro modelo. Son tres columnas de aritmética que el modelo v1 no tenía:
//   (1) brecha GAAP/ajustado CONOCIDA (8-K, 10-Q, IR con URL),
//   (2) consenso (vigente si lo hay) + sorpresa mediana de la empresa (8T),
//   (3) barra vs guía implícita de la empresa.
// Ver docs/earnings-beat-v2.md (hipótesis, criterios y fecha de corte).
//
// PURO: sin red y sin DB. El endpoint (api/earnings-beat-v2.js) lee las tablas
// y le pasa filas a estas funciones. Mismo reparto que earnings-beat.js.
//
// ── LO QUE ESTA CAPA NO HACE, A PROPÓSITO ──────────────────────────
//   · No toca el modelo v1, ni pm_earnings_markets, ni pead_earnings.
//   · No rellena `consenso_vigente` hacia atrás: es PIT solo desde que el cron
//     empezó a capturarlo. Para mercados pasados queda null y se usa el de
//     creación (el que Polymarket declara en la descripción).
//   · No inventa historial para símbolos fuera del universo de 99: quedan
//     `fuera_universo = true`, sin sorpresa, sin prob_v2, y cuentan para el
//     INCONCLUSO.
//   · La guía implícita es una COLUMNA, no entra a `estimado_v2`. La fórmula
//     pre-registrada no la usa, y meterla ahora sería mover la portería
//     después de ver resultados (docs/earnings-beat-v2.md §"Qué no reproduce").
// ═══════════════════════════════════════════════════════════════════

import { extraeMetricaMercado, extraeConsensoEps, umbralDelSlug, metricaDeFuente } from './earnings-beat.js';
import { V0_UNIVERSE } from './pead-universe.js';

// ─────────────────── criterios, congelados ───────────────────
// Se fijan ANTES de que resuelva el set de validación. Mover uno rompe un test.
const CRITERIOS_V2 = Object.freeze({
  ventana_trimestres: 8,          // sorpresa mediana / std / beats de los últimos 8
  min_trimestres: 4,              // con menos, sorpresa_mediana_8t = null
  std_fallback_frac: 0.05,        // sin std: 0.05 × |barra|
  std_piso: 0.01,                 // un centavo: una std de 0 no es certeza, es poca muestra
  clamp_min: 0.03,
  clamp_max: 0.97,
  // La barra es ESTRICTA (>) y el EPS se publica en centavos: "actual > barra"
  // es "actual ≥ barra + 0.01", o sea actual continuo > barra + 0.005.
  ajuste_empate: 0.005,
  tolerancia_consenso_barra: 0.005, // consenso_creacion == barra salvo redondeo
  umbral_desacuerdo: 0.15,        // zona |prob_v2 − prob_pm| > 15 pts
  acierto_min_zona: 0.70,         // en esa zona v2 tiene que acertar ≥ 70%
  max_faltantes: 4,               // > 4 de 22 sin datos → INCONCLUSO
});

// Set de validación CONGELADO: los 22 mercados de /finance/earnings al
// 21-oct-2026 20:00 CT. El market_id se busca en pm_earnings_markets por
// símbolo + fecha; los que no estén ahí (fuera del universo v1) igual cuentan.
const CORTE_VALIDACION = '2026-10-21T20:00:00-05:00'; /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
const VALIDACION_V2 = Object.freeze([
  ['TSLA', '2026-10-20'], ['WDFC', '2026-10-21'], ['META', '2026-10-21'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['UNP', '2026-10-22'], ['SSNC', '2026-10-22'], ['PG', '2026-10-22'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['AAL', '2026-10-22'], ['TFX', '2026-10-22'], ['PCG', '2026-10-22'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['IMAX', '2026-10-22'], ['AXP', '2026-10-23'], ['SOFI', '2026-10-27'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['BA', '2026-10-27'], ['PJT', '2026-10-27'], ['CZR', '2026-10-27'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['PYPL', '2026-10-27'], ['GOOGL', '2026-10-27'], ['TDOC', '2026-10-28'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['AMZN', '2026-10-29'], ['LLY', '2026-10-29'], ['XOM', '2026-10-30'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
  ['IMAX', '2026-11-05'], /* date-lint-ok: set de validación v2 congelado (hecho fijo, no "hoy") */
].map(([symbol, fecha]) => Object.freeze({ symbol, fecha })));

const UNIVERSO = new Set(V0_UNIVERSE);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function redondea(x, d = 4) {
  return x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(d);
}

function isoDia(v) {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// ─────────────────── lectura del mercado ───────────────────

// ── La métrica de la barra ──
// Primero el lector v1 (slug + pregunta + descripción, ignorando las
// oraciones condicionales de respaldo). Si v1 ve UNA métrica, esa es.
//
// Si v1 ve las DOS (conflicto), decide la ORACIÓN PRINCIPAL: la que define el
// mercado, «This market will resolve to "Yes" if X reports <métrica> EPS
// greater than $…». Es la regla por la que el mercado resuelve; todo lo demás
// en la descripción es respaldo o definición. Pero solo decide si el slug y
// la pregunta no la contradicen. Si la contradicen, o si no hay oración
// principal, o si la principal nombra las dos, queda `metrica_ambigua`: no se
// adivina.
//
// Por qué hizo falta (piloto oct-26, 9 de 22 en `sin_metrica`): la plantilla
// nueva de Polymarket trae dos menciones a GAAP que el lector v1 no aparta:
//   1. «…; or, if not published there, according to the GAAP EPS provided
//      by SeekingAlpha.» — la COLA, después del «;», de un respaldo
//      condicional. Como la cola no empieza con «If», v1 no la reconoce.
//   2. «Note: For the purposes of this market, IFRS EPS will be treated as
//      GAAP EPS.» — una nota de definición.
// El lector v1 no se toca (v1 y sus tests quedan como estaban): la regla vive
// solo en v2.
const ORACION_PRINCIPAL_V2 = /\bresolves?\s+to\s+["“‘']?yes["”’']?\s+if\b/i;
const CODIGO_V2 = { eps_gaap: 'GAAP', eps_ajustado: 'NONGAAP' };

function oracionPrincipal(texto) {
  if (!texto || typeof texto !== 'string') return null;
  return texto.split(/(?<=[.!?;])\s+/).map((x) => x.trim()).find((c) => ORACION_PRINCIPAL_V2.test(c)) || null;
}

function leeMetrica(m) {
  const v1 = extraeMetricaMercado(m || {});
  if (CODIGO_V2[v1.metrica]) return { metrica: CODIGO_V2[v1.metrica], via: 'v1', motivo: null, oracion: null };
  if (v1.motivo === 'sin_mencion') return { metrica: null, via: null, motivo: 'sin_metrica', oracion: null };
  const oracion = oracionPrincipal(m && m.descripcion) || oracionPrincipal(m && m.pregunta);
  const lee = oracion ? metricaDeFuente(oracion, { ignorarCondicionales: false }).lee : null;
  if (!CODIGO_V2[lee]) return { metrica: null, via: null, motivo: 'metrica_ambigua', oracion };
  // Testigos: slug y pregunta. Callados está bien; contradiciendo, no.
  const testigos = [v1.por_fuente.slug.lee, v1.por_fuente.pregunta.lee].filter(Boolean);
  if (testigos.some((t) => t !== lee)) return { metrica: null, via: null, motivo: 'metrica_ambigua', oracion };
  return { metrica: CODIGO_V2[lee], via: 'oracion_principal', motivo: null, oracion };
}

// 'GAAP' | 'NONGAAP' | null.
function metricaBarra(m) {
  return leeMetrica(m).metrica;
}

// Fecha del slug: "imax-quarterly-earnings-nongaap-eps-10-22-2026-0pt88" →
// 2026-10-22. Es la fecha ESTIMADA del reporte cuando nació el mercado; la
// columna de fecha de la tabla puede moverse después (IMAX 10-22 quedó con
// 2026-11-05 y se perdió del cruce).
function fechaDelSlug(slug) {
  const m = /-(\d{2})-(\d{2})-(\d{4})-(?:neg-?)?\d+pt\d+$/.exec(String(slug || '').toLowerCase());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Consenso de creación en la plantilla nueva: «The Street consensus estimate
// for Tesla’s non-GAAP EPS for the relevant quarter is $0.43 as of market
// creation». El lector v1 busca el monto a ≤ 60 caracteres de "consensus" y
// acá está más lejos; en producción no se notaba porque caía al consensus_pm
// de la tabla. Este patrón lee la oración entera, con el monto pegado a
// "as of market creation".
const CONSENSO_PLANTILLA = /\bconsensus estimate for [^.$]{1,120}? is \$\s*(-?\d+(?:\.\d+)?) as of market creation/i;

// La barra: el umbral del slug ("…-6pt31") y, si no está, el monto de la
// descripción. consenso_creacion: lo que la descripción declara como consenso.
function leeMercado(m) {
  const desc = (m && m.descripcion) || '';
  const plantilla = CONSENSO_PLANTILLA.exec(desc);
  const consenso = plantilla ? { valor: Number(plantilla[1]), patron: 'consensus_monto' } : extraeConsensoEps(desc);
  const delSlug = umbralDelSlug(m && m.slug);
  const barra = delSlug !== null ? delSlug : consenso ? consenso.valor : null;
  const consenso_creacion = consenso && consenso.patron === 'consensus_monto' ? consenso.valor : null;
  const met = leeMetrica(m);
  return {
    metrica_barra: met.metrica,
    metrica_via: met.via,
    metrica_motivo: met.motivo,
    barra,
    barra_fuente: delSlug !== null ? 'slug' : consenso ? 'descripcion' : null,
    consenso_creacion,
  };
}

// ── Qué mercado es cada fila del piloto ──
// El piloto es "los 22 de la página al 21-oct 20:00 CT". Un mercado creado
// DESPUÉS del corte no puede ser uno de esos 22 (LLY 7.01, creado el 23-oct,
// se estaba colando en lugar del de 7.49). Entre los que existían al corte,
// gana el que tiene la fecha del SLUG igual a la fecha de la lista; si ninguno,
// la fecha de la tabla ± 1 día. Si queda más de uno, desempata la barra de la
// semilla; si todavía queda más de uno, el más viejo, y se marca `ambiguo`.
function eligeMercadoPiloto(candidatos, { symbol, fecha, barraSemilla = null, corte = CORTE_VALIDACION } = {}) {
  const corteMs = Date.parse(corte);
  const delSimbolo = (candidatos || []).filter((x) => x && x.symbol === symbol);
  const alCorte = delSimbolo.filter((x) => !x.creado_ts || Date.parse(x.creado_ts) <= corteMs);
  const descartados_por_corte = delSimbolo.length - alCorte.length;
  let pool = alCorte.filter((x) => fechaDelSlug(x.slug) === fecha);
  let via = 'fecha_slug';
  if (!pool.length) {
    pool = alCorte.filter((x) => x.fecha && Math.abs(Date.parse(x.fecha) - Date.parse(fecha)) <= 86400000);
    via = 'fecha_tabla';
  }
  if (pool.length > 1 && barraSemilla !== null && barraSemilla !== undefined) {
    const conBarra = pool.filter((x) => umbralDelSlug(x.slug) === Number(barraSemilla));
    if (conBarra.length) pool = conBarra;
  }
  if (!pool.length) return { mercado: null, via: null, ambiguo: false, descartados_por_corte };
  const orden = [...pool].sort((a, b) => String(a.creado_ts || '').localeCompare(String(b.creado_ts || '')));
  return { mercado: orden[0], via, ambiguo: orden.length > 1, descartados_por_corte };
}

// ─────────────────── (2) sorpresa histórica, 8T ───────────────────

function mediana(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function desvio(vals) {
  if (vals.length < 2) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1));
}

// filas: pead_earnings del símbolo. Solo trimestres reportados ESTRICTAMENTE
// antes de `fecha` (cero look-ahead). pead_earnings (Alpha Vantage) guarda el
// EPS AJUSTADO, así que la métrica coincide solo si la barra es NONGAAP.
function sorpresaHistorica(filas, fecha, metrica_barra, { n = CRITERIOS_V2.ventana_trimestres, min = CRITERIOS_V2.min_trimestres } = {}) {
  const corte = isoDia(fecha);
  const validas = (filas || [])
    .map((f) => ({ d: isoDia(f.reported_date), rep: num(f.reported_eps), est: num(f.estimated_eps) }))
    .filter((f) => f.d && corte && f.d < corte && f.rep !== null && f.est !== null)
    .sort((a, b) => (a.d < b.d ? 1 : -1))
    .slice(0, n);
  const sorpresas = validas.map((f) => +(f.rep - f.est).toFixed(4));
  const suficiente = sorpresas.length >= min;
  return {
    n_8t: sorpresas.length,
    sorpresa_mediana_8t: suficiente ? redondea(mediana(sorpresas)) : null,
    sorpresa_std_8t: suficiente ? redondea(desvio(sorpresas)) : null,
    beats_8t: validas.filter((f) => f.rep > f.est).length,
    sorpresa_metrica_match: metrica_barra === 'NONGAAP',
    ultimo_reporte: validas.length ? validas[0].d : null,
  };
}

// ─────────────────── (1) brecha conocida ───────────────────

// Fin del trimestre calendario ANTERIOR a la fecha del reporte. Para fiscales
// no calendario (WDFC cierra en agosto) es una aproximación declarada: la
// semilla de pm_known_gaps / pm_company_guidance se carga con esta misma clave.
function trimestreDelReporte(fecha) {
  const d = isoDia(fecha);
  if (!d) return null;
  const [y, m] = d.split('-').map(Number);
  const q = Math.floor((m - 1) / 3); // trimestre en curso (0..3)
  const finAnterior = q === 0 ? [y - 1, 12, 31] : [y, q * 3, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][q * 3 - 1]];
  return `${finAnterior[0]}-${String(finAnterior[1]).padStart(2, '0')}-${String(finAnterior[2]).padStart(2, '0')}`;
}

// gaps: filas de pm_known_gaps del símbolo+trimestre. brecha_por_accion ≥ 0
// (ajustado − GAAP esperado). `afecta`:
//   'GAAP'  — el cargo vive solo en el GAAP (fusión, multa, legal): se resta
//             solo si la barra es GAAP.
//   'AMBAS' — el cargo pega en GAAP Y en non-GAAP (IPR&D adquirido de Lilly:
//             la empresa lo deja en las dos métricas). Se resta siempre.
// Sin URL no cuenta: la regla es "solo lo que esté en un documento con URL".
//
// `anunciado_en` (24-oct) es SOLO un dato: cuándo se anunció el cargo por
// primera vez. Si el mercado nació DESPUÉS del anuncio, la fila lo dice
// (`brechas_anunciadas_antes_de_creacion`), pero la brecha se aplica igual.
// Se evaluó la regla "creado después del anuncio ⇒ el consenso ya trae el
// cargo ⇒ brecha 0" y se descartó: META (creado 16-oct, anuncio 26-ago) tenía
// barra GAAP 6.31 = consenso de creación y salió 3.83. El consenso NO traía el
// cargo; con esa regla v2 habría dicho ~83% en un mercado que resolvió No.
function brechaConocida(gaps, metrica_barra, creado = null) {
  const conUrl = (gaps || []).filter((g) => g && g.fuente_url && num(g.brecha_por_accion) !== null);
  let soloGaap = 0, ambas = 0;
  for (const g of conUrl) {
    const v = Math.abs(num(g.brecha_por_accion));
    if (String(g.afecta || 'GAAP').toUpperCase() === 'AMBAS') ambas += v; else soloGaap += v;
  }
  const aplicada = metrica_barra === 'GAAP' ? soloGaap + ambas : ambas;
  // Solo cuentan los cargos que de verdad se aplican a esta barra y no son 0.
  const aplicables = conUrl.filter((g) => Math.abs(num(g.brecha_por_accion)) > 0
    && (metrica_barra === 'GAAP' || String(g.afecta || 'GAAP').toUpperCase() === 'AMBAS'));
  const dia = isoDia(creado);
  const previas = dia ? aplicables.filter((g) => isoDia(g.anunciado_en) && isoDia(g.anunciado_en) < dia) : [];
  return {
    brechas_anunciadas_antes_de_creacion: dia ? previas.length : null,
    brecha_anunciada_en: previas.length ? previas.map((g) => isoDia(g.anunciado_en)).sort()[0] : null,
    brecha_gaap_adj: redondea(soloGaap),
    cargo_ambas_metricas: redondea(ambas),
    brecha_aplicada: redondea(aplicada),
    brechas_sin_verificar: conUrl.filter((g) => g.verificada === false).length,
    brechas_descartadas_sin_url: (gaps || []).length - conUrl.length,
  };
}

// ─────────────────── (3) guía implícita ───────────────────

// Guía trimestral: tal cual. Guía anual: (guía_anual − YTD reportado) /
// trimestres restantes, para el mínimo, el máximo y el medio.
function guiaImplicita(g) {
  if (!g) return { guia_q_implicita: null, guia_q_min: null, guia_q_max: null, guia_alcance: null };
  const min = num(g.guia_min), max = num(g.guia_max);
  if (min === null && max === null) return { guia_q_implicita: null, guia_q_min: null, guia_q_max: null, guia_alcance: g.alcance || null };
  let qmin = min, qmax = max;
  if (String(g.alcance || 'trimestre') === 'anual') {
    const ytd = num(g.ytd_reportado), rest = num(g.trimestres_restantes);
    if (ytd === null || !rest) return { guia_q_implicita: null, guia_q_min: null, guia_q_max: null, guia_alcance: 'anual' };
    qmin = min === null ? null : (min - ytd) / rest;
    qmax = max === null ? null : (max - ytd) / rest;
  }
  const lo = qmin ?? qmax, hi = qmax ?? qmin;
  return {
    guia_q_min: redondea(lo), guia_q_max: redondea(hi),
    guia_q_implicita: redondea((lo + hi) / 2),
    guia_alcance: String(g.alcance || 'trimestre'),
  };
}

// Dónde queda la barra contra el rango de la guía. Informativo.
function barraVsGuia(barra, guia) {
  if (barra === null || !guia || guia.guia_q_min === null) return null;
  if (barra > guia.guia_q_max) return 'arriba';
  if (barra < guia.guia_q_min) return 'abajo';
  return 'dentro';
}

// ─────────────────── estimado y probabilidad ───────────────────

function estimadoV2({ metrica_barra, consenso_vigente, consenso_creacion, sorpresa_mediana_8t, brecha_aplicada }) {
  const consenso = num(consenso_vigente) ?? num(consenso_creacion);
  const s = num(sorpresa_mediana_8t);
  if (consenso === null || s === null || !metrica_barra) return null;
  // GAAP: consenso + sorpresa − brecha conocida. NONGAAP: consenso + sorpresa
  // (− solo los cargos que pegan en las dos métricas, ver brechaConocida).
  return redondea(consenso + s - (num(brecha_aplicada) || 0));
}

// Φ(x) — Abramowitz & Stegun 7.1.26 (error < 1.5e-7).
function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// P(actual > barra) con actual ~ Normal(estimado_v2, std). beats_8t y
// metrica_match viajan en la firma pre-registrada pero NO mueven el número: el
// encargo no define cómo, y definirlo ahora sería ajustar después de mirar.
// Se devuelven para que la fila quede auditable.
function probV2(margen, sorpresa_std_8t, beats_8t, metrica_match, { barra = null } = {}) {
  const m = num(margen);
  if (m === null) return { prob_v2: null, std_usada: null, std_fallback: null, beats_8t, metrica_match };
  let std = num(sorpresa_std_8t);
  let std_fallback = false;
  if (std === null) {
    const b = num(barra);
    std = b === null ? null : CRITERIOS_V2.std_fallback_frac * Math.abs(b);
    std_fallback = true;
  }
  if (std === null) return { prob_v2: null, std_usada: null, std_fallback, beats_8t, metrica_match };
  const std_piso = std < CRITERIOS_V2.std_piso;
  if (std_piso) std = CRITERIOS_V2.std_piso;
  const p = normalCdf((m - CRITERIOS_V2.ajuste_empate) / std);
  const prob = Math.min(CRITERIOS_V2.clamp_max, Math.max(CRITERIOS_V2.clamp_min, p));
  return { prob_v2: redondea(prob), std_usada: redondea(std), std_fallback, std_piso, beats_8t, metrica_match };
}

// ─────────────────── la fila completa ───────────────────

// entrada:
//   mercado  { market_id, symbol, fecha, metrica_barra, barra, consenso_creacion,
//              consenso_vigente, prob_pm_t24, outcome }
//   historial  filas pead_earnings del símbolo
//   gaps       filas pm_known_gaps del símbolo+trimestre
//   guia       fila pm_company_guidance del símbolo+trimestre (o null)
//   universo   Set de símbolos (default: los 99)
function filaV2({ mercado, historial = [], gaps = [], guia = null, universo = UNIVERSO }) {
  const mk = mercado || {};
  const symbol = mk.symbol || null;
  const fecha = isoDia(mk.fecha);
  const metrica_barra = mk.metrica_barra || null;
  const barra = num(mk.barra);
  const consenso_creacion = num(mk.consenso_creacion);
  const consenso_vigente = num(mk.consenso_vigente);
  const fuera_universo = !symbol || !universo.has(symbol);

  const hist = fuera_universo
    ? { n_8t: 0, sorpresa_mediana_8t: null, sorpresa_std_8t: null, beats_8t: null, sorpresa_metrica_match: metrica_barra === 'NONGAAP', ultimo_reporte: null }
    : sorpresaHistorica(historial, fecha, metrica_barra);
  const brecha = brechaConocida(gaps, metrica_barra, mk.creado);
  const g = guiaImplicita(guia);

  const estimado_v2 = estimadoV2({ metrica_barra, consenso_vigente, consenso_creacion, sorpresa_mediana_8t: hist.sorpresa_mediana_8t, brecha_aplicada: brecha.brecha_aplicada });
  const margen_v2 = estimado_v2 !== null && barra !== null ? redondea(estimado_v2 - barra) : null;
  const pr = probV2(margen_v2, hist.sorpresa_std_8t, hist.beats_8t, hist.sorpresa_metrica_match, { barra });
  const prob_pm_t24 = num(mk.prob_pm_t24);
  const desacuerdo = pr.prob_v2 !== null && prob_pm_t24 !== null ? redondea(pr.prob_v2 - prob_pm_t24) : null;

  // Por qué falta prob_v2, en una palabra. "Sin dato" no es un cero.
  const faltante = fuera_universo ? 'fuera_universo'
    : !metrica_barra ? (mk.metrica_motivo === 'metrica_ambigua' ? 'metrica_ambigua' : 'sin_metrica')
      : barra === null ? 'sin_barra'
        : (consenso_vigente ?? consenso_creacion) === null ? 'sin_consenso'
          : hist.sorpresa_mediana_8t === null ? 'sin_historial_8t'
            : null;

  return {
    market_id: mk.market_id || null, symbol, fecha,
    quarter_end: trimestreDelReporte(fecha),
    metrica_barra, metrica_via: mk.metrica_via || null, barra, consenso_creacion, consenso_vigente,
    consenso_usado: consenso_vigente !== null ? 'vigente' : consenso_creacion !== null ? 'creacion' : null,
    consenso_vs_barra_ok: consenso_creacion === null || barra === null ? null
      : Math.abs(consenso_creacion - barra) <= CRITERIOS_V2.tolerancia_consenso_barra + 1e-9,
    ...hist,
    ...brecha,
    ...g,
    barra_vs_guia: barraVsGuia(barra, g),
    estimado_v2, margen_v2,
    prob_v2: pr.prob_v2, std_usada: pr.std_usada, std_fallback: pr.std_fallback, std_piso: pr.std_piso || false,
    prob_pm_t24, desacuerdo,
    fuera_universo, faltante,
    outcome: mk.outcome ? String(mk.outcome).toLowerCase() : null,
    actual_eps: num(mk.actual_eps),
  };
}

// ═══════════════════ v2.1 — universo abierto, dos reglas ═══════════════════
//
// Decisiones de Lety (23-oct), pre-registradas acá y no elegidas después:
//   · prob_A = la fórmula de v2 tal cual (consenso + sorpresa mediana − brecha).
//   · prob_B = igual, pero si hay guía (trimestral o implícita de la anual) de
//     la MISMA métrica que la barra: estimado_B = promedio(estimado_A, medio de
//     la guía). Sin guía, o con guía de otra métrica, prob_B = prob_A.
//     Lo de "misma métrica" es la única regla que agregué: promediar una guía
//     GAAP con una barra non-GAAP mezcla dos números distintos.
//   · No se elige entre A y B. Si las dos pasan, se reporta cuál tiene mejor
//     Brier y la elección espera a un tercer set.
//   · El set de 22 queda como piloto ('piloto-oct26'), SIN veredicto.

const SET_PILOTO = 'piloto-oct26';

// El set v2.1 no es una lista: lo define la cosecha. Mercados de earnings de
// Polymarket CREADOS desde la fecha de corte y hasta el 30-nov-2026, que
// RESUELVAN antes del 31-dic-2026.
//
// FECHA DE CORTE: el encargo dice "la fecha de merge". El merge no tiene fecha
// todavía y el PR se abre listo para merge, sin pushes después. Así que el
// corte queda en el día que se abre el PR, que es cuando los criterios
// quedaron escritos. Si el merge cae después, entran los mercados creados
// entre la apertura y el merge: es una ventana más ANCHA, nunca una elegida
// mirando datos (docs/earnings-beat-v2.md §"v2.1").
const CRITERIOS_V21 = Object.freeze({
  set: 'v2.1',
  creado_desde: '2026-10-23', /* date-lint-ok: fecha de corte pre-registrada de v2.1 (apertura del PR) */
  creado_hasta: '2026-11-30', /* date-lint-ok: fin de la ventana de creación del set v2.1, pre-registrado */
  resuelve_antes: '2026-12-31', /* date-lint-ok: fin del set v2.1, pre-registrado */
  min_mercados: 40,            // con TODOS los datos (prob_A, prob_B, PM a T-24h, resolución)
  umbral_desacuerdo: 0.15,     // |prob − PM| > 15 pts
  acierto_min_zona: 0.65,      // la regla ganadora acierta ≥ 65% en esa zona
});

// ¿El mercado entra al set v2.1? creado: createdAt de Gamma; fecha: la de
// resolución/reporte.
function enSetV21(m, c = CRITERIOS_V21) {
  const creado = isoDia(m && m.creado);
  const fecha = isoDia(m && m.fecha);
  return !!(creado && fecha && creado >= c.creado_desde && creado <= c.creado_hasta && fecha < c.resuelve_antes);
}

// estimado_B: promedio con el medio de la guía, solo si la guía es de la misma
// métrica que la barra. Devuelve null si no hay estimado_A.
function estimadoB(estimado_A, guia_q_implicita, guia_metrica, metrica_barra) {
  const a = num(estimado_A);
  if (a === null) return { estimado_B: null, usa_guia: false };
  const g = num(guia_q_implicita);
  const misma = !guia_metrica || !metrica_barra || guia_metrica === metrica_barra;
  if (g === null || !misma) return { estimado_B: a, usa_guia: false };
  return { estimado_B: redondea((a + g) / 2), usa_guia: true };
}

// Una fila v2.1. A diferencia de filaV2, el universo es "tiene historial":
// pead_earnings para los 99, pm_v2_hist para el resto. fuenteHist dice de dónde
// vino; con pm_v2_hist la métrica de la sorpresa NO se sabe (AV no distingue
// GAAP de non-GAAP en reportedEPS) → sorpresa_metrica_match = null.
function filaV21({ mercado, historial = [], fuenteHist = null, gaps = [], guia = null, universoPead = UNIVERSO }) {
  const mk = mercado || {};
  const symbol = mk.symbol || null;
  const base = filaV2({ mercado: mk, historial, gaps, guia, universo: new Set(symbol ? [symbol] : []) });
  const universo_pead = !!(symbol && universoPead.has(symbol));
  const sorpresa_metrica_match = fuenteHist === 'pm_v2_hist' ? null : base.sorpresa_metrica_match;
  const faltante = !symbol ? 'sin_simbolo'
    : !fuenteHist && base.faltante === 'sin_historial_8t' ? 'sin_historial'
      : base.faltante;

  const { estimado_B, usa_guia } = estimadoB(base.estimado_v2, base.guia_q_implicita, guia && guia.metrica, base.metrica_barra);
  const margen_B = estimado_B !== null && base.barra !== null ? redondea(estimado_B - base.barra) : null;
  const prB = probV2(margen_B, base.sorpresa_std_8t, base.beats_8t, sorpresa_metrica_match, { barra: base.barra });
  const pm = base.prob_pm_t24;
  return {
    ...base,
    // En v2.1 "fuera_universo" es fuera del universo PEAD, informativo: ya no
    // impide el número si hay historial en pm_v2_hist.
    fuera_universo: !universo_pead,
    universo_pead, fuente_hist: fuenteHist, sorpresa_metrica_match, faltante,
    estimado_A: base.estimado_v2, margen_A: base.margen_v2, prob_A: base.prob_v2,
    estimado_B, margen_B, prob_B: prB.prob_v2, B_usa_guia: usa_guia,
    estimado_b: estimado_B, prob_b: prB.prob_v2,   // nombres de columna en pm_earnings_v2_features
    desacuerdo_A: base.prob_v2 !== null && pm !== null ? redondea(base.prob_v2 - pm) : null,
    desacuerdo_B: prB.prob_v2 !== null && pm !== null ? redondea(prB.prob_v2 - pm) : null,
    creado: isoDia(mk.creado),
  };
}

// Veredicto v2.1 (pre-registrado):
//   GO         si Brier(A) < Brier(PM) o Brier(B) < Brier(PM), sobre ≥ 40
//              mercados con todos los datos, Y la regla ganadora acierta ≥ 65%
//              donde |desacuerdo| > 15 pts.
//   NO-GO      si ninguna le gana al Brier de PM con ≥ 40 mercados.
//   INCONCLUSO si < 40 mercados con datos completos al 31-dic.
// Lo que la regla no dice, declarado antes de mirar (igual que en v2):
//   · regla ganadora con zona VACÍA → no cuenta como ganadora que pase;
//   · ganadora(s) que no llegan al 65% en la zona → NO-GO (no es GO);
//   · si A y B pasan, GO, se reporta cuál tiene mejor Brier, y NO se elige.
//   · antes del 31-dic el veredicto es PROVISIONAL (estado 'abierto').
function veredictoV21(filas, { criterios = CRITERIOS_V21, hoy = null } = {}) {
  const enSet = filas.filter((f) => enSetV21(f, criterios));
  const resueltas = enSet.filter((f) => f.outcome === 'yes' || f.outcome === 'no');
  const completas = resueltas.filter((f) => f.prob_A !== null && f.prob_B !== null && f.prob_pm_t24 !== null);
  const y = (f) => (f.outcome === 'yes' ? 1 : 0);
  const brier_pm = brier(completas.map((f) => [f.prob_pm_t24, y(f)]));
  const regla = (k) => {
    const b = brier(completas.map((f) => [f[k], y(f)]));
    const zona = completas.filter((f) => Math.abs(f[k] - f.prob_pm_t24) > criterios.umbral_desacuerdo);
    const ac = zona.filter((f) => acierto(f[k], f.outcome)).length;
    const gana = b !== null && brier_pm !== null && b < brier_pm;
    const pasa_zona = zona.length > 0 && ac / zona.length >= criterios.acierto_min_zona;
    return { brier: b, gana_brier: gana, zona_n: zona.length, zona_aciertos: ac,
      acierto_zona: zona.length ? redondea(ac / zona.length) : null, pasa: gana && pasa_zona };
  };
  const A = regla('prob_A');
  const B = regla('prob_B');
  const faltan = {};
  for (const f of resueltas.filter((x) => !completas.includes(x))) {
    const k = f.prob_pm_t24 === null && f.faltante === null ? 'sin_precio_pm' : (f.faltante || 'sin_precio_pm');
    faltan[k] = (faltan[k] || 0) + 1;
  }
  const abierto = !hoy || isoDia(hoy) < criterios.resuelve_antes;
  const base = {
    set: criterios.set, estado: abierto ? 'abierto' : 'cerrado',
    en_set: enSet.length, resueltas: resueltas.length, completas: completas.length,
    pendientes: enSet.length - resueltas.length, motivos_faltan: faltan,
    brier_pm, A, B,
  };
  let veredicto, motivo;
  if (completas.length < criterios.min_mercados) {
    veredicto = 'INCONCLUSO';
    motivo = `${completas.length} mercados con datos completos (< ${criterios.min_mercados}): falla de frontera, no veredicto`;
  } else if (!A.gana_brier && !B.gana_brier) {
    veredicto = 'NO-GO';
    motivo = `ni A (${A.brier}) ni B (${B.brier}) le ganan al Brier de PM (${brier_pm})`;
  } else if (A.pasa || B.pasa) {
    veredicto = 'GO';
    const pasan = [A.pasa && 'A', B.pasa && 'B'].filter(Boolean);
    const mejor = pasan.length === 2 ? (A.brier <= B.brier ? 'A' : 'B') : pasan[0];
    motivo = pasan.length === 2
      ? `pasan A y B; mejor Brier: ${mejor}. No se elige: eso espera a un tercer set`
      : `pasa ${mejor} (Brier ${mejor === 'A' ? A.brier : B.brier} < PM ${brier_pm}, zona ${mejor === 'A' ? `${A.zona_aciertos}/${A.zona_n}` : `${B.zona_aciertos}/${B.zona_n}`})`;
  } else {
    veredicto = 'NO-GO';
    motivo = 'le gana al Brier de PM pero en la zona de desacuerdo no llega al 65% (o la zona está vacía)';
  }
  return { ...base, veredicto: abierto ? `${veredicto} (provisional)` : veredicto, motivo };
}

// ─────────────────── consenso vigente (Alpha Vantage) ───────────────────

// events: salida de parseEarnings (av-earnings.js). El trimestre que viene
// aparece con reportedEPS 'None' y estimatedEPS lleno — CUANDO aparece: AV no
// lo publica para todos los símbolos ni con la misma anticipación. Se toma el
// evento sin reportar cuyo fiscal_date_ending cae en el trimestre del reporte
// (± 45 días, por los fiscales no calendario). Sin eso → null, y se dice.
function estimadoVigenteDeAv(events, quarter_end) {
  const q = isoDia(quarter_end);
  if (!q || !Array.isArray(events)) return { valor: null, motivo: 'sin_trimestre' };
  const qms = Date.parse(q + 'T00:00:00Z');
  const candidatos = events
    .filter((e) => e && e.reported_eps === null && num(e.estimated_eps) !== null)
    .map((e) => ({ e, dist: Math.abs(Date.parse(e.fiscal_date_ending + 'T00:00:00Z') - qms) / 86400000 }))
    .filter((x) => x.dist <= 45)
    .sort((a, b) => a.dist - b.dist);
  if (!candidatos.length) return { valor: null, motivo: 'av_sin_estimado_del_trimestre' };
  return { valor: num(candidatos[0].e.estimated_eps), motivo: null, fiscal_date_ending: candidatos[0].e.fiscal_date_ending };
}

// ── Diagnóstico del consenso vigente (25-oct) ──
// Con EARNINGS_V2_VIGENTE_ENABLED=1, las 68 filas abiertas seguían con
// consenso_vigente null, y el latido no guardaba qué había contestado AV.
// Estas dos funciones son para VER eso, no cambian ninguna fórmula.

// Resumen chico de una captura, para el latido (cron_heartbeat.detail).
function resumenCaptura(captura) {
  const c = captura || {};
  const por_estado = {};
  for (const i of c.intentos || []) por_estado[i.estado] = (por_estado[i.estado] || 0) + 1;
  return {
    activa: !!c.activa, error: c.error || null,
    llamadas: c.llamadas ?? 0, cupo_libre_antes: c.cupo_libre_antes ?? null,
    por_estado,
    muestras: (c.intentos || []).slice(0, 8).map((i) => `${i.symbol}:${i.estado}${i.valor !== undefined ? '=' + i.valor : ''}`),
  };
}

// EARNINGS_CALENDAR de Alpha Vantage viene en CSV:
//   symbol,name,reportDate,fiscalDateEnding,estimate,currency
// UNA llamada trae todos los reportes de los próximos 3 meses. Se parsea por
// nombre de columna, no por posición: si AV cambia el orden, no se mezclan.
// Un cuerpo que no es CSV (el JSON de "Note"/"Information" del rate limit)
// devuelve status y ninguna fila.
function parseCalendarioCsv(texto) {
  const t = String(texto || '').trim();
  if (!t) return { status: 'vacio', filas: [] };
  if (t.startsWith('{')) {
    let body = null;
    try { body = JSON.parse(t); } catch (e) { /* no era JSON */ }
    if (body && (body.Note || body.Information)) return { status: 'rate_limited', filas: [], mensaje: String(body.Note || body.Information) };
    return { status: 'no_csv', filas: [] };
  }
  const lineas = t.split(/\r?\n/).filter(Boolean);
  const cab = lineas[0].split(',').map((x) => x.trim());
  const idx = (n) => cab.indexOf(n);
  if (idx('symbol') < 0 || idx('estimate') < 0) return { status: 'cabecera_inesperada', filas: [], cabecera: cab };
  // El nombre de la empresa puede traer comas entre comillas.
  const celdas = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const filas = lineas.slice(1).map((l) => {
    const c = celdas(l);
    return {
      symbol: c[idx('symbol')] || null,
      report_date: isoDia(c[idx('reportDate')]),
      fiscal_date_ending: isoDia(c[idx('fiscalDateEnding')]),
      estimate: num(c[idx('estimate')]),
      currency: idx('currency') >= 0 ? c[idx('currency')] || null : null,
    };
  }).filter((f) => f.symbol);
  return { status: 'ok', filas, cabecera: cab };
}

// ─────────────────── validación: Brier y veredicto ───────────────────

// acierto = el lado > 50% coincide con la resolución. 50% exacto no acierta.
function acierto(p, outcome) {
  if (p === null || p === undefined || !outcome) return null;
  if (p === 0.5) return false;
  return (p > 0.5) === (outcome === 'yes');
}

function brier(pares) {
  if (!pares.length) return null;
  return redondea(pares.reduce((a, [p, y]) => a + (p - y) ** 2, 0) / pares.length);
}

// filas: salida de filaV2 para los 22 del set. Pre-registrado:
//   INCONCLUSO si faltan > 4 de 22 por datos (fuera de universo, consenso o
//              historial nulos, o sin precio de Polymarket a T-24h).
//   NO-GO      si Brier(v2) ≥ Brier(PM).
//   GO         si Brier(v2) < Brier(PM) Y en |d| > 15 pts v2 acierta ≥ 70%.
// Lo que la regla no cubre se declara: zona vacía = falla de frontera
// (INCONCLUSO, igual que v1); Brier mejor pero zona < 70% = no es GO → NO-GO.
function veredictoV2(filas, { criterios = CRITERIOS_V2, total = VALIDACION_V2.length } = {}) {
  const resueltas = filas.filter((f) => f.outcome === 'yes' || f.outcome === 'no');
  const pendientes = total - resueltas.length;
  const faltan = filas.filter((f) => f.prob_v2 === null || f.prob_pm_t24 === null);
  const motivosFaltan = {};
  for (const f of faltan) {
    const k = f.faltante || (f.prob_pm_t24 === null ? 'sin_precio_pm' : 'otro');
    motivosFaltan[k] = (motivosFaltan[k] || 0) + 1;
  }
  const evaluables = resueltas.filter((f) => f.prob_v2 !== null && f.prob_pm_t24 !== null);
  const y = (f) => (f.outcome === 'yes' ? 1 : 0);
  const brier_v2 = brier(evaluables.map((f) => [f.prob_v2, y(f)]));
  const brier_pm = brier(evaluables.map((f) => [f.prob_pm_t24, y(f)]));
  const zona = evaluables.filter((f) => Math.abs(f.prob_v2 - f.prob_pm_t24) > criterios.umbral_desacuerdo);
  const aciertos_zona = zona.filter((f) => acierto(f.prob_v2, f.outcome)).length;
  const acierto_zona = zona.length ? redondea(aciertos_zona / zona.length) : null;

  const base = {
    total, resueltas: resueltas.length, pendientes, evaluables: evaluables.length,
    faltan: faltan.length, motivos_faltan: motivosFaltan,
    brier_v2, brier_pm, zona_n: zona.length, zona_aciertos: aciertos_zona, acierto_zona,
    aciertos_v2: evaluables.filter((f) => acierto(f.prob_v2, f.outcome)).length,
    aciertos_pm: evaluables.filter((f) => acierto(f.prob_pm_t24, f.outcome)).length,
  };
  if (faltan.length > criterios.max_faltantes) {
    return { ...base, veredicto: 'INCONCLUSO', motivo: `faltan ${faltan.length} de ${total} por datos (tope ${criterios.max_faltantes})` };
  }
  if (pendientes > 0) return { ...base, veredicto: 'PENDIENTE', motivo: `${pendientes} de ${total} sin resolver` };
  if (brier_v2 === null || brier_pm === null) return { ...base, veredicto: 'INCONCLUSO', motivo: 'sin mercados evaluables' };
  if (brier_v2 >= brier_pm) return { ...base, veredicto: 'NO-GO', motivo: `Brier v2 ${brier_v2} ≥ Brier PM ${brier_pm}` };
  if (!zona.length) return { ...base, veredicto: 'INCONCLUSO', motivo: 'cero mercados con |desacuerdo| > 15 pts: falla de frontera, no veredicto' };
  if (acierto_zona < criterios.acierto_min_zona) return { ...base, veredicto: 'NO-GO', motivo: `Brier mejor, pero en la zona de desacuerdo v2 acierta ${aciertos_zona}/${zona.length} (< 70%)` };
  return { ...base, veredicto: 'GO', motivo: `Brier v2 ${brier_v2} < PM ${brier_pm} y zona ${aciertos_zona}/${zona.length}` };
}

// ─────────────────── markdown ───────────────────

const pct = (p) => (p === null || p === undefined ? '—' : `${Math.round(p * 100)}%`);
const n2 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
// La guía implícita lleva 3 decimales: PCG da 0.405–0.415 y con 2 se ve 0.41–0.41.
const n3 = (x) => (x === null || x === undefined ? '—' : String(+Number(x).toFixed(3)));
const sgn = (x) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${Math.round(x * 100)}`);

function tablaMd(filas) {
  const head = '| Símbolo | Fecha | Barra | Métrica | Consenso | Sorpresa med. 8T | Beats 8T | Brecha | Guía impl. | Estimado v2 | prob v2 | prob PM | Desacuerdo | Falta |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = filas.map((f) => {
    const cons = f.consenso_vigente ?? f.consenso_creacion;
    const guia = f.guia_q_implicita === null || f.guia_q_implicita === undefined ? '—'
      : `${n3(f.guia_q_min)}…${n3(f.guia_q_max)}${f.barra_vs_guia ? ` (barra ${f.barra_vs_guia})` : ''}`;
    const brecha = f.brecha_aplicada ? n2(f.brecha_aplicada) : (f.cargo_ambas_metricas || f.brecha_gaap_adj) ? `0 (${n2(f.brecha_gaap_adj)} solo GAAP)` : '0';
    return `| ${f.symbol} | ${f.fecha} | ${n2(f.barra)} | ${f.metrica_barra || '—'} | ${n2(cons)}${f.consenso_usado === 'vigente' ? ' (vig.)' : ''} | ${f.sorpresa_mediana_8t === null ? '—' : `${f.sorpresa_mediana_8t > 0 ? '+' : ''}${f.sorpresa_mediana_8t.toFixed(2)}`}${f.sorpresa_metrica_match === false && f.sorpresa_mediana_8t !== null ? '*' : ''} | ${!f.n_8t ? '—' : `${f.beats_8t}/${f.n_8t}`} | ${brecha} | ${guia} | ${n2(f.estimado_v2)} | ${pct(f.prob_v2)}${f.std_fallback ? '†' : ''} | ${pct(f.prob_pm_t24)} | ${sgn(f.desacuerdo)} | ${f.faltante || (f.prob_pm_t24 === null ? 'sin_precio_pm' : '')} |`;
  });
  return [head, sep, ...rows].join('\n');
}

function lineaResuelto(f) {
  const sale = f.outcome === 'yes' ? 'Yes' : 'No';
  const act = f.actual_eps === null || f.actual_eps === undefined ? '' : ` (${n2(f.actual_eps)})`;
  const v2 = f.prob_v2 === null ? `v2 no da número (${f.faltante})` : `v2 dijo ${pct(f.prob_v2)}`;
  const pm = f.prob_pm_t24 === null ? 'PM sin precio a T-24h en la tabla' : `PM dijo ${pct(f.prob_pm_t24)}`;
  const a = acierto(f.prob_v2, f.outcome);
  const marca = a === null ? '' : a ? ' → v2 acierta' : ' → v2 falla';
  return `- **${f.symbol} ${f.fecha}**: ${v2}, ${pm}, salió ${sale}${act}${marca}.`;
}

function renderMd({ titulo, filas, veredicto = null, notas = [] }) {
  const out = [`# ${titulo}`, ''];
  out.push('Papel. Una columna de aritmética, no una recomendación. Nada de esto va a la tab EARNINGS hasta que haya veredicto.', '');
  if (veredicto) {
    out.push(`**Veredicto del set de validación: ${veredicto.veredicto}** — ${veredicto.motivo}.`, '');
    out.push(`Resueltos ${veredicto.resueltas}/${veredicto.total} · evaluables ${veredicto.evaluables} · faltan por datos ${veredicto.faltan} (${Object.entries(veredicto.motivos_faltan).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'})`);
    out.push(`Brier v2 ${veredicto.brier_v2 ?? '—'} · Brier PM ${veredicto.brier_pm ?? '—'} · zona |d|>15: ${veredicto.zona_aciertos}/${veredicto.zona_n}`, '');
  }
  out.push(tablaMd(filas), '');
  out.push('`*` sorpresa en EPS ajustado (pead_earnings) contra una barra GAAP: sorpresa_metrica_match = false. `†` std de respaldo (0.05 × |barra|). Guía implícita: informativa, no entra al estimado.', '');
  const res = filas.filter((f) => f.outcome);
  if (res.length) {
    out.push('## Resueltos', '', ...res.map(lineaResuelto), '');
  }
  if (notas.length) out.push('## Notas', '', ...notas.map((n) => `- ${n}`), '');
  return out.join('\n');
}

// ── markdown v2.1: prob_A y prob_B lado a lado ──
function tablaMdV21(filas) {
  const head = '| Símbolo | Fecha | Barra | Métrica | Consenso | Sorpresa med. 8T | Hist. | Brecha | Guía impl. | Est. A | Est. B | prob A | prob B | prob PM | d A | d B | Falta |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = filas.map((f) => {
    const cons = f.consenso_vigente ?? f.consenso_creacion;
    const guia = f.guia_q_implicita === null || f.guia_q_implicita === undefined ? '—'
      : `${n3(f.guia_q_min)}…${n3(f.guia_q_max)}${f.barra_vs_guia ? ` (barra ${f.barra_vs_guia})` : ''}`;
    const sorp = f.sorpresa_mediana_8t === null || f.sorpresa_mediana_8t === undefined ? '—'
      : `${f.sorpresa_mediana_8t > 0 ? '+' : ''}${f.sorpresa_mediana_8t.toFixed(2)}${f.sorpresa_metrica_match === null ? '‡' : f.sorpresa_metrica_match === false ? '*' : ''}`;
    const hist = !f.n_8t ? '—' : `${f.beats_8t}/${f.n_8t} ${f.fuente_hist === 'pm_v2_hist' ? 'AV' : 'PEAD'}`;
    const falta = f.faltante || (f.prob_pm_t24 === null ? 'sin_precio_pm' : '');
    return `| ${f.symbol} | ${f.fecha} | ${n2(f.barra)} | ${f.metrica_barra || '—'} | ${n2(cons)}${f.consenso_usado === 'vigente' ? ' (vig.)' : ''} | ${sorp} | ${hist} | ${n2(f.brecha_aplicada)}${f.brechas_anunciadas_antes_de_creacion ? '§' : ''} | ${guia} | ${n2(f.estimado_A)} | ${n2(f.estimado_B)}${f.B_usa_guia || f.estimado_B === null ? '' : ' (=A)'} | ${pct(f.prob_A)}${f.std_fallback ? '†' : ''} | ${pct(f.prob_B)} | ${pct(f.prob_pm_t24)} | ${sgn(f.desacuerdo_A)} | ${sgn(f.desacuerdo_B)} | ${falta} |`;
  });
  return [head, sep, ...rows].join('\n');
}

function lineaResueltoV21(f) {
  const sale = f.outcome === 'yes' ? 'Yes' : 'No';
  const act = f.actual_eps === null || f.actual_eps === undefined ? '' : ` (${n2(f.actual_eps)})`;
  const v = (k, nombre) => (f[k] === null ? `${nombre} sin número` : `${nombre} dijo ${pct(f[k])}${acierto(f[k], f.outcome) ? ' ✓' : ' ✗'}`);
  const pm = f.prob_pm_t24 === null ? 'PM sin precio a T-24h' : `PM dijo ${pct(f.prob_pm_t24)}${acierto(f.prob_pm_t24, f.outcome) ? ' ✓' : ' ✗'}`;
  const motivo = f.prob_A === null && f.faltante ? ` [${f.faltante}]` : '';
  return `- **${f.symbol} ${f.fecha}**: ${v('prob_A', 'A')}, ${v('prob_B', 'B')}, ${pm}, salió ${sale}${act}.${motivo}`;
}

// piloto: sin veredicto (decisión del 23-oct). veredicto: el de v2.1, o null.
function renderMdV21({ titulo, filas, veredicto = null, piloto = false, notas = [] }) {
  const out = [`# ${titulo}`, ''];
  out.push('Papel. Aritmética, no recomendación. Nada de esto va a la tab EARNINGS. No se elige entre A y B.', '');
  if (piloto) {
    const res = filas.filter((f) => f.outcome);
    const con = (k) => res.filter((f) => f[k] !== null).length;
    out.push(`**Piloto ${SET_PILOTO}: SIN veredicto.** ${filas.length} mercados · resueltos ${res.length} · con prob A ${con('prob_A')} · con prob B ${con('prob_B')} · con PM a T-24h ${con('prob_pm_t24')}.`, '');
  }
  if (veredicto) {
    const r = (x) => `Brier ${x.brier ?? '—'} (${x.gana_brier ? 'gana' : 'no gana'} a PM) · zona |d|>15: ${x.zona_aciertos}/${x.zona_n}`;
    out.push(`**Set ${veredicto.set}: ${veredicto.veredicto}** — ${veredicto.motivo}.`, '');
    out.push(`En el set ${veredicto.en_set} · resueltos ${veredicto.resueltas} · completos ${veredicto.completas} · pendientes ${veredicto.pendientes} · faltan (${Object.entries(veredicto.motivos_faltan).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'})`);
    out.push(`Brier PM ${veredicto.brier_pm ?? '—'} · A: ${r(veredicto.A)} · B: ${r(veredicto.B)}`, '');
  }
  out.push(tablaMdV21(filas), '');
  out.push('`‡` historial de Alpha Vantage para un símbolo fuera del universo PEAD: no se sabe si es GAAP o non-GAAP (sorpresa_metrica_match = null). `*` sorpresa ajustada contra barra GAAP. `†` std de respaldo. `(=A)` sin guía de la misma métrica: prob B = prob A. `§` el cargo se anunció ANTES de que naciera el mercado (dato; la brecha se aplica igual).', '');
  const res = filas.filter((f) => f.outcome);
  if (res.length) out.push('## Resueltos', '', ...res.map(lineaResueltoV21), '');
  if (notas.length) out.push('## Notas', '', ...notas.map((n) => `- ${n}`), '');
  return out.join('\n');
}

export {
  CRITERIOS_V2, CORTE_VALIDACION, VALIDACION_V2, UNIVERSO,
  metricaBarra, leeMetrica, oracionPrincipal, fechaDelSlug, eligeMercadoPiloto, leeMercado, sorpresaHistorica, trimestreDelReporte,
  brechaConocida, guiaImplicita, barraVsGuia, estimadoV2, normalCdf, probV2,
  filaV2, acierto, brier, veredictoV2, tablaMd, lineaResuelto, renderMd, mediana, desvio,
  estimadoVigenteDeAv, resumenCaptura, parseCalendarioCsv,
  SET_PILOTO, CRITERIOS_V21, enSetV21, estimadoB, filaV21, veredictoV21, tablaMdV21, lineaResueltoV21, renderMdV21,
};
