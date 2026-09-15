#!/usr/bin/env node
/**
 * FASE 0 — XBRL BMV: smoke de viabilidad.
 *
 * Pregunta única que contesta este script:
 *   ¿se pueden bajar y parsear los XBRL de BMV/emisnet de forma programática,
 *   repetible y con números correctos?
 *
 * NO es pipeline: no escribe en Neon, no toca el app, no crea tablas.
 * El raw baja a .xbrl-fase0/ (ignorada por git).
 *
 * Sin dependencias. Node >= 20.
 *   - ZIP: mini-lector de central directory + zlib.inflateRawSync (~70 líneas).
 *     Justificación: los XBRL de emisnet se publican en .zip; meter adm-zip o
 *     yauzl por un inflate no se paga en una Fase 0.
 *   - XBRL: parser propio por regex sobre el instance document.
 *     Justificación: un procesador XBRL de verdad (Arelle) es Python, descarga
 *     de taxonomías y minutos por archivo. Para leer HECHOS de un instance sólo
 *     hace falta (a) resolver contextos y (b) elegir qnames: XML plano y muy
 *     regular por ser generado por máquina. No resolvemos linkbases ni
 *     calculation arcs porque este smoke no valida la taxonomía, valida que los
 *     NÚMEROS salgan y cuadren contra el PDF.
 *
 * ---------------------------------------------------------------------------
 * MODOS
 *
 *   node scripts/xbrl-smoke.mjs --probe
 *       Sólo censo de red: pega a los candidatos de entrada documentados e
 *       imprime status / content-type / set-cookie / redirects. No parsea.
 *
 *   node scripts/xbrl-smoke.mjs --manual <dir>
 *       Toma los archivos que YA bajaste a mano desde el portal de BMV (.zip,
 *       .xbrl o .xml) y corre extracción + tablas. Este modo SIEMPRE funciona.
 *       Nombra los archivos con emisora, año y trimestre, p.ej.:
 *           walmex_2025_2.zip    femsa_2025_4.zip
 *       Si no puede inferir emisora/periodo del nombre lo dice; no adivina.
 *
 *   node scripts/xbrl-smoke.mjs --file <archivo> [--dump-tags]
 *       Un solo archivo. --dump-tags lista TODOS los qnames presentes: así se
 *       descubren los tags reales en vez de suponerlos.
 *
 *   node scripts/xbrl-smoke.mjs
 *       Flujo automático: probe + intento de descarga + parseo. Si la URL de
 *       descarga no está resuelta, lo dice y manda a --manual. No inventa URLs.
 * ---------------------------------------------------------------------------
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const OUT_DIR = process.env.XBRL_FASE0_DIR || '.xbrl-fase0';

/* ========================================================================= */
/* 0. Objetivo del smoke                                                     */
/* ========================================================================= */

const TARGETS = [
  { emisora: 'WALMEX', anio: 2025, trim: 2, periodEnd: '2025-06-30' },
  { emisora: 'WALMEX', anio: 2025, trim: 4, periodEnd: '2025-12-31' },
  { emisora: 'FEMSA',  anio: 2025, trim: 2, periodEnd: '2025-06-30' },
  { emisora: 'FEMSA',  anio: 2025, trim: 4, periodEnd: '2025-12-31' },
];

/* ========================================================================= */
/* 1. Los 9 campos y sus tags candidatos                                     */
/* ========================================================================= */
/*
 * HONESTIDAD SOBRE LOS TAGS — leer antes de confiar en esta lista.
 *
 * [IFRS]      nombres del IFRS Accounting Taxonomy (namespace ifrs-full), de
 *             donde cuelga la taxonomía IFRS-BMV. Estables internacionalmente,
 *             es razonable esperarlos en el instance. NO verificados contra un
 *             archivo real de BMV desde este entorno (sin egress, ver el doc).
 * [DESCUBRIR] no hay un elemento IFRS único y limpio para el concepto, o la
 *             extensión mexicana puede traer el suyo. Hay que confirmarlo con
 *             --dump-tags sobre un archivo real.
 *
 * El script NO asume: prueba los candidatos EN ORDEN, reporta cuál pegó, y si
 * ninguno pega marca el campo como FALTA. Un campo que no se resuelve se
 * reporta como hueco — nunca se rellena con un proxy silencioso.
 */

