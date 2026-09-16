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

// ── CATÁLOGO DE ALPACA PARA LOS TESTS ────────────────────────────────
// Desde que el canal del día filtra por INSTRUMENTO, `buildUniverse` necesita
// el catálogo de Alpaca — y sin él NADA pasa (fail closed, a propósito). Los
// bloques que no están probando ESE filtro usan un catálogo permisivo: un Proxy
// que responde "acción común" a lo que sea que se le pregunte, sin tener que
// enumerar 600 símbolos.
const catalogoTodoComun = {
  count: 99999, from_cache: false,
  assets: new Proxy({}, {
    get: (_, sym) => (typeof sym === 'string'
      ? { symbol: sym, class: 'us_equity', status: 'active', tradable: true, name: sym + ' Common Stock' }
      : undefined),
  }),
};
const conCatalogo = (deps) => ({ cargarCatalogo: async () => catalogoTodoComun, ...deps });

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
    // La foto guardada lleva SECTORES: este caso es sobre una lista VIEJA, no
    // sobre una incompleta. Sin ellos, el que responde es el otro camino
    // (`sin_sectores`) y el test mediría algo distinto del que dice medir.
    deps: depsBase({ fmp: null, neon: { index: 'sp500', source: 'neon', built_at: hace10, symbols: sp500, sectores: { AAPL: 'Information Technology' } } }),
  });
  ok(r.source === 'neon' && r.symbols.length === 500, 'se usa la lista guardada', r.source);
  ok(r.stale === true && r.age_days === 10, 'marcada como vieja, con la edad EXACTA', `stale=${r.stale} age=${r.age_days}`);
  ok(/sesgo declarado/.test(r.note || ''), 'y la nota dice que es un sesgo declarado, no un dato fresco', r.note);

  // Y el caso gemelo: una lista VIEJA que además viene SIN sectores no se
  // reporta igual, porque rompe R6, `sector()` y el screener a la vez.
  const sinSec = await resolveConstituents('sp500', {
    now: HOY,
    deps: depsBase({ fmp: null, neon: { index: 'sp500', source: 'neon', built_at: hace10, symbols: sp500, sectores: {} } }),
  });
  ok(sinSec.sin_sectores === true && /No son tres bugs — es este/.test(sinSec.note || ''),
    'una lista sin sectores se reporta por su propio problema, no como "vieja"', (sinSec.note || '').slice(-50));
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
  // El stub imita una Response DE VERDAD: `ok`, `status` y `text()`. Antes solo
  // tenía `json()`, y cuando `fetchConstituents` pasó a leer el cuerpo crudo
  // —para poder guardar los primeros bytes, que es donde FMP explica el
  // rechazo— este bloque siguió en verde POR LA RAZÓN EQUIVOCADA: el stub
  // devolvía `undefined`, el parseo fallaba y el null venía de ahí y no del
  // piso de cordura. Un stub que miente menos que la API real es un test que
  // prueba otra cosa.
  const resp200 = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const doceNombres = resp200(Array.from({ length: 12 }, (_, i) => ({ symbol: 'X' + i })));
  const diagCorta = [];
  const r = await fetchConstituents('sp500', { apiKey: 'k', fetchImpl: doceNombres, diag: diagCorta });
  ok(r === null, '12 nombres para el S&P 500 se RECHAZA: es un error de la API, no el índice');
  ok(diagCorta.every((d) => d.reason === 'lista_corta'),
    '...y se rechaza POR ESO, no por un parseo que falló de casualidad',
    JSON.stringify(diagCorta.map((d) => d.reason)));

  const quinientos = resp200(sp500.map((s) => ({ symbol: s })));
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

