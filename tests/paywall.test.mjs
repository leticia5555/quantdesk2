// ═══════════════════════════════════════════════════════════════
// Unit tests del kill-switch del paywall (fase testing).
// Correr con `node tests/paywall.test.mjs`; sale con código ≠ 0 si falla.
//
// Cubre:
//  - paywallEnabled(): solo el literal 'true' activa el paywall.
//  - /api/paywall: refleja el flag como { enabled }.
// ═══════════════════════════════════════════════════════════════

import { paywallEnabled } from '../api/_lib/paywall.js';
import paywallHandler from '../api/paywall.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// res mínimo estilo Vercel.
function mockRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

function withEnv(value, fn) {
  const had = 'PAYWALL_ENABLED' in process.env;
  const prev = process.env.PAYWALL_ENABLED;
  if (value === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = value;
  try { return fn(); }
  finally {
    if (had) process.env.PAYWALL_ENABLED = prev;
    else delete process.env.PAYWALL_ENABLED;
  }
}

// ─────────────────── paywallEnabled ───────────────────
console.log('paywallEnabled(): default apagado, solo "true" activa');
{
  withEnv(undefined, () => ok(paywallEnabled() === false, 'ausente → off (todos Pro)'));
  withEnv('true',    () => ok(paywallEnabled() === true,  '"true" → paywall activo'));
  withEnv('false',   () => ok(paywallEnabled() === false, '"false" → off'));
  withEnv('TRUE',    () => ok(paywallEnabled() === false, '"TRUE" (mayúsculas) → off (solo literal "true")'));
  withEnv('1',       () => ok(paywallEnabled() === false, '"1" → off'));
  withEnv('',        () => ok(paywallEnabled() === false, 'vacío → off'));
}

// ─────────────────── /api/paywall ───────────────────
console.log('/api/paywall: expone el flag como { enabled }');
{
  withEnv(undefined, () => {
    const res = mockRes();
    paywallHandler({ method: 'GET', headers: {} }, res);
    ok(res.code === 200 && res.body.enabled === false, 'sin env → { enabled: false }', JSON.stringify(res.body));
    ok(res.headers['Cache-Control'] === 'no-store', 'no-store: el flag cambia al instante');
  });
  withEnv('true', () => {
    const res = mockRes();
    paywallHandler({ method: 'GET', headers: {} }, res);
    ok(res.code === 200 && res.body.enabled === true, 'PAYWALL_ENABLED=true → { enabled: true }', JSON.stringify(res.body));
  });
  withEnv('true', () => {
    const res = mockRes();
    paywallHandler({ method: 'OPTIONS', headers: {} }, res);
    ok(res.code === 200, 'OPTIONS (CORS preflight) → 200');
  });
}

if (failures) { console.error(`\n${failures} FALLO(S)`); process.exit(1); }
console.log('\nTODOS LOS TESTS PASAN');
