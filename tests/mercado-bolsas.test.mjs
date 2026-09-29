// ═══════════════════════════════════════════════════════════════════════
// EL RELOJ DE LAS BOLSAS — Y LO QUE NO AFIRMA
//
// El chip de hoy (`app.html:4452`) usa un offset EDT fijo de −4 y sabe de una
// sola bolsa. Estas pruebas fijan las dos cosas que el encargo pide de R2: un
// estado POR bolsa, y que ese estado no se equivoque en los cambios de horario
// ni afirme "abierto" con el horario solo.
//
// Todas corren con reloj congelado: un estado de mercado que dependa de cuándo
// se corrió la prueba no se puede probar.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { BOLSAS, ETIQUETA_24H, horaEnZona, estadoDeBolsa, estado24h } from '../qd-mercados.js';

test('las 8 bolsas de la decisión están, con zona IANA y horario', () => {
  assert.deepEqual(
    Object.keys(BOLSAS).sort(),
    ['bmv', 'francfort', 'hongkong', 'londres', 'nyse', 'saopaulo', 'seul', 'tokio'],
  );
  for (const [k, b] of Object.entries(BOLSAS)) {
    assert.match(b.zona, /^[A-Za-z]+\/[A-Za-z_]+$/, `${k}: zona IANA`);
    assert.match(b.abre, /^\d{2}:\d{2}$/, `${k}: abre`);
    assert.match(b.cierra, /^\d{2}:\d{2}$/, `${k}: cierra`);
    assert.ok(b.abre < b.cierra, `${k}: ${b.abre} antes de ${b.cierra}`);
    assert.ok(b.nombre, `${k}: nombre`);
  }
});

// ── LOS CAMBIOS DE HORARIO, QUE ES LO QUE EL OFFSET FIJO SE COME ───────
test('el offset NO es fijo: la apertura de Nueva York cae a la misma hora local en verano y en invierno', () => {
  // 2026-07-15 (EDT, −4) y 2026-12-15 (EST, −5), las dos a las 13:30 UTC.
  // Con offset fijo de −4, en diciembre daría 09:30 y el mercado estaría
  // "abierto" cuando faltaba una hora.
  const verano = horaEnZona('America/New_York', new Date('2026-07-15T13:30:00Z'));
  const invierno = horaEnZona('America/New_York', new Date('2026-12-15T13:30:00Z'));
  assert.equal(verano.hhmm, '09:30', 'en julio, 13:30 UTC son 09:30 en NY');
  assert.equal(invierno.hhmm, '08:30', 'en diciembre, las mismas 13:30 UTC son 08:30');

  const abVerano = estadoDeBolsa('nyse', new Date('2026-07-15T13:31:00Z'), { ultimoCierre: '2026-07-15' });
  const abInvierno = estadoDeBolsa('nyse', new Date('2026-12-15T13:31:00Z'), { ultimoCierre: '2026-12-15' });
  assert.equal(abVerano.abierta, true, abVerano.etiqueta);
  assert.equal(abInvierno.abierta, false, 'a las 08:31 de NY todavía no abre');
});

test('el hemisferio sur va al revés y tampoco se le pone offset a mano', () => {
  // São Paulo dejó el horario de verano en 2019, así que hoy es −3 todo el año;
  // lo que importa es que no se asuma nada: la zona lo resuelve.
  const enero = horaEnZona('America/Sao_Paulo', new Date('2026-01-15T13:00:00Z'));
  const julio = horaEnZona('America/Sao_Paulo', new Date('2026-07-15T13:00:00Z'));
  assert.equal(enero.hhmm, '10:00');
  assert.equal(julio.hhmm, '10:00');
});

test('Asia abre el día ANTERIOR en hora de México, y el día se lee en SU zona', () => {
  // Domingo 2026-09-27, 23:30 en Ciudad de México = lunes 13:30 en Tokio.
  // Leer el día con nuestro reloj daría "domingo" y Tokio estaría cerrada.
  const t = new Date('2026-09-28T05:30:00Z');
  const mx = horaEnZona('America/Mexico_City', t);
  const tk = horaEnZona('Asia/Tokyo', t);
  assert.equal(mx.dia_local || mx.diaIso, 7, 'en México es domingo');
  assert.equal(tk.diaIso, 1, 'en Tokio ya es lunes');
  assert.equal(tk.hhmm, '14:30');

  const e = estadoDeBolsa('tokio', t, { ultimoCierre: tk.fecha });
  assert.equal(e.abierta, true, `${e.hora_local} ${e.dia_local}: ${e.etiqueta}`);
  assert.equal(e.dia_local, 'lunes');
});

