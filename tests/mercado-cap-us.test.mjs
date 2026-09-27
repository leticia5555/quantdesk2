// ═══════════════════════════════════════════════════════════════════════
// LA CAP DE LOS ADR — el caso TSM
//
// El mapa dimensiona por capitalización. Una cap mal medida no es un número
// feo: es el cuadro más grande de la pantalla mintiendo de tamaño. Estas
// pruebas fijan que el desajuste se detecte SIN saber de antemano de dónde
// viene, y que un ADR sin confirmar salga gris punteado en vez de grande.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { veredictoCapUs, auditaCapUs, candidatasCapUs } from '../api/_lib/mercado-cap-us.js';

// Una estadounidense sana: la declarada en USD cuadra con acciones×precio.
const NVDA = { symbol: 'NVDA', moneda: 'USD', declarada: 4_000_000, acciones: 24_400, precio_usd: 163.93 };

test('una emisora en USD cuyas dos fuentes cuadran sale VERIFICADA', () => {
  const v = veredictoCapUs(NVDA);
  assert.equal(v.estado, 'verificada');
  assert.equal(v.motivo, null);
  assert.ok(Math.abs(v.error_pct) <= 5, `error ${v.error_pct}`);
  assert.ok(v.cap_usd > 0, 'la cap verificada viaja para dimensionar el cuadro');
});

test('la cap que viaja es la DECLARADA, no un promedio de las dos', () => {
  const v = veredictoCapUs(NVDA);
  // Promediar dos fuentes fabricaría un número que ninguna midió.
  assert.equal(v.cap_usd, NVDA.declarada * 1e6);
});

// ── EL CASO QUE DESTAPÓ EL TELÉFONO ────────────────────────────────────
test('una cap declarada en otra moneda sale GRIS y el motivo nombra la moneda', () => {
  // La forma del bug de TSM: la cap viene en la moneda de reporte y se guardó
  // como si fueran dólares. El número exacto da igual — lo que importa es que
  // no concuerde con acciones×precio y que la moneda lo explique.
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD',
    declarada: 32_000_000,          // millones de TWD
    acciones: 5_190, precio_usd: 200,
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null, 'sin tamaño antes que con un tamaño inventado');
  assert.match(v.motivo, /TWD/);
});

test('el múltiplo delata de qué tipo es el desajuste', () => {
  const v = veredictoCapUs({ symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, acciones: 5_190, precio_usd: 200 });
  // ~30× apunta a tipo de cambio; ~5× a ratio de ADR; ~1e6 a unidades.
  assert.ok(v.multiplo > 20 && v.multiplo < 45, `multiplo ${v.multiplo}`);
});

test('aunque la moneda sea USD, un desajuste >5% sale gris', () => {
  // El ratio del ADR es la otra trampa, y no la delata la moneda.
  const v = veredictoCapUs({ symbol: 'ADR', moneda: 'USD', declarada: 1_000_000, acciones: 1_000, precio_usd: 200 });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /difiere/);
});

