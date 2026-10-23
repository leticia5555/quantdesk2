// ═══════════════════════════════════════════════════════════════
// api/_lib/openrouter-saldo.js — el saldo de OpenRouter, leído y publicado.
//
// EL CASO (2026-10-21, día 2 de la T3). A las 18:15 UTC OpenRouter respondió
// 402: la cuenta se había quedado sin créditos. Los cinco agentes de
// OpenRouter dependen de ESA cuenta, y nadie lo vio venir: el saldo no se
// miraba en ningún lado.
//
// Lo que hace esto: el vigilante lee el saldo al empezar cada ciclo, lo guarda
// en `arena_watch_meta` y /liga y /api/arena-audit lo publican. Si baja del
// piso (`ARENA_OPENROUTER_PISO_USD`, default 10) se publica como AVISO.
//
// NUNCA FRENA LA LIGA. Un saldo bajo es un aviso, no una compuerta: frenar a
// los siete por una lectura de observabilidad sería cambiar un problema por
// otro peor (el mismo criterio que el FAIL OPEN de `currentTier`). Si el saldo
// llega a cero, el 402 de cada agente queda journaleado con causa `cuenta`.
//
// DOS ENDPOINTS, en orden:
//   GET /api/v1/credits  → { data: { total_credits, total_usage } }
//   GET /api/v1/auth/key → { data: { limit, usage, limit_remaining } }
// El primero es el saldo de la CUENTA; el segundo el límite de la KEY, que
// puede ser más chico que la cuenta. Si el primero no contesta (una key que no
// tiene permiso para verlo), se usa el segundo y se dice cuál fue.
// ═══════════════════════════════════════════════════════════════

const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 4000;
export const PISO_DEFAULT_USD = 10;
export const CLAVE_META = 'openrouter_saldo';

export function pisoSaldo(env = process.env) {
  const n = Number(env && env.ARENA_OPENROUTER_PISO_USD);
  return Number.isFinite(n) && n >= 0 && String(env.ARENA_OPENROUTER_PISO_USD).trim() !== '' ? n : PISO_DEFAULT_USD;
}

const num = (x) => (x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));

async function pedir(ruta, apiKey, fetchImpl) {
  const r = await fetchImpl(BASE + ruta, {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${ruta} HTTP ${r.status}`);
  return r.json();
}

// Nunca lanza: `{ usd, fuente, at }` o `{ usd: null, error, at }`.
export async function leerSaldoOpenRouter({ apiKey = process.env.OPENROUTER_API_KEY, now = new Date(), fetchImpl = fetch } = {}) {
  const at = now.toISOString();
  if (!apiKey) return { usd: null, error: 'sin OPENROUTER_API_KEY', at };
  const errores = [];
  try {
    const j = await pedir('/credits', apiKey, fetchImpl);
    const d = (j && j.data) || {};
    const total = num(d.total_credits), usado = num(d.total_usage);
    if (total != null && usado != null) return { usd: +(total - usado).toFixed(2), fuente: 'credits', at };
    errores.push('/credits sin total_credits/total_usage');
  } catch (e) { errores.push(String((e && e.message) || e)); }
  try {
    const j = await pedir('/auth/key', apiKey, fetchImpl);
    const d = (j && j.data) || {};
    const restante = num(d.limit_remaining);
    if (restante != null) return { usd: +restante.toFixed(2), fuente: 'auth/key (límite de la key)', at };
    errores.push('/auth/key sin limit_remaining (key sin límite)');
  } catch (e) { errores.push(String((e && e.message) || e)); }
  return { usd: null, error: errores.join(' · '), at };
}

// Pura: lo que se publica. `bajo` solo es true con un número que lo diga — una
// lectura fallida NO es "saldo bajo", es "no sabemos", y se dice así.
export function estadoSaldo(lectura, piso = PISO_DEFAULT_USD) {
  if (!lectura) return null;
  const usd = num(lectura.usd);
  const bajo = usd != null && usd < piso;
  return {
    usd, piso, bajo, fuente: lectura.fuente || null, at: lectura.at || null,
    ...(lectura.error ? { error: lectura.error } : {}),
    aviso: usd == null
      ? `No se pudo leer el saldo de OpenRouter (${lectura.error || 'sin dato'}). No es saldo bajo: no sabemos.`
      : bajo
        ? `SALDO DE OPENROUTER BAJO: $${usd.toFixed(2)}, por debajo del piso de $${piso}. Los cinco agentes de OpenRouter dependen de esa cuenta: sin créditos, cada corrida aborta con causa "cuenta" (nuestra, no del modelo).`
        : null,
  };
}
