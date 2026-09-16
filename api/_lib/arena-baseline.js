// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-baseline.js — el CORTE del Arena: baselines y flags.
//
// Dos cosas chicas que el resto del Arena necesita y que no tenían dueño:
//
// 1. EL BASELINE POR AGENTE. `SEASON_CUTOFF` (arena-run.js) corta la memoria
//    del PM y el pico del breaker en la fecha de arranque DECLARADA de la
//    temporada. Eso alcanza mientras la temporada arranca una sola vez. Un
//    RESET a mitad de temporada —aplanar las siete cuentas y volver a empezar
//    el mismo T2— no tenía dónde anotarse: el plan anterior, los fills, los
//    compromisos y el `max(equity)` del breaker seguían mirando al arranque
//    declarado, o sea a un libro que ya no existe.
//
//    El baseline es ese corte con fecha REAL, por agente, en `arena_state`.
//    La regla es una sola y se aplica en los dos lados:
//
//        corte efectivo = MAX(arranque de temporada, baseline del reset)
//
//    Y el PISO del pico del breaker es el `baseline_equity` declarado. Ahí está
//    la mitad que importa del fix: sin piso, un libro recién aplanado arranca
//    con el pico de ANTES del aplanado y el breaker dispara el primer día.
//
//    El baseline es TAMBIÉN el DENOMINADOR del retorno de ese agente
//    (`returnPct`). Las dos cosas tienen que ser el mismo número: si el piso del
//    breaker es el equity real pero el retorno se divide por un $100k global, la
//    misma cuenta arranca en 0% para el breaker y en −1.45% en la tabla
//    pública. Por eso `readBaselines` y `baselineDe` viven acá y no cada
//    endpoint con su propio fallback.
//
// 2. LOS FLAGS. Un kv en Neon (`arena_flags`) para lo único que hoy tiene que
//    poder apagarse SIN redeploy: la pausa del vigilante mientras el reset
//    liquida. Guarda un VENCIMIENTO, no un booleano — una pausa que se olvida
//    de despausarse deja al Arena ciego para siempre, y un vencimiento hace que
//    el peor caso sea "el vigilante vuelve solo en N minutos".
//
// Todo acá es best-effort sobre la DB: un flag que no se pudo leer NO apaga el
// Arena (fail OPEN para la pausa: si no sabemos que está pausado, corre), y un
// baseline que no se pudo leer cae al corte de temporada de siempre.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

// Piso declarado de equity de una temporada. Las cuentas paper arrancan en
// $100k; env-overridable para poder corregirlo sin deploy si alguna cuenta se
// abre con otro monto.
export const RESET_BASELINE_USD = (() => {
  const n = Number(process.env.ARENA_RESET_BASELINE_USD);
  return Number.isFinite(n) && n > 0 ? n : 100000;
})();

export const WATCH_PAUSE_FLAG = 'watch_paused_until';

// ── PURO (testeable sin DB) ──────────────────────────────────────────