console.log(`\n── 4) el tope de ${MOVERS_MAX} se gasta SOLO en nombres nuevos ──`);
{
  // 30 movers: 20 YA están en el S&P 500, 10 son nuevos. Más 120 most-actives
  // nuevos, para que el tope muerda.
  const yaEstan = sp500.slice(0, 20);
  const nuevos = Array.from({ length: 130 }, (_, i) => 'NEW' + i);
  const u = await buildUniverse({
    now: HOY, creds: {},
    deps: {
      ...conIndices(),
      cargarCatalogo: async () => catalogoTodoComun,
      getMovers: async () => ({ gainers: yaEstan.map((s) => ({ symbol: s, price: 50, percent_change: 5 })), losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: nuevos.map((s) => ({ symbol: s, volume: 1e7 })), by: 'volume', last_updated: null }),
      resolveAdmission: admisionTodo,
    },
  });
  ok(u.counts.indices === 600, 'los índices aportan 600 nombres', String(u.counts.indices));
  ok(u.counts.del_dia_nuevos === MOVERS_MAX,
    `del día entran exactamente ${MOVERS_MAX}: el tope aplica a los NUEVOS`, String(u.counts.del_dia_nuevos));
  ok(u.counts.del_dia_brutos === 150, 'aunque el día trajo 150 nombres en bruto', String(u.counts.del_dia_brutos));
  ok(u.counts.admitidos === 600 + MOVERS_MAX,
    `600 + ${MOVERS_MAX} — los 20 que ya estaban NO gastaron cupo`, String(u.counts.admitidos));
  ok(u.from_index.length === 600 && u.from_day.length === MOVERS_MAX, 'y se sabe cuál vino de dónde', `${u.from_index.length}/${u.from_day.length}`);
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
      cargarCatalogo: async () => catalogoTodoComun,
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
      cargarCatalogo: async () => catalogoTodoComun,
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
      cargarCatalogo: async () => catalogoTodoComun,
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
      cargarCatalogo: async () => catalogoTodoComun,
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
      cargarCatalogo: async () => catalogoTodoComun,
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
      cargarCatalogo: async () => catalogoTodoComun,
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

// ═══════════════════════════════════════════════════════════════
// "SIN FMP" TIENE QUE DECIR POR QUÉ.
//
// EL REPORTE QUE LO ORIGINA: la key llevaba dos horas puesta en Vercel y el
// endpoint seguía diciendo "Sin FMP". No había forma de saber si la env var no
// llegaba, si la rechazaban, si la cuota estaba agotada o si el endpoint era el
// equivocado — porque `fetchConstituents` devolvía `null` pelado en SEIS
// situaciones distintas y ninguna llegaba a `errors`.
//
// Un fallo que no se puede distinguir de otros cinco no es un fallo: es un
// agujero. Acá se fija que cada uno se nombre.
// ═══════════════════════════════════════════════════════════════
const { fetchConstituents, motivoFmp, FMP_APIS } = await import('../api/_lib/arena-universe.js');

// Respuesta falsa de fetch con el mínimo que el código toca.
const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const listaBuena = (n, pre = 'A') => Array.from({ length: n }, (_, i) => ({ symbol: `${pre}${String(i).padStart(3, '0')}` }));

console.log('\n── cada causa de fallo se NOMBRA ──');
{
  // (a) sin key.
  let diag = [];
  let r = await fetchConstituents('sp500', { apiKey: '', diag, fetchImpl: async () => resp(200, []) });
  ok(r === null && diag.length === 1 && diag[0].reason === 'sin_key',
    'sin key: se dice `sin_key`, no un null mudo', JSON.stringify(diag));
  ok(/entorno/i.test(diag[0].detail || ''),
    'y el detalle avisa lo de los entornos de Vercel, que es la causa más común',
    diag[0].detail);

  // (b) HTTP de error, con el cuerpo que FMP manda.
  diag = [];
  r = await fetchConstituents('sp500', { apiKey: 'k', diag, fetchImpl: async () => resp(403, { 'Error Message': 'Legacy Endpoint: please use /stable' }) });
  ok(r === null && diag.every((d) => d.reason === 'http_error' && d.status === 403),
    'HTTP 403: se dice el status, no "no contestó"', JSON.stringify(diag.map((d) => `${d.api}:${d.status}`)));
  ok(diag.some((d) => /Legacy Endpoint/.test(d.body_sample || '')),
    'y los primeros bytes del cuerpo viajan: ahí es donde FMP explica el rechazo',
    diag[0].body_sample);

  // (c) EL QUE MÁS ENGAÑA: HTTP 200 con un objeto de error.
  diag = [];
  r = await fetchConstituents('sp500', { apiKey: 'k', diag, fetchImpl: async () => resp(200, { 'Error Message': 'Limit Reach. Please upgrade your plan' }) });
  ok(r === null && diag.every((d) => d.reason === 'fmp_error_message'),
    'HTTP 200 con {"Error Message"}: se lee como error de FMP, no como "FMP no contestó"',
    JSON.stringify(diag.map((d) => d.reason)));
  ok(diag.every((d) => /Limit Reach/.test(d.fmp_message || '')),
    'y el mensaje de FMP se extrae tal cual — "cuota agotada" es accionable, "sin FMP" no',
    diag[0].fmp_message);

  // (d) lista corta: el piso de cordura, pero ahora dice cuánto recibió.
  diag = [];
  r = await fetchConstituents('sp500', { apiKey: 'k', diag, fetchImpl: async () => resp(200, listaBuena(12)) });
  ok(r === null && diag.every((d) => d.reason === 'lista_corta' && d.recibidos === 12),
    '12 nombres para el S&P 500: `lista_corta` CON el número, no un rechazo mudo',
    JSON.stringify(diag.map((d) => `${d.recibidos}<${d.minimo}`)));

  // (e) JSON roto.
  diag = [];
  r = await fetchConstituents('sp500', { apiKey: 'k', diag, fetchImpl: async () => resp(200, '<html>502 Bad Gateway</html>') });
  ok(r === null && diag.every((d) => d.reason === 'json_invalido'),
    'un cuerpo que no es JSON se nombra como tal (y la muestra delata el HTML)',
    diag[0].body_sample);

  // (f) timeout / red.
  diag = [];
  r = await fetchConstituents('sp500', { apiKey: 'k', diag, fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); } });
  ok(r === null && diag.every((d) => d.reason === 'timeout'),
    'un timeout se distingue de un rechazo: no es lo mismo esperar que ser rechazado',
    JSON.stringify(diag.map((d) => d.reason)));
}

