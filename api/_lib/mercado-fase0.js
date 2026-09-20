// ═══════════════════════════════════════════════════════════════════
// api/_lib/mercado-fase0.js — el MEDIDOR de la Fase 0 de /mercado.
//
// Contesta las 10 preguntas del censo (docs/mercado-fase0.md §2) con
// números, no con opiniones. TODO lo de acá es PURO: sin fetch, sin DB, sin
// Date.now() escondido. Entra JSON crudo (de Neon, de Yahoo, de Finnhub, de
// EDGAR) y sale una estructura normalizada con su veredicto.
//
// Por qué puro: el sandbox donde se escribe esto NO tiene salida a
// query1.finance.yahoo.com, finnhub.io ni data.sec.gov — el proxy de egress
// de la organización contesta 403 al CONNECT (evidencia pegada en
// docs/mercado-fase0.md §0). Sin red no se ganan los números de las fuentes;
// sí se puede probar que el instrumento MIDE BIEN, que es la otra mitad de no
// inventar nada. Los números se ganan corriendo /api/mercado-censo desde
// Vercel, que es justo el sitio donde el producto va a vivir.
//
// Es el mismo patrón que ya se usó en la Fase 0 de HISTORIA
// (scripts/historia-phase0-probe.mjs + tests/historia-phase0-probe.test.mjs):
// medidor probado contra fixtures, compuertas fijadas ANTES de ver un dato.
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO: no dibuja nada, no toca app.html,
// no llama a ninguna IA, y no decide el diseño de ninguna rebanada. La Fase 0
// es censo y smoke.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────── COMPUERTAS (CONGELADAS) ───────────────────
// Fijadas ANTES de correr nada. El endpoint las devuelve en cada respuesta.
// Un umbral escrito después de ver el número no es un umbral, es una
// racionalización — y si alguien mueve una portería, el diff lo delata.
export const CRITERIOS = {
  version: 1,

  // G1 — universo US. Un mapa por sector necesita que CADA sector tenga con
  // qué llenarse. Con 3 nombres en Utilities el cuadro no es un sector, es
  // una anécdota. El piso es por sector, no global: un total grande con un
  // sector vacío sigue siendo un mapa mentiroso.
  g1_min_tickers_con_cap: 120,      // del universo que se vaya a pintar
  g1_min_por_sector: 5,             // nombres con cap Y sector, por sector GICS
  g1_min_sectores: 9,               // de los 11 GICS; menos que esto no es "por sector"
  g1_max_horas_frescura_cap: 192,   // 8 días: el TTL largo de arena_market_cap (7d) + margen

  // G2 — capitalización MX. El encargo lo fija: >5% de error → gris punteado.
  // El umbral de ACEPTACIÓN es el mismo número leído al revés.
  g2_max_error_pct: 5,
  g2_min_emisoras_verificadas: 15,  // de las 30 de emisoras.json; menos = el mapa MX no sale

  // G3 — precios en batch. La meta de producto es /mercado interactivo en
  // <1.5s en 4G. El presupuesto del SERVIDOR es más chico que eso: el cliente
  // todavía tiene que bajar el HTML, parsear y pintar.
  g3_max_ms_endpoint: 800,          // p95 del endpoint de mapa, cache-miss incluido
  g3_max_ms_cache_hit: 150,

  // G4 — retorno total. No hay umbral: es binario. O el chart devuelve
  // adjclose y el factor se puede derivar, o no.
  // G5 — fundamentales. Cuántos de los 12 campos pedidos trae `metric`.
  g5_min_campos_metric: 8,          // de 12; menos = la hoja de ticker va medio vacía
  // G6 — UPA real vs estimado.
  g6_min_trimestres_upa: 4,         // el encargo pide 4–8
  // G7 — ingresos/utilidad por trimestre con cita.
  g7_min_trimestres_facts: 8,
  // G9 — Form 4 completo.
  g9_min_codigos: 4,                // además de P: al menos S, A, M y uno más

  // G11 — punto 0.10 de la adenda: feeds de noticias.
  //
  // El piso NO es "cuántos feeds contestan 200": es cuántos entregan items
  // USABLES bajo la regla 3 del encargo (titular original + fuente + link) y
  // con FECHA parseable, porque "lo de hoy" muestra la hora del titular y un
  // feed sin pubDate la obligaría a inventarse.
  g11_min_feeds_vivos: 3,           // menos que esto y "lo de hoy" no se llena
  g11_min_items_por_feed: 5,        // un feed con 2 items es un feed muerto con 200
  g11_min_pct_con_fecha: 90,        // % de items del feed con pubDate parseable
};

// Los 12 campos que la ficha de ticker pide de `metric` de Finnhub (§2.5 del
// encargo). El nombre de la izquierda es el nuestro; la derecha son las
// grafías candidatas de Finnhub, EN ORDEN — gana la primera que exista.
//
// Son candidatas y no una tabla cerrada a propósito: Finnhub mezcla sufijos
// (TTM / Annual / Quarterly) y no documenta cuáles trae el tier gratis. El
// censo REPORTA cuál resolvió, así que la respuesta no depende de que yo haya
// adivinado bien la grafía.
export const CAMPOS_METRIC = [
  ['cap',        ['marketCapitalization']],
  ['ev',         ['enterpriseValue']],
  ['pe',         ['peTTM', 'peBasicExclExtraTTM', 'peAnnual']],
  ['pe_fwd',     ['forwardPE', 'peForward', 'peNormalizedAnnual']],
  ['peg',        ['pegTTM', 'pegRatio', 'pegAnnual']],
  ['ps',         ['psTTM', 'psAnnual']],
  ['pb',         ['pbQuarterly', 'pbAnnual']],
  ['ev_rev',     ['evToRevenueTTM', 'currentEv/freeCashFlowTTM']],
  ['margen',     ['netProfitMarginTTM', 'netProfitMarginAnnual']],
  ['roa',        ['roaTTM', 'roaRfy', 'roaAnnual']],
  ['roe',        ['roeTTM', 'roeRfy', 'roeAnnual']],
  ['dividendo',  ['dividendYieldIndicatedAnnual', 'currentDividendYieldTTM', 'dividendPerShareTTM']],
];

