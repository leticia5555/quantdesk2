// ═══════════════════════════════════════════════════════════════
// /api/agents — CRUD de agentes de paper trading.
//
//   GET    ?uid=u123                     → lista de agentes del usuario
//   GET    ?uid=u123&id=a456             → detalle: agente + edges +
//                                          posiciones + trades + equity
//   POST   { uid, email?, name, edge_ids:[...], edges:[...] }
//          → crea agente. `edges` es el payload COMPLETO de la biblioteca
//            localStorage del usuario: en el primer agente (y en cada
//            create) se migran/upsertean a la DB con el campo `source`
//            marcando la procedencia ('localStorage:<source original>').
//            localStorage queda como fallback de solo lectura en el front.
//   DELETE ?uid=u123&id=a456             → elimina el agente (cascade)
//
// IDENTIDAD: uid anónimo generado en el navegador (localStorage), email
// opcional (el del Checkout de Stripe si existe) — mismo modelo de
// identidad mínima que el resto del producto.
//
// LÍMITE: 3 agentes free / ilimitados Pro. La verificación Pro es la misma
// del paywall: email → suscripción activa en Stripe, consultada en vivo.
//
// ENV VARS: DATABASE_URL · STRIPE_SECRET_KEY (para el check Pro; sin ella
// todos cuentan como free, degrada con gracia)
// ═══════════════════════════════════════════════════════════════

import { sql, sqlBatch, ensureSchema } from './_lib/db.js';
import { ASSUMPTIONS } from './_lib/sim.js';

const FREE_AGENT_LIMIT = 3;
const PRO_STATUSES = ['active', 'trialing', 'past_due'];

