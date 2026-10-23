// ═══════════════════════════════════════════════════════════════════
// tests/arena-cuenta-402.test.mjs — el 402 de OpenRouter es la CUENTA.
//
// EL CASO (2026-10-21, 18:15 UTC). OpenRouter respondió 402 (sin créditos).
// Lo que se blinda:
//   1. CADA agente que recibe el 402 deja SU fila en el journal, con
//      `causa: 'cuenta'` y el mensaje del proveedor legible (no "cuerpo
//      no-JSON" sobre un cuerpo que sí era JSON).
//   2. /liga lo cuenta como aborto NO del modelo (columna de saldo/cuenta).
//   3. El saldo se lee de OpenRouter, con su fallback, y se publica en /liga
//      y en /api/arena-audit — sin frenar nada.
//
// Camino real: runShadowAgent → runAgenteObjetivo → runToolLoop →
// callArenaLLM → openRouterFetch. Lo único falso es la red, a nivel de
// `fetch`: OpenRouter contesta 402 con el cuerpo que manda de verdad.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.OPENROUTER_API_KEY = 'or-test';
process.env.ARENA_ALLOW_UNVERIFIED_SLUGS = '1';
process.env.ARENA_ADMIN_KEY = 'clave-de-prueba';
const OR = ['openai', 'grok', 'gemini', 'deepseek', 'qwen'];
for (const a of OR) { process.env['ALPACA_' + a.toUpperCase() + '_KEY'] = 'k'; process.env['ALPACA_' + a.toUpperCase() + '_SECRET'] = 's'; }

