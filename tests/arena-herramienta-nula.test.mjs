// ═══════════════════════════════════════════════════════════════
// tests/arena-herramienta-nula.test.mjs — null ≠ 0 filas.
//
// Visto en Grok (2026-10-20): screener y ficha de MU/WDC/STX volvían sin
// datos y se leían como "0 filas". Lo que se blinda:
//
//   1. EL AGENTE RECIBE "LA HERRAMIENTA FALLÓ": un runner que devuelve null,
//      un objeto sin texto o que lanza no tumba la vuelta ni viaja mudo.
//   2. FICHA CON FUNDAMENTALES VACÍOS es una falla (rows null, error) y no se
//      cachea: una ficha toda en null no es "sin cobertura" de MU.
//   3. EL SCREENER SIN TABLERO es una falla, no "0 nombres".
//   4. LA PUBLICACIÓN: el paso dice `falló`, y `avisos` lo cuenta por agente.
//
// Correr con `node tests/arena-herramienta-nula.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { createToolExecutor, RUNNERS, resultadoValido, runFicha, runScreener } from '../api/_lib/arena-tools.js';
import { runToolLoop } from '../api/_lib/arena-tool-loop.js';
import { secuenciaPublicable, fallosDeHerramientas, avisosDeFallos, libroDeFila, pasoEnPalabras } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-10-20T15:00:00Z');
const board = {
  gainers: [{ symbol: 'MU', price: 120, change_pct: 4.1, rvol: 2.2, pct_from_high: -1 }],
  losers: [], rvol: [], breakouts: { high: [], low: [] }, sectors: [], headlines: [],
};
// El shape EXACTO que devuelve fetchDeepDive cuando Finnhub contesta 429 a
// todo: la entrada existe, con todos los campos en null, y el error dice
// "sin cobertura Finnhub" (safeJson trata cualquier no-ok como null).
const DIVE_429 = async (tks) => ({
  data: { [tks[0]]: { profile: { name: null, industry: null, marketCapM: null }, fundamentals: { peTTM: null, psTTM: null, grossMarginTTM: null }, recommendation: null, news: [] } },
  errors: { [tks[0]]: 'sin cobertura Finnhub' },
});
const DIVE_OK = async (tks) => ({
  data: { [tks[0]]: { profile: { name: 'Micron', industry: 'Semis', marketCapM: 130000 }, fundamentals: { peTTM: 14.2, psTTM: 4, grossMarginTTM: 38 }, recommendation: { buy: 20 }, news: [] } },
  errors: {},
});

