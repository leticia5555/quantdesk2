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

// ── EL COSTO DE LA ADMISIÓN, que es lo que hace viable a B1 ──────────
console.log('\n── el costo: 6 requests de precio, no 600 ──');
{
  let lotesDePrecio = 0;
  let simbolosPedidos = 0;
  let admisionRecibio = null;

  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      getMovers: async () => ({ gainers: [{ symbol: 'DAY1', price: 50, percent_change: 9 }], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [{ symbol: 'DAY2', volume: 1e7 }], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => {
        lotesDePrecio++;
        simbolosPedidos = syms.length;
        return Object.fromEntries(syms.map((s2) => [s2, { price: 100, dollarVolume: 5e8, sessions: 20 }]));
      },
      resolveAdmission: async (syms, opts) => {
        admisionRecibio = opts;
        // Simula el módulo real: respeta `known` y NO vuelve a pedir lo que ya
        // tiene. Lo que quede sin resolver es lo que costaría una request.
        return Object.fromEntries(syms.map((s2) => [s2, { ...(opts.known || {})[s2] }]));
      },
      getFiftyTwoWeek: async () => ({}),
    },
  });

  ok(lotesDePrecio === 1 && simbolosPedidos === 602,
    'el precio y el volumen se piden EN UNA sola llamada por lotes para los 602 nombres, no uno por uno',
    `${lotesDePrecio} llamada(s), ${simbolosPedidos} símbolos`);

  const known = admisionRecibio && admisionRecibio.known;
  ok(known && Object.keys(known).length === 602, 'y la admisión recibe `known` ya lleno', String(known && Object.keys(known).length));

  // LO QUE DE VERDAD IMPORTA: cuántos market caps quedan sin resolver, porque
  // cada uno es un profile2 de Finnhub contra un tier de 60/min.
  const sinMcap = Object.entries(known).filter(([, v]) => !Number.isFinite(v.marketCap)).map(([k]) => k);
  ok(sinMcap.length === 2 && sinMcap.includes('DAY1') && sinMcap.includes('DAY2'),
    'SOLO los nombres DEL DÍA pagan un profile2 de Finnhub: 600 profile2 serían DIEZ MINUTOS contra un tier de 60/min, y la función tiene 300s',
    `${sinMcap.length} pendientes: ${sinMcap.join(',')}`);

  ok(u.admission.market_cap_assumed_by_index === 600 && u.admission.market_cap_measured === 2,
    'y el reparto queda journaleado: 600 supuestos por índice, 2 medidos',
    JSON.stringify({ sup: u.admission.market_cap_assumed_by_index, med: u.admission.market_cap_measured }));
  ok(/suposición|construcción del índice/.test(u.admission.market_cap_note || ''),
    'con la nota que dice que es una SUPOSICIÓN declarada, no un dato medido');
  ok(/PRECIO y el VOLUMEN se miden de verdad/.test(u.admission.market_cap_note || ''),
    'y que lo que NO se asume es el precio ni el volumen — ésa es la demora del comité que el Arena no hereda');
}

