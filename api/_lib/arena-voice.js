// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-voice.js — el TITULAR de una línea de cada agente.
//
// Cada corrida, cada agente publica UN titular en español con la voz de su
// arquetipo (fijo por modelo, en el registry; el control es "el escéptico que
// no cree en nadie"). Es material de la liga: lo que se lee de un vistazo en el
// leaderboard y lo que se cita en un video, sin tener que leer seis oraciones
// de tesis en inglés.
//
// ── EL CANDADO QUE DEFINE ESTE ARCHIVO ───────────────────────────────
// El arquetipo **JAMÁS** entra al prompt que DECIDE. El titular se genera en
// una llamada APARTE, POSTERIOR, que recibe el plan y las órdenes YA decididas
// y solo las narra. El motivo no es estético:
//
//   `claude` y `control` son el MISMO modelo con el MISMO prompt y distinta
//   cuenta. Ese prompt byte-idéntico es lo único que hace del control un piso
//   de ruido válido (decisión #5 del scope): sin él, ningún delta entre
//   modelos significa nada, porque dos corridas del mismo modelo ya divergen
//   solas por el orden de los fills. Meter "eres el escéptico" en el DIVE del
//   control lo convertiría en otro agente y borraría la única medición que
//   dice cuánto del delta es ruido.
//
// Por eso: el DIVE decide sin saber que existe un arquetipo, y esta capa narra
// sin poder cambiar una orden. `tests/arena-voice.test.mjs` lo blinda.
//
// El titular tampoco se re-inyecta en la corrida siguiente: vive en
// `context.headline`, no en la columna `plan`, que es la que alimenta el
// "PREVIOUS PLAN" del prompt. Narrar no puede contaminar el siguiente juicio.
//
// BEST-EFFORT: si la llamada falla, el titular es null y la corrida sigue
// exactamente igual. Nunca frena una orden ni cambia un status.
//
// ADDENDUM (2026-09-14): el titular recibe también la decisión por posición ya
// decidida — condición de invalidación y confianza (0–1). Sigue siendo material
// PARA NARRAR: esta capa no puede cambiar una orden ni completar un campo que
// el PM dejó vacío (eso lo resuelve el guard, descartando la orden).
//
// ENV VARS: ARENA_HEADLINES (opc; '0' lo apaga sin tocar código).
// ═══════════════════════════════════════════════════════════════

// Tope duro: un titular es una línea, no un párrafo. 140 caracteres entran
// completos en una card del leaderboard y en un subtítulo de video.
export const HEADLINE_MAX = 140;

// Apagable por env (coste, o si un proveedor se pone caro). Default: encendido.
export function headlinesEnabled() {
  return process.env.ARENA_HEADLINES !== '0';
}

// ── prompts ──────────────────────────────────────────────────────────
// El system lleva SOLO la voz. No lleva reglas de trading, ni el buffet, ni el
// libro: este modelo no decide nada, y no debe poder.
export function buildHeadlineSystemPrompt(agent) {
  const a = (agent && agent.archetype) || { name: 'el analista', voice: 'Neutral y directo.' };
  return `Eres ${agent && agent.name ? agent.name : 'un agente'}, gestor de cartera en QuantDesk Arena — un experimento público de trading en papel donde varios modelos compiten con su propio libro.

TU VOZ: ${a.name}. ${a.voice}

Tu único trabajo aquí es escribir el TITULAR de tu corrida de hoy: UNA línea, en ESPAÑOL, con tu voz, sobre la decisión que ya tomaste. No estás decidiendo nada — la decisión ya está tomada y te la paso abajo.

REGLAS DEL TITULAR:
- UNA sola línea, máximo ${HEADLINE_MAX} caracteres. Sin comillas, sin markdown, sin emojis, sin hashtags.
- En español. Los tickers van como son (NVDA, AAPL).
- Solo puedes usar los hechos y números que te doy. NO inventes cifras, precios, porcentajes ni noticias, y no anuncies una operación que no esté en la lista.
- Si hoy no operaste, el titular es sobre por qué no. "No hice nada" dicho con tu voz es un titular perfectamente válido.
- Abajo van tus decisiones por posición con lo que declaraste hoy: tu CONDICIÓN DE INVALIDACIÓN (qué te haría vender) y tu CONFIANZA (0 a 1). Son tuyas y son material de titular — citarlas es de las cosas más honestas que puedes decir. Cítalas tal como están: no redondees la confianza a tu favor ni suavices la condición.
- Nada de consejos de inversión ni promesas de rendimiento.

Responde SOLO con el titular. Nada más: ni explicación, ni JSON, ni prefijo.`;
}