// Mismo check que /api/stripe-status, compactado: ¿este email es Pro?
async function isProEmail(email) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !email || !email.includes('@')) return false;
  try {
    const h = { Authorization: `Bearer ${key}` };
    const cr = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, { headers: h });
    const { data: customers = [] } = await cr.json();
    for (const c of customers) {
      const sr = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(c.id)}&status=all&limit=10`, { headers: h });
      const { data: subs = [] } = await sr.json();
      if (subs.some((s) => PRO_STATUSES.includes(s.status))) return true;
    }
  } catch (e) { /* Stripe caído o sin configurar: free */ }
  return false;
}

// Procedencia de la migración sin doble prefijo en re-migraciones.
function migrationSource(original) {
  const src = original || 'quantdesk-app-v0';
  return src.startsWith('localStorage:') ? src : 'localStorage:' + src;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureSchema();
    const q = req.query || {};
    const uid = ((req.method === 'POST' ? (req.body || {}).uid : q.uid) || '').toString().trim();
    if (!uid) return res.status(400).json({ error: 'Falta uid.' });

    // ── DETALLE ──
    if (req.method === 'GET' && q.id) {
      const agents = await sql('select * from agents where id = $1 and user_id = $2', [q.id, uid]);
      if (!agents.length) return res.status(404).json({ error: 'Agente no encontrado.' });
      const [edges, open, closed, equity] = await Promise.all([
        sql(`select e.* from edges e join agent_edges ae on ae.edge_id = e.id where ae.agent_id = $1`, [q.id]),
        sql(`select * from positions where agent_id = $1 and status = 'open' order by entry_date`, [q.id]),
        sql(`select * from positions where agent_id = $1 and status = 'closed' order by exit_date desc limit 200`, [q.id]),
        sql(`select date, equity from equity_history where agent_id = $1 order by date`, [q.id]),
      ]);
      return res.status(200).json({ agent: agents[0], edges, open_positions: open, trades: closed, equity_history: equity, assumptions: ASSUMPTIONS });
    }

    // ── LISTA (+ re-adopción por email verificado en Stripe) ──
    if (req.method === 'GET') {
      // Si el uid anónimo cambió (otro navegador/perfil, site data borrada),
      // los agentes y edges creados bajo el uid ANTERIOR quedan huérfanos en
      // la DB. Con ?email= y una suscripción ACTIVA en Stripe para ese email,
      // se re-parentan al uid actual. Mismo modelo de identidad honor-based
      // del paywall v1 (el email no se prueba con login — deliberado, sin
      // sistema de cuentas); el gate de Stripe evita adopciones arbitrarias
      // de emails no-Pro. Idempotente: sin huérfanos, no hace nada.
      const adoptEmail = ((q.email || '').toString().trim().toLowerCase());
      if (adoptEmail && adoptEmail.includes('@') && await isProEmail(adoptEmail)) {
        const owners = await sql(
          `select id from users where lower(email) = $1 and id <> $2`, [adoptEmail, uid]);
        if (owners.length) {
          const ids = `{${owners.map((o) => o.id).join(',')}}`;
          await sqlBatch([
            [`insert into users (id, email) values ($1, $2)
              on conflict (id) do update set email = excluded.email`, [uid, adoptEmail]],
            [`update agents set user_id = $1 where user_id = any($2::text[])`, [uid, ids]],
            [`update edges set user_id = $1 where user_id = any($2::text[])`, [uid, ids]],
          ]);
        }
      }

      const agents = await sql(
        `select a.*, (select count(*) from agent_edges ae where ae.agent_id = a.id) as n_edges
         from agents a where a.user_id = $1 order by a.created_at desc`, [uid]);
      return res.status(200).json({ agents, limit_free: FREE_AGENT_LIMIT, assumptions: ASSUMPTIONS });
    }

    // ── ELIMINAR ──
    if (req.method === 'DELETE') {
      if (!q.id) return res.status(400).json({ error: 'Falta id.' });
      await sql('delete from agents where id = $1 and user_id = $2', [q.id, uid]);
      return res.status(200).json({ deleted: q.id });
    }

    // ── CREAR (+ migración de edges) ──
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no soportado.' });
    const body = req.body || {};
    const name = (body.name || '').toString().trim().slice(0, 40);
    const email = (body.email || '').toString().trim().toLowerCase() || null;
    const edgeIds = Array.isArray(body.edge_ids) ? body.edge_ids.map(String) : [];
    const libEdges = Array.isArray(body.edges) ? body.edges : [];
    if (!name) return res.status(400).json({ error: 'El agente necesita nombre.' });
    if (!edgeIds.length) return res.status(400).json({ error: 'Asigna al menos un edge de tu biblioteca.' });

    // usuario + migración de la biblioteca completa (upsert idempotente)
    const queries = [[
      `insert into users (id, email) values ($1, $2)
       on conflict (id) do update set email = coalesce(excluded.email, users.email)`, [uid, email]]];
    for (const e of libEdges) {
      if (!e || !e.id || !e.engine || !e.config) continue;
      queries.push([
        `insert into edges (id, user_id, edge_schema_version, engine, config, verdict, metrics, verdict_history, source, notes, created_at, validated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do update set
           verdict = excluded.verdict, metrics = excluded.metrics,
           verdict_history = excluded.verdict_history, validated_at = excluded.validated_at`,
        [e.id, uid, e.edge_schema_version || 1, e.engine, JSON.stringify(e.config),
         e.verdict || null, JSON.stringify(e.metrics || null), JSON.stringify(e.verdict_history || []),
         migrationSource(e.source), e.notes || null, e.created_at || null, e.validated_at || null]]);
    }
    await sqlBatch(queries);

    // límite free (server-side, misma verificación Stripe del paywall)
    const [{ n }] = await sql('select count(*)::int as n from agents where user_id = $1', [uid]);
    if (n >= FREE_AGENT_LIMIT && !(await isProEmail(email))) {
      return res.status(402).json({
        error: `${FREE_AGENT_LIMIT} agentes es el límite free — Pro tiene ilimitados.`,
        limit: FREE_AGENT_LIMIT, upgrade: true,
      });
    }

    // valida que los edges asignados existan ya en la DB
    const found = await sql(
      `select id from edges where user_id = $1 and id = any($2::text[])`, [uid, `{${edgeIds.join(',')}}`]);
    if (found.length !== edgeIds.length) {
      return res.status(400).json({ error: 'Algún edge asignado no existe en tu biblioteca migrada.' });
    }

    const id = newId('a');
    const create = [[
      `insert into agents (id, user_id, name, capital_start, cash, equity, equity_peak)
       values ($1,$2,$3,$4,$4,$4,$4)`, [id, uid, name, ASSUMPTIONS.capital_start]]];
    for (const eid of edgeIds) {
      create.push([`insert into agent_edges (agent_id, edge_id) values ($1,$2) on conflict do nothing`, [id, eid]]);
    }
    await sqlBatch(create);

    const [agent] = await sql('select * from agents where id = $1', [id]);
    return res.status(201).json({ agent, migrated_edges: libEdges.length, assumptions: ASSUMPTIONS });
  } catch (err) {
    return res.status(500).json({ error: 'agents: ' + (err && err.message ? err.message : 'unknown') });
  }
}

export { isProEmail, migrationSource, FREE_AGENT_LIMIT };
