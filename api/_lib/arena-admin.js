// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-admin.js — la COMPUERTA de los endpoints de admin del Arena.
//
// Vivía dentro de /api/arena-smoke. Se mudó acá porque dejó de tener un solo
// dueño: /api/arena-reset también la necesita, y ese endpoint LIQUIDA SIETE
// LIBROS — no puede depender de una copia de la lógica de autorización que
// pueda divergir de la original. Un candado duplicado es un candado con dos
// versiones, y la que falla es siempre la que nadie probó.
//
// `api/arena-smoke.js` la re-exporta para no romper a quien la importe de ahí
// (tests/arena-smoke-auth.test.mjs incluido): ese test prueba LA MISMA función
// que ahora corre en los dos endpoints.
//
// ENV VARS: ARENA_ADMIN_KEY (obligatoria; sin ella los endpoints dan 503).
// ═══════════════════════════════════════════════════════════════

import { createHash, timingSafeEqual } from 'node:crypto';

// ── LA COMPUERTA: cómo se lee ARENA_ADMIN_KEY ────────────────────────
// Tres formas, TODAS equivalentes y TODAS se prueban (la primera que coincide
// gana; que una venga mal no invalida a las otras — el bug viejo era ese: un
// `Authorization` presente pisaba el `?key=` y nunca se leía):
//
//   Authorization: Bearer <key>   ·   x-admin-key: <key>   ·   ?key=<key>
//
// `.trim()` en LOS DOS LADOS. El caso que más duele es el valor pegado en
// Vercel con un `\n` o un espacio al final: son bytes distintos y el 401 sale
// idéntico al de una key equivocada. Acá el trim lo perdona, y si igual no
// coincide el cuerpo del 401 dice qué llegó y por dónde — nunca la key.
const ADMIN_HEADERS = ['x-admin-key'];
const ADMIN_QUERY = ['key', 'admin_key'];

function firstString(v) {
  if (Array.isArray(v)) return v.length ? String(v[v.length - 1]) : '';
  return v == null ? '' : String(v);
}

// Node baja los nombres de header a minúsculas, pero un test o un runtime
// distinto puede no hacerlo: se busca sin distinguir mayúsculas.
function header(req, name) {
  const h = (req && req.headers) || {};
  if (h[name] != null) return firstString(h[name]);
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name);
  return hit ? firstString(h[hit]) : '';
}

// Cada candidato con SU PROCEDENCIA, para poder decir en el 401 por dónde llegó.
export function adminKeyCandidates(req) {
  const out = [];
  const auth = header(req, 'authorization').trim();
  if (auth) {
    const m = /^Bearer\s+([\s\S]*)$/i.exec(auth);
    // Sin el prefijo `Bearer` igual se acepta: mandar la key pelada en
    // Authorization es un error de dedo, no un intento de otra cosa.
    out.push({ source: m ? 'Authorization: Bearer' : 'Authorization (sin Bearer)', value: (m ? m[1] : auth).trim() });
  }
  for (const name of ADMIN_HEADERS) {
    const v = header(req, name).trim();
    if (v) out.push({ source: name, value: v });
  }
  const q = (req && req.query) || {};
  for (const name of ADMIN_QUERY) {
    const v = firstString(q[name]).trim();
    if (v) out.push({ source: '?' + name + '=', value: v });
  }
  return out;
}

// Comparación de largo constante. timingSafeEqual explota si los largos no
// coinciden, así que el largo se chequea antes (y el largo no es el secreto).
function sameSecret(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

// Huella de lo RECIBIDO, nunca de lo esperado: publicar el hash de la key a
// cualquiera que pegue un 401 es regalar material para romperla offline.
// Con esto el dueño compara del lado de su terminal y listo.
function fingerprint(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12);
}

// Nombres —NUNCA valores— de headers y query params que tienen pinta de traer
// una credencial y que este endpoint NO lee. Es la pista que resuelve el caso
// real: "la mandaste por `x-api-key`, que acá no se mira".
function keyishNames(obj, prefix, leidos) {
  const skip = new Set(leidos.map((k) => k.toLowerCase()));
  return Object.keys(obj || {})
    .map((k) => k.toLowerCase())
    .filter((k) => /key|token|secret|auth/i.test(k) && !skip.has(k))
    .map((k) => prefix + k)
    .sort();
}

