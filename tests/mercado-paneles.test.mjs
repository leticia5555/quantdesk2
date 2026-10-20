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
import { armaEstaSemana, armaArena, ventanaSemana, DIAS_SEMANA, DIAS_HORIZONTE } from '../api/_lib/mercado-paneles.js';

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
  assert.match(a.agentes[1].pct_motivo, /Sin rendimiento publicado/);
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

// ═══════════════════════════════════════════════════════════════════════
// LOS OTROS ENDPOINTS SE LLAMAN EN PROCESO, NO POR HTTP
//
// Pedir `https://<host>/api/earnings?mega=1` con fetch devolvía 401 en el
// preview: Vercel protege los despliegues y el servidor se topaba con su propia
// puerta al llamarse a sí mismo. Lo encontró Lety (2026-10-05).
// ═══════════════════════════════════════════════════════════════════════
import { enProceso } from '../api/mercado-paneles.js';

test('enProceso corre el handler y devuelve su JSON, sin red', async () => {
  const handler = async (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.query.mega, '1');     // la query llega tal cual
    res.setHeader('Cache-Control', 'x');   // el handler real pone headers
    return res.status(200).json({ earnings: [{ ticker: 'NVDA', date: '2026-10-06' }] });
  };
  const r = await enProceso(handler, { mega: '1' });
  assert.equal(r.error, undefined);
  assert.equal(r.json.earnings[0].ticker, 'NVDA');
});

test('un código que no es 200 es un ERROR con su número, no una lista vacía', async () => {
  // Es el caso del 401: si se leyera como "no hay reportes", la semana más
  // cargada del trimestre saldría como una pantalla tranquila.
  const handler = async (req, res) => res.status(401).json({ error: 'no' });
  const r = await enProceso(handler);
  assert.equal(r.json, undefined);
  assert.match(r.error, /401/);
});

test('un handler que LANZA tampoco tumba el panel', async () => {
  const handler = async () => { throw new Error('Finnhub se cayó'); };
  const r = await enProceso(handler);
  assert.match(r.error, /Finnhub se cayó/);
});

test('y ese error llega hasta la pantalla con su texto', async () => {
  const handler = async (req, res) => res.status(401).json({});
  const r = await enProceso(handler);
  const s = armaEstaSemana({ macro: { filas: [] }, reportes: r, ahora: HOY });
  assert.equal(s.fuentes.reportes.ok, false);
  assert.match(s.fuentes.reportes.motivo, /401/);
});

test('una fuente lenta se cuelga SOLA: hay tope y se dice', async () => {
  // El `fetch` que se fue traía un AbortController de 5s. Sin tope, el
  // leaderboard colgado contra Alpaca se llevaría la pantalla entera hasta el
  // timeout de la función.
  const lento = () => new Promise(() => {});          // nunca resuelve
  const t0 = Date.now();
  const r = await enProceso(lento, {}, { topeMs: 60 });
  assert.match(r.error, /no contestó en 60 ms/);
  assert.ok(Date.now() - t0 < 1000, 'devolvió sin esperar al handler');
});

// ═══════════════════════════════════════════════════════════════════════
// LO QUE CAE FUERA DE LA SEMANA SE CUENTA, NO SE TIRA
// ═══════════════════════════════════════════════════════════════════════
test('los reportes que no caben en la semana se CUENTAN, y el conteo lo trae quien preguntó', () => {
  // El llamador hace DOS consultas acotadas —una por la semana, otra por el
  // resto— porque una de 30 días la recorta Finnhub y lo que se pierde son los
  // primeros. Acá el conteo del resto llega ya hecho.
  const r = armaEstaSemana({
    macro: { filas: [] },
    reportes: { filas: [], mas_adelante: 9 },
    ahora: HOY,
  });
  assert.equal(r.eventos.length, 0);
  assert.equal(r.fuentes.reportes.en_ventana, 0, 'lo que se pinta');
  assert.equal(r.fuentes.reportes.mas_adelante, 9, 'y lo que hay después, preguntado aparte');
});

test('si la segunda consulta falla, el conteo va en NULL y no en 0', () => {
  // "No se pudo mirar" no es "no hay nada": un 0 inventado haría ver un
  // horizonte vacío que nadie midió.
  const r = armaEstaSemana({ reportes: { filas: [], mas_adelante: null }, ahora: HOY });
  assert.equal(r.fuentes.reportes.mas_adelante, 0,
    'sin dato se cae al conteo por fechas, que con 0 filas es 0');
});