const CAMPOS = [
  {
    key: 'ingresos',
    label: 'Ingresos',
    tipo: 'duration',
    candidatos: [
      'Revenue',                              // [IFRS]
      'RevenueFromContractsWithCustomers',    // [IFRS]
      'RevenueFromSaleOfGoods',               // [IFRS]
    ],
  },
  {
    key: 'utilidad_neta_atribuible',
    label: 'Utilidad neta atribuible a la controladora',
    tipo: 'duration',
    candidatos: [
      'ProfitLossAttributableToOwnersOfParent', // [IFRS]
      'ProfitLoss',                             // [IFRS] ojo: incluye minoritarios
    ],
    nota: 'Si pega ProfitLoss y no ...AttributableToOwnersOfParent, el número ' +
          'INCLUYE participación no controladora y NO es comparable con el PDF.',
  },
  { key: 'activos_totales',  label: 'Activos totales',  tipo: 'instant', candidatos: ['Assets'] },      // [IFRS]
  { key: 'pasivos_totales',  label: 'Pasivos totales',  tipo: 'instant', candidatos: ['Liabilities'] }, // [IFRS]
  {
    key: 'capital_contable',
    label: 'Capital contable',
    tipo: 'instant',
    candidatos: [
      'Equity',                            // [IFRS] total, incl. no controladora
      'EquityAttributableToOwnersOfParent', // [IFRS] sólo controladora
    ],
    nota: 'Equity y EquityAttributableToOwnersOfParent son cosas distintas. ' +
          'El PDF suele mostrar ambas: hay que comparar contra la correcta.',
  },
  {
    key: 'efectivo',
    label: 'Efectivo y equivalentes',
    tipo: 'instant',
    candidatos: [
      'CashAndCashEquivalents',                                       // [IFRS]
      'CashAndCashEquivalentsIfDifferentFromStatementOfFinancialPosition', // [IFRS]
      'Cash',                                                         // [IFRS]
    ],
  },
  {
    key: 'deuda_corto',
    label: 'Deuda con costo — corto plazo',
    tipo: 'instant',
    candidatos: [
      'ShorttermBorrowings',                     // [DESCUBRIR]
      'CurrentPortionOfLongtermBorrowings',      // [DESCUBRIR]
      'ShorttermBorrowingsClassifiedAsCurrent',  // [DESCUBRIR]
    ],
    nota: 'IFRS no define "deuda con costo" como un solo elemento. Es casi ' +
          'seguro que haya que SUMAR varios tags (préstamos bancarios + ' +
          'bursátiles + arrendamientos IFRS-16). Ver §deuda en el doc.',
  },
  {
    key: 'deuda_largo',
    label: 'Deuda con costo — largo plazo',
    tipo: 'instant',
    candidatos: [
      'LongtermBorrowings',                      // [DESCUBRIR]
      'NoncurrentPortionOfNoncurrentBorrowings', // [DESCUBRIR]
    ],
    nota: 'Mismo problema que deuda_corto.',
  },
  {
    key: 'acciones_circulacion',
    label: 'Acciones en circulación',
    tipo: 'instant',
    candidatos: [
      'NumberOfSharesOutstanding',    // [DESCUBRIR]
      'NumberOfSharesIssued',         // [DESCUBRIR] emitidas != en circulación
      'WeightedAverageShares',        // [DESCUBRIR] promedio ponderado, otra cosa
    ],
    nota: 'Emitidas, en circulación y promedio ponderado son TRES números ' +
          'distintos. Cuál trae el instance es justo lo que hay que descubrir.',
  },
];

// Décimo dato, no es un "campo financiero" pero se pide en el censo.
const FECHA_PUBLICACION_CANDIDATOS = [
  'DateOfEndOfReportingPeriod2013',  // [DESCUBRIR]
  'DateOfAuthorisationForIssueOfFinancialStatements', // [IFRS] fecha de autorización
];

/* ========================================================================= */
/* 2. Censo de red: candidatos de entrada                                    */
/* ========================================================================= */
/*
 * Estos son los puntos de entrada DOCUMENTADOS (ver docs/xbrl-fase0.md §1).
 * Ninguno está verificado en vivo desde el sandbox — todos dieron 403 en el
 * proxy de egress. El probe existe justamente para que corriéndolo en local se
 * sepa cuál responde y con qué.
 */