const ACEPTA = [
  'Authorization: Bearer <ARENA_ADMIN_KEY>',
  'x-admin-key: <ARENA_ADMIN_KEY>',
  '?key=<ARENA_ADMIN_KEY>',
];
const EJEMPLO = 'curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-smoke?catalog=1"';

// Endpoints que pasan por esta compuerta. Se listan en el 503/401 para que el
// mensaje sirva igual venga de cual venga — un 503 que solo nombra al smoke
// manda a buscar el problema al endpoint equivocado cuando el que falló fue el
// reset.
export const ADMIN_ENDPOINTS = ['/api/arena-smoke', '/api/arena-reset'];

// Devuelve { ok:true } o { ok:false, status, body }. Exportada para que el
// test pruebe LA MISMA función que corre en producción.
// ── LA COMPUERTA DE LOS ENDPOINTS DE LECTURA ─────────────────────────
// `arena-audit` nació detrás de `CRON_SECRET` porque lo llamaba un cron. Pero
// también lo lee Lety desde una terminal, y en Vercel `CRON_SECRET` quedó
// marcada como Secret: no se puede volver a leer una vez guardada. O sea que
// el endpoint estaba efectivamente cerrado para la persona que lo necesita.
//
// Acepta CUALQUIERA de las dos: la del cron o la de admin (por header
// `x-admin-key`, `Authorization: Bearer` o `?key=`, las mismas tres puertas
// que el smoke). Dos llaves válidas no debilitan nada mientras las dos sean
// secretas — lo que debilita es que la única llave sea ilegible y termine
// pegada en un archivo para no perderla.
//
// SIN NINGUNA DE LAS DOS CONFIGURADA el endpoint queda abierto, como antes:
// es solo lectura y cerrarlo de golpe dejaría a un deploy existente sin
// auditoría. Pero deja de ser silencioso — la respuesta lo DICE, para que un
// despliegue sin protección se vea en vez de suponerse.
export function checkLecturaAuth(req, { cronSecret = process.env.CRON_SECRET, adminKey = process.env.ARENA_ADMIN_KEY } = {}) {
  const cron = String(cronSecret || '').trim();
  const admin = String(adminKey || '').trim();

  if (!cron && !admin) {
    return { ok: true, abierto: true, aviso: 'Ni CRON_SECRET ni ARENA_ADMIN_KEY están configuradas: este endpoint de lectura está ABIERTO. Poné una de las dos en Vercel y redeployá.' };
  }

  const cands = adminKeyCandidates(req);
  // `?secret=` es la puerta histórica del cron y se conserva: hay curls
  // guardados que la usan.
  const q = (req && req.query) || {};
  const secretQuery = firstString(q.secret).trim();
  if (secretQuery) cands.push({ source: '?secret=', value: secretQuery });

  for (const c of cands) {
    if (cron && sameSecret(c.value, cron)) return { ok: true, via: 'CRON_SECRET', fuente: c.source };
    if (admin && sameSecret(c.value, admin)) return { ok: true, via: 'ARENA_ADMIN_KEY', fuente: c.source };
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: 'No autorizado.',
      // QUÉ llaves acepta y por qué puertas. Nunca cuál es el valor.
      acepta: [
        ...(admin ? ['x-admin-key: <ARENA_ADMIN_KEY>', 'Authorization: Bearer <ARENA_ADMIN_KEY>', '?key=<ARENA_ADMIN_KEY>'] : []),
        ...(cron ? ['Authorization: Bearer <CRON_SECRET>', '?secret=<CRON_SECRET>'] : []),
      ],
      recibido: cands.length ? cands.map((c) => ({ fuente: c.source, chars: c.value.length })) : 'ninguna llave en la petición',
      ejemplo: admin
        ? 'curl -sS -H "x-admin-key: $ARENA_ADMIN_KEY" "$BASE/api/arena-audit?agent=control&format=md"'
        : 'curl -sS "$BASE/api/arena-audit?agent=control&format=md&secret=$CRON_SECRET"',
    },
  };
}

