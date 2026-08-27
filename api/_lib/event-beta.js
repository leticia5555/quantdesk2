// ═══════════════════════════════════════════════════════════════════
// api/_lib/event-beta.js — matemática de la sección "BETA DE EVENTO".
//
// Responde "¿Y se mueve con X en eventos?" exista o no cointegración: la
// pregunta que las 3 Puertas del Pairs Validator NO responden porque miran
// NIVELES (¿el spread revierte?) y ésta mira RETORNOS (¿Y reacciona cuando
// X salta?). Un par puede fallar la Puerta A y aun así tener beta de evento.
//
// Sin I/O: no toca red, no toca Neon, no toca Claude. Todo lo de acá es una
// función pura sobre arrays, y por eso todo tiene test directo
// (tests/event-beta.test.mjs). El handler (api/event-beta.js) es el que baja
// precios y earnings y le pasa los arrays a este módulo.
//
// LOS UMBRALES ESTÁN CONGELADOS. `CRITERIOS` se fijó ANTES de correr esto
// sobre datos reales (docs/pairs-event-beta-scope.md §5), va Object.freeze,
// sale en cada respuesta del endpoint y tiene un test que lo verifica. Si
// alguien los mueve después de ver los números, el diff lo delata.
//
// DOS INVARIANTES QUE SE SOSTIENEN POR CONSTRUCCIÓN, NO POR CHEQUEO
//   1. Las dos series se alinean por fecha ANTES de nada, así que "día con
//      precio válido en AMBOS" deja de ser una condición que hay que
//      recordar chequear en cada evento: es el único tipo de día que existe
//      río abajo. Lo que se descarta al alinear se cuenta y se reporta.
//   2. El día de evento es SIEMPRE la sesión POSTERIOR al reporte (supuesto
//      AMC parejo, §4.2): AV no da hora, y tratar un AMC como BMO mediría
//      una reacción ANTERIOR al anuncio. El error se elige asimétrico a
//      propósito — AMC a lo sumo mide un día tarde; BMO fabrica evidencia.
// ═══════════════════════════════════════════════════════════════════

// ───────────────────── Criterios pre-registrados ─────────────────────

const CRITERIOS = Object.freeze({
  UMBRAL_SALTO: 0.03,     // |c2c| de X que define UP / DOWN (frontera INCLUSIVA)
  HIT_FUERTE: 0.60,       // hit rate >= esto → candidato a "hay beta de evento"
  HIT_DEBIL: 0.50,        // entre esto y HIT_FUERTE → "arrastre débil"
  MULT_BASE: 2.0,         // |avg_Y| >= esto × |baseline| exigido para "fuerte"
  N_MIN: 10,              // N < esto → "descriptivo, no significativo"
  MIN_RET_CORR: 30,       // pares de retornos mínimos para reportar correlación
  VENTANA_CORTA: 252,     // sesiones de la ventana "1 año"
  RANGE_PRECIOS: '10y',   // ventana de precios del event study
});

// Días de calendario por `range` del validador. Se usa para recortar la
// serie de 10 años a la ventana que eligió el usuario SIN bajarla dos veces.
const RANGE_DIAS = Object.freeze({ '1y': 365, '2y': 730, '5y': 1825 });

const MS_DIA = 86400000;

// ───────────────────── Utilidades numéricas ─────────────────────

const signo = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// Log-retornos de una serie de precios. Un precio no positivo corta el
// retorno de ESE par (queda null) en vez de producir un -Infinity que
// después contamina la media en silencio.
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    out.push(a > 0 && b > 0 ? Math.log(b / a) : null);
  }
  return out;
}

// Pearson sobre dos arrays del mismo largo, ignorando los pares donde
// cualquiera de los dos sea null/no finito. Devuelve null si no llega a
// `minN` pares usables o si alguna serie no tiene varianza — un número
// frágil disfrazado de dato es peor que un "no disponible".
function pearson(a, b, minN = CRITERIOS.MIN_RET_CORR) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const xs = [];
  const ys = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  }
  if (xs.length < minN) return null;
  const m = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / m;
  const my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ───────────────────── Alineación de las dos series ─────────────────────

