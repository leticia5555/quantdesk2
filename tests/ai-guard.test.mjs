// ═══════════════════════════════════════════════════════════════
// tests/ai-guard.test.mjs — anclaje temporal de la IA (bug jul 2026:
// insights hablando de "this 2025 scenario" como futuro).
//
//   node tests/ai-guard.test.mjs
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { dateDirective, staleProspectiveDates, guardedClaudeCall } from '../api/_lib/ai-guard.js';

const NOW = new Date('2026-07-16T15:00:00Z');

// ── dateDirective ────────────────────────────────────────────────
test('dateDirective trae la fecha de HOY y la instrucción anti-pasado', () => {
  const d = dateDirective(NOW);
  assert.match(d, /2026-07-16/);
  assert.match(d, /July 16, 2026/);
  assert.match(d, /before 2026 are the PAST/);
  assert.match(d, /say so explicitly instead of inventing/);
});

// ── staleProspectiveDates ────────────────────────────────────────
test('guard atrapa años pasados en frases prospectivas', () => {
  // los dos ejemplos reales del bug reportado
  assert.ok(staleProspectiveDates('Positioning for this 2025 scenario requires patience.', NOW).length);
  assert.ok(staleProspectiveDates('The company will report earnings in Q1 2024.', NOW).length);
  // variantes comunes
  assert.ok(staleProspectiveDates('We expect a margin rebound into 2025.', NOW).length);
  assert.ok(staleProspectiveDates('Upcoming catalysts in H2 2024 include the Fed pivot.', NOW).length);
  assert.ok(staleProspectiveDates('El mercado proyecta recortes hacia 2025.', NOW).length);
});

test('guard NO marca menciones históricas legítimas ni años vigentes', () => {
  assert.equal(staleProspectiveDates('In Q1 2024, revenue grew 12% and margins held.', NOW).length, 0);
  assert.equal(staleProspectiveDates('Since its 2023 lows, the stock tripled.', NOW).length, 0);
  assert.equal(staleProspectiveDates('We expect strength into 2027 as rates fall.', NOW).length, 0);
  assert.equal(staleProspectiveDates('Watch the July 2026 CPI print this week.', NOW).length, 0);
  assert.equal(staleProspectiveDates('', NOW).length, 0);
  assert.equal(staleProspectiveDates(null, NOW).length, 0);
});

// ── guardedClaudeCall con fetch mockeado ─────────────────────────
function fakeAnthropicFetch(replies) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply.httpError) return { ok: false, status: reply.status || 500, json: async () => ({ error: { message: 'boom' } }) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: reply.text }] }) };
  };
  return { impl, calls };
}
const basePayload = { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'analyze' }] };

test('inyecta la fecha en el system prompt (aunque no venga system)', async () => {
  const { impl, calls } = fakeAnthropicFetch([{ text: 'All good, anchored to July 2026.' }]);
  const out = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  assert.equal(out.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /2026-07-16/);
});

test('respuesta con fechas rotas → 1 retry con recordatorio → limpia pasa', async () => {
  const { impl, calls } = fakeAnthropicFetch([
    { text: 'Positioning for this 2025 scenario looks attractive.' },
    { text: 'Positioning for the current July 2026 regime looks attractive.' },
  ]);
  const out = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 2);
  assert.equal(out.retried, true);
  assert.equal(out.status, 200);
  const retryMsgs = calls[1].messages;
  assert.equal(retryMsgs.length, 3); // user + assistant previo + reminder
  assert.match(retryMsgs[2].content, /REMINDER: today is 2026-07-16/);
  assert.match(retryMsgs[2].content, /this 2025 scenario/);
});

test('reincidencia tras el retry → stale:true, sin publicar texto', async () => {
  const { impl, calls } = fakeAnthropicFetch([
    { text: 'This 2025 scenario will play out soon.' },
    { text: 'Indeed, we expect fireworks in Q1 2024.' },
  ]);
  const out = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 2);
  assert.equal(out.stale, true);
  assert.equal(out.status, 502);
  assert.equal(out.data, null);
  assert.ok(out.hits.length);
});

test('guard:false inyecta fecha pero no escanea ni reintenta', async () => {
  const { impl, calls } = fakeAnthropicFetch([{ text: 'Headline from Q1 2024: we expect nothing.' }]);
  const out = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, guard: false, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(out.status, 200);
  assert.equal(out.stale, undefined);
  assert.match(calls[0].system, /2026-07-16/);
});

test('error HTTP de la API pasa directo, sin retry del guard', async () => {
  const { impl, calls } = fakeAnthropicFetch([{ httpError: true, status: 429 }]);
  const out = await guardedClaudeCall({ apiKey: 'k', payload: basePayload, now: NOW, fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(out.status, 429);
  assert.ok(out.data.error);
});
