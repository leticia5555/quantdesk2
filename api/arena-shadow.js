// ═══════════════════════════════════════════════════════════════
// /api/arena-shadow — B13: corre el CONTRATO NUEVO sin tocar un solo libro.
//
// El portafolio objetivo (B5) no puede estrenarse contra siete cuentas reales.
// Acá corre con el MISMO tablero, las MISMAS herramientas y el MISMO mercado —
// y CERO órdenes. Lo que sale es lo único que importa antes de encenderlo:
// ¿los siete producen un objetivo legible?, ¿pasa los rieles?, ¿qué órdenes
// habría mandado el motor?, y ¿cuánto costó?
//
//   GET /api/arena-shadow            → corre la sombra sobre la liga activa
//   GET /api/arena-shadow?agent=grok → un solo agente
//   GET /api/arena-shadow?report=1   → SOLO el reporte del día (0 tokens)
//
// GATES: CRON_SECRET (si corre por cron) **o** ARENA_ADMIN_KEY (a mano). NO
// exige ARENA_ENABLED: la sombra es lo que se corre ANTES de encender nada.
//
// ── LO QUE NO PUEDE PASAR, Y CÓMO SE IMPIDE ──────────────────────────
// No alcanza con no llamar a Alpaca: el runner recibe un `shadowBroker`, cuyas
// escrituras LANZAN. Si algún camino intentara mandar una orden, la corrida
// falla ruidosamente en vez de operar en silencio sobre una cuenta real.
// Y escribe en `arena_shadow_journal`, tabla aparte — no una columna booleana
// en la tabla real, que está a una consulta mal escrita de contaminar el
// post-mortem para siempre.
//
// ── LA SOMBRA GASTA DINERO DE VERDAD ─────────────────────────────────
// Son llamadas reales a siete proveedores. Va contra el MISMO
// ARENA_DAILY_BUDGET_USD que la liga viva y se registra con `phase='shadow'`.
// "La sombra es gratis" sería una creencia que se desmiente con la factura.
//
// ENV VARS: ARENA_ADMIN_KEY · CRON_SECRET · DATABASE_URL · las de la liga.
// ═══════════════════════════════════════════════════════════════

import { ensureSchema } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import * as alpaca from './_lib/alpaca.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_MAX_TOKENS } from './_lib/arena-registry.js';
import { callArenaLLM, withDeadline, cachePrefixReport, anthropicCostUsd } from './_lib/arena-model.js';
import { gatherContext, buildSharedContext, buildTargetSystemPrompt, resolveBaseUrl, PROMPT_VERSION } from './arena-run.js';
import { parsePortfolioResponse, validateTarget, railTrims, RAILS } from './_lib/arena-rails.js';
import { buildRebalance } from './_lib/arena-rebalance.js';
import { createToolExecutor, TOOL_BUDGET } from './_lib/arena-tools.js';
import { runToolLoop } from './_lib/arena-tool-loop.js';
import { buildTail, lenteDelDia } from './_lib/arena-herding.js';
import { buildRailMeta } from './_lib/arena-meta.js';
import { shadowBroker, shadowJournalInsert, shadowRunId, shadowReport, ensureShadowSchema } from './_lib/arena-shadow.js';
import { currentTier, recordRunSpend, callCost } from './_lib/arena-budget.js';
import { marketDay } from './_lib/arena-buffet-cache.js';
import { beat } from './_lib/heartbeat.js';

export const maxDuration = 300;

function autorizado(req) {
  const cron = process.env.CRON_SECRET;
  if (cron) {
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
    if (h === 'Bearer ' + cron) return { ok: true };
  }
  const admin = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (admin.ok) return { ok: true };
  return { ok: false, status: admin.status, body: admin.body };
}

// El libro de UN agente, leído a través del broker de sombra (las lecturas
// pasan; las escrituras lanzan).
async function leerLibro(broker, creds) {
  const [account, positions, openOrders] = await Promise.all([
    broker.getAccount(creds), broker.getPositions(creds), broker.getOrders('open', 100, creds),
  ]);
  return { account, positions: positions || [], openOrders: openOrders || [] };
}

