// ═══════════════════════════════════════════════════════════════════
// tests/arena-anthropic-corte-nuestro.test.mjs — Anthropic que no contesta
// dentro del techo es un corte NUESTRO, no un "HTTP 502" del modelo.
//
// EL CASO (2026-10-22). claude abortó a las 16:46 y 19:16, control a las
// 19:31, con "HTTP 502". El 502 lo ponía `status || 502` sobre el status 0 de
// NUESTRO AbortSignal, vencido antes de que llegaran las cabeceras. Como solo
// el corte leyendo el cuerpo se marcaba `timeout_nuestro`, /liga se lo cargaba
// al modelo y la puerta no lo contaba.
//
// Camino real: runShadowAgent → runAgenteObjetivo → runToolLoop →
// callArenaLLM → guardedAnthropicCall → timedFetch → anthropicFetch. Lo único
// falso es la red: Anthropic acepta la conexión y no contesta nunca. El
// AbortSignal que corta es el de verdad, con el techo real de la vuelta
// (ARENA_LLM_TIMEOUT_MS=5000, el mínimo que acepta el registro: 5 s reales).
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.OPENROUTER_API_KEY = 'or-test';
process.env.ARENA_ALLOW_UNVERIFIED_SLUGS = '1';
process.env.ARENA_LLM_TIMEOUT_MS = '5000';
process.env.ARENA_VUELTA_PISO_MS = '5000';
for (const a of ['PAPER', 'CONTROL', 'GROK']) { process.env['ALPACA_' + a + '_KEY'] = 'k'; process.env['ALPACA_' + a + '_SECRET'] = 's'; }

let anthropicLlamadas = 0;
const json = (b, s = 200) => ({
  ok: s < 400, status: s,
  headers: { get: (h) => (/content-type/i.test(h) ? 'application/json' : null), entries: () => [][Symbol.iterator]() },
  json: async () => b, text: async () => JSON.stringify(b),
});
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/') || u.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
    anthropicLlamadas++;
    // No contesta: la promesa solo se resuelve si NUESTRA señal la corta, como
    // un fetch real que espera cabeceras.
    // El timer de `AbortSignal.timeout` no sostiene el proceso (unref); en
    // producción lo sostiene el socket abierto. Acá lo sostiene `socket`, que
    // NO corta nada: solo vive hasta que la señal dispara.
    return new Promise((_, reject) => {
      const s = opts.signal;
      assert.ok(s, 'anthropicFetch manda su AbortSignal');
      const socket = setTimeout(() => reject(new Error('la señal nunca cortó')), 60000);
      s.addEventListener('abort', () => { clearTimeout(socket); reject(s.reason); }, { once: true });
    });
  }
  if (u.includes('/v2/account')) return json({ equity: '100000', cash: '100000', last_equity: '100000', status: 'ACTIVE' });
  if (u.includes('/v2/positions') || u.includes('/v2/orders')) return json([]);
  if (u.includes('neon.tech')) return json({ fields: [], rows: [] });
  return json({});
};

const { runShadowAgent } = await import('../api/arena-shadow.js');
const { agentById } = await import('../api/_lib/arena-registry.js');
const { culpaDelAborto, esAbortoNuestro, manosPorAgente } = await import('../api/_lib/arena-manos.js');
const { puertaDeCorrida } = await import('../api/liga-libros.js');

const AHORA = new Date('2026-10-22T16:46:00Z');

