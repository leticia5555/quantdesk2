// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-rebalance.js — B5: del PORTAFOLIO OBJETIVO a las órdenes.
//
// JS PURO, sin I/O. El PM entrega un objetivo —`{pesos: {TICKER: ±%}, cash}`—
// y esto calcula la diferencia contra el libro REAL y produce las órdenes.
//
// El cambio de contrato es más grande de lo que parece. Antes el PM entregaba
// ÓRDENES: "compro 50 de NVDA". Eso mide "¿sabe elegir entre lo que le pusimos
// enfrente?". Ahora entrega un LIBRO: "quiero estar 12% en NVDA". Eso mide cómo
// se posiciona — y de paso hace imposible el bug de la omisión silenciosa.
//
// ── LAS CUATRO DECISIONES, y qué cambia cada una ─────────────────────
//
// 1. OMISIÓN = 0% = SALIDA. Un ticker que el PM no menciona SE CIERRA. La
//    alternativa ("lo que no menciono se queda") deja que la omisión pase por
//    decisión, que es exactamente la amnesia que la T2 vino a arreglar. Con
//    omisión = salida, TODO el libro se re-afirma en cada corrida o desaparece:
//    es el pronunciamiento obligatorio hecho estructura, no hecho instrucción.
//
//    EL RIESGO ES REAL y hay que decirlo: un modelo que no lo entienda se
//    liquida solo en su primera corrida. Va dicho tres veces en el prompt y hay
//    un test que verifica que un objetivo vacío produce la liquidación completa
//    (no un no-op silencioso).
//
// 2. BANDA DE NO-NEGOCIACIÓN: 2pp. Sin banda, el motor negocia contra el drift
//    de precios todos los días — una posición que el PM quiere al 12% y cerró
//    en 11.6% generaría una orden que no expresa NINGUNA decisión. Con banda,
//    en el journal solo aparecen las órdenes que el PM decidió.
//    EXCEPCIÓN: un cierre completo NUNCA se frena por banda. "Salir del 1.5%"
//    es una decisión aunque el movimiento sea chico.
//
// 3. ORDEN DE EJECUCIÓN: ventas → coberturas → compras → cortos nuevos. Si no,
//    una rotación completa viola el riel de bruto a mitad de secuencia o se
//    queda sin cash. Lo que LIBERA capacidad va primero; lo que la CONSUME,
//    después.
//
// 4. UN OBJETIVO QUE VIOLA UN RIEL SE DESCARTA ENTERO, no se escala. Escalarlo
//    lo convierte en uno que el PM nunca propuso, y el journal publicaría como
//    suya una tesis que no corresponde a las posiciones. La validación vive en
//    _lib/arena-rails.js; acá se asume que ya pasó.
// ═══════════════════════════════════════════════════════════════

import { RAILS } from './arena-rails.js';

// Peso actual de cada posición, con signo (corto negativo).
export function currentWeights(positions, equity) {
  const w = {};
  if (!Number.isFinite(equity) || equity <= 0) return w;
  for (const p of positions || []) {
    const sym = String(p.symbol || '').trim().toUpperCase();
    const mv = Number(p.market_value);
    if (!sym || !Number.isFinite(mv)) continue;
    // EL SIGNO LO MANDA `qty`, NO `market_value`. Alpaca devuelve el
    // market_value negativo en un corto casi siempre — pero "casi siempre" acá
    // es el peor error posible: leer un corto como un largo del mismo tamaño
    // invierte la dirección del libro entero y el motor de rebalanceo compraría
    // donde tenía que cubrir.
    //
    // `qty` es el conteo de acciones y su signo NO es ambiguo. Se usa ése
    // cuando está, y el de market_value solo como respaldo.
    const qty = Number(p.qty);
    const signo = Number.isFinite(qty) && qty !== 0
      ? Math.sign(qty)
      : (mv !== 0 ? Math.sign(mv) : 1);
    w[sym] = (Math.abs(mv) / equity) * signo;
  }
  return w;
}

