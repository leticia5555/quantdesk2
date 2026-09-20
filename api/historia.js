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

import { crearLectura, armarHistoria, armarNarracion } from './_lib/historia-lectura.js';
import { respuestaEvidencia } from './_lib/historia-evidencia.js';
import { autorizar } from './_lib/historia-auth.js';
import { repo } from './_lib/historia-db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'solo GET: este endpoint es de lectura' });

  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  const lang = String(req.query.lang || 'es').toLowerCase() === 'en' ? 'en' : 'es';
  // `?evidencia=1` devuelve EXACTAMENTE lo que la Fase B le va a pasar al
  // modelo, sin llamarlo. Existe para que se pueda mirar el paquete antes de
  // gastar en la llamada —y para medir su peso con datos reales en vez de
  // adivinarlo. Sigue siendo lectura: cero escrituras, cero IA.
  const verEvidencia = ['1', 'true', 'si', 'yes'].includes(String(req.query.evidencia || '').toLowerCase());

  if (!ticker) return res.status(400).json({ error: 'falta el ticker', ruta: '/api/historia/:ticker' });

  try {
    // El idioma entra también en la lectura: las glosas de los códigos se
    // resuelven donde se arman los documentos, no en la página.
    const { status, cuerpo } = await armarHistoria(crearLectura({ lang }), ticker, { lang });

    if (verEvidencia) {
      // La puerta de inspección va autenticada aunque no filtre nada: en
      // bucle le pega a Neon gratis desde una ruta pública, y además enseña
      // exactamente qué se le manda al modelo. Ninguna de las dos cosas tiene
      // por qué estar abierta.
      const auth = autorizar(req);
      if (!auth.ok) return res.status(auth.status).json(auth.cuerpo);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(respuestaEvidencia(cuerpo, { ticker }));
    }

    // La lectura escrita se LEE, no se genera acá: generarla bajo demanda
    // haría que cada visita fuera una llamada a Opus pagada. La genera
    // /api/historia-narrar, que está autenticada.
    if (cuerpo.estado === 'ok') {
      cuerpo.narracion = await armarNarracion(cuerpo, {
        buscar: (cik, hash) => repo.narracionPorHash(cik, hash),
        lang,
      });
    }
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
