// ═══════════════════════════════════════════════════════════════
// /api/arena-reset — APLANA las siete cuentas y re-basa la temporada.
//
// Lo dispara UNA PERSONA con curl, nunca un cron y nunca un LLM. Es el único
// endpoint del repo que cierra posiciones a MERCADO (la excepción declarada en
// _lib/alpaca.js) y el único que escribe `arena_state.baseline_*`.
//
// LOS SEIS PASOS, en este orden y por una razón cada uno:
//
//   1. PAUSA EL VIGILANTE. Va PRIMERO. El cron `*/5` puede caer en medio del
//      aplanado, ver siete libros a medio liquidar y despertar a los agentes
//      para que opinen sobre un libro que está dejando de existir. La pausa
//      vive en Neon (`arena_flags`, no una env var) porque apagar una env var
//      exige un redeploy, y un redeploy en medio de un aplanado es lo último
//      que uno quiere tocar. Vence sola: el peor caso es que el vigilante
//      vuelva solo en N minutos, nunca que quede apagado para siempre.
//   2. FOTO DE ANTES, cuenta por cuenta: equity, cash, posiciones y órdenes.
//      Sin la foto previa, "se vendió todo" es una afirmación sin evidencia.
//   3. CANCELA LAS ÓRDENES ABIERTAS. Antes de liquidar: una venta vieja
//      compitiendo con el aplanado deja un fill parcial y una orden huérfana.
//   4. LIQUIDA A MERCADO (`DELETE /v2/positions`). Alpaca no ofrece variante
//      límite acá, y un aplanado por límites es N órdenes que pueden no llenar
//      — una temporada que arranca con media cartera vieja adentro es peor que
//      un fill unos centavos peor.
//   5. VERIFICA. Re-lee posiciones y órdenes hasta que estén en cero o se
//      acabe el reloj. Un reset que reporta éxito sin re-leer es un reset que
//      no ocurrió. Lo que quedó abierto se NOMBRA.
//   6. RE-BASA Y REACTIVA. Escribe `baseline_at` / `baseline_equity` /
//      `baseline_id` por agente (el corte que la memoria del PM y el pico del
//      breaker van a respetar), levanta cualquier halt, journalea UNA fila
//      `rules_changed` de liga con el id que pidió Lety, y despausa el
//      vigilante.
//
//      EL BASELINE ES EL EQUITY REAL DE CADA CUENTA, no un $100k declarado.
//      Aplanar a mercado deja un residuo distinto en cada libro; con un
//      denominador compartido, ese residuo se le cobra a cada agente como
//      pérdida el primer día. El 2026-09-16: `control` −1.45%, `claude` −0.41%.
//      Esas dos cuentas corren el MISMO modelo con el MISMO prompt para medir
//      el piso de ruido entre sí, y un punto de diferencia metido por el
//      denominador es más grande que el ruido que están ahí para medir — y no
//      se distingue de él. `?baseline=<n>` fuerza el número declarado.
//   7. ABRE EL BENCHMARK PASIVO: $100k en SPY al precio de APERTURA de este
//      mismo día, y nunca más se toca. Va acá y no en un endpoint aparte
//      porque el benchmark tiene que arrancar en el MISMO instante que las
//      siete cuentas — si arranca un día después, mide otra temporada. Es
//      idempotente: si ya estaba abierto NO se re-abre (ver
//      _lib/arena-benchmark.js), así que volver a correr el reset no mueve el
//      precio de entrada. Si Alpaca no da precio, el reset NO falla: el
//      benchmark queda sin abrir y sale en `warnings`, porque aplanar siete
//      libros importa más que una línea de comparación.
//
// ── EL FIX DEL PICO, que es la mitad del trabajo ─────────────────────
// Aplanar las cuentas sin re-basar el pico del breaker es el footgun que ya
// estaba documentado: `max(equity)` arrastra el pico de ANTES del aplanado, un
// libro que vuelve a $100k desde un pico de $130k arranca en −23% de drawdown,
// y los siete quedan HALTED en su primera corrida. El baseline es ese corte,
// con fecha real y por agente (ver _lib/arena-baseline.js).
//
// El otro lado, que este endpoint AVISA en vez de tapar: si el equity que queda
// tras liquidar está por DEBAJO del baseline declarado, el piso de $100k mete un
// drawdown de arranque real. No es un bug del piso — es el baseline diciendo la
// verdad sobre una cuenta que no vale lo que se declaró. Sale en la respuesta
// como `starting_drawdown_pct` por cuenta y en `warnings`, y `?baseline=` o
// `ARENA_RESET_BASELINE_USD` lo corrigen sin deploy.
//
//   GET /api/arena-reset?dry=1        → PLAN: qué se cancelaría y se vendería,
//                                       cuenta por cuenta. CERO escrituras.
//   GET /api/arena-reset?confirm=1    → lo hace.
//   GET /api/arena-reset?confirm=1&agent=claude   → una sola cuenta
//   GET /api/arena-reset?confirm=1&id=arena-t2-2026-09-16   → baseline = equity real
//   GET /api/arena-reset?confirm=1&baseline=100000          → baseline DECLARADO
//
// SIN `confirm=1` NO HACE NADA: el default es el dry run. Un endpoint que
// liquida siete libros no puede vaciarlos porque alguien pegó la URL sin el
// resto de la línea.
//
// GATES: ARENA_ADMIN_KEY (la misma del smoke, _lib/arena-admin.js). NO exige
// ARENA_ENABLED — el reset es justamente lo que se corre con el Arena a punto
// de arrancar o recién apagado.
//
// ENV VARS: ARENA_ADMIN_KEY (obl) · ALPACA_<AGENTE>_KEY/SECRET · DATABASE_URL ·
//           ARENA_RESET_BASELINE_USD (opc, default 100000) ·
//           ARENA_RESET_WATCH_PAUSE_MIN (opc, default 15)
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import {
  getAccount, getPositions, getOrders, cancelAllOrders, closeAllPositions, getClock,
} from './_lib/alpaca.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_SEASON } from './_lib/arena-registry.js';
import {
  RESET_BASELINE_USD, setBaseline, pauseWatch, resumeWatch, startingDrawdown,
} from './_lib/arena-baseline.js';
import {
  BENCHMARK, abrirBenchmark, precioBenchmark, leerBenchmark,
} from './_lib/arena-benchmark.js';
import { PROMPT_VERSION } from './arena-run.js';

