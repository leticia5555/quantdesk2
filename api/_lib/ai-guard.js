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
export async function guardedClaudeCall({ apiKey, payload, guard = true, now = new Date(), fetchImpl = fetch }) {
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
