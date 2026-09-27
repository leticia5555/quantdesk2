// ═══════════════════════════════════════════════════════════════════════
// EDGAR DE ÁRBITRO — y su techo, que no es el de G2
//
// Las 21 emisoras en USD de la auditoría del 2026-09-24 no cuadraban porque
// `shareOutstanding` estaba viejo, no porque la cap estuviera mal: tres
// múltiplos pegados a 2× (VMRK 2.1765, MNST 2.0782, APH 1.9847) son un split
// que Finnhub no reflejó. Estas pruebas fijan que el conteo de la portada del
// 10-Q resuelva ese caso, que el split NO se cuele como verificado, y que el
// 10% de acá quede separado del 5% de G2.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapaCik, accionesDeCompanyConcept, veredictoCapEdgar, rutaCompanyConcept, UMBRAL_EDGAR_PCT,
} from '../api/_lib/mercado-edgar.js';
import { CRITERIOS } from '../api/_lib/mercado-fase0.js';

test('el techo de EDGAR es 10% y NO es el de G2', () => {
  // Si alguien los unifica, esta prueba se pone roja y obliga a decir por qué.
  // Son dos preguntas distintas: G2 compara dos medidas del mismo instante;
  // acá se comparan acciones de la portada del trimestre contra el cierre de
  // hoy, donde algo de deriva es lo esperado.
  assert.equal(UMBRAL_EDGAR_PCT, 10);
  assert.notEqual(UMBRAL_EDGAR_PCT, CRITERIOS.g2_max_error_pct);
});

test('el CIK se rellena a 10 dígitos y la ruta lo usa tal cual', () => {
  const m = mapaCik({ 0: { cik_str: 320193, ticker: 'aapl', title: 'Apple' }, 1: { cik_str: 789019, ticker: 'MSFT' } });
  assert.equal(m.get('AAPL'), '0000320193');
  assert.match(rutaCompanyConcept(m.get('AAPL')), /CIK0000320193\/dei\/EntityCommonStockSharesOutstanding\.json$/);
});

test('un ticker que EDGAR no conoce no se inventa', () => {
  const m = mapaCik({ 0: { cik_str: 320193, ticker: 'AAPL' } });
  assert.equal(m.get('SPCX'), undefined);
});

// ── LEER LA PORTADA ────────────────────────────────────────────────────
const CONCEPTO = {
  cik: 865752,
  units: {
    shares: [
      { end: '2025-05-01', val: 1000000000, form: '10-Q', filed: '2025-05-05', fy: 2025, fp: 'Q1' },
      { end: '2025-08-01', val: 2000000000, form: '10-Q', filed: '2025-08-04', fy: 2025, fp: 'Q2' },
      // Un 8-K no trae portada con conteo: no debe ganar por ser el más nuevo.
      { end: '2025-09-10', val: 999, form: '8-K', filed: '2025-09-10' },
    ],
  },
};

test('gana el último 10-Q por fecha de presentación, no el archivo más nuevo', () => {
  const a = accionesDeCompanyConcept(CONCEPTO);
  assert.equal(a.acciones, 2000000000);
  assert.equal(a.form, '10-Q');
  assert.equal(a.fecha_portada, '2025-08-01', 'la fecha de portada es el instante al que vale el conteo');
  assert.equal(a.presentado_en, '2025-08-04', 'y la de presentación es cuándo nos enteramos');
});

test('sin formas con portada lo dice en vez de devolver un número', () => {
  const a = accionesDeCompanyConcept({ units: { shares: [{ end: '2025-09-10', val: 5, form: '8-K' }] } });
  assert.equal(a.acciones, null);
  assert.match(a.motivo, /10-Q/);
});

test('un CIK sin el concepto lo dice con su causa', () => {
  const a = accionesDeCompanyConcept({});
  assert.equal(a.acciones, null);
  assert.match(a.motivo, /no reporta dei:EntityCommonStockSharesOutstanding/);
});

