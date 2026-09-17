// ═══════════════════════════════════════════════════════════════
// tests/bmv-harvest.test.mjs — Fase A: cosecha DataBursatil.
//
// El sandbox donde se escribió el cosechador NO alcanza la API (el proxy de
// egress contesta 403 por política). O sea que estos tests NO pueden validar
// el contrato del servidor — y no fingen hacerlo. Lo que fijan es todo lo que
// SÍ se puede decidir sin red y que, si se rompe, rompe caro:
//
//   · la aritmética del calendario de trimestres,
//   · el parseo tolerante del censo (la forma exacta no está verificada),
//   · que la ambigüedad y lo ausente fallen CERRADO, con motivo,
//   · que el mes del presupuesto se calcule en CDMX y no en UTC,
//   · que el token no se filtre en ninguna URL reportada,
//   · que la cartera pare por presupuesto, por tope y por reloj.
//
//   node tests/bmv-harvest.test.mjs
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCHMARK, BENCHMARK_EMISORA, BENCHMARK_SERIE, BENCHMARK_TIPO,
  COBERTURA_FIN, PRESUPUESTO_MENSUAL,
  aNumero, aplanarHistoricos, clavePeriodo, construirUrl, emisoraSerie, valorDeCampo,
  extraerDistribuciones, finDeTrimestre, mesPresupuesto, normalizarFinancieros,
  parseClavePeriodo, periodoApi, restaDias, DIAS_EX_APROX, UMBRAL_PLACEHOLDER,
  recortarAlPeriodo, finDeClave,
  consolidarDistribuciones, categoriaReparto, esEfectivo, requiereConversion,
  parsearRangoFechas, parsearRangoPeriodos, recortarACobertura, resolverCampo,
  trimestresEntre, urlSegura,
} from '../api/_lib/databursatil.js';

import {
  CONTRATO_DEFECTO, TOPE_PROBE, candidatosFinancieros, candidatosHistoricos, contar,
  describirCrudo, literal, tipoDe,
  jobInspect, jobReparseFinancieros, jobProbe, jobEmisoras, jobFinancieros,
  jobHistoricos, jobReparse,
  estimarConsumo, filaCenso, filasDelCenso, nuevaCartera, pareceClave, pareceSerie,
  pendientesFinancieros,
  paramsBenchmark, paramsFinancieros, paramsHistoricos, parsePeriodoTexto,
  seriesDeEmisora, sirveFinanciero,
} from '../api/bmv-harvest.js';
import handler from '../api/bmv-harvest.js';

/* ── calendario de trimestres ───────────────────────────────────── */

test('finDeTrimestre da el último día natural, incluido febrero bisiesto', () => {
  assert.equal(finDeTrimestre(2016, 1), '2016-03-31');
  assert.equal(finDeTrimestre(2016, 2), '2016-06-30');
  assert.equal(finDeTrimestre(2016, 3), '2016-09-30');
  assert.equal(finDeTrimestre(2016, 4), '2016-12-31');
  assert.equal(finDeTrimestre(2026, 2), '2026-06-30');
});

test('trimestresEntre cubre el rango inclusive y cruza el año', () => {
  const t = trimestresEntre({ anio: 2016, trimestre: 3 }, { anio: 2017, trimestre: 2 });
  assert.deepEqual(t.map((x) => clavePeriodo(x.anio, x.trimestre)),
    ['2016-3', '2016-4', '2017-1', '2017-2']);
});

test('trimestresEntre: la cobertura declarada 2T2016→2T2026 son 41 trimestres', () => {
  assert.equal(trimestresEntre(COBERTURA_FIN.desde, COBERTURA_FIN.hasta).length, 41);
});

test('trimestresEntre con el rango invertido da vacío, no un bucle infinito', () => {
  assert.deepEqual(trimestresEntre({ anio: 2020, trimestre: 3 }, { anio: 2019, trimestre: 1 }), []);
});

test('recortarACobertura no deja pedir fuera de lo que la API tiene', () => {
  const r = recortarACobertura({ anio: 2010, trimestre: 1 }, { anio: 2030, trimestre: 4 });
  assert.deepEqual(r, { desde: COBERTURA_FIN.desde, hasta: COBERTURA_FIN.hasta });
  // Una emisora que nació después conserva SU inicio: ese es el dato
  // point-in-time que evita meterla al universo antes de existir.
  const tarde = recortarACobertura({ anio: 2019, trimestre: 2 }, { anio: 2026, trimestre: 2 });
  assert.deepEqual(tarde.desde, { anio: 2019, trimestre: 2 });
  // Y una deslistada antes del inicio de la cobertura no deja nada que pedir.
  assert.equal(recortarACobertura({ anio: 2011, trimestre: 1 }, { anio: 2014, trimestre: 4 }), null);
});

test('recortarACobertura falla CERRADO: un rango ausente no se rellena con "todo"', () => {
  // Rellenarlo le inventaría a la emisora una fecha de nacimiento, la metería
  // al universo en trimestres en los que no cotizaba, y cobraría 41 requests
  // por cada rango que no se supo leer.
  assert.equal(recortarACobertura(null, { anio: 2026, trimestre: 2 }), null);
  assert.equal(recortarACobertura({ anio: 2016, trimestre: 2 }, null), null);
  assert.equal(recortarACobertura(null, null), null);
});

test('parseClavePeriodo acepta AAAA-T y rechaza lo demás', () => {
  assert.deepEqual(parseClavePeriodo('2016-2'), { anio: 2016, trimestre: 2 });
  assert.equal(parseClavePeriodo('2016-5'), null);
  assert.equal(parseClavePeriodo('2016-06-30'), null);
  assert.equal(parseClavePeriodo(''), null);
});

/* ── el censo: rangos de forma desconocida ──────────────────────── */

test('parsearRangoPeriodos aguanta las formas plausibles del rango_financieros', () => {
  const esperado = { desde: { anio: 2016, trimestre: 2 }, hasta: { anio: 2026, trimestre: 2 } };
  for (const v of ['2016-2/2026-2', '2016-2 a 2026-2', '2016-2,2026-2', '2016-2..2026-2',
                   ['2016-2', '2026-2'], { inicio: '2016-2', fin: '2026-2' },
                   { desde: '2016-2', hasta: '2026-2' }]) {
    assert.deepEqual(parsearRangoPeriodos(v).rango, esperado, `falló con ${JSON.stringify(v)}`);
  }
});

test('parsearRangoPeriodos saca min y max de un mapa año→trimestres', () => {
  const r = parsearRangoPeriodos({ 2016: [2, 3, 4], 2017: [1, 2] });
  assert.deepEqual(r.rango, { desde: { anio: 2016, trimestre: 2 }, hasta: { anio: 2017, trimestre: 2 } });
});

test('parsearRangoPeriodos falla CERRADO y con motivo, nunca inventa un rango', () => {
  for (const v of [null, undefined, '', 'vaya usted a saber', {}, []]) {
    const r = parsearRangoPeriodos(v);
    assert.equal(r.rango, null, `debió fallar con ${JSON.stringify(v)}`);
    assert.ok(r.motivo && r.motivo.length, 'un fallo sin motivo es un fallo mudo');
  }
});

test('parsearRangoFechas ordena y toma los extremos', () => {
  assert.deepEqual(parsearRangoFechas('2010-01-04/2026-09-15').rango,
    { desde: '2010-01-04', hasta: '2026-09-15' });
  assert.deepEqual(parsearRangoFechas(['2026-09-15', '2010-01-04']).rango,
    { desde: '2010-01-04', hasta: '2026-09-15' });
  assert.equal(parsearRangoFechas('sin fechas').rango, null);
});

/* ── resolver campos sobre un JSON de forma desconocida ──────────── */

test('resolverCampo encuentra el campo anidado y reporta su ruta', () => {
  const raw = { resultado_trimestre: { BasicEarningsLossPerShare: '1.25' }, posicion: { Assets: 1000 } };
  const eps = resolverCampo(raw, 'basicearningslosspershare');
  assert.equal(eps.valor, 1.25);
  assert.equal(eps.ruta, 'resultado_trimestre.BasicEarningsLossPerShare');
  assert.equal(resolverCampo(raw, 'assets').valor, 1000);
});

test('resolverCampo: el MISMO valor en dos ramas no es ambigüedad', () => {
  const raw = { a: { assets: 500 }, b: { Assets: '500' } };
  assert.equal(resolverCampo(raw, 'assets').valor, 500);
});

test('resolverCampo: dos valores DISTINTOS fallan cerrado, no promedian', () => {
  const raw = { a: { assets: 500 }, b: { assets: 900 } };
  const r = resolverCampo(raw, 'assets');
  assert.equal(r.valor, null, 'un dato que puede significar dos cosas no es un dato');
  assert.match(r.motivo, /AMBIGUO/);
  assert.match(r.motivo, /500/);
  assert.match(r.motivo, /900/);
});

test('resolverCampo: lo ausente devuelve null CON motivo', () => {
  const r = resolverCampo({ otra: 1 }, 'equity');
  assert.equal(r.valor, null);
  assert.equal(r.motivo, 'no está en la respuesta');
});

test('aNumero acepta el formato contable y rechaza la basura sin devolver NaN', () => {
  assert.equal(aNumero('1,234.56'), 1234.56);
  assert.equal(aNumero('12,345,678'), 12345678);
  assert.equal(aNumero('(89)'), -89);
  assert.equal(aNumero('(1,234.5)'), -1234.5);
  assert.equal(aNumero('  -3.5 '), -3.5);
  assert.equal(aNumero(0), 0);
  assert.equal(aNumero('0'), 0);
  for (const v of ['n/d', '', null, undefined, 'abc', {}, NaN, Infinity]) {
    assert.equal(aNumero(v), null, `debió ser null con ${String(v)}`);
  }
});

test('aNumero rechaza la coma que NO es separador de miles', () => {
  // `10,7` como decimal europeo se volvería 107: un precio 10× mal, mudo.
  // Preferimos el hoyo visible (null con motivo) al número plausible.
  assert.equal(aNumero('10,7'), null);
  assert.equal(aNumero('1,23'), null);
  assert.equal(aNumero('1,2345'), null);
  assert.equal(aNumero('1,234,56'), null);
});

test('normalizarFinancieros deja los 7 campos y el motivo de cada faltante', () => {
  const { valores, faltantes } = normalizarFinancieros({
    posicion: { Assets: 10, Liabilities: 4, Equity: 6, CashAndCashEquivalents: 2 },
    resultado_trimestre: { Revenue: 100, BasicEarningsLossPerShare: 0.5 },
  });
  assert.equal(valores.assets, 10);
  assert.equal(valores.revenue, 100);
  assert.equal(valores.basicearningslosspershare, 0.5);
  assert.equal(valores.profitlossattributabletoownersofparent, null);
  assert.equal(faltantes.profitlossattributabletoownersofparent, 'no está en la respuesta');
  assert.equal(Object.keys(faltantes).length, 1);
});

test('normalizarFinancieros con un cuerpo vacío no devuelve ceros silenciosos', () => {
  const { valores, faltantes } = normalizarFinancieros({});
  assert.ok(Object.values(valores).every((v) => v === null));
  assert.equal(Object.keys(faltantes).length, 7);
});

/* ── precios ────────────────────────────────────────────────────── */

test('aplanarHistoricos lee el mapa por fecha', () => {
  const { filas, descartadas } = aplanarHistoricos({
    '2016-01-04': { cierre: 10.5, importe: 1000 },
    '2016-01-05': { cierre: '10.70', importe: '2,000' },
  });
  assert.equal(descartadas, 0);
  assert.deepEqual(filas.map((f) => f.fecha), ['2016-01-04', '2016-01-05']);
  assert.equal(filas[1].cierre, 10.7);
  assert.equal(filas[1].importe, 2000, 'la coma de miles bien formada sí se acepta');
});

