// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-analiza.test.mjs — R6: la ficha de ticker.
//
// LO QUE SE FIJA ACÁ es que ningún número salga sin decir de dónde viene y
// que ninguno salga cuando no se puede sostener. Las tres que más importan:
//
//   · RENDIMIENTO DE PRECIO ≠ RENDIMIENTO TOTAL. Sin cierre ajustado el
//     número es de precio y la fila lo dice. Llamarle "total" a un número
//     sin dividendos es un error que NO se nota.
//   · CADA TRIMESTRE CITA SU FILING. Un número de estados financieros sin
//     el 10-Q del que salió no se puede auditar, y auditarlo es justo lo
//     que alguien va a querer hacer.
//   · LO DE PAGO SE DECLARA. El precio objetivo ausente va punteado con su
//     causa; nunca el precio actual disfrazado de objetivo.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dato, serieDeRendimiento, upaRealVsEstimado, trimestresDeCompanyFacts,
  linkDeFiling, recomendaciones, precioObjetivo, tablaValuacion, netoInsiders, DE_PAGO,
} from '../api/_lib/analiza.js';

// ── CADA DATO CON SU FUENTE ──────────────────────────────────────────
test('un dato sin valor trae su causa y NINGUNA fuente', () => {
  const d = dato(null, 'yahoo');
  assert.equal(d.valor, null);
  assert.equal(d.fuente, null, 'una fuente sin dato haría pensar que el dato existe');
  assert.match(d.motivo, /no devolvió/);
});

test('y con valor trae la fuente y ningún motivo', () => {
  const d = dato(12.5, 'yahoo:quoteSummary');
  assert.equal(d.valor, 12.5);
  assert.equal(d.fuente, 'yahoo:quoteSummary');
  assert.equal(d.motivo, null);
});

// ── RENDIMIENTO ──────────────────────────────────────────────────────
test('con cierre AJUSTADO el rendimiento es TOTAL y lo dice', () => {
  const r = serieDeRendimiento([
    { time: 1, close: 10, adjclose: 9.8 }, { time: 2, close: 11, adjclose: 10.9 },
  ]);
  assert.equal(r.clase, 'total');
  assert.match(r.nota, /ajustado por dividendos/);
  assert.deepEqual(r.serie.map((p) => p.c), [9.8, 10.9], 'usa el ajustado, no el cierre');
});

test('sin cierre ajustado es rendimiento de PRECIO, y lo dice', () => {
  const r = serieDeRendimiento([{ time: 1, close: 10 }, { time: 2, close: 11 }]);
  assert.equal(r.clase, 'precio');
  assert.match(r.nota, /sin dividendos/);
});

test('con un solo punto no hay rendimiento de ninguna clase', () => {
  const r = serieDeRendimiento([{ time: 1, close: 10 }]);
  assert.equal(r.clase, null);
  assert.match(r.motivo, /1 cierre/);
});

// ── UPA ──────────────────────────────────────────────────────────────
const UPA = [
  { date: '2026-07-30', quarter: 2, year: 2026, eps_actual: 1.26, eps_est: 1.20 },
  { date: '2026-04-30', quarter: 1, year: 2026, eps_actual: 1.10, eps_est: 1.15 },
  { date: '2026-01-29', quarter: 4, year: 2025, eps_actual: 1.40, eps_est: 1.33 },
  // Sin estimado: la fuente no lo trae para ese trimestre.
  { date: '2025-10-29', quarter: 3, year: 2025, eps_actual: 0.98, eps_est: null },
  // Todavía no reporta.
  { date: '2026-10-29', quarter: 3, year: 2026, eps_actual: null, eps_est: 1.31 },
];

test('"le ganó" es real menos estimado, y se dice que es contra el consenso', () => {
  const r = upaRealVsEstimado(UPA);
  const t2 = r.filas.find((f) => f.fecha === '2026-07-30');
  assert.ok(Math.abs(t2.sorpresa - 0.06) < 1e-9, String(t2.sorpresa));
  assert.match(r.nota, /CONSENSO/);
  assert.match(r.nota, /no contra el movimiento de la acción/);
});

