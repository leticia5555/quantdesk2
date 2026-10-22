// ═══════════════════════════════════════════════════════════════════════
// EL DIAGNÓSTICO DEL VIGILANTE — `?job=diagnostico`
//
// #319 arregló que el 402 de OpenRouter se reconozca como rechazo de cuenta y
// deje su fila POR AGENTE, y con eso dejó abierta la pregunta que importa: si
// cada agente que llama y recibe el 402 deja su fila, los otros cuatro nunca
// llegaron a llamar. Por qué no los despachó el vigilante entre 18:27 y 19:18
// UTC no se ve en el código — se ve en `arena_watch` / `arena_watch_meta`.
//
// Lo que se prueba acá:
//   · que las seis consultas sean de SOLO LECTURA, y que el guardia lo note
//     si alguien agrega una que no lo sea;
//   · que PARSEEN contra un Postgres real con la DDL del repo (PREPARE
//     resuelve cada columna: si la DDL y la consulta se desincronizan, rojo);
//   · que el resumen distinga las hipótesis que SE VEN IGUAL en las filas —
//     "detenido" contra "sin disparador", y "despachado" contra "despachado y
//     nunca dejó journal".
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

import {
  CONSULTAS, diaValido, horaValida, resumenPorAgente, soloLectura, HIPOTESIS,
} from '../api/_lib/arena-watch-diagnostico.js';
import { SCHEMA } from '../api/_lib/db.js';

const PUERTO = 55441;
const BIN = SIN_POSTGRES ? null : binDePostgres();

// ── SOLO LECTURA ──────────────────────────────────────────────────────
test('las seis consultas son de solo lectura', () => {
  const nombres = Object.keys(CONSULTAS);
  assert.equal(nombres.length, 6, 'seis bloques, uno por grupo de hipótesis');
  for (const [nombre, q] of Object.entries(CONSULTAS)) {
    assert.ok(soloLectura(q), `${nombre} no es de solo lectura`);
  }
});

test('y el guardia SE DA CUENTA si alguien agrega una que escribe', () => {
  // La mutación: si `soloLectura` fuera `() => true`, el endpoint correría
  // un `delete` en producción y lo contaría como diagnóstico.
  assert.equal(soloLectura('delete from arena_watch where 1=1'), false);
  assert.equal(soloLectura('select 1; drop table arena_watch'), false);
  assert.equal(soloLectura('update arena_state set halted = false'), false);
  assert.equal(soloLectura('  SELECT * from arena_watch  '), true);
});

// ── LOS PARÁMETROS ────────────────────────────────────────────────────
test('el día y las horas se validan: nada se interpola a ciegas', () => {
  assert.equal(diaValido('2026-10-21'), '2026-10-21');
  assert.equal(diaValido('2026-10-21; drop table arena_watch'), null);
  assert.equal(diaValido('ayer'), null);
  assert.equal(horaValida('18:00'), '18:00:00');
  assert.equal(horaValida('19:18:30'), '19:18:30');
  assert.equal(horaValida('25:00'), null);
  assert.equal(horaValida('18:60'), null);
  // Vacío NO es inválido: cae al default que le pase el handler.
  assert.equal(horaValida('', '00:00:00'), '00:00:00');
});

// ── EL RESUMEN: LAS HIPÓTESIS QUE SE VEN IGUAL ────────────────────────
test('"detenido" y "sin disparador" NO se confunden, aunque las filas sean idénticas', () => {
  // Los dos agentes tienen EXACTAMENTE lo mismo en arena_watch: nada. Es el
  // caso que motiva el bloque `estado`: `agentsForEval` saca al detenido
  // antes de que se escriba fila alguna.
  const r = resumenPorAgente({
    agentes: ['grok', 'deepseek'],
    disparadores: [],
    journal: [],
    estado: [{ agent_id: 'deepseek', halted: true, halted_at: '2026-10-21T17:50:00Z', halted_reason: 'tope de pérdida diaria' }],
  });
  assert.equal(r.find((x) => x.agent_id === 'grok').veredicto, 'sin_disparador');
  assert.equal(r.find((x) => x.agent_id === 'deepseek').veredicto, 'detenido');
  assert.equal(r.find((x) => x.agent_id === 'deepseek').motivo, 'tope de pérdida diaria');
});

