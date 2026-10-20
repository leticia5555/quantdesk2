// ═══════════════════════════════════════════════════════════════════
// tests/arena-herramienta-falla.test.mjs — null NO es 0 filas.
//
// EL CASO (2026-10-20). Grok: screener()→null, ficha(MU)→null,
// ficha(WDC)→null, ficha(STX)→null. Un resultado sin conteo es la herramienta
// fallando, no un filtro que dejó cero nombres. Tres lugares tenían que
// decirlo y ninguno lo decía:
//
//   1. EL AGENTE: tiene que recibir "la herramienta falló" con palabras, no
//      nada. Un runner que devuelve null o un objeto sin `text`/`rows` se
//      convierte en falla explícita (`error`, `sin_resultado`).
//   2. LA PROYECCIÓN PÚBLICA: el `error` del ejecutor se quedaba en el
//      journal y /api/liga/libros lo publicaba como "0 filas". Ahora el paso
//      sale con `falló: true` y `resultado: 'falló'`.
//   3. AVISOS: una línea por agente con cuántas fallaron y cuáles.
//
// Y la otra mitad, que es la que evita el falso positivo: un 0 legítimo (un
// filtro que vació el embudo) NO es falla, y un rechazo por cupo tampoco.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolExecutor, RUNNERS } from '../api/_lib/arena-tools.js';
import { secuenciaPublicable, avisosDeHerramientas, libroDeFila, FUENTE_VIVA } from '../api/liga-libros.js';

async function conRunner(nombre, fn, cuerpo) {
  const orig = RUNNERS[nombre];
  RUNNERS[nombre] = fn;
  try { return await cuerpo(); } finally { RUNNERS[nombre] = orig; }
}

for (const [caso, devuelve] of [
  ['null', null],
  ['sin rows', { text: 'algo' }],
  ['sin text', { rows: 3 }],
  ['rows null', { text: 'algo', rows: null }],
]) {
  test(`el agente recibe "falló" con palabras cuando el runner devuelve ${caso}`, async () => {
    await conRunner('ficha', async () => devuelve, async () => {
      const ex = createToolExecutor({ budget: 4, cache: false });
      const out = await ex.call('ficha', { ticker: 'MU' });
      assert.match(out.text, /La herramienta falló/);
      assert.match(out.text, /no significa que no haya/);
      assert.equal(out.rows, 0);
      const s = ex.summary()[0];
      assert.equal(s.error, true);
      assert.equal(s.sin_resultado, true);
      assert.equal(s.rows, 0);
    });
  });
}

test('un resultado válido pasa intacto (el arreglo no toca lo que funciona)', async () => {
  await conRunner('ficha', async () => ({ text: 'FICHA MU\nprecio 100', rows: 1 }), async () => {
    const ex = createToolExecutor({ budget: 4, cache: false });
    const out = await ex.call('ficha', { ticker: 'MU' });
    assert.equal(out.text, 'FICHA MU\nprecio 100');
    assert.equal(ex.summary()[0].error, undefined);
  });
});

test('la proyección pública dice "falló", y distingue falla de cero y de cupo', () => {
  const s = secuenciaPublicable({ tools: { budget: 8, used: 5, summary: [
    { n: 1, tool: 'screener', args: {}, rows: null },
    { n: 2, tool: 'ficha', args: { ticker: 'MU' }, rows: 0, error: true, sin_resultado: true },
    { n: 3, tool: 'screener', args: { rvol_top: true }, rows: 0 },
    { n: 4, tool: 'noticias', args: { ticker: 'NVDA' }, rows: 5 },
    { intento: 5, tool: 'ficha', args: { ticker: 'X' }, refused: 'budget_exhausted' },
  ] } });
  const [a, b, c, d, e] = s.pasos;
  assert.equal(a.falló, true); assert.equal(a.resultado, 'falló'); assert.equal(a.etiqueta, 'screener()');
  assert.equal(b.falló, true); assert.equal(b.etiqueta, 'ficha MU');
  assert.equal(c.falló, undefined, 'un 0 legítimo no es falla'); assert.equal(c.resultado, '0 nombres');
  assert.equal(d.resultado, '5 titulares');
  assert.equal(e.falló, undefined, 'un rechazo por cupo no es falla de la herramienta'); assert.equal(e.resultado, 'sin cupo');
});

test('avisos: una línea por agente con cuántas fallaron, en cuántas corridas y cuáles', () => {
  const fila = (agent_id, summary) => ({
    run_date: '2026-10-20', created_at: '2026-10-20T15:40:00Z', agent_id, status: 'ok_target', plan: 'x',
    context: { tools: { budget: 8, used: summary.length, summary } },
  });
  const libros = [
    fila('grok', [{ n: 1, tool: 'screener', args: {}, rows: null }, { n: 2, tool: 'ficha', args: { ticker: 'MU' }, rows: null }]),
    fila('grok', [{ n: 1, tool: 'ficha', args: { ticker: 'WDC' }, rows: 0, error: true }]),
    fila('deepseek', [{ n: 1, tool: 'screener', args: { rvol_top: true }, rows: 0 }]),
  ].map((r) => libroDeFila(r, FUENTE_VIVA));
  const av = avisosDeHerramientas(libros);
  assert.equal(av.length, 1, 'deepseek no: su 0 es legítimo');
  assert.match(av[0], /^Grok: 3 llamadas a herramientas fallaron en 2 corridas \(screener\(\), ficha MU, ficha WDC\)/);
});