// ── FALLAR CERRADO ─────────────────────────────────────────────────────
test('moneda desconocida NO se asume USD, y la causa nombra la fuente', () => {
  // Suponer USD es exactamente la suposición que rompió el mapa.
  // XNDU (Xanadu Quantum Technologies, XLK) es el caso real: su cap entró por
  // `neon:arena_market_cap`, un camino que nunca guardó `profile2.currency`.
  // Decisión de Lety del 2026-09-26: NO sale del universo, se dibuja gris con
  // la causa dicha. Y la causa nombra de dónde vino la cap, para no acusar a
  // Finnhub de un dato que no dio él.
  const v = veredictoCapUs({
    symbol: 'XNDU', declarada: 3_200, acciones: 290, precio_usd: 11,
    fuente_declarada: 'neon:arena_market_cap',
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /sin moneda declarada por Finnhub/);
  assert.match(v.motivo, /neon:arena_market_cap/);

  // Sin fuente declarada no se inventa un paréntesis vacío.
  const sinFuente = veredictoCapUs({ symbol: 'X', declarada: 1_000, acciones: 10, precio_usd: 100 });
  assert.equal(sinFuente.motivo, 'sin moneda declarada por Finnhub');
});

test('una sola fuente nunca se verifica a sí misma', () => {
  const soloDeclarada = veredictoCapUs({ symbol: 'A', moneda: 'USD', declarada: 1_000 });
  assert.equal(soloDeclarada.estado, 'gris_punteado');
  assert.match(soloDeclarada.motivo, /no se puede reconstruir/);

  const soloRecon = veredictoCapUs({ symbol: 'B', moneda: 'USD', acciones: 10, precio_usd: 100 });
  assert.equal(soloRecon.estado, 'gris_punteado');
  assert.match(soloRecon.motivo, /segunda fuente/);
});

test('sin ninguna fuente lo dice, no truena', () => {
  const v = veredictoCapUs({ symbol: 'C' });
  assert.equal(v.estado, 'gris_punteado');
  assert.match(v.motivo, /ninguna fuente/);
});

test('candidatasCapUs no marca como USD una declarada sin moneda', () => {
  const [decl] = candidatasCapUs({ declarada: 100, acciones: 1, precio_usd: 1 });
  assert.equal(decl.usd, false);
});

// ── LA AUDITORÍA, que es lo que hay que reportar ───────────────────────
test('la auditoría cuenta, agrupa por moneda y ordena por el que más miente', () => {
  const a = auditaCapUs([
    NVDA,
    { symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, acciones: 5_190, precio_usd: 200 },
    { symbol: 'SAP', moneda: 'EUR', declarada: 300_000, acciones: 1_200, precio_usd: 250 },
    { symbol: 'MSFT', moneda: 'USD', declarada: 3_700_000, acciones: 7_430, precio_usd: 498 },
  ]);
  assert.equal(a.total, 4);
  assert.equal(a.gris_punteado, 2, 'los dos no-USD');
  assert.equal(a.verificadas, 2);
  assert.equal(a.no_usd, 2);
  assert.deepEqual(a.por_moneda, { USD: 2, TWD: 1, EUR: 1 });
  assert.equal(a.umbral_pct, 5, 'el umbral es el congelado de G2, no uno nuevo');
  assert.equal(a.peores[0].symbol, 'TSM', 'el que más miente de tamaño va primero');
});

// ═══════════════════════════════════════════════════════════════════════
// LA RAZÓN DEL ADR, Y EL ORDEN DE PRECEDENCIA
//
// La referencia manual de Yahoo NO SE PINTA: despeja la razón y nada más. Lo
// que el mapa dibuja es `acciones ÷ razón × nuestro cierre`, así que el cuadro
// sigue al mercado en vez de quedarse clavado en la fecha de captura.
// ═══════════════════════════════════════════════════════════════════════
import { razonAdr, referenciaVigente, vigenciaReferenciasUs, cierreHasta, filaVeredictoCapUs, MILLON } from '../api/_lib/mercado-cap-us.js';

// Un ADR de 5 ordinarias por ADR: 5,190M ordinarias, ADR a 200 USD, y una
// referencia que dice que la empresa vale 5,190M/5 × 200.
const TSM = { acciones: 5_190, precio_usd: 200 };
const REF_TSM = {
  // 1% arriba de la razón exacta, como una captura de verdad: la razón sigue
  // resolviendo a 5:1 y la cap pintada NO coincide con la referencia.
  clave: 'TSM', market_cap_usd: ((TSM.acciones * MILLON * TSM.precio_usd) / 5) * 1.01,
  fuente: 'yahoo-finance-market-cap-intraday', capturada_en: '2026-09-23', vigente_hasta: '2026-09-30',
};
const HOY = new Date('2026-09-24T12:00:00Z');

test('la razón se despeja y sale una proporción de ADR, no un decimal suelto', () => {
  const r = razonAdr({ cap_referencia_usd: REF_TSM.market_cap_usd, acciones_millones: TSM.acciones, precio_usd: TSM.precio_usd });
  assert.equal(r.ok, true);
  assert.equal(r.razon, 5);
  assert.equal(r.etiqueta, '5:1');
});

test('una razón que no se parece a ninguna proporción NO se fuerza a la más cercana', () => {
  // Captura vieja, o acciones de otra clase: el desajuste no es una razón de
  // ADR y darle un tamaño igual sería el bug que esto vino a cerrar.
  const r = razonAdr({ cap_referencia_usd: REF_TSM.market_cap_usd / 1.13, acciones_millones: TSM.acciones, precio_usd: TSM.precio_usd });
  assert.equal(r.ok, false);
  assert.equal(r.razon, null);
  assert.match(r.motivo, /no se parece a ninguna proporción/);
});

test('con referencia vigente la cap pintada es NUESTRO cálculo, no la referencia', () => {
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    precio_captura: TSM.precio_usd, referencia: REF_TSM, hoy: HOY,
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.cap_usd, (TSM.acciones * MILLON * TSM.precio_usd) / 5);
  assert.equal(v.fuente, 'calc: acciones÷5:1×neon');
  assert.equal(v.via, 'referencia_manual');
  // Y la cap de referencia no viaja al render en ningún campo.
  assert.equal(JSON.stringify(v).includes(String(REF_TSM.market_cap_usd)), false,
    'la referencia manual nunca se pinta: sólo el veredicto');
});