test('un agente despachado que NO dejó journal se nombra, que es H7', () => {
  // Es la única hipótesis que el código solo no puede descartar: #319 concluye
  // que esos cuatro "nunca llegaron a llamar", y esa conclusión supone que no
  // hay `fired=true` sin fila de journal. Eso es un dato, no un teorema.
  const r = resumenPorAgente({
    agentes: ['openai', 'qwen'],
    disparadores: [
      { agent_id: 'openai', fired: true }, { agent_id: 'qwen', fired: true },
    ],
    journal: [{ agent_id: 'openai' }],
  });
  assert.equal(r.find((x) => x.agent_id === 'openai').veredicto, 'despachado_y_corrio');
  assert.equal(r.find((x) => x.agent_id === 'qwen').veredicto, 'despachado_sin_journal');
});

test('el frenado trae SUS razones, que es lo que separa enfriamiento de presupuesto', () => {
  const r = resumenPorAgente({
    agentes: ['grok', 'gemini'],
    disparadores: [
      { agent_id: 'grok', fired: false, skip_reason: 'enfriamiento: corrió hace 9 min' },
      { agent_id: 'gemini', fired: false, skip_reason: 'presupuesto en escalón 2: los disparadores del buffet están apagados (los del propio libro no)' },
    ],
  });
  assert.deepEqual(r.find((x) => x.agent_id === 'grok').razones, ['enfriamiento: corrió hace 9 min']);
  assert.match(r.find((x) => x.agent_id === 'gemini').razones[0], /^presupuesto en escalón/);
});

test('sin tick, NINGÚN agente se explica por lo suyo', () => {
  // H5 gana sobre todo: si el vigilante no corrió, preguntarse por el
  // enfriamiento de un agente es responder una pregunta que nadie hizo.
  const r = resumenPorAgente({
    agentes: ['openai', 'grok'],
    disparadores: [{ agent_id: 'grok', fired: false, skip_reason: 'enfriamiento' }],
    huboTick: false,
  });
  assert.ok(r.every((x) => x.veredicto === 'sin_tick'), JSON.stringify(r));
});

test('el resumen recorre el PADRÓN, no las filas', () => {
  // Si se armara desde las filas, un agente sin disparador sencillamente no
  // aparecería — y "no aparece" es justo lo que no queremos que signifique
  // dos cosas distintas.
  const r = resumenPorAgente({ agentes: ['a', 'b', 'c'], disparadores: [{ agent_id: 'a', fired: true }], journal: [{ agent_id: 'a' }] });
  assert.deepEqual(r.map((x) => x.agent_id), ['a', 'b', 'c']);
});