// Códigos de transacción de un Form 4 (tabla I y II del formato de la SEC).
// P y S son los que ya se muestran; el encargo pide TODAS (R5 abre con
// "Todas las transacciones"), así que el censo cuenta cuáles aparecen.
export const CODIGOS_FORM4 = ['P', 'S', 'A', 'M', 'F', 'G', 'C', 'D', 'X', 'J', 'K'];

// El parser de fechas vive en mercado-r0.js y se importa en vez de
// duplicarse: dos parsers de fecha que se desincronizan es cómo un feed
// pasa en un lado y falla en el otro sin que nadie entienda por qué.
import { parseFechaFeed } from './mercado-r0.js';

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const up = (s) => String(s || '').trim().toUpperCase();

// ═══════════════════════════════════════════════════════════════════
// Q1 — ¿alcanza el universo US para un mapa por sector?
// ═══════════════════════════════════════════════════════════════════

/**
 * Cruza las tres tablas de Neon que hoy tienen algo que decir del universo US
 * y reporta con cuántos nombres se puede pintar un treemap por sector.
 *
 * `screener`  → filas de arena_screener (métricas; NO trae cap ni sector).
 * `caps`      → filas de arena_market_cap [{symbol, market_cap, fetched_at}].
 * `sectores`  → mapa { SYMBOL: 'XLK' | … } del canal assets:sector del buffet.
 * `universo`  → símbolos de arena_universe (S&P500 + Nasdaq100 + movers).
 *
 * `ahora` se INYECTA: la frescura es una resta contra un reloj, y un reloj
 * escondido hace que el test mida la hora en que corrió en vez del dato.
 */
