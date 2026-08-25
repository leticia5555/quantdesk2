// ═══════════════════════════════════════════════════════════════
// ai-guard — anclaje temporal de la IA + guard anti-fechas alucinadas.
//
// BUG que motiva esto (jul 2026): el Institutional Insight hablaba de
// "this 2025 scenario" y "Q1 2024" como escenarios FUTUROS. El modelo no
// recibía la fecha actual y anclaba el análisis al presente de su
// entrenamiento; varios prompts del front además traían "April 2026"
// hardcodeado de cuando se escribieron.
//
// Tres piezas, todas centralizadas aquí (un solo lugar, no 26 ediciones):
//
//   dateDirective(now)            → texto para el system prompt: fecha de
//                                   HOY (server-side) + instrucción de no
//                                   proyectar hacia el pasado y de admitir
//                                   conocimiento limitado en vez de
//                                   inventar contexto macro.
//   staleProspectiveDates(text)   → guard barato de salida: años ANTERIORES
//                                   al actual usados en frases prospectivas
//                                   ("this 2025 scenario", "will ... in Q1
//                                   2024"). Las menciones históricas
//                                   legítimas ("in Q1 2024 revenue grew")
//                                   no se marcan.
//   guardedClaudeCall({...})      → llamada a Anthropic con la directiva
//                                   inyectada + guard: si la respuesta trae
//                                   fechas rotas reintenta UNA vez con
//                                   recordatorio; si reincide devuelve
//                                   stale:true para que el caller corte con
//                                   su fallback honesto.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { recordAiCall } from './usage.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function dateDirective(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  const label = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;
  return `\n\nTODAY'S DATE IS ${iso} (${label}). Anchor ALL analysis to this date. ` +
    `Do not project scenarios toward dates earlier than today — years before ${now.getUTCFullYear()} are the PAST, never "upcoming" or "this". ` +
    `If your knowledge of events close to this date is limited, say so explicitly instead of inventing recent macro context.`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

