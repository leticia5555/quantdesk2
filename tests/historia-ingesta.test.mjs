// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-ingesta.js — de EDGAR a las tablas.
//
// Los fixtures son SINTÉTICOS y están escritos a mano acá, pero no son
// inventados: reproducen las formas que midió la corrida 2 (§11 del memo) —
// el 9M y el FY de los que sale un Q4, los dos alias de ingresos que le dieron
// a MELI sus "19 revisiones", el 20-F de VIST sin un solo trimestre, y la
// página vieja del índice que no trae columna `items`.
//
// Nada de acá cierra G7: que lo ingerido quede bien GUARDADO se verifica
// contra Neon con datos reales. Lo que sí queda probado es la lectura, que es
// donde un error no explota sino que produce un número plausible y falso:
//
//   1. **El Q4 derivado y sus dos citas.** Es el único hecho que este módulo
//      calcula en vez de copiar, así que es el único que puede estar mal por
//      nuestra culpa. Se prueba que empareja por año fiscal y no por cercanía
//      de fechas, y que se niega a derivar cuando falta una de las dos citas.
//   2. **Lo que se descarta se cuenta.** Un hecho sin `accn` no se puede
//      citar y no entra — pero sale en el conteo. La corrida 2 midió 0 en los
//      cuatro emisores: si aparece uno, es nuestro.
//   3. **La re-expresión se conserva y el alias no se confunde con ella.**
//      Mismo periodo con dos valores de DOS filings son dos filas (eso es la
//      pregunta 3); mismo periodo con dos TAGS son dos filas con rango
//      distinto, y la vista de la rebanada B elige, no promedia.
//   4. **La página vieja sin `items`.** Un `undefined` ahí se cuela como
//      "8-K sin item" y ensucia el censo en silencio. Es el bug que la Fase 0
//      del Congreso pagó con dos corridas.
//   5. **Un emisor que falla no tumba el turno del goteo.**
//
// Correr con `node tests/historia-ingesta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  aplanarSubmissions, itemsDe, perfilDe, filingsParaGuardar,
  clasePeriodo, dias, sumarDias, restarAnios, hechosDe,
  derivarQ4, normalizarFacts, ingerirEmisor, sembrarUniverso, correrGoteo, aNumero,
} from '../api/_lib/historia-ingesta.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

// ── Fixtures sintéticos con la forma de la corrida 2 ──────────────────────

// Un nodo de companyfacts: units → filas.
const nodo = (filas, unit = 'USD') => ({ units: { [unit]: filas } });

// Un trimestre presentado en su 10-Q.
const q = (start, end, val, accn, filed, extra = {}) =>
  ({ start, end, val, accn, filed, form: '10-Q', fy: Number(end.slice(0, 4)), fp: 'Q1', ...extra });

// El año, presentado en el 10-K.
const fy = (start, end, val, accn, filed) =>
  ({ start, end, val, accn, filed, form: '10-K', fy: Number(end.slice(0, 4)), fp: 'FY' });

