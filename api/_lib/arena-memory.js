// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-memory.js — la MEMORIA del Arena (Temporada 2, 2026-09-13).
//
// Tercer hermano de arena-guard.js y arena-exits.js: JS puro, sin I/O, sin
// LLM. Lo que vive aquí es lo que el PM NO puede recordar solo, y que la
// Temporada 1 demostró que no recuerda:
//
//   1. COMPROMISOS (T2 #1). El PM escribía "reservo efectivo para la
//      dislocación post-earnings de NVDA" y a los dos días ni NVDA ni CRM
//      volvían a aparecer en su prosa: la promesa moría con la corrida que la
//      escribió. Aquí los compromisos se EXTRAEN de su salida, se guardan
//      CON FECHA y se le devuelven en la corrida siguiente con obligación de
//      pronunciarse (cumplido / vigente / cancelado). La amnesia deja de ser
//      gratis: queda journaleada.
//   2. LA HISTORIA DE CADA POSICIÓN (T2 #3/#4/#9). Alpaca da `qty`,
//      `avg_entry_price` y el P&L, pero NO desde cuándo tienes el nombre ni
//      cuánto llegó a valer. Sin eso no hay trailing stop (necesita el pico),
//      no hay time stop (necesita los días) y el pronunciamiento por posición
//      no tiene números. Ambos se DERIVAN, sin schema nuevo: la fecha de
//      apertura, de los fills del propio journal; el pico, de la serie diaria
//      acotada por esa fecha. Mismo criterio con el que el pico de equity del
//      breaker sale de `max(account.equity)` del journal.
//
// POR QUÉ DERIVAR Y NO GUARDAR: una tabla `arena_positions` sería estado
// paralelo que puede desincronizarse del libro real y hay que migrar. El
// journal ya es la memoria del experimento — reconstruir de él es auditable
// (el post-mortem ve la MISMA cuenta que vio el runner) y se auto-repara.
//
// QUÉ **NO** HACE ESTE MÓDULO: no censura, no corrige y no aborta. Las
// auditorías (`auditCommitments`, `auditPositionReview`) son INSTRUMENTOS DE
// MEDICIÓN — journalean quién incumplió, igual que _lib/prose-audit.js. Lo que
// sí fuerza una venta es el trailing stop determinista (_lib/arena-exits.js);
// la memoria le pone al PM la obligación de hablar, no de obedecer.
// ═══════════════════════════════════════════════════════════════

import { EXIT_RULES, trailingState, timeStopState } from './arena-exits.js';

const up = (s) => String(s || '').trim().toUpperCase();
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
const day = (s) => (isDate(s) ? Date.parse(String(s).trim() + 'T00:00:00Z') : NaN);

