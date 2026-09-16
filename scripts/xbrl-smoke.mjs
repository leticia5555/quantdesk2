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

/*
 * BMV publica gratis SÓLO el trimestre más reciente por emisora (§1 del doc),
 * así que el par WALMEX/FEMSA va sobre 2T2026 y no sobre dos trimestres.
 * El archivo viejo (4T2016, de CNBV) NO está para comparar números: está para
 * ver si la VERSIÓN de taxonomía cambió en 10 años y si los tags sobreviven.
 */
const TARGETS = [
  { emisora: 'WALMEX', anio: 2026, trim: 2, periodEnd: '2026-06-30', fuente: 'BMV docs-pub' },
  { emisora: 'FEMSA',  anio: 2026, trim: 2, periodEnd: '2026-06-30', fuente: 'BMV docs-pub' },
  { emisora: '(la que salga)', anio: 2016, trim: 4, periodEnd: '2016-12-31', fuente: 'CNBV — prueba de versión de taxonomía' },
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
  /*
   * Deuda con costo: [VERIFICADO en 2T2026 de WALMEX y FEMSA].
   * La extensión mexicana resuelve lo que IFRS no: distingue explícitamente
   * crédito CON costo de crédito SIN costo. La deuda con costo es la SUMA de
   * tres componentes, y OtrosCreditosSinCostoA*Plazo queda FUERA a propósito.
   * Los arrendamientos IFRS-16 viven en tags aparte (ver CAMPOS_EXTRA): no se
   * suman aquí porque D3 sigue abierta, y tenerlos separados es justo lo que
   * permite decidirla.
   */
  {
    key: 'deuda_corto',
    label: 'Deuda con costo — corto plazo',
    tipo: 'instant',
    componentes: [
      'CreditosBancariosACortoPlazo',      // [VERIFICADO] ifrs_mx
      'CreditosBursatilesACortoPlazo',     // [VERIFICADO] ifrs_mx
      'OtrosCreditosConCostoACortoPlazo',  // [VERIFICADO] ifrs_mx
    ],
  },
  {
    key: 'deuda_largo',
    label: 'Deuda con costo — largo plazo',
    tipo: 'instant',
    componentes: [
      'CreditosBancariosALargoPlazo',      // [VERIFICADO] ifrs_mx
      'CreditosBursatilesALargoPlazo',     // [VERIFICADO] ifrs_mx
      'OtrosCreditosConCostoALargoPlazo',  // [VERIFICADO] ifrs_mx
    ],
  },
  {
    key: 'acciones_circulacion',
    label: 'Acciones en circulación',
    tipo: 'instant',
    candidatos: [
      'NumeroDeAccionesEnCirculacion', // [VERIFICADO] ifrs_mx — es literal
      'NumberOfSharesOutstanding',     // [DESCUBRIR] fallback IFRS, no visto en BMV
    ],
    nota: 'La extensión mexicana lo da literal. NumeroDeAccionesRecompradas ' +
          '(en tesorería) es otro tag y NO se resta: ya viene descontado.',
  },
];

/*
 * Extras informativos — no son de los 9 campos, pero sin ellos no se puede
 * cerrar D3 (¿los arrendamientos IFRS-16 cuentan como deuda con costo?).
 */
const CAMPOS_EXTRA = [
  { key: 'arrend_corto', label: '(extra) Arrendamientos IFRS-16 — corto plazo',
    tipo: 'instant', candidatos: ['CurrentLeaseLiabilities'] },
  { key: 'arrend_largo', label: '(extra) Arrendamientos IFRS-16 — largo plazo',
    tipo: 'instant', candidatos: ['NoncurrentLeaseLiabilities'] },
];

/*
 * Décimo dato del censo: la fecha del reporte. Hay que separar tres cosas que
 * NO son lo mismo, porque confundirlas es look-ahead directo en el backtest:
 *
 *   1. Fecha de ENVÍO a BMV/CNBV  <- la correcta para evitar look-ahead (D8).
 *      NO viene en el instance. Sale del listado de la página de la emisora,
 *      con hora (ej. "23-Jul-2026 14:11"). Este script NO la resuelve.
 *   2. Fecha de AUTORIZACIÓN del consejo <- lo mejor que hay dentro del
 *      archivo. Es un proxy, y va antes que el envío. Se reporta como tal.
 *   3. Fecha de CIERRE del periodo <- NO es una fecha de publicación. Se
 *      imprime sólo como dato secundario y etiquetado, para que nadie la use
 *      como si lo fuera.
 */
