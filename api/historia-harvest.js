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
// GATING DE ESCRITURA: `Authorization: Bearer <ADMIN_SECRET>` (fallback a
// CRON_SECRET), mismo patrón que api/xbrl-capture.js. **Sin secret
// configurado no se escribe** — fail closed. Este endpoint le pega a EDGAR
// con nuestro User-Agent y escribe en Neon; dejarlo abierto sería regalar
// las dos cosas.
//
// NO HAY ENTRADA EN `crons` DE vercel.json TODAVÍA, a propósito: un cron que
// corre contra un universo vacío es ruido diario. Se agrega cuando haya algo
// sembrado, y ahí la decisión 2 de §10 (diario para cubiertos) entra con
// `masViejoQue`.
//
// ENV VARS: DATABASE_URL · ADMIN_SECRET (o CRON_SECRET) · SEC_USER_AGENT (opc)
// ═══════════════════════════════════════════════════════════════

import { crearCliente, ErrorEdgar } from './_lib/edgar.js';
import { repo } from './_lib/historia-db.js';
import { sembrarUniverso, correrGoteo, ANIOS_FILINGS, ANIOS_FACTS } from './_lib/historia-ingesta.js';

const secreto = () => process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;

function autorizado(req) {
  const s = secreto();
  if (!s) return false;                       // fail closed
  return (req.headers.authorization || '') === `Bearer ${s}`;
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
      escritura: secreto()
        ? 'protegida (header Authorization: Bearer <ADMIN_SECRET>)'
        : 'DESHABILITADA — no hay ADMIN_SECRET ni CRON_SECRET configurado (fail closed)',
    });
  }

  if (!autorizado(req)) {
    return res.status(401).json({
      error: 'no autorizado',
      detalle: secreto()
        ? 'header Authorization: Bearer <ADMIN_SECRET>'
        : 'ADMIN_SECRET no configurado — la escritura está deshabilitada',
    });
  }

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