console.log('\n── las dos APIs de FMP, y cuál contestó ──');
{
  ok(FMP_APIS.length === 2 && FMP_APIS.some((a) => a.id === 'stable') && FMP_APIS.some((a) => a.id === 'v3'),
    'se conocen las dos generaciones vivas de FMP (stable y v3)');

  // Una key nueva: v3 la rechaza, stable la acepta. El código no tiene que
  // saber cuál de antemano.
  const diag = [];
  const r = await fetchConstituents('sp500', {
    apiKey: 'k', diag,
    fetchImpl: async (url) => (/\/stable\//.test(url)
      ? resp(200, listaBuena(503))
      : resp(403, { 'Error Message': 'Legacy Endpoint' })),
  });
  ok(r && r.symbols.length === 503, 'si una API la acepta, el universo sale completo', r && r.symbols.length);
  ok(r && r.fmp_api === 'stable',
    'y se REPORTA cuál contestó: sin eso, "anduvo" no dice cuál de las dos sirve', r && r.fmp_api);

  // El orden no puede importar: con la key vieja pasa al revés.
  const diag2 = [];
  const r2 = await fetchConstituents('nasdaq100', {
    apiKey: 'k', diag: diag2,
    fetchImpl: async (url) => (/\/api\/v3\//.test(url)
      ? resp(200, listaBuena(101, 'N'))
      : resp(403, { 'Error Message': 'Exclusive Endpoint' })),
  });
  ok(r2 && r2.fmp_api === 'v3',
    'con una key vieja gana v3 — se prueban las dos y no se adivina', r2 && r2.fmp_api);
  ok(diag2.some((d) => d.api === 'stable' && !d.ok) && diag2.some((d) => d.api === 'v3' && d.ok),
    'y el diagnóstico guarda el intento fallido TAMBIÉN cuando el otro funcionó',
    JSON.stringify(diag2.map((d) => `${d.api}:${d.ok}`)));
}

console.log('\n── la key nunca se journalea ──');
{
  const diag = [];
  await fetchConstituents('sp500', { apiKey: 'SECRETO-NO-PUBLICAR', diag, fetchImpl: async () => resp(403, 'nope') });
  const texto = JSON.stringify(diag);
  ok(!texto.includes('SECRETO-NO-PUBLICAR'),
    'la key viaja en la query string pero NO aparece en el diagnóstico: se guarda la URL sin el ?apikey=',
    texto.slice(0, 160));
  ok(diag.every((d) => d.url && !d.url.includes('apikey')),
    'ninguna URL journaleada lleva el parámetro de la key');
}

console.log('\n── el resumen en una frase ──');
{
  const diag = [
    { index: 'sp500', api: 'stable', ok: false, reason: 'http_error', status: 403, fmp_message: 'Legacy Endpoint' },
    { index: 'sp500', api: 'v3', ok: false, reason: 'lista_corta', recibidos: 12, minimo: 400 },
    { index: 'nasdaq100', api: 'v3', ok: true, status: 200 },
  ];
  const m = motivoFmp(diag, 'sp500');
  ok(/stable/.test(m) && /403/.test(m) && /v3/.test(m) && /12<400/.test(m),
    'si las dos APIs fallan DISTINTO, se dicen las dos: son pistas diferentes', m);
  ok(motivoFmp(diag, 'nasdaq100') === 'sin_intentos',
    'un índice que no falló no inventa un motivo', motivoFmp(diag, 'nasdaq100'));
}

