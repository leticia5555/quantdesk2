// ═══════════════════════════════════════════════════════════════
// tests/arena-universo-datos.test.mjs — los tres huecos de datos del
// universo, encontrados por el diag del 2026-09-16.
//
// Los tres tienen la misma forma y por eso son fáciles de no ver: nada falla,
// nada lanza, y el síntoma aparece lejos del origen como "la herramienta X
// devuelve 0 filas".
//
//   1. SECTORES EN CERO. La lista del S&P guardada en Neon era ANTERIOR a que
//      se leyera la columna `Sector` del CSV. Como el refresco es semanal, esa
//      foto se releía todos los días: 502 símbolos correctos, cero sectores.
//      De ahí salían TRES ceros que parecían bugs distintos.
//   2. `ret_1m` SIEMPRE NULL. Las velas se recortaban a 20 —la ventana del
//      promedio de VOLUMEN— y el retorno a 1 mes mira 21 sesiones atrás. El
//      índice caía en −2. `ret_5d` funcionaba, y eso hacía que el bug se leyera
//      como "a veces no hay dato" en vez de "nunca lo hubo".
//   3. MARKET CAP ASUMIDO. A los nombres de índice se les asume el piso de $1B
//      sin medirlo. El screener lo comparaba como si fuera medición, así que
//      con `min_mcap_b: 10` los 502 del índice quedaban fuera —Apple incluida—
//      y el modelo leía "ningún nombre grande cumple".
//
// Correr con `node tests/arena-universo-datos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { resolveConstituents } from '../api/_lib/arena-universe.js';
import { createToolExecutor } from '../api/_lib/arena-tools.js';
import { RET_1M_SESIONES } from '../api/_lib/alpaca.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-09-17T14:00:00Z');
const AYER = '2026-09-16T23:53:00Z';

// ── 1) UN SNAPSHOT SIN SECTORES SE REFRESCA SOLO ─────────────────────
console.log('\n── una foto sin sectores está INCOMPLETA, no vieja ──');
{
  const guardadoSinSectores = { index: 'sp500', source: 'etf', built_at: AYER, symbols: ['DELL', 'COP'], sectores: {} };
  const frescoConSectores = { index: 'sp500', source: 'etf', built_at: HOY.toISOString(), symbols: ['DELL', 'COP'], sectores: { DELL: 'Information Technology', COP: 'Energy' } };

  let bajo = 0;
  let escribio = null;
  const deps = {
    readStored: async () => guardadoSinSectores,
    fetchDesdeEtf: async () => { bajo++; return frescoConSectores; },
    writeStored: async (i, snap) => { escribio = snap; return true; },
  };
  const r = await resolveConstituents('sp500', { now: HOY, deps });

  ok(bajo === 1, 'se re-baja el CSV aunque la foto sea de AYER y la ventana sea semanal', String(bajo));
  ok(r.refreshed === true && Object.keys(r.sectores).length === 2, 'y la lista nueva SÍ trae sectores');
  ok(r.refrescado_por === 'sin_sectores',
    'el motivo del refresco se NOMBRA: no fue la edad, fue que faltaba el dato', r.refrescado_por);
  ok(/no es un snapshot viejo/.test(r.note || ''), 'y la nota lo explica', (r.note || '').slice(-60));
  ok(escribio && Object.keys(escribio.sectores).length === 2, 'la foto corregida se guarda');

  // Una foto CON sectores y dentro de la ventana no se re-baja: el arreglo no
  // puede convertir el refresco semanal en un refresco diario.
  let bajo2 = 0;
  const r2 = await resolveConstituents('sp500', {
    now: HOY,
    deps: {
      readStored: async () => ({ ...guardadoSinSectores, sectores: { DELL: 'Information Technology' } }),
      fetchDesdeEtf: async () => { bajo2++; return frescoConSectores; },
      writeStored: async () => true,
    },
  });
  ok(bajo2 === 0 && r2.refreshed === false,
    'una foto COMPLETA y reciente NO se re-baja: sigue siendo un refresco semanal', String(bajo2));

  // Y el forzado sigue funcionando.
  let bajo3 = 0;
  await resolveConstituents('sp500', {
    now: HOY, force: true,
    deps: {
      readStored: async () => ({ ...guardadoSinSectores, sectores: { DELL: 'x' } }),
      fetchDesdeEtf: async () => { bajo3++; return frescoConSectores; },
      writeStored: async () => true,
    },
  });
  ok(bajo3 === 1, '`force` sigue ignorando la ventana aunque la foto esté completa', String(bajo3));

  // Si el refresco falla Y lo guardado no tiene sectores, se DICE — porque ese
  // estado rompe R6, `sector()` y el screener a la vez.
  const roto = await resolveConstituents('sp500', {
    now: HOY,
    deps: {
      readStored: async () => guardadoSinSectores,
      fetchDesdeEtf: async () => null,
      fetchConstituents: async () => null,
      writeStored: async () => true,
      forzarFmp: false,
    },
  });
  ok(roto.sin_sectores === true, 'si el refresco falla, el estado sin sectores se marca');
  ok(/No son tres bugs — es este/.test(roto.note || ''),
    'y la nota nombra los tres síntomas que produce, para que no se diagnostiquen por separado',
    (roto.note || '').slice(-70));
}