export function checkAdminAuth(req, rawEnv) {
  const raw = rawEnv == null ? '' : String(rawEnv);
  const expected = raw.trim();

  // Sin llave configurada el endpoint NO queda abierto: responde 503. Un smoke
  // que gasta en siete proveedores no puede depender de que nadie adivine la
  // URL — y "si no hay llave, dejá pasar" es el default que convierte eso en
  // una factura de otro.
  if (!expected) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'Falta ARENA_ADMIN_KEY: el smoke está deshabilitado hasta que se configure.',
        hint: raw
          ? 'ARENA_ADMIN_KEY existe pero está vacía (solo espacios). Ponele un valor en Vercel → Settings → Environment Variables y REDEPLOYÁ: las env vars entran al deploy, no al proyecto.'
          : 'Poné ARENA_ADMIN_KEY en Vercel → Settings → Environment Variables (marcá Production) y REDEPLOYÁ: una env var agregada después del último deploy no la ve la función.',
        acepta: ACEPTA,
      },
    };
  }

  const cands = adminKeyCandidates(req);
  if (cands.some((c) => sameSecret(c.value, expected))) return { ok: true };

  // ── El 401 con pista. Regla: se dice QUÉ FALTA, nunca la key. ──────
  const recibido = cands.map((c) => ({
    fuente: c.source,
    chars: c.value.length,
    mismo_largo_que_la_env: c.value.length === expected.length,
    huella_sha256_12: fingerprint(c.value),
    parece_entre_comillas: /^(".*"|'.*')$/.test(c.value),
  }));
  const headersPinta = keyishNames((req && req.headers) || {}, '', ['authorization', ...ADMIN_HEADERS]);
  const queryPinta = keyishNames((req && req.query) || {}, '?', ADMIN_QUERY);
  const envConEspacios = raw !== expected;
  const envEntreComillas = /^(".*"|'.*')$/.test(expected);

  let hint;
  if (!cands.length) {
    hint = 'No llegó NINGUNA key: ni `Authorization: Bearer`, ni el header `x-admin-key`, ni `?key=`.'
      + (headersPinta.length
        ? ` Sí llegaron estos headers con pinta de credencial: ${headersPinta.join(', ')} — ninguno de esos se lee.`
        : '');
  } else {
    const mismoLargo = recibido.find((r) => r.mismo_largo_que_la_env);
    const r = mismoLargo || recibido[0];
    hint = `La key llegó por \`${r.fuente}\` pero no coincide con ARENA_ADMIN_KEY. `
      + (r.mismo_largo_que_la_env
        ? 'Tiene el largo correcto, así que es OTRA key: revisá si se regeneró en Vercel sin redeployar, o si estás pegando la de otro entorno (Preview vs Production).'
        : `Tiene ${r.chars} chars y la de la env tiene otro largo. Los espacios y saltos de línea alrededor YA se ignoran (trim de los dos lados), así que no es eso: o se cortó al copiar, o viajan comillas pegadas al valor.`);
  }
  if (envEntreComillas) {
    hint += ' ⚠️ El valor de ARENA_ADMIN_KEY en el server empieza y termina con comillas: Vercel guarda el valor literal, no lo desescapa. Sacalas y redeployá.';
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: 'No autorizado.',
      hint,
      acepta: ACEPTA,
      recibido: recibido.length ? recibido : null,
      headers_que_no_se_leen: headersPinta.length ? headersPinta : null,
      query_que_no_se_lee: queryPinta.length ? queryPinta : null,
      env: {
        configurada: true,
        tenia_espacios_alrededor: envConEspacios,
        parece_entre_comillas: envEntreComillas,
      },
      como_comparar: 'En esta respuesta NO viaja ninguna key. `huella_sha256_12` es sha256 de lo que llegó: corré `printf %s "$ARENA_ADMIN_KEY" | shasum -a 256 | cut -c1-12` y comparalo. (`printf %s`, no `echo`: echo agrega un \\n y te da otra huella.)',
      ejemplo: EJEMPLO,
    },
  };
}
