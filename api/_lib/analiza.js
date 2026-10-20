// ═══════════════════════════════════════════════════════════════════════
// api/_lib/analiza.js — R6: la aritmética y las lecturas de `/analiza/:ticker`.
//
// PURO: entran payloads crudos, salen bloques listos para pintar. Ni red ni
// reloj (salvo el que se le pasa). Es lo que permite probar "la fila cita su
// 10-Q" sin llamar a la SEC.
//
// LAS TRES REGLAS QUE ESTE ARCHIVO EXISTE PARA CUMPLIR:
//
//   1. CADA NÚMERO DICE SU FUENTE (regla 3). Por eso ningún bloque devuelve
//      un número pelado: todos devuelven `{ valor, fuente, motivo }`. Una
//      fila sin fuente no se puede revisar, y lo que no se puede revisar no
//      se puede corregir.
//   2. LO QUE ES DE PAGO SE DECLARA, no se estima. El precio objetivo y la
//      calificación con nombre de casa salen como paneles punteados con su
//      causa — nunca con un número "aproximado".
//   3. RENDIMIENTO DE PRECIO ≠ RENDIMIENTO TOTAL. Si la fuente no devuelve
//      el cierre AJUSTADO, el número que sale es de precio y la fila lo
//      dice. Llamarle "rendimiento total" a un número sin dividendos es
//      exactamente la clase de error que no se nota.
// ═══════════════════════════════════════════════════════════════════════

// `Number(null)` es CERO, no NaN. Es la trampa más cara de este repo: con el
// guardia ingenuo, un estimado de consenso ausente se volvía 0 y la sorpresa
// salía como "le ganó por 0.98" — un número inventado con dos datos reales.
// Lo encontró la prueba del trimestre sin estimado, que estaba escrita antes
// que el arreglo.
// Las grafías de los campos de Finnhub viven en un solo sitio del proyecto:
// el censo de la Fase 0 ya tuvo que resolver que Finnhub mezcla sufijos
// (TTM / Annual / Quarterly) y no documenta cuáles trae el tier gratis.
import { CAMPOS_METRIC } from './mercado-fase0.js';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Un dato con su procedencia. El `motivo` es obligatorio cuando falta. */
export function dato(valor, fuente, motivo = null) {
  return valor == null || valor === ''
    ? { valor: null, fuente: null, motivo: motivo || 'la fuente no devolvió este campo' }
    : { valor, fuente, motivo: null };
}

/**
 * LA SERIE PARA EL RENDIMIENTO, y qué clase de rendimiento permite.
 *
 * Yahoo devuelve `adjclose` sólo cuando se le pide, y no siempre. Con el
 * cierre ajustado el rendimiento INCLUYE dividendos (rendimiento total); sin
 * él es rendimiento de PRECIO. Las dos cosas son válidas y NO son la misma,
 * así que la clase viaja con la serie y la pantalla la dice.
 */
export function serieDeRendimiento(velas) {
  const vs = Array.isArray(velas) ? velas : [];
  const conAjuste = vs.filter((v) => Number.isFinite(v.adjclose));
  if (conAjuste.length >= 2) {
    return {
      serie: conAjuste.map((v) => ({ t: v.time ?? v.t, c: v.adjclose })),
      clase: 'total',
      nota: 'rendimiento total: cierre ajustado por dividendos y splits',
      fuente: 'yahoo:v8/chart (adjclose)',
    };
  }
  const cierres = vs.map((v) => ({ t: v.time ?? v.t, c: num(v.close ?? v.c) }))
    .filter((p) => Number.isFinite(p.c));
  return {
    serie: cierres,
    clase: cierres.length >= 2 ? 'precio' : null,
    nota: cierres.length >= 2
      ? 'rendimiento de PRECIO, sin dividendos: la fuente no devolvió el cierre ajustado'
      : null,
    fuente: 'yahoo:v8/chart (close)',
    motivo: cierres.length >= 2 ? null : `la serie trae ${cierres.length} cierre(s)`,
  };
}