export function censoUniversoUs({ screener = [], caps = [], sectores = {}, universo = [], ahora }) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const capOf = new Map();
  let masViejo = null;
  for (const f of caps) {
    const c = num(f && f.market_cap);
    if (c == null || c <= 0) continue;
    const sym = up(f.symbol);
    capOf.set(sym, c);
    const t = f.fetched_at ? new Date(f.fetched_at).getTime() : NaN;
    if (Number.isFinite(t) && (masViejo == null || t < masViejo)) masViejo = t;
  }

  const secOf = new Map(Object.entries(sectores || {}).map(([k, v]) => [up(k), v || null]));
  const candidatos = [...new Set([
    ...screener.map((r) => up(r && r.symbol)),
    ...universo.map(up),
  ].filter(Boolean))];

  const porSector = {};
  let conCap = 0, conSector = 0, conAmbos = 0;
  for (const sym of candidatos) {
    const tieneCap = capOf.has(sym);
    const sec = secOf.get(sym) || null;
    if (tieneCap) conCap++;
    if (sec) conSector++;
    if (tieneCap && sec) {
      conAmbos++;
      porSector[sec] = (porSector[sec] || 0) + 1;
    }
  }

  const sectoresConPiso = Object.entries(porSector)
    .filter(([, n]) => n >= CRITERIOS.g1_min_por_sector)
    .map(([s]) => s)
    .sort();

  const horasFrescura = masViejo == null ? null
    : Math.round(((now.getTime() - masViejo) / 3600000) * 10) / 10;

  const razones = [];
  if (conAmbos < CRITERIOS.g1_min_tickers_con_cap)
    razones.push(`solo ${conAmbos} nombres tienen cap Y sector (piso ${CRITERIOS.g1_min_tickers_con_cap})`);
  if (sectoresConPiso.length < CRITERIOS.g1_min_sectores)
    razones.push(`solo ${sectoresConPiso.length} sectores llegan a ${CRITERIOS.g1_min_por_sector} nombres (piso ${CRITERIOS.g1_min_sectores})`);
  if (horasFrescura != null && horasFrescura > CRITERIOS.g1_max_horas_frescura_cap)
    razones.push(`la cap más vieja tiene ${horasFrescura}h (techo ${CRITERIOS.g1_max_horas_frescura_cap}h)`);
  if (horasFrescura == null && conCap > 0)
    razones.push('hay caps sin fetched_at: la frescura no se puede medir');

  return {
    candidatos: candidatos.length,
    con_cap: conCap,
    con_sector: conSector,
    con_cap_y_sector: conAmbos,
    por_sector: porSector,
    sectores_con_piso: sectoresConPiso,
    horas_frescura_cap_mas_vieja: horasFrescura,
    verde: razones.length === 0,
    razones,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q2 — capitalización MX: la trampa de las series
// ═══════════════════════════════════════════════════════════════════

/**
 * LA TRAMPA, escrita como código para que no se pueda olvidar.
 *
 * `xbrl_reports.acciones_circulacion` viene del tag ICS
 * `NumeroDeAccionesEnCirculacion`, que es UN número INSTANTÁNEO por emisora:
 * el total del capital social. NO tiene dimensión de serie. Entonces:
 *
 *   cap = acciones_totales × precio_de_UNA_serie
 *
 * es correcto SOLO si la emisora tiene una sola serie y esa serie es una
 * acción, no una unidad vinculada. Falla de dos maneras distintas:
 *
 *   (a) VARIAS SERIES a precios distintos (AMX serie A vs B; LIVEPOL C-1
 *       vs 1). Usar el precio de la más cara infla, el de la más barata
 *       desinfla. El error es del orden de la brecha entre series.
 *   (b) UNIDADES VINCULADAS (FEMSA UBD = un paquete de varias acciones;
 *       CEMEX CPO; GAP/ASUR/OMA B). Ahí el precio NO es por acción sino por
 *       paquete, así que acciones_totales × precio_de_la_unidad multiplica la
 *       cap por el tamaño del paquete. El error no es de puntos: es de veces.
 *
 * Por eso esta función NO devuelve "la" capitalización. Devuelve las dos
 * lecturas y deja que el veredicto lo dé la comparación contra una referencia
 * pública — que es lo único que puede distinguir (a) de (b) sin conocer de
 * antemano la estructura de capital de cada emisora.
 *
 * `precios` = [{ emisora_serie, cierre }] — las series vivas de bmv_precios.
 */
export function capMxCandidatas({ clave, acciones_circulacion, precios = [] }) {
  const acciones = num(acciones_circulacion);
  const series = precios
    .map((p) => ({ serie: String((p && p.emisora_serie) || ''), cierre: num(p && p.cierre) }))
    .filter((p) => p.serie && p.cierre != null && p.cierre > 0);

  if (acciones == null || acciones <= 0) {
    return { clave, acciones: null, n_series: series.length, candidatas: [], motivo: 'sin acciones_circulacion' };
  }
  if (!series.length) {
    return { clave, acciones, n_series: 0, candidatas: [], motivo: 'sin precio de ninguna serie' };
  }

  // Una candidata por serie: "y si el total de acciones se valuara a ESTE
  // precio". Ordenadas por serie para que el reporte sea determinista.
  const candidatas = series
    .slice()
    .sort((a, b) => (a.serie < b.serie ? -1 : a.serie > b.serie ? 1 : 0))
    .map((s) => ({ serie: s.serie, precio: s.cierre, cap: acciones * s.cierre }));

  return { clave, acciones, n_series: series.length, candidatas, motivo: null };
}

/** Error relativo en %, con signo. `ref` es la referencia pública. */
export function errorPct(calc, ref) {
  const c = num(calc), r = num(ref);
  if (c == null || r == null || r === 0) return null;
  return ((c - r) / Math.abs(r)) * 100;
}

/**
 * Veredicto por emisora. Elige la candidata MÁS CERCANA a la referencia y
 * reporta su error. Elegir la más cercana no es hacer trampa: la pregunta de
 * la Fase 0 es "¿EXISTE una serie con la que el cálculo cuadre?". Si ni la
 * mejor cuadra, ninguna lo hace, y la emisora sale gris punteada.
 *
 * `umbral` es el 5% del encargo. >umbral → 'gris_punteado' (la emisora se
 * pinta sin tamaño, "sin capitalización verificada"), nunca un tamaño
 * inventado.
 */
export function veredictoCapMx(candidatas, referencia, umbral = CRITERIOS.g2_max_error_pct) {
  const ref = num(referencia);
  const lista = (candidatas && candidatas.candidatas) || [];
  if (ref == null) {
    return { clave: candidatas && candidatas.clave, estado: 'gris_punteado', motivo: 'sin capitalización de referencia', mejor: null, error_pct: null };
  }
  if (!lista.length) {
    return { clave: candidatas.clave, estado: 'gris_punteado', motivo: candidatas.motivo || 'sin candidatas', mejor: null, error_pct: null };
  }
  let mejor = null;
  for (const c of lista) {
    const e = errorPct(c.cap, ref);
    if (e == null) continue;
    if (mejor == null || Math.abs(e) < Math.abs(mejor.error_pct)) mejor = { ...c, error_pct: e };
  }
  if (!mejor) {
    return { clave: candidatas.clave, estado: 'gris_punteado', motivo: 'referencia no comparable', mejor: null, error_pct: null };
  }
  const ok = Math.abs(mejor.error_pct) <= umbral;
  return {
    clave: candidatas.clave,
    estado: ok ? 'verificada' : 'gris_punteado',
    motivo: ok ? null : `error ${mejor.error_pct.toFixed(1)}% con la mejor serie (${mejor.serie}), techo ${umbral}%`,
    mejor: { serie: mejor.serie, precio: mejor.precio, cap: mejor.cap },
    // Múltiplo contra la referencia: delata el caso (b) —unidades vinculadas—
    // de un vistazo. ~5× en FEMSA UBD no es "un error de 400%", es un paquete
    // de 5 acciones leído como si fuera una.
    multiplo_vs_referencia: mejor.cap / ref,
    error_pct: mejor.error_pct,
    referencia: ref,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q3 — presupuesto de precios en batch
// ═══════════════════════════════════════════════════════════════════

/**
 * Cuánto tarda poblar un mapa, bajo cada una de las dos arquitecturas que el
 * encargo pide comparar. Aritmética explícita, no una corazonada.
 *
 *   'on_request'  → la lambda abre los fetches a Yahoo en el cache-miss.
 *                   Tiempo ≈ ceil(n / concurrencia) × ms_por_simbolo.
 *   'cron_neon'   → el cron ya dejó las filas en Neon; la lambda hace UNA
 *                   consulta. Tiempo ≈ ms_consulta_neon (no depende de n).
 *
 * El cache-hit del CDN es el mismo bajo las dos: el s-maxage sirve la copia
 * sin tocar la función. Por eso el número que decide NO es el promedio, es el
 * MISS — que es lo que le toca al primero que entra después de cada ventana.
 */
export function presupuestoPrecios({
  n_us = 0, n_mx = 0, n_idx = 0,
  ms_por_simbolo = 250, concurrencia = 8, ms_consulta_neon = 120,
} = {}) {
  const n = n_us + n_mx + n_idx;
  const tandas = concurrencia > 0 ? Math.ceil(n / concurrencia) : n;
  const on_request_ms = tandas * ms_por_simbolo;
  const cron_neon_ms = ms_consulta_neon;
  return {
    simbolos: n, desglose: { us: n_us, mx: n_mx, idx: n_idx },
    tandas, concurrencia,
    on_request_ms, cron_neon_ms,
    // El veredicto se lee contra el presupuesto de SERVIDOR (g3), no contra
    // el 1.5s de producto: al cliente todavía le falta bajar y pintar.
    on_request_cabe: on_request_ms <= CRITERIOS.g3_max_ms_endpoint,
    cron_neon_cabe: cron_neon_ms <= CRITERIOS.g3_max_ms_endpoint,
    recomendacion: on_request_ms <= CRITERIOS.g3_max_ms_endpoint ? 'on_request_con_cache' : 'cron_neon',
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q4 — retorno total con dividendos, y el agujero de YTD
// ═══════════════════════════════════════════════════════════════════

/**
 * ¿El payload del chart trae con qué calcular retorno TOTAL?
 *
 * El v8 devuelve `quote[0]` (o/h/l/c ajustados SOLO por splits) y
 * `adjclose[0]` (ajustado por splits Y dividendos). El factor del día es
 * f = adjclose/close. Si f nunca se separa de 1, o no hay adjclose, la serie
 * es de PRECIO y no de retorno total — y decirle "rendimiento total" a eso
 * sería un número mal.
 *
 * Esto es exactamente lo que api/_lib/yahoo-daily.js ya hace en los
 * backtests; acá solo se MIDE que la fuente lo siga entregando para los
 * símbolos de /mercado (incluidos los `.MX`, que es donde no está probado).
 */
export function censoRetornoTotal(chartJson) {
  const r = chartJson && chartJson.chart && chartJson.chart.result && chartJson.chart.result[0];
  const ts = r && r.timestamp;
  const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
  const adj = r && r.indicators && r.indicators.adjclose && r.indicators.adjclose[0]
    && r.indicators.adjclose[0].adjclose;
  if (!Array.isArray(ts) || !q) return { ok: false, motivo: 'sin timestamp/quote' };
  if (!Array.isArray(adj)) return { ok: false, motivo: 'sin adjclose: la serie es de precio, no de retorno total' };

  let puntos = 0, conFactor = 0, maxDesvio = 0;
  for (let i = 0; i < ts.length; i++) {
    const c = num(q.close && q.close[i]);
    const a = num(adj[i]);
    if (c == null || c <= 0 || a == null || a <= 0) continue;
    puntos++;
    const f = a / c;
    const d = Math.abs(f - 1);
    if (d > 1e-9) conFactor++;
    if (d > maxDesvio) maxDesvio = d;
  }
  // `events` del propio payload: Yahoo los manda cuando se pide events=div,split.
  const eventos = (r && r.events) || {};
  const nDiv = eventos.dividends ? Object.keys(eventos.dividends).length : 0;
  const nSplit = eventos.splits ? Object.keys(eventos.splits).length : 0;

  return {
    ok: puntos > 0,
    puntos,
    dias_con_factor: conFactor,
    max_desvio_factor: maxDesvio,
    dividendos_en_events: nDiv,
    splits_en_events: nSplit,
    // Un factor pegado a 1 en TODA la ventana no prueba que la fuente esté
    // rota: puede ser un nombre sin dividendos. Se reporta, no se juzga.
    nota: conFactor === 0 ? 'factor ≡ 1 en toda la ventana: o el nombre no pagó dividendos, o adjclose viene sin ajustar' : null,
  };
}

/**
 * EL HUECO DE YTD, medido.
 *
 * `qdPeriodChange` ancla por `tradingDays` (1D=1, 1S=5, 1M=21, 3M=63). YTD no
 * es un número de sesiones: es una FECHA (el último cierre del año pasado), y
 * cuántas sesiones hay hasta ahí depende del día en que se pregunte.
 *
 * Esta función devuelve el índice del ancla YTD sobre una serie CON
 * timestamps. Es la pieza que R1 necesita para agregar `'YTD'` a QD_PERIODS
 * sin romper el contrato del pct-lint (un solo cálculo, una sola etiqueta).
 *
 * `serie` = [{ t, c }] en orden cronológico, con `t` en epoch SEGUNDOS
 * (el mismo shape que devuelve /api/macro-markets).
 * Devuelve { refIdx, refValue, puntos, cubre } — `cubre: false` significa que
 * la serie EMPIEZA dentro de este año, o sea que no alcanza para YTD y el
 * número saldría corto sin avisar. Ese es el modo de falla que importa.
 */
export function anclaYtd(serie, ahora) {
  const now = ahora instanceof Date ? ahora : new Date(ahora);
  const anio = now.getUTCFullYear();
  const pts = (serie || []).filter((p) => p && Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.t));
  if (pts.length < 2) return { refIdx: null, refValue: null, puntos: pts.length, cubre: false, motivo: 'serie de menos de 2 puntos' };

  // El ancla es el ÚLTIMO cierre del año anterior. Se busca hacia atrás desde
  // el final: el primer punto cuyo año sea menor al actual.
  let refIdx = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (new Date(pts[i].t * 1000).getUTCFullYear() < anio) { refIdx = i; break; }
  }
  if (refIdx == null) {
    return {
      refIdx: null, refValue: null, puntos: pts.length, cubre: false,
      motivo: 'la serie no llega al año anterior: no hay cierre de fin de año contra el cual anclar',
    };
  }
  return { refIdx, refValue: pts[refIdx].c, puntos: pts.length, cubre: true, motivo: null };
}

// ═══════════════════════════════════════════════════════════════════
// Q5 — fundamentales por ticker (`metric` de Finnhub)
// ═══════════════════════════════════════════════════════════════════

/** Qué campos de los 12 trae `metric`, y con qué grafía resolvió cada uno. */
export function coberturaMetric(metricResp, campos = CAMPOS_METRIC) {
  const m = (metricResp && metricResp.metric) || {};
  const presentes = {}, ausentes = [];
  for (const [nuestro, candidatos] of campos) {
    const clave = candidatos.find((k) => k in m && num(m[k]) != null);
    if (clave) presentes[nuestro] = { clave_finnhub: clave, valor: num(m[clave]) };
    else ausentes.push(nuestro);
  }
  const n = Object.keys(presentes).length;
  return {
    total: campos.length, presentes: n, ausentes,
    detalle: presentes,
    verde: n >= CRITERIOS.g5_min_campos_metric,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q6 — UPA real vs estimado
// ═══════════════════════════════════════════════════════════════════

/**
 * Censo de la ventana histórica de `stock/earnings` de Finnhub: cuántos
 * trimestres traen actual Y estimate (los dos, porque "le ganó" es una
 * resta y con una sola mitad no existe).
 *
 * Ojo con la semántica que R6 tiene que pintar: `actual − estimate` es la
 * distancia al CONSENSO, no lo que hizo la acción. Un beat con la acción
 * cayendo 8% es normal y la ficha tiene que poder decir las dos cosas sin
 * mezclarlas. Acá solo se cuenta la cobertura.
 */
export function ventanaUpa(rows) {
  const lista = Array.isArray(rows) ? rows : [];
  const completos = lista.filter((r) => r && num(r.actual) != null && num(r.estimate) != null);
  const periodos = completos
    .map((r) => (r.period ? String(r.period) : null))
    .filter(Boolean)
    .sort();
  return {
    filas: lista.length,
    con_actual_y_estimate: completos.length,
    periodo_mas_viejo: periodos[0] || null,
    periodo_mas_nuevo: periodos[periodos.length - 1] || null,
    verde: completos.length >= CRITERIOS.g6_min_trimestres_upa,
  };
}

/** El próximo reporte, del calendario. Devuelve null sin inventar fecha. */
export function proximoReporte(calendarJson, symbol) {
  const arr = (calendarJson && calendarJson.earningsCalendar) || [];
  const sym = up(symbol);
  const mio = arr.filter((e) => up(e && e.symbol) === sym && e && e.date);
  if (!mio.length) return null;
  mio.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const e = mio[0];
  return {
    fecha: String(e.date),
    hora: e.hour || null,               // 'bmo' | 'amc' | ''
    eps_estimado: num(e.epsEstimate),   // puede ser null en el tier gratis → '—'
    ingresos_estimados: num(e.revenueEstimate),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q7 — ingresos / utilidad por trimestre, CON CITA
// ═══════════════════════════════════════════════════════════════════

/**
 * Censo de `companyfacts` de EDGAR para las dos series que R6 grafica.
 *
 * La regla del encargo es "cada barra cita su 10-Q/10-K", así que acá no
 * basta con que el número exista: tiene que venir con `accn` (número de
 * accession) y `form`. Un hecho sin accession es un número que no se puede
 * auditar, y para esta ficha eso es lo mismo que no tenerlo.
 *
 * Se cuentan solo los hechos TRIMESTRALES: los que tienen `start` y `end`
 * separados por ~90 días. Los anuales y los acumulados de 9 meses viven en el
 * mismo arreglo y sumarlos como si fueran trimestres es la manera clásica de
 * inventar un trimestre que nunca existió.
 */
export function coberturaCompanyFacts(facts, {
  conceptos = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'NetIncomeLoss'],
} = {}) {
  const usgaap = (facts && facts.facts && facts.facts['us-gaap']) || {};
  const out = {};
  for (const concepto of conceptos) {
    const unidades = (usgaap[concepto] && usgaap[concepto].units) || {};
    const filas = unidades.USD || [];
    let trimestrales = 0, conCita = 0;
    const formas = {};
    for (const f of filas) {
      if (!f || !f.start || !f.end) continue;
      const dias = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
      if (!Number.isFinite(dias) || dias < 60 || dias > 120) continue;  // ~1 trimestre
      trimestrales++;
      if (f.accn && f.form) { conCita++; formas[f.form] = (formas[f.form] || 0) + 1; }
    }
    out[concepto] = { filas_usd: filas.length, trimestrales, con_cita: conCita, formas };
  }
  const mejorIngresos = Math.max(
    out.Revenues ? out.Revenues.con_cita : 0,
    out.RevenueFromContractWithCustomerExcludingAssessedTax
      ? out.RevenueFromContractWithCustomerExcludingAssessedTax.con_cita : 0,
  );
  const utilidad = out.NetIncomeLoss ? out.NetIncomeLoss.con_cita : 0;
  return {
    por_concepto: out,
    trimestres_ingresos_con_cita: mejorIngresos,
    trimestres_utilidad_con_cita: utilidad,
    verde: mejorIngresos >= CRITERIOS.g7_min_trimestres_facts
      && utilidad >= CRITERIOS.g7_min_trimestres_facts,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Q9 — Form 4: ¿TODAS las transacciones?
// ═══════════════════════════════════════════════════════════════════

/**
 * El encargo pide que R5 abra en "Todas las transacciones" y que cada fila
 * traiga "le quedan" (sharesOwnedFollowing) y la hora de aceptación del
 * filing. Hoy /api/stock-tracker?cat=insider filtra a compras open-market (P)
 * de officers/directors ≥ $100k — o sea que el 90% de lo que R5 necesita
 * nunca se guarda.
 *
 * Esta función mide QUÉ TRAE LA FUENTE, no qué filtra el endpoint: se le pasa
 * el arreglo crudo de transacciones y reporta los códigos vistos, si
 * `sharesOwnedFollowing` viene poblado y si hay timestamp de aceptación.
 */
export function censoForm4(txs) {
  const lista = Array.isArray(txs) ? txs : [];
  const porCodigo = {};
  let conQuedan = 0, conAceptacion = 0, conCargo = 0;
  for (const t of lista) {
    if (!t) continue;
    const c = up(t.transactionCode || t.code);
    if (c) porCodigo[c] = (porCodigo[c] || 0) + 1;
    // Finnhub llama `share` al remanente; EDGAR, sharesOwnedFollowingTransaction.
    if (num(t.sharesOwnedFollowing ?? t.sharesOwnedFollowingTransaction ?? t.share) != null) conQuedan++;
    if (t.acceptanceDateTime || t.acceptedAt || t.filingDateTime) conAceptacion++;
    if (t.officerTitle || t.title) conCargo++;
  }
  const codigos = Object.keys(porCodigo).sort();
  const soloP = codigos.length > 0 && codigos.every((c) => c === 'P');
  return {
    transacciones: lista.length,
    codigos,
    por_codigo: porCodigo,
    solo_compras: soloP,
    con_le_quedan: conQuedan,
    con_hora_aceptacion: conAceptacion,
    con_cargo: conCargo,
    verde: codigos.length >= CRITERIOS.g9_min_codigos
      && conQuedan === lista.length && lista.length > 0
      && conAceptacion === lista.length,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Punto 0.10 (adenda) — feeds de noticias
// ═══════════════════════════════════════════════════════════════════

/**
 * Cuenta items de un feed SIN saber de antemano su dialecto.
 *
 * `parseRss` de api/vc-feed.js solo entiende `<item>` (RSS 2.0). Media web de
 * noticias publica **Atom** (`<entry>`), empezando por Google News y varios
 * medios mexicanos. Contar solo `<item>` reportaría "0 items" sobre un feed
 * perfectamente sano, y eso sería un rojo inventado — el peor resultado
 * posible de un censo, porque cierra una puerta que estaba abierta.
 *
 * Además del conteo, mide lo que la regla 3 del encargo necesita de verdad:
 * cuántos items traen TÍTULO, cuántos traen LINK, y cuántos traen una FECHA
 * parseable. Un feed que contesta 200 con 40 items sin `pubDate` no sirve
 * para "lo de hoy": la hora del titular tendría que inventarse.
 *
 * NO republica cuerpo, ni lo guarda: solo cuenta. Misma regla que vc-feed.
 */
export function contarItemsFeed(xml) {
  const s = String(xml || '');
  const items = s.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const entries = s.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const dialecto = items.length >= entries.length
    ? (items.length ? 'rss' : null)
    : 'atom';
  const bloques = dialecto === 'atom' ? entries : items;

  const tag = (b, t) => {
    const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'i').exec(b);
    return m ? m[1].trim() : '';
  };
  let conTitulo = 0, conLink = 0, conFecha = 0, conImagen = 0, conCategoria = 0;
  const viasImagen = {}, ejemplosCategoria = new Set();
  const muestrasFecha = [];
  for (const b of bloques) {
    if (tag(b, 'title')) conTitulo++;
    // Atom pone el link en un atributo href, RSS en el texto del tag.
    if (tag(b, 'link') || /<link[^>]*href="[^"]+"/i.test(b)) conLink++;
    // La FECHA, y —cuando falla— la cadena cruda. Sin la cruda, "0% con fecha"
    // es un callejón sin salida: fue exactamente lo que pasó con el feed de la
    // Fed, que contestó 200 con items y 0% de fechas parseables sin decir por
    // qué. Se guardan hasta 5 muestras: alcanzan para ver el patrón y no
    // inflan el JSON del censo.
    const fecha = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published')
      || tag(b, 'dc:date') || tag(b, 'date');
    const pf = parseFechaFeed(fecha);
    if (pf.ms != null) conFecha++;
    else if (muestrasFecha.length < 5) {
      muestrasFecha.push({
        // Qué tags de fecha trae el item, aunque ninguno sirva: distingue
        // "no hay campo de fecha" de "hay uno y no se pudo leer".
        tags_presentes: ['pubDate', 'updated', 'published', 'dc:date', 'date'].filter((t) => tag(b, t)),
        cruda: String(fecha || '').slice(0, 60),
        motivo: pf.motivo,
      });
    }

    // ── IMAGEN (punto 0.10 de la adenda) ─────────────────────────────
    // R3b pone foto SOLO si el feed la trae; si no, bloque de color. O sea
    // que este conteo decide cuántas de las 4 destacadas pueden llevar
    // foto de verdad. Se buscan las tres formas que se usan en la práctica,
    // y se reporta CUÁL — porque `enclosure` puede traer un audio o un PDF
    // y contarlo como imagen pintaría un <img> roto.
    let via = null;
    const mc = /<media:content[^>]*\burl\s*=\s*"([^"]+)"[^>]*>/i.exec(b);
    if (mc && /^https?:/i.test(mc[1])) {
      const tipo = /\btype\s*=\s*"([^"]+)"/i.exec(mc[0]);
      const medium = /\bmedium\s*=\s*"([^"]+)"/i.exec(mc[0]);
      // Sin type ni medium se acepta: media:content sin atributos es, en la
      // práctica, siempre la imagen del artículo.
      if (!tipo && !medium) via = 'media:content';
      else if ((tipo && /^image\//i.test(tipo[1])) || (medium && /^image$/i.test(medium[1]))) via = 'media:content';
    }
    if (!via) {
      const mt = /<media:thumbnail[^>]*\burl\s*=\s*"([^"]+)"/i.exec(b);
      if (mt && /^https?:/i.test(mt[1])) via = 'media:thumbnail';
    }
    if (!via) {
      const en = /<enclosure[^>]*>/i.exec(b);
      if (en) {
        const url = /\burl\s*=\s*"([^"]+)"/i.exec(en[0]);
        const tipo = /\btype\s*=\s*"([^"]+)"/i.exec(en[0]);
        // Un enclosure SIN type no se cuenta: los podcasts lo usan para
        // audio, y una foto que resulta ser un mp3 es peor que no tener foto.
        if (url && /^https?:/i.test(url[1]) && tipo && /^image\//i.test(tipo[1])) via = 'enclosure';
      }
    }
    if (via) { conImagen++; viasImagen[via] = (viasImagen[via] || 0) + 1; }

    // ── CATEGORÍA / TICKERS (punto 0.10 de la adenda) ────────────────
    // R3b clasifica por sección y marca chips de ticker. Si el feed ya trae
    // categorías, la sección sale del feed en vez de una regla nuestra.
    const cats = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((m) => m[1].trim()).filter(Boolean);
    const catsAttr = [...b.matchAll(/<category[^>]*\bterm\s*=\s*"([^"]+)"/gi)]
      .map((m) => m[1].trim()).filter(Boolean);   // Atom
    const todas = [...cats, ...catsAttr];
    if (todas.length) {
      conCategoria++;
      for (const c of todas.slice(0, 3)) if (ejemplosCategoria.size < 15) ejemplosCategoria.add(c.slice(0, 40));
    }
  }
  const n = bloques.length;
  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return {
    dialecto,
    items: n,
    con_titulo: conTitulo,
    con_link: conLink,
    con_fecha: conFecha,
    pct_con_fecha: pct(conFecha),
    // Solo viaja cuando hay algo que explicar.
    fechas_que_fallaron: muestrasFecha.length ? muestrasFecha : undefined,
    con_imagen: conImagen,
    pct_con_imagen: pct(conImagen),
    vias_imagen: viasImagen,
    con_categoria: conCategoria,
    pct_con_categoria: pct(conCategoria),
    categorias_ejemplo: [...ejemplosCategoria],
    // Usable = lo que la regla 3 puede pintar sin inventar nada. La imagen NO
    // entra: R3b ya tiene su caída (bloque de color con la fuente), así que un
    // feed sin fotos es usable, solo que más feo. La fecha sí entra: sin hora,
    // "lo de hoy" tendría que inventarla.
    usables: Math.min(conTitulo, conLink, conFecha),
  };
}

