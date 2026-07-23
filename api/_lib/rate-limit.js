// ═══════════════════════════════════════════════════════════════
// api/_lib/rate-limit.js — límite por IP para los endpoints de IA.
//
// Con el paywall abierto (PAYWALL_ENABLED ausente) NO hay ningún tope por
// usuario en las llamadas de IA: un crawler o bot puede martillar /api/claude
// y los 6 agentes sin freno. Este limitador es la primera línea contra eso:
// GENEROSO para un humano real (que lee segundos entre análisis), LETAL para
// un bot que dispara decenas por segundo.
//
// Token bucket por IP, en memoria por instancia de lambda:
//   - capacity   → ráfaga máxima instantánea (default 30).
//   - refill_ms  → se repone 1 token cada tanto (default 4s ⇒ ~15/min
//                  sostenido). Un humano jamás lo toca; un bot lo drena y
//                  cae en 429 con Retry-After.
//
// Limitación honesta: la memoria es POR INSTANCIA. Un bot distribuido en
// muchas instancias evade parte del tope. Para el caso dominante (una IP
// martillando ⇒ reutiliza la instancia caliente) es efectivo, y sumado a la
// caché por request+día baja el burn con fuerza. Si hace falta un tope global
// y consistente, el upgrade natural es Upstash/Redis o un contador en Neon.
//
// Fail-open: si no se puede determinar la IP, se DEJA pasar (mejor no tumbar
// tráfico legítimo detrás de un proxy raro que bloquear a ciegas).
//
// ENV VARS (todas opcionales):
//   AI_RATELIMIT_DISABLED = '1'   → apaga el limitador.
//   AI_RATELIMIT_CAPACITY = '30'  → tokens de ráfaga.
//   AI_RATELIMIT_REFILL_MS = '4000' → ms por token repuesto.
// ═══════════════════════════════════════════════════════════════

function intEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function config() {
  return {
    disabled: process.env.AI_RATELIMIT_DISABLED === '1',
    capacity: intEnv('AI_RATELIMIT_CAPACITY', 30),
    refillMs: intEnv('AI_RATELIMIT_REFILL_MS', 4000),
  };
}

// IP del cliente: Vercel pone x-forwarded-for (lista; el primero es el real).
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).split(',')[0].trim();
  if (typeof h['x-real-ip'] === 'string' && h['x-real-ip'].length) return h['x-real-ip'].trim();
  return null; // desconocida → fail-open
}

const BUCKETS = new Map(); // ip → { tokens, last }
const MAX_BUCKETS = 20000; // cota dura anti-crecimiento de memoria

function prune(now, refillMs, capacity) {
  // Evicción de buckets ociosos (ya rellenados al tope hace rato).
  const idleMs = refillMs * capacity * 2;
  for (const [ip, b] of BUCKETS) {
    if (now - b.last > idleMs) BUCKETS.delete(ip);
    if (BUCKETS.size <= MAX_BUCKETS) break;
  }
  // Si aún así está lleno, tira lo más viejo insertado.
  while (BUCKETS.size > MAX_BUCKETS) {
    const oldest = BUCKETS.keys().next().value;
    if (oldest === undefined) break;
    BUCKETS.delete(oldest);
  }
}

// Núcleo testeable: decide sin tocar req/res.
// Devuelve { allowed, retryAfterS, remaining }.
export function consumeToken(ip, now = Date.now(), cfg = config()) {
  if (cfg.disabled || !ip) return { allowed: true, retryAfterS: 0, remaining: cfg.capacity };

  let b = BUCKETS.get(ip);
  if (!b) {
    if (BUCKETS.size >= MAX_BUCKETS) prune(now, cfg.refillMs, cfg.capacity);
    b = { tokens: cfg.capacity, last: now };
    BUCKETS.set(ip, b);
  } else {
    // Repone según el tiempo transcurrido.
    const refill = Math.floor((now - b.last) / cfg.refillMs);
    if (refill > 0) {
      b.tokens = Math.min(cfg.capacity, b.tokens + refill);
      b.last = b.last + refill * cfg.refillMs;
    }
  }

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterS: 0, remaining: b.tokens };
  }
  // Sin tokens: cuánto falta para el próximo.
  const waitMs = cfg.refillMs - (now - b.last);
  return { allowed: false, retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)), remaining: 0 };
}

// Middleware: aplica el límite y, si toca, responde 429. Devuelve `true` si
// la request puede continuar, `false` si ya se respondió con 429.
// El caller: `if (!rateLimit(req, res)) return;`
export function rateLimit(req, res) {
  const ip = clientIp(req);
  const r = consumeToken(ip);
  if (r.allowed) {
    if (res && res.setHeader) res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    return true;
  }
  if (res && res.setHeader) res.setHeader('Retry-After', String(r.retryAfterS));
  res.status(429).json({
    error: 'rate_limited',
    detail: 'Demasiadas solicitudes de análisis desde esta IP. Esperá un momento y reintentá.',
    retry_after_s: r.retryAfterS,
  });
  return false;
}

// Hooks de tests.
export function _resetRateLimit() { BUCKETS.clear(); }
export function _bucketCount() { return BUCKETS.size; }