/**
 * UPA REAL CONTRA ESTIMADO, por trimestre.
 *
 * "Le ganó +0.06" es real − estimado, y es una diferencia contra el CONSENSO
 * — no significa que la acción haya subido. El pie de la pantalla lo dice y
 * acá se devuelve el campo con ese nombre para que no se confunda.
 *
 * Un trimestre sin estimado NO se descarta: se muestra con la sorpresa en
 * null y su causa. Descartarlo haría que la tasa de aciertos se calculara
 * sobre los trimestres que convienen.
 */
export function upaRealVsEstimado(filas, { tope = 8, motivoFuente = null } = {}) {
  // ── LOS NOMBRES SON LOS DE `/api/earnings` ──────────────────────────
  // Ese endpoint manda `period` y `eps_estimate`; esta función pedía `date` y
  // `eps_est`, y el resultado era un bloque vacío sobre un historial completo.
  // Se aceptan los dos nombres —no cuesta nada y hay fixtures viejos— pero el
  // que manda es el del productor.
  const crudas = (filas || [])
    .filter((e) => e && (e.eps_actual != null || e.eps_estimate != null || e.eps_est != null))
    .map((e) => {
      const real = num(e.eps_actual);
      const est = num(e.eps_estimate != null ? e.eps_estimate : e.eps_est);
      const fecha = e.period || e.date || null;
      return {
        fecha,
        // EL TRIMESTRE SE NOMBRA POR SU FECHA DE CIERRE, NO POR SU AÑO FISCAL.
        //
        // En producción la tabla de NVDA enseñaba "2027 T2" y "2026 T2" con el
        // mismo real y el mismo estimado (Lety, 2026-10-21). NVDA cierra su
        // ejercicio en enero, así que su año fiscal va ADELANTADO: el trimestre
        // que termina en julio de 2026 es el T2 del fiscal 2027. Cuando la
        // fuente manda unas filas con el año fiscal y otras con el calendario,
        // el MISMO trimestre sale dos veces con dos nombres, y el lector no
        // tiene forma de saber que es uno solo.
        //
        // La fecha de cierre no tiene esa ambigüedad: es un hecho del filing.
        // El nombre fiscal se conserva aparte —es el que usa la empresa en su
        // reporte— pero rotulado como fiscal, no como si fuera el calendario.
        trimestre: fecha,
        trimestre_fiscal: e.quarter != null && e.year != null ? `T${e.quarter} del fiscal ${e.year}` : null,
        real, estimado: est,
        sorpresa: real != null && est != null ? real - est : null,
        sorpresa_motivo: real != null && est != null ? null
          : (real == null ? 'todavía no reporta' : 'la fuente no trae estimado de consenso para ese trimestre'),
      };
    })
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));

  // ── UN TRIMESTRE, UNA FILA ──────────────────────────────────────────
  // Dos defensas, porque el duplicado puede llegar de dos formas: la misma
  // fecha de cierre repetida, o dos fechas a pocos días una de otra —el mismo
  // trimestre fechado al cierre contable y al cierre del calendario—. Un
  // trimestre dura ~91 días, así que dos filas a menos de 45 son la misma.
  const DIAS_MISMO_TRIMESTRE = 45;
  const unicas = [];
  let duplicados = 0;
  for (const f of crudas) {
    const t = Date.parse(f.fecha || '');
    const ya = unicas.find((u) => {
      if (u.fecha === f.fecha) return true;
      const tu = Date.parse(u.fecha || '');
      return Number.isFinite(t) && Number.isFinite(tu)
        && Math.abs(t - tu) / 864e5 < DIAS_MISMO_TRIMESTRE;
    });
    if (!ya) { unicas.push(f); continue; }
    duplicados++;
    // Gana la fila más completa: una con el real ya publicado dice más que
    // una que todavía sólo trae el estimado.
    if (ya.real == null && f.real != null) Object.assign(ya, f);
    // Y si la descartada traía el nombre fiscal, se conserva.
    if (!ya.trimestre_fiscal && f.trimestre_fiscal) ya.trimestre_fiscal = f.trimestre_fiscal;
  }

  const fs = unicas.slice(0, tope);
  const conSorpresa = fs.filter((f) => f.sorpresa != null);
  return {
    filas: fs,
    // La tasa se calcula SÓLO sobre los que tienen las dos cifras, y se dice
    // sobre cuántos: "4 de 4" y "4 de 8" no son la misma afirmación.
    gano: conSorpresa.filter((f) => f.sorpresa > 0).length,
    medidos: conSorpresa.length,
    duplicados,
    // Si hubo que juntar filas, se dice: un conteo que cambió en silencio es
    // un conteo en el que no se puede confiar.
    motivo_duplicados: duplicados
      ? `la fuente mandó ${duplicados} fila(s) repetida(s) del mismo trimestre, con el año fiscal y el calendario mezclados; se cuenta una vez`
      : null,
    fuente: 'finnhub:earnings',
    nota: 'la sorpresa es contra el CONSENSO de analistas, no contra el movimiento de la acción',
    // Y si no hay trimestres, se dice POR QUÉ: "la fuente no devolvió" tapa
    // por igual un ticker sin cobertura y una llave mal leída.
    motivo: fs.length ? null
      : (motivoFuente || 'la fuente no devolvió trimestres con UPA para este ticker'),
  };
}