// ── 1b) EL BUG DE FONDO: los sectores no sobrevivían a la escritura ──
// La explicación natural —y la que dimos los dos— era que la foto guardada era
// anterior a que se leyera la columna `Sector`. No: `writeStored` guardaba
// `{ symbols }` y NADA MÁS. Los sectores se bajaban bien, viajaban bien, y se
// tiraban en el `JSON.stringify`. Una foto recién bajada tenía sectores; la
// misma foto leída de vuelta, no — para siempre, sin importar la fecha.
//
// Lo que lo hacía invisible: `symbols` SÍ se guardaba, así que el universo se
// construía con sus 502 nombres y nada fallaba. El hueco aparecía tres capas
// más allá, como tres bugs distintos.
console.log('\n── los sectores tienen que sobrevivir al viaje a Neon ──');
{
  const src = await import('node:fs').then((fs) => fs.readFileSync('api/_lib/arena-universe.js', 'utf8'));
  const escritura = /JSON\.stringify\(\{\s*symbols: snapshot\.symbols,\s*sectores: snapshot\.sectores \|\| \{\},\s*\}\)/.test(src);
  ok(escritura, 'writeStored persiste `sectores`, no solo `symbols`');
  ok(/sectores: \(p\.sectores && typeof p\.sectores === 'object'\) \? p\.sectores : \{\}/.test(src),
    'y readStored los lee de vuelta: escribir sin leer sería el mismo hueco con otra cara');

  // El viaje completo, con un almacén de mentira que respeta el contrato real:
  // se serializa lo que writeStored serializa y se lee lo que readStored lee.
  const conSectores = { index: 'sp500', source: 'etf', built_at: '2026-09-17T12:00:00Z', symbols: ['DELL', 'COP'], sectores: { DELL: 'Information Technology', COP: 'Energy' } };
  let guardado = null;
  const r = await resolveConstituents('sp500', {
    now: HOY,
    deps: {
      readStored: async () => null,
      fetchDesdeEtf: async () => conSectores,
      writeStored: async (i, snap) => { guardado = JSON.parse(JSON.stringify({ symbols: snap.symbols, sectores: snap.sectores || {} })); return true; },
    },
  });
  ok(r.refreshed === true && Object.keys(r.sectores).length === 2, 'la foto fresca trae sus sectores');
  ok(guardado && Object.keys(guardado.sectores).length === 2,
    'y los DOS llegan al almacén: antes llegaban cero y nadie fallaba', JSON.stringify(guardado && guardado.sectores));
}

