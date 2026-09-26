// ═══════════════════════════════════════════════════════════════════
// api/_lib/grades-backtest.js — LÓGICA PURA del backtest de enfriamiento.
//
// La pregunta: ¿el enfriamiento de los analistas ANTES del reporte predice
// beat/miss?
//
// ── ESTO ES UN BACKTEST PRE-REGISTRADO ─────────────────────────────
// Todos los umbrales, la definición del score, la ventana y el criterio de GO
// están EN ESTE ARCHIVO y se fijaron ANTES de correr nada — el pre-registro
// está en `docs/grades-backtest-scope.md`. Cada uno tiene un test que lo pinea:
// mover una portería rompe un test y se ve en el diff. Es el mismo patrón del
// PEAD y del earnings-beat, y existe porque elegir el umbral después de ver el
// p-valor es exactamente cómo se fabrica un hallazgo.
//
// Sin red y sin DB: fixtures en los tests.
// ═══════════════════════════════════════════════════════════════════

const CRITERIOS_GRADES = {
  version: 1,

  // ── LA SEÑAL, definida antes de ver un solo dato ──
  // score = (2·strongBuy + buy − sell − 2·strongSell) / total_analistas
  // `total_analistas` incluye los HOLD: son analistas que cubren el nombre y
  // decidieron no mojarse. Dejarlos fuera del denominador haría que una casa
  // que pasa de buy a hold suba el score, que es lo contrario de enfriarse.
  pesos: { strongBuy: 2, buy: 1, hold: 0, sell: -1, strongSell: -2 },

  // ── LA VENTANA: del mes T-3 al mes T-1 antes del reporte ──
  // La serie de FMP es MENSUAL, así que "T-1" es la última fila estrictamente
  // anterior al reporte y "T-3" la más cercana a 90 días antes. Las dos
  // tolerancias existen porque una serie con huecos convertiría un "cambio de
  // 3 meses" en un cambio de otra cosa, sin avisar.
  max_dias_t1: 45,          // si la última fila es más vieja que esto: rancia
  min_dias_ventana: 45,     // T-1 y T-3 separados por menos de mes y medio: no es la ventana
  max_dias_ventana: 135,    // por más de 4.5 meses tampoco
  dias_objetivo_t3: 90,     // T-3 = la fila más cercana a esto
  min_meses_grades: 3,      // al menos 3 filas ANTERIORES al reporte

  // ── CANDADOS DE MUESTRA. Van ANTES que cualquier número. ──
  min_eventos: 100,         // por debajo: INCONCLUSO y se para
  min_por_tercil: 30,

  // ── CRITERIO DE GO ──
  terciles: 3,
  min_diferencia_pp: 10,    // entre los terciles EXTREMOS
  max_p_valor: 0.05,

  // ── BASELINE OBLIGATORIO ──
  // La tasa base de beats del universo. Una señal que no se aparta de esto no
  // es una señal: es la tasa base con otro nombre.
  tasa_base_universo: 0.8182,
};

// ─────────────────── el score de sentimiento ───────────────────

const n0 = (x) => {
  const v = Number(x);
  return Number.isFinite(v) && v >= 0 ? v : 0;
};

// Devuelve null cuando NO hay analistas. Un mes sin cobertura no es un score de
// cero: cero es "los buy y los sell se cancelan", que es otra cosa.
function scoreSentimiento(fila, { pesos = CRITERIOS_GRADES.pesos } = {}) {
  if (!fila || typeof fila !== 'object') return null;
  const c = {
    strongBuy: n0(fila.strongBuy), buy: n0(fila.buy), hold: n0(fila.hold),
    sell: n0(fila.sell), strongSell: n0(fila.strongSell),
  };
  const total = c.strongBuy + c.buy + c.hold + c.sell + c.strongSell;
  if (!total) return null;
  const suma = pesos.strongBuy * c.strongBuy + pesos.buy * c.buy + pesos.hold * c.hold
    + pesos.sell * c.sell + pesos.strongSell * c.strongSell;
  return { score: suma / total, total_analistas: total, conteos: c };
}

