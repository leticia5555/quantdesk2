// ═══════════════════════════════════════════════════════════════════
// tests/alertas.test.mjs — las alertas a Telegram.
//
// Lo que se prueba es lo que Lety pidió, en sus palabras:
//   • "sin repetir la misma alerta"      → contra un Postgres de verdad, porque
//     la deduplicación ES un `on conflict` y un mock de eso no prueba nada.
//   • "máximo una vez al día" el saldo   → la clave lleva la fecha de Monterrey.
//   • "un cron que falle"                → una vez por episodio; si se recupera
//     y vuelve a fallar, avisa de nuevo (y el episodio viejo queda archivado).
//   • "más de 30% en 1D"                 → y que una serie atrasada no cuente.
//   • "8 pm hora de Monterrey"           → el cron de vercel.json es 02:00 UTC.
//   • "nunca imprimas el token"          → ningún error lo trae.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  enviarAlerta, cerrarEpisodiosDeCron, SCHEMA_ALERTAS, guardarChatId, chatIdDestino,
  alertaSaldo, cronsEnFalla, alertaCron, movimientosFuertes, alertaMovimiento,
  alertaResumen, alertaDePrueba, fechaMonterrey, telegram, sinToken,
  chatsDeUpdates, elegirChat, estadoDeConfig,
} from '../api/_lib/alertas.js';
import { jobVigia, jobResumen, jobChatId, llamar } from '../api/alertas.js';
import handler from '../api/alertas.js';
import { estadoSaldo } from '../api/_lib/openrouter-saldo.js';
import { rowsToObjects } from '../api/_lib/db.js';
import { puenteNeon, resFalsa } from './_neon-psql.mjs';
import { levantaPostgres, binDePostgres, SIN_POSTGRES, FALTA_POSTGRES } from './_postgres.mjs';

const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake12';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '5550001234' };

// Un Telegram de mentira que anota lo que le mandan.
function telegramFalso({ falla = false } = {}) {
  const tg = { enviados: [], urls: [], falla };
  tg.fetch = async (url, init) => {
    tg.urls.push(url);
    const cuerpo = JSON.parse(init.body);
    if (tg.falla) return { ok: false, status: 500, json: async () => ({ ok: false, description: 'Internal Server Error' }) };
    if (url.endsWith('/sendMessage')) {
      tg.enviados.push(cuerpo);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 100 + tg.enviados.length } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: tg.updates || [] }) };
  };
  return tg;
}

function sqlDe(psql) {
  const puente = puenteNeon(psql);
  return async (query, params = []) => rowsToObjects(await (await puente('', { body: JSON.stringify({ query, params }) })).json());
}

// ─────────────────────────── fechas ───────────────────────────

test('la fecha de las claves diarias es la de Monterrey, no la de UTC', () => {
  // 02:00 UTC del 26 son las 20:00 del 25 en Monterrey.
  assert.equal(fechaMonterrey(new Date('2026-11-26T02:00:00Z')), '2026-11-25');
  assert.equal(fechaMonterrey(new Date('2026-11-26T06:00:00Z')), '2026-11-26');
  // En julio también es UTC−6: México no tiene horario de verano desde 2022.
  assert.equal(fechaMonterrey(new Date('2026-07-10T05:59:00Z')), '2026-07-09');
});

test('el resumen está agendado a las 20:00 de Monterrey y el vigía cada 10 min', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  const resumen = vercel.crons.find((c) => c.path === '/api/alertas?job=resumen');
  assert.ok(resumen, 'el resumen no está agendado');
  const [min, hora] = resumen.schedule.split(' ');
  const enMonterrey = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Monterrey', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(Date.UTC(2026, 10, 26, Number(hora), Number(min))));
  assert.equal(enMonterrey, '20:00');
  assert.equal(vercel.crons.find((c) => c.path === '/api/alertas?job=vigia').schedule, '*/10 * * * *');
});

// ─────────────────────────── el token ───────────────────────────