console.log('\n── 1) null, vacío o excepción → "la herramienta falló" ──');
{
  ok(!resultadoValido(null) && !resultadoValido(undefined) && !resultadoValido({}) && !resultadoValido({ text: '  ' }) && !resultadoValido('x'),
    'null, undefined, sin texto, texto en blanco y no-objeto no son resultados');
  ok(resultadoValido({ text: 'x', rows: 0 }) && resultadoValido({ text: 'x' }) && resultadoValido({ text: 'x', rows: null, error: true }),
    'un cero con texto SÍ es un resultado; null con error declarado también');
  ok(!resultadoValido({ text: 'x', rows: null }) && !resultadoValido({ text: 'x', rows: 'tres' }),
    'filas null SIN error declarado no es válido: es exactamente el hueco que se lee como cero');

  const original = RUNNERS.ficha;
  try {
    for (const [nombre, devuelve] of [['null', null], ['undefined', undefined], ['sin texto', { rows: 3 }], ['texto vacío', { text: '', rows: 0 }]]) {
      RUNNERS.ficha = async () => devuelve;
      const ex = createToolExecutor({ board, now: HOY, cache: false });
      let r, lanzo = null;
      try { r = await ex.call('ficha', { ticker: 'MU' }); } catch (e) { lanzo = e; }
      ok(!lanzo && /^La herramienta falló: devolvió un resultado vacío/.test(r.text) && r.rows === null && r.error === true,
        `runner que devuelve ${nombre}: no lanza, el agente lee "la herramienta falló"`, lanzo ? String(lanzo) : r.text);
      ok(/NO es lo mismo que 0 filas/.test(r.text), `  …y le dice que no es un cero (${nombre})`);
      const s = ex.summary()[0];
      ok(s.error === true && s.fallo === 'resultado nulo' && s.rows === null, `  …y el resumen journalea la falla (${nombre})`, JSON.stringify(s));
    }
    RUNNERS.ficha = async () => { throw new Error('boom'); };
    const ex = createToolExecutor({ board, now: HOY, cache: false });
    const r = await ex.call('ficha', { ticker: 'MU' });
    ok(r.rows === null && r.error && /^La herramienta falló: boom/.test(r.text) && ex.summary()[0].fallo === 'lanzó una excepción',
      'una excepción deja filas null (antes: 0)', JSON.stringify(ex.summary()[0]));
  } finally { RUNNERS.ficha = original; }

  // Por el LOOP: Grok pide tres fichas en una vuelta y las tres vuelven null.
  const original2 = RUNNERS.ficha;
  try {
    RUNNERS.ficha = async () => null;
    const ex = createToolExecutor({ board, now: HOY, cache: false });
    const agent = { id: 'grok', provider: 'openrouter', model: 'm', caps: {} };
    let vuelta = 0;
    const call = async () => {
      vuelta++;
      if (vuelta === 1) {
        return { status: 200, data: { content: ['MU', 'WDC', 'STX'].map((t, i) => ({ type: 'tool_use', id: 'c' + i, name: 'ficha', input: { ticker: t } })) } };
      }
      return { status: 200, data: { content: [{ type: 'text', text: '{"plan":"ok","pesos":{}}' }] } };
    };
    let r, lanzo = null;
    try { r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call }); } catch (e) { lanzo = e; }
    ok(!lanzo && r.stopped_by === 'end_turn', 'el loop no se cae: la vuelta sigue y el agente cierra', lanzo ? String(lanzo) : r.stopped_by);
    const tools = r.messages.filter((m) => m.role === 'tool');
    ok(tools.length === 3 && tools.every((m) => /^La herramienta falló/.test(m.content)),
      'los tres mensajes `tool` que recibe el modelo dicen "La herramienta falló"', tools.map((m) => m.content.slice(0, 30)).join(' | '));
  } finally { RUNNERS.ficha = original2; }
}

console.log('\n── 2) ficha con fundamentales vacíos es una falla, no "sin cobertura" ──');
{
  const ctx = { board, now: HOY, finnhubKey: 'k', deps: { fetchDeepDive: DIVE_429 }, universe: null };
  const r = await runFicha({ ticker: 'MU' }, ctx);
  ok(r.error === true && r.rows === null && /^La herramienta falló en la parte de fundamentales \(Finnhub: sin cobertura Finnhub\)/.test(r.text),
    'MU con Finnhub en 429: la herramienta dice que FALLÓ', r.text.split('\n')[0]);
  ok(/precio 120\.00/.test(r.text), 'y lo que sí hay (el tablero) igual viaja');
  ok(!/P\/E —/.test(r.text), 'no imprime una fila de fundamentales toda en "—" como si fuera dato');
  ok(/^fundamentales: /.test(r.fallo), 'con el motivo en `fallo`');

  const tiro = await runFicha({ ticker: 'WDC' }, { ...ctx, deps: { fetchDeepDive: async () => { throw new Error('timeout'); } } });
  ok(tiro.error && /Finnhub: timeout/.test(tiro.text), 'si fetchDeepDive lanza, también es falla, con el motivo');
  const nula = await runFicha({ ticker: 'STX' }, { ...ctx, deps: { fetchDeepDive: async () => null } });
  ok(nula.error && nula.rows === null, 'si devuelve null, también');

  const bien = await runFicha({ ticker: 'MU' }, { ...ctx, deps: { fetchDeepDive: DIVE_OK } });
  ok(!bien.error && Number.isFinite(bien.rows) && /P\/E 14\.20/.test(bien.text), 'con datos, la ficha es normal');

  const src = readFileSync(new URL('../api/_lib/arena-tools.js', import.meta.url), 'utf8');
  ok(/if \(cache && !out\.error\) await writeDayCache/.test(src),
    'y como es `error`, NO se cachea: antes una ficha en null quedaba servida el día entero a los siete');
  ok(/hit && resultadoValido\(hit\.payload\) && !hit\.payload\.error/.test(src),
    'una entrada de caché mal formada o de error no se sirve: se vuelve a correr');
}

