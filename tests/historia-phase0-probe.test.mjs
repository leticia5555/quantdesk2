// ═══════════════════════════════════════════════════════════════
// Tests de scripts/historia-phase0-probe.mjs — el MEDIDOR de la Fase 0.
//
// La sonda no puede correr desde este contenedor (egress a sec.gov cerrado,
// ver docs/historia-fase0.md §0). Eso impide ganar los números de EDGAR;
// no impide —ni excusa— probar que el instrumento mide bien. Un medidor sin
// probar que reporta "🟢 VERDE" es exactamente el falso negativo que costó
// dos corridas en la Fase 0 del Congreso.
//
// Cinco cosas se prueban con dientes, todas contra fixtures sintéticos con
// la respuesta PLANTADA:
//
//   1. El aplanado del índice. submissions guarda columnas paralelas; las
//      páginas viejas no traen la columna `items`. Un `undefined` ahí
//      rompería el censo de G2 EN SILENCIO (undefined.trim() tira, y peor,
//      `f.items && …` lo saltea contándolo como "sin item").
//   2. La clasificación de periodos por largo (Q / H1 / 9M / FY).
//   3. El censo de items de 8-K: cobertura, mal formados, conteo por item.
//   4. **La derivación de Q4** — el corazón de G1. Un emisor reporta Q1-Q3
//      en 10-Q y el AÑO en 10-K: Q4 no existe como hecho. Si el medidor no
//      lo deriva (FY − 9M), reporta 9 trimestres donde hay 12 y manda a
//      rojo una compuerta que está verde.
//   5. La unión de alias a través del corte de ASC 606 (Revenues →
//      RevenueFromContractWithCustomer…): una serie que cruza 2018 cambia
//      de tag a mitad de camino y contarla por tag la parte en dos.
//
// Correr con `node tests/historia-phase0-probe.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  FAMILIAS, analizarFamilia, analizarItems8K, aplanarSubmissions,
  clasePeriodo, dias, hechosDe,
} from '../scripts/historia-phase0-probe.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const fam = (id) => FAMILIAS.find((f) => f.id === id);

// ─────────────────────────────────────────────────────────────────
// 1. Aplanado del índice de filings
// ─────────────────────────────────────────────────────────────────
console.log('\n── aplanarSubmissions');
{
  // Página reciente: completa. Página vieja: SIN columna `items` ni
  // `primaryDocument` — así son de verdad las páginas pre-2001 de EDGAR.
  const reciente = {
    accessionNumber: ['0001-24-000002', '0001-24-000001'],
    form: ['8-K', 'def 14a'],
    filingDate: ['2024-03-02', '2024-03-01'],
    reportDate: ['2024-03-01', null],
    items: ['5.02,9.01', ''],
    primaryDocument: ['a.htm', 'b.htm'],
    isXBRL: [1, 0],
    size: [1000, 2000],
  };
  const vieja = {
    accessionNumber: ['0001-99-000001'],
    form: ['10-K'],
    filingDate: ['1999-04-01'],
  };

  const out = aplanarSubmissions([reciente, vieja]);
  eq(out.length, 3, 'aplana las dos páginas');
  eq(out[0].filed, '2024-03-02', 'orden reverse-cron tras concatenar páginas');
  eq(out[2].filed, '1999-04-01', 'la página vieja queda al final');
  eq(out[1].form, 'DEF 14A', 'normaliza la forma a mayúsculas');
  eq(out[2].items, '', 'columna items ausente → cadena vacía, NUNCA undefined');
  eq(out[2].primaryDocument, '', 'columna primaryDocument ausente → cadena vacía');
  ok(out.every((f) => typeof f.items === 'string'), 'todos los items son string');
}

// ─────────────────────────────────────────────────────────────────
// 2. Clasificación de periodos
// ─────────────────────────────────────────────────────────────────
console.log('\n── clasePeriodo');
{
  eq(clasePeriodo(91), 'Q', '91 días → trimestre');
  eq(clasePeriodo(98), 'Q', '98 días (trimestre de 14 semanas del retail) → trimestre');
  eq(clasePeriodo(182), 'H1', '182 días → semestre');
  eq(clasePeriodo(273), '9M', '273 días → nueve meses');
  eq(clasePeriodo(364), 'FY', '364 días (año fiscal 52 semanas) → año');
  eq(clasePeriodo(371), 'FY', '371 días (año fiscal 53 semanas) → año');
  eq(clasePeriodo(30), 'otro', '30 días (mes suelto de un 6-K) → otro');
  eq(dias('2025-11-02', '2026-02-01'), 91, 'dias() cuenta el trimestre de cierre');
}