// Número REAL o null. `Number(null)`, `Number('')` y `Number([])` son todos 0 —
// tres formas de que un dato ausente se publique como un cero con autoridad.
function num(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// El corte efectivo de la memoria del PM: la MÁS RECIENTE entre el arranque de
// la temporada y el baseline del último reset. Ambos 'YYYY-MM-DD'.
// Un baseline nulo o inválido no rompe nada: gana el arranque de temporada.
export function effectiveCutoff(seasonStart, baselineAt) {
  if (!baselineAt) return seasonStart;
  // `Date.parse` PRIMERO: `new Date('basura').toISOString()` LANZA, y esta
  // función alimenta el corte de cuatro consultas de memoria — un baseline
  // corrupto en la DB no puede tumbar la corrida, tiene que caer al suelo.
  const t = Date.parse(baselineAt instanceof Date ? baselineAt.toISOString() : String(baselineAt));
  if (!Number.isFinite(t)) return seasonStart;
  const b = new Date(t).toISOString().slice(0, 10);
  return b > seasonStart ? b : seasonStart;
}

// El PICO del breaker. Tres candidatos y gana el mayor, siempre:
//   · el máximo journaleado DESPUÉS del corte (dbPeak);
//   · el equity de HOY (el pico es monótono e incluye el presente);
//   · el baseline declarado de la temporada (el piso).
//
// El piso es la pieza nueva y es la que evita el footgun: un libro aplanado a
// $100k contra un pico de $130k de antes del reset arrancaría en −23% de
// drawdown → los siete HALTED en su primera corrida.
//
// OJO CON EL OTRO LADO: si el equity POST-aplanado quedó por debajo del
// baseline declarado, el piso mete un drawdown de arranque real
// (`startingDrawdown` lo calcula para poder reportarlo). Eso no es un bug del
// piso — es el baseline diciendo la verdad sobre una cuenta que no vale lo que
// se declaró. Por eso el reset lo AVISA cuenta por cuenta en vez de taparlo.
export function breakerPeak({ dbPeak = 0, equity = 0, baselineEquity = 0 } = {}) {
  return Math.max(Number(dbPeak) || 0, Number(equity) || 0, Number(baselineEquity) || 0);
}

// ── EL RETORNO, contra el baseline PROPIO ────────────────────────────
// El denominador de un agente es SU baseline, no un $100k global. Cuando las
// siete cuentas no arrancan exactamente en $100k —y no arrancan: aplanar a
// mercado deja residuos distintos en cada una— un denominador compartido le
// cobra a cada agente el residuo de su propio aplanado como si fuera pérdida.
// El 2026-09-16 eso valía −1.45% para `control` y −0.41% para `claude`: más que
// el piso de ruido que esas dos cuentas existen para medir.
//
// null si no se puede calcular. Un retorno inventado en la tabla pública es
// peor que un hueco.
export function returnPct(equity, baselineEquity) {
  // `num` y no `Number` a secas: `Number(null)` es 0 y `Number('')` también, así
  // que un equity AUSENTE pasaría el chequeo de finitud y saldría publicado como
  // −100%. Un agente al que no se le pudo leer la cuenta no está en −100%: no
  // se sabe, y eso se dice con null.
  const e = num(equity), b = num(baselineEquity);
  if (e == null || b == null || b <= 0) return null;
  return +(((e - b) / b) * 100).toFixed(2);
}

// El baseline de un agente desde el mapa de `readBaselines`, con el default
// aplicado. Existe para que los cuatro consumidores no repitan el fallback cada
// uno a su manera — que es como terminan divergiendo.
export function baselineDe(map, agentId, fallback = RESET_BASELINE_USD) {
  const r = map && map[agentId];
  const n = r && r.baseline_equity != null ? Number(r.baseline_equity) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Drawdown con el que arranca una cuenta recién aplanada, en fracción (0.13 =
// −13%). 0 cuando el equity alcanza o supera el baseline.
export function startingDrawdown(equity, baselineEquity) {
  // Mismo cuidado que en `returnPct`: sin `num`, un equity null se leería como 0
  // y la cuenta arrancaría reportando 100% de drawdown. Dato ausente → 0, que es
  // el fail-open documentado de esta función (no sabemos ≠ está en el piso).
  const e = num(equity), b = num(baselineEquity);
  if (e == null || b == null || b <= 0) return 0;
  return e >= b ? 0 : +((b - e) / b).toFixed(4);
}

// ── CON DB (best-effort; nunca lanza) ────────────────────────────────

// { agent_id: {baseline_at, baseline_equity, baseline_id} }. {} si la DB falla.
export async function readBaselines(agentIds = null) {
  try {
    const rows = agentIds && agentIds.length
      ? await sql(`select agent_id, baseline_at, baseline_equity, baseline_id from arena_state where agent_id = any($1)`, [agentIds])
      : await sql(`select agent_id, baseline_at, baseline_equity, baseline_id from arena_state`);
    const out = {};
    for (const r of rows || []) if (r && r.agent_id) out[r.agent_id] = r;
    return out;
  } catch { return {}; }
}

// El baseline de UN agente, con los defaults ya aplicados. Nunca null.
export async function readBaseline(agentId) {
  const map = await readBaselines([agentId]);
  const r = map[agentId] || {};
  return {
    baseline_at: r.baseline_at || null,
    baseline_equity: r.baseline_equity != null ? Number(r.baseline_equity) : RESET_BASELINE_USD,
    baseline_id: r.baseline_id || null,
  };
}

export async function setBaseline(agentId, { at, equity, id }) {
  await sql(
    `insert into arena_state (agent_id, halted, baseline_at, baseline_equity, baseline_id)
     values ($1, false, $2, $3, $4)
     on conflict (agent_id) do update set
       halted = false, halted_at = null, halted_reason = null,
       baseline_at = excluded.baseline_at,
       baseline_equity = excluded.baseline_equity,
       baseline_id = excluded.baseline_id`,
    [agentId, at, equity, id],
  );
}

// ── FLAGS ────────────────────────────────────────────────────────────

export async function readFlag(key) {
  try {
    const rows = await sql(`select value, note, updated_at from arena_flags where key = $1`, [key]);
    return rows[0] || null;
  } catch { return null; }
}

export async function setFlag(key, value, note = null) {
  await sql(
    `insert into arena_flags (key, value, note, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, note = excluded.note, updated_at = now()`,
    [key, JSON.stringify(value), note],
  );
}

export async function clearFlag(key) {
  try { await sql(`delete from arena_flags where key = $1`, [key]); return true; }
  catch { return false; }
}

// Pausa el vigilante hasta `now + minutes`. El vencimiento es obligatorio: no
// hay forma de pedir una pausa indefinida desde acá.
export async function pauseWatch(minutes, note, now = new Date()) {
  const mins = Math.max(1, Math.min(120, Math.floor(Number(minutes) || 0) || 15));
  const until = new Date(now.getTime() + mins * 60000).toISOString();
  await setFlag(WATCH_PAUSE_FLAG, { until }, note || null);
  return { until, minutes: mins };
}

export async function resumeWatch() {
  return clearFlag(WATCH_PAUSE_FLAG);
}

// ¿Está pausado AHORA? FAIL OPEN: si la DB no contesta, el vigilante corre.
// Un vigilante que se apaga porque Neon tosió es peor que uno que corre un tick
// de más durante un aplanado — el tick de más se journalea y se lee.
export async function watchPaused(now = new Date()) {
  const row = await readFlag(WATCH_PAUSE_FLAG);
  const until = row && row.value && row.value.until;
  if (!until) return null;
  const t = Date.parse(until);
  if (!Number.isFinite(t) || t <= now.getTime()) return null;
  return { until, note: row.note || null, minutes_left: Math.ceil((t - now.getTime()) / 60000) };
}
