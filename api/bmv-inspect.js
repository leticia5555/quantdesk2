// ═══════════════════════════════════════════════════════════════
// /api/bmv-inspect — CENSO del histórico (Fase 1b). Sólo lee y describe.
//
// No baja documentos, no parsea XBRL, no escribe en Neon, no llama a Claude.
// Pide dos páginas por emisora y devuelve qué hay en ellas.
//
// Existe porque el sandbox donde se escribe este código no llega a bmv.com.mx
// y Vercel sí. Es el mismo patrón de "smoke desde prod" de Fase 0 y 1a.
//
//   GET ?claves=WALMEX,FEMSA,GMEXICO,ALSEA,GCC   → censo de esas emisoras
//   GET                                          → ayuda
//
// Público y de sólo lectura a propósito: no hay nada que proteger porque no
// muta nada, y así se puede correr desde el navegador y pegar el JSON.
//
// CORTESÍA: 1 request/segundo, User-Agent identificado, un reintento sólo en
// 5xx. Con 5 emisoras son 10 requests, ~12 segundos.
// ═══════════════════════════════════════════════════════════════

import EMISORAS from './_lib/emisoras.json' with { type: 'json' };
import { parseFechaBmv, filasXbrl, segmentoRuta } from './xbrl-capture.js';
import {
  estructuraCruda, documentos, clasificarEvento, analizarIds, resumirPorTipo,
  detectarPaginacion, zipsDeTipo,
} from './_lib/bmv-inspect.js';
import { leerZip } from './_lib/xbrl-parse.js';

const BASE = 'https://www.bmv.com.mx';
const PAUSA_MS = 1000;
const TIMEOUT_MS = 30000;
const DEFECTO = ['WALMEX', 'FEMSA', 'GMEXICO', 'ALSEA', 'GCC'];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const userAgent = () =>
  `quantdesk-bmv-inspect/1.0 (+${process.env.XBRL_CONTACT || 'https://github.com/leticia5555/quantdesk2'})`;

async function traer(url) {
  for (let intento = 1; intento <= 2; intento++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (intento === 2) return { error: `red: ${e.message}` };
      await dormir(PAUSA_MS * 2);
      continue;
    }
    if (res.status >= 500 && intento === 1) { await dormir(PAUSA_MS * 2); continue; }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  }
  return { error: 'agotados los intentos' };
}

/** Lo que se reporta de una página: crudo primero, interpretación después. */
function describir(html) {
  const cruda = estructuraCruda(html);
  const docs = documentos(html, parseFechaBmv);
  return { estructura: cruda, n_documentos: docs.length, por_tipo: resumirPorTipo(docs), documentos: docs };
}

async function censarEmisora(em) {
  const salida = { clave: em.clave, bmv_id: em.id, estado: em.estado || 'activa' };
  if (!em.id) return { ...salida, error: 'sin id de BMV verificado' };

  const ruta = `${segmentoRuta(em.clave)}-${em.id}-CGEN_CAPIT`;

  // ── 1. Información financiera: XBRL trimestral + reportes anuales ──
  const urlFin = `${BASE}/es/emisoras/informacionfinanciera/${ruta}`;
  const fin = await traer(urlFin);
  salida.informacion_financiera = { url: urlFin };
  if (fin.error) salida.informacion_financiera.error = fin.error;
  else {
    const d = describir(fin.html);
    const xbrl = filasXbrl(fin.html);
    salida.informacion_financiera = {
      ...salida.informacion_financiera,
      ...d,
      // La pregunta de la Parte A.1: ¿sólo el vigente o hay histórico?
      xbrl_trimestral: {
        n_filas: xbrl.length,
        periodos: xbrl.map((f) => `${f.anio}-T${f.trimestre}`),
        detalle: xbrl.map((f) => ({ archivo: f.archivo, periodo: `${f.anio}-T${f.trimestre}`, fecha: f.fecha_publicacion || f.fecha_texto })),
        veredicto: xbrl.length === 0 ? 'sin XBRL en la página'
          : xbrl.length === 1 ? 'SÓLO el trimestre vigente — confirma el supuesto de Fase 0'
          : `${xbrl.length} trimestres listados — HAY HISTÓRICO, esto cambia el plan`,
      },
    };
  }

  await dormir(PAUSA_MS);

  // ── 2. Eventos relevantes: comunicados de resultados ──
  const urlEv = `${BASE}/es/emisoras/eventosrelevantes/${ruta}`;
  const ev = await traer(urlEv);
  salida.eventos_relevantes = { url: urlEv };
  if (ev.error) salida.eventos_relevantes.error = ev.error;
  else {
    const d = describir(ev.html);
    const clasificados = d.documentos.map((f) => ({ ...f, ...clasificarEvento(f.titulo || '') }));
    const resultados = clasificados.filter((f) => f.clase === 'resultados_trimestrales');
    const anios = [...new Set(resultados.map((r) => r.anio_titulo || r.anio_archivo).filter(Boolean))].sort();

    salida.eventos_relevantes = {
      ...salida.eventos_relevantes,
      estructura: d.estructura,
      n_documentos: d.n_documentos,
      por_tipo: d.por_tipo,
      resultados_trimestrales: {
        n: resultados.length,
        n_alta_confianza: resultados.filter((r) => r.confianza === 'alta').length,
        anio_min: anios[0] ?? null,
        anio_max: anios[anios.length - 1] ?? null,
        periodos: resultados.map((r) => (r.anio_titulo && r.trimestre_titulo ? `${r.anio_titulo}-T${r.trimestre_titulo}` : null)).filter(Boolean),
        muestra: resultados.slice(0, 8).map((r) => ({ archivo: r.archivo, titulo: r.titulo, fecha: r.fecha_publicacion || r.fecha_texto, confianza: r.confianza })),
      },
      // Muestra de lo descartado: para poder ver si el clasificador se pasó de estricto.
      otros_muestra: clasificados.filter((f) => f.clase === 'otro').slice(0, 5).map((f) => ({ archivo: f.archivo, titulo: f.titulo })),
    };
  }

  // ── 3. ¿Los ids son contiguos? ──
  const todas = [
    ...(salida.informacion_financiera.documentos || []),
    ...((ev.html && documentos(ev.html, parseFechaBmv)) || []),
  ];
  salida.ids = analizarIds(todas);

  // No se devuelve el listado completo de eventos: puede ser enorme.
  delete salida.informacion_financiera.documentos;

  return salida;
}