// ─────────────────────────────────────────────────────────────────
// 3. Censo de items de 8-K (G2)
// ─────────────────────────────────────────────────────────────────
console.log('\n── analizarItems8K');
{
  const filings = [
    { form: '8-K', items: '2.02,9.01', accession: 'a1' },
    { form: '8-K', items: '5.02', accession: 'a2' },
    { form: '8-K', items: '5.02,7.01', accession: 'a3' },
    { form: '8-K/A', items: '5.07', accession: 'a4' },
    { form: '8-K', items: '', accession: 'a5' },            // sin item
    { form: '8-K', items: 'Item 8.01', accession: 'a6' },   // mal formado
    { form: '10-Q', items: '', accession: 'a7' },           // no es 8-K
  ];
  const g2 = analizarItems8K(filings);
  eq(g2.ochoK, 6, 'cuenta 8-K y 8-K/A, ignora el 10-Q');
  eq(g2.conItems, 5, 'cuenta los que traen item (incluido el mal formado)');
  eq(g2.cobertura, '83.3%', 'cobertura sobre el total de 8-K');
  eq(g2.malFormados, 1, 'detecta el item que no es N.NN');
  eq(g2.ejemplosMalFormados[0].accession, 'a6', 'guarda el ejemplo para diagnóstico');
  eq(g2.claves['5.02'], 2, 'cuenta los 5.02 (pregunta 1: quién dirige)');
  eq(g2.claves['2.02'], 1, 'cuenta los 2.02 (pregunta 3: prometido vs entregado)');
  eq(g2.claves['5.07'], 1, 'cuenta los 5.07 dentro de un 8-K/A');
  eq(g2.claves['1.01'], 0, 'un item clave sin apariciones vale 0, no undefined');
  ok(g2.top.length > 0 && g2.top[0][1] >= g2.top[g2.top.length - 1][1], 'el top viene ordenado desc');
}

// ─────────────────────────────────────────────────────────────────
// Fixture de company-facts: minorista con año fiscal que cierra a fin de
// enero / principios de febrero (el calendario de LULU). Tres años fiscales
// COMPLETOS, reportados como los reporta un emisor real:
//   · Q1, Q2, Q3 como hechos de ~91 días (10-Q)
//   · los nueve meses como hecho de ~273 días (10-Q del Q3)
//   · el AÑO como hecho de ~364 días (10-K)
//   · Q4 NO EXISTE como hecho → tiene que salir de FY − 9M
// ─────────────────────────────────────────────────────────────────
const ANIOS_FISCALES = [
  { inicio: '2023-01-30', q1: '2023-04-30', q2: '2023-07-30', q3: '2023-10-29', fin: '2024-01-28' },
  { inicio: '2024-01-29', q1: '2024-04-28', q2: '2024-07-28', q3: '2024-10-27', fin: '2025-02-02' },
  { inicio: '2025-02-03', q1: '2025-05-04', q2: '2025-08-03', q3: '2025-11-02', fin: '2026-02-01' },
];

// Arma un nodo de company-facts (la forma {units:{USD:[…]}}) a partir de
// una lista de hechos. `tagPorAnio` permite plantar el corte de taxonomía.
function nodoDuracion(anios, { unidad = 'USD', accn = true, base = 1000 } = {}) {
  const filas = [];
  anios.forEach((a, i) => {
    const val = base * (i + 1);
    filas.push({ start: a.inicio, end: a.q1, val, fy: 2024 + i, fp: 'Q1', form: '10-Q', filed: a.q1, accn: accn ? `acc-${i}-q1` : undefined });
    filas.push({ start: a.q1, end: a.q2, val: val + 1, fy: 2024 + i, fp: 'Q2', form: '10-Q', filed: a.q2, accn: accn ? `acc-${i}-q2` : undefined });
    filas.push({ start: a.q2, end: a.q3, val: val + 2, fy: 2024 + i, fp: 'Q3', form: '10-Q', filed: a.q3, accn: accn ? `acc-${i}-q3` : undefined });
    filas.push({ start: a.inicio, end: a.q3, val: val * 3, fy: 2024 + i, fp: 'Q3', form: '10-Q', filed: a.q3, accn: accn ? `acc-${i}-9m` : undefined });
    filas.push({ start: a.inicio, end: a.fin, val: val * 4, fy: 2024 + i, fp: 'FY', form: '10-K', filed: a.fin, accn: accn ? `acc-${i}-fy` : undefined });
  });
  return { units: { [unidad]: filas } };
}

