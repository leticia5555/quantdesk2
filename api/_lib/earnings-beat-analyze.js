// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat-analyze.js — FASE 2 del experimento earnings-beat.
//
// PREGUNTA ÚNICA: ¿el modelo de QuantDesk predice beat/miss mejor que el
// precio de Polymarket a T-24h?
//
// TODO ACÁ ES PURO: sin fetch, sin DB, sin Date.now(). Entra el dataset, sale
// el veredicto. Así el análisis se testea con fixtures y el endpoint es solo
// plomería — mismo reparto que _lib/pead-analyze.js.
//
// ── LOS CRITERIOS SE FIJARON ANTES DE CORRER NADA ──────────────────
// Viven en `CRITERIOS_F2` y se exportan en cada respuesta. Si alguien los
// mueve después de ver los números, el diff lo delata. Lo mismo vale para las
// DOS decisiones que el encargo pidió congelar antes de entrenar: el umbral de
// liquidez y el tratamiento de INTC. Elegirlas mirando el Brier sería mover la
// portería, así que están acá arriba con su porqué escrito.
// ═══════════════════════════════════════════════════════════════════

const CRITERIOS_F2 = {
  version: 1,

  // ── Candado de muestra ──
  min_mercados: 100,            // con precio válido a T-24h y outcome resuelto

  // ── LIQUIDEZ: umbral fijado ANTES de ver cuántos sobreviven ──
  // El memo dice que $200 de volumen es ruido. El umbral se pone en $500 —
  // 2.5× ese piso — y no más arriba: cada dólar de exigencia extra recorta
  // muestra, y la muestra es lo que decide entre INCONCLUSO y un número.
  // Si con $500 quedan menos de `min_mercados`, el veredicto es INCONCLUSO;
  // NO se baja el umbral para alcanzar el candado.
  min_volumen_usd: 500,
  piso_de_ruido_declarado_usd: 200,

  // ── INTC / la sorpresa que explota por escala ──
  // Decisión congelada: WINSORIZAR la sorpresa del feature a ±100%.
  // Por qué ésta y no escalar por precio: escalar exige el cierre previo de
  // cada trimestre, o sea una fuente de precios dentro de un endpoint que es
  // SELECT-only, y eso cambia la naturaleza del análisis. Winsorizar no
  // descarta ningún mercado ni inventa un dato: acota un feature cuya ESCALA
  // no es comparable entre empresas. Escalar por precio queda anotado como
  // alternativa para v2 — con su propia congelación, antes de entrenar.
  // (Esto revisa la recomendación que yo mismo había dejado en el scope; el
  // motivo del cambio es la dependencia de datos, no el resultado.)
  winsor_sorpresa_pct: 100,

  // ── Modelo ──
  ventana_trimestres: 20,       // 5 años, decidido en la vista en vivo
  folds_cv: 5,                  // predicción fuera de muestra por k-fold

  // ── Lectura y edge ──
  umbral_desacuerdo: 0.15,      // apuesta solo si |modelo − mercado| ≥ 15 pts
  costo_por_apuesta: 0.03,      // 3% del stake
  min_apuestas: 30,

  // ── Calibración ──
  deciles: 10,
  // Tramo donde el mercado ya está pegado a 1: ganarle SOLO ahí no es apuesta.
  tramo_saturado_desde: 0.90,

  baselines: ['siempre_si', 'tasa_por_empresa', 'mercado_t24h'],
};