test('el receso de mediodía no es "abierto": Tokio y Hong Kong paran', () => {
  // Lunes 12:00 en Tokio: dentro del horario, pero en receso.
  const t = new Date('2026-09-28T03:00:00Z');
  const e = estadoDeBolsa('tokio', t, { ultimoCierre: '2026-09-28' });
  assert.equal(e.hora_local, '12:00');
  assert.equal(e.estado, 'receso');
  assert.equal(e.abierta, false);
  assert.match(e.etiqueta, /receso de mediodía · 11:30–12:30/);
  // Y Hong Kong tiene el suyo en otro horario.
  assert.ok(BOLSAS.hongkong.almuerzo, 'Hong Kong también para a mediodía');
});

// ── LO QUE NO SE AFIRMA CON EL HORARIO SOLO ───────────────────────────
test('en horario pero con el último cierre de ayer: "sin cierre nuevo hoy", no "abierto"', () => {
  // Es el caso del feriado que no está en ningún calendario del repo. También
  // cubre "la cosecha no llegó": las dos se arreglan distinto y ninguna es
  // "abierto".
  const t = new Date('2026-09-28T14:00:00Z');   // lunes 10:00 en NY
  const e = estadoDeBolsa('nyse', t, { ultimoCierre: '2026-09-25' });
  assert.equal(e.sesion_corriendo, true, 'el horario sí dice que corre');
  assert.equal(e.abierta, false, 'pero no se afirma sin el dato');
  assert.equal(e.estado, 'sin_cierre_nuevo');
  assert.match(e.etiqueta, /sin cierre nuevo hoy · último del 2026-09-25/);
});

test('sin último cierre no se dice ni abierto ni cerrado a secas: se dice que falta', () => {
  const t = new Date('2026-09-28T14:00:00Z');
  const enHorario = estadoDeBolsa('nyse', t, {});
  assert.equal(enHorario.estado, 'horario_solo');
  assert.equal(enHorario.abierta, false);
  assert.match(enHorario.etiqueta, /en horario, sin cierre con el que confirmarlo/);

  // Fuera de horario, cerrado es cerrado — pero la etiqueta dice que no sabe
  // de qué día es el último cierre, en vez de nombrar un día inventado.
  const fuera = estadoDeBolsa('nyse', new Date('2026-09-28T23:00:00Z'), {});
  assert.equal(fuera.estado, 'cerrada');
  assert.match(fuera.etiqueta, /no se sabe de qué día es el último cierre/);
});

test('la etiqueta de cerrado nombra el día, y dice "de hoy" cuando es de hoy', () => {
  // Sábado: el último cierre es del viernes, como el chip que ya existía.
  const sabado = estadoDeBolsa('nyse', new Date('2026-10-03T16:00:00Z'), { ultimoCierre: '2026-10-02' });
  assert.equal(sabado.estado, 'cerrada');
  assert.equal(sabado.etiqueta, 'cerrado · cierre del viernes');

  // Lunes a las 17:00 de NY: ya cerró, y el cierre es de hoy.
  const tarde = estadoDeBolsa('nyse', new Date('2026-09-28T21:00:00Z'), { ultimoCierre: '2026-09-28' });
  assert.equal(tarde.etiqueta, 'cerrado · cierre de hoy');
});

test('los que cotizan casi sin parar llevan otra etiqueta, no abierto/cerrado', () => {
  // Decisión de Lety: futuros, FX y cripto van con "24h".
  assert.equal(ETIQUETA_24H, '24h');
  assert.equal(estado24h().etiqueta, '24h');
  assert.equal(estado24h().estado, 'continuo');
});

test('una bolsa sin horario declarado lo dice en vez de suponer uno', () => {
  const e = estadoDeBolsa('shanghai', new Date('2026-09-28T02:00:00Z'), { ultimoCierre: '2026-09-28' });
  assert.equal(e.estado, 'desconocida');
  assert.equal(e.abierta, false);
  assert.match(e.etiqueta, /sin horario declarado/);
});
