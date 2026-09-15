// ═══════════════════════════════════════════════════════════════
// /api/arena-watch — el VIGILANTE del Arena. Cadencia por evento.
//
//   GET (default)  → UN TICK. Cron cada 5 minutos en horario de mercado.
//   GET ?estimate=1 → el costo del PEOR CASO, calculado. Sin efectos.
//   GET ?dry=1      → evalúa y journalea los disparadores pero NO despierta a
//                     nadie (cero tokens). Para mirar un día real sin gastarlo.
//
// QUÉ HACE UN TICK, en orden:
//   1. Gate de cadencia (antes del corte, este endpoint no hace NADA) y gate de
//      sesión: fuera del horario de mercado sale con una llamada al calendario.
//   2. Lee, vía Alpaca, precio vivo + volumen del día + cierre anterior de la
//      UNIÓN de: las posiciones de los 7 libros y los candidatos del buffet.
//      CERO tokens: acá no hay ni una llamada a un LLM.
//   3. Evalúa los seis disparadores (_lib/arena-watch.js, JS puro).
//   4. Aplica topes y cooldown, y JOURNALEA TODOS los disparos —los que
//      despiertan y los que se frenan, con su razón.
//   5. Despierta al agente con una corrida ACOTADA al/los ticker(s) que
//      dispararon, reglamento completo, órdenes marketable que ejecutan ya.
//   6. En el tick de la apertura +30: corre la RED DETERMINISTA de los siete
//      (breaker/stop/trailing, sin LLM) y la REVISIÓN DE PISO del agente al que
//      ningún disparador tocó.
//
// ── LO QUE ESTE ENDPOINT *NO* HACE ───────────────────────────────────
// No decide nada. No llama a un modelo. No re-evalúa la red determinista fuera
// del tick de piso. Es un sensor con una libreta: mide, anota y toca la puerta.
// Todo lo que cuesta tokens pasa del otro lado de esa puerta, en arena-run.js,
// con el mismo reglamento de siempre.
//
// ── DÓNDE VIVE EL CRON (y por qué acá y no en Actions) ───────────────
// En `vercel.json`. La cuenta es Vercel PRO, y Pro no tiene límite de FRECUENCIA
// de crons (el tope de 1×/día era de Hobby; ver docs/crons.md), así que un
// `*/5` cabe sin trucos. Las otras dos opciones se descartaron con motivo:
//   - GitHub Actions: sus schedules son BEST-EFFORT y se retrasan de minutos a
//     decenas de minutos cuando la cola está cargada. Para el screener cada 4h
//     da igual; para un vigilante de mercado, un tick que llega 20 minutos tarde
//     es un disparador que no existió.
//   - Worker chico (Fly/Railway/Cloudflare): cadencia confiable, pero agrega un
//     runtime, un deploy y un juego de secretos MÁS que mantener, para correr
//     código que ya vive en este repo y necesita las mismas env vars. No compra
//     nada que Pro no dé.
// El handler se auto-gatea con el calendario de Alpaca, así que los ticks fuera
// de sesión (la ventana UTC cubre EDT y EST) cuestan una llamada y salen.
//
// ENV VARS: ARENA_ENABLED · ARENA_WATCH_ENABLED (opc, default 1 — el freno de
//   mano del vigilante, separado del del Arena) · ARENA_WATCH_START (opc, mueve
//   el corte de cadencia sin deploy) · CRON_SECRET · DATABASE_URL ·
//   ALPACA_<AGENTE>_KEY/SECRET · ALPACA_DATA_FEED (opc) · PUBLIC_BASE_URL
//   + las que ya usa arena-run para las corridas que despierta.
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { getCalendar, getPositions, getSnapshots, getAvgDailyVolume } from './_lib/alpaca.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_AGENT_DEADLINE_MS } from './_lib/arena-registry.js';
import { withDeadline } from './_lib/arena-model.js';
import {
  WATCH_RULES, watchCadenceActive, watchStartDate, easternDate, sessionPhase, easternMinutes,
  evaluateTriggers, applyCaps, floorReviewDue, buildTriggerHeadline,
  estimateWorstCaseCost, fixedRoundDue, FIXED_ROUNDS,
} from './_lib/arena-watch.js';
import { readDayEvents, eventsRefreshDue, refreshDayEvents } from './_lib/arena-watch-events.js';
import { catastrophicStopLevel } from './_lib/arena-exits.js';
import { buildPositionMeta, reconstructPositionOpens } from './_lib/arena-memory.js';
import { fetchDailySeries, completedSlice } from './_lib/sim.js';
import { readScreenerRows } from './_lib/screener-db.js';
import { computeScreens, screenerRankedSymbols } from './_lib/screens.js';
import {
  runArenaDecide, runArenaRiskNet, runArenaReconcile, announceEventCadence,
  ensureAgentStateRows, getArenaState, resolveBaseUrl, gatherContext, announceSpendTier,
} from './arena-run.js';
import { currentTier } from './_lib/arena-budget.js';
import { beat } from './_lib/heartbeat.js';
// La pausa dinámica del vigilante (la pone el reset mientras aplana las cuentas).
import { watchPaused } from './_lib/arena-baseline.js';

