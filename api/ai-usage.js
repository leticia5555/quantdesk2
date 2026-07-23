// ═══════════════════════════════════════════════════════════════
// /api/ai-usage — monitor del burn diario de IA (ask del diagnóstico).
//
//   GET /api/ai-usage            → últimos 7 días
//   GET /api/ai-usage?days=30    → últimos 30 días (1–90)
//
// Devuelve el agregado por (día, modelo) que guardó _lib/usage.js en cada
// llamada a Anthropic, más un costo ESTIMADO en USD con la tabla de precios
// vigente. Sirve para dos cosas:
//   1. Ver el gasto diario de un vistazo, de aquí en adelante.
//   2. DELATAR si el modelo servido no es haiku: si aparece una fila cuyo
//      modelo es de la familia opus/sonnet, el ANTHROPIC_MODEL de Vercel
//      quedó apuntando al modelo caro — 5–25× el costo de haiku.
//
// Gate: si CRON_SECRET está seteado, exige Authorization: Bearer <secret>
// (mismo patrón que arena-run). Solo expone conteos agregados, sin secretos.
//
// ENV VARS: DATABASE_URL (para el journal) · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════

import { readDailyUsage } from './_lib/usage.js';

// Precios por millón de tokens (USD), catálogo vigente jul 2026 (input/output).
// Se indexa por SUFIJO de familia (sin el prefijo del proveedor) a propósito:
// así este archivo no re-hardcodea un ID de modelo completo — el ID de
// inferencia vive SOLO en _lib/model.js (blindaje del test claude-model).
// El modelo servido llega como '<proveedor>-haiku-4-5', etc.; se hace match
// por endsWith. Suffix no listado → costo null (se marca no priced).
const PRICES = {
  'haiku-4-5': { in: 1, out: 5 },
  'sonnet-4-6': { in: 3, out: 15 },
  'sonnet-5': { in: 3, out: 15 },
  'opus-4-6': { in: 5, out: 25 },
  'opus-4-7': { in: 5, out: 25 },
  'opus-4-8': { in: 5, out: 25 },
};

function priceFor(model) {
  if (!model) return null;
  const key = Object.keys(PRICES).find((k) => model.endsWith(k));
  return key ? PRICES[key] : null;
}

// El único modelo esperado es haiku; cualquier otro es una alarma de costo.
function isHaiku(model) { return !!model && model.indexOf('haiku') !== -1; }

function estCostUSD(model, inTok, outTok) {
  const p = priceFor(model);
  if (!p) return null;
  return +(((inTok || 0) / 1e6) * p.in + ((outTok || 0) / 1e6) * p.out).toFixed(4);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const days = Math.max(1, Math.min(90, Number((req.query && req.query.days) || 7) || 7));

  try {
    const { source, rows } = await readDailyUsage(days);

    const byDay = {};
    const totals = { calls: 0, input_tokens: 0, output_tokens: 0, retries: 0, cache_hits: 0, est_cost_usd: 0 };
    const nonHaiku = new Set();

    for (const r of rows) {
      const cost = estCostUSD(r.model, r.input_tokens, r.output_tokens);
      const row = {
        model: r.model,
        calls: Number(r.calls) || 0,
        input_tokens: Number(r.input_tokens) || 0,
        output_tokens: Number(r.output_tokens) || 0,
        retries: Number(r.retries) || 0,
        cache_hits: Number(r.cache_hits) || 0,
        est_cost_usd: cost,
        priced: cost !== null,
      };
      if (r.model && !isHaiku(r.model)) nonHaiku.add(r.model);
      (byDay[r.day] = byDay[r.day] || { day: r.day, models: [], est_cost_usd: 0 }).models.push(row);
      byDay[r.day].est_cost_usd = +(byDay[r.day].est_cost_usd + (cost || 0)).toFixed(4);
      totals.calls += row.calls;
      totals.input_tokens += row.input_tokens;
      totals.output_tokens += row.output_tokens;
      totals.retries += row.retries;
      totals.cache_hits += row.cache_hits;
      totals.est_cost_usd = +(totals.est_cost_usd + (cost || 0)).toFixed(4);
    }

    return res.status(200).json({
      source,               // 'db' | 'memory' | 'db_unavailable_memory_fallback'
      days,
      totals,
      // Bandera fuerte: si esto no está vacío, el modelo servido NO es haiku.
      non_haiku_models: [...nonHaiku],
      warning: nonHaiku.size
        ? `Modelos NO-haiku detectados (${[...nonHaiku].join(', ')}): revisa ANTHROPIC_MODEL en Vercel — cuesta 5–25× más que haiku.`
        : null,
      days_detail: Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day)),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'ai-usage: ' + (err && err.message ? err.message : 'unknown') });
  }
}