test('ningún error de Telegram trae el token, ni cuando el fetch revienta con la URL adentro', async () => {
  const revienta = async (url) => { throw new Error(`request to ${url} failed, reason: ECONNRESET`); };
  await assert.rejects(telegram('sendMessage', {}, { env: ENV, fetchImpl: revienta }), (e) => {
    assert.ok(!e.message.includes(TOKEN), 'el token salió en el error');
    assert.ok(!e.message.includes('AAFake'));
    assert.match(e.message, /<token>/);
    return true;
  });
  const r = await enviarAlerta({ clave: null, texto: 'x' }, { env: ENV, sql: async () => [], fetchImpl: revienta });
  assert.equal(r.enviada, false);
  assert.ok(!JSON.stringify(r).includes('AAFake'));
  assert.equal(sinToken(`bot${TOKEN}/getUpdates`), 'bot<token>/getUpdates');
});

test('sin token o sin chat no manda, y dice cuál falta', async () => {
  const tg = telegramFalso();
  const sinTok = await enviarAlerta({ clave: null, texto: 'x' }, { env: { TELEGRAM_CHAT_ID: '1' }, sql: async () => [], fetchImpl: tg.fetch });
  assert.match(sinTok.error, /TELEGRAM_BOT_TOKEN/);
  const sinChat = await enviarAlerta({ clave: null, texto: 'x' }, { env: { TELEGRAM_BOT_TOKEN: TOKEN }, sql: async () => [], fetchImpl: tg.fetch });
  assert.match(sinChat.error, /chat_id/);
  assert.equal(tg.enviados.length, 0);
});

test('el estado de la configuración dice SI hay token, nunca cuál', async () => {
  const e = await estadoDeConfig({ env: ENV, sql: async () => [] });
  assert.equal(e.token_configurado, true);
  assert.equal(e.chat, '…1234');
  assert.ok(!JSON.stringify(e).includes('AAFake'));
  assert.ok(!JSON.stringify(e).includes('5550001234'));
});

// ─────────────────────────── el chat_id ───────────────────────────

const UPD = (id, nombre, usuario, date, type = 'private') => ({ update_id: date, message: { date, chat: { id, type, first_name: nombre, username: usuario } } });

test('chat-id: con un solo chat privado lo toma; grupos y canales no cuentan', () => {
  const chats = chatsDeUpdates([UPD(111, 'Lety', 'lety', 10), UPD(111, 'Lety', 'lety', 20), UPD(-999, 'Grupo', null, 30, 'group')]);
  assert.equal(chats.length, 1);
  assert.deepEqual(elegirChat(chats), { ok: true, chat: { id: 111, nombre: 'Lety', usuario: 'lety', fecha: 20 } });
});

test('chat-id: con dos personas NO adivina — pide &usuario= y enmascara los ids', () => {
  const chats = chatsDeUpdates([UPD(1110001, 'Lety', 'lety', 10), UPD(2220002, 'Extraño', 'x', 20)]);
  const r = elegirChat(chats);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('1110001'));
  assert.equal(elegirChat(chats, { usuario: '@Lety' }).chat.id, 1110001);
  assert.equal(elegirChat([], {}).ok, false);
});

// ─────────────────────────── 1. saldo ───────────────────────────

test('saldo: bajo $10 alerta con clave del día; una lectura fallida NO es saldo bajo', () => {
  const ahora = new Date('2026-11-26T01:00:00Z');
  const a = alertaSaldo(estadoSaldo({ usd: -0.15, fuente: 'credits' }, 10), ahora);
  assert.equal(a.clave, 'saldo-openrouter:2026-11-25');
  assert.match(a.texto, /−\$0\.15/);
  assert.match(a.texto, /piso es \$10/);
  assert.equal(alertaSaldo(estadoSaldo({ usd: 10, fuente: 'credits' }, 10), ahora), null);
  assert.equal(alertaSaldo(estadoSaldo({ usd: 250 }, 10), ahora), null);
  assert.equal(alertaSaldo(estadoSaldo({ usd: null, error: 'HTTP 500' }, 10), ahora), null);
});

// ─────────────────────────── 2. crons ───────────────────────────

