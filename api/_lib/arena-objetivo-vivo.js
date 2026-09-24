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

// ── CORTOS (D8, habilitados el 2026-09-18) ───────────────────────────
// Default ENCENDIDO: la decisión D8 del scope de la T2 —cerrada por Lety el
// 2026-09-15— habilitaba cortos desde el día 1, y el reglamento v4 los
// prohibió por un error de redacción, no por una decisión.
//
// La bandera existe para APAGARLOS sin deploy si algo sale mal en vivo
// (`ARENA_CORTOS=0` en Vercel), no para encenderlos: encender un corto sin la
// red de salida cableada es lo que este bloque vino a evitar, y por eso el
// cable entró ANTES que el permiso, en su propio commit.
//
// FAIL-SAFE DE LA BANDERA: cualquier valor distinto de '0'/'false'/'no' deja
// los cortos encendidos, PERO los rieles siguen siendo los que deciden. La
// bandera no es un riel: apaga una capacidad, no relaja un límite.
export function permiteCortos(env = process.env) {
  const v = String((env && env.ARENA_CORTOS) ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// ── EL LÍMITE MARKETABLE, SIMÉTRICO ──────────────────────────────────
// Vender: por DEBAJO del mercado. Comprar: por ENCIMA. En los dos casos el
// límite es agresivo para que llene, y en los dos casos existe: es el techo que
// una orden a mercado no tiene.
//
// La banda por defecto es la misma que usan las salidas de riesgo. Redondeo a
// centavos porque Alpaca exige tick de $0.01 y un precio con más decimales se
// rechaza entero.
export const BANDA_MARKETABLE = Number(process.env.ARENA_MARKETABLE_BAND) || 0.005;

// ── EL UMBRAL MÍNIMO PARA QUE UN DISPARADOR OPERE ────────────────────
// La banda de no-negociación (2pp) frena PATA POR PATA, y tiene una excepción
// deliberada: un cierre completo nunca se frena. Eso está bien para un ajuste
// —"salir del 1.5%" es una decisión, no drift— y es exactamente lo que dejó
// pasar el ida y vuelta de deepseek con NKE el primer día vivo: un objetivo la
// puso en 0 (cierre completo, exento) y el siguiente la volvió a poner. Las
// dos patas eran legales por separado.
//
// Este umbral es de otra naturaleza: mira el rebalanceo COMPLETO. Si el libro
// que el modelo quiere se parece tanto al que ya tiene que el turnover total
// no llega al piso, la corrida no manda NADA. No es una opinión sobre la
// decisión: es que un disparador despertó al agente, el agente miró, y lo que
// quiere hacer no justifica pagar el spread siete veces.
//
// SÓLO aplica a corridas por disparador. Las rondas fijas son el latido de la
// liga y tienen que poder expresar un ajuste chico: son tres al día, no doce.
export const TURNOVER_MINIMO_DISPARADOR = (() => {
  const n = Number(process.env.ARENA_TURNOVER_MIN_DISPARADOR);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;   // 5% del equity
})();

// ¿Este rebalanceo mueve lo suficiente como para justificar operar?
// Devuelve null cuando SÍ (no hay nada que decir) y el motivo cuando NO.
export function frenoPorTurnoverMinimo(rebalance, { esDisparador = false, minimo = TURNOVER_MINIMO_DISPARADOR } = {}) {
  if (!esDisparador || !rebalance) return null;
  // `Number(null)` es 0 y `Number('')` también: sin esta guarda, un turnover
  // ausente se leería como "movió 0%" y frenaría una decisión real. Es el
  // mismo trampolín que ya mordió en `returnPct`, y acá cuesta más caro: allá
  // publicaba un −100%, acá bloquea una orden.
  const t = rebalance.turnover == null || rebalance.turnover === '' ? NaN : Number(rebalance.turnover);
  if (!Number.isFinite(t)) return null;          // sin dato no se frena nada
  if (t >= minimo) return null;
  return {
    freno: 'turnover_bajo_el_minimo',
    turnover: t,
    minimo,
    detalle: `El rebalanceo mueve ${(t * 100).toFixed(2)}% del equity y el piso para una corrida por disparador es ${(minimo * 100).toFixed(0)}%. El agente miró y lo que quiere hacer no justifica el costo de operar. NO se mandó ninguna orden; el objetivo queda journaleado igual.`,
  };
}

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
// `permitirCortos` sigue siendo EXPLÍCITO, pero su default cambió el
// 2026-09-18: la T2 habilita cortos (D8). El parámetro no desaparece porque la
// sombra y los tests necesitan poder correr el motor con los cortos apagados
// sin tocar env — y porque un default no es un permiso: los rieles del corto
// (R2/R4/R5/R9/R10) se evalúan igual y rechazan antes de llegar acá.
export function legsAOrdenes({ legs = [], meta = {}, banda = BANDA_MARKETABLE, permitirCortos = permiteCortos() } = {}) {
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
      descartadas.push({ ...leg, motivo: `los cortos están APAGADOS en esta corrida (ARENA_CORTOS=0), así que una pata "${leg.side}" no se manda. La T2 los habilita por reglamento desde el 2026-09-18; si esto aparece sin que nadie haya apagado la bandera, es un bug.` });
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
// ── EL MINUTO DE LA CORRIDA ──────────────────────────────────────────
// `HHMM` en UTC. Es el mismo trozo que ya usa el contrato de ACCIONES
// (`runArenaDecide`), y se exporta para que los dos caminos no puedan divergir:
// el bug de abajo nació justo de que un camino tuviera el arreglo y el otro no.
export const minutoDeCorrida = (now = new Date()) => String(now.toISOString().slice(11, 16)).replace(':', '');

// ── EL ID QUE COLISIONABA CONSIGO MISMO (2026-09-24) ─────────────────
// EL BUG, medido en producción: 525 órdenes calculadas del 21 al 24 y ~216 que
// nunca llegaron a Alpaca, con las VENTAS fallando muchísimo más que las
// compras. Dos filas reales del mismo agente, el mismo día, el mismo ticker y
// el mismo lado, con cinco minutos de diferencia: la primera `approved`, la
// segunda `submit_failed`.
//
//     arena-control-f-2026-09-24-GDDY-buy      ← 19:31
//     arena-control-f-2026-09-24-GDDY-buy      ← 19:36, byte a byte el mismo
//
// El id llevaba agente, fecha, ticker y lado, y NO llevaba la corrida. Alpaca
// rechaza un `client_order_id` repetido, así que cada agente podía tocar cada
// nombre UNA vez por día por lado y todo lo demás moría con un 422.
//
// ── Y EL ARREGLO YA EXISTÍA, EN EL CAMINO QUE SE RETIRÓ ──────────────
// `runArenaDecide` —el contrato de ACCIONES— chocó con esto cuando entró la
// cadencia por evento, y lo resolvió agregando el tag de corrida y el minuto.
// Su comentario lo dice con todas las letras: *"Alpaca rechaza el id repetido
// — la segunda orden, la que el disparador produjo, moriría con un 422"*. El
// contrato OBJETIVO se escribió después y no se llevó el arreglo: peor, dejó
// `runTag: 'f'` escrito a mano en el llamador, así que todas las corridas se
// estampan con el tag de la revisión de piso.
//
// Es el patrón de la casa otra vez: una regla que entra por un camino y no por
// el otro.
//
// ── POR QUÉ LAS VENTAS FALLABAN MÁS ──────────────────────────────────
// Una compra se pide una vez y llena. Una venta se repite: se trimea, no llena,
// y la ronda siguiente vuelve a pedir el mismo trim del mismo nombre. La
// segunda petición es la que se cae — y el libro, que sí podía comprar y no
// podía deshacerse de nada, crece.
//
// ── QUÉ IDEMPOTENCIA SE CONSERVA Y CUÁL NO ───────────────────────────
// Se conserva la que importa: dos invocaciones de la MISMA corrida (un cron que
// se repite, un reintento de la lambda) caen en el mismo minuto y producen el
// mismo id, así que no se duplica la orden. Lo que deja de estar bloqueado es
// lo que nunca tuvo que estarlo: una ronda POSTERIOR pidiendo el mismo nombre.
// Que dos rondas distintas no se pisen lo garantiza el vigilante con sus
// marcadores de "ya se hizo hoy", que es la capa donde vive esa decisión.
//
// ── SIN RECORTE CIEGO ────────────────────────────────────────────────
// Antes terminaba en `.slice(0, 48)`. Un recorte por la cola se come primero el
// LADO: `…-GDDY-buy` y `…-GDDY-sell` truncados al mismo largo serían el mismo
// id, y una compra cancelaría una venta. Ahora el largo está acotado por
// construcción (el agente se capa a 10 caracteres, que es lo único de largo
// variable) y hay un test que lo verifica contra el registry entero — si entra
// un agente con un id largo, falla el test en vez de colisionar en vivo.
export const AGENTE_EN_ID = 10;

export function clientOrderIdObjetivo({ agentId, runTag = 'f', runDate, symbol, side, now = new Date() } = {}) {
  return `arena-${String(agentId || '').slice(0, AGENTE_EN_ID)}-${runTag}${minutoDeCorrida(now)}-${runDate}-${symbol}-${side}`;
}

export async function enviarOrdenes({ ordenes = [], creds, runDate, agentId, runTag = 'f', now = new Date() } = {}) {
  const enviadas = [];
  for (const o of ordenes) {
    // Idempotencia del broker ACOTADA A LA CORRIDA, no al día: ver arriba.
    const clientOrderId = clientOrderIdObjetivo({ agentId, runTag, runDate, symbol: o.symbol, side: o.side, now });
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
