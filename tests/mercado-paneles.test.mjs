// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-paneles.test.mjs — "esta semana" y la tarjeta de Arena.
//
// Lo que se fija acá es que una FUENTE CAÍDA no se pueda leer como una lista
// vacía. Las dos mitades de "esta semana" vienen de sitios distintos y se caen
// por separado: si se funden, un Finnhub en 429 se lee igual que "no hay
// reportes esta semana", y la semana más cargada del trimestre aparece como una
// pantalla tranquila.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { armaEstaSemana, armaArena, ventanaSemana, DIAS_SEMANA } from '../api/_lib/mercado-paneles.js';

const HOY = new Date('2026-10-02T15:00:00Z');   // viernes

test('la ventana es de hoy a hoy+7, en fechas', () => {
  const v = ventanaSemana(HOY);
  assert.equal(v.desde, '2026-10-02');
  assert.equal(v.hasta, '2026-10-09');
  assert.equal(v.dias, DIAS_SEMANA);
});

test('macro y reportes se mezclan en una línea de tiempo por día', () => {
  const r = armaEstaSemana({
    macro: { filas: [
      { event_date: '2026-10-07', title: 'CPI', importance: 'high' },
      { event_date: '2026-10-05', title: 'Minutas de la Fed', importance: 'med' },
    ] },
    reportes: { filas: [
      { ticker: 'NVDA', company: 'Nvidia', date: '2026-10-05', time: 'AMC', eps_est: 1.2 },
    ] },
    ahora: HOY,
  });
  assert.deepEqual(r.eventos.map((e) => [e.fecha, e.tipo, e.titulo]), [
    ['2026-10-05', 'macro', 'Minutas de la Fed'],
    // Macro antes que reporte el mismo día: un dato de la Fed mueve todo y un
    // reporte mueve un ticker.
    ['2026-10-05', 'reporte', 'NVDA'],
    ['2026-10-07', 'macro', 'CPI'],
  ]);
});

test('lo que cae fuera de la ventana no entra', () => {
  const r = armaEstaSemana({
    macro: { filas: [
      { event_date: '2026-10-01', title: 'ayer' },
      { event_date: '2026-11-01', title: 'el mes que viene' },
      { event_date: '2026-10-09', title: 'el último día, sí' },
    ] },
    ahora: HOY,
  });
  assert.deepEqual(r.eventos.map((e) => e.titulo), ['el último día, sí']);
});

test('UNA FUENTE CAÍDA NO ES UNA LISTA VACÍA: cada mitad trae su estado', () => {
  const r = armaEstaSemana({
    macro: { filas: [{ event_date: '2026-10-06', title: 'Empleo' }] },
    reportes: { error: 'HTTP 429' },
    ahora: HOY,
  });
  assert.equal(r.eventos.length, 1, 'lo que sí llegó se pinta');
  assert.equal(r.fuentes.macro.ok, true);
  assert.equal(r.fuentes.reportes.ok, false);
  assert.equal(r.fuentes.reportes.motivo, 'HTTP 429');
  // Y las dos nombran de dónde salen (regla 3).
  assert.equal(r.fuentes.macro.fuente, 'neon:macro_events');
  assert.equal(r.fuentes.reportes.fuente, 'finnhub:earnings-calendar');
});

test('una semana de verdad tranquila se distingue de una fuente muda', () => {
  const r = armaEstaSemana({ macro: { filas: [] }, reportes: { filas: [] }, ahora: HOY });
  assert.equal(r.eventos.length, 0);
  assert.equal(r.fuentes.macro.ok, true, 'contestó, y no había nada');
  assert.equal(r.fuentes.reportes.ok, true);
});

test('el reporte conserva su BMO/AMC: no se le inventa una hora', () => {
  // "Antes de la apertura" es un hecho del calendario; "08:00 CT" sería una
  // hora que Finnhub no dio.
  const r = armaEstaSemana({
    reportes: { filas: [
      { ticker: 'AAPL', date: '2026-10-06', time: 'BMO' },
      { ticker: 'MSFT', date: '2026-10-06' },
    ] },
    ahora: HOY,
  });
  assert.equal(r.eventos[0].cuando, 'BMO');
  assert.equal(r.eventos[1].cuando, 'TBD', 'sin hora declarada se dice TBD, no se adivina');
});

// ── Arena ────────────────────────────────────────────────────────────
test('la tarjeta de Arena sale del shape {agents:[…]} y NO calcula el %', () => {
  const a = armaArena({ agents: [
    { id: 'claude', name: 'Claude', model: 'opus', return_pct: 12.4 },
    { id: 'otro', name: 'Otro', model: 'x', equity: 110000, baseline_equity: 100000 },
  ] });
  assert.equal(a.agentes[0].pct, 12.4);
  // El segundo TIENE con qué despejar un 10%, y se deja en null a propósito:
  // despejarlo acá sería una segunda definición de "rendimiento" en el repo.
  assert.equal(a.agentes[1].pct, null);
  assert.match(a.agentes[1].pct_motivo, /no trajo el rendimiento/);
});

test('el leaderboard caído se dice, no se pinta vacío', () => {
  const a = armaArena({ error: 'HTTP 500' });
  assert.deepEqual(a.agentes, []);
  assert.equal(a.motivo, 'HTTP 500');
  assert.equal(a.fuente, 'api:leaderboard');
});

test('sin agentes, el motivo lo dice', () => {
  const a = armaArena({ agents: [] });
  assert.match(a.motivo, /no devolvió agentes/);
});
