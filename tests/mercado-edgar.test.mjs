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

// ═══════════════════════════════════════════════════════════════════════
// CORRIDA DEL 2026-09-28 — CUATRO CASOS DE LA REALIDAD
//
// 27 consultas, 15 con conteo, 12 sin, 0 excepciones. De las que resolvieron
// salieron cuatro cosas que el lector no sabía hacer.
// ═══════════════════════════════════════════════════════════════════════
import {
  UMBRAL_ACUERDO_ACCIONES_PCT, MAX_MESES_PORTADA, mesesEntre, muestraCruda,
} from '../api/_lib/mercado-edgar.js';

const HOY = new Date('2026-09-29T12:00:00Z');

// ── 1. MNST, APH, VMRK: dos conteos que coinciden ─────────────────────
// EDGAR × cierre da 2× la cap declarada, y Finnhub × cierre da TAMBIÉN 2×.
// Los dos conteos concuerdan entre sí; la que se sale es la cap declarada.
test('dos conteos de acciones que coinciden descartan la cap declarada', () => {
  const casos = [
    { symbol: 'MNST', declarada_usd: 60e9, acciones_edgar: 2_080_000_000, acciones_finnhub: 2_075_000_000, precio_usd: 57.7 },
    { symbol: 'APH', declarada_usd: 120e9, acciones_edgar: 1_204_000_000, acciones_finnhub: 1_190_000_000, precio_usd: 199.3 },
    { symbol: 'VMRK', declarada_usd: 10e9, acciones_edgar: 435_000_000, acciones_finnhub: 428_000_000, precio_usd: 46 },
  ];
  for (const c of casos) {
    const v = veredictoCapEdgar({ ...c, fecha_portada: '2026-07-31' });
    assert.equal(v.estado, 'verificada', `${c.symbol}: ${v.motivo}`);
    assert.equal(v.via, 'edgar_acuerdo_acciones', c.symbol);
    assert.equal(v.fuente, 'calc: edgar×neon', c.symbol);
    // El tamaño es el NUESTRO: acciones de la portada × nuestro cierre.
    assert.equal(v.cap_usd, c.acciones_edgar * c.precio_usd, c.symbol);
    assert.match(v.nota, /cap declarada de Finnhub descartada: dos conteos de acciones coinciden/, c.symbol);
    // Y el desajuste con la declarada queda dicho, no borrado: es lo que
    // explica por qué la fuente dice edgar.
    assert.ok(Math.abs(v.error_pct) > UMBRAL_EDGAR_PCT, `${c.symbol}: ${v.error_pct}`);
    assert.ok(v.multiplo < 0.6, `${c.symbol}: múltiplo ${v.multiplo} — el patrón del split 2:1`);
  }
});

