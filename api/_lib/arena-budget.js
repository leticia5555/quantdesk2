// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-budget.js — B9: el PRESUPUESTO de la liga, con breaker
// escalonado.
//
// `_lib/usage.js` ya cuenta TOKENS por (día, modelo) para toda la app. Esto es
// otra pregunta: **cuánto lleva gastado LA LIGA hoy, en dólares, por agente y
// por corrida** — y qué hacer cuando se pasa.
//
// Hace falta ahora y no antes por una razón concreta: con herramientas, una
// corrida dejó de ser DOS llamadas al LLM y pasó a ser hasta diez. El gasto por
// corrida se multiplicó y el techo que antes sobraba ahora puede quedar corto
// en un día volátil, sin que nadie se entere hasta la factura.
//
// ── EL BREAKER VA EN ESCALONES, Y ESO ES EL DISEÑO ───────────────────
// La versión obvia —"si te pasás del presupuesto, apagá las rondas fijas"— es
// PEOR que no tener breaker, y vale la pena entender por qué: apagar las rondas
// fijas deja vivos los DISPARADORES, que en un día volátil son MÁS caros que
// las rondas que se apagaron. El breaker ahorraría plata solo los días
// tranquilos, que son justo los días en que no hacía falta.
//
//   | Escalón | Umbral      | Qué hace |
//   |---|---|---|
//   | 0 | < budget    | normal: 8 herramientas, effort medium, 3 rondas fijas |
//   | 1 | ≥ budget    | herramientas 8→3 y effort → low. SIGUE DECIDIENDO, más barato |
//   | 2 | ≥ 1.5×      | solo la red de riesgo y los disparadores del PROPIO libro |
//
// El escalón 1 baja el costo sin dejar al libro sin decidir, que era la falla
// del diseño anterior. El escalón 2 deja vivo lo único que no puede apagarse:
// la red determinista, que no gasta un token.
//
// ── LO QUE EL BREAKER NUNCA APAGA ────────────────────────────────────
// La red de riesgo (breaker de equity, stops, trailing) NO consume LLM y por lo
// tanto NO tiene por qué apagarse jamás. Un presupuesto de tokens que apaga la
// protección del libro estaría cambiando plata por riesgo sin decirlo.
//
// ── CADA TRANSICIÓN SE JOURNALEA ─────────────────────────────────────
// Con el gasto acumulado que la disparó, el escalón nuevo y qué se recortó. Un
// día que terminó con menos corridas de lo normal tiene que poder explicarse
// sin adivinar.
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';
import { TOOL_BUDGET } from './arena-tools.js';
import { marketDay } from './arena-buffet-cache.js';

