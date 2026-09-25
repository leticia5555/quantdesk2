// ═══════════════════════════════════════════════════════════════════
// api/_lib/mercado-mapa.js — armar el mapa, sin abrir Neon.
//
// PURA. El endpoint hace las consultas; acá se decide qué entra, qué se
// manda y qué se dice de lo que falta.
//
// ── LA DECISIÓN DE TAMAÑO, QUE NO ES UN DETALLE ─────────────────────
// El navegador tiene que poder calcular los cuatro periodos (1D/1S/1M/YTD)
// SIN volver a pedir nada: el toggle es instantáneo y la URL es el estado.
// Mandar la serie entera de un año son ~252 puntos × 300 nombres — 75,000
// puntos en un teléfono, para pintar 300 cuadritos.
//
// Y mandar los cuatro porcentajes ya calculados tampoco sirve: la regla 1 del
// encargo dice que TODO % pasa por `qdPeriodChange`, y si el servidor los
// calcula hay dos implementaciones del ancla que se desincronizan.
//
// La salida: **los últimos 22 cierres** —el mínimo que deja a 1D, 1S y 1M
// anclarse con la regla REAL de `tradingDays`— más el **ancla YTD** como un
// punto explícito, elegido acá con `anclaYtd`, el mismo medidor que el
// navegador implementa y que `tests/qd-periods.test.mjs` prueba equivalente.
// El navegador arma [ancla, último] y se lo pasa a `qdPeriodChange('YTD')`.
// Un solo calculador, payload de teléfono.
// ═══════════════════════════════════════════════════════════════════

import { anclaYtd } from './mercado-fase0.js';
import { serieDesdeFilas, cubreYtd } from './mercado-precios.js';
import { veredictoCapUs } from './mercado-cap-us.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Cuántos cierres recientes viajan. 22 = el ancla de 1M (21) + el de hoy. */
export const CIERRES_RECIENTES = 22;

/** Los motivos por los que un cuadro puede no tener %. Cada uno se arregla distinto. */
export const MOTIVOS = {
  SIN_SERIE: 'no_hay_serie',
  SERIE_CORTA: 'serie_corta',
  SIN_ANCLA_YTD: 'sin_ancla_ytd',
  SIN_CAP: 'sin_capitalizacion',
  // La cap existe pero no se pudo confirmar contra una segunda fuente. NO es
  // lo mismo que SIN_CAP: acá hay número y se decidió no creerle.
  CAP_SIN_VERIFICAR: 'cap_sin_verificar',
};

/**
 * Una serie fechada → lo que viaja al navegador.
 *
 * `ytd` es null CON motivo cuando la serie no llega al año anterior: el
 * cuadro pinta "—" en gris y la hoja dice por qué. Nunca se estima con 252
 * sesiones — ese es justo el bug que `qdPctTag` existe para hacer imposible.
 */
export function empaquetaSerie(filas = [], { ahora = new Date(), recientes = CIERRES_RECIENTES } = {}) {
  const { serie, puntos_sin_ajuste } = serieDesdeFilas(filas);
  if (!serie.length) {
    return { serie: [], ytd: null, ytd_motivo: 'no_hay_serie', puntos: 0, precio: null, fecha_precio: null };
  }
  const a = anclaYtd(serie, ahora);
  const cob = cubreYtd(serie, ahora);
  // El PRECIO que se muestra es el cierre sin ajustar: es el número que la
  // gente ve en cualquier otra pantalla. El % usa el ajustado. Mezclarlos
  // sería pintar un precio que no existe o un % que ignora los splits.
  const ultimaFila = filas
    .filter((f) => num(f && f.cierre) != null)
    .sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)))
    .pop() || null;

  return {
    serie: serie.slice(-recientes),
    ytd: a.cubre ? { t: serie[a.refIdx].t, c: a.refValue } : null,
    ytd_motivo: a.cubre ? null : (cob.motivo || 'sin_ancla_ytd'),
    puntos: serie.length,
    puntos_sin_ajuste: puntos_sin_ajuste || undefined,
    precio: ultimaFila ? num(ultimaFila.cierre) : null,
    fecha_precio: ultimaFila ? String(ultimaFila.fecha).slice(0, 10) : null,
  };
}