function nodoInstante(anios, { unidad = 'USD' } = {}) {
  const filas = [];
  anios.forEach((a, i) => {
    [a.q1, a.q2, a.q3, a.fin].forEach((end, j) => {
      filas.push({ end, val: 100 + i * 10 + j, fy: 2024 + i, fp: 'Q' + (j + 1), form: j === 3 ? '10-K' : '10-Q', filed: end, accn: `acc-${i}-inv${j}` });
    });
  });
  return { units: { [unidad]: filas } };
}

const DESDE = '2023-01-01'; // ventana que abarca los tres años del fixture

console.log('\n── hechosDe');
{
  const h = hechosDe(nodoDuracion(ANIOS_FISCALES));
  eq(h.length, 15, 'aplana 5 hechos × 3 años fiscales');
  ok(h.every((x) => x.unidad === 'USD'), 'arrastra la unidad');
  ok(h.every((x) => x.accn), 'arrastra el accession (sin él no hay cita)');
  eq(hechosDe({}).length, 0, 'nodo vacío → 0 hechos, sin tirar');
  eq(hechosDe(undefined).length, 0, 'nodo ausente → 0 hechos, sin tirar');
}

// ─────────────────────────────────────────────────────────────────
// 4. G1 — la derivación de Q4, que es de lo que depende la compuerta
// ─────────────────────────────────────────────────────────────────
console.log('\n── analizarFamilia · duración y derivación de Q4');
{
  const facts = { facts: { 'us-gaap': { Revenues: nodoDuracion(ANIOS_FISCALES) } } };
  const r = analizarFamilia(facts, fam('ingresos'), DESDE);

  ok(r.presente, 'familia presente');
  eq(r.tipo, 'duracion', 'clasificada como duración');
  eq(r.trimestres, 9, 'Q1-Q3 de tres años = 9 trimestres DIRECTOS (Q4 no se reporta)');
  eq(r.nueveMeses, 3, 'tres hechos de nueve meses');
  eq(r.anuales, 3, 'tres hechos anuales');
  eq(r.derivables, 3, 'tres Q4 DERIVABLES como FY − 9M');
  eq(r.efectivos, 12, 'doce trimestres efectivos ← el número que decide G1');
  eq(r.sinAccn, 0, 'todos los hechos son citables');
  eq(r.revisiones, 0, 'sin revisiones plantadas, cero revisiones');
  eq(r.primero, '2023-04-30', 'primer trimestre de la ventana');
  eq(r.ultimo, '2025-11-02', 'último trimestre de la ventana');
}

console.log('\n── analizarFamilia · un año SIN el hecho de nueve meses');
{
  // Si falta el 9M, ese Q4 no se puede derivar: el medidor tiene que
  // reportar 11 y no 12. Es la diferencia entre un hueco declarado y un
  // hueco inventado.
  const nodo = nodoDuracion(ANIOS_FISCALES);
  nodo.units.USD = nodo.units.USD.filter((f) => f.accn !== 'acc-2-9m');
  const r = analizarFamilia({ facts: { 'us-gaap': { Revenues: nodo } } }, fam('ingresos'), DESDE);
  eq(r.derivables, 2, 'sin el 9M del último año, solo dos Q4 derivables');
  eq(r.efectivos, 11, 'once trimestres efectivos, no doce');
}

console.log('\n── analizarFamilia · unión de alias a través de ASC 606');
{
  // Los dos primeros años bajo el tag viejo, el último bajo el nuevo.
  const viejos = nodoDuracion(ANIOS_FISCALES.slice(0, 2));
  const nuevos = nodoDuracion(ANIOS_FISCALES.slice(2));
  const facts = { facts: { 'us-gaap': {
    Revenues: viejos,
    RevenueFromContractWithCustomerExcludingAssessedTax: nuevos,
  } } };
  const r = analizarFamilia(facts, fam('ingresos'), DESDE);
  eq(r.tags.length, 2, 'reporta los DOS tags que aportaron a la serie');
  eq(r.efectivos, 12, 'la serie unida da los mismos 12 trimestres');
  ok(r.tags.every((t) => t.startsWith('us-gaap:')), 'los tags vienen con su taxonomía');
}

