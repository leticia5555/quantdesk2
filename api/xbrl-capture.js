// ═══════════════════════════════════════════════════════════════
// /api/xbrl-capture — captura del XBRL trimestral de BMV a Neon.
//
// POR QUÉ ESTO CORRE CONTRA RELOJ: BMV publica gratis SÓLO el trimestre
// vigente por emisora. Cuando salga el 3T2026 (finales de octubre), el 2T2026
// desaparece de la página gratis y el histórico sólo se consigue comprándolo
// (docs/xbrl-fase0.md §1.2, §3.2). O sea que el feed gratis es de
// MANTENIMIENTO, no de backfill: cada trimestre que no se capture hay que
// comprarlo después.
//
//   GET ?smoke=1              → público, SOLO LECTURA. Baja WALMEX y FEMSA,
//                               parsea y compara contra los valores de Fase 0.
//                               No escribe en Neon. Devuelve paso a paso.
//   GET ?run=1                → protegido. Recorre emisoras.json, captura lo
//                               que falte y escribe en Neon. Idempotente.
//   GET                       → ayuda + estado de la tabla (público).
//
// GATING de escritura: `Authorization: Bearer <ADMIN_SECRET>` (fallback a
// CRON_SECRET), mismo patrón que /api/macro-events. Sin secret configurado NO
// se escribe: fail closed.
//
// CORTESÍA CON BMV: 1 request/segundo, User-Agent identificado con contacto,
// un reintento sólo en 5xx (nunca en 4xx: un 404 es "no está", no "falló").
//
// CERO llamadas a Claude. Esto es determinista de punta a punta.
//
// ENV VARS: DATABASE_URL · ADMIN_SECRET (o CRON_SECRET) · XBRL_CONTACT (opcional)
// ═══════════════════════════════════════════════════════════════

import { sql, ensureSchema } from './_lib/db.js';
import { extraerDeZip, CAMPOS, EXTRAS } from './_lib/xbrl-parse.js';
import EMISORAS from './_lib/emisoras.json' with { type: 'json' };

const BASE = 'https://www.bmv.com.mx';
const PAUSA_MS = 1000;                 // 1 request/segundo
const TIMEOUT_MS = 30000;

function contacto() {
  return process.env.XBRL_CONTACT || 'https://github.com/leticia5555/quantdesk2';
}
function userAgent() {
  return `quantdesk-xbrl-capture/1.0 (+${contacto()})`;
}

function adminSecret() {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;
}
function authorized(req) {
  const secret = adminSecret();
  if (!secret) return false;                     // fail closed
  const h = req.headers.authorization || '';
  if (h === `Bearer ${secret}`) return true;
  // Vercel Cron manda su propio header; se acepta si coincide con CRON_SECRET.
  return !!process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── fetch con cortesía ──────────────────────────────────────────── */

/**
 * Un reintento SÓLO en 5xx o error de red. Un 4xx no se reintenta: si BMV dice
 * 404, el documento no está, y martillar no lo va a materializar.
 */
async function traer(url, { binario = false } = {}) {
  for (let intento = 1; intento <= 2; intento++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: binario ? '*/*' : 'text/html,*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (intento === 2) throw new Error(`red: ${e.message}`);
      await dormir(PAUSA_MS * 2);
      continue;
    }
    if (res.status >= 500 && intento === 1) { await dormir(PAUSA_MS * 2); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return binario ? Buffer.from(await res.arrayBuffer()) : await res.text();
  }
  throw new Error('agotados los intentos');
}

/* ── la fila del XBRL en la página de la emisora ─────────────────── */

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };

/**
 * "23-Jul-2026 14:11" → "2026-07-23T14:11:00Z".
 * Esta fecha-hora es la de ENVÍO a BMV, que es la que evita look-ahead
 * (decisión D8, docs/xbrl-fase0.md §2.5). No está dentro del XBRL: sólo
 * existe aquí, en el listado. Si no se captura al bajar, se pierde.
 */
