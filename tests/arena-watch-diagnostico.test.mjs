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
  parametrosQueUsa, BLOQUES_DEL_VEREDICTO,
} from '../api/_lib/arena-watch-diagnostico.js';
import { SCHEMA } from '../api/_lib/db.js';

const PUERTO = 55441;
const BIN = SIN_POSTGRES ? null : binDePostgres();

// LOS MISMOS VALORES QUE ARMA EL HANDLER. Si esto se escribiera distinto de
// `diagnosticoDelHueco`, la prueba mediría otra cosa que la que corre.
const CTX = { dia: '2026-10-21', desde: '2026-10-21T18:00:00Z', hasta: '2026-10-21T19:30:00Z' };
const comillas = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ── SOLO LECTURA ──────────────────────────────────────────────────────
test('las seis consultas son de solo lectura', () => {
  const nombres = Object.keys(CONSULTAS);
  assert.equal(nombres.length, 6, 'seis bloques, uno por grupo de hipótesis');
  for (const [nombre, c] of Object.entries(CONSULTAS)) {
    assert.ok(soloLectura(c.sql), `${nombre} no es de solo lectura`);
  }
});

test('cada consulta entrega EXACTAMENTE los parámetros que su texto menciona', () => {
  // El defecto de producción en una línea: el handler le pasaba los mismos
  // tres a las seis. `estado` no usa ninguno, `anclas` usa uno, y tres usan
  // $1 y $2 — un parámetro de más no es inofensivo, es un error de bind.
  for (const [nombre, c] of Object.entries(CONSULTAS)) {
    const usa = parametrosQueUsa(c.sql);
    const entrega = c.params(CTX);
    assert.equal(entrega.length, usa.length,
      `${nombre}: el texto menciona ${usa.length} parámetro(s) y params() entrega ${entrega.length}`);
    // Y numerados desde $1 sin huecos: `$2` sin `$1` es justo lo que daba
    // "could not determine data type of parameter $1".
    assert.deepEqual(usa, usa.map((_, i) => i + 1),
      `${nombre}: los parámetros tienen que ir de $1 en adelante, sin saltos — son ${usa.join(',')}`);
    for (const v of entrega) assert.ok(v != null && v !== '', `${nombre}: un parámetro vacío`);
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

  await t.test('PREPARE SIN declarar tipos: igual que Neon, que los infiere', () => {
    // ── POR QUÉ `prepare p AS …` Y NO `prepare p (text, text, text) AS …` ──
    // La primera versión de esta prueba declaraba los tres tipos a mano. Esa
    // declaración FABRICA la aridad y le inventa un tipo a un `$1` que la
    // consulta nunca menciona — justo las dos cosas que producción no puede
    // hacer. Las seis pasaron en verde acá y las seis reventaron en Neon.
    //
    // Sin lista de tipos, Postgres los infiere del texto, que es exactamente
    // lo que hace Neon. Si una consulta vuelve a traer un parámetro que no
    // usa, esto se pone rojo con el mismo mensaje que vio Lety.
    for (const [nombre, c] of Object.entries(CONSULTAS)) {
      psql(`prepare d_${nombre} as ${c.sql};`);
    }
  });

  await t.test('y EXECUTE con los parámetros REALES del handler', () => {
    // La otra mitad: que la cantidad que el handler entrega sea la que la
    // consulta pide. "supplies 3 parameters, but requires 1" sólo aparece al
    // ejecutar, no al preparar.
    for (const [nombre, c] of Object.entries(CONSULTAS)) {
      const ps = c.params(CTX).map(comillas).join(', ');
      psql(`prepare e_${nombre} as ${c.sql};\nexecute e_${nombre}${ps ? `(${ps})` : ''};`);
    }
  });

  await t.test('y la prueba SE PONE ROJA si alguien vuelve a pasarle tres a todas', () => {
    // La mutación que reproduce el caso de producción. Sin esto, nada impide
    // que el handler vuelva a mandar `[dia, desde, hasta]` a las seis.
    const tres = [CTX.dia, CTX.desde, CTX.hasta].map(comillas).join(', ');
    const rotas = [];
    for (const [nombre, c] of Object.entries(CONSULTAS)) {
      try {
        psql(`prepare m_${nombre} as ${c.sql};\nexecute m_${nombre}(${tres});`);
      } catch (err) { rotas.push(nombre); }
    }
    // ── UN LÍMITE DE ESTE ARNÉS, DECLARADO ──────────────────────────
    // Cinco de las seis, no las seis. `estado` no lleva parámetros, y el
    // `EXECUTE` de psql —protocolo simple— se come los argumentos de más sin
    // chistar. Neon usa el protocolo EXTENDIDO, donde el mensaje `Bind` sí es
    // estricto: por eso en producción `estado` SÍ falló ("supplies 3
    // parameters, but requires 0") y acá no puede reproducirse.
    //
    // No se disfraza con un `>= 5`: se nombra cuál falta y por qué, y ese caso
    // queda cubierto EXACTAMENTE por la prueba de aridad de arriba, que
    // compara `parametrosQueUsa()` contra `params().length` sin depender de
    // qué protocolo hable el cliente.
    assert.deepEqual(rotas.sort(),
      ['anclas', 'dia_por_agente', 'disparadores', 'journal', 'marcas'],
      'las cinco con parámetros tienen que fallar con los tres de siempre');
    assert.ok(!rotas.includes('estado'),
      'si `estado` empieza a fallar acá, psql cambió de protocolo y este comentario quedó viejo');
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

// ── EL VEREDICTO CUANDO NO SE PUDO MEDIR ──────────────────────────────
// Lo grave del caso de producción no fue que las consultas fallaran: fue que
// el resumen igual dijo `sin_tick` para los siete agentes. Un bloque que
// REVENTÓ viene vacío igual que uno sin filas, y confundirlos convierte un
// error en un hallazgo.
function fallaEn(cuales) {
  consultas = [];
  return async (_url, opts) => {
    const q = String(JSON.parse(opts.body).query || '');
    consultas.push(q);
    if (cuales.some((frag) => q.includes(frag))) throw new Error('Neon: could not determine data type of parameter $1');
    return { ok: true, status: 200, json: async () => ({ fields: [], rows: [] }) };
  };
}

test('si falla un bloque del veredicto, NADIE sale diagnosticado', async () => {
  global.fetch = fallaEn(['arena_watch_meta']);   // el bloque `marcas`
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.medicion_completa, false);
  // `null`, no `false`: false quiere decir "miré y no había".
  assert.equal(res.body.hubo_tick, null);
  assert.ok(res.body.resumen.every((r) => r.veredicto === 'no_medido'),
    `ninguno puede salir con diagnóstico: ${JSON.stringify(res.body.resumen)}`);
  assert.ok(res.body.resumen.every((r) => r.bloques_fallidos.includes('marcas')));
  assert.match(res.body.aviso, /No se pudo medir/);
});

test('y NO sale `sin_tick`, que es lo que pasó en producción', async () => {
  // La mutación exacta: con `marcas` reventado, el resumen anterior leía su
  // arreglo vacío y concluía que el vigilante no había tickeado.
  global.fetch = fallaEn(['arena_watch_meta']);
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), res);
  assert.ok(!res.body.resumen.some((r) => r.veredicto === 'sin_tick'),
    'un bloque que reventó no puede leerse como "no pasó nada"');
});

test('un bloque de CONTEXTO que falla no borra el veredicto, pero se marca', async () => {
  // `anclas` y `dia_por_agente` ayudan a LEER el veredicto, no lo producen.
  // Tirar la lectura entera por uno de ellos sería perder cinco bloques
  // buenos; callarlo sería lo otro.
  global.fetch = fallaEn(['arena_watch_mark']);   // el bloque `anclas`
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), res);
  assert.equal(res.body.medicion_completa, false);
  assert.deepEqual(res.body.bloques_fallidos, ['anclas']);
  assert.equal(res.body.aviso, undefined, 'el veredicto no depende de anclas');
  assert.ok(res.body.resumen.every((r) => r.veredicto === 'sin_tick'));
  assert.ok(BLOQUES_DEL_VEREDICTO.every((b) => b !== 'anclas'));
});

