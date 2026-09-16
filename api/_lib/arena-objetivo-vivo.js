// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-objetivo-vivo.js — EL CONTRATO OBJETIVO, EN VIVO.
//
// Traduce un PORTAFOLIO OBJETIVO ya validado por los rieles a ÓRDENES REALES.
// Es la única pieza nueva que toca dinero, y por eso vive sola: todo lo demás
// (el loop, los rieles, el rebalanceo) ya corrió en sombra durante días.
//
// ── LO QUE NO HACE ───────────────────────────────────────────────────
// No decide, no valida pesos y no llama al LLM. Entra un `rebalance` con sus
// patas; sale una lista de órdenes ejecutables o una negativa con motivo.
//
// ── LA REGLA DE LA CASA, INTACTA ─────────────────────────────────────
// JAMÁS órdenes a mercado. Todo sale como LÍMITE MARKETABLE: un límite puesto
// del lado agresivo para asegurar el fill, pero con un techo. Una orden a
// mercado en un libro ilíquido es cómo se paga 8% de slippage sin que nadie
// apruebe ese precio — la cicatriz Polymarket.
//
// ── POR QUÉ EL PRECIO VA POR SÍMBOLO Y NO UNO GLOBAL ─────────────────
// Cada pata se precia con su propia referencia (el snapshot que ya trajeron los
// rieles). Un símbolo sin precio NO se manda: fail closed, igual que R9 y R11.
// Un precio inventado es una orden a un precio que nadie aprobó.
// ═══════════════════════════════════════════════════════════════

import { createLimitOrder } from './alpaca.js';

// ── LA BANDERA ───────────────────────────────────────────────────────
// TRES estados, no dos. El escalón intermedio existe porque el código que manda
// órdenes es el único de todo el Arena que no se pudo probar contra la realidad:
// la sombra prueba la decisión, no la ejecución.
//
//   (sin poner) · '0'  → contrato VIEJO. Comportamiento idéntico al de hoy.
//   'objetivo_dry'     → contrato NUEVO: decide, calcula las órdenes, las
//                        journalea COMPLETAS — y no manda ninguna.
//   'objetivo'         → contrato NUEVO y las manda.
//
// El escalón `dry` es lo que convierte "confío en que las órdenes están bien"
// en "vi las órdenes que iba a mandar". Cuesta una ronda.
export const CONTRATO_VIEJO = 'acciones';
export const CONTRATO_OBJETIVO = 'objetivo';
export const CONTRATO_OBJETIVO_DRY = 'objetivo_dry';

export function contratoActivo(env = process.env) {
  const v = String(env.ARENA_CONTRATO || '').trim().toLowerCase();
  if (v === CONTRATO_OBJETIVO) return CONTRATO_OBJETIVO;
  if (v === CONTRATO_OBJETIVO_DRY) return CONTRATO_OBJETIVO_DRY;
  return CONTRATO_VIEJO;
}

export const usaObjetivo = (env = process.env) => contratoActivo(env) !== CONTRATO_VIEJO;
export const mandaOrdenes = (env = process.env) => contratoActivo(env) === CONTRATO_OBJETIVO;

// ── EL LÍMITE MARKETABLE, SIMÉTRICO ──────────────────────────────────
// Vender: por DEBAJO del mercado. Comprar: por ENCIMA. En los dos casos el
// límite es agresivo para que llene, y en los dos casos existe: es el techo que
// una orden a mercado no tiene.
//
// La banda por defecto es la misma que usan las salidas de riesgo. Redondeo a
// centavos porque Alpaca exige tick de $0.01 y un precio con más decimales se
// rechaza entero.
export const BANDA_MARKETABLE = Number(process.env.ARENA_MARKETABLE_BAND) || 0.005;

export function limiteMarketable(referencia, lado, banda = BANDA_MARKETABLE) {
  const r = Number(referencia);
  const b = Number(banda);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(b) || b < 0 || b >= 1) return null;
  const compra = lado === 'buy';
  const p = compra ? r * (1 + b) : r * (1 - b);
  const redondeado = Math.round(p * 100) / 100;
  return redondeado > 0 ? redondeado : null;
}