test('aplanarHistoricos lee el arreglo de filas y los alias del importe', () => {
  const { filas } = aplanarHistoricos([
    { fecha: '2016-01-04', close: 10.5, importe_operado: 900 },
    { fecha: '2016-01-05', close: 11, monto_operado: 800 },
  ]);
  assert.equal(filas.length, 2);
  assert.equal(filas[0].importe, 900);
  assert.equal(filas[1].importe, 800);
});

test('aplanarHistoricos ordena por fecha aunque lleguen al revés', () => {
  const { filas } = aplanarHistoricos({ '2016-03-01': 2, '2016-01-04': 1 });
  assert.deepEqual(filas.map((f) => f.fecha), ['2016-01-04', '2016-03-01']);
  assert.equal(filas[0].cierre, 1, 'un número suelto es el cierre');
});

test('aplanarHistoricos DESCARTA la fila sin cierre y la cuenta', () => {
  const { filas, descartadas } = aplanarHistoricos({
    '2016-01-04': { cierre: 10 },
    '2016-01-05': { importe: 500 },      // sin cierre: no sirve ni para ranking ni para retorno
    'no-es-fecha': { cierre: 9 },
  });
  assert.equal(filas.length, 1);
  assert.equal(descartadas, 2, 'lo descartado se cuenta: un hoyo silencioso es peor que uno visible');
});

test('aplanarHistoricos con importe ausente deja null, no cero', () => {
  const { filas } = aplanarHistoricos({ '2016-01-04': { cierre: 10 } });
  assert.equal(filas[0].importe, null, 'un cero de importe pasaría el filtro de liquidez como si hubiera operado');
});

/* ── presupuesto ────────────────────────────────────────────────── */

test('mesPresupuesto usa CDMX: el 1º de mes de madrugada UTC todavía es el mes anterior', () => {
  // Los créditos se reponen el día 1 a las 00:01 CDMX. Con el mes UTC, las
  // primeras horas del 1º caerían en el mes nuevo antes de tiempo.
  assert.equal(mesPresupuesto(new Date('2026-10-01T02:00:00Z')), '2026-09');
  assert.equal(mesPresupuesto(new Date('2026-10-01T07:00:00Z')), '2026-10');
  assert.equal(mesPresupuesto(new Date('2026-09-16T18:00:00Z')), '2026-09');
});

test('la cartera para por tope de la corrida', () => {
  const c = nuevaCartera({ mes: '2026-09', gastadoMes: 0, tope: 2 });
  assert.equal(c.puedeSeguir(), true); c.anota(null);
  assert.equal(c.puedeSeguir(), true); c.anota(null);
  assert.equal(c.puedeSeguir(), false);
  assert.equal(c.razonParo, 'tope_de_la_corrida');
});

test('la cartera para ANTES de pasarse del presupuesto mensual, no después', () => {
  const c = nuevaCartera({ mes: '2026-09', gastadoMes: PRESUPUESTO_MENSUAL - 1, tope: 100 });
  assert.equal(c.puedeSeguir(), true);
  c.anota(null);
  assert.equal(c.puedeSeguir(), false);
  assert.equal(c.razonParo, 'presupuesto_mensual_agotado');
  assert.ok(c.gastadoMes + c.creditos <= PRESUPUESTO_MENSUAL);
});

test('la cartera para por el reloj de la lambda antes del 504', () => {
  const c = nuevaCartera({ mes: '2026-09', gastadoMes: 0, tope: 100, t0: Date.now() - 999999, limiteMs: 1000 });
  assert.equal(c.puedeSeguir(), false);
  assert.equal(c.razonParo, 'reloj_de_la_lambda');
});

/* ── el presupuesto estimado ────────────────────────────────────── */

const emisorasDemo = (n, d0 = '2016-01-01') => Array.from({ length: n }, (_, i) => ({
  emisora: `E${i}`, emisora_serie: `E${i}*`,
  finDesde: COBERTURA_FIN.desde, finHasta: COBERTURA_FIN.hasta,
  histDesde: d0, histHasta: '2026-09-16',
}));

test('estimarConsumo: 30 emisoras × 41 trimestres + 30 rangos + 1 censo', () => {
  const e = estimarConsumo({ emisoras: emisorasDemo(30) });
  assert.equal(e.requests.financieros, 30 * 41);
  assert.equal(e.requests.historicos, 30);
  assert.equal(e.requests.total, 1 + 1230 + 30);
  assert.equal(e.modelos.A_por_request, 1261);
});

test('estimarConsumo: bajo el modelo más caro la cosecha NO cabe en un mes', () => {
  // Este test existe para que el hallazgo no se pierda: si el costo se cobra
  // por campo × día, 200,000 no alcanzan y hay que partir la cosecha en dos
  // meses o recortar el rango de precios. Es el motivo de que el reporte
  // muestre los tres modelos en vez de uno.
  const e = estimarConsumo({ emisoras: emisorasDemo(30) });
  assert.equal(e.cabe_en_un_mes.A, true);
  assert.equal(e.cabe_en_un_mes.C, false);
  assert.ok(e.modelos.C_por_campo_dia > PRESUPUESTO_MENSUAL);
});

test('estimarConsumo: una emisora con rango corto cuesta menos, no lo mismo', () => {
  const corta = [{ emisora: 'NUEVA', finDesde: { anio: 2024, trimestre: 1 }, finHasta: { anio: 2026, trimestre: 2 }, histDesde: '2024-01-01', histHasta: '2026-09-16' }];
  const e = estimarConsumo({ emisoras: corta });
  assert.equal(e.requests.financieros, 10);   // 2024-1 … 2026-2
  assert.equal(e.requests.historicos, 1);
});

test('estimarConsumo: sin rango de precios no se pide /historicos', () => {
  const e = estimarConsumo({ emisoras: [{ emisora: 'X', finDesde: COBERTURA_FIN.desde, finHasta: COBERTURA_FIN.hasta, histDesde: null, histHasta: null }] });
  assert.equal(e.requests.historicos, 0);
  assert.equal(e.datos.dias_precio, 0);
});

/* ── el contrato de la API ──────────────────────────────────────── */

test('paramsFinancieros arma cada forma del contrato sin mezclarlas', () => {
  const base = { emisora: 'WALMEX', financieros: 'posicion,resultado_trimestre' };
  assert.deepEqual(paramsFinancieros({ financieros: { forma: 'periodo', periodo: 'periodo' } }, 'WALMEX', 2026, 2),
    { ...base, periodo: '2026-2' });
  assert.deepEqual(paramsFinancieros({ financieros: { forma: 'cierre', periodo: 'fecha' } }, 'WALMEX', 2026, 2),
    { ...base, fecha: '2026-06-30' });
  assert.deepEqual(paramsFinancieros({ financieros: { forma: 'partes', anio: 'año', trim: 'trimestre' } }, 'WALMEX', 2026, 2),
    { ...base, 'año': 2026, trimestre: 2 });
});

test('paramsFinancieros pide resultado_trimestre, NO el acumulado', () => {
  // El TTM es la SUMA de 4 trimestres. Con el acumulado, el 1T se contaría
  // cuatro veces y el "value" sería otra cosa.
  const p = paramsFinancieros(CONTRATO_DEFECTO, 'WALMEX', 2026, 2);
  assert.equal(p.financieros, 'posicion,resultado_trimestre');
  assert.ok(!/acumulado/.test(p.financieros));
});

test('paramsHistoricos pide por emisora_serie, que es lo que la API quiere', () => {
  // VERIFICADO contra la API: el parámetro NO es `emisora`, y el valor lleva
  // la serie pegada. Este test es el que impide volver a la grafía vieja.
  assert.deepEqual(paramsHistoricos(CONTRATO_DEFECTO, 'WALMEX*', '2016-01-01', '2026-09-16'),
    { emisora_serie: 'WALMEX*', inicio: '2016-01-01', final: '2026-09-16' });
  // Y sigue respetando una grafía distinta si el probe descubriera otra.
  assert.deepEqual(paramsHistoricos({ historicos: { clave: 'emisora', inicio: 'fecha_inicio', final: 'fecha_final' } }, 'WALMEX*', '2016-01-01', '2026-09-16'),
    { emisora: 'WALMEX*', fecha_inicio: '2016-01-01', fecha_final: '2026-09-16' });
});

test('paramsFinancieros usa el formato TT_AAAA que la API pidió por su nombre', () => {
  // El error literal de la API traía el ejemplo: "Por ejemplo: '1T_2020'".
  // Verificado a mano: periodo=2T_2017 devuelve datos.
  const p = paramsFinancieros(CONTRATO_DEFECTO, 'WALMEX', 2017, 2);
  assert.equal(p.periodo, '2T_2017');
  assert.equal(p.emisora, 'WALMEX');
  assert.equal(paramsFinancieros(CONTRATO_DEFECTO, 'X', 2020, 1).periodo, '1T_2020');
});

test('periodoApi es el dialecto de la API, clavePeriodo es nuestra llave', () => {
  // Separados a propósito: atar el índice del ledger al formato de un tercero
  // sería heredar su siguiente cambio de API.
  assert.equal(periodoApi(2020, 1), '1T_2020');
  assert.equal(clavePeriodo(2020, 1), '2020-1');
});

test('el contrato de arranque viene marcado como NO verificado', () => {
  assert.equal(CONTRATO_DEFECTO.verificado, false,
    'que exista un default no significa que esté verificado: significa que el probe tiene por dónde empezar');
});

test('los candidatos del probe caben en el tope y no se repiten', () => {
  const f = candidatosFinancieros(2026, 2);
  const h = candidatosHistoricos('2026-06-20', '2026-06-30');
  // 1 censo + financieros + históricos + 2 grafías del benchmark.
  assert.ok(1 + f.length + h.length + 2 <= TOPE_PROBE, 'el probe no debe poder pasarse de su tope duro');
  assert.equal(new Set(f.map((c) => c.etiqueta)).size, f.length);
  assert.equal(new Set(h.map((c) => c.etiqueta)).size, h.length);
});

test('sirveFinanciero exige que se resuelva al menos un campo, no sólo un 200', () => {
  assert.equal(sirveFinanciero({ mensaje: 'ok', datos: {} }).sirve, false);
  assert.equal(sirveFinanciero(null).sirve, false);
  assert.equal(sirveFinanciero({ posicion: { Assets: 1 } }).sirve, true);
});

/* ── censo: filas de forma desconocida ──────────────────────────── */

test('filasDelCenso lee el mapa CLAVE→datos', () => {
  const filas = filasDelCenso({
    WALMEX: { razon_social: 'Wal-Mart de México', tipo_valor_id: 1, estatus: 'ACTIVA', rango_financieros: '2016-2/2026-2', rango_historicos: '2010-01-04/2026-09-15' },
    ELEKTRA: { tipo_valor_id: '1', estatus: 'SUSPENDIDA', rango_financieros: '2016-2/2025-4', rango_historicos: '2010-01-04/2025-09-30' },
  });
  assert.equal(filas.length, 2);
  const w = filas.find((f) => f.emisora === 'WALMEX');
  assert.equal(w.tipo_valor_id, '1', 'el tipo se guarda como texto aunque venga numérico');
  assert.equal(w.fin_desde, '2016-2');
  assert.equal(w.fin_hasta, '2026-2');
  assert.equal(w.hist_desde, '2010-01-04');
  // La deslistada conserva su rango: sin ella el universo tendría
  // survivorship bias, que es justo lo que este censo evita.
  const e = filas.find((f) => f.emisora === 'ELEKTRA');
  assert.equal(e.estatus, 'SUSPENDIDA');
  assert.equal(e.fin_hasta, '2025-4');
});