/**
 * Veredicto de UN feed, ya medido. `resp` es lo que devolvió el fetch
 * instrumentado: { ok, status, ms, texto }.
 *
 * Un 403 acá NO es un fallo del censo: es LA RESPUESTA. El smoke de vc-feed
 * ya encontró que FinSMEs devuelve 403 de Cloudflare desde IPs de Vercel
 * mientras funciona perfecto desde una laptop — por eso este censo corre
 * desde prod y por eso el motivo se reporta con su nombre real
 * (`bloqueado_cloudflare`) y no como "no disponible".
 */
export function veredictoFeed(nombre, url, resp) {
  const base = { nombre, url, status: resp && resp.status, ms: resp && resp.ms };
  if (!resp || (!resp.ok && !resp.texto)) {
    return { ...base, vivo: false, motivo: (resp && resp.error) || `HTTP ${resp && resp.status}` };
  }
  if (!resp.ok) {
    const cf = /cloudflare|just a moment|attention required/i.test(resp.texto || '');
    return {
      ...base, vivo: false,
      motivo: cf ? 'bloqueado_cloudflare' : `HTTP ${resp.status}`,
      // Se distingue a propósito de un 403 cualquiera: uno se arregla con un
      // proxy o cambiando de fuente; el otro puede ser una URL mal escrita.
      pista: cf ? 'responde desde una laptop pero no desde una IP de datacenter (mismo caso que FinSMEs en vc-feed)' : undefined,
    };
  }
  const m = contarItemsFeed(resp.texto);
  const razones = [];
  if (!m.dialecto) razones.push('la respuesta no parece un feed (ni <item> ni <entry>)');
  if (m.items < CRITERIOS.g11_min_items_por_feed) razones.push(`${m.items} items (piso ${CRITERIOS.g11_min_items_por_feed})`);
  if (m.pct_con_fecha < CRITERIOS.g11_min_pct_con_fecha) razones.push(`solo ${m.pct_con_fecha}% de los items trae fecha parseable (piso ${CRITERIOS.g11_min_pct_con_fecha}%) — "lo de hoy" no puede mostrar la hora`);
  return { ...base, vivo: razones.length === 0, ...m, motivo: razones.length ? razones.join(' · ') : null };
}