// ── UNA CORRIDA EN SOMBRA ────────────────────────────────────────────
// Nunca lanza: una corrida que falla tiene que aparecer como una FILA, no
// llevarse el reporte de los otros seis.
export async function runShadowAgent({ agent, buffet, now = new Date(), tier = null, deps = {} }) {
  const runId = shadowRunId(agent.id, now);
  const base = { id: runId, run_date: marketDay(now), agent_id: agent.id, phase: 'decide', prompt_version: PROMPT_VERSION, model: agent.model };
  const broker = (deps.shadowBroker || shadowBroker)(alpaca);
  const creds = agentAlpacaCreds(agent);
  if (!creds) {
    await shadowJournalInsert({ ...base, status: 'aborted_no_alpaca_keys', error: `Faltan ALPACA_${agent.alpaca}_KEY/SECRET.` });
    return { agent: agent.id, status: 'aborted_no_alpaca_keys' };
  }

  let libro;
  try { libro = await leerLibro(broker, creds); }
  catch (e) {
    await shadowJournalInsert({ ...base, status: 'aborted_alpaca_read', error: String((e && e.message) || e) });
    return { agent: agent.id, status: 'aborted_alpaca_read' };
  }
  const equity = Number(libro.account.equity);

  // El prompt: MISMO system y MISMO contexto compartido que la liga; la cola
  // (lente + orden aleatorizado) es lo único por agente, del lado no cacheado.
  const system = buildTargetSystemPrompt(agent.persona);
  const shared = buildSharedContext(buffet);
  const cola = buildTail({
    agentId: agent.id, runId,
    movers: ((buffet.board_raw && buffet.board_raw.gainers) || []).concat((buffet.board_raw && buffet.board_raw.losers) || []),
    now,
  });
  const user = [
    cola.text,
    '',
    'YOUR BOOK (Alpaca paper, live):',
    JSON.stringify({
      equity_total_incl_cash: equity,
      cash_included_in_equity: Number(libro.account.cash),
      positions: libro.positions.map((p) => ({
        symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        weight_pct: Number.isFinite(equity) && equity > 0 ? +((Number(p.market_value) / equity) * 100).toFixed(2) : null,
      })),
      open_orders: libro.openOrders.map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, status: o.status })),
    }),
    '',
    'State the book you want to hold. Remember: anything you hold and do not list gets sold.',
  ].join('\n');

  const toolsMax = tier ? tier.tools_max : TOOL_BUDGET.fixed_round;
  const executor = createToolExecutor({
    budget: toolsMax, board: buffet.board_raw || null, universe: buffet.universe_raw || null,
    creds, now, deps: { sectorOf: () => null },
  });

  const ctx = {
    prompt: { system, shared, user },
    cache_prefix: cachePrefixReport(agent, [system, shared]),
    lens: cola.lens, tail_tokens: cola.tokens_est,
    tier: tier ? { tier: tier.tier, tools_max: toolsMax } : null,
  };

  let loop;
  try {
    loop = toolsMax > 0
      ? await runToolLoop({ agent, system: [system, shared], messages: [{ role: 'user', content: user }], executor, maxTokens: ARENA_MAX_TOKENS, now })
      : { llm: await callArenaLLM({ agent, system: [system, shared], messages: [{ role: 'user', content: user }], maxTokens: ARENA_MAX_TOKENS, now }), turns: 1, stopped_by: 'tools_disabled' };
  } catch (e) {
    await shadowJournalInsert({ ...base, status: 'aborted_llm_threw', error: String((e && e.message) || e), context: ctx });
    return { agent: agent.id, status: 'aborted_llm_threw' };
  }

  const llm = loop.llm;
  ctx.tools = { budget: toolsMax, used: executor.used, turns: loop.turns, stopped_by: loop.stopped_by, sequence: executor.sequence, summary: executor.summary() };

  // El gasto se registra SIEMPRE, haya salido bien o mal: una corrida abortada
  // igual gastó tokens, y un contador que solo cuenta los éxitos subestima.
  // El acumulado del LOOP, no el de la última llamada: con herramientas el
  // prompt entero viaja en cada vuelta, así que contar solo la última es contar
  // una llamada de nueve — y el escalón del breaker sale de este número.
  const usage = (loop && loop.usage_total) || (llm.data && llm.data.usage) || {};
  const costo = callCost({
    anthropicUsd: agent.provider === 'anthropic' ? anthropicCostUsd(agent.model, usage) : null,
    providerUsd: Number.isFinite(loop && loop.cost_usd_total) ? loop.cost_usd_total
      : (llm.data && Number.isFinite(llm.data.cost_usd) ? llm.data.cost_usd : null),
  });
  await recordRunSpend({
    agentId: agent.id, runId, phase: 'shadow', usd: costo.usd, usdSource: costo.source,
    tokens: { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_write: usage.cache_creation_input_tokens },
    llmCalls: (loop.usage_total && loop.usage_total.calls) || loop.turns || 1, toolCalls: executor.used, now,
  });
  ctx.cost = costo;

  if (llm.status !== 200 || !llm.data) {
    const error = llm.stale ? 'fechas rotas tras retry' : `HTTP ${llm.status}${llm.error_detail ? ': ' + llm.error_detail : ''}`;
    await shadowJournalInsert({ ...base, status: 'aborted_llm_error', error, context: ctx });
    return { agent: agent.id, status: 'aborted_llm_error', error, cost_usd: costo.usd };
  }

  const text = ((llm.data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')).trim();
  const parsed = parsePortfolioResponse(text);
  if (!parsed.ok) {
    await shadowJournalInsert({ ...base, status: 'aborted_malformed_target', error: parsed.error, llm_response: text, context: ctx });
    return { agent: agent.id, status: 'aborted_malformed_target', error: parsed.error, cost_usd: costo.usd };
  }

  // ── RIELES ──
  // La metadata por nombre (precio, sector, shortable, easy-to-borrow) se
  // resuelve ACÁ, sobre los símbolos que el objetivo realmente nombra — no
  // sobre el universo entero. Son unidades de nombres, no centenas, y el dato
  // de borrow viene de la MISMA fuente que después va a aceptar o rechazar la
  // orden (Alpaca /v2/assets).
  //
  // Lo que falte sale ausente y los rieles lo leen como "sin dato": R9 rechaza
  // el corto (fail closed) y el nombre cae al bucket UNKNOWN de R6. Que ahora
  // haya datos no afloja ningún riel — deja de rechazarlos a todos por igual.
  const simbolosDelObjetivo = [...new Set([
    ...Object.keys(parsed.weights || {}),
    ...(libro.positions || []).map((p) => String((p && p.symbol) || '').toUpperCase()),
  ].filter(Boolean))];
  let meta = {};
  let metaDiag = null;
  try {
    const rm = await buildRailMeta(simbolosDelObjetivo, { creds, now });
    meta = rm.meta; metaDiag = { ...rm.diagnostics, errors: rm.errors };
  } catch (e) {
    metaDiag = { error: String((e && e.message) || e), note: 'sin metadata: R9 rechaza todo corto y R6 manda todo al bucket UNKNOWN' };
  }
  ctx.rail_meta = metaDiag;
  const v = validateTarget(parsed.weights, meta, RAILS);
  const trims = railTrims(libro.positions, equity, meta, RAILS);
  const rebalance = v.ok
    ? buildRebalance({ positions: libro.positions, openOrders: libro.openOrders, equity, target: parsed.weights, trims })
    : null;

  await shadowJournalInsert({
    ...base,
    status: v.ok ? 'ok_target' : 'rejected_rails',
    plan: parsed.plan, llm_response: text,
    target: { weights: parsed.weights, cash: parsed.cash, theses: parsed.theses },
    rebalance,
    context: { ...ctx, rails: v, rail_trims: trims },
    error: v.ok ? null : `violó ${v.violations.length} riel(es): ${v.violations.map((x) => x.rail).join(', ')}`,
  });

  return {
    agent: agent.id, status: v.ok ? 'ok_target' : 'rejected_rails',
    lens: cola.lens, tools_used: executor.used, cost_usd: costo.usd,
    weights: parsed.weights,
    exposures: v.exposures,
    violations: v.violations,
    would_place: rebalance ? rebalance.legs.length : 0,
    turnover: rebalance ? rebalance.turnover : null,
    rail_trims: trims.length,
    rail_meta: metaDiag ? {
      shortable_ok: metaDiag.shortable_ok, with_borrow: metaDiag.with_borrow,
      with_sector: metaDiag.with_sector, sector_unknown_bucket: metaDiag.sector_unknown_bucket,
      symbols: metaDiag.symbols, note: metaDiag.note || metaDiag.error || null,
    } : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const auth = autorizado(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const now = new Date();
  try {
    await ensureSchema();
    await ensureShadowSchema();

    // ?report=1 — gratis, cero tokens: qué pasó hoy en la sombra.
    if (String(q.report || '') === '1') {
      return res.status(200).json(await shadowReport(String(q.day || marketDay(now))));
    }

    const only = String(q.agent || '').toLowerCase();
    const agents = only ? [agentById(only)].filter(Boolean) : activeAgents();
    if (!agents.length) return res.status(400).json({ error: 'Ningún agente activo con ese id.' });

    // El presupuesto manda también acá: la sombra gasta dinero de verdad.
    const tier = await currentTier(now);

    const buffet = await gatherContext({ baseUrl: resolveBaseUrl(req), now });

    const settled = await Promise.allSettled(
      agents.map((a) => withDeadline(
        runShadowAgent({ agent: a, buffet, now, tier }),
        270000,
        () => ({ agent: a.id, status: 'timeout' }),
      )),
    );
    const results = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : {
      agent: agents[i].id, status: 'threw', error: String((r.reason && r.reason.message) || r.reason),
    }));

    const costo = results.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const verdes = results.filter((r) => r.status === 'ok_target');
    const out = {
      ran_at: now.toISOString(),
      shadow: true,
      orders_placed: 0,
      orders_note: 'La sombra NO manda órdenes por construcción: el broker de sombra LANZA en cualquier escritura.',
      budget: { tier: tier.tier, spent_before_usd: tier.spent_usd, budget_usd: tier.budget_usd, tools_max: tier.tools_max, note: tier.note || null },
      cost_usd: +costo.toFixed(4),
      board: buffet.board_meta || null,
      universe: (buffet.universe_diagnostics && buffet.universe_diagnostics.base) || null,
      agents: results,
      verdict: verdes.length === results.length
        ? `VERDE: los ${verdes.length} produjeron un objetivo que pasa los rieles. Costo de la sombra: $${costo.toFixed(4)}.`
        : `${verdes.length}/${results.length} en verde. Revisá \`agents[].status\` y \`violations\` antes de encender el contrato nuevo.`,
    };
    await beat('arena:shadow', verdes.length === results.length ? 'ok' : 'partial', { verdes: verdes.length, costo: +costo.toFixed(4) });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'arena-shadow: ' + ((err && err.message) || 'unknown') });
  }
}
