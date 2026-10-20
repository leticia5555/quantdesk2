// ═══════════════════════════════════════════════════════════════
// tests/liga-razonamiento.test.mjs — /liga/libros: VER EL RAZONAMIENTO.
//
// Lety: «por agente y por corrida: la cadena de herramientas (ficha X,
// noticias Y → N titulares) y la tesis de cada posición. Que se pueda abrir
// cada corrida y leer por qué compró cada cosa.»
//
// Lo que se blinda:
//   1. LA CADENA dice herramienta, objeto y conteo con su unidad — y una
//      herramienta que FALLÓ no se lee como "0 filas".
//   2. POR POSICIÓN: movimiento, peso antes → ahora, tesis, y en qué pasos
//      preguntó por ESE ticker. Aparecer en un screener no cuenta como
//      "lo miró": el resumen no guarda las filas.
//   3. CADA CORRIDA SE PUEDE ABRIR: el libro trae `corrida_id`, la consulta lo
//      pide, y la página entiende `?corrida=` y `?agente=`.
//
// Correr con `node tests/liga-razonamiento.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pasoEnPalabras, razonamientoDeLibro, libroDeFila } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── 1) la cadena, en palabras ──');
{
  ok(pasoEnPalabras({ n: 1, herramienta: 'noticias', argumentos: { ticker: 'NVDA', days: 2, limit: 8 }, filas: 6 })
    === 'noticias NVDA (2 días) → 6 titulares', 'noticias: ticker, ventana y titulares',
  pasoEnPalabras({ n: 1, herramienta: 'noticias', argumentos: { ticker: 'NVDA', days: 2, limit: 8 }, filas: 6 }));
  ok(pasoEnPalabras({ herramienta: 'noticias', argumentos: { ticker: 'MU' }, filas: 1 }) === 'noticias MU → 1 titular',
    'singular cuando es uno');
  ok(pasoEnPalabras({ herramienta: 'ficha', argumentos: { ticker: 'MU' }, filas: 9 }) === 'ficha MU → 9 líneas', 'ficha');
  const scr = pasoEnPalabras({ herramienta: 'screener', argumentos: { sector: 'XLK', rvol_top: true, near_52w_low: false, limit: 25 }, filas: 12 });
  ok(scr === 'screener sector XLK, rvol_top → 12 nombres',
    'screener: los filtros en palabras; el `false` y el `limit` no se dicen', scr);
  ok(pasoEnPalabras({ herramienta: 'noticias', argumentos: { tema: 'guidance' }, filas: 0 }) === 'noticias "guidance" → 0 titulares',
    'un tema va entre comillas y el cero se dice');
  ok(/truncado/.test(pasoEnPalabras({ herramienta: 'screener', argumentos: {}, filas: 25, truncado: true })), 'el truncado se ve');
  const fallo = pasoEnPalabras({ herramienta: 'ficha', argumentos: { ticker: 'WDC' }, filas: 0, falló: true });
  ok(/FALLÓ/.test(fallo) && !/0 líneas/.test(fallo), 'una herramienta que FALLÓ no se lee como "0 filas"', fallo);
  ok(/sin resultado registrado/.test(pasoEnPalabras({ herramienta: 'ficha', argumentos: { ticker: 'STX' }, filas: null })),
    'filas null se dice "sin resultado registrado", no se pinta como cero');
  ok(/no se ejecutó \(budget_exhausted\)/.test(pasoEnPalabras({ herramienta: 'screener', argumentos: {}, rechazada: 'budget_exhausted' })),
    'un rechazo por presupuesto dice que no se ejecutó');
}