test('si los dos conteos NO coinciden, la cap declarada sigue siendo el árbitro', () => {
  // 25% entre conteos: acá no hay acuerdo que descarte nada, y el veredicto
  // vuelve al contraste normal contra la declarada, que falla su techo.
  const v = veredictoCapEdgar({
    symbol: 'X', declarada_usd: 10e9, acciones_edgar: 100_000_000,
    acciones_finnhub: 80_000_000, precio_usd: 46, fecha_portada: '2026-07-31',
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /techo propio 10%/);
});

test('el umbral de acuerdo entre conteos es 5% y NO es el de G2 ni el de EDGAR', () => {
  assert.equal(UMBRAL_ACUERDO_ACCIONES_PCT, 5);
  // Coincide en número con el de G2, y aun así es otra constante: G2 compara
  // caps, esto compara conteos de acciones. Unificarlas es cómo se pierde de
  // vista cuál se está aflojando.
  assert.notEqual(UMBRAL_ACUERDO_ACCIONES_PCT, UMBRAL_EDGAR_PCT);
  // Justo afuera del techo no se verifica.
  const v = veredictoCapEdgar({
    symbol: 'X', declarada_usd: 10e9, acciones_edgar: 1_000_000_000,
    acciones_finnhub: 940_000_000, precio_usd: 20, fecha_portada: '2026-07-31',
  });
  assert.notEqual(v.via, 'edgar_acuerdo_acciones', '6% de diferencia no es coincidir');
});

test('sin conteo de Finnhub la regla no se activa sola', () => {
  // `num(null)` es 0: si el guardia fuera `!= null`, un símbolo sin conteo de
  // Finnhub entraría como "0 acciones" y el acuerdo saldría -100%, no 0%.
  for (const accF of [null, undefined, 0]) {
    const v = veredictoCapEdgar({
      symbol: 'X', declarada_usd: 10e9, acciones_edgar: 100_000_000,
      acciones_finnhub: accF, precio_usd: 46, fecha_portada: '2026-07-31',
    });
    assert.notEqual(v.via, 'edgar_acuerdo_acciones', String(accF));
  }
});

// ── 2. CMCSA: una portada de 2009 ─────────────────────────────────────
test('una portada de hace 17 años NO sostiene un tamaño, y la causa dice el año', () => {
  const a = accionesDeCompanyConcept({
    units: { shares: [{ end: '2009-12-31', val: 2_800_000_000, form: '10-K', filed: '2010-02-19' }] },
  }, { hoy: HOY });
  assert.equal(a.acciones, null, 'sin conteo antes que con uno de otra época');
  assert.match(a.motivo, /EDGAR sólo tiene portada de 2009/);
  assert.match(a.motivo, /2009-12-31/);
  assert.equal(a.fecha_portada, '2009-12-31', 'la fecha viaja igual: es el dato accionable');
  assert.ok(a.meses_de_antiguedad > 190, `${a.meses_de_antiguedad}`);
});

test('el techo de antigüedad es 15 meses, y una portada del trimestre pasa', () => {
  assert.equal(MAX_MESES_PORTADA, 15);
  const reciente = accionesDeCompanyConcept({
    units: { shares: [{ end: '2026-07-31', val: 1_000, form: '10-Q', filed: '2026-08-05' }] },
  }, { hoy: HOY });
  assert.equal(reciente.acciones, 1_000);
  assert.equal(reciente.meses_de_antiguedad, 2);

  // 15 meses justos pasan; 16 no. El borde se prueba para que mover el número
  // sea una decisión y no un efecto secundario.
  const justo = accionesDeCompanyConcept({
    units: { shares: [{ end: '2025-07-15', val: 5, form: '10-K', filed: '2025-08-01' }] },
  }, { hoy: HOY });
  assert.equal(justo.acciones, 5, `${justo.meses_de_antiguedad} meses`);
  const pasado = accionesDeCompanyConcept({
    units: { shares: [{ end: '2025-04-15', val: 5, form: '10-K', filed: '2025-05-01' }] },
  }, { hoy: HOY });
  assert.equal(pasado.acciones, null, `${pasado.meses_de_antiguedad} meses`);
});

test('mesesEntre no inventa un número cuando la fecha no se puede leer', () => {
  assert.equal(mesesEntre(null, HOY), null);
  assert.equal(mesesEntre('no es fecha', HOY), null);
  assert.ok(Math.abs(mesesEntre('2026-08-29', HOY) - 1) < 0.1);
});

// ── 3. BE: `units: {shares: object}` ──────────────────────────────────
test('un OBJETO de hechos también se lee, y se dice que vino así', () => {
  // La huella de BE decía `units: objeto con {shares: object}`: el lector ya no
  // reventaba, pero devolvía cero filas porque sólo entendía arreglos.
  const a = accionesDeCompanyConcept({
    units: {
      shares: {
        '0': { end: '2026-01-31', val: 220_000_000, form: '10-Q', filed: '2026-02-04' },
        '1': { end: '2026-07-31', val: 231_000_000, form: '10-Q', filed: '2026-08-06' },
      },
    },
  }, { hoy: HOY });
  assert.equal(a.acciones, 231_000_000, 'gana el filed más nuevo, igual que con un arreglo');
  assert.equal(a.unidad, 'shares');
  assert.match(a.forma, /objeto con 2 de 2 valores con pinta de hecho/);
});

test('un objeto que NO son hechos no se convierte en hechos', () => {
  // Fallar closed: un diccionario cualquiera bajo `shares` no es una colección
  // de conteos, y tratarlo como tal fabricaría un número.
  const a = accionesDeCompanyConcept({ units: { shares: { label: 'x', description: 'y' } } }, { hoy: HOY });
  assert.equal(a.acciones, null);
  assert.match(a.motivo, /no reporta dei:EntityCommonStockSharesOutstanding/);
  // Y la huella ahora dice las CLAVES, no sólo "object", que fue lo que no
  // alcanzó para entender BE.
  assert.match(a.motivo, /objeto con claves \{label\|description\}/);
});

test('la muestra cruda viaja recortada, para poder MIRAR lo que llegó', () => {
  const grande = { units: { shares: Array.from({ length: 200 }, (_, i) => ({ end: '2026-01-01', val: i })) } };
  const m = muestraCruda(grande, 120);
  assert.ok(m.length < 200, `${m.length}`);
  assert.match(m, /caracteres en total/);
  assert.match(muestraCruda({ units: { shares: { a: 1 } } }), /^\{"units":\{"shares":\{"a":1\}\}\}$/);
});

// ── 4. BX: varias clases de acciones ──────────────────────────────────
test('varias clases en la misma portada: NO se elige una ni se suman', () => {
  const a = accionesDeCompanyConcept({
    units: {
      shares: [
        { end: '2026-07-31', val: 720_000_000, form: '10-Q', filed: '2026-08-05' },
        { end: '2026-07-31', val: 490_000_000, form: '10-Q', filed: '2026-08-05' },
      ],
    },
  }, { hoy: HOY });
  assert.equal(a.acciones, null, 'tomar una contaría de menos; sumarlas sería adivinar');
  assert.equal(a.clases, 2);
  assert.deepEqual(a.conteos, [720_000_000, 490_000_000]);
  assert.match(a.motivo, /2 conteos distintos para la portada del 2026-07-31/);
  assert.match(a.motivo, /varias clases/);
});

test('el MISMO conteo repetido no es varias clases', () => {
  // EDGAR repite el mismo hecho en varios filings. Dos copias del mismo número
  // no son dos clases, y confundirlas mandaría a gris a media bolsa.
  const a = accionesDeCompanyConcept({
    units: {
      shares: [
        { end: '2026-07-31', val: 500_000_000, form: '10-Q', filed: '2026-08-05' },
        { end: '2026-07-31', val: 500_000_000, form: '10-Q', filed: '2026-08-05' },
      ],
    },
  }, { hoy: HOY });
  assert.equal(a.acciones, 500_000_000);
});