// Series de entrada: { fechas:['YYYY-MM-DD'…], opens:[…], closes:[…] } tal
// como las devuelve api/_lib/yahoo-daily.js (ya ajustadas por splits Y
// dividendos, con el factor aplicado también al open).
//
// Devuelve las dos series recortadas a las fechas que existen en AMBAS, en
// orden cronológico, más el conteo de lo que se cayó. Ese conteo se reporta:
// una sesión silenciosamente ausente es una muestra distinta a la que dice
// el JSON.
function alignSeries(serieY, serieX) {
  const vacio = { fechas: [], yOpen: [], yClose: [], xOpen: [], xClose: [], n: 0, dropped_sessions: 0 };
  if (!serieY || !serieX || !Array.isArray(serieY.fechas) || !Array.isArray(serieX.fechas)) return vacio;

  const idxX = new Map();
  for (let i = 0; i < serieX.fechas.length; i++) idxX.set(serieX.fechas[i], i);

  const out = { fechas: [], yOpen: [], yClose: [], xOpen: [], xClose: [], n: 0, dropped_sessions: 0 };
  for (let i = 0; i < serieY.fechas.length; i++) {
    const j = idxX.get(serieY.fechas[i]);
    const yo = serieY.opens[i], yc = serieY.closes[i];
    const xo = j == null ? null : serieX.opens[j];
    const xc = j == null ? null : serieX.closes[j];
    if (j == null || ![yo, yc, xo, xc].every((v) => Number.isFinite(v) && v > 0)) {
      out.dropped_sessions++;
      continue;
    }
    out.fechas.push(serieY.fechas[i]);
    out.yOpen.push(yo); out.yClose.push(yc);
    out.xOpen.push(xo); out.xClose.push(xc);
  }
  // Yahoo entrega cronológico, pero no se asume: el binary search de
  // eventDay() depende del orden y una serie desordenada daría eventos mal
  // fechados sin fallar nunca de forma visible.
  out.n = out.fechas.length;
  return out;
}

// Recorta la serie alineada a los últimos `range` (1y/2y/5y). El corte es
// relativo a la ÚLTIMA SESIÓN de la serie, no a `Date.now()`: así la función
// es determinista, testeable y no depende del reloj (que además rompería el
// lint anti "relojes rotos" si se tatuara una fecha).
function sliceRange(aligned, range) {
  const dias = RANGE_DIAS[range];
  if (!dias || !aligned.n) return aligned;
  const ultima = aligned.fechas[aligned.n - 1];
  const corte = new Date(new Date(ultima + 'T00:00:00Z').getTime() - dias * MS_DIA)
    .toISOString().slice(0, 10);
  let desde = 0;
  while (desde < aligned.n && aligned.fechas[desde] < corte) desde++;
  return {
    fechas: aligned.fechas.slice(desde),
    yOpen: aligned.yOpen.slice(desde), yClose: aligned.yClose.slice(desde),
    xOpen: aligned.xOpen.slice(desde), xClose: aligned.xClose.slice(desde),
    n: aligned.n - desde,
    dropped_sessions: aligned.dropped_sessions,
  };
}

// ───────────────────── Correlación ─────────────────────

// Dos ventanas: 252 sesiones y la que eligió el usuario.
//
// `same_window` es true cuando el `range` elegido NO es más largo que un año
// (hoy: sólo '1y'). En ese caso las dos ventanas cubren el mismo año y
// reportar ambas produciría dos números que difieren en el tercer decimal
// por unas pocas sesiones de desfase entre "365 días de calendario" y "252
// sesiones" — precisión falsa disfrazada de segundo dato. Se devuelve sólo
// `r_full`, etiquetado con el range del usuario, y la UI pinta UN número.
function correlationBlock(aligned, range) {
  const full = sliceRange(aligned, range);
  const dias = RANGE_DIAS[range] || 0;
  const sameWindow = dias > 0 && dias <= 365;

  if (full.n < 2) {
    return { r_1y: null, r_full: null, same_window: sameWindow, unavailable: unavailable('pocos_dias', { n: full.n }) };
  }

  const ry = logReturns(full.yClose);
  const rx = logReturns(full.xClose);
  const rf = pearson(ry, rx);
  const corto = Math.min(CRITERIOS.VENTANA_CORTA, ry.length);
  const r1 = sameWindow ? null : pearson(ry.slice(-corto), rx.slice(-corto));

  if (r1 === null && rf === null) {
    return { r_1y: null, r_full: null, same_window: sameWindow, unavailable: unavailable('pocos_dias', { n: ry.length }) };
  }
  return {
    r_1y: r1 === null ? null : { value: r1, n: corto },
    r_full: rf === null ? null : { value: rf, n: ry.length, range },
    same_window: sameWindow,
    unavailable: null,
  };
}