// Los nueve meses, que son la otra mitad del Q4.
const m9 = (start, end, val, accn, filed) =>
  ({ start, end, val, accn, filed, form: '10-Q', fy: Number(end.slice(0, 4)), fp: 'Q3' });

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Aritmética de fechas (la que NO se delega)');
{
  eq(dias('2025-01-01', '2025-12-31'), 364, 'un año fiscal son ~364 días');
  eq(dias('2025-01-01', '2025-09-30'), 272, 'nueve meses son ~272');
  eq(dias('2025-09-30', '2025-12-31'), 92, 'y el hueco entre ellos es un trimestre');
  eq(sumarDias('2025-09-30', 1), '2025-10-01', 'el Q4 arranca el día después del 9M');
  eq(restarAnios('2026-09-20', 3), '2023-09-20', 'la ventana de 3 años');
  eq(restarAnios('2024-02-29', 1), '2023-03-01', 'un 29 de febrero no rompe la resta de años');

  hondo([89, 91, 105, 116].map(clasePeriodo), ['Q', 'Q', 'Q', 'OTRO'], 'Q admite el 4-5-4 pero no cualquier cosa');
  hondo([180, 272, 364, 45].map(clasePeriodo), ['H1', '9M', 'FY', 'OTRO'], 'H1 / 9M / FY / lo demás');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── aNumero: el cero inventado que Number() regala');
{
  // `Number(null)` es 0 y `Number('')` también. En una tabla cuyo punto es
  // que nada esté inventado, eso convertía un hecho SIN valor en un cero
  // creíble — y un cero creíble en una serie de ingresos no se ve nunca.
  ok(Number.isNaN(aNumero(null)), 'null NO es cero');
  ok(Number.isNaN(aNumero(undefined)), 'undefined tampoco');
  ok(Number.isNaN(aNumero('')), 'ni la cadena vacía');
  ok(Number.isNaN(aNumero(true)), 'ni un booleano');
  ok(Number.isNaN(aNumero('hola')), 'ni texto');
  eq(aNumero(0), 0, 'pero un cero de verdad SÍ es cero');
  eq(aNumero('1500000'), 1500000, 'y un número en texto se convierte');
  eq(aNumero(-42.5), -42.5, 'los negativos y decimales pasan');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── aplanarSubmissions: la página vieja no trae columna items');
{
  const principal = {
    name: 'MERCADOLIBRE INC',
    filings: {
      recent: {
        accessionNumber: ['0001-26-1', '0001-26-2'],
        form: ['8-K', '10-q'],
        filingDate: ['2026-02-20', '2026-01-15'],
        reportDate: ['2026-02-19', null],
        items: ['2.02,9.01', ''],
        primaryDocument: ['a.htm', 'b.htm'],
        isXBRL: [1, 1],
        size: [1000, 2000],
      },
      files: [],
    },
  };
  // Página vieja: SIN `items`, SIN `isXBRL`. Así vienen de verdad.
  const vieja = {
    json: {
      accessionNumber: ['0001-19-9'],
      form: ['8-K'],
      filingDate: ['2019-05-01'],
      primaryDocument: ['viejo.htm'],
    },
  };

  const filas = aplanarSubmissions({ principal, paginas: [vieja] });
  eq(filas.length, 3, 'une la principal con las páginas extra');
  eq(filas[0].filed, '2026-02-20', 'y ordena descendente: concatenar rompía el orden');
  eq(filas[2].filed, '2019-05-01', 'lo viejo al final');
  eq(filas[2].items, '', 'una página sin columna items da cadena vacía, no undefined');
  eq(filas[2].isXBRL, false, 'ni undefined en isXBRL');
  eq(filas[2].reportDate, null, 'ni en reportDate');
  eq(filas[1].form, '10-Q', 'la forma se normaliza a mayúsculas');

  // Una fila sin accession o sin fecha no se puede ni guardar ni ubicar.
  const rota = aplanarSubmissions({
    principal: { filings: { recent: {
      accessionNumber: ['a', null, 'c'], form: ['8-K', '8-K', '8-K'],
      filingDate: ['2026-01-01', '2026-01-02', null],
    } } },
  });
  eq(rota.length, 1, 'una fila sin accession o sin fecha se descarta, no se completa');

  hondo(aplanarSubmissions({}), [], 'sin datos devuelve lista vacía, no explota');
  hondo(aplanarSubmissions(), [], 'ni sin argumento');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── itemsDe');
{
  hondo(itemsDe('5.02,9.01'), ['5.02', '9.01'], 'parte por coma');
  hondo(itemsDe(' 7.01 , 7.01 '), ['7.01'], 'recorta y deduplica');
  hondo(itemsDe('15.02'), ['15.02'], 'un item de dos dígitos es válido');
  hondo(itemsDe('5.2'), [], 'pero 5.2 no: el formato es N.NN');
  hondo(itemsDe('basura, 2.02'), ['2.02'], 'lo que no matchea se descarta y lo bueno se queda');
  hondo(itemsDe(''), [], 'vacío es vacío');
  hondo(itemsDe(null), [], 'y null también');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── perfilDe: la etiqueta de cobertura se MIDE, no se asume');
{
  const p = (formas) => perfilDe(formas.map((f) => ({ form: f })));

  const domestico = p(['8-K', '10-Q', '10-K', '4']);
  eq(domestico.formaAnual, '10-K', 'un 10-K filer es doméstico');
  eq(domestico.cobertura, 'completa', 'y su cobertura es completa');

  // VIST, el control de la corrida 2.
  const extranjero = p(['6-K', '20-F', 'SC 13D']);
  eq(extranjero.formaAnual, '20-F', 'un 20-F filer es emisor privado extranjero');
  eq(extranjero.cobertura, 'parcial', 'y su cobertura es PARCIAL — se etiqueta, no se esconde');
  eq(extranjero.tiene10Q, false, 'sin 10-Q no hay trimestres');
  eq(extranjero.tiene6K, true, 'presenta 6-K en su lugar');

  eq(p(['40-F', '6-K']).cobertura, 'parcial', 'el 40-F canadiense también es parcial');
  eq(p(['4', '8-K']).formaAnual, null, 'sin forma anual en la ventana se dice null, no se adivina');

  // El memo creía que MELI era 20-F y la corrida 2 lo desmintió: esto es lo
  // que hace que el dato mande sobre la creencia.
  eq(p(['10-K', '10-Q', '8-K']).cobertura, 'completa',
    'un ticker latino que presenta 10-K es doméstico, diga lo que diga la intuición');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── filingsParaGuardar: la URL de la cita');
{
  const crudas = [
    { accession: '0001-26-1', form: '8-K', filed: '2026-02-20', reportDate: '2026-02-19', items: '2.02', primaryDocument: 'a.htm', isXBRL: true, size: 10 },
    { accession: '0001-20-1', form: '8-K', filed: '2020-01-01', reportDate: null, items: '', primaryDocument: '', isXBRL: false, size: 0 },
  ];
  const filas = filingsParaGuardar('0001099590', crudas, { desde: '2021-01-01' });
  eq(filas.length, 1, 'la ventana recorta lo viejo');
  eq(filas[0].url, 'https://www.sec.gov/Archives/edgar/data/1099590/000126 1/a.htm'.replace('000126 1', '0001261'),
    'la URL apunta al documento primario, con cik entero y accession sin guiones');
  eq(filas[0].index_url, 'https://www.sec.gov/Archives/edgar/data/1099590/0001261/index.json', 'y el index.json al lado');
  eq(filas[0].size_bytes, 10, 'el tamaño viaja');

  const sinDoc = filingsParaGuardar('1', [crudas[1]], {});
  eq(sinDoc[0].url, sinDoc[0].index_url,
    'sin documento primario se enlaza el directorio: una URL útil antes que una rota');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── derivarQ4: el único hecho que calculamos, y sus DOS citas');
{
  const base = [
    fy('2025-01-01', '2025-12-31', 1000, 'acc-10K', '2026-02-20'),
    m9('2025-01-01', '2025-09-30', 700, 'acc-10Q3', '2025-11-01'),
  ];
  const [d] = derivarQ4(base);
  eq(d.val, 300, 'Q4 = FY − 9M');
  eq(d.start, '2025-10-01', 'el periodo arranca el día después del 9M');
  eq(d.end, '2025-12-31', 'y termina con el año');
  eq(d.accn, 'acc-10K', 'cita el 10-K…');
  eq(d.accnAux, 'acc-10Q3', '…y el 10-Q de los nueve meses: el valor depende de los dos');
  eq(d.derived, true, 'queda marcado como derivado');
  eq(d.fp, 'Q4', 'y etiquetado Q4');
  eq(clasePeriodo(dias(d.start, d.end)), 'Q', 'el periodo derivado clasifica como trimestre');

  // El emparejamiento por AÑO FISCAL, no por cercanía de fechas. Un 9M que
  // arranca en otra fecha es de otro año: restarlo daría un número plausible.
  eq(derivarQ4([
    fy('2025-02-01', '2026-01-31', 1000, 'a', '2026-03-01'),
    m9('2025-01-01', '2025-10-31', 700, 'b', '2025-12-01'),
  ]).length, 0, 'un 9M que arranca en otra fecha NO se empareja aunque el hueco dé ~90 días');

  // Sin cita no se deriva: preferimos no tener el Q4 a tener uno sin respaldo.
  eq(derivarQ4([fy('2025-01-01', '2025-12-31', 1000, null, '2026-02-20'), base[1]]).length, 0,
    'un FY sin accn no produce Q4');
  eq(derivarQ4([base[0], m9('2025-01-01', '2025-09-30', 700, null, '2025-11-01')]).length, 0,
    'un 9M sin accn tampoco: la segunda cita no es opcional');

  // Consistencia "as reported": el 9M elegido es lo que se sabía al cerrar.
  const conReexpresion = [
    base[0],
    m9('2025-01-01', '2025-09-30', 700, 'acc-original', '2025-11-01'),
    m9('2025-01-01', '2025-09-30', 690, 'acc-reexpresado', '2026-05-01'),  // DESPUÉS del 10-K
  ];
  const [dr] = derivarQ4(conReexpresion);
  eq(dr.accnAux, 'acc-original', 'el 9M re-expresado DESPUÉS del 10-K no se usa');
  eq(dr.val, 300, 'así el Q4 es consistente con lo que la empresa sabía al cerrar el año');

  // Dos 9M anteriores al 10-K: gana el más reciente.
  const [d2] = derivarQ4([
    base[0],
    m9('2025-01-01', '2025-09-30', 710, 'acc-viejo', '2025-11-01'),
    m9('2025-01-01', '2025-09-30', 700, 'acc-nuevo', '2025-12-15'),
  ]);
  eq(d2.accnAux, 'acc-nuevo', 'entre dos 9M válidos gana la última palabra previa al cierre');

  // Unidades distintas no se restan.
  eq(derivarQ4([
    { ...base[0], unit: 'USD' },
    { ...base[1], unit: 'shares' },
  ]).length, 0, 'un FY en USD no se empareja con un 9M en shares');

  eq(derivarQ4([]).length, 0, 'sin hechos no hay derivados');
  eq(derivarQ4([base[0]]).length, 0, 'un FY solo, sin su 9M, no produce nada');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── normalizarFacts');
{
  const cf = (facts) => ({ cik: 1099590, facts });

  // Caso base: un trimestre mapeado.
  {
    const { filas, descartados } = normalizarFacts(cf({
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: nodo([
          q('2025-01-01', '2025-03-31', 100, 'acc-1', '2025-05-01'),
        ]),
      },
    }), { cik: '0001099590' });
    eq(filas.length, 1, 'un hecho mapeado entra');
    eq(filas[0].familia, 'ingresos', 'con su familia');
    eq(filas[0].familia_rango, 1, 'y su rango, que es lo que la vista usa para elegir');
    eq(filas[0].period_class, 'Q', 'clasificado por largo de periodo');
    eq(filas[0].accession, 'acc-1', 'y su cita');
    eq(filas[0].derived, false, 'no es derivado');
    hondo(descartados, { sin_accn: 0, sin_valor: 0, sin_fecha: 0 }, 'sin descartes');
  }

  // Lo que no se puede citar no entra — y se CUENTA.
  {
    const { filas, descartados } = normalizarFacts(cf({
      'us-gaap': {
        GrossProfit: nodo([
          q('2025-01-01', '2025-03-31', 100, null, '2025-05-01'),          // sin accn
          q('2025-04-01', '2025-06-30', null, 'acc-2', '2025-08-01'),      // sin valor
          q('2025-07-01', '2025-09-30', 300, 'acc-3', null),               // sin fecha de presentación
          q('2025-10-01', '2025-12-31', 400, 'acc-4', '2026-02-01'),       // bueno
        ]),
      },
    }), { cik: '1' });
    eq(filas.length, 1, 'solo entra el hecho citable, con valor y con fecha');
    eq(descartados.sin_accn, 1, 'el que no se puede citar se cuenta');
    eq(descartados.sin_valor, 1, 'el que no tiene valor también');
    eq(descartados.sin_fecha, 1, 'y el que no se puede ubicar en el tiempo');
  }

  // La re-expresión: mismo periodo, dos filings, dos valores → DOS filas.
  // Es la materia prima de la pregunta 3, no ruido a limpiar.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': {
        NetIncomeLoss: nodo([
          q('2025-01-01', '2025-03-31', 100, 'acc-original', '2025-05-01'),
          q('2025-01-01', '2025-03-31', 95, 'acc-reexpresado', '2026-05-01'),
        ]),
      },
    }), { cik: '1' });
    eq(filas.length, 2, 'una re-expresión son DOS filas: el accession va en la clave');
    eq(new Set(filas.map((f) => f.accession)).size, 2, 'con citas distintas');
    eq(new Set(filas.map((f) => f.familia_rango)).size, 1, 'y el MISMO rango: es el mismo tag');
  }

  // El alias: mismo periodo, DOS tags → dos filas con rango distinto. La
  // vista de la rebanada B elige por rango; acá solo se etiqueta.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: nodo([q('2025-01-01', '2025-03-31', 100, 'acc-1', '2025-05-01')]),
        RevenueFromContractWithCustomerIncludingAssessedTax: nodo([q('2025-01-01', '2025-03-31', 118, 'acc-1', '2025-05-01')]),
      },
    }), { cik: '1' });
    eq(filas.length, 2, 'los dos alias se guardan: el crudo no se tira');
    hondo(filas.map((f) => f.familia_rango).sort(), [1, 2], 'con rangos distintos — esto es lo que NO es una re-expresión');
    eq(new Set(filas.map((f) => f.familia)).size, 1, 'y la misma familia');
  }

  // Instantes: no se derivan (no hay nada que restar) y se clasifican aparte.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': { InventoryNet: nodo([{ end: '2025-03-31', val: 50, accn: 'acc-1', filed: '2025-05-01', form: '10-Q' }]) },
    }), { cik: '1' });
    eq(filas.length, 1, 'un instante entra igual');
    eq(filas[0].period_class, 'INSTANT', 'clasificado como instante');
    eq(filas[0].period_start, null, 'sin inicio, que es lo que lo hace un instante');
    eq(filas[0].derived, false, 'y nunca derivado: no hay nada que restar en un corte');
  }

  // El Q4 derivado llega hasta la fila, con sus dos citas.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': {
        Revenues: nodo([
          fy('2025-01-01', '2025-12-31', 1000, 'acc-10K', '2026-02-20'),
          m9('2025-01-01', '2025-09-30', 700, 'acc-10Q3', '2025-11-01'),
        ]),
      },
    }), { cik: '1' });
    const derivada = filas.find((f) => f.derived);
    ok(derivada, 'el Q4 derivado llega a las filas');
    eq(derivada.val, 300, 'con su valor');
    eq(derivada.accession_aux, 'acc-10Q3', 'y su segunda cita, que el CHECK de la tabla exige');
    eq(derivada.period_class, 'Q', 'clasificado como trimestre');
  }

  // Un concepto sin familia se guarda igual.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': { AlgoRarisimo: nodo([q('2025-01-01', '2025-03-31', 1, 'acc-1', '2025-05-01')]) },
    }), { cik: '1' });
    eq(filas.length, 1, 'un concepto sin familia se guarda');
    eq(filas[0].familia, null, 'con familia null');
    eq(filas[0].familia_rango, null, 'y rango null: el CHECK exige que viajen juntos');
  }

  // VIST: ifrs-full, solo anuales, cero trimestres.
  {
    const { filas } = normalizarFacts(cf({
      'ifrs-full': {
        Revenue: nodo([
          { start: '2024-01-01', end: '2024-12-31', val: 500, accn: 'v-1', filed: '2025-04-01', form: '20-F' },
          { start: '2025-01-01', end: '2025-12-31', val: 600, accn: 'v-2', filed: '2026-04-01', form: '20-F' },
        ]),
      },
    }), { cik: '0001762506' });
    eq(filas.length, 2, 'ifrs-full mapea igual');
    eq(filas.filter((f) => f.period_class === 'Q').length, 0,
      'y un 20-F no produce un solo trimestre: eso es cobertura parcial, no un fallo');
    eq(filas[0].familia, 'ingresos', 'la familia cruza las taxonomías');
  }

  // La ventana.
  {
    const { filas } = normalizarFacts(cf({
      'us-gaap': {
        GrossProfit: nodo([
          q('2019-01-01', '2019-03-31', 1, 'viejo', '2019-05-01'),
          q('2025-01-01', '2025-03-31', 2, 'nuevo', '2025-05-01'),
        ]),
      },
    }), { cik: '1', desde: '2023-01-01' });
    eq(filas.length, 1, 'la ventana de 3 años recorta');
    eq(filas[0].accession, 'nuevo', 'y deja lo reciente');
  }

  hondo(normalizarFacts({}, { cik: '1' }).filas, [], 'un companyfacts vacío no explota');
  hondo(normalizarFacts(null, { cik: '1' }).filas, [], 'ni uno nulo');
  eq(hechosDe(null).length, 0, 'hechosDe tolera un nodo ausente');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── ingerirEmisor: la orquestación');

