// ═══════════════════════════════════════════════════════════════
// tests/arena-tablero.test.mjs — B2: el tablero.
//
// El tablero reemplaza al buffet como "lo que el PM ve". Lo que hay que
// blindar no es que se arme —eso se ve— sino las cinco cosas que, si salen
// mal, salen mal EN SILENCIO:
//
//   1. EL PRESUPUESTO DE TOKENS es una regla, no una esperanza. Se mide, y
//      cuando no cabe se recorta POR LA COLA y se DICE qué se cayó. Una
//      sección a medias es una lista que el PM lee como completa.
//   2. ORDEN TOTAL en los tres rankings. Sin desempate, dos corridas con los
//      mismos datos devuelven listas distintas y el replay deja de reproducir.
//   3. LAS ETIQUETAS DE RELOJ. El calor por sector sale de velas CERRADAS; el
//      precio y el RVOL son VIVOS. Mezclarlos sin decirlo es publicar un
//      número correcto con la semántica equivocada.
//   4. NO INVENTAR. Un nombre sin precio no entra; un plazo sin historia sale
//      null; el VIX viaja como PROXY y se dice.
//   5. COBERTURA. Un tablero que cubre 120 de 600 nombres no es el mismo
//      tablero, y tiene que poder verse sin reconstruirlo.
//
// Sin red: todo por inyección de dependencias.
// Correr con `node tests/arena-tablero.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  buildBoard, renderBoard, trimToBudget, returnsFromCloses, rvol, clasificarTitular,
  SECTOR_ETFS, INDEX_ETFS, VIX_PROXY, TOP_MOVERS, TOP_RVOL, BOARD_TOKEN_TARGET, estimateTokens,
} from '../api/_lib/arena-board.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-09-16T14:30:00Z');   // 10:30 ET, una hora de sesión

// ── piezas puras ─────────────────────────────────────────────────────
console.log('\n── retornos: sin historia suficiente, null (no un número con menos barras) ──');
{
  const c = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = returnsFromCloses(c);
  ok(r.d1 !== null && r.d5 !== null && r.m1 !== null, 'con 30 barras salen los tres plazos', JSON.stringify(r));
  const corto = returnsFromCloses([100, 101, 102]);
  ok(corto.d1 !== null && corto.m1 === null, 'con 3 barras sale 1d pero NO 1m — no se aproxima con lo que hay', JSON.stringify(corto));
  ok(returnsFromCloses([]).d1 === null, 'sin barras, null y no cero');
  ok(returnsFromCloses([0, 0, 100]).d1 === null, 'un cierre en 0 no produce una división absurda');
}

console.log('\n── RVOL ──');
{
  ok(rvol(3e7, 1e7) === 3, 'volumen del día / promedio de 20 sesiones');
  ok(rvol(3e7, 0) === null, 'promedio 0 → null, no infinito');
  ok(rvol(null, 1e7) === null, 'sin volumen del día, null');
}

console.log('\n── el clasificador de titulares es TONTO Y EXPLICABLE ──');
{
  ok(clasificarTitular('Acme to acquire Beta Corp for $4B') === 'M&A', 'M&A');
  ok(clasificarTitular('Analyst upgrades NVDA to Buy') === 'UP', 'upgrade');
  ok(clasificarTitular('Goldman downgrades ZM to Sell') === 'DOWN', 'downgrade');
  ok(clasificarTitular('NVDA opens a new office in Austin') === null,
    'un titular que no es de ninguno de los tres temas NO se fuerza a una categoría');
}

// ── el armado, con Alpaca stubbeado ──────────────────────────────────
const UNI = Array.from({ length: 200 }, (_, i) => 'U' + String(i).padStart(3, '0'));
const universe = {
  symbols: UNI,
  fifty_two_week: Object.fromEntries(UNI.map((s, i) => [s, {
    high_52w: 200, low_52w: 50, last: 180,
    pct_from_high: i < 5 ? -0.5 : -30,     // los primeros 5 están en máximos
    pct_from_low: i >= 195 ? 0.4 : 120,    // los últimos 5 en mínimos
  }])),
};
const etfs = [...INDEX_ETFS.map((x) => x.etf), VIX_PROXY.etf, ...SECTOR_ETFS.map((x) => x.etf)];

