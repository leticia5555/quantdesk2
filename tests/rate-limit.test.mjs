// ═══════════════════════════════════════════════════════════════
// tests/rate-limit.test.mjs — tope por IP de los endpoints de IA.
//
//   node tests/rate-limit.test.mjs
// ═══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeToken, clientIp, rateLimit, _resetRateLimit, _bucketCount } from '../api/_lib/rate-limit.js';

const CFG = { disabled: false, capacity: 3, refillMs: 1000 };

test('deja pasar hasta capacity y luego bloquea con Retry-After', () => {
  _resetRateLimit();
  const ip = '1.2.3.4';
  for (let i = 0; i < 3; i++) {
    const r = consumeToken(ip, 0, CFG);
    assert.equal(r.allowed, true, 'token ' + i);
  }
  const blocked = consumeToken(ip, 0, CFG);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterS >= 1);
});

test('repone tokens con el paso del tiempo', () => {
  _resetRateLimit();
  const ip = '5.6.7.8';
  for (let i = 0; i < 3; i++) consumeToken(ip, 0, CFG); // drena
  assert.equal(consumeToken(ip, 500, CFG).allowed, false); // medio refill: nada aún
  assert.equal(consumeToken(ip, 1000, CFG).allowed, true); // 1 token repuesto
  assert.equal(consumeToken(ip, 1000, CFG).allowed, false); // y se agota otra vez
});

test('IPs distintas no comparten bucket', () => {
  _resetRateLimit();
  for (let i = 0; i < 3; i++) consumeToken('10.0.0.1', 0, CFG);
  assert.equal(consumeToken('10.0.0.1', 0, CFG).allowed, false);
  assert.equal(consumeToken('10.0.0.2', 0, CFG).allowed, true); // otra IP, bucket propio
});

test('fail-open: sin IP siempre deja pasar (no tumba tráfico legítimo)', () => {
  _resetRateLimit();
  for (let i = 0; i < 100; i++) assert.equal(consumeToken(null, 0, CFG).allowed, true);
  assert.equal(_bucketCount(), 0); // no crea buckets para IP desconocida
});

test('disabled → siempre deja pasar', () => {
  _resetRateLimit();
  const off = { disabled: true, capacity: 1, refillMs: 1000 };
  for (let i = 0; i < 50; i++) assert.equal(consumeToken('9.9.9.9', 0, off).allowed, true);
});

test('clientIp toma el primero de x-forwarded-for', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'x-real-ip': '198.51.100.5' } }), '198.51.100.5');
  assert.equal(clientIp({ headers: {} }), null);
});

test('rateLimit responde 429 con Retry-After cuando se agota', () => {
  _resetRateLimit();
  // Config real por defecto (capacity 30): agotamos con una IP fija.
  const req = { headers: { 'x-forwarded-for': '44.44.44.44' } };
  function mockRes() {
    return { code: null, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(o) { this.body = o; return this; } };
  }
  let last = true;
  for (let i = 0; i < 200 && last; i++) last = rateLimit(req, mockRes());
  assert.equal(last, false); // en algún punto bloqueó
  const res = mockRes();
  const ok = rateLimit(req, res);
  assert.equal(ok, false);
  assert.equal(res.code, 429);
  assert.equal(res.body.error, 'rate_limited');
  assert.ok(Number(res.headers['Retry-After']) >= 1);
});