// ── EL TRIMESTRE SE NOMBRA POR SU FECHA DE CIERRE ────────────────────
//
// En producción la tabla de NVDA enseñaba "2027 T2" y "2026 T2" con el mismo
// real y el mismo estimado (Lety, 2026-10-21). NVDA cierra su ejercicio en
// enero, así que su año fiscal va adelantado: el trimestre que termina en
// julio de 2026 es el T2 del fiscal 2027. Con unas filas rotuladas por año
// fiscal y otras por calendario, el mismo trimestre salía dos veces.
test('el trimestre se rotula con su fecha de cierre, no con el año fiscal', () => {
  const r = upaRealVsEstimado(UPA);
  const t2 = r.filas.find((f) => f.fecha === '2026-07-30');
  assert.equal(t2.trimestre, '2026-07-30', 'el rótulo es la fecha de cierre');
  // El nombre fiscal se conserva, pero DICHO como fiscal: es el que usa la
  // empresa en su reporte y no se puede confundir con el calendario.
  assert.equal(t2.trimestre_fiscal, 'T2 del fiscal 2026');
});

test('el mismo trimestre con año fiscal y calendario se cuenta UNA vez', () => {
  // El caso exacto de NVDA: dos filas del trimestre que cerró el 27 de julio,
  // una rotulada fiscal 2027 y otra calendario 2026.
  const r = upaRealVsEstimado([
    { period: '2026-07-27', year: 2027, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
    { period: '2026-07-27', year: 2026, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
    { period: '2026-04-27', year: 2027, quarter: 1, eps_actual: 1.96, eps_estimate: 1.90 },
  ]);
  assert.equal(r.filas.length, 2, 'dos trimestres, no tres');
  assert.equal(r.duplicados, 1);
  assert.match(r.motivo_duplicados, /año fiscal y el calendario/);
  // Y la tasa NO cuenta el repetido: con el duplicado dentro decía "2 de 3".
  assert.equal(r.medidos, 2);
});

test('y también cuando el duplicado viene con la fecha corrida unos días', () => {
  // La otra forma del mismo defecto: el cierre contable y el del calendario
  // difieren en días. Un trimestre dura ~91, así que dos filas a menos de 45
  // son la misma.
  const r = upaRealVsEstimado([
    { period: '2026-07-27', year: 2027, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
    { period: '2026-07-31', year: 2026, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.duplicados, 1);
});

test('dos trimestres de verdad NO se colapsan', () => {
  // La prueba que impide que el arreglo se pase de listo: 91 días de
  // distancia son dos trimestres distintos y los dos tienen que quedar.
  const r = upaRealVsEstimado([
    { period: '2026-07-27', year: 2027, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
    { period: '2026-04-27', year: 2027, quarter: 1, eps_actual: 1.96, eps_estimate: 1.90 },
  ]);
  assert.equal(r.filas.length, 2);
  assert.equal(r.duplicados, 0);
  assert.equal(r.motivo_duplicados, null);
});

test('al juntar dos filas gana la que trae el real ya publicado', () => {
  const r = upaRealVsEstimado([
    { period: '2026-07-27', year: 2027, quarter: 2, eps_actual: null, eps_estimate: 2.14 },
    { period: '2026-07-29', year: 2026, quarter: 2, eps_actual: 2.22, eps_estimate: 2.14 },
  ]);
  assert.equal(r.filas.length, 1);
  assert.equal(r.filas[0].real, 2.22, 'el real publicado dice más que el estimado solo');
});

test('un trimestre sin estimado NO se descarta: se muestra con su causa', () => {
  // Descartarlo haría que la tasa de aciertos se calcule sobre los
  // trimestres que convienen.
  const r = upaRealVsEstimado(UPA);
  const sin = r.filas.find((f) => f.fecha === '2025-10-29');
  assert.ok(sin, 'la fila sigue ahí');
  assert.equal(sin.sorpresa, null);
  assert.match(sin.sorpresa_motivo, /no trae estimado/);
});

test('el que todavía no reporta se distingue del que no tiene estimado', () => {
  const r = upaRealVsEstimado(UPA);
  const futuro = r.filas.find((f) => f.fecha === '2026-10-29');
  assert.match(futuro.sorpresa_motivo, /todavía no reporta/);
});

test('la tasa se calcula SÓLO sobre los que tienen las dos cifras, y dice cuántos', () => {
  const r = upaRealVsEstimado(UPA);
  assert.equal(r.medidos, 3, '3 de 5 tienen real y estimado');
  assert.equal(r.gano, 2, 'T2 2026 y T4 2025');
});

// ── EDGAR ────────────────────────────────────────────────────────────
const FACTS = {
  cik: 320193,
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [
          { start: '2026-04-01', end: '2026-06-30', val: 1000, accn: '0000320193-26-000070', form: '10-Q', filed: '2026-08-01', fy: 2026, fp: 'Q3' },
          { start: '2026-01-01', end: '2026-03-31', val: 900, accn: '0000320193-26-000050', form: '10-Q', filed: '2026-05-02' },
          // ANUAL: no es un trimestre y no puede entrar.
          { start: '2025-07-01', end: '2026-06-30', val: 3900, accn: '0000320193-26-000090', form: '10-K', filed: '2026-09-01' },
          // Reexpresión del mismo trimestre, presentada DESPUÉS.
          { start: '2026-04-01', end: '2026-06-30', val: 1010, accn: '0000320193-26-000099', form: '10-Q/A', filed: '2026-09-15' },
        ] },
      },
      NetIncomeLoss: {
        units: { USD: [
          { start: '2026-04-01', end: '2026-06-30', val: 250, accn: '0000320193-26-000070', form: '10-Q', filed: '2026-08-01' },
          { start: '2026-01-01', end: '2026-03-31', val: 180, accn: '0000320193-26-000050', form: '10-Q', filed: '2026-05-02' },
        ] },
      },
    },
  },
};

test('cada trimestre cita su filing: accn y forma', () => {
  const r = trimestresDeCompanyFacts(FACTS);
  const q = r.filas.find((f) => f.fin === '2026-03-31');
  assert.equal(q.ingresos, 900);
  assert.equal(q.ingresos_accn, '0000320193-26-000050');
  assert.equal(q.ingresos_form, '10-Q');
  assert.equal(r.fuente, 'edgar:companyfacts');
});

test('el ANUAL no se cuela entre los trimestres', () => {
  // Un periodo de 365 días mezclado con los de 90 produce un pico de cuatro
  // veces el tamaño que parece un trimestre extraordinario.
  const r = trimestresDeCompanyFacts(FACTS);
  assert.ok(r.filas.every((f) => f.ingresos !== 3900), JSON.stringify(r.filas.map((f) => f.ingresos)));
});

test('ante una reexpresión gana el filing MÁS RECIENTE', () => {
  const r = trimestresDeCompanyFacts(FACTS);
  const q = r.filas.find((f) => f.fin === '2026-06-30');
  assert.equal(q.ingresos, 1010, 'el 10-Q/A de septiembre pisa al 10-Q de agosto');
  assert.equal(q.ingresos_form, '10-Q/A');
});

test('el margen sale sólo cuando están ingreso y utilidad', () => {
  const r = trimestresDeCompanyFacts(FACTS);
  const q1 = r.filas.find((f) => f.fin === '2026-03-31');
  assert.ok(Math.abs(q1.margen_pct - 20) < 1e-9, String(q1.margen_pct));
  const q2 = r.filas.find((f) => f.fin === '2026-06-30');
  // El T2 reexpresado tiene ingreso de un filing y utilidad de otro: el
  // margen se calcula igual, pero cada cifra cita SU filing.
  assert.equal(q2.utilidad_accn, '0000320193-26-000070');
  assert.equal(q2.ingresos_accn, '0000320193-26-000099');
});

test('sin conceptos de us-gaap se dice, no se devuelve una tabla vacía muda', () => {
  const r = trimestresDeCompanyFacts({ facts: {} });
  assert.deepEqual(r.filas, []);
  assert.match(r.motivo, /us-gaap/);
});

test('el link al filing se arma con el accn, y sin accn no se inventa', () => {
  const l = linkDeFiling(320193, '0000320193-26-000070');
  assert.match(l, /sec\.gov/);
  assert.match(l, /000032019326000070/);
  assert.match(l, /0000320193-26-000070-index\.htm$/);
  assert.equal(linkDeFiling(320193, null), null);
  assert.equal(linkDeFiling(null, '0000320193-26-000070'), null);
});

// ── ANALISTAS ────────────────────────────────────────────────────────
test('las recomendaciones van en CONTEOS, no en una nota inventada', () => {
  const r = recomendaciones([
    { period: '2026-10-01', strongBuy: 12, buy: 8, hold: 4, sell: 1, strongSell: 0 },
    { period: '2026-09-01', strongBuy: 10, buy: 9, hold: 5, sell: 1, strongSell: 1 },
  ]);
  assert.equal(r.filas[0].periodo, '2026-10-01');
  assert.equal(r.filas[0].total, 25);
  // Una "nota de 1 a 5" sería NUESTRA y se leería como de los analistas.
  assert.ok(!('nota' in r.filas[0]) && !('score' in r.filas[0]));
});

test('el precio objetivo ausente va declarado, no con el precio actual', () => {
  const r = precioObjetivo({});
  assert.equal(r.disponible, false);
  // La causa, DICHA para quien lee la pantalla. Antes decía "el caso NO-GO
  // de la Fase 0.8", que nombra un documento interno nuestro, y "crumb", que
  // es un detalle del protocolo de Yahoo: jerga en pantalla (Lety,
  // 2026-10-20). El hecho es el mismo; ahora se entiende.
  assert.match(r.motivo, /credencial que sólo le da a un navegador/);
  assert.doesNotMatch(r.motivo, /NO-GO|crumb|Fase 0\.\d/);
});

test('y cuando la fuente SÍ lo trae, viene con sus tres niveles y su fuente', () => {
  const r = precioObjetivo({
    targetLowPrice: { raw: 180 }, targetMeanPrice: { raw: 230 },
    targetHighPrice: { raw: 280 }, numberOfAnalystOpinions: { raw: 41 },
  });
  assert.equal(r.disponible, true);
  assert.deepEqual([r.bajo, r.medio, r.alto], [180, 230, 280]);
  assert.equal(r.analistas, 41);
  assert.match(r.fuente, /quoteSummary/);
});

test('la tarjeta de la calificación con nombre de casa está SIEMPRE punteada', () => {
  // El encargo lo fija así: es dato de pago y no se muestra. La prueba
  // existe para que nadie la "complete" con una estimación.
  assert.equal(DE_PAGO.length, 1);
  assert.equal(DE_PAGO[0].id, 'calificacion_casa');
  assert.match(DE_PAGO[0].motivo, /no lo mostramos, es dato de pago/);
});

// ── VALUACIÓN ────────────────────────────────────────────────────────
test('la tabla de valuación trae las doce filas, y las que faltan dicen por qué', () => {
  const t = tablaValuacion({ summaryDetail: { trailingPE: { raw: 28.4 } } });
  assert.equal(t.length, 12);
  const pu = t.find((f) => f.k === 'P/U');
  assert.equal(pu.valor, 28.4);
  assert.match(pu.fuente, /yahoo/);
  const peg = t.find((f) => f.k === 'PEG');
  assert.equal(peg.valor, null);
  assert.match(peg.motivo, /no devolvió/);
});

test('acepta el formato `{raw}` de Yahoo y el número pelado', () => {
  const t = tablaValuacion({ summaryDetail: { trailingPE: 11 }, defaultKeyStatistics: { priceToBook: { raw: 3.2 } } });
  assert.equal(t.find((f) => f.k === 'P/U').valor, 11);
  assert.equal(t.find((f) => f.k === 'P/Valor en libros').valor, 3.2);
});

// ── INSIDERS DEL TICKER ──────────────────────────────────────────────
const HOY = new Date('2026-10-20T00:00:00Z');
test('el neto de 90 días suma compras y resta ventas', () => {
  const r = netoInsiders([
    { transactionDate: '2026-10-01', type: 'BUY', value: 100000 },
    { transactionDate: '2026-09-15', type: 'SELL', value: 40000 },
    { transactionDate: '2026-01-01', type: 'BUY', value: 999999 },   // fuera de ventana
  ], { hoy: HOY });
  assert.equal(r.neto_usd, 60000);
  assert.equal(r.compras, 1);
  assert.equal(r.ventas, 1);
  assert.equal(r.operaciones, 2, 'la de enero queda fuera de los 90 días');
});

test('sin operaciones con valor el neto es null con su causa, no cero', () => {
  const r = netoInsiders([{ transactionDate: '2026-10-01', type: 'AWARD', value: 0 }], { hoy: HOY });
  assert.equal(r.neto_usd, null);
  assert.match(r.motivo, /ninguna operación del periodo declaró valor/);
});

test('y sin operaciones en la ventana se dice eso, que es otra cosa', () => {
  const r = netoInsiders([], { hoy: HOY });
  assert.equal(r.neto_usd, null);
  assert.match(r.motivo, /sin operaciones en los últimos 90 días/);
});

// ═══════════════════════════════════════════════════════════════════════
// EL CONCEPTO DE INGRESOS: "EXISTE" NO ES "SIRVE"
//
// En producción los ingresos de NVDA salían "—" en los ocho trimestres
// mientras la utilidad salía perfecta (Lety, 2026-10-21). La causa: se elegía
// el PRIMER concepto de la lista que existiera en el archivo, y una emisora
// puede tener `RevenueFromContractWithCustomer…` declarado sólo con periodos
// ANUALES y reportar el trimestre bajo `Revenues`.
// ═══════════════════════════════════════════════════════════════════════
const u = (start, end, val, extra = {}) => ({
  start, end, val, accn: '0001045810-26-000' + String(val).slice(0, 3),
  form: '10-Q', filed: end, ...extra,
});

test('si el concepto preferido sólo trae el AÑO, se usa el que sí trae trimestres', () => {
  const facts = { facts: { 'us-gaap': {
    // El preferido existe… y sólo con el ejercicio completo.
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      u('2025-01-27', '2026-01-25', 130_497_000_000, { form: '10-K' }),
    ] } },
    // El trimestre vive acá.
    Revenues: { units: { USD: [
      u('2026-04-28', '2026-07-27', 46_743_000_000),
      u('2026-01-26', '2026-04-27', 44_062_000_000),
    ] } },
    NetIncomeLoss: { units: { USD: [
      u('2026-04-28', '2026-07-27', 26_422_000_000),
      u('2026-01-26', '2026-04-27', 18_775_000_000),
    ] } },
  } } };
  const r = trimestresDeCompanyFacts(facts);
  assert.equal(r.filas.length, 2);
  // Lo que fallaba: los ingresos llegaban.
  assert.equal(r.filas[0].ingresos, 46_743_000_000);
  assert.equal(r.filas[0].ingresos_concepto, 'Revenues');
  assert.equal(r.conceptos.ingresos, 'Revenues');
  // Y el anual NO se coló entre los trimestres.
  assert.ok(!r.filas.some((f) => f.ingresos === 130_497_000_000));
  assert.equal(r.motivo_ingresos, null);
});

