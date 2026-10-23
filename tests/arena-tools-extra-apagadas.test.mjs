// ═══════════════════════════════════════════════════════════════════
// tests/arena-tools-extra-apagadas.test.mjs — sin ARENA_TOOLS_EXTRA, los
// siete ven EXACTAMENTE las cuatro herramientas de siempre.
//
// `eventos` (8-K) e `historia` existen en el código desde este PR, apagadas.
// Lo que se blinda es que existir no cambie el experimento:
//   1. el esquema que viaja a cada proveedor tiene las mismas cuatro, en el
//      mismo orden, y cada una es byte a byte la misma que con las extra
//      encendidas (encender suma, no modifica);
//   2. pedir `eventos` o `historia` apagadas es pedir una herramienta
//      inexistente, y el mensaje lista solo las cuatro — no filtra que existan.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ARENA_TOOLS_EXTRA;
const { toolsForProvider, herramientasActivas, createToolExecutor } = await import('../api/_lib/arena-tools.js');

const CUATRO = ['screener', 'noticias', 'ficha', 'sector'];
const nombre = (p, d) => (p === 'anthropic' ? d.name : d.function.name);

test('apagadas: el esquema de cada proveedor trae las cuatro de siempre', () => {
  assert.deepEqual(herramientasActivas({}), CUATRO);
  for (const p of ['anthropic', 'openrouter']) {
    assert.deepEqual(toolsForProvider(p, null, {}).map((d) => nombre(p, d)), CUATRO, p);
    // Y con la variable del proceso sin definir, igual.
    assert.deepEqual(toolsForProvider(p, null).map((d) => nombre(p, d)), CUATRO, p + ' (process.env)');
  }
});

test('encender suma herramientas, no modifica las cuatro', () => {
  const env = { ARENA_TOOLS_EXTRA: 'eventos,historia' };
  for (const p of ['anthropic', 'openrouter']) {
    const on = toolsForProvider(p, null, env);
    assert.deepEqual(on.map((d) => nombre(p, d)), [...CUATRO, 'eventos', 'historia']);
    assert.deepEqual(on.slice(0, 4), toolsForProvider(p, null, {}), p + ': las cuatro, byte a byte');
  }
  assert.deepEqual(herramientasActivas({ ARENA_TOOLS_EXTRA: ' Eventos , nada ' }), [...CUATRO, 'eventos'], 'un nombre desconocido no entra');
});

test('apagadas: llamarlas es una herramienta inexistente, y el mensaje no las nombra', async () => {
  const ex = createToolExecutor({ cache: false, herramientas: herramientasActivas({}) });
  for (const t of ['eventos', 'historia']) {
    const r = await ex.call(t, { ticker: 'MU' });
    assert.equal(r.unknown_tool, true, t);
    assert.equal(r.text, `No existe una herramienta llamada "${t}". Las disponibles son: ${CUATRO.join(', ')}.`);
  }
});