const CONCEPTOS_INGRESO = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
];
const CONCEPTOS_UTILIDAD = ['NetIncomeLoss', 'ProfitLoss'];

/**
 * INGRESOS Y UTILIDAD POR TRIMESTRE, CITANDO SU FILING.
 *
 * El encargo lo pide explícito: "cada barra cita su 10-Q/10-K". Por eso cada
 * fila lleva `accn` y `form`, y la pantalla arma el link a EDGAR. Un número
 * de estados financieros sin el filing del que salió no se puede auditar, y
 * auditarlo es justo lo que alguien va a querer hacer con él.
 *
 * SÓLO TRIMESTRES: se toman los hechos con un periodo de ~90 días. Los
 * anuales (~365) mezclados con trimestrales dan una serie con picos de cuatro
 * veces el tamaño que parecen un trimestre extraordinario.
 */
export function trimestresDeCompanyFacts(facts, { tope = 8 } = {}) {
  const conceptos = (facts && facts.facts && facts.facts['us-gaap']) || null;
  if (!conceptos) {
    return { filas: [], motivo: 'EDGAR no devolvió conceptos us-gaap para esta emisora', fuente: 'edgar:companyfacts' };
  }
  const esTrimestre = (u) => {
    if (!u.start || !u.end) return false;
    const d = (Date.parse(u.end) - Date.parse(u.start)) / 864e5;
    return d > 60 && d < 120;
  };

  // ── EL CONCEPTO SE ELIGE POR LO QUE TRAE, NO POR EXISTIR ────────────
  //
  // Esto era "el primer concepto de la lista que exista en el archivo", y en
  // producción dejó los ingresos de NVDA en "—" en los ocho trimestres
  // mientras la utilidad salía perfecta (Lety, 2026-10-21).
  //
  // La causa: una emisora puede tener `RevenueFromContractWithCustomer…`
  // declarado SÓLO con periodos anuales y reportar el trimestre bajo
  // `Revenues`. El primero existía, así que ganaba, y no tenía ni un periodo
  // trimestral que ofrecer. "Existe" y "sirve" no son lo mismo.
  //
  // Y hay un segundo caso, igual de real: la emisora CAMBIA de concepto de un
  // año a otro (la taxonomía us-gaap se mueve). Por eso no se elige uno y se
  // descarta el resto: se recorren todos los candidatos y cada trimestre toma
  // el del candidato de MAYOR prioridad que lo tenga. La prioridad es el orden
  // de la lista, que no es casual: las grafías específicas van antes que
  // `Revenues`, que es la bolsa grande.
  const trimestresDe = (nombres) => {
    const out = [];
    nombres.forEach((n, prioridad) => {
      const c = conceptos[n];
      const uds = c && c.units && (c.units.USD || Object.values(c.units)[0]);
      if (!Array.isArray(uds)) return;
      for (const u of uds) if (esTrimestre(u)) out.push({ ...u, _concepto: n, _prioridad: prioridad });
    });
    return out;
  };
  const ing = trimestresDe(CONCEPTOS_INGRESO);
  const uti = trimestresDe(CONCEPTOS_UTILIDAD);
  if (!ing.length && !uti.length) {
    // Se distingue "no está el concepto" de "está y no trae trimestres":
    // son dos problemas distintos y se arreglan distinto.
    const hayAlguno = [...CONCEPTOS_INGRESO, ...CONCEPTOS_UTILIDAD].some((n) => conceptos[n]);
    return {
      filas: [],
      motivo: hayAlguno
        ? 'EDGAR trae los conceptos de ingresos y utilidad, pero ninguno con periodos trimestrales (sólo anuales)'
        : `EDGAR no trae ninguno de los conceptos de ingresos (${CONCEPTOS_INGRESO[0]}…) ni de utilidad (${CONCEPTOS_UTILIDAD[0]})`,
      fuente: 'edgar:companyfacts',
    };
  }
  const porFin = new Map();
  const mete = (lista, campo) => {
    for (const u of lista || []) {
      const k = u.end;
      if (!porFin.has(k)) porFin.set(k, { fin: k, inicio: u.start });
      const f = porFin.get(k);
      const yaHay = f[campo] != null;
      // Entre dos candidatos, manda el de MAYOR prioridad (la grafía más
      // específica). Dentro del mismo concepto, cuando el trimestre aparece
      // varias veces por una reexpresión, gana el filing MÁS RECIENTE: es el
      // que la emisora sostiene hoy.
      const mejorPorConcepto = yaHay && u._prioridad < f[campo + '_prioridad'];
      const mejorPorFecha = yaHay && u._prioridad === f[campo + '_prioridad']
        && String(u.filed || '') > String(f[campo + '_filed'] || '');
      if (!yaHay || mejorPorConcepto || mejorPorFecha) {
        f[campo] = num(u.val);
        f[campo + '_accn'] = u.accn || null;
        f[campo + '_form'] = u.form || null;
        f[campo + '_filed'] = u.filed || null;
        f[campo + '_concepto'] = u._concepto;
        f[campo + '_prioridad'] = u._prioridad;
      }
    }
  };
  mete(ing, 'ingresos');
  mete(uti, 'utilidad');

  const filas = [...porFin.values()]
    .sort((a, b) => String(b.fin).localeCompare(String(a.fin)))
    .slice(0, tope)
    .map((f) => ({
      ...f,
      // El margen SÓLO cuando están los dos y el ingreso no es cero.
      margen_pct: Number.isFinite(f.ingresos) && Number.isFinite(f.utilidad) && f.ingresos !== 0
        ? (f.utilidad / f.ingresos) * 100 : null,
      margen_motivo: Number.isFinite(f.ingresos) && Number.isFinite(f.utilidad) && f.ingresos !== 0
        ? null : 'falta el ingreso o la utilidad del trimestre',
    }));
  // Qué concepto terminó dando cada número. Si la emisora cambió de grafía a
  // mitad de la serie, se usan dos y se DICE: son el mismo dato económico,
  // pero decir que salieron del mismo campo cuando no es cierto rompe la
  // regla 3 —y además explica un escalón que si no parecería del negocio.
  const usados = (campo) => [...new Set(filas.map((f) => f[campo + '_concepto']).filter(Boolean))];
  const ingUsados = usados('ingresos');
  const utiUsados = usados('utilidad');
  return {
    filas,
    fuente: 'edgar:companyfacts',
    conceptos: { ingresos: ingUsados[0] || null, utilidad: utiUsados[0] || null },
    conceptos_todos: { ingresos: ingUsados, utilidad: utiUsados },
    motivo_conceptos: ingUsados.length > 1
      ? `la emisora reportó los ingresos bajo ${ingUsados.length} conceptos distintos de us-gaap en el periodo mostrado`
      : null,
    // Qué faltó, dicho por separado: "no hay trimestres" y "hay trimestres sin
    // ingresos" son dos cosas distintas, y la segunda es la que dejó ocho
    // barras iguales en pantalla.
    motivo: filas.length ? null : 'EDGAR trae los conceptos pero ningún periodo trimestral',
    motivo_ingresos: filas.length && !filas.some((f) => Number.isFinite(f.ingresos))
      ? 'EDGAR no trae ingresos trimestrales para esta emisora bajo ninguno de los conceptos conocidos'
      : null,
  };
}

