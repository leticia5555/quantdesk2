// ═══════════════════════════════════════════════════════════════════
// tests/arena-compuertas-techo.test.mjs — ¿llegó el techo de salida?
//
// Con ARENA_ENABLED la variable no llegó a las funciones hasta un redeploy
// sin caché, y se perdieron 18 días midiendo con el valor viejo. Antes de la
// puerta, `?compuertas=1` tiene que mostrar el ARENA_MAX_TOKENS que de verdad
// corre — el CRUDO y el EFECTIVO, porque un valor inválido cae en silencio al
// default y el crudo solo mentiría "llegó".
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { estadoDeCompuertas, techoDeSalida, ARENA_MAX_TOKENS_DEFAULT } from '../api/_lib/arena-registry.js';

test('publica el valor crudo, igual que ARENA_ENABLED', () => {
  assert.equal(estadoDeCompuertas({ ARENA_MAX_TOKENS: '9000' }).ARENA_MAX_TOKENS, '9000');
  assert.equal(estadoDeCompuertas({}).ARENA_MAX_TOKENS, null, 'no existe ≠ "6000"');
});

test('y el efectivo, que es el que corre', () => {
  assert.equal(estadoDeCompuertas({ ARENA_MAX_TOKENS: '9000' }).techo_de_salida.efectivo, 9000);
  assert.equal(estadoDeCompuertas({}).techo_de_salida.efectivo, ARENA_MAX_TOKENS_DEFAULT);
});

test('un valor inválido se DICE: llegó, pero se ignora', () => {
  for (const malo of ['9k', '100', '99999', '']) {
    const t = estadoDeCompuertas({ ARENA_MAX_TOKENS: malo }).techo_de_salida;
    assert.equal(t.efectivo, 6000, malo);
    assert.match(t.aviso, /se IGNORA y corre el default \(6000\)/, malo);
  }
  assert.equal(estadoDeCompuertas({ ARENA_MAX_TOKENS: '6000' }).techo_de_salida.aviso, undefined, '6000 explícito no es un error');
});

test('una sola regla: el techo y la compuerta parsean igual', () => {
  const src = readFileSync(new URL('../api/_lib/arena-registry.js', import.meta.url), 'utf8');
  assert.match(src, /export const ARENA_MAX_TOKENS = techoDeSalida\(process\.env\.ARENA_MAX_TOKENS\);/);
  assert.equal(techoDeSalida('12000.7'), 12000);
});
