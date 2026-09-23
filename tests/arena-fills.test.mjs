// ═══════════════════════════════════════════════════════════════
// tests/arena-fills.test.mjs — A CUÁNTO SE COMPRÓ Y A CUÁNTO SE VENDIÓ.
//
// "PGR buy · filled" dice que pasó algo, no QUÉ pasó. Lo que este archivo
// protege son las cinco decisiones que convierten un estado en un hecho:
//
//   1. EL FILL GANA SOBRE EL ECO DEL ENVÍO. `enviadas` dice `accepted` para
//      siempre; `actions` —la única columna que el reconcile re-escribe— dice a
//      cuánto llenó. Si se invirtiera la precedencia, el precio no aparecería.
//   2. UNA PARCIAL SE VE PARCIAL. Mostrar solo lo llenado la convierte en una
//      orden completa más chica, y nadie va a buscar las que faltaron.
//   3. LO QUE NO LLENÓ TAMBIÉN APARECE, con su estado y su motivo.
//   4. EL RESULTADO DE UN CORTO NO LLEVA EL SIGNO AL REVÉS. Una fórmula para
//      los dos lados, y el porcentaje siempre sobre la base.
//   5. AUSENTE NO ES CERO. Un precio de ejecución que falta no es $0, y una
//      salida sin precio de entrada NO entra al realizado como 0.
//
// Correr con `node tests/arena-fills.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  claveDeOrden, fillsDeActions, entradasDeCuenta, resultadoContraEntrada,
  detalleDeOrden, resumenDeOrdenes, ordenesDeActions, resumenDeslizamiento,
} from '../api/_lib/arena-fills.js';
import { ejecucionPublicable } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// El libro ANTES de operar: PGR largo a $258.40, MPC corto a $190.
const CUENTA = {
  equity: 101000, cash: 12000, positions: 2,
  holdings: [
    { symbol: 'PGR', qty: 40, avg_entry_price: 258.4, market_value: 10600, current_price: 265 },
    { symbol: 'MPC', qty: -30, avg_entry_price: 190, market_value: -5580, current_price: 186 },
  ],
};

// ── 1) EL FILL, Y SU PRECIO ──────────────────────────────────────────
console.log('\n── una compra que llenó ──');
{
  const d = detalleDeOrden({
    orden: { symbol: 'ADBE', side: 'buy', qty: 12, limit_price: 511.5, referencia: 509, intencion: 'buy', delta_weight: 0.06 },
    fill: { symbol: 'ADBE', side: 'buy', qty: 12, filled_qty: 12, filled_avg_price: 510.25,
      filled_at: '2026-09-21T17:32:11Z', order_status: 'filled', result: 'approved' },
  });
  ok(d.estado === 'llena', 'llenó entera');
  ok(d.precio_ejecucion === 510.25, 'el precio de EJECUCIÓN, no el límite', String(d.precio_ejecucion));
  ok(d.monto_usd === 6123, 'el monto es cantidad llenada × precio de ejecución', String(d.monto_usd));
  ok(d.hora === '2026-09-21T17:32:11Z', 'con su hora');
  ok(d.deslizamiento_pp === 0.246, 'y el deslizamiento contra la referencia que aprobó el riel', String(d.deslizamiento_pp));
  ok(d.resultado_contra_entrada === null, 'una COMPRA no realiza nada: no tiene resultado contra la entrada');
}