test('cada hipótesis del encabezado tiene su entrada publicada', () => {
  // La respuesta del endpoint lleva el mapa: un JSON de seis bloques sin decir
  // qué separa cada uno obliga a reconstruirlo de memoria cada vez.
  assert.deepEqual(Object.keys(HIPOTESIS), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']);
});

// ── CONTRA UN POSTGRES DE VERDAD ──────────────────────────────────────
test('las seis consultas se preparan contra un Postgres real', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: PUERTO });

  await t.test('la DDL real del repo crea las tablas del vigilante', () => {
    // La DDL DEL REPO, no una copia escrita a mano: una copia no puede
    // contradecirme. Varias sentencias son migraciones que no aplican sobre
    // una base vacía, así que se toleran una por una.
    for (const q of SCHEMA) {
      try { psql(q + ';'); } catch { /* migración que no aplica en vacío */ }
    }
    const tablas = psql(
      "select table_name from information_schema.tables where table_schema='public' "
      + "and table_name like 'arena%' order by 1;").trim().split('\n');
    for (const t of ['arena_journal', 'arena_state', 'arena_watch', 'arena_watch_mark', 'arena_watch_meta']) {
      assert.ok(tablas.includes(t), `falta ${t}; están: ${tablas.join(', ')}`);
    }
  });

  await t.test('PREPARE: cada columna existe y cada parámetro liga con su tipo', () => {
    // PREPARE parsea Y resuelve nombres: si la DDL y la consulta se
    // desincronizan, esto es rojo. Un `explain` no alcanzaría.
    // Los tres parámetros se declaran por TIPO —`(text, text, text)`—, que es
    // lo que la sintaxis de PREPARE pide; `($1 text, …)` es un error de
    // sintaxis, no otra forma de escribirlo.
    psql(Object.entries(CONSULTAS)
      .map(([nombre, q]) => `prepare d_${nombre} (text, text, text) as ${q};`)
      .join('\n'));
  });

  await t.test('y devuelven lo que el caso del 2026-10-21 necesita leer', () => {
    // Filas con la FORMA del caso: un agente que recibió el 402, uno frenado
    // por enfriamiento, uno apagado por presupuesto, uno detenido, y un ancla
    // re-fijada. Si un bloque queda mudo por un tipo o un rango mal puestos,
    // acá se ve — y no pasa por "no había nada".
    psql(`
      insert into arena_watch (run_date, agent_id, symbol, trigger_type, fired, skip_reason, detail, fired_at) values
        ('2026-10-21','openai','NVDA','move_3pct',true,  null, '{}', '2026-10-21 18:15:00+00'),
        ('2026-10-21','grok',  'TSLA','move_3pct',false,'enfriamiento: corrió hace 9 min', '{}', '2026-10-21 18:31:00+00'),
        ('2026-10-21','gemini','AMD', 'buffet_move',false,'presupuesto en escalón 2', '{}', '2026-10-21 18:44:00+00'),
        ('2026-10-21','grok',  'TSLA','move_3pct',false,'enfriamiento', '{}', '2026-10-21 23:00:00+00');
      insert into arena_journal (id, run_date, phase, status, model, agent_id, error, context, created_at) values
        ('j1','2026-10-21','watch','error','openrouter/gpt','openai','OpenRouter HTTP 402: requires more credits','{"llm_error":"cuenta"}','2026-10-21 18:15:04+00');
      insert into arena_watch_meta (key, value, updated_at) values
        ('reconcile:2026-10-21','{"at":"x"}','2026-10-21 18:30:00+00');
      insert into arena_state (id, agent_id, halted, halted_at, halted_reason) values
        (1,'deepseek',true,'2026-10-21 17:50:00+00','tope de pérdida diaria');
      insert into arena_watch_mark (agent_id, symbol, price, marked_at, source) values
        ('llama','MSFT',512.40,'2026-10-21 18:26:00+00','watch_trigger');
    `);
    // Cada llamada a psql es una SESIÓN nueva, y un `prepare` muere con su
    // sesión: el prepare y el execute tienen que ir en la misma llamada. (La
    // primera versión los separó y el error —"prepared statement does not
    // exist"— no se parece en nada a la causa.)
    const corre = (nombre) => psql(
      `prepare p (text, text, text) as ${CONSULTAS[nombre]};\n`
      + `execute p('2026-10-21','2026-10-21T18:00:00Z','2026-10-21T19:30:00Z');`)
      .trim().split('\n').filter(Boolean);

    // La VENTANA recorta de verdad: el cuarto disparo de grok es de las 23:00
    // y no puede estar. Sin esta comprobación, un rango mal puesto se leería
    // como "hubo más actividad de la que hubo".
    assert.equal(corre('disparadores').length, 3, 'tres en la ventana, no los cuatro del día');
    // El bloque del día SÍ los cuenta todos: es su trabajo separar
    // enfriamiento de tope.
    const dia = corre('dia_por_agente');
    assert.ok(dia.some((l) => l.startsWith('grok|2|0')), `grok con 2 disparos y 0 despachados: ${dia.join(' / ')}`);
    assert.equal(corre('journal').length, 1);
    assert.equal(corre('marcas').length, 1);
    assert.equal(corre('estado').length, 1);
    assert.equal(corre('anclas').length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EL ENDPOINT: `/api/arena-watch?job=diagnostico`
//
// Se prueba por el handler REAL, con el fetch a Neon mockeado y CADA consulta
// capturada. La aserción central no es que conteste 200: es que todo lo que
// mandó a la base sea `select`. Un diagnóstico que escribe deja de serlo.
// ═══════════════════════════════════════════════════════════════════════
process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ARENA_ADMIN_KEY = 'llave-de-prueba';
delete process.env.CRON_SECRET;
// Los tres frenos del vigilante, APAGADOS a propósito: el momento en que más
// falta hace mirar su libreta es justo cuando está apagado.
delete process.env.ARENA_ENABLED;

const { default: watchHandler } = await import('../api/arena-watch.js');

function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; } };
}