// El user prompt es un resumen COMPACTO y ya resuelto de lo que pasó. No se le
// manda el buffet ni el deep dive: narrar no necesita el contexto de decidir, y
// mandárselo sería pagar tokens por tentar al modelo a inventar una tesis nueva.
export function buildHeadlineUserPrompt({ plan, actions = [], decisions = [], equity = null, positions = null, breakerStage = null } = {}) {
  const label = (a) => {
    const base = `${a.side === 'buy' ? 'COMPRA' : 'VENTA'} ${a.symbol}${a.qty ? ' ×' + a.qty : ''}`;
    if (a.result === 'approved') return `${base} — ejecutada @ ${a.limit_price}`;
    if (a.result === 'discarded') return `${base} — DESCARTADA por el guard: ${a.reason || 'sin razón'}`;
    if (a.result === 'submit_failed') return `${base} — falló al enviarse`;
    return base;
  };
  const lines = (actions || []).slice(0, 10).map(label);
  // ── ADDENDUM 2026-09-14: la decisión por posición llega al titular ──
  // `invalidation_condition` y `confidence` son lo más citable que produce una
  // corrida sin órdenes ("sostengo NVDA con 0.6 y vendo si pierde los 140"
  // es un titular; "holdeo" no lo es). Llegan YA normalizados desde
  // _lib/arena-memory.js: acá no se recalcula nada, solo se rinden. Un hueco
  // se dice como hueco — jamás se rellena con una confianza inventada.
  const decisionLine = (d) => [
    `${d.symbol} — ${d.stance}`,
    d.confidence != null ? `confianza ${d.confidence}` : 'sin confianza declarada',
    d.invalidation_condition ? `vendes si: ${String(d.invalidation_condition).slice(0, 200)}` : 'sin condición de venta declarada',
  ].join(' · ');
  const decisionLines = (decisions || []).filter((d) => d && d.symbol).slice(0, 10).map(decisionLine);
  return [
    'TU PLAN DE HOY (lo escribiste tú, en inglés; el titular va en español):',
    String(plan || '(sin plan)').slice(0, 1200),
    '',
    'LO QUE REALMENTE PASÓ CON TUS ÓRDENES:',
    lines.length ? lines.join('\n') : 'Ninguna orden: hoy no operaste.',
    ...(decisionLines.length
      ? ['', 'TUS DECISIONES POR POSICIÓN DE HOY (con tu condición de venta y tu confianza):', decisionLines.join('\n')]
      : []),
    '',
    'TU LIBRO:',
    [
      equity != null ? `equity ${Math.round(equity)}` : null,
      positions != null ? `${positions} posición(es)` : null,
      breakerStage && breakerStage !== 'none' ? `el circuit breaker está en etapa ${breakerStage}` : null,
    ].filter(Boolean).join(' · ') || 'sin datos de cuenta',
    '',
    `Escribe tu titular. UNA línea, español, máximo ${HEADLINE_MAX} caracteres, con tu voz.`,
  ].join('\n');
}

// ── normalización (determinista) ─────────────────────────────────────
// El modelo a veces devuelve el titular entre comillas, con un "Titular:"
// delante, o con dos líneas. Eso se limpia acá — no es "corregirle la decisión"
// (no decidió nada), es des-serializar una línea de texto.
// Devuelve null si no queda nada utilizable: hueco honesto, no un titular vacío.
export function normalizeHeadline(raw, max = HEADLINE_MAX) {
  if (!raw || typeof raw !== 'string') return null;
  let t = raw.trim();
  // Fences de markdown por si acaso.
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  // Primera línea NO vacía (si mandó varias, la primera es el titular).
  t = (t.split('\n').map((l) => l.trim()).find(Boolean) || '').trim();
  // Prefijo tipo "Titular:" / "Headline:".
  t = t.replace(/^(titular|headline|título|titulo)\s*[:\-–—]\s*/i, '').trim();
  // Comillas envolventes (rectas o tipográficas).
  t = t.replace(/^["'“”«‘’](.*)["'“”»‘’]$/s, '$1').trim();
  // Viñetas o numeración de lista.
  t = t.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
  if (!t) return null;
  if (t.length > max) {
    // Corte en la última frontera de palabra + elipsis, para no partir un ticker.
    const cut = t.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
  }
  return t;
}

// ── generación (best-effort) ─────────────────────────────────────────
// `callLLM` se inyecta (el dispatch de proveedor vive en _lib/arena-model.js;
// pasarlo por parámetro deja este módulo sin I/O propio y testeable sin red).
// Devuelve { text, archetype, model, chars } · null si está apagado, si el
// agente no tiene arquetipo, o si la llamada no produjo nada usable.
export async function generateHeadline({ agent, plan, actions, decisions, equity, positions, breakerStage, callLLM, now = new Date() }) {
  if (!headlinesEnabled() || !agent || !agent.archetype || typeof callLLM !== 'function') return null;
  const system = buildHeadlineSystemPrompt(agent);
  const user = buildHeadlineUserPrompt({ plan, actions, decisions, equity, positions, breakerStage });
  try {
    // 200 tokens: una línea sobra. Si el modelo se pasa, normalizeHeadline corta.
    const res = await callLLM({ agent, system, messages: [{ role: 'user', content: user }], maxTokens: 200, now });
    if (!res || res.status !== 200 || !res.data) return null;
    const text = normalizeHeadline((res.data.content || []).map((b) => b.text || '').join(''));
    if (!text) return null;
    return { text, archetype: agent.archetype.name, model: agent.model, chars: text.length };
  } catch (e) {
    return null; // narrar nunca puede tumbar una corrida
  }
}