// ── EL DIFF ──────────────────────────────────────────────────────────
// Devuelve una fila por símbolo con lo que hay que hacer, ANTES de ordenarlas.
// `legs` es lo que distingue una venta de una cobertura y una compra de un
// corto nuevo: no es cosmético, es lo que decide el ORDEN de ejecución.
//
//   sell        — reducir/cerrar un largo          (libera cash)
//   cover       — reducir/cerrar un corto          (libera capacidad de corto)
//   buy         — abrir/aumentar un largo          (consume cash)
//   short       — abrir/aumentar un corto          (consume capacidad)
//
// Un cruce de signo (largo → corto) produce DOS patas: se cierra el largo y se
// abre el corto. Tratarlo como una sola orden gigante pasaría por plano sin
// pasar por plano — y el riel de bruto se validaría sobre un estado que nunca
// existe.
export function diffToLegs(current, target, equity, { band = RAILS.no_trade_band } = {}) {
  const legs = [];
  const skipped = [];
  const symbols = [...new Set([...Object.keys(current || {}), ...Object.keys(target || {})])].sort();

  for (const sym of symbols) {
    const actual = Number(current[sym]) || 0;
    // OMISIÓN = 0% = SALIDA. Acá es donde esa decisión se vuelve código: un
    // símbolo que está en `current` y no en `target` recibe objetivo 0.
    const objetivo = Number(target[sym]) || 0;
    const delta = objetivo - actual;
    if (Math.abs(delta) < 1e-9) continue;

    const cierreTotal = objetivo === 0 && actual !== 0;
    // LA BANDA, y su excepción. Un cierre completo nunca se frena: "salir del
    // 1.5%" es una decisión aunque el movimiento sea chico.
    if (!cierreTotal && Math.abs(delta) < band) {
      skipped.push({
        symbol: sym, current: +actual.toFixed(4), target: +objetivo.toFixed(4), delta: +delta.toFixed(4),
        reason: `movimiento de ${(Math.abs(delta) * 100).toFixed(2)}pp < banda de ${(band * 100).toFixed(0)}pp — no expresa una decisión, expresa el drift del precio`,
      });
      continue;
    }

    // CRUCE DE SIGNO: dos patas, no una.
    if (actual > 0 && objetivo < 0) {
      legs.push(mkLeg(sym, 'sell', actual, 0, equity, 'cierra el largo antes de cruzar a corto'));
      legs.push(mkLeg(sym, 'short', 0, objetivo, equity, 'abre el corto después de cerrar el largo'));
      continue;
    }
    if (actual < 0 && objetivo > 0) {
      legs.push(mkLeg(sym, 'cover', actual, 0, equity, 'cubre el corto antes de cruzar a largo'));
      legs.push(mkLeg(sym, 'buy', 0, objetivo, equity, 'abre el largo después de cubrir'));
      continue;
    }

    const lado = actual >= 0 && objetivo >= 0
      ? (delta > 0 ? 'buy' : 'sell')
      : (delta > 0 ? 'cover' : 'short');   // los dos en el lado corto: delta > 0 reduce el corto
    legs.push(mkLeg(sym, lado, actual, objetivo, equity, cierreTotal ? 'cierre completo (el objetivo lo omitió o lo puso en 0)' : null));
  }
  return { legs: orderLegs(legs), skipped };
}

function mkLeg(symbol, side, from, to, equity, note) {
  const deltaPeso = to - from;
  return {
    symbol, side,
    weight_from: +from.toFixed(4), weight_to: +to.toFixed(4),
    delta_weight: +deltaPeso.toFixed(4),
    // En dólares, SIEMPRE positivo: el lado ya dice la dirección. Un notional
    // con signo más un side es una forma de que los dos se contradigan.
    notional: Number.isFinite(equity) ? +Math.abs(deltaPeso * equity).toFixed(2) : null,
    closes_position: to === 0,
    ...(note ? { note } : {}),
  };
}