// ─────────────────── primitivas ───────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function mediana(vals) {
  const v = (vals || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Acota sin descartar. El valor sigue siendo el mismo signo y el mismo orden;
// lo que se corta es la magnitud que no es comparable entre empresas.
function winsoriza(x, tope) {
  if (!Number.isFinite(x)) return null;
  return Math.max(-tope, Math.min(tope, x));
}

const media = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// ─────────────────── features (solo datos ANTERIORES a report_date) ───────────
//
// La regla que hace válido todo lo demás: cada feature se calcula con
// trimestres cuyo `reported_date` es ESTRICTAMENTE anterior al report_date del
// evento. Un `<=` acá metería el resultado que se quiere predecir dentro de la
// entrada, y el modelo saldría brillante por una razón falsa.
function featuresDeEvento({
  report_date, historial = [], paresDelSector = [],
  ventana = CRITERIOS_F2.ventana_trimestres,
  winsor = CRITERIOS_F2.winsor_sorpresa_pct,
} = {}) {
  const previos = (historial || [])
    .filter((h) => h && h.reported_date && h.reported_date < report_date
      && num(h.reported_eps) !== null && num(h.estimated_eps) !== null)
    .sort((a, b) => b.reported_date.localeCompare(a.reported_date))
    .slice(0, ventana)
    .map((h) => ({
      fecha: h.reported_date,
      beat: num(h.reported_eps) > num(h.estimated_eps),
      sorpresa: winsoriza(num(h.surprise_pct), winsor),
    }));

  if (!previos.length) {
    return { tasa: null, racha: null, sorpresa_mediana: null, pares: null,
      trimestres_previos: 0, sin_historial: true };
  }

  const beats = previos.filter((p) => p.beat).length;
  let racha = 0;
  for (const p of previos) { if (p.beat !== previos[0].beat) break; racha++; }

  // Pares: % de beats de empresas del MISMO sector que reportaron ANTES en la
  // misma temporada (mismo mes calendario). Es la única feature que mira fuera
  // de la empresa, y la que más cuidado necesita con el orden temporal.
  const mes = String(report_date).slice(0, 7);
  const antes = (paresDelSector || []).filter((p) => p && p.reported_date
    && String(p.reported_date).slice(0, 7) === mes && p.reported_date < report_date
    && typeof p.beat === 'boolean');
  const pares = antes.length ? antes.filter((p) => p.beat).length / antes.length : null;

  return {
    tasa: beats / previos.length,
    // Racha CON SIGNO: +3 son tres beats al hilo, −3 tres misses. Un modelo
    // que recibe "3" sin signo no puede distinguir una cosa de la otra.
    racha: previos[0].beat ? racha : -racha,
    sorpresa_mediana: mediana(previos.map((p) => p.sorpresa)),
    pares,
    pares_n: antes.length,
    trimestres_previos: previos.length,
    sin_historial: false,
  };
}

// ─────────────────── regresión logística ───────────────────
//
// Lo más tonto que funciona, y a propósito: 4 features + intercepto, descenso
// de gradiente con tasa y pasos FIJOS, sin tuning ni búsqueda. Cada grado de
// libertad extra es una oportunidad de jardín de pruebas, y con 240 filas el
// jardín se llena rápido. Determinista: los mismos datos dan el mismo modelo.
const ORDEN_FEATURES = ['tasa', 'racha', 'sorpresa_mediana', 'pares'];
const PASOS = 400;
const TASA_APRENDIZAJE = 0.1;
const L2 = 1e-3;   // sólo para que no se vaya al infinito con features casi colineales

const sigmoide = (z) => 1 / (1 + Math.exp(-z));

// Faltante → 0 tras estandarizar, o sea "la media": el modelo no recibe una
// invención, recibe "no sé". Se cuenta aparte cuántos hubo.
function matriz(eventos, estand) {
  return eventos.map((e) => ORDEN_FEATURES.map((k, i) => {
    const v = e.features ? e.features[k] : null;
    if (!Number.isFinite(v)) return 0;
    const { mu, sd } = estand[i];
    return sd > 0 ? (v - mu) / sd : 0;
  }));
}

function estandarizacion(eventos) {
  return ORDEN_FEATURES.map((k) => {
    const vals = eventos.map((e) => (e.features ? e.features[k] : null)).filter(Number.isFinite);
    const mu = media(vals) ?? 0;
    const sd = vals.length > 1
      ? Math.sqrt(media(vals.map((v) => (v - mu) ** 2)) || 0) : 0;
    return { mu, sd };
  });
}

function entrena(eventos) {
  const estand = estandarizacion(eventos);
  const X = matriz(eventos, estand);
  const y = eventos.map((e) => (e.beat ? 1 : 0));
  const w = new Array(ORDEN_FEATURES.length).fill(0);
  let b = 0;
  const n = X.length || 1;
  for (let paso = 0; paso < PASOS; paso++) {
    const gw = new Array(w.length).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const p = sigmoide(X[i].reduce((a, x, j) => a + x * w[j], b));
      const err = p - y[i];
      for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < w.length; j++) w[j] -= TASA_APRENDIZAJE * (gw[j] / n + L2 * w[j]);
    b -= TASA_APRENDIZAJE * (gb / n);
  }
  return { w, b, estand, tasa_base: media(y) ?? 0.5 };
}

function predice(modelo, evento) {
  const x = ORDEN_FEATURES.map((k, i) => {
    const v = evento.features ? evento.features[k] : null;
    if (!Number.isFinite(v)) return 0;
    const { mu, sd } = modelo.estand[i];
    return sd > 0 ? (v - mu) / sd : 0;
  });
  return sigmoide(x.reduce((a, xi, j) => a + xi * modelo.w[j], modelo.b));
}

// Predicción FUERA DE MUESTRA por k-fold determinista (fold = índice % k).
// No es lo mismo que grabar hacia adelante —el modelo sigue viendo el mismo
// período— pero al menos ninguna fila puntúa con un modelo que la vio.
function prediceCV(eventos, k = CRITERIOS_F2.folds_cv) {
  const preds = new Array(eventos.length).fill(null);
  for (let f = 0; f < k; f++) {
    const train = eventos.filter((_, i) => i % k !== f);
    const test = eventos.map((e, i) => ({ e, i })).filter(({ i }) => i % k === f);
    if (train.length < 10) { for (const { i } of test) preds[i] = null; continue; }
    const m = entrena(train);
    for (const { e, i } of test) preds[i] = predice(m, e);
  }
  return preds;
}

