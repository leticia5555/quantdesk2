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
import { conErrorJson } from './_lib/historia-http.js';
import { crearLectura, armarHistoria } from './_lib/historia-lectura.js';
import { respuestaEvidencia } from './_lib/historia-evidencia.js';
import {
  narrar, hashNarracion, sumarCostos, MAX_TOKENS, MAX_TOKENS_REINTENTO, MAX_INTENTOS,
} from './_lib/historia-narrador.js';
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

  // Lo que hubo antes en este hash, sirva o no: hace falta para las dos
  // decisiones de abajo (no re-narrar lo que ya está, y no reintentar para
  // siempre lo que ya se pagó dos veces).
  const previo = almacen.intentoPrevio ? await almacen.intentoPrevio(cik, hash) : null;

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

  // ── EL REINTENTO, CON TOPE ──────────────────────────────────────────
  //
  // Una narración cortada con la misma evidencia, el mismo prompt y el mismo
  // modelo se vuelve a cortar: el reintento ciego son dos llamadas pagadas
  // por cada narración que no cabe, y falla en silencio.
  //
  // Lo único que puede cambiar el resultado es el techo, así que el reintento
  // lo sube UNA vez y después se para. Y como el conteo se acumula en la
  // fila, una narración que ya gastó sus dos intentos no se vuelve a intentar
  // en la visita siguiente — que es como un tope se convierte en infinito en
  // cuotas.
  const gastados = (previo && previo.intentos) || 0;
  if (!forzar && previo && previo.estado === 'cortada' && gastados >= MAX_INTENTOS) {
    return {
      status: 409,
      cuerpo: {
        ticker, cik, hash, estado: 'cortada_definitiva', narrada: false, costo: null,
        intentos_gastados: gastados,
        detalle: `Se cortó ${gastados} veces, la segunda con el techo en ${MAX_TOKENS_REINTENTO}. No se reintenta: con la misma evidencia el resultado no cambia. Usá forzar=1 si querés pagarlo igual.`,
      },
    };
  }

  const intentos = [];
  let r = await llamar(paq.evidencia, { apiKey, maxTokens: MAX_TOKENS });
  intentos.push(r);

  if (r.estado === 'cortada' && gastados + intentos.length < MAX_INTENTOS) {
    r = await llamar(paq.evidencia, { apiKey, maxTokens: MAX_TOKENS_REINTENTO });
    intentos.push(r);
  }

  // El costo es la SUMA de lo que se pagó, no lo del último intento. Si no,
  // el número miente hacia abajo y el intento que falló —el que más ganas dan
  // de no mirar— desaparece de la cuenta justamente porque falló.
  const costo = sumarCostos(intentos.map((i) => i.costo));

  // SE GUARDA SIEMPRE, cualquiera sea el estado.
  await almacen.guardarNarracion({
    cik,
    hash: r.hash,
    estado: r.estado,
    prompt_version: r.prompt_version,
    modelo: r.modelo_servido || r.modelo,
    huella_prompt: r.huella_prompt,
    secciones: r.estado === 'ok' ? r.secciones : null,
    // La cruda del ÚLTIMO intento, que es el que decidió el estado.
    crudo: r.crudo,
    costo,
    detalle: r.detalle || r.categoria || null,
    evidencia_bytes: paq.bytes,
    intentos: intentos.length,
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
      // Cuántas llamadas se pagaron en ESTA corrida, a la vista.
      intentos: intentos.length,
      // El costo se devuelve SIEMPRE que haya habido llamada, incluso cuando
      // falló: se pagó igual, y no verlo es cómo una factura sorprende.
      costo,
      secciones: r.estado === 'ok' ? r.secciones : null,
    },
  };
}

async function handler(req, res) {
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

// Envuelto para que CUALQUIER excepción salga como JSON y no como la página
// HTML de Vercel: esto se consume con `jq`, y un error legible es la
// diferencia entre leerlo y adivinarlo (§11.6).
export default conErrorJson(handler, { ruta: '/api/historia-narrar' });
