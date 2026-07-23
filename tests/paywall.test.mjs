// ═══════════════════════════════════════════════════════════════
// Unit tests del kill-switch del paywall (env var PAYWALL_ENABLED).
// Correr con `node tests/paywall.test.mjs`; sale ≠ 0 si algo falla.
// ═══════════════════════════════════════════════════════════════

import { paywallEnabled } from '../api/_lib/paywall.js';
import configHandler from '../api/config.js';

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

// Corre fn con PAYWALL_ENABLED = value (o borrada si undefined) y restaura.
function withEnv(value, fn) {
  const prev = process.env.PAYWALL_ENABLED;
  if (value === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.PAYWALL_ENABLED;
    else process.env.PAYWALL_ENABLED = prev;
  }
}

// ── paywallEnabled(): SOLO 'true' (trim/case-insensitive) enciende ──
console.log('paywallEnabled()');
withEnv(undefined, () => ok(paywallEnabled() === false, 'ausente → apagado (default abierto)'));
withEnv('', () => ok(paywallEnabled() === false, "'' → apagado"));
withEnv('false', () => ok(paywallEnabled() === false, "'false' → apagado"));
withEnv('0', () => ok(paywallEnabled() === false, "'0' → apagado"));
withEnv('1', () => ok(paywallEnabled() === false, "'1' → apagado (no es 'true')"));
withEnv('yes', () => ok(paywallEnabled() === false, "'yes' → apagado"));
withEnv('true', () => ok(paywallEnabled() === true, "'true' → encendido"));
withEnv('TRUE', () => ok(paywallEnabled() === true, "'TRUE' → encendido (case-insensitive)"));
withEnv('  true  ', () => ok(paywallEnabled() === true, "'  true  ' → encendido (trim)"));

// ── /api/config expone el flag al frontend ──
console.log('/api/config');
withEnv('true', () => {
  const res = mockRes();
  configHandler({ method: 'GET', query: {} }, res);
  ok(res.code === 200 && res.body && res.body.paywall_enabled === true,
    'paywall_enabled=true cuando la env var es true', JSON.stringify(res.body));
});
withEnv(undefined, () => {
  const res = mockRes();
  configHandler({ method: 'GET', query: {} }, res);
  ok(res.code === 200 && res.body && res.body.paywall_enabled === false,
    'paywall_enabled=false cuando la env var está ausente', JSON.stringify(res.body));
});
(() => {
  const res = mockRes();
  configHandler({ method: 'OPTIONS', query: {} }, res);
  ok(res.code === 200, 'OPTIONS (CORS preflight) responde 200');
})();

console.log(`\n${failures === 0 ? 'OK' : 'FALLÓ'} — paywall kill-switch`);
process.exit(failures ? 1 : 0);
