// ═══════════════════════════════════════════════════════════════
// tests/arena-pareo-ordenes.test.mjs — EL PAREO ORDEN ↔ FILL, SOBRE LA
// TUBERÍA REAL Y NO SOBRE UN FIXTURE.
//
// EL BUG (producción, 462 órdenes del 21 al 24 de septiembre, TODAS con
// `resultado: null` y `estado_alpaca: null`):
//
//   `legsAOrdenes` empuja la orden calculada SIN `client_order_id` — lo pone
//   `enviarOrdenes` después, al mandar. Y `ejecucionPublicable` armaba el mapa
//   de enviadas con `client_order_id || symbol` (→ el id) y lo buscaba desde el
//   lado calculado con la misma expresión (→ el símbolo).
//
//   El mapa se llavea por el id y se busca por el símbolo. MISS, siempre, en
//   toda corrida viva, sin una sola excepción y sin ningún hueco visible: el
//   resultado salía `null`, que es indistinguible de "todavía no pasó nada".
//
// ── POR QUÉ ESTE ARCHIVO EXISTE Y NO ALCANZABA EL OTRO ───────────────
// `tests/arena-fills.test.mjs` probaba el pareo con objetos escritos a mano, y
// en esos objetos yo le había puesto `client_order_id` a la orden calculada —
// un campo que la función que las produce NUNCA escribe. El fixture confirmaba
// mi creencia sobre la forma del dato en vez de comprobarla, y el test pasaba
// en verde sobre el caso que no existe.
//
// Así que acá NO se escriben las formas: se llaman las funciones que las
// producen (`legsAOrdenes`, y la misma proyección a `actions` que hace
// `journalObjetivoVivo`) y se parea lo que sale de ellas. Si mañana alguien
// cambia dónde nace `client_order_id`, esto se entera.
//
// Correr con `node tests/arena-pareo-ordenes.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { legsAOrdenes } from '../api/_lib/arena-objetivo-vivo.js';
import { fillsDeActions, entradasDeCuenta, claveDeOrden } from '../api/_lib/arena-fills.js';
import { ejecucionPublicable } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── LA TUBERÍA, PASO POR PASO, CON LAS FUNCIONES DE VERDAD ───────────
const AGENTE = 'claude';
const FECHA = '2026-09-24';

// (1) El rebalanceo produce patas; `legsAOrdenes` las vuelve órdenes.
const legs = [
  { symbol: 'PGR', side: 'sell', notional: 10520, weight_from: 0.10, weight_to: 0, delta_weight: -0.10, closes_position: true },
  { symbol: 'ADBE', side: 'buy', notional: 6100, weight_from: 0, weight_to: 0.06, delta_weight: 0.06 },
];
const meta = {
  PGR: { price: 264.3, tradable: true },
  ADBE: { price: 509, tradable: true },
};
const { ordenes } = legsAOrdenes({ legs, meta });

// (2) `enviarOrdenes` arma el client_order_id y lo pega ENCIMA de la orden. Se
// reproduce su forma exacta (la línea del `push`) sin llamar a Alpaca.
const cid = (o) => `arena-${AGENTE}-f-${FECHA}-${o.symbol}-${o.side}`.slice(0, 48);
const enviadas = ordenes.map((o, i) => ({
  ...o, result: 'approved', alpaca_order_id: 'alp-' + i, client_order_id: cid(o), order_status: 'accepted',
}));

// (3) `journalObjetivoVivo` proyecta `enviadas` → la columna `actions`. Misma
// proyección, y encima lo que le escribe el reconcile cuando el fill llega.
const FILLS = { PGR: { qty: 40, precio: 265.1 }, ADBE: { qty: 11, precio: 510.25 } };
const actions = enviadas.map((o) => ({
  symbol: o.symbol, side: o.side, qty: o.qty, limit_price: o.limit_price,
  result: o.result, order_status: 'filled',
  alpaca_order_id: o.alpaca_order_id, client_order_id: o.client_order_id, origin: 'objetivo',
  intencion: o.intencion, referencia: o.referencia,
  filled_qty: FILLS[o.symbol].qty, filled_avg_price: FILLS[o.symbol].precio,
  filled_at: '2026-09-24T19:58:02Z',
}));

const cuenta = {
  equity: 101000, cash: 12000, positions: 1,
  holdings: [{ symbol: 'PGR', qty: 40, avg_entry_price: 258.4, market_value: 10600 }],
};

// ── 1) LA FORMA, AFIRMADA CONTRA QUIEN LA PRODUCE ────────────────────
console.log('\n── de dónde nace `client_order_id` ──');
{
  ok(ordenes.length === 2, 'legsAOrdenes produjo las dos órdenes', String(ordenes.length));
  ok(!Object.hasOwn(ordenes[0], 'client_order_id'),
    'la orden CALCULADA no tiene client_order_id: lo pone `enviarOrdenes` después, al mandar',
    JSON.stringify(Object.keys(ordenes[0])));
  ok(Object.hasOwn(enviadas[0], 'client_order_id'), 'la ENVIADA sí lo tiene');
  ok(claveDeOrden(ordenes[0]) === 'PGR|sell',
    'así que la única clave que las dos comparten es SÍMBOLO|lado', claveDeOrden(ordenes[0]));
  ok(claveDeOrden(enviadas[0]) === cid(ordenes[0]),
    'y del lado enviado la clave es el id — las dos expresiones NO dan lo mismo, que es el bug entero');
}