// Un tick puede despertar hasta 7 agentes, cada uno con su llamada al DIVE y su
// titular. Mismo techo que arena-run (plan Pro): 300s.
export const maxDuration = 300;

// Candidatos del buffet que el vigilante mira. El buffet completo (movers +
// earnings + insiders + screener) es un self-fetch caro que NO cabe en un tick
// de 5 minutos; el canal SCREENER, en cambio, ya está PRECOMPUTADO en Neon por
// su propio cron. Se usa ése: es la parte del buffet que es persistente,
// barata de leer y la única que tiene sentido vigilar continuamente (un mover
// del día ya se movió — vigilarlo es llegar tarde). Tope para no inflar la
// llamada de snapshots con nombres que nadie va a comprar.
const MAX_BUFFET_WATCHED = 15;

const up = (s) => String(s || '').trim().toUpperCase();

// ── cache de NIVELES por día (trailing armado + stop catastrófico) ──
// Los dos niveles se calculan con CIERRES COMPLETOS y la entrada de la
// posición: dentro de una misma sesión NO cambian. Calcularlos en cada tick
// costaría, por agente, una consulta de 180 días de journal + una serie de
// Yahoo por símbolo — 78 veces al día, para obtener el mismo número. Se
// computan una vez por (día, agente) y se guardan en Neon (no en memoria: una
// lambda fría no debe pagar el recálculo). Se invalidan solos si aparece un
// símbolo que no estaba — que es exactamente lo que pasa cuando una orden llena.
async function levelsForAgent(agent, positions, today, now) {
  const symbols = [...new Set((positions || []).map((p) => up(p && p.symbol)).filter(Boolean))].sort();
  const key = `levels:${today}:${agent.id}`;
  try {
    const rows = await sql(`select value from arena_watch_meta where key = $1`, [key]);
    const cached = rows[0] && rows[0].value;
    if (cached && Array.isArray(cached.symbols) && cached.symbols.join(',') === symbols.join(',')) {
      return cached.levels || {};
    }
  } catch (err) { /* sin cache → se recalcula */ }

  const fills = await sql(
    `select run_date, actions from arena_journal
     where phase = 'decide' and agent_id = $1 and actions is not null
     and created_at > now() - interval '180 days' order by created_at asc`, [agent.id]);
  const seriesBySymbol = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const raw = await fetchDailySeries(s, '1y');
      seriesBySymbol[s] = raw ? completedSlice(raw, now) : null;
    } catch (err) { seriesBySymbol[s] = null; }
  }));
  const meta = buildPositionMeta({ positions, opens: reconstructPositionOpens(fills), seriesBySymbol, now });

  const levels = {};
  for (const p of positions || []) {
    const sym = up(p && p.symbol);
    if (!sym) continue;
    levels[sym] = {
      trailing: (meta[sym] && meta[sym].trailing) || null,
      // El stop catastrófico sale directo de la entrada (no necesita serie):
      // nivel = entrada × (1 − 22%). Si Alpaca no trae la entrada, null — y el
      // disparador simplemente no se evalúa (fail-safe, como el resto).
      catastrophic_level: catastrophicStopLevel(p),
      days_in_position: (meta[sym] && meta[sym].days_in_position) ?? null,
    };
  }
  try {
    await sql(
      `insert into arena_watch_meta (key, value, updated_at) values ($1,$2,$3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify({ symbols, levels }), now.toISOString()]);
  } catch (err) { /* best-effort */ }
  return levels;
}

// ── marcador de "ya se hizo hoy" (piso, red determinista, reconcile) ──
async function doneToday(key) {
  try {
    const rows = await sql(`select value from arena_watch_meta where key = $1`, [key]);
    return !!(rows[0] && rows[0].value);
  } catch (err) { return false; }
}
async function markDone(key, value, now) {
  try {
    await sql(
      `insert into arena_watch_meta (key, value, updated_at) values ($1,$2,$3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now.toISOString()]);
  } catch (err) { /* best-effort */ }
}