// ── 2) LA VENTA, CONTRA LA ENTRADA ───────────────────────────────────
console.log('\n── una venta, con su resultado ──');
{
  const entradas = entradasDeCuenta(CUENTA);
  ok(entradas.PGR.entrada === 258.4 && entradas.PGR.lado === 'largo', 'la entrada sale del libro de ANTES de la corrida');
  ok(entradas.MPC.lado === 'corto', 'una cantidad negativa en Alpaca es un CORTO, y el lado viaja');

  const d = detalleDeOrden({
    orden: { symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, intencion: 'sell', closes_position: true },
    fill: { symbol: 'PGR', side: 'sell', qty: 40, filled_qty: 40, filled_avg_price: 265.1,
      filled_at: '2026-09-21T19:58:02Z', order_status: 'filled', result: 'approved' },
    entrada: entradas.PGR,
  });
  const r = d.resultado_contra_entrada;
  ok(r && r.calculable === true, 'la venta SÍ realiza');
  ok(r.entrada === 258.4 && r.salida === 265.1, 'entrada y salida, las dos', JSON.stringify([r.entrada, r.salida]));
  ok(r.pnl_usd === 268, 'ganancia en dólares: (265.10 − 258.40) × 40', String(r.pnl_usd));
  ok(r.pnl_pct === 2.59, 'y en porcentaje sobre la base', String(r.pnl_pct));
  ok(/sin comisiones y sin dividendos/.test(r.nota), 'con el caveat pegado: es bruto, y la entrada es un PROMEDIO');
}

// ── 3) EL CORTO NO LLEVA EL SIGNO AL REVÉS ───────────────────────────
console.log('\n── cubrir un corto ──');
{
  const entradas = entradasDeCuenta(CUENTA);
  // Se cubre MPC a $186 habiéndolo shorteado a $190: el corto GANA.
  const d = detalleDeOrden({
    orden: { symbol: 'MPC', side: 'buy', qty: 30, limit_price: 187, intencion: 'cover', closes_position: true },
    fill: { symbol: 'MPC', side: 'buy', qty: 30, filled_qty: 30, filled_avg_price: 186,
      filled_at: '2026-09-21T14:05:00Z', order_status: 'filled', result: 'approved' },
    entrada: entradas.MPC,
  });
  const r = d.resultado_contra_entrada;
  ok(r.cierra === 'corto', 'un `cover` cierra un corto, aunque el lado de Alpaca sea `buy`');
  ok(r.pnl_usd === 120, 'baja el precio → el corto gana: (190 − 186) × 30', String(r.pnl_usd));
  ok(r.pnl_pct === 2.11, 'y el porcentaje es sobre la base, igual que en el largo', String(r.pnl_pct));

  // Y al revés: si el corto sube, PIERDE. Es la mitad que un signo invertido
  // haría desaparecer.
  const malo = resultadoContraEntrada({ intencion: 'cover', lado: 'buy', entrada: 190, salida: 199.5, cantidad: 30 });
  ok(malo.pnl_usd === -285 && malo.pnl_pct === -5, 'un corto que sube pierde, y el % acompaña al dinero',
    JSON.stringify([malo.pnl_usd, malo.pnl_pct]));

  // Sin intención journaleada (filas viejas) se cae al lado de la POSICIÓN.
  const viejo = resultadoContraEntrada({ intencion: null, lado: 'buy', ladoPosicion: 'corto', entrada: 190, salida: 186, cantidad: 30 });
  ok(viejo && viejo.pnl_usd === 120, 'una fila sin `intencion` usa el lado de la posición: mismo dato por otro camino');
  const apertura = resultadoContraEntrada({ intencion: null, lado: 'buy', ladoPosicion: null, entrada: null, salida: 510, cantidad: 12 });
  ok(apertura === null, 'y una compra sobre un nombre que no se tenía sigue sin realizar nada');
}