// Días CALENDARIO entre dos fechas 'YYYY-MM-DD' (o Date → ISO). null si alguna
// no parsea: un dato ausente nunca se rellena con un cero que parece un hecho.
export function daysBetween(fromDate, toDate) {
  const a = day(fromDate);
  const b = day(typeof toDate === 'string' ? toDate : new Date(toDate || Date.now()).toISOString().slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ═══ 1. HISTORIA DE LA POSICIÓN ════════════════════════════════════

// ── fecha de apertura, reconstruida de los FILLS del journal ─────────
// `rows`: filas decide del agente en orden CRONOLÓGICO (ascendente), cada una
// { run_date, actions }. Se recorre el libro sintético: cada compra LLENADA
// suma, cada venta LLENADA resta. La posición ACTUAL empieza la última vez que
// el nombre pasó de 0 a >0 — así un nombre que se cerró y se volvió a comprar
// reinicia su reloj (que es lo correcto: es otra tesis, otra entrada).
//
// Solo cuentan órdenes con fill REAL (`result:'approved'` + `order_status:
// 'filled'`): una orden enviada que expiró nunca abrió nada. La fecha es la del
// fill (`filled_at`) y, si falta, la de la corrida — el journal del reconcile
// llena `filled_at`, pero una fila vieja puede no traerlo.
//
// Devuelve { SYMBOL: { opened_at, qty } } con SOLO los nombres abiertos según
// la reconstrucción. Un símbolo que Alpaca reporta y esta cuenta no conoce
// (fill anterior al journal, o movimiento manual) simplemente no aparece → el
// caller lo trata como apertura DESCONOCIDA, nunca como "abierto hoy".
export function reconstructPositionOpens(rows) {
  const book = new Map(); // SYMBOL → { qty, opened_at }
  for (const row of rows || []) {
    const runDate = String((row && row.run_date) || '').slice(0, 10);
    for (const a of ((row && row.actions) || [])) {
      if (!a || a.result !== 'approved' || a.order_status !== 'filled') continue;
      const sym = up(a.symbol);
      if (!sym) continue;
      // filled_qty del reconcile; si la fila no lo trae, la qty de la orden.
      const q = num(a.filled_qty) ?? num(a.qty);
      if (q == null || q <= 0) continue;
      const when = isDate(String(a.filled_at || '').slice(0, 10)) ? String(a.filled_at).slice(0, 10) : (isDate(runDate) ? runDate : null);
      const prev = book.get(sym) || { qty: 0, opened_at: null };
      if (a.side === 'buy') {
        // 0 → >0: nace la posición actual. Un `add` sobre una posición viva NO
        // reinicia el reloj (sigue siendo la misma tesis, promediada).
        if (prev.qty <= 0) book.set(sym, { qty: q, opened_at: when });
        else book.set(sym, { qty: prev.qty + q, opened_at: prev.opened_at });
      } else if (a.side === 'sell') {
        const rest = prev.qty - q;
        if (rest > 0) book.set(sym, { qty: rest, opened_at: prev.opened_at });
        else book.delete(sym); // cerrada: el reloj se reinicia con la próxima compra
      }
    }
  }
  const out = {};
  for (const [sym, v] of book) if (v.qty > 0) out[sym] = { opened_at: v.opened_at, qty: v.qty };
  return out;
}

// ── pico de precio desde la entrada ──────────────────────────────────
// `series` = { dates:[], closes:[] } YA recortada a velas COMPLETAS (la misma
// que alimenta al guard). La ventana arranca en `openedAt` inclusive. El piso
// del pico es la ENTRADA: comprar arriba del cierre de ese día no debe producir
// un "pico" por debajo del costo (el high-water-mark de una posición empieza en
// lo que pagaste). Sin ventana utilizable → el pico es la entrada.
// Devuelve { peak, peak_at, sessions } · null si no hay ni entrada ni serie.
export function peakSinceEntry(series, openedAt, entry) {
  const e = num(entry);
  const dates = (series && series.dates) || [];
  const closes = (series && series.closes) || [];
  let peak = e != null && e > 0 ? e : null;
  let peak_at = null;
  let sessions = 0;
  const from = day(openedAt);
  for (let i = 0; i < dates.length; i++) {
    // Sin fecha de apertura conocida NO se abre la ventana: usar la serie
    // completa daría un pico anterior a la compra (trailing que arma solo).
    if (!Number.isFinite(from) || day(dates[i]) < from) continue;
    sessions++;
    const c = num(closes[i]);
    if (c == null || c <= 0) continue;
    if (peak == null || c > peak) { peak = c; peak_at = dates[i]; }
  }
  if (peak == null) return null;
  return { peak: +peak.toFixed(4), peak_at, sessions };
}

// ── meta por posición: lo que el PM necesita para pronunciarse (T2 #9) ──
// Un objeto por símbolo con los números YA CALCULADOS (la casa no delega
// aritmética al modelo): días en posición, pico desde la entrada, distancia al
// pico, estado del trailing y estado del time stop.
//   positions → las de Alpaca ({ symbol, qty, avg_entry_price, current_price })
//   opens     → salida de reconstructPositionOpens
//   seriesBySymbol → { SYMBOL: {dates,closes} } recortada a velas completas
// Un dato que no se pudo derivar viaja como null y el prompt lo dice: hueco
// honesto, jamás un cero que se lee como un hecho.
export function buildPositionMeta({ positions = [], opens = {}, seriesBySymbol = {}, now = new Date(), rules = EXIT_RULES } = {}) {
  const today = now.toISOString().slice(0, 10);
  const meta = {};
  for (const p of positions) {
    const sym = up(p && p.symbol);
    if (!sym) continue;
    const opened_at = (opens[sym] && opens[sym].opened_at) || null;
    const days_in_position = opened_at ? daysBetween(opened_at, today) : null;
    const pk = peakSinceEntry(seriesBySymbol[sym], opened_at, p.avg_entry_price);
    const trailing = pk ? trailingState(p, pk.peak, rules) : null;
    meta[sym] = {
      opened_at,
      days_in_position,
      peak_since_entry: pk ? pk.peak : null,
      peak_at: pk ? pk.peak_at : null,
      // Distancia al pico con el precio VIVO de Alpaca (lo que el PM ve en su
      // libro). El trailing determinista decide con el CIERRE completo, no con
      // esto — dos números distintos a propósito, y ambos journaleados.
      from_peak_pct: trailing ? trailing.from_peak_pct : null,
      gain_at_peak_pct: trailing ? trailing.gain_at_peak_pct : null,
      trailing: trailing ? { armed: trailing.armed, arm_level: trailing.arm_level, level: trailing.level } : null,
      time_stop: timeStopState(days_in_position, rules),
    };
  }
  return meta;
}

// { SYMBOL: pico } — lo que buildRiskExits necesita para el trailing stop.
export function peaksFromMeta(meta) {
  const out = {};
  for (const [sym, m] of Object.entries(meta || {})) if (m && m.peak_since_entry != null) out[sym] = m.peak_since_entry;
  return out;
}

// ═══ 2. COMPROMISOS ════════════════════════════════════════════════

// Un compromiso caduca solo a los 30 días sin resolución: si el PM no lo cumplió
// ni lo canceló en un mes, arrastrarlo más tiempo solo llena el prompt de ruido
// viejo. La caducidad queda journaleada (`caducado`), no desaparece en silencio.
export const COMMITMENT_MAX_AGE_DAYS = 30;
// Tope de compromisos abiertos que viajan al prompt (los más recientes). Es un
// límite de contexto, no de memoria: el journal los conserva todos.
export const MAX_OPEN_COMMITMENTS = 8;

const COMMITMENT_STATUS = new Set(['cumplido', 'vigente', 'cancelado']);

// ── normalización de lo que el modelo emite ─────────────────────────
// El contrato del DIVE es TOLERANTE a propósito: `commitments` ausente o
// malformado NO invalida la respuesta (el run no aborta por esto — la regla de
// la casa sobre JSON malformado aplica a `plan`/`actions`, y endurecerla aquí
// solo subiría la tasa de aborts). Lo que no se puede leer, se descarta y se
// mide. `tag` distingue la corrida dentro del día ('d' decide, 'm' matutina)
// para que dos corridas del mismo día no colisionen en el id.
export function normalizeCommitments(raw, { runDate, tag = 'd', max = 5 } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const text = typeof c.text === 'string' ? c.text.trim() : (typeof c.commitment === 'string' ? c.commitment.trim() : '');
    if (!text) continue;
    const symbol = up(c.symbol || c.ticker) || null;
    const due = isDate(c.due) ? String(c.due).trim() : (isDate(c.due_date) ? String(c.due_date).trim() : null);
    out.push({ id: `${runDate}:${tag}#${out.length + 1}`, on: runDate, symbol, text: text.slice(0, 300), due });
    if (out.length >= max) break;
  }
  return out;
}

// Updates sobre compromisos abiertos: { id, status, note }. Un status fuera del
// vocabulario se descarta (la auditoría lo cuenta como no-pronunciado).
export function normalizeCommitmentUpdates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const u of raw) {
    if (!u || typeof u !== 'object') continue;
    const id = typeof u.id === 'string' ? u.id.trim() : '';
    const status = typeof u.status === 'string' ? u.status.trim().toLowerCase() : '';
    if (!id || seen.has(id) || !COMMITMENT_STATUS.has(status)) continue;
    seen.add(id);
    out.push({ id, status, note: typeof u.note === 'string' ? u.note.trim().slice(0, 300) : null });
  }
  return out;
}