console.log('\n── 2) por posición: qué hizo, con qué peso, por qué, y si preguntó por el nombre ──');
const investigacion = {
  pasos: [
    { n: 1, herramienta: 'screener', argumentos: { sector: 'XLK' }, filas: 12 },
    { n: 2, herramienta: 'ficha', argumentos: { ticker: 'MU' }, filas: 9 },
    { n: 3, herramienta: 'noticias', argumentos: { ticker: 'mu', days: 2 }, filas: 4 },
    { n: 4, herramienta: 'ficha', argumentos: { ticker: 'AMD' }, filas: 9 },
  ],
};
const portafolio = {
  pesos: { MU: 0.2, AAPL: 0.1, NVDA: 0.15 },
  tesis: { MU: 'HBM sold out through 2027; guidance raised.', AAPL: 'Defensive ballast.' },
};
const pesosActuales = { NVDA: 0.15, AAPL: 0.05, TSLA: 0.1 };
const r = razonamientoDeLibro({ investigacion, portafolio, pesos_actuales: pesosActuales });
{
  ok(r.cadena.length === 4 && r.cadena[1] === 'ficha MU → 9 líneas', 'la cadena trae un eslabón por paso', JSON.stringify(r.cadena));
  const de = (t) => r.posiciones.find((p) => p.ticker === t);
  ok(de('MU').movimiento === 'compra nueva' && de('MU').peso === 0.2 && de('MU').peso_antes === 0,
    'MU: compra nueva, de 0 a 20%');
  ok(de('MU').tesis === portafolio.tesis.MU, 'con su tesis literal');
  ok(JSON.stringify(de('MU').investigo) === '[2,3]',
    'y los pasos donde preguntó por MU (sin importar mayúsculas)', JSON.stringify(de('MU').investigo));
  ok(de('AAPL').movimiento === 'sube', 'AAPL: sube de 5 a 10%');
  ok(de('NVDA').movimiento === 'se mantiene', 'NVDA: se mantiene');
  ok(de('TSLA') && de('TSLA').movimiento === 'sale' && de('TSLA').peso === 0,
    'TSLA estaba y no se nombra: SALE (lo que no se nombra, se vende)');
  ok(!de('AMD'), 'AMD se investigó y no se compró: no es una posición');
  ok(JSON.stringify(de('NVDA').investigo) === '[]',
    'el screener de XLK NO cuenta como haber mirado NVDA: el resumen no guarda qué filas vinieron');
  ok(JSON.stringify(r.sin_tesis) === '["NVDA"]', 'se declara qué posición quedó sin tesis', JSON.stringify(r.sin_tesis));
  ok(r.sin_consulta_propia.includes('AAPL') && r.sin_consulta_propia.includes('NVDA') && !r.sin_consulta_propia.includes('MU'),
    'y cuáles se sostienen sin una consulta propia', JSON.stringify(r.sin_consulta_propia));
  ok(r.posiciones[0].ticker === 'MU' && r.posiciones[r.posiciones.length - 1].ticker === 'TSLA',
    'orden: lo más pesado primero, lo que sale al final', r.posiciones.map((p) => p.ticker).join(','));

  const corto = razonamientoDeLibro({ portafolio: { pesos: { XYZ: -0.05 }, tesis: {} }, pesos_actuales: {} });
  ok(corto.posiciones[0].movimiento === 'abre corto', 'un peso negativo nuevo es abrir corto');
  const vuelta = razonamientoDeLibro({ portafolio: { pesos: { XYZ: -0.05 } }, pesos_actuales: { XYZ: 0.05 } });
  ok(vuelta.posiciones[0].movimiento === 'da vuelta', 'de largo a corto es dar vuelta');
  const sinActual = razonamientoDeLibro({ portafolio: { pesos: { XYZ: 0.05 } } });
  ok(sinActual.posiciones[0].peso_antes === null, 'sin pesos actuales journaleados, el "antes" es null y no un cero inventado');
  ok(razonamientoDeLibro({}) === null, 'sin investigación ni portafolio no hay razonamiento que mostrar');
  const soloCadena = razonamientoDeLibro({ investigacion });
  ok(soloCadena && soloCadena.cadena.length === 4 && soloCadena.posiciones.length === 0,
    'una corrida abortada que investigó igual muestra su cadena');
}

console.log('\n── 3) cada corrida se puede abrir ──');
{
  const l = libroDeFila({
    id: 'arena-grok-2026-10-20T14:00', created_at: '2026-10-20T14:00:00Z', agent_id: 'grok', status: 'ok_target',
    target: { weights: { MU: 0.2 }, theses: { MU: 'x' } },
    rebalance: { current: { STX: 0.1 } },
    context: { tools: { summary: [{ n: 1, tool: 'ficha', args: { ticker: 'MU' }, rows: 9 }] } },
  }, 'prueba');
  ok(l.corrida_id === 'arena-grok-2026-10-20T14:00', 'el libro trae el id de su fila');
  ok(l.razonamiento && l.razonamiento.cadena[0] === 'ficha MU → 9 líneas', 'y su razonamiento armado');
  ok(l.razonamiento.posiciones.some((p) => p.ticker === 'STX' && p.movimiento === 'sale'), 'con las salidas incluidas');

  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  const selects = src.match(/`select [^`]*from arena_(shadow_)?journal/g) || [];
  ok(selects.length === 2 && selects.every((q) => /^`select id, /.test(q)),
    'las DOS consultas (en vivo y prueba) piden el id: sin él no hay enlace', String(selects.length));

  const html = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  ok(/PARAMS\.get\('corrida'\)/.test(html) && /data-corrida=/.test(html) && /abrirCorrida\(\)/.test(html),
    'la página entiende `?corrida=` y abre esa tarjeta');
  ok(/PARAMS\.get\('agente'\)/.test(html) && /&agente='\+encodeURIComponent/.test(html),
    'y `?agente=` se pasa al endpoint');
  const lb = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');
  ok(/\/liga\/libros\?agente='\+encodeURIComponent\(a\.id\)/.test(lb), '/liga enlaza a los libros de cada agente');

  // La página PINTA lo que el servidor armó: se ejecutan sus dos funciones
  // tal cual están en el HTML, sin navegador.
  const ini = html.indexOf('function cadenaHtml');
  const fin = html.indexOf('function pesosHtml');
  ok(ini > 0 && fin > ini, 'las funciones de pintado existen');
  const sandbox = {
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    pp: (n) => (Number(n) * 100).toFixed(1) + '%',
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(ini, fin) + ';this.cadenaHtml=cadenaHtml;this.porqueHtml=porqueHtml;', sandbox);
  const cad = sandbox.cadenaHtml({ cadena: ['ficha MU → 9 líneas', 'ficha WDC → la herramienta FALLÓ (no es lo mismo que 0 filas)'] });
  ok(/ficha MU → 9 líneas/.test(cad) && /eslabon falla/.test(cad), 'la cadena se pinta y la falla se marca', cad);
  const pq = sandbox.porqueHtml(r);
  ok(/HBM sold out/.test(pq) && /paso 2, 3/.test(pq) && /Sin tesis para esta posición/.test(pq) && /Sale del libro/.test(pq),
    'el porqué de cada posición se pinta con tesis, pasos, faltantes y salidas');
  ok(/<script>/.test(sandbox.porqueHtml({ posiciones: [{ ticker: '<script>', movimiento: 'sube', peso: 0.1, tesis: null, investigo: [] }] })) === false,
    'y se escapa: una tesis o un ticker no inyecta HTML');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