// ═══════════════════════════════════════════════════════════════
// EL CANAL DEL DÍA: 100 CANDIDATOS, CERO ADMITIDOS.
//
// Lo reportado el 2026-09-15: de 100 candidatos del día, 69 rebotaron como
// `data_unavailable` y eran warrants, rights, preferentes y unidades.
//
// El tope de 100 se gastaba ANTES de saber qué eran, así que el cupo se iba en
// instrumentos que no son el universo del Arena — y encima cada uno se llevaba
// una llamada a Finnhub para pedirle el market cap de un warrant.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el filtro de instrumento corre ANTES del tope ──');
{
  const comun = (s2) => ({ symbol: s2, class: 'us_equity', status: 'active', tradable: true, name: s2 + ' Inc Common Stock' });
  const warrant = (s2) => ({ symbol: s2, class: 'us_equity', status: 'active', tradable: true, name: s2 + ' Acquisition Warrant' });

  // 30 acciones reales y 70 warrants: el reparto que se vio en producción.
  const acciones = Array.from({ length: 30 }, (_, i) => 'REAL' + i);
  const basura = Array.from({ length: 70 }, (_, i) => 'WRNT' + i);
  const catalogo = {
    count: 100,
    assets: Object.fromEntries([...acciones.map(comun), ...basura.map(warrant)].map((a) => [a.symbol, a])),
  };

  const u = await buildUniverse({
    now: HOY, moversMax: 100,
    deps: {
      cargarCatalogo: async () => catalogo,
      fetchConstituents: async () => null,
      fetchDesdeEtf: async () => null,
      readStored: async () => null,
      readStatic: async () => null,
      writeStored: async () => true,
      getMovers: async () => ({ gainers: [...acciones, ...basura].map((s2) => ({ symbol: s2, price: 40, percent_change: 6 })), losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { price: 40, dollarVolume: 5e7 }])),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { symbol: s2, price: 40, dollarVolume: 5e7, marketCap: 5e9 }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });

  ok(u.counts.del_dia_brutos === 100, 'entraron los 100 brutos del screener', String(u.counts.del_dia_brutos));
  ok(u.counts.del_dia_no_comunes === 70,
    'los 70 warrants se descartan por NO SER ACCIONES, antes de tocar el tope', String(u.counts.del_dia_no_comunes));
  ok(u.counts.del_dia_nuevos === 30 && u.counts.admitidos === 30,
    'y el cupo se gasta en las 30 reales — antes se gastaba en los warrants y quedaban 0',
    `nuevos=${u.counts.del_dia_nuevos} admitidos=${u.counts.admitidos}`);
  ok(u.instrumento.por_clase.warrant === 70,
    'el diagnóstico dice DE QUÉ está hecho el ruido: 70 warrants', JSON.stringify(u.instrumento.por_clase));
  ok(u.instrumento_rechazados.every((x) => x.reason === 'no_es_comun'),
    'ninguno sale como `data_unavailable`: el motivo del rechazo ya no manda a buscar al lugar equivocado');
}

