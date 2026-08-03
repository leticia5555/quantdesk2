// ═══════════════════════════════════════════════════════════════
// /api/agents-run — el tick diario de los agentes de paper trading.
//
//   GET   → CRON de Vercel (ver vercel.json: días hábiles 22:30 UTC,
//           después del cierre de NYSE). Procesa TODOS los agentes vivos.
//           Si CRON_SECRET está configurado, exige Authorization: Bearer.
//   POST  { uid } → catch-up al abrir la app: procesa los agentes vivos de
//           ese usuario si el cron no corrió (o el usuario llevaba días
//           sin entrar). Idempotente: cada agente solo avanza fechas
//           ESTRICTAMENTE posteriores a su last_run_date, así que cron y
//           catch-up pueden pisarse sin duplicar nada.
//
// Por agente: carga edges + posiciones abiertas, baja las series diarias
// (una vez por símbolo por request), corre el motor (_lib/sim.js) y
// persiste: agente (equity/peak/cash/last_run_date/status), posiciones
// (upsert por id) y equity_history (upsert por agente+fecha).
//
// ENV VARS: DATABASE_URL · CRON_SECRET (opcional)
// ═══════════════════════════════════════════════════════════════

import { sql, sqlBatch, ensureSchema } from './_lib/db.js';
import { fetchDailySeries, completedSlice, runAgent, ASSUMPTIONS } from './_lib/sim.js';
import { beat } from './_lib/heartbeat.js';

// Símbolos que usa un edge (1 para señales, 2 para pares).
function edgeSymbols(edge) {
  const c = edge.config || {};
  return edge.engine === 'pairs' ? [c.x, c.y] : [c.ticker];
}

async function processAgents(agents) {
  const seriesCache = new Map(); // símbolo → serie (compartida entre agentes)
  const now = new Date();
  const summary = { agents_processed: 0, agents_died: 0, days: 0, opened: 0, closed: 0, errors: [] };

  for (const agent of agents) {
    try {
      const edges = await sql(
        `select e.* from edges e join agent_edges ae on ae.edge_id = e.id where ae.agent_id = $1`, [agent.id]);
      const openPositions = await sql(
        `select * from positions where agent_id = $1 and status = 'open'`, [agent.id]);

      const symbols = [...new Set(edges.flatMap(edgeSymbols).filter(Boolean))];
      const seriesBySymbol = {};
      for (const s of symbols) {
        if (!seriesCache.has(s)) {
          const raw = await fetchDailySeries(s, '2y');
          seriesCache.set(s, raw ? completedSlice(raw, now) : null);
        }
        if (seriesCache.get(s)) seriesBySymbol[s] = seriesCache.get(s);
      }

      const events = runAgent(agent, edges, openPositions, seriesBySymbol);
      if (!events.equityRows.length && !events.opened.length && !events.closed.length) continue;

      const queries = [];
      queries.push([
        `update agents set cash=$2, equity=$3, equity_peak=$4, last_run_date=$5,
           status=$6, died_at=coalesce(died_at, $7) where id=$1`,
        [agent.id, agent.cash, agent.equity, agent.equity_peak, agent.last_run_date,
         events.died ? 'dead' : agent.status, events.died ? (events.died_on + 'T22:00:00Z') : null]]);

      // upsert de TODAS las posiciones tocadas (nuevas, cerradas, y las
      // abiertas nuevas que siguen abiertas)
      const touched = new Map();
      for (const p of [...events.opened, ...events.closed, ...events.stillOpen]) touched.set(p.id, p);
      for (const p of touched.values()) {
        queries.push([
          `insert into positions (id, agent_id, edge_id, symbol, direction, legs, qty, entry_price, entry_date, stop_price, notional, status, exit_price, exit_date, exit_reason, pnl)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           on conflict (id) do update set
             status = excluded.status, legs = excluded.legs, exit_price = excluded.exit_price,
             exit_date = excluded.exit_date, exit_reason = excluded.exit_reason, pnl = excluded.pnl`,
          [p.id, p.agent_id, p.edge_id, p.symbol, p.direction,
           p.legs ? JSON.stringify(p.legs) : null, p.qty, p.entry_price, p.entry_date,
           p.stop_price, p.notional, p.status, p.exit_price ?? null, p.exit_date ?? null,
           p.exit_reason ?? null, p.pnl ?? null]]);
      }
      for (const row of events.equityRows) {
        queries.push([
          `insert into equity_history (agent_id, date, equity) values ($1,$2,$3)
           on conflict (agent_id, date) do update set equity = excluded.equity`,
          [agent.id, row.date, row.equity]]);
      }
      await sqlBatch(queries);

      summary.agents_processed++;
      summary.days += events.equityRows.length;
      summary.opened += events.opened.length;
      summary.closed += events.closed.length;
      if (events.died) summary.agents_died++;
    } catch (err) {
      summary.errors.push(agent.id + ': ' + (err && err.message ? err.message : 'unknown'));
    }
  }
  return summary;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      // cron: todos los agentes vivos. Con CRON_SECRET configurado, solo Vercel.
      const secret = process.env.CRON_SECRET;
      if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'No autorizado.' });
      }
      const agents = await sql(`select * from agents where status = 'alive' order by created_at`);
      const summary = await processAgents(agents);
      await beat('agents:run', 'ok', { agents: agents.length });
      return res.status(200).json({ mode: 'cron', ...summary, assumptions: ASSUMPTIONS });
    }

    if (req.method === 'POST') {
      const uid = ((req.body || {}).uid || '').toString().trim();
      if (!uid) return res.status(400).json({ error: 'Falta uid.' });
      const agents = await sql(`select * from agents where user_id = $1 and status = 'alive' order by created_at`, [uid]);
      const summary = await processAgents(agents);
      return res.status(200).json({ mode: 'catchup', ...summary });
    }

    return res.status(405).json({ error: 'Método no soportado.' });
  } catch (err) {
    return res.status(500).json({ error: 'agents-run: ' + (err && err.message ? err.message : 'unknown') });
  }
}

export { processAgents, edgeSymbols };