// ───────────────────── Event study ─────────────────────

// Primera sesión ESTRICTAMENTE posterior a `reportedDate` (supuesto AMC).
// Binary search sobre las fechas alineadas; devuelve el índice o -1.
function nextSessionIndex(fechas, reportedDate) {
  let lo = 0, hi = fechas.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fechas[mid] > reportedDate) hi = mid; else lo = mid + 1;
  }
  return lo < fechas.length ? lo : -1;
}

// Construye la lista de eventos usables + el conteo de descartes.
// `reportedDates` son los `reported_date` de X (formato YYYY-MM-DD).
//
// No hace falta un descarte por "sin precio": alignSeries() ya garantizó que
// toda fecha de la serie tiene precio en ambos símbolos (invariante #1 de la
// cabecera). Lo que se cayó ahí viaja como `dropped_sessions` a nivel serie,
// que es su unidad correcta — no es un evento descartado, es una sesión.
function buildEvents(aligned, reportedDates) {
  const dropped = { out_of_window: 0, no_next_session: 0, no_prior_close: 0 };
  const eventos = [];
  if (!aligned.n) {
    dropped.out_of_window = (reportedDates || []).length;
    return { eventos, dropped, ventana: null };
  }
  const primera = aligned.fechas[0];
  const ultima = aligned.fechas[aligned.n - 1];

  // Ordenadas + sin repetidas: AV a veces manda dos filas con el mismo
  // reportedDate (restatements). dedupeByReportedDate() ya colapsa lo que
  // entra a Neon, pero esto vale también para el camino directo desde AV.
  const fechas = [...new Set(reportedDates || [])].sort();

  for (const d of fechas) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { dropped.out_of_window++; continue; }
    if (d < primera || d > ultima) { dropped.out_of_window++; continue; }
    const i = nextSessionIndex(aligned.fechas, d);
    if (i < 0) { dropped.no_next_session++; continue; }
    if (i === 0) { dropped.no_prior_close++; continue; }
    eventos.push({
      reported_date: d,
      event_date: aligned.fechas[i],
      hour_source: 'assumed_amc',
      x_c2c: aligned.xClose[i] / aligned.xClose[i - 1] - 1,
      x_o2c: aligned.xClose[i] / aligned.xOpen[i] - 1,
      y_c2c: aligned.yClose[i] / aligned.yClose[i - 1] - 1,
      y_o2c: aligned.yClose[i] / aligned.yOpen[i] - 1,
    });
  }
  return { eventos, dropped, ventana: { from: primera, to: ultima, sessions: aligned.n } };
}

// Grupos por el c2c de X. La frontera de ±3% es INCLUSIVA y se compara con
// tolerancia de punto flotante: de qué lado cae un salto de exactamente 3%
// no puede depender de un error de redondeo.
function classifyGroups(eventos) {
  const U = CRITERIOS.UMBRAL_SALTO;
  const eps = 1e-9;
  return {
    UP: eventos.filter((e) => e.x_c2c >= U - eps),
    DOWN: eventos.filter((e) => e.x_c2c <= -U + eps),
    ALL: eventos.slice(),
  };
}

// n, hit rate y media de Y para un grupo.
//   hit = sign(r_Y) === sign(r_X)  ("¿Y se movió para el mismo lado?")
// Un retorno exactamente 0 en cualquiera de los dos NO cuenta como hit y
// suma a `n_zero`: si se contara, el denominador mentiría.
function groupStats(evs, keyY, keyX) {
  if (!evs || !evs.length) return { n: 0, n_zero: 0, hit_rate: null, avg: null };
  let hits = 0, ceros = 0, suma = 0;
  for (const e of evs) {
    const sY = signo(e[keyY]);
    const sX = signo(e[keyX]);
    if (sY === 0 || sX === 0) ceros++;
    else if (sY === sX) hits++;
    suma += e[keyY];
  }
  return { n: evs.length, n_zero: ceros, hit_rate: hits / evs.length, avg: suma / evs.length };
}