// Siete cuentas en paralelo, cada una con hasta 4 llamadas a Alpaca más el
// bucle de verificación. Mismo techo que el resto del Arena (plan Pro).
export const maxDuration = 300;

// Cuánto se espera a que los fills de mercado se reflejen. Con el mercado
// abierto un market order llena en segundos; con el mercado cerrado NO llena
// nunca (queda encolado al próximo open) y esperar sería tiempo tirado — por
// eso el bucle se salta entero cuando el reloj de Alpaca dice que está cerrado.
const VERIFY_TRIES = 6;
const VERIFY_WAIT_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resumen mínimo y legible de una posición/orden. La respuesta la lee una
// persona en una terminal: el objeto entero de Alpaca no ayuda a confirmar nada.
const posBrief = (p) => ({
  symbol: p.symbol, qty: Number(p.qty), side: p.side || null,
  market_value: Number(p.market_value), unrealized_pl: Number(p.unrealized_pl),
});
const ordBrief = (o) => ({ id: o.id, symbol: o.symbol, side: o.side, qty: Number(o.qty), status: o.status });

// ── El aplanado de UNA cuenta ────────────────────────────────────────
// Devuelve SIEMPRE una fila, pase lo que pase: una cuenta que falló tiene que
// aparecer nombrada en el reporte, no desaparecer de él. Nunca lanza.
export async function resetAccount(agent, { dry, baselineUsd, baselineModo = 'real', marketOpen, now }) {
  const row = { agent: agent.id, name: agent.name, alpaca: agent.alpaca, ok: false, steps: [] };
  const creds = agentAlpacaCreds(agent);
  if (!creds) {
    row.failure = 'missing_alpaca_keys';
    row.detail = `Faltan ALPACA_${agent.alpaca}_KEY / ALPACA_${agent.alpaca}_SECRET. Esta cuenta NO se tocó.`;
    return row;
  }

  // ── PASO 2: la foto de ANTES ──
  try {
    const [account, positions, orders] = await Promise.all([
      getAccount(creds), getPositions(creds), getOrders('open', 500, creds),
    ]);
    row.before = {
      equity: Number(account.equity),
      cash: Number(account.cash),
      positions: (positions || []).map(posBrief),
      open_orders: (orders || []).map(ordBrief),
    };
    row.before.position_count = row.before.positions.length;
    row.before.open_order_count = row.before.open_orders.length;
    row.steps.push({ step: 'snapshot', ok: true });
  } catch (e) {
    row.failure = 'snapshot_failed';
    row.detail = String((e && e.message) || e) + ' — no se tocó nada en esta cuenta.';
    return row;
  }

  if (dry) {
    row.ok = true;
    row.would_cancel = row.before.open_order_count;
    row.would_sell = row.before.position_count;
    row.would_sell_value = +row.before.positions.reduce((s, p) => s + (Number(p.market_value) || 0), 0).toFixed(2);
    // En modo `real` el baseline es el equity que quede DESPUÉS de aplanar, que
    // todavía no existe. El dry run lo ESTIMA con el equity de ahora y lo dice:
    // aplanar mueve el número unos centavos por el spread, no unos dólares.
    row.baseline_modo = baselineModo;
    row.baseline_equity = baselineModo === 'real' ? +Number(row.before.equity).toFixed(2) : baselineUsd;
    row.baseline_estimado = baselineModo === 'real';
    row.starting_drawdown_pct = +(startingDrawdown(row.before.equity, row.baseline_equity) * 100).toFixed(2);
    return row;
  }

  // ── PASO 3: cancelar órdenes abiertas ──
  if (row.before.open_order_count > 0) {
    try {
      const res = await cancelAllOrders(creds);
      row.steps.push({ step: 'cancel_orders', ok: true, requested: row.before.open_order_count, alpaca: Array.isArray(res) ? res.length : null });
    } catch (e) {
      // No aborta: `closeAllPositions` vuelve a cancelar con `cancel_orders=true`.
      row.steps.push({ step: 'cancel_orders', ok: false, error: String((e && e.message) || e) });
    }
  } else {
    row.steps.push({ step: 'cancel_orders', ok: true, requested: 0, note: 'no había órdenes abiertas' });
  }

  // ── PASO 4: liquidar a mercado ──
  if (row.before.position_count > 0) {
    try {
      const res = await closeAllPositions(creds, { cancelOrders: true });
      row.steps.push({ step: 'liquidate', ok: true, requested: row.before.position_count, alpaca: Array.isArray(res) ? res.length : null });
    } catch (e) {
      row.failure = 'liquidate_failed';
      row.detail = String((e && e.message) || e);
      row.steps.push({ step: 'liquidate', ok: false, error: row.detail });
      return row;
    }
  } else {
    row.steps.push({ step: 'liquidate', ok: true, requested: 0, note: 'la cuenta ya estaba plana' });
  }

  // ── PASO 5: VERIFICAR (releer, no suponer) ──
  let positions = [];
  let orders = [];
  const tries = marketOpen ? VERIFY_TRIES : 1;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(VERIFY_WAIT_MS);
    try {
      [positions, orders] = await Promise.all([getPositions(creds), getOrders('open', 500, creds)]);
    } catch (e) {
      row.steps.push({ step: 'verify', ok: false, try: i + 1, error: String((e && e.message) || e) });
      continue;
    }
    if (!positions.length && !orders.length) break;
  }
  let account = null;
  try { account = await getAccount(creds); } catch { /* el equity de después es informativo */ }

  row.after = {
    equity: account ? Number(account.equity) : null,
    cash: account ? Number(account.cash) : null,
    positions: (positions || []).map(posBrief),
    open_orders: (orders || []).map(ordBrief),
  };
  row.after.position_count = row.after.positions.length;
  row.after.open_order_count = row.after.open_orders.length;
  row.flat = row.after.position_count === 0 && row.after.open_order_count === 0;
  row.steps.push({ step: 'verify', ok: row.flat, positions_left: row.after.position_count, orders_left: row.after.open_order_count });

  if (!row.flat) {
    row.failure = marketOpen ? 'not_flat' : 'queued_market_closed';
    row.detail = marketOpen
      ? `Quedaron ${row.after.position_count} posiciones y ${row.after.open_order_count} órdenes después de ${tries} verificaciones. ` +
        'Las órdenes de mercado se mandaron: puede ser latencia de fill. Volvé a correr el reset para confirmar — es idempotente.'
      : 'EL MERCADO ESTÁ CERRADO: las órdenes de mercado quedaron ENCOLADAS al próximo open y NO llenaron. ' +
        'El baseline se escribió igual, pero las cuentas NO están planas todavía: volvé a correr el reset con el mercado abierto para confirmar.';
  }

  // ── PASO 6: re-basar ──
  // Se escribe aunque la cuenta no haya quedado plana: el corte de memoria y el
  // piso del pico tienen que existir igual, si no la próxima corrida le
  // reinyecta al PM un libro que ya se está liquidando.
  const equityAfter = row.after.equity != null ? row.after.equity : row.before.equity;
  // ── EL BASELINE: el equity REAL, no el declarado ──
  // `real` (default): el denominador de cada agente es lo que de verdad tiene al
  // arrancar, así que los siete parten de 0.00%. `fijo` (?baseline=<n>) mantiene
  // el número declarado para todos.
  //
  // El default cambió el 2026-09-16 y la razón es medible: con $100k declarado,
  // `control` arrancaba en −1.45% y `claude` en −0.41% solo por el residuo de su
  // propio aplanado. Esas dos cuentas existen para medir el PISO DE RUIDO entre
  // sí — un delta de 1 punto metido por el denominador es más grande que el ruido
  // que están ahí para medir, y no se distingue de él.
  row.baseline_modo = baselineModo;
  row.baseline_equity = baselineModo === 'real' ? +Number(equityAfter).toFixed(2) : baselineUsd;
  row.starting_drawdown_pct = +(startingDrawdown(equityAfter, row.baseline_equity) * 100).toFixed(2);
  row.ok = row.flat;
  return row;
}

