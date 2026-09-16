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
  COBERTURA_FIN, PRESUPUESTO_MENSUAL,
  aNumero, aplanarHistoricos, clavePeriodo, construirUrl, finDeTrimestre,
  mesPresupuesto, normalizarFinancieros, parseClavePeriodo, parsearRangoFechas,
  parsearRangoPeriodos, recortarACobertura, resolverCampo, trimestresEntre, urlSegura,
} from '../api/_lib/databursatil.js';

import {
  CONTRATO_DEFECTO, candidatosFinancieros, candidatosHistoricos, contar,
  estimarConsumo, filaCenso, filasDelCenso, nuevaCartera, pareceClave,
  paramsFinancieros, paramsHistoricos, parsePeriodoTexto, sirveFinanciero,
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
  emisora: `E${i}`, finDesde: COBERTURA_FIN.desde, finHasta: COBERTURA_FIN.hasta,
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

test('paramsHistoricos respeta la grafía descubierta', () => {
  assert.deepEqual(paramsHistoricos({ historicos: { inicio: 'fecha_inicio', final: 'fecha_final' } }, 'WALMEX', '2016-01-01', '2026-09-16'),
    { emisora: 'WALMEX', fecha_inicio: '2016-01-01', fecha_final: '2026-09-16' });
});

test('el contrato de arranque viene marcado como NO verificado', () => {
  assert.equal(CONTRATO_DEFECTO.verificado, false,
    'que exista un default no significa que esté verificado: significa que el probe tiene por dónde empezar');
});

test('los candidatos del probe caben en el tope y no se repiten', () => {
  const f = candidatosFinancieros(2026, 2);
  const h = candidatosHistoricos('2026-06-20', '2026-06-30');
  assert.ok(1 + f.length + h.length <= 15, 'el probe no debe poder pasarse de su tope duro');
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