// El contrafáctico: Y en TODOS los días de la ventana. Sin hit rate — no hay
// X con qué comparar, y `null` (no aplica) es distinto de 0% (nunca acierta).
// Sin esto, un "64% de hit rate" no significa nada: si Y sube el 62% de los
// días, ese 64% es ruido.
function baselineStats(aligned) {
  if (!aligned || aligned.n < 2) {
    return { n: 0, c2c: { hit_rate: null, avg: null }, o2c: { hit_rate: null, avg: null } };
  }
  let sc = 0, so = 0, n = 0;
  for (let i = 1; i < aligned.n; i++) {
    sc += aligned.yClose[i] / aligned.yClose[i - 1] - 1;
    so += aligned.yClose[i] / aligned.yOpen[i] - 1;
    n++;
  }
  return {
    n,
    c2c: { hit_rate: null, avg: sc / n },
    o2c: { hit_rate: null, avg: so / n },
  };
}

// Arma las 4 filas de la tabla (UP / DOWN / ALL / BASELINE).
function buildGroups(eventos, aligned) {
  const g = classifyGroups(eventos);
  const filas = ['UP', 'DOWN', 'ALL'].map((key) => ({
    key,
    n: g[key].length,
    significant: g[key].length >= CRITERIOS.N_MIN,
    c2c: groupStats(g[key], 'y_c2c', 'x_c2c'),
    o2c: groupStats(g[key], 'y_o2c', 'x_o2c'),
  }));
  const base = baselineStats(aligned);
  filas.push({
    key: 'BASELINE',
    n: base.n,
    significant: base.n >= CRITERIOS.N_MIN,
    c2c: { ...base.c2c, n_zero: 0 },
    o2c: { ...base.o2c, n_zero: 0 },
  });
  return filas;
}

// ───────────────────── Veredicto ─────────────────────

// Grupo sobre el que se pronuncia el veredicto: UP → DOWN → ALL, en ese
// orden fijo, tomando el primero con datos. NUNCA "el que salió mejor":
// elegir el grupo después de ver los números es p-hacking con otro nombre.
function pickBasis(filas) {
  for (const key of ['UP', 'DOWN', 'ALL']) {
    const f = filas.find((x) => x.key === key);
    if (f && f.n > 0) return key;
  }
  return null;
}

// Tier sobre el c2c del grupo base. Umbrales de CRITERIOS, congelados.
function verdictTier(fila, baseline) {
  if (!fila || !fila.n || fila.c2c.hit_rate === null) return 'sin_datos';
  const hit = fila.c2c.hit_rate;
  if (hit < CRITERIOS.HIT_DEBIL) return 'sin_beta';
  if (hit < CRITERIOS.HIT_FUERTE) return 'arrastre_debil';
  // hit >= HIT_FUERTE: falta el segundo requisito, que el movimiento sea
  // grande CONTRA la línea base. Sin baseline no se puede exigir el múltiplo,
  // así que no se concede el tier fuerte: se cae a débil.
  const avg = Math.abs(fila.c2c.avg ?? 0);
  const base = baseline && baseline.c2c && Number.isFinite(baseline.c2c.avg)
    ? Math.abs(baseline.c2c.avg) : null;
  if (base === null) return 'arrastre_debil';
  // `avg > 0` es un desempate, no un umbral: con avg exactamente 0 el
  // múltiplo se cumpliría por vacío contra un baseline de 0.
  if (avg > 0 && avg >= CRITERIOS.MULT_BASE * base) return 'beta_evento';
  return 'arrastre_debil';
}

// ───────────────────── Texto (es/en), sin Claude ─────────────────────

// Plantilla + números. Cero llamadas a un modelo: los veredictos de esta
// casa se calculan, no se redactan.

