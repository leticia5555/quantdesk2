// ═══════════════════════════════════════════════════════════════
// tests/arena-universo.test.mjs — el universo de B1 y sus tres escalones.
//
// LA PROMESA QUE HAY QUE BLINDAR: **el tablero nunca se bloquea por esto**
// (decisión D1). Un universo más chico es un sesgo declarado; un tablero que no
// sale es una corrida perdida. Así que casi todo lo de acá prueba DEGRADACIÓN:
//
//   1. LOS TRES ESCALONES en orden: FMP → Neon → JSON del repo → solo movers.
//      Cada caída baja UN escalón y lo DICE en `universe_source`.
//   2. NO CORROMPER AL DEGRADAR. Una lista incoherente de FMP (12 nombres para
//      el S&P 500 = cuota agotada o error) NO pisa la buena que ya estaba.
//   3. REFRESCO SEMANAL por EDAD, no por calendario: si el cron no corrió el
//      lunes, el martes refresca igual.
//   4. EL TOPE DE 100 se gasta solo en nombres NUEVOS. Un mover que ya está en
//      el S&P 500 no consume cupo — sería gastar el presupuesto de nombres
//      nuevos en nombres que ya estaban.
//   5. LOS ÍNDICES TAMBIÉN PASAN POR ADMISIÓN: un constituyente sigue en el
//      índice hasta que el comité lo saque, y el Arena no hereda esa demora.
//   6. EL UNIVERSO DE AYER se puede usar, pero MARCADO.
//
// Sin red y sin Neon: todo por inyección de dependencias.
// Correr con `node tests/arena-universo.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  buildUniverse, resolveConstituents, refreshDue, REFRESH_DAYS, MOVERS_MAX,
} from '../api/_lib/arena-universe.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-09-16T13:00:00Z');   // 9:00 ET, media hora antes de la apertura
const sp500 = Array.from({ length: 500 }, (_, i) => 'SP' + i);
const nq100 = Array.from({ length: 100 }, (_, i) => 'NQ' + i);
const listaDe = (index) => (index === 'sp500' ? sp500 : nq100);

// Fábricas de dependencias. Cada test arma el escenario que necesita.
const depsBase = ({ fmp, neon, repo } = {}) => ({
  fetchConstituents: async (index) => (fmp === undefined ? null : (typeof fmp === 'function' ? fmp(index) : fmp)),
  readStored: async (index) => (neon === undefined ? null : (typeof neon === 'function' ? neon(index) : neon)),
  writeStored: async () => true,
  readStatic: async (index) => (repo === undefined ? null : (typeof repo === 'function' ? repo(index) : repo)),
});

// ── 3) REFRESCO POR EDAD ─────────────────────────────────────────────
console.log('\n── el refresco se decide por EDAD, no por calendario ──');
{
  ok(refreshDue(null) === true, 'sin nada guardado, toca refrescar');
  ok(refreshDue('no-es-fecha') === true, 'una fecha corrupta manda a refrescar en vez de romper');
  const hace3 = new Date(HOY.getTime() - 3 * 86400000).toISOString();
  const hace9 = new Date(HOY.getTime() - 9 * 86400000).toISOString();
  ok(refreshDue(hace3, HOY) === false, 'a 3 días no toca (la ventana es semanal)');
  ok(refreshDue(hace9, HOY) === true,
    'a 9 días SÍ — si el cron no corrió el lunes, el martes refresca igual en vez de esperar al siguiente lunes');
  ok(REFRESH_DAYS === 7, 'la ventana declarada es semanal', String(REFRESH_DAYS));
}

// ── 1) LOS TRES ESCALONES ────────────────────────────────────────────
console.log('\n── escalón 1: FMP fresco ──');
{
  const r = await resolveConstituents('sp500', {
    now: HOY, deps: depsBase({ fmp: (i) => ({ index: i, source: 'fmp', built_at: HOY.toISOString(), symbols: listaDe(i) }) }),
  });
  ok(r.source === 'fmp' && r.symbols.length === 500, 'con FMP arriba, gana FMP', `${r.source}/${r.symbols.length}`);
  ok(r.refreshed === true && r.stored === true, 'y se guarda en Neon para la próxima');
}