const EXP = [
  { job: 'a:error', path: '/api/a', cadence: 'diario', stale_after_h: 30 },
  { job: 'b:tarde', path: '/api/b', cadence: 'cada 10 min', stale_after_h: 2 },
  { job: 'c:bien', path: '/api/c', cadence: 'diario', stale_after_h: 30 },
  { job: 'd:apagado', path: '/api/d', cadence: 'diario', stale_after_h: 30 },
  { job: 'e:nunca', path: '/api/e', cadence: 'diario', stale_after_h: 30 },
];

test('crons: falla = latido `error` o sin latir de más; apagado y nunca-corrido no', () => {
  const ahora = new Date('2026-11-26T01:00:00Z');
  const beats = [
    { job: 'a:error', last_run_at: '2026-11-25 21:05:35.331471+00', last_status: 'error', detail: { error: 'Faltan ALPACA_LIBRO_PAPER_KEY' } },
    { job: 'b:tarde', last_run_at: '2026-11-25 20:00:00+00', last_status: 'ok' },
    { job: 'c:bien', last_run_at: '2026-11-25 23:00:00+00', last_status: 'ok' },
    { job: 'd:apagado', last_run_at: '2026-11-25 23:00:00+00', last_status: 'disabled' },
  ];
  const f = cronsEnFalla({ expected: EXP, beats, ahora });
  assert.deepEqual(f.map((x) => [x.job, x.causa]), [['a:error', 'error'], ['b:tarde', 'sin_latido']]);
  const a = alertaCron(f[0]);
  assert.equal(a.clave, 'cron:a:error');
  assert.match(a.texto, /Falló el cron a:error/);
  assert.match(a.texto, /Faltan ALPACA_LIBRO_PAPER_KEY/);
  assert.match(alertaCron(f[1]).texto, /Lleva 5 h sin latir/);
});

// ─────────────────────────── 3. movimientos ───────────────────────────

const T = (iso) => Date.parse(iso + 'T00:00:00Z') / 1000;

test('movimientos: sólo > 30% en el ÚLTIMO cierre; ni serie atrasada ni serie con hueco', () => {
  const mapa = {
    mapa: 'us', ultimo_cierre: '2026-11-25',
    cuadros: [
      { symbol: 'SUBE', nombre: 'Sube Inc', serie: [{ t: T('2026-11-24'), c: 10 }, { t: T('2026-11-25'), c: 14 }] },
      { symbol: 'BAJA', nombre: 'Baja Corp', serie: [{ t: T('2026-11-24'), c: 20 }, { t: T('2026-11-25'), c: 12 }] },
      { symbol: 'JUSTO30', serie: [{ t: T('2026-11-24'), c: 10 }, { t: T('2026-11-25'), c: 13 }] },
      { symbol: 'POCO', serie: [{ t: T('2026-11-24'), c: 10 }, { t: T('2026-11-25'), c: 11 }] },
      // El caso real (PSKY): +41% entre dos puntos de octubre. No es de hoy.
      { symbol: 'ATRASADA', serie: [{ t: T('2026-10-16'), c: 10 }, { t: T('2026-10-22'), c: 14.1 }] },
      // Último punto al día, pero el anterior es de hace tres semanas.
      { symbol: 'HUECO', serie: [{ t: T('2026-11-03'), c: 10 }, { t: T('2026-11-25'), c: 15 }] },
      // Fin de semana largo: viernes → martes son 4 días y SÍ es 1D.
      { symbol: 'PUENTE', serie: [{ t: T('2026-11-20'), c: 10 }, { t: T('2026-11-25'), c: 5 }] },
      { symbol: 'CORTA', serie: [{ t: T('2026-11-25'), c: 15 }] },
    ],
  };
  const m = movimientosFuertes(mapa);
  assert.deepEqual(m.map((x) => x.symbol), ['PUENTE', 'SUBE', 'BAJA']);
  const a = alertaMovimiento(m.find((x) => x.symbol === 'SUBE'));
  assert.equal(a.clave, 'movimiento:us:SUBE:2026-11-25');
  assert.match(a.texto, /SUBE \+40\.0% en 1D/);
  assert.match(alertaMovimiento(m.find((x) => x.symbol === 'BAJA')).texto, /BAJA −40\.0% en 1D/);
  assert.match(alertaMovimiento({ ...m[1], mercado: 'mx' }).texto, /MXN/);
});

