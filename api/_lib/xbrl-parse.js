// ═══════════════════════════════════════════════════════════════
// api/_lib/xbrl-parse.js — lector del XBRL de BMV, extraído de
// scripts/xbrl-smoke.mjs para que lo use el capturador de /api/xbrl-capture.
//
// OJO: lo que BMV publica en docs-pub NO es XBRL estándar. Es un zip con un
// único .json que es el volcado del modelo interno del editor de EMISNET
// (claves en español, campos como `Bloqueado` e `IdUsuarioBloqueo`). Ninguna
// herramienta XBRL estándar lo lee. Ver docs/xbrl-fase0.md §1.1.
//
// Sin dependencias: zip con zlib + lectura del central directory.
//
// FAIL-CLOSED en todo: un campo que no resuelve, o cuyo contexto no es el
// consolidado del periodo pedido, sale `null` con `motivo`. Nunca se rellena
// con un proxy ni se adivina una escala.
// ═══════════════════════════════════════════════════════════════

import { inflateRawSync } from 'node:zlib';

/* ── 1. Los 9 campos ──────────────────────────────────────────────
 * Tags [VERIFICADO] contra WALMEX y FEMSA 2T2026 (docs/xbrl-fase0.md §6.2).
 * Deuda con costo es una SUMA: la extensión mexicana distingue crédito CON
 * costo de SIN costo, y los arrendamientos IFRS-16 viven en tags aparte que
 * NO se suman aquí (decisión D3 sigue abierta — se guardan como extras). */
export const CAMPOS = [
  { key: 'ingresos', label: 'Ingresos', tipo: 'duration',
    candidatos: ['Revenue', 'RevenueFromContractsWithCustomers'] },
  { key: 'utilidad_neta_atribuible', label: 'Utilidad neta atribuible a la controladora', tipo: 'duration',
    candidatos: ['ProfitLossAttributableToOwnersOfParent'] },
  { key: 'activos_totales', label: 'Activos totales', tipo: 'instant', candidatos: ['Assets'] },
  { key: 'pasivos_totales', label: 'Pasivos totales', tipo: 'instant', candidatos: ['Liabilities'] },
  { key: 'capital_contable', label: 'Capital contable', tipo: 'instant', candidatos: ['Equity'] },
  { key: 'efectivo', label: 'Efectivo y equivalentes', tipo: 'instant', candidatos: ['CashAndCashEquivalents'] },
  { key: 'deuda_corto', label: 'Deuda con costo — corto plazo', tipo: 'instant',
    componentes: ['CreditosBancariosACortoPlazo', 'CreditosBursatilesACortoPlazo', 'OtrosCreditosConCostoACortoPlazo'] },
  { key: 'deuda_largo', label: 'Deuda con costo — largo plazo', tipo: 'instant',
    componentes: ['CreditosBancariosALargoPlazo', 'CreditosBursatilesALargoPlazo', 'OtrosCreditosConCostoALargoPlazo'] },
  { key: 'acciones_circulacion', label: 'Acciones en circulación', tipo: 'instant',
    candidatos: ['NumeroDeAccionesEnCirculacion'] },
];

/* Extras: no son de los 9, pero sin ellos no corren 3 de las 4 identidades
 * ni se puede decidir D3 (¿IFRS-16 cuenta como deuda con costo?). */
export const EXTRAS = [
  { key: 'capital_controladora', tipo: 'instant', candidatos: ['EquityAttributableToOwnersOfParent'] },
  { key: 'participacion_no_control', tipo: 'instant', candidatos: ['NoncontrollingInterests'] },
  { key: 'activo_circulante', tipo: 'instant', candidatos: ['CurrentAssets'] },
  { key: 'activo_no_circulante', tipo: 'instant', candidatos: ['NoncurrentAssets'] },
  { key: 'pasivo_circulante', tipo: 'instant', candidatos: ['CurrentLiabilities'] },
  { key: 'pasivo_no_circulante', tipo: 'instant', candidatos: ['NoncurrentLiabilities'] },
  { key: 'arrendamientos_corto', tipo: 'instant', candidatos: ['CurrentLeaseLiabilities'] },
  { key: 'arrendamientos_largo', tipo: 'instant', candidatos: ['NoncurrentLeaseLiabilities'] },
];

export const FECHA_AUTORIZACION = ['DateOfAuthorisationForIssueOfFinancialStatements'];

/** Cierre de periodo de un trimestre. 1→31-mar, 2→30-jun, 3→30-sep, 4→31-dic. */
export function cierreDeTrimestre(anio, trimestre) {
  const t = Number(trimestre);
  return ({ 1: `${anio}-03-31`, 2: `${anio}-06-30`, 3: `${anio}-09-30`, 4: `${anio}-12-31` })[t] || null;
}

/* ── 2. ZIP ─────────────────────────────────────────────────────── */

