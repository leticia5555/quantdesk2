// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-auth.js — el gating de escritura de HISTORIA.
//
// Tres llaves, cuatro puertas, FAIL CLOSED. Vive acá —y no dentro de un
// endpoint— porque hay más de uno que escribe: el goteo (que le pega a EDGAR
// con nuestro User-Agent) y el narrador (que le pega a Anthropic con nuestra
// tarjeta). Tenerlo duplicado habría sido tener dos versiones de "quién puede
// gastar plata nuestra", y esas dos versiones se separan.
//
// ── POR QUÉ VARIAS LLAVES ───────────────────────────────────────────
// Acepta `ADMIN_SECRET`, `CRON_SECRET` o `ARENA_ADMIN_KEY`, por `x-admin-key`,
// `Authorization: Bearer`, `?key=` o `?secret=`.
//
// No es laxitud: es la lección que ya pagó api/arena-audit.js. En Vercel una
// env var marcada como Secret NO se puede volver a leer, así que un endpoint
// con una sola llave termina teniendo una llave ilegible para quien la
// necesita — y de ahí a pegarla en un archivo para no perderla hay un paso.
// Varias llaves válidas no debilitan nada; una llave ilegible sí.
//
// ── POR QUÉ FAIL CLOSED, Y NO COMO arena-audit ──────────────────────
// Lo que NO se copia de arena-audit es su fail-OPEN: `checkLecturaAuth` deja
// el endpoint abierto cuando no hay ninguna llave configurada, y eso está bien
// para una LECTURA. Esto habilita escrituras y gasto: sin llave contesta
// **503**, nunca abierto. Un 401 diría "tu llave está mal"; el problema es del
// servidor, y el mensaje lo dice.
// ═══════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto';

// Deliberadamente NO se importa `adminKeyCandidates` de _lib/arena-admin.js,
// aunque haga casi esto mismo: hay otra sesión trabajando en el Arena en
// paralelo y colgar la autorización de Historia de un archivo que se está
// moviendo es pedir un fallo ajeno. Cuando las dos se estabilicen, unificarlas
// en un _lib compartido es un PR propio, no un efecto colateral de éste.

export const LLAVES = ['ADMIN_SECRET', 'CRON_SECRET', 'ARENA_ADMIN_KEY'];

const texto = (v) => {
  if (Array.isArray(v)) return v.length ? String(v[v.length - 1]) : '';
  return v == null ? '' : String(v);
};

const header = (req, nombre) => {
  const h = (req && req.headers) || {};
  if (h[nombre] != null) return texto(h[nombre]);
  const k = Object.keys(h).find((x) => x.toLowerCase() === nombre);
  return k ? texto(h[k]) : '';
};

// Cada candidata con su procedencia, para poder decir en el 401 por dónde
// llegó sin decir nunca cuánto vale.
export function llavesDeLaPeticion(req) {
  const out = [];
  const auth = header(req, 'authorization').trim();
  if (auth) {
    const m = /^Bearer\s+([\s\S]*)$/i.exec(auth);
    // Sin el prefijo `Bearer` se acepta igual: mandar la llave pelada es un
    // error de dedo, no un intento de otra cosa.
    out.push({ fuente: m ? 'Authorization: Bearer' : 'Authorization (sin Bearer)', valor: (m ? m[1] : auth).trim() });
  }
  const h = header(req, 'x-admin-key').trim();
  if (h) out.push({ fuente: 'x-admin-key', valor: h });
  const q = (req && req.query) || {};
  for (const nombre of ['key', 'secret']) {
    const v = texto(q[nombre]).trim();
    if (v) out.push({ fuente: `?${nombre}=`, valor: v });
  }
  return out;
}

// Comparación de largo constante. timingSafeEqual explota si los largos no
// coinciden, así que el largo se chequea antes — y el largo no es el secreto.
function mismaLlave(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (A.length !== B.length || A.length === 0) return false;
  return timingSafeEqual(A, B);
}

export const llavesConfiguradas = (env = process.env) =>
  LLAVES.filter((n) => String(env[n] || '').trim().length > 0);

export function autorizar(req, env = process.env) {
  const configuradas = llavesConfiguradas(env);

  // Sin ninguna llave el endpoint NO queda abierto. Y no es 401: el que se
  // equivocó es el servidor, no quien llama.
  if (!configuradas.length) {
    return {
      ok: false,
      status: 503,
      cuerpo: {
        error: 'escritura deshabilitada',
        detalle: `No hay ninguna llave configurada en el server. Poné una de ${LLAVES.join(', ')} en Vercel y redeployá.`,
        acepta: LLAVES,
      },
    };
  }

  const candidatas = llavesDeLaPeticion(req);
  for (const c of candidatas) {
    for (const nombre of configuradas) {
      if (mismaLlave(c.valor, env[nombre])) return { ok: true, via: nombre, fuente: c.fuente };
    }
  }

  return {
    ok: false,
    status: 401,
    cuerpo: {
      error: 'no autorizado',
      // QUÉ llaves acepta y por qué puertas. Nunca cuál es el valor.
      acepta: configuradas.flatMap((n) => [`x-admin-key: <${n}>`, `Authorization: Bearer <${n}>`, `?key=<${n}>`]),
      // Qué llegó, sin filtrarlo: el largo no es el secreto y ahorra media
      // hora de "pero si la mandé".
      recibido: candidatas.length
        ? candidatas.map((c) => ({ fuente: c.fuente, chars: c.valor.length }))
        : 'ninguna llave en la petición',
      ejemplo: `curl -sS -H "x-admin-key: $${configuradas[0]}" "$BASE/api/historia-harvest?job=goteo&limite=4"`,
    },
  };
}
