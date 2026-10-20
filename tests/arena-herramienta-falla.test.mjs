// ═══════════════════════════════════════════════════════════════════
// tests/arena-herramienta-falla.test.mjs — null NO es 0 filas.
//
// EL CASO (2026-10-20). Grok: screener()→null, ficha(MU)→null,
// ficha(WDC)→null, ficha(STX)→null. Leído de arena_shadow_journal, NO eran
// fallas: eran los intentos 21-24, rechazados por presupuesto. Ni corrieron.
// Hay TRES vacíos y cada uno se dice distinto:
//
//   rechazada     → ni corrió (cupo / herramienta inexistente)
//   falló         → corrió y dio error
//   sin resultado → corrió y no devolvió nada usable
//
// Lo de abajo blinda los tres, y sobre todo el ORDEN: el rechazo se resuelve
// antes que cualquier chequeo de "sin conteo", porque un rechazo no tiene
// conteo por construcción. Y además, para lo que SÍ corrió:
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

// La secuencia CRUDA de Grok, tal cual vino de arena_shadow_journal
// (context.tools.sequence de la corrida shadow del 2026-10-20).
const GROK_20OCT = [
  { tool: 'screener', args: { near_52w_high: true, limit: 25 }, intento: 21, refused: 'budget_exhausted' },
  { tool: 'ficha', args: { ticker: 'MU' }, intento: 22, refused: 'budget_exhausted' },
  { tool: 'ficha', args: { ticker: 'WDC' }, intento: 23, refused: 'budget_exhausted' },
  { tool: 'ficha', args: { ticker: 'STX' }, intento: 24, refused: 'budget_exhausted' },
];

test('Grok 20-oct: un rechazo por cupo se publica "rechazada: presupuesto" — nunca "falló" ni "0 filas"', () => {
  for (const fuente of ['sequence', 'summary']) {
    const s = secuenciaPublicable({ tools: { budget: 20, used: 20, [fuente]: GROK_20OCT } });
    for (const [i, p] of s.pasos.entries()) {
      assert.equal(p.resultado, 'rechazada: presupuesto', `${fuente}[${i}]`);
      assert.equal(p.rechazada, 'budget_exhausted');
      assert.equal(p.falló, undefined, `${fuente}[${i}] no es falla`);
      assert.ok(!('filas' in p), `${fuente}[${i}] no corrió: no lleva filas, ni 0 ni null`);
      assert.equal(p.intento, GROK_20OCT[i].intento, 'su número es el del intento');
    }
    assert.deepEqual(s.pasos.map((p) => p.etiqueta), ['screener(near_52w_high, limit=25)', 'ficha MU', 'ficha WDC', 'ficha STX']);
  }
});

test('el ejecutor: con el cupo agotado, el rechazo sale ANTES de la guarda (no se marca como falla)', async () => {
  await conRunner('ficha', async () => ({ text: 'FICHA', rows: 1 }), async () => {
    const ex = createToolExecutor({ budget: 1, cache: false });
    await ex.call('ficha', { ticker: 'AAPL' });
    const out = await ex.call('ficha', { ticker: 'MU' });
    assert.match(out.text, /PRESUPUESTO DE HERRAMIENTAS AGOTADO/);
    const r = ex.summary()[1];
    assert.equal(r.refused, 'budget_exhausted');
    assert.equal(r.error, undefined);
    assert.equal(r.sin_resultado, undefined);
    assert.equal(secuenciaPublicable({ tools: { summary: ex.summary() } }).pasos[1].resultado, 'rechazada: presupuesto');
  });
});

test('los tres vacíos se dicen distinto, y un 0 legítimo no es ninguno', () => {
  const s = secuenciaPublicable({ tools: { budget: 8, used: 5, summary: [
    { n: 1, tool: 'screener', args: {}, rows: null },
    { n: 2, tool: 'ficha', args: { ticker: 'MU' }, rows: 0, error: true, sin_resultado: true },
    { n: 3, tool: 'noticias', args: { ticker: 'X' }, rows: 0, error: true },
    { n: 4, tool: 'screener', args: { rvol_top: true }, rows: 0 },
    { n: 5, tool: 'noticias', args: { ticker: 'NVDA' }, rows: 5 },
    { intento: 6, tool: 'nada', args: {}, refused: 'unknown_tool' },
  ] } });
  const [a, b, c, d, e, f] = s.pasos;
  assert.equal(a.resultado, 'sin resultado'); assert.equal(a.falló, true); assert.equal(a.etiqueta, 'screener()');
  assert.equal(b.resultado, 'sin resultado'); assert.equal(b.falló, true);
  assert.equal(c.resultado, 'falló'); assert.equal(c.falló, true);
  assert.equal(d.falló, undefined, 'un 0 legítimo no es falla'); assert.equal(d.resultado, '0 nombres');
  assert.equal(e.resultado, '5 titulares');
  assert.equal(f.resultado, 'rechazada: herramienta inexistente'); assert.equal(f.falló, undefined);
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
    // Los rechazos de Grok del 20-oct NO son fallas de la herramienta.
    fila('chatgpt', GROK_20OCT),
  ].map((r) => libroDeFila(r, FUENTE_VIVA));
  const av = avisosDeHerramientas(libros);
  assert.equal(av.length, 1, 'deepseek no (su 0 es legítimo) y los rechazos por cupo tampoco');
  assert.match(av[0], /^Grok: 3 llamadas a herramientas fallaron en 2 corridas \(screener\(\), ficha MU, ficha WDC\)/);
});
