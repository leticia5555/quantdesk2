// ═══════════════════════════════════════════════════════════════
// /api/historia/:ticker — la historia de una empresa, SOLO LECTURA.
//
//   GET /api/historia/MELI          (reescrito a /api/historia?ticker=MELI)
//   GET /api/historia?ticker=MELI&lang=en
//
// Las 7 secciones del esqueleto, cada una con sus documentos, su fecha, su
// enlace y su cita. **Esta fase no narra**: no hay IA, no hay párrafos, no hay
// veredicto. Lo que devuelve es lo que está en los filings y el identificador
// para ir a verlo.
//
// Este archivo es SOLO el cableado HTTP. Lo que arma la respuesta vive en
// api/_lib/historia-lectura.js, y está ahí para que los estados `sin_ingesta`
// y `desconocido` —los dos que más fácil mienten— se puedan probar sin base
// de datos.
//
// ── CERO ESCRITURAS, Y NO SE INGIERE AL VUELO ───────────────────────
// Un ticker sin ingerir devuelve `sin_ingesta` con el estado explícito. La
// tentación sería ingerirlo en el request y contestar "bonito" — pero la
// corrida 2 midió **42 s por ticker** (docs/historia-fase0.md §11, G4), así
// que eso sería un timeout disfrazado de feature. La ingesta es el goteo de
// /api/historia-harvest.
//
// ── LOS TRES VACÍOS SE DISTINGUEN ───────────────────────────────────
// `sin_documentos` (se cubre, se buscó, no hay) · `no_cubierta` (no miramos
// esa fuente) · `fuera_del_modulo` (existe en QuantDesk, no en EDGAR). Un
// hueco sin etiqueta es indistinguible de un error, y "no hay 13D" y "no
// miramos 13D" llevan a decisiones opuestas.
//
// ENV VARS: DATABASE_URL.
// ═══════════════════════════════════════════════════════════════

import { crearLectura, armarHistoria } from './_lib/historia-lectura.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'solo GET: este endpoint es de lectura' });

  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  const lang = String(req.query.lang || 'es').toLowerCase() === 'en' ? 'en' : 'es';

  if (!ticker) return res.status(400).json({ error: 'falta el ticker', ruta: '/api/historia/:ticker' });

  try {
    // El idioma entra también en la lectura: las glosas de los códigos se
    // resuelven donde se arman los documentos, no en la página.
    const { status, cuerpo } = await armarHistoria(crearLectura({ lang }), ticker, { lang });
    // Los filings son inmutables y la ingesta es diaria: media hora de caché
    // en el CDN no envejece nada y descarga a Neon. Lo que todavía no se
    // ingirió no se cachea: su estado cambia en cuanto corre el goteo.
    if (cuerpo.estado === 'ok') {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.status(status).json(cuerpo);
  } catch (e) {
    return res.status(500).json({
      ticker,
      error: 'lectura fallida: ' + (e && e.message ? e.message : 'desconocido'),
    });
  }
}