console.log('\n── escalón 2: FMP caído → lo guardado, MARCADO como viejo ──');
{
  const hace10 = new Date(HOY.getTime() - 10 * 86400000).toISOString();
  const r = await resolveConstituents('sp500', {
    now: HOY,
    deps: depsBase({ fmp: null, neon: { index: 'sp500', source: 'neon', built_at: hace10, symbols: sp500 } }),
  });
  ok(r.source === 'neon' && r.symbols.length === 500, 'se usa la lista guardada', r.source);
  ok(r.stale === true && r.age_days === 10, 'marcada como vieja, con la edad EXACTA', `stale=${r.stale} age=${r.age_days}`);
  ok(/sesgo declarado/.test(r.note || ''), 'y la nota dice que es un sesgo declarado, no un dato fresco', r.note);
}

console.log('\n── escalón 3: arranque en frío → el JSON del repo ──');
{
  const r = await resolveConstituents('nasdaq100', {
    now: HOY, deps: depsBase({ fmp: null, neon: null, repo: { index: 'nasdaq100', source: 'static', built_at: '2026-09-01T00:00:00Z', symbols: nq100 } }),
  });
  ok(r.source === 'static' && r.symbols.length === 100, 'sin FMP y sin Neon, gana el JSON del repo', r.source);
  ok(/Arranque en frío/.test(r.note || ''), 'y se dice', r.note);
}

console.log('\n── los cuatro escalones agotados: se declara, no se inventa ──');
{
  const r = await resolveConstituents('sp500', { now: HOY, deps: depsBase({}) });
  ok(r.source === 'none' && r.symbols.length === 0, 'sin ninguna fuente → lista vacía, fuente `none`', r.source);
  ok(/data\/universe\/README/.test(r.note || ''), 'y la nota manda al lugar donde se arregla', r.note);
}

// ── 2) NO CORROMPER AL DEGRADAR ──────────────────────────────────────
console.log('\n── una lista incoherente de FMP NO pisa la buena ──');
{
  // El caso real: cuota agotada o error de la API devuelve 12 nombres para el
  // S&P 500. Guardar eso sería CORROMPER, no degradar.
  const { fetchConstituents } = await import('../api/_lib/arena-universe.js');
  const doceNombres = async () => ({ ok: true, json: async () => Array.from({ length: 12 }, (_, i) => ({ symbol: 'X' + i })) });
  const r = await fetchConstituents('sp500', { apiKey: 'k', fetchImpl: doceNombres });
  ok(r === null, '12 nombres para el S&P 500 se RECHAZA: es un error de la API, no el índice');

  const quinientos = async () => ({ ok: true, json: async () => sp500.map((s) => ({ symbol: s })) });
  const r2 = await fetchConstituents('sp500', { apiKey: 'k', fetchImpl: quinientos });
  ok(r2 && r2.symbols.length === 500, 'y una lista sana sí se acepta', r2 && r2.symbols.length);

  const basura = async () => ({ ok: true, json: async () => ({ error: 'Limit Reach' }) });
  ok((await fetchConstituents('sp500', { apiKey: 'k', fetchImpl: basura })) === null, 'una respuesta que no es un array tampoco pasa');
  ok((await fetchConstituents('sp500', { apiKey: null })) === null, 'sin FMP_API_KEY ni se intenta');

  const rota = async () => { throw new Error('ECONNRESET'); };
  ok((await fetchConstituents('sp500', { apiKey: 'k', fetchImpl: rota })) === null, 'y una excepción de red devuelve null en vez de propagarse');
}

// ── EL UNIVERSO COMPLETO ─────────────────────────────────────────────
const conIndices = () => depsBase({ fmp: (i) => ({ index: i, source: 'fmp', built_at: HOY.toISOString(), symbols: listaDe(i) }) });
const TODO_ADMISIBLE = { price: 100, marketCap: 5e11, dollarVolume: 5e9 };
const admisionTodo = async (syms) => Object.fromEntries(syms.map((s) => [s, TODO_ADMISIBLE]));