/**
 * Veredicto de una FUENTE del registro, que puede tener varias candidatas.
 *
 * `intentos` = [{ url, resp }] en el orden en que se probaron. Gana la
 * primera que esté viva, y se reportan TODAS — porque "la candidata 1 dio 404
 * y la 2 funcionó" es información que hay que guardar en el registro, no
 * descubrir otra vez el mes que viene.
 *
 * Una fuente `asumido_no` no se sondea y sale con veredicto propio: no es un
 * NO-GO medido, es una decisión, y mezclarlas haría parecer que se probó algo
 * que nunca se probó.
 */
export function veredictoFuente(fuente, intentos = []) {
  const base = {
    id: fuente.id, nombre: fuente.nombre, idioma: fuente.idioma,
    tipo: fuente.tipo, seccion: fuente.seccion,
  };
  if (fuente.asumido_no) {
    return { ...base, veredicto: 'ASUMIDO_NO', motivo: fuente.asumido_no, feed: null, candidatas: [] };
  }
  if (!intentos.length) {
    return { ...base, veredicto: 'NO-GO', motivo: 'sin candidatas en el registro', feed: null, candidatas: [] };
  }
  const juzgadas = intentos.map(({ url, resp }) => veredictoFeed(fuente.id, url, resp));
  const ganadora = juzgadas.find((j) => j.vivo) || null;
  const candidatas = juzgadas.map((j) => ({
    url: j.url, status: j.status, ms: j.ms, vivo: j.vivo,
    motivo: j.motivo || undefined, pista: j.pista || undefined,
  }));
  if (!ganadora) {
    return {
      ...base, veredicto: 'NO-GO', feed: null, candidatas,
      // El motivo agregado nombra cuántas rutas se probaron: un NO-GO de
      // "ninguna de 3 rutas sirve" es un hecho; uno de "probé una que inventé"
      // no lo sería.
      motivo: `ninguna de las ${candidatas.length} candidatas respondió con un feed usable`,
      bloqueado_cloudflare: candidatas.some((c) => c.motivo === 'bloqueado_cloudflare'),
    };
  }
  return {
    ...base, veredicto: 'GO', feed: ganadora.url, candidatas,
    items: ganadora.items, usables: ganadora.usables,
    pct_con_fecha: ganadora.pct_con_fecha,
    // Las dos mediciones que pide la adenda, por fuente.
    pct_con_imagen: ganadora.pct_con_imagen,
    vias_imagen: ganadora.vias_imagen,
    pct_con_categoria: ganadora.pct_con_categoria,
    categorias_ejemplo: ganadora.categorias_ejemplo,
    dialecto: ganadora.dialecto,
  };
}