// ── EL VEREDICTO ───────────────────────────────────────────────────────
test('dentro del 10% queda verificada y la cap que viaja es EDGAR × nuestro cierre', () => {
  // ORCL en la auditoría: 10.69% contra Finnhub. Con las acciones de la
  // portada el desajuste baja y entra — que es justo el caso que el 5% de G2
  // habría dejado gris sin que nadie tuviera nada que arreglar.
  const v = veredictoCapEdgar({
    symbol: 'ORCL', declarada_usd: 1_050e9, acciones_edgar: 2_800_000_000,
    precio_usd: 360, fecha_portada: '2025-08-31',
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.cap_usd, 2_800_000_000 * 360, 'el número pintado es el nuestro, no el declarado');
  assert.equal(v.fuente, 'calc: edgar×neon');
  assert.equal(v.fecha_portada, '2025-08-31', 'la portada viaja pegada al número');
  assert.ok(Math.abs(v.error_pct) <= 10);
});

test('un split 2:1 sigue siendo gris: 100 puntos de error no los tapa el 10%', () => {
  const v = veredictoCapEdgar({
    symbol: 'MNST', declarada_usd: 60e9, acciones_edgar: 500_000_000, precio_usd: 57.7,
    fecha_portada: '2025-07-31',
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null, 'sin tamaño antes que con un tamaño inventado');
  assert.ok(v.multiplo > 1.9 && v.multiplo < 2.3, `multiplo ${v.multiplo}`);
  assert.match(v.motivo, /techo propio 10%/);
});

test('sin acciones de EDGAR, o sin cierre nuestro, es insumo que falta y no hallazgo', () => {
  const sinAcc = veredictoCapEdgar({ symbol: 'X', declarada_usd: 10e9, acciones_edgar: null, precio_usd: 10 });
  assert.equal(sinAcc.estado, 'gris_punteado');
  assert.equal(sinAcc.auditable, false);
  assert.match(sinAcc.motivo, /no dio acciones/);

  const sinPx = veredictoCapEdgar({ symbol: 'X', declarada_usd: 10e9, acciones_edgar: 1e9, precio_usd: null });
  assert.equal(sinPx.auditable, false);
  assert.match(sinPx.motivo, /cierre nuestro/);
});

test('una sola fuente no se verifica a sí misma, tampoco EDGAR', () => {
  const v = veredictoCapEdgar({ symbol: 'X', declarada_usd: null, acciones_edgar: 1e9, precio_usd: 10 });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /ninguna cap declarada/);
});

// ═══════════════════════════════════════════════════════════════════════
// EL CERO QUE NO SE PUDO DEPURAR
//
// Corrida del 2026-09-25: `candidatos: 0` con 21 hallazgos en USD en el
// universo. La causa fue un descarte silencioso —`num(null)` devuelve 0, no
// null, porque `Number(null)` es 0—, así que el filtro
// `num(acciones_edgar_millones) == null` daba false para las 21 filas con la
// columna vacía y las tiraba como si ya tuvieran su conteo de EDGAR.
// ═══════════════════════════════════════════════════════════════════════
import { candidatosParaEdgar } from '../api/_lib/mercado-edgar.js';

const gris = (symbol, moneda = 'USD') => ({ symbol, moneda, estado: 'gris_punteado', auditable: true });
const entrada = (symbol, extra = {}) => ({ symbol, precio_usd: 100, acciones: 500, ...extra });

test('una columna acciones_edgar_millones NULL no descarta al candidato', () => {
  // Es lo que Postgres devuelve para la columna vacía: null, no undefined.
  const r = candidatosParaEdgar({
    entradas: [entrada('MNST'), entrada('APH'), entrada('ORCL')],
    veredictos: [gris('MNST'), gris('APH'), gris('ORCL')],
    universoPorSymbol: new Map([
      ['MNST', { acciones_edgar_millones: null }],
      ['APH', { acciones_edgar_millones: null }],
      ['ORCL', {}],
    ]),
  });
  assert.deepEqual(r.candidatos, ['MNST', 'APH', 'ORCL']);
  assert.equal(r.diagnostico.candidatos, 3);
  assert.equal(r.diagnostico.ya_con_edgar, 0);
});

test('el que YA tiene conteo de EDGAR sí se descarta, y se dice', () => {
  const r = candidatosParaEdgar({
    entradas: [entrada('MNST')],
    veredictos: [gris('MNST')],
    universoPorSymbol: new Map([['MNST', { acciones_edgar_millones: 1040 }]]),
  });
  assert.deepEqual(r.candidatos, []);
  assert.equal(r.diagnostico.ya_con_edgar, 1);
});

test('cada descarte se cuenta por su causa: un cero tiene que poder depurarse', () => {
  const r = candidatosParaEdgar({
    entradas: [
      entrada('SINPX', { precio_usd: null }),
      entrada('SINACC', { acciones: null }),
      entrada('NVDA'),
      entrada('TSM'),
      entrada('MNST'),
    ],
    veredictos: [
      gris('SINPX'), gris('SINACC'),
      { symbol: 'NVDA', moneda: 'USD', estado: 'verificada', auditable: true },
      gris('TSM', 'TWD'),
      gris('MNST'),
    ],
    universoPorSymbol: new Map(),
  });
  assert.deepEqual(r.candidatos, ['MNST']);
  assert.deepEqual(r.diagnostico, {
    filas: 5, sin_precio: 1, sin_acciones: 1, verificadas: 1, no_usd: 1, ya_con_edgar: 0, candidatos: 1,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LA FORMA DE LA RESPUESTA — EL TypeError QUE SE LLEVÓ 21 SÍMBOLOS
//
// Corrida del 2026-09-26 en prod: `TypeError: unidades.filter is not a
// function` en la primera respuesta, y con ella los 21 candidatos. El lector
// daba por hecho dos cosas de `units`: que la clave se llama `shares` y que su
// valor es un arreglo. Ninguna de las dos es un invariante de la fuente — el
// resto de esta casa nunca lo dio por hecho (`mercado-fase0.js:622` y
// `historia-ingesta.js:183` recorren `Object.entries(units)`).
//
// ADVERTENCIA SOBRE ESTE FIXTURE, que hay que leer antes de creerle: este
// contenedor NO tiene salida a sec.gov —el proxy deniega el CONNECT a
// data.sec.gov:443 por política, igual que documenta docs/historia-fase0.md
// §0— así que NO está grabado de una llamada real. Está reconstruido del
// esquema que publica la SEC para `companyconcept` y del que ya consume el
// código probado de este repo, recortado a tres hechos. La primera corrida en
// prod con `fallas` en la salida dirá la forma REAL si todavía no coincide:
// para eso el motivo ahora arrastra la huella de `units`.
// ═══════════════════════════════════════════════════════════════════════
import { filasDeUnits, formaDeUnits, estadoEdgar, ESTADOS_EDGAR } from '../api/_lib/mercado-edgar.js';

const COMPANYCONCEPT_ORCL = {
  cik: 1341439,
  taxonomy: 'dei',
  tag: 'EntityCommonStockSharesOutstanding',
  label: 'Entity Common Stock, Shares Outstanding',
  description: 'Indicate number of shares or other units outstanding of each of registrant\'s classes of capital or common stock...',
  entityName: 'Oracle Corporation',
  units: {
    shares: [
      { end: '2025-03-07', val: 2_802_000_000, accn: '0000950170-25-034563', fy: 2025, fp: 'Q3', form: '10-Q', filed: '2025-03-11', frame: 'CY2025Q1I' },
      { end: '2025-06-13', val: 2_811_000_000, accn: '0000950170-25-085487', fy: 2025, fp: 'FY', form: '10-K', filed: '2025-06-20' },
      { end: '2025-09-05', val: 2_818_000_000, accn: '0000950170-25-121463', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2025-09-09' },
    ],
  },
};

test('la forma real de companyconcept se lee, y gana el filing más nuevo', () => {
  const a = accionesDeCompanyConcept(COMPANYCONCEPT_ORCL);
  assert.equal(a.acciones, 2_818_000_000);
  assert.equal(a.form, '10-Q');
  assert.equal(a.fecha_portada, '2025-09-05');
  assert.equal(a.presentado_en, '2025-09-09');
  assert.equal(a.unidad, 'shares', 'se dice de qué clave de unidad salió');
});

test('`units` con un valor que NO es arreglo ya no tira TypeError', () => {
  // Es el caso exacto que mató la corrida. Lo que tiene que pasar es un motivo
  // con la huella de la forma, no una excepción.
  for (const units of [{ shares: null }, { shares: 42 }, { shares: { 0: {} } }, {}, null, [], 'shares']) {
    const a = accionesDeCompanyConcept({ units });
    assert.equal(a.acciones, null, `units=${JSON.stringify(units)}`);
    assert.equal(typeof a.motivo, 'string');
  }
  // Y la huella dice QUÉ llegó: un TypeError en el log sólo dice que algo no
  // era un arreglo.
  const a = accionesDeCompanyConcept({ units: { shares: 42 } });
  assert.match(a.motivo, /units: objeto con \{shares: number\}/);
});

test('si la clave de unidad no es "shares", se usa la que traiga el arreglo y se dice cuál', () => {
  const a = accionesDeCompanyConcept({
    units: { 'shares/item': [{ end: '2025-09-05', val: 10, form: '10-Q', filed: '2025-09-09' }] },
  });
  assert.equal(a.acciones, 10);
  assert.equal(a.unidad, 'shares/item');
});

test('se prefiere `shares` cuando hay varias unidades', () => {
  const { filas, unidad } = filasDeUnits({ units: { USD: [{ val: 1 }, { val: 2 }], shares: [{ val: 9 }] } });
  assert.equal(unidad, 'shares');
  assert.equal(filas.length, 1);
});

test('la huella de units nombra cada caso sin volcar la respuesta entera', () => {
  assert.equal(formaDeUnits(undefined), 'respuesta: undefined');
  assert.equal(formaDeUnits(null), 'respuesta: null');
  assert.equal(formaDeUnits({}), 'sin campo units');
  assert.equal(formaDeUnits({ units: null }), 'units: null');
  assert.equal(formaDeUnits({ units: [1, 2, 3] }), 'units: arreglo de 3');
  assert.equal(formaDeUnits({ units: 'x' }), 'units: string');
  assert.equal(formaDeUnits(COMPANYCONCEPT_ORCL), 'units: objeto con {shares: arreglo de 3}');
});

// ═══════════════════════════════════════════════════════════════════════
// TRES ESTADOS: NO CONSULTADO ≠ CONSULTADO SIN DATO
//
// El mapa decía de ORCL, MNST y APH "EDGAR no dio acciones en circulación"
// cuando EDGAR nunca fue consultado —el job había muerto—. Una causa falsa
// manda a revisar la fuente en lugar del job, y es la peor clase de gris: el
// que parece resuelto.
// ═══════════════════════════════════════════════════════════════════════
test('sin consulta la causa es una TAREA, no una acusación a EDGAR', () => {
  const e = estadoEdgar({});
  assert.equal(e.estado, 'no_consultado');
  assert.match(e.frase, /pendiente de consulta a EDGAR/);
  assert.doesNotMatch(e.frase, /no dio/, 'no se le puede achacar nada a quien no se le preguntó');
});

test('consultado sin dato dice CUÁNDO se preguntó y QUÉ contestó', () => {
  const e = estadoEdgar({ consultada_en: '2026-09-27T14:03:00.000Z', motivo: 'sin CIK en el índice de la SEC' });
  assert.equal(e.estado, 'consultado_sin_dato');
  assert.equal(e.consultada_en, '2026-09-27');
  assert.match(e.frase, /consultado el 2026-09-27/);
  assert.match(e.frase, /sin CIK en el índice de la SEC/);
});

test('un conteo de 0 no es un conteo: `num(null)` da 0 y ésa ya costó cuatro bugs', () => {
  assert.equal(estadoEdgar({ acciones: 0, consultada_en: '2026-09-27' }).estado, 'consultado_sin_dato');
  assert.equal(estadoEdgar({ acciones: 0 }).estado, 'no_consultado');
  assert.equal(estadoEdgar({ acciones: 2_818_000_000 }).estado, 'consultado_con_dato');
  assert.deepEqual(ESTADOS_EDGAR, ['no_consultado', 'consultado_sin_dato', 'consultado_con_dato']);
});