test('la grafía más específica gana cuando las dos traen el mismo trimestre', () => {
  // El orden de `CONCEPTOS_INGRESO` no es casual: las grafías específicas van
  // antes que `Revenues`, que es la bolsa grande y puede llevar otras cosas.
  const facts = { facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      u('2026-04-28', '2026-07-27', 46_743_000_000),
    ] } },
    Revenues: { units: { USD: [
      u('2026-04-28', '2026-07-27', 47_900_000_000),
    ] } },
  } } };
  const r = trimestresDeCompanyFacts(facts);
  assert.equal(r.filas[0].ingresos, 46_743_000_000);
  assert.equal(r.filas[0].ingresos_concepto, 'RevenueFromContractWithCustomerExcludingAssessedTax');
});

test('si la emisora cambió de concepto a mitad de la serie, se usan los dos y se DICE', () => {
  const facts = { facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      u('2026-04-28', '2026-07-27', 46_743_000_000),
    ] } },
    Revenues: { units: { USD: [
      u('2025-04-28', '2025-07-27', 30_040_000_000),
    ] } },
  } } };
  const r = trimestresDeCompanyFacts(facts);
  assert.equal(r.filas.length, 2);
  assert.equal(r.conceptos_todos.ingresos.length, 2);
  assert.match(r.motivo_conceptos, /conceptos distintos/);
});

test('con trimestres pero sin NINGÚN ingreso, se dice — y es lo que apaga las barras', () => {
  const facts = { facts: { 'us-gaap': {
    NetIncomeLoss: { units: { USD: [
      u('2026-04-28', '2026-07-27', 26_422_000_000),
      u('2026-01-26', '2026-04-27', 18_775_000_000),
    ] } },
  } } };
  const r = trimestresDeCompanyFacts(facts);
  assert.equal(r.filas.length, 2);
  assert.ok(r.filas.every((f) => f.ingresos == null));
  // La causa separada: "no hay trimestres" y "hay trimestres sin ingresos"
  // son dos problemas distintos, y el segundo es el que dejó ocho barras
  // iguales en pantalla.
  assert.match(r.motivo_ingresos, /no trae ingresos trimestrales/);
  assert.equal(r.motivo, null, 'trimestres sí hay');
});

test('el concepto que existe pero sólo con periodos anuales se declara como tal', () => {
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [u('2025-01-27', '2026-01-25', 130_497_000_000, { form: '10-K' })] } },
  } } };
  const r = trimestresDeCompanyFacts(facts);
  assert.equal(r.filas.length, 0);
  assert.match(r.motivo, /ninguno con periodos trimestrales/);
});