// ─────────────────── métricas ───────────────────

function brier(ps, ys) {
  const pares = ps.map((p, i) => [p, ys[i]]).filter(([p]) => Number.isFinite(p));
  if (!pares.length) return null;
  return +(media(pares.map(([p, y]) => (p - y) ** 2))).toFixed(5);
}

// Acierto por DECIL de probabilidad. El encargo lo pide porque un Brier
// agregado bueno puede venir entero del tramo donde el mercado ya está en 1:
// ahí no hay apuesta, y el agregado no lo muestra.
function calibracionPorDecil(ps, ys, { deciles = CRITERIOS_F2.deciles } = {}) {
  const cubos = Array.from({ length: deciles }, (_, i) => ({
    desde: +(i / deciles).toFixed(2), hasta: +((i + 1) / deciles).toFixed(2),
    n: 0, predicho: [], observado: 0,
  }));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!Number.isFinite(p)) continue;
    const idx = Math.min(deciles - 1, Math.floor(p * deciles));
    cubos[idx].n++;
    cubos[idx].predicho.push(p);
    if (ys[i] === 1) cubos[idx].observado++;
  }
  return cubos.map((c) => ({
    desde: c.desde, hasta: c.hasta, n: c.n,
    predicho_medio: c.n ? +media(c.predicho).toFixed(3) : null,
    observado: c.n ? +(c.observado / c.n).toFixed(3) : null,
    brecha: c.n ? +(media(c.predicho) - c.observado / c.n).toFixed(3) : null,
  }));
}

// ─────────────────── simulación ───────────────────
//
// Mecánica congelada: se apuesta 1 unidad cuando |modelo − mercado| ≥ umbral,
// del lado que dice el modelo. Comprar a precio `p` da 1/p acciones que pagan
// $1 si acierta, así que la ganancia es (1/p − 1) y la pérdida es −1. El costo
// es 3% del stake y se cobra SIEMPRE, gane o pierda.
function simula(eventos, preds, {
  umbral = CRITERIOS_F2.umbral_desacuerdo,
  costo = CRITERIOS_F2.costo_por_apuesta,
} = {}) {
  const apuestas = [];
  for (let i = 0; i < eventos.length; i++) {
    const p = preds[i];
    const m = eventos[i].mercado;
    if (!Number.isFinite(p) || !Number.isFinite(m)) continue;
    if (Math.abs(p - m) < umbral) continue;
    const ladoSi = p > m;                       // el modelo cree más que el mercado
    const precio = ladoSi ? m : 1 - m;
    if (!(precio > 0 && precio < 1)) continue;  // sin precio operable no hay apuesta
    const acierta = ladoSi ? eventos[i].beat : !eventos[i].beat;
    const pnl = (acierta ? (1 / precio - 1) : -1) - costo;
    apuestas.push({
      symbol: eventos[i].symbol, report_date: eventos[i].report_date,
      modelo: +p.toFixed(3), mercado: +m.toFixed(3), lado: ladoSi ? 'si' : 'no',
      precio: +precio.toFixed(3), acierta, pnl: +pnl.toFixed(4),
    });
  }
  const neto = apuestas.length ? apuestas.reduce((a, x) => a + x.pnl, 0) : 0;
  return {
    apuestas: apuestas.length,
    aciertos: apuestas.filter((a) => a.acierta).length,
    neto_unidades: +neto.toFixed(3),
    neto_por_apuesta: apuestas.length ? +(neto / apuestas.length).toFixed(4) : null,
    umbral, costo,
    detalle: apuestas,
  };
}

// ─────────────────── el análisis completo ───────────────────