const FECHA_AUTORIZACION_CANDIDATOS = [
  'DateOfAuthorisationForIssueOfFinancialStatements', // [IFRS] fecha del consejo
];
const FECHA_CIERRE_CANDIDATOS = [
  'DateOfEndOfReportingPeriod2013', // [DESCUBRIR] cierre de periodo, NO publicación
];

/* ========================================================================= */
/* 2. Censo de red: candidatos de entrada                                    */
/* ========================================================================= */
/*
 * Puntos de entrada (ver docs/xbrl-fase0.md §1).
 *
 * El primero está VERIFICADO fuera del sandbox: BMV sirve gratis y sin sesión
 * el XBRL del trimestre más reciente por emisora bajo docs-pub/ifrsxbrl/. El
 * resto sigue sin verificar (403 de egress desde aquí). El probe está para
 * cerrar esa diferencia con evidencia, no con opinión.
 */
const ENTRADAS = [
  { nombre: 'BMV docs-pub ifrsxbrl — VERIFICADO libre (Bimbo 2T2026)',
    url: 'https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_1576474_2026-02_1.zip' },
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
  { nombre: 'BMV pubsys2 — catálogo del XBRL histórico (de pago)',
    url: 'https://pubsys2.bmv.com.mx/productdetails.aspx?i=1417' },
  { nombre: 'emisnet',
    url: 'https://emisnet.bmv.com.mx/' },
  { nombre: 'CNBV visor XBRL — histórico público, pero robots.txt lo prohíbe',
    url: 'https://xbrl.cnbv.gob.mx/' },
  { nombre: 'CNBV robots.txt — LEER ESTO ANTES DE COSECHAR',
    url: 'https://xbrl.cnbv.gob.mx/robots.txt' },
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

/* =========================================================================
 * Parser del JSON propietario de BMV.
 *
 * OJO: docs-pub NO sirve XBRL estándar. Sirve el volcado del modelo interno
 * del editor de BMV/EMISNET, en JSON y con claves en español (incluye cosas
 * como PuedeEscribir, Bloqueado, IdUsuarioBloqueo). No es xBRL-JSON de la OIM,
 * así que ninguna herramienta XBRL estándar lo lee. Ver §1.1 del doc.
 *
 * Se normaliza a la MISMA forma que produce el parser de XML, para que todo
 * lo de abajo (resolución de campos, tablas, criterio) funcione igual.
 * ========================================================================= */

const soloFecha = (f) => (f ? String(f).slice(0, 10) : null);

function parsearJsonBmv(txt) {
  const j = JSON.parse(txt);
  if (!j.HechosPorId || !j.ContextosPorId) {
    throw new Error('JSON sin HechosPorId/ContextosPorId: no es el formato de BMV');
  }

  const contextos = new Map();
  for (const c of Object.values(j.ContextosPorId)) {
    const per = c.Periodo || {};
    contextos.set(c.Id, {
      id: c.Id,
      // Periodo.Tipo: 1 = instante, 2 = duración [VERIFICADO en los archivos 2T2026]
      instant: per.Tipo === 1 ? soloFecha(per.FechaInstante) : null,
      startDate: per.Tipo === 2 ? soloFecha(per.FechaInicio) : null,
      endDate: per.Tipo === 2 ? soloFecha(per.FechaFin) : null,
      entidad: null,
      dimensionado: !!c.ContieneInformacionDimensional,
    });
  }

  const hechos = [];
  for (const h of Object.values(j.HechosPorId)) {
    const local = h.NombreConcepto;
    if (!local) continue;
    // IdConcepto viene como "<prefijo>_<NombreConcepto>"; se recorta por longitud
    // en vez de por split("_") porque el prefijo mexicano trae guiones bajos
    // (ifrs_mx-cor_20141205_CreditosBancariosACortoPlazo).
    let prefijo = '';
    if (h.IdConcepto && h.IdConcepto.endsWith('_' + local)) {
      prefijo = h.IdConcepto.slice(0, h.IdConcepto.length - local.length - 1);
    } else if (h.EspacioNombres) {
      prefijo = h.EspacioNombres.split('/').pop();
    }
    hechos.push({
      qname: prefijo ? `${prefijo}:${local}` : local,
      prefijo, local,
      contextRef: h.IdContexto,
      unitRef: h.IdUnidad,
      decimals: h.Decimales == null ? null : String(h.Decimales),
      scale: null, sign: null,
      nil: !!h.EsValorNil,
      valorCrudo: h.EsValorNil ? null
        : (h.ValorNumerico != null ? String(h.ValorNumerico)
          : (h.Valor == null ? null : String(h.Valor).trim())),
    });
  }

  const ns = {};
  for (const h of Object.values(j.HechosPorId)) {
    const local = h.NombreConcepto;
    if (!local || !h.IdConcepto || !h.EspacioNombres) continue;
    if (h.IdConcepto.endsWith('_' + local)) {
      ns[h.IdConcepto.slice(0, h.IdConcepto.length - local.length - 1)] = h.EspacioNombres;
    }
  }
  return { contextos, hechos, meta: { entryPoint: j.EspacioNombresPrincipal, ns } };
}

/** Saca el instance (.xbrl/.xml, o el .json de BMV) de un zip o archivo suelto. */
function extraerInstance(buf, nombreArchivo) {
  const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!esZip) {
    const txt = buf.toString('utf8');
    const ini = txt.slice(0, 200).trimStart()[0];
    return ini === '{' ? { json: txt, origen: nombreArchivo } : { xml: txt, origen: nombreArchivo };
  }

  const archivos = leerZip(buf);
  // (1) XBRL estándar: el que tiene elemento raíz xbrl (los .xsd/linkbases no).
  for (const a of archivos.filter((x) => x.datos && /\.(xbrl|xml)$/i.test(x.nombre))) {
    const txt = a.datos.toString('utf8');
    if (/<(\w+:)?xbrl[\s>]/.test(txt)) return { xml: txt, origen: `${nombreArchivo}!${a.nombre}` };
  }
  // (2) JSON propietario de BMV (lo que sirve docs-pub hoy).
  for (const a of archivos.filter((x) => x.datos && /\.json$/i.test(x.nombre))) {
    return { json: a.datos.toString('utf8'), origen: `${nombreArchivo}!${a.nombre}` };
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
/** Suma de componentes (deuda con costo). Un componente ausente NO es cero:
 *  se reporta aparte para que no se confunda "no reportado" con "reportó 0". */
function resolverSuma(campo, hechos, contextos, periodEnd) {
  const halladas = [], faltantes = [];
  for (const comp of campo.componentes) {
    const h = hechos.find((x) => {
      if (x.local !== comp) return false;
      const c = contextos.get(x.contextRef);
      if (!c || c.dimensionado) return false;
      if (aNumero(x) === null) return false;
      return c.instant === periodEnd;
    });
    if (h) halladas.push({ comp, valor: aNumero(h), qname: h.qname, unidad: h.unitRef, decimals: h.decimals });
    else faltantes.push(comp);
  }
  if (!halladas.length) return { encontrado: false, tag: null, opciones: [], faltantes };

  const total = halladas.reduce((a, b) => a + b.valor, 0);
  const pref = halladas[0].qname.split(':')[0];
  return {
    encontrado: true,
    tag: `Σ ${campo.componentes.length} comp.`,
    esSuma: true,
    componentes: halladas,
    faltantes,
    opciones: [{
      tag: `${pref}:Σ(${halladas.map((x) => x.comp).join('+')})`,
      valor: total, ventana: 'instant', ventanaKey: 'instant', meses: 0,
      unidad: halladas[0].unidad, decimals: halladas[0].decimals, ctx: null,
    }],
    ambiguo: false,
  };
}

function resolverCampo(campo, hechos, contextos, periodEnd) {
  if (campo.componentes) return resolverSuma(campo, hechos, contextos, periodEnd);
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
      let ventana = 'instant', ventanaKey = 'instant', meses = 0;
      if (campo.tipo === 'duration' && c.startDate) {
        meses = Math.round(
          (Date.parse(c.endDate) - Date.parse(c.startDate)) / (1000 * 60 * 60 * 24 * 30.44)
        );
        ventana = `${meses}m (${c.startDate}→${c.endDate})`;
        ventanaKey = `${meses}m`; // normalizada: comparable ENTRE archivos
      }
      return { tag: h.qname, valor: aNumero(h), ventana, ventanaKey, meses,
               unidad: h.unitRef, decimals: h.decimals, ctx: c.id };
    });
    // Orden determinista (ventana más corta primero). Sin esto, "la opción [0]"
    // dependería del orden del documento y la comparación entre archivos mentiría.
    opciones.sort((a, b) => a.meses - b.meses);
    return { encontrado: true, tag: `${cand}`, opciones, ambiguo: opciones.length > 1 };
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

function analizarArchivo(etiqueta, periodEnd, fuente, opts = {}) {
  let contextos, hechos, ns = {}, entryPoint = null, formato;
  if (fuente.json != null) {
    formato = 'JSON propietario BMV';
    const r = parsearJsonBmv(fuente.json);
    contextos = r.contextos; hechos = r.hechos; ns = r.meta.ns; entryPoint = r.meta.entryPoint;
  } else {
    formato = 'XBRL XML estándar';
    contextos = parsearContextos(fuente.xml);
    hechos = parsearHechos(fuente.xml);
    const nsRe = /xmlns:([\w.-]+)="([^"]+)"/g; let mm;
    while ((mm = nsRe.exec(fuente.xml.slice(0, 8000))) !== null) ns[mm[1]] = mm[2];
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`ARCHIVO: ${etiqueta}   (cierre de periodo objetivo: ${periodEnd})`);
  console.log(`${'='.repeat(78)}`);
  console.log(`formato: ${formato}`);
  if (entryPoint) console.log(`entry point de taxonomía: ${entryPoint}`);
  console.log(`contextos: ${contextos.size} (${[...contextos.values()].filter((c) => !c.dimensionado).length} sin dimensiones)  |  hechos: ${hechos.length}`);

  const prefijos = [...new Set(hechos.map((h) => h.prefijo))].sort();
  console.log(`prefijos/namespaces de los hechos:`);
  for (const p of prefijos) console.log(`    ${p}${ns[p] ? ' → ' + ns[p] : ''}`);

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
    if (r.esSuma) {
      for (const c of r.componentes) {
        console.log(`  ${''.padEnd(44)} ${fmt(c.valor).padStart(20)}     + ${c.comp}`);
      }
      if (r.faltantes.length) {
        console.log(`  ${''.padEnd(44)} ${''.padStart(20)}     ! NO REPORTADOS (≠ cero): ${r.faltantes.join(', ')}`);
      }
    }
    for (const alt of r.opciones.slice(1)) {
      console.log(`  ${''.padEnd(44)} ${fmt(alt.valor).padStart(20)}  ^^ OTRA VENTANA: ${alt.ventana}  <-- OJO, ambigüedad de periodo`);
    }
    if (campo.nota && r.opciones[0].tag.split(':')[1] !== campo.candidatos[0]) {
      console.log(`  ${''.padEnd(44)}        NOTA: ${campo.nota}`);
    }
  }

  /* Verificaciones internas: identidades contables que deben cumplirse dentro
   * del propio archivo. No sustituyen la comparación contra el PDF, pero son
   * la evidencia más fuerte que se puede producir SIN el PDF: si el extractor
   * estuviera tomando el contexto equivocado (un segmento, otra fecha, otra
   * ventana), estas sumas no cuadrarían. */
  console.log(`\n--- VERIFICACIONES INTERNAS (identidades contables) ---`);
  const unNum = (local, tipo, fecha) => {
    const h = hechos.find((x) => {
      if (x.local !== local) return false;
      const c = contextos.get(x.contextRef);
      if (!c || c.dimensionado) return false;
      if (aNumero(x) === null) return false;
      return tipo === 'instant' ? c.instant === fecha : c.endDate === fecha;
    });
    return h ? aNumero(h) : null;
  };
  const I = (n) => unNum(n, 'instant', periodEnd);
  const identidades = [
    ['Assets = Liabilities + Equity', I('Assets'), [I('Liabilities'), I('Equity')]],
    ['Assets = CurrentAssets + NoncurrentAssets', I('Assets'), [I('CurrentAssets'), I('NoncurrentAssets')]],
    ['Liabilities = Current + Noncurrent', I('Liabilities'), [I('CurrentLiabilities'), I('NoncurrentLiabilities')]],
    ['Equity = Controladora + NoControladora', I('Equity'), [I('EquityAttributableToOwnersOfParent'), I('NoncontrollingInterests')]],
  ];
  let identidadesOk = true;
  for (const [nombre, izq, partes] of identidades) {
    if (izq == null || partes.some((x) => x == null)) { console.log(`  ${nombre.padEnd(48)} n/d`); continue; }
    const dif = izq - partes.reduce((a, b) => a + b, 0);
    if (dif !== 0) identidadesOk = false;
    console.log(`  ${nombre.padEnd(48)} ${dif === 0 ? 'OK' : 'DESCUADRA por ' + fmt(dif)}`);
  }
  if (!identidadesOk) {
    console.log(`  >>> Una identidad que no cuadra casi siempre significa que se tomó el`);
    console.log(`      contexto equivocado, no que el emisor reportó mal. Revisar antes de seguir.`);
  }

  // D6 se decide con este número, así que se muestra siempre.
  const eqTotal = I('Equity'), eqCtrl = I('EquityAttributableToOwnersOfParent'), nci = I('NoncontrollingInterests');
  if (eqTotal != null && eqCtrl != null && eqTotal !== eqCtrl) {
    console.log(`  OJO D6: Equity TOTAL ${fmt(eqTotal)} vs CONTROLADORA ${fmt(eqCtrl)} (NCI ${fmt(nci)}).`);
    console.log(`          Son dos números distintos; el PDF puede mostrar cualquiera de los dos.`);
  }

  console.log(`\n--- EXTRAS (para decidir D3: ¿IFRS-16 es deuda con costo?) ---`);
  for (const campo of CAMPOS_EXTRA) {
    const r = resolverCampo(campo, hechos, contextos, periodEnd);
    if (r.encontrado) console.log(`  ${campo.label.padEnd(44)} ${fmt(r.opciones[0].valor).padStart(20)}  [${r.opciones[0].tag}]`);
    else console.log(`  ${campo.label.padEnd(44)} FALTA`);
  }

  console.log(`\n--- FECHAS DEL REPORTE ---`);
  const buscarFecha = (cands) => {
    for (const cand of cands) {
      const h = hechos.find((x) => x.local === cand && x.valorCrudo);
      if (h) return h;
    }
    return null;
  };

  const hAut = buscarFecha(FECHA_AUTORIZACION_CANDIDATOS);
  if (hAut) console.log(`  autorización del consejo : ${hAut.valorCrudo}   [${hAut.qname}]`);
  else console.log(`  autorización del consejo : FALTA (probados: ${FECHA_AUTORIZACION_CANDIDATOS.join(', ')}) — correr con --dump-tags`);

  const hCie = buscarFecha(FECHA_CIERRE_CANDIDATOS);
  if (hCie) console.log(`  [SECUNDARIO — NO es publicación] cierre de periodo: ${hCie.valorCrudo}   [${hCie.qname}]`);

  console.log(`  envío a BMV/CNBV         : NO ESTÁ EN EL INSTANCE.`);
  console.log(`      Es la fecha correcta contra look-ahead (D8 del doc). Hay que`);
  console.log(`      capturarla del listado de la emisora, con hora, p.ej. "23-Jul-2026 14:11".`);

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

  let hayAmbiguo = false;
  for (const campo of CAMPOS) {
    let fila = campo.label.padEnd(40);
    for (const a of porArchivo) {
      const r = a.resultado?.[campo.key];
      if (!r?.encontrado) { fila += 'FALTA'.padStart(w); continue; }
      // Si el campo tiene más de una ventana con el mismo cierre, el valor de
      // la tabla NO es un dato: es una elección. Se marca y no se disimula.
      const marca = r.ambiguo ? '*' : '';
      if (r.ambiguo) hayAmbiguo = true;
      fila += (fmt(r.opciones[0].valor) + marca).padStart(w);
    }
    console.log(fila);

    let fTag = '   tag usado'.padEnd(40);
    for (const a of porArchivo) {
      const r = a.resultado?.[campo.key];
      fTag += (r?.encontrado ? r.opciones[0].tag.split(':')[1].slice(0, w - 2) : '—').padStart(w);
    }
    console.log(fTag);

    let fVen = '   ventana'.padEnd(40);
    for (const a of porArchivo) {
      const r = a.resultado?.[campo.key];
      fVen += (r?.encontrado
        ? (r.opciones[0].ventanaKey + (r.ambiguo ? ' AMBIGUO' : ''))
        : '—').padStart(w);
    }
    console.log(fVen);
  }
  if (hayAmbiguo) {
    console.log(`\n  (*) AMBIGUO = el archivo trae más de una ventana que cierra en la misma`);
    console.log(`      fecha (típico: trimestre 3m y acumulado 6m/12m). Se muestra la más`);
    console.log(`      corta por convención, pero CUÁL es la correcta la decide D4, no el`);
    console.log(`      script. Verificar ese campo contra el PDF antes de creerle.`);
  }

  /* --- criterio GO/NO-GO: mismo TAG y misma VENTANA en todas las celdas ---
   *
   * El tag por sí solo no basta. Dos archivos pueden traer ifrs-full:Revenue
   * y aun así no ser comparables si uno lo reporta a 3 meses y el otro a 6:
   * mismos tags, series inservibles. La ventana entra al criterio.            */
  console.log(`\n${'#'.repeat(78)}`);
  console.log(`# ESTABILIDAD (criterio GO: mismo TAG y misma VENTANA en las ${porArchivo.length} celdas)`);
  console.log(`${'#'.repeat(78)}\n`);

  let todosEstables = true, todosPresentes = true;
  for (const campo of CAMPOS) {
    const celdas = porArchivo.map((a) => a.resultado?.[campo.key] ?? null);
    const tags = celdas.map((r) => r?.opciones?.[0]?.tag ?? null);
    const vens = celdas.map((r) => r?.opciones?.[0]?.ventanaKey ?? null);

    const faltan = tags.filter((t) => t === null).length;
    const tagsDistintos = [...new Set(tags.filter(Boolean))];
    const vensDistintas = [...new Set(vens.filter(Boolean))];
    const ambiguos = celdas.filter((r) => r?.ambiguo).length;

    let veredicto;
    if (faltan === tags.length) { veredicto = 'FALTA EN TODOS'; todosPresentes = false; }
    else if (faltan > 0)        { veredicto = `FALTA EN ${faltan}/${tags.length}`; todosPresentes = false; }
    else if (tagsDistintos.length > 1) {
      veredicto = `TAG INESTABLE: ${tagsDistintos.join(' | ')}`; todosEstables = false;
    } else if (vensDistintas.length > 1) {
      veredicto = `VENTANA INESTABLE: ${vensDistintas.join(' | ')} (mismo tag)`; todosEstables = false;
    } else {
      veredicto = `estable (${vensDistintas[0]})`;
    }
    if (ambiguos) veredicto += `  [${ambiguos} celda(s) AMBIGUA(s)]`;
    console.log(`  ${campo.label.padEnd(44)} ${veredicto}`);
  }

  console.log(`\n${'#'.repeat(78)}`);
  if (todosPresentes && todosEstables) {
    console.log('# Criterio "9 campos, mismo tag y misma ventana": SE CUMPLE');
    console.log('# FALTA para GO: comparar cada número contra el PDF de IR (ver links abajo).');
  } else {
    console.log('# Criterio "9 campos, mismo tag y misma ventana": NO SE CUMPLE');
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

/*
 * Se pega con DOS user-agents a propósito. Un sitio que contesta 200 al UA de
 * navegador y 403 al UA declarado de script no está "caído": está discriminando
 * por cliente, y eso es dato tanto de viabilidad como de términos de uso.
 * Disfrazar el cosechador de navegador para esquivarlo es una decisión que le
 * toca al dueño del proyecto, no al script; aquí sólo se mide y se reporta.
 */
const UAS = [
  { etiqueta: 'browser', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  { etiqueta: 'bot',     ua: 'quantdesk-fase0/0.1' },
];

async function probe() {
  console.log(`\n${'#'.repeat(78)}`);
  console.log(`# PROBE DE RED — puntos de entrada (2 user-agents por URL)`);
  console.log(`# Desde el sandbox del agente todo da 403 DEL PROXY (~3ms, text/plain).`);
  console.log(`# Corrido en local, un 403 real de BMV/CNBV se ve distinto.`);
  console.log(`${'#'.repeat(78)}\n`);

  for (const e of ENTRADAS) {
    console.log(`  ${e.nombre}`);
    console.log(`       ${e.url}`);
    const vistos = [];

    for (const { etiqueta, ua } of UAS) {
      const t0 = Date.now();
      try {
        const res = await fetch(e.url, { redirect: 'manual', headers: { 'User-Agent': ua } });
        const ms = Date.now() - t0;
        const ct = res.headers.get('content-type') || '—';
        const len = res.headers.get('content-length');
        const loc = res.headers.get('location');
        // getSetCookie() devuelve TODAS las cabeceras Set-Cookie por separado;
        // headers.get('set-cookie') las colapsa y pierde cookies.
        const cookies = typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);

        vistos.push(res.status);
        console.log(`       [${etiqueta.padEnd(7)}] ${String(res.status).padEnd(4)} ${String(ms).padStart(5)}ms  ${ct}${len ? `  ${len}B` : ''}`);
        if (loc) console.log(`                 -> redirect: ${loc}`);
        for (const c of cookies) {
          const nombre = c.split('=')[0];
          const sesion = /sessionid|jsessionid|phpsessid|asp\.net_sessionid/i.test(nombre);
          console.log(`                 set-cookie: ${nombre}${sesion ? '   <-- COOKIE DE SESIÓN' : ''}`);
        }
      } catch (err) {
        vistos.push('ERR');
        console.log(`       [${etiqueta.padEnd(7)}] ERR          ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 1200)); // cortesía: no martillar
    }

    if (vistos.length === 2 && vistos[0] !== vistos[1]) {
      console.log(`       >>> EL UA CAMBIA LA RESPUESTA (${vistos[0]} vs ${vistos[1]}) — anotarlo.`);
    }
    console.log('');
  }

  console.log(`Cómo leerlo:`);
  console.log(`  200 + content-type zip/xml + sin cookie de sesión  = descarga directa viable.`);
  console.log(`  302 a login, o cookie de sesión antes de poder bajar = exige sesión = NO-GO.`);
  console.log(`  200 con UA de navegador y 403 con UA de script = el sitio discrimina;`);
  console.log(`      es decisión tuya (no del script) si eso se respeta o se rodea.`);
  console.log(`  Y lee el robots.txt de CNBV antes de automatizar nada contra ese host.`);
}

/* ========================================================================= */
/* 7. Main                                                                   */
/* ========================================================================= */

const cierreDe = (anio, trim) =>
  ({ 1: `${anio}-03-31`, 2: `${anio}-06-30`, 3: `${anio}-09-30`, 4: `${anio}-12-31` })[trim];

/**
 * Infiere emisora/año/trimestre del nombre del archivo, sin renombrar nada.
 * Soporta las dos convenciones reales que vamos a tener en la carpeta:
 *
 *   BMV docs-pub : ifrsxbrl_1576474_2026-02_1.zip   (id interno numérico)
 *   CNBV         : ifrsxbrl_ALFA_2016-4.xbrl        (clave de pizarra)
 *   libre        : walmex_2026_2.zip
 *
 * En el caso de BMV la "emisora" es un id numérico que NO es derivable del
 * ticker: se reporta como id:<n> en vez de fingir que sabemos cuál es.
 */
/*
 * Mapa id de docs-pub -> clave de pizarra. Es el mapa que §5.3 del doc daba por
 * faltante; se llena a mano, una entrada por emisora, al bajar su archivo.
 * [VERIFICADO] las dos entradas, contra los zips de 2T2026.
 */
const ID_DOCSPUB_A_TICKER = {
  '1576010': 'WALMEX',
  '1577302': 'FEMSA',
};

function inferirDeNombre(nombre) {
  const base = basename(nombre);

  // (a) ifrsxbrl_<CLAVE|ID>_<AAAA>-<T>[_<n>].(xbrl|zip)
  let m = /ifrsxbrl_([^_]+)_(20\d{2})-(\d{1,2})/i.exec(base);
  if (m) {
    const [, clave, anio, t] = m;
    const trim = Number(t);
    if (trim >= 1 && trim <= 4) {
      const emisora = /^\d+$/.test(clave)
        ? (ID_DOCSPUB_A_TICKER[clave] || `id:${clave}`)
        : clave.toUpperCase();
      return { emisora, anio: Number(anio), trim, periodEnd: cierreDe(anio, trim) };
    }
  }

  // (b) <emisora>_<AAAA>_<T>
  m = /^([A-Za-z&.\-]+)[_-](20\d{2})[_-]([1-4])(?:[_.\-]|$)/.exec(base);
  if (m) {
    const [, emisora, anio, t] = m;
    return {
      emisora: emisora.toUpperCase(), anio: Number(anio),
      trim: Number(t), periodEnd: cierreDe(anio, Number(t)),
    };
  }

  return null;
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
    const fuente = extraerInstance(readFileSync(f), basename(f));
    analizarArchivo(fuente.origen, periodEnd, fuente, { dumpTags: tiene('--dump-tags') });
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
        const fuente = extraerInstance(readFileSync(join(dir, f)), f);
        const resultado = analizarArchivo(fuente.origen, meta.periodEnd, fuente, { dumpTags: tiene('--dump-tags') });
        porArchivo.push({ ...meta, resultado });
      } catch (err) {
        console.log(`\n[error] ${f}: ${err.message}`);
      }
    }
    if (porArchivo.length) tablaResumen(porArchivo);
    if (porArchivo.length < TARGETS.length) {
      console.log(`\nOJO: se analizaron ${porArchivo.length}/${TARGETS.length} archivos objetivo:`);
      for (const t of TARGETS) console.log(`       - ${t.emisora} ${t.trim}T${t.anio}  (${t.fuente})`);
      console.log(`La tabla de estabilidad sólo es concluyente con todos.`);
    }
    return;
  }

  /* ---- modo automático ---- */
  await probe();
  console.log(`\n\n${'#'.repeat(78)}`);
  console.log(`\n\n${'#'.repeat(78)}`);
  console.log(`# DESCARGA AUTOMÁTICA: NO IMPLEMENTADA — a propósito.`);
  console.log(`${'#'.repeat(78)}`);
  console.log(`
Lo que YA sabemos (verificado fuera de este entorno):

  * BMV sirve gratis y sin sesión el XBRL del trimestre MÁS RECIENTE por
    emisora, bajo un nombre estático:

        https://www.bmv.com.mx/docs-pub/ifrsxbrl/ifrsxbrl_<ID>_<AAAA>-<TT>_1.zip
        ej. Bimbo 2T2026 -> ifrsxbrl_1576474_2026-02_1.zip

  * Sólo se lista el último trimestre. El histórico BMV lo vende (pubsys2).
  * CNBV sí tiene el histórico público, pero su robots.txt prohíbe el acceso
    automatizado. Ver docs/xbrl-fase0.md §8 antes de escribir un cosechador.

Por qué aun así no automatizo la descarga aquí:

  El <ID> de docs-pub es un id interno de BMV (1576474 para Bimbo) que NO es
  el de la ficha de emisora (WALMEX-5214, FEMSA-5305) ni se deriva del ticker.
  Sin el mapa ticker -> id de docs-pub no se puede construir la URL, y ponerlo
  a adivinar sería inventarlo. Ese mapa es el entregable que falta.

Qué hacer:

  1) node scripts/xbrl-smoke.mjs --probe
     Confirma que el zip de ejemplo baja libre y mira si el UA cambia algo.

  2) Baja a mano, con la pestaña Network abierta, WALMEX y FEMSA 2T2026 desde
     BMV. Anota el <ID> de cada URL: con dos ya se ve si el mapa es estable.

  3) Si consigues un 4T2016 de CNBV, mételo a la misma carpeta: sirve para ver
     si la versión de taxonomía cambió en 10 años (no para comparar números).

  4) Corre la extracción sobre lo que tengas:

       node scripts/xbrl-smoke.mjs --manual ${OUT_DIR}

     Los nombres nativos ya se entienden (ifrsxbrl_<id>_<anio>-<t>_1.zip y
     ifrsxbrl_<CLAVE>_<anio>-<t>.xbrl); no hace falta renombrarlos.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
