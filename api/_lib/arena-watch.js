// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-watch.js — el VIGILANTE del Arena (lógica pura, CERO tokens).
//
// TEMPORADA 2, cambio de cadencia (vigente 2026-09-15): el cron
// NOCTURNO deja de ser el latido del experimento. En su lugar, un vigilante
// SIN LLM mira el mercado cada 5 minutos en horario de sesión y solo DESPIERTA
// al agente cuando pasa algo que le concierne. El costo de mirar es cero
// tokens; el costo de pensar se paga únicamente cuando hay un motivo, y ese
// motivo queda journaleado —haya orden o no.
//
// Este módulo es JS PURO: sin red, sin DB, sin LLM. Misma disciplina que
// _lib/arena-guard.js y _lib/arena-exits.js — las reglas se pueden testear con
// un día sintético de mercado sin levantar nada. El I/O (Alpaca, SEC, Neon) y
// el despertar del agente viven en `api/arena-watch.js`.
//
// ── LOS SEIS DISPARADORES ────────────────────────────────────────────
//   1. move_since_pronouncement — el precio se movió ≥ ±3% desde la MARCA del
//      último pronunciamiento del agente sobre ese nombre. La marca se re-fija
//      cada vez que el agente se pronuncia, así que el disparador se RE-ARMA
//      solo: hacen falta otros 3% para volver a despertarlo.
//   2. near_trailing        — el precio llegó a ≤2 PUNTOS porcentuales del nivel
//                             del trailing stop armado.
//   3. near_catastrophic    — ídem contra el stop catastrófico ancho.
//   4. event_earnings / event_8k — la empresa reporta HOY, o presentó un 8-K hoy.
//   5. volume_spike         — el volumen del día va ≥3× su promedio de 20 días.
//   6. buffet_move          — un CANDIDATO del buffet (no del libro) se movió
//                             ≥ ±5%. Es el único disparador sin dueño: la
//                             oportunidad es de la liga, así que despierta a
//                             TODOS los agentes activos que no lo tengan ya
//                             (si lo tienen, es una posición y manda el #1).
//
// ── STICKY vs RE-ARMABLE (el candado anti-quema de tokens) ───────────
// Un disparador de HECHO DEL DÍA (earnings, 8-K, volumen, cercanía a un stop)
// sigue siendo verdad todos los ticks que quedan de la sesión: si se dejara
// disparar libremente, un día loco consumiría las 12 corridas en una hora. Por
// eso esos cinco son STICKY: disparan UNA vez por (agente, símbolo, tipo, día).
// Los dos de PRECIO (move_since_pronouncement, buffet_move) NO son sticky: se
// re-arman contra la marca, que solo se mueve cuando el agente ya se pronunció.
//
// ── TOPES (regla cadencia #7) ──────────────────────────────────────────────
//   - 12 corridas por agente por día (la revisión de piso cuenta como una).
//   - 20 minutos de cooldown por (agente, ticker).
//   - tope por tick, para no reventar los 300s de la lambda.
// Los tres son env-overridables sin deploy, igual que EXIT_RULES.
//
// ── AGRUPACIÓN POR TICK (decisión explícita) ─────────────────────────
// Si en el MISMO tick disparan dos nombres del mismo agente, se corre UNA sola
// corrida acotada a esos dos, no dos corridas. Sigue siendo "acotada a los
// tickers que dispararon" (el slate del evento son exactamente ellos y el
// runner descarta cualquier acción fuera de él), pero cuesta un solo prompt y
// UNA de las 12 corridas del día. Lo contrario premiaría la volatilidad con
// gasto, que es justo lo que los topes existen para evitar.
//
// ENV VARS (todas opcionales, con default): ARENA_WATCH_MOVE_PCT ·
//   ARENA_WATCH_BUFFET_PCT · ARENA_WATCH_STOP_POINTS · ARENA_WATCH_VOL_MULT ·
//   ARENA_WATCH_MAX_RUNS_DAY · ARENA_WATCH_COOLDOWN_MIN ·
//   ARENA_WATCH_FLOOR_AFTER_OPEN_MIN · ARENA_WATCH_MAX_RUNS_TICK ·
//   ARENA_WATCH_START (fecha ET del cambio de cadencia)
// ═══════════════════════════════════════════════════════════════