/**
 * La tabla GO/NO-GO por fuente que pide la adenda, más lo que R3b necesita
 * saber ANTES de escribirse: cuántas secciones del layout se pueden llenar y
 * cuántas destacadas pueden llevar foto de verdad.
 */
export function tablaFuentes(veredictos = []) {
  const medidas = veredictos.filter((v) => v.veredicto !== 'ASUMIDO_NO');
  const go = medidas.filter((v) => v.veredicto === 'GO');

  const porTipo = {}, porSeccion = {}, porIdioma = {};
  for (const v of go) {
    porTipo[v.tipo] = (porTipo[v.tipo] || 0) + 1;
    porSeccion[v.seccion] = (porSeccion[v.seccion] || 0) + 1;
    porIdioma[v.idioma] = (porIdioma[v.idioma] || 0) + 1;
  }
  // Las secciones del layout de R3b que quedarían VACÍAS. Una sección vacía no
  // es un detalle estético: es una pestaña que se abre en blanco.
  const SECCIONES_R3B = ['mercado', 'mexico_latam', 'acciones', 'oficiales'];
  const seccionesVacias = SECCIONES_R3B.filter((s) => !porSeccion[s]);

  // Cuántas fuentes GO traen imagen en la mayoría de sus items. R3b pone 4
  // destacadas con foto: si ninguna fuente trae imagen, las 4 salen como
  // bloque de color y el diseño cambia de carácter.
  const conFoto = go.filter((v) => (v.pct_con_imagen || 0) >= 50);

  const razones = [];
  if (go.length < CRITERIOS.g11_min_feeds_vivos) {
    razones.push(`${go.length} fuentes GO (piso ${CRITERIOS.g11_min_feeds_vivos})`);
  }
  if (!porIdioma.es) {
    razones.push('ninguna fuente en español viva: la mitad mexicana de "lo de hoy" (R3) y el toggle "Solo español" (R3b) quedan vacíos');
  }
  if (seccionesVacias.length) {
    razones.push(`secciones de R3b sin ninguna fuente: ${seccionesVacias.join(', ')}`);
  }
  return {
    fuentes: veredictos.length,
    medidas: medidas.length,
    asumidas_no: veredictos.length - medidas.length,
    go: go.length,
    no_go: medidas.length - go.length,
    por_tipo: porTipo, por_seccion: porSeccion, por_idioma: porIdioma,
    secciones_vacias: seccionesVacias,
    fuentes_con_foto: conFoto.length,
    fuentes_con_foto_nombres: conFoto.map((v) => v.nombre),
    bloqueadas_cloudflare: medidas.filter((v) => v.bloqueado_cloudflare).map((v) => v.nombre),
    tabla: veredictos,
    verde: razones.length === 0,
    razones,
  };
}

