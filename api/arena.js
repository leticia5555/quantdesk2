// ═══════════════════════════════════════════════════════════════
// /api/arena — datos de solo lectura del ARENA para la UI.
//
// GET → { enabled, has_keys, account, positions, journal } donde journal
// es la última decisión del Agente #6 (plan publicado + órdenes con su
// resultado y fills). El razonamiento es público a propósito — patrón
// nof1: el porqué viaja junto al trade, verbatim.
//
// Nunca expone keys ni el account_number completo. Si Alpaca no responde,
// devuelve el journal igual con el error visible (honestidad > panel roto).
//
// ENV VARS: ARENA_ENABLED · ALPACA_PAPER_KEY/SECRET · DATABASE_URL
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { alpacaCreds, getAccount, getPositions } from './_lib/alpaca.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const out = {
    enabled: process.env.ARENA_ENABLED === '1',
    has_keys: !!alpacaCreds(),
    account: null,
    positions: [],
    journal: null,
    halt: null,
  };

  try {
    await ensureSchema();
    const [rows, stateRows] = await Promise.all([
      sql(`select run_date, status, plan, actions, account, created_at from arena_journal
           where phase = 'decide' order by created_at desc limit 1`),
      sql(`select halted, halted_at, halted_reason, resumed_at from arena_state where id = 1`),
    ]);
    if (rows[0]) {
      out.journal = {
        run_date: rows[0].run_date,
        status: rows[0].status,
        plan: rows[0].plan,
        actions: rows[0].actions || [],
        account_at_decision: rows[0].account || null,
        created_at: rows[0].created_at,
      };
    }
    // Estado de HALT del breaker: el panel lo muestra explícito (agente detenido
    // por drawdown de −20%). Honesto y contenido — no un limbo silencioso.
    if (stateRows[0]) {
      out.halt = {
        halted: !!stateRows[0].halted,
        halted_at: stateRows[0].halted_at || null,
        reason: stateRows[0].halted_reason || null,
        resumed_at: stateRows[0].resumed_at || null,
      };
    }
  } catch (err) {
    out.journal_error = String((err && err.message) || err);
  }

  if (out.has_keys) {
    try {
      const [account, positions] = await Promise.all([getAccount(), getPositions()]);
      out.account = { equity: Number(account.equity), cash: Number(account.cash), status: account.status };
      out.positions = positions.map((p) => ({
        symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        unrealized_pl: Number(p.unrealized_pl), unrealized_plpc: Number(p.unrealized_plpc),
      }));
    } catch (err) {
      out.alpaca_error = String((err && err.message) || err);
    }
  }

  // El equity intradía cambia poco para una card y el journal es diario.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(out);
}