// Cliente falso: contesta por URL con los fixtures. Ejercita el transporte
// real (bajarSubmissionsCompleto, bajarCompanyFacts) en vez de saltárselo.
function cliFalso(porUrl) {
  const pedidas = [];
  return {
    pedidas,
    json: async (url) => {
      pedidas.push(url);
      const clave = Object.keys(porUrl).find((k) => url.includes(k));
      if (!clave) throw Object.assign(new Error(`fixture faltante: ${url}`), { clase: 'ausente' });
      return { json: porUrl[clave], bytes: JSON.stringify(porUrl[clave]).length };
    },
  };
}

function repoFalso() {
  const llamadas = [];
  const grabar = (nombre) => async (...args) => { llamadas.push([nombre, ...args]); return 0; };
  return {
    llamadas,
    asegurarEsquema: grabar('asegurarEsquema'),
    guardarEmisor: grabar('guardarEmisor'),
    guardarFilings: grabar('guardarFilings'),
    guardarItems: async (...a) => { llamadas.push(['guardarItems', ...a]); return a[2].length; },
    guardarFacts: grabar('guardarFacts'),
    marcarIngesta: grabar('marcarIngesta'),
    pendientes: async () => [],
    nombres: () => llamadas.map((l) => l[0]),
  };
}

{
  const submissions = {
    name: 'MERCADOLIBRE INC',
    sic: '7389',
    filings: {
      recent: {
        accessionNumber: ['0001-26-1', '0001-26-2', '0001-26-3'],
        form: ['8-K', '10-K', '10-Q'],
        filingDate: ['2026-02-20', '2026-02-20', '2025-11-01'],
        reportDate: ['2026-02-19', '2025-12-31', '2025-09-30'],
        items: ['2.02,9.01', '', ''],
        primaryDocument: ['a.htm', 'b.htm', 'c.htm'],
        isXBRL: [1, 1, 1],
        size: [100, 200, 300],
      },
      files: [],
    },
  };
  const companyfacts = {
    facts: {
      'us-gaap': {
        Revenues: nodo([
          fy('2025-01-01', '2025-12-31', 1000, '0001-26-2', '2026-02-20'),
          m9('2025-01-01', '2025-09-30', 700, '0001-26-3', '2025-11-01'),
        ]),
        InventoryNet: nodo([{ end: '2025-12-31', val: 50, accn: '0001-26-2', filed: '2026-02-20', form: '10-K' }]),
      },
    },
  };

  const cli = cliFalso({ '/submissions/': submissions, '/companyfacts/': companyfacts });
  const repo = repoFalso();
  const r = await ingerirEmisor(cli, repo, { cik: '1099590', ticker: 'MELI' }, { hoy: '2026-09-20' });

  eq(r.cik, '0001099590', 'el cik se normaliza a diez dígitos');
  eq(r.nombre, 'MERCADOLIBRE INC', 'el nombre sale del propio submissions');
  eq(r.perfil.cobertura, 'completa', 'MELI presenta 10-K: cobertura completa, como midió la corrida 2');
  eq(r.filings, 3, 'guarda los tres filings de la ventana');
  eq(r.items, 2, 'y los items del 8-K');
  eq(r.derivados, 1, 'deriva el Q4');
  eq(r.sinCita, 0, 'ningún hecho sin cita — el número que G7 vigila');

  // El orden importa: company_filing_items tiene FK a company_filings, y el
  // perfil tiene que existir antes que nada para que la página pueda decir
  // "cobertura parcial" aunque la serie venga vacía.
  const orden = repo.nombres();
  ok(orden.indexOf('guardarEmisor') < orden.indexOf('guardarFilings'), 'el emisor se guarda antes que los filings');
  ok(orden.indexOf('guardarFilings') < orden.indexOf('guardarItems'), 'y los filings antes que sus items (hay una FK)');

  // Solo se piden items del filing que los tiene.
  eq(repo.llamadas.filter((l) => l[0] === 'guardarItems').length, 1,
    'un 10-Q sin items no genera una transacción por nada');

  // Y los hechos llegan con lo que el esquema exige.
  const facts = repo.llamadas.find((l) => l[0] === 'guardarFacts')[1];
  ok(facts.every((f) => f.accession), 'ningún hecho viaja sin accession');
  ok(facts.filter((f) => f.derived).every((f) => f.accession_aux), 'y ningún derivado sin su segunda cita');
}