/**
 * El mapa de EE.UU.: filas de `mercado_universo_us` + series de
 * `mercado_precios_us`, recortado al top N por capitalización.
 *
 * `recorteMapa` ya devuelve el "+N más = X%" con el porcentaje MEDIDO y los
 * sin-cap contados aparte. Se respeta tal cual: afirmar un porcentaje que no
 * se midió es el mismo error que el mapa evita en todo lo demás.
 */
export function armaMapaUs({ universo = [], precios = [], recorte, ahora = new Date(), referencias = new Map() }) {
  const porSymbol = new Map();
  for (const p of precios) {
    const s = String(p.symbol || '').toUpperCase();
    if (!porSymbol.has(s)) porSymbol.set(s, []);
    porSymbol.get(s).push(p);
  }

  const cuadros = [];
  const faltantes = [];
  for (const u of (recorte ? recorte.dentro : universo)) {
    const sym = String(u.symbol || '').toUpperCase();
    const paq = empaquetaSerie(porSymbol.get(sym) || [], { ahora });
    if (!paq.serie.length) faltantes.push({ symbol: sym, motivo: MOTIVOS.SIN_SERIE });
    else if (paq.serie.length < 2) faltantes.push({ symbol: sym, motivo: MOTIVOS.SERIE_CORTA });
    else if (!paq.ytd) faltantes.push({ symbol: sym, motivo: MOTIVOS.SIN_ANCLA_YTD, detalle: paq.ytd_motivo });

    // LA CAP SÓLO SE PINTA SI ESTÁ VERIFICADA, igual que en México. Un ADR
    // con la cap en su moneda de reporte se guardó como si fueran dólares y
    // salía como el cuadro más grande de la pantalla: mentía de tamaño, que
    // es la mentira que más se nota y la que nadie puede corregir a ojo.
    //
    // El contraste es contra `acciones × precio` con el cierre que ya
    // tenemos. Si no concuerdan dentro del 5%, gris punteado con su motivo.
    const cap = veredictoCapUs({
      symbol: sym,
      declarada: num(u.market_cap) != null ? num(u.market_cap) / 1e6 : null,
      moneda: u.cap_moneda || null,
      acciones: num(u.acciones_millones),
      precio_usd: paq.precio,
      // La referencia manual de Yahoo para los ADR: no se pinta, sólo despeja
      // la razón. Y las acciones de EDGAR, que entran de árbitro cuando el par
      // de Finnhub no concuerda.
      referencia: referencias.get(sym) || null,
      edgar: num(u.acciones_edgar_millones) != null
        ? { acciones: num(u.acciones_edgar_millones) * 1e6, fecha_portada: u.acciones_edgar_portada || null }
        : null,
      hoy: ahora,
    });
    // Sólo se reporta como problema DE CAP cuando hay precio: sin serie no
    // hay con qué contrastar, y eso ya está dicho arriba. Dos motivos para
    // una sola causa infla el conteo y manda a arreglar lo que no está roto.
    if (cap.estado !== 'verificada' && paq.precio != null) {
      faltantes.push({ symbol: sym, motivo: MOTIVOS.CAP_SIN_VERIFICAR, detalle: cap.motivo });
    }

    cuadros.push({
      symbol: sym,
      nombre: u.nombre || sym,
      sector: u.sector_etf || null,
      cap: cap.estado === 'verificada' ? cap.cap_usd : null,
      // La fuente la declara el VEREDICTO cuando la cap no salió de Finnhub:
      // `calc: edgar×neon` o `calc: acciones÷5:1×neon` dicen de dónde viene el
      // número que se está pintando. Decir "finnhub" en esos casos sería
      // atribuirle un número que Finnhub no dio.
      cap_fuente: cap.estado === 'verificada' ? (cap.fuente || u.cap_fuente || null) : null,
      cap_via: cap.via || null,
      cap_razon_adr: cap.razon_etiqueta || null,
      cap_referencia_a_recapturar: cap.referencia_a_recapturar === true,
      cap_referencia_vigente_hasta: cap.referencia_vigente_hasta || null,
      cap_portada_edgar: cap.fecha_portada || null,
      cap_medida_en: u.cap_actualizado ? String(u.cap_actualizado).slice(0, 10) : null,
      estado: cap.estado,
      motivo: cap.motivo,
      cap_auditable: cap.auditable === true,
      cap_moneda: cap.moneda,
      cap_error_pct: cap.error_pct,
      cap_multiplo: cap.multiplo,
      ...paq,
    });
  }
  return { cuadros, faltantes };
}

