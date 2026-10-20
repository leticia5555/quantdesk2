// ═══════════════════════════════════════════════════════════════════
// tests/arena-puerta-vivo.test.mjs — lo que se dispara HOY entra HOY.
//
// EL BUG QUE CIERRA. Los nombres "del día" del universo se arman a las 13:00
// UTC, antes de la apertura: son los movers de AYER. Un nombre que se dispara
// a las 11:00 no estaba en el universo de ninguna corrida de ese día, así que
// no salía en el tablero, el screener no lo podía devolver y el objetivo lo
// rechazaba. Para un agente de momentum eso es elegir del pasado.
//
// LO QUE SE BLINDA:
//   1. MISMOS PISOS QUE EL CRON, por EQUIVALENCIA: con los mismos datos, la
//      puerta admite exactamente los nombres del día que el cron admitiría.
//      No "parecidos": los mismos. Incluye el piso ajustado al feed (IEX), que
//      es el que ya mordió una vez (AIG).
//   2. Sólo SUMA: lo que ya estaba no se vuelve a pedir ni se duplica.
//   3. FAIL CLOSED: sin datos de admisión no entra nadie; sin universo base
//      no abre (y ni siquiera llama a Alpaca).
//   4. LA FUSIÓN: el universo de la corrida trae a los nuevos con su rango de
//      52 semanas, y el base (que viene de Neon) no se muta.
//   5. EL CABLEADO: gatherContext la espera ANTES del tablero, le pasa al
//      tablero el universo fusionado, y la deja journaleada en las dos rutas
//      (contrato viejo y contrato objetivo).
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildUniverse, abrirPuertaEnVivo, fusionarPuerta, resumenPuerta } from '../api/_lib/arena-universe.js';

const HOY = new Date('2026-10-20T15:26:00Z'); // 11:26 ET
const sp500 = Array.from({ length: 500 }, (_, i) => 'SP' + i);
const nq100 = Array.from({ length: 100 }, (_, i) => 'NQ' + i);

// Catálogo de Alpaca: todo es acción común salvo lo que se llame "...Warrants".
const catalogo = {
  count: 99999, from_cache: false,
  assets: new Proxy({}, {
    get: (_, sym) => (typeof sym === 'string'
      ? { symbol: sym, class: 'us_equity', status: 'active', tradable: true,
        name: sym === 'WRNT' ? 'Wrnt Corp Warrants' : sym + ' Common Stock' }
      : undefined),
  }),
};

// Los nombres del día, uno por cada piso. Volumen en dólares sobre feed IEX:
// ILIQ ($1M) pasa el piso de IEX y NO pasaría el nominal de $10M — si la
// puerta aplicara las reglas nominales en vez de las del feed, este test lo ve.
const DIA = {
  IONQ:  { price: 42,  dollarVolume: 9e8, marketCap: 1.2e10 },  // entra
  BUENO: { price: 20,  dollarVolume: 5e8, marketCap: 5e9 },     // entra
  ILIQ:  { price: 30,  dollarVolume: 1e6, marketCap: 3e9 },     // entra SÓLO con piso IEX
  BARATO:{ price: 3,   dollarVolume: 5e8, marketCap: 2e9 },     // < $5
  CHICO: { price: 12,  dollarVolume: 5e8, marketCap: 4e8 },     // < $1B
  SECO:  { price: 25,  dollarVolume: 1e4, marketCap: 2e9 },     // sin volumen
  WRNT:  { price: 15,  dollarVolume: 5e8, marketCap: 2e9 },     // pasa los pisos; NO es acción
};
const nombresDia = Object.keys(DIA);
const INDICE = { price: 100, dollarVolume: 5e9 };

const depsComunes = ({ movers = [], actives = [] } = {}) => ({
  // constituyentes: escalón 1 (ETF) con la lista fija, sin red
  fetchDesdeEtf: async (index) => ({ index, source: 'etf', built_at: HOY.toISOString(), symbols: index === 'sp500' ? sp500 : nq100 }),
  fetchConstituents: async () => null,
  readStored: async () => null, writeStored: async () => true, readStatic: async () => null,
  cargarCatalogo: async () => catalogo,
  getSymbolTypes: async () => null,
  getMovers: async () => ({ gainers: movers.map((s) => ({ symbol: s, price: 10, percent_change: 9 })), losers: [], last_updated: null }),
  getMostActives: async ({ by }) => ({ most_actives: by === 'volume' ? actives.map((s) => ({ symbol: s, volume: 1e7 })) : [], by, last_updated: null }),
  getPriceAndDollarVolume: async (syms) => ({
    feed: 'iex',
    data: Object.fromEntries(syms.map((s) => [s, DIA[s] ? { price: DIA[s].price, dollarVolume: DIA[s].dollarVolume } : INDICE])),
  }),
  // Respeta `known` como la real, y el market cap sale de la tabla.
  resolveAdmission: async (syms, { known = {} } = {}) => Object.fromEntries(syms.map((s) => [s, {
    price: (known[s] || {}).price ?? (DIA[s] || INDICE).price,
    dollarVolume: (known[s] || {}).dollarVolume ?? (DIA[s] || INDICE).dollarVolume,
    marketCap: (known[s] || {}).marketCap ?? (DIA[s] ? DIA[s].marketCap : null),
  }])),
  mcapCache: { leer: async () => ({}), guardar: async () => 0 },
  getFiftyTwoWeek: async (syms) => Object.fromEntries(syms.map((s) => [s, { high_52w: 50, low_52w: 10, pct_from_high: -5, pct_from_low: 300 }])),
});