// ── VENCER NO APAGA EL CUADRO ──────────────────────────────────────────
// La primera versión ponía gris al vencer la referencia, que es la trampa de
// los 14 días de #248 con otro disfraz: un reloj que apaga datos buenos solo.
// La razón del ADR es ESTRUCTURAL; lo que envejece es la cap de Yahoo, y la cap
// de Yahoo no se pinta.
test('una referencia vencida SIGUE dibujando el cuadro, y se anota para recapturar', () => {
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    precio_captura: TSM.precio_usd,
    referencia: { ...REF_TSM, vigente_hasta: '2026-06-30' }, hoy: HOY,
  });
  assert.equal(v.estado, 'verificada', 'el cuadro no se apaga por el calendario');
  assert.equal(v.cap_usd, (TSM.acciones * MILLON * TSM.precio_usd) / 5);
  assert.equal(v.referencia_a_recapturar, true, 'pero la tarea queda dicha');
  assert.equal(v.referencia_vigente_hasta, '2026-06-30');
  assert.equal(v.motivo, null, 'una tarea pendiente no es un motivo de gris');
});

test('lo único que pone gris es que la razón deje de parecerse a una proporción', () => {
  // Un split del ADR, un cambio de ratio, una captura mal leída: ahí sí cambió
  // algo de verdad y el tamaño deja de estar sostenido.
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    precio_captura: TSM.precio_usd,
    referencia: { ...REF_TSM, market_cap_usd: REF_TSM.market_cap_usd / 1.13 }, hoy: HOY,
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /no se parece a ninguna proporción/);
});

test('referenciaVigente marca la tarea, no una falla', () => {
  const sinFecha = referenciaVigente({ clave: 'X', market_cap_usd: 1 }, HOY);
  assert.equal(sinFecha.a_recapturar, true);
  assert.match(sinFecha.motivo, /no declara hasta cuándo/);

  const vencida = referenciaVigente({ clave: 'X', market_cap_usd: 1, vigente_hasta: '2026-06-30' }, HOY);
  assert.equal(vencida.a_recapturar, true);
  assert.match(vencida.motivo, /sigue dibujándose/);
});

test('la lista para cron-status no lleva alerta: una tarea con fecha no es un rojo', () => {
  const v = vigenciaReferenciasUs({
    referencias: [
      { clave: 'TSM', vigente_hasta: '2026-12-31', fuente: 'yahoo', capturada_en: '2026-09-23' },
      { clave: 'VALE', vigente_hasta: '2026-06-30', fuente: 'yahoo', capturada_en: '2026-06-01' },
    ],
  }, HOY);
  assert.equal(v.filas, 2);
  assert.equal(v.vigentes, 1);
  assert.deepEqual(v.a_recapturar.map((r) => r.clave), ['VALE']);
  assert.equal(v.a_recapturar[0].mapa, 'us');
  assert.equal(v.alerta, false, 'no puede poner en rojo el tablero: no rompe nada');
});

// ── EDGAR entra SÓLO como segunda oportunidad ──────────────────────────
test('si el par de Finnhub ya concuerda, EDGAR no cambia nada', () => {
  // Las 279 verificadas de la auditoría no se mueven de fuente por haber
  // agregado un árbitro: nadie reportó que estuvieran rotas.
  const v = veredictoCapUs({ ...NVDA, edgar: { acciones: 1, fecha_portada: '2025-08-01' } });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.via, 'finnhub');
  assert.equal(v.cap_usd, NVDA.declarada * 1e6);
});

