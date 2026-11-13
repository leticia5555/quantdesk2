// ═══════════════════════════════════════════════════════════════════════
// tests/macro-oficial.test.mjs — EL CALENDARIO MACRO YA NO DEPENDE DE QUE
// ALGUIEN SE ACUERDE DE CARGARLO
//
// La tabla `macro_events` es curada a mano y estaba en cero filas
// (2026-11-11): el panel decía "calendario macro sin cargar". Las fechas de la
// Fed y del BLS ya están publicadas y ahora viven en el repo. Lo que se fija:
//
//   1. la lista es coherente (fechas ISO, días hábiles, con su fuente);
//   2. lo curado GANA a lo oficial si coinciden en fecha y categoría;
//   3. los próximos eventos se NOMBRAN, no sólo se cuentan;
//   4. cuando la lista se acaba, el panel lo dice en vez de quedarse mudo.
//
// Ninguna prueba de acá depende del reloj: todas pasan su propio "hoy".
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { CALENDARIO_OFICIAL, OFICIAL_HASTA, oficialesEntre, unirMacro, horaCdmx } from '../api/_lib/macro-oficial.js';
import { armaEstaSemana, PROXIMOS_MACRO } from '../api/_lib/mercado-paneles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fraseDeFuente } = createRequire(import.meta.url)(join(ROOT, 'qd-tablas.js'));