/** El agregado de G11 sobre los feeds ya juzgados. */
export function censoFeeds(feeds = []) {
  const vivos = feeds.filter((f) => f.vivo);
  const razones = [];
  if (vivos.length < CRITERIOS.g11_min_feeds_vivos) {
    razones.push(`${vivos.length} feeds vivos (piso ${CRITERIOS.g11_min_feeds_vivos})`);
  }
  // La cobertura de MÉXICO se cuenta aparte del total: "lo de hoy" mezcla
  // EE.UU. y México, y tres feeds gringos vivos no llenan la mitad mexicana.
  // Un feed se cuenta como MX solo si quien arma la lista lo marcó — nunca se
  // adivina por el dominio.
  const mx = feeds.filter((f) => f.pais === 'mx');
  const mxVivos = mx.filter((f) => f.vivo);
  if (mx.length && !mxVivos.length) razones.push('ningún feed de México vivo: la mitad mexicana de "lo de hoy" queda vacía');
  return {
    feeds: feeds.length,
    vivos: vivos.length,
    muertos: feeds.length - vivos.length,
    mx: { declarados: mx.length, vivos: mxVivos.length },
    items_usables_totales: feeds.reduce((a, f) => a + (f.usables || 0), 0),
    detalle: feeds,
    verde: razones.length === 0,
    razones,
  };
}