test('cuando Finnhub no concuerda, EDGAR decide y la fuente lo dice', () => {
  const v = veredictoCapUs({
    symbol: 'MNST', moneda: 'USD', declarada: 60_000, acciones: 500, precio_usd: 57.7,
    edgar: { acciones: 1_040_000_000, fecha_portada: '2025-07-31' },
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.via, 'edgar');
  assert.equal(v.fuente, 'calc: edgar×neon');
  assert.equal(v.cap_usd, 1_040_000_000 * 57.7);
  assert.ok(Math.abs(v.finnhub_error_pct) > 5, 'el desajuste con Finnhub queda dicho, no se borra');
});

test('si EDGAR tampoco cuadra, gris con las DOS causas', () => {
  const v = veredictoCapUs({
    symbol: 'VMRK', moneda: 'USD', declarada: 10_000, acciones: 100, precio_usd: 46,
    edgar: { acciones: 100_000_000, fecha_portada: '2025-07-31' },
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /techo propio 10%/);
  assert.match(v.motivo, /contra Finnhub/);
});

// ── LA RAZÓN SE DESPEJA CON EL CIERRE DE SU FECHA ──────────────────────
// El caso ASML del 2026-09-25: la cap de Yahoo es del 23 y el job la contrastó
// con el cierre del 25. Razón cruda 1.023 → falla el techo del 2% y una emisora
// sana se va a gris. Misma regla de #248: la referencia se contrasta con el dato
// de SU fecha.
test('la razón usa el cierre del día de la captura, no el de hoy', () => {
  const acciones = 400;              // millones
  const pxCaptura = 1000;            // cierre del 2026-09-23
  const pxHoy = 1023;                // +2.3% al 2026-09-25
  const ref = {
    clave: 'ASML', market_cap_usd: acciones * MILLON * pxCaptura, // razón exacta 1:1
    fuente: 'yahoo-finance-market-cap-intraday', capturada_en: '2026-09-23', vigente_hasta: '2026-09-30',
  };

  const bien = veredictoCapUs({
    symbol: 'ASML', moneda: 'EUR', declarada: 500_000, acciones,
    precio_usd: pxHoy, precio_captura: pxCaptura, referencia: ref, hoy: HOY,
  });
  assert.equal(bien.estado, 'verificada');
  assert.equal(bien.razon_adr, 1, 'resuelve 1:1');
  // Y el tamaño que se pinta sigue el mercado: usa el cierre de HOY.
  assert.equal(bien.cap_usd, acciones * MILLON * pxHoy);

  // Con el precio de hoy como si fuera el de la captura, la razón cruda se va a
  // 1.023 y la emisora cae a gris: el bug que esto arregla.
  const mal = razonAdr({ cap_referencia_usd: ref.market_cap_usd, acciones_millones: acciones, precio_usd: pxHoy });
  assert.equal(mal.ok, false);
  assert.ok(Math.abs(mal.error_pct - 2.3) < 0.1, `error ${mal.error_pct}`);
});

test('sin el cierre de la fecha de captura NO se sustituye por el de hoy: gris con causa', () => {
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    precio_captura: null, referencia: REF_TSM, hoy: HOY,
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /cierre del 2026-09-23/);
});

test('cierreHasta toma el último cierre en o antes de la fecha, nunca uno posterior', () => {
  const filas = [
    { fecha: '2026-09-21', cierre: 10 },
    { fecha: '2026-09-23', cierre: 12 },
    { fecha: '2026-09-25', cierre: 99 },
  ];
  assert.deepEqual(cierreHasta(filas, '2026-09-23'), { fecha: '2026-09-23', cierre: 12 });
  // Sábado: cae al viernes, no al lunes siguiente.
  assert.deepEqual(cierreHasta(filas, '2026-09-24'), { fecha: '2026-09-23', cierre: 12 });
  assert.equal(cierreHasta(filas, '2026-09-20'), null);
});

// ═══════════════════════════════════════════════════════════════════════
// LA FILA DE EDGAR QUE NO EXISTÍA — `num(null) === 0`, CUARTA VEZ
//
// El mapa decía de ORCL, MNST y APH "EDGAR no dio acciones en circulación" sin
// que EDGAR hubiera sido consultado nunca: el job había muerto antes. La causa
// era doble y las dos mitades se prueban acá.
//
// Mitad 1: `filaVeredictoCapUs` preguntaba `num(acciones_edgar_millones) != null`
// y `num(null)` devuelve **0** —`Number(null)` es 0—, así que la columna vacía
// entraba como "EDGAR dio 0 acciones" para las 569 emisoras. Peor que la causa
// falsa: `veredictoCapEdgar` devuelve `auditable: false` sin acciones, así que
// los 21 hallazgos en USD se contaron como "insumos que faltan" y la auditoría
// reportó 3 donde había 21.
//
// Mitad 2: aunque el guardia estuviera bien, la columna vacía no distingue
// "todavía no se preguntó" de "se preguntó y no había".
// ═══════════════════════════════════════════════════════════════════════
import { ventanaDeCierres, razonesPorCierre, TOLERANCIA_RAZON_PCT } from '../api/_lib/mercado-cap-us.js';
import REFERENCIAS from '../api/_lib/mercado-cap-us-referencia.json' with { type: 'json' };

// ORCL tal como sale de la tabla el día que el job de EDGAR no corrió.
const ORCL = {
  symbol: 'ORCL', market_cap: 1.05e12, cap_moneda: 'USD', cap_fuente: 'finnhub:metric',
  acciones_millones: 2_800, acciones_edgar_millones: null, acciones_edgar_portada: null,
  edgar_consultada_en: null, edgar_consulta_motivo: null,
};

test('una columna de EDGAR vacía NO fabrica una fila de EDGAR con 0 acciones', () => {
  const fila = filaVeredictoCapUs(ORCL, { precio_usd: 420, referencias: new Map() });
  assert.equal(fila.edgar, null, 'null, no {acciones: 0}');
  // Y el 0 explícito tampoco: un conteo de cero acciones no es un conteo.
  assert.equal(filaVeredictoCapUs({ ...ORCL, acciones_edgar_millones: 0 }, { precio_usd: 420 }).edgar, null);
  // Un conteo de verdad sí pasa, en acciones y no en millones.
  const conDato = filaVeredictoCapUs({ ...ORCL, acciones_edgar_millones: 2_818 }, { precio_usd: 420 });
  assert.equal(conDato.edgar.acciones, 2_818_000_000);
});

test('sin consulta a EDGAR la causa es la TAREA, y el hallazgo sigue contando como hallazgo', () => {
  const v = veredictoCapUs(filaVeredictoCapUs(ORCL, { precio_usd: 420, referencias: new Map() }));
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.edgar_estado, 'no_consultado');
  assert.match(v.motivo, /difiere -10\.7% de acciones×precio/);
  assert.match(v.motivo, /pendiente de consulta a EDGAR/);
  assert.doesNotMatch(v.motivo, /EDGAR no dio/, 'no se acusa a quien no se le preguntó');
  // ÉSTE es el que hizo que la auditoría dijera 3 donde había 21: un desajuste
  // medido es un hallazgo, esté pendiente o no la segunda opinión.
  assert.equal(v.auditable, true);
});