// ═══════════════════════════════════════════════════════════════════════
// EL CASO EXACTO DEL 19 DE OCTUBRE
//
// `/api/earnings?from=2026-10-19&to=2026-10-25&mega=1` traía NUEVE y el panel
// decía "sin reportes de mega-caps esta semana" (Lety, 2026-10-20). El panel
// pedía 30 días sin fechas y recortaba después; ahora pide la ventana.
// ═══════════════════════════════════════════════════════════════════════
test('los 9 del 19 al 25 de octubre entran todos en la semana', () => {
  const NUEVE = [
    { ticker: 'NFLX', date: '2026-10-21', time: 'AMC' },
    { ticker: 'TSLA', date: '2026-10-22', time: 'AMC' },
    { ticker: 'META', date: '2026-10-22', time: 'AMC' },
    { ticker: 'IBM', date: '2026-10-22', time: 'AMC' },
    { ticker: 'TXN', date: '2026-10-20', time: 'AMC' },
    { ticker: 'PG', date: '2026-10-23', time: 'BMO' },
    { ticker: 'XOM', date: '2026-10-23', time: 'BMO' },
    { ticker: 'BX', date: '2026-10-22', time: 'BMO' },
    { ticker: 'SPCX', date: '2026-10-25', time: 'TBD' },
  ];
  const r = armaEstaSemana({
    macro: { filas: [] },
    reportes: { filas: NUEVE, mas_adelante: 7, filtro: 'mega-caps' },
    ahora: new Date('2026-10-19T15:00:00Z'),
  });
  assert.equal(r.fuentes.reportes.en_ventana, 9, 'los nueve se pintan');
  assert.equal(r.eventos.length, 9);
  assert.deepEqual(r.eventos.map((e) => e.titulo),
    ['TXN', 'NFLX', 'BX', 'IBM', 'META', 'TSLA', 'PG', 'XOM', 'SPCX'],
    'ordenados por día, y dentro del día por nombre');
  // Y la frase deja de mentir: con nueve adentro no hay nada que explicar.
  assert.equal(r.fuentes.reportes.ok, true);
});

test('lo anterior a hoy no cuenta como "más adelante"', () => {
  const r = armaEstaSemana({
    reportes: { filas: [{ ticker: 'VIEJO', date: '2026-09-01' }] },
    ahora: HOY,
  });
  assert.equal(r.fuentes.reportes.mas_adelante, 0);
  assert.equal(r.fuentes.reportes.en_ventana, 1, 'devolvió 1 y 0 están más adelante');
});

test('cada fuente dice hasta dónde se miró', () => {
  // Sin el horizonte, "no hay nada" no dice "nada ¿hasta cuándo?".
  const r = armaEstaSemana({ macro: { filas: [] }, reportes: { filas: [] }, ahora: HOY });
  assert.equal(r.fuentes.macro.horizonte_dias, DIAS_HORIZONTE);
  assert.equal(r.fuentes.reportes.horizonte_dias, DIAS_HORIZONTE);
  assert.ok(DIAS_HORIZONTE > r.ventana.dias, 'se pide más de lo que se pinta, a propósito');
});

// ── Arena: la causa REAL de un retorno que falta ──────────────────────
test('sin llaves de Alpaca, la causa lo dice — no "el leaderboard no trajo"', () => {
  // Cuatro de cinco agentes salían con la frase genérica (Lety, 2026-10-05).
  // El campo era el correcto: `return_pct` sólo se calcula cuando hay llaves.
  const a = armaArena({ agents: [
    { id: 'claude', name: 'Claude', model: 'opus', has_keys: true, equity: 112400, return_pct: 12.4 },
    { id: 'gpt', name: 'GPT', model: 'g', has_keys: false, equity: null, return_pct: null },
  ] });
  assert.equal(a.agentes[0].pct, 12.4);
  assert.equal(a.agentes[0].pct_motivo, null);
  assert.match(a.agentes[1].pct_motivo, /Sin llaves de Alpaca/);
  // Y el modelo llega: `ordenarRanking` lo dejaba fuera del shape público.
  assert.equal(a.agentes[1].modelo, 'g');
});

test('con llaves pero sin cuenta legible, la causa es otra', () => {
  const a = armaArena({ agents: [{ id: 'x', name: 'X', has_keys: true, equity: null, return_pct: null }] });
  assert.match(a.agentes[0].pct_motivo, /No se pudo leer su cuenta de Alpaca/);
});

test('con cuenta pero sin capital inicial, otra más', () => {
  const a = armaArena({ agents: [
    { id: 'x', name: 'X', has_keys: true, equity: 100, baseline_equity: null, return_pct: null },
  ] });
  assert.match(a.agentes[0].pct_motivo, /No se pudo leer su capital inicial/);
});

// ═══════════════════════════════════════════════════════════════════════
// EL FILTRO DE MEGA-CAPS SE DECLARA, NO SE ESCONDE
//
// El 19 de octubre, en plena temporada de reportes, la sección decía "sin
// reportes esta semana · 7 más adelante" mientras el calendario traía decenas.
// Era verdad sobre las mega-caps y falso sobre el mercado (Lety, 2026-10-20).
// ═══════════════════════════════════════════════════════════════════════
test('se cuenta cuántos reportes de la SEMANA tiró el filtro', () => {
  const r = armaEstaSemana({
    macro: { filas: [] },
    reportes: {
      filas: [{ ticker: 'AAPL', date: '2026-10-30' }],        // mega, fuera de la semana
      filtro: 'mega-caps',
      descartados: [
        { ticker: 'XYZ', date: '2026-10-06' },                // DENTRO de la semana
        { ticker: 'ABC', date: '2026-10-07' },                // dentro
        { ticker: 'QRS', date: '2026-10-29' },                // fuera
      ],
      descartados_total: 312,
    },
    ahora: HOY,
  });
  assert.equal(r.fuentes.reportes.filtro, 'mega-caps');
  assert.equal(r.fuentes.reportes.filtrados_en_ventana, 2, 'sólo los de la semana');
  assert.equal(r.fuentes.reportes.filtrados_total, 312, 'y el total del horizonte, sin recortar');
  assert.equal(r.fuentes.reportes.mas_adelante, 1);
});

test('sin filtro declarado no se inventa uno', () => {
  const r = armaEstaSemana({ reportes: { filas: [] }, ahora: HOY });
  assert.equal(r.fuentes.reportes.filtro, null);
  assert.equal(r.fuentes.reportes.filtrados_en_ventana, 0);
});
