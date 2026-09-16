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
} from './_lib/bmv-inspect.js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const pedidas = String(req.query.claves || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (!pedidas.length) {
    return res.status(200).json({
      endpoint: '/api/bmv-inspect',
      que_hace: 'censo de qué guarda BMV hacia atrás. Sólo lee: no baja documentos ni escribe nada.',
      uso: `?claves=${DEFECTO.join(',')}`,
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
