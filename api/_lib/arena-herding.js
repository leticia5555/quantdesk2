// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-herding.js — B8: ANTI-HERDING y sus métricas.
//
// Siete modelos mirando el MISMO tablero pueden terminar con el mismo libro, y
// si eso pasa el experimento deja de medir modelos y pasa a medir el tablero.
// Dos intervenciones y tres métricas.
//
// ── LAS DOS INTERVENCIONES ───────────────────────────────────────────
//
// 1. COLA ALEATORIZADA. El orden de los top-30 cambia por agente. Suena menor y
//    no lo es: un modelo que lee una lista tiende a pesar más lo de arriba, así
//    que un orden común es una preferencia común disfrazada de coincidencia.
//
// 2. LENTE PRIMARIA ROTATIVA (momentum / catalizador / valor / reversión),
//    dicha en el prompt como "hoy mirá primero por…". No le prohíbe nada: le
//    cambia por dónde empieza.
//
// ── TODO ES DETERMINISTA, Y NO ES UN DETALLE ─────────────────────────
// La semilla es `hash(agent_id + run_id)` y la lente es
// `LENTES[(hash(agent) + día) % 4]`. Un `Math.random()` acá haría el journal
// IRREPRODUCIBLE: el post-mortem no podría reconstruir qué vio cada agente, y
// el replay —que existe justamente para eso— sería inútil. Determinista además
// garantiza que en 4 días cada agente pasó por las cuatro lentes.
//
// ── DÓNDE VIVE LA ALEATORIZACIÓN (D2: la caché gana) ─────────────────
// En la COLA NO CACHEADA, nunca en el prefijo. Si el orden del tablero cambiara
// por agente dentro del bloque cacheado, los siete tendrían prefijos distintos
// y la caché no serviría para nada. Por eso lo que se aleatoriza es una cola
// corta (≤2K tokens) que viaja del lado volátil, junto al libro y la lente.
//
// ── LA ADVERTENCIA HONESTA ───────────────────────────────────────────
// La lente rotativa es un CONFOUND DELIBERADO. Dos agentes con lentes distintas
// el mismo día NO son comparables ese día. Mide diversidad a costa de
// comparabilidad diaria; a lo largo de la temporada se promedia, pero hay que
// decirlo en el post-mortem en vez de dejar que alguien lo descubra.
//
// JS puro, sin I/O.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

export const LENTES = [
  { id: 'momentum', prompt: 'Today, look first through MOMENTUM: what is already moving, and whether the move has support (volume, breadth, a reason) or is just a gap that will close.' },
  { id: 'catalizador', prompt: 'Today, look first through CATALYSTS: what is about to happen — earnings, deals, rating changes — and what is already priced into the name before it happens.' },
  { id: 'valor', prompt: 'Today, look first through VALUE: what is cheap against its own history or its sector, and whether it is cheap for a reason you can name.' },
  { id: 'reversion', prompt: 'Today, look first through MEAN REVERSION: what has been punished beyond what the news justifies, and what has run beyond what the numbers support.' },
];

const hashNum = (s) => parseInt(createHash('sha256').update(String(s)).digest('hex').slice(0, 8), 16);

// Día del año, en horario del ESTE (el del mercado). Usar UTC haría que la
// lente cambiara a las 20:00 ET, o sea a mitad de la sesión.
export function dayIndex(now = new Date()) {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
}

// La lente de un agente HOY. Determinista y rotativa: en 4 días cada agente
// pasa por las cuatro.
export function lenteDelDia(agentId, now = new Date()) {
  const i = (hashNum(agentId) + dayIndex(now)) % LENTES.length;
  return LENTES[i];
}