export function parseFechaBmv(txt) {
  const m = /(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóú]{3,4})\.?-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(txt || '');
  if (!m) return null;
  const mes = MESES[m[2].slice(0, 3).toLowerCase()];
  if (!mes) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(mes)}-${p(m[1])}T${p(m[4] || 0)}:${p(m[5] || 0)}:00Z`;
}

const limpiar = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

/**
 * Encuentra en el HTML las filas de "ESTADOS FINANCIEROS BÁSICOS" que apuntan
 * a un zip de ifrsxbrl. Devuelve todas las que vea, más reciente primero.
 *
 * El link viene como visorXbrl.html?docins=../ifrsxbrl/ifrsxbrl_{DOCID}_{AAAA}-{TT}_1.zip
 * y el zip directo vive en /docs-pub/ifrsxbrl/<mismo nombre>.
 */
export function filasXbrl(html) {
  const RE_ZIP = /ifrsxbrl_(\d+)_(\d{4})-(\d{1,2})_(\d+)\.zip/g;
  const filas = [];

  // Preferimos partir por <tr> para quedarnos con la fecha de la MISMA fila.
  const bloques = html.split(/<tr[\s>]/i);
  for (const b of bloques) {
    RE_ZIP.lastIndex = 0;
    const m = RE_ZIP.exec(b);
    if (!m) continue;
    const [archivo, docId, anio, tt, seq] = [m[0], m[1], Number(m[2]), Number(m[3]), Number(m[4])];
    const texto = limpiar(b);
    const trim = /Trimestre\s+(\d)/i.exec(texto);
    filas.push({
      archivo,
      doc_id: docId,
      anio,
      trimestre: tt >= 1 && tt <= 4 ? tt : (trim ? Number(trim[1]) : null),
      secuencia: seq,
      fecha_publicacion: parseFechaBmv(texto),
      titulo: texto.slice(0, 200) || null,
      zip_url: `${BASE}/docs-pub/ifrsxbrl/${archivo}`,
    });
  }

  // Deduplica por archivo y ordena: año, trimestre, secuencia — desc.
  const vistos = new Set();
  return filas
    .filter((f) => (vistos.has(f.archivo) ? false : vistos.add(f.archivo)))
    .sort((a, b) => (b.anio - a.anio) || (b.trimestre - a.trimestre) || (b.secuencia - a.secuencia));
}

/*
 * Caracteres que NO hay que escapar dentro de un segmento de ruta (RFC 3986:
 * unreserved + sub-delims + ':' '@'). El '&' está entre ellos.
 *
 * Esto salió de PE&OLES en la primera corrida: yo pedía
 *   .../informacionfinanciera/PE%26OLES-5608-CGEN_CAPIT
 * y BMV publica
 *   .../informacionfinanciera/PE&OLES-5608-CGEN_CAPIT
 * La captura funcionó igual (el zip salió bien, 9/9 campos), pero la
 * fecha_publicacion vino null y en las otras 22 no. Verifiqué que el '&' NO
 * rompe el parseo de la fila —cuatro variantes con '&' literal, '&amp;' y '&'
 * dentro de un href pasan—, así que lo que queda es la URL: pedir %26
 * probablemente cae en una variante de página que lista el documento sin la
 * columna de fecha. No pude comprobarlo desde acá (sin egress a BMV), pero
 * mandar la URL tal como BMV la publica es lo correcto de todos modos.
 */
const PATH_SEGURO = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;
export function segmentoRuta(s) {
  return String(s).split('').map((c) => (PATH_SEGURO.test(c) ? c : encodeURIComponent(c))).join('');
}

function urlEmisora(clave, id) {
  return `${BASE}/es/emisoras/informacionfinanciera/${segmentoRuta(clave)}-${id}-CGEN_CAPIT`;
}

/*
 * Trimestre que YA debería estar publicado a una fecha dada.
 *
 * Una emisora reporta ~1-2 meses después del cierre; se toma el último
 * trimestre cuyo cierre + 60 días ya pasó. Sirve para detectar solo el caso
 * ELEKTRA —una emisora que dejó de reportar— sin depender de que alguien
 * recuerde anotarlo a mano en emisoras.json.
 */
export function trimestreEsperado(ahora = new Date()) {
  const cierres = [];
  const anio = ahora.getUTCFullYear();
  for (const a of [anio - 1, anio]) {
    for (const [t, mes, dia] of [[1, 3, 31], [2, 6, 30], [3, 9, 30], [4, 12, 31]]) {
      cierres.push({ anio: a, trimestre: t, fin: Date.UTC(a, mes - 1, dia) });
    }
  }
  const limite = ahora.getTime() - 60 * 24 * 60 * 60 * 1000;
  const pasados = cierres.filter((c) => c.fin <= limite).sort((a, b) => b.fin - a.fin);
  return pasados[0] ? { anio: pasados[0].anio, trimestre: pasados[0].trimestre } : null;
}

/** Cuántos trimestres de atraso trae un periodo respecto del esperado. */
export function trimestresDeAtraso(periodo, esperado) {
  if (!esperado) return 0;
  return Math.max(0, (esperado.anio * 4 + esperado.trimestre) - (periodo.anio * 4 + periodo.trimestre));
}

/* ── captura de una emisora ──────────────────────────────────────── */

async function localizarFila(em) {
  const pasos = [];
  const paso = (nombre, ok, detalle) => { pasos.push({ paso: nombre, ok, detalle }); return ok; };

  if (!em.id) {
    paso('id', false, 'sin id de BMV verificado — no se adivina; completar api/_lib/emisoras.json');
    return { clave: em.clave, estado: 'saltada', motivo: 'sin id verificado', pasos };
  }

  const url = urlEmisora(em.clave, em.id);
  let html;
  try { html = await traer(url); paso('pagina', true, url); }
  catch (e) { paso('pagina', false, `${url} → ${e.message}`); return { clave: em.clave, estado: 'fallida', motivo: `página: ${e.message}`, pasos }; }

  const filas = filasXbrl(html);
  if (!filas.length) {
    paso('fila_xbrl', false, 'la página no trae ningún link a ifrsxbrl_*.zip');
    return { clave: em.clave, estado: 'fallida', motivo: 'sin fila de XBRL en la página', pasos };
  }
  const fila = filas[0];
  paso('fila_xbrl', true, `${fila.archivo} · ${fila.anio}-T${fila.trimestre} · publicado ${fila.fecha_publicacion || '(SIN FECHA)'}`);
  // La fecha de envío NO está dentro del XBRL (D8): si la fila no la trae, no
  // se puede recuperar re-parseando el raw. Es alerta, nunca un null callado.
  if (!fila.fecha_publicacion) {
    paso('fecha_publicacion', false, 'la fila no trae fecha-hora legible — no se puede derivar del archivo');
  }

  return { clave: em.clave, estado: 'fila', fila, pasos };
}

/**
 * Baja el zip y lo parsea. Separado de localizar la fila a propósito: reparar
 * una fecha_publicacion que quedó null NO necesita el zip —la fecha vive en la
 * página, no en el archivo— así que esa reparación cuesta cero descargas.
 */
async function descargarYParsear(em, fila, pasos) {
  const paso = (nombre, ok, detalle) => { pasos.push({ paso: nombre, ok, detalle }); return ok; };

  await dormir(PAUSA_MS);
  let zip;
  try { zip = await traer(fila.zip_url, { binario: true }); paso('zip', true, `${zip.length} bytes`); }
  catch (e) { paso('zip', false, `${fila.zip_url} → ${e.message}`); return { clave: em.clave, estado: 'fallida', motivo: `zip: ${e.message}`, fila, pasos }; }

  let ext;
  try { ext = extraerDeZip(zip, { anio: fila.anio, trimestre: fila.trimestre }); paso('parse', true, `entry point ${ext.entryPoint}`); }
  catch (e) { paso('parse', false, e.message); return { clave: em.clave, estado: 'fallida', motivo: `parse: ${e.message}`, fila, pasos }; }

  const resueltos = CAMPOS.filter((c) => ext.campos[c.key].ok).length;
  paso('campos', true, `${resueltos}/${CAMPOS.length} resueltos${ext.alertas.length ? ` · ${ext.alertas.length} alerta(s)` : ''}`);

  return { clave: em.clave, estado: 'ok', fila, ext, pasos };
}

/** Localizar + descargar + parsear, para el smoke y para la captura nueva. */
async function capturarUna(em) {
  const r = await localizarFila(em);
  if (r.estado !== 'fila') return r;
  return descargarYParsear(em, r.fila, r.pasos);
}

/* ── escritura en Neon ───────────────────────────────────────────── */

function columnasDe(ext) {
  const col = {};
  for (const c of [...CAMPOS, ...EXTRAS]) {
    const r = ext.campos[c.key] || ext.extras[c.key];
    col[c.key] = r && r.ok ? r.valor : null;
    if (CAMPOS.some((x) => x.key === c.key)) {
      col[`${c.key}_tag`] = r && r.ok ? r.tag : null;
      col[`${c.key}_ventana`] = r && r.ok ? r.ventana : null;
      col[`${c.key}_motivo`] = r && r.ok ? null : (r ? r.motivo : 'no evaluado');
    }
  }
  return col;
}

async function guardar(em, fila, ext) {
  const col = columnasDe(ext);
  const identidadesOk = Object.values(ext.identidades).every((i) => i.estado !== 'dif');

  // doc_id es UNIQUE: correr dos veces no duplica. ON CONFLICT DO NOTHING para
  // que la idempotencia no dependa de leer antes de escribir.
  const r = await sql(
    `insert into xbrl_reports (
       clave, bmv_id, doc_id, anio, trimestre, fecha_publicacion, fecha_captura,
       zip_url, entry_point, raw_json,
       ingresos, ingresos_tag, ingresos_ventana, ingresos_motivo,
       utilidad_neta_atribuible, utilidad_neta_atribuible_tag, utilidad_neta_atribuible_ventana, utilidad_neta_atribuible_motivo,
       activos_totales, activos_totales_tag, activos_totales_ventana, activos_totales_motivo,
       pasivos_totales, pasivos_totales_tag, pasivos_totales_ventana, pasivos_totales_motivo,
       capital_contable, capital_contable_tag, capital_contable_ventana, capital_contable_motivo,
       efectivo, efectivo_tag, efectivo_ventana, efectivo_motivo,
       deuda_corto, deuda_corto_tag, deuda_corto_ventana, deuda_corto_motivo,
       deuda_largo, deuda_largo_tag, deuda_largo_ventana, deuda_largo_motivo,
       acciones_circulacion, acciones_circulacion_tag, acciones_circulacion_ventana, acciones_circulacion_motivo,
       capital_controladora, participacion_no_control,
       arrendamientos_corto, arrendamientos_largo,
       identidades, identidades_ok, alertas
     ) values (
       $1,$2,$3,$4,$5,$6, now(),
       $7,$8,$9,
       $10,$11,$12,$13, $14,$15,$16,$17, $18,$19,$20,$21, $22,$23,$24,$25,
       $26,$27,$28,$29, $30,$31,$32,$33, $34,$35,$36,$37, $38,$39,$40,$41,
       $42,$43,$44,$45, $46,$47, $48,$49, $50,$51,$52
     )
     on conflict (doc_id) do update
        set fecha_publicacion = excluded.fecha_publicacion,
            alertas           = excluded.alertas
      where xbrl_reports.fecha_publicacion is null
        and excluded.fecha_publicacion is not null
     returning (xmax = 0) as inserto`,
    [
      em.clave, String(em.id), fila.doc_id, fila.anio, fila.trimestre, fila.fecha_publicacion,
      fila.zip_url, ext.entryPoint, JSON.stringify(ext.raw),
      col.ingresos, col.ingresos_tag, col.ingresos_ventana, col.ingresos_motivo,
      col.utilidad_neta_atribuible, col.utilidad_neta_atribuible_tag, col.utilidad_neta_atribuible_ventana, col.utilidad_neta_atribuible_motivo,
      col.activos_totales, col.activos_totales_tag, col.activos_totales_ventana, col.activos_totales_motivo,
      col.pasivos_totales, col.pasivos_totales_tag, col.pasivos_totales_ventana, col.pasivos_totales_motivo,
      col.capital_contable, col.capital_contable_tag, col.capital_contable_ventana, col.capital_contable_motivo,
      col.efectivo, col.efectivo_tag, col.efectivo_ventana, col.efectivo_motivo,
      col.deuda_corto, col.deuda_corto_tag, col.deuda_corto_ventana, col.deuda_corto_motivo,
      col.deuda_largo, col.deuda_largo_tag, col.deuda_largo_ventana, col.deuda_largo_motivo,
      col.acciones_circulacion, col.acciones_circulacion_tag, col.acciones_circulacion_ventana, col.acciones_circulacion_motivo,
      col.capital_controladora, col.participacion_no_control,
      col.arrendamientos_corto, col.arrendamientos_largo,
      JSON.stringify(ext.identidades), identidadesOk, JSON.stringify(ext.alertas),
    ]
  );
  // Sin filas = ya existía y no había nada que reparar. xmax=0 = insert nuevo.
  const devuelta = (r.rows || [])[0];
  if (!devuelta) return 'sin_cambio';
  return devuelta.inserto ? 'insertada' : 'reparada';
}

/**
 * Rellena SÓLO la fecha_publicacion de una fila ya guardada.
 *
 * Por qué esta es la única columna que se repara desde la red: todo lo demás se
 * puede recalcular del raw_json, que se guarda completo. La fecha de envío no
 * está en el archivo (D8) — vive únicamente en el listado de BMV. Si quedó
 * null, la única forma de obtenerla es volver a leer la página, y eso deja de
 * ser posible cuando el trimestre sale de la vista gratis.
 */
async function repararFecha(docId, fecha) {
  const r = await sql(
    `update xbrl_reports set fecha_publicacion = $2
      where doc_id = $1 and fecha_publicacion is null
      returning doc_id`,
    [docId, fecha]
  );
  return (r.rows || []).length > 0;
}

/* ── modo smoke ──────────────────────────────────────────────────── */

/* Valores de Fase 0, 2T2026 (docs/xbrl-fase0.md §6.2). Son la verdad contra la
 * que se compara el smoke: si el capturador no los reproduce, algo cambió en
 * BMV y hay que mirarlo ANTES de correr la captura completa. */
const ESPERADO_2T2026 = {
  WALMEX: {
    ingresos: 250947844000, utilidad_neta_atribuible: 11152382000,
    activos_totales: 505946590000, pasivos_totales: 267332796000,
    capital_contable: 238613794000, efectivo: 30118253000,
    deuda_corto: 0, deuda_largo: 0, acciones_circulacion: 17220231803,
  },
  FEMSA: {
    ingresos: 231002301000, utilidad_neta_atribuible: 5535227000,
    activos_totales: 802581500000, pasivos_totales: 501646499000,
    capital_contable: 300935001000, efectivo: 104959729000,
    deuda_corto: 14947551000, deuda_largo: 124830071000, acciones_circulacion: 16935974370,
  },
};

async function modoSmoke() {
  const salida = [];
  let todoOk = true;

  for (const clave of Object.keys(ESPERADO_2T2026)) {
    const em = EMISORAS.emisoras.find((e) => e.clave === clave);
    const r = await capturarUna(em);

    const comparacion = [];
    if (r.estado === 'ok') {
      const esperado = ESPERADO_2T2026[clave];
      const mismoPeriodo = r.fila.anio === 2026 && r.fila.trimestre === 2;
      for (const [campo, esp] of Object.entries(esperado)) {
        const obt = r.ext.campos[campo].ok ? r.ext.campos[campo].valor : null;
        const cuadra = obt === esp;
        if (!cuadra && mismoPeriodo) todoOk = false;
        comparacion.push({ campo, esperado: esp, obtenido: obt, cuadra, tag: r.ext.campos[campo].tag });
      }
      if (!mismoPeriodo) {
        comparacion.push({
          nota: `la página ya no sirve 2T2026 sino ${r.fila.anio}-T${r.fila.trimestre}: la comparación contra Fase 0 no aplica, pero la captura sí funcionó`,
        });
      }
    } else { todoOk = false; }

    salida.push({
      clave,
      estado: r.estado,
      motivo: r.motivo || null,
      pasos: r.pasos,
      fila: r.fila || null,
      identidades: r.ext ? r.ext.identidades : null,
      alertas: r.ext ? r.ext.alertas : null,
      comparacion,
    });
    await dormir(PAUSA_MS);
  }

  return { modo: 'smoke', escribio_en_neon: false, veredicto: todoOk ? 'ok' : 'revisar', emisoras: salida };
}

/* ── modo run ────────────────────────────────────────────────────── */

async function modoRun() {
  await ensureSchema();

  // Se trae la fecha junto al doc_id: una fila vieja con fecha null es
  // reparable, y repararla no cuesta una descarga extra.
  const existentes = new Map(
    ((await sql('select doc_id, fecha_publicacion from xbrl_reports')).rows || [])
      .map((r) => [String(r.doc_id), r.fecha_publicacion])
  );

  const esperado = trimestreEsperado(new Date());
  const resumen = { capturadas: [], reparadas: [], ya_existentes: [], saltadas: [], fallidas: [] };
  const alertas = [];

  for (const em of EMISORAS.emisoras) {
    const loc = await localizarFila(em);

    if (loc.estado === 'saltada') { resumen.saltadas.push({ clave: em.clave, motivo: loc.motivo }); continue; }
    if (loc.estado === 'fallida') {
      resumen.fallidas.push({ clave: em.clave, motivo: loc.motivo });
      if (em.estado === 'deslistada') {
        alertas.push({ clave: em.clave, tipo: 'deslistada', detalle: `falló, pero está marcada como deslistada: ${em.nota || 'sin nota'}` });
      }
      await dormir(PAUSA_MS);
      continue;
    }

    const fila = loc.fila;
    const docId = String(fila.doc_id);
    const atraso = trimestresDeAtraso({ anio: fila.anio, trimestre: fila.trimestre }, esperado);

    /* Una emisora que dejó de reportar NO puede pasar como éxito silencioso.
     * Se detecta sola por atraso; el campo `estado` sólo dice si ya lo sabíamos. */
    if (atraso > 0) {
      alertas.push({
        clave: em.clave,
        tipo: em.estado === 'deslistada' ? 'deslistada_esperado' : 'atrasada',
        detalle: `última fila ${fila.anio}-T${fila.trimestre}, ${atraso} trimestre(s) detrás de ${esperado.anio}-T${esperado.trimestre}`
               + (em.estado === 'deslistada' ? ` — esperado: ${em.nota || 'marcada deslistada'}` : ' — revisar si dejó de reportar'),
      });
    } else if (em.estado === 'deslistada') {
      alertas.push({ clave: em.clave, tipo: 'revivio', detalle: `marcada deslistada pero publicó ${fila.anio}-T${fila.trimestre} — actualizar emisoras.json` });
    }
    if (!fila.fecha_publicacion) {
      alertas.push({ clave: em.clave, tipo: 'sin_fecha', detalle: `la fila de ${fila.anio}-T${fila.trimestre} no trae fecha-hora: no se puede derivar del XBRL (D8)` });
    }

    // ── ya existe ──
    if (existentes.has(docId)) {
      const fechaGuardada = existentes.get(docId);
      if (!fechaGuardada && fila.fecha_publicacion) {
        try {
          const reparo = await repararFecha(docId, fila.fecha_publicacion);
          if (reparo) { resumen.reparadas.push({ clave: em.clave, doc_id: docId, fecha_publicacion: fila.fecha_publicacion }); continue; }
        } catch (e) {
          resumen.fallidas.push({ clave: em.clave, motivo: `neon (reparar fecha): ${e.message}` });
          continue;
        }
      }
      resumen.ya_existentes.push({ clave: em.clave, doc_id: docId, periodo: `${fila.anio}-T${fila.trimestre}` });
      continue;   // sin descargar el zip
    }

    // ── nueva: ahora sí se baja y se parsea ──
    const r = await descargarYParsear(em, fila, loc.pasos);
    if (r.estado === 'fallida') { resumen.fallidas.push({ clave: em.clave, motivo: r.motivo }); await dormir(PAUSA_MS); continue; }

    try {
      const estado = await guardar(em, fila, r.ext);
      const info = {
        clave: em.clave, doc_id: docId, periodo: `${fila.anio}-T${fila.trimestre}`,
        fecha_publicacion: fila.fecha_publicacion,
        campos_ok: CAMPOS.filter((c) => r.ext.campos[c.key].ok).length,
        alertas: r.ext.alertas,
      };
      if (estado === 'insertada') resumen.capturadas.push(info);
      else if (estado === 'reparada') resumen.reparadas.push(info);
      else resumen.ya_existentes.push(info);
    } catch (e) {
      resumen.fallidas.push({ clave: em.clave, motivo: `neon: ${e.message}` });
    }
    await dormir(PAUSA_MS);
  }

  return {
    modo: 'run',
    trimestre_esperado: esperado ? `${esperado.anio}-T${esperado.trimestre}` : null,
    total: EMISORAS.emisoras.length,
    capturadas: resumen.capturadas.length,
    reparadas: resumen.reparadas.length,
    ya_existentes: resumen.ya_existentes.length,
    saltadas: resumen.saltadas.length,
    fallidas: resumen.fallidas.length,
    alertas,                       // nunca vacío por omisión: si hay algo raro, aquí sale
    detalle: resumen,
  };
}

/* ── handler ─────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  try {
    if (req.query.smoke === '1') {
      return res.status(200).json(await modoSmoke());
    }

    if (req.query.run === '1') {
      if (!authorized(req)) {
        return res.status(401).json({
          error: 'no autorizado',
          detalle: adminSecret() ? 'header Authorization: Bearer <ADMIN_SECRET>' : 'ADMIN_SECRET no configurado — escritura deshabilitada (fail closed)',
        });
      }
      return res.status(200).json(await modoRun());
    }

    // Estado (público, sin secretos).
    await ensureSchema();
    const q = await sql(
      `select count(*)::int as filas, count(distinct clave)::int as emisoras,
              max(fecha_captura) as ultima_captura
         from xbrl_reports`
    );
    const verificadas = EMISORAS.emisoras.filter((e) => e.id).length;
    return res.status(200).json({
      endpoint: '/api/xbrl-capture',
      modos: {
        '?smoke=1': 'público, solo lectura: baja WALMEX y FEMSA y compara contra Fase 0',
        '?run=1': 'protegido (Bearer ADMIN_SECRET): captura y escribe en Neon',
      },
      universo: { total: EMISORAS.emisoras.length, con_id_verificado: verificadas, sin_id: EMISORAS.emisoras.length - verificadas },
      tabla: (q.rows || [])[0] || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
