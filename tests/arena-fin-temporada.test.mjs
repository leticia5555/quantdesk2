// ═══════════════════════════════════════════════════════════════════
// tests/arena-fin-temporada.test.mjs — el cierre = inicio + 22 sesiones.
//
// 2026-10-20. La T3 abre hoy. ARENA_SEASON decía `end: 2026-10-30`, así que
// abriendo el 20 quedaban 9 sesiones y, peor, `declareSeasonWinner` coronaba
// al ganador el 30-oct — y su id idempotente bloqueaba después la
// declaración del día correcto. La temporada se mide en SESIONES: el reset
// escribe start Y end, y todo lo que lee la temporada usa la efectiva.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';

const {
  ARENA_SEASON, finDeTemporada, esSesionHabil, temporadaEfectiva, seasonStatus, isSeasonFinalDay, seasonDay,
} = await import('../api/_lib/arena-registry.js');
const { rejillaDeEnfoques } = await import('../api/_lib/arena-herding.js');
const { marcarInicioTemporada, leerInicioTemporada } = await import('../api/_lib/arena-baseline.js');
const { declareSeasonWinner } = await import('../api/arena-run.js');
const { resetAnnouncement } = await import('../api/arena-reset.js');

// ── Neon falso: arena_flags en memoria, y cada INSERT capturado ──────
let flags = {};
let journal = [];
let flagsRotos = false;
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('neon.tech')) throw new Error('red no esperada: ' + url);
  const { query, params = [] } = JSON.parse(opts.body);
  const reply = (fields, rows) => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({ fields, rows }), text: async () => '',
  });
  if (/from arena_flags/.test(query)) {
    if (flagsRotos) return { ok: false, status: 500, headers: { get: () => 'text/plain' }, json: async () => ({}), text: async () => 'caído' };
    const f = flags[params[0]];
    return reply([{ name: 'value', dataTypeID: 3802 }, { name: 'note', dataTypeID: 25 }, { name: 'updated_at', dataTypeID: 1184 }],
      f ? [[JSON.stringify(f), null, '2026-10-20T15:00:00Z']] : []);
  }
  if (/insert into arena_flags/.test(query)) { flags[params[0]] = JSON.parse(params[1]); return reply([], []); }
  if (/insert into arena_journal/.test(query)) { journal.push(params); return reply([], []); }
  return reply([], []);
};

const ABRE = '2026-10-20';
const at = (d, h = '22:40') => new Date(`${d}T${h}:00Z`);

test('finDeTemporada: abriendo el 20-oct, la sesión 22 es el 18-nov', () => {
  assert.equal(finDeTemporada(ABRE), '2026-11-18');
  assert.equal(finDeTemporada(ABRE, 22), '2026-11-18');
  assert.equal(finDeTemporada(ABRE, 1), ABRE, 'el día del inicio es la sesión 1');
  // La rejilla cuenta con el MISMO criterio: si divergieran, el anuncio diría
  // "22 sesiones" y el reparto se calcularía sobre otro número.
  assert.equal(rejillaDeEnfoques(ABRE, finDeTemporada(ABRE), ['qwen']).sesiones, 22);
});

test('la ventana planeada sale de la misma regla (la constante no miente)', () => {
  assert.equal(ARENA_SEASON.sesiones, 22);
  assert.equal(finDeTemporada(ARENA_SEASON.start, ARENA_SEASON.sesiones), ARENA_SEASON.end);
});

test('feriados y fines de semana no cuentan', () => {
  assert.equal(esSesionHabil('2026-11-26'), false, 'Thanksgiving');
  assert.equal(esSesionHabil('2026-10-24'), false, 'sábado');
  assert.equal(esSesionHabil('2026-11-27'), true, 'viernes post-Thanksgiving: abre (medio día)');
  // 2-nov + 22 cruza Thanksgiving: sin el feriado daría 1-dic.
  assert.equal(finDeTemporada('2026-11-02'), '2026-12-02');
  assert.equal(rejillaDeEnfoques('2026-11-02', '2026-12-02', ['qwen']).sesiones, 22, 'y la rejilla salta el mismo feriado');
  // Un inicio en sábado: la sesión 1 es el lunes.
  assert.equal(finDeTemporada('2026-10-24', 1), '2026-10-26');
  assert.throws(() => finDeTemporada('nada'), /inválidos/);
  assert.throws(() => finDeTemporada(ABRE, 0), /inválidos/);
});

test('temporadaEfectiva: con inicio real, el cierre se corre con él', () => {
  const t = temporadaEfectiva({ start: ABRE });
  assert.equal(t.start, ABRE);
  assert.equal(t.end, '2026-11-18');
  assert.equal(t.end_planeado, ARENA_SEASON.end);
  assert.equal(t.abierta, true);
  // El que escribió el reset manda sobre el derivado.
  assert.equal(temporadaEfectiva({ start: ABRE, end: '2026-11-20' }).end, '2026-11-20');
  // Sin reset: la planeada, entera.
  const p = temporadaEfectiva(null);
  assert.equal(p.end, ARENA_SEASON.end);
  assert.equal(p.abierta, false);
});

test('estado y último día, contra la temporada efectiva', () => {
  const t = temporadaEfectiva({ start: ABRE });
  assert.equal(isSeasonFinalDay(at('2026-10-30'), t), false, 'el 30-oct ya NO es el último día');
  assert.equal(seasonStatus(at('2026-10-31', '15:00'), t), 'running', 'el 31-oct sigue corriendo');
  assert.equal(isSeasonFinalDay(at('2026-11-18'), t), true);
  assert.equal(seasonStatus(at('2026-11-19', '15:00'), t), 'ended');
  assert.equal(seasonDay(at(ABRE, '15:00'), t), 1);
});