// ── 4) LAS PARCIALES SE VEN PARCIALES ────────────────────────────────
console.log('\n── una parcial ──');
{
  const d = detalleDeOrden({
    orden: { symbol: 'MPC', side: 'buy', qty: 50, limit_price: 188 },
    fill: { symbol: 'MPC', side: 'buy', qty: 50, filled_qty: 18, filled_avg_price: 187.5,
      filled_at: '2026-09-21T19:59:40Z', order_status: 'expired', result: 'approved' },
  });
  ok(d.estado === 'parcial', 'se llama parcial, no llena');
  ok(d.cantidad_llena === 18 && d.cantidad_sin_llenar === 32, 'dice cuánto se llenó Y cuánto NO', JSON.stringify([d.cantidad_llena, d.cantidad_sin_llenar]));
  ok(d.monto_usd === 3375, 'el monto es sobre lo LLENADO, no sobre lo pedido', String(d.monto_usd));
  ok(d.monto_pedido_usd === 9400, 'y lo pedido viaja al lado, para poder leer la parcial contra su tamaño', String(d.monto_pedido_usd));
  ok(/ya cerró/.test(d.motivo) && /NO se van a llenar/.test(d.motivo),
    'con la orden ya terminal, el motivo dice que las que faltan no van a llegar', d.motivo);

  const viva = detalleDeOrden({
    orden: { symbol: 'MPC', side: 'buy', qty: 50, limit_price: 188 },
    fill: { symbol: 'MPC', side: 'buy', qty: 50, filled_qty: 18, filled_avg_price: 187.5, order_status: 'partially_filled', result: 'approved' },
  });
  ok(/sigue viva/.test(viva.motivo), 'y una parcial todavía abierta se distingue de una que ya cerró', viva.motivo);
}

// ── 5) LAS QUE NO LLENARON TAMBIÉN APARECEN ──────────────────────────
console.log('\n── las que no llenaron ──');
{
  const expirada = detalleDeOrden({
    orden: { symbol: 'NKE', side: 'buy', qty: 30, limit_price: 72 },
    fill: { symbol: 'NKE', side: 'buy', qty: 30, filled_qty: 0, filled_avg_price: null, order_status: 'expired', result: 'approved' },
  });
  ok(expirada.estado === 'sin_llenar', 'una orden terminal sin fill es `sin_llenar`');
  ok(/el límite nunca se tocó/.test(expirada.motivo), 'y el motivo dice POR QUÉ, no solo el estado de Alpaca', expirada.motivo);
  ok(expirada.precio_ejecucion === null && expirada.monto_usd === null,
    'sin fill no se inventa un precio ni un monto — y `null` no es `$0`');

  const viva = detalleDeOrden({
    orden: { symbol: 'NKE', side: 'buy', qty: 30, limit_price: 72 },
    fill: { symbol: 'NKE', side: 'buy', qty: 30, filled_qty: null, order_status: 'accepted', result: 'approved' },
  });
  ok(viva.estado === 'pendiente', 'una orden viva es `pendiente`, no "no llenó"');
  ok(/reconcile/.test(viva.motivo), 'y se distingue de un fill que el reconcile todavía no trajo', viva.motivo);

  const fallo = detalleDeOrden({
    orden: { symbol: 'XYZ', side: 'buy', qty: 5, limit_price: 10 },
    fill: { symbol: 'XYZ', side: 'buy', result: 'submit_failed', error: 'Alpaca 403: insufficient buying power' },
  });
  ok(fallo.estado === 'no_enviada' && /buying power/.test(fallo.motivo), 'un envío fallido no es una orden que no llenó: nunca salió', fallo.motivo);

  const seca = detalleDeOrden({ orden: { symbol: 'AAPL', side: 'buy', qty: 5, limit_price: 200 }, fill: null });
  ok(seca.estado === 'sin_enviar', 'y una corrida en seco calculó la orden y no la mandó');
}