const ENTRADAS = [
  { nombre: 'BMV portal XBRL (empresas listadas)',
    url: 'https://www.bmv.com.mx/es/empresas-listadas/informacion-financiera-xbrl' },
  { nombre: 'BMV archivos estándar XBRL',
    url: 'https://www.bmv.com.mx/es/emisoras/archivos-estadar-xbrl' },
  { nombre: 'BMV info financiera WALMEX (ficha emisora)',
    url: 'https://www.bmv.com.mx/es/emisoras/informacionfinanciera/WALMEX-5214-CGEN_CAPIT' },
  { nombre: 'BMV info financiera FEMSA (ficha emisora)',
    url: 'https://www.bmv.com.mx/es/emisoras/informacionfinanciera/FEMSA-5305-CGEN_CAPIT' },
  { nombre: 'BMV cognos InfoFinanciera (backend de las fichas)',
    url: 'https://cognos.bmv.com.mx/es/Grupo_BMV/InfoFinanciera/WALMEX-5214' },
  { nombre: 'BMV docs-pub (ruta estática pública observada)',
    url: 'https://www.bmv.com.mx/docs-pub/' },
  { nombre: 'emisnet',
    url: 'https://emisnet.bmv.com.mx/' },
  { nombre: 'CNBV visor XBRL (plan B)',
    url: 'https://xbrl.cnbv.gob.mx/' },
  { nombre: 'BIVA emisoras (plan B)',
    url: 'https://www.biva.mx/es/emisoras' },
];

/* ========================================================================= */
/* 3. Mini-lector de ZIP (central directory + inflate)                       */
/* ========================================================================= */

function leerZip(buf) {
  // End of central directory: firma 0x06054b50, buscada desde el final.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido: no se encontró el end-of-central-directory');

  const nEntradas = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset del central directory
  const archivos = [];

  for (let i = 0; i < nEntradas; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo    = buf.readUInt16LE(p + 10);
    const tamComp   = buf.readUInt32LE(p + 20);
    const nLen      = buf.readUInt16LE(p + 28);
    const eLen      = buf.readUInt16LE(p + 30);
    const cLen      = buf.readUInt16LE(p + 32);
    const offLocal  = buf.readUInt32LE(p + 42);
    const nombre    = buf.toString('utf8', p + 46, p + 46 + nLen);
    p += 46 + nLen + eLen + cLen;

    // Cabecera local: el tamaño de los campos variables puede diferir del CD.
    if (buf.readUInt32LE(offLocal) !== 0x04034b50) continue;
    const lnLen = buf.readUInt16LE(offLocal + 26);
    const leLen = buf.readUInt16LE(offLocal + 28);
    const ini   = offLocal + 30 + lnLen + leLen;
    const crudo = buf.subarray(ini, ini + tamComp);

    let datos;
    if (metodo === 0) datos = crudo;                       // stored
    else if (metodo === 8) datos = inflateRawSync(crudo);  // deflate
    else { archivos.push({ nombre, error: `método de compresión ${metodo} no soportado` }); continue; }

    archivos.push({ nombre, datos });
  }
  return archivos;
}

/** Saca el instance document (.xbrl/.xml con <xbrl>) de un zip o archivo suelto. */
function extraerInstance(buf, nombreArchivo) {
  const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!esZip) return { xml: buf.toString('utf8'), origen: nombreArchivo };

  const archivos = leerZip(buf);
  const candidatos = archivos.filter((a) => a.datos && /\.(xbrl|xml)$/i.test(a.nombre));
  // El instance es el que tiene el elemento raíz xbrl; los .xsd/linkbases no.
  for (const a of candidatos) {
    const txt = a.datos.toString('utf8');
    if (/<(\w+:)?xbrl[\s>]/.test(txt)) return { xml: txt, origen: `${nombreArchivo}!${a.nombre}` };
  }
  throw new Error(
    `No se encontró instance document dentro del zip. Contenido: ` +
    archivos.map((a) => a.nombre).join(', ')
  );
}

/* ========================================================================= */
/* 4. Parser de XBRL instance                                                */
/* ========================================================================= */