export const DAILY_BUDGET_USD = (() => {
  const n = Number(process.env.ARENA_DAILY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

// Multiplicador del escalón 2. 1.5× y no 2×: entre el escalón 1 y el 2 el gasto
// ya viene frenado, así que si igual sigue subiendo es que el día es caro de
// verdad y conviene cortar antes.
export const TIER2_MULTIPLIER = (() => {
  const n = Number(process.env.ARENA_BUDGET_TIER2_MULT);
  return Number.isFinite(n) && n > 1 ? n : 1.5;
})();

const SCHEMA = `create table if not exists arena_spend (
   id          text primary key,
   day         date not null,
   agent_id    text not null,
   phase       text,
   usd         numeric,
   usd_source  text,
   input_tokens   int,
   output_tokens  int,
   cache_read     int,
   cache_write    int,
   llm_calls   int,
   tool_calls  int,
   created_at  timestamptz not null default now()
 )`;
const INDEX = `create index if not exists arena_spend_day_idx on arena_spend (day, agent_id)`;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql(SCHEMA);
  await sql(INDEX);
  ready = true;
}

// ── PURO (testeable sin DB) ──────────────────────────────────────────

// El escalón, del gasto acumulado del día.
export function spendTier(spentUsd, budget = DAILY_BUDGET_USD, mult = TIER2_MULTIPLIER) {
  const s = Number(spentUsd);
  if (!Number.isFinite(s) || s < 0) return 0;
  if (s >= budget * mult) return 2;
  if (s >= budget) return 1;
  return 0;
}

// Qué permite cada escalón. Es la ÚNICA definición de la política: el runner y
// el vigilante la leen de acá en vez de tener cada uno su propia idea de qué
// significa "escalón 1".
export function tierPolicy(tier) {
  if (tier >= 2) {
    return {
      tier: 2,
      tools_max: 0,
      effort: 'low',
      fixed_rounds: false,
      buffet_triggers: false,     // los disparadores de OPORTUNIDAD se apagan
      own_book_triggers: true,    // los del PROPIO libro no: es su posición
      risk_net: true,             // NUNCA se apaga: no gasta tokens
      label: 'solo la red de riesgo y los disparadores del propio libro',
      cut: 'rondas fijas y disparadores del buffet',
    };
  }
  if (tier >= 1) {
    return {
      tier: 1,
      tools_max: 3,
      effort: 'low',
      fixed_rounds: true,
      buffet_triggers: true,
      own_book_triggers: true,
      risk_net: true,
      label: 'sigue decidiendo, más barato: 3 herramientas y effort bajo',
      cut: `herramientas de ${TOOL_BUDGET.fixed_round} a 3, effort de medium a low`,
    };
  }
  return {
    tier: 0,
    tools_max: TOOL_BUDGET.fixed_round,
    effort: null,                 // null = el default del registry
    fixed_rounds: true,
    buffet_triggers: true,
    own_book_triggers: true,
    risk_net: true,
    label: 'normal',
    cut: null,
  };
}

// El costo de UNA llamada, con su procedencia. Se prefiere SIEMPRE lo que
// cobró el proveedor; una estimación se marca como tal. Nunca se inventa un
// número — un costo ausente es un dato, un costo inventado es una mentira que
// después alguien usa para presupuestar.
export function callCost({ anthropicUsd = null, providerUsd = null, estimateUsd = null } = {}) {
  if (Number.isFinite(providerUsd)) return { usd: providerUsd, source: 'provider_reported' };
  if (Number.isFinite(anthropicUsd)) return { usd: anthropicUsd, source: 'anthropic_price_table' };
  if (Number.isFinite(estimateUsd)) return { usd: estimateUsd, source: 'catalog_estimate', estimated: true };
  return { usd: null, source: null, note: 'el proveedor no reportó costo y no hay precio de catálogo — no se inventa' };
}

// ── CON DB (best-effort; el contador NUNCA frena una corrida) ────────

export async function recordRunSpend({
  agentId, runId, phase = 'decide', usd = null, usdSource = null,
  tokens = {}, llmCalls = 0, toolCalls = 0, now = new Date(),
}) {
  try {
    await ensure();
    await sql(
      `insert into arena_spend (id, day, agent_id, phase, usd, usd_source,
                                input_tokens, output_tokens, cache_read, cache_write, llm_calls, tool_calls)
       values ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [runId, marketDay(now), agentId, phase, usd, usdSource,
       Number(tokens.input) || 0, Number(tokens.output) || 0,
       Number(tokens.cache_read) || 0, Number(tokens.cache_write) || 0,
       Math.floor(llmCalls) || 0, Math.floor(toolCalls) || 0],
    );
    return true;
  } catch { return false; }
}

// Lo que lleva gastado la liga HOY. Devuelve { usd, rows, by_agent, partial }.
//
// `partial: true` cuando hay corridas SIN costo (un proveedor que no reportó y
// sin precio de catálogo). Importa para el breaker: un total que ignora las
// corridas sin precio está SUBESTIMANDO el gasto, y un breaker que subestima no
// dispara cuando debería. Se dice en vez de taparse.
export async function todaySpend(now = new Date()) {
  try {
    await ensure();
    const rows = await sql(
      `select agent_id, sum(usd) as usd, count(*) as corridas,
              count(*) filter (where usd is null) as sin_costo
       from arena_spend where day = $1::date group by agent_id`, [marketDay(now)],
    );
    let total = 0, sinCosto = 0, corridas = 0;
    const byAgent = {};
    for (const r of rows || []) {
      const u = Number(r.usd) || 0;
      total += u;
      sinCosto += Number(r.sin_costo) || 0;
      corridas += Number(r.corridas) || 0;
      byAgent[r.agent_id] = { usd: +u.toFixed(4), corridas: Number(r.corridas) || 0, sin_costo: Number(r.sin_costo) || 0 };
    }
    return { usd: +total.toFixed(4), rows: rows ? rows.length : 0, corridas, by_agent: byAgent, partial: sinCosto > 0, sin_costo: sinCosto };
  } catch {
    // SIN CONTADOR, EL BREAKER NO PUEDE DECIDIR. Fail OPEN (escalón 0): frenar
    // la liga entera porque Neon no contesta cambiaría un problema de
    // observabilidad por uno de producto. Se declara `unavailable` para que la
    // corrida journalee que corrió a ciegas.
    return { usd: 0, rows: 0, corridas: 0, by_agent: {}, partial: true, unavailable: true };
  }
}

// El escalón vigente AHORA, con todo lo que hace falta para journalearlo.
export async function currentTier(now = new Date(), budget = DAILY_BUDGET_USD) {
  const spend = await todaySpend(now);
  const tier = spend.unavailable ? 0 : spendTier(spend.usd, budget);
  const policy = tierPolicy(tier);
  return {
    ...policy,
    spent_usd: spend.usd, budget_usd: budget,
    pct_of_budget: budget > 0 ? +((spend.usd / budget) * 100).toFixed(1) : null,
    spend_partial: spend.partial,
    spend_unavailable: !!spend.unavailable,
    by_agent: spend.by_agent,
    ...(spend.unavailable
      ? { note: 'El contador de gasto no está disponible (DB): se corre en escalón 0 a ciegas. Frenar la liga por un problema de observabilidad sería cambiar un problema por otro peor.' }
      : spend.partial
        ? { note: `${spend.sin_costo} corrida(s) de hoy sin costo reportado: el total está SUBESTIMADO y el breaker puede estar disparando tarde.` }
        : {}),
  };
}

// ── EL ANUNCIO DE LA TRANSICIÓN ──────────────────────────────────────
// Idempotente por (día, escalón): se anuncia UNA vez por escalón por día, no en
// cada corrida que lo encuentra. Sin esa idempotencia, un día en escalón 1
// llenaría el journal con la misma fila doce veces y el post-mortem tendría que
// deduplicar para contar qué pasó.
export function tierAnnouncementId(tier, now = new Date()) {
  return `arena-presupuesto-${marketDay(now)}-escalon-${tier}`;
}

export function tierAnnouncementText(info) {
  return [
    `PRESUPUESTO — ESCALÓN ${info.tier}. La liga lleva gastado $${Number(info.spent_usd).toFixed(2)} de un presupuesto diario de $${Number(info.budget_usd).toFixed(2)} (${info.pct_of_budget}%).`,
    `Qué cambia: ${info.label}.` + (info.cut ? ` Se recorta: ${info.cut}.` : ''),
    info.tier >= 2
      ? 'La RED DE RIESGO sigue corriendo: no gasta tokens y no se apaga nunca. Un presupuesto que apaga la protección del libro estaría cambiando plata por riesgo sin decirlo.'
      : 'La red de riesgo y los disparadores del propio libro siguen intactos.',
    info.tier === 1
      ? 'El escalón 1 NO apaga las rondas fijas a propósito: apagarlas dejaría vivos los disparadores, que en un día volátil son MÁS caros que las rondas que se apagaron.'
      : '',
    info.note || '',
  ].filter(Boolean).join('\n');
}
