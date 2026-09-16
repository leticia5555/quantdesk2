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
import { buildRailMeta, sectorFromGics } from './_lib/arena-meta.js';

// Sector ETF de un simbolo, desde los sectores GICS que el universo guardó.
// Sin esto, todo el tablero es "sin sector" para la herramienta `sector`.
function sectorEtfDe(buffet, sym) {
  const secs = (buffet && buffet.universe_raw && buffet.universe_raw.sectores) || null;
  if (!secs) return null;
  return sectorFromGics(secs[String(sym || '').toUpperCase()]);
}
import { shadowBroker, shadowJournalInsert, shadowRunId, shadowReport, ensureShadowSchema } from './_lib/arena-shadow.js';
import { currentTier, recordRunSpend, callCost } from './_lib/arena-budget.js';
import { marketDay } from './_lib/arena-buffet-cache.js';
import { createTrace } from './_lib/arena-trace.js';
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
export async function runShadowAgent({ agent, buffet, now = new Date(), tier = null, deps = {}, trace = null }) {
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
  // POSICIONES DE ARRANQUE. El piso de ruido compara a claude con control, y
  // eso solo mide ruido si los dos ARRANCAN del mismo libro: si uno hereda 6
  // posiciones y el otro 1, el coseno mide herencia, no ruido.
  const posicionesIniciales = (libro.positions || []).map((x) => String((x && x.symbol) || '').toUpperCase()).filter(Boolean).sort();

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
    creds, now,
    // ── `sectorOf` DEVOLVÍA null LITERALMENTE ──────────────────────────
    // Por eso `sector({etf:'XLE'})` daba 0 filas: ningún nombre del tablero
    // podía coincidir con ningún sector, porque la función decía que nadie
    // tiene sector. La herramienta no estaba rota — estaba conectada a nada.
    //
    // Ahora lee los sectores GICS del universo, que vienen del CSV de IVV. Es
    // el MISMO dato que arregló R6: una vez cargado, sirve para los dos.
    deps: { sectorOf: (sym) => sectorEtfDe(buffet, sym) },
    // `marketCapOf` y `retornosOf` salen del universo por default (ver
    // createToolExecutor): sin ellos, `min_mcap_b` y `ret_*_min` se ignoraban
    // en silencio y el modelo creía que había filtrado.
  });

  const ctx = {
    prompt: { system, shared, user },
    posiciones_iniciales: posicionesIniciales,
    cache_prefix: cachePrefixReport(agent, [system, shared]),
    lens: cola.lens, tail_tokens: cola.tokens_est,
    tier: tier ? { tier: tier.tier, tools_max: toolsMax } : null,
  };

  let loop;
  try {
    loop = toolsMax > 0
      ? await runToolLoop({ agent, system: [system, shared], messages: [{ role: 'user', content: user }], executor, maxTokens: ARENA_MAX_TOKENS, now, trace })
      : { llm: await callArenaLLM({ agent, system: [system, shared], messages: [{ role: 'user', content: user }], maxTokens: ARENA_MAX_TOKENS, now, trace, fase: 'sin_herramientas' }), turns: 1, stopped_by: 'tools_disabled' };
  } catch (e) {
    // EL STACK, no solo el mensaje. `aborted_llm_threw` con un string suelto no
    // distingue un error de red de un TypeError nuestro, y son diagnósticos
    // opuestos: uno se reintenta, el otro se arregla.
    const err = { message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).slice(0, 2000) : null, name: (e && e.name) || null };
    ctx.threw = err;
    if (trace) ctx.trace = trace.report();
    await shadowJournalInsert({ ...base, status: 'aborted_llm_threw', error: err.message, context: ctx });
    return { agent: agent.id, status: 'aborted_llm_threw', threw: err, ...(trace ? { trace: trace.report() } : {}) };
  }

  const llm = loop.llm;
  ctx.tools = { budget: toolsMax, used: executor.used, intentos: executor.intentos, turns: loop.turns, stopped_by: loop.stopped_by, sequence: executor.sequence, summary: executor.summary() };
  if (loop.cierre_diagnostico) ctx.cierre = loop.cierre_diagnostico;
  // DÓNDE MURIÓ. `cierre: null` significaba dos cosas opuestas —el cierre salió
  // bien, o el loop murió antes de llegar a él— y se veían iguales. Esto las
  // separa: si hay `murio_en`, el cierre nunca ocurrió.
  if (loop.murio_en) ctx.murio_en = loop.murio_en;

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
    // EL CUERPO CRUDO AL JOURNAL. Tres agentes abortaron con "HTTP 200" y no
    // había forma de saber qué había contestado el proveedor: el error decía el
    // status y nada más. Sin el cuerpo, diagnosticar esto es adivinar.
    ctx.llm_error = {
      status: llm.status, detail: llm.error_detail || null,
      provider_error: llm.provider_error || null,
      raw_body: llm.raw_body || null,
      // EL TURNO DE CIERRE ENTERO. Los abortos llegaron con status 200 y todo
      // lo de arriba en null: el fetch iba bien y la falla estaba al LEER la
      // respuesta. Esto es lo que faltaba.
      cierre: llm.cierre_diagnostico || (loop && loop.cierre_diagnostico) || null,
      // Si esto viene poblado, el `cierre: null` de arriba NO es un cierre que
      // salió bien: es un cierre que nunca se ejecutó.
      murio_en: (loop && loop.murio_en) || null,
      threw_stack: llm.threw_stack || null,
      timed_out: !!llm.timedOut, stale: !!llm.stale, retry_failed: !!llm.retry_failed,
    };
    if (trace) ctx.trace = trace.report();
    await shadowJournalInsert({ ...base, status: 'aborted_llm_error', error, context: ctx });
    return {
      agent: agent.id, status: 'aborted_llm_error', error, cost_usd: costo.usd,
      murio_en: (loop && loop.murio_en) || null,
      llm_error: ctx.llm_error,
      ...(trace ? { trace: trace.report() } : {}),
    };
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
    // Los sectores del universo (GICS del CSV de IVV) llegan acá: son la
    // clasificación del índice, no una heurística, y son lo que evita que R6
    // rechace carteras por un bucket UNKNOWN inventado por la falta de datos.
    const sectoresUniverso = (buffet && buffet.universe_raw && buffet.universe_raw.sectores) || null;
    const rm = await buildRailMeta(simbolosDelObjetivo, { creds, now, sectoresConocidos: sectoresUniverso });
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
    lens: cola.lens, tools_used: executor.used, tools_intentos: executor.intentos, cost_usd: costo.usd,
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

    // ── ?trace=1 — LA CONVERSACIÓN ENTERA, TURNO POR TURNO ─────────────
    // EXIGE `?agent=<uno>`. No es una restricción arbitraria: el trace de una
    // vuelta lleva el tablero, el prompt del sistema y todos los resultados de
    // herramientas acumulados. Siete de esos en una respuesta HTTP no caben, y
    // el caso de uso es "este agente falla, quiero ver por qué", no "quiero
    // siete conversaciones".
    const quiereTrace = String(q.trace || '') === '1';
    if (quiereTrace && !only) {
      return res.status(400).json({
        error: '?trace=1 exige ?agent=<id>.',
        detalle: 'El trace de UNA vuelta lleva el prompt entero más todos los resultados de herramientas acumulados; siete agentes no caben en una respuesta. Corré uno por vez.',
        ejemplo: '/api/arena-shadow?agent=qwen&trace=1&key=<ARENA_ADMIN_KEY>',
      });
    }

    // El presupuesto manda también acá: la sombra gasta dinero de verdad.
    const tier = await currentTier(now);

    const buffet = await gatherContext({ baseUrl: resolveBaseUrl(req), now });

    const trazas = new Map();
    const settled = await Promise.allSettled(
      agents.map((a) => {
        const trace = quiereTrace ? createTrace({ label: a.id }) : null;
        if (trace) trazas.set(a.id, trace);
        return withDeadline(
          runShadowAgent({ agent: a, buffet, now, tier, trace }),
          270000,
          // El timeout TAMBIÉN devuelve el trace: una corrida que se pasó del
          // reloj es justo la que hay que poder mirar vuelta por vuelta, y
          // perderlo acá deja el peor caso sin evidencia.
          () => ({ agent: a.id, status: 'timeout', ...(trace ? { trace: trace.report() } : {}) }),
        );
      }),
    );
    const results = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : {
      agent: agents[i].id, status: 'threw',
      error: String((r.reason && r.reason.message) || r.reason),
      stack: r.reason && r.reason.stack ? String(r.reason.stack).slice(0, 2000) : null,
      ...(trazas.has(agents[i].id) ? { trace: trazas.get(agents[i].id).report() } : {}),
    }));

    // Red de seguridad del trace: si un agente salió por un camino que no lo
    // adjuntó, se adjunta acá. Pedir `?trace=1` y recibir una respuesta sin
    // trace es exactamente el fallo que este endpoint existe para no repetir.
    if (quiereTrace) {
      for (const r of results) {
        if (r && !r.trace && trazas.has(r.agent)) r.trace = trazas.get(r.agent).report();
      }
    }

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
    if (quiereTrace) {
      out.trace_note = 'TRACE ACTIVO: `agents[].trace.turnos_detalle[]` trae, por vuelta, el CUERPO HTTP enviado y el TEXTO CRUDO recibido (4 KB c/u), más el stack de cualquier throw. Lleva los prompts completos: no se cachea y no se publica en ninguna ruta pública.';
      res.setHeader('Cache-Control', 'no-store');
    }
    await beat('arena:shadow', verdes.length === results.length ? 'ok' : 'partial', { verdes: verdes.length, costo: +costo.toFixed(4) });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'arena-shadow: ' + ((err && err.message) || 'unknown') });
  }
}