let consultas = [];
function neonMock() {
  consultas = [];
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const qs = body.queries ? body.queries.map((x) => x.query) : [String(body.query || '')];
    consultas.push(...qs);
    return { ok: true, status: 200, json: async () =>
      (body.queries ? { results: qs.map(() => ({ fields: [], rows: [] })) } : { fields: [], rows: [] }) };
  };
}
const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

test('sin llave → 401, y NO toca la base', async () => {
  global.fetch = neonMock();
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico' }), res);
  assert.equal(res.code, 401);
  assert.equal(consultas.length, 0, 'un 401 no puede haber consultado nada');
  // Dice QUÉ llaves acepta, nunca cuál es el valor.
  assert.ok(res.body.acepta.some((a) => /ARENA_ADMIN_KEY/.test(a)), JSON.stringify(res.body));
});

test('con ?key= contesta 200 aunque el vigilante esté apagado', async () => {
  global.fetch = neonMock();
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', dia: '2026-10-21', desde: '18:00', hasta: '19:30',
    key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.ventana,
    { dia: '2026-10-21', desde: '2026-10-21T18:00:00Z', hasta: '2026-10-21T19:30:00Z' });
  assert.equal(res.body.solo_lectura, true);
  assert.equal(res.body.hubo_tick, false, 'sin marcas en la ventana → H5 arriba de todo');
  assert.ok(res.body.resumen.length > 0, 'el resumen recorre el padrón aunque no haya filas');
  assert.ok(res.body.resumen.every((r) => r.veredicto === 'sin_tick'));
  assert.deepEqual(Object.keys(res.body.bloques).sort(), Object.keys(CONSULTAS).sort());
  assert.ok(res.body.hipotesis.H7, 'el mapa de hipótesis viaja con la respuesta');
});

test('TODO lo que mandó a la base es select: ni ensureSchema', async () => {
  global.fetch = neonMock();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), mockRes());
  assert.equal(consultas.length, 6, `seis consultas, una por bloque: ${consultas.length}`);
  for (const q of consultas) {
    assert.ok(soloLectura(q), `esta consulta no es de solo lectura: ${q.slice(0, 90)}`);
  }
  // `ensureSchema` es DDL (`create table if not exists`). Un diagnóstico que
  // crea tablas no es de solo lectura, por más idempotente que sea.
  assert.ok(!consultas.some((q) => /create table/i.test(q)), 'el diagnóstico no corre ensureSchema');
});

test('un día inválido → 400, y tampoco toca la base', async () => {
  global.fetch = neonMock();
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', dia: "2026-10-21'; drop table arena_watch; --",
    key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.equal(consultas.length, 0);
});

test('una hora inválida → 400 con lo que esperaba y lo que recibió', async () => {
  global.fetch = neonMock();
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', desde: '25:00', key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.recibido.desde, '25:00');
  assert.match(res.body.espera.desde, /HH:MM/);
});

test('una ventana al revés se rechaza en vez de devolver vacío', async () => {
  // Sin esto, `desde=19:30&hasta=18:00` devuelve seis bloques vacíos, que se
  // leen exactamente igual que "el vigilante no tickeó" (H5). Un error de
  // tipeo no puede disfrazarse de hallazgo.
  global.fetch = neonMock();
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', dia: '2026-10-21', desde: '19:30', hasta: '18:00',
    key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.equal(consultas.length, 0);
});

test('una consulta que falla no tumba a las otras cinco', async () => {
  // Con un hueco por explicar, cinco bloques valen mucho más que un 500.
  let n = 0;
  global.fetch = async (_url, opts) => {
    consultas.push(String(JSON.parse(opts.body).query || ''));
    if (++n === 2) throw new Error('Neon: connection reset');
    return { ok: true, status: 200, json: async () => ({ fields: [], rows: [] }) };
  };
  consultas = [];
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.ok(res.body.errores, 'el bloque que falló se NOMBRA en vez de desaparecer');
  assert.equal(Object.keys(res.body.errores).length, 1);
});