test('consultado y sin dato dice cuándo se preguntó, y no se confunde con lo anterior', () => {
  const v = veredictoCapUs(filaVeredictoCapUs({
    ...ORCL,
    edgar_consultada_en: '2026-09-27T14:03:00.000Z',
    edgar_consulta_motivo: 'EDGAR no reporta dei:EntityCommonStockSharesOutstanding para este CIK (404)',
  }, { precio_usd: 420, referencias: new Map() }));
  assert.equal(v.edgar_estado, 'consultado_sin_dato');
  assert.equal(v.edgar_consultada_en, '2026-09-27');
  assert.match(v.motivo, /EDGAR consultado el 2026-09-27 y no dio acciones/);
  assert.match(v.motivo, /404/);
});

// ═══════════════════════════════════════════════════════════════════════
// CONTRA QUÉ DÍA — EL INSTRUMENTO
//
// #259 puso el contraste contra el cierre de `capturada_en`, y funcionó: VALE
// pasó de 0.999 (cierre del 25) a 1.043 (cierre del 18), que es exactamente lo
// que significa cambiar de ancla. Lo que quedó al descubierto es que no sabemos
// con qué precio calculó Yahoo su cap intradía. La ventana lo contesta con
// datos en vez de con una corazonada, y NO afloja el techo.
// ═══════════════════════════════════════════════════════════════════════
const SERIE = [
  { fecha: '2026-09-15', cierre: 9.2 }, { fecha: '2026-09-16', cierre: 9.4 },
  { fecha: '2026-09-17', cierre: 9.6 }, { fecha: '2026-09-18', cierre: 9.8 },
  { fecha: '2026-09-21', cierre: 10.0 }, { fecha: '2026-09-22', cierre: 10.1 },
  { fecha: '2026-09-23', cierre: 10.2 }, { fecha: '2026-09-25', cierre: 10.23 },
];

