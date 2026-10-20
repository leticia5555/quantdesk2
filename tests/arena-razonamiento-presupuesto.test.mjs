// ═══════════════════════════════════════════════════════════════════
// tests/arena-razonamiento-presupuesto.test.mjs — pensar no se come contestar.
//
// LA PUERTA DEL 20-OCT (view=cierres, qwen, 3 de 3 cortados): el razonamiento
// se comió el techo entero — 6000/6000/5616 de 6000 — y en la primera no
// quedó una ficha para la respuesta. El reintento salió con el MISMO techo y
// el MISMO effort, volvió a pensar 6000 y tampoco entregó: $0.28 por nada.
//
// LO QUE SE BLINDA:
//   1. ARENA_REASONING_MAX_TOKENS_<AGENTE> manda `reasoning.max_tokens` en vez
//      de `effort`, SÓLO para ese agente; sin la variable, nada cambia.
//   2. El presupuesto nunca deja menos de RESPUESTA_MINIMA para contestar.
//   3. El reintento solo-JSON corre con razonamiento mínimo (effort low +
//      presupuesto chico): el rescate no puede tener el techo de la falla.
//   4. Se ve desde afuera: ?compuertas=1 y effectiveParams lo publican.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { presupuestoRazonamiento, RESPUESTA_MINIMA_TOKENS, estadoDeCompuertas, agentById } from '../api/_lib/arena-registry.js';
import { buildOpenRouterBody, effectiveParams, sameParams } from '../api/_lib/arena-model.js';

const conEnv = (vars, fn) => {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) { antes[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const qwen = agentById('qwen');
const deepseek = agentById('deepseek');
const cuerpo = (agent, extra = {}) => buildOpenRouterBody({ agent, system: 's', messages: [], maxTokens: 6000, ...extra });

test('el presupuesto: por agente, acotado, y un valor malo se dice', () => {
  assert.deepEqual(presupuestoRazonamiento('qwen', { env: {}, techo: 6000 }), { crudo: null, efectivo: null });
  assert.equal(presupuestoRazonamiento('qwen', { env: { ARENA_REASONING_MAX_TOKENS_QWEN: '4000' }, techo: 6000 }).efectivo, 4000);
  const largo = presupuestoRazonamiento('qwen', { env: { ARENA_REASONING_MAX_TOKENS_QWEN: '6000' }, techo: 6000 });
  assert.equal(largo.efectivo, 6000 - RESPUESTA_MINIMA_TOKENS, 'siempre queda respuesta');
  assert.match(largo.aviso, /se ACOTA/);
  const malo = presupuestoRazonamiento('qwen', { env: { ARENA_REASONING_MAX_TOKENS_QWEN: '4k' }, techo: 6000 });
  assert.equal(malo.efectivo, null);
  assert.match(malo.aviso, /se IGNORA/);
});

test('con la variable, qwen manda reasoning.max_tokens; deepseek (sin variable) sigue con effort', () => {
  conEnv({ ARENA_REASONING_MAX_TOKENS_QWEN: '4000', ARENA_REASONING_MAX_TOKENS_DEEPSEEK: undefined }, () => {
    assert.deepEqual(cuerpo(qwen).reasoning, { max_tokens: 4000 });
    assert.ok(!('effort' in cuerpo(qwen).reasoning), 'OpenRouter acepta effort O max_tokens, no los dos');
    assert.deepEqual(cuerpo(deepseek).reasoning, { effort: 'medium' });
  });
});

test('sin variables, el cuerpo es el de siempre', () => {
  conEnv({ ARENA_REASONING_MAX_TOKENS_QWEN: undefined }, () => {
    assert.deepEqual(cuerpo(qwen).reasoning, { effort: 'medium' });
  });
});

test('el reintento pide su propio presupuesto, chico, aunque el agente tenga otro', () => {
  conEnv({ ARENA_REASONING_MAX_TOKENS_QWEN: '4000' }, () => {
    assert.deepEqual(cuerpo(qwen, { reasoningMaxTokens: 1024 }).reasoning, { max_tokens: 1024 });
  });
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const i = shadow.indexOf('async function rescatarConSoloJson');
  const llamada = shadow.slice(i, shadow.indexOf('});', shadow.indexOf('callArenaLLM({', i)));
  assert.match(llamada, /effort: 'low',/, 'el reintento corre con effort low');
  assert.match(llamada, /reasoningMaxTokens: REINTENTO_RAZONAMIENTO_TOKENS,/, 'y con presupuesto de razonamiento propio');
});

test('el parámetro llega al cuerpo por los cuatro tramos (callArenaLLM → guarded → fetch → body)', () => {
  const src = readFileSync(new URL('../api/_lib/arena-model.js', import.meta.url), 'utf8');
  assert.match(src, /guardedOpenRouterCall\(\{[^}]*reasoningMaxTokens \}\);/);
  assert.equal((src.match(/openRouterFetch\(\{[^}]*provider, reasoningMaxTokens \}\)/g) || []).length, 2, 'las dos llamadas de la guarda (incluida la de fechas)');
  assert.match(src, /buildOpenRouterBody\(\{[^}]*provider, reasoningMaxTokens \}\);/);
});

test('se ve desde afuera: ?compuertas=1 y los parámetros efectivos de cada fila', () => {
  const pr = estadoDeCompuertas({ ARENA_REASONING_MAX_TOKENS_QWEN: '4000' }).presupuesto_razonamiento;
  assert.deepEqual(pr.qwen, { crudo: '4000', efectivo: 4000 });
  assert.deepEqual(pr.deepseek, { crudo: null, efectivo: null });
  assert.ok(!('claude' in pr), 'sólo los de OpenRouter');
  conEnv({ ARENA_REASONING_MAX_TOKENS_QWEN: '4000' }, () => {
    assert.equal(effectiveParams(qwen, 6000).reasoning_max_tokens, 4000);
    assert.ok(sameParams(agentById('claude'), agentById('control')), 'claude y control siguen idénticos: el control sigue siendo control');
  });
});
