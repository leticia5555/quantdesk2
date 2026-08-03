// ═══════════════════════════════════════════════════════════════
// /api/leaderboard — datos públicos de la LIGA multi-modelo del Arena.
//
// Ruta pública NUEVA (no el tab MIS AGENTES): rankea a los agentes activos por
// EQUITY y, por cada uno, publica su último plan (verbatim, patrón nof1) y sus
// trades. Es la fuente de /leaderboard (página standalone) y de la versión
// compacta embebida en /hoy. Read-only, cacheado, nunca expone keys.
//
// Por cada agente activo (registry / ARENA_LEAGUE):
//   - equity/cash/posiciones de SU cuenta Alpaca (si tiene keys),
//   - última decisión journaleada (plan + acciones con resultado/fill),
//   - estado de HALT del breaker,
//   - return vs. baseline y cambio del día (last_equity de Alpaca).
// Ordenado por equity desc; los que aún no operan (sin keys / Alpaca caída)
// caen al final sin ranking. Honesto > panel roto: si algo falla, el agente
// igual aparece con su error visible.
//
// ENV VARS: ARENA_ENABLED · ALPACA_<ALPACA>_KEY/SECRET por agente ·
//           DATABASE_URL · ARENA_BASELINE_EQUITY (opc, default 100000).
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { getAccount, getPositions } from './_lib/alpaca.js';
import { activeAgents, agentAlpacaCreds } from './_lib/arena-registry.js';

const BASELINE = (() => {
  const n = Number(process.env.ARENA_BASELINE_EQUITY);
  return Number.isFinite(n) && n > 0 ? n : 100000; // cuentas paper de Alpaca arrancan en $100k
})();

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? +(((a - b) / b) * 100).toFixed(2) : null);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const enabled = process.env.ARENA_ENABLED === '1';
  const agents = activeAgents();

  // Estado de halt de TODA la tabla (es diminuta) → mapa por agent_id.
  let haltByAgent = {};
  let journalErr = null;
  try {
    await ensureSchema();
    const stateRows = await sql(`select agent_id, halted, halted_at, halted_reason, resumed_at from arena_state`);
    for (const r of stateRows) haltByAgent[r.agent_id] = r;
  } catch (err) { journalErr = String((err && err.message) || err); }

  const rows = await Promise.all(agents.map(async (agent) => {
    const creds = agentAlpacaCreds(agent);
    const out = {
      id: agent.id, name: agent.name, model: agent.model, model_label: agent.model_label,
      provider: agent.provider, house: agent.house, control: !!agent.control,
      has_keys: !!creds, account: null, positions: [], journal: null, halt: null,
      return_pct: null, day_change_pct: null,
    };

    // Última decisión journaleada del agente (plan + acciones). Best-effort.
    try {
      const jr = await sql(
        `select run_date, status, plan, actions, account, created_at from arena_journal
         where phase = 'decide' and agent_id = $1 order by created_at desc limit 1`, [agent.id]);
      if (jr[0]) {
        out.journal = {
          run_date: jr[0].run_date, status: jr[0].status, plan: jr[0].plan,
          actions: jr[0].actions || [], created_at: jr[0].created_at,
        };
      }
    } catch (err) { out.journal_error = String((err && err.message) || err); }

    const h = haltByAgent[agent.id];
    if (h) out.halt = { halted: !!h.halted, halted_at: h.halted_at || null, reason: h.halted_reason || null, resumed_at: h.resumed_at || null };

    if (creds) {
      try {
        const [account, positions] = await Promise.all([getAccount(creds), getPositions(creds)]);
        const equity = Number(account.equity);
        const lastEquity = Number(account.last_equity);
        out.account = { equity, cash: Number(account.cash), status: account.status };
        out.return_pct = pct(equity, BASELINE);
        out.day_change_pct = pct(equity, lastEquity);
        out.positions = positions.map((p) => ({
          symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
          market_value: Number(p.market_value),
          unrealized_pl: Number(p.unrealized_pl), unrealized_plpc: Number(p.unrealized_plpc),
        }));
      } catch (err) { out.alpaca_error = String((err && err.message) || err); }
    }
    return out;
  }));

  // Ranking por EQUITY (decisión #6). Los que ya operan (con equity) van primero,
  // ordenados desc; los que aún no (sin keys / Alpaca caída) caen al final sin rank.
  const withEquity = rows.filter((r) => r.account && Number.isFinite(r.account.equity));
  const withoutEquity = rows.filter((r) => !(r.account && Number.isFinite(r.account.equity)));
  withEquity.sort((a, b) => b.account.equity - a.account.equity);
  withEquity.forEach((r, i) => { r.rank = i + 1; });
  withoutEquity.forEach((r) => { r.rank = null; });
  const ranked = [...withEquity, ...withoutEquity];

  const body = { enabled, count: ranked.length, baseline_equity: BASELINE, agents: ranked };
  if (journalErr) body.journal_error = journalErr;

  // El equity intradía cambia poco para un ranking; el journal es diario.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(body);
}