export function leerZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido: sin end-of-central-directory');

  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28);
    const eLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const offLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + nLen);
    p += 46 + nLen + eLen + cLen;

    if (buf.readUInt32LE(offLocal) !== 0x04034b50) continue;
    const ini = offLocal + 30 + buf.readUInt16LE(offLocal + 26) + buf.readUInt16LE(offLocal + 28);
    const crudo = buf.subarray(ini, ini + tamComp);
    if (metodo === 0) out.push({ nombre, datos: crudo });
    else if (metodo === 8) out.push({ nombre, datos: inflateRawSync(crudo) });
    else out.push({ nombre, error: `método de compresión ${metodo} no soportado` });
  }
  return out;
}

/** Saca el texto del .json de BMV que viene dentro del zip. */
export function extraerJsonDelZip(buf) {
  const archivos = leerZip(buf);
  const j = archivos.find((a) => a.datos && /\.json$/i.test(a.nombre));
  if (!j) {
    throw new Error(`El zip no trae .json. Contenido: ${archivos.map((a) => a.nombre).join(', ') || '(vacío)'}`);
  }
  return { texto: j.datos.toString('utf8'), nombre: j.nombre };
}

/* ── 3. Instance JSON de BMV → forma normalizada ─────────────────── */

const soloFecha = (f) => (f ? String(f).slice(0, 10) : null);

export function parsearJsonBmv(texto) {
  const j = typeof texto === 'string' ? JSON.parse(texto) : texto;
  if (!j || !j.HechosPorId || !j.ContextosPorId) {
    throw new Error('JSON sin HechosPorId/ContextosPorId: no es el formato de BMV');
  }

  const contextos = new Map();
  for (const c of Object.values(j.ContextosPorId)) {
    const per = c.Periodo || {};
    contextos.set(c.Id, {
      id: c.Id,
      // Periodo.Tipo: 1 = instante, 2 = duración. [VERIFICADO] en los 2T2026.
      instant: per.Tipo === 1 ? soloFecha(per.FechaInstante) : null,
      startDate: per.Tipo === 2 ? soloFecha(per.FechaInicio) : null,
      endDate: per.Tipo === 2 ? soloFecha(per.FechaFin) : null,
      dimensionado: !!c.ContieneInformacionDimensional,
    });
  }

  const hechos = [];
  const ns = {};
  for (const h of Object.values(j.HechosPorId)) {
    const local = h.NombreConcepto;
    if (!local) continue;
    // IdConcepto = "<prefijo>_<NombreConcepto>"; se recorta por longitud porque
    // el prefijo mexicano trae guiones bajos (ifrs_mx-cor_20141205_Creditos...).
    let prefijo = '';
    if (h.IdConcepto && h.IdConcepto.endsWith('_' + local)) {
      prefijo = h.IdConcepto.slice(0, h.IdConcepto.length - local.length - 1);
      if (h.EspacioNombres) ns[prefijo] = h.EspacioNombres;
    }
    hechos.push({
      qname: prefijo ? `${prefijo}:${local}` : local,
      local,
      contextRef: h.IdContexto,
      unitRef: h.IdUnidad,
      decimals: h.Decimales == null ? null : String(h.Decimales),
      nil: !!h.EsValorNil,
      valor: h.EsValorNil ? null
        : (h.ValorNumerico != null ? Number(h.ValorNumerico) : null),
      texto: h.EsValorNil ? null : (h.Valor == null ? null : String(h.Valor).trim()),
    });
  }

  return { contextos, hechos, entryPoint: j.EspacioNombresPrincipal || null, ns };
}

/* ── 4. Resolución de campos ─────────────────────────────────────── */

function mesesEntre(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / (1000 * 60 * 60 * 24 * 30.44));
}

/** Hechos no dimensionados, numéricos, del periodo pedido. */
function candidatosDe(local, tipo, hechos, contextos, periodEnd) {
  return hechos.filter((h) => {
    if (h.local !== local || h.valor == null || !Number.isFinite(h.valor)) return false;
    const c = contextos.get(h.contextRef);
    if (!c || c.dimensionado) return false;            // sólo consolidado total
    return tipo === 'instant' ? c.instant === periodEnd : c.endDate === periodEnd;
  });
}

/**
 * Resuelve un campo simple. Para flujos, la ventana de 3 MESES es la principal
 * cuando existe (D4); las demás se devuelven en `otras_ventanas`.
 */
function resolverSimple(campo, hechos, contextos, periodEnd) {
  for (const cand of campo.candidatos) {
    const pegan = candidatosDe(cand, campo.tipo, hechos, contextos, periodEnd);
    if (!pegan.length) continue;

    const ops = pegan.map((h) => {
      const c = contextos.get(h.contextRef);
      const meses = campo.tipo === 'duration' && c.startDate ? mesesEntre(c.startDate, c.endDate) : 0;
      return { valor: h.valor, tag: h.qname, ventana: campo.tipo === 'instant' ? 'instant' : `${meses}m`, meses, decimals: h.decimals };
    });
    ops.sort((a, b) => a.meses - b.meses); // la ventana más corta manda
    const [pri, ...resto] = ops;
    return {
      ok: true, valor: pri.valor, tag: pri.tag, ventana: pri.ventana, decimals: pri.decimals,
      otras_ventanas: resto.map((o) => ({ ventana: o.ventana, valor: o.valor })),
      motivo: null,
    };
  }
  return { ok: false, valor: null, tag: null, ventana: null, otras_ventanas: [], motivo: `ningún tag resolvió (probados: ${campo.candidatos.join(', ')})` };
}