// Pata del rebalanceo → lado de Alpaca. Alpaca solo conoce `buy` y `sell`; las
// cuatro intenciones del rebalanceo se colapsan a esas dos, y perder la
// intención original sería perder por qué se mandó.
const LADO_ALPACA = { buy: 'buy', cover: 'buy', sell: 'sell', short: 'sell' };

// ── PATAS → ÓRDENES ──────────────────────────────────────────────────
// `meta` es el mismo objeto que alimentó los rieles: trae `price` y `tradable`.
// Se reusa a propósito — pedir precios otra vez acá abriría la puerta a que la
// orden se precie con un número distinto del que validó el riel.
//
// `permitirCortos` es explícito y default false: la T2 es long-only por diseño,
// y una pata `short` que aparezca acá es un bug, no una oportunidad.
export function legsAOrdenes({ legs = [], meta = {}, banda = BANDA_MARKETABLE, permitirCortos = false } = {}) {
  const ordenes = [];
  const descartadas = [];

  for (const leg of legs) {
    const sym = String((leg && leg.symbol) || '').toUpperCase();
    const m = meta[sym] || {};
    const lado = LADO_ALPACA[leg.side];

    if (!lado) {
      descartadas.push({ ...leg, motivo: `lado desconocido: "${leg.side}"` });
      continue;
    }
    if (!permitirCortos && (leg.side === 'short' || leg.side === 'cover')) {
      descartadas.push({ ...leg, motivo: `la T2 es long-only: una pata "${leg.side}" acá es un bug del rebalanceo, no una oportunidad. No se manda.` });
      continue;
    }
    // Fail closed, igual que R11: sin confirmación de Alpaca no se manda nada.
    if (m.tradable !== true) {
      descartadas.push({ ...leg, motivo: `Alpaca no confirma que ${sym} sea operable (tradable=${m.tradable ?? 'sin fila'})` });
      continue;
    }
    const precio = Number(m.price);
    if (!Number.isFinite(precio) || precio <= 0) {
      descartadas.push({ ...leg, motivo: `sin precio de referencia para ${sym}: una orden sin precio es una orden a un precio que nadie aprobó` });
      continue;
    }
    const limite = limiteMarketable(precio, lado, banda);
    if (limite == null) {
      descartadas.push({ ...leg, motivo: `no se pudo calcular el límite marketable para ${sym} (ref ${precio})` });
      continue;
    }
    // Cantidad ENTERA. Alpaca acepta fraccionarias en market/notional, pero la
    // regla de la casa es límite — y las límites fraccionarias no se aceptan.
    // `floor`, no `round`: redondear hacia arriba compra más de lo que el peso
    // pedía, y el riel ya aprobó ESE peso.
    const qty = Math.floor(Number(leg.notional) / precio);
    if (!Number.isFinite(qty) || qty < 1) {
      descartadas.push({
        ...leg,
        motivo: `el movimiento son $${Number(leg.notional).toFixed(2)} y una acción cuesta $${precio.toFixed(2)}: no alcanza para una acción entera. No es un error — es una posición demasiado chica para expresarse.`,
      });
      continue;
    }
    ordenes.push({
      symbol: sym, side: lado, qty, limit_price: limite,
      // La intención ORIGINAL viaja con la orden: `sell` y `short` son ambos
      // `sell` para Alpaca y significan cosas opuestas para el post-mortem.
      intencion: leg.side,
      referencia: precio,
      notional_objetivo: leg.notional,
      notional_real: +(qty * limite).toFixed(2),
      weight_from: leg.weight_from, weight_to: leg.weight_to, delta_weight: leg.delta_weight,
      closes_position: !!leg.closes_position,
    });
  }
  return { ordenes, descartadas };
}