// Constantes compartidas: el precio por modelo vive en _lib/model.js (regla de
// la casa) y el techo de salida en _lib/arena-registry.js. Importarlas no rompe
// el "cero I/O" de este módulo: son números, no llamadas.
import { ANTHROPIC_PRICES } from './model.js';
import { ARENA_MAX_TOKENS } from './arena-registry.js';

// ── helpers de env (mismo criterio que _lib/arena-exits.js: inválido → default) ──
function envFrac(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : def;
}
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function envInt(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && Math.floor(v) === v ? v : def;
}

export const WATCH_RULES = {
  // Cadencia del vigilante. NO es configurable por env a propósito: el cron de
  // vercel.json es la fuente de verdad de cada cuánto corre, y tener dos
  // números que pueden discrepar es peor que tener uno.
  tick_minutes: 5,

  // ── umbrales de los disparadores ──
  move_since_mark: envFrac('ARENA_WATCH_MOVE_PCT', 0.03),   // ±3% desde el último pronunciamiento
  buffet_move: envFrac('ARENA_WATCH_BUFFET_PCT', 0.05),     // ±5% en un candidato del buffet
  near_stop_points: envNum('ARENA_WATCH_STOP_POINTS', 2),   // 2 PUNTOS porcentuales sobre el nivel
  volume_multiple: envNum('ARENA_WATCH_VOL_MULT', 3),       // volumen del día ≥ 3× el promedio
  volume_lookback_days: 20,                                 // el promedio, en sesiones

  // ── topes (cadencia #7) ──
  max_runs_per_agent_day: envInt('ARENA_WATCH_MAX_RUNS_DAY', 12),
  cooldown_minutes: envInt('ARENA_WATCH_COOLDOWN_MIN', 20),
  // Tope por TICK: la lambda tiene 300s y cada corrida son 2 llamadas al LLM.
  // Lo que no entra se journalea como diferido y vuelve a evaluarse en el tick
  // siguiente — la condición que disparó sigue ahí, no se pierde nada.
  max_runs_per_tick: envInt('ARENA_WATCH_MAX_RUNS_TICK', 7),

  // ── revisión de piso (cadencia #6) ──
  // A la apertura +30 min, el agente que NO fue tocado por ningún disparador se
  // pronuncia igual sobre sus posiciones. Es el piso del reglamento T2 #9
  // (pronunciamiento obligatorio) sobreviviendo al cambio de cadencia: sin él,
  // un día tranquilo dejaría al libro sin una sola revisión.
  floor_after_open_minutes: envInt('ARENA_WATCH_FLOOR_AFTER_OPEN_MIN', 30),
};

// Tipos de disparador. `sticky:true` = hecho del DÍA, dispara una sola vez por
// (agente, símbolo, tipo, fecha). `sticky:false` = se re-arma contra la marca.
export const TRIGGER_TYPES = {
  move_since_pronouncement: { sticky: false, owner: 'position' },
  near_trailing: { sticky: true, owner: 'position' },
  near_catastrophic: { sticky: true, owner: 'position' },
  event_earnings: { sticky: true, owner: 'position' },
  event_8k: { sticky: true, owner: 'position' },
  volume_spike: { sticky: true, owner: 'position' },
  buffet_move: { sticky: false, owner: 'buffet' },
};

// Severidad para ordenar qué disparador se narra primero cuando varios pegan en
// el mismo nombre. Un stop cerca manda sobre un volumen raro.
const TRIGGER_SEVERITY = {
  near_catastrophic: 6, near_trailing: 5, event_earnings: 4, event_8k: 3,
  move_since_pronouncement: 2, volume_spike: 1, buffet_move: 1,
};

