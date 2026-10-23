// ═══════════════════════════════════════════════════════════════════
// tests/arena-anthropic-ms.test.mjs — Anthropic que contesta en 20 s deja su
// duración en `vueltas_medidas[].ms` y en `lectura_cierre.ms`, igual que
// OpenRouter.
//
// Hasta el 2026-10-23 `guardedAnthropicCall` no devolvía `ms` en el camino
// bueno: claude y control salían con `ms: null` en cada vuelta. Sin eso no se
// puede decidir el techo de la vuelta: no se sabe cuánto tardan las que sí
// contestan.
//
// Camino real: runShadowAgent → runToolLoop → callArenaLLM →
// guardedAnthropicCall → anthropicFetch. Lo falso es la red y el paso del
// tiempo: la respuesta "tarda" 20 s avanzando `Date.now` (el reloj con el que
// anthropicFetch mide y el loop reparte), sin esperar 20 s de verdad. El techo
// es el de producción, más alto que 20 s: la señal no corta.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.ARENA_ALLOW_UNVERIFIED_SLUGS = '1';
delete process.env.ARENA_LLM_TIMEOUT_MS;
for (const a of ['PAPER', 'CONTROL']) { process.env['ALPACA_' + a + '_KEY'] = 'k'; process.env['ALPACA_' + a + '_SECRET'] = 's'; }

const real = Date.now;
let adelanto = 0;
Date.now = () => real() + adelanto;

const TARDA_MS = 20000;
const RESPUESTA = {
  id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ plan: 'Me quedo en caja hasta tener una tesis.', pesos: {}, cash: 100 }) }],
  usage: { input_tokens: 3000, output_tokens: 400 },
};
let techoVisto = null;
const json = (b, s = 200) => ({
  ok: s < 400, status: s,
  headers: { get: (h) => (/content-type/i.test(h) ? 'application/json' : null), entries: () => [][Symbol.iterator]() },
  json: async () => b, text: async () => JSON.stringify(b),
});
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/')) {
    techoVisto = opts.signal;
    adelanto += TARDA_MS;
    return json(RESPUESTA);
  }
  if (u.includes('/v2/account')) return json({ equity: '100000', cash: '100000', last_equity: '100000', status: 'ACTIVE' });
  if (u.includes('/v2/positions') || u.includes('/v2/orders')) return json([]);
  if (u.includes('neon.tech')) return json({ fields: [], rows: [] });
  return json({});
};

const { runShadowAgent } = await import('../api/arena-shadow.js');
const { agentById, ARENA_LLM_TIMEOUT_MS } = await import('../api/_lib/arena-registry.js');
const { puertaDeCorrida } = await import('../api/liga-libros.js');

test('el techo de producción es mayor que 20 s (si no, este caso sería un corte)', () => {
  assert.ok(ARENA_LLM_TIMEOUT_MS > TARDA_MS, String(ARENA_LLM_TIMEOUT_MS));
});

for (const id of ['claude', 'control']) {
  test(`${id}: Anthropic contesta en 20 s → la duración queda registrada`, async () => {
    const filas = [];
    const r = await runShadowAgent({ agent: agentById(id), buffet: {}, now: new Date('2026-10-22T19:00:00Z'), journalInsert: async (row) => filas.push(row) });
    assert.ok(techoVisto && !techoVisto.aborted, 'la señal no cortó');
    assert.ok(!/^aborted/.test(r.status), `no abortó (${r.status}: ${r.error || ''})`);
    const ctx = filas[0].context;
    const v = ctx.tools.vueltas_medidas;
    assert.equal(v.length, 1);
    assert.equal(v[0].status, 200);
    assert.equal(v[0].reloj_nuestro, false);
    assert.ok(v[0].ms >= TARDA_MS && v[0].ms < TARDA_MS + 2000, `vueltas_medidas[0].ms = ${v[0].ms}`);
    assert.ok(ctx.lectura_cierre.ms >= TARDA_MS && ctx.lectura_cierre.ms < TARDA_MS + 2000, `lectura_cierre.ms = ${ctx.lectura_cierre.ms}`);
    assert.equal(ctx.lectura_cierre.tokens_por_s, +(400 / (ctx.lectura_cierre.ms / 1000)).toFixed(1));
    // Y la puerta ya puede leer la lectura máxima: antes salía null ("no medido").
    assert.equal(puertaDeCorrida(ctx.tools, ctx).lectura_max_ms, v[0].ms);
  });
}

test.after(() => { Date.now = real; });
