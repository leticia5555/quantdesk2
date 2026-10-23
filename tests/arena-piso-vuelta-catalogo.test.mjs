// ═══════════════════════════════════════════════════════════════════
// tests/arena-piso-vuelta-catalogo.test.mjs — el piso de vuelta vigente se
// publica en el catálogo de relojes de /api/arena-smoke, con su origen.
//
// EL CASO (2026-10-23). En la T3, 32 vueltas arrancaron con techo < 30 s
// (qwen 14, deepseek 11, grok 7): 6 salieron, 26 las cortamos. Lety pone
// ARENA_VUELTA_PISO_MS=30000 y necesita VERIFICAR que entró sin esperar un
// aborto: el catálogo dice el piso, de dónde salió y el mínimo para arrancar
// otra vuelta.
//
// Las constantes se leen al importar, así que cada caso corre en su propio
// proceso con su env — igual que una lambda nueva después de cambiar la
// variable en Vercel.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const RAIZ = new URL('..', import.meta.url).pathname;

function enProceso(env, codigo) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
    cwd: RAIZ, encoding: 'utf8',
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db', ARENA_CIERRE_MS: '90000', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const CATALOGO = `
  const { relojesEfectivos } = await import('./api/arena-smoke.js');
  const r = relojesEfectivos();
  console.log(JSON.stringify({ piso: r.piso_vuelta_ms, origen: r.piso_vuelta_origen, minimo: r.minimo_para_otra_vuelta_ms, reserva: r.reserva_cierre_ms, nota: r.nota_piso }));
`;

test('con ARENA_VUELTA_PISO_MS=30000: el catálogo publica 30 s, su origen y el mínimo para otra vuelta', () => {
  const r = enProceso({ ARENA_VUELTA_PISO_MS: '30000' }, CATALOGO);
  assert.equal(r.piso, 30000);
  assert.equal(r.origen, 'env ARENA_VUELTA_PISO_MS=30000');
  assert.equal(r.reserva, 90000);
  assert.equal(r.minimo, 120000, 'reserva de cierre + piso');
  assert.match(r.nota, /quedan 120s \(reserva de cierre 90s \+ piso 30s\)/);
});

test('sin la variable: 10 s, y dice que es el default', () => {
  const r = enProceso({}, CATALOGO);
  assert.equal(r.piso, 10000);
  assert.match(r.origen, /^default del código \(10000 ms\): ARENA_VUELTA_PISO_MS no está puesta/);
  assert.equal(r.minimo, 100000);
});

test('un valor que no es número se IGNORA y se dice, no se publica como si hubiera entrado', () => {
  const r = enProceso({ ARENA_VUELTA_PISO_MS: '30s' }, CATALOGO);
  assert.equal(r.piso, 10000);
  assert.match(r.origen, /IGNORADA/);
  assert.match(r.origen, /"30s"/);
});

// El número publicado es el que USA el loop: con piso 30 s, ninguna vuelta
// arranca con menos de 30 s, y cuando no queda reserva + piso va directo al
// cierre. Camino real de runToolLoop, con el reloj inyectado.
test('el loop usa el piso publicado: ninguna vuelta arranca con techo < 30 s', () => {
  const r = enProceso({ ARENA_VUELTA_PISO_MS: '30000' }, `
    const { runToolLoop } = await import('./api/_lib/arena-tool-loop.js');
    const techos = [];
    let cierre = null;
    const call = async ({ toolChoice, timeoutMs }) => {
      if (toolChoice) { cierre = timeoutMs; return { status: 200, data: { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' } }; }
      techos.push(timeoutMs);
      return { status: 200, data: { content: [{ type: 'tool_use', id: 't' + techos.length, name: 'screener', input: {} }], stop_reason: 'tool_use' } };
    };
    const executor = { used: 0, sequence: [], summary: () => ({}), call: async () => ({ text: 'ok', rows: 1 }), restantes: () => 99, budget: 99 };
    const t = { ahora: 0 };
    // Cada lectura del reloj avanza 7 s: las vueltas se comen el presupuesto
    // de 165 s hasta quedar por debajo de reserva (90 s) + piso (30 s).
    const out = await runToolLoop({
      agent: { id: 'qwen', provider: 'openrouter' }, system: 'S', messages: [{ role: 'user', content: 'U' }],
      executor, call, maxTurns: 20, budgetMs: 165000, clock: () => (t.ahora += 7000),
    });
    console.log(JSON.stringify({ techos, cierre, stopped_by: out.stopped_by }));
  `);
  assert.ok(r.techos.length >= 1, 'hubo vueltas');
  assert.ok(r.techos.every((x) => x >= 30000), `techos: ${r.techos.join(', ')}`);
  assert.ok(r.cierre >= 90000, 'el cierre conserva su reserva');
  assert.notEqual(r.stopped_by, 'error');
});