test('filasDelCenso lee el arreglo de objetos', () => {
  const filas = filasDelCenso([
    { emisora: 'AMX', tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' },
    { clave: 'GAP', tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' },
  ]);
  assert.deepEqual(filas.map((f) => f.emisora).sort(), ['AMX', 'GAP']);
});

test('filaCenso guarda el crudo y el motivo cuando el rango no se entiende', () => {
  const f = filaCenso('XYZ', { tipo_valor_id: '1', rango_financieros: 'quién sabe' });
  assert.equal(f.fin_desde, null);
  assert.ok(f.fin_motivo);
  assert.deepEqual(f.raw, { tipo_valor_id: '1', rango_financieros: 'quién sabe' },
    'el crudo se guarda siempre: re-parsear no debe costar créditos');
});

test('parsePeriodoTexto es la inversa de clavePeriodo', () => {
  assert.deepEqual(parsePeriodoTexto(clavePeriodo(2019, 3)), { anio: 2019, trimestre: 3 });
  assert.equal(parsePeriodoTexto('basura'), null);
});

/* ── el token no se filtra ──────────────────────────────────────── */

test('urlSegura tacha el token, que es lo único que se reporta', () => {
  const u = construirUrl('/emisoras', { mercado: 'local' }, 'SECRETO123');
  assert.match(u, /token=SECRETO123/);
  const s = urlSegura(u);
  assert.ok(!s.includes('SECRETO123'), 'el token nunca debe salir en una respuesta ni en un log');
  assert.match(s, /token=\*\*\*/);
  assert.match(s, /mercado=local/);
});

test('construirUrl omite los params vacíos en vez de mandar cadenas huecas', () => {
  const u = construirUrl('/historicos', { emisora: 'WALMEX', inicio: null, final: '', bolsa: undefined }, 'T');
  assert.match(u, /emisora=WALMEX/);
  assert.ok(!u.includes('inicio='));
  assert.ok(!u.includes('final='));
  assert.ok(!u.includes('bolsa='));
});

test('contar agrupa los estados de la corrida', () => {
  assert.deepEqual(contar(['hecho', 'hecho', 'error']), { hecho: 2, error: 1 });
});

/* ── el censo no debe tragarse basura ───────────────────────────── */

test('filasDelCenso ignora las llaves que no son emisoras', () => {
  // Un `{"creditos": 5}` colgando del mismo nivel entraría al censo como si
  // cotizara. El tipo_valor_id lo filtraría después, pero una fila basura en
  // el censo es una fila basura en el dato point-in-time.
  const filas = filasDelCenso({
    WALMEX: { tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' },
    creditos: 5,
    mensaje: 'ok',
  });
  assert.deepEqual(filas.map((f) => f.emisora), ['WALMEX']);
});

test('pareceClave acepta pizarras reales y rechaza prosa', () => {
  for (const k of ['WALMEX', 'PE&OLES', 'AC', 'GMEXICO', 'Q']) {
    assert.equal(pareceClave(k), true, `debió aceptar ${k}`);
  }
  for (const k of ['un mensaje largo', 'resultado de la consulta', '']) {
    assert.equal(pareceClave(k), false, `debió rechazar ${k}`);
  }
});

test('un objeto anidado con campos de emisora pasa aunque la llave sea rara', () => {
  const filas = filasDelCenso({ fila_1: { emisora: 'ALFA', tipo_valor_id: '1' } });
  assert.deepEqual(filas.map((f) => f.emisora), ['ALFA']);
});

/* ── el benchmark: NAFTRAC ISHRS, tipo 1B ───────────────────────── */

test('el benchmark va PEGADO, sin espacio — el espacio fue el 400', () => {
  // Todos los identificadores de la API van pegados: WALMEX*, FEMSAUBD,
  // LIVEPOLC-1, LACOMERUBC. NAFTRAC no es la excepción, y probarlo con espacio
  // devolvió 400 — el problema nunca fue que faltara en el censo (hay 16 filas
  // tipo 1B), sino cómo se armaba el identificador.
  assert.equal(BENCHMARK, 'NAFTRACISHRS');
  assert.ok(!BENCHMARK.includes(' '), 'ni un espacio');
  assert.equal(BENCHMARK, BENCHMARK_EMISORA + BENCHMARK_SERIE,
    'se construye igual que cualquier otro emisora_serie, no a mano');
  assert.equal(BENCHMARK_TIPO, '1B');
});

test('el benchmark NO puede colarse al universo: 1B nunca empata con 1', () => {
  // La exclusión es ESTRUCTURAL, no una excepción escrita a mano: el filtro
  // del universo es igualdad exacta de texto contra '1', y el censo guarda el
  // tipo sin coerción. Si alguien cambiara el filtro a un LIKE o a un Number(),
  // este test se cae — que es justo para lo que está.
  const filas = filasDelCenso({
    WALMEX: { tipo_valor_id: 1, rango_financieros: '2016-2/2026-2' },
    NAFTRAC: { razon_social: 'iShares NAFTRAC', ISHRS: { tipo_valor_id: '1B' } },
  });
  const ics = filas.filter((f) => f.tipo_valor_id === '1');
  assert.deepEqual(ics.map((f) => f.emisora), ['WALMEX']);
  const bench = filas.find((f) => f.emisora_serie === BENCHMARK);
  assert.equal(bench.tipo_valor_id, '1B', 'el tipo se guarda como texto, sin coerción');
  assert.notEqual(bench.tipo_valor_id, '1');
});

test('el censo arma el identificador del benchmark desde la serie', () => {
  const filas = filasDelCenso({
    NAFTRAC: { razon_social: 'iShares NAFTRAC', ISHRS: { tipo_valor_id: '1B', rango_historicos: '2010-01-04/2026-09-15' } },
  });
  assert.deepEqual(filas.map((f) => f.emisora_serie), [BENCHMARK]);
  assert.equal(filas[0].tipo_valor_id, '1B');
});

test('paramsBenchmark: el benchmark ya es un emisora_serie como cualquier otro', () => {
  const p = paramsBenchmark(CONTRATO_DEFECTO, '2016-01-01', '2026-09-16');
  assert.equal(p.emisora_serie, 'NAFTRACISHRS');
  assert.equal(p.emisora, undefined, 'no debe mandar el parámetro viejo');
});

/* ── distribuciones: el benchmark es de RETORNO TOTAL ───────────── */

/** Compacta una fila de reparto a lo que el test quiere mirar. */
const pagoMonto = (d) => ({ fecha_pago: d.fecha_pago, monto: d.monto });

test('extraerDistribuciones lee el mapa por fecha y ordena', () => {
  const { distribuciones, descartadas } = extraerDistribuciones({
    distribuciones: { '2026-02-16': { monto: '0.38' }, '2026-01-15': { monto: 0.42 } },
  });
  assert.equal(descartadas, 0);
  assert.deepEqual(distribuciones.map(pagoMonto), [
    { fecha_pago: '2026-01-15', monto: 0.42 },
    { fecha_pago: '2026-02-16', monto: 0.38 },
  ]);
});

test('extraerDistribuciones lee el arreglo y descarta lo que no sirve para reinvertir', () => {
  const { distribuciones, descartadas } = extraerDistribuciones({
    dividendos: [
      { fecha_ex: '2025-03-10', importe: 1.1 },
      { fecha_ex: 'pendiente', importe: 2 },     // sin fecha ex: no se puede reinvertir
      { fecha_ex: '2025-06-10', importe: 'n/d' }, // sin monto
    ],
  });
  assert.deepEqual(distribuciones.map(pagoMonto), [{ fecha_pago: '2025-03-10', monto: 1.1 }]);
  assert.equal(descartadas, 2, 'lo que no se puede reinvertir se cuenta, no se rellena con cero');
});

test('extraerDistribuciones no confunde el rango del censo con un reparto', () => {
  const { distribuciones } = extraerDistribuciones({
    rango_financieros: '2016-2/2026-2', rango_historicos: '2010-01-04/2026-09-15', tipo_valor_id: '1B',
  });
  assert.deepEqual(distribuciones, []);
});

test('extraerDistribuciones no duplica el mismo reparto visto dos veces', () => {
  const { distribuciones } = extraerDistribuciones({
    distribuciones: { '2025-01-10': { monto: 0.5 } },
    dividendos: { '2025-01-10': { monto: 0.5 } },
  });
  assert.equal(distribuciones.length, 1);
});

/* ── el presupuesto cuenta al benchmark ─────────────────────────── */

test('estimarConsumo cobra el rango de precios del benchmark, sin financieros', () => {
  // Un ETF no reporta trimestres, pero su serie de precios sí cuesta — y es la
  // única sin la cual no hay contra qué medir.
  const e = estimarConsumo({
    emisoras: [{ emisora: BENCHMARK, finDesde: null, finHasta: null, histDesde: '2016-01-01', histHasta: '2026-09-16' }],
  });
  assert.equal(e.requests.financieros, 0);
  assert.equal(e.requests.historicos, 1);
  assert.ok(e.datos.dias_precio > 2000);
});

/* ── simetría del retorno total ─────────────────────────────────── */

test('las distribuciones se extraen de CUALQUIER emisora, no sólo del benchmark', () => {
  // La simetría del retorno total depende de esto: si el extractor estuviera
  // atado al benchmark, la canasta se mediría a precio contra un benchmark con
  // dividendos — exactamente la asimetría que el diseño corrige.
  const filas = filasDelCenso({
    WALMEX: { '*': { tipo_valor_id: '1', dividendos: { '2025-11-20': { monto: 0.58 } } } },
    NAFTRAC: { ISHRS: { tipo_valor_id: '1B', distribuciones: { '2025-11-28': { monto: 0.31 } } } },
  });
  const porEmisora = Object.fromEntries(
    filas.map((f) => [f.emisora_serie, extraerDistribuciones(f.raw_serie || f.raw).distribuciones]));

  assert.deepEqual(porEmisora['WALMEX*'].map(pagoMonto), [{ fecha_pago: '2025-11-20', monto: 0.58 }]);
  assert.deepEqual(porEmisora[BENCHMARK].map(pagoMonto), [{ fecha_pago: '2025-11-28', monto: 0.31 }]);
});

test('una emisora sin reparto da lista vacía, no un cero inventado', () => {
  // La diferencia importa: "no repartió" y "el dato no vino" se ven igual si se
  // rellena con cero, y lo segundo rompe la simetría en silencio.
  const [fila] = filasDelCenso({ GCC: { tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' } });
  const { distribuciones, descartadas } = extraerDistribuciones(fila.raw);
  assert.deepEqual(distribuciones, []);
  assert.equal(descartadas, 0);
});

/* ── la SERIE: lo que el probe reveló ───────────────────────────── */

test('emisoraSerie concatena literal, sin normalizar ni separar', () => {
  // Literal y sin separador: así se reproducen los identificadores tal como
  // la API los quiere, incluido el del benchmark.
  assert.equal(emisoraSerie('WALMEX', '*'), 'WALMEX*');
  assert.equal(emisoraSerie('FEMSA', 'UBD'), 'FEMSAUBD');
  assert.equal(emisoraSerie('AMX', 'B'), 'AMXB');
  assert.equal(emisoraSerie('CEMEX', 'CPO'), 'CEMEXCPO');
  assert.equal(emisoraSerie('LIVEPOL', 'C-1'), 'LIVEPOLC-1');
  assert.equal(emisoraSerie('NAFTRAC', 'ISHRS'), 'NAFTRACISHRS');
  assert.equal(emisoraSerie('LACOMER', 'UBC'), 'LACOMERUBC');
  assert.equal(emisoraSerie('GCC', null), 'GCC');
});

test('seriesDeEmisora NO confunde un campo-objeto con una serie', () => {
  // `rango_financieros` puede venir como {inicio, fin}: detectar series por
  // "su valor es un objeto" la tomaría por una serie llamada
  // 'rango_financieros' y pediría precios de 'WALMEXrango_financieros'.
  const series = seriesDeEmisora({
    razon_social: 'Wal-Mart de México',
    rango_financieros: { inicio: '2016-2', fin: '2026-2' },
    rango_historicos: ['2010-01-04', '2026-09-15'],
    distribuciones: { '2025-11-20': { monto: 0.5 } },
    '*': { tipo_valor_id: '1' },
  });
  assert.deepEqual(series.map((x) => x.serie), ['*']);
});

test('pareceSerie acepta las series reales y rechaza nombres de campo', () => {
  for (const k of ['*', 'B', 'UBD', 'CPO', 'C-1', 'CK', 'CPI', 'ISHRS', 'UBC']) {
    assert.equal(pareceSerie(k), true, `debió aceptar ${JSON.stringify(k)}`);
  }
  for (const k of ['rango_financieros', 'razon_social', 'tipo_valor_id', '']) {
    assert.equal(pareceSerie(k), false, `debió rechazar ${k}`);
  }
});

test('filasDelCenso desdobla una emisora en UNA FILA POR SERIE', () => {
  const filas = filasDelCenso({
    LIVEPOL: {
      razon_social: 'El Puerto de Liverpool',
      'C-1': { tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' },
      '1': { tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' },
    },
  });
  assert.deepEqual(filas.map((f) => f.emisora_serie).sort(), ['LIVEPOL1', 'LIVEPOLC-1']);
  assert.ok(filas.every((f) => f.emisora === 'LIVEPOL'), 'la emisora es la misma: los financieros son por emisora');
});

test('los campos de la SERIE ganan sobre los de la emisora', () => {
  // tipo_valor_id y estatus son del instrumento, no de la empresa: NAFTRAC
  // ISHRS es 1B y un CKD es 1R, aunque cuelguen de un nombre cualquiera.
  const [n] = filasDelCenso({ NAFTRAC: { tipo_valor_id: '1', ISHRS: { tipo_valor_id: '1B' } } });
  assert.equal(n.emisora_serie, 'NAFTRACISHRS');
  assert.equal(n.tipo_valor_id, '1B');
  const [ck] = filasDelCenso({ AA1CK: { razon_social: 'CKD', CK: { tipo_valor_id: '1R' } } });
  assert.equal(ck.tipo_valor_id, '1R', 'un CKD no es ICS y el filtro de universo lo deja fuera');
});

test('una emisora sin serie se guarda igual, con serie null y sin inventarla', () => {
  // Sin serie no se puede pedir /v2/historicos. Se guarda y se reporta; lo que
  // no se hace es adivinarle una, que produciría un emisora_serie inexistente.
  const [f] = filasDelCenso({ RARA: { tipo_valor_id: '1', rango_financieros: '2016-2/2026-2' } });
  assert.equal(f.serie, null);
  assert.equal(f.emisora_serie, 'RARA');
});

/* ── el presupuesto con series ──────────────────────────────────── */

test('estimarConsumo NO cobra dos veces los financieros de una emisora con dos series', () => {
  // /v2/financieros no conoce series: pedir LIVEPOLC-1 y LIVEPOL1 por separado
  // sería pagar 41 requests de más por emisora con doble serie.
  const dos = [
    { emisora: 'LIVEPOL', emisora_serie: 'LIVEPOLC-1', finDesde: COBERTURA_FIN.desde, finHasta: COBERTURA_FIN.hasta, histDesde: '2016-01-01', histHasta: '2026-09-16' },
    { emisora: 'LIVEPOL', emisora_serie: 'LIVEPOL1', finDesde: COBERTURA_FIN.desde, finHasta: COBERTURA_FIN.hasta, histDesde: '2016-01-01', histHasta: '2026-09-16' },
  ];
  const e = estimarConsumo({ emisoras: dos });
  assert.equal(e.requests.financieros, 41, 'un solo juego de trimestres');
  assert.equal(e.requests.historicos, 2, 'pero dos series de precios');
  assert.equal(e.emisoras, 1);
  assert.equal(e.series, 2);
});

test('estimarConsumo dice CÓMO partir la cosecha sólo cuando no cabe', () => {
  const chico = estimarConsumo({ emisoras: emisorasDemo(30) });
  assert.equal(chico.plan_si_no_cabe, null, 'si cabe, no hay nada que partir');

  // Un universo absurdo para forzar el caso: 6,000 emisoras × 41 > 200,000.
  const enorme = estimarConsumo({ emisoras: emisorasDemo(6000) });
  assert.equal(enorme.cabe_en_un_mes.A, false);
  assert.ok(enorme.plan_si_no_cabe.financieros_solos > 0);
  assert.ok(enorme.plan_si_no_cabe.historicos_solos > 0);
  assert.match(enorme.plan_si_no_cabe.mes_1, /financieros/);
});

/* ═══════════════════════════════════════════════════════════════
 * Los cuatro bugs de la primera corrida del censo. Todos de la misma
 * clase: el dato llegaba bien y el código lo tiraba. Cada test usa la
 * forma REAL que la API mandó, no una inventada.
 * ═══════════════════════════════════════════════════════════════ */

/** La cadena literal de WALMEX: lista por comas, en orden LEXICOGRÁFICO. */
function rangoWalmex() {
  const qs = [];
  for (const t of [1, 2, 3, 4]) {
    for (let a = 2016; a <= 2025; a++) {
      if (t === 1 && a === 2016) continue;      // la cobertura arranca en 2T2016
      qs.push(`${t}T_${a}`);
    }
  }
  return qs.join(', ');
}

test('BUG 1 · rango_financieros: la lista "1T_2017, ..., 2T_2016, ..." SÍ es válida', () => {
  // Esto dejó las 137 ICS con motivo "no se reconoce el formato" y la
  // cobertura en CERO. Fallar cerrado protege de inventar datos; no sirve de
  // nada si además tira los que llegan bien.
  const r = parsearRangoPeriodos(rangoWalmex());
  assert.equal(r.motivo, null, 'el formato bueno no puede salir con motivo');
  assert.deepEqual(r.rango.desde, { anio: 2016, trimestre: 2 });
  assert.deepEqual(r.rango.hasta, { anio: 2025, trimestre: 4 });
});

test('BUG 1b · el mínimo es CRONOLÓGICO, no el primero de la cadena', () => {
  // La lista viene ordenada lexicográficamente: '1T_2017' aparece ANTES que
  // '2T_2016'. Tomar el primero y el último daría el arranque un año tarde, y
  // eso mete a la emisora al universo en trimestres que no reportó.
  const cadena = rangoWalmex();
  assert.ok(cadena.startsWith('1T_2017'), 'la cadena real empieza por 1T_2017');
  const r = parsearRangoPeriodos(cadena);
  assert.deepEqual(r.rango.desde, { anio: 2016, trimestre: 2 }, 'pero el mínimo real es 2T2016');
});

test('BUG 1c · se conserva la ENUMERACIÓN, no sólo los extremos', () => {
  // La lista puede tener huecos, y un hueco no es un trimestre que valga un
  // request — ni un trimestre en el que la emisora deba entrar al universo.
  const r = parsearRangoPeriodos('2T_2016, 3T_2016, 1T_2020');
  assert.deepEqual(r.periodos.map((p) => `${p.anio}-${p.trimestre}`), ['2016-2', '2016-3', '2020-1']);
  assert.equal(r.periodos.length, 3, 'tres, no los 16 que hay entre los extremos');
});

test('BUG 1d · parseClavePeriodo habla los dos dialectos', () => {
  assert.deepEqual(parseClavePeriodo('2T_2016'), { anio: 2016, trimestre: 2 });
  assert.deepEqual(parseClavePeriodo('2016-2'), { anio: 2016, trimestre: 2 });
  assert.equal(parseClavePeriodo('5T_2016'), null);
  assert.equal(parseClavePeriodo('T_2016'), null);
});

test('BUG 2 · los dividendos cuelgan de la SERIE, y no se cruzan entre hermanas', () => {
  // Extraerlos del objeto de la emisora le daba a cada serie los repartos de
  // TODAS sus hermanas: LIVEPOL C-1 se llevaba los de LIVEPOL 1.
  const filas = filasDelCenso({
    LIVEPOL: {
      razon_social: 'Liverpool',
      'C-1': { tipo_valor_id: '1', dividendos: { '2025-12-17': [0.85] } },
      1: { tipo_valor_id: '1', dividendos: { '2025-06-10': [0.40] } },
    },
  });
  const por = Object.fromEntries(filas.map((f) => [f.emisora_serie, extraerDistribuciones(f.raw_serie).distribuciones]));
  assert.deepEqual(por['LIVEPOLC-1'].map(pagoMonto), [{ fecha_pago: '2025-12-17', monto: 0.85 }]);
  assert.deepEqual(por.LIVEPOL1.map(pagoMonto), [{ fecha_pago: '2025-06-10', monto: 0.40 }]);
});

test('BUG 2b · un reparto en ARREGLO o escalar ya no se descarta', () => {
  // WALMEX trae 11 entradas y salían como "sin reparto" porque el parser sólo
  // miraba objetos con llaves.
  assert.deepEqual(extraerDistribuciones({ dividendos: { '2025-12-17': [0.85] } }).distribuciones.map(pagoMonto),
    [{ fecha_pago: '2025-12-17', monto: 0.85 }]);
  assert.deepEqual(extraerDistribuciones({ dividendos: { '2025-12-17': 0.85 } }).distribuciones.map(pagoMonto),
    [{ fecha_pago: '2025-12-17', monto: 0.85 }]);
});

test('BUG 3 · los precios llegan como ARREGLO [precio, importe]', () => {
  // Formato real: {"2026-06-22": [50.57, 1313556324.33]}. El parser lo trataba
  // como objeto, no hallaba llaves y descartaba la fila: 7 de 7 de WALMEX se
  // perdían, e `importe_operado_presente` salía false con el importe presente.
  const { filas, descartadas } = aplanarHistoricos({
    '2026-06-22': [50.57, 1313556324.33],
    '2026-06-23': [51.10, 900000.5],
  });
  assert.equal(descartadas, 0);
  assert.equal(filas.length, 2);
  assert.equal(filas[0].cierre, 50.57);
  assert.equal(filas[0].importe, 1313556324.33, 'el importe es el segundo elemento');
});

test('BUG 3b · un arreglo de largo desconocido se descarta, no se adivina', () => {
  // Con 5 columnas el orden NO está verificado: meter el volumen donde va el
  // importe dejaría el filtro de liquidez midiendo otra cosa, en silencio.
  const { filas, descartadas } = aplanarHistoricos({ '2026-06-22': [1, 2, 3, 4, 5] });
  assert.equal(filas.length, 0);
  assert.equal(descartadas, 1);
});

test('BUG 3c · un arreglo de un solo elemento es el cierre, sin importe', () => {
  const { filas } = aplanarHistoricos({ '2026-06-22': [50.57] });
  assert.equal(filas[0].cierre, 50.57);
  assert.equal(filas[0].importe, null, 'null, no cero: un cero pasaría el filtro de liquidez');
});

test('BUG 4 · el identificador del benchmark se arma desde el censo, pegado', () => {
  const [f] = filasDelCenso({ NAFTRAC: { ISHRS: { tipo_valor_id: '1B' } } });
  assert.equal(f.emisora_serie, 'NAFTRACISHRS');
  assert.equal(paramsHistoricos(CONTRATO_DEFECTO, f.emisora_serie, 'a', 'b').emisora_serie, 'NAFTRACISHRS');
});

/* ── el censo completo, de punta a punta con la forma real ──────── */

test('una emisora real sale con cobertura, serie, tipo y dividendos', () => {
  const filas = filasDelCenso({
    WALMEX: {
      razon_social: 'Wal-Mart de México',
      '*': {
        tipo_valor_id: '1',
        estatus: 'ACTIVA',
        rango_financieros: rangoWalmex(),
        rango_historicos: '2010-01-04, 2026-09-15',
        dividendos: { '2025-12-17': [0.85], '2025-06-10': [0.70] },
      },
    },
  });
  assert.equal(filas.length, 1);
  const f = filas[0];
  assert.equal(f.emisora_serie, 'WALMEX*');
  assert.equal(f.tipo_valor_id, '1');
  assert.equal(f.estatus, 'ACTIVA');
  assert.equal(f.fin_desde, '2016-2', 'la cobertura ya NO sale en cero');
  assert.equal(f.fin_hasta, '2025-4');
  assert.equal(f.fin_motivo, null);
  assert.equal(f.fin_periodos.length, 39);
  assert.equal(f.hist_desde, '2010-01-04');
  assert.equal(extraerDistribuciones(f.raw_serie).distribuciones.length, 2);
});

test('estimarConsumo cobra los trimestres ENUMERADOS, no los del rango', () => {
  // Con huecos, min..max pediría requests que vuelven vacíos. La enumeración
  // da el número exacto.
  const e = estimarConsumo({
    emisoras: [{ emisora: 'X', emisora_serie: 'X*', finPeriodos: 3,
      finDesde: { anio: 2016, trimestre: 2 }, finHasta: { anio: 2020, trimestre: 1 },
      histDesde: '2016-01-01', histHasta: '2026-09-16' }],
  });
  assert.equal(e.requests.financieros, 3, 'tres, no los 16 del rango');
});

/* ═══════════════════════════════════════════════════════════════
 * La forma REAL del reparto, con el crudo de NAFTRAC:
 *   "reciente":  {"2026-08-31": {pago, tipo, divisa, fechaexcupon}}
 *   "historico": {"2025-12-31": {pago, tipo}}          ← sin ex, sin divisa
 * La LLAVE es la fecha de PAGO. `pago` es el MONTO, pese al nombre.
 * ═══════════════════════════════════════════════════════════════ */

const NAFTRAC_CRUDO = {
  dividendos: {
    reciente: {
      '2026-08-31': {
        pago: 0.01387504835,
        tipo: 'DISTRIBUCION DE EFECTIVO',
        divisa: 'MXN',
        fechaexcupon: '2026-08-28',
      },
    },
    historico: {
      '2025-12-31': { pago: 0.56096644127, tipo: 'DISTRIBUCION DE EFECTIVO' },
    },
  },
};

test('la llave es la fecha de PAGO y `pago` es el MONTO, pese al nombre', () => {
  const { distribuciones } = extraerDistribuciones(NAFTRAC_CRUDO);
  const reciente = distribuciones.find((d) => d.fecha_pago === '2026-08-31');
  assert.equal(reciente.monto, 0.01387504835, '`pago` es el monto, no una fecha');
  assert.equal(reciente.fecha_pago, '2026-08-31');
});

test('cuando viene `fechaexcupon` se usa ESA, sin aproximar', () => {
  const { distribuciones } = extraerDistribuciones(NAFTRAC_CRUDO);
  const r = distribuciones.find((d) => d.fecha_pago === '2026-08-31');
  assert.equal(r.fecha_ex, '2026-08-28', 'el dato real gana siempre');
  assert.equal(r.ex_aproximada, false);
  assert.equal(r.divisa, 'MXN');
});

test('sin `fechaexcupon` se aproxima pago − 3 días, Y SE MARCA', () => {
  // Todo el bloque "historico" —o sea casi todo lo que el backtest usa— llega
  // sin la ex. Aproximarla en silencio sería indistinguible de tenerla.
  const { distribuciones, aproximadas, pct_aproximadas } = extraerDistribuciones(NAFTRAC_CRUDO);
  const h = distribuciones.find((d) => d.fecha_pago === '2025-12-31');
  assert.equal(h.fecha_ex, '2025-12-28');
  assert.equal(h.ex_aproximada, true, 'marcada: una aproximación que no se marca se vuelve un dato');
  assert.equal(h.divisa, null, 'el histórico no trae divisa; no se le inventa MXN');
  assert.equal(aproximadas, 1);
  assert.equal(pct_aproximadas, 50, 'el porcentaje, no sólo el conteo');
});

test('el delta de 3 días es el observado en NAFTRAC: 31-ago pago → 28-ago ex', () => {
  assert.equal(DIAS_EX_APROX, 3);
  assert.equal(restaDias('2026-08-31', DIAS_EX_APROX), '2026-08-28',
    'el mismo delta que trae el dato real, no un número inventado');
  assert.equal(restaDias('2026-03-01', 3), '2026-02-26', 'cruza el fin de mes');
  assert.equal(restaDias('2024-03-01', 3), '2024-02-27', 'y el bisiesto');
});

test('`tipo` y `divisa` se cuentan, para no asumirlos en silencio', () => {
  const r = extraerDistribuciones(NAFTRAC_CRUDO);
  assert.deepEqual(r.tipos, { 'DISTRIBUCION DE EFECTIVO': 2 });
  assert.deepEqual(r.divisas, { MXN: 1 }, 'sólo una de las dos trae divisa, y eso se ve');
  assert.deepEqual(r.campos.sort(), ['divisa', 'fechaexcupon', 'pago', 'tipo']);
});

test('un reparto que NO es en efectivo no se reinvierte como tal', () => {
  // Un split o una entrega en especie no es dinero que nadie recibió. Contarlo
  // como efectivo sumaría retorno inexistente; dejarlo fuera lo subestima, que
  // es el lado barato de equivocarse — y queda visible en el conteo por tipo.
  const { distribuciones, tipos } = extraerDistribuciones({
    dividendos: {
      '2025-05-05': { pago: 1.0, tipo: 'DISTRIBUCION DE EFECTIVO' },
      '2025-06-06': { pago: 1.0, tipo: 'DIVIDENDO EN ACCIONES' },
    },
  });
  const efectivo = distribuciones.find((d) => d.fecha_pago === '2025-05-05');
  const especie = distribuciones.find((d) => d.fecha_pago === '2025-06-06');
  assert.equal(efectivo.es_efectivo, true);
  assert.equal(especie.es_efectivo, false);
  assert.equal(Object.keys(tipos).length, 2, 'los dos tipos quedan contados y a la vista');
});

test('una divisa distinta de MXN viaja hasta el reporte, no se asume', () => {
  const r = extraerDistribuciones({ dividendos: { '2025-05-05': { pago: 1.0, divisa: 'USD' } } });
  assert.equal(r.distribuciones[0].divisa, 'USD');
  assert.deepEqual(r.divisas, { USD: 1 });
});

test('dos repartos del mismo día con montos distintos se SUMAN, y se marca', () => {
  // Dejarlos como dos filas fue lo que reventó el insert: la llave de la tabla
  // es (emisora_serie, fecha_pago) y Postgres se niega a tocar la misma fila
  // dos veces en una sentencia. Elegir uno en silencio perdería dinero sin
  // rastro, así que se suman y la fila queda marcada.
  const { distribuciones, sumadas } = extraerDistribuciones({
    dividendos: { reciente: { '2025-05-05': { pago: 1.0 } }, historico: { '2025-05-05': { pago: 2.0 } } },
  });
  assert.equal(distribuciones.length, 1);
  assert.equal(distribuciones[0].monto, 3.0, 'no se pierde ninguno de los dos');
  assert.equal(distribuciones[0].pago_consolidado, true);
  assert.equal(sumadas, 1);
});

/* ═══════════════════════════════════════════════════════════════
 * El traslape entre "reciente" e "historico", que reventó el insert
 * con "ON CONFLICT DO UPDATE command cannot affect row a second time".
 * Postgres se niega a tocar la misma fila dos veces en una sentencia,
 * y hace bien: no hay forma de saber cuál de las dos gana. Se decide
 * ANTES del insert, donde se puede mirar el grupo completo.
 * ═══════════════════════════════════════════════════════════════ */

/** El crudo literal de NAFTRAC, con las dos fechas duplicadas reportadas. */
const NAFTRAC_TRASLAPE = {
  dividendos: {
    reciente: {
      '2026-08-31': { pago: 0.01387504835, tipo: 'DISTRIBUCION DE EFECTIVO', divisa: 'MXN', fechaexcupon: '2026-08-28' },
      '2022-07-29': { pago: 1e-7, tipo: 'DISTRIBUCION DE EFECTIVO', divisa: 'MXN', fechaexcupon: '2022-07-26' },
    },
    historico: {
      '2026-08-31': { pago: 0.01387504835, tipo: 'DISTRIBUCION DE EFECTIVO' },
      '2022-07-29': { pago: 1e-7, tipo: 'DISTRIBUCION DE EFECTIVO' },
      '2025-12-31': { pago: 0.56096644127, tipo: 'DISTRIBUCION DE EFECTIVO' },
    },
  },
};

test('la fecha de pago es ÚNICA después de consolidar — sin esto el insert revienta', () => {
  const { distribuciones } = extraerDistribuciones(NAFTRAC_TRASLAPE);
  const fechas = distribuciones.map((d) => d.fecha_pago);
  assert.equal(new Set(fechas).size, fechas.length,
    'una llave repetida en el mismo VALUES tumba la sentencia entera');
  assert.equal(distribuciones.length, 3, 'de las 5 filas crudas quedan 3 fechas');
});

test('al colapsar el traslape, gana la fila con fechaexcupon REAL', () => {
  // Es lo que hace valioso al bloque "reciente": la misma información que el
  // histórico, pero con la fecha buena. Quedarse con la aproximada tiraría el
  // único dato exacto que la fuente da.
  const { distribuciones } = extraerDistribuciones(NAFTRAC_TRASLAPE);
  const a = distribuciones.find((d) => d.fecha_pago === '2026-08-31');
  const b = distribuciones.find((d) => d.fecha_pago === '2022-07-29');
  assert.equal(a.fecha_ex, '2026-08-28');
  assert.equal(a.ex_aproximada, false);
  assert.equal(b.fecha_ex, '2022-07-26');
  assert.equal(b.ex_aproximada, false);
});

test('el duplicado exacto se colapsa SIN sumar: 1e-07 no se vuelve 2e-07', () => {
  // Mismo monto en los dos bloques es la MISMA distribución vista dos veces.
  // Sumarla duplicaría el reparto y con él el retorno total.
  const { distribuciones, colapsadas, sumadas } = extraerDistribuciones(NAFTRAC_TRASLAPE);
  const b = distribuciones.find((d) => d.fecha_pago === '2022-07-29');
  assert.equal(b.monto, 1e-7, 'el mismo monto, no el doble');
  assert.equal(b.pago_consolidado, false);
  assert.equal(colapsadas, 2, 'dos filas del traslape desaparecieron');
  assert.equal(sumadas, 0, 'ninguna se sumó: eran duplicados exactos');
});

test('los pagos de centésimas de centavo se CUENTAN, no se filtran', () => {
  // 1e-07 pesos casi seguro es un placeholder de la fuente y no un reparto.
  // Filtrarlo es una decisión de producto, no del parser: se reporta.
  const r = extraerDistribuciones(NAFTRAC_TRASLAPE);
  assert.equal(r.bajo_umbral, 1);
  assert.equal(r.umbral_placeholder, UMBRAL_PLACEHOLDER);
  assert.ok(r.distribuciones.some((d) => d.monto === 1e-7),
    'sigue ahí: la decisión de excluirlo no es del código');
});

test('consolidarDistribuciones no suma lo que no es efectivo', () => {
  const { filas } = consolidarDistribuciones([
    { fecha_pago: '2025-05-05', fecha_ex: '2025-05-02', ex_aproximada: true, monto: 1.0, es_efectivo: true },
    { fecha_pago: '2025-05-05', fecha_ex: '2025-05-02', ex_aproximada: true, monto: 9.0, es_efectivo: false },
  ]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].monto, 1.0, 'el reparto en especie no entra al retorno total');
  assert.equal(filas[0].es_efectivo, true);
});

test('consolidarDistribuciones deja pasar las fechas distintas intactas', () => {
  const { filas, colapsadas, sumadas } = consolidarDistribuciones([
    { fecha_pago: '2025-05-05', fecha_ex: '2025-05-02', ex_aproximada: true, monto: 1.0, es_efectivo: true },
    { fecha_pago: '2025-06-05', fecha_ex: '2025-06-02', ex_aproximada: true, monto: 2.0, es_efectivo: true },
  ]);
  assert.equal(filas.length, 2);
  assert.equal(colapsadas, 0);
  assert.equal(sumadas, 0);
});

/* ═══════════════════════════════════════════════════════════════
 * El censo tiene que ser DETERMINISTA. Dos corridas sobre el mismo
 * crudo dieron 595/185 y 597/183: filas que aparecen y tipos que se
 * pierden sin que nadie baje datos nuevos. Un censo que cambia solo
 * no sirve para un universo point-in-time.
 * ═══════════════════════════════════════════════════════════════ */

/** Quálitas cotiza como `Q`: una pizarra de UN carácter. Ese fue el caso. */
const CENSO_MIXTO = {
  WALMEX: { razon_social: 'Walmart', '*': { tipo_valor_id: '1', rango_financieros: '2T_2016, 4T_2025' } },
  Q: { razon_social: 'Quálitas', '*': { tipo_valor_id: '1', rango_financieros: '2T_2016, 4T_2025' } },
  GFNORTE: { razon_social: 'Banorte', O: { tipo_valor_id: '1', rango_financieros: '2T_2016, 4T_2025' } },
  NAFTRAC: { razon_social: 'iShares', ISHRS: { tipo_valor_id: '1B' } },
};

const claves = (censo) => filasDelCenso(censo).map((f) => `${f.emisora_serie}|${f.tipo_valor_id}`);

test('el censo da lo MISMO se pase entero o emisora por emisora', () => {
  // `?job=emisoras` pasa cientos de llaves de golpe; `?job=reparse` las pasaba
  // una a una. Con `llaves.length <= 3` el heurístico de envoltorio se
  // disparaba en el segundo caso y `Q*` salía como `*`.
  const juntas = claves(CENSO_MIXTO);
  const unaAUna = Object.entries(CENSO_MIXTO).flatMap(([k, v]) => claves({ [k]: v }));
  assert.deepEqual(unaAUna, juntas, 'el mismo crudo no puede dar dos censos distintos');
});

test('una pizarra de UN carácter no se confunde con un envoltorio', () => {
  const [f] = filasDelCenso({ Q: { razon_social: 'Quálitas', '*': { tipo_valor_id: '1' } } });
  assert.equal(f.emisora_serie, 'Q*', 'no `*`: la emisora es Q');
  assert.equal(f.tipo_valor_id, '1');
});

test('un envoltorio DE VERDAD sigue reconociéndose', () => {
  // La regla nueva mira la forma —una llave cuyo valor contiene dos o más
  // pizarras— y no el número de llaves del nivel de arriba.
  assert.deepEqual(claves({ data: CENSO_MIXTO }), claves(CENSO_MIXTO));
  assert.deepEqual(claves({ resultados: CENSO_MIXTO }), claves(CENSO_MIXTO));
});

test('el censo en lotes arbitrarios da siempre lo mismo', () => {
  const entradas = Object.entries(CENSO_MIXTO);
  const completo = claves(CENSO_MIXTO).sort();
  for (const tam of [1, 2, 3, 4]) {
    const porLotes = [];
    for (let i = 0; i < entradas.length; i += tam) {
      porLotes.push(...claves(Object.fromEntries(entradas.slice(i, i + tam))));
    }
    assert.deepEqual(porLotes.sort(), completo, `falló con lotes de ${tam}`);
  }
});

/* ── categoría del reparto: decisión explícita, no efecto de un regex ── */

test('categoriaReparto: el ORDEN importa — reembolso antes que efectivo', () => {
  // "REEMBOLSO DE CAPITAL EN EFECTIVO" contiene la palabra "efectivo". Con el
  // regex viejo habría entrado al retorno total como rendimiento, y un
  // reembolso de capital NO es rendimiento: es la empresa devolviendo
  // principal. Sumarlo infla el resultado con dinero que no es ganancia.
  assert.equal(categoriaReparto('REEMBOLSO DE CAPITAL EN EFECTIVO'), 'reembolso');
  assert.equal(esEfectivo('REEMBOLSO DE CAPITAL EN EFECTIVO'), false);
});

test('categoriaReparto clasifica los tipos observados y los que no', () => {
  assert.equal(categoriaReparto('DISTRIBUCION DE EFECTIVO'), 'efectivo');
  assert.equal(categoriaReparto('REEMBOLSO'), 'reembolso');
  assert.equal(categoriaReparto('DIVIDENDO EN ACCIONES'), 'especie');
  assert.equal(categoriaReparto('SPLIT'), 'especie');
  assert.equal(categoriaReparto('ALGO QUE NO CONOCEMOS'), 'desconocido');
  assert.equal(categoriaReparto(null), 'efectivo', 'sin tipo no hay nada que distinguir');
});

test('sólo `efectivo` entra al retorno total', () => {
  for (const t of ['REEMBOLSO', 'DIVIDENDO EN ACCIONES', 'ALGO RARO']) {
    assert.equal(esEfectivo(t), false, `${t} no debe entrar`);
  }
  assert.equal(esEfectivo('DISTRIBUCION DE EFECTIVO'), true);
});

/* ── divisa: nada se asume ──────────────────────────────────────── */

test('requiereConversion sólo marca lo que VIENE y no es MXN', () => {
  assert.equal(requiereConversion('USD'), true);
  assert.equal(requiereConversion('EUR'), true);
  assert.equal(requiereConversion('MXN'), false);
  assert.equal(requiereConversion('mxn'), false);
  // Un null NO se declara MXN aquí: el histórico no trae divisa, y decidirlo
  // en el parser sería inventar. La propagación por serie se decide arriba.
  assert.equal(requiereConversion(null), false);
  assert.equal(requiereConversion(undefined), false);
});

test('la marca de conversión se PROPAGA al consolidar el grupo', () => {
  // El bloque "reciente" trae divisa y el "historico" no. Si sólo se mirara la
  // fila que gana, un reparto en USD cuya versión histórica no trae divisa
  // quedaría sin marcar — y se reinvertiría como si fueran pesos.
  const { filas } = consolidarDistribuciones([
    { fecha_pago: '2025-05-05', fecha_ex: '2025-05-02', ex_aproximada: true, monto: 1.0, es_efectivo: true, requiere_conversion: false },
    { fecha_pago: '2025-05-05', fecha_ex: '2025-05-02', ex_aproximada: false, monto: 1.0, es_efectivo: true, requiere_conversion: true },
  ]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].requiere_conversion, true, 'si cualquiera del grupo la necesita, el grupo la necesita');
});

test('extraerDistribuciones cuenta categorías y conversiones', () => {
  const r = extraerDistribuciones({
    dividendos: {
      '2025-01-05': { pago: 1.0, tipo: 'DISTRIBUCION DE EFECTIVO', divisa: 'MXN' },
      '2025-02-05': { pago: 2.0, tipo: 'REEMBOLSO', divisa: 'MXN' },
      '2025-03-05': { pago: 3.0, tipo: 'DISTRIBUCION DE EFECTIVO', divisa: 'USD' },
    },
  });
  assert.deepEqual(r.categorias, { efectivo: 2, reembolso: 1 });
  assert.equal(r.requieren_conversion, 1);
});

/* ── la lista de trabajo de financieros ─────────────────────────── */

test('la cosecha pide los trimestres ENUMERADOS, no el rango relleno', () => {
  // Con huecos, min..max manda requests que vuelven vacíos y mete a la emisora
  // al universo en trimestres que no reportó. Además el estimate ya contaba con
  // la enumeración: sin esto, la cosecha pediría más de lo presupuestado.
  const e = {
    emisora: 'X', emisora_serie: 'X*', tipo_valor_id: '1',
    fin_periodos: ['2016-2', '2016-3', '2020-1'],
    fin_desde: '2016-2', fin_hasta: '2020-1',
  };
  const trimestres = pendientesFinancieros([e]);
  assert.deepEqual(trimestres.map((t) => t.clave), ['2016-2', '2016-3', '2020-1']);
  assert.equal(trimestres.length, 3, 'tres, no los 16 que hay entre los extremos');
});

test('una emisora con dos series conserva la que SÍ tiene cobertura', () => {
  // Los campos del censo son del instrumento, así que una serie puede traer
  // cobertura y la otra no. Quedarse con la primera que llegue perdería los
  // financieros de la emisora entera si la serie vacía ordena antes.
  const sinCobertura = { emisora: 'DOBLE', emisora_serie: 'DOBLE1', tipo_valor_id: '1', fin_periodos: null, fin_desde: null };
  const conCobertura = { emisora: 'DOBLE', emisora_serie: 'DOBLEB', tipo_valor_id: '1', fin_periodos: ['2016-2', '2016-3'], fin_desde: '2016-2', fin_hasta: '2016-3' };
  assert.equal(pendientesFinancieros([sinCobertura, conCobertura]).length, 2, 'la vacía llega primero');
  assert.equal(pendientesFinancieros([conCobertura, sinCobertura]).length, 2, 'y al revés también');
});

test('una emisora SIN cobertura no genera ni un request', () => {
  // Los 20 bancos y casas de bolsa del censo caen acá: sin rango_financieros no
  // hay nada que pedir, y tampoco entran al universo de la v1.
  const banco = { emisora: 'GFNORTE', emisora_serie: 'GFNORTEO', tipo_valor_id: '1', fin_periodos: null, fin_desde: null, fin_hasta: null };
  assert.deepEqual(pendientesFinancieros([banco]), []);
});

test('no se pide dos veces la misma emisora por tener dos series', () => {
  const a = { emisora: 'LIVEPOL', emisora_serie: 'LIVEPOLC-1', tipo_valor_id: '1', fin_periodos: ['2016-2'], fin_desde: '2016-2', fin_hasta: '2016-2' };
  const b = { emisora: 'LIVEPOL', emisora_serie: 'LIVEPOL1', tipo_valor_id: '1', fin_periodos: ['2016-2'], fin_desde: '2016-2', fin_hasta: '2016-2' };
  assert.equal(pendientesFinancieros([a, b]).length, 1, '/v2/financieros no conoce series');
});

/* ═══════════════════════════════════════════════════════════════
 * El valor llega como ["etiqueta", 0.77], no como número suelto.
 * `aNumero` devuelve null para un arreglo, así que los 7 campos de
 * las 4,174 filas cosechadas salieron null. No fue un bug del EPS:
 * fue de TODA la normalización.
 * ═══════════════════════════════════════════════════════════════ */

/** La respuesta literal de WALMEX 2T_2017, con la forma que la API manda. */
const WALMEX_2T2017 = {
  posicion: {
    '2017-06-30': {
      assets: ['activos totales', 1000],
      liabilities: ['pasivos totales', 400],
      equity: ['capital contable', 600],
      cashandcashequivalents: ['efectivo y equivalentes', 50],
    },
  },
  resultado_trimestre: {
    '2017-04-01_2017-06-30': {
      basicearningslosspershare: ['utilidad (pérdida) básica por acción', 0.77],
      dilutedearningslosspershare: ['utilidad (pérdida) básica por acción diluida', 0.77],
      basicearningslosspersharefromcontinuingoperations: ['de operaciones continuas', 0.39],
      basicearningslosspersharefromdiscontinuedoperations: ['de operaciones discontinuadas', 0.38],
      revenue: ['ingresos', 150000],
      profitlossattributabletoownersofparent: ['utilidad de la controladora', 13000],
    },
  },
};

test('valorDeCampo lee el arreglo [etiqueta, valor]', () => {
  assert.equal(valorDeCampo(['utilidad (pérdida) básica por acción', 0.77]), 0.77);
  assert.equal(valorDeCampo(['activos totales', 1000]), 1000);
  assert.equal(valorDeCampo(['etiqueta', '1,234.56']), 1234.56, 'y el número sigue pasando por aNumero');
  assert.equal(valorDeCampo(42), 42, 'un número suelto sigue funcionando');
});

test('valorDeCampo NO adivina en un arreglo de forma desconocida', () => {
  // Con dos números no hay manera de saber cuál es el valor. Adivinar la
  // posición es cómo se meten cifras equivocadas que parecen correctas.
  assert.equal(valorDeCampo(['etiqueta', 1, 2]), null);
  assert.equal(valorDeCampo(['sólo etiqueta']), null);
  assert.equal(valorDeCampo([]), null);
});

test('los 7 campos salen de la respuesta REAL — ninguno queda null', () => {
  const { valores, faltantes } = normalizarFinancieros(WALMEX_2T2017);
  assert.equal(faltantes, null, 'cero faltantes: antes eran los 7');
  assert.equal(valores.revenue, 150000);
  assert.equal(valores.assets, 1000);
  assert.equal(valores.liabilities, 400);
  assert.equal(valores.equity, 600);
  assert.equal(valores.cashandcashequivalents, 50);
  assert.equal(valores.profitlossattributabletoownersofparent, 13000);
  assert.equal(valores.basicearningslosspershare, 0.77);
});

test('el EPS es el TOTAL, no el de operaciones continuas', () => {
  // 0.39 (continuas) + 0.38 (discontinuadas) = 0.77 (total). Para el value
  // queremos el total: es lo que le tocó al accionista en el periodo, y es el
  // único campo que TODAS las emisoras traen — el desglose sólo aparece cuando
  // hubo operaciones discontinuadas.
  const { valores } = normalizarFinancieros(WALMEX_2T2017);
  assert.equal(valores.basicearningslosspershare, 0.77);
  assert.notEqual(valores.basicearningslosspershare, 0.39, 'no el de continuas');
  assert.notEqual(valores.basicearningslosspershare, 0.38, 'ni el de discontinuadas');
});

test('el EPS diluido no contamina al básico: la llave se compara exacta', () => {
  // `dilutedearningslosspershare` contiene la subcadena del básico si se
  // buscara por inclusión. Se compara la llave COMPLETA, así que no hay
  // ambigüedad aunque los dos valgan lo mismo.
  const r = resolverCampo(WALMEX_2T2017, 'basicearningslosspershare');
  assert.equal(r.valor, 0.77);
  assert.match(r.ruta, /resultado_trimestre/);
  assert.ok(!r.motivo);
});

test('el EPS sale de resultado_trimestre, no de posicion', () => {
  const r = resolverCampo(WALMEX_2T2017, 'basicearningslosspershare');
  assert.ok(r.ruta.startsWith('resultado_trimestre.'), `salió de ${r.ruta}`);
});

test('una emisora sin operaciones discontinuadas también resuelve', () => {
  const simple = {
    resultado_trimestre: { '2017-04-01_2017-06-30': { basicearningslosspershare: ['upa', 1.25] } },
  };
  assert.equal(normalizarFinancieros(simple).valores.basicearningslosspershare, 1.25);
});

/* ═══════════════════════════════════════════════════════════════
 * El inspector del crudo. Existe porque el arreglo del
 * ["etiqueta", valor] NO era la causa raíz: de 1,000 filas
 * re-parseadas sólo 65 quedaron con campos. Su trabajo es describir
 * lo que hay SIN interpretarlo — si el parser y el inspector no
 * coinciden, el desacuerdo es el hallazgo.
 * ═══════════════════════════════════════════════════════════════ */

test('tipoDe distingue arreglo, null y objeto — que es donde se esconden estas cosas', () => {
  assert.equal(tipoDe(['etiqueta', 0.77]), 'array[2]');
  assert.equal(tipoDe(null), 'null');
  assert.equal(tipoDe({}), 'object');
  assert.equal(tipoDe(0.77), 'number');
  assert.equal(tipoDe('0.77'), 'string', 'un número como texto NO es lo mismo');
});

test('describirCrudo no normaliza: reporta el valor y el tipo tal cual', () => {
  const d = describirCrudo({
    resultado_trimestre: { '2017-04-01_2017-06-30': { basicearningslosspershare: ['upa', 0.77] } },
  });
  const [hallazgo] = d.campos.basicearningslosspershare;
  assert.equal(hallazgo.tipo, 'array[2]');
  assert.deepEqual(hallazgo.valor, ['upa', 0.77], 'el valor literal, no el interpretado');
  assert.equal(hallazgo.ruta, 'resultado_trimestre.2017-04-01_2017-06-30.basicearningslosspershare');
});

test('hipótesis (a): un nivel extra de envoltura se ve en la ruta', () => {
  const d = describirCrudo({ data: { posicion: { '2017-06-30': { assets: ['activos', 1000] } } } });
  assert.deepEqual(d.nivel_1.map((x) => x.llave), ['data']);
  assert.match(d.campos.assets[0].ruta, /^data\.posicion\./);
});

test('hipótesis (b): si sólo se pidió un bloque, el otro campo NO APARECE', () => {
  const d = describirCrudo({ resultado_trimestre: { '2017-04-01_2017-06-30': { revenue: ['ingresos', 150000] } } });
  assert.deepEqual(d.nivel_1.map((x) => x.llave), ['resultado_trimestre']);
  assert.equal(d.campos.assets, 'NO APARECE en ningún nivel');
  assert.ok(Array.isArray(d.campos.revenue));
});

test('hipótesis (c): llaveado por fecha vs campo directo se distingue en nivel_2', () => {
  const porFecha = describirCrudo({ posicion: { '2017-06-30': { assets: ['a', 1] } } });
  const directo = describirCrudo({ posicion: { assets: ['a', 1] } });
  assert.deepEqual(porFecha.nivel_2.posicion.map((x) => x.llave), ['2017-06-30']);
  assert.deepEqual(directo.nivel_2.posicion.map((x) => x.llave), ['assets']);
  assert.equal(porFecha.campos.assets[0].ruta, 'posicion.2017-06-30.assets');
  assert.equal(directo.campos.assets[0].ruta, 'posicion.assets');
});

test('hipótesis (d): dos formas distintas se ven en las llaves de primer nivel', () => {
  const vieja = describirCrudo({ resultado_trimestre: {} });
  const nueva = describirCrudo({ posicion: {}, resultado_trimestre: {} });
  assert.notDeepEqual(vieja.nivel_1.map((x) => x.llave), nueva.nivel_1.map((x) => x.llave));
});

test('describirCrudo aguanta un crudo que NO es un objeto', () => {
  // Si la cosecha guardó una cadena de error o un arreglo, el inspector tiene
  // que decirlo en vez de reventar — es justo el caso que uno no anticipa.
  for (const v of [null, 'error de la API', 42, []]) {
    const d = describirCrudo(v);
    assert.ok(d.tipo_raiz, `sin tipo_raiz para ${JSON.stringify(v)}`);
    assert.equal(d.nivel_1, null);
  }
});

test('literal recorta lo gigante pero deja ver que se recortó', () => {
  const largo = { x: 'y'.repeat(500) };
  const out = literal(largo, 50);
  assert.equal(typeof out, 'string');
  assert.match(out, /\(\+\d+\)$/, 'dice cuánto se quedó fuera');
  assert.deepEqual(literal({ a: 1 }), { a: 1 }, 'lo chico pasa entero');
});

test('un campo que aparece en DOS rutas se reporta dos veces, sin elegir', () => {
  // El parser falla cerrado ante la ambigüedad; el inspector la muestra. Ver
  // las dos rutas es lo que permite decidir cuál es la buena.
  const d = describirCrudo({
    posicion: { '2017-06-30': { assets: ['a', 1000] } },
    otro: { assets: ['a', 2000] },
  });
  assert.equal(d.campos.assets.length, 2);
  assert.deepEqual(d.campos.assets.map((x) => x.valor[1]).sort(), [1000, 2000]);
});

/* ═══════════════════════════════════════════════════════════════
 * LA RUTA REAL DE CADA JOB.
 *
 * `?job=inspect` salió a prod con `parseClavePeriodo is not defined`:
 * la función existía en databursatil.js pero no estaba importada.
 * `node --check` pasó —valida sintaxis, no resolución de nombres— y
 * los tests sólo tocaban `describirCrudo` aislado, así que la línea
 * que la llamaba nunca se ejecutó.
 *
 * Es el mismo caso de la colisión del parámetro `fila`. La lección se
 * repite: un módulo que no se EJECUTA no está probado.
 *
 * Estos tests llaman a cada job y sólo exigen una cosa: que la falla
 * sea la de la base (no hay DATABASE_URL) y NO un ReferenceError. O
 * sea, que la ruta de entrada resuelva todos sus nombres.
 * ═══════════════════════════════════════════════════════════════ */

const JOBS = [
  ['inspect', jobInspect, { emisora: 'WALMEX', periodo: '2T_2017' }],
  ['inspect (sin params)', jobInspect, {}],
  ['reparse-fin', jobReparseFinancieros, { max: '10' }],
  ['reparse', jobReparse, {}],
  ['probe', jobProbe, { emisora: 'WALMEX' }],
  ['emisoras', jobEmisoras, {}],
  ['financieros', jobFinancieros, { max: '1' }],
  ['historicos', jobHistoricos, { max: '1' }],
];

for (const [nombre, job, query] of JOBS) {
  test(`job ${nombre}: su ruta de entrada resuelve todos sus nombres`, async () => {
    // Sin DATABASE_URL todos deben morir en el MISMO punto: la frontera de la
    // base. Cualquier otra cosa —sobre todo un ReferenceError— es un nombre sin
    // importar, que es exactamente lo que se escapó a prod.
    const previa = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await job({ query });
      // Si no lanzó, también está bien: significa que llegó hasta el final.
    } catch (e) {
      assert.ok(!(e instanceof ReferenceError),
        `${nombre} lanzó ReferenceError — hay un nombre sin definir ni importar: ${e.message}`);
      assert.match(e.message, /DATABASE_URL|Neon|fetch|red:/i,
        `${nombre} falló por algo que no es la frontera de la base: ${e.message}`);
    } finally {
      if (previa !== undefined) process.env.DATABASE_URL = previa;
    }
  });
}

test('el handler despacha los jobs protegidos sin rebotar en auth', async () => {
  // OJO CON LO QUE ESTE TEST *NO* PRUEBA. El handler corre `ensureBmvSchema()`
  // ANTES del dispatch, así que sin DATABASE_URL muere ahí y nunca entra al
  // cuerpo del job. Se verificó: con el bug de `parseClavePeriodo` puesto, este
  // test PASA.
  //
  // O sea que la protección real son los tests de `job …` de arriba, que llaman
  // a cada job directamente. Éste sólo cubre el árbol de auth y despacho —que
  // también es código— y queda escrito así para que nadie lea de más en él.
  const previaDb = process.env.DATABASE_URL;
  const previaSecret = process.env.ADMIN_SECRET;
  delete process.env.DATABASE_URL;
  process.env.ADMIN_SECRET = 'secreto-de-prueba';
  const respuestas = [];
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(b) { respuestas.push({ codigo: this._c, cuerpo: b }); return this; },
    send(b) { respuestas.push({ codigo: this._c, cuerpo: b }); return this; },
    end() { return this; },
  };
  try {
    for (const job of ['inspect', 'reparse', 'reparse-fin']) {
      await handler({
        method: 'GET',
        headers: { authorization: 'Bearer secreto-de-prueba' },
        query: { job, emisora: 'WALMEX', periodo: '2T_2017' },
      }, res);
    }
  } finally {
    if (previaDb !== undefined) process.env.DATABASE_URL = previaDb;
    if (previaSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = previaSecret;
  }
  assert.equal(respuestas.length, 3);
  for (const r of respuestas) {
    assert.notEqual(r.codigo, 401, 'con el secret correcto no debe rebotar en auth');
    const texto = JSON.stringify(r.cuerpo);
    assert.ok(!/is not defined|is not a function/.test(texto),
      `el handler devolvió un error de nombre: ${texto.slice(0, 200)}`);
  }
});

test('sin ADMIN_SECRET los jobs protegidos SÍ rebotan en 401', async () => {
  const previaDb = process.env.DATABASE_URL;
  const previaSecret = process.env.ADMIN_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_SECRET;
  delete process.env.CRON_SECRET;
  let salida = null;
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(b) { salida = { codigo: this._c, cuerpo: b }; return this; },
    send() { return this; }, end() { return this; },
  };
  try {
    await handler({ method: 'GET', headers: {}, query: { job: 'inspect' } }, res);
  } finally {
    if (previaDb !== undefined) process.env.DATABASE_URL = previaDb;
    if (previaSecret !== undefined) process.env.ADMIN_SECRET = previaSecret;
  }
  assert.equal(salida.codigo, 401, 'fail closed: sin secret no se lee la base');
});

test('el handler contesta los jobs públicos sin reventar por nombres', async () => {
  // El handler es la otra ruta de entrada, y tiene su propio árbol de ifs.
  const previa = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const respuestas = [];
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(b) { respuestas.push({ codigo: this._c, cuerpo: b }); return this; },
    send(b) { respuestas.push({ codigo: this._c, cuerpo: b }); return this; },
    end() { return this; },
  };
  try {
    for (const job of ['estimate', 'contrato', 'cobertura', 'inspect', '']) {
      await handler({ method: 'GET', headers: {}, query: { job } }, res);
    }
  } finally {
    if (previa !== undefined) process.env.DATABASE_URL = previa;
  }
  assert.equal(respuestas.length, 5);
  for (const r of respuestas) {
    const texto = JSON.stringify(r.cuerpo);
    assert.ok(!/is not defined|is not a function/.test(texto),
      `el handler devolvió un error de nombre: ${texto.slice(0, 200)}`);
  }
});

/* ═══════════════════════════════════════════════════════════════
 * DOS PERIODOS POR RESPUESTA. Cada llamada a /v2/financieros trae el
 * solicitado Y el comparativo del año anterior:
 *
 *   posicion:            { "2017-06-30", "2016-12-31" }
 *   resultado_trimestre: { "2017-04-01_2017-06-30", "2016-04-01_2016-06-30" }
 *
 * `resolverCampo` veía dos valores, los declaraba AMBIGUO y fallaba
 * cerrado. Correcto como default; equivocado acá, porque no hay
 * ambigüedad que resolver: hay que SELECCIONAR POR FECHA.
 * ═══════════════════════════════════════════════════════════════ */

/** La respuesta real de WALMEX 2T_2017, con sus dos periodos. */
const DOS_PERIODOS = {
  posicion: {
    '2017-06-30': { assets: ['activos', 1000], liabilities: ['pasivos', 400], equity: ['capital', 600], cashandcashequivalents: ['efectivo', 50] },
    '2016-12-31': { assets: ['activos', 900], liabilities: ['pasivos', 380], equity: ['capital', 520], cashandcashequivalents: ['efectivo', 45] },
  },
  resultado_trimestre: {
    '2017-04-01_2017-06-30': { revenue: ['ingresos', 135723675000], basicearningslosspershare: ['upa', 0.77], profitlossattributabletoownersofparent: ['contro', 13000] },
    '2016-04-01_2016-06-30': { revenue: ['ingresos', 125000000000], basicearningslosspershare: ['upa', 0.70], profitlossattributabletoownersofparent: ['contro', 11800] },
  },
};

test('finDeClave entiende las dos formas de llave', () => {
  assert.equal(finDeClave('2017-06-30'), '2017-06-30', 'posicion: la fecha ES el cierre');
  assert.equal(finDeClave('2017-04-01_2017-06-30'), '2017-06-30', 'resultado: el FIN es el cierre');
  assert.equal(finDeClave('assets'), null, 'un campo no es un periodo');
  assert.equal(finDeClave('2017'), null);
});

test('con dos periodos se elige el SOLICITADO, no se falla por ambiguo', () => {
  const r = normalizarFinancieros(DOS_PERIODOS, '2017-06-30');
  assert.equal(r.faltantes, null, 'cero faltantes: antes eran los 7 por AMBIGUO');
  assert.equal(r.valores.revenue, 135723675000);
  assert.equal(r.valores.basicearningslosspershare, 0.77);
  assert.equal(r.valores.assets, 1000, 'el del cierre, no los 900 del año pasado');
});

test('la selección queda AUDITABLE: se guarda qué llave se usó por bloque', () => {
  const r = normalizarFinancieros(DOS_PERIODOS, '2017-06-30');
  assert.deepEqual(r.bloques, {
    posicion: '2017-06-30',
    resultado_trimestre: '2017-04-01_2017-06-30',
  });
});

test('el comparativo se guarda aparte, con SUS fechas', () => {
  // En `resultado_trimestre` el comparativo es el mismo trimestre del año
  // pasado; en `posicion` es el cierre fiscal anterior (31-dic), no junio del
  // año pasado. Se guarda con sus fechas para que nadie lo lea como "hace un
  // año" en los dos casos.
  const r = normalizarFinancieros(DOS_PERIODOS, '2017-06-30');
  assert.equal(r.comparativo.valores.basicearningslosspershare, 0.70);
  assert.equal(r.comparativo.valores.assets, 900);
  assert.deepEqual(r.comparativo.bloques, {
    posicion: '2016-12-31',
    resultado_trimestre: '2016-04-01_2016-06-30',
  });
});

test('EL CASO ACCELSA: dos periodos con el MISMO valor era un falso positivo', () => {
  // Los dos periodos traían 0.39 por coincidencia, así que `resolverCampo` los
  // vio idénticos, no marcó ambigüedad y guardó el valor. Quedaba "bien" por
  // casualidad: si el año anterior hubiera diferido, habría fallado — y peor,
  // en otra emisora el mismo mecanismo pudo haber guardado el valor de un solo
  // periodo sin que nadie lo notara.
  const accelsa = {
    resultado_trimestre: {
      '2017-04-01_2017-06-30': { basicearningslosspershare: ['upa', 0.39] },
      '2016-04-01_2016-06-30': { basicearningslosspershare: ['upa', 0.39] },
    },
  };
  const r = normalizarFinancieros(accelsa, '2017-06-30');
  assert.equal(r.valores.basicearningslosspershare, 0.39);
  // Lo que cambia no es el número: es que AHORA viene del periodo correcto y
  // queda dicho cuál fue.
  assert.equal(r.bloques.resultado_trimestre, '2017-04-01_2017-06-30');
  assert.equal(r.comparativo.valores.basicearningslosspershare, 0.39);
});

test('si NINGUNA llave corresponde al periodo, falla con nombre — no adivina', () => {
  // Tomar "la única que hay" es exactamente cómo se cuela el dato del año
  // pasado en la serie.
  const r = normalizarFinancieros(DOS_PERIODOS, '2019-03-31');
  assert.equal(r.valores.revenue, null);
  assert.equal(r.valores.assets, null);
  assert.match(r.faltantes.revenue, /sin periodo correspondiente/);
  assert.match(r.faltantes.assets, /sin periodo correspondiente/);
  assert.deepEqual(r.bloques, {}, 'ningún bloque aportó');
});

test('con TRES periodos el comparativo es el anterior más cercano', () => {
  const tres = {
    resultado_trimestre: {
      '2017-04-01_2017-06-30': { revenue: ['r', 300] },
      '2016-04-01_2016-06-30': { revenue: ['r', 200] },
      '2015-04-01_2015-06-30': { revenue: ['r', 100] },
    },
  };
  const r = normalizarFinancieros(tres, '2017-06-30');
  assert.equal(r.valores.revenue, 300);
  assert.equal(r.comparativo.valores.revenue, 200, 'el más cercano hacia atrás, determinista');
});

test('la ambigüedad DENTRO del mismo periodo sigue fallando cerrado', () => {
  // Seleccionar por fecha resuelve la ambigüedad ENTRE periodos. Dos valores
  // distintos bajo el mismo nombre dentro del MISMO periodo siguen siendo
  // ambiguos de verdad, y eso no se toca.
  const r = normalizarFinancieros({
    posicion: { '2017-06-30': { assets: ['a', 1000], otro: { assets: ['a', 2000] } } },
  }, '2017-06-30');
  assert.equal(r.valores.assets, null);
  assert.match(r.faltantes.assets, /AMBIGUO/);
});

test('recortarAlPeriodo ignora bloques sin llaves de periodo', () => {
  const corte = recortarAlPeriodo({
    posicion: { '2017-06-30': { assets: ['a', 1] } },
    metadatos: { emisora: 'WALMEX', creditos: 1 },
  }, '2017-06-30');
  assert.deepEqual(Object.keys(corte.actual), ['posicion']);
  assert.deepEqual(corte.sin_periodo, [], 'un bloque que no es de periodos no cuenta como faltante');
});

test('sin `cierre` se mantiene la búsqueda en todo el árbol', () => {
  // Es lo correcto sólo para respuestas de un solo periodo, y es lo que usan
  // los tests de forma. Con dos periodos y valores distintos, falla cerrado.
  const uno = { resultado_trimestre: { '2017-04-01_2017-06-30': { revenue: ['r', 500] } } };
  assert.equal(normalizarFinancieros(uno).valores.revenue, 500);
  assert.equal(normalizarFinancieros(DOS_PERIODOS).valores.revenue, null, 'dos valores distintos sin fecha que los separe');
});
