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

import { autorizar } from './_lib/historia-auth.js';
import { crearCliente, ErrorEdgar } from './_lib/edgar.js';
import { repo } from './_lib/historia-db.js';
import { sembrarUniverso, correrGoteo, ANIOS_FILINGS, ANIOS_FACTS } from './_lib/historia-ingesta.js';

// La autorización vive en _lib/historia-auth.js: la comparten este endpoint y
// el narrador, y tener dos copias de "quién puede gastar plata nuestra" es
// tener dos reglas que con el tiempo dicen cosas distintas.
export { LLAVES, llavesDeLaPeticion, llavesConfiguradas, autorizar } from './_lib/historia-auth.js';

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
