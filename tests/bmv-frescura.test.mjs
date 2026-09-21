// ═══════════════════════════════════════════════════════════════════
// tests/bmv-frescura.test.mjs — la alerta de precios rancios.
//
// El caso que le da origen está escrito tal cual: última fecha 2026-09-15,
// consulta el lunes 21, con el 16 de septiembre de asueto en medio. La
// respuesta correcta es DOS sesiones perdidas (17 y 18), no seis días.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASUETOS_BMV, MAX_DIAS_HABILES,
  esFinDeSemana, esSesion, sesionEsperada, sesionesFaltantes, frescuraPrecios,
} from '../api/_lib/bmv-frescura.js';

test('sábado y domingo no son sesión', () => {
  assert.equal(esFinDeSemana('2026-09-19'), true);   // sábado
  assert.equal(esFinDeSemana('2026-09-20'), true);   // domingo
  assert.equal(esFinDeSemana('2026-09-18'), false);  // viernes
  assert.equal(esSesion('2026-09-19'), false);
  assert.equal(esSesion('2026-09-18'), true);
});

test('el 16 de septiembre no es sesión aunque sea miércoles', () => {
  assert.equal(esFinDeSemana('2026-09-16'), false);
  assert.equal(esSesion('2026-09-16'), false);
  assert.equal(ASUETOS_BMV['2026-09-16'], 'Independencia');
});

test('antes del cierre, la sesión esperada es la de AYER', () => {
  // Jueves 17 a las 14:00 UTC = 8:00 CDMX: la bolsa ni abrió.
  assert.equal(sesionEsperada({ ahora: new Date('2026-09-17T14:00:00Z') }), '2026-09-15');
  // Jueves 17 a las 23:00 UTC = 17:00 CDMX: ya cerró (y el 16 fue asueto).
  assert.equal(sesionEsperada({ ahora: new Date('2026-09-17T23:00:00Z') }), '2026-09-17');
});

test('el lunes temprano la sesión esperada es el viernes, no el domingo', () => {
  assert.equal(sesionEsperada({ ahora: new Date('2026-09-21T13:00:00Z') }), '2026-09-18');
});

test('sesionesFaltantes salta findes y asuetos', () => {
  const r = sesionesFaltantes('2026-09-15', '2026-09-21');
  // 16 asueto, 19-20 finde: quedan 17, 18 y 21.
  assert.deepEqual(r.fechas, ['2026-09-17', '2026-09-18', '2026-09-21']);
  assert.equal(r.n, 3);
  assert.equal(r.truncada, false);
});

test('sesionesFaltantes trunca la lista pero no el conteo', () => {
  const r = sesionesFaltantes('2024-01-01', '2026-09-18', { tope: 5 });
  assert.equal(r.fechas.length, 5);
  assert.ok(r.n > 400, `esperaba cientos de sesiones, dio ${r.n}`);
  assert.equal(r.truncada, true);
});

test('EL CASO: 15-sep guardado, lunes 21 por la tarde → 2 sesiones y alerta', () => {
  const r = frescuraPrecios({ ultima_fecha: '2026-09-15', ahora: new Date('2026-09-21T20:00:00Z') });
  assert.equal(r.sesion_esperada, '2026-09-18');
  assert.equal(r.dias_habiles_atraso, 2);
  assert.deepEqual(r.sesiones_faltantes, ['2026-09-17', '2026-09-18']);
  assert.equal(r.alerta, true);
  // El asueto que la cuenta saltó viaja en la salida: un calendario
  // equivocado se tiene que poder ver, no sólo sufrir.
  assert.deepEqual(r.asuetos_aplicados, { '2026-09-16': 'Independencia' });
  assert.match(r.motivo, /2 sesiones/);
});

test('una sesión de atraso NO alerta: la de hoy puede venir en camino', () => {
  const r = frescuraPrecios({ ultima_fecha: '2026-09-17', ahora: new Date('2026-09-18T22:30:00Z') });
  assert.equal(r.dias_habiles_atraso, 1);
  assert.equal(r.alerta, false);
  assert.equal(r.motivo, null);
  assert.equal(r.max_dias_habiles, MAX_DIAS_HABILES);
});

test('al día = cero, y el lunes por la mañana no inventa atraso', () => {
  const viernes = frescuraPrecios({ ultima_fecha: '2026-09-18', ahora: new Date('2026-09-18T23:00:00Z') });
  assert.equal(viernes.dias_habiles_atraso, 0);
  assert.equal(viernes.alerta, false);
  const lunes = frescuraPrecios({ ultima_fecha: '2026-09-18', ahora: new Date('2026-09-21T13:00:00Z') });
  assert.equal(lunes.dias_habiles_atraso, 0);
  assert.equal(lunes.alerta, false);
});

test('el fin de semana entero no cuenta como atraso', () => {
  const r = frescuraPrecios({ ultima_fecha: '2026-09-18', ahora: new Date('2026-09-20T23:00:00Z') });
  assert.equal(r.dias_habiles_atraso, 0);
  assert.equal(r.alerta, false);
});

test('tabla vacía es alerta con su motivo, no un cero', () => {
  const r = frescuraPrecios({ ultima_fecha: null, ahora: new Date('2026-09-21T20:00:00Z') });
  assert.equal(r.alerta, true);
  assert.equal(r.dias_habiles_atraso, null);
  assert.match(r.motivo, /vacía/);
});

test('un año fuera del calendario se DECLARA en vez de callarse', () => {
  const r = frescuraPrecios({ ultima_fecha: '2029-03-01', ahora: new Date('2029-03-06T23:00:00Z') });
  assert.deepEqual(r.anios_sin_calendario, ['2029']);
});

