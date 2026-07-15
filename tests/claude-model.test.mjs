// ═══════════════════════════════════════════════════════════════
// Modelo de IA centralizado (api/_lib/model.js + api/claude.js).
//
// El retiro de claude-sonnet-4-20250514 tumbó toda la IA porque el ID
// vivía en 26 sitios. Estos tests garantizan que: el server decide el
// modelo (ignora body.model de clientes stale), la env var manda, los 6
// agentes comparten la config, y ni el frontend ni el api re-hardcodean
// un modelo.
//
// Correr con `node tests/claude-model.test.mjs` — fetch mockeado, sin red.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import handler from '../api/claude.js';
import { ANTHROPIC_MODEL } from '../api/_lib/model.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}
const realFetch = global.fetch;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('config: default y forma del ID');
{
  ok(ANTHROPIC_MODEL === (process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'),
    'default claude-haiku-4-5 salvo env ANTHROPIC_MODEL', ANTHROPIC_MODEL);
  ok(!/20250514/.test(ANTHROPIC_MODEL), 'no es el modelo retirado');
}

console.log('api/claude.js: el server decide el modelo');
{
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { status: 200, json: async () => ({ content: [{ type: 'text', text: 'pong' }] }) };
  };

  // cliente stale que todavía manda el modelo retirado → se ignora
  const res = mockRes();
  await handler({ method: 'POST', body: {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'ping' }],
  } }, res);
  ok(sent.model === ANTHROPIC_MODEL, 'body.model de cliente stale se ignora', sent.model);
  ok(res.code === 200 && Array.isArray(res.body.content), 'passthrough del content en éxito');

  // cliente nuevo sin model → mismo modelo central
  sent = null;
  await handler({ method: 'POST', body: {
    max_tokens: 50, messages: [{ role: 'user', content: 'ping' }],
  } }, mockRes());
  ok(sent.model === ANTHROPIC_MODEL, 'sin body.model usa el central', sent.model);
}

console.log('los 6 agentes importan la config compartida');
{
  const agents = ['event-agent', 'filings-agent', 'fundamental-agent', 'macro-agent', 'risk-agent', 'sentiment-agent'];
  for (const a of agents) {
    const src = readFileSync(join(ROOT, 'api', a + '.js'), 'utf8');
    ok(/import \{ ANTHROPIC_MODEL \} from '\.\/_lib\/model\.js'/.test(src) && !/claude-sonnet-4-20250514/.test(src),
      a + ' usa _lib/model.js');
  }
}

console.log('blindaje: nadie re-hardcodea un modelo');
{
  const appHtml = readFileSync(join(ROOT, 'app.html'), 'utf8');
  ok(!/model\s*:\s*'claude-/.test(appHtml), 'app.html no manda model en ninguna llamada');
  const offenders = [];
  (function walk(d) {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.js') && !p.endsWith(join('_lib', 'model.js'))) {
        if (/claude-(sonnet|opus|haiku|fable|mythos|3)[-a-z0-9.]*/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    }
  })(join(ROOT, 'api'));
  ok(offenders.length === 0, 'ningún api/*.js hardcodea un ID de modelo fuera de _lib/model.js', offenders.join(','));
}

global.fetch = realFetch;
console.log(failures ? `\n${failures} FAIL` : '\nOK — modelo centralizado verificado');
process.exit(failures ? 1 : 0);