// ── 6) EL RESUMEN NO CUENTA UN AUSENTE COMO CERO ─────────────────────
console.log('\n── el resumen del día ──');
{
  const entradas = entradasDeCuenta(CUENTA);
  const ordenes = [
    detalleDeOrden({ orden: { symbol: 'ADBE', side: 'buy', qty: 12, limit_price: 511.5 },
      fill: { filled_qty: 12, filled_avg_price: 500, order_status: 'filled', result: 'approved', symbol: 'ADBE', side: 'buy', qty: 12 } }),
    detalleDeOrden({ orden: { symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, intencion: 'sell' },
      fill: { filled_qty: 40, filled_avg_price: 265.1, order_status: 'filled', result: 'approved', symbol: 'PGR', side: 'sell', qty: 40 },
      entrada: entradas.PGR }),
    // Una venta de un nombre que NO estaba en el libro de antes: sin base.
    detalleDeOrden({ orden: { symbol: 'ZZZ', side: 'sell', qty: 10, limit_price: 50, intencion: 'sell' },
      fill: { filled_qty: 10, filled_avg_price: 50, order_status: 'filled', result: 'approved', symbol: 'ZZZ', side: 'sell', qty: 10 },
      entrada: null }),
  ];
  const r = resumenDeOrdenes(ordenes);
  ok(r.comprado_usd === 6000 && r.vendido_usd === 11104, 'compró y vendió, por separado', JSON.stringify([r.comprado_usd, r.vendido_usd]));
  ok(r.realizado_usd === 268, 'el realizado suma SOLO la salida con base: la otra no entra como 0', String(r.realizado_usd));
  ok(r.salidas_sin_base === 1 && /NO se cuentan como cero/.test(r.nota), 'y se dice cuántas quedaron fuera del total', r.nota);
  ok(r.llenas === 3, 'con el conteo por estado al lado');
}

// ── 7) EL FILL GANA SOBRE EL ECO DEL ENVÍO ───────────────────────────
// `enviadas` se escribe cuando la orden SALE: ahí dice `accepted` y no hay
// precio. Si esa copia ganara, el precio no aparecería nunca — que es
// exactamente el bug.
console.log('\n── el reconcile manda sobre el eco del envío ──');
{
  const e = {
    modo: 'enviado',
    candado: { ok: true },
    ordenes_calculadas: [
      { symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, intencion: 'sell', referencia: 264.3,
        client_order_id: 'arena-claude-f-2026-09-21-PGR-sell', closes_position: true, delta_weight: -0.1, notional_real: 10520 },
    ],
    enviadas: [
      { symbol: 'PGR', side: 'sell', qty: 40, result: 'approved', order_status: 'accepted',
        client_order_id: 'arena-claude-f-2026-09-21-PGR-sell', alpaca_order_id: 'abc' },
    ],
    descartadas: [],
  };
  const fills = fillsDeActions([
    { symbol: 'PGR', side: 'sell', qty: 40, result: 'approved', order_status: 'filled',
      filled_qty: 40, filled_avg_price: 265.1, filled_at: '2026-09-21T19:58:02Z',
      client_order_id: 'arena-claude-f-2026-09-21-PGR-sell', alpaca_order_id: 'abc', intencion: 'sell' },
  ]);
  const pub = ejecucionPublicable(e, { fills, entradas: entradasDeCuenta(CUENTA) });
  const o = pub.ordenes[0];
  ok(o.estado === 'llena' && o.precio_ejecucion === 265.1,
    'la orden calculada se queda con el fill reconciliado, no con el `accepted` del envío',
    JSON.stringify([o.estado, o.precio_ejecucion]));
  ok(o.resultado_contra_entrada.pnl_usd === 268, 'y su resultado contra la entrada sale completo');
  ok(o.cantidad === 40 && o.monto === 10520, 'los nombres viejos siguen ahí: un consumidor de antes no se rompe');
  ok(pub.resumen && pub.resumen.vendido_usd === 10604, 'con el resumen del día calculado en el servidor', JSON.stringify(pub.resumen && pub.resumen.vendido_usd));

  // SIN los fills (corrida de PRUEBA, que no manda nada) degrada en vez de romperse.
  const prueba = ejecucionPublicable({ ...e, modo: 'dry', enviadas: [] }, {});
  ok(prueba.ordenes[0].estado === 'sin_enviar' && prueba.ordenes[0].precio_ejecucion === null,
    'una corrida de prueba no tiene fills, y eso se publica como `sin_enviar` — no como una orden pendiente');
}