// ── CORTE DE CADENCIA ───────────────────────────────────────────
// La fecha en que el modelo POR EVENTO sustituye al cron nocturno, en horario
// del ESTE (el del mercado). Antes de esta fecha el Arena corre con la cadencia
// vieja; desde ella, `decide` y `morning` se retiran (journalean una fila de
// liga, cero tokens) y el vigilante es el que despierta a los agentes.
//
// EL LUNES 14 QUEDA DEL LADO VIEJO DEL CORTE, y es deliberado: es el día 1 de la
// Temporada 2 y la única corrida end-to-end de las SIETE cuentas Alpaca, de
// OpenRouter y del reglamento v3-t2 completo antes de estrenar el vigilante.
// Estrenar la cadencia nueva encima de un harness que nunca corrió entero
// mezclaría dos estrenos: si algo fallara no se sabría cuál de los dos fue.
//
// Env-overridable (ARENA_WATCH_START) por la misma razón que los slugs de
// modelo: mover el corte un día no debería requerir un deploy, y si el
// vigilante sale mal se vuelve al cron nocturno con una variable.
//
// OJO: este export es el DEFAULT declarado. Todo lo que se DERIVA del corte —el
// id del anuncio, su fecha, el texto del reglamento— tiene que salir de
// `watchStartDate()`, que respeta la env var. Derivarlo de esta constante fue un
// bug real: con `ARENA_WATCH_START` puesta, la compuerta se movía pero el
// `rules_changed` seguía fechado en el default, y el corte del post-mortem
// apuntaba a un día en el que no cambió nada.
export const WATCH_START = /* date-lint-ok: no es una referencia a "hoy" — es la fecha declarada del cambio de cadencia, un hecho fijo que ancla el corte del post-mortem */ '2026-09-15';