function fmtPct(v, lang, dec = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return lang === 'es' ? 'n/d' : 'n/a';
  const s = (v >= 0 ? '+' : '') + (v * 100).toFixed(dec) + '%';
  return lang === 'es' ? s.replace('.', ',') : s;
}

function fmtHit(v, lang) {
  if (v === null || v === undefined || !Number.isFinite(v)) return lang === 'es' ? 'n/d' : 'n/a';
  return Math.round(v * 100) + '%';
}

// Frase nominal completa del grupo, con el N adentro: "los 14 earnings de
// NVDA con salto ≥ +3%". El N va acá y no antepuesto ("en 14 de los
// earnings…") porque esa construcción sugiere una submuestra de una muestra
// mayor, y no lo es: son TODOS los eventos que cumplen la condición.
const ETIQUETA_GRUPO = {
  UP: {
    es: (x, n, u) => `los ${n} earnings de ${x} con salto ≥ +${u}%`,
    en: (x, n, u) => `${x}'s ${n} earnings with a ≥ +${u}% move`,
  },
  DOWN: {
    es: (x, n, u) => `los ${n} earnings de ${x} con caída ≤ −${u}%`,
    en: (x, n, u) => `${x}'s ${n} earnings with a ≤ −${u}% move`,
  },
  ALL: {
    es: (x, n) => `los ${n} earnings de ${x}`,
    en: (x, n) => `${x}'s ${n} earnings`,
  },
};

// Devuelve { tier, basis, significant, es, en }.
function verdictLine(filas, baseline, pair) {
  const y = (pair && pair.y) || 'Y';
  const x = (pair && pair.x) || 'X';
  const basis = pickBasis(filas);
  const fila = basis ? filas.find((f) => f.key === basis) : null;
  const tier = verdictTier(fila, baseline);

  if (tier === 'sin_datos' || !fila) {
    return {
      tier: 'sin_datos', basis: null, significant: false,
      es: `No hay earnings de ${x} utilizables en la ventana de precios, así que no se puede medir si ${y} se mueve con ${x} en eventos.`,
      en: `No usable ${x} earnings fall inside the price window, so there is no way to measure whether ${y} moves with ${x} on events.`,
    };
  }

  const u = (CRITERIOS.UMBRAL_SALTO * 100).toFixed(0);
  const n = fila.n;
  const hits = Math.round((fila.c2c.hit_rate || 0) * n);
  const significant = n >= CRITERIOS.N_MIN;
  const baseAvg = baseline && baseline.c2c ? baseline.c2c.avg : null;

  const cierre = {
    beta_evento: {
      es: 'Hay beta de evento, aunque no haya cointegración.',
      en: 'There is event beta, even without cointegration.',
    },
    arrastre_debil: {
      es: `El arrastre es débil: se mueve con ${x}, pero no lo suficiente para colgarse de eso.`,
      en: `The drag is weak: it does move with ${x}, but not enough to lean on.`,
    },
    sin_beta: {
      es: `No se distingue de un día cualquiera: ${y} no se mueve con ${x} en eventos.`,
      en: `It is no different from an ordinary day: ${y} does not move with ${x} on events.`,
    },
  }[tier];

  const grupoEs = ETIQUETA_GRUPO[basis].es(x, n, u);
  const grupoEn = ETIQUETA_GRUPO[basis].en(x, n, u);

  // El cuerpo sólo menciona la línea base cuando existe: prometer un
  // contrafáctico que no se calculó sería exactamente el humo que la
  // sección existe para evitar.
  const contraEs = baseAvg === null ? '' : ` contra ${fmtPct(baseAvg, 'es', 2)} de un día cualquiera`;
  const contraEn = baseAvg === null ? '' : ` against ${fmtPct(baseAvg, 'en', 2)} on an ordinary day`;

  const es = `En ${grupoEs}, ${y} cerró en la misma dirección ${hits} de ${n} veces `
    + `(${fmtHit(fila.c2c.hit_rate, 'es')}) y promedió ${fmtPct(fila.c2c.avg, 'es')}${contraEs}. ${cierre.es}`;
  const en = `Across ${grupoEn}, ${y} closed the same way ${hits} of ${n} times `
    + `(${fmtHit(fila.c2c.hit_rate, 'en')}), averaging ${fmtPct(fila.c2c.avg, 'en')}${contraEn}. ${cierre.en}`;

  // El modificador N<10 va ADELANTE, no como nota al pie: cambia lo que el
  // lector puede hacer con el número, así que tiene que leerse antes que él.
  if (!significant) {
    return {
      tier, basis, significant: false,
      es: `Descriptivo, no significativo (N=${n}): ` + es.charAt(0).toLowerCase() + es.slice(1),
      en: `Descriptive, not significant (N=${n}): ` + en.charAt(0).toLowerCase() + en.slice(1),
    };
  }
  return { tier, basis, significant: true, es, en };
}