// VIST: el control de cobertura parcial, de punta a punta.
{
  const cli = cliFalso({
    '/submissions/': {
      name: 'Vista Energy, S.A.B. de C.V.',
      filings: { recent: {
        accessionNumber: ['v-1', 'v-2'], form: ['20-F', '6-K'],
        filingDate: ['2026-04-01', '2026-05-01'], reportDate: [null, null],
        items: ['', ''], primaryDocument: ['x.htm', 'y.htm'], isXBRL: [1, 0], size: [1, 2],
      }, files: [] },
    },
    '/companyfacts/': { facts: { 'ifrs-full': { Revenue: nodo([
      { start: '2025-01-01', end: '2025-12-31', val: 600, accn: 'v-1', filed: '2026-04-01', form: '20-F' },
    ]) } } },
  });
  const repo = repoFalso();
  const r = await ingerirEmisor(cli, repo, { cik: '1762506', ticker: 'VIST' }, { hoy: '2026-09-20' });

  eq(r.perfil.cobertura, 'parcial', 'VIST queda etiquetado cobertura parcial');
  eq(r.perfil.formaAnual, '20-F', 'con su forma anual');
  eq(r.derivados, 0, 'sin 9M no hay Q4 que derivar');
  ok(r.hechos > 0, 'pero SÍ se ingiere: el extranjero sale del cálculo de cobertura, no del módulo');
  const emisor = repo.llamadas.find((l) => l[0] === 'guardarEmisor')[1];
  eq(emisor.cobertura, 'parcial', 'y la etiqueta llega a la tabla, que es de donde la lee la UI');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── sembrarUniverso y correrGoteo');
{
  const mapa = {
    0: { cik_str: 1099590, ticker: 'MELI', title: 'MERCADOLIBRE INC' },
    1: { cik_str: 1397187, ticker: 'LULU', title: 'lululemon athletica inc.' },
  };
  const cli = cliFalso({ 'company_tickers.json': mapa });
  const repo = repoFalso();
  const { sembrados, desconocidos } = await sembrarUniverso(cli, repo, ['meli', 'LULU', 'NOEXISTE']);
  eq(sembrados.length, 2, 'siembra los que están en EDGAR');
  eq(sembrados[0].cik, '0001099590', 'con el cik ya normalizado');
  hondo(desconocidos, ['NOEXISTE'], 'y devuelve los que no: un ticker sin registro no es un error del sistema');
}

{
  // Dos emisores: el primero falla, el segundo tiene que ingerirse igual.
  const cli = {
    json: async (url) => {
      if (url.includes('0000000001')) throw new Error('HTTP 429 tras 3 reintentos');
      if (url.includes('/submissions/')) {
        return { json: { name: 'Buena', filings: { recent: {
          accessionNumber: ['b-1'], form: ['10-K'], filingDate: ['2026-01-01'],
          reportDate: [null], items: [''], primaryDocument: ['b.htm'], isXBRL: [1], size: [1],
        }, files: [] } }, bytes: 10 };
      }
      return { json: { facts: {} }, bytes: 2 };
    },
  };
  const repo = repoFalso();
  repo.pendientes = async () => ([
    { cik: '0000000001', ticker: 'MALA' },
    { cik: '0000000002', ticker: 'BUENA' },
  ]);

  const r = await correrGoteo(cli, repo, { limite: 7, hoy: '2026-09-20' });
  eq(r.intentados, 2, 'intenta los dos');
  eq(r.ok, 1, 'uno sale bien');
  eq(r.errores, 1, 'y el otro falla');
  ok(r.resultados[0].error.includes('429'), 'el error se conserva, no se traga');

  const marcas = repo.llamadas.filter((l) => l[0] === 'marcarIngesta');
  eq(marcas.length, 2, 'los dos quedan marcados');
  eq(marcas[0][2].estado, 'error', 'el que falló con su estado…');
  ok(marcas[0][2].error.includes('429'), '…y su motivo en la misma tabla donde se elige a quién ingerir');
  eq(marcas[1][2].estado, 'ok', 'y el que salió bien, bien');
  ok(repo.nombres().includes('asegurarEsquema'), 'el goteo asegura el esquema antes de empezar');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
