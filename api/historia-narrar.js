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
import { guardar as guardarSalida } from './_lib/historia-guardia.js';

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
    return { status: 409, cuerpo: { ticker, estado: cuerpo.estado, detalle: cuerpo.detalle, narrada: false, intentos: 0 } };
  }

  const paq = respuestaEvidencia(cuerpo, { ticker });
  if (!paq.narrable) {
    return { status: 409, cuerpo: { ticker, estado: 'no_narrable', narrada: false, intentos: 0 } };
  }

  const hash = hashNarracion(paq.evidencia);
  const cik = cuerpo.emisor.cik;

  // ── NO SE LLAMA A LO QUE NO SE VA A PODER GUARDAR ───────────────────
  //
  // Esto existe por un gasto perdido real (§11.7). Antes, el orden efectivo
  // con `forzar=1` era: armar evidencia → llamar a Opus → guardar → truena,
  // porque la lectura previa de company_narracion se saltea con forzar. Se
  // pagó la llamada y se perdió la respuesta — y lo peor: la respuesta cruda
  // se guarda en esa fila, así que el resguardo vivía en la misma tabla que
  // falló.
  //
  // Que el orden quedara bien sin forzar era un accidente: una lectura que
  // pasaba a estar primero, no una garantía. Ahora es explícito y va antes de
  // TODOS los caminos que gastan.
  if (almacen.esquemaListo) {
    let listo = await almacen.esquemaListo();
    // Un intento de arreglarlo solo. `asegurarEsquema` es idempotente y es lo
    // mismo que corre el goteo al sembrar.
    if (!listo && almacen.asegurarEsquema) {
      await almacen.asegurarEsquema();
      listo = await almacen.esquemaListo();
    }
    if (!listo) {
      return {
        status: 503,
        cuerpo: {
          ticker, cik, hash, estado: 'sin_esquema', narrada: false, intentos: 0, costo: null,
          detalle: 'Falta la tabla company_narracion y no se pudo crear. NO se llamó al modelo: una llamada que no se va a poder guardar no se hace. Aplicá docs/sql/historia.sql o corré /api/historia-harvest?job=sembrar, que asegura el esquema.',
        },
      };
    }
  }

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
          // Cero llamadas en ESTA corrida. Que el campo esté siempre evita
          // tener que deducir de su ausencia si hubo llamada o no.
          intentos: 0,
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
        intentos: 0,
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
        intentos: 0,
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

  // ── EL GUARDIA, ANTES DE GUARDAR ────────────────────────────────────
  //
  // Acá y no en la lectura: una narración con una cita inventada no debe
  // llegar a existir como servible. Lo que se guarda en `secciones` es el
  // texto YA cortado, y lo que se cortó viaja en `cortes` para que la página
  // lo declare. La respuesta cruda del modelo queda intacta en `crudo`, así
  // que siempre se puede ver qué dijo antes del corte.
  //
  // Los accessions válidos salen del inventario del MISMO paquete que se le
  // mandó: la lista es cerrada por construcción, no una segunda lista que se
  // pueda separar.
  let cortes = null;
  let estadoFinal = r.estado;
  let seccionesFinales = r.estado === 'ok' ? r.secciones : null;
  if (r.estado === 'ok') {
    const citables = new Set(paq.inventario.map((x) => x.accession));
    const g = guardarSalida(r.secciones, citables);
    cortes = g.cortes.length ? { lista: g.cortes, resumen: g.resumen } : null;
    estadoFinal = g.estado;
    seccionesFinales = g.secciones.length ? g.secciones : null;
  }

  // SE GUARDA SIEMPRE, cualquiera sea el estado.
  //
  // Y si el guardado falla, la respuesta se lleva TODO lo que se pagó. No es
  // paranoia: el resguardo de la cruda es esta misma fila, así que cuando la
  // escritura falla el único lugar que queda para lo que costó plata es la
  // respuesta HTTP. Un fallo que costó plata tiene que decir cuánto costó —
  // y entregar lo que se compró.
  try {
    await almacen.guardarNarracion({
      cik,
      hash: r.hash,
      estado: estadoFinal,
      prompt_version: r.prompt_version,
      modelo: r.modelo_servido || r.modelo,
      huella_prompt: r.huella_prompt,
      secciones: seccionesFinales,
      cortes,
      // La cruda del ÚLTIMO intento, SIN cortar: es la única manera de ver
      // qué dijo el modelo antes de que el guardia lo tocara.
      crudo: r.crudo,
      costo,
      detalle: r.detalle || r.categoria || null,
      evidencia_bytes: paq.bytes,
      intentos: intentos.length,
    });
  } catch (e) {
    return {
      status: 502,
      cuerpo: {
        ticker, cik, hash,
        estado: 'guardado_fallido',
        narrada: false,
        intentos: intentos.length,
        detalle: `La llamada se hizo y se pagó, pero no se pudo guardar: ${(e && e.message) || e}. Lo que sigue es lo único que queda de esta corrida.`,
        costo,
        // En qué había terminado el modelo, que si no se pierde con la fila.
        estado_modelo: r.estado,
        // Lo que se compró va ACÁ, porque en la tabla no entró.
        secciones: seccionesFinales,
        cortes,
        crudo_no_guardado: r.crudo,
      },
    };
  }

  const sirve = estadoFinal === 'ok' || estadoFinal === 'ok_con_cortes';
  return {
    status: sirve ? 200 : 502,
    cuerpo: {
      ticker, cik, hash: r.hash,
      estado: estadoFinal,
      narrada: sirve,
      cacheada: false,
      // Qué cortó el guardia, en el resumen. La lista entera queda en la fila.
      cortes: cortes ? cortes.resumen : null,
      detalle: r.detalle || null,
      evidencia_bytes: paq.bytes,
      // Cuántas llamadas se pagaron en ESTA corrida, a la vista.
      intentos: intentos.length,
      // El costo se devuelve SIEMPRE que haya habido llamada, incluso cuando
      // falló: se pagó igual, y no verlo es cómo una factura sorprende.
      costo,
      secciones: seccionesFinales,
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