const dia = (x) => {
  if (!x) return null;
  const s = String(x).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const diasEntre = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

// ─────────────────── T-3 y T-1, sin look-ahead ───────────────────
//
// EL CORTE ES ESTRICTO: `fecha < report_date`. Una fila fechada EL DÍA del
// reporte ya puede contener la reacción de los analistas al reporte, y con eso
// el backtest entero se cae — es el mismo cuidado que el precio a T-24h del
// earnings-beat. Hay test con una fila fechada exactamente en report_date.
function seleccionaVentana(grades, report_date, { criterios = CRITERIOS_GRADES } = {}) {
  const rep = dia(report_date);
  if (!rep) return { ok: false, motivo: 'sin_report_date' };

  const previas = (Array.isArray(grades) ? grades : [])
    .map((g) => ({ ...g, fecha: dia(g && g.date) }))
    .filter((g) => g.fecha && g.fecha < rep)          // ESTRICTO
    .sort((a, b) => b.fecha.localeCompare(a.fecha));   // más reciente primero

  if (previas.length < criterios.min_meses_grades) {
    return { ok: false, motivo: 'menos_de_3_meses', meses_previos: previas.length };
  }

  const t1 = previas[0];
  const diasT1 = diasEntre(rep, t1.fecha);
  if (diasT1 > criterios.max_dias_t1) {
    return { ok: false, motivo: 't1_rancio', dias_t1: diasT1, max: criterios.max_dias_t1, meses_previos: previas.length };
  }

  // T-3: la fila más cercana a `dias_objetivo_t3` días antes del reporte, ENTRE
  // las que además dejan una ventana T-1↔T-3 dentro del rango.
  //
  // El orden importa y la primera versión lo tenía al revés: elegía la más
  // cercana a 90 días y DESPUÉS miraba la ventana, así que si esa fila dejaba
  // una ventana de 41 días el evento se descartaba aunque hubiera otra fila que
  // sí servía. Con la serie mensual eso tiraba los reportes de fin de mes.
  // Las tolerancias son las mismas; lo que cambió es que la búsqueda no se
  // rinde en el primer candidato.
  const resto = previas.slice(1);
  const enRango = resto.filter((g) => {
    const w = diasEntre(t1.fecha, g.fecha);
    return w >= criterios.min_dias_ventana && w <= criterios.max_dias_ventana;
  });
  if (!enRango.length) {
    // El RANGO de ventanas que había, no una sola: con eso se ve si la serie es
    // demasiado densa (todas cortas) o demasiado vieja (todas largas).
    const anchos = resto.map((g) => diasEntre(t1.fecha, g.fecha));
    return { ok: false, motivo: 'ventana_fuera_de_rango',
      dias_ventana_min: anchos.length ? Math.min(...anchos) : null,
      dias_ventana_max: anchos.length ? Math.max(...anchos) : null,
      min: criterios.min_dias_ventana, max: criterios.max_dias_ventana,
      candidatas: resto.length, meses_previos: previas.length };
  }
  let t3 = null, mejor = Infinity;
  for (const g of enRango) {
    const d = Math.abs(diasEntre(rep, g.fecha) - criterios.dias_objetivo_t3);
    // Empate de distancia → la más vieja, por determinismo.
    if (d < mejor || (d === mejor && t3 && g.fecha < t3.fecha)) { mejor = d; t3 = g; }
  }
  const ventana = diasEntre(t1.fecha, t3.fecha);

  const s1 = scoreSentimiento(t1, { pesos: criterios.pesos });
  const s3 = scoreSentimiento(t3, { pesos: criterios.pesos });
  if (!s1 || !s3) {
    return { ok: false, motivo: 'sin_analistas', meses_previos: previas.length,
      total_t1: s1 ? s1.total_analistas : 0, total_t3: s3 ? s3.total_analistas : 0 };
  }

  return {
    ok: true,
    t1: { fecha: t1.fecha, score: s1.score, total_analistas: s1.total_analistas, conteos: s1.conteos },
    t3: { fecha: t3.fecha, score: s3.score, total_analistas: s3.total_analistas, conteos: s3.conteos },
    dias_t1: diasT1, dias_ventana: ventana,
    // NEGATIVO = enfriamiento (el score bajó). Es la dirección que la pregunta
    // persigue, y va con signo para que no se pierda.
    delta: s1.score - s3.score,
    meses_previos: previas.length,
  };
}

// ─────────────────── terciles ───────────────────
//
// Los cortes se toman por índice sobre la lista ordenada, pero la asignación es
// por VALOR: así dos eventos con el MISMO delta nunca caen en terciles
// distintos. El precio es que los terciles pueden quedar desparejos, y por eso
// se publica el n real de cada uno en vez de asumir n/3.
function terciles(valores, { k = CRITERIOS_GRADES.terciles } = {}) {
  const v = valores.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length < k) return { cortes: [], insuficiente: true };
  const cortes = [];
  for (let i = 1; i < k; i++) cortes.push(v[Math.floor((v.length * i) / k)]);
  return { cortes, insuficiente: false };
}