// ─────────────────────────── 4. resumen ───────────────────────────

const LIGA = {
  temporada: { name: 'Temporada 3', corrida_dias: 19 },
  agents: [{ id: 'grok', day_change_pct: 0.68 }, { id: 'openai', day_change_pct: -0.2 }],
  ranking: [
    { id: 'grok', name: 'Grok', compite: true, rank: 1, return_pct: -0.93 },
    { id: 'benchmark-spy', name: 'S&P 500 · SPY', compite: false, rank: null, return_pct: -6.4 },
    { id: 'openai', name: 'ChatGPT', compite: true, rank: 2, return_pct: -7.08 },
  ],
  margen_de_la_tabla: { indice: { disponible: true, ganan: 1, total: 2 } },
};
const COB = {
  ultimo: { fecha: '2026-11-24', texto: 'Cobertura: 47.8% de los Form 4 del día (653 de 1366) — faltan 713' },
  dias: [{ fecha: '2026-11-25', pct: null }, { fecha: '2026-11-24', pct: 47.8 }, { fecha: '2026-11-23', pct: 48.05 }],
  cerrados_con_error: 1,
};

test('resumen: La Liga y Form 4, en español, con clave del día de Monterrey', () => {
  const a = alertaResumen({ liga: LIGA, cobertura: COB, ahora: new Date('2026-11-26T02:00:00Z') });
  assert.equal(a.clave, 'resumen:2026-11-25');
  assert.match(a.texto, /Resumen del miércoles, 25 de noviembre/);
  assert.match(a.texto, /1\. Grok: −0\.93% \(hoy \+0\.68%\)/);
  assert.match(a.texto, /— S&P 500 · SPY: −6\.40% \(índice, no compite\)/);
  assert.match(a.texto, /Le ganan al índice 1 de 2/);
  assert.match(a.texto, /Cobertura: 47\.8% .* \(día 2026-11-24\)/);
  assert.match(a.texto, /11-23: 48%/);
});

test('resumen: si una fuente no se pudo leer, sale igual y LO DICE', () => {
  const a = alertaResumen({ liga: { error: 'Neon: timeout' }, cobertura: COB, ahora: new Date('2026-11-26T02:00:00Z') });
  assert.match(a.texto, /LA LIGA\nNo se pudo leer: Neon: timeout/);
  assert.match(a.texto, /Cobertura: 47\.8%/);
});

test('`llamar` convierte un handler que contesta 5xx o revienta en { error }', async () => {
  assert.deepEqual(await llamar(async (req, res) => res.status(500).json({ error: 'se cayó' })), { error: 'se cayó' });
  assert.deepEqual(await llamar(async () => { throw new Error('pum'); }), { error: 'pum' });
  assert.deepEqual(await llamar(async (req, res) => { res.setHeader('x', 'y'); return res.status(200).json({ ok: 1, q: req.query }); }, { map: 'mx' }), { ok: 1, q: { map: 'mx' } });
});

test('el mensaje de prueba no lleva clave: se puede mandar las veces que haga falta', () => {
  const a = alertaDePrueba(new Date('2026-11-26T02:05:00Z'), 'preview');
  assert.equal(a.clave, null);
  assert.match(a.texto, /20:05 \(hora de Monterrey\) desde preview/);
});

// ─────────────────────────── la compuerta ───────────────────────────