const stubs = (over = {}) => ({
  getSnapshots: async (syms) => Object.fromEntries(syms.map((s, i) => [s, {
    price: 100 + i, prev_close: 100, day_volume: (i + 1) * 1e6, day_open: 100, as_of: HOY.toISOString(),
  }])),
  getAvgDailyVolume: async (syms) => Object.fromEntries(syms.map((s, i) => [s, (i + 1) * 5e5])),
  getDailyCloses: async (syms) => Object.fromEntries(syms.map((s) => [s, Array.from({ length: 30 }, (_, i) => 100 + i)])),
  getNews: async () => ([
    { headline: 'Acme to acquire U001 in $4B deal', symbols: ['U001'], created_at: HOY.toISOString() },
    { headline: 'Broker upgrades U002 to Buy', symbols: ['U002'], created_at: HOY.toISOString() },
    { headline: 'U003 opens a new office', symbols: ['U003'], created_at: HOY.toISOString() },
    { headline: 'Bank downgrades ZZZZ to Sell', symbols: ['ZZZZ'], created_at: HOY.toISOString() },
  ]),
  ...over,
});

console.log('\n── el tablero se arma con las siete secciones ──');
const board = await buildBoard({ universe, creds: {}, now: HOY, earnings: [{ ticker: 'U010', when: 'in 2 days (Thu Sep 18, AMC)', date: '2026-09-18', time: 'amc' }], deps: stubs() });
{
  ok(board.indices.length === 4 && board.indices[0].etf === 'SPY', 'índices', board.indices.map((i) => i.etf).join(','));
  ok(board.sectors.length === 11, 'once sectores GICS — ni 13 (SOXX/IBIT no son sectores) ni menos', String(board.sectors.length));
  ok(board.gainers.length === TOP_MOVERS && board.losers.length === TOP_MOVERS, `top ${TOP_MOVERS} por lado`);
  ok(board.rvol.length === TOP_RVOL, `top ${TOP_RVOL} por RVOL`);
  ok(board.breakouts.high.length === 5 && board.breakouts.low.length === 5, 'breakouts de 52 semanas de los dos lados',
    `${board.breakouts.high.length}/${board.breakouts.low.length}`);
  ok(board.coverage_pct === 100, 'cobertura reportada', String(board.coverage_pct));
}

console.log('\n── 4) no inventar ──');
{
  ok(/proxy/i.test(board.vix.name) && /NO es el índice/.test(board.vix.name),
    'el VIX viaja como PROXY y lo DICE: llamarle VIX a VIXY sería un número correcto con la etiqueta equivocada', board.vix.name);

  // Un nombre sin snapshot no entra al tablero.
  const parcial = await buildBoard({
    universe, creds: {}, now: HOY,
    deps: stubs({ getSnapshots: async (syms) => (syms.length > 20
      ? Object.fromEntries(syms.slice(0, 50).map((s, i) => [s, { price: 100 + i, prev_close: 100, day_volume: 1e6 }]))
      : Object.fromEntries(syms.map((s, i) => [s, { price: 100 + i, prev_close: 100, day_volume: 1e6 }]))) }),
  });
  ok(parcial.covered === 50, 'un nombre sin precio vivo NO entra: no se inventa una fila', String(parcial.covered));
  ok(parcial.coverage_pct === 25, 'y la COBERTURA lo dice — un tablero de 50 de 200 no es el mismo tablero', String(parcial.coverage_pct));
}

console.log('\n── 5) los titulares: solo tema Y solo universo ──');
{
  const tags = board.headlines.map((h) => h.tag);
  ok(tags.includes('M&A') && tags.includes('UP'), 'entran los de tema', JSON.stringify(tags));
  ok(!board.headlines.some((h) => /new office/.test(h.headline)), 'el que no es de ningún tema NO entra');
  ok(!board.headlines.some((h) => /ZZZZ/.test(h.headline)),
    'y un titular de una empresa FUERA del universo tampoco: el PM no puede comprarla, así que solo paga tokens');
}

console.log('\n── 2) ORDEN TOTAL en los tres rankings ──');
{
  const empatados = Array.from({ length: 10 }, (_, i) => 'T' + i);
  const uni2 = { symbols: empatados, fifty_two_week: {} };
  const planos = {
    getSnapshots: async (syms) => Object.fromEntries(syms.map((s) => [s, { price: 100, prev_close: 100, day_volume: 1e6 }])),
    getAvgDailyVolume: async (syms) => Object.fromEntries(syms.map((s) => [s, 1e6])),
    getDailyCloses: async (syms) => Object.fromEntries(syms.map((s) => [s, [100, 100, 100]])),
    getNews: async () => [],
  };
  const a = await buildBoard({ universe: uni2, creds: {}, now: HOY, deps: planos });
  const b = await buildBoard({ universe: { ...uni2, symbols: [...empatados].reverse() }, creds: {}, now: HOY, deps: planos });
  ok(a.gainers.map((x) => x.symbol).join(',') === b.gainers.map((x) => x.symbol).join(','),
    'con TODO empatado, invertir la entrada no cambia el orden — sin esto el replay deja de reproducir',
    `${a.gainers.map((x) => x.symbol).join(',')} vs ${b.gainers.map((x) => x.symbol).join(',')}`);
  ok(a.rvol.map((x) => x.symbol).join(',') === b.rvol.map((x) => x.symbol).join(','), 'ídem el ranking de RVOL');
}