// ── 8) LA CLAVE ES EL client_order_id ────────────────────────────────
console.log('\n── el pareo orden ↔ fill ──');
{
  ok(claveDeOrden({ client_order_id: 'x', symbol: 'PGR', side: 'sell' }) === 'x', 'manda el client_order_id');
  ok(claveDeOrden({ symbol: 'pgr', side: 'SELL' }) === 'PGR|sell', 'y el respaldo normaliza símbolo y lado');

  // El respaldo NO pisa una clave que ya está: la primera orden se la queda.
  const m = fillsDeActions([
    { symbol: 'PGR', side: 'sell', filled_qty: 10, filled_avg_price: 100, order_status: 'filled' },
    { symbol: 'PGR', side: 'sell', filled_qty: 5, filled_avg_price: 200, order_status: 'filled' },
  ]);
  ok(m.get('PGR|sell').filled_avg_price === 100, 'con dos órdenes del mismo símbolo y lado sin id, gana la primera');
}

// ── 9) EL CAMINO DE /liga: de `actions` a órdenes ────────────────────
console.log('\n── /liga arma las órdenes desde `actions` ──');
{
  const ordenes = ordenesDeActions([
    { symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, result: 'approved', order_status: 'filled',
      filled_qty: 40, filled_avg_price: 265.1, filled_at: '2026-09-21T19:58:02Z', intencion: 'sell',
      alpaca_order_id: 'a1', client_order_id: 'c1' },
    // Contrato VIEJO: el guard la descartó y nunca salió. No tiene id ni estado.
    { symbol: 'ZM', side: 'buy', qty: 10, limit_price: 70, result: 'rejected', reason: 'fuera de la banda de ±2%' },
  ], CUENTA);
  ok(ordenes.length === 2, 'las dos salen: la que llenó y la que nunca se mandó');
  ok(ordenes[0].precio_ejecucion === 265.1 && ordenes[0].resultado_contra_entrada.pnl_usd === 268,
    'la que llenó trae precio y resultado');
  ok(ordenes[1].estado === 'no_enviada' && /banda/.test(ordenes[1].motivo),
    'y la descartada por el guard dice que nunca salió, con el motivo del guard', ordenes[1].motivo);
}

