import { ANTHROPIC_MODEL } from './_lib/model.js';
import { guardedClaudeCall } from './_lib/ai-guard.js';
import { rateLimit } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!rateLimit(req, res)) return; // tope por IP: letal para bots, invisible para humanos
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  try {
    // El modelo lo decide el SERVER (env ANTHROPIC_MODEL o default en
    // _lib/model.js). body.model se ignora a propósito: clientes con
    // HTML cacheado viejo mandaban un modelo ya retirado y tumbaban
    // toda la IA (jul 2026). guardedClaudeCall además inyecta la fecha de
    // HOY en el system prompt y corta respuestas que proyecten años
    // pasados como escenarios futuros (1 retry, luego stale).
    const out = await guardedClaudeCall({
      apiKey,
      // cache: dedupe de requests idénticas (mismo ticker+día+precio, re-clicks,
      // pestañas paralelas, visitantes cuasi-simultáneos). Clave anclada a la
      // fecha de HOY → rota sola cada día. Baja el burn de SMART $ y del resto
      // de paneles que pasan por aquí sin tocar su lógica.
      cache: true,
      payload: {
        model: ANTHROPIC_MODEL,
        max_tokens: body.max_tokens || 1000,
        ...(body.system ? { system: body.system } : {}),
        messages: body.messages,
      },
    });
    if (out.stale) {
      // 502 → el front (qdAI/qdFetchJSON) lo trata como IA caída y muestra
      // su fallback honesto en vez de publicar análisis temporalmente roto.
      return res.status(502).json({ error: 'ai_stale_dates', detail: out.hits });
    }
    return res.status(out.status).json(out.data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