function analiza(eventos, { criterios = CRITERIOS_F2 } = {}) {
  const ys = eventos.map((e) => (e.beat ? 1 : 0));
  const sinPares = eventos.filter((e) => !e.features || !Number.isFinite(e.features.pares)).length;
  const mercado = eventos.map((e) => (Number.isFinite(e.mercado) ? e.mercado : null));

  // ── Baselines. Sin estos el número del modelo no significa nada. ──
  // 1. "siempre sí": la tasa base de la muestra, aplicada a todos.
  const tasaBase = media(ys) ?? 0.5;
  const siempreSi = ys.map(() => tasaBase);
  // 2. tasa histórica por empresa, SIN modelo: es el feature `tasa` crudo.
  //    Sin historial cae a la tasa base — declarado, no inventado.
  const porEmpresa = eventos.map((e) => {
    const t = e.features ? e.features.tasa : null;
    return Number.isFinite(t) ? t : tasaBase;
  });
  // 3. el precio de Polymarket a T-24h: el que decide.

  // ── Modelo: predicción FUERA DE MUESTRA (k-fold) como principal ──
  const predCV = prediceCV(eventos, criterios.folds_cv);
  const modeloEnMuestra = entrena(eventos);
  const predEnMuestra = eventos.map((e) => predice(modeloEnMuestra, e));

  const briers = {
    modelo_cv: brier(predCV, ys),
    siempre_si: brier(siempreSi, ys),
    tasa_por_empresa: brier(porEmpresa, ys),
    mercado_t24h: brier(mercado, ys),
    modelo_en_muestra_EXPLORATORIO: brier(predEnMuestra, ys),
  };

  const sim = simula(eventos, predCV, {
    umbral: criterios.umbral_desacuerdo, costo: criterios.costo_por_apuesta,
  });
  const enSaturado = sim.detalle.filter((a) => a.mercado >= criterios.tramo_saturado_desde).length;

  // ── Veredicto, contra los umbrales congelados ──
  const candados = [];
  if (eventos.length < criterios.min_mercados) {
    candados.push(`muestra: ${eventos.length} < ${criterios.min_mercados} mercados`);
  }
  if (sim.apuestas < criterios.min_apuestas) {
    candados.push(`apuestas: ${sim.apuestas} < ${criterios.min_apuestas} — el neto no es legible`);
  }

  const lectura = Number.isFinite(briers.modelo_cv) && Number.isFinite(briers.tasa_por_empresa)
    && briers.modelo_cv < briers.tasa_por_empresa;
  const gana_al_mercado = Number.isFinite(briers.modelo_cv) && Number.isFinite(briers.mercado_t24h)
    && briers.modelo_cv < briers.mercado_t24h;
  const neto_positivo = sim.neto_unidades > 0;
  const edge = gana_al_mercado && neto_positivo;

  const veredicto = candados.length ? 'INCONCLUSO' : (lectura && edge) ? 'GO' : 'NO-GO';

  const porque = candados.length ? candados
    : [
        `lectura (Brier modelo ${briers.modelo_cv} ${lectura ? '<' : '≥'} tasa por empresa ${briers.tasa_por_empresa}): ${lectura ? 'PASA' : 'NO pasa'}`,
        `edge vs mercado (Brier modelo ${briers.modelo_cv} ${gana_al_mercado ? '<' : '≥'} mercado ${briers.mercado_t24h}): ${gana_al_mercado ? 'PASA' : 'NO pasa'}`,
        `neto de la simulación (${sim.neto_unidades} unidades en ${sim.apuestas} apuestas): ${neto_positivo ? 'PASA' : 'NO pasa'}`,
      ];

  return {
    criterios,
    // Las predicciones de ESTA corrida, alineadas con `eventos`. La vista de
    // comparación las consume tal cual: si recalculara el modelo por su
    // cuenta, la tabla y el veredicto podrían mostrar números distintos del
    // mismo evento, y nadie sabría cuál creer.
    predicciones: predCV,
    muestra: {
      mercados: eventos.length,
      beats: ys.filter((y) => y === 1).length,
      tasa_base: +tasaBase.toFixed(4),
      sin_historial: eventos.filter((e) => e.features && e.features.sin_historial).length,
      sin_pares: sinPares,
      // UN FEATURE SIEMPRE NULO NO ES UN FEATURE, y hay que decirlo en vez de
      // dejar que el modelo lo reciba como "la media" en silencio. Pasa cuando
      // los pares del sector NO reportaron todavía en la misma temporada
      // *según pead_earnings* — o sea, cuando nuestra cosecha del PEAD está
      // atrasada (§0.2 del scope). El modelo entonces corre con 3 features, no
      // con 4, y el veredicto se lee sabiendo eso.
      aviso_pares: sinPares === eventos.length
        ? `El feature de pares es null en LOS ${eventos.length} eventos: no aporta nada y el modelo corre de hecho con 3 features. Causa típica: el historial de los pares de la misma temporada no está en pead_earnings (deuda §0.2).`
        : sinPares / Math.max(1, eventos.length) > 0.5
          ? `El feature de pares es null en ${sinPares} de ${eventos.length} eventos (más de la mitad): su peso no es interpretable.`
          : null,
    },
    modelo: {
      tipo: 'regresión logística, 4 features + intercepto, descenso de gradiente con pasos fijos',
      features: ORDEN_FEATURES,
      pesos_en_muestra: ORDEN_FEATURES.reduce((o, k, i) => ({ ...o, [k]: +modeloEnMuestra.w[i].toFixed(4) }), {}),
      intercepto: +modeloEnMuestra.b.toFixed(4),
      prediccion_principal: `fuera de muestra, k-fold k=${criterios.folds_cv}`,
      nota_en_muestra: 'El Brier en muestra va etiquetado EXPLORATORIO: sirve para ver la brecha con el de CV, no para el veredicto.',
    },
    briers,
    calibracion: {
      modelo_cv: calibracionPorDecil(predCV, ys, { deciles: criterios.deciles }),
      mercado: calibracionPorDecil(mercado, ys, { deciles: criterios.deciles }),
    },
    simulacion: { ...sim, apuestas_en_tramo_saturado: enSaturado },
    veredicto,
    porque,
    // La advertencia que el encargo pidió dejar escrita, y que no depende del
    // resultado: va igual en GO, en NO-GO y en INCONCLUSO.
    advertencia: 'El modelo se construyó VIENDO cómo salieron estos mercados. Un GO acá es SEÑAL, no prueba: incluso con predicción fuera de muestra por k-fold, la elección de features y de ventana se hizo mirando este mismo período. La prueba es grabar hacia adelante con el modelo CONGELADO y leer después.',
    saturacion: {
      apuestas_en_tramo_saturado: enSaturado,
      de: sim.apuestas,
      aviso: sim.apuestas && enSaturado / sim.apuestas > 0.5
        ? `Más de la mitad de las apuestas (${enSaturado} de ${sim.apuestas}) caen donde el mercado ya está ≥ ${criterios.tramo_saturado_desde}. Ahí el precio deja poco que ganar y la ventaja es frágil aunque el neto salga positivo.`
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// VISTA DE COMPARACIÓN — dónde coinciden y dónde no
//
// NO es una señal de apuesta y NO calcula retornos. La pregunta que contesta
// es otra: ¿en qué mercados QuantDesk y Polymarket dicen lo mismo, y en cuáles
// no, sobre todo en la zona de duda donde ninguno de los dos está seguro?
//
// Usa las MISMAS predicciones fuera de muestra que el veredicto (las que
// `analiza()` devuelve en `predicciones`). No re-entrena nada: un segundo
// ajuste daría números parecidos pero distintos, y entonces habría dos
// QuantDesk y ninguna forma de saber cuál es el que dictaminó NO-GO.
// ═══════════════════════════════════════════════════════════════════

// Un pronóstico probabilístico "acierta" cuando su LADO fue el correcto. La
// definición está acá, congelada, porque "acierto" en un número entre 0 y 1 no
// es obvio: p ≥ 0.5 apostaría a beat, p < 0.5 a miss.
const acierta = (p, beat) => (Number.isFinite(p) ? (p >= 0.5 ? beat : !beat) : null);

const TRAMOS = [
  [0.00, 0.25], [0.25, 0.40], [0.40, 0.55],
  // La zona de DUDA, partida fina: es la que la pregunta persigue.
  [0.55, 0.65], [0.65, 0.75],
  [0.75, 0.85], [0.85, 0.95], [0.95, 1.001],
];
const MIN_N_TRAMO = 20;   // por debajo de esto no se concluye nada

function comparacion(eventos, predicciones, {
  zonaDesde = null, zonaHasta = null, orden = 'desacuerdo', descendente = true,
} = {}) {
  const filas = [];
  const descartadas = [];
  for (let i = 0; i < eventos.length; i++) {
    const e = eventos[i];
    const qd = predicciones[i];
    const pm = e.mercado;
    if (!Number.isFinite(qd) || !Number.isFinite(pm)) {
      // Una fila que no se puede comparar NO desaparece en silencio: la tabla
      // se encogería un mercado y nadie se enteraría.
      descartadas.push({ symbol: e.symbol, report_date: e.report_date,
        motivo: !Number.isFinite(qd) ? 'sin_prediccion' : 'sin_precio_de_mercado' });
      continue;
    }
    const y = e.beat ? 1 : 0;
    const errQd = Math.abs(qd - y);
    const errPm = Math.abs(pm - y);
    filas.push({
      symbol: e.symbol, report_date: e.report_date,
      prob_quantdesk: +qd.toFixed(3),
      prob_polymarket: +pm.toFixed(3),
      // CON SIGNO: + significa que QuantDesk es MÁS optimista que el mercado.
      desacuerdo: +(qd - pm).toFixed(3),
      desacuerdo_abs: +Math.abs(qd - pm).toFixed(3),
      resultado: e.beat ? 'beat' : 'miss',
      acierta_quantdesk: acierta(qd, e.beat),
      acierta_polymarket: acierta(pm, e.beat),
      // "Más cerca" es distancia al resultado (0 o 1), no quién acertó el lado:
      // los dos pueden acertar el lado y uno estar mucho más cerca.
      mas_cerca: Math.abs(errQd - errPm) < 1e-9 ? 'empate' : (errQd < errPm ? 'quantdesk' : 'polymarket'),
      error_quantdesk: +errQd.toFixed(3),
      error_polymarket: +errPm.toFixed(3),
    });
  }

  // El filtro es por la probabilidad del MERCADO: la zona de duda se define
  // por dónde duda el mercado, que es el referente.
  const enZona = filas.filter((f) =>
    (zonaDesde === null || f.prob_polymarket >= zonaDesde)
    && (zonaHasta === null || f.prob_polymarket < zonaHasta));

  const cmp = {
    desacuerdo: (a, b) => a.desacuerdo_abs - b.desacuerdo_abs,
    desacuerdo_con_signo: (a, b) => a.desacuerdo - b.desacuerdo,
    fecha: (a, b) => String(a.report_date).localeCompare(String(b.report_date)),
    simbolo: (a, b) => String(a.symbol).localeCompare(String(b.symbol)),
    mercado: (a, b) => a.prob_polymarket - b.prob_polymarket,
  }[orden] || ((a, b) => a.desacuerdo_abs - b.desacuerdo_abs);
  const ordenadas = enZona.slice().sort((a, b) => (descendente ? -cmp(a, b) : cmp(a, b)));

  return {
    es_vista_de_comparacion: true,
    no_es_senal: 'Esta vista NO es una señal de apuesta y NO calcula retornos. Compara dos pronósticos contra lo que pasó; no recomienda nada.',
    filtro: { zona_mercado_desde: zonaDesde, zona_mercado_hasta: zonaHasta, orden, descendente,
      filas_en_zona: enZona.length, filas_totales: filas.length,
      eventos_recibidos: eventos.length, descartadas: descartadas.length,
      aviso_descartadas: descartadas.length
        ? `${descartadas.length} de ${eventos.length} mercados quedaron fuera de la tabla por no tener los dos números que hacen falta para compararlos.`
        : null,
      detalle_descartadas: descartadas },
    filas: ordenadas,
    por_tramo: resumenPorTramo(filas),
    distribucion: distribucionComparada(filas),
    ...titularDeDuda(filas),
  };
}

// Resumen por tramo del MERCADO. Es el que contesta la pregunta: en la zona de
// duda, ¿se parecen o no, y quién queda más cerca?
function resumenPorTramo(filas) {
  return TRAMOS.map(([desde, hasta]) => {
    const enT = filas.filter((f) => f.prob_polymarket >= desde && f.prob_polymarket < hasta);
    const n = enT.length;
    const medDes = mediana(enT.map((f) => f.desacuerdo));
    const aciertoQd = n ? enT.filter((f) => f.acierta_quantdesk).length / n : null;
    const aciertoPm = n ? enT.filter((f) => f.acierta_polymarket).length / n : null;
    return {
      tramo: `${desde.toFixed(2)}–${Math.min(1, hasta).toFixed(2)}`,
      n,
      // La zona de duda tiene pocos casos por definición: es donde el mercado
      // se moja menos. Marcarlo evita leer una diferencia de 3 casos como un
      // hallazgo, que es el error más fácil de cometer con esta tabla.
      muestra_insuficiente: n < MIN_N_TRAMO,
      desacuerdo_mediano: medDes === null ? null : +medDes.toFixed(3),
      acierto_quantdesk: aciertoQd === null ? null : +aciertoQd.toFixed(3),
      acierto_polymarket: aciertoPm === null ? null : +aciertoPm.toFixed(3),
      quantdesk_mas_cerca: enT.filter((f) => f.mas_cerca === 'quantdesk').length,
      polymarket_mas_cerca: enT.filter((f) => f.mas_cerca === 'polymarket').length,
      empates: enT.filter((f) => f.mas_cerca === 'empate').length,
      beats_reales: n ? +(enT.filter((f) => f.resultado === 'beat').length / n).toFixed(3) : null,
    };
  });
}

// Dónde pone su masa cada uno. De acá sale el titular, calculado y no escrito
// a mano: si mañana el modelo cambia, la frase cambia con él.
function distribucionComparada(filas, deciles = 10) {
  const cubos = Array.from({ length: deciles }, (_, i) => ({
    desde: +(i / deciles).toFixed(2), hasta: +((i + 1) / deciles).toFixed(2), quantdesk: 0, polymarket: 0,
  }));
  for (const f of filas) {
    cubos[Math.min(deciles - 1, Math.floor(f.prob_quantdesk * deciles))].quantdesk++;
    cubos[Math.min(deciles - 1, Math.floor(f.prob_polymarket * deciles))].polymarket++;
  }
  return cubos;
}

// EL TITULAR, en letras y calculado. La pregunta "¿quién duda más?" se contesta
// con cuánta masa pone cada uno en los extremos (≥0.9 y ≤0.1): el que pone
// menos es el que duda más. Se dice, no se deja deducir de una tabla.
function titularDeDuda(filas) {
  const n = filas.length;
  const extremo = (k) => filas.filter((f) => f[k] >= 0.9 || f[k] <= 0.1).length;
  const alto = (k, d, h) => filas.filter((f) => f[k] >= d && f[k] < h).length;
  const exQd = extremo('prob_quantdesk');
  const exPm = extremo('prob_polymarket');
  const quienDudaMas = exQd === exPm ? null : (exQd < exPm ? 'quantdesk' : 'polymarket');

  const detalle = [
    `mercado en 0.9–1: ${alto('prob_polymarket', 0.9, 1.001)} · QuantDesk en 0.9–1: ${alto('prob_quantdesk', 0.9, 1.001)}`,
    `mercado en 0.8–0.9: ${alto('prob_polymarket', 0.8, 0.9)} · QuantDesk en 0.8–0.9: ${alto('prob_quantdesk', 0.8, 0.9)}`,
  ];

  return {
    titular: quienDudaMas === null
      ? `Los dos se mojan parecido: ${exQd} de ${n} pronósticos en los extremos (≥0.9 o ≤0.1) cada uno.`
      : quienDudaMas === 'quantdesk'
        ? `**QuantDesk duda más que el mercado.** Pone ${exQd} de ${n} pronósticos en los extremos (≥0.9 o ≤0.1); el mercado pone ${exPm}. O sea que el modelo se moja menos, y por eso su probabilidad casi nunca llega donde llega el precio.`
        : `**El mercado duda más que QuantDesk.** Pone ${exPm} de ${n} pronósticos en los extremos (≥0.9 o ≤0.1); el modelo pone ${exQd}.`,
    titular_detalle: detalle,
    extremos: { quantdesk: exQd, polymarket: exPm, de: n },
  };
}

function renderComparacionMd(c, { veredicto = null } = {}) {
  const L = [];
  L.push('# QuantDesk vs Polymarket — dónde coinciden y dónde no');
  L.push('');
  L.push(`Generado: ${c.generado_en || '—'} · ${c.filtro.filas_totales} mercados`);
  L.push('');
  if (veredicto) {
    L.push(`> **El veredicto de la Fase 2 sigue siendo ${veredicto}.** La columna de QuantDesk es la salida de un modelo que **no** pasó sus criterios; está acá para comparar, no porque esté validada.`);
    L.push('');
  }
  L.push(`> ${c.no_es_senal}`);
  L.push('');
  L.push('## ' + String(c.titular).replace(/\*\*/g, ''));
  L.push('');
  for (const d of c.titular_detalle || []) L.push(`- ${d}`);
  L.push('');

  L.push('## Por tramo del MERCADO (la zona de duda es 0.55–0.75)');
  L.push('');
  L.push('| Tramo | n | Desacuerdo mediano | Acierto QD | Acierto mercado | QD más cerca | Mercado más cerca | Beats reales |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const t of c.por_tramo || []) {
    if (!t.n) continue;
    const marca = t.muestra_insuficiente ? ' ⚠' : '';
    L.push(`| ${t.tramo}${marca} | ${t.n} | ${t.desacuerdo_mediano ?? '—'} | ${t.acierto_quantdesk ?? '—'} | ${t.acierto_polymarket ?? '—'} | ${t.quantdesk_mas_cerca} | ${t.polymarket_mas_cerca} | ${t.beats_reales ?? '—'} |`);
  }
  L.push('');
  L.push(`⚠ = menos de ${MIN_N_TRAMO} casos: **muestra insuficiente para concluir**. La zona de duda tiene pocos casos por definición — es donde el mercado se moja menos — así que es justo donde más fácil es confundir tres casos con un hallazgo.`);
  L.push('');

  L.push('## Dónde pone su masa cada uno');
  L.push('');
  L.push('| Tramo | QuantDesk | Polymarket |');
  L.push('|---|---|---|');
  for (const d of c.distribucion || []) {
    if (!d.quantdesk && !d.polymarket) continue;
    L.push(`| ${d.desde}–${d.hasta} | ${d.quantdesk} | ${d.polymarket} |`);
  }
  L.push('');

  const f = c.filas || [];
  L.push(`## Mayor desacuerdo${c.filtro.zona_mercado_desde !== null ? ` (mercado ${c.filtro.zona_mercado_desde}–${c.filtro.zona_mercado_hasta ?? 1})` : ''}`);
  L.push('');
  L.push('| Símbolo | Fecha | QD | Mercado | Desacuerdo | Resultado | Más cerca |');
  L.push('|---|---|---|---|---|---|---|');
  for (const x of f.slice(0, 25)) {
    L.push(`| ${x.symbol} | ${x.report_date} | ${x.prob_quantdesk} | ${x.prob_polymarket} | ${x.desacuerdo > 0 ? '+' : ''}${x.desacuerdo} | ${x.resultado} | ${x.mas_cerca} |`);
  }
  if (f.length > 25) { L.push(''); L.push(`_(${f.length} filas en total; se muestran 25. El JSON las trae todas.)_`); }
  L.push('');
  L.push('Desacuerdo **con signo**: positivo = QuantDesk más optimista que el mercado.');
  return L.join('\n');
}

// ─────────────────── resumen en español ───────────────────

function renderResumenF2(a) {
  const L = [];
  const c = a.criterios || CRITERIOS_F2;
  L.push('# FASE 2 — ¿le gana el modelo al precio de Polymarket?');
  L.push('');
  L.push(`Generado: ${a.generado_en || '—'}`);
  L.push('');
  L.push(`## VEREDICTO: ${a.veredicto}`);
  L.push('');
  for (const p of a.porque || []) L.push(`- ${p}`);
  L.push('');
  L.push(`> ⚠ ${a.advertencia}`);
  L.push('');

  const m = a.muestra || {};
  L.push('## Muestra');
  L.push('');
  L.push(`Mercados: **${m.mercados}** (umbral ${c.min_mercados}) · beats: ${m.beats} · tasa base: ${m.tasa_base}`);
  L.push(`Sin historial previo: ${m.sin_historial} · sin pares del sector: ${m.sin_pares}`);
  if (m.aviso_pares) { L.push(''); L.push(`> ⚠ ${m.aviso_pares}`); }
  if (a.liquidez) {
    L.push('');
    L.push(`Liquidez: umbral **$${c.min_volumen_usd}** (piso de ruido declarado $${c.piso_de_ruido_declarado_usd}) · sobreviven **${a.liquidez.sobreviven}** de ${a.liquidez.antes}, descartados ${a.liquidez.descartados}.`);
  }
  L.push('');

  L.push('## Brier (menor = mejor)');
  L.push('');
  L.push('| Predictor | Brier | ¿Qué es? |');
  L.push('|---|---|---|');
  L.push(`| **modelo (fuera de muestra, k-fold)** | **${a.briers.modelo_cv}** | el que decide |`);
  L.push(`| tasa por empresa | ${a.briers.tasa_por_empresa} | baseline 2 — el que hay que batir para "lectura" |`);
  L.push(`| **Polymarket T-24h** | **${a.briers.mercado_t24h}** | baseline 3 — el que hay que batir para "edge" |`);
  L.push(`| "siempre sí" | ${a.briers.siempre_si} | baseline 1 |`);
  L.push(`| modelo en muestra | ${a.briers.modelo_en_muestra_EXPLORATORIO} | **EXPLORATORIO** — no cuenta |`);
  L.push('');

  L.push('## Calibración por decil (el agregado puede mentir)');
  L.push('');
  L.push('| Tramo | n | predicho | observado | brecha | mercado obs. |');
  L.push('|---|---|---|---|---|---|');
  for (let i = 0; i < (a.calibracion.modelo_cv || []).length; i++) {
    const d = a.calibracion.modelo_cv[i];
    const dm = (a.calibracion.mercado || [])[i] || {};
    if (!d.n && !dm.n) continue;
    L.push(`| ${d.desde}–${d.hasta} | ${d.n} | ${d.predicho_medio ?? '—'} | ${d.observado ?? '—'} | ${d.brecha ?? '—'} | ${dm.observado ?? '—'} (n=${dm.n || 0}) |`);
  }
  L.push('');

  const s = a.simulacion || {};
  L.push('## Simulación');
  L.push('');
  L.push(`Apuesta solo si |modelo − mercado| ≥ ${c.umbral_desacuerdo * 100} pts · costo ${c.costo_por_apuesta * 100}% por apuesta`);
  L.push('');
  L.push(`Apuestas: **${s.apuestas}** (mínimo ${c.min_apuestas}) · aciertos: ${s.aciertos} · neto: **${s.neto_unidades}** unidades (${s.neto_por_apuesta ?? '—'} por apuesta)`);
  if (a.saturacion && a.saturacion.aviso) {
    L.push('');
    L.push(`> ${a.saturacion.aviso}`);
  }
  L.push('');
  L.push('## Modelo');
  L.push('');
  L.push(`${a.modelo.tipo}. Predicción principal: ${a.modelo.prediccion_principal}.`);
  L.push('');
  L.push('| Feature | Peso (en muestra) |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(a.modelo.pesos_en_muestra || {})) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push(`Los pesos son del ajuste en muestra, publicados para poder leer el SIGNO de cada feature. El veredicto usa la predicción fuera de muestra.`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('**Los criterios estaban congelados antes de correr esto** (`CRITERIOS_F2` en `api/_lib/earnings-beat-analyze.js`), incluidos el umbral de liquidez y el tratamiento de la sorpresa de escala. El veredicto lo lee quien abre esta página; el endpoint no se auto-aprueba.');
  return L.join('\n');
}

export {
  CRITERIOS_F2, ORDEN_FEATURES, featuresDeEvento, winsoriza, mediana, media,
  entrena, predice, prediceCV, brier, calibracionPorDecil, simula, sigmoide,
  analiza, renderResumenF2,
  comparacion, renderComparacionMd, resumenPorTramo, distribucionComparada,
  titularDeDuda, acierta, TRAMOS, MIN_N_TRAMO,
};