const CUERPO_402 = { error: { code: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 12000 tokens, but can only afford 0.' } };
let saldoMeta = null;
let orLlamadas = 0;
let saldoResp = {};
const json = (b, s = 200) => ({
  ok: s < 400, status: s,
  headers: { get: (h) => (/content-type/i.test(h) ? 'application/json' : null), entries: () => [][Symbol.iterator]() },
  json: async () => b, text: async () => JSON.stringify(b),
});
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://openrouter.ai/api/v1/chat/completions')) { orLlamadas++; return json(CUERPO_402, 402); }
  if (u.startsWith('https://openrouter.ai/api/v1/credits')) return saldoResp.credits ? saldoResp.credits() : json({}, 404);
  if (u.startsWith('https://openrouter.ai/api/v1/auth/key')) return saldoResp.key ? saldoResp.key() : json({}, 404);
  if (u.includes('/v2/account')) return json({ equity: '100000', cash: '100000', last_equity: '100000', status: 'ACTIVE' });
  if (u.includes('/v2/positions') || u.includes('/v2/orders')) return json([]);
  if (u.includes('neon.tech')) {
    const { query } = JSON.parse(opts.body);
    if (/from arena_watch_meta/.test(query) && saldoMeta) {
      return json({ fields: [{ name: 'value', dataTypeID: 3802 }, { name: 'updated_at', dataTypeID: 1184 }], rows: [[JSON.stringify(saldoMeta), '2026-10-21T18:10:00Z']] });
    }
    return json({ fields: [], rows: [] });
  }
  return json({});
};

const { runShadowAgent } = await import('../api/arena-shadow.js');
const { agentById } = await import('../api/_lib/arena-registry.js');
const { culpaDelAborto, manosPorAgente, esRechazoDeCuenta } = await import('../api/_lib/arena-manos.js');
const { leerSaldoOpenRouter, estadoSaldo, pisoSaldo } = await import('../api/_lib/openrouter-saldo.js');

const AHORA = new Date('2026-10-21T18:15:00Z');

test('402: CADA uno de los cinco de OpenRouter deja su fila, con causa "cuenta"', async () => {
  const filas = [];
  for (const id of OR) {
    const r = await runShadowAgent({ agent: agentById(id), buffet: {}, now: AHORA, journalInsert: async (row) => filas.push(row) });
    assert.equal(r.status, 'aborted_llm_error', id);
  }
  assert.ok(orLlamadas >= OR.length, 'cada agente llamó a OpenRouter y recibió el 402');
  assert.deepEqual(filas.map((f) => f.agent_id), OR, 'una fila por agente, ninguno sin huella');
  for (const f of filas) {
    const le = f.context.llm_error;
    assert.equal(le.status, 402, f.agent_id);
    assert.equal(le.causa, 'cuenta', f.agent_id + ': causa cuenta');
    assert.match(le.detail, /^OpenRouter HTTP 402: This request requires more credits/, f.agent_id);
    assert.doesNotMatch(le.detail, /no-JSON/, 'el cuerpo era JSON: no se rotula "no-JSON"');
    assert.equal(le.provider_error.code, 402);
    // /liga: un aborto de la cuenta no es del modelo.
    assert.equal(culpaDelAborto(f), 'saldo', f.agent_id + ': culpa de la cuenta');
  }
  const m = manosPorAgente(filas);
  for (const id of OR) {
    const a = m.get(id);
    assert.equal(a.abortadas_saldo, 1, id);
    assert.equal(a.abortadas_modelo, 0, id + ': nada se le carga al modelo');
    assert.equal(a.abortadas_no_suyas, 1, id);
  }
});

test('la cuenta se reconoce por el STATUS, aunque cambie el texto', () => {
  const fila = (le) => ({ agent_id: 'grok', status: 'aborted_llm_error', error: 'HTTP 402', context: { llm_error: le } });
  assert.equal(culpaDelAborto(fila({ status: 402, detail: 'Payment Required' })), 'saldo', '402 con un texto que ninguna firma conoce');
  assert.equal(culpaDelAborto(fila({ status: 500, detail: 'upstream error' })), 'modelo', 'un 500 no es la cuenta');
  assert.equal(culpaDelAborto(fila({ status: 200, causa: 'cuenta' })), 'saldo', 'la causa escrita manda');
  assert.equal(esRechazoDeCuenta({ status: 400, detail: 'x' }, 'This request requires more credits'), true, 'y la firma de texto sigue valiendo');
  assert.equal(esRechazoDeCuenta({ status: 429, detail: 'rate limited' }), false, 'un 429 es cola, no cuenta');
});

test('saldo: /credits primero, /auth/key si no contesta, y nunca lanza', async () => {
  saldoResp = { credits: () => json({ data: { total_credits: 50, total_usage: 43.21 } }) };
  assert.deepEqual(await leerSaldoOpenRouter({ now: AHORA }), { usd: 6.79, fuente: 'credits', at: AHORA.toISOString() });

  saldoResp = { credits: () => json({ error: 'forbidden' }, 403), key: () => json({ data: { limit: 100, usage: 80, limit_remaining: 20 } }) };
  const r2 = await leerSaldoOpenRouter({ now: AHORA });
  assert.equal(r2.usd, 20);
  assert.match(r2.fuente, /auth\/key/);

  saldoResp = { credits: () => json({}, 500), key: () => { throw new Error('ECONNRESET'); } };
  const r3 = await leerSaldoOpenRouter({ now: AHORA });
  assert.equal(r3.usd, null);
  assert.match(r3.error, /credits HTTP 500/);
  assert.match(r3.error, /ECONNRESET/);

  assert.match((await leerSaldoOpenRouter({ apiKey: '', now: AHORA })).error, /sin OPENROUTER_API_KEY/);
});

test('el aviso: bajo el piso es aviso; sin lectura es "no sabemos", no "bajo"', () => {
  assert.equal(pisoSaldo({}), 10);
  assert.equal(pisoSaldo({ ARENA_OPENROUTER_PISO_USD: '25' }), 25);
  assert.equal(pisoSaldo({ ARENA_OPENROUTER_PISO_USD: 'x' }), 10, 'un valor raro no apaga el aviso');
  assert.equal(pisoSaldo({ ARENA_OPENROUTER_PISO_USD: '' }), 10, 'la variable vacía (puesta sin valor en Vercel) no es un piso de 0');
  const bajo = estadoSaldo({ usd: 6.79, fuente: 'credits', at: 't' }, 10);
  assert.equal(bajo.bajo, true);
  assert.match(bajo.aviso, /SALDO DE OPENROUTER BAJO: \$6\.79, por debajo del piso de \$10/);
  const ok = estadoSaldo({ usd: 40, fuente: 'credits', at: 't' }, 10);
  assert.equal(ok.bajo, false);
  assert.equal(ok.aviso, null);
  const nada = estadoSaldo({ usd: null, error: 'credits HTTP 500', at: 't' }, 10);
  assert.equal(nada.bajo, false, 'no leer el saldo NO es saldo bajo');
  assert.match(nada.aviso, /No se pudo leer el saldo de OpenRouter \(credits HTTP 500\)/);
});

const mkRes = () => {
  const r = { headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
};

test('/api/arena-audit?compuertas=1 publica el saldo que leyó el vigilante', async () => {
  saldoMeta = estadoSaldo({ usd: 6.79, fuente: 'credits', at: '2026-10-21T18:10:00Z' }, 10);
  const audit = (await import('../api/arena-audit.js')).default;
  const r = mkRes();
  await audit({ method: 'GET', query: { compuertas: '1' }, headers: { 'x-admin-key': 'clave-de-prueba' } }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.saldo_openrouter.usd, 6.79);
  assert.equal(r.body.saldo_openrouter.bajo, true);
  saldoMeta = null;
});

test('el vigilante lo lee al empezar cada ciclo, lo guarda y nunca frena por él', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/arena-watch.js', import.meta.url), 'utf8');
  const i = src.indexOf('const saldoOpenRouter = estadoSaldo(await leerSaldoOpenRouter({ now }), pisoSaldo());');
  assert.ok(i > src.indexOf('await announceSpendTier(presupuesto, now);') && i < src.indexOf('const fixedRuns = []'),
    'se lee en cada ciclo, antes de despachar rondas y disparadores');
  assert.match(src.slice(i, i + 200), /await markDone\(CLAVE_SALDO, saldoOpenRouter, now\)/);
  assert.doesNotMatch(src, /saldoOpenRouter\.bajo\)?\s*(return|\{\s*return)/, 'ningún return sale por el saldo: nunca frena la liga');
});

test('/api/leaderboard publica el saldo arriba de la tabla (lo lee del vigilante)', async () => {
  for (const a of ['PAPER', 'CONTROL']) { process.env['ALPACA_' + a + '_KEY'] = 'k'; process.env['ALPACA_' + a + '_SECRET'] = 's'; }
  saldoMeta = estadoSaldo({ usd: 6.79, fuente: 'credits', at: '2026-10-21T18:10:00Z' }, 10);
  const lb = (await import('../api/leaderboard.js')).default;
  const r = mkRes();
  await lb({ method: 'GET', query: {}, headers: {} }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.saldo_openrouter.usd, 6.79);
  assert.match(r.body.saldo_openrouter.aviso, /SALDO DE OPENROUTER BAJO/);
  saldoMeta = null;
  const r2 = mkRes();
  await lb({ method: 'GET', query: {}, headers: {} }, r2);
  assert.equal(r2.body.saldo_openrouter, null, 'sin lectura del vigilante, null: no se inventa');
});