// ═══════════════════════════════════════════════════════════════════
// El tablero de compuertas
// ═══════════════════════════════════════════════════════════════════

/**
 * Junta los veredictos parciales en un GO / NO-GO por escrito.
 *
 * `parciales` = { g1: {verde, …}, g2: {…}, … }. Una compuerta AUSENTE no
 * cuenta como verde: cuenta como `sin_medir`, y con una sin medir el
 * veredicto global no puede ser GO. Es la diferencia entre "pasó" y "no se
 * probó", que es justo la que un tablero mal hecho borra.
 */
export function tablero(parciales = {}) {
  const claves = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11'];
  const filas = claves.map((k) => {
    const p = parciales[k];
    if (p === undefined || p === null) return { gate: k, estado: 'sin_medir' };
    return { gate: k, estado: p.verde === true ? 'verde' : 'rojo', razones: p.razones || (p.motivo ? [p.motivo] : []) };
  });
  const rojos = filas.filter((f) => f.estado === 'rojo').map((f) => f.gate);
  const sinMedir = filas.filter((f) => f.estado === 'sin_medir').map((f) => f.gate);
  return {
    criterios_version: CRITERIOS.version,
    filas,
    rojos,
    sin_medir: sinMedir,
    veredicto: sinMedir.length ? 'INCOMPLETO' : (rojos.length ? 'NO-GO' : 'GO'),
  };
}
