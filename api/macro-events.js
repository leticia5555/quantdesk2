// ═══════════════════════════════════════════════════════════════
// /api/macro-events — calendario macro CURADO (tabla Neon `macro_events`).
//
// Decisión de producto: NADA de scraping frágil. Lety carga a mano ~8
// eventos/mes (Fed, CPI, jobs, PIB, subastas, discursos) en 5 min desde el
// admin gated (`/admin-macro.html`). Los earnings de mega-caps NO viven aquí:
// se automatizan desde el calendario de Finnhub (`/api/earnings?mega=1`). El
// frontend de `/hoy` mergea ambas fuentes en una sola línea de tiempo.
//
//   GET                      → { events: [...] } — próximos (público, cacheado).
//                              ?all=1 incluye pasados recientes (para el admin).
//   POST  {event_date,title,…} → agrega un evento          (gated)
//   DELETE ?id=<id>            → borra un evento            (gated)
//
// GATING de escritura: header `Authorization: Bearer <ADMIN_SECRET>`
//   (fallback a CRON_SECRET). Sin ninguno de los dos → escritura RECHAZADA
//   (fail closed: nunca se deja la tabla abierta a internet). La lectura GET
//   es pública siempre.
//
// ENV VARS: DATABASE_URL · ADMIN_SECRET (o CRON_SECRET como fallback)
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { sql, ensureSchema } from './_lib/db.js';

const IMPORTANCE = new Set(['high', 'med', 'low']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// El secret de escritura. Fail closed: si no hay secret configurado, NO se
// permite mutar (mejor un admin inutilizable que una tabla abierta).
function adminSecret() {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;
}
function authorized(req) {
  const secret = adminSecret();
  if (!secret) return false;
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

function readBody(req) {
  // Vercel ya parsea JSON en req.body cuando el content-type es json; si viene
  // como string (o crudo), se intenta parsear. Nunca lanza.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureSchema();

    // ── GET: lectura pública ──────────────────────────────────────
    if (req.method === 'GET') {
      const all = String((req.query && req.query.all) || '') === '1';
      // Público: solo próximos (desde hoy). Admin (?all=1): incluye ~7 días
      // pasados para poder editar/borrar lo recién cargado.
      const rows = all
        ? await sql(
            `select id, to_char(event_date,'YYYY-MM-DD') as event_date, title, category, importance, note
             from macro_events
             where event_date >= (current_date - 7)
             order by event_date asc, importance desc, title asc
             limit 200`)
        : await sql(
            `select id, to_char(event_date,'YYYY-MM-DD') as event_date, title, category, importance, note
             from macro_events
             where event_date >= current_date
             order by event_date asc, importance desc, title asc
             limit 60`);
      // El calendario cambia poco: cache CDN corto con revalidación.
      if (!all) res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
      return res.status(200).json({ events: rows, count: rows.length });
    }

    // ── mutaciones: gated ─────────────────────────────────────────
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!authorized(req)) {
        const hint = adminSecret() ? 'Secret inválido.' : 'Falta ADMIN_SECRET/CRON_SECRET en el server.';
        return res.status(401).json({ error: 'No autorizado. ' + hint });
      }

      if (req.method === 'DELETE') {
        const id = (req.query && req.query.id) || '';
        if (!id) return res.status(400).json({ error: 'Falta ?id=' });
        const del = await sql(`delete from macro_events where id = $1 returning id`, [String(id)]);
        return res.status(200).json({ deleted: del.length, id: String(id) });
      }

      // POST: agregar evento
      const body = readBody(req) || {};
      const eventDate = String(body.event_date || '').trim();
      const title = String(body.title || '').trim();
      const category = body.category ? String(body.category).trim().slice(0, 40) : null;
      const importance = IMPORTANCE.has(body.importance) ? body.importance : 'med';
      const note = body.note ? String(body.note).trim().slice(0, 280) : null;

      if (!DATE_RE.test(eventDate)) return res.status(400).json({ error: 'event_date inválido (usa YYYY-MM-DD).' });
      if (!title) return res.status(400).json({ error: 'Falta title.' });
      if (title.length > 120) return res.status(400).json({ error: 'title muy largo (máx 120).' });

      const id = 'me_' + randomUUID();
      await sql(
        `insert into macro_events (id, event_date, title, category, importance, note)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, eventDate, title, category, importance, note]);
      return res.status(200).json({ ok: true, id, event_date: eventDate, title });
    }

    return res.status(405).json({ error: 'Método no soportado.' });
  } catch (err) {
    return res.status(500).json({ error: 'macro-events: ' + (err && err.message ? err.message : 'unknown') });
  }
}
