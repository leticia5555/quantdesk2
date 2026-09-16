// ═══════════════════════════════════════════════════════════════════
// api/_lib/polymarket.js — frontera de red con Polymarket (Fase 0).
//
// DOS APIs públicas distintas, y la diferencia importa:
//   · Gamma  (gamma-api.polymarket.com) — catálogo: mercados y eventos, con
//     `question`, `description`, `endDate`, `outcomes`, `outcomePrices` y
//     `clobTokenIds`. Es donde se descubre QUÉ mercados existen.
//   · CLOB   (clob.polymarket.com)      — libro y precios: `prices-history`
//     por token. Es donde se baja el precio del "Yes" a T-24h.
//
// Esta capa NO interpreta nada: hace el request, clasifica la respuesta y
// devuelve el cuerpo crudo. Toda la lectura vive en _lib/earnings-beat.js
// (puro, testeable sin red) — mismo reparto que av-earnings.js / pead-hour.js.
//
// POR QUÉ CLASIFICA EN VEZ DE LANZAR: el censo de Fase 0 tiene que poder
// reportar "este endpoint contestó 404" como un HECHO, no morirse. Una fuente
// caída se declara; no se inventa. Por eso cada respuesta trae `status`,
// `http`, `ms` y los headers de rate limit que el servidor haya mandado.
//
// SIN AUTH: los dos endpoints que usa el censo son lectura pública. Si alguno
// contesta 401/403 el status es 'auth' y el censo lo reporta como tal — ese es
// justamente uno de los datos que la Fase 0 tiene que traer.
// ═══════════════════════════════════════════════════════════════════

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const UA = 'quantdesk2/1.0 (research; +https://quantdesk2.vercel.app)';

// Headers que dicen algo sobre el presupuesto de requests. Se capturan TODOS
// los que matcheen, sin asumir cuáles manda Polymarket: el censo reporta lo
// que vio y ahí se decide la cadencia de la Fase 1.
const RATE_HEADER_RE = /^(x-)?(rate-?limit|ratelimit)|^retry-after$/i;

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { for (const x of v) p.append(k, String(x)); continue; }
    p.append(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

// headers → objeto chico {nombre: valor} solo con los de rate limit.
function rateHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, name) => {
    if (RATE_HEADER_RE.test(name)) out[String(name).toLowerCase()] = String(value);
  });
  return out;
}

// Una llamada. NUNCA lanza: devuelve status clasificado.
//   ok        → body parseado
//   auth      → 401/403 (hay que autenticarse: dato de censo)
//   ratelimit → 429 (con los headers que hayan venido)
//   httperror → cualquier otro !ok (404 incluido: endpoint que no existe)
//   nonjson   → 200 con cuerpo que no es JSON
//   neterror  → timeout / DNS / TLS
async function pmFetch(base, path, params, { timeoutMs = 15000 } = {}) {
  const url = base + path + qs(params);
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { status: 'neterror', url, ms: Date.now() - t0, message: String((e && e.message) || e) };
  }
  const ms = Date.now() - t0;
  const headers = rateHeaders(r.headers);
  if (!r.ok) {
    let message = null;
    try { message = (await r.text()).slice(0, 300); } catch (e) { /* cuerpo ilegible: el código HTTP ya dice lo suyo */ }
    const status = r.status === 401 || r.status === 403 ? 'auth' : r.status === 429 ? 'ratelimit' : 'httperror';
    return { status, http: r.status, url, ms, headers, message };
  }
  let body;
  try {
    body = await r.json();
  } catch (e) {
    return { status: 'nonjson', http: r.status, url, ms, headers, message: (r.headers.get('content-type') || '') };
  }
  return { status: 'ok', http: r.status, url, ms, headers, body };
}

const gamma = (path, params, opts) => pmFetch(GAMMA_BASE, path, params, opts);
const clob = (path, params, opts) => pmFetch(CLOB_BASE, path, params, opts);

export { gamma, clob, pmFetch, qs, rateHeaders, GAMMA_BASE, CLOB_BASE, UA };