// ── 2) LA VENTANA DE VELAS DEL RETORNO A 1 MES ───────────────────────
console.log('\n── ret_1m necesita 22 velas, no 20 ──');
{
  ok(RET_1M_SESIONES === 21, 'el retorno a 1 mes mira 21 sesiones atrás', String(RET_1M_SESIONES));

  // La aritmética exacta que fallaba, reproducida.
  const indiceDe = (velas, n) => velas - 1 - n;
  ok(indiceDe(20, RET_1M_SESIONES) < 0,
    'con 20 velas conservadas el índice cae en negativo → undefined → null SIEMPRE, por construcción',
    String(indiceDe(20, RET_1M_SESIONES)));
  ok(indiceDe(20, 5) >= 0,
    'mientras que ret_5d SÍ tenía índice válido — por eso el bug se leía como "a veces falta el dato"',
    String(indiceDe(20, 5)));
  ok(indiceDe(RET_1M_SESIONES + 1, RET_1M_SESIONES) === 0,
    'con 22 velas el índice existe: ése es el mínimo', String(indiceDe(RET_1M_SESIONES + 1, RET_1M_SESIONES)));

  // Y el promedio de volumen NO puede ensancharse de rebote: conservar 22 velas
  // para el retorno no puede convertir un promedio de 20 sesiones en uno de 22,
  // porque eso cambiaría en silencio a quién admite el universo.
  const src = await import('node:fs').then((fs) => fs.readFileSync('api/_lib/alpaca.js', 'utf8'));
  ok(/const dvs = cerradas\.slice\(-days\)/.test(src),
    'el promedio de volumen sigue usando SOLO sus `days` sesiones, no las 22 conservadas');
  ok(/sessions_volumen/.test(src),
    'y se reporta cuántas velas entraron en cada cálculo: un null con 22 sesiones sería bug nuestro, con 8 es una acción joven');
}

// ── 3) EL MARKET CAP ASUMIDO ─────────────────────────────────────────
console.log('\n── $1B asumido es una COTA, y el cero tiene que decirlo ──');
{
  const fila = (symbol) => ({ symbol, price: 200, change_pct: 1, rvol: 1, pct_from_high: -2, pct_from_low: 50 });
  const board = { gainers: [fila('AAPL'), fila('MSFT')] };
  const universe = { market_caps: { AAPL: 1e9, MSFT: 1e9 }, market_caps_asumidos: ['AAPL', 'MSFT'] };
  const ex = createToolExecutor({ budget: 9, board, universe, cache: false });

  const alto = await ex.call('screener', { min_mcap_b: 10 });
  ok(alto.rows === 0, 'con el umbral por encima de la cota no pasa ninguno (fail-closed, como el resto de los rieles)');
  ok(/COTA INFERIOR/.test(alto.text),
    'pero el texto dice que el cap NO se midió, en vez de "ningún nombre cumple"', alto.text.slice(0, 60));
  ok(/no es que ninguno llegue/.test(alto.text),
    'y desmiente explícitamente la lectura falsa: están Apple y Microsoft ahí adentro');
  ok(alto.datos_faltantes && alto.datos_faltantes[0] === 'market cap medido',
    'el hueco se reporta como dato faltante, no como criterio no cumplido', JSON.stringify(alto.datos_faltantes));

  const bajo = await ex.call('screener', { min_mcap_b: 1 });
  ok(bajo.rows === 2, 'con un umbral que la cota SÍ respalda, los dos pasan', String(bajo.rows));

  // Con caps MEDIDOS el cero vuelve a ser un cero de verdad.
  const medido = createToolExecutor({
    budget: 9, board, cache: false,
    universe: { market_caps: { AAPL: 2e9, MSFT: 3e9 }, market_caps_asumidos: [] },
  });
  const r = await medido.call('screener', { min_mcap_b: 10 });
  ok(r.rows === 0 && !/COTA INFERIOR/.test(r.text),
    'con el dato medido y nadie que llegue, el cero es un cero y no se disfraza de hueco', r.text.slice(0, 50));
}