function parsearContextos(xml) {
  const ctx = new Map();
  const re = /<(?:\w+:)?context\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, id, cuerpo] = m;
    const instant   = /<(?:\w+:)?instant>\s*([\d-]+)\s*<\//.exec(cuerpo);
    const startDate = /<(?:\w+:)?startDate>\s*([\d-]+)\s*<\//.exec(cuerpo);
    const endDate   = /<(?:\w+:)?endDate>\s*([\d-]+)\s*<\//.exec(cuerpo);
    const ident     = /<(?:\w+:)?identifier[^>]*>\s*([^<\s]+)\s*<\//.exec(cuerpo);
    // Dimensiones: cualquier explicitMember/typedMember hace el contexto NO consolidado-total.
    const dimensionado = /<(?:\w+:)?(explicitMember|typedMember)[\s>]/.test(cuerpo);
    ctx.set(id, {
      id,
      instant: instant ? instant[1] : null,
      startDate: startDate ? startDate[1] : null,
      endDate: endDate ? endDate[1] : null,
      entidad: ident ? ident[1] : null,
      dimensionado,
    });
  }
  return ctx;
}

function parsearHechos(xml) {
  const hechos = [];
  // Un hecho es un elemento hoja con contextRef. Cubre <t ...>v</t> y <t ... />.
  const re = /<([\w.-]+:[\w.-]+)\s([^>]*?contextRef="[^"]*"[^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, qname, attrs, contenido] = m;
    const at = (n) => { const r = new RegExp(`${n}="([^"]*)"`).exec(attrs); return r ? r[1] : null; };
    const esNil = /xsi:nil="true"/.test(attrs);
    const [prefijo, local] = qname.split(':');
    hechos.push({
      qname, prefijo, local,
      contextRef: at('contextRef'),
      unitRef: at('unitRef'),
      decimals: at('decimals'),
      scale: at('scale'),
      sign: at('sign'),
      nil: esNil,
      valorCrudo: esNil ? null : (contenido == null ? null : contenido.trim()),
    });
  }
  return hechos;
}

function aNumero(h) {
  if (h.nil || h.valorCrudo == null || h.valorCrudo === '') return null;
  const limpio = h.valorCrudo.replace(/[,\s]/g, '');
  if (!/^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(limpio)) return null;
  let v = Number(limpio);
  if (!Number.isFinite(v)) return null;
  // Atributos de iXBRL que a veces viajan en XBRL: scale y sign.
  if (h.scale) v *= Math.pow(10, Number(h.scale));
  if (h.sign === '-') v = -v;
  return v;
}

/**
 * Resuelve un campo contra el instance.
 * Devuelve TODOS los hechos que califican, sin elegir por nosotros cuando hay
 * ambigüedad de periodo — ahí es justo donde se rompe la comparación con PDF.
 */
function resolverCampo(campo, hechos, contextos, periodEnd) {
  for (const cand of campo.candidatos) {
    const pegan = hechos.filter((h) => {
      if (h.local !== cand) return false;
      const c = contextos.get(h.contextRef);
      if (!c || c.dimensionado) return false;           // sólo consolidado total
      if (aNumero(h) === null) return false;
      if (campo.tipo === 'instant') return c.instant === periodEnd;
      return c.endDate === periodEnd;                   // duration: cierra en el trimestre
    });
    if (!pegan.length) continue;

    const opciones = pegan.map((h) => {
      const c = contextos.get(h.contextRef);
      let ventana = 'instant';
      if (campo.tipo === 'duration' && c.startDate) {
        const meses = Math.round(
          (Date.parse(c.endDate) - Date.parse(c.startDate)) / (1000 * 60 * 60 * 24 * 30.44)
        );
        ventana = `${meses}m (${c.startDate}→${c.endDate})`;
      }
      return { tag: h.qname, valor: aNumero(h), ventana, unidad: h.unitRef, decimals: h.decimals, ctx: c.id };
    });
    return { encontrado: true, tag: `${cand}`, opciones };
  }
  return { encontrado: false, tag: null, opciones: [] };
}

/* ========================================================================= */
/* 5. Salida                                                                 */
/* ========================================================================= */

const fmt = (n) =>
  n === null || n === undefined ? '—'
    : Math.abs(n) >= 1e6 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : String(n);