function tercilDe(delta, cortes) {
  if (!Number.isFinite(delta)) return null;
  for (let i = 0; i < cortes.length; i++) if (delta < cortes[i]) return i;
  return cortes.length;
}

const NOMBRE_TERCIL = ['enfriamiento', 'medio', 'calentamiento'];

// ─────────────────── test de proporciones ───────────────────
//
// z de dos proporciones con varianza AGRUPADA (la hipótesis nula es que las dos
// tasas son la misma, así que la varianza se estima con la tasa común), y
// p-valor a DOS COLAS.
//
// Dos colas porque la pregunta pre-registrada es "¿difiere?", no "¿es menor?".
// Elegir una cola después de ver de qué lado salió la diferencia duplicaría la
// significancia gratis, y eso es mover la portería con otro disfraz.
function erf(x) {
  // Abramowitz & Stegun 7.1.26:
  //   erf(x) ≈ 1 − (a1·t + a2·t² + a3·t³ + a4·t⁴ + a5·t⁵)·e^(−x²),  t = 1/(1+p·x)
  // Error máximo 1.5e-7, determinista. El polinomio va por Horner: la primera
  // versión de esto lo agrupó mal y daba erf(1) = 0.8143 en vez de 0.8427, o
  // sea p(z=1.96) = 0.061 en vez de 0.050 — un p-valor equivocado justo en el
  // umbral del veredicto. Por eso los tests de abajo comparan contra valores
  // de tabla y no solo contra "se ve razonable".
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741
    + t * (-1.453152027 + t * 1.061405429))));
  return s * (1 - poly * Math.exp(-a * a));
}
const normalCDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

function testProporciones(exitos1, n1, exitos2, n2) {
  if (!n1 || !n2) return { z: null, p_valor: null, motivo: 'grupo_vacio' };
  const p1 = exitos1 / n1, p2 = exitos2 / n2;
  const pAgrupada = (exitos1 + exitos2) / (n1 + n2);
  const se = Math.sqrt(pAgrupada * (1 - pAgrupada) * (1 / n1 + 1 / n2));
  if (!se) {
    // Las dos tasas son 0 o las dos son 1: no hay varianza que medir. Un
    // p-valor de 1 dice la verdad (no hay evidencia de diferencia); un 0 sería
    // una mentira aritmética.
    return { z: 0, p_valor: 1, p1, p2, diferencia: p1 - p2, motivo: 'sin_varianza' };
  }
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normalCDF(Math.abs(z)));
  return { z, p_valor: Math.max(0, Math.min(1, p)), p1, p2, diferencia: p1 - p2, motivo: null };
}

// ═══════════════════════════════════════════════════════════════════
// EL ANÁLISIS Y EL VEREDICTO
//
// Orden NO negociable: primero los candados de muestra, después los números.
// Si la muestra no alcanza el veredicto es INCONCLUSO y no se mira la
// diferencia — mirarla y después decidir si "alcanza" es cómo un resultado
// chico se convierte en un hallazgo.
// ═══════════════════════════════════════════════════════════════════