test('el endpoint no corre sin llave, ni queda abierto si no hay ninguna configurada', async () => {
  const previo = { c: process.env.CRON_SECRET, a: process.env.ARENA_ADMIN_KEY };
  try {
    delete process.env.CRON_SECRET; delete process.env.ARENA_ADMIN_KEY;
    let res = resFalsa();
    await handler({ method: 'GET', query: { job: 'prueba' }, headers: {} }, res);
    assert.equal(res.code, 503);
    process.env.CRON_SECRET = 'secreto-del-cron';
    res = resFalsa();
    await handler({ method: 'GET', query: { job: 'prueba' }, headers: {} }, res);
    assert.equal(res.code, 401);
    res = resFalsa();
    await handler({ method: 'GET', query: { job: 'nada' }, headers: { authorization: 'Bearer secreto-del-cron' } }, res);
    assert.equal(res.code, 400);
  } finally {
    if (previo.c == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previo.c;
    if (previo.a == null) delete process.env.ARENA_ADMIN_KEY; else process.env.ARENA_ADMIN_KEY = previo.a;
  }
});

test('un solo módulo le habla a Telegram: nadie más en api/ nombra api.telegram.org', () => {
  const raiz = new URL('../api/', import.meta.url);
  const archivos = [
    ...readdirSync(raiz).filter((f) => f.endsWith('.js')).map((f) => f),
    ...readdirSync(new URL('_lib/', raiz)).filter((f) => f.endsWith('.js')).map((f) => '_lib/' + f),
  ];
  const culpables = archivos.filter((f) => f !== '_lib/alertas.js' && readFileSync(new URL(f, raiz), 'utf8').includes('api.telegram.org'));
  assert.deepEqual(culpables, []);
});

// ═════════════ "SIN REPETIR", contra un Postgres de verdad ═════════════

test('sin repetir: dedup, reintento tras falla, episodios de cron y los jobs enteros', { skip: SIN_POSTGRES && 'SIN_POSTGRES=1' }, async (t) => {
  const BIN = binDePostgres();
  assert.ok(BIN, FALTA_POSTGRES);
  const psql = levantaPostgres(t, { bin: BIN, puerto: 55461 });
  for (const q of SCHEMA_ALERTAS) psql(q + ';');
  const sql = sqlDe(psql);
  const cuenta = () => Number(psql('select count(*) from alertas_enviadas;').trim());

  await t.test('la misma clave se manda UNA vez', async () => {
    const tg = telegramFalso();
    const deps = { env: ENV, sql, fetchImpl: tg.fetch };
    const uno = await enviarAlerta({ clave: 'k1', tipo: 'saldo', texto: 'hola' }, deps);
    const dos = await enviarAlerta({ clave: 'k1', tipo: 'saldo', texto: 'hola' }, deps);
    assert.equal(uno.enviada, true);
    assert.deepEqual([dos.enviada, dos.motivo], [false, 'repetida']);
    assert.equal(tg.enviados.length, 1);
    assert.equal(tg.enviados[0].chat_id, '5550001234');
    assert.equal(tg.enviados[0].text, 'hola');
  });

  await t.test('dos lambdas a la vez: sale una sola', async () => {
    const tg = telegramFalso();
    const deps = { env: ENV, sql, fetchImpl: tg.fetch };
    const rs = await Promise.all([1, 2, 3].map(() => enviarAlerta({ clave: 'k-carrera', tipo: 'saldo', texto: 'x' }, deps)));
    assert.equal(rs.filter((r) => r.enviada).length, 1);
    assert.equal(tg.enviados.length, 1);
  });

  await t.test('si Telegram falla NO queda como enviada: se reintenta cuando vence el reclamo', async () => {
    const tg = telegramFalso({ falla: true });
    const deps = { env: ENV, sql, fetchImpl: tg.fetch };
    const falla = await enviarAlerta({ clave: 'k2', tipo: 'saldo', texto: 'x' }, deps);
    assert.equal(falla.motivo, 'error');
    assert.equal(psql(`select enviada_at is null, ultimo_error from alertas_enviadas where clave = 'k2';`).trim(), 't|Telegram sendMessage: Internal Server Error');
    tg.falla = false;
    // Enseguida no: otra lambda podría estar mandándola.
    assert.equal((await enviarAlerta({ clave: 'k2', tipo: 'saldo', texto: 'x' }, deps)).motivo, 'repetida');
    psql(`update alertas_enviadas set reclamada_at = now() - interval '3 minutes' where clave = 'k2';`);
    assert.equal((await enviarAlerta({ clave: 'k2', tipo: 'saldo', texto: 'x' }, deps)).enviada, true);
    // Y una vez enviada, ya no se reclama aunque pase el tiempo.
    psql(`update alertas_enviadas set reclamada_at = now() - interval '3 days' where clave = 'k2';`);
    assert.equal((await enviarAlerta({ clave: 'k2', tipo: 'saldo', texto: 'x' }, deps)).motivo, 'repetida');
    assert.equal(tg.enviados.length, 1);
  });

  await t.test('en seco no manda ni marca; sin clave manda sin marcar', async () => {
    const tg = telegramFalso();
    const antes = cuenta();
    const seco = await enviarAlerta({ clave: 'k-seco', texto: 'x' }, { env: ENV, sql, fetchImpl: tg.fetch, seco: true });
    assert.equal(seco.motivo, 'seco');
    await enviarAlerta({ clave: null, texto: 'prueba' }, { env: ENV, sql, fetchImpl: tg.fetch });
    await enviarAlerta({ clave: null, texto: 'prueba' }, { env: ENV, sql, fetchImpl: tg.fetch });
    assert.equal(tg.enviados.length, 2);
    assert.equal(cuenta(), antes);
  });

  await t.test('el chat_id guardado por ?job=chat-id sirve cuando no hay env var', async () => {
    const tg = telegramFalso();
    tg.updates = [UPD(777000111, 'Lety', 'lety', 50)];
    const env = { TELEGRAM_BOT_TOKEN: TOKEN };
    assert.equal((await chatIdDestino({ env, sql })).chat_id, null);
    const r = await jobChatId({ deps: { sql, env, fetchImpl: tg.fetch } });
    assert.deepEqual([r.ok, r.chat, r.nombre], [true, '…0111', 'Lety']);
    assert.ok(!JSON.stringify(r).includes('777000111'), 'la respuesta no publica el id entero');
    assert.deepEqual(await chatIdDestino({ env, sql }), { chat_id: '777000111', fuente: 'tabla alertas_config' });
    await enviarAlerta({ clave: null, texto: 'x' }, { env, sql, fetchImpl: tg.fetch });
    assert.equal(tg.enviados[0].chat_id, '777000111');
    // La env var gana.
    assert.equal((await chatIdDestino({ env: ENV, sql })).chat_id, '5550001234');
    await guardarChatId('888', { sql });
    assert.equal((await chatIdDestino({ env, sql })).chat_id, '888');
  });

  await t.test('vigía: tres ticks seguidos mandan cada alerta una vez; el cron que se recupera y recae avisa de nuevo', async () => {
    psql('delete from alertas_enviadas;');
    const tg = telegramFalso();
    const ahora = new Date('2026-11-26T01:00:00Z');
    let estadoLibro = 'error';
    let saldo = -0.15, lecturas = 0;
    const deps = {
      sql, env: ENV, fetchImpl: tg.fetch,
      leerSaldo: async () => { lecturas += 1; return { usd: saldo, fuente: 'credits' }; },
      latidos: async () => [
        { job: 'libro:equity', last_run_at: '2026-11-25 21:05:35+00', last_status: estadoLibro, detail: { error: 'Faltan llaves' } },
        { job: 'arena:watch', last_run_at: '2026-11-25 21:55:09+00', last_status: 'ok' },
      ],
      mapa: async (map) => (map === 'us'
        ? { mapa: 'us', ultimo_cierre: '2026-11-25', cuadros: [{ symbol: 'SUBE', nombre: 'Sube Inc', serie: [{ t: T('2026-11-24'), c: 10 }, { t: T('2026-11-25'), c: 14 }] }] }
        : { mapa: 'mx', ultimo_cierre: '2026-11-25', cuadros: [] }),
    };
    const tipos = () => tg.enviados.map((m) => m.text.split('\n')[0]);

    const t1 = await jobVigia({ ahora, deps });
    assert.equal(t1.ok, true, JSON.stringify(t1.errores));
    assert.equal(t1.enviadas, 3);
    assert.deepEqual(tipos(), ['🔴 Saldo de OpenRouter bajo', '⚠️ Falló el cron libro:equity', '🚀 SUBE +40.0% en 1D']);

    const t2 = await jobVigia({ ahora: new Date('2026-11-26T01:10:00Z'), deps });
    const t3 = await jobVigia({ ahora: new Date('2026-11-26T05:50:00Z'), deps });
    assert.deepEqual([t2.enviadas, t3.enviadas], [0, 0]);
    assert.equal(tg.enviados.length, 3, 'se repitió una alerta');
    assert.equal(lecturas, 1, 'con el saldo ya avisado hoy no se vuelve a consultar OpenRouter');

    // Día siguiente en Monterrey (06:00 UTC = medianoche): el saldo sigue
    // bajo → avisa otra vez. El cron sigue roto → NO repite. SUBE, mismo
    // cierre → NO repite.
    const t4 = await jobVigia({ ahora: new Date('2026-11-26T06:10:00Z'), deps });
    assert.equal(t4.enviadas, 1);
    assert.equal(tipos()[3], '🔴 Saldo de OpenRouter bajo');

    // El cron se recupera: no avisa nada, pero el episodio se cierra…
    estadoLibro = 'ok'; saldo = 50;
    const t5 = await jobVigia({ ahora: new Date('2026-11-27T06:10:00Z'), deps });
    assert.equal(t5.enviadas, 0);
    assert.deepEqual(t5.crons.recuperados, ['libro:equity']);
    // El episodio no se borra: queda archivado, con la hora en que se cerró.
    assert.match(psql(`select clave from alertas_enviadas where tipo = 'cron-cerrado';`).trim(), /^cron:libro:equity · cerrado 2\d{3}-/);
    // …y cuando vuelve a fallar, avisa de nuevo.
    estadoLibro = 'error';
    const t6 = await jobVigia({ ahora: new Date('2026-11-27T06:20:00Z'), deps });
    assert.equal(t6.enviadas, 1);
    assert.equal(tipos()[4], '⚠️ Falló el cron libro:equity');
    assert.equal(tg.enviados.length, 5);
  });

  await t.test('vigía en seco: dice qué mandaría y no manda ni marca nada', async () => {
    psql('delete from alertas_enviadas;');
    const tg = telegramFalso();
    const r = await jobVigia({ seco: true, ahora: new Date('2026-11-26T01:00:00Z'), deps: {
      sql, env: ENV, fetchImpl: tg.fetch,
      leerSaldo: async () => ({ usd: 3, fuente: 'credits' }), latidos: async () => [], mapa: async () => ({ mapa: 'us', ultimo_cierre: '2026-11-25', cuadros: [] }),
    } });
    assert.equal(r.alertas.length, 1);
    assert.equal(r.alertas[0].motivo, 'seco');
    assert.equal(tg.enviados.length, 0);
    assert.equal(cuenta(), 0);
  });

  await t.test('resumen: uno por día de Monterrey, aunque el cron dispare dos veces', async () => {
    const tg = telegramFalso();
    const deps = { sql, env: ENV, fetchImpl: tg.fetch, liga: async () => LIGA, cobertura: async () => COB };
    const a = await jobResumen({ ahora: new Date('2026-11-26T02:00:00Z'), deps });
    const b = await jobResumen({ ahora: new Date('2026-11-26T02:03:00Z'), deps });
    const c = await jobResumen({ ahora: new Date('2026-11-27T02:00:00Z'), deps });
    assert.deepEqual([a.alerta.enviada, b.alerta.motivo, c.alerta.enviada], [true, 'repetida', true]);
    assert.equal(tg.enviados.length, 2);
    assert.match(tg.enviados[0].text, /LA LIGA/);
    assert.match(tg.enviados[0].text, /FORM 4/);
  });

  await t.test('en ninguna URL ni fila quedó nada que no deba', () => {
    const filas = psql('select coalesce(string_agg(coalesce(texto, \'\') || coalesce(ultimo_error, \'\'), \' \'), \'\') from alertas_enviadas;');
    assert.ok(!filas.includes('AAFake'), 'el token quedó escrito en la tabla');
  });
});