function analizarArchivo(etiqueta, periodEnd, xml, opts = {}) {
  const contextos = parsearContextos(xml);
  const hechos = parsearHechos(xml);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`ARCHIVO: ${etiqueta}   (cierre de periodo objetivo: ${periodEnd})`);
  console.log(`${'='.repeat(78)}`);
  console.log(`contextos: ${contextos.size}  |  hechos: ${hechos.length}`);

  const prefijos = [...new Set(hechos.map((h) => h.prefijo))].sort();
  console.log(`prefijos/namespaces de los hechos: ${prefijos.join(', ') || '(ninguno)'}`);

  const nsRe = /xmlns:([\w.-]+)="([^"]+)"/g;
  const ns = {}; let mm;
  while ((mm = nsRe.exec(xml.slice(0, 8000))) !== null) ns[mm[1]] = mm[2];
  for (const p of prefijos) if (ns[p]) console.log(`    ${p} → ${ns[p]}`);

  if (opts.dumpTags) {
    const porTag = new Map();
    for (const h of hechos) porTag.set(h.qname, (porTag.get(h.qname) || 0) + 1);
    console.log(`\n--- TODOS LOS TAGS (${porTag.size}) ---`);
    for (const [t, n] of [...porTag].sort()) console.log(`  ${n.toString().padStart(4)}  ${t}`);
  }

  const resultado = {};
  console.log(`\n--- 9 CAMPOS ---`);
  for (const campo of CAMPOS) {
    const r = resolverCampo(campo, hechos, contextos, periodEnd);
    resultado[campo.key] = r;

    if (!r.encontrado) {
      const presentes = [...new Set(hechos.map((h) => h.local))]
        .filter((l) => campo.candidatos.some((c) => l.toLowerCase().includes(c.slice(0, 8).toLowerCase())));
      console.log(`  ${campo.label.padEnd(44)} FALTA  (probados: ${campo.candidatos.join(', ')})`);
      if (presentes.length) console.log(`  ${''.padEnd(44)}        parecidos en el archivo: ${presentes.slice(0, 6).join(', ')}`);
      continue;
    }
    const pri = r.opciones[0];
    console.log(`  ${campo.label.padEnd(44)} ${fmt(pri.valor).padStart(20)}  [${pri.tag}] ${pri.ventana} u=${pri.unidad || '—'} dec=${pri.decimals || '—'}`);
    for (const alt of r.opciones.slice(1)) {
      console.log(`  ${''.padEnd(44)} ${fmt(alt.valor).padStart(20)}  ^^ OTRA VENTANA: ${alt.ventana}  <-- OJO, ambigüedad de periodo`);
    }
    if (campo.nota && r.opciones[0].tag.split(':')[1] !== campo.candidatos[0]) {
      console.log(`  ${''.padEnd(44)}        NOTA: ${campo.nota}`);
    }
  }

  console.log(`\n--- FECHA DE PUBLICACIÓN / AUTORIZACIÓN ---`);
  let fechaOk = false;
  for (const cand of FECHA_PUBLICACION_CANDIDATOS) {
    const h = hechos.find((x) => x.local === cand && x.valorCrudo);
    if (h) { console.log(`  ${h.qname} = ${h.valorCrudo}`); fechaOk = true; break; }
  }
  if (!fechaOk) console.log(`  FALTA (probados: ${FECHA_PUBLICACION_CANDIDATOS.join(', ')}) — correr con --dump-tags`);

  return resultado;
}