// ── EL ORDEN ─────────────────────────────────────────────────────────
// Lo que LIBERA capacidad primero; lo que la CONSUME, después. Dentro de cada
// grupo, por notional descendente — si algo va a fallar por falta de cash, que
// falle lo chico y no lo que movía la tesis. Y el símbolo como desempate final,
// para que dos corridas con los mismos datos produzcan la MISMA secuencia (sin
// eso, el replay no reproduce).
const ORDEN = { sell: 0, cover: 1, buy: 2, short: 3 };

export function orderLegs(legs) {
  return [...legs].sort((a, b) => (ORDEN[a.side] - ORDEN[b.side])
    || ((b.notional || 0) - (a.notional || 0))
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

// ── ÓRDENES PENDIENTES QUE YA NO APLICAN ─────────────────────────────
// Una orden abierta de ayer que apunta a un peso que el objetivo de hoy ya no
// quiere es una decisión vieja esperando ejecutarse. Se cancela.
//
// LA REGLA ES CONSERVADORA A PROPÓSITO: se cancela lo que NO tiene una pata en
// la misma dirección en el plan de hoy. Dejar viva una orden que el objetivo
// nuevo contradice es peor que cancelar una que igual se iba a re-emitir —
// cancelar cuesta una llamada, ejecutar una decisión que el PM ya cambió cuesta
// una posición que nadie quiso.
export function staleOrders(openOrders, legs) {
  const porSimbolo = new Map();
  for (const l of legs || []) {
    if (!porSimbolo.has(l.symbol)) porSimbolo.set(l.symbol, new Set());
    porSimbolo.get(l.symbol).add(l.side === 'buy' || l.side === 'cover' ? 'buy' : 'sell');
  }
  const out = [];
  for (const o of openOrders || []) {
    const sym = String(o.symbol || '').trim().toUpperCase();
    const side = String(o.side || '').toLowerCase();
    const quiere = porSimbolo.get(sym);
    if (!quiere) {
      out.push({ id: o.id, symbol: sym, side, reason: 'el objetivo de hoy no toca este nombre: la orden es una decisión vieja esperando ejecutarse' });
      continue;
    }
    if (!quiere.has(side)) {
      out.push({ id: o.id, symbol: sym, side, reason: `el objetivo de hoy va en la dirección contraria (${[...quiere].join('/')}) — esta orden ejecutaría una decisión que el PM ya cambió` });
    }
  }
  return out;
}

// ── EL PLAN COMPLETO ─────────────────────────────────────────────────
// Junta todo: el diff, las canceladas, y los RECORTES de riel (que van PRIMERO
// de todo — son la red determinista, no la decisión del PM, y tienen
// precedencia sobre lo que el PM haya pedido para ese nombre).
export function buildRebalance({ positions = [], openOrders = [], equity, target = {}, trims = [], band = RAILS.no_trade_band } = {}) {
  const current = currentWeights(positions, equity);

  // EL RECORTE GANA. Si la red determinista decidió recortar un nombre, el
  // objetivo del PM para ese nombre no puede ser mayor que el riel — aunque él
  // lo haya pedido y aunque el objetivo haya pasado la validación (pudo pasar
  // porque el peso OBJETIVO cabía; lo que se pasó es el peso REAL de hoy).
  const objetivo = { ...target };
  const recortes = [];
  for (const t of trims || []) {
    const pedido = objetivo[t.symbol];
    const tope = t.weight_after;
    const acotado = pedido == null
      ? tope                                                    // no lo mencionó: queda en el riel, no en cero
      : (t.side === 'short' ? Math.max(pedido, tope) : Math.min(pedido, tope));
    objetivo[t.symbol] = acotado;
    recortes.push({ ...t, target_asked: pedido ?? null, target_applied: +acotado.toFixed(4) });
  }

  const { legs, skipped } = diffToLegs(current, objetivo, equity, { band });
  return {
    current, target: objetivo,
    legs, skipped,
    cancel: staleOrders(openOrders, legs),
    rail_trims: recortes,
    turnover: +legs.reduce((s, l) => s + Math.abs(l.delta_weight), 0).toFixed(4),
  };
}