console.log('\n── analizarFamilia · revisiones y hechos sin accession');
{
  const nodo = nodoDuracion(ANIOS_FISCALES);
  // Mismo periodo, valor distinto, presentación posterior: una re-expresión.
  const q1 = nodo.units.USD[0];
  nodo.units.USD.push({ ...q1, val: q1.val + 999, filed: '2025-03-01', accn: 'acc-restate' });
  // Un hecho sin accession: no se puede citar y el reporte tiene que verlo.
  nodo.units.USD.push({ ...nodo.units.USD[1], accn: undefined });

  const r = analizarFamilia({ facts: { 'us-gaap': { Revenues: nodo } } }, fam('ingresos'), DESDE);
  eq(r.revisiones, 1, 'detecta el periodo re-expresado');
  eq(r.sinAccn, 1, 'detecta el hecho sin accession');
  eq(r.efectivos, 12, 'la re-expresión no infla el conteo de trimestres');
}

console.log('\n── analizarFamilia · instantes y taxonomía IFRS');
{
  const inst = analizarFamilia(
    { facts: { 'us-gaap': { InventoryNet: nodoInstante(ANIOS_FISCALES) } } },
    fam('inventario'), DESDE);
  eq(inst.tipo, 'instante', 'inventario es un instante, no una duración');
  eq(inst.trimestres, 12, 'doce cortes de inventario');
  eq(inst.efectivos, 12, 'en instantes, efectivos = cortes (no hay nada que derivar)');

  const ifrs = analizarFamilia(
    { facts: { 'ifrs-full': { Revenue: nodoDuracion(ANIOS_FISCALES) } } },
    fam('ingresos'), DESDE);
  ok(ifrs.presente, 'encuentra la familia bajo ifrs-full (emisor 20-F)');
  eq(ifrs.tags[0], 'ifrs-full:Revenue', 'etiqueta la taxonomía IFRS');
}

console.log('\n── analizarFamilia · ausencia y ventana temporal');
{
  const ausente = analizarFamilia({ facts: { 'us-gaap': {} } }, fam('ingresos'), DESDE);
  eq(ausente.presente, false, 'familia ausente se declara ausente');
  eq(ausente.efectivos, 0, 'ausente → 0 efectivos, nunca un número inventado');

  const facts = { facts: { 'us-gaap': { Revenues: nodoDuracion(ANIOS_FISCALES) } } };
  const corta = analizarFamilia(facts, fam('ingresos'), '2025-02-04');
  eq(corta.trimestres, 3, 'la ventana recorta a los trimestres del último año');
  eq(corta.derivables, 1, 'y a un solo Q4 derivable');

  const vacio = analizarFamilia({ facts: {} }, fam('ingresos'), DESDE);
  eq(vacio.presente, false, 'company-facts sin taxonomías no revienta');
}

// ─────────────────────────────────────────────────────────────────
// 5. Coherencia del catálogo de familias
// ─────────────────────────────────────────────────────────────────
console.log('\n── catálogo FAMILIAS');
{
  ok(FAMILIAS.length > 0, 'hay familias definidas');
  ok(FAMILIAS.every((f) => f.tags.length > 0), 'toda familia trae al menos un tag us-gaap');
  ok(FAMILIAS.every((f) => f.tipo === 'duracion' || f.tipo === 'instante'), 'todo tipo es duración o instante');
  ok(FAMILIAS.every((f) => [1, 2, 3, 7].includes(f.pregunta)), 'toda familia se cuelga de una pregunta del esqueleto');
  eq(new Set(FAMILIAS.map((f) => f.id)).size, FAMILIAS.length, 'los ids de familia son únicos');
  // El núcleo que evalúa la compuerta G1 tiene que existir en el catálogo.
  for (const id of ['ingresos', 'margen', 'inventario', 'neto']) {
    ok(!!fam(id), `el núcleo de G1 incluye "${id}"`);
  }
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