// ── LA COLA ALEATORIZADA ─────────────────────────────────────────────
// Fisher-Yates con un PRNG sembrado. La semilla es `agent_id + run_id`: cambia
// por agente (que es el punto) y por corrida (para que un agente no vea siempre
// el mismo orden), y es REPRODUCIBLE dado el journal.
function mulberry32(a) {
  return function prng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleDeterministic(items, seed) {
  const prng = mulberry32(hashNum(seed));
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// La cola completa que viaja del lado NO cacheado. Se mide y se acota: si pasa
// del techo, se recorta — el presupuesto de la cola es lo que protege al
// prefijo cacheado de volverse irrelevante.
export const TAIL_TOKEN_CAP = Number(process.env.ARENA_TAIL_TOKEN_CAP) || 2000;
const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

export function buildTail({ agentId, runId, movers = [], now = new Date(), cap = TAIL_TOKEN_CAP }) {
  const lente = lenteDelDia(agentId, now);
  const orden = shuffleDeterministic(movers.map((m) => m.symbol || m), `${agentId}|${runId}`);
  const partes = [
    `YOUR LENS TODAY: ${lente.prompt}`,
    'This is where to START, not a restriction: if the board points somewhere else, go there and say so.',
    '',
    'TODAY\'S NAMES, in no particular order (the ordering is randomized per agent on purpose — it carries no ranking):',
    orden.join(' '),
  ];
  let text = partes.join('\n');
  let truncated = false;
  if (estimateTokens(text) > cap) {
    // Se recorta la LISTA, nunca la lente: la lente son 40 tokens y es la mitad
    // del mecanismo.
    const cabe = Math.max(10, Math.floor((cap * 4 - partes.slice(0, 4).join('\n').length) / 6));
    text = [...partes.slice(0, 4), orden.slice(0, cabe).join(' ') + ` …(${orden.length - cabe} más, truncado)`].join('\n');
    truncated = true;
  }
  return { text, lens: lente.id, order: orden, tokens_est: estimateTokens(text), truncated, cap };
}

// ── LAS MÉTRICAS DEL POST-MORTEM ─────────────────────────────────────
// `books` = { agentId: { TICKER: peso } }.

// % de libros que comparten el ticker más común.
export function sharedTopTicker(books) {
  const cuenta = new Map();
  const ids = Object.keys(books || {});
  for (const id of ids) for (const t of Object.keys(books[id] || {})) cuenta.set(t, (cuenta.get(t) || 0) + 1);
  if (!cuenta.size) return { ticker: null, books: 0, pct: 0 };
  let mejor = null, max = 0;
  // Desempate por ticker para que la métrica sea reproducible.
  for (const [t, n] of [...cuenta.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    if (n > max) { max = n; mejor = t; }
  }
  return { ticker: mejor, books: max, pct: ids.length ? +((max / ids.length) * 100).toFixed(1) : 0 };
}

// Solapamiento par a par: coseno entre los vectores de peso. Con portafolio
// objetivo esto deja de ser una aproximación y pasa a ser un número directo —
// es la ventaja de medir libros en vez de órdenes.
export function pairwiseOverlap(books) {
  const ids = Object.keys(books || {}).sort();
  const pares = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pares.push({ a: ids[i], b: ids[j], cosine: cosine(books[ids[i]], books[ids[j]]) });
    }
  }
  const vals = pares.map((p) => p.cosine).filter((v) => v != null);
  return {
    pairs: pares,
    mean: vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4) : null,
    max: vals.length ? +Math.max(...vals).toFixed(4) : null,
  };
}

function cosine(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = Number((a || {})[k]) || 0;
    const y = Number((b || {})[k]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return null;   // un libro vacío no se parece ni se diferencia
  return +(dot / (Math.sqrt(na) * Math.sqrt(nb))).toFixed(4);
}

// Posiciones que vinieron de una HERRAMIENTA vs del tablero. Es la métrica que
// dice si las herramientas sirvieron para algo o si el PM decide igual con lo
// que ya tenía enfrente.
export function toolVsBoardOrigin(weights, { toolSymbols = new Set(), boardSymbols = new Set() } = {}) {
  const out = { from_tool: [], from_board: [], from_neither: [] };
  for (const sym of Object.keys(weights || {})) {
    if (toolSymbols.has(sym)) out.from_tool.push(sym);
    else if (boardSymbols.has(sym)) out.from_board.push(sym);
    else out.from_neither.push(sym);
  }
  const total = Object.keys(weights || {}).length;
  return {
    ...out,
    pct_from_tool: total ? +((out.from_tool.length / total) * 100).toFixed(1) : 0,
    // Un nombre en NINGUNO de los dos es un pick sin anclar: el modelo lo trajo
    // de su memoria, no de los datos de hoy. No es necesariamente malo, pero es
    // exactamente lo que hay que poder contar.
    unanchored: out.from_neither.length,
  };
}