/** El link al filing que sostiene una cifra. Sin `accn` no se inventa uno. */
export function linkDeFiling(cik, accn) {
  if (!cik || !accn) return null;
  const limpio = String(accn).replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, '')}/${limpio}/${accn}-index.htm`;
}

/**
 * LAS RECOMENDACIONES DE ANALISTAS, por mes.
 *
 * Finnhub free las da en conteos (strongBuy/buy/hold/sell/strongSell). NO se
 * convierten a una "nota" de 1 a 5: esa nota sería nuestra, no de los
 * analistas, y se leería como un dato de ellos.
 */
export function recomendaciones(filas, { tope = 6 } = {}) {
  const fs = (filas || []).filter((r) => r && r.period)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))
    .slice(0, tope)
    .map((r) => ({
      periodo: r.period,
      compra_fuerte: num(r.strongBuy) || 0,
      compra: num(r.buy) || 0,
      mantener: num(r.hold) || 0,
      venta: num(r.sell) || 0,
      venta_fuerte: num(r.strongSell) || 0,
      total: ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((s, k) => s + (num(r[k]) || 0), 0),
    }));
  return {
    filas: fs,
    fuente: 'finnhub:recommendation',
    motivo: fs.length ? null : 'la fuente no devolvió recomendaciones para este ticker',
  };
}

/**
 * LO QUE NO MOSTRAMOS PORQUE ES DE PAGO, declarado.
 *
 * El encargo lo fija: la tarjeta de "última calificación con nombre de casa"
 * va SIEMPRE punteada, y el precio objetivo sólo si la Fase 0.8 dio GO. Un
 * panel punteado que dice "esto es de pago" es información; un número
 * inventado con cara de consenso es una mentira cara.
 */
export const DE_PAGO = [
  {
    id: 'calificacion_casa',
    titulo: 'Última calificación, con el nombre de la casa',
    motivo: 'no lo mostramos, es dato de pago',
    detalle: 'Finnhub cobra el feed de upgrades/downgrades con el nombre de la casa de bolsa. Lo que sí está es el conteo mensual de recomendaciones, abajo.',
  },
];

/**
 * El precio objetivo, SÓLO si la fuente lo trajo de verdad.
 *
 * Yahoo `financialData` lo trae cuando el crumb funciona desde el servidor.
 * Cuando no, el panel va punteado con su causa — nunca con el precio actual
 * disfrazado de objetivo.
 */
export function precioObjetivo(financialData) {
  const f = financialData || {};
  const bajo = num(f.targetLowPrice && (f.targetLowPrice.raw ?? f.targetLowPrice));
  const alto = num(f.targetHighPrice && (f.targetHighPrice.raw ?? f.targetHighPrice));
  const medio = num(f.targetMeanPrice && (f.targetMeanPrice.raw ?? f.targetMeanPrice));
  if (medio == null && bajo == null && alto == null) {
    return {
      disponible: false,
      // En pantalla, en castellano. "NO-GO de la Fase 0.8" y "crumb" son
      // nuestros: nombran un documento interno y un detalle del protocolo de
      // Yahoo. Lo que necesita saber quien lee es que el número no está y
      // que no es un fallo suyo.
      motivo: 'Yahoo no entregó el precio objetivo: pide una credencial que sólo le da a un navegador, no a un servidor como el nuestro',
    };
  }
  return {
    disponible: true, bajo, medio, alto,
    analistas: num(f.numberOfAnalystOpinions && (f.numberOfAnalystOpinions.raw ?? f.numberOfAnalystOpinions)),
    fuente: 'yahoo:quoteSummary/financialData',
    motivo: null,
  };
}

/**
 * LA TABLA DE VALUACIÓN, con una fila por métrica y su fuente.
 *
 * Lo que la fuente no trae se queda en null CON su causa: una tabla de
 * valuación a la que le faltan filas sin decirlo se lee como si esas métricas
 * no existieran para esta empresa.
 */
export function tablaValuacion(yahoo) {
  const sd = (yahoo && yahoo.summaryDetail) || {};
  const ks = (yahoo && yahoo.defaultKeyStatistics) || {};
  const fd = (yahoo && yahoo.financialData) || {};
  const v = (o, k) => (o && o[k] != null ? num(o[k].raw ?? o[k]) : null);
  const F = 'yahoo:quoteSummary';
  return [
    { k: 'Capitalización', ...dato(v(sd, 'marketCap') ?? v(ks, 'marketCap'), F), formato: 'usd' },
    { k: 'Valor de empresa', ...dato(v(ks, 'enterpriseValue'), F), formato: 'usd' },
    { k: 'P/U', ...dato(v(sd, 'trailingPE'), F), formato: 'x' },
    { k: 'P/U adelantado', ...dato(v(sd, 'forwardPE') ?? v(ks, 'forwardPE'), F), formato: 'x' },
    { k: 'PEG', ...dato(v(ks, 'pegRatio'), F), formato: 'x' },
    { k: 'P/Ventas', ...dato(v(ks, 'priceToSalesTrailing12Months') ?? v(sd, 'priceToSalesTrailing12Months'), F), formato: 'x' },
    { k: 'P/Valor en libros', ...dato(v(ks, 'priceToBook'), F), formato: 'x' },
    { k: 'VE/Ingresos', ...dato(v(ks, 'enterpriseToRevenue'), F), formato: 'x' },
    { k: 'Margen operativo', ...dato(v(fd, 'operatingMargins'), F), formato: 'pct1' },
    { k: 'ROA', ...dato(v(fd, 'returnOnAssets'), F), formato: 'pct1' },
    { k: 'ROE', ...dato(v(fd, 'returnOnEquity'), F), formato: 'pct1' },
    // DOS decimales, no uno: un rendimiento de 0.03% con un decimal se pinta
    // "0.0%", que se lee como "no paga dividendo". Es un número mal por
    // redondeo — el peor tipo, porque parece deliberado.
    { k: 'Dividendo', ...dato(v(sd, 'dividendYield'), F), formato: 'pct2' },
  ];
}

/**
 * LA MISMA TABLA, DESDE FINNHUB, CUANDO YAHOO NO CONTESTA.
 *
 * Lety, 2026-10-20: *"Yahoo `quoteSummary` da 429 … si sigue fallando, que la
 * valuación salga de Finnhub `metric`, que ya usamos en el mapa."*
 *
 * Las grafías de los campos NO se adivinan acá: salen de `CAMPOS_METRIC`, en
 * `mercado-fase0.js`, que ya es la lista candidata del proyecto —Finnhub
 * mezcla sufijos TTM / Annual / Quarterly y no documenta cuáles trae el tier
 * gratis— y gana la primera grafía que exista.
 *
 * DOS TRAMPAS DE UNIDADES, Y LAS DOS SE RESUELVEN EN LA PUERTA:
 *
 *   · Finnhub da la capitalización y el valor de empresa EN MILLONES. Es el
 *     mismo tropiezo que ya costó que Apple midiera lo mismo que una small
 *     cap en el censo del mapa, y está anotado allá.
 *   · Finnhub da los márgenes, ROA, ROE y el dividendo EN POR CIENTO (3.1 =
 *     3.1 %); Yahoo los da en FRACCIÓN (0.031). La pantalla multiplica por
 *     100 porque la convención de adentro es la fracción, así que un número
 *     de Finnhub sin convertir se pintaría 310 %.
 *
 * Cada fila dice que viene de Finnhub: son dos proveedores y pueden no
 * coincidir al segundo decimal, y callar cuál se usó haría imposible
 * explicar por qué un P/U cambió entre dos recargas.
 */
export function tablaValuacionFinnhub(metric) {
  const m = (metric && metric.metric) || metric || null;
  const F = 'finnhub:metric';
  // La primera grafía que exista, como hace el censo.
  const g = (clave) => {
    if (!m) return null;
    const fila = CAMPOS_METRIC.find((c) => c[0] === clave);
    for (const nombre of (fila ? fila[1] : [])) {
      const v = num(m[nombre]);
      if (v != null) return v;
    }
    return null;
  };
  const millones = (v) => (v == null ? null : v * 1e6);
  const deFraccion = (v) => (v == null ? null : v / 100);
  return [
    { k: 'Capitalización', ...dato(millones(g('cap')), F), formato: 'usd' },
    { k: 'Valor de empresa', ...dato(millones(g('ev')), F), formato: 'usd' },
    { k: 'P/U', ...dato(g('pe'), F), formato: 'x' },
    { k: 'P/U adelantado', ...dato(g('pe_fwd'), F), formato: 'x' },
    { k: 'PEG', ...dato(g('peg'), F), formato: 'x' },
    { k: 'P/Ventas', ...dato(g('ps'), F), formato: 'x' },
    { k: 'P/Valor en libros', ...dato(g('pb'), F), formato: 'x' },
    { k: 'VE/Ingresos', ...dato(g('ev_rev'), F), formato: 'x' },
    // `margen` de Finnhub es el margen NETO, no el operativo: se nombra por
    // lo que es. Dos márgenes distintos bajo la misma etiqueta sería un
    // número mal con cara de bueno.
    { k: 'Margen neto', ...dato(deFraccion(g('margen')), F), formato: 'pct1' },
    { k: 'ROA', ...dato(deFraccion(g('roa')), F), formato: 'pct1' },
    { k: 'ROE', ...dato(deFraccion(g('roe')), F), formato: 'pct1' },
    { k: 'Dividendo', ...dato(deFraccion(g('dividendo')), F), formato: 'pct2' },
  ];
}

/** El neto de insiders de los últimos N días, con su conteo. */
export function netoInsiders(transacciones, { dias = 90, hoy = new Date() } = {}) {
  const corte = new Date(hoy.getTime() - dias * 864e5).toISOString().slice(0, 10);
  const dentro = (transacciones || []).filter((t) => String(t.transactionDate || t.filingDate || '') >= corte);
  let neto = 0; let compras = 0; let ventas = 0; let conValor = 0;
  for (const t of dentro) {
    const v = num(t.value);
    if (t.type === 'BUY') compras++;
    if (t.type === 'SELL') ventas++;
    if (v != null && (t.type === 'BUY' || t.type === 'SELL')) { neto += t.type === 'BUY' ? v : -v; conValor++; }
  }
  return {
    dias, compras, ventas, operaciones: dentro.length,
    neto_usd: conValor ? neto : null,
    motivo: conValor ? null : (dentro.length ? 'ninguna operación del periodo declaró valor' : `sin operaciones en los últimos ${dias} días`),
    fuente: 'finnhub:insider-transactions (SEC Form 4)',
  };
}
