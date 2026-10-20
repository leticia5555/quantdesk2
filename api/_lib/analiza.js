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
  // LOS NOMBRES SON LOS DE `/api/earnings`, NO LOS QUE YO SUPUSE.
  // Ese endpoint manda `period` y `eps_estimate`; esta función pedía `date` y
  // `eps_est`, y el resultado era un bloque vacío sobre un historial completo.
  // Se aceptan los dos nombres —no cuesta nada y hay fixtures viejos— pero el
  // que manda es el del productor.
  const fs = (filas || [])
    .filter((e) => e && (e.eps_actual != null || e.eps_estimate != null || e.eps_est != null))
    .map((e) => {
      const real = num(e.eps_actual);
      const est = num(e.eps_estimate != null ? e.eps_estimate : e.eps_est);
      return {
        fecha: e.period || e.date || null,
        trimestre: e.quarter != null && e.year != null ? `${e.year} T${e.quarter}` : null,
        real, estimado: est,
        sorpresa: real != null && est != null ? real - est : null,
        sorpresa_motivo: real != null && est != null ? null
          : (real == null ? 'todavía no reporta' : 'la fuente no trae estimado de consenso para ese trimestre'),
      };
    })
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))
    .slice(0, tope);
  const conSorpresa = fs.filter((f) => f.sorpresa != null);
  return {
    filas: fs,
    // La tasa se calcula SÓLO sobre los que tienen las dos cifras, y se dice
    // sobre cuántos: "4 de 4" y "4 de 8" no son la misma afirmación.
    gano: conSorpresa.filter((f) => f.sorpresa > 0).length,
    medidos: conSorpresa.length,
    fuente: 'finnhub:earnings',
    nota: 'la sorpresa es contra el CONSENSO de analistas, no contra el movimiento de la acción',
    // Y si no hay trimestres, se dice POR QUÉ: "la fuente no devolvió" tapa
    // por igual un ticker sin cobertura y una llave mal leída.
    motivo: fs.length ? null
      : (motivoFuente || 'la fuente no devolvió trimestres con UPA para este ticker'),
  };
}

import { CAMPOS_METRIC } from './mercado-fase0.js';

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
  const tomar = (nombres) => {
    for (const n of nombres) {
      const c = conceptos[n];
      const uds = c && c.units && (c.units.USD || Object.values(c.units)[0]);
      if (Array.isArray(uds) && uds.length) return { concepto: n, filas: uds };
    }
    return null;
  };
  const ing = tomar(CONCEPTOS_INGRESO);
  const uti = tomar(CONCEPTOS_UTILIDAD);
  if (!ing && !uti) {
    return {
      filas: [],
      motivo: `EDGAR no trae ninguno de los conceptos de ingresos (${CONCEPTOS_INGRESO[0]}…) ni de utilidad (${CONCEPTOS_UTILIDAD[0]})`,
      fuente: 'edgar:companyfacts',
    };
  }
  const esTrimestre = (u) => {
    if (!u.start || !u.end) return false;
    const d = (Date.parse(u.end) - Date.parse(u.start)) / 864e5;
    return d > 60 && d < 120;
  };
  const porFin = new Map();
  const mete = (lista, campo, concepto) => {
    for (const u of lista || []) {
      if (!esTrimestre(u)) continue;
      const k = u.end;
      if (!porFin.has(k)) porFin.set(k, { fin: k, inicio: u.start });
      const f = porFin.get(k);
      // Cuando el mismo trimestre aparece varias veces (reexpresiones), gana
      // el filing MÁS RECIENTE: es el que la emisora sostiene hoy.
      if (!f[campo] || String(u.filed || '') > String(f[campo + '_filed'] || '')) {
        f[campo] = num(u.val);
        f[campo + '_accn'] = u.accn || null;
        f[campo + '_form'] = u.form || null;
        f[campo + '_filed'] = u.filed || null;
        f[campo + '_concepto'] = concepto;
      }
    }
  };
  if (ing) mete(ing.filas, 'ingresos', ing.concepto);
  if (uti) mete(uti.filas, 'utilidad', uti.concepto);

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
  return {
    filas,
    fuente: 'edgar:companyfacts',
    conceptos: { ingresos: ing ? ing.concepto : null, utilidad: uti ? uti.concepto : null },
    motivo: filas.length ? null : 'EDGAR trae los conceptos pero ningún periodo trimestral',
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
