#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/historia-edgar-smoke.mjs — el cliente de Historia contra EDGAR
// REAL. Diez llamadas, sin keys, sin DB, sin escribir nada.
//
// POR QUÉ EXISTE: api/_lib/edgar.js está probado con 94 aserciones contra
// fixtures sintéticos y `fetch` inyectado (tests/historia-edgar.test.mjs).
// Eso prueba el instrumento, NO la fuente: el contenedor donde se escribió no
// alcanza sec.gov (docs/historia-fase0.md §0). Este smoke es la parte de G7
// (§10) que se puede ganar sin esquema ni ingesta — que el transporte hable
// con EDGAR de verdad: que el UA sea aceptado, que las URLs resuelvan, que el
// techo de req/s se respete y que companyfacts pese lo que creemos.
//
// Lo que este smoke NO cierra: que la ingesta guarde bien. Eso es G7 completo
// y necesita la rebanada C.
//
//   node scripts/historia-edgar-smoke.mjs                # LULU MSFT MELI VIST
//   node scripts/historia-edgar-smoke.mjs MELI           # uno solo
//   node scripts/historia-edgar-smoke.mjs --rps 3        # más suave
//
// Sale 0 si todo resolvió, 1 si algo falló. Imprime lo que midió, nunca lo
// que supone: si una llamada no se hizo, dice que no se hizo.
// ═══════════════════════════════════════════════════════════════

import {
  crearCliente, bajarTickerMap, bajarSubmissionsCompleto, bajarCompanyFacts,
  urlDocumento, ErrorEdgar,
} from '../api/_lib/edgar.js';

// Un parseo de una pasada: `--rps N` se consume con su valor y lo demás son
// tickers. Filtrar por `indexOf` se equivoca con argumentos repetidos.
const argv = process.argv.slice(2);
const tickers = [];
let rps;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--rps') { rps = Number(argv[++i]) || undefined; continue; }
  if (argv[i].startsWith('--')) continue;
  tickers.push(argv[i].toUpperCase());
}
const OBJETIVO = tickers.length ? tickers : ['LULU', 'MSFT', 'MELI', 'VIST'];

const mb = (b) => `${(b / 1e6).toFixed(2)} MB`;
let fallas = 0;

const cli = crearCliente(rps ? { reqPorSegundo: rps } : {});

console.log('═══════════════════════════════════════════════════════════');
console.log('  SMOKE — api/_lib/edgar.js contra EDGAR real');
console.log(`  tickers: ${OBJETIVO.join(', ')}`);
console.log(`  UA: ${cli.ua}`);
console.log(`  techo propio: ${cli.reqPorSegundo} req/s${cli.recortadoAlTecho ? ' (recortado al techo de la SEC)' : ''}`);
console.log('═══════════════════════════════════════════════════════════\n');

let map;
try {
  const r = await bajarTickerMap(cli);
  map = r.map;
  console.log(`✓ ticker-map: ${Object.keys(map).length.toLocaleString('es')} tickers · ${mb(r.bytes)}`);
} catch (e) {
  console.error(`✗ ticker-map: ${e.message}`);
  if (e instanceof ErrorEdgar && e.clase === 'egress') {
    console.error('\n  Esta máquina no tiene salida a sec.gov. El smoke tiene que correr');
    console.error('  desde una con internet abierto: EDGAR es público y anónimo.\n');
  }
  process.exit(1);
}

for (const ticker of OBJETIVO) {
  const hit = map[ticker];
  console.log(`\n── ${ticker}`);
  if (!hit) {
    console.log('  ✗ no está en company_tickers.json');
    fallas++;
    continue;
  }
  console.log(`  cik ${hit.cikPad} · ${hit.nombre}`);

  // 1. El índice de filings, con sus páginas viejas si las hay.
  let sub;
  try {
    const desde = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    sub = await bajarSubmissionsCompleto(cli, hit.cik, { desde });
    const recientes = sub.principal?.filings?.recent?.form?.length || 0;
    console.log(`  ✓ submissions: ${recientes} filings en 'recent' · ${sub.paginas.length} página(s) extra`
      + ` · ${sub.paginasOmitidasPorVentana} omitida(s) por ventana de 5a · ${mb(sub.bytes)}`
      + (sub.truncado ? ' · ⚠ TRUNCADO' : ''));
    // El dato que clasifica G6, medido y no asumido.
    const formas = new Set(sub.principal?.filings?.recent?.form || []);
    const anual = ['10-K', '20-F', '40-F'].filter((f) => formas.has(f));
    console.log(`  · forma anual en 'recent': ${anual.length ? anual.join(', ') : 'ninguna en la ventana'}`
      + ` · 10-Q ${formas.has('10-Q') ? 'sí' : 'no'} · 8-K ${formas.has('8-K') ? 'sí' : 'no'} · 6-K ${formas.has('6-K') ? 'sí' : 'no'}`);
  } catch (e) {
    console.log(`  ✗ submissions: ${e.message}`);
    fallas++;
  }

  // 2. La URL de un documento primario: si no resuelve, la cita no se puede
  //    construir y el producto entero se cae — es el corazón de G3.
  if (sub) {
    const rec = sub.principal?.filings?.recent;
    if (rec && rec.accessionNumber && rec.accessionNumber.length) {
      const url = urlDocumento(hit.cik, rec.accessionNumber[0], rec.primaryDocument?.[0] || '');
      const estado = await cli.head(url);
      console.log(`  ${estado === 200 ? '✓' : '✗'} documento primario del último filing: HTTP ${estado}`);
      if (estado !== 200) fallas++;
    }
  }

  // 3. companyfacts: el peso es el número que decide goteo vs bajo demanda.
  try {
    const { facts, bytes } = await bajarCompanyFacts(cli, hit.cik);
    const taxonomias = Object.keys(facts?.facts || {});
    const conceptos = taxonomias.reduce((a, t) => a + Object.keys(facts.facts[t] || {}).length, 0);
    console.log(`  ✓ companyfacts: ${mb(bytes)} · taxonomías ${taxonomias.join(', ') || '(ninguna)'} · ${conceptos} conceptos`);
  } catch (e) {
    console.log(`  ✗ companyfacts: ${e.message}`);
    fallas++;
  }
}

const s = cli.stats();
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  ${s.llamadas} llamadas · ${mb(s.bytes)} · ${s.reintentos} reintento(s)`);
console.log(`  latencia p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms`);
console.log(`  esperando nuestro propio turno: ${(s.esperaTotalMs / 1000).toFixed(1)} s`);
console.log(`  ${fallas ? `✗ ${fallas} falla(s)` : '✓ todo resolvió'}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('\nEsto verifica el TRANSPORTE. G7 (§10 del memo) no cierra hasta que');
console.log('la ingesta de la rebanada C guarde y se verifique lo guardado.\n');

process.exit(fallas ? 1 : 0);