// ── 4) EL RVOL INTRADÍA VACIABA LOS FILTROS DE MOMENTO ───────────────
// Reportado el 2026-09-17: `ret_1d_min:2` + `min_rvol` daba 0 filas, y las
// mismas llamadas SIN `min_rvol` daban 5.
//
// El RVOL compara el volumen PARCIAL de hoy contra sesiones COMPLETAS, así que
// a mitad de sesión está por debajo de 1 por construcción y cualquier umbral de
// "volumen inusual" lo vacía. El tablero ya lo etiquetaba en el prompt — pero
// un FILTRO no lee etiquetas.
console.log('\n── un umbral de RVOL no significa nada a mitad de sesión ──');
{
  const { fraccionDeSesion } = await import('../api/_lib/arena-board.js');
  const et = (h, m) => new Date(`2026-09-17T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);
  ok(fraccionDeSesion(et(9, 30)) === 0, 'en el open la sesión lleva 0%');
  ok(Math.abs(fraccionDeSesion(et(10, 30)) - 0.154) < 0.01,
    'a las 10:30 lleva ~15%: un nombre con volumen 3× normal leería RVOL ~0.46',
    String(fraccionDeSesion(et(10, 30))));
  ok(fraccionDeSesion(et(16, 0)) === 1 && fraccionDeSesion(et(20, 0)) === 1, 'después del cierre, 1');

  const fila = (symbol, rvol) => ({ symbol, price: 10, change_pct: 5, rvol, pct_from_high: -2, pct_from_low: 50 });
  const board = { gainers: [fila('AAA', 0.42), fila('BBB', 0.31)], sesion_pct: 0.25, rvol_top: ['AAA'] };
  const ex = createToolExecutor({ budget: 9, board, cache: false });

  const vacio = await ex.call('screener', { ret_1d_min: 2, min_rvol: 1.5 });
  ok(vacio.rows === 0, 'el umbral absoluto sigue vaciando (el filtro no miente sobre lo que midió)');
  ok(/sesión lleva 25%/.test(vacio.text),
    'pero el cero DICE a qué hora se midió, en vez de "ninguno cumple"', vacio.text.slice(0, 60));
  ok(/sesgado hacia abajo por construcción/.test(vacio.text),
    'y que el sesgo es estructural, no una ausencia de volumen');
  ok(/El RVOL más alto de todo el tablero ahora mismo es 0\.42/.test(vacio.text),
    'con el máximo observado, para que el modelo vea la escala real de esta hora');
  ok(vacio.sesgo_intradia && vacio.sesgo_intradia.sesion_pct === 0.25,
    'y el dato viaja estructurado al lado del texto', JSON.stringify(vacio.sesgo_intradia));

  // LA SALIDA: un RANGO no se distorsiona con la hora, porque todos los nombres
  // se miden al mismo tiempo.
  ok(/rvol_top: true/.test(vacio.text), 'el cero propone la alternativa que SÍ es interpretable');
  const rango = await ex.call('screener', { ret_1d_min: 2, rvol_top: true });
  ok(rango.rows === 1, '`rvol_top` filtra por el TOP del día y devuelve filas', String(rango.rows));

  // Y con la sesión cerrada, un cero de RVOL vuelve a ser un cero de verdad: el
  // aviso no puede convertirse en una excusa permanente.
  const cerrado = createToolExecutor({ budget: 9, board: { ...board, sesion_pct: 1 }, cache: false });
  const r = await cerrado.call('screener', { min_rvol: 9 });
  ok(r.rows === 0 && !/sesgado hacia abajo/.test(r.text),
    'con la sesión completa, el cero de RVOL es un cero y no se disculpa', r.text.slice(0, 55));

  // Un booleano que llega como string no puede aplicarse al revés: "false" es
  // truthy en JS y ese filtro se habría aplicado igual.
  const { clampArgs } = await import('../api/_lib/arena-tools.js');
  ok(clampArgs('screener', { rvol_top: 'false' }).args.rvol_top === false,
    'un `rvol_top: "false"` se normaliza a false en vez de filtrar por truthy');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
