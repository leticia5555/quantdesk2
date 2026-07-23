// ═══════════════════════════════════════════════════════════════
// tests/ai-cache.test.mjs — caché de respuesta (opt-in) + journaling
// del burn en guardedClaudeCall (diagnóstico de consumo, jul 2026).
//
//   node tests/ai-cache.test.mjs
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedClaudeCall, _resetRespCache } from '../api/_lib/ai-guard.js';
import { _resetUsage } from '../api/_lib/usage.js';

const NOW = new Date('2026-07-16T15:00:00Z');

// Sin DATABASE_URL el journal es no-op: los tests no tocan la DB.
delete process.env.DATABASE_URL;

function fakeAnthropicFetch(replies) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply.httpError) return { ok: false, status: reply.status || 500, json: async () => ({ error: { message: 'boom' } }) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: reply.text }], usage: reply.usage }) };
  };
  return { impl, calls };
}
const basePayload = { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'analyze AAPL' }] };

test('cache:true → segunda request idéntica NO vuelve a llamar a Anthropic', async () => {
  _resetRespCache(); _resetUsage();
  const { impl, calls } = fakeAnthropicFetch([{ text: 'Anchored to July 2026, all good.', usage: { input_tokens: 50, output_tokens: 20 } }]);
  const a = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  const b = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 1);           // solo la primera pegó a la API
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.cached, true);            // la segunda vino del caché
  assert.equal(a.cached, undefined);       // la primera no
  assert.deepEqual(b.data, a.data);        // mismo contenido
});

test('sin cache (default) → cada request pega a la API (conducta previa intacta)', async () => {
  _resetRespCache(); _resetUsage();
  const { impl, calls } = fakeAnthropicFetch([{ text: 'Anchored to July 2026.' }]);
  await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 2);
});

test('payloads distintos → claves de caché distintas, no se pisan', async () => {
  _resetRespCache(); _resetUsage();
  const { impl, calls } = fakeAnthropicFetch([{ text: 'Anchored to July 2026.' }]);
  await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  const other = { ...basePayload, messages: [{ role: 'user', content: 'analyze MSFT' }] };
  await guardedClaudeCall({ apiKey: 'k', payload: other, cache: true, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 2);           // ticker distinto = miss = 2 llamadas
});

test('la clave rota por día: mañana es un miss', async () => {
  _resetRespCache(); _resetUsage();
  const { impl, calls } = fakeAnthropicFetch([{ text: 'Anchored, fine.' }]);
  await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  const tomorrow = new Date('2026-07-17T15:00:00Z');
  await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: tomorrow, fetchImpl: impl });
  assert.equal(calls.length, 2);
});

test('respuesta stale (502) NO se cachea: se reintenta en la próxima', async () => {
  _resetRespCache(); _resetUsage();
  // Reincide en fechas rotas tras el retry → stale:true, status 502.
  const { impl, calls } = fakeAnthropicFetch([
    { text: 'This 2025 scenario will play out.' },
    { text: 'Indeed, we expect fireworks in Q1 2024.' },
    { text: 'This 2025 scenario will play out.' },
    { text: 'Indeed, we expect fireworks in Q1 2024.' },
  ]);
  const a = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  assert.equal(a.stale, true);
  assert.equal(a.status, 502);
  const b = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, cache: true, now: NOW, fetchImpl: impl });
  assert.equal(b.stale, true);
  assert.equal(calls.length, 4);           // 2 + 2: la stale no se sirvió de caché
});