function tablaResumen(porArchivo) {
  console.log(`\n\n${'#'.repeat(78)}`);
  console.log(`# TABLA emisora × trimestre × campo`);
  console.log(`${'#'.repeat(78)}\n`);

  const cols = porArchivo.map((a) => `${a.emisora} ${a.trim}T${a.anio}`);
  const w = 22;
  console.log('CAMPO'.padEnd(40) + cols.map((c) => c.padStart(w)).join(''));
  console.log('-'.repeat(40 + w * cols.length));

  for (const campo of CAMPOS) {
    let fila = campo.label.padEnd(40);
    for (const a of porArchivo) {
      const r = a.resultado?.[campo.key];
      fila += (r?.encontrado ? fmt(r.opciones[0].valor) : 'FALTA').padStart(w);
    }
    console.log(fila);
    let fTag = '   tag usado'.padEnd(40);
    for (const a of porArchivo) {
      const r = a.resultado?.[campo.key];
      fTag += (r?.encontrado ? r.opciones[0].tag.split(':')[1].slice(0, w - 2) : '—').padStart(w);
    }
    console.log(fTag);
  }

  /* ----- criterio GO/NO-GO: mismos tags entre emisoras y entre trimestres --- */
  console.log(`\n${'#'.repeat(78)}`);
  console.log(`# ESTABILIDAD DE TAGS (criterio GO: mismo tag en las 4 celdas)`);
  console.log(`${'#'.repeat(78)}\n`);

  let todosEstables = true, todosPresentes = true;
  for (const campo of CAMPOS) {
    const tags = porArchivo.map((a) => a.resultado?.[campo.key]?.opciones?.[0]?.tag ?? null);
    const faltan = tags.filter((t) => t === null).length;
    const distintos = [...new Set(tags.filter(Boolean))];
    let veredicto;
    if (faltan === tags.length)      { veredicto = 'FALTA EN TODOS'; todosPresentes = false; }
    else if (faltan > 0)             { veredicto = `FALTA EN ${faltan}/${tags.length}`; todosPresentes = false; }
    else if (distintos.length === 1) { veredicto = 'estable'; }
    else                             { veredicto = `INESTABLE: ${distintos.join(' | ')}`; todosEstables = false; }
    console.log(`  ${campo.label.padEnd(44)} ${veredicto}`);
  }

  console.log(`\n${'#'.repeat(78)}`);
  if (todosPresentes && todosEstables) {
    console.log('# Criterio "9 campos con los mismos tags en ambas emisoras": SE CUMPLE');
    console.log('# FALTA para GO: comparar cada número contra el PDF de IR (ver links abajo).');
  } else {
    console.log('# Criterio "9 campos con los mismos tags en ambas emisoras": NO SE CUMPLE');
    console.log('# -> esto apunta a NO-GO. Documentar la causa, no parchearla.');
  }
  console.log(`${'#'.repeat(78)}`);

  console.log(`\nPDFs para la verificación manual (comparar campo por campo):`);
  console.log(`  WALMEX  https://www.walmex.mx/informacion-financiera/trimestral.html`);
  console.log(`  FEMSA   https://femsa.com/es/inversionistas/reportes-y-filings/reportes-trimestrales/`);
}

/* ========================================================================= */
/* 6. Probe de red                                                           */
/* ========================================================================= */

