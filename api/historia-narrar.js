// ═══════════════════════════════════════════════════════════════
// api/historia-narrar.js — el que gasta. Fase B, rebanada H.
//
//   GET /api/historia-narrar?ticker=MELI            → narra si hace falta
//   GET /api/historia-narrar?ticker=MELI&forzar=1   → narra aunque esté guardada
//   GET /api/historia-narrar?ticker=MELI&simular=1  → arma todo y NO llama
//
// ── POR QUÉ ESTO ES UNA PUERTA APARTE Y NO /api/historia ────────────
// Si la página narrara bajo demanda, **cada visita sería una llamada a Opus
// pagada**. Un bot, una pestaña que se recarga sola o un compartido que
// funciona bien son, con ese diseño, una factura. Y sería una factura
// invisible: la página se vería igual de bien en los dos casos.
//
// Así que la escritura tiene su propia puerta, autenticada y fail-closed, con
// las mismas tres llaves y cuatro puertas del goteo (_lib/historia-auth.js).
// `/api/historia` LEE lo que ya está guardado y, cuando no hay nada, lo dice
// en pantalla igual que dice `sin_documentos`. Un hueco declarado es un dato.
//
// ── LA NARRACIÓN NO SE REHACE PORQUE SÍ ─────────────────────────────
// La clave es el hash de (evidencia + versión del prompt + modelo). Si ya hay
// una narración servible con ese hash, no se llama: se devuelve `cacheada` y
// el costo es cero. La historia cambia cuando cambia un filing —o cuando
// cambiamos el prompt—, no cuando alguien abre la página.
//
// ── LO QUE SE GUARDA CUANDO FALLA ───────────────────────────────────
// Todo. La respuesta cruda del modelo se guarda incluso cuando el estado no
// es 'ok': si un guardia la rechaza hay que poder ver qué dijo, no solamente
// que la rechazó.
//
// ENV VARS: DATABASE_URL · ANTHROPIC_API_KEY
//           · una de ADMIN_SECRET / CRON_SECRET / ARENA_ADMIN_KEY
// ═══════════════════════════════════════════════════════════════

import { autorizar } from './_lib/historia-auth.js';
import { crearLectura, armarHistoria } from './_lib/historia-lectura.js';
import { respuestaEvidencia } from './_lib/historia-evidencia.js';
import { narrar, hashNarracion } from './_lib/historia-narrador.js';
import { repo } from './_lib/historia-db.js';

export const config = { maxDuration: 300 };

// El trabajo, con todos los colaboradores inyectables: este contenedor no
// tiene ni DATABASE_URL ni llave de Anthropic, así que la única manera de que
// esto esté probado y no solo escrito es que entren por parámetro.
export async function correrNarracion(ticker, {
  lectura,
  almacen = repo,
  llamar = narrar,
  apiKey = process.env.ANTHROPIC_API_KEY,
  forzar = false,
  simular = false,
  lang = 'es',
} = {}) {
  const { cuerpo } = await armarHistoria(lectura, ticker, { lang });
  if (cuerpo.estado !== 'ok') {
    return { status: 409, cuerpo: { ticker, estado: cuerpo.estado, detalle: cuerpo.detalle, narrada: false } };
  }

  const paq = respuestaEvidencia(cuerpo, { ticker });
  if (!paq.narrable) {
    return { status: 409, cuerpo: { ticker, estado: 'no_narrable', narrada: false } };
  }

  const hash = hashNarracion(paq.evidencia);
  const cik = cuerpo.emisor.cik;

  // Lo que ya está no se vuelve a pagar.
  if (!forzar) {
    const guardada = await almacen.narracionPorHash(cik, hash);
    if (guardada) {
      return {
        status: 200,
        cuerpo: {
          ticker, cik, hash, estado: 'ok', narrada: false, cacheada: true,
          creado_en: guardada.creado_en, costo: null,
          secciones: guardada.secciones,
        },
      };
    }
  }

  // `simular=1` arma el request entero y NO llama. Existe para poder ver el
  // costo que se VA a pagar antes de pagarlo.
  if (simular) {
    return {
      status: 200,
      cuerpo: {
        ticker, cik, hash, estado: 'simulado', narrada: false,
        evidencia_bytes: paq.bytes,
        inventario: paq.inventario.length,
        huerfanos: paq.huerfanos,
        excluidos_sin_cita: paq.excluidos_sin_cita,
      },
    };
  }

  const r = await llamar(paq.evidencia, { apiKey });

  // SE GUARDA SIEMPRE, cualquiera sea el estado.
  await almacen.guardarNarracion({
    cik,
    hash: r.hash,
    estado: r.estado,
    prompt_version: r.prompt_version,
    modelo: r.modelo_servido || r.modelo,
    huella_prompt: r.huella_prompt,
    secciones: r.estado === 'ok' ? r.secciones : null,
    crudo: r.crudo,
    costo: r.costo,
    detalle: r.detalle || r.categoria || null,
    evidencia_bytes: paq.bytes,
  });

  return {
    status: r.estado === 'ok' ? 200 : 502,
    cuerpo: {
      ticker, cik, hash: r.hash,
      estado: r.estado,
      narrada: r.estado === 'ok',
      cacheada: false,
      detalle: r.detalle || null,
      evidencia_bytes: paq.bytes,
      // El costo se devuelve SIEMPRE que haya habido llamada, incluso cuando
      // falló: se pagó igual, y no verlo es cómo una factura sorprende.
      costo: r.costo,
      secciones: r.estado === 'ok' ? r.secciones : null,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'solo GET o POST' });
  }

  const auth = autorizar(req);
  if (!auth.ok) return res.status(auth.status).json(auth.cuerpo);

  const ticker = String((req.query && req.query.ticker) || '').trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'falta el ticker', ruta: '/api/historia-narrar?ticker=MELI' });
  }
  const bandera = (n) => ['1', 'true', 'si', 'yes'].includes(String((req.query || {})[n] || '').toLowerCase());

  try {
    const { status, cuerpo } = await correrNarracion(ticker, {
      lectura: crearLectura({ lang: 'es' }),
      forzar: bandera('forzar'),
      simular: bandera('simular'),
    });
    return res.status(status).json({ ...cuerpo, via: auth.via });
  } catch (e) {
    return res.status(500).json({ ticker, error: 'narración fallida: ' + ((e && e.message) || 'desconocido') });
  }
}