// eventos: [{ symbol, report_date, beat, grades: [{date, strongBuy, ...}] }]
function analizaGrades(eventos, { criterios = CRITERIOS_GRADES } = {}) {
  const evaluados = [];
  const descartes = {};
  for (const e of Array.isArray(eventos) ? eventos : []) {
    const v = seleccionaVentana(e.grades, e.report_date, { criterios });
    if (!v.ok) {
      descartes[v.motivo] = (descartes[v.motivo] || 0) + 1;
      continue;
    }
    evaluados.push({
      symbol: e.symbol, report_date: e.report_date, beat: !!e.beat,
      market_id: e.market_id ?? null,
      delta: v.delta, t1: v.t1, t3: v.t3,
      dias_ventana: v.dias_ventana, dias_t1: v.dias_t1,
    });
  }

  const muestra = {
    eventos_de_entrada: (eventos || []).length,
    con_ventana_valida: evaluados.length,
    descartes,
    min_eventos: criterios.min_eventos,
    // El baseline obligatorio, al lado de la tasa observada en la muestra: si la
    // muestra ya no se parece al universo, la comparación con el baseline no
    // dice lo que parece.
    tasa_base_universo: criterios.tasa_base_universo,
    tasa_beats_en_muestra: evaluados.length
      ? +(evaluados.filter((x) => x.beat).length / evaluados.length).toFixed(4) : null,
  };

  // ── CANDADO 1: la muestra ──
  if (evaluados.length < criterios.min_eventos) {
    return {
      criterios, muestra, terciles: null, comparacion: null,
      veredicto: 'INCONCLUSO',
      porque: [
        `Solo ${evaluados.length} eventos con ventana válida; el candado pre-registrado son ${criterios.min_eventos}. INCONCLUSO y se para acá.`,
        'INCONCLUSO no es NO-GO: con esta muestra no se puede distinguir una señal de la falta de ella.',
        ...motivosDeDescarte(descartes),
      ],
      advertencia: ADVERTENCIA,
    };
  }

  // ── Terciles por delta ──
  const { cortes, insuficiente } = terciles(evaluados.map((x) => x.delta), { k: criterios.terciles });
  const distintos = new Set(evaluados.map((x) => x.delta)).size;
  if (insuficiente || distintos < criterios.terciles) {
    return { criterios, muestra, terciles: null, comparacion: null, veredicto: 'INCONCLUSO',
      porque: [`Los deltas toman solo ${distintos} valor(es) distinto(s): no se puede partir en ${criterios.terciles} terciles.`,
        'INCONCLUSO, no NO-GO: el problema es la forma de la distribución, no la ausencia de señal.'],
      advertencia: ADVERTENCIA };
  }
  for (const x of evaluados) x.tercil = tercilDe(x.delta, cortes);

  // UN TERCIL EXTREMO VACÍO NO ES UN NO-GO. Pasa cuando los deltas se apilan en
  // pocos valores: los cortes coinciden con esos valores y, como la asignación
  // es por `<` estricto, el tercil de abajo queda sin nadie. Sin este chequeo el
  // test de proporciones recibía n = 0, devolvía p-valor null, y el veredicto
  // salía NO-GO — un NO-GO hecho de nulls, que es peor que no contestar.
  const vacios = [0, criterios.terciles - 1].filter((i) => !evaluados.some((x) => x.tercil === i));
  if (vacios.length) {
    return { criterios, muestra, cortes_terciles: cortes.map((c) => +c.toFixed(4)),
      terciles: null, comparacion: null, veredicto: 'INCONCLUSO',
      porque: [`El tercil extremo ${vacios.map((i) => NOMBRE_TERCIL[i]).join(' y ')} quedó VACÍO: los deltas se apilan en muy pocos valores y el corte no separa nada.`,
        'INCONCLUSO, no NO-GO: no hay dos grupos que comparar, así que no hay resultado — ni a favor ni en contra.'],
      advertencia: ADVERTENCIA };
  }

  const grupos = NOMBRE_TERCIL.map((nombre, i) => {
    const en = evaluados.filter((x) => x.tercil === i);
    const beats = en.filter((x) => x.beat).length;
    const deltas = en.map((x) => x.delta).sort((a, b) => a - b);
    return {
      tercil: i, nombre, n: en.length, beats,
      tasa_beats: en.length ? +(beats / en.length).toFixed(4) : null,
      delta_mediano: deltas.length ? +deltas[Math.floor(deltas.length / 2)].toFixed(4) : null,
      delta_min: deltas.length ? +deltas[0].toFixed(4) : null,
      delta_max: deltas.length ? +deltas[deltas.length - 1].toFixed(4) : null,
      muestra_insuficiente: en.length < criterios.min_por_tercil,
    };
  });

  const frio = grupos[0];                       // el que más se enfrió
  const calor = grupos[grupos.length - 1];      // el que más se calentó
  const test = testProporciones(calor.beats, calor.n, frio.beats, frio.n);
  const difPP = test.diferencia === undefined || test.diferencia === null
    ? null : +(test.diferencia * 100).toFixed(2);

  const comparacion = {
    // La diferencia va CON SIGNO y con la dirección dicha en letras: positivo =
    // el tercil que se CALENTÓ superó más seguido.
    entre: 'calentamiento − enfriamiento',
    diferencia_pp: difPP,
    direccion: difPP === null ? null
      : difPP > 0 ? 'el tercil que se CALENTÓ superó más seguido'
        : difPP < 0 ? 'el tercil que se ENFRIÓ superó más seguido' : 'iguales',
    z: test.z === null ? null : +test.z.toFixed(3),
    p_valor: test.p_valor === null ? null : +test.p_valor.toFixed(4),
    colas: 2,
    nota_colas: 'p-valor a DOS colas: la pregunta pre-registrada es "¿difiere?", no "¿es menor?". Elegir una cola después de ver el lado duplicaría la significancia gratis.',
    tasa_calentamiento: calor.tasa_beats,
    tasa_enfriamiento: frio.tasa_beats,
  };

  // ── El veredicto, con los tres requisitos del pre-registro ──
  const cumpleDif = difPP !== null && Math.abs(difPP) >= criterios.min_diferencia_pp;
  const cumpleP = test.p_valor !== null && test.p_valor < criterios.max_p_valor;
  const cumpleN = frio.n >= criterios.min_por_tercil && calor.n >= criterios.min_por_tercil;
  const veredicto = (cumpleDif && cumpleP && cumpleN) ? 'GO' : 'NO-GO';

  const porque = [
    `Muestra: ${evaluados.length} eventos con ventana válida (candado ${criterios.min_eventos}) ✓`,
    `Diferencia entre terciles extremos: ${difPP} pp (umbral ${criterios.min_diferencia_pp}) ${cumpleDif ? '✓' : '✗'} — ${comparacion.direccion}.`,
    `p-valor a dos colas: ${comparacion.p_valor} (umbral < ${criterios.max_p_valor}) ${cumpleP ? '✓' : '✗'}`,
    `Eventos por tercil extremo: enfriamiento ${frio.n}, calentamiento ${calor.n} (mínimo ${criterios.min_por_tercil}) ${cumpleN ? '✓' : '✗'}`,
    `Baseline: la tasa base del universo es ${criterios.tasa_base_universo}; en esta muestra es ${muestra.tasa_beats_en_muestra}. `
      + `El tercil frío quedó en ${frio.tasa_beats} y el caliente en ${calor.tasa_beats}.`,
  ];
  if (!cumpleN) {
    // La distinción importa y no la hace el criterio: el criterio pre-registrado
    // dice NO-GO, y así queda. Pero un tercil chico es falta de evidencia, no
    // evidencia de que no haya nada, y eso se dice.
    porque.push('NO-GO por TAMAÑO de tercil, que no es lo mismo que "no hay señal": con terciles así de chicos no hay con qué verlo.');
  }
  if (veredicto === 'NO-GO' && cumpleN && !cumpleDif && cumpleP) {
    porque.push('La diferencia es estadísticamente distinguible de cero pero MÁS CHICA que el umbral pre-registrado: significativa y sin tamaño útil son cosas distintas.');
  }

  return { criterios, muestra, cortes_terciles: cortes.map((c) => +c.toFixed(4)),
    terciles: grupos, comparacion, veredicto, porque, advertencia: ADVERTENCIA,
    eventos: evaluados };
}