test('el reset ESCRIBE el cierre junto al inicio, y se lee de vuelta', async () => {
  flags = {};
  const r = await marcarInicioTemporada('T3', at(ABRE, '15:05'));
  assert.deepEqual({ start: r.start, end: r.end, sesiones: r.sesiones, ya_estaba: r.ya_estaba },
    { start: ABRE, end: '2026-11-18', sesiones: 22, ya_estaba: false });
  assert.equal(flags['season_start:T3'].end, '2026-11-18', 'queda en arena_flags, no solo en la respuesta');
  const leido = await leerInicioTemporada('T3');
  assert.equal(leido.end, '2026-11-18');
  assert.equal(temporadaEfectiva(leido).end, '2026-11-18');
  // Un segundo reset no mueve ni el inicio ni el cierre.
  const r2 = await marcarInicioTemporada('T3', at('2026-10-22', '15:05'));
  assert.equal(r2.ya_estaba, true);
  assert.equal(r2.end, '2026-11-18');
  assert.equal(flags['season_start:T3'].start, ABRE);
  // Y si lo escrito difiere de lo derivado, gana lo escrito (no se recalcula).
  flags['season_start:T3'].end = '2026-11-20';
  assert.equal((await marcarInicioTemporada('T3', at('2026-10-23', '15:05'))).end, '2026-11-20');
});

const RESULTS = ['claude', 'qwen'].map((id, i) => ({ id, name: id, status: 'ok', equity: 101000 - i * 500 }));

test('el ganador NO se declara el 30-oct: el último día es el 18-nov', async () => {
  flags = { 'season_start:T3': { start: ABRE, end: '2026-11-18', sesiones: 22 } };
  journal = [];
  const el30 = await declareSeasonWinner(RESULTS, at('2026-10-30'));
  assert.equal(el30.declared, false);
  assert.match(el30.reason, /último día de la temporada \(2026-11-18\)/);
  assert.equal(journal.length, 0, 'ninguna fila de ganador el 30-oct');

  const el18 = await declareSeasonWinner(RESULTS, at('2026-11-18'));
  assert.equal(el18.declared, true, JSON.stringify(el18));
  assert.equal(journal.length, 1);
  const ctx = JSON.parse(journal[0][4]);
  assert.equal(ctx.season.end, '2026-11-18');
  assert.match(journal[0][3], /Ventana: 2026-10-20 → 2026-11-18 \(22 sesiones/);
});

test('sin inicio escrito, o sin poder leerlo, NO se declara contra la fecha planeada', async () => {
  journal = [];
  flags = {};
  const sinReset = await declareSeasonWinner(RESULTS, at(ARENA_SEASON.end));
  assert.equal(sinReset.declared, false);
  assert.match(sinReset.reason, /no está abierta/);
  // arena_flags caída: `readFlag` se traga el error y devuelve null, así que
  // también cae en "no abierta" y no declara — nunca contra la planeada.
  flagsRotos = true;
  const caida = await declareSeasonWinner(RESULTS, at(ARENA_SEASON.end));
  flagsRotos = false;
  assert.equal(caida.declared, false);
  const conError = await declareSeasonWinner(RESULTS, at('2026-11-18'),
    { temporada: temporadaEfectiva(null), error: 'arena_flags caída' });
  assert.equal(conError.declared, false);
  assert.match(conError.reason, /arena_flags caída/);
  assert.equal(journal.length, 0);
});

test('el anuncio de hoy publica 2026-10-20 → 2026-11-18, 22 sesiones, y NO dice 2026-10-30', () => {
  const rows = ['claude', 'control', 'openai', 'grok', 'gemini', 'deepseek', 'qwen']
    .map((agent) => ({ agent, flat: true, before: { equity: 100000 }, baseline_equity: 100000 }));
  const a = resetAnnouncement({ resetId: 'arena-t3-2026-10-20', baselineUsd: 100000, rows, now: at(ABRE, '14:30') });
  assert.match(a, /VENTANA DE LA TEMPORADA: 2026-10-20 → 2026-11-18, 22 sesiones hábiles/);
  assert.match(a, /El último día, 2026-11-18, se declara al ganador/);
  assert.match(a, /REJILLA COMPLETA.*22 sesiones/);
  assert.doesNotMatch(a, /2026-10-30|30-oct/, 'ni una mención a la fecha de cierre vieja');
});

// ── LO QUE SE PUBLICA: /api/liga/libros y ?compuertas=1 ──────────────
// Después del reset, Lety verifica con ?compuertas=1: tiene que leer 11-18.
const mkRes = () => {
  const r = { headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
};

test('libros y compuertas publican la temporada efectiva', async () => {
  flags = { 'season_start:T3': { start: ABRE, end: '2026-11-18', sesiones: 22 } };
  process.env.ARENA_ADMIN_KEY = 'clave-de-prueba';
  const libros = (await import('../api/liga-libros.js')).default;
  let r = mkRes();
  await libros({ method: 'GET', query: {}, headers: {} }, r);
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.temporada.start, r.body.temporada.end, r.body.temporada.abierta], [ABRE, '2026-11-18', true]);

  const audit = (await import('../api/arena-audit.js')).default;
  r = mkRes();
  await audit({ method: 'GET', query: { compuertas: '1' }, headers: { 'x-admin-key': 'clave-de-prueba' } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.temporada, { id: 'T3', start: ABRE, end: '2026-11-18', sesiones: 22, abierta: true });
});