/* ═══════════════════════════════════════════════════════════════
 * MODO PROFUNDO — las tres preguntas que quedaron abiertas tras la 1ª corrida.
 * Una emisora, una corrida, las tres respuestas.
 * ═══════════════════════════════════════════════════════════════ */

async function modoProfundo(em) {
  const ruta = `${segmentoRuta(em.clave)}-${em.id}-CGEN_CAPIT`;
  const urlEv = `${BASE}/es/emisoras/eventosrelevantes/${ruta}`;
  const out = { clave: em.clave, url: urlEv };

  const ev = await traer(urlEv);
  if (ev.error) return { ...out, error: ev.error };

  const docs = documentos(ev.html, parseFechaBmv);

  /* ── P1. TODOS los títulos, sin filtrar ──────────────────────────
   * La 1ª corrida devolvió sólo 5 ejemplos de lo descartado, y con eso no
   * alcanzó para entender por qué FEMSA salió con 1 de 84. Acá va la lista
   * completa: son cadenas cortas, 84 no pesan nada, y con verlas se arregla
   * el clasificador sin pedir otra corrida. */
  out.titulos = {
    n: docs.length,
    nota: 'lista COMPLETA sin filtrar — es lo que hace falta para arreglar el clasificador',
    filas: docs.map((d) => ({
      archivo: d.archivo,
      tipo: d.tipo,
      fecha: d.fecha_publicacion || d.fecha_texto,
      titulo: d.titulo,
      clasificado_como: clasificarEvento(d.titulo || '').clase,
    })),
  };

  /* ── P2. ¿El tope de ~80 filas se puede rodear? ──────────────── */
  const pag = detectarPaginacion(ev.html);
  out.paginacion = { ...pag, intento: null };

  if (pag.enlaces_paginacion.length) {
    // Se prueba UN enlace, el que apunte al índice más alto: si devuelve
    // documentos distintos, la paginación funciona y el tope no es el techo.
    const conIndice = pag.enlaces_paginacion
      .map((h) => ({ href: h, idx: Number((/index=(\d+)/.exec(h) || [])[1] ?? -1) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => b.idx - a.idx)[0] || { href: pag.enlaces_paginacion[0], idx: null };

    const url = conIndice.href.startsWith('http') ? conIndice.href
      : `${BASE}${conIndice.href.startsWith('/') ? '' : '/'}${conIndice.href}`;

    await dormir(PAUSA_MS);
    const p2 = await traer(url);
    if (p2.error) out.paginacion.intento = { url, error: p2.error };
    else {
      const d2 = documentos(p2.html, parseFechaBmv);
      const antes = new Set(docs.map((d) => d.archivo));
      const nuevos = d2.filter((d) => !antes.has(d.archivo));
      const anios = [...new Set(d2.map((d) => d.anio_titulo || d.anio_archivo).filter(Boolean))].sort();
      out.paginacion.intento = {
        url,
        n_documentos: d2.length,
        n_nuevos: nuevos.length,
        anios_en_esta_pagina: anios,
        muestra_nuevos: nuevos.slice(0, 5).map((d) => ({ archivo: d.archivo, fecha: d.fecha_publicacion, titulo: d.titulo })),
        veredicto: nuevos.length > 0
          ? 'LA PAGINACIÓN FUNCIONA — el tope de filas no es el techo del histórico'
          : 'devolvió los mismos documentos: ese enlace no pagina de verdad',
      };
    }
  }

  /* ── P3. ¿El zip de eventemi trae XBRL de verdad o sólo envuelve el PDF? ──
   * Si trae datos estructurados, cambia todo: serían 9/9 campos sin PDF ni
   * modelo, a costo cero de API. */
  const zips = zipsDeTipo(docs, 'eventemi').slice(0, 3);
  out.zip_eventemi = { n_candidatos: zipsDeTipo(docs, 'eventemi').length, pruebas: [] };

  for (const z of zips) {
    await dormir(PAUSA_MS);
    const url = `${BASE}/docs-pub/eventemi/${z.archivo}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) { out.zip_eventemi.pruebas.push({ url, error: `red: ${e.message}` }); continue; }

    if (!res.ok) { out.zip_eventemi.pruebas.push({ url, http: res.status, veredicto: 'no existe como zip' }); continue; }

    const buf = Buffer.from(await res.arrayBuffer());
    const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
    const esPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    const prueba = {
      url, http: res.status, bytes: buf.length,
      content_type: res.headers.get('content-type'),
      magic: esZip ? 'ZIP' : esPdf ? 'PDF' : buf.subarray(0, 8).toString('hex'),
    };

    if (esZip) {
      try {
        const dentro = leerZip(buf).map((a) => ({ nombre: a.nombre, bytes: a.datos ? a.datos.length : null, error: a.error }));
        prueba.contenido = dentro;
        const tieneDatos = dentro.some((a) => /\.(json|xbrl|xml)$/i.test(a.nombre));
        prueba.veredicto = tieneDatos
          ? 'ZIP CON DATOS ESTRUCTURADOS — esto cambia el plan del histórico: 9/9 campos sin PDF ni modelo'
          : 'zip, pero adentro sólo hay documentos no estructurados: el visor sólo envuelve';
      } catch (e) { prueba.veredicto = `zip ilegible: ${e.message}`; }
    } else {
      prueba.veredicto = esPdf ? 'es un PDF servido con nombre .zip: el visor sólo envuelve el PDF' : 'ni zip ni PDF';
    }
    out.zip_eventemi.pruebas.push(prueba);
  }
  if (!zips.length) out.zip_eventemi.nota = 'la página no enlaza ningún eventemi_*.zip; sólo .pdf';

  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // ── modo profundo: una emisora, las tres preguntas ──
  const profunda = String(req.query.profundo || '').trim().toUpperCase();
  if (profunda) {
    const em = EMISORAS.emisoras.find((e) => e.clave === profunda);
    if (!em) return res.status(400).json({ error: `${profunda} no está en emisoras.json` });
    if (!em.id) return res.status(400).json({ error: `${profunda} no tiene id de BMV verificado` });
    try {
      return res.status(200).json({ generado: new Date().toISOString(), modo: 'profundo', ...(await modoProfundo(em)) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const pedidas = String(req.query.claves || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (!pedidas.length) {
    return res.status(200).json({
      endpoint: '/api/bmv-inspect',
      que_hace: 'censo de qué guarda BMV hacia atrás. Sólo lee: no baja documentos ni escribe nada.',
      uso: `?claves=${DEFECTO.join(',')}`,
      modo_profundo: '?profundo=FEMSA — para UNA emisora: todos los títulos sin filtrar, prueba de paginación y prueba del zip de eventemi',
      emisoras_disponibles: EMISORAS.emisoras.filter((e) => e.id).map((e) => e.clave),
      nota: 'con 5 emisoras son 10 requests a 1/seg, ~12 segundos.',
    });
  }

  try {
    const salida = [];
    for (const clave of pedidas) {
      const em = EMISORAS.emisoras.find((e) => e.clave === clave);
      if (!em) { salida.push({ clave, error: 'no está en emisoras.json' }); continue; }
      salida.push(await censarEmisora(em));
      await dormir(PAUSA_MS);
    }
    return res.status(200).json({
      generado: new Date().toISOString(),
      leer_primero: 'estructura.docs_pub_por_tipo dice qué tipos de documento hay, sin depender de que mis parsers acierten',
      emisoras: salida,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