// ── el fold: filas del journal → compromisos ABIERTOS ────────────────
// `rows` en orden CRONOLÓGICO (ascendente), cada una con
// context.commitments = { created:[...], updates:[...] }. Se aplica en orden:
// primero los updates de esa corrida (resuelven lo anterior), luego lo que esa
// corrida creó. Un `vigente` NO cierra: re-afirma (y actualiza la nota).
// Devuelve { open:[...], resolved:[...] } — `open` ordenado del más viejo al
// más nuevo, con la edad y el vencimiento YA calculados para el prompt.
export function foldCommitments(rows, { now = new Date(), maxOpen = MAX_OPEN_COMMITMENTS, maxAgeDays = COMMITMENT_MAX_AGE_DAYS } = {}) {
  const today = now.toISOString().slice(0, 10);
  const open = new Map();
  const resolved = [];
  for (const row of rows || []) {
    const c = (row && row.context && row.context.commitments) || null;
    if (!c) continue;
    for (const u of (c.updates || [])) {
      const cur = open.get(u && u.id);
      if (!cur) continue; // update sobre algo que ya no está abierto: se ignora acá (la auditoría de esa corrida ya lo midió)
      if (u.status === 'vigente') { cur.note = u.note || cur.note; cur.reaffirmed = (cur.reaffirmed || 0) + 1; continue; }
      open.delete(u.id);
      resolved.push({ ...cur, status: u.status, note: u.note || null, resolved_on: String((row && row.run_date) || '').slice(0, 10) || null });
    }
    for (const n of (c.created || [])) {
      if (!n || !n.id || open.has(n.id)) continue;
      open.set(n.id, { ...n, reaffirmed: 0, note: null });
    }
  }
  // Caducidad: lo que lleva más de maxAgeDays sin resolverse sale del prompt,
  // marcado (no se borra del journal — la fila que lo creó sigue ahí).
  const alive = [];
  for (const c of open.values()) {
    const age = daysBetween(c.on, today);
    if (age != null && age > maxAgeDays) { resolved.push({ ...c, status: 'caducado', resolved_on: today }); continue; }
    alive.push({ ...c, age_days: age, overdue: c.due ? (daysBetween(c.due, today) ?? 0) > 0 : false });
  }
  // Se muestran los más RECIENTES cuando hay más que el tope (un compromiso de
  // hace 3 semanas pesa menos que el de ayer), pero se renderean del más viejo
  // al más nuevo para que la lista se lea como una bitácora.
  const trimmed = alive.slice(-maxOpen);
  return { open: trimmed, resolved, dropped: alive.length - trimmed.length };
}