// ── 2) EL PAREO, DE PUNTA A PUNTA ────────────────────────────────────
console.log('\n── la orden calculada encuentra su fill ──');
{
  const e = { modo: 'enviado', candado: { ok: true }, ordenes_calculadas: ordenes, enviadas, descartadas: [] };
  const pub = ejecucionPublicable(e, { fills: fillsDeActions(actions), entradas: entradasDeCuenta(cuenta) });

  const pgr = pub.ordenes.find((x) => x.ticker === 'PGR');
  ok(pgr.resultado === 'approved' && pgr.estado_alpaca === 'filled',
    'resultado y estado dejan de ser null — es lo que producción devuelve en 462 de 462 órdenes',
    JSON.stringify([pgr.resultado, pgr.estado_alpaca]));
  ok(pgr.precio_ejecucion === 265.1 && pgr.monto_usd === 10604, 'con su precio de ejecución y su monto');
  ok(pgr.resultado_contra_entrada.pnl_usd === 268, 'y el resultado de la venta contra la entrada');

  // TODAS, no la primera: el bug era del 100% de las órdenes, así que una
  // aserción sobre una sola no distingue "arreglado" de "arreglado a medias".
  ok(pub.ordenes.every((x) => x.resultado === 'approved' && x.precio_ejecucion != null),
    'las DOS, no solo la primera: el fallo era del 100% de las filas',
    JSON.stringify(pub.ordenes.map((x) => [x.ticker, x.precio_ejecucion])));
}

// ── 3) SIN EL FILL CONCILIADO, EL ECO DEL ENVÍO TIENE QUE LLEGAR ─────
// Éste es el camino que el pareo roto dejaba muerto. Entre que la orden sale y
// que el reconcile la true-ea pasan minutos u horas: en esa ventana lo único
// que hay es `enviadas`, y si no se parea la pantalla dice "calculada" sobre
// una orden que ya está en el broker.
console.log('\n── antes del reconcile ──');
{
  const e = { modo: 'enviado', candado: { ok: true }, ordenes_calculadas: ordenes, enviadas, descartadas: [] };
  const pub = ejecucionPublicable(e, { fills: new Map(), entradas: {} });
  const pgr = pub.ordenes.find((x) => x.ticker === 'PGR');
  ok(pgr.resultado === 'approved' && pgr.estado_alpaca === 'accepted',
    'el eco del envío se parea igual: la orden se mandó, aunque todavía no sepamos a cuánto llenó',
    JSON.stringify([pgr.resultado, pgr.estado_alpaca]));
  ok(pgr.estado === 'pendiente',
    'y el estado es `pendiente` — NO `sin_enviar`, que significaría que nunca salió', pgr.estado);
}

// ── 4) LA CORRIDA EN SECO SIGUE DICIENDO QUE NO MANDÓ NADA ───────────
// El arreglo no puede hacer que una corrida `dry` parezca que operó.
console.log('\n── y una corrida en seco no se contagia ──');
{
  const e = { modo: 'dry', candado: { ok: true }, ordenes_calculadas: ordenes, enviadas: [], descartadas: [] };
  const pub = ejecucionPublicable(e, { fills: new Map(), entradas: {} });
  ok(pub.ordenes.every((x) => x.estado === 'sin_enviar' && x.resultado === null),
    'sin `enviadas` la orden sale `sin_enviar`: se calculó y no se mandó');
  ok(/SIN ENVIAR/.test(pub.modo_nota), 'y la nota del modo lo dice arriba');
}

// ── 5) EL CANDADO CONTRA LA REGRESIÓN ────────────────────────────────
// La expresión rota era literal y es fácil de reintroducir copiando una línea.
console.log('\n── que no vuelva por la misma puerta ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(!/enviadas\.get\(String\(o\.client_order_id \|\| o\.symbol/.test(src),
    'la expresión que llaveaba por el id y buscaba por el símbolo no está más');
  ok(/enviadas\.set\(alt, o\)/.test(src),
    'el mapa de enviadas se indexa TAMBIÉN por SÍMBOLO|lado, que es la clave que el lado calculado sí tiene');

  const vivo = readFileSync(new URL('../api/_lib/arena-objetivo-vivo.js', import.meta.url), 'utf8');
  const push = vivo.slice(vivo.indexOf('ordenes.push({'), vivo.indexOf('ordenes.push({') + 600);
  ok(!/client_order_id/.test(push),
    'y la orden calculada sigue naciendo sin client_order_id — si algún día lo lleva, este test es el que avisa que el pareo cambió de clave');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