test('el umbral se puede apretar sin tocar el medidor', () => {
  const r = frescuraPrecios({ ultima_fecha: '2026-09-17', ahora: new Date('2026-09-18T22:30:00Z'), max_dias_habiles: 0 });
  assert.equal(r.dias_habiles_atraso, 1);
  assert.equal(r.alerta, true);
});

// ───────────────── el plan de la cola diaria ─────────────────
// `planPrecios` vive en api/bmv-harvest.js porque es la mitad que DECIDE de
// `?job=precios`. Se prueba acá, junto al calendario que le da el `hasta`.

import { planPrecios, PRECIOS_SERIE_VIVA_DIAS } from '../api/bmv-harvest.js';

const SERIES = [
  { emisora: 'WALMEX', emisora_serie: 'WALMEX*' },
  { emisora: 'AMX', emisora_serie: 'AMXB' },
  { emisora: 'FEMSA', emisora_serie: 'FEMSAUBD' },
];
const mapa = (o) => new Map(Object.entries(o));

test('plan: pide desde el día siguiente al último precio de CADA serie', () => {
  const { pendientes, saltadas } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-15',
    yaTengo: mapa({ 'WALMEX*': '2026-09-15', AMXB: '2026-09-15', FEMSAUBD: '2026-09-11' }),
  });
  assert.equal(pendientes.length, 3);
  assert.deepEqual(pendientes.map((p) => p.desde), ['2026-09-16', '2026-09-16', '2026-09-12']);
  assert.ok(pendientes.every((p) => p.hasta === '2026-09-18'));
  assert.equal(saltadas.al_dia, 0);
});

test('plan: la serie al día no se pide — correrlo dos veces no cuesta', () => {
  const { pendientes, saltadas } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-18',
    yaTengo: mapa({ 'WALMEX*': '2026-09-18', AMXB: '2026-09-18', FEMSAUBD: '2026-09-18' }),
  });
  assert.deepEqual(pendientes, []);
  assert.equal(saltadas.al_dia, 3);
});

test('plan: la serie SIN historia se reporta, no se siembra por accidente', () => {
  const { pendientes, saltadas } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-18',
    yaTengo: mapa({ 'WALMEX*': '2026-09-18' }),
  });
  assert.equal(pendientes.length, 0);
  assert.deepEqual(saltadas.sin_historia, ['AMXB', 'FEMSAUBD']);
});

test('plan: suspendida se mide contra la TABLA, no contra el calendario', () => {
  // FEMSAUBD lleva 200 días detrás del resto: dejó de cotizar.
  const { pendientes, saltadas } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-18',
    yaTengo: mapa({ 'WALMEX*': '2026-09-17', AMXB: '2026-09-17', FEMSAUBD: '2026-03-02' }),
  });
  assert.deepEqual(pendientes.map((p) => p.emisora_serie), ['WALMEX*', 'AMXB']);
  assert.equal(saltadas.suspendidas.length, 1);
  assert.equal(saltadas.suspendidas[0].emisora_serie, 'FEMSAUBD');
  assert.ok(saltadas.suspendidas[0].dias_detras_de_la_tabla > PRECIOS_SERIE_VIVA_DIAS);
});

test('plan: una cosecha parada seis semanas NO deja a todas como suspendidas', () => {
  // EL MODO DE FALLA QUE ESTE ANCLA EVITA. Con la sesión esperada como
  // referencia, las tres estarían 42 días atrás y el job diario no pediría
  // nada: callado y quieto, que es como empezó todo esto.
  const { pendientes, saltadas } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-08-07',
    yaTengo: mapa({ 'WALMEX*': '2026-08-07', AMXB: '2026-08-07', FEMSAUBD: '2026-08-07' }),
  });
  assert.equal(pendientes.length, 3);
  assert.equal(saltadas.suspendidas.length, 0);
  // Y la ventana cubre TODO el hueco: recortarla dejaría un agujero que la
  // corrida siguiente ya no vería.
  assert.ok(pendientes.every((p) => p.desde === '2026-08-08' && p.hasta === '2026-09-18'));
});

test('plan: con fechas forzadas se rellena el hueco tal cual (16→18 sep)', () => {
  const { pendientes } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-15',
    desdeForzado: '2026-09-16',
    yaTengo: mapa({ 'WALMEX*': '2026-09-15', AMXB: '2026-09-15', FEMSAUBD: '2026-09-15' }),
  });
  assert.equal(pendientes.length, 3);
  assert.ok(pendientes.every((p) => p.desde === '2026-09-16' && p.hasta === '2026-09-18'));
});

test('plan: &emisora= filtra por emisora o por serie', () => {
  const ya = mapa({ 'WALMEX*': '2026-09-15', AMXB: '2026-09-15', FEMSAUBD: '2026-09-15' });
  const porEmisora = planPrecios({ series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-15', yaTengo: ya, soloEmisora: 'AMX' });
  assert.deepEqual(porEmisora.pendientes.map((p) => p.emisora_serie), ['AMXB']);
  const porSerie = planPrecios({ series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-15', yaTengo: ya, soloEmisora: 'AMXB' });
  assert.deepEqual(porSerie.pendientes.map((p) => p.emisora_serie), ['AMXB']);
});

test('plan: &todas=1 incluye las suspendidas cuando se piden a propósito', () => {
  const { pendientes } = planPrecios({
    series: SERIES, hasta: '2026-09-18', maxTabla: '2026-09-18', incluirSuspendidas: true,
    yaTengo: mapa({ 'WALMEX*': '2026-09-17', AMXB: '2026-09-17', FEMSAUBD: '2026-03-02' }),
  });
  assert.equal(pendientes.length, 3);
});