// ── auditoría de cumplimiento (mide, no censura) ─────────────────────
// ¿Se pronunció el PM sobre CADA compromiso abierto que se le puso enfrente?
// Devuelve { required, addressed, missing, unknown, rate }. `unknown` son ids
// que el modelo inventó (no estaban abiertos) — señal de que alucinó memoria.
export function auditCommitments(open = [], updates = []) {
  const ids = new Set((open || []).map((c) => c && c.id).filter(Boolean));
  const seen = new Set();
  const unknown = [];
  for (const u of (updates || [])) {
    if (ids.has(u.id)) seen.add(u.id);
    else unknown.push(u.id);
  }
  const missing = [...ids].filter((id) => !seen.has(id));
  return {
    required: ids.size,
    addressed: [...seen],
    missing,
    unknown,
    rate: ids.size ? +((seen.size / ids.size)).toFixed(3) : null,
  };
}

// ═══ 3. PRONUNCIAMIENTO POR POSICIÓN (T2 #9) ═══════════════════════

export const STANCES = new Set(['hold', 'trim', 'exit']);

// `positions_review` del modelo → [{ symbol, stance, reason }] normalizado.
// Tolerante igual que los compromisos: lo ilegible se descarta y la auditoría
// lo cuenta como posición NO pronunciada.
export function normalizePositionsReview(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const symbol = up(r.symbol || r.ticker);
    const stance = typeof r.stance === 'string' ? r.stance.trim().toLowerCase() : '';
    if (!symbol || seen.has(symbol) || !STANCES.has(stance)) continue;
    seen.add(symbol);
    out.push({ symbol, stance, reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 400) : null });
  }
  return out;
}

// ¿Se pronunció sobre CADA posición del libro? `required` son los símbolos que
// el PM tenía que cubrir (los holdings de la corrida). Devuelve además
// `time_stop_missing`: las posiciones VENCIDAS por time stop que ni así fueron
// nombradas — el incumplimiento que más importa medir (T2 #4).
export function auditPositionReview(requiredSymbols = [], review = [], meta = {}) {
  const required = [...new Set((requiredSymbols || []).map(up).filter(Boolean))];
  const bySym = new Map((review || []).map((r) => [r.symbol, r]));
  const missing = required.filter((s) => !bySym.has(s));
  const extra = [...bySym.keys()].filter((s) => !required.includes(s));
  const noReason = [...bySym.values()].filter((r) => !r.reason).map((r) => r.symbol);
  const timeStopMissing = missing.filter((s) => meta[s] && meta[s].time_stop && meta[s].time_stop.due);
  return {
    required: required.length,
    reviewed: [...bySym.keys()],
    missing,
    extra,
    without_reason: noReason,
    time_stop_missing: timeStopMissing,
    rate: required.length ? +((required.length - missing.length) / required.length).toFixed(3) : null,
  };
}