// ── EL CANDADO DE LETY ───────────────────────────────────────────────
// "Si el motor manda una orden que no corresponde a ningún peso, apago la
// bandera esa misma ronda."
//
// Eso no puede depender de que alguien lo note leyendo el journal: se verifica
// ANTES de mandar, y si falla no se manda NADA de esa corrida. Un motor que
// inventa una orden no se corrige mandando las otras siete bien.
//
// Qué cuenta como "corresponde a un peso": el símbolo aparece en el objetivo
// del PM (con peso ≠ 0) o en el libro actual (y entonces la orden lo está
// cerrando o ajustando). Una orden sobre un símbolo que no está en NINGUNO de
// los dos no tiene de dónde haber salido.
export function verificarOrdenesContraPesos({ ordenes = [], target = {}, current = {} } = {}) {
  const enObjetivo = new Set(Object.keys(target || {}).map((s) => s.toUpperCase()));
  const enLibro = new Set(Object.keys(current || {}).map((s) => s.toUpperCase()));
  const huerfanas = [];

  for (const o of ordenes) {
    const sym = String(o.symbol || '').toUpperCase();
    if (enObjetivo.has(sym) || enLibro.has(sym)) continue;
    huerfanas.push({
      symbol: sym, side: o.side, qty: o.qty,
      motivo: 'la orden no corresponde a ningún peso del objetivo NI a ninguna posición del libro actual',
    });
  }

  // Y el lado tiene que ser coherente con el movimiento del peso: una compra
  // que baja el peso (o una venta que lo sube) significa que el signo se
  // invirtió en algún lado, y eso es peor que una orden de más.
  const incoherentes = [];
  for (const o of ordenes) {
    const d = Number(o.delta_weight);
    if (!Number.isFinite(d) || d === 0) continue;
    const sube = d > 0;
    const compra = o.side === 'buy';
    if (sube !== compra) {
      incoherentes.push({
        symbol: o.symbol, side: o.side, delta_weight: d,
        motivo: `la orden es ${o.side} pero el peso ${sube ? 'sube' : 'baja'} (${(d * 100).toFixed(2)}pp): el lado y el movimiento se contradicen`,
      });
    }
  }

  const ok = !huerfanas.length && !incoherentes.length;
  return {
    ok, huerfanas, incoherentes,
    ...(ok ? {} : {
      error: `CANDADO: ${huerfanas.length} orden(es) huérfana(s) y ${incoherentes.length} incoherente(s). NO se manda ninguna orden de esta corrida — un motor que inventa una orden no se corrige mandando las otras bien.`,
    }),
  };
}

// ── EL ENVÍO ─────────────────────────────────────────────────────────
// Secuencial y en el orden que ya trae la lista (libera capacidad primero,
// consume después — ver orderLegs). Paralelo ahorraría segundos y dejaría al
// broker decidiendo qué orden llega primero, que es justo lo que ese orden
// existe para controlar.
//
// Una orden que falla NO aborta las siguientes: se anota y se sigue. Media
// cartera puesta es un estado real que el próximo rebalanceo corrige; abortar a
// la mitad deja el mismo estado pero sin registro de qué faltó.
export async function enviarOrdenes({ ordenes = [], creds, runDate, agentId, runTag = 'f', now = new Date() } = {}) {
  const enviadas = [];
  for (const o of ordenes) {
    // Idempotencia del broker: el mismo símbolo, la misma corrida y el mismo
    // agente no pueden mandar dos órdenes aunque el cron se repita.
    const clientOrderId = `arena-${agentId}-${runTag}-${runDate}-${o.symbol}-${o.side}`.slice(0, 48);
    try {
      const orden = await createLimitOrder({
        symbol: o.symbol, qty: o.qty, side: o.side,
        limit_price: o.limit_price, client_order_id: clientOrderId,
      }, creds);
      enviadas.push({ ...o, result: 'approved', alpaca_order_id: orden.id, client_order_id: clientOrderId, order_status: orden.status });
    } catch (e) {
      enviadas.push({ ...o, result: 'submit_failed', client_order_id: clientOrderId, error: String((e && e.message) || e) });
    }
  }
  return enviadas;
}