test('cada fecha oficial es ISO, cae en día hábil y dice de dónde salió', () => {
  assert.ok(CALENDARIO_OFICIAL.length >= 9, 'al menos tres de cada una');
  for (const e of CALENDARIO_OFICIAL) {
    assert.match(e.event_date, /^\d{4}-\d{2}-\d{2}$/);
    const dia = new Date(e.event_date + 'T12:00:00Z').getUTCDay();
    assert.ok(dia >= 1 && dia <= 5, `${e.event_date} (${e.title}) cae en fin de semana: ni la Fed ni el BLS publican ahí`);
    assert.ok(['fed', 'inflacion', 'empleo'].includes(e.category), e.category);
    assert.match(e.fuente, /^oficial:(federalreserve|bls)\.gov$/);
    assert.match(e.fuente_url, /^https:\/\/www\.(federalreserve|bls)\.gov\//);
    assert.equal(e.importance, 'high');
  }
  const fechas = CALENDARIO_OFICIAL.map((e) => e.event_date);
  assert.deepEqual(fechas, [...fechas].sort(), 'va ordenada por fecha');
  assert.equal(OFICIAL_HASTA, fechas[fechas.length - 1]);
});

test('el empleo sale en viernes y hay una fecha de cada tipo por mes cubierto', () => {
  // El BLS publica el informe de empleo en viernes. Si una fecha de acá no lo
  // es, lo más probable es un dedazo al copiarla.
  for (const e of CALENDARIO_OFICIAL.filter((x) => x.category === 'empleo')) {
    assert.equal(new Date(e.event_date + 'T12:00:00Z').getUTCDay(), 5, `${e.event_date} no es viernes`);
  }
  const porMes = {};
  for (const e of CALENDARIO_OFICIAL) (porMes[e.event_date.slice(0, 7)] ||= new Set()).add(e.category);
  for (const [mes, cats] of Object.entries(porMes)) {
    assert.ok(cats.has('inflacion') && cats.has('empleo'), `${mes}: falta inflación o empleo`);
  }
});

test('oficialesEntre recorta por fecha, con los dos extremos adentro', () => {
  const dic = oficialesEntre('2026-12-04', '2026-12-10');
  assert.deepEqual(dic.map((e) => e.category), ['empleo', 'fed', 'inflacion']);
  assert.equal(oficialesEntre('2026-11-11', '2026-11-18').length, 0);
});

test('lo curado gana: la misma categoría el mismo día no entra dos veces', () => {
  const curadas = [
    { event_date: '2026-12-09', title: 'FOMC — con conferencia de Powell', category: 'Fed', importance: 'high' },
    { event_date: '2026-12-11', title: 'Subasta de bonos a 30 años', category: 'subasta', importance: 'med' },
  ];
  const u = unirMacro(curadas, oficialesEntre('2026-12-01', '2026-12-31'));
  const delNueve = u.filter((e) => e.event_date === '2026-12-09');
  assert.equal(delNueve.length, 1, 'una sola decisión de la Fed ese día');
  assert.equal(delNueve[0].title, 'FOMC — con conferencia de Powell', 'y es la curada');
  assert.ok(u.some((e) => e.title === 'Subasta de bonos a 30 años'), 'lo curado que no choca se suma');
  assert.ok(u.some((e) => e.category === 'inflacion'), 'y lo oficial que no choca también');
  assert.deepEqual(u.map((e) => e.event_date), [...u.map((e) => e.event_date)].sort());
});

test('con la tabla vacía, el panel NOMBRA los próximos en vez de decir "sin cargar"', () => {
  // El caso real del 2026-11-11: cero filas curadas, la Fed a cuatro semanas.
  const ahora = new Date('2026-11-11T18:00:00Z');
  const macro = { filas: unirMacro([], oficialesEntre('2026-11-11', '2026-12-11')), oficial_hasta: OFICIAL_HASTA };
  const s = armaEstaSemana({ macro, reportes: { filas: [] }, ahora });
  assert.equal(s.eventos.filter((e) => e.tipo === 'macro').length, 0, 'esta semana no hay ninguno, y no se inventa');
  assert.equal(s.fuentes.macro.en_ventana, 0, 'en_ventana cuenta lo que se PINTA, no el horizonte');
  assert.equal(s.fuentes.macro.mas_adelante, 3);
  assert.deepEqual(s.proximos_macro.map((e) => [e.fecha, e.categoria]),
    [['2026-12-04', 'empleo'], ['2026-12-09', 'fed'], ['2026-12-10', 'inflacion']]);
  assert.ok(s.proximos_macro.length <= PROXIMOS_MACRO);
  assert.equal(s.proximos_macro[0].fuente, 'oficial:bls.gov', 'y cada uno dice de dónde salió');
  assert.equal(fraseDeFuente('macro', s.fuentes), 'sin eventos macro esta semana · 3 más adelante');
  assert.equal(s.fuentes.macro.oficial_agotado, false);
});

test('la semana del dato lo pinta como evento de la semana, con su hora en CT', () => {
  const ahora = new Date('2026-12-07T18:00:00Z');
  const macro = { filas: oficialesEntre('2026-12-07', '2027-01-06'), oficial_hasta: OFICIAL_HASTA };
  const s = armaEstaSemana({ macro, reportes: { filas: [] }, ahora });
  const m = s.eventos.filter((e) => e.tipo === 'macro');
  assert.deepEqual(m.map((e) => e.fecha), ['2026-12-09', '2026-12-10']);
  assert.match(m[0].titulo, /Fed/);
  assert.match(m[0].detalle, /13:00 hora de CDMX/);
  assert.match(m[1].detalle, /7:30 hora de CDMX/);
  assert.doesNotMatch(m[0].detalle + m[1].detalle, /\bCT\b/, '"CT" no dice de qué ciudad es la hora');
  assert.equal(fraseDeFuente('macro', s.fuentes), null, 'con eventos esta semana no hay aviso');
});

test('la hora de CDMX se CALCULA: en horario de verano de EE.UU. son dos horas, no una', () => {
  // México ya no cambia de horario y Estados Unidos sí. En invierno Nueva York
  // va una hora adelante de CDMX; del segundo domingo de marzo a noviembre,
  // dos. Con la hora escrita a mano, la Fed de marzo salía una hora mal.
  assert.equal(horaCdmx('2026-12-09', '14:00'), '13:00', 'invierno: una hora');
  assert.equal(horaCdmx('2026-12-10', '08:30'), '7:30');
  assert.equal(horaCdmx('2027-03-10', '08:30'), '7:30', 'el 10 de marzo EE.UU. todavía no cambia');
  assert.equal(horaCdmx('2027-03-17', '14:00'), '12:00', 'el 17 de marzo ya cambió: dos horas');
  assert.equal(horaCdmx('2027-07-02', '08:30'), '6:30', 'verano');
  const marzo = CALENDARIO_OFICIAL.find((e) => e.event_date === '2027-03-17');
  assert.match(marzo.note, /comunicado 12:00 hora de CDMX/);
  for (const e of CALENDARIO_OFICIAL) {
    assert.match(e.note, /\d{1,2}:\d{2} hora de CDMX/, `${e.event_date}: sin hora de CDMX`);
    assert.doesNotMatch(e.note, /\bCT\b|null|undefined/, e.note);
  }
});

test('en pantalla: el día lleva su mes y la importancia va en español', () => {
  // "mar 17" se leía como 17 de marzo —"mar" es martes y también marzo— y la
  // importancia salía "high" (Lety, 2026-11-13).
  const html = readFileSync(join(ROOT, 'mercado.html'), 'utf8');
  const cuerpo = /function diaConMes\(fecha\)\{([\s\S]*?)\n  \}/.exec(html);
  assert.ok(cuerpo, 'no encontré diaConMes en mercado.html');
  const MESES_CORTOS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const nombreDeDia = (f) => DIAS[(new Date(f + 'T12:00:00Z').getUTCDay() + 6) % 7];
  const diaConMes = new Function('nombreDeDia', 'MESES_CORTOS', 'fecha', cuerpo[1]).bind(null, nombreDeDia, MESES_CORTOS);
  assert.equal(diaConMes('2026-11-17'), 'mar 17 nov');
  assert.equal(diaConMes('2026-12-04'), 'vie 4 dic');
  assert.equal(diaConMes('2027-03-17'), 'mié 17 mar');
  assert.match(html, /high: 'alta', med: 'media', low: 'baja'/);
  assert.doesNotMatch(html, /e\.fecha\.slice\(8\) : e\.fecha/, 'la semana ya no pinta el día sin mes');
});

test('cuando la lista se acaba, el panel lo DICE', () => {
  const ahora = new Date('2027-03-20T18:00:00Z');
  const s = armaEstaSemana({ macro: { filas: [], oficial_hasta: OFICIAL_HASTA }, reportes: { filas: [] }, ahora });
  assert.equal(s.fuentes.macro.oficial_agotado, true);
  assert.equal(fraseDeFuente('macro', s.fuentes),
    `el calendario macro oficial llega sólo hasta el ${OFICIAL_HASTA}: falta extenderlo`);
});

test('si la tabla curada falla, lo oficial se pinta igual y el error se dice', () => {
  const ahora = new Date('2026-12-07T18:00:00Z');
  const macro = { filas: oficialesEntre('2026-12-07', '2027-01-06'), oficial_hasta: OFICIAL_HASTA, error: 'Neon: timeout' };
  const s = armaEstaSemana({ macro, reportes: { filas: [] }, ahora });
  assert.equal(s.eventos.filter((e) => e.tipo === 'macro').length, 2);
  assert.equal(s.fuentes.macro.ok, false);
  assert.match(fraseDeFuente('macro', s.fuentes), /no respondió: Neon: timeout/);
});