async function probe() {
  console.log(`\n${'#'.repeat(78)}`);
  console.log(`# PROBE DE RED — puntos de entrada documentados`);
  console.log(`# Ninguno verificado desde el sandbox del agente (403 en el proxy).`);
  console.log(`${'#'.repeat(78)}\n`);

  for (const e of ENTRADAS) {
    const t0 = Date.now();
    try {
      const res = await fetch(e.url, { redirect: 'manual', headers: { 'User-Agent': 'quantdesk-fase0/0.1' } });
      const ms = Date.now() - t0;
      const ct = res.headers.get('content-type') || '—';
      const loc = res.headers.get('location');
      const cookie = res.headers.get('set-cookie');
      console.log(`  ${String(res.status).padEnd(4)} ${ms.toString().padStart(5)}ms  ${e.nombre}`);
      console.log(`       ${e.url}`);
      console.log(`       content-type: ${ct}`);
      if (loc) console.log(`       -> redirect: ${loc}`);
      if (cookie) console.log(`       set-cookie: ${cookie.slice(0, 120)}  <-- ¿sesión requerida?`);
    } catch (err) {
      console.log(`  ERR  ${' '.repeat(7)}  ${e.nombre}`);
      console.log(`       ${e.url}`);
      console.log(`       ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // cortesía: no martillar BMV
  }
  console.log(`\nQué anotar de esto: status 200 sin set-cookie y con content-type de`);
  console.log(`zip/xml = descarga directa viable. 302 a un login, o set-cookie con`);
  console.log(`JSESSIONID/ASP.NET_SessionId antes de poder bajar = exige sesión = NO-GO.`);
}

/* ========================================================================= */
/* 7. Main                                                                   */
/* ========================================================================= */

function inferirDeNombre(nombre) {
  const n = basename(nombre).toLowerCase();
  const emisora = /walmex/.test(n) ? 'WALMEX' : /femsa/.test(n) ? 'FEMSA' : null;
  const anio = (/(20\d{2})/.exec(n) || [])[1];
  const trim = (/(?:_|-|t)([1-4])(?:_|-|\.|$)/.exec(n) || [])[1];
  if (!emisora || !anio || !trim) return null;
  const periodEnd = { 1: `${anio}-03-31`, 2: `${anio}-06-30`, 3: `${anio}-09-30`, 4: `${anio}-12-31` }[trim];
  return { emisora, anio: Number(anio), trim: Number(trim), periodEnd };
}

async function main() {
  const argv = process.argv.slice(2);
  const tiene = (f) => argv.includes(f);
  const valor = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  mkdirSync(OUT_DIR, { recursive: true });

  if (tiene('--probe')) { await probe(); return; }

  /* ---- modo un solo archivo ---- */
  if (tiene('--file')) {
    const f = valor('--file');
    if (!f || !existsSync(f)) { console.error(`No existe: ${f}`); process.exit(1); }
    const meta = inferirDeNombre(f);
    const periodEnd = valor('--period-end') || meta?.periodEnd;
    if (!periodEnd) {
      console.error(`No pude inferir el periodo de "${basename(f)}" y no lo voy a adivinar.`);
      console.error(`Pásalo explícito:  --file ${f} --period-end 2025-06-30`);
      process.exit(1);
    }
    const { xml, origen } = extraerInstance(readFileSync(f), basename(f));
    analizarArchivo(origen, periodEnd, xml, { dumpTags: tiene('--dump-tags') });
    return;
  }

  /* ---- modo manual: directorio con los 4 archivos bajados a mano ---- */
  if (tiene('--manual')) {
    const dir = valor('--manual');
    if (!dir || !existsSync(dir)) { console.error(`No existe el directorio: ${dir}`); process.exit(1); }
    const archivos = readdirSync(dir).filter((f) => /\.(zip|xbrl|xml)$/i.test(f));
    if (!archivos.length) { console.error(`Sin .zip/.xbrl/.xml en ${dir}`); process.exit(1); }

    const porArchivo = [];
    for (const f of archivos) {
      const meta = inferirDeNombre(f);
      if (!meta) {
        console.log(`\n[saltado] ${f}: no pude inferir emisora/año/trimestre del nombre.`);
        console.log(`          Renómbralo tipo walmex_2025_2.zip, o úsalo con --file ... --period-end`);
        continue;
      }
      try {
        const { xml, origen } = extraerInstance(readFileSync(join(dir, f)), f);
        const resultado = analizarArchivo(origen, meta.periodEnd, xml, { dumpTags: tiene('--dump-tags') });
        porArchivo.push({ ...meta, resultado });
      } catch (err) {
        console.log(`\n[error] ${f}: ${err.message}`);
      }
    }
    if (porArchivo.length) tablaResumen(porArchivo);
    if (porArchivo.length < 4) {
      console.log(`\nOJO: se analizaron ${porArchivo.length}/4 archivos objetivo. La tabla de`);
      console.log(`estabilidad de tags sólo es concluyente con los 4.`);
    }
    return;
  }

  /* ---- modo automático ---- */
  await probe();
  console.log(`\n\n${'#'.repeat(78)}`);
  console.log(`# DESCARGA AUTOMÁTICA: NO IMPLEMENTADA — a propósito.`);
  console.log(`${'#'.repeat(78)}`);
  console.log(`
La URL exacta del archivo XBRL por emisora+trimestre NO se pudo verificar desde
el entorno del agente (todo bmv.com.mx da 403 en el proxy de egress). Escribir
aquí un patrón de URL supuesto sería inventarlo, que es exactamente lo que este
memo no debe hacer.

Qué hacer, en orden:

  1) Corre el probe de arriba y mira cuál entrada responde 200 sin set-cookie.
  2) Abre la ficha de la emisora en el navegador, con la pestaña Network abierta,
     y baja UN trimestre a mano. Copia la URL real del request del archivo.
  3) Si esa URL es estable y parametrizable (emisora/año/trimestre), pégala en
     ENTRADAS y automatizar es trivial. Si depende de un id de envío opaco o de
     una cookie de sesión, eso ya es el veredicto: NO-GO por sesión.
  4) Mientras tanto, para no bloquear el smoke, baja los 4 a mano y corre:

       node scripts/xbrl-smoke.mjs --manual ${OUT_DIR}

     nombrando los archivos walmex_2025_2.zip, walmex_2025_4.zip,
     femsa_2025_2.zip, femsa_2025_4.zip
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
