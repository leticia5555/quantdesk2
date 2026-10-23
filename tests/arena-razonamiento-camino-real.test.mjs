// ═══════════════════════════════════════════════════════════════════
// tests/arena-razonamiento-camino-real.test.mjs — el medidor corre por el
// MISMO camino que mide.
//
// EL CASO (2026-10-20): con ARENA_REASONING_MAX_TOKENS_QWEN=4000, la sonda de
// arena-smoke dio "respetado: true" (1115 de 4000) y los cierres reales de
// arena-shadow razonaron 6000 de 4000. La prueba anterior "el parámetro llega
// al cuerpo" revisaba la cadena de llamadas con regex sobre el fuente: nunca
// EJECUTÓ el cierre. Y la sonda tampoco probaba nada: un prompt chico nunca
// se acerca al presupuesto, así que "1115 ≤ 4000" pasa igual si el proveedor
// lo respeta que si lo ignora.
//
// LO QUE SE BLINDA:
//   1. EL CUERPO DEL CIERRE REAL: se corre runToolLoop hasta su turno de
//      cierre (tool_choice: none) con callArenaLLM de verdad y fetch
//      interceptado, y se lee el cuerpo literal. No el de una llamada paralela.
//   2. La sonda tiene tres estados y "no se puso a prueba" no es "respetado".
//   3. view=cierres —el camino real— marca el cierre que pasó su presupuesto
//      y por qué proveedor; ésa es la medida de la puerta.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { agentById } from '../api/_lib/arena-registry.js';
import { respetoDelPresupuesto } from '../api/_lib/arena-model.js';
import { runToolLoop } from '../api/_lib/arena-tool-loop.js';
import { createToolExecutor } from '../api/_lib/arena-tools.js';
import { resumenDeCierres } from '../api/_lib/arena-audit.js';

test('el cierre REAL del loop (tool_choice none) lleva reasoning.max_tokens — ejecutado, no leído', async () => {
  const env = { ARENA_REASONING_MAX_TOKENS_QWEN: '4000', OPENROUTER_API_KEY: 'x', ARENA_MODEL_QWEN: 'qwen/qwen3.8-2.4t-a95b' };
  const antes = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const fetchReal = globalThis.fetch;
  const cuerpos = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    cuerpos.push(b);
    // Pide herramientas hasta que se le prohíben: así el loop TIENE que ir al cierre.
    const msg = b.tool_choice !== 'none'
      ? { role: 'assistant', content: '', tool_calls: [{ id: 't' + cuerpos.length, type: 'function', function: { name: 'screener', arguments: '{}' } }] }
      : { role: 'assistant', content: '{"plan":"x","pesos":{}}' };
    return new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: b.tool_choice !== 'none' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const executor = createToolExecutor({ budget: 2, cache: false, board: { gainers: [{ symbol: 'A', price: 1, change_pct: 1 }], losers: [] } });
    const loop = await runToolLoop({ agent: agentById('qwen'), system: ['s'], messages: [{ role: 'user', content: 'u' }], executor, maxTokens: 6000, now: new Date(), budgetMs: 200000, timeoutMs: 90000 });
    const cierre = cuerpos.find((b) => b.tool_choice === 'none');
    assert.ok(cierre, `el loop llegó a su cierre (stopped_by=${loop.stopped_by})`);
    assert.deepEqual(cierre.reasoning, { max_tokens: 4000 }, 'el cuerpo literal del cierre');
    assert.equal(cierre.max_tokens, 6000);
    for (const b of cuerpos) assert.deepEqual(b.reasoning, { max_tokens: 4000 }, 'y cada vuelta del loop');
  } finally {
    globalThis.fetch = fetchReal;
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('la sonda: "no se puso a prueba" NO es "respetado"', () => {
  assert.equal(respetoDelPresupuesto(4000, 1115), null, 'la sonda del 20-oct: lejos del techo, no prueba nada');
  assert.equal(respetoDelPresupuesto(4000, 6000), false, 'el cierre del 20-oct: lo ignora');
  assert.equal(respetoDelPresupuesto(4000, 3800), true, 'bajo carga y debajo: respetado');
  assert.equal(respetoDelPresupuesto(null, 6000), null, 'sin presupuesto no hay veredicto');
});

test('view=cierres mide el camino real: el cierre que pasó su presupuesto, y por qué proveedor', () => {
  const fila = (reasoning, proveedor) => ({
    agent_id: 'qwen', fuente: 'prueba', created_at: '2026-10-20T14:08:00Z', status: 'aborted_malformed_target',
    context: { lectura_cierre: { max_tokens: 6000, output_tokens: 6000, reasoning_tokens: reasoning, truncado: true, presupuesto_razonamiento: 4000, proveedor } },
  });
  const r = resumenDeCierres([fila(6000, 'Alibaba'), fila(6000, 'Alibaba'), fila(3500, 'Novita')], { techoActual: 6000, reservaMs: 70000 });
  assert.equal(r.cierres[0].razonamiento_excedido, true);
  assert.equal(r.cierres[2].razonamiento_excedido, false);
  const q = r.agentes.find((a) => a.agente === 'qwen').presupuesto_razonamiento;
  assert.equal(q.excedidos, 2);
  assert.deepEqual(q.por_proveedor, { Alibaba: { cierres: 2, excedidos: 2 }, Novita: { cierres: 1, excedidos: 0 } }, 'por proveedor: el que lo ignora y el que no');
  assert.match(r.razonamiento, /PRESUPUESTO DE RAZONAMIENTO IGNORADO en el camino real: qwen 2\/3 \(Alibaba 2\/2, Novita 0\/1\)/);
});

test('cableado: la fila del cierre journalea el presupuesto pedido y el proveedor que atendió', () => {
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  assert.match(shadow, /corte\.presupuesto_razonamiento = presupuestoRazonamiento\(agent\.id, \{ techo: ARENA_MAX_TOKENS \}\)\.efectivo;/);
  assert.match(shadow, /corte\.proveedor = llm\.proveedor \|\| null;/);
});
