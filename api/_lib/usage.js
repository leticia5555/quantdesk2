// ═══════════════════════════════════════════════════════════════
// api/_lib/usage.js — contador journaleado del gasto de IA.
//
// TODA llamada a Anthropic pasa por guardedClaudeCall (_lib/ai-guard.js),
// así que basta instrumentar ahí para tener el censo completo del burn.
// Este módulo persiste un agregado diario por (día, modelo) en Neon:
//
//   ai_usage_journal(day, model, calls, input_tokens, output_tokens,
//                    retries, cache_hits, updated_at)
//
// Diseño defensivo — el journal JAMÁS debe tumbar ni frenar una respuesta
// de IA:
//   - Gated por DATABASE_URL (sin DB → no-op) y por AI_USAGE_JOURNAL != '0'
//     (kill-switch).
//   - Upsert con timeout corto; si tarda o falla, se descarta.
//   - Circuit breaker: tras un fallo, se saltan las escrituras 60s para no
//     gravar cada llamada cuando Neon está caído.
//   - Fallback en memoria por instancia (lo que el read endpoint puede
//     mostrar aunque la DB no esté).
//
// El objetivo del contador (además del monitoreo diario) es delatar de
// inmediato si el modelo servido NO es haiku: `model` queda registrado en
// crudo, así que un opus/sonnet colado por env var salta a la vista.
//
// ENV VARS: DATABASE_URL (opcional) · AI_USAGE_JOURNAL (opcional, '0' apaga)
// ═══════════════════════════════════════════════════════════════

import { sql } from './db.js';

const WRITE_TIMEOUT_MS = 2000;
const BREAKER_COOLDOWN_MS = 60000;

// Fallback en memoria: sobrevive lo que dure la instancia de lambda.
const memTally = new Map(); // `${day}|${model}` → {calls, input_tokens, output_tokens, retries, cache_hits}

let breakerUntil = 0; // timestamp: mientras Date.now() < esto, no se escribe a DB
let schemaReady = false;

function enabled() {
  if (process.env.AI_USAGE_JOURNAL === '0') return false;
  return typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
}

function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function bumpMem(day, model, d) {
  const k = `${day}|${model}`;
  const cur = memTally.get(k) || { calls: 0, input_tokens: 0, output_tokens: 0, retries: 0, cache_hits: 0 };
  cur.calls += d.calls || 0;
  cur.input_tokens += d.input_tokens || 0;
  cur.output_tokens += d.output_tokens || 0;
  cur.retries += d.retries || 0;
  cur.cache_hits += d.cache_hits || 0;
  memTally.set(k, cur);
}

async function ensureSchema() {
  if (schemaReady) return;
  await sql(
    `create table if not exists ai_usage_journal (
       day date not null,
       model text not null,
       calls bigint not null default 0,
       input_tokens bigint not null default 0,
       output_tokens bigint not null default 0,
       retries bigint not null default 0,
       cache_hits bigint not null default 0,
       updated_at timestamptz not null default now(),
       primary key (day, model)
     )`);
  schemaReady = true;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('usage journal timeout')), ms)),
  ]);
}

// ── API: registrar una llamada (o un cache-hit) ──────────────────
// Nunca lanza. Extrae tokens de data.usage si viene. Un retry cuenta como
// 2 llamadas upstream (aprox: el gasto real exacto está en el Usage de la
// consola; esto es tendencia + verificación de modelo).
export async function recordAiCall({ model, usage, retried = false, stale = false, cacheHit = false, now = new Date() }) {
  const day = todayISO(now);
  const mdl = model || 'unknown';

  const delta = cacheHit
    ? { calls: 0, input_tokens: 0, output_tokens: 0, retries: 0, cache_hits: 1 }
    : {
        calls: retried || stale ? 2 : 1,
        input_tokens: (usage && Number(usage.input_tokens)) || 0,
        output_tokens: (usage && Number(usage.output_tokens)) || 0,
        retries: retried || stale ? 1 : 0,
        cache_hits: 0,
      };

  // Siempre actualiza el fallback en memoria (barato, no falla).
  bumpMem(day, mdl, delta);

  if (!enabled()) return;
  if (Date.now() < breakerUntil) return; // circuit breaker abierto

  try {
    await ensureSchema();
    await withTimeout(sql(
      `insert into ai_usage_journal (day, model, calls, input_tokens, output_tokens, retries, cache_hits, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (day, model) do update set
         calls = ai_usage_journal.calls + $3,
         input_tokens = ai_usage_journal.input_tokens + $4,
         output_tokens = ai_usage_journal.output_tokens + $5,
         retries = ai_usage_journal.retries + $6,
         cache_hits = ai_usage_journal.cache_hits + $7,
         updated_at = now()`,
      [day, mdl, delta.calls, delta.input_tokens, delta.output_tokens, delta.retries, delta.cache_hits]),
      WRITE_TIMEOUT_MS);
  } catch (_) {
    // Neon lento/caído: abre el breaker para no gravar las próximas llamadas.
    breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    schemaReady = false; // por si el fallo fue de schema, se reintenta luego
  }
}

// ── API: leer el burn diario (para /api/ai-usage) ────────────────
// Devuelve filas por (día, modelo) de los últimos `days` días. Si no hay DB
// o falla, cae al tally en memoria de esta instancia (parcial, pero útil).
export async function readDailyUsage(days = 7) {
  if (enabled()) {
    try {
      await ensureSchema();
      const rows = await withTimeout(sql(
        `select to_char(day,'YYYY-MM-DD') as day, model, calls, input_tokens, output_tokens, retries, cache_hits, updated_at
         from ai_usage_journal
         where day >= (current_date - ($1::int - 1))
         order by day desc, model asc`,
        [Math.max(1, Math.min(90, days))]),
        WRITE_TIMEOUT_MS);
      return { source: 'db', rows };
    } catch (_) { /* cae al fallback */ }
  }
  const rows = [...memTally.entries()].map(([k, v]) => {
    const [day, model] = k.split('|');
    return { day, model, ...v, updated_at: null };
  }).sort((a, b) => (b.day.localeCompare(a.day) || a.model.localeCompare(b.model)));
  return { source: enabled() ? 'db_unavailable_memory_fallback' : 'memory', rows };
}

// Hook de tests.
export function _resetUsage() { memTally.clear(); breakerUntil = 0; schemaReady = false; }
