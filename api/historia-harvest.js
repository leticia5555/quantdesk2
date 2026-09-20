// ═══════════════════════════════════════════════════════════════
// api/historia-harvest.js — el runner del goteo de HISTORIA.
//
//   GET /api/historia-harvest                        → estado, sin escribir
//   GET /api/historia-harvest?job=sembrar&tickers=…  → resuelve tickers a CIK
//   GET /api/historia-harvest?job=goteo&limite=7     → ingiere un turno
//
// POR QUÉ ES UN JOB Y NO UNA INGESTA BAJO DEMANDA. No es una preferencia: la
// corrida 2 midió **42 s y 16 llamadas por ticker** (docs/historia-fase0.md
// §11, G4). Un lambda de 60 s no alcanza para uno solo con margen, así que la
// ingesta dentro de un request quedó descartada por medición. Con
// `maxDuration: 300` entran ~7 por invocación, que es el default de `limite`
// y de `repo.pendientes()`.
//
// ── GATING DE ESCRITURA: TRES LLAVES, CUATRO PUERTAS, FAIL CLOSED ───
// Acepta `ADMIN_SECRET`, `CRON_SECRET` o `ARENA_ADMIN_KEY`, por `x-admin-key`,
// `Authorization: Bearer`, `?key=` o `?secret=`.
//
// No es laxitud: es la lección que ya pagó api/arena-audit.js. En Vercel una
// env var marcada como Secret NO se puede volver a leer, así que un endpoint
// con una sola llave termina teniendo una llave ilegible para quien la
// necesita — y de ahí a pegarla en un archivo para no perderla hay un paso.
// Varias llaves válidas no debilitan nada; una llave ilegible sí.
//
// Lo que NO se copia de arena-audit es su fail-OPEN: `checkLecturaAuth` deja
// el endpoint abierto cuando no hay ninguna llave configurada, y eso está bien
// para una LECTURA. Esto escribe en Neon y le pega a EDGAR con nuestro
// User-Agent: sin llave contesta **503**, nunca abierto. Un 401 diría "tu
// llave está mal"; el problema es del servidor, y el mensaje lo dice.
//
// NO HAY ENTRADA EN `crons` DE vercel.json TODAVÍA, a propósito: un cron que
// corre contra un universo vacío es ruido diario. Se agrega cuando haya algo
// sembrado, y ahí la decisión 2 de §10 (diario para cubiertos) entra con
// `masViejoQue`.
//
// ENV VARS: DATABASE_URL · una de ADMIN_SECRET / CRON_SECRET / ARENA_ADMIN_KEY
//           · SEC_USER_AGENT (opc)
// ═══════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto';
import { crearCliente, ErrorEdgar } from './_lib/edgar.js';
import { repo } from './_lib/historia-db.js';
import { sembrarUniverso, correrGoteo, ANIOS_FILINGS, ANIOS_FACTS } from './_lib/historia-ingesta.js';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const job = String(req.query.job || '').toLowerCase();

  if (!job) {
    return res.status(200).json({
      modulo: 'historia',
      estado: 'listo',
      ventanas: { filings_anios: ANIOS_FILINGS, facts_anios: ANIOS_FACTS },
      rutas: {
        '?job=sembrar&tickers=LULU,MSFT,MELI,VIST': 'protegido — resuelve tickers a CIK y los deja pendientes',
        '?job=goteo&limite=7': 'protegido — ingiere un turno (~42 s por ticker, medido en la corrida 2)',
      },
      escritura: llavesConfiguradas().length
        ? {
          estado: 'protegida',
          // Los NOMBRES de las llaves que sirven, nunca sus valores. Que el
          // estado diga cuáles están puestas ahorra el viaje de adivinar.
          llaves: llavesConfiguradas(),
          puertas: ['x-admin-key', 'Authorization: Bearer', '?key=', '?secret='],
        }
        : {
          estado: 'DESHABILITADA',
          detalle: `fail closed: ninguna de ${LLAVES.join(', ')} está configurada, así que hoy no escribiría nada aunque tuvieras la llave`,
        },
    });
  }

  const auth = autorizar(req);
  if (!auth.ok) return res.status(auth.status).json(auth.cuerpo);

  const cli = crearCliente();

  try {
    if (job === 'sembrar') {
      const tickers = String(req.query.tickers || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!tickers.length) return res.status(400).json({ error: 'falta ?tickers=LULU,MSFT' });
      await repo.asegurarEsquema();
      const r = await sembrarUniverso(cli, repo, tickers);
      return res.status(200).json({ job, ...r, llamadas: cli.stats().llamadas });
    }

    if (job === 'goteo') {
      const limite = Math.min(Number(req.query.limite) || 7, 20);
      const masViejoQue = req.query.mas_viejo_que || null;
      const r = await correrGoteo(cli, repo, { limite, masViejoQue });
      const s = cli.stats();
      return res.status(200).json({
        job,
        ...r,
        // El costo real de este turno, para contrastarlo con los 42 s/ticker
        // de la corrida 2 en vez de suponer que se mantienen.
        red: { llamadas: s.llamadas, bytes: s.bytes, reintentos: s.reintentos, p50: s.p50, p95: s.p95 },
      });
    }

    return res.status(400).json({ error: `job desconocido: ${job}` });
  } catch (e) {
    // Un 403 de EDGAR y un error de Neon se arreglan distinto: el mensaje
    // tiene que decir cuál de los dos fue.
    const esEdgar = e instanceof ErrorEdgar;
    return res.status(esEdgar && e.status === 429 ? 429 : 500).json({
      error: esEdgar ? `EDGAR: ${e.message}` : String(e && e.message ? e.message : e),
      clase: esEdgar ? e.clase : 'interno',
    });
  }
}