test('si fallan las SEIS, 502: eso no es una lectura con huecos', async () => {
  // Es la lectura que no ocurrió, y un 200 la haría pasar por buena. Es
  // literalmente lo que devolvió producción el 2026-10-22.
  global.fetch = async (_url, opts) => {
    consultas.push(String(JSON.parse(opts.body).query || ''));
    throw new Error('Neon: could not determine data type of parameter $1');
  };
  consultas = [];
  const res = mockRes();
  await watchHandler(GET({ job: 'diagnostico', key: 'llave-de-prueba' }), res);
  assert.equal(res.code, 502, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.medicion_completa, false);
  assert.equal(res.body.bloques_fallidos.length, 6);
  assert.ok(res.body.resumen.every((r) => r.veredicto === 'no_medido'));
});

test('cada consulta sale con SU cantidad de parámetros, no con tres', async () => {
  // El defecto de producción, por el camino real del handler.
  const binds = [];
  global.fetch = async (_url, opts) => {
    const b = JSON.parse(opts.body);
    binds.push({ q: String(b.query || ''), n: (b.params || []).length });
    return { ok: true, status: 200, json: async () => ({ fields: [], rows: [] }) };
  };
  consultas = [];
  await watchHandler(GET({ job: 'diagnostico', dia: '2026-10-21', desde: '18:00', hasta: '19:30',
    key: 'llave-de-prueba' }), mockRes());
  assert.equal(binds.length, 6);
  for (const b of binds) {
    const usa = parametrosQueUsa(b.q).length;
    assert.equal(b.n, usa, `esta consulta usa ${usa} parámetro(s) y se mandaron ${b.n}: ${b.q.slice(0, 70)}`);
  }
  // Y que de verdad NO sean tres en todas, que es como estaba.
  assert.ok(new Set(binds.map((b) => b.n)).size > 1,
    'si todas llevan la misma cantidad, volvimos al bug');
});
