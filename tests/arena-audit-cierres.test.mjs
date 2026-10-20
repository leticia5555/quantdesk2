// ═══════════════════════════════════════════════════════════════════
// tests/arena-audit-cierres.test.mjs — ¿a cuánto subir ARENA_MAX_TOKENS?
//
// El escenario de la puerta del 20-oct: 6000 cortó 4 de 21 cierres (Qwen 3/3,
// DeepSeek 1/3). `techo_usado` de un corte es 1.0 por definición, así que no
// dice cuánto falta; la vista usa la salida de los cierres LIMPIOS (piso) y la
// velocidad (techo por reloj). Lo que se blinda es que la recomendación no
// salga de un número que no tiene:
//   · sin velocidad → da el piso y DICE que no sabe si cabe en el reloj;
//   · con velocidad suficiente → recomienda el piso;
//   · con velocidad insuficiente → CONFLICTO, no un número.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resumenDeCierres } from '../api/_lib/arena-audit.js';

const fila = (agent_id, lectura, reintento = null) => ({
  agent_id, fuente: 'prueba', created_at: '2026-10-20T15:40:00Z', status: 'ok_target',
  context: { lectura_cierre: { max_tokens: 6000, ...lectura }, ...(reintento ? { reintento_json: reintento } : {}) },
});
const corte = (reasoning, extra = {}) => ({ output_tokens: 6000, reasoning_tokens: reasoning, techo_usado: 1, truncado: true, truncado_por: 'stop_reason=max_tokens', ...extra });
const limpio = (out, extra = {}) => ({ output_tokens: out, reasoning_tokens: Math.round(out * 0.6), techo_usado: +(out / 6000).toFixed(3), truncado: false, ...extra });

const PUERTA = (vel = {}) => [
  fila('qwen', corte(5400, vel.qwen), { concedido: true, resuelto: true, causa: 'corte' }),
  fila('qwen', corte(5600, vel.qwen), { concedido: true, resuelto: false, causa: 'corte' }),
  fila('qwen', corte(5800, vel.qwen), { concedido: true, resuelto: true, causa: 'corte' }),
  fila('deepseek', corte(5200, vel.deepseek), { concedido: true, resuelto: true, causa: 'corte' }),
  fila('deepseek', limpio(5100, vel.deepseek)),
  fila('deepseek', limpio(4300, vel.deepseek)),
  ...['claude', 'grok', 'openai', 'gemini', 'control'].flatMap((a) => [fila(a, limpio(3200, vel.rapido)), fila(a, limpio(2800, vel.rapido)), fila(a, limpio(3000, vel.rapido))]),
];

test('cuenta los cortes por agente como en la puerta (Qwen 3/3, DeepSeek 1/3)', () => {
  const r = resumenDeCierres(PUERTA(), { techoActual: 6000, reservaMs: 70000 });
  assert.equal(r.cierres.length, 21);
  const q = r.agentes.find((a) => a.agente === 'qwen');
  const d = r.agentes.find((a) => a.agente === 'deepseek');
  assert.equal(q.cortados, 3); assert.equal(q.rescatados_por_reintento, 2);
  assert.equal(q.solo_cota_inferior, true, 'de Qwen sólo sabemos que necesita MÁS de 6000');
  assert.equal(q.salida_max_sin_corte, null);
  assert.deepEqual(q.razonamiento_en_cortes, [5400, 5600, 5800]);
  assert.equal(d.cortados, 1); assert.equal(d.salida_max_sin_corte, 5100);
});

test('sin velocidad journaleada: da el piso y dice que no sabe si cabe en el reloj', () => {
  const r = resumenDeCierres(PUERTA(), { techoActual: 6000, reservaMs: 70000 });
  assert.equal(r.piso, 7000, 'max(5100×1.25 → 7000, 6000+1000)');
  assert.equal(r.techo_por_reloj, null);
  assert.match(r.lectura, /SIN velocidad journaleada/);
});

test('con velocidad que alcanza: recomienda el piso', () => {
  const vel = { qwen: { tokens_por_s: 150 }, deepseek: { tokens_por_s: 120 }, rapido: { tokens_por_s: 200 } };
  const r = resumenDeCierres(PUERTA(vel), { techoActual: 6000, reservaMs: 70000 });
  assert.equal(r.techo_por_reloj, 8000, 'el más lento (120 tok/s) escribe ~8400 en 70s → 8000');
  assert.match(r.lectura, /^Subir a 7000/);
});

test('con velocidad que NO alcanza: CONFLICTO, no un número', () => {
  const vel = { qwen: { tokens_por_s: 60 }, deepseek: { tokens_por_s: 90 }, rapido: { tokens_por_s: 200 } };
  const r = resumenDeCierres(PUERTA(vel), { techoActual: 6000, reservaMs: 70000 });
  assert.equal(r.techo_por_reloj, 4000);
  assert.match(r.lectura, /^CONFLICTO/);
  assert.match(r.lectura, /cambiaría cortes por timeouts/);
});

test('cableado: la sombra journalea ms y tokens/s del cierre, y audit expone la vista', () => {
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  assert.match(shadow, /corte\.ms = llm\.ms;/);
  assert.match(shadow, /corte\.tokens_por_s = /);
  const audit = readFileSync(new URL('../api/arena-audit.js', import.meta.url), 'utf8');
  assert.match(audit, /view === 'cierres'/);
  assert.match(audit, /resumenDeCierres\(rows, \{ techoActual: ARENA_MAX_TOKENS, reservaMs: RESERVA_CIERRE_MS \}\)/);
});

test('las dos reglas del piso, separadas', () => {
  // (a) hubo cortes y la salida limpia más larga es corta: manda techo+1000,
  //     porque los cortados necesitan MÁS que el techo actual.
  const a = resumenDeCierres([fila('qwen', corte(5500)), fila('claude', limpio(3000))], { techoActual: 6000, reservaMs: 70000 });
  assert.equal(a.piso, 7000, `no 4000 (3000×1.25): ${a.piso}`);
  // (b) una salida limpia de 5800 ya roza el techo: manda el margen de 25%.
  const b = resumenDeCierres([fila('qwen', corte(5500)), fila('deepseek', limpio(5800))], { techoActual: 6000, reservaMs: 70000 });
  assert.equal(b.piso, 8000, `5800×1.25 = 7250 → 8000, no 7000: ${b.piso}`);
});