// ── relativeDayLabel: fecha ABSOLUTA → distancia en días YA CALCULADA ──
//
// BUG que motiva esto (ago 2026): al PM del Arena las noticias le llegaban con
// fecha absoluta + una instrucción de "calculá vos qué tan vieja es", y los
// earnings ni eso — solo `date`. Con la fecha suelta el modelo narró unos
// earnings a DOS DÍAS como "post-market today" (NVDA 8/26 escrito el 8/24) en
// el mismo párrafo donde fechaba bien las noticias, que sí traían contexto de
// antigüedad. La aritmética de calendario no se delega al LLM: se hace acá y
// viaja al prompt ya resuelta ("in 2 days (Wed Aug 26, AMC)").
//
// dateStr: 'YYYY-MM-DD'. `note` opcional se cuelga dentro del paréntesis (el
// AMC/BMO de un earnings). Todo en UTC — el mismo huso que dateDirective usa
// para decir qué día es hoy, así "today" significa lo mismo en ambos lados.
// El año solo aparece cuando difiere del actual (evita el "Jan 3" ambiguo de
// fin de año). Devuelve null si la fecha no parsea — el caller omite el campo,
// nunca inventa uno.
export function relativeDayLabel(dateStr, now = new Date(), note = null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!Number.isFinite(day)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diff = Math.round((day - today) / 86400000);
  const rel = diff === 0 ? 'today'
    : diff === 1 ? 'tomorrow'
      : diff === -1 ? 'yesterday'
        : diff > 0 ? `in ${diff} days`
          : `${-diff} days ago`;
  const d = new Date(day);
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
  const stamp = `${WEEKDAYS[d.getUTCDay()]} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
  return `${rel} (${stamp}${note ? ', ' + note : ''})`;
}

// Señales de orientación a futuro cerca de una mención de año. Deliberadamente
// moderada: mejor dejar pasar una frase ambigua que marcar todo el histórico
// legítimo de un análisis ("in Q1 2024, revenue grew 12%" NO debe marcarse).
const FUTURE_CUES = /\b(will|would|expects?|expecting|anticipat\w*|upcoming|coming|ahead|forecast\w*|project\w*|heading (in)?to|into|by (the )?end of|se espera|esperamos|proyecta\w*|pr[oó]xim\w*|de cara a|hacia)\b/i;

export function staleProspectiveDates(text, now = new Date()) {
  if (!text || typeof text !== 'string') return [];
  const nowYear = now.getUTCFullYear();
  const hits = [];
  const re = /\b20\d{2}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const year = +m[0];
    if (year >= nowYear) continue;
    const before = text.slice(Math.max(0, m.index - 70), m.index);
    const after = text.slice(m.index + 4, m.index + 34);
    const snippet = (before.slice(-40) + m[0] + after.slice(0, 20)).replace(/\s+/g, ' ').trim();
    // "this 2025 scenario" / "este 2024": un año pasado nunca es "this".
    if (/\b(this|este|esta)\s+((q[1-4]|h[12])\s+)?$/i.test(before)) { hits.push(snippet); continue; }
    if (FUTURE_CUES.test(before.slice(-70)) || FUTURE_CUES.test(after)) hits.push(snippet);
  }
  return [...new Set(hits)].slice(0, 5);
}

function extractText(data) {
  return ((data && data.content) || []).map((b) => (b && b.text) || '').join('').trim();
}

function retryReminder(hits, now) {
  const iso = now.toISOString().slice(0, 10);
  return `Your previous answer treated past dates as future scenarios (e.g. ${hits.map((h) => `"…${h}…"`).join(', ')}). ` +
    `REMINDER: today is ${iso}; any year before ${now.getUTCFullYear()} is the past. ` +
    `Rewrite your ENTIRE answer in the exact same required format, with correct temporal framing. ` +
    `If you lack knowledge of recent events, say so instead of fabricating context.`;
}

// Devuelve { status, data, retried?, stale?, hits? }.
//   - stale:true → el modelo reincidió tras el retry: el caller NO debe
//     publicar el texto; corta con su fallback honesto (status sugerido 502).
//   - guard:false → solo inyecta la fecha, sin escaneo de salida (p. ej.
//     scoring mecánico de titulares, donde los años viejos son legítimos).
async function runGuardedCall({ apiKey, payload, guard = true, now = new Date(), fetchImpl = fetch }) {
  const withDate = { ...payload, system: (payload.system || '') + dateDirective(now) };
  const call = (p) => fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(p),
  });

  let r = await call(withDate);
  let data = await r.json();
  if (!r.ok || !guard) return { status: r.status, data };

  const text = extractText(data);
  const hits = staleProspectiveDates(text, now);
  if (!hits.length) return { status: r.status, data };

  // Reintento único con recordatorio de fecha, mismo formato requerido.
  const retryPayload = {
    ...withDate,
    messages: [...withDate.messages,
      { role: 'assistant', content: text },
      { role: 'user', content: retryReminder(hits, now) }],
  };
  r = await call(retryPayload);
  data = await r.json();
  if (!r.ok) return { status: r.status, data };

  const hits2 = staleProspectiveDates(extractText(data), now);
  if (!hits2.length) return { status: r.status, data, retried: true };
  return { status: 502, stale: true, hits: hits2, data: null };
}

// ── Caché de respuesta en memoria (opt-in) ───────────────────────
// Muchas interacciones repiten la MISMA request (mismo ticker+idioma el
// mismo día, re-clicks, pestañas paralelas, visitantes cuasi-simultáneos con
// el paywall abierto). Sin caché, cada una es una llamada fresca a Anthropic.
//
// La clave incluye la fecha de HOY (dateDirective se ancla a ella), así que
// el caché rota solo cada día — es literalmente "por request+día". Solo se
// guardan éxitos (200, no-stale); jamás errores ni respuestas stale.
//
// Opt-in por caller (cache:true). Sin la opción, comportamiento idéntico al
// de antes: cero caché, cero cambios.
const RESP_CACHE = new Map(); // key → { at, result }
const RESP_CACHE_MAX = 500;
const DEFAULT_CACHE_TTL_MS = (() => {
  const n = Number(process.env.AI_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 3600e3; // 6h por defecto
})();

function cacheKey(payload, guard, now) {
  const iso = now.toISOString().slice(0, 10);
  return createHash('sha256')
    .update(JSON.stringify({ p: payload, guard, iso }))
    .digest('hex');
}

function cacheGet(key, ttlMs) {
  const hit = RESP_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) { RESP_CACHE.delete(key); return null; }
  return hit.result;
}

function cacheSet(key, result) {
  if (RESP_CACHE.size >= RESP_CACHE_MAX) {
    // Evicción FIFO simple: borra la entrada más vieja insertada.
    const oldest = RESP_CACHE.keys().next().value;
    if (oldest !== undefined) RESP_CACHE.delete(oldest);
  }
  RESP_CACHE.set(key, { at: Date.now(), result });
}

// Wrapper público: caché opcional + journaling del burn (siempre, best-effort).
// Firma compatible: los callers viejos (sin cache/tag) no cambian de conducta.
export async function guardedClaudeCall(opts) {
  const { payload, guard = true, now = new Date(), cache = false, cacheTtlMs } = opts;
  const model = payload && payload.model;
  const ttl = Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const key = cache ? cacheKey(payload, guard, now) : null;

  if (key) {
    const cached = cacheGet(key, ttl);
    if (cached) {
      // No se re-consulta a Anthropic: journalea el ahorro y devuelve copia.
      // recordAiCall nunca lanza (try/catch interno) y está auto-acotado a ≤2s.
      await recordAiCall({ model, cacheHit: true, now });
      return { ...cached, cached: true };
    }
  }

  const out = await runGuardedCall(opts);

  // Journaling del gasto — best-effort, auto-acotado, nunca rompe la respuesta.
  await recordAiCall({
    model,
    usage: out && out.data && out.data.usage,
    retried: !!(out && out.retried),
    stale: !!(out && out.stale),
    now,
  });

  // Solo se cachean éxitos reales (200, con data, no stale).
  if (key && out && out.status >= 200 && out.status < 300 && out.data && !out.stale) {
    cacheSet(key, { status: out.status, data: out.data, retried: out.retried });
  }
  return out;
}

// Hook de tests.
export function _resetRespCache() { RESP_CACHE.clear(); }