// ── 10) EL CONTRATO CON LAS PANTALLAS ────────────────────────────────
console.log('\n── las dos pantallas leen lo que el servidor publica ──');
{
  const liga = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');
  const libros = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');

  ok(/ordenes: ordenesDeActions/.test(api), '/api/leaderboard publica las órdenes ya armadas');
  ok(/j\.ordenes/.test(liga) && /precio_ejecucion/.test(liga), 'y /liga las lee con su precio de ejecución');
  ok(/resultado_contra_entrada/.test(liga) && /resultado_contra_entrada/.test(libros),
    'las dos pantallas muestran el resultado contra la entrada');
  ok(/cantidad_sin_llenar/.test(liga) && /cantidad_sin_llenar/.test(libros), 'y las dos dicen lo que quedó sin llenar');
  ok(!/\bfilled<\/span>|order_status\?\(' · '/.test(liga), 'y /liga ya no publica el `filled` pelado que lo originó');
  ok(/intencion: o\.intencion \|\| null/.test(run),
    '`actions` journalea la INTENCIÓN: sin ella, una venta de cierre y la apertura de un corto se ven iguales');
}

// ── 10b) LA FORMA REAL DE PROD, QUE LA SINTÉTICA NO TENÍA ────────────
// `ordenes_calculadas` NO lleva `client_order_id`: se lo pone `enviarOrdenes`
// DESPUÉS, al mandar. Un test que se lo inventa prueba un caso que no existe.
// Éste usa la forma exacta que journalea `legsAOrdenes`.
console.log('\n── la forma que de verdad tiene una corrida viva ──');
{
  const CID = 'arena-claude-f-2026-09-23-PGR-sell';
  const e = {
    modo: 'enviado', candado: { ok: true },
    // TAL CUAL sale de `legsAOrdenes`: sin client_order_id, sin alpaca_order_id.
    ordenes_calculadas: [{
      symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, intencion: 'sell',
      referencia: 264.3, notional_objetivo: 10572, notional_real: 10520,
      weight_from: 0.10, weight_to: 0, delta_weight: -0.1, closes_position: true,
    }],
    // Y `enviadas` SÍ lo lleva: es lo que rompía el pareo.
    enviadas: [{ symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, result: 'approved',
      order_status: 'accepted', client_order_id: CID, alpaca_order_id: 'a1' }],
    descartadas: [],
  };
  const fills = fillsDeActions([{
    symbol: 'PGR', side: 'sell', qty: 40, limit_price: 263, result: 'approved', order_status: 'filled',
    filled_qty: 40, filled_avg_price: 265.1, filled_at: '2026-09-23T19:58:02Z',
    client_order_id: CID, alpaca_order_id: 'a1', intencion: 'sell',
  }]);
  const pub = ejecucionPublicable(e, { fills, entradas: entradasDeCuenta(CUENTA) });
  const o = pub.ordenes[0];
  ok(o.precio_ejecucion === 265.1,
    'la orden calculada encuentra su fill por SÍMBOLO|lado, que es la única clave que comparten', String(o.precio_ejecucion));
  ok(o.resultado === 'approved' && o.estado_alpaca === 'filled',
    'y el resultado del envío también se pega: buscarlo solo por client_order_id devolvía null en TODA corrida viva',
    JSON.stringify([o.resultado, o.estado_alpaca]));
  ok(o.deslizamiento_pp === -0.303, 'el deslizamiento sale de la referencia journaleada por el motor', String(o.deslizamiento_pp));

  // Sin fill conciliado todavía, el eco del envío igual tiene que llegar.
  const sinFill = ejecucionPublicable(e, { fills: new Map(), entradas: {} });
  ok(sinFill.ordenes[0].estado === 'pendiente' && sinFill.ordenes[0].resultado === 'approved',
    'antes del reconcile la orden sale `pendiente` y NO `sin_enviar`: se mandó, solo que no sabemos a cuánto llenó',
    JSON.stringify([sinFill.ordenes[0].estado, sinFill.ordenes[0].resultado]));
}

// ── 10c) LAS SALIDAS DE RIESGO ───────────────────────────────────────
// Una fila `risk_exit` no tiene `context.ejecucion` —la escribió la red
// determinista, no el contrato objetivo— pero sí tiene `actions` con su fill.
// Eran las únicas ventas que seguían sin decir a cuánto se vendieron, y son
// justo las que más importan: las que disparó un stop.
console.log('\n── las ventas que disparó un stop ──');
{
  const o = ordenesDeActions([{
    symbol: 'PGR', side: 'sell', qty: 40, limit_price: 250,
    // OJO: la red determinista escribe `reference`, en inglés. Leer solo
    // `referencia` dejaba estas órdenes sin deslizamiento.
    reference: 252, channels: ['risk_exit'], origin: 'catastrophic_stop',
    result: 'approved', order_status: 'filled',
    filled_qty: 40, filled_avg_price: 251.4, filled_at: '2026-09-23T13:35:00Z',
    alpaca_order_id: 'x1', client_order_id: 'arena-claude-2026-09-23-PGR:exit',
  }], CUENTA)[0];
  ok(o.precio_ejecucion === 251.4 && o.monto_usd === 10056, 'el stop dice a cuánto vendió');
  ok(o.resultado_contra_entrada.pnl_usd === -280,
    'y su resultado contra la entrada: un stop que cortó una pérdida la muestra', String(o.resultado_contra_entrada.pnl_usd));
  ok(o.deslizamiento_pp === 0.238, '`reference` se lee igual que `referencia`: es el mismo dato con dos nombres', String(o.deslizamiento_pp));
}

// ── 11) EL DESLIZAMIENTO, AGREGADO ───────────────────────────────────
// La pregunta: ¿alguno paga sistemáticamente más que los otros por el MISMO
// mecanismo? Si sí, no es el modelo — es el límite marketable trabajando mal
// para él.
console.log('\n── el deslizamiento por agente ──');
{
  const o = (ticker, lado, ref, ejec, qty, limite) => detalleDeOrden({
    orden: { symbol: ticker, side: lado, qty, limit_price: limite, referencia: ref },
    fill: { symbol: ticker, side: lado, qty, filled_qty: qty, filled_avg_price: ejec,
      filled_at: '2026-09-23T15:00:00Z', order_status: 'filled', result: 'approved' },
  });

  // Compra a 100 que llena a 100.20 → +0.2pp (peor). Venta a 100 que llena a
  // 99.80 → +0.2pp TAMBIÉN: el signo se normaliza para que positivo sea peor
  // de los dos lados. Sin eso, promediar compras y ventas las cancelaría.
  const compra = o('AAA', 'buy', 100, 100.2, 10, 100.5);
  const venta = o('BBB', 'sell', 100, 99.8, 10, 99.5);
  ok(compra.deslizamiento_pp === 0.2 && venta.deslizamiento_pp === 0.2,
    'positivo es PEOR de los dos lados: comprar caro y vender barato dan el mismo signo',
    JSON.stringify([compra.deslizamiento_pp, venta.deslizamiento_pp]));

  const r = resumenDeslizamiento([compra, venta, o('CCC', 'buy', 100, 99.9, 10, 100.5)]);
  ok(r.fills === 3, 'cuenta los fills medibles');
  ok(r.media_pp === 0.1, 'la media incluye el que ejecutó MEJOR que la referencia, con su signo negativo: (0.2 + 0.2 − 0.1) / 3', String(r.media_pp));
  ok(r.por_lado.compras.fills === 2 && r.por_lado.ventas.fills === 1, 'y se abre por lado');
  ok(r.mejor.ticker === 'CCC' && r.mejor.pp === -0.1, 'nombra el mejor y el peor: un promedio sin extremos no se puede auditar');

  // LA PONDERADA: un agente que desliza feo en una orden chica y bien en una
  // grande tiene una media horrible y un costo real ínfimo. Las dos, o ninguna.
  const chicaFea = o('DDD', 'buy', 100, 100.4, 2, 100.5);      // 0.4pp sobre $200
  const grandeBuena = o('EEE', 'buy', 100, 100.01, 200, 100.5); // 0.01pp sobre $20k
  const p = resumenDeslizamiento([chicaFea, grandeBuena]);
  ok(p.media_pp === 0.205, 'la media dice cómo ejecuta', String(p.media_pp));
  ok(p.ponderada_pp === 0.014, 'y la ponderada por monto dice cuánto le costó — son números distintos a propósito', String(p.ponderada_pp));
  ok(p.costo_estimado_usd === 2.8, 'con el costo en dólares al lado, que es lo que vuelve accionable al porcentaje', String(p.costo_estimado_usd));

  // EL TOPE: un fill no puede pasar su límite. Pegarse al límite todas las
  // veces no es "deslizar más": es la firma de una banda mal calibrada.
  const t = resumenDeslizamiento([o('FFF', 'buy', 100, 100.5, 10, 100.5), compra]);
  ok(t.en_el_tope === 1 && t.en_el_tope_pct === 50,
    'se cuenta cuántos llenaron PEGADOS al límite, sin necesitar saber la banda', JSON.stringify([t.en_el_tope, t.en_el_tope_pct]));

  // Sin referencia no hay deslizamiento, y eso NO es un cero.
  const vacio = resumenDeslizamiento([detalleDeOrden({
    orden: { symbol: 'GGG', side: 'buy', qty: 10, limit_price: 100 },
    fill: { symbol: 'GGG', side: 'buy', qty: 10, filled_qty: 10, filled_avg_price: 99, order_status: 'filled', result: 'approved' },
  })]);
  ok(vacio.fills === 0 && vacio.media_pp === null && /no hay con qué|sin las dos/.test(vacio.nota),
    'sin referencia del riel no se publica un 0 que se leería como "ejecuta perfecto"', vacio.nota);
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