export function watchStartDate() {
  const raw = String(process.env.ARENA_WATCH_START || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : WATCH_START;
}

// Fecha de HOY en horario del Este ('YYYY-MM-DD').
export function easternDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Minutos desde medianoche en horario del Este (maneja DST solo).
export function easternMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// ¿Ya rige la cadencia por evento? Compara en ET, no en UTC: el corte es un día
// de mercado, y a las 22:40 UTC en ET sigue siendo el mismo día hábil.
export function watchCadenceActive(now = new Date()) {
  return easternDate(now) >= watchStartDate();
}

// ── sesión de mercado (del calendario de Alpaca) ─────────────────────
// `session` = la fila del calendario de Alpaca de HOY: { date, open:'09:30',
// close:'16:00' }. Los medios días (cierre 13:00) vienen bien desde ahí, así
// que el vigilante NO hardcodea el horario del mercado.
// Devuelve { open, minutes_since_open, minutes_to_close, date }.
export function sessionPhase(now = new Date(), session = null) {
  const date = easternDate(now);
  const mins = easternMinutes(now);
  if (!session || mins == null) return { open: false, reason: session ? 'clock_error' : 'no_session', date, minutes_since_open: null, minutes_to_close: null };
  const hhmm = (s) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const open = hhmm(session.open);
  const close = hhmm(session.close);
  if (open == null || close == null) return { open: false, reason: 'session_malformed', date, minutes_since_open: null, minutes_to_close: null };
  const isOpen = mins >= open && mins < close;
  return {
    open: isOpen,
    reason: isOpen ? 'open' : (mins < open ? 'pre_market' : 'after_hours'),
    date,
    minutes_since_open: mins - open,
    minutes_to_close: close - mins,
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const up = (s) => String(s || '').trim().toUpperCase();

// Cambio porcentual en FRACCIÓN (0.031 = +3.1%). null si falta cualquiera.
export function pctChange(from, to) {
  const a = num(from), b = num(to);
  if (a == null || b == null || a <= 0) return null;
  return (b - a) / a;
}

// Distancia a un nivel de stop, en PUNTOS porcentuales. Negativa = el precio ya
// pasó por debajo del nivel. El disparador pega cuando distancia ≤ umbral, así
// que "ya lo cruzó" también despierta al agente (y con más razón: la red
// determinista decide con CIERRES, no intradía — el agente es el único que
// puede reaccionar antes del cierre).
export function pointsToLevel(price, level) {
  const p = num(price), l = num(level);
  if (p == null || l == null || l <= 0) return null;
  return ((p - l) / l) * 100;
}

// ── MARCA del último pronunciamiento ─────────────────────────────────
// El ancla contra la que se mide el ±3%. Si el agente todavía no se ha
// pronunciado sobre ese nombre bajo la cadencia nueva, el ancla es el CIERRE
// ANTERIOR — que es exactamente el número que el PM tuvo enfrente en su última
// corrida. Así el disparador funciona desde el primer tick del primer día, sin
// un periodo ciego de "sembrando marcas" y sin inventar un precio.
export function markPrice(mark, prevClose) {
  const m = num(mark && mark.price);
  if (m != null && m > 0) return { price: m, source: 'pronouncement', marked_at: mark.marked_at || null };
  const p = num(prevClose);
  return p != null && p > 0 ? { price: p, source: 'prev_close', marked_at: null } : null;
}

// ── EVALUACIÓN (pura) ────────────────────────────────────────────────
// Entradas (todo ya leído por el caller, nada de I/O acá):
//   agents      [{ id, halted }]
//   books       { agentId: { positions: [{symbol, avg_entry_price, qty}], meta: { SYM: {trailing:{armed,level}, ...} } } }
//   quotes      { SYMBOL: { price, prev_close, day_volume, avg_volume_20d } }
//   marks       { 'agentId|SYMBOL': { price, marked_at } }
//   dayEvents   { SYMBOL: { earnings: {...}|null, filing_8k: {...}|null } }
//   buffet      [SYMBOL, ...]  — candidatos vivos del buffet (screener + movers)
// Salida: [{ agent_id, symbol, type, owner, detail }] SIN filtrar por topes
// (eso lo hace applyCaps, para que el journal pueda distinguir "disparó pero se
// frenó por cooldown" de "no disparó").
export function evaluateTriggers({ agents = [], books = {}, quotes = {}, marks = {}, dayEvents = {}, buffet = [], rules = WATCH_RULES } = {}) {
  const out = [];
  const live = agents.filter((a) => a && !a.halted);

  for (const agent of live) {
    const book = books[agent.id] || { positions: [], meta: {} };
    const held = new Set((book.positions || []).map((p) => up(p && p.symbol)).filter(Boolean));

    for (const position of (book.positions || [])) {
      const symbol = up(position && position.symbol);
      if (!symbol) continue;
      const q = quotes[symbol];
      const price = num(q && q.price);
      // Sin precio vivo NO se evalúa nada de ese nombre. Fail-safe explícito,
      // igual que el resto de la casa: un dato faltante nunca inventa un evento.
      if (price == null || price <= 0) continue;
      const meta = (book.meta || {})[symbol] || {};

      // 1. ±3% desde el último pronunciamiento.
      const mark = markPrice(marks[agent.id + '|' + symbol], q && q.prev_close);
      if (mark) {
        const move = pctChange(mark.price, price);
        if (move != null && Math.abs(move) >= rules.move_since_mark) {
          out.push({
            agent_id: agent.id, symbol, type: 'move_since_pronouncement', owner: 'position',
            detail: {
              price, mark: mark.price, mark_source: mark.source, marked_at: mark.marked_at,
              move_pct: +(move * 100).toFixed(2), threshold_pct: +(rules.move_since_mark * 100).toFixed(2),
            },
          });
        }
      }

      // 2/3. A ≤2 puntos del trailing armado o del stop catastrófico.
      // Sin nivel (trailing no armado, o entrada desconocida) no hay nada que
      // medir: no se dispara sobre un nivel que no existe.
      const trailingLevel = meta.trailing && meta.trailing.armed ? num(meta.trailing.level) : null;
      if (trailingLevel != null) {
        const pts = pointsToLevel(price, trailingLevel);
        if (pts != null && pts <= rules.near_stop_points) {
          out.push({
            agent_id: agent.id, symbol, type: 'near_trailing', owner: 'position',
            detail: { price, level: trailingLevel, points_to_level: +pts.toFixed(2), threshold_points: rules.near_stop_points, crossed: pts < 0 },
          });
        }
      }
      const catLevel = num(meta.catastrophic_level);
      if (catLevel != null) {
        const pts = pointsToLevel(price, catLevel);
        if (pts != null && pts <= rules.near_stop_points) {
          out.push({
            agent_id: agent.id, symbol, type: 'near_catastrophic', owner: 'position',
            detail: { price, level: catLevel, points_to_level: +pts.toFixed(2), threshold_points: rules.near_stop_points, crossed: pts < 0 },
          });
        }
      }

      // 4. Earnings o 8-K del día.
      const ev = dayEvents[symbol] || {};
      if (ev.earnings) {
        out.push({ agent_id: agent.id, symbol, type: 'event_earnings', owner: 'position', detail: { price, ...ev.earnings } });
      }
      if (ev.filing_8k) {
        out.push({ agent_id: agent.id, symbol, type: 'event_8k', owner: 'position', detail: { price, ...ev.filing_8k } });
      }

      // 5. Volumen ≥ 3× el promedio de 20 días.
      const dayVol = num(q && q.day_volume);
      const avgVol = num(q && q.avg_volume_20d);
      if (dayVol != null && avgVol != null && avgVol > 0 && dayVol >= avgVol * rules.volume_multiple) {
        out.push({
          agent_id: agent.id, symbol, type: 'volume_spike', owner: 'position',
          detail: { price, day_volume: dayVol, avg_volume_20d: Math.round(avgVol), multiple: +(dayVol / avgVol).toFixed(2), threshold_multiple: rules.volume_multiple },
        });
      }
    }

    // 6. Candidato del BUFFET con ≥ ±5%. Único disparador SIN dueño: la
    //    oportunidad es de la liga entera, así que despierta a cada agente que
    //    NO lo tenga (si lo tiene es una posición y ya la cubre el #1, con su
    //    umbral más bajo).
    for (const raw of buffet) {
      const symbol = up(raw);
      if (!symbol || held.has(symbol)) continue;
      const q = quotes[symbol];
      const price = num(q && q.price);
      if (price == null || price <= 0) continue;
      const mark = markPrice(marks[agent.id + '|' + symbol], q && q.prev_close);
      if (!mark) continue;
      const move = pctChange(mark.price, price);
      if (move == null || Math.abs(move) < rules.buffet_move) continue;
      out.push({
        agent_id: agent.id, symbol, type: 'buffet_move', owner: 'buffet',
        detail: {
          price, mark: mark.price, mark_source: mark.source, marked_at: mark.marked_at,
          move_pct: +(move * 100).toFixed(2), threshold_pct: +(rules.buffet_move * 100).toFixed(2),
        },
      });
    }
  }
  return out;
}

// ── TOPES Y COOLDOWN (puro) ──────────────────────────────────────────
// Entradas de estado (las lee el caller de la DB):
//   firedToday  Set de 'agentId|SYMBOL|type' ya disparados HOY (para los sticky)
//   runsToday   { agentId: n } corridas ya despertadas hoy (incluye la de piso)
//   lastRunAt   { 'agentId|SYMBOL': epoch_ms } último despertar sobre ese ticker
// Salida:
//   { runs: [{ agent_id, symbols:[...], triggers:[...] }],   ← a despertar, YA agrupado
//     journal: [{ ...trigger, fired:bool, skip_reason }] }    ← TODO se journalea
//
// TODO disparador entra a `journal`, dispare o no. Es la condición #2 del
// encargo: "cada disparador se journalea con su razón aunque el agente decida
// no operar" — y también aunque el tope decida que no corra.
export function applyCaps(triggers, { firedToday = new Set(), runsToday = {}, lastRunAt = {}, now = new Date(), rules = WATCH_RULES } = {}) {
  const t0 = now.getTime();
  const cooldownMs = rules.cooldown_minutes * 60000;
  const journal = [];
  // agente → { symbol → [triggers] } de los que SÍ pasan todos los filtros.
  const byAgent = new Map();

  // Orden estable y por severidad: si el tope por tick recorta, que lo que
  // sobrevive sea lo más urgente, no lo que llegó primero por azar del Map.
  const sorted = [...triggers].sort((a, b) => (TRIGGER_SEVERITY[b.type] || 0) - (TRIGGER_SEVERITY[a.type] || 0) || String(a.agent_id).localeCompare(String(b.agent_id)) || String(a.symbol).localeCompare(String(b.symbol)));

  for (const t of sorted) {
    const key = t.agent_id + '|' + t.symbol;
    const sticky = (TRIGGER_TYPES[t.type] || {}).sticky;
    const skip = (reason) => journal.push({ ...t, fired: false, skip_reason: reason });

    // (a) STICKY ya disparado hoy: el hecho del día no se cobra dos veces.
    if (sticky && firedToday.has(key + '|' + t.type)) { skip('sticky_ya_disparo_hoy'); continue; }

    // (b) Cooldown por ticker. Un agente que acaba de pronunciarse sobre un
    //     nombre no vuelve a hacerlo por 20 minutos, por muy loco que se ponga.
    //     OJO: si el agente YA va a correr este tick por ese mismo ticker (otro
    //     disparador del mismo nombre), esto no aplica — es la misma corrida.
    const already = byAgent.get(t.agent_id);
    const alreadyThisTick = already && already.has(t.symbol);
    if (!alreadyThisTick) {
      const last = num(lastRunAt[key]);
      if (last != null && t0 - last < cooldownMs) {
        skip(`cooldown ${rules.cooldown_minutes}m (último despertar hace ${Math.round((t0 - last) / 60000)}m)`);
        continue;
      }
    }

    // (c) Tope diario del agente. La corrida agrupada cuenta UNA vez, así que
    //     un agente que ya va a correr este tick no consume otra.
    if (!already) {
      const used = num(runsToday[t.agent_id]) || 0;
      if (used >= rules.max_runs_per_agent_day) { skip(`tope diario (${rules.max_runs_per_agent_day} corridas)`); continue; }
      // (d) Tope por tick: la lambda tiene 300s. Lo diferido vuelve al tick
      //     siguiente — la condición que disparó sigue en pie.
      if (byAgent.size >= rules.max_runs_per_tick) { skip(`tope por tick (${rules.max_runs_per_tick} corridas)`); continue; }
      byAgent.set(t.agent_id, new Map());
    }

    const bySymbol = byAgent.get(t.agent_id);
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
    journal.push({ ...t, fired: true, skip_reason: null });
  }

  const runs = [...byAgent.entries()].map(([agent_id, bySymbol]) => ({
    agent_id,
    symbols: [...bySymbol.keys()],
    triggers: [...bySymbol.values()].flat(),
  }));
  return { runs, journal };
}

// ── REVISIÓN DE PISO (cadencia #6) ─────────────────────────────────────────
// A la apertura +30 min: los agentes que NO fueron tocados por ningún
// disparador HOY se pronuncian igual sobre sus posiciones. Devuelve los ids.
// `floorDone` es el set de agentes a los que ya se les corrió el piso hoy
// (idempotencia: el vigilante pasa cada 5 min, el piso corre UNA vez).
export function floorReviewDue({ phase, agents = [], runsToday = {}, floorDone = new Set(), rules = WATCH_RULES } = {}) {
  if (!phase || !phase.open) return [];
  if (phase.minutes_since_open == null || phase.minutes_since_open < rules.floor_after_open_minutes) return [];
  return agents
    .filter((a) => a && !a.halted)
    .filter((a) => !floorDone.has(a.id))
    .filter((a) => !((num(runsToday[a.id]) || 0) > 0))
    .map((a) => a.id);
}

// ── MARKETABLE LIMIT intradía (cadencia #5) ────────────────────────────────
// La corrida por disparador ejecuta EN EL MOMENTO, no en la apertura siguiente:
// una decisión tomada por un movimiento de las 10:15 que se ejecuta al día
// siguiente no es una reacción, es otra cosa. Para que una orden LÍMITE llene
// intradía tiene que ser MARKETABLE — cruzar el spread:
//   compra → referencia × (1 + banda)   (por ARRIBA del mercado)
//   venta  → referencia × (1 − banda)   (por DEBAJO)
// Sigue siendo una orden límite (regla de la casa, cicatriz Polymarket: JAMÁS
// market orders). La banda no es el precio esperado del fill —el libro llena en
// el NBBO— es el tope de deslizamiento que aceptamos.
export function marketableLimit(reference, side, band) {
  const r = num(reference), b = num(band);
  if (r == null || r <= 0 || b == null || b < 0 || b >= 1) return null;
  const raw = side === 'buy' ? r * (1 + b) : r * (1 - b);
  return Math.round(raw * 100) / 100; // Alpaca exige tick de $0.01
}

// ── TITULAR del evento (determinista, CERO tokens) ───────────────────
// La línea que explica POR QUÉ se despertó al agente. La escribe este módulo,
// no un LLM: es un hecho, no una narración (el titular con voz de arquetipo lo
// sigue generando _lib/arena-voice.js DESPUÉS de decidir).
export function describeTrigger(t) {
  const d = t.detail || {};
  switch (t.type) {
    case 'move_since_pronouncement':
      return `${t.symbol} se movió ${d.move_pct >= 0 ? '+' : ''}${d.move_pct}% (a ${d.price}) desde ${d.mark_source === 'prev_close' ? `el cierre anterior de ${d.mark}` : `tu último pronunciamiento a ${d.mark}`}.`;
    case 'near_trailing':
      return d.crossed
        ? `${t.symbol} CRUZÓ su trailing stop armado (${d.price} vs. nivel ${d.level}).`
        : `${t.symbol} está a ${d.points_to_level} puntos de su trailing stop armado (${d.price} vs. nivel ${d.level}).`;
    case 'near_catastrophic':
      return d.crossed
        ? `${t.symbol} CRUZÓ su stop catastrófico (${d.price} vs. nivel ${d.level}).`
        : `${t.symbol} está a ${d.points_to_level} puntos de su stop catastrófico (${d.price} vs. nivel ${d.level}).`;
    case 'event_earnings':
      return `${t.symbol} reporta HOY${d.time ? ` (${d.time})` : ''}.`;
    case 'event_8k':
      return `${t.symbol} presentó un 8-K hoy${d.items ? ` (items ${d.items})` : ''}.`;
    case 'volume_spike':
      return `${t.symbol} lleva ${d.multiple}× su volumen promedio de ${WATCH_RULES.volume_lookback_days} días (${d.day_volume} vs. ${d.avg_volume_20d}).`;
    case 'buffet_move':
      return `${t.symbol} — candidato del buffet, NO lo tienes — se movió ${d.move_pct >= 0 ? '+' : ''}${d.move_pct}% (a ${d.price}).`;
    default:
      return `${t.symbol}: ${t.type}.`;
  }
}

// El encabezado que recibe el PM en la corrida acotada. Nombra el/los
// disparadores y deja claro el alcance: solo estos nombres.
export function buildTriggerHeadline(triggers = []) {
  const lines = [...triggers]
    .sort((a, b) => (TRIGGER_SEVERITY[b.type] || 0) - (TRIGGER_SEVERITY[a.type] || 0))
    .map(describeTrigger);
  const symbols = [...new Set(triggers.map((t) => t.symbol))];
  return `Te despertó el vigilante del Arena (no es la revisión diaria). ${lines.join(' ')} Esta corrida está ACOTADA a ${symbols.join(', ')}: cualquier acción sobre otro nombre se descarta.`;
}

// ═══ COSTO EN EL PEOR CASO (cadencia #7) ══════════════════════════════════
// El encargo pide estimarlo, así que se CALCULA —no se escribe a mano en un
// doc que envejece—: el endpoint lo publica en `?estimate=1` y el test lo
// verifica. Precios de LISTA por 1M de tokens, aproximados y públicos; se
// re-visan cuando un proveedor los mueve. La cuenta que importa es el ORDEN DE
// MAGNITUD, no el centavo.
// ── PRECIOS (relanzamiento 2026-09-15) ───────────────────────────────
// Los de Anthropic salen de ANTHROPIC_PRICES (_lib/model.js), por MODELO: el
// Arena ya no corre Haiku, y la línea `anthropic:haiku` que había acá hacía
// que el peor caso se calculara a $1/$5 cuando el modelo real cuesta $10/$50.
// Un estimador que subestima diez veces es peor que no tener estimador.
//
// Los de OpenRouter quedan VACÍOS a propósito. Las cinco filas que había eran
// de los modelos de la temporada anterior (gpt-5-mini, grok-4-fast, …) y esos
// slugs ya no corren; dejarlas habría hecho que el peor caso se calculara con
// el precio de un modelo que nadie está llamando. El precio REAL de cada
// modelo nuevo lo lee /api/arena-smoke del catálogo de OpenRouter
// (`pricing.prompt`/`pricing.completion`) — de ahí se copian acá, con fecha.
// Mientras tanto salen en `unpriced` y el estimador NO publica un total: un
// número inventado en un doc es exactamente lo que este módulo existe para
// evitar.
export const MODEL_PRICES = {
  // $/1M tokens { in, out } — se llenan desde el catálogo tras el smoke.
};

// Tokens del PEOR caso por corrida acotada. La corrida por disparador SE SALTA
// el SCOUT (el disparador ya definió el slate), así que son dos llamadas:
//   DIVE     — system + libro + meta + compromisos + deep dive de 1-3 nombres.
//              El output se toma en su TECHO, que es el peor caso real: una
//              respuesta más larga se corta, no cuesta más.
//   TITULAR  — la voz del arquetipo, corta por diseño.
//
// OJO CON EL TECHO: ahora es ARENA_MAX_TOKENS (6000, era 3000) y en un modelo
// de razonamiento los tokens de pensamiento SE COBRAN COMO SALIDA y salen de
// ese mismo techo. El peor caso de salida se duplicó por el techo, y el precio
// de salida de Fable 5.1 es 10× el de Haiku: el peor caso diario de los dos
// agentes de Anthropic sube ~20×. Que se vea en el número, no en una nota.
export const WORST_CASE_TOKENS = { dive_in: 5800, dive_out: ARENA_MAX_TOKENS, headline_in: 800, headline_out: 100 };

export function priceForAgent(agent) {
  if (!agent) return null;
  if (agent.provider === 'anthropic') return ANTHROPIC_PRICES[agent.model] || null;
  return MODEL_PRICES[agent.model] || null;
}

// Costo del peor caso: CADA agente activo quema sus 12 corridas del día.
// Devuelve { per_agent:[...], daily_usd, monthly_usd, assumptions }.
export function estimateWorstCaseCost(agents = [], rules = WATCH_RULES, tokens = WORST_CASE_TOKENS) {
  const runs = rules.max_runs_per_agent_day;
  const tokIn = tokens.dive_in + tokens.headline_in;
  const tokOut = tokens.dive_out + tokens.headline_out;
  const per_agent = agents.map((a) => {
    const price = priceForAgent(a);
    const usd = price ? runs * ((tokIn / 1e6) * price.in + (tokOut / 1e6) * price.out) : null;
    return {
      id: a.id, name: a.name, model: a.model,
      price_per_mtok: price,
      runs_per_day: runs,
      // null honesto si no tenemos precio de lista de ese slug: mejor un hueco
      // nombrado que un número inventado que alguien presupueste.
      usd_per_day: usd == null ? null : +usd.toFixed(4),
    };
  });
  const daily = per_agent.reduce((s, r) => s + (r.usd_per_day || 0), 0);
  const unpriced = per_agent.filter((r) => r.usd_per_day == null).map((r) => r.id);
  return {
    per_agent,
    // ~21 sesiones de mercado al mes: el vigilante no corre fines de semana.
    daily_usd: +daily.toFixed(2),
    monthly_usd: +(daily * 21).toFixed(2),
    unpriced,
    // PARCIAL: con agentes sin precio, `daily_usd` NO es el costo de la liga —
    // es el de los agentes que sí tienen precio. Sin esta bandera el total se
    // lee como si cubriera a los siete y se presupuesta de menos. La bandera
    // viaja con el número, no en una nota aparte que alguien no lea.
    partial: unpriced.length > 0,
    priced_agents: per_agent.length - unpriced.length,
    total_agents: per_agent.length,
    ...(unpriced.length ? { partial_note: `daily_usd cubre ${per_agent.length - unpriced.length} de ${per_agent.length} agentes. Faltan los precios de: ${unpriced.join(', ')} — los resuelve /api/arena-smoke contra el catálogo de OpenRouter.` } : {}),
    assumptions: {
      runs_per_agent_per_day: runs,
      tokens_per_run: { input: tokIn, output: tokOut },
      note: 'Peor caso ABSOLUTO: los 7 agentes queman sus 12 corridas todos los días y toda respuesta llega al techo de tokens. Un día normal son 1-3 corridas por agente.',
      llm_calls_per_run: 2,
      watchdog_llm_calls: 0,
    },
  };
}