for (const id of ['claude', 'control']) {
  test(`${id}: Anthropic sin contestar dentro del techo → aborto NUESTRO, rotulado y contado`, async () => {
    const filas = [];
    const antes = anthropicLlamadas;
    const r = await runShadowAgent({ agent: agentById(id), buffet: {}, now: AHORA, journalInsert: async (row) => filas.push(row) });
    assert.equal(r.status, 'aborted_llm_error');
    assert.equal(anthropicLlamadas - antes, 1, 'una sola llamada: la vuelta 1, cortada');
    assert.equal(filas.length, 1);
    const f = filas[0];
    const le = f.context.llm_error;

    // 2. El rótulo: quién cortó, a los cuántos ms, con qué techo y dónde.
    assert.equal(le.status, 0, 'status 0: nadie respondió, no un 502');
    assert.match(f.error, /^corte de NUESTRO reloj a los \d+ ms \(techo 5 s, vuelta 1\)/);
    assert.doesNotMatch(f.error, /HTTP 502|HTTP 0/);
    assert.match(le.detail, /^corte de NUESTRO reloj a los \d+ ms \(techo 5 s, vuelta 1\)\. Origen del techo: reloj del loop, vuelta 1/);
    const ms = Number(le.detail.match(/a los (\d+) ms/)[1]);
    assert.ok(ms >= 4900 && ms < 7000, `cortó cerca del techo, no antes (${ms} ms)`);
    assert.equal(le.techo_ms, 5000);

    // 1. Marcado nuestro, igual que el corte leyendo el cuerpo.
    assert.equal(le.timeout_nuestro, true);
    assert.equal(le.timed_out, true);
    assert.equal(esAbortoNuestro(f), true);
    assert.equal(culpaDelAborto(f), 'nuestra', '/liga lo carga a "nuestro", no al modelo');
    const m = manosPorAgente(filas).get(id);
    assert.equal(m.abortadas_modelo, 0, 'nada al modelo');

    // La puerta lo suma en cortes.loop, con la duración medida.
    const v = f.context.tools.vueltas_medidas;
    assert.equal(v.length, 1);
    assert.equal(v[0].reloj_nuestro, true);
    assert.equal(v[0].status, 0);
    assert.ok(v[0].ms >= 4900, 'la vuelta cortada tiene su ms, no null');
    const p = puertaDeCorrida(f.context.tools, f.context);
    assert.equal(p.cortes.loop, 1);
    assert.equal(p.cortes.cierre.cortado, false, 'murió en el loop: el cierre no se cuenta dos veces');
    assert.equal(p.cortes_nuestros, 1);
    assert.equal(p.puertas.cortes_nuestros, false);
  });
}

// El rótulo y el status salen de `timedFetch`, que es el mismo para los dos
// proveedores: OpenRouter tampoco inventa un 502 sobre nuestro corte.
test('grok (OpenRouter): el mismo corte, el mismo rótulo, status 0', async () => {
  const filas = [];
  await runShadowAgent({ agent: agentById('grok'), buffet: {}, now: AHORA, journalInsert: async (row) => filas.push(row) });
  const le = filas[0].context.llm_error;
  assert.equal(le.status, 0);
  assert.match(filas[0].error, /^corte de NUESTRO reloj a los \d+ ms \(techo 5 s, vuelta 1\)/);
  assert.equal(le.timeout_nuestro, true);
  const v = filas[0].context.tools.vueltas_medidas[0];
  assert.equal(v.reloj_nuestro, true);
  assert.ok(v.ms >= 4900, 'con su ms');
  assert.equal(culpaDelAborto(filas[0]), 'nuestra');
});

test('puerta: un corte antes de las cabeceras EN EL CIERRE cuenta como cierre cortado (0 o 1)', () => {
  const tools = { turns: 3, vueltas_medidas: [{ vuelta: 1, ms: 20000 }, { vuelta: 2, ms: 30000 }] };
  const cierre = { llm_error: { status: 0, timed_out: true, timeout_nuestro: true, murio_en: null, cuerpos_vacios: null } };
  assert.deepEqual(puertaDeCorrida(tools, cierre).cortes, { loop: 0, cierre: { cortado: true, intentos_cortados: 1 } });
  // Con vacíos del loop journaleados (la lista existe), igual se ve.
  const conLista = { llm_error: { ...cierre.llm_error, cuerpos_vacios: [{ vuelta: 2, intento: 1, timeout_nuestro: false }] } };
  assert.equal(puertaDeCorrida(tools, conLista).cortes.cierre.cortado, true);
  // Si el loop murió, esa vuelta ya está en vueltas_medidas: no es el cierre.
  const enLoop = { llm_error: { ...cierre.llm_error, murio_en: { vuelta: 2 } } };
  assert.equal(puertaDeCorrida(tools, enLoop).cortes.cierre.cortado, false);
  // Un timeout que NO es nuestro (sin la marca) no se cuenta.
  const ajeno = { llm_error: { status: 0, timed_out: true, timeout_nuestro: false } };
  assert.equal(puertaDeCorrida(tools, ajeno).cortes.cierre.cortado, false);
});