// ── persistencia de disparadores ─────────────────────────────────────
// TODO disparo entra, haya despertado al agente o no (regla cadencia #6). Un insert
// por fila: son pocas por tick y así un fallo aislado no pierde las demás.
async function journalTriggers(rows, today, now) {
  for (const t of rows) {
    try {
      await sql(
        `insert into arena_watch (run_date, agent_id, symbol, trigger_type, fired, skip_reason, detail, fired_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [today, t.agent_id, t.symbol, t.type, !!t.fired, t.skip_reason || null, JSON.stringify(t.detail || {}), now.toISOString()]);
    } catch (err) { /* best-effort: el disparo se pierde del registro, no la corrida */ }
  }
}

// La MARCA del ±3%: el precio contra el que se medirá el próximo movimiento.
// Se re-fija para TODO el slate sobre el que el agente se acaba de pronunciar,
// haya operado o no — "su último pronunciamiento" es cuando HABLÓ, no cuando
// compró.
async function setMarks(agentId, symbols, prices, source, now) {
  for (const sym of symbols) {
    const px = Number(prices[sym]);
    if (!Number.isFinite(px) || px <= 0) continue;
    try {
      await sql(
        `insert into arena_watch_mark (agent_id, symbol, price, marked_at, source) values ($1,$2,$3,$4,$5)
         on conflict (agent_id, symbol) do update set price = excluded.price, marked_at = excluded.marked_at, source = excluded.source`,
        [agentId, sym, px, now.toISOString(), source]);
    } catch (err) { /* best-effort */ }
  }
}

// ── EL TICK ──────────────────────────────────────────────────────────
export async function runArenaWatch({ baseUrl, now = new Date(), dry = false } = {}) {
  const today = easternDate(now);

  // (1a) Gate de CADENCIA. Antes del corte el vigilante no existe: el cron
  // puede estar desplegado desde días antes sin tocar una sola corrida.
  if (!watchCadenceActive(now)) {
    return { status: 'pending_cadence', cadence_start: watchStartDate(), date: today };
  }

  const agents = activeAgents();
  if (!agents.length) return { status: 'no_agents', date: today };

  // (1b) Gate de SESIÓN. El calendario de Alpaca da el horario REAL de hoy
  // (incluidos los medios días de 13:00), así que el vigilante no hardcodea
  // 09:30-16:00 ni se equivoca en la víspera de Navidad.
  let session = null;
  try {
    const cal = await getCalendar(today, today, agentAlpacaCreds(agents[0]));
    session = Array.isArray(cal) && cal.length ? cal[0] : null;
  } catch (err) {
    // Calendario caído → NO se corre a ciegas. Al revés que el fail-OPEN del
    // decide: aquel corría una vez al día y no correr costaba un día del
    // experimento; éste corre 78 veces y correr a ciegas costaría 78 ticks de
    // datos intradía sobre un mercado que podría estar cerrado.
    return { status: 'skipped_calendar_error', error: String((err && err.message) || err), date: today };
  }
  const phase = sessionPhase(now, session);
  if (!phase.open) return { status: 'skipped_market_closed', reason: phase.reason, date: today, phase };

  // El cambio de reglamento queda anunciado con fecha, una sola vez
  // (idempotente por id). Mismo mecanismo que el anuncio de la T2.
  await announceEventCadence(now);
  await ensureAgentStateRows(agents.map((a) => a.id));

  // ── (1c) B9 · EL ESCALÓN DEL PRESUPUESTO, UNA VEZ POR TICK ───────────
  // Acá es donde el breaker tiene dientes de verdad: el vigilante corre 78
  // veces al día y es el que puede despertar a los siete agentes. Se resuelve
  // UNA vez y rige todo el tick — rondas fijas, disparadores y el techo de
  // herramientas de cada corrida que se despache.
  //
  // FAIL OPEN si Neon no contesta (`currentTier` devuelve escalón 0 y lo
  // declara): frenar la liga entera por un problema de observabilidad sería
  // cambiar un problema por otro peor. Queda journaleado que corrió a ciegas.
  const presupuesto = await currentTier(now);
  await announceSpendTier(presupuesto, now);

  // (2) LIBROS. Un agente sin keys o con Alpaca caída se salta sin tumbar al
  // resto — igual que en la liga.
  const books = {};
  const bookErrors = {};
  const states = {};
  await Promise.all(agents.map(async (agent) => {
    states[agent.id] = await getArenaState(agent.id);
    const creds = agentAlpacaCreds(agent);
    if (!creds) { bookErrors[agent.id] = 'sin keys de Alpaca'; books[agent.id] = { positions: [], meta: {} }; return; }
    try {
      const positions = await getPositions(creds);
      books[agent.id] = { positions: positions || [], meta: {} };
    } catch (err) {
      bookErrors[agent.id] = String((err && err.message) || err);
      books[agent.id] = { positions: [], meta: {} };
    }
  }));

  // Niveles del día por agente (trailing armado + stop catastrófico).
  await Promise.all(agents.map(async (agent) => {
    if (states[agent.id] && states[agent.id].halted) return;
    books[agent.id].meta = await levelsForAgent(agent, books[agent.id].positions, today, now);
  }));

  // (2b) BUFFET: los candidatos precomputados del screener.
  let buffet = [];
  try {
    const rows = await readScreenerRows();
    buffet = screenerRankedSymbols(computeScreens(rows)).slice(0, MAX_BUFFET_WATCHED).map(up);
  } catch (err) { buffet = []; }

  const heldSymbols = [...new Set(Object.values(books).flatMap((b) => (b.positions || []).map((p) => up(p && p.symbol))).filter(Boolean))];
  const watched = [...new Set([...heldSymbols, ...buffet])];
  if (!watched.length) {
    return { status: 'ok_nothing_watched', date: today, phase, agents: agents.length, book_errors: bookErrors };
  }

  // (2c) EVENTOS DEL DÍA (earnings + 8-K), con su propio TTL: no se re-escanea
  // SEC en cada tick por una respuesta que cambia un puñado de veces al día.
  let eventsRefresh = null;
  try {
    if (await eventsRefreshDue(today, now)) {
      eventsRefresh = await refreshDayEvents({ baseUrl, symbols: heldSymbols, today, now });
    }
  } catch (err) { eventsRefresh = { error: String((err && err.message) || err) }; }
  let dayEvents = {};
  try { dayEvents = (await readDayEvents(today)).events; } catch (err) { dayEvents = {}; }

  // (2d) PRECIOS. Dos llamadas multi-símbolo para TODO el universo vigilado:
  // el snapshot (precio vivo + volumen del día + cierre anterior) y el promedio
  // de volumen de 20 sesiones. Cero tokens, dos requests.
  const dataCreds = agentAlpacaCreds(agents[0]);
  let quotes = {};
  let marketDataError = null;
  try {
    const [snaps, avgVol] = await Promise.all([
      getSnapshots(watched, dataCreds),
      getAvgDailyVolume(watched, { days: WATCH_RULES.volume_lookback_days, today, creds: dataCreds }),
    ]);
    for (const [sym, s] of Object.entries(snaps)) quotes[sym] = { ...s, avg_volume_20d: avgVol[sym] ?? null };
  } catch (err) {
    // Sin datos de mercado no hay vigilancia posible. Se reporta ruidoso (el
    // heartbeat lo verá) y se sale: NO se inventa un tick sin precios.
    marketDataError = String((err && err.message) || err);
    return { status: 'error_market_data', error: marketDataError, date: today, watched: watched.length };
  }

  // (3) ESTADO para los topes, leído de la fuente de verdad de cada cosa:
  //   - corridas de hoy → el JOURNAL (una corrida es una fila, punto).
  //   - cooldown y sticky → arena_watch (lo escribe este mismo endpoint).
  const [runRows, firedRows, markRows] = await Promise.all([
    sql(`select agent_id, count(*)::int as n from arena_journal
         where run_date = $1 and phase = 'decide' and context->'event'->>'type' in ('watch_trigger','watch_floor')
         group by agent_id`, [today]),
    sql(`select agent_id, symbol, trigger_type, fired, max(fired_at) as last_at
         from arena_watch where run_date = $1 group by agent_id, symbol, trigger_type, fired`, [today]),
    sql(`select agent_id, symbol, price, marked_at from arena_watch_mark`),
  ]);
  const runsToday = Object.fromEntries(runRows.map((r) => [r.agent_id, r.n]));
  const firedToday = new Set();
  const lastRunAt = {};
  for (const r of firedRows) {
    if (!r.fired) continue;
    firedToday.add(`${r.agent_id}|${up(r.symbol)}|${r.trigger_type}`);
    const key = `${r.agent_id}|${up(r.symbol)}`;
    const at = Date.parse(r.last_at);
    if (Number.isFinite(at)) lastRunAt[key] = Math.max(lastRunAt[key] || 0, at);
  }
  const marks = {};
  for (const r of markRows) marks[`${r.agent_id}|${up(r.symbol)}`] = { price: Number(r.price), marked_at: r.marked_at };

  // (4) EVALUAR + TOPES. Todo lo que dispara se journalea, despierte o no.
  const agentsForEval = agents.map((a) => ({ id: a.id, halted: !!(states[a.id] && states[a.id].halted) }));
  const triggersCrudos = evaluateTriggers({ agents: agentsForEval, books, quotes, marks, dayEvents, buffet });
  // ESCALÓN 2: se apagan los disparadores de OPORTUNIDAD (`buffet_move`: un
  // nombre que el agente NO tiene y que se movió) y sobreviven los del PROPIO
  // libro. La distinción es la que hace que el escalón 2 sea un freno y no una
  // mordaza: una posición abierta que cruza su stop tiene que poder despertar a
  // su dueño aunque el presupuesto esté agotado — eso es riesgo, no exploración.
  //
  // Los apagados NO desaparecen: se journalean con su `skip_reason`, igual que
  // los que caen por tope. Un día con menos corridas tiene que poder explicarse.
  const apagadosPorPresupuesto = presupuesto.buffet_triggers
    ? []
    : triggersCrudos.filter((t) => t.type === 'buffet_move');
  const triggers = presupuesto.buffet_triggers
    ? triggersCrudos
    : triggersCrudos.filter((t) => t.type !== 'buffet_move');
  const { runs, journal } = applyCaps(triggers, { firedToday, runsToday, lastRunAt, now });
  await journalTriggers([
    ...journal,
    ...apagadosPorPresupuesto.map((t) => ({ ...t, fired: false, skip_reason: `presupuesto en escalón ${presupuesto.tier}: los disparadores del buffet están apagados (los del propio libro no)` })),
  ], today, now);

  // (5) TICK DE LA APERTURA +30: la red determinista de los siete, y la
  //     revisión de piso del que nadie tocó.
  const riskNet = [];
  const floorRuns = [];

  // (5a) RED DETERMINISTA, una vez al día, para TODOS (cadencia #8). Sin LLM.
  // En el PRIMER tick de la sesión, no en el de la revisión de piso: decide con
  // el último cierre COMPLETO —el de ayer, el mismo dato que tenía la corrida
  // nocturna—, así que esperar media hora solo retrasaría el fill sin mejorar
  // la decisión. Con esto un stop que disparó se ejecuta ~9:35 ET, tan cerca de
  // la apertura como la orden `day` de la cadencia vieja llenaba a las 9:30.
  // Corre ANTES de cualquier pronunciamiento: si un stop disparó, la orden sale
  // primero y el PM decide con eso ya enviado.
  if (!dry && !(await doneToday('risknet:' + today))) {
    const caches = { series: new Map(), dive: new Map() };
    for (const agent of agents) {
      try { riskNet.push(await runArenaRiskNet({ agent, now, caches })); }
      catch (err) { riskNet.push({ agent: agent.id, status: 'error', error: String((err && err.message) || err) }); }
    }
    await markDone('risknet:' + today, { at: now.toISOString(), agents: riskNet.length }, now);
  }

  // ── (5c) B4 · LAS TRES RONDAS FIJAS ─────────────────────────────────
  // Viven acá y no en tres crons de Vercel, y ésa es la decisión: tres crons
  // serían tres horas UTC fijas, y el horario del mercado no lo es (cambia con
  // el horario de verano, y con media sesión el cierre−30 se mueve). El
  // vigilante ya sabe en qué minuto de la sesión está, así que las rondas se
  // derivan de ahí: "cuando lleven 30 minutos de sesión", no "a las 14:00 UTC".
  //
  // Una ronda fija es un `runArenaDecide` COMPLETO —con buffet y con el
  // presupuesto de 8 herramientas—, no una corrida acotada: es el momento en que
  // el PM mira el mercado entero y no un nombre que se movió.
  //
  // IDEMPOTENCIA: una ronda por tipo por día (`round:<día>:<id>`). El tick es de
  // 5 minutos y la ventana de una ronda dura media hora, así que sin la marca
  // los seis ticks siguientes dispararían seis rondas.
  //
  // EL PRESUPUESTO MANDA: en el escalón 2 no corren (`fixed_rounds: false`), y
  // la decisión de NO correrlas se journalea con el escalón que la causó.
  const fixedRuns = [];
  let rondaFija = null;
  if (!dry) {
    const roundsDone = new Set();
    for (const r of FIXED_ROUNDS) {
      if (await doneToday('round:' + today + ':' + r.id)) roundsDone.add(r.id);
    }
    rondaFija = fixedRoundDue({ phase, easternMinutes: easternMinutes(now), done: roundsDone });
    if (rondaFija && !presupuesto.fixed_rounds) {
      // Se marca como hecha IGUAL: sin esto, cada tick de la media hora
      // siguiente volvería a evaluarla y a journalear el mismo salto.
      await markDone('round:' + today + ':' + rondaFija.id,
        { at: now.toISOString(), skipped: true, tier: presupuesto.tier }, now);
      fixedRuns.push({ round: rondaFija.id, status: 'skipped_budget_tier', tier: presupuesto.tier, reason: presupuesto.label });
      rondaFija = null;
    } else if (rondaFija) {
      // El buffet es un self-fetch caro y es el MISMO para los siete: una vez
      // por ronda, compartido (igual que en la liga nocturna).
      let buffetPromise = null;
      const getBuffet = () => (buffetPromise = buffetPromise || gatherContext({ baseUrl, now }));
      const cachesRonda = { series: new Map(), dive: new Map() };
      const vivos = agents.filter((a) => !(states[a.id] && states[a.id].halted));
      const salidas = await Promise.all(vivos.map(async (agent) => {
        try {
          const out = await withDeadline(
            runArenaDecide({ baseUrl, now, agent, getBuffet, caches: cachesRonda, tier: presupuesto }),
            ARENA_AGENT_DEADLINE_MS,
            () => ({ status: 'timeout', orders: 0,
              error: `el agente no terminó en ${Math.round(ARENA_AGENT_DEADLINE_MS / 1000)}s (ronda ${rondaFija.label}). Los demás siguieron.` }),
          );
          return { id: agent.id, name: agent.name, round: rondaFija.id, ...out };
        } catch (err) {
          return { id: agent.id, name: agent.name, round: rondaFija.id, status: 'error', error: String((err && err.message) || err) };
        }
      }));
      fixedRuns.push(...salidas);
      await markDone('round:' + today + ':' + rondaFija.id,
        { at: now.toISOString(), agents: salidas.map((x) => x.id), tier: presupuesto.tier }, now);
    }
  }

  const floorTick = phase.minutes_since_open != null && phase.minutes_since_open >= WATCH_RULES.floor_after_open_minutes;
  // La revisión de piso es una corrida PROGRAMADA (no un disparador), así que
  // sigue la misma regla que las rondas fijas: en el escalón 2 no corre. Un
  // agente al que nadie despertó y que además está sobre presupuesto no tiene
  // por qué gastar una corrida entera en decir que no hace nada.
  let floorAgents = [];
  if (floorTick && !dry && presupuesto.fixed_rounds) {
    // (5b) PISO: los que no fueron despertados HOY por ningún disparador.
    const floorDone = new Set();
    try {
      const rows = await sql(`select value from arena_watch_meta where key = $1`, ['floor:' + today]);
      for (const id of (rows[0] && rows[0].value && rows[0].value.agents) || []) floorDone.add(id);
    } catch (err) { /* sin marca → se intenta */ }
    // Un agente que va a correr AHORA por un disparador tampoco necesita piso.
    const runsWithTick = { ...runsToday };
    for (const r of runs) runsWithTick[r.agent_id] = (runsWithTick[r.agent_id] || 0) + 1;
    floorAgents = floorReviewDue({ phase, agents: agentsForEval, runsToday: runsWithTick, floorDone });
  }

  // (6) RECONCILE oportuno: con órdenes que llenan en minutos, el `previous`
  // que se le reinyecta al PM se queda viejo dentro del mismo día. Se true-ea
  // antes de despertar a nadie, y no más de una vez cada 30 minutos.
  let reconcile = null;
  if (!dry && (runs.length || floorAgents.length)) {
    const key = 'reconcile:' + today;
    let dueAt = 0;
    try {
      const rows = await sql(`select value from arena_watch_meta where key = $1`, [key]);
      dueAt = rows[0] && rows[0].value && rows[0].value.at ? Date.parse(rows[0].value.at) : 0;
    } catch (err) { dueAt = 0; }
    if (!Number.isFinite(dueAt) || now.getTime() - dueAt >= 30 * 60000) {
      try { reconcile = await runArenaReconcile({ now }); } catch (err) { reconcile = { error: String((err && err.message) || err) }; }
      await markDone(key, { at: now.toISOString() }, now);
    }
  }

  // (7) DESPERTAR. Cada corrida es ACOTADA a sus tickers, con el reglamento
  // completo y órdenes que ejecutan en el momento. En paralelo: son cuentas y
  // modelos distintos, y uno que truena no tumba a los demás.
  const caches = { series: new Map(), dive: new Map() };
  const priceOf = (syms) => Object.fromEntries(syms.map((s) => [s, quotes[s] && quotes[s].price]).filter(([, p]) => Number.isFinite(p)));

  const dispatched = await Promise.all(runs.map(async (r) => {
    const agent = agentById(r.agent_id);
    if (!agent || dry) return { id: r.agent_id, symbols: r.symbols, status: dry ? 'dry_run' : 'unknown_agent', triggers: r.triggers.map((t) => t.type) };
    const prices = priceOf(r.symbols);
    const event = {
      type: 'watch_trigger',
      symbols: r.symbols,
      triggers: r.triggers,
      prices,
      headline: buildTriggerHeadline(r.triggers),
    };
    try {
      // MISMO RELOJ QUE LA NOCTURNA: el vigilante dispara el MISMO
      // runArenaDecide (scan + dive), así que hereda el mismo riesgo — un
      // agente lento tumbando el tick entero — y la misma cura.
      const out = await withDeadline(
        runArenaDecide({ baseUrl, now, agent, caches, event, tier: presupuesto }),
        ARENA_AGENT_DEADLINE_MS,
        () => ({ status: 'timeout', orders: 0,
          error: `el agente no terminó en ${Math.round(ARENA_AGENT_DEADLINE_MS / 1000)}s. Los demás del tick siguieron.` }),
      );
      // La marca se re-fija sobre TODO el slate: el agente se pronunció sobre
      // esos nombres, opere o no. Sin esto el mismo ±3% lo despertaría otra vez
      // en el tick siguiente, y otra, hasta agotar sus 12 corridas.
      //
      // TAMBIÉN SE MARCA EN TIMEOUT, y es deliberado. Un timeout ya gastó
      // tokens (recordAiCall corre dentro de la llamada, el burn es real). Si
      // además dejáramos el disparador vivo, un modelo sistemáticamente lento
      // se despertaría cada 5 minutos sobre el mismo ±3% y quemaría las 12
      // corridas del día sin decidir nada. Se paga una reacción perdida a
      // cambio de no pagar doce. La fila `timeout` queda en el journal para
      // que se vea que pasó.
      await setMarks(agent.id, r.symbols, prices, 'watch_trigger', now);
      return { id: agent.id, name: agent.name, symbols: r.symbols, triggers: r.triggers.map((t) => t.type), ...out };
    } catch (err) {
      return { id: agent.id, name: agent.name, symbols: r.symbols, status: 'error', error: String((err && err.message) || err) };
    }
  }));

  // (8) REVISIÓN DE PISO (cadencia #6).
  for (const agentId of floorAgents) {
    const agent = agentById(agentId);
    const positions = (books[agentId] && books[agentId].positions) || [];
    const symbols = [...new Set(positions.map((p) => up(p && p.symbol)).filter(Boolean))];
    if (!agent || !symbols.length) { floorRuns.push({ id: agentId, status: 'skipped_empty_book' }); continue; }
    const prices = priceOf(symbols);
    const event = {
      type: 'watch_floor',
      symbols,
      prices,
      headline: `Ningún disparador te tocó hoy. Revisión de piso a la apertura +${WATCH_RULES.floor_after_open_minutes} min: te pronuncias sobre tus ${symbols.length} posición(es) igual.`,
    };
    try {
      const out = await runArenaDecide({ baseUrl, now, agent, caches, event, tier: presupuesto });
      await setMarks(agentId, symbols, prices, 'watch_floor', now);
      floorRuns.push({ id: agentId, name: agent.name, symbols, ...out });
    } catch (err) {
      floorRuns.push({ id: agentId, status: 'error', error: String((err && err.message) || err) });
    }
  }
  if (floorAgents.length) {
    const prev = new Set();
    try {
      const rows = await sql(`select value from arena_watch_meta where key = $1`, ['floor:' + today]);
      for (const id of (rows[0] && rows[0].value && rows[0].value.agents) || []) prev.add(id);
    } catch (err) { /* ídem */ }
    for (const id of floorAgents) prev.add(id);
    await markDone('floor:' + today, { at: now.toISOString(), agents: [...prev] }, now);
  }

  return {
    status: 'ok',
    date: today,
    phase: { open: phase.open, minutes_since_open: phase.minutes_since_open, minutes_to_close: phase.minutes_to_close },
    budget: {
      tier: presupuesto.tier, spent_usd: presupuesto.spent_usd, budget_usd: presupuesto.budget_usd,
      pct_of_budget: presupuesto.pct_of_budget, tools_max: presupuesto.tools_max,
      effort: presupuesto.effort || null, fixed_rounds: presupuesto.fixed_rounds,
      buffet_triggers: presupuesto.buffet_triggers, label: presupuesto.label,
      buffet_triggers_apagados: apagadosPorPresupuesto.length,
      note: presupuesto.note || null,
    },
    fixed_round: rondaFija ? rondaFija.id : null,
    fixed_runs: fixedRuns,
    watched: watched.length,
    held: heldSymbols.length,
    buffet: buffet.length,
    triggers_evaluated: triggers.length,
    triggers_fired: journal.filter((t) => t.fired).length,
    triggers_skipped: journal.filter((t) => !t.fired).map((t) => ({ agent: t.agent_id, symbol: t.symbol, type: t.type, reason: t.skip_reason })),
    runs: dispatched,
    floor_runs: floorRuns,
    risk_net: riskNet,
    reconcile,
    events_refresh: eventsRefresh,
    book_errors: Object.keys(bookErrors).length ? bookErrors : undefined,
    dry: dry || undefined,
  };
}

// ── handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  // El costo del peor caso, CALCULADO (no escrito a mano en un doc que
  // envejece). Sin efectos: no toca DB, ni Alpaca, ni un modelo.
  if (req.query && (req.query.estimate === '1' || req.query.estimate === 'true')) {
    return res.status(200).json({
      estimate: estimateWorstCaseCost(activeAgents()),
      rules: WATCH_RULES,
      cadence_start: watchStartDate(),
    });
  }

  // Dos frenos independientes: el del Arena entero y el del vigilante. Apagar
  // el vigilante NO debe requerir apagar el Arena — si el modelo por evento sale
  // mal, se vuelve al cron nocturno moviendo ARENA_WATCH_START hacia adelante y
  // ARENA_WATCH_ENABLED a 0, sin un deploy.
  if (process.env.ARENA_ENABLED !== '1' || process.env.ARENA_WATCH_ENABLED === '0') {
    await beat('arena:watch', 'disabled');
    return res.status(200).json({ disabled: true, hint: 'ARENA_ENABLED != 1 o ARENA_WATCH_ENABLED = 0.' });
  }

  try {
    await ensureSchema();

    // ── PAUSA DINÁMICA (freno de mano #3, en Neon) ───────────────────
    // Los dos frenos de arriba son env vars: moverlos exige un redeploy. El
    // RESET de libros (/api/arena-reset) necesita algo más chico y más rápido —
    // apagar el vigilante por los pocos minutos que dura el aplanado y volver a
    // prenderlo solo, sin tocar el deploy. Si el tick cayera en medio, vería
    // siete libros a medio liquidar y despertaría a los agentes para opinar
    // sobre un libro que está dejando de existir.
    //
    // La pausa VENCE sola: no existe forma de dejarla puesta para siempre. Y
    // falla ABIERTA (watchPaused devuelve null si la DB no contesta): un
    // vigilante que se apaga porque Neon tosió es peor que un tick de más.
    const pausa = await watchPaused(new Date());
    if (pausa) {
      await beat('arena:watch', 'paused', { until: pausa.until });
      return res.status(200).json({
        paused: true, until: pausa.until, minutes_left: pausa.minutes_left, reason: pausa.note,
        hint: 'Pausa dinámica en arena_flags (la pone /api/arena-reset mientras aplana las cuentas). Vence sola.',
      });
    }

    const dry = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));
    const summary = await runArenaWatch({ baseUrl: resolveBaseUrl(req), dry });
    // El latido dice "el vigilante corrió", no "operó": late igual en un tick
    // sin disparadores. Es lo que distingue un cron muerto de un día tranquilo.
    await beat('arena:watch', 'ok', { status: summary.status, fired: summary.triggers_fired ?? 0, runs: (summary.runs || []).length });
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ error: 'arena-watch: ' + (err && err.message ? err.message : 'unknown') });
  }
}