console.log('\n── un nombre sin precio NO se admite por defecto ──');
{
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      // Solo la mitad de los nombres tiene barras.
      getPriceAndDollarVolume: async (syms) => Object.fromEntries(
        syms.slice(0, 300).map((s2) => [s2, { price: 100, dollarVolume: 5e8, sessions: 20 }])),
      resolveAdmission: async (syms, opts) => Object.fromEntries(syms.map((s2) => [s2, { ...(opts.known || {})[s2] }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(u.counts.admitidos === 300,
    'los 300 sin barras NO entran: sin precio no hay admisión posible (fail closed, la cicatriz DDDX)', String(u.counts.admitidos));
  ok(u.admission.prices_missing === 300, 'y el conteo de los que no resolvieron precio viaja al journal', String(u.admission.prices_missing));
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

// ═══════════════════════════════════════════════════════════════
// LA LISTA SE PERSISTE SOLA — nadie tiene que commitear nada.
//
// El arranque de B1 NO puede depender de que alguien corra `jq` en su terminal
// y suba dos archivos: eso convierte un cron en un ritual manual, y un ritual
// manual que nadie hace es una fuente que no existe. La lista se escribe en
// Neon en el mismo paso en que se baja de FMP, y el cron de las 13:00 UTC la
// refresca solo.
//
// Lo que se fija acá es que el ciclo cierra sin intervención: Neon vacío → se
// baja → se guarda → mañana se lee de ahí → a los 7 días se vuelve a bajar.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el ciclo se cierra solo: bajar → guardar → leer → refrescar ──');
{
  // La "base de datos": un objeto que sobrevive entre llamadas, como Neon.
  const neon = {};
  let llamadasAFmp = 0;
  const deps = {
    fetchConstituents: async (index) => {
      llamadasAFmp++;
      return { index, source: 'fmp', built_at: new Date(AHORA).toISOString(), symbols: listaDe(index) };
    },
    readStored: async (index) => neon[index] || null,
    writeStored: async (index, snap) => { neon[index] = { ...snap, index, source: 'neon' }; return true; },
    readStatic: async () => null,
  };
  let AHORA = HOY.getTime();

  // Día 1: Neon vacío. El cron baja y guarda, sin que nadie toque nada.
  const d1 = await resolveConstituents('sp500', { now: new Date(AHORA), deps });
  ok(d1.source === 'fmp' && d1.stored === true,
    'Neon vacío: la primera corrida baja de FMP y la GUARDA en el mismo paso', `${d1.source}/stored=${d1.stored}`);
  ok(neon.sp500 && neon.sp500.symbols.length === 500,
    'la lista quedó persistida — sobrevive al deploy sin pasar por el repo', String(neon.sp500 && neon.sp500.symbols.length));

  // Día 2: la corrida siguiente NO vuelve a FMP.
  AHORA += 86400000;
  const d2 = await resolveConstituents('sp500', { now: new Date(AHORA), deps });
  ok(llamadasAFmp === 1 && d2.source === 'neon',
    'al día siguiente se lee de Neon: no se gasta cuota de FMP para recibir el mismo archivo', `fmp=${llamadasAFmp} src=${d2.source}`);
  ok(d2.stored === true, 'y sigue reportándose como persistida');

  // Día 9: vencida por EDAD → se refresca sola, sin cron especial ni humano.
  AHORA += 8 * 86400000;
  const d9 = await resolveConstituents('sp500', { now: new Date(AHORA), deps });
  ok(llamadasAFmp === 2 && d9.source === 'fmp' && d9.refreshed === true,
    'a los 9 días el refresco semanal dispara SOLO y vuelve a guardar', `fmp=${llamadasAFmp} src=${d9.source}`);

  // Y si la escritura falla, se dice: la lista de hoy sirve igual, pero mañana
  // se va a volver a pagar la cuota. Es un aviso, no una caída.
  const dFalla = await resolveConstituents('nasdaq100', {
    now: new Date(AHORA), deps: { ...deps, writeStored: async () => false },
  });
  ok(dFalla.source === 'fmp' && dFalla.stored === false,
    'una escritura fallida NO rompe la corrida, pero queda marcada (`stored: false`)', `stored=${dFalla.stored}`);
}

console.log('\n── el JSON del repo es opcional, no un requisito ──');
{
  // El seed vacío NO cuenta como respaldo, y eso es lo que hace que estar vacío
  // sea inofensivo: con FMP o con Neon vivos, el escalón 3 no se consulta nunca.
  const conFmp = await resolveConstituents('sp500', {
    now: HOY,
    deps: depsBase({
      fmp: (i) => ({ index: i, source: 'fmp', built_at: HOY.toISOString(), symbols: listaDe(i) }),
      repo: null,
    }),
  });
  ok(conFmp.source === 'fmp' && conFmp.symbols.length === 500,
    'con FMP arriba y el JSON del repo VACÍO, el universo sale completo igual');
  const conNeon = await resolveConstituents('sp500', {
    now: HOY,
    deps: depsBase({ fmp: null, neon: { index: 'sp500', source: 'neon', built_at: HOY.toISOString(), symbols: sp500 }, repo: null }),
  });
  ok(conNeon.source === 'neon' && conNeon.symbols.length === 500,
    'y con FMP caído pero Neon cargado, tampoco hace falta el repo');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