// ── PASO 7: abrir el benchmark pasivo ────────────────────────────────
// Nunca lanza y nunca falla el reset: devuelve una fila que se puede leer. El
// benchmark es la vara de comparación, no parte del aplanado — si Alpaca no da
// precio de SPY, las siete cuentas igual tienen que quedar planas y re-basadas.
//
// En DRY no escribe NADA, ni la migración de la tabla (`migrar: false`): el
// contrato del dry run es cero escrituras, y `create table if not exists` es
// una escritura aunque no cambie nada.
export async function abrirBenchmarkDelReset({ dry, now, creds = null }) {
  const precio = await precioBenchmark({ creds });
  if (!precio.ok) {
    return {
      abierto: false, motivo: precio.detail || precio.reason,
      warning: `BENCHMARK: no se pudo leer el precio de ${BENCHMARK.symbol} (${precio.reason}). La temporada arranca SIN línea de comparación — corré el reset otra vez con el mercado abierto, o el benchmark quedará abierto a un precio que no es el de este corte.`,
    };
  }

  if (dry) {
    const ya = await leerBenchmark({ migrar: false });
    return ya
      ? { abierto: true, ya_estaba: true, ...ya, would_open: false,
        note: `El benchmark YA está abierto a $${ya.entry} desde ${ya.opened_at}. Un reset con &confirm=1 NO lo re-abre: el precio de entrada de la temporada no se mueve.` }
      : { abierto: false, would_open: true, symbol: BENCHMARK.symbol,
        precio: precio.price, precio_fuente: precio.fuente,
        shares: +(BENCHMARK.capital_usd / precio.price).toFixed(6),
        capital: BENCHMARK.capital_usd,
        note: `Con &confirm=1 se comprarían $${BENCHMARK.capital_usd.toLocaleString('en-US')} de ${BENCHMARK.symbol} a $${precio.price} (${precio.fuente}) y no se tocarían en toda la temporada.` };
  }

  const r = await abrirBenchmark({
    price: precio.price, now,
    note: `reset ${now.toISOString()} · precio de ${precio.fuente}` + (precio.as_of ? ` · as_of ${precio.as_of}` : ''),
  });
  if (!r.ok) {
    return { abierto: false, motivo: r.detail || r.reason,
      warning: `BENCHMARK: no se pudo guardar la apertura (${r.reason}: ${r.detail}). Las siete cuentas SÍ se resetearon. Volvé a correr el reset — es idempotente y el benchmark se abrirá entonces, pero al precio de ESE momento, no al de este corte.` };
  }
  return {
    abierto: true, ya_estaba: !!r.ya_estaba,
    symbol: r.symbol, entry: r.entry, shares: r.shares, capital: r.capital,
    opened_at: r.opened_at || now.toISOString(),
    precio_fuente: precio.fuente,
    note: r.ya_estaba
      ? `Ya estaba abierto a $${r.entry}: NO se re-abrió. Un benchmark que se re-abre deja de medir la temporada y pasa a medir desde el último reset.`
      : `$${Number(r.capital).toLocaleString('en-US')} en ${r.symbol} a $${r.entry} (${precio.fuente}) = ${r.shares} acciones. No se toca hasta el final de la temporada.`,
  };
}