// ── 1) EL PRESUPUESTO ────────────────────────────────────────────────
console.log('\n── 1) el presupuesto de tokens ──');
{
  const r = renderBoard(board);
  ok(r.tokens_est > 0, 'el render mide sus tokens', String(r.tokens_est));
  ok(r.tokens_est <= 5000, `y cabe en el techo duro (${r.tokens_est} tokens)`, String(r.tokens_est));
  console.log(`     · tablero real: ~${r.tokens_est} tokens (objetivo ${BOARD_TOKEN_TARGET})`);
  ok(Array.isArray(r.sections) && r.sections.length >= 7, 'con el desglose por sección, para saber QUÉ creció', String(r.sections.length));
  ok(r.sections.every((s) => s.tokens_est > 0), 'cada sección con su medida');

  // 3) etiquetas de reloj
  ok(/CLOSED daily bars/.test(r.text), 'el calor por sector dice que sale de velas CERRADAS');
  ok(/live price/.test(r.text), 'y el precio dice que es VIVO');
  ok(/BIASED LOW/.test(r.text),
    'el RVOL intradía avisa que está sesgado hacia abajo: a las 10:30 un RVOL de 1.0 ya es mucho volumen');
  ok(/CLOSED weekly bars/.test(r.text), 'y el rango de 52 semanas, que sale de barras semanales cerradas');
}

console.log('\n── el recorte: por la COLA, y se dice qué se cayó ──');
{
  const completo = renderBoard(board);
  const chico = renderBoard(board, { budget: 400 });
  ok(chico.dropped.length > 0, 'con un presupuesto chico se cae al menos una sección', JSON.stringify(chico.dropped));
  ok(/BOARD TRUNCATED/.test(chico.text), 'y el tablero lo DICE en el propio texto');
  ok(/did not fit/.test(chico.text),
    'aclarando que no están vacías, que no cupieron — un PM que lee una sección ausente como "no hay nada" razona sobre un mercado que no existe');
  ok(/INDICES/.test(chico.text), 'los índices sobreviven: son el encuadre, se recorta desde la cola');
  ok(chico.budget_respected === (chico.tokens_est <= 400),
    'el resultado declara si respetó el presupuesto — no devuelve un número que se pasó sin avisar',
    `${chico.tokens_est} tokens, respected=${chico.budget_respected}`);
  ok(chico.tokens_est < completo.tokens_est, 'y recortó de verdad', `${completo.tokens_est} → ${chico.tokens_est}`);

  // Nunca se queda sin nada: el recorte tiene piso.
  const minimo = renderBoard(board, { budget: 1 });
  ok(minimo.text.length > 0 && /INDICES/.test(minimo.text),
    'con un presupuesto absurdo igual queda el encuadre — un tablero vacío sería peor que uno recortado');
  ok(minimo.floor_hit === true && minimo.budget_respected === false,
    'y cuando el PISO gana sobre el presupuesto, se DECLARA en vez de devolver un número pasado en silencio',
    JSON.stringify({ floor_hit: minimo.floor_hit, respected: minimo.budget_respected }));
  ok(/no alcanza ni para el encuadre mínimo/.test(minimo.floor_note || ''), 'con la nota que explica por qué', minimo.floor_note);
}

console.log('\n── una sección caída no tumba el tablero ──');
{
  const roto = await buildBoard({
    universe, creds: {}, now: HOY,
    deps: stubs({ getNews: async () => { throw new Error('HTTP 403'); }, getDailyCloses: async () => { throw new Error('HTTP 500'); } }),
  });
  ok(/403/.test(roto.errors.news || ''), 'el error de noticias queda registrado', roto.errors.news);
  ok(/500/.test(roto.errors.sector_bars || ''), 'y el de las barras de sector', roto.errors.sector_bars);
  ok(roto.gainers.length === TOP_MOVERS, 'y el resto del tablero sale igual');
  ok(roto.sectors.every((s) => s.d1 === null), 'los sectores salen en null en vez de con un número inventado');
}

console.log('\n── sin universo, el tablero SIGUE saliendo (D1) ──');
{
  const sinUni = await buildBoard({ universe: null, creds: {}, now: HOY, deps: stubs() });
  ok(sinUni.universe_size === 0 && sinUni.gainers.length === 0, 'sin universo no hay rankings de nombres');
  ok(sinUni.indices.length === 4 && sinUni.sectors.length === 11,
    'pero índices y calor por sector salen igual: el tablero nunca se bloquea del todo');
  const r = renderBoard(sinUni);
  ok(/INDICES/.test(r.text) && /SECTOR HEAT/.test(r.text), 'y se renderiza');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