function motivosDeDescarte(descartes) {
  const total = Object.values(descartes || {}).reduce((a, b) => a + b, 0);
  if (!total) return [];
  const partes = Object.entries(descartes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`);
  return [`Se descartaron ${total} eventos por no tener ventana válida — ${partes.join(' · ')}.`];
}

// La advertencia que el encargo pidió dejar escrita. No depende del resultado:
// va en GO, en NO-GO y en INCONCLUSO.
const ADVERTENCIA = 'Aunque salga GO, esto es INFORMACIÓN PÚBLICA que el mercado ya ve: las notas de los analistas se publican. No implica ventaja contra Polymarket — esa pregunta ya se corrió y salió NO-GO (Fase 2 del earnings-beat). Sería un feature descriptivo, no una señal de apuesta.';

// ─────────────────── resumen en español ───────────────────

function renderGradesMd(a) {
  const c = a.criterios || CRITERIOS_GRADES;
  const L = [];
  L.push('# ¿El enfriamiento de los analistas predice beat/miss?');
  L.push('');
  L.push(`Generado: ${a.generado_en || '—'} · backtest **pre-registrado**`);
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
  L.push(`Eventos de entrada: **${m.eventos_de_entrada}** · con ventana válida: **${m.con_ventana_valida}** (candado ${c.min_eventos})`);
  L.push(`Tasa de beats en la muestra: **${m.tasa_beats_en_muestra ?? '—'}** · tasa base del universo: ${c.tasa_base_universo}`);
  if (m.descartes && Object.keys(m.descartes).length) {
    L.push('');
    L.push('| Motivo de descarte | Eventos |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(m.descartes).sort((x, y) => y[1] - x[1])) L.push(`| ${k} | ${v} |`);
  }
  L.push('');

  if (a.terciles) {
    L.push('## Por tercil de cambio de sentimiento (T-3 → T-1)');
    L.push('');
    L.push('| Tercil | n | delta mediano | rango de delta | beats | tasa de beats |');
    L.push('|---|---|---|---|---|---|');
    for (const t of a.terciles) {
      const marca = t.muestra_insuficiente ? ' ⚠' : '';
      L.push(`| ${t.nombre}${marca} | ${t.n} | ${t.delta_mediano ?? '—'} | ${t.delta_min ?? '—'} … ${t.delta_max ?? '—'} | ${t.beats} | ${t.tasa_beats ?? '—'} |`);
    }
    L.push('');
    L.push(`⚠ = menos de ${c.min_por_tercil} eventos: el criterio pre-registrado lo cuenta como NO-GO, y eso es falta de evidencia, no evidencia de que no haya nada.`);
    L.push('');
  }

  const cmp = a.comparacion;
  if (cmp) {
    L.push('## La comparación');
    L.push('');
    L.push(`Diferencia (${cmp.entre}): **${cmp.diferencia_pp} pp** — ${cmp.direccion}`);
    L.push(`z = ${cmp.z} · p-valor (2 colas) = **${cmp.p_valor}**`);
    L.push('');
    L.push(`> ${cmp.nota_colas}`);
    L.push('');
  }

  L.push('## Los criterios, congelados ANTES de correr');
  L.push('');
  L.push('| Criterio | Valor |');
  L.push('|---|---|');
  L.push(`| score | (2·strongBuy + buy − sell − 2·strongSell) / total_analistas |`);
  L.push(`| ventana | mes T-3 → mes T-1, con fecha **estrictamente anterior** al reporte |`);
  L.push(`| T-1 no más viejo que | ${c.max_dias_t1} días |`);
  L.push(`| ventana T-1↔T-3 entre | ${c.min_dias_ventana} y ${c.max_dias_ventana} días |`);
  L.push(`| meses de grades previos | ≥ ${c.min_meses_grades} |`);
  L.push(`| eventos mínimos | ${c.min_eventos} (por debajo: INCONCLUSO) |`);
  L.push(`| eventos por tercil | ≥ ${c.min_por_tercil} |`);
  L.push(`| diferencia para GO | ≥ ${c.min_diferencia_pp} pp entre terciles extremos |`);
  L.push(`| p-valor para GO | < ${c.max_p_valor} (dos colas) |`);
  L.push(`| baseline | tasa base del universo = ${c.tasa_base_universo} |`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('El pre-registro está en `docs/grades-backtest-scope.md` y los umbrales viven en `CRITERIOS_GRADES` (`api/_lib/grades-backtest.js`), pineados por test: mover una portería rompe un test y se ve en el diff. **El veredicto lo lee quien abre esta página; el endpoint no se auto-aprueba.**');
  return L.join('\n');
}

export {
  CRITERIOS_GRADES, scoreSentimiento, seleccionaVentana, terciles, tercilDe,
  NOMBRE_TERCIL, testProporciones, erf, normalCDF, diasEntre, dia,
  analizaGrades, ADVERTENCIA, renderGradesMd,
};
