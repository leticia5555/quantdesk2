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
  aNumero, aplanarHistoricos, clavePeriodo, construirUrl, emisoraSerie,
  extraerDistribuciones, finDeTrimestre, mesPresupuesto, normalizarFinancieros,
  parseClavePeriodo, periodoApi, restaDias, DIAS_EX_APROX,
  parsearRangoFechas, parsearRangoPeriodos, recortarACobertura, resolverCampo,
  trimestresEntre, urlSegura,
} from '../api/_lib/databursatil.js';

import {
  CONTRATO_DEFECTO, TOPE_PROBE, candidatosFinancieros, candidatosHistoricos, contar,
  estimarConsumo, filaCenso, filasDelCenso, nuevaCartera, pareceClave, pareceSerie,
  paramsBenchmark, paramsFinancieros, paramsHistoricos, parsePeriodoTexto,
  seriesDeEmisora, sirveFinanciero,
} from '../api/bmv-harvest.js';

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

test('dos repartos del mismo día con montos distintos no se colapsan', () => {
  // La llave de deduplicación es (fecha_pago, monto): dos repartos el mismo día
  // son raros pero posibles, y perder uno subestimaría el retorno total.
  const { distribuciones } = extraerDistribuciones({
    dividendos: { reciente: { '2025-05-05': { pago: 1.0 } }, historico: { '2025-05-05': { pago: 2.0 } } },
  });
  assert.equal(distribuciones.length, 2);
});