test('la ventana toma sesiones a los DOS lados de la captura', () => {
  const v = ventanaDeCierres(SERIE, '2026-09-18', 2);
  assert.deepEqual(v.map((f) => f.fecha), ['2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22']);
  // Una fecha que no existe en la serie no rompe nada: se ubica entre las que sí.
  assert.deepEqual(ventanaDeCierres(SERIE, '2026-09-19', 1).map((f) => f.fecha), ['2026-09-18', '2026-09-21']);
  assert.deepEqual(ventanaDeCierres(SERIE, null, 2), []);
});

test('la ventana dice si hay un día que reconcilia, y cuál', () => {
  // Una referencia que cuadra 1:1 contra el cierre del 22 y contra ninguno de
  // los de la semana anterior.
  const r = razonesPorCierre(ventanaDeCierres(SERIE, '2026-09-18', 5), {
    cap_referencia_usd: 10.1 * 6_000 * 1e6, acciones_millones: 6_000,
  });
  assert.equal(r.alguno_dentro, true);
  assert.equal(r.mejor.fecha, '2026-09-22');
  assert.ok(r.mejor.error_pct < 0.01);
  const dentro = r.filas.filter((f) => f.dentro).map((f) => f.fecha);
  assert.deepEqual(dentro, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-25']);
  // Y el del 18 queda fuera con su número, que es el dato que hacía falta.
  const d18 = r.filas.find((f) => f.fecha === '2026-09-18');
  assert.ok(d18.error_pct > TOLERANCIA_RAZON_PCT, `${d18.error_pct}`);
});

test('si NINGÚN día reconcilia, la ventana lo dice: el problema es la referencia', () => {
  const r = razonesPorCierre(ventanaDeCierres(SERIE, '2026-09-18', 5), {
    // Una cap 40% arriba de cualquier acciones×precio de la ventana: no hay
    // proporción de ADR que la explique ningún día.
    cap_referencia_usd: 10.1 * 6_000 * 1e6 * 1.4, acciones_millones: 6_000,
  });
  assert.equal(r.alguno_dentro, false);
  assert.ok(r.mejor.error_pct > TOLERANCIA_RAZON_PCT);
});

test('el veredicto sigue usando UN cierre: el de capturada_en, no el que mejor queda', () => {
  // La ventana informa; no elige. Si el elegido no cuadra, gris con su causa.
  const usado = cierreHasta(SERIE, '2026-09-18');
  assert.equal(usado.fecha, '2026-09-18');
  const v = veredictoCapUs({
    symbol: 'VALE', moneda: 'BRL', declarada: 300_000, acciones: 6_000,
    precio_usd: 10.23, precio_captura: usado.cierre,
    referencia: { market_cap_usd: 10.1 * 6_000 * 1e6, capturada_en: '2026-09-18', vigente_hasta: '2026-12-31' },
    hoy: new Date('2026-09-27'),
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.match(v.motivo, /no se parece a ninguna proporción/);
});

// ── LA FECHA DE CAPTURA DE VALE ────────────────────────────────────────
test('capturada_en es el día en que se LEYÓ la cap, y el sello de Yahoo va aparte', () => {
  // Las cuatro se capturaron el 2026-09-23 al cierre (mensaje de Lety del
  // 2026-09-24). El 2026-09-18 era lo que Yahoo ESTAMPABA en la cotización de
  // VALE y estaba guardado por error como fecha de captura, lo que mandaba la
  // razón a despejarse contra un cierre 4.3% más bajo.
  const vale = REFERENCIAS.referencias.find((r) => r.clave === 'VALE');
  assert.equal(vale.capturada_en, '2026-09-23');
  assert.equal(vale.cotizacion_marcada_en, '2026-09-18');
  for (const r of REFERENCIAS.referencias) {
    assert.equal(r.capturada_en, '2026-09-23', `${r.clave}: todas se leyeron el mismo día`);
  }
});