// ───────────────────── "No disponible" ─────────────────────

// Cada fallo tiene su razón, en los dos idiomas. Nunca un 500 genérico y
// nunca una sección vacía: el usuario ve POR QUÉ no hay número, que es
// información distinta de "no hay número".
const RAZONES = {
  sin_precios: {
    es: (p) => `sin precios para ${p.symbol} (Yahoo no respondió)`,
    en: (p) => `no prices for ${p.symbol} (Yahoo did not respond)`,
  },
  pocos_dias: {
    es: (p) => `solo ${p.n} días en común; muy poco para una correlación honesta`,
    en: (p) => `only ${p.n} overlapping days; too few for an honest correlation`,
  },
  sin_cache: {
    es: () => 'caché de earnings no configurado',
    en: () => 'earnings cache not configured',
  },
  presupuesto_av: {
    es: (p) => `presupuesto de Alpha Vantage agotado hoy (${p.used}/${p.cap})`,
    en: (p) => `Alpha Vantage budget spent for today (${p.used}/${p.cap})`,
  },
  av_rate_limited: {
    es: () => 'Alpha Vantage rate-limitó la llamada; reintenta más tarde',
    en: () => 'Alpha Vantage rate-limited the call; try again later',
  },
  av_vacio: {
    es: (p) => `Alpha Vantage no tiene historial de earnings para ${p.symbol}`,
    en: (p) => `Alpha Vantage has no earnings history for ${p.symbol}`,
  },
  sin_eventos: {
    es: (p) => `ningún earnings de ${p.symbol} cae en la ventana de precios`,
    en: (p) => `no ${p.symbol} earnings falls inside the price window`,
  },
};

function unavailable(key, params = {}) {
  const r = RAZONES[key];
  if (!r) return { reason_key: 'desconocida', es: 'no disponible', en: 'unavailable' };
  return { reason_key: key, es: r.es(params), en: r.en(params) };
}

// ───────────────────── Ensamblado ─────────────────────

// El bloque completo del event study a partir de las series ya bajadas.
// `serieY`/`serieX` vienen de api/_lib/yahoo-daily.js; `reportedDates` de
// pead_earnings (o de AV, si hubo miss de caché).
function buildStudy(serieY, serieX, reportedDates, meta = {}) {
  const aligned = alignSeries(serieY, serieX);
  const { eventos, dropped, ventana } = buildEvents(aligned, reportedDates);
  const groups = buildGroups(eventos, aligned);
  const baseline = groups.find((g) => g.key === 'BASELINE');

  return {
    x_events_total: eventos.length,
    window: ventana ? { ...ventana, range: CRITERIOS.RANGE_PRECIOS } : null,
    hour_source: 'assumed_amc',
    dropped: { ...dropped, dropped_sessions: aligned.dropped_sessions },
    groups,
    earnings_source: meta.earnings_source || null,
    unavailable: eventos.length ? null : unavailable('sin_eventos', { symbol: meta.x || 'X' }),
    _aligned: aligned,   // interno: lo consume correlationBlock; el handler no lo serializa
    _baseline: baseline, // interno: lo consume verdictLine
  };
}

export {
  CRITERIOS,
  RANGE_DIAS,
  signo,
  logReturns,
  pearson,
  alignSeries,
  sliceRange,
  correlationBlock,
  nextSessionIndex,
  buildEvents,
  classifyGroups,
  groupStats,
  baselineStats,
  buildGroups,
  pickBasis,
  verdictTier,
  verdictLine,
  fmtPct,
  fmtHit,
  unavailable,
  RAZONES,
  buildStudy,
};