test('mismos pisos que el cron: la puerta admite EXACTAMENTE lo que el cron admitiría', async () => {
  // El cron, si hubiera visto a estos nombres a las 13:00.
  const conDia = await buildUniverse({ now: HOY, creds: {}, deps: depsComunes({ movers: nombresDia }) });
  // El cron real de hoy, que no los vio (los movers de ayer eran otros).
  const base = await buildUniverse({ now: HOY, creds: {}, deps: depsComunes() });
  assert.equal(base.from_day.length, 0);
  // La puerta, a las 11:26, sobre ese base.
  const puerta = await abrirPuertaEnVivo(base, { now: HOY, creds: {}, deps: depsComunes({ movers: nombresDia }) });

  assert.deepEqual(puerta.simbolos, [...conDia.from_day].sort());
  assert.deepEqual(puerta.simbolos, ['BUENO', 'ILIQ', 'IONQ'], 'IONQ, BUENO e ILIQ (piso IEX); el resto no');
  const motivos = Object.fromEntries(puerta.rechazados.map((r) => [r.symbol, r.reason]));
  assert.match(motivos.BARATO, /precio/);
  assert.ok(motivos.CHICO && motivos.SECO, 'CHICO y SECO rechazados con su motivo');
  assert.ok(!puerta.simbolos.includes('WRNT') && puerta.counts.no_comunes === 1, 'el warrant no llega ni a la admisión');
  assert.equal(puerta.reglas.feed, 'iex');
});

test('sólo suma: lo que ya está en el universo no se vuelve a pedir', async () => {
  const base = await buildUniverse({ now: HOY, creds: {}, deps: depsComunes() });
  const pedidos = [];
  const deps = depsComunes({ movers: ['SP1', 'SP2', 'IONQ'], actives: ['NQ5', 'IONQ'] });
  const orig = deps.getPriceAndDollarVolume;
  deps.getPriceAndDollarVolume = async (syms, o) => { pedidos.push(...syms); return orig(syms, o); };
  const puerta = await abrirPuertaEnVivo(base, { now: HOY, creds: {}, deps });
  assert.deepEqual(pedidos, ['IONQ']);
  assert.deepEqual(puerta.simbolos, ['IONQ']);
  assert.deepEqual(puerta.counts, { brutos: 4, ya_en_universo: 3, nuevos_brutos: 1, comunes: 1, no_comunes: 0, candidatos: 1 });
});

test('fail closed: sin datos de admisión no entra nadie', async () => {
  const base = await buildUniverse({ now: HOY, creds: {}, deps: depsComunes() });
  const deps = { ...depsComunes({ movers: ['IONQ', 'BUENO'] }), resolveAdmission: async () => { throw new Error('finnhub caído'); } };
  const puerta = await abrirPuertaEnVivo(base, { now: HOY, creds: {}, deps });
  assert.equal(puerta.entraron, 0);
  assert.equal(puerta.rechazados_count, 2);
  assert.match(puerta.errors.admission, /finnhub/);
});

test('sin universo base no abre, y no le pregunta nada a Alpaca', async () => {
  let llamadas = 0;
  const deps = { getMovers: async () => { llamadas++; return null; }, getMostActives: async () => { llamadas++; return null; } };
  const p = await abrirPuertaEnVivo(null, { now: HOY, deps });
  assert.equal(p.abierta, false);
  assert.equal(p.motivo, 'sin_universo_base');
  assert.equal(llamadas, 0);
});

test('la fusión: los nuevos quedan en el universo de la corrida, con su rango; el base no se toca', async () => {
  const base = await buildUniverse({ now: HOY, creds: {}, deps: depsComunes() });
  const antes = JSON.stringify(base);
  const puerta = await abrirPuertaEnVivo(base, { now: HOY, creds: {}, deps: depsComunes({ movers: nombresDia }) });
  const u = fusionarPuerta(base, puerta);
  assert.equal(JSON.stringify(base), antes, 'el base que vino de Neon no se muta');
  assert.ok(u.symbols.includes('IONQ') && u.symbols.length === base.symbols.length + 3);
  assert.deepEqual(u.from_vivo, ['BUENO', 'ILIQ', 'IONQ']);
  assert.ok(u.fifty_two_week.IONQ, 'IONQ trae su rango de 52 semanas: puede salir en breakouts');
  assert.equal(u.market_caps.IONQ, 1.2e10);
  // Puerta cerrada o vacía → el universo es el base, el mismo objeto.
  assert.equal(fusionarPuerta(base, { abierta: false, entraron: 0, simbolos: [] }), base);
  // El journal lleva cuáles y cuántos, sin el payload pesado.
  const j = resumenPuerta(puerta);
  assert.equal(j.entraron, 3);
  assert.deepEqual(j.simbolos, ['BUENO', 'ILIQ', 'IONQ']);
  assert.equal(j.extension, undefined);
});

test('cableado: gatherContext espera la puerta ANTES del tablero y la journalea en las dos rutas', () => {
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const iFusion = run.indexOf('universeBase = fusionarPuerta(universeBase, puerta_en_vivo)');
  const iBoard = run.indexOf('board = await buildBoard({');
  assert.ok(iFusion > 0 && iBoard > iFusion, 'la fusión va antes de buildBoard');
  assert.match(run.slice(iBoard, iBoard + 200), /universe: universeBase/, 'el tablero recibe el universo fusionado');
  assert.match(run, /universe_raw: universeBase,/, 'herramientas y objetivo validan contra el fusionado');
  assert.match(run, /puerta_en_vivo: resumenPuerta\(puerta_en_vivo\)/);
  assert.match(run, /context\.puerta_en_vivo = buffet\.puerta_en_vivo/);
  assert.match(shadow, /puerta_en_vivo: \(buffet && buffet\.puerta_en_vivo\) \|\| null/);
  assert.match(run, /Promise\.race\(\[\s*abrirPuertaEnVivo/, 'la puerta tiene techo propio');
});
