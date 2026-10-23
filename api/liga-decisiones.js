// ═══════════════════════════════════════════════════════════════
// /api/liga/decisiones?agent=&desde= — cada orden LLENA de la liga en vivo,
// con su resultado a 1, 3 y 5 sesiones (vista `liga_decisiones`, definida y
// documentada en _lib/liga-decisiones.js).
//
// SOLO LECTURA. Lo único que escribe es la DEFINICIÓN de la vista
// (`create or replace view`, idempotente, una vez por lambda): no hay tabla
// nueva ni datos nuevos. Nada de esto viaja a ningún prompt.
//
//   agent  — opcional, un id del registro (claude, control, openai…).
//   desde  — opcional, YYYY-MM-DD: día del fill (hora del Este) desde.
// ═══════════════════════════════════════════════════════════════

import { sql } from './_lib/db.js';
import { agentById } from './_lib/arena-registry.js';
import { VISTA_DECISIONES, SQL_DECISIONES, filaDecision } from './_lib/liga-decisiones.js';

let vistaLista = false;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const q = req.query || {};
  const agent = String(q.agent || '').trim().toLowerCase() || null;
  const desde = String(q.desde || '').trim() || null;
  if (agent && !agentById(agent)) return res.status(400).json({ error: `agent desconocido: "${agent}".` });
  if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde tiene que ser YYYY-MM-DD.' });
  try {
    if (!vistaLista) { await sql(VISTA_DECISIONES); vistaLista = true; }
    const filas = (await sql(SQL_DECISIONES, [agent, desde])).map(filaDecision);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      agent, desde, n: filas.length,
      definiciones: 'sesión k = k-ésimo día con cierres en mercado_precios_us DESPUÉS del día del fill (hora del Este); resultado = (cierre_k − precio de ejecución) / precio de ejecución, en %, con signo según el lado (una venta gana si baja); cierre sin ajustar. null = sin cierre guardado para ese símbolo o sesión todavía no ocurrida — nunca 0.',
      decisiones: filas,
    });
  } catch (err) {
    return res.status(500).json({ error: 'liga-decisiones: ' + ((err && err.message) || 'unknown') });
  }
}