/** Deuda con costo: suma de componentes. Un componente ausente NO es cero. */
function resolverSuma(campo, hechos, contextos, periodEnd) {
  const halladas = [], faltantes = [];
  for (const comp of campo.componentes) {
    const h = candidatosDe(comp, 'instant', hechos, contextos, periodEnd)[0];
    if (h) halladas.push({ comp, valor: h.valor, tag: h.qname });
    else faltantes.push(comp);
  }
  if (!halladas.length) {
    return { ok: false, valor: null, tag: null, ventana: null, componentes: [], faltantes, motivo: 'ningún componente de deuda presente' };
  }
  const pref = halladas[0].tag.split(':')[0];
  return {
    ok: true,
    valor: halladas.reduce((a, b) => a + b.valor, 0),
    tag: `${pref}:Σ(${halladas.map((x) => x.comp).join('+')})`,
    ventana: 'instant',
    componentes: halladas,
    faltantes,
    otras_ventanas: [],
    motivo: faltantes.length ? `no reportados (≠ cero): ${faltantes.join(', ')}` : null,
  };
}

export function resolverCampo(campo, hechos, contextos, periodEnd) {
  return campo.componentes
    ? resolverSuma(campo, hechos, contextos, periodEnd)
    : resolverSimple(campo, hechos, contextos, periodEnd);
}

/* ── 5. Identidades contables ────────────────────────────────────── */

export function identidadesContables(v) {
  const g = (k) => (v[k] == null ? null : v[k]);
  const pruebas = [
    ['activos_eq_pasivos_capital', g('activos_totales'), [g('pasivos_totales'), g('capital_contable')]],
    ['activos_eq_circ_nocirc', g('activos_totales'), [g('activo_circulante'), g('activo_no_circulante')]],
    ['pasivos_eq_circ_nocirc', g('pasivos_totales'), [g('pasivo_circulante'), g('pasivo_no_circulante')]],
    ['capital_eq_ctrl_nocrtl', g('capital_contable'), [g('capital_controladora'), g('participacion_no_control')]],
  ];
  const out = {};
  for (const [nombre, izq, partes] of pruebas) {
    if (izq == null || partes.some((x) => x == null)) { out[nombre] = { estado: 'n/d', dif: null }; continue; }
    const dif = izq - partes.reduce((a, b) => a + b, 0);
    out[nombre] = { estado: dif === 0 ? 'ok' : 'dif', dif };
  }
  return out;
}

/* ── 6. Entrada principal ────────────────────────────────────────── */

/**
 * Del zip crudo de BMV a los 9 campos normalizados.
 *
 * @param {Buffer} zipBuffer  el .zip tal como lo sirve docs-pub
 * @param {{anio:number|string, trimestre:number|string}} periodo
 * @returns {{periodEnd, entryPoint, campos, extras, valores, identidades,
 *            fecha_autorizacion, raw, alertas}}
 */
export function extraerDeZip(zipBuffer, periodo) {
  const periodEnd = cierreDeTrimestre(periodo.anio, periodo.trimestre);
  if (!periodEnd) throw new Error(`trimestre inválido: ${periodo.trimestre}`);

  const { texto } = extraerJsonDelZip(zipBuffer);
  const raw = JSON.parse(texto);
  const { contextos, hechos, entryPoint } = parsearJsonBmv(raw);

  const campos = {}, extras = {}, valores = {};
  for (const c of CAMPOS) {
    const r = resolverCampo(c, hechos, contextos, periodEnd);
    campos[c.key] = r;
    valores[c.key] = r.ok ? r.valor : null;
  }
  for (const e of EXTRAS) {
    const r = resolverCampo(e, hechos, contextos, periodEnd);
    extras[e.key] = r;
    valores[e.key] = r.ok ? r.valor : null;
  }

  let fechaAut = null;
  for (const cand of FECHA_AUTORIZACION) {
    const h = hechos.find((x) => x.local === cand && x.texto);
    if (h) { fechaAut = h.texto.slice(0, 10); break; }
  }

  const identidades = identidadesContables(valores);

  // Alertas: no bloquean el guardado del raw, pero viajan al resumen.
  const alertas = [];
  const faltan = CAMPOS.filter((c) => !campos[c.key].ok).map((c) => c.key);
  if (faltan.length) alertas.push(`campos sin resolver: ${faltan.join(', ')}`);
  for (const [k, v] of Object.entries(identidades)) {
    if (v.estado === 'dif') alertas.push(`identidad ${k} descuadra por ${v.dif}`);
  }
  if (!entryPoint || !/ics/i.test(entryPoint)) {
    alertas.push(`entry point inesperado (¿no es ICS?): ${entryPoint || 'ausente'}`);
  }

  return { periodEnd, entryPoint, campos, extras, valores, identidades, fecha_autorizacion: fechaAut, raw, alertas };
}