// El texto del anuncio. Fuera del handler para que el test lo lea sin red.
export function resetAnnouncement({ resetId, baselineUsd, baselineModo = 'real', rows, now, benchmark = null }) {
  const planas = rows.filter((r) => r.flat).length;
  const vendidas = rows.reduce((s, r) => s + ((r.before && r.before.position_count) || 0), 0);
  const canceladas = rows.reduce((s, r) => s + ((r.before && r.before.open_order_count) || 0), 0);
  // ── EL BASELINE, cuenta por cuenta ──
  // Con baseline `real` los números NO son todos iguales, y el anuncio los
  // LISTA en vez de resumirlos: el denominador de cada agente es lo que hace
  // comparable (o no) su retorno con el de los demás, así que tiene que quedar
  // escrito en el corte, no reconstruible después.
  const conBase = rows.filter((r) => r && r.baseline_equity != null);
  const lineaBaseline = baselineModo === 'real'
    ? `BASELINE de la temporada: el EQUITY REAL de cada cuenta después de aplanar. Los ${rows.length} arrancan en 0.00%. ` +
      (conBase.length ? conBase.map((r) => `${r.agent} $${Number(r.baseline_equity).toFixed(2)}`).join(' · ') + '. ' : '') +
      'Es el denominador del return Y el PISO del pico del breaker. Un $100k declarado le habría cobrado a cada agente el residuo de su propio aplanado como si fuera pérdida — para `claude` y `control`, que existen para medirse entre sí, ese sesgo era más grande que el piso de ruido que miden.'
    : `BASELINE de la temporada: $${Number(baselineUsd).toLocaleString('en-US')} por cuenta, DECLARADO. Es el denominador del return Y el PISO del pico del breaker — un libro recién aplanado NO arranca con el pico de antes del aplanado. Las cuentas cuyo equity real quedó por debajo arrancan con retorno negativo el primer día por el residuo de su aplanado, no por una pérdida.`;

  // La línea del benchmark entra en el MISMO anuncio, no en uno aparte: el
  // `season_started` del 16 tiene que decir contra qué se va a medir la
  // temporada, si no la comparación aparece inventada después.
  const lineaBench = benchmark && benchmark.abierto
    ? `BENCHMARK PASIVO: $${Number(benchmark.capital).toLocaleString('en-US')} en ${benchmark.symbol} a $${benchmark.entry} (${benchmark.shares} acciones), comprados en este mismo corte y sin tocar el resto de la temporada. Cero modelo, cero herramientas: está para contestar si los siete le ganan al índice. NO compite en el ranking — aparece ordenado entre los agentes pero no puede ganar, porque no decidió nada.`
    : 'BENCHMARK PASIVO: NO se abrió en este reset (' + ((benchmark && benchmark.motivo) || 'sin precio de SPY') + '). Sin él, los returns de la temporada no tienen contra qué leerse.';
  return [
    `RESET DE LIBROS — ${resetId}. Las ${rows.length} cuentas de la liga se aplanaron: ${canceladas} órdenes abiertas canceladas y ${vendidas} posiciones vendidas a mercado. ${planas} de ${rows.length} quedaron confirmadas en cero.`,
    lineaBaseline,
    'CORTE DE MEMORIA: el plan anterior, los fills, los compromisos abiertos y el pico de equity se cortan en este instante. Nada de antes del reset se le reinyecta al PM: un libro que ya no existe no puede ser recordado como propio.',
    lineaBench,
    'Las métricas de ANTES y DESPUÉS de este corte NO son comparables. El post-mortem tiene que partir acá.',
    'Experimento sin validación estadística, paper trading, no es asesoría.',
  ].join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const auth = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const confirm = String(q.confirm || '') === '1';
  const dry = !confirm;
  const only = String(q.agent || '').toLowerCase();
  const agents = only ? [agentById(only)].filter(Boolean) : activeAgents();
  if (!agents.length) return res.status(400).json({ error: 'Ningún agente activo con ese id.' });

  // ── EL BASELINE: `real` por default, `fijo` si se pide un número ──────
  // Sin `?baseline=`, cada cuenta se re-basa a SU equity después de aplanar y
  // los siete arrancan en 0.00%. Con `?baseline=<n>` vuelve el número declarado
  // para todas — sigue disponible, ya no es el default.
  const baselineFijo = Number(q.baseline);
  const baselineModo = Number.isFinite(baselineFijo) && baselineFijo > 0 ? 'fijo' : 'real';
  const baselineUsd = baselineModo === 'fijo' ? baselineFijo : RESET_BASELINE_USD;
  const now = new Date();
  const resetId = String(q.id || '').trim() || `arena-${ARENA_SEASON.id.toLowerCase()}-${now.toISOString().slice(0, 10)}`;

  const out = {
    ran_at: now.toISOString(),
    mode: dry ? 'dry_run' : 'applied',
    reset_id: resetId,
    baseline_modo: baselineModo,
    baseline_usd: baselineModo === 'fijo' ? baselineUsd : null,
    baseline_nota: baselineModo === 'real'
      ? 'BASELINE = EQUITY REAL por cuenta después de aplanar: los siete arrancan en 0.00% y el piso del pico del breaker es su propio equity de arranque. Es también el DENOMINADOR del retorno en /liga. Con `&baseline=100000` se fuerza el número declarado para todas.'
      : `BASELINE FIJO de $${Number(baselineUsd).toLocaleString('en-US')} para las ${agents.length} cuentas. OJO: si el equity real tras aplanar queda por debajo, esa cuenta arranca con drawdown y con retorno negativo el primer día, por el residuo de su propio aplanado y no por una pérdida.`,
    season: { id: ARENA_SEASON.id, start: ARENA_SEASON.start, end: ARENA_SEASON.end },
    agents: agents.map((a) => a.id),
    accounts: [],
    warnings: [],
  };
  if (dry) {
    out.note = 'DRY RUN: no se canceló ni se vendió NADA, y no se escribió en la DB. Agregá `&confirm=1` para ejecutarlo.';
  }

  // ¿Está abierto el mercado? Decide si tiene sentido esperar los fills y si el
  // reporte puede afirmar que las cuentas quedaron planas.
  let marketOpen = false;
  // Las mismas keys sirven para el reloj Y para el precio de SPY del benchmark:
  // `ALPACA_PAPER_KEY` puede no existir (cada agente tiene su par propio), así
  // que el default de la casa no se puede dar por sentado acá.
  const anyCreds = agents.map(agentAlpacaCreds).find(Boolean) || null;
  try {
    const clock = anyCreds ? await getClock(anyCreds) : null;
    marketOpen = !!(clock && clock.is_open);
    out.market = clock ? { is_open: marketOpen, next_open: clock.next_open || null, next_close: clock.next_close || null } : null;
  } catch (e) {
    out.market = { is_open: null, error: String((e && e.message) || e) };
  }
  if (!dry && !marketOpen) {
    out.warnings.push('EL MERCADO ESTÁ CERRADO: las ventas a mercado se ENCOLAN al próximo open y no llenan ahora. El baseline se escribe igual; volvé a correr el reset con el mercado abierto para confirmar que las cuentas quedaron planas.');
  }

  // ── PASO 1: pausar el vigilante (solo si se va a ejecutar de verdad) ──
  const pauseMin = (() => {
    const n = Number(process.env.ARENA_RESET_WATCH_PAUSE_MIN);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
  })();
  if (!dry) {
    try {
      await ensureSchema();
      const p = await pauseWatch(pauseMin, `reset ${resetId}`, now);
      out.watch = { paused: true, until: p.until, minutes: p.minutes };
    } catch (e) {
      // NO se sigue: sin la pausa, el cron del vigilante puede despertar a los
      // siete en medio del aplanado y gastar tokens opinando sobre un libro que
      // está dejando de existir. Es exactamente el estado que la pausa evita.
      return res.status(500).json({
        ...out,
        error: 'No se pudo pausar el vigilante: ' + String((e && e.message) || e),
        hint: 'El reset NO se ejecutó. Sin la pausa, el cron */5 puede despertar a los agentes en medio del aplanado. Revisá DATABASE_URL.',
      });
    }
  }

  // ── PASOS 2-6, las siete cuentas EN PARALELO ──
  // allSettled y no all: una cuenta que explota no puede llevarse el reporte de
  // las otras seis — y menos en un reset, donde el reporte ES el entregable.
  const settled = await Promise.allSettled(
    agents.map((a) => resetAccount(a, { dry, baselineUsd, baselineModo, marketOpen, now })),
  );
  out.accounts = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : {
    agent: agents[i].id, name: agents[i].name, ok: false, failure: 'threw',
    detail: String((r.reason && r.reason.message) || r.reason),
  }));

  // ── PASO 7: el BENCHMARK PASIVO ──────────────────────────────────────
  // Solo cuando se resetea la liga ENTERA. Con `?agent=claude` se está
  // arreglando UNA cuenta, no arrancando una temporada, y abrir el benchmark
  // ahí lo ataría a una fecha que no es la del reset de verdad.
  if (only) {
    out.benchmark = { skipped: true, motivo: 'reset de una sola cuenta: el benchmark solo se abre con el reset de la liga entera.' };
  } else {
    out.benchmark = await abrirBenchmarkDelReset({ dry, now, creds: anyCreds });
    if (out.benchmark.warning) out.warnings.push(out.benchmark.warning);
  }

  if (!dry) {
    // Baseline por agente. Se escribe para TODAS las cuentas que se pudieron
    // leer, plana o no (ver el comentario del paso 6).
    for (const row of out.accounts) {
      if (row.failure === 'missing_alpaca_keys' || row.failure === 'snapshot_failed' || row.failure === 'threw') continue;
      try {
        await setBaseline(row.agent, { at: now.toISOString(), equity: row.baseline_equity, id: resetId });
        row.baseline_written = true;
      } catch (e) {
        row.baseline_written = false;
        row.baseline_error = String((e && e.message) || e);
        out.warnings.push(`${row.agent}: la cuenta se aplanó pero NO se pudo escribir el baseline (${row.baseline_error}). El pico del breaker sigue mirando al libro viejo — no dejes correr la liga hasta arreglarlo.`);
      }
    }

    // El anuncio: UNA fila de liga, idempotente por id.
    try {
      await sql(
        `insert into arena_journal (id, run_date, phase, status, prompt_version, plan, context, agent_id)
         values ($1,$2,'decide','rules_changed',$3,$4,$5,'league') on conflict (id) do nothing`,
        [resetId, now.toISOString().slice(0, 10), PROMPT_VERSION,
         resetAnnouncement({ resetId, baselineUsd, baselineModo, rows: out.accounts, now, benchmark: out.benchmark }),
         JSON.stringify({
           reset_id: resetId, baseline_modo: baselineModo,
           baseline_usd: baselineModo === 'fijo' ? baselineUsd : null, market_open: marketOpen,
           season: ARENA_SEASON.id, baseline_at: now.toISOString(),
           benchmark: out.benchmark && out.benchmark.abierto
             ? { symbol: out.benchmark.symbol, entry: out.benchmark.entry, shares: out.benchmark.shares, capital: out.benchmark.capital }
             : null,
           accounts: out.accounts.map((r) => ({
             agent: r.agent, flat: !!r.flat,
             positions_sold: (r.before && r.before.position_count) || 0,
             orders_canceled: (r.before && r.before.open_order_count) || 0,
             equity_before: r.before && r.before.equity, equity_after: r.after && r.after.equity,
             baseline_equity: r.baseline_equity ?? null,
             starting_drawdown_pct: r.starting_drawdown_pct,
           })),
         })],
      );
      out.journaled = true;
    } catch (e) {
      out.journaled = false;
      out.warnings.push('No se pudo journalear el anuncio del reset: ' + String((e && e.message) || e) + '. El corte existe en arena_state pero no hay fila que lo cuente en /liga.');
    }

    // ── PASO 6b: reactivar el vigilante ──
    try { await resumeWatch(); out.watch = { ...(out.watch || {}), paused: false, resumed: true }; }
    catch (e) {
      out.watch = { ...(out.watch || {}), resumed: false, error: String((e && e.message) || e) };
      out.warnings.push(`No se pudo despausar el vigilante: ${String((e && e.message) || e)}. Se despausa SOLO al vencer (${pauseMin} min) — no hace falta intervenir, pero hasta entonces no hay disparadores.`);
    }
  }

  // Aviso del drawdown de arranque: el baseline declarado contra el equity real.
  for (const r of out.accounts) {
    if (r.starting_drawdown_pct > 2) {
      out.warnings.push(`${r.agent}: equity ${r.after && r.after.equity != null ? '$' + Number(r.after.equity).toFixed(0) : 's/d'} contra un baseline de $${Number(r.baseline_equity).toLocaleString('en-US')} → arranca con ${r.starting_drawdown_pct}% de drawdown contra el pico del breaker Y con ese mismo ${r.starting_drawdown_pct}% de retorno negativo en /liga el primer día, por el residuo de su propio aplanado. A −15% empieza el desapalancamiento y a −20% el corte amplio. Quitá \`&baseline=\` para re-basar a su equity real.`);
    }
  }

  const planas = out.accounts.filter((r) => r.flat).length;
  const fallidas = out.accounts.filter((r) => !r.ok);
  out.summary = {
    cuentas: out.accounts.length,
    baseline_modo: baselineModo,
    baselines: Object.fromEntries(out.accounts
      .filter((r) => r.baseline_equity != null)
      .map((r) => [r.agent, r.baseline_equity])),
    planas,
    con_problema: fallidas.length,
    posiciones_vendidas: out.accounts.reduce((s, r) => s + ((r.before && r.before.position_count) || 0), 0),
    ordenes_canceladas: out.accounts.reduce((s, r) => s + ((r.before && r.before.open_order_count) || 0), 0),
  };
  out.verdict = dry
    ? `DRY RUN — se cancelarían ${out.summary.ordenes_canceladas} órdenes y se venderían ${out.summary.posiciones_vendidas} posiciones en ${out.accounts.length} cuentas. Nada se tocó. Agregá &confirm=1 para ejecutarlo.`
    : fallidas.length === 0
      ? `VERDE: las ${planas} cuentas quedaron planas y re-basadas ${baselineModo === 'real' ? 'a SU equity real (las siete arrancan en 0.00%)' : `a $${baselineUsd.toLocaleString('en-US')}`}. Vigilante reactivado. Corte journaleado como ${resetId}.`
      : `PARCIAL: ${planas}/${out.accounts.length} cuentas confirmadas planas. Revisá \`accounts[].failure\` — el reset es idempotente, se puede volver a correr.`;

  return res.status(200).json(out);
}