console.log('\n── sin catálogo de Alpaca: el canal del día se apaga, DECLARADO ──');
{
  const u = await buildUniverse({
    now: HOY, moversMax: 100,
    deps: {
      cargarCatalogo: async () => ({ assets: null, error: 'Alpaca 500' }),
      fetchConstituents: async () => null,
      fetchDesdeEtf: async (i) => ({ index: i, source: 'etf', built_at: HOY.toISOString(), symbols: i === 'sp500' ? sp500 : nq100 }),
      readStored: async () => null, readStatic: async () => null, writeStored: async () => true,
      getMovers: async () => ({ gainers: [{ symbol: 'DAY1', price: 40, percent_change: 9 }], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { price: 40, dollarVolume: 5e7 }])),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { symbol: s2, price: 40, dollarVolume: 5e7, marketCap: 5e9 }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(u.counts.del_dia_nuevos === 0, 'sin catálogo, ningún nombre del día entra: fail closed');
  ok(u.counts.indices === 600 && u.counts.admitidos === 600,
    'pero los índices siguen entrando: el tablero NO se queda vacío por esto', String(u.counts.admitidos));
  ok(/falla NUESTRA/i.test(u.instrumento.note || ''),
    'y se dice que la culpa es nuestra, no de los nombres', u.instrumento.note);
}

console.log('\n── las tenencias del ETF son la fuente D1; FMP es respaldo opcional ──');
{
  let pidioFmp = false;
  const u = await buildUniverse({
    now: HOY, moversMax: 0,
    deps: {
      cargarCatalogo: async () => catalogoTodoComun,
      fetchDesdeEtf: async (i) => ({ index: i, source: 'etf', etf: i === 'sp500' ? 'IVV' : 'QQQ', built_at: HOY.toISOString(), symbols: i === 'sp500' ? sp500 : nq100 }),
      fetchConstituents: async () => { pidioFmp = true; return null; },
      readStored: async () => null, readStatic: async () => null, writeStored: async () => true,
      getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { price: 40, dollarVolume: 5e7 }])),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { symbol: s2, price: 40, dollarVolume: 5e7, marketCap: 5e9 }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(u.counts.indices === 600 && u.indices.sp500.source === 'etf',
    'los 600 nombres salen de las tenencias de IVV y QQQ, sin key y sin plan de pago',
    `${u.counts.indices} · ${u.indices.sp500.source}`);
  ok(pidioFmp === false,
    'y a FMP NI SE LE PREGUNTA cuando el ETF contestó: es respaldo, no la fuente');
}

console.log('\n── Finnhub: "0 admitidos" tiene que decir de quién es la culpa ──');
{
  const { resolveAdmission, _resetAdmissionCache, FINNHUB_CALL_BUDGET } = await import('../api/_lib/arena-admission.js');
  ok(FINNHUB_CALL_BUDGET === 40,
    'el techo de llamadas a profile2 por lote está declarado (el tier gratis corta a 60/min)', String(FINNHUB_CALL_BUDGET));

  // 60 nombres del día con un presupuesto de 5: los 55 que sobran NO se piden.
  _resetAdmissionCache();
  const diag = [];
  const syms = Array.from({ length: 60 }, (_, i) => 'SYM' + i);
  await resolveAdmission(syms, {
    finnhubKey: 'k', now: HOY, diag, maxFinnhub: 5,
    known: Object.fromEntries(syms.map((s2) => [s2, { price: 40, dollarVolume: 5e7 }])),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ marketCapitalization: 5000 }) }),
  });
  const porRazon = diag.reduce((a, d) => { const k = d.ok ? 'ok' : d.reason; a[k] = (a[k] || 0) + 1; return a; }, {});
  ok(porRazon.ok === 5 && porRazon.rate_budget === 55,
    'con presupuesto 5: 5 consultados y 55 marcados `rate_budget` — NO "sin datos"', JSON.stringify(porRazon));

  // El 429, que es el que se veía como "Finnhub no tiene estos nombres".
  _resetAdmissionCache();
  const diag2 = [];
  await resolveAdmission(['AAA', 'BBB'], {
    finnhubKey: 'k', now: HOY, diag: diag2,
    known: { AAA: { price: 40, dollarVolume: 5e7 }, BBB: { price: 40, dollarVolume: 5e7 } },
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  ok(diag2.length === 2 && diag2.every((d) => d.reason === 'rate_limit'),
    'un 429 se nombra `rate_limit`: es un límite NUESTRO, no que el nombre no exista',
    JSON.stringify(diag2.map((d) => d.reason)));

  // Y la distinción fina: Finnhub contestó pero no cubre el nombre.
  _resetAdmissionCache();
  const diag3 = [];
  await resolveAdmission(['ZZZ'], {
    finnhubKey: 'k', now: HOY, diag: diag3,
    known: { ZZZ: { price: 40, dollarVolume: 5e7 } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  ok(diag3[0].reason === 'sin_cobertura',
    '"no lo tiene" se distingue de "no nos dejó pedir": son problemas distintos', diag3[0].reason);
}

// ═══════════════════════════════════════════════════════════════
// UN ÍNDICE OPCIONAL QUE FALTA NO ES UNA FALLA.
//
// El Nasdaq 100 arranca sin URL verificada (Invesco devolvió HTML y no hay otra
// probada desde este entorno). Que falte NO puede leerse igual que si faltara el
// S&P 500: uno es una decisión tomada, el otro es el universo roto.
//
// Si se mezclaran, `partial` estaría encendido TODOS los días — y una bandera
// que está siempre encendida deja de ser una bandera. El día que de verdad se
// caiga el S&P 500, nadie lo notaría entre el ruido.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el Nasdaq 100 ausente no degrada ni ensucia ──');
{
  const soloSp = {
    cargarCatalogo: async () => catalogoTodoComun,
    fetchDesdeEtf: async (i) => (i === 'sp500'
      ? { index: i, source: 'etf', etf: 'IVV', built_at: HOY.toISOString(), symbols: sp500 }
      : null),
    fetchConstituents: async () => null,
    readStored: async () => null, readStatic: async () => null, writeStored: async () => true,
    getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
    getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
    getPriceAndDollarVolume: async (syms) => Object.fromEntries(syms.map((x) => [x, { price: 40, dollarVolume: 5e7 }])),
    resolveAdmission: async (syms) => Object.fromEntries(syms.map((x) => [x, { symbol: x, price: 40, dollarVolume: 5e7, marketCap: 5e9 }])),
    getFiftyTwoWeek: async () => ({}),
  };
  const u = await buildUniverse({ now: HOY, moversMax: 0, deps: soloSp });

  ok(u.counts.admitidos === 500,
    'con solo el S&P 500 el universo sale con sus 500 nombres: NO bloquea', String(u.counts.admitidos));
  ok(u.universe_source === 'etf',
    'y la fuente dice `etf`, NO `partial` — el opcional no cuenta para el cálculo', u.universe_source);
  ok(u.indices.nasdaq100.opcional === true && u.indices.nasdaq100.source === 'none',
    'el Nasdaq 100 queda VISIBLE como ausente y marcado opcional (no desaparece del reporte)',
    JSON.stringify({ op: u.indices.nasdaq100.opcional, src: u.indices.nasdaq100.source }));
  // El assert original buscaba que la nota NO contuviera "error" — y fallaba
  // con la nota "No es un error", que dice exactamente lo correcto. Buscar la
  // AUSENCIA de una palabra es frágil: lo que importa es lo que la nota AFIRMA.
  ok(/OPCIONAL/i.test(u.indices.nasdaq100.note || '') && /no es un error/i.test(u.indices.nasdaq100.note || ''),
    'y su nota lo dice con todas las letras: es opcional y NO es un error', u.indices.nasdaq100.note);
  ok(/ARENA_HOLDINGS_URL_NASDAQ100/.test(u.indices.nasdaq100.note || ''),
    'nombrando la env var exacta, que se toma sin deploy');
  ok(!u.errors.nasdaq100 && Object.keys(u.errors).length === 0,
    '`errors` queda LIMPIO: una decisión no es un error', JSON.stringify(u.errors));

  // Y el S&P 500 caído SÍ tiene que degradar — si no, el opcional habría
  // apagado la señal para todos.
  const uRoto = await buildUniverse({
    now: HOY, moversMax: 0,
    deps: { ...soloSp, fetchDesdeEtf: async () => null },
  });
  ok(uRoto.universe_source !== 'etf',
    'pero si se cae el S&P 500 —que es obligatorio— la fuente SÍ degrada: la señal sigue viva', uRoto.universe_source);
}

console.log('\n── cuánto aportaría el Nasdaq 100, medido ──');
{
  // La mayoría de sus miembros también están en el S&P 500. "Nos falta el 100"
  // NO significa "nos faltan 100 nombres", y la decisión de ir a buscar la URL
  // de QQQ merece un número en vez de una intuición.
  const compartidos = sp500.slice(0, 80);
  const propios = Array.from({ length: 20 }, (_, i) => 'NDXONLY' + i);
  const u = await buildUniverse({
    now: HOY, moversMax: 0,
    deps: {
      cargarCatalogo: async () => catalogoTodoComun,
      fetchDesdeEtf: async (i) => ({ index: i, source: 'etf', built_at: HOY.toISOString(), symbols: i === 'sp500' ? sp500 : [...compartidos, ...propios] }),
      fetchConstituents: async () => null,
      readStored: async () => null, readStatic: async () => null, writeStored: async () => true,
      getMovers: async () => ({ gainers: [], losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => Object.fromEntries(syms.map((x) => [x, { price: 40, dollarVolume: 5e7 }])),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((x) => [x, { symbol: x, price: 40, dollarVolume: 5e7, marketCap: 5e9 }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(u.indices.solo_en.nasdaq100 === 20,
    'el journal dice cuántos nombres aporta el Nasdaq 100 que el S&P 500 no tiene', String(u.indices.solo_en.nasdaq100));
  ok(u.indices.solo_en.en_ambos === 80,
    'y cuántos comparten: la coincidencia es el que hace que arrancar con uno sea razonable', String(u.indices.solo_en.en_ambos));
}

console.log('\n── varias URLs candidatas: la primera que sirva ──');
{
  const { fetchHoldings } = await import('../api/_lib/etf-holdings.js');
  const pedidas = [];
  const r = await fetchHoldings('sp500', {
    source: { etf: 'IVV', proveedor: 'iShares', urls: ['https://a.test/uno.csv', 'https://b.test/dos.csv'] },
    fetchImpl: async (url) => {
      pedidas.push(url);
      return /uno/.test(url)
        ? { ok: true, status: 200, text: async () => '<!DOCTYPE html><html>se movió</html>' }
        : { ok: true, status: 200, text: async () => 'Ticker,Name,Asset Class\nAAPL,Apple Inc,Equity\nMSFT,Microsoft,Equity' };
    },
  });
  ok(pedidas.length === 2 && r.symbols.length === 2,
    'si la primera devuelve HTML se prueba la siguiente, y esa gana', JSON.stringify(r.symbols));
  ok(r.diagnostics.intentos.length === 2 && r.diagnostics.intentos[0].reason === 'html_no_csv',
    'el intento fallido NO se pierde: queda en `intentos` con su motivo',
    JSON.stringify(r.diagnostics.intentos.map((x) => x.reason || 'ok')));
  ok(r.diagnostics.url_host === 'b.test',
    'y se dice CUÁL sirvió — sin eso, "anduvo" no dice cuál de las candidatas usar', r.diagnostics.url_host);
}

// EL PISO DE VOLUMEN SE ESTABA MIDIENDO SOBRE EL FEED EQUIVOCADO.
//
// EL BUG (2026-09-15): 218 rechazos por volumen, con AIG entre ellos a
// "$8.7M/día". AIG negocia cientos de millones. El volumen salía del feed IEX
// —UNA bolsa, ~2-3% del consolidado— así que el piso de $10M se aplicaba sobre
// el 2-3% del volumen real: en la práctica pedía ~$400M consolidados.
//
// El filtro no estaba midiendo liquidez: estaba midiendo cuota de mercado de
// IEX. Y lo traicionero es que el PRECIO de IEX está bien — solo el volumen es
// una fracción, así que todo se veía correcto salvo el número que decidía.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el piso de volumen se ajusta al FEED que contestó ──');
{
  const { reglasParaFeed, isAdmissible, MIN_DOLLAR_VOLUME_POR_FEED } = await import('../api/_lib/arena-admission.js');

  const sip = reglasParaFeed('sip');
  const iex = reglasParaFeed('iex');
  ok(sip.min_dollar_volume === 10_000_000, 'con SIP (consolidado) el piso es el real: $10M/día', String(sip.min_dollar_volume));
  ok(iex.min_dollar_volume === 300_000,
    'con IEX el piso baja a $0.3M ≈ $10M consolidados asumiendo ~3%', String(iex.min_dollar_volume));

  // EL CASO EXACTO DEL REPORTE.
  const aig = { symbol: 'AIG', price: 80, marketCap: 5e10, dollarVolume: 8.7e6 };
  ok(!isAdmissible(aig, sip).ok === false || isAdmissible(aig, iex).ok,
    'AIG con $8.7M sobre IEX ahora ENTRA', JSON.stringify(isAdmissible(aig, iex)));
  ok(isAdmissible(aig, iex).ok, 'AIG admitido con las reglas de IEX');

  // Y el piso sigue existiendo: bajarlo no puede volverlo decorativo.
  const microcap = { symbol: 'PENNY', price: 6, marketCap: 1.2e9, dollarVolume: 2e5 };
  ok(!isAdmissible(microcap, iex).ok,
    'un nombre que de verdad negocia $0.2M sobre IEX SIGUE afuera: se corrigió la unidad, no se apagó el filtro',
    isAdmissible(microcap, iex).reason);

  // Un feed que no conocemos NO afloja nada.
  const raro = reglasParaFeed('otro_feed');
  ok(raro.min_dollar_volume === 10_000_000,
    'un feed desconocido se queda con el piso consolidado: aflojar sin saber sobre qué se mide sería aflojar a ciegas',
    String(raro.min_dollar_volume));

  ok(/APROXIMACIÓN/i.test(iex.volume_note || '') && /no significa/i.test(iex.volume_note || ''),
    'la nota declara que el factor es aproximado y que NO significa que el Arena opere microcaps', iex.volume_note);
  ok(MIN_DOLLAR_VOLUME_POR_FEED.delayed_sip === 10_000_000, 'delayed_sip también es consolidado');
}

console.log('\n── SIP primero, IEX de respaldo, y se dice cuál contestó ──');
{
  const { getPriceAndDollarVolume, FEED_FALLBACK_STATUS } = await import('../api/_lib/alpaca.js');
  const barra = (sym) => ({ t: '2026-09-10T00:00:00Z', c: 100, v: 1e6 });

  // Cuenta SIN plan de datos: SIP devuelve 403 y se baja a IEX.
  const pedidos = [];
  const anterior = process.env.ALPACA_DATA_FEED;
  delete process.env.ALPACA_DATA_FEED;
  global.fetch = async (url) => {
    pedidos.push(/feed=sip/.test(url) ? 'sip' : 'iex');
    if (/feed=sip/.test(url)) return { ok: false, status: 403, text: async () => '{"message":"subscription does not permit querying recent SIP data"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ bars: { AIG: [barra('AIG'), barra('AIG')] } }) };
  };
  const r = await getPriceAndDollarVolume(['AIG'], { creds: { key: 'k', secret: 's' }, now: new Date('2026-09-15T18:00:00Z') });
  ok(pedidos[0] === 'sip' && pedidos[1] === 'iex',
    'se intenta SIP primero y recién después IEX', JSON.stringify(pedidos));
  ok(r.feed === 'iex' && r.data.AIG,
    'y el resultado DICE que vino de IEX — sin eso, el piso se aplicaría sobre la unidad equivocada, que es el bug entero',
    JSON.stringify({ feed: r.feed }));
  ok(r.intentos.length === 2 && r.intentos[0].status === 403,
    'el intento fallido queda registrado con su status', JSON.stringify(r.intentos.map((x) => `${x.feed}:${x.status || 'ok'}`)));

  // Un 500 NO es "no tenés el plan": reintentar con otro feed taparía una caída.
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  let lanzo = false;
  try { await getPriceAndDollarVolume(['AIG'], { creds: { key: 'k', secret: 's' } }); } catch { lanzo = true; }
  ok(lanzo, 'un 500 se propaga en vez de caer a IEX: reintentar taparía una caída de Alpaca');
  ok(FEED_FALLBACK_STATUS.has(403) && !FEED_FALLBACK_STATUS.has(500),
    'la lista de status que justifican el fallback está acotada y declarada');
  if (anterior === undefined) delete process.env.ALPACA_DATA_FEED; else process.env.ALPACA_DATA_FEED = anterior;
}

console.log('\n── el canal del día: los MÁS LÍQUIDOS, no los primeros ──');
{
  // El orden viejo cortaba a los primeros N del screener, y "los primeros N" no
  // quería decir nada: era el orden en que el screener los devolvió. Encima
  // cada uno gastaba un profile2 de Finnhub, y el tier gratis corta a 60/min.
  const volumenes = { LIQ1: 9e8, LIQ2: 8e8, LIQ3: 7e8, CHICO1: 1e6, CHICO2: 5e5 };
  const orden = ['CHICO1', 'LIQ3', 'CHICO2', 'LIQ1', 'LIQ2'];   // como los devuelve el screener
  const u = await buildUniverse({
    now: HOY, moversMax: 3,
    deps: {
      cargarCatalogo: async () => catalogoTodoComun,
      fetchDesdeEtf: async () => null, fetchConstituents: async () => null,
      readStored: async () => null, readStatic: async () => null, writeStored: async () => true,
      getMovers: async () => ({ gainers: orden.map((s2) => ({ symbol: s2, price: 40, percent_change: 5 })), losers: [], last_updated: null }),
      getMostActives: async () => ({ most_actives: [], by: 'volume', last_updated: null }),
      getPriceAndDollarVolume: async (syms) => ({
        feed: 'iex',
        data: Object.fromEntries(syms.map((s2) => [s2, { price: 40, dollarVolume: volumenes[s2] ?? 1e3 }])),
      }),
      resolveAdmission: async (syms) => Object.fromEntries(syms.map((s2) => [s2, { symbol: s2, price: 40, dollarVolume: volumenes[s2] ?? 1e3, marketCap: 5e9 }])),
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(u.from_day.length === 3 && ['LIQ1', 'LIQ2', 'LIQ3'].every((x) => u.from_day.includes(x)),
    'con tope 3 entran los TRES más líquidos, no los tres primeros que llegaron',
    JSON.stringify(u.from_day));
  ok(!u.from_day.includes('CHICO1'),
    'y CHICO1, que venía PRIMERO en la lista del screener, queda afuera por líquido, no por orden');
  ok(u.admission.feed === 'iex' && u.admission.rules.min_dollar_volume === 300_000,
    'el universo reporta el feed y las reglas EFECTIVAS, no las nominales',
    JSON.stringify({ feed: u.admission.feed, piso: u.admission.rules.min_dollar_volume }));
  ok(/IEX/.test(u.admission.volume_note || ''),
    'con la nota que explica sobre qué volumen se midió', u.admission.volume_note);
}

console.log('\n── el tope del día sale de la cuota de Finnhub ──');
{
  ok(MOVERS_MAX === 50,
    'son 50 y no 100 porque cada nombre del día paga un profile2 y el tier gratis corta a 60/min', String(MOVERS_MAX));
  const { FINNHUB_CALL_BUDGET } = await import('../api/_lib/arena-admission.js');
  ok(MOVERS_MAX <= 60 - FINNHUB_CALL_BUDGET + FINNHUB_CALL_BUDGET && MOVERS_MAX <= FINNHUB_CALL_BUDGET + 10,
    'y el tope del canal entra en el presupuesto de llamadas declarado',
    `tope ${MOVERS_MAX} · presupuesto ${FINNHUB_CALL_BUDGET}`);
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
