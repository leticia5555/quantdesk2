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

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `qd-mercados.js` lo carga el navegador con un <script src> clásico, así que
// NO puede tener `export`: sería un SyntaxError y el archivo entero no
// cargaría. Se lee con `createRequire`, igual que `tests/qd-periods.test.mjs`
// hace con `qd-periods.js`. Hay una prueba que fija esto en
// `tests/mercado-scripts.test.mjs`.
const require = createRequire(import.meta.url);
const M = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'qd-mercados.js'));
const { BOLSAS, ETIQUETA_24H, horaEnZona, estadoDeBolsa, estado24h, qdEstadoMercado, ALIAS_BOLSA } = M;

test('las bolsas del mapa están, con zona IANA y horario', () => {
  // Eran las 8 de la decisión del 2026-09-29; el artboard 4 agregó seis
  // índices más y con ellos sus bolsas. La lista se fija acá para que agregar
  // una sea una decisión y no un efecto secundario.
  assert.deepEqual(
    Object.keys(BOLSAS).sort(),
    ['bmv', 'bogota', 'francfort', 'hongkong', 'londres', 'mumbai', 'nyse',
      'paris', 'saopaulo', 'seul', 'shanghai', 'sidney', 'tokio', 'toronto'],
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
  // Shanghái ya tiene horario desde el artboard 4, así que el caso se prueba
  // con una que de verdad no está declarada.
  const e = estadoDeBolsa('estambul', new Date('2026-09-28T02:00:00Z'), { ultimoCierre: '2026-09-28' });
  assert.equal(e.estado, 'desconocida');
  assert.equal(e.abierta, false);
  assert.match(e.etiqueta, /sin horario declarado/);
});

// ═══════════════════════════════════════════════════════════════════════
// UNA SOLA TABLA — las pruebas que vivían en `tests/qd-periods.test.mjs`
//
// `qd-periods.js` tenía su propio `QD_BOLSAS` con us/mx y su propio `Intl`, o
// sea DOS tablas decidiendo si un mercado está abierto. Estas pruebas se
// mudaron acá tal cual —mismos instantes, mismas expectativas— para que la
// unificación se demuestre en vez de afirmarse: si el adaptador cambiara el
// comportamiento que `/mercado` ya tenía, se ponen rojas.
// ═══════════════════════════════════════════════════════════════════════


test('los alias us/mx apuntan a la tabla única, no a una copia', () => {
  assert.deepEqual(ALIAS_BOLSA, { us: 'nyse', mx: 'bmv' });
  assert.equal(qdEstadoMercado('us', new Date('2026-09-21T17:00:00Z'), { ultimoCierre: '2026-09-21' }).bolsa, 'nyse');
  assert.equal(qdEstadoMercado('mx', new Date('2026-09-21T17:00:00Z'), { ultimoCierre: '2026-09-21' }).bolsa, 'bmv');
});

test('las dos bolsas NO abren ni cierran a la misma hora', () => {
  // 20:30 UTC = 16:30 en Nueva York (cerrado) y 14:30 en la CDMX (abierto).
  const t = new Date('2026-09-21T20:30:00Z');   // lunes
  const us = qdEstadoMercado('us', t, { ultimoCierre: '2026-09-21' });
  const mx = qdEstadoMercado('mx', t, { ultimoCierre: '2026-09-21' });
  assert.equal(us.abierto, false, 'NY ya cerró a las 16:30 locales');
  assert.equal(mx.abierto, true, 'la BMV sigue abierta a las 14:30 locales');
  assert.equal(us.etiqueta, 'NYSE/Nasdaq');
  assert.equal(mx.etiqueta, 'BMV');
});

test('en sesión, las dos abiertas', () => {
  const t = new Date('2026-09-21T17:00:00Z');   // 13:00 NY, 11:00 CDMX
  assert.equal(qdEstadoMercado('us', t, { ultimoCierre: '2026-09-21' }).abierto, true);
  assert.equal(qdEstadoMercado('mx', t, { ultimoCierre: '2026-09-21' }).abierto, true);
});

test('el fin de semana dice de qué día es el cierre que se está viendo', () => {
  const dom = new Date('2026-09-20T17:00:00Z');   // domingo
  for (const b of ['us', 'mx']) {
    const e = qdEstadoMercado(b, dom, { ultimoCierre: '2026-09-18' });
    assert.equal(e.abierto, false);
    assert.match(e.texto, /cierre del viernes/);
  }
});

test('antes de abrir, el cierre que se ve es el del día hábil anterior', () => {
  const lunesTemprano = new Date('2026-09-21T12:00:00Z');   // 8:00 NY, 6:00 CDMX
  for (const b of ['us', 'mx']) {
    const e = qdEstadoMercado(b, lunesTemprano, { ultimoCierre: '2026-09-18' });
    assert.equal(e.abierto, false);
    assert.match(e.texto, /cierre del viernes/);
  }
});

test('una bolsa que no existe LANZA en vez de inventar un horario', () => {
  assert.throws(() => qdEstadoMercado('xx', new Date()), /bolsa desconocida/);
});

test('lo ÚNICO que cambió del chip viejo: ya no afirma abierto con el horario solo', () => {
  // El comentario que estaba en `qd-periods.js` lo admitía: "los feriados NO se
  // modelan… un día de asueto sale como abierto sin operaciones". Con el último
  // cierre en la mano, deja de pasar.
  const t = new Date('2026-09-21T17:00:00Z');   // lunes, en sesión
  assert.equal(qdEstadoMercado('us', t, { ultimoCierre: '2026-09-21' }).abierto, true);
  const feriado = qdEstadoMercado('us', t, { ultimoCierre: '2026-09-18' });
  assert.equal(feriado.abierto, false, 'en sesión pero sin cierre nuevo: no se afirma');
  assert.match(feriado.texto, /sin cierre nuevo hoy/);
  assert.match(feriado.motivo, /sin cierre nuevo hoy/);
});

// ═══════════════════════════════════════════════════════════════════════
// LA PRÓXIMA APERTURA Y EL ENCABEZADO DE REGIÓN (artboard 4)
//
// El mockup pide "Asia · abre lun 18:00 CT" en un domingo. Las dos mitades
// tienen trampa: el DÍA es el de la bolsa —en Tokio ya es lunes— y la HORA es
// la de México, donde todavía es domingo por la noche. Mezclarlas al revés es
// cómo se dice "abre el lunes" de algo que abre esta noche.
// ═══════════════════════════════════════════════════════════════════════
const { proximaApertura, estadoDeRegion } = M;

test('la próxima apertura nombra el día de ALLÁ con la hora de ACÁ', () => {
  // Domingo 2026-09-20, 12:00 en la CDMX.
  const dom = new Date('2026-09-20T17:00:00Z');
  const tk = proximaApertura('tokio', dom);
  assert.equal(tk.etiqueta, 'abre lun 18:00 CT', 'la línea exacta del mockup');
  assert.equal(tk.dia, 'lun', 'lunes es el día en Tokio');
  assert.equal(tk.hhmm, '18:00', 'y 18:00 es la hora en México, donde es domingo');
});

test('la apertura sale bien a los dos lados de un cambio de horario', () => {
  // EE.UU. cambia de horario el primer domingo de noviembre; México no cambia
  // desde 2022. Así que la apertura de Nueva York vista desde la CDMX se MUEVE
  // una hora, y con un offset a mano se erraría medio año.
  const octubre = proximaApertura('nyse', new Date('2026-10-20T04:00:00Z'));
  const diciembre = proximaApertura('nyse', new Date('2026-12-15T04:00:00Z'));
  assert.equal(octubre.hhmm, '07:30', 'en octubre NY abre 07:30 CT');
  assert.equal(diciembre.hhmm, '08:30', 'en diciembre, 08:30 CT: una hora más tarde');
});

test('el encabezado de una región resume varias bolsas sin afirmar de más', () => {
  const dom = new Date('2026-09-20T17:00:00Z');   // domingo
  const asia = estadoDeRegion(['tokio', 'seul', 'hongkong', 'shanghai', 'mumbai', 'sidney'], dom,
    { cierres: { tokio: '2026-09-18' } });
  assert.match(asia.etiqueta, /^cerrado · abre /);
  assert.match(asia.etiqueta, / CT$/, 'la hora va en CT');
  assert.equal(asia.abiertas, 0);

  // En sesión, con el cierre de hoy: abierto.
  const lunes = new Date('2026-09-21T14:30:00Z');   // 09:30 en NY
  const america = estadoDeRegion(['nyse', 'toronto'], lunes,
    { cierres: { nyse: '2026-09-21', toronto: '2026-09-21' } });
  assert.equal(america.etiqueta, 'abierto');
  assert.equal(america.abiertas, 2);
});

test('si sólo algunas están abiertas, se dice cuántas — no "abierto" a secas', () => {
  // 09:30 en NY son 15:30 en Fráncfort (abierta) y 14:30 en Londres (abierta),
  // pero Tokio ya cerró. Un "abierto" pelado taparía eso.
  const t = new Date('2026-09-21T14:30:00Z');
  const r = estadoDeRegion(['nyse', 'tokio'], t, { cierres: { nyse: '2026-09-21', tokio: '2026-09-21' } });
  assert.match(r.etiqueta, /abierto · 1 de 2/);
});

test('una región en horario pero sin cierre nuevo NO dice abierto', () => {
  // El feriado que no está en ningún calendario del repo, a nivel región.
  const t = new Date('2026-09-21T14:30:00Z');
  const r = estadoDeRegion(['nyse', 'toronto'], t,
    { cierres: { nyse: '2026-09-18', toronto: '2026-09-18' } });
  assert.match(r.etiqueta, /sin cierre nuevo \(2 de 2\)/);
  assert.equal(r.abiertas, 0);
});

test('una región de puros 24h no se pregunta por horarios', () => {
  const r = estadoDeRegion(['24h', '24h'], new Date('2026-09-20T17:00:00Z'));
  assert.equal(r.continuo, true);
  assert.match(r.etiqueta, /24\/7/);
});