console.log('\n── 4) el tope de 100 se gasta SOLO en nombres nuevos ──');
{
  // 30 movers: 20 YA están en el S&P 500, 10 son nuevos. Más 120 most-actives
  // nuevos, para que el tope muerda.
  const yaEstan = sp500.slice(0, 20);
  const nuevos = Array.from({ length: 130 }, (_, i) => 'NEW' + i);
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      getMovers: async () => ({ gainers: yaEstan.map((s) => ({ symbol: s, price: 50, percent_change: 5 })), losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: nuevos.map((s) => ({ symbol: s, volume: 1e7 })), by: 'volume', last_updated: null }),
      resolveAdmission: admisionTodo,
    },
  });
  ok(u.counts.indices === 600, 'los índices aportan 600 nombres', String(u.counts.indices));
  ok(u.counts.del_dia_nuevos === MOVERS_MAX,
    `del día entran exactamente ${MOVERS_MAX}: el tope aplica a los NUEVOS`, String(u.counts.del_dia_nuevos));
  ok(u.counts.del_dia_brutos === 150, 'aunque el día trajo 150 nombres en bruto', String(u.counts.del_dia_brutos));
  ok(u.counts.admitidos === 700, '600 + 100 = 700 — los 20 que ya estaban NO gastaron cupo', String(u.counts.admitidos));
  ok(u.from_index.length === 600 && u.from_day.length === 100, 'y se sabe cuál vino de dónde', `${u.from_index.length}/${u.from_day.length}`);
  ok(u.universe_source === 'fmp', 'la fuente queda journaleada', u.universe_source);
  ok(/survivorship bias/.test(u.caveat), 'el caveat de survivorship viaja CON el dato, no en un doc que nadie abre');
}

console.log('\n── 5) los ÍNDICES también pasan por admisión ──');
{
  const caido = sp500[0];
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((s) => [s,
        s === caido ? { price: 3.2, marketCap: 8e8, dollarVolume: 2e6 } : TODO_ADMISIBLE])),
    },
  });
  ok(!u.symbols.includes(caido),
    'un constituyente del S&P 500 que cayó bajo $5 NO entra: el Arena no hereda la demora del comité del índice');
  ok(u.admission.rejected.some((r) => r.symbol === caido && /precio \$3\.20/.test(r.reason)),
    'y sale nombrado con el número que lo sacó', JSON.stringify(u.admission.rejected[0]));
  ok(u.counts.admitidos === 599, 'el conteo lo refleja', String(u.counts.admitidos));
}

console.log('\n── 6) degradación: sin índices, el tablero SIGUE saliendo ──');
{
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...depsBase({}),   // los tres escalones vacíos
      getMovers: async () => ({ gainers: [{ symbol: 'NVDA', price: 200, percent_change: 8 }], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [{ symbol: 'AAPL', volume: 9e7 }], by: 'volume', last_updated: null }),
      resolveAdmission: admisionTodo,
    },
  });
  ok(u.universe_source === 'movers_only',
    'sin ninguna lista de índices, la fuente es `movers_only` — DECLARADO, no silencioso', u.universe_source);
  ok(u.symbols.length === 2 && u.symbols.includes('NVDA'),
    'y el universo sale igual con lo que hubo: el tablero NUNCA se bloquea por esto', u.symbols.join(','));
}

console.log('\n── y con TODO caído, vacío honesto ──');
{
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...depsBase({}),
      getMovers: async () => { throw new Error('HTTP 403'); },
      getMostActives: async () => { throw new Error('HTTP 403'); },
      resolveAdmission: admisionTodo,
    },
  });
  ok(u.universe_source === 'empty' && u.symbols.length === 0, 'fuente `empty`, cero nombres — no se inventa uno solo', u.universe_source);
  ok(/403/.test(u.errors.movers || ''), 'con el error real de cada canal', JSON.stringify(u.errors));
}

console.log('\n── la admisión caída NO vacía el universo ──');
{
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      resolveAdmission: async () => { throw new Error('Finnhub 429'); },
    },
  });
  ok(u.admission.applied === false, 'se declara que el filtro NO corrió');
  ok(u.counts.admitidos === 600, 'y los nombres pasan sin filtrar en vez de dejar el tablero vacío', String(u.counts.admitidos));
  ok(/429/.test(u.errors.admission || ''), 'con el error registrado', u.errors.admission);
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