console.log('\n── 3) screener sin tablero es una falla ──');
{
  const r = await runScreener({}, { board: null });
  ok(r.error === true && r.rows === null && /^La herramienta falló/.test(r.text) && r.fallo === 'sin tablero',
    'sin tablero: falló, filas null — no "0 nombres"', r.text.slice(0, 60));
}

console.log('\n── 4) la publicación y `avisos` ──');
{
  const summary = [
    { n: 1, tool: 'screener', args: { sector: 'XLK' }, rows: null, error: true, fallo: 'sin tablero' },
    { n: 2, tool: 'ficha', args: { ticker: 'MU' }, rows: null, error: true, fallo: 'fundamentales: sin cobertura Finnhub' },
    { n: 3, tool: 'ficha', args: { ticker: 'WDC' }, rows: 0, error: true },       // fila vieja: error sin `fallo`
    { n: 4, tool: 'ficha', args: { ticker: 'STX' }, rows: null },                  // fila vieja: null sin nada
    { n: 5, tool: 'noticias', args: { ticker: 'MU' }, rows: 0 },                   // un cero de verdad
    { n: 6, tool: 'ficha', args: { ticker: 'AMD' }, refused: 'budget_exhausted' }, // un rechazo no es una falla
  ];
  const s = secuenciaPublicable({ tools: { summary } });
  ok(s.pasos[0].falló === true && s.pasos[0].fallo === 'sin tablero', 'el paso que falló se marca, con su motivo');
  ok(s.pasos[2].falló === true, 'una fila VIEJA con `error: true` también sale como falla (antes: "0 filas")');
  ok(!s.pasos[3].falló && s.pasos[3].filas === null, 'null sin error declarado no se inventa como falla…');
  ok(/sin resultado registrado/.test(pasoEnPalabras(s.pasos[3])), '…pero tampoco se lee como cero');
  ok(!s.pasos[4].falló && s.pasos[4].filas === 0, 'un cero de verdad sigue siendo cero');
  ok(!s.pasos[5].falló, 'un rechazo por presupuesto no es una falla de la herramienta');

  const libro = libroDeFila({ id: 'g1', created_at: '2026-10-20T14:00:00Z', agent_id: 'grok', status: 'ok_target', context: { tools: { summary } } }, 'en_vivo');
  const sano = libroDeFila({ id: 'c1', created_at: '2026-10-20T14:00:00Z', agent_id: 'claude', status: 'ok_target', context: { tools: { summary: [summary[4]] } } }, 'en_vivo');
  const f = fallosDeHerramientas([libro, sano]);
  ok(f.length === 4 && f.every((x) => x.agente === 'grok' && x.corrida_id === 'g1'), 'cuatro llamadas sin datos, todas de grok, con su corrida', JSON.stringify(f.map((x) => x.paso)));
  ok(f.filter((x) => x.tipo === 'falló').length === 3 && f.filter((x) => x.tipo === 'sin_resultado').length === 1, 'tres fallaron y una no registró resultado');
  const avisos = avisosDeFallos(f);
  ok(avisos.length === 1 && /^grok: 4 llamada\(s\)/.test(avisos[0]) && /screener XLK, ficha MU, ficha WDC, ficha STX/.test(avisos[0]),
    '`avisos` lo publica en una línea por agente, con qué falló', avisos[0]);
  ok(/NO son "0 filas"/.test(avisos[0]), 'y dice que no son ceros');
  ok(avisosDeFallos([]).length === 0, 'sin fallas, sin avisos');

  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(/avisos\.push\(\.\.\.avisosDeFallos\(fallosHerr\)\)/.test(src) && /herramientas_fallidas: fallosHerr/.test(src),
    'el endpoint los empuja a `avisos` y publica el detalle en `herramientas_fallidas`');
  const html = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  ok(/la herramienta FALLÓ/.test(html) && /sin resultado registrado/.test(html), 'la tarjeta pinta la falla y el null, no un cero');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