/**
 * El mapa de México: el veredicto de G2 ya resuelto (verificada / gris con
 * motivo) más la serie de `bmv_precios`.
 *
 * Tres clases de gris, y no son el mismo mensaje — el motivo viaja al render
 * porque cada uno se arregla distinto (§2.2 del encargo de R1).
 */
export function armaMapaMx({ detalleG2 = [], precios = [], ahora = new Date() }) {
  const porSerie = new Map();
  for (const p of precios) {
    const s = String(p.emisora_serie || '');
    if (!porSerie.has(s)) porSerie.set(s, []);
    porSerie.get(s).push(p);
  }

  const cuadros = [];
  const faltantes = [];
  for (const d of detalleG2) {
    const paq = empaquetaSerie(porSerie.get(d.serie_liquida) || [], { ahora });
    const verificada = d.estado === 'verificada' || d.estado === 'verificada_por_metodo';
    if (!verificada) faltantes.push({ symbol: d.clave, motivo: d.via || 'gris', detalle: d.motivo_estado });
    else if (!paq.ytd) faltantes.push({ symbol: d.clave, motivo: MOTIVOS.SIN_ANCLA_YTD, detalle: paq.ytd_motivo });

    cuadros.push({
      symbol: d.clave,
      nombre: d.nombre || d.clave,
      sector: d.sector || null,
      serie_liquida: d.serie_liquida || null,
      // La cap sólo se PINTA si está verificada. Un cuadro dimensionado con
      // una cap que no cuadra es un cuadro que miente de tamaño, no sólo de
      // color.
      cap: verificada ? num(d.cap_calculada) : null,
      cap_fuente: verificada ? 'calc (acciones × precio / unidades)' : null,
      estado: d.estado,
      via: d.via || null,
      etiqueta: d.etiqueta || null,
      motivo: verificada ? null : d.motivo_estado,
      acciones_por_unidad: d.acciones_por_unidad,
      ...paq,
    });
  }
  return { cuadros, faltantes };
}

/** Cuántos cuadros quedaron sin cada cosa, agrupado por motivo. */
export function resumenFaltantes(faltantes = []) {
  const por = {};
  for (const f of faltantes) por[f.motivo] = (por[f.motivo] || 0) + 1;
  const n = (k) => por[k] || 0;
  // `total` sumaba cosas que se arreglan en lugares distintos y se leía como
  // un solo problema: "277 cuadros sin dato completo" eran 25 caps sin
  // verificar más 250 símbolos que ni siquiera tienen serie. Los segundos NO
  // SON CUADROS todavía; contarlos como tales manda a buscar 250 bugs que no
  // existen. Sigue estando `total` para quien lo necesite, pero el pie usa el
  // desglose.
  return {
    total: faltantes.length,
    por_motivo: por,
    sin_precio: n(MOTIVOS.SIN_SERIE),
    sin_periodo: n(MOTIVOS.SERIE_CORTA),
    sin_ancla_ytd: n(MOTIVOS.SIN_ANCLA_YTD),
    sin_cap_verificada: n(MOTIVOS.CAP_SIN_VERIFICAR),
    ejemplos: faltantes.slice(0, 10),
  };
}
