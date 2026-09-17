// ═══════════════════════════════════════════════════════════════════
// /api/bmv-harvest — FASE A del backtest BMV: cosecha DataBursatil → Neon.
//
//   GET                        → ayuda + estado (público, sólo lectura)
//   GET ?job=estimate          → público, SIN RED: presupuesto de créditos
//   GET ?job=cobertura         → público, sólo lectura (&format=md)
//   GET ?job=contrato          → público: el contrato descubierto por el probe
//   GET ?job=probe             → protegido. Gasta ≤15 requests y DESCUBRE el
//                                contrato de la API. Corre esto PRIMERO.
//   GET ?job=emisoras          → protegido. 1 request. El censo point-in-time.
//   GET ?job=financieros&max=N → protegido. Reanudable e idempotente.
//   GET ?job=historicos&max=N  → protegido. Reanudable e idempotente.
//
// GATING de escritura: `Authorization: Bearer <ADMIN_SECRET>` (fallback a
// CRON_SECRET). Sin secret configurado NO se escribe: fail closed. Mismo
// patrón que /api/xbrl-capture.
//
// ── POR QUÉ HAY UN `probe` Y NO SE COSECHA DE UNA ──────────────────
// El sandbox donde se escribió esto NO alcanza `api.databursatil.com` ni
// `databursatil.com`: el proxy de egress contesta 403 al CONNECT (política de
// la organización). O sea que **ni la API ni su documentación se pudieron
// leer**, y el contrato exacto —cómo se llama el parámetro del periodo, qué
// forma tiene la respuesta, cuánto cuesta cada request— NO está verificado.
//
// Adivinarlo y lanzar 1,200 requests contra la suposición es la forma cara de
// equivocarse. `?job=probe` gasta un puñado de requests, prueba las grafías
// candidatas, y guarda en `bmv_meta` la que funcione. Es el mismo movimiento
// que el descubrimiento de tags del smoke de Fase 0: nunca asumir, medir.
//
// Y si el probe falla, falla BARATO y con el cuerpo crudo del error a la
// vista — que es donde las APIs suelen decir exactamente qué parámetro falta.
//
// ── IDEMPOTENCIA ───────────────────────────────────────────────────
// `bmv_harvest_ledger` guarda cada (job, emisora, clave) resuelto. Lo que ya
// está 'hecho' o 'vacio' no se vuelve a pedir. Correr el job dos veces no
// cuesta créditos de más; correrlo veinte veces termina la cosecha.
//
// ── PRESUPUESTO ────────────────────────────────────────────────────
// 200,000 créditos/mes, se reponen el día 1 a las 00:01 CDMX. El contador
// vive en `bmv_api_budget` con el mes en hora de CDMX (con el mes UTC, las
// primeras 6 horas del día 1 caerían en el mes anterior). Cuando se agota, la
// corrida PARA LIMPIO y reporta dónde se quedó — el ledger ya lo sabe.
//
// CERO llamadas a Claude. Determinista de punta a punta.
//
// ENV VARS: DATABASE_URL · DATABURSATIL_TOKEN · ADMIN_SECRET (o CRON_SECRET)
//           BMV_CREDITOS_POR_REQUEST (opcional, default 1) · XBRL_CONTACT
// ═══════════════════════════════════════════════════════════════════

import {
  BENCHMARK, BENCHMARK_EMISORA, BENCHMARK_SERIE, BENCHMARK_TIPO, UMBRAL_PLACEHOLDER,
  CAMPOS, COBERTURA_FIN, PAUSA_MS, PRESUPUESTO_MENSUAL,
  aplanarHistoricos, clavePeriodo, construirUrl, dormir, emisoraSerie,
  extraerDistribuciones, finDeTrimestre, normalizaLlave, periodoApi,
  mesPresupuesto, normalizarFinancieros, parsearRangoFechas, parsearRangoPeriodos,
  recortarACobertura, resolverCampo, traer, trimestresEntre,
} from './_lib/databursatil.js';

import { sql } from './_lib/db.js';
import {
  ensureBmvSchema, upsertEmisora, emisorasIcs, emisoraPorClave, censoResumen,
  MAX_INTENTOS,
  upsertFinancieros, insertarPrecios, insertarDistribuciones, ultimaFechaPrecios,
  marcarLedger, clavesHechas, clavesAgotadas, ledgerResumen, financierosCrudos,
  actualizarFinancieros, formasDelCrudo, financieroCrudo, financieroQueSiSirvio,
  presupuesto, gastar, cobertura, leerMeta, guardarMeta,
} from './_lib/bmv-db.js';

import EMISORAS_ICS from './_lib/emisoras.json' with { type: 'json' };

export const maxDuration = 300;

// Se corta ANTES del tope de la lambda para devolver un reporte en vez de un
// 504. Un 504 pierde el resumen de la corrida; el ledger sobrevive, pero
// "¿dónde se quedó?" se contesta mejor con la respuesta que con una query.
const LIMITE_MS = 240000;

const TOPE_PROBE = 18;          // tope DURO de requests del probe

// Piso de la serie de precios cuando el censo no trae `rango_historicos`.
// NO es una referencia a "hoy": es el arranque de la cobertura de financieros
// (2T2016) llevado a principio de año. El primer rebalanceo con un TTM
// completo cae a mediados de 2017, y el momentum 12-1 necesita los 12 meses
// previos, o sea mediados de 2016 — este piso los cubre con holgura.
const PRECIOS_DESDE_DEFECTO = /* date-lint-ok: arranque declarado de la cobertura de DataBursatil, un hecho fijo */ '2016-01-01';
const LOTE_DEFECTO = 60;        // requests por corrida si no se pide otra cosa

function creditosPorRequest() {
  const n = Number(process.env.BMV_CREDITOS_POR_REQUEST);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function adminSecret() {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;
}
function authorized(req) {
  const secret = adminSecret();
  if (!secret) return false;                       // fail closed
  const h = (req.headers && req.headers.authorization) || '';
  if (h === `Bearer ${secret}`) return true;
  return !!process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`;
}

/* ═══════════════ el contrato de la API ═══════════════ */

/**
 * La suposición de arranque [NO VERIFICADO]. El probe la confirma o la
 * corrige, y lo que quede se guarda en `bmv_meta`. Que el default exista NO
 * significa que esté verificado: significa que el probe tiene por dónde
 * empezar.
 */
const CONTRATO_DEFECTO = {
  // VERIFICADO contra la API: periodo='1T_2020'. El error que devolvió cuando
  // se probaron las otras 8 grafías traía el ejemplo literal.
  financieros: { forma: 'dbtrim', periodo: 'periodo' },
  // VERIFICADO: el parámetro es `emisora_serie` (no `emisora`) y el valor
  // lleva la serie pegada. `inicio`/`final` sí eran correctos.
  historicos: { clave: 'emisora_serie', inicio: 'inicio', final: 'final' },
  // El benchmark es "NAFTRAC ISHRS" (emisora NAFTRAC, serie ISHRS). Lety dijo
  // usarlo TAL CUAL, así que ese es el default; 'emisora_serie' queda como la
  // alternativa que el probe intenta si el identificador completo no pega.
  benchmark: { forma: 'identificador' },
  verificado: false,
};

/**
 * El benchmark ya no necesita caso especial: 'NAFTRAC ISHRS' ES un
 * emisora_serie, igual que 'WALMEX*'. La función se queda como el punto único
 * donde el benchmark se nombra, para que si su grafía cambia se cambie aquí.
 */
function paramsBenchmark(contrato, desde, hasta) {
  return paramsHistoricos(contrato, BENCHMARK, desde, hasta);
}

/** Las grafías candidatas del periodo en /v2/financieros. */
function candidatosFinancieros(anio, trimestre) {
  const p = clavePeriodo(anio, trimestre);
  const cierre = finDeTrimestre(anio, trimestre);
  return [
    // El que la API pidió por su nombre. Va primero para que el probe lo
    // confirme en UN request en vez de gastar ocho descartando.
    { etiqueta: 'periodo=TT_AAAA (verificado)', forma: 'dbtrim', periodo: 'periodo', params: { periodo: periodoApi(anio, trimestre) } },
    { etiqueta: 'periodo=AAAA-T', forma: 'periodo', periodo: 'periodo', params: { periodo: p } },
    { etiqueta: 'trimestre=AAAA-T', forma: 'periodo', periodo: 'trimestre', params: { trimestre: p } },
    { etiqueta: 'periodo=AAAA-MM-DD', forma: 'cierre', periodo: 'periodo', params: { periodo: cierre } },
    { etiqueta: 'fecha=AAAA-MM-DD', forma: 'cierre', periodo: 'fecha', params: { fecha: cierre } },
    { etiqueta: 'año+trimestre', forma: 'partes', anio: 'año', trim: 'trimestre', params: { 'año': anio, trimestre } },
    { etiqueta: 'anio+trimestre', forma: 'partes', anio: 'anio', trim: 'trimestre', params: { anio, trimestre } },
    { etiqueta: 'ejercicio+periodo', forma: 'partes', anio: 'ejercicio', trim: 'periodo', params: { ejercicio: anio, periodo: trimestre } },
    { etiqueta: 'year+quarter', forma: 'partes', anio: 'year', trim: 'quarter', params: { year: anio, quarter: trimestre } },
  ];
}

/**
 * Las grafías candidatas de /v2/historicos. Lo que el probe reveló: el
 * parámetro es `emisora_serie`, no `emisora`, y el valor lleva la serie
 * pegada. `inicio`/`final` sí eran correctos, así que el candidato verificado
 * va primero y los demás quedan sólo por si la API cambia.
 */
function candidatosHistoricos(clave, desde, hasta) {
  return [
    { etiqueta: 'emisora_serie + inicio/final (verificado)', clave: 'emisora_serie', inicio: 'inicio', final: 'final', params: { emisora_serie: clave, inicio: desde, final: hasta } },
    { etiqueta: 'emisora + inicio/final', clave: 'emisora', inicio: 'inicio', final: 'final', params: { emisora: clave, inicio: desde, final: hasta } },
    { etiqueta: 'emisora_serie + fecha_inicio/fecha_final', clave: 'emisora_serie', inicio: 'fecha_inicio', final: 'fecha_final', params: { emisora_serie: clave, fecha_inicio: desde, fecha_final: hasta } },
    { etiqueta: 'emisora_serie + desde/hasta', clave: 'emisora_serie', inicio: 'desde', final: 'hasta', params: { emisora_serie: clave, desde, hasta } },
    { etiqueta: 'emisora_serie + start/end', clave: 'emisora_serie', inicio: 'start', final: 'end', params: { emisora_serie: clave, start: desde, end: hasta } },
  ];
}

/** Params de /v2/financieros según el contrato vigente. */
function paramsFinancieros(contrato, emisora, anio, trimestre) {
  const c = (contrato && contrato.financieros) || CONTRATO_DEFECTO.financieros;
  const base = { emisora, financieros: 'posicion,resultado_trimestre' };
  if (c.forma === 'partes') {
    return { ...base, [c.anio || 'anio']: anio, [c.trim || 'trimestre']: trimestre };
  }
  const valor = c.forma === 'dbtrim' ? periodoApi(anio, trimestre)
    : c.forma === 'cierre' ? finDeTrimestre(anio, trimestre)
    : clavePeriodo(anio, trimestre);
  return { ...base, [c.periodo || 'periodo']: valor };
}

/**
 * `clave` es el **emisora_serie** (WALMEX*, FEMSAUBD, NAFTRAC ISHRS), no la
 * emisora sola: /v2/historicos no conoce emisoras sin serie.
 */
function paramsHistoricos(contrato, clave, desde, hasta) {
  const c = (contrato && contrato.historicos) || CONTRATO_DEFECTO.historicos;
  return {
    [c.clave || 'emisora_serie']: clave,
    [c.inicio || 'inicio']: desde,
    [c.final || 'final']: hasta,
  };
}

async function contratoVigente() {
  const m = await leerMeta('contrato');
  return (m && m.value) || CONTRATO_DEFECTO;
}

/* ═══════════════ la cartera de créditos de una corrida ═══════════════ */

/**
 * Lleva la cuenta de los créditos de ESTA corrida contra el saldo del mes y
 * contra el reloj de la lambda. `puedeSeguir()` es el único lugar donde se
 * decide parar, para que no haya dos criterios de parada compitiendo.
 */
function nuevaCartera({ mes, gastadoMes, tope, t0 = Date.now(), limiteMs = LIMITE_MS }) {
  const porRequest = creditosPorRequest();
  return {
    mes, porRequest, tope,
    gastadoMes,
    requests: 0,
    creditos: 0,
    razonParo: null,
    headers: null,
    puedeSeguir() {
      if (Date.now() - t0 > limiteMs) { this.razonParo = 'reloj_de_la_lambda'; return false; }
      if (this.requests >= tope) { this.razonParo = 'tope_de_la_corrida'; return false; }
      if (this.gastadoMes + this.creditos + porRequest > PRESUPUESTO_MENSUAL) {
        this.razonParo = 'presupuesto_mensual_agotado'; return false;
      }
      return true;
    },
    anota(res) {
      this.requests += 1;
      this.creditos += porRequest;
      if (res && res.creditos_header) this.headers = res.creditos_header;
    },
  };
}

async function cerrarCartera(cartera) {
  if (!cartera.requests) return { requests: 0, creditos: 0 };
  return gastar(cartera.mes, {
    requests: cartera.requests, creditos: cartera.creditos, headers: cartera.headers,
  });
}

/* ═══════════════ job: estimate (sin red, sin créditos) ═══════════════ */

const DIAS_HABILES_POR_ANIO = 252;

/**
 * El presupuesto ANTES de correr. Pura aritmética: se exporta para que el
 * test la fije y para que el número que sale aquí sea el mismo que se
 * escribió en docs/bmv-rotation.md.
 *
 * Se reportan TRES modelos de costo porque **no sé cuál usa DataBursatil**
 * [NO VERIFICADO], y la diferencia entre ellos decide si la cosecha cabe en
 * un mes o no:
 *
 *   A · por request        — el más barato y el más común en APIs con token.
 *   B · por dato devuelto  — financieros ~60 campos, precios 1 punto por día.
 *   C · por campo × día    — el más caro: precios cuentan cierre E importe.
 *
 * Bajo (C) la cosecha NO cabe en 200,000 en un solo mes, y eso hay que
 * saberlo antes, no a mitad de camino.
 */
function estimarConsumo({ emisoras, camposPorFinanciero = 60, preciosDesde = null } = {}) {
  const det = [];
  let reqFin = 0, datosFin = 0, reqHist = 0, diasHist = 0;
  // Los financieros son por EMISORA y los precios por SERIE. Una emisora con
  // dos series cuesta DOS rangos de precios pero UN solo juego de trimestres;
  // contarlos juntos inflaría el presupuesto justo donde más filas hay.
  const emisorasContadas = new Set();

  for (const e of emisoras) {
    const rango = recortarACobertura(e.finDesde, e.finHasta, COBERTURA_FIN);
    const yaContada = emisorasContadas.has(e.emisora);
    // La enumeración del censo gana sobre el rango: es el número exacto.
    const trimestres = yaContada ? 0
      : (e.finPeriodos ? e.finPeriodos
        : (rango ? trimestresEntre(rango.desde, rango.hasta).length : 0));
    if (rango) emisorasContadas.add(e.emisora);
    reqFin += trimestres;
    datosFin += trimestres * camposPorFinanciero;

    let dias = 0;
    if (e.histDesde && e.histHasta) {
      const d0 = preciosDesde && preciosDesde > e.histDesde ? preciosDesde : e.histDesde;
      const ms = Date.parse(e.histHasta) - Date.parse(d0);
      dias = ms > 0 ? Math.round((ms / 86400000) * (DIAS_HABILES_POR_ANIO / 365.25)) : 0;
    }
    if (dias > 0) { reqHist += 1; diasHist += dias; }

    det.push({ emisora: e.emisora_serie || e.emisora, trimestres, dias_habiles_estimados: dias });
  }

  const reqTotal = 1 + reqFin + reqHist;    // +1 por el censo de emisoras
  return {
    series: emisoras.length,
    emisoras: emisorasContadas.size,
    requests: { emisoras: 1, financieros: reqFin, historicos: reqHist, total: reqTotal },
    datos: { campos_financieros: datosFin, dias_precio: diasHist },
    modelos: {
      A_por_request: reqTotal,
      B_por_dato: datosFin + diasHist,
      C_por_campo_dia: datosFin + diasHist * 2,       // cierre + importe
    },
    presupuesto_mensual: PRESUPUESTO_MENSUAL,
    cabe_en_un_mes: {
      A: reqTotal <= PRESUPUESTO_MENSUAL,
      B: datosFin + diasHist <= PRESUPUESTO_MENSUAL,
      C: datosFin + diasHist * 2 <= PRESUPUESTO_MENSUAL,
    },
    // Si no cabe, el ledger ya hace que partirla no cueste nada: la corrida se
    // corta sola y el mes siguiente retoma donde quedó. Lo único que importa es
    // el ORDEN, y por eso va escrito acá y no improvisado el día que pase.
    plan_si_no_cabe: reqTotal <= PRESUPUESTO_MENSUAL ? null : {
      mes_1: 'financieros — son el dato escaso y point-in-time; sin ellos no hay ranking, y los precios no se van a ningún lado',
      mes_2: 'historicos — se piden por rango, así que llegan completos cuando toque',
      financieros_solos: 1 + reqFin,
      historicos_solos: reqHist,
      nota: 'No hay que hacer nada especial: la cartera para en `presupuesto_mensual_agotado`, el ledger guarda dónde quedó, y el día 1 a las 00:01 CDMX se retoma con el mismo job.',
    },
    detalle: det.slice(0, 50),
    detalle_truncado: det.length > 50 ? det.length - 50 : 0,
  };
}

/** Las emisoras para estimar: el censo real si ya está, si no el de Fase 1a. */
async function emisorasParaEstimar() {
  let filas = [];
  try { filas = await emisorasIcs(); } catch (e) { filas = []; }
  if (filas.length) {
    // El benchmark no es ICS (es 1B), así que no sale en `filas` — pero su
    // serie de precios sí se cosecha y sí cuesta. Contarlo aparte evita un
    // presupuesto que se queda corto justo en lo único sin lo cual no hay
    // contra qué medir.
    let bench = null;
    try { bench = await emisoraPorClave(BENCHMARK); } catch (e) { bench = null; }
    const extra = [{
      emisora: BENCHMARK_EMISORA,
      emisora_serie: BENCHMARK,
      finDesde: null, finHasta: null,          // un ETF no reporta financieros
      histDesde: bench && bench.hist_desde ? String(bench.hist_desde).slice(0, 10) : PRECIOS_DESDE_DEFECTO,
      histHasta: bench && bench.hist_hasta ? String(bench.hist_hasta).slice(0, 10) : new Date().toISOString().slice(0, 10),
    }];
    return {
      fuente: 'bmv_emisoras (censo real de DataBursatil) + benchmark',
      lista: [...extra, ...filas.map((f) => ({
        emisora: f.emisora,
        emisora_serie: f.emisora_serie || f.emisora,
        // Si el censo trae la enumeración de trimestres, ése es el número
        // EXACTO de requests; el rango sólo aproxima cuando no la hay.
        finPeriodos: Array.isArray(f.fin_periodos) ? f.fin_periodos.length : null,
        finDesde: f.fin_desde ? { anio: Number(String(f.fin_desde).split('-')[0]), trimestre: Number(String(f.fin_desde).split('-')[1]) } : null,
        finHasta: f.fin_hasta ? { anio: Number(String(f.fin_hasta).split('-')[0]), trimestre: Number(String(f.fin_hasta).split('-')[1]) } : null,
        histDesde: f.hist_desde ? String(f.hist_desde).slice(0, 10) : null,
        histHasta: f.hist_hasta ? String(f.hist_hasta).slice(0, 10) : null,
      }))],
    };
  }
  // Sin censo todavía: se estima con las 30 ICS de Fase 1a y la cobertura
  // declarada, que es el PEOR caso razonable (todas con historia completa).
  const hoy = new Date().toISOString().slice(0, 10);
  return {
    fuente: 'api/_lib/emisoras.json (Fase 1a) + benchmark + cobertura declarada — PEOR CASO',
    lista: [
      // El benchmark no reporta financieros (es un ETF), pero su serie de
      // precios cuesta igual que la de cualquier emisora.
      { emisora: BENCHMARK_EMISORA, emisora_serie: BENCHMARK, finDesde: null, finHasta: null, histDesde: PRECIOS_DESDE_DEFECTO, histHasta: hoy },
      ...(EMISORAS_ICS.emisoras || EMISORAS_ICS).map((e) => ({
        emisora: e.clave || e.emisora,
        finDesde: COBERTURA_FIN.desde,
        finHasta: COBERTURA_FIN.hasta,
        histDesde: PRECIOS_DESDE_DEFECTO,
        histHasta: hoy,
      })),
    ],
  };
}

/* ═══════════════ job: probe (descubre el contrato) ═══════════════ */

function llavesDe(x, n = 25) {
  if (!x || typeof x !== 'object') return null;
  return Array.isArray(x) ? [`(arreglo de ${x.length})`] : Object.keys(x).slice(0, n);
}

/** Un intento sirve si contesta 200 Y se le puede sacar al menos un campo. */
function sirveFinanciero(json) {
  if (!json) return { sirve: false, motivo: 'sin JSON' };
  const hits = CAMPOS.map((c) => resolverCampo(json, c)).filter((r) => r.valor !== null);
  if (!hits.length) return { sirve: false, motivo: 'JSON sin ninguno de los 7 campos' };
  return { sirve: true, campos_resueltos: hits.length };
}

async function jobProbe(req) {
  const emisora = String((req.query && req.query.emisora) || 'WALMEX').toUpperCase();
  const anio = Number((req.query && req.query.anio) || COBERTURA_FIN.hasta.anio);
  const trimestre = Number((req.query && req.query.trimestre) || COBERTURA_FIN.hasta.trimestre);

  const mes = mesPresupuesto();
  const saldo = await presupuesto(mes);
  const cartera = nuevaCartera({ mes, gastadoMes: saldo.creditos, tope: TOPE_PROBE });

  const pasos = [];
  const contrato = { ...CONTRATO_DEFECTO, verificado: false };

  // ── 1. /v2/emisoras — la ruta que Lety dio explícita, así que sólo se mide.
  if (cartera.puedeSeguir()) {
    const r = await traer(construirUrl('/emisoras', { mercado: 'local' }));
    cartera.anota(r);
    const filas = r.ok ? filasDelCenso(r.json) : [];
    pasos.push({
      paso: 'emisoras', url: r.url, status: r.status, ok: r.ok,
      // Lo que de verdad hay que mirar del censo: cuántas salieron, cuántas
      // ICS, y si las series se pudieron construir. 441 KB de JSON no se leen;
      // estos cinco números sí.
      filas: filas.length,
      ics: filas.filter((f) => f.tipo_valor_id === '1').length,
      con_serie: filas.filter((f) => f.serie).length,
      sin_serie: filas.filter((f) => !f.serie).map((f) => f.emisora).slice(0, 20),
      ejemplos_emisora_serie: filas.slice(0, 8).map((f) => f.emisora_serie),
      tipos: contar(filas.map((f) => f.tipo_valor_id || '(null)')),
      llaves: llavesDe(r.json), muestra: muestraChica(r.json), error: r.error || null,
      cuerpo: r.ok ? undefined : r.texto,
      json_censo: r.json,     // se borra antes de responder; sólo lo usa serieDelCenso
    });
    await dormir(PAUSA_MS);
  }

  // ── 2. /v2/financieros — se prueban las grafías hasta que una sirva.
  for (const cand of candidatosFinancieros(anio, trimestre)) {
    if (!cartera.puedeSeguir()) break;
    const r = await traer(construirUrl('/financieros', {
      emisora, financieros: 'posicion,resultado_trimestre', ...cand.params,
    }));
    cartera.anota(r);
    const v = r.ok ? sirveFinanciero(r.json) : { sirve: false, motivo: r.error };
    pasos.push({
      paso: 'financieros', candidato: cand.etiqueta, url: r.url, status: r.status,
      ok: r.ok, sirve: v.sirve, motivo: v.motivo || null,
      campos_resueltos: v.campos_resueltos || 0,
      llaves: llavesDe(r.json), muestra: muestraChica(r.json),
      // El cuerpo del error es donde las APIs dicen qué parámetro falta.
      cuerpo: r.ok ? undefined : r.texto,
    });
    if (v.sirve) {
      contrato.financieros = cand.forma === 'partes'
        ? { forma: 'partes', anio: cand.anio, trim: cand.trim }
        : { forma: cand.forma, periodo: cand.periodo };
      break;
    }
    await dormir(PAUSA_MS);
  }

  // ── 3. /v2/historicos — una ventana de días, no el rango completo.
  const hasta = finDeTrimestre(anio, trimestre);
  const desde = new Date(Date.parse(hasta) - 10 * 86400000).toISOString().slice(0, 10);
  // La clave de /v2/historicos es emisora+serie. Si el censo del paso 1 la
  // trae, se usa la REAL; si no, se prueba con la emisora sola, que es lo que
  // hace fallar el paso y deja el error a la vista.
  const claveHist = serieDelCenso(pasos, emisora) || emisora;
  for (const cand of candidatosHistoricos(claveHist, desde, hasta)) {
    if (!cartera.puedeSeguir()) break;
    const r = await traer(construirUrl('/historicos', cand.params));
    cartera.anota(r);
    const plano = r.ok ? aplanarHistoricos(r.json) : { filas: [], descartadas: 0 };
    pasos.push({
      paso: 'historicos', candidato: cand.etiqueta, clave: claveHist, url: r.url, status: r.status,
      ok: r.ok, filas: plano.filas.length, descartadas: plano.descartadas,
      primera_fila: plano.filas[0] || null,
      con_importe: plano.filas.filter((f) => f.importe !== null).length,
      llaves: llavesDe(r.json), muestra: muestraChica(r.json),
      cuerpo: r.ok ? undefined : r.texto,
    });
    if (plano.filas.length) {
      contrato.historicos = { clave: cand.clave, inicio: cand.inicio, final: cand.final };
      break;
    }
    await dormir(PAUSA_MS);
  }

  // ── 4. El benchmark se nombra distinto ("NAFTRAC ISHRS"), así que se prueba
  // aparte: que /v2/historicos funcione con una emisora normal no garantiza
  // que acepte el identificador con serie pegada.
  for (const forma of ['identificador', 'emisora_serie']) {
    if (!cartera.puedeSeguir()) break;
    const r = await traer(construirUrl('/historicos', paramsBenchmark({ ...contrato, benchmark: { forma } }, desde, hasta)));
    cartera.anota(r);
    const plano = r.ok ? aplanarHistoricos(r.json) : { filas: [] };
    pasos.push({
      paso: 'benchmark', candidato: forma, url: r.url, status: r.status,
      ok: r.ok, filas: plano.filas.length, primera_fila: plano.filas[0] || null,
      cuerpo: r.ok ? undefined : r.texto,
    });
    if (plano.filas.length) { contrato.benchmark = { forma }; break; }
    await dormir(PAUSA_MS);
  }

  const finOk = pasos.some((p) => p.paso === 'financieros' && p.sirve);
  const histOk = pasos.some((p) => p.paso === 'historicos' && p.filas > 0);
  const benchOk = pasos.some((p) => p.paso === 'benchmark' && p.filas > 0);
  contrato.verificado = finOk && histOk && benchOk;
  contrato.probado_at = new Date().toISOString();

  for (const p of pasos) delete p.json_censo;   // 441 KB no viajan en la respuesta

  const gastoMes = await cerrarCartera(cartera);
  if (finOk || histOk || benchOk) {
    await guardarMeta('contrato', contrato,
      `probe ${emisora} ${anio}-${trimestre}: financieros=${finOk ? 'ok' : 'NO'} historicos=${histOk ? 'ok' : 'NO'} benchmark=${benchOk ? 'ok' : 'NO'}`);
  }

  return {
    job: 'probe', emisora, periodo: clavePeriodo(anio, trimestre),
    contrato, guardado: finOk || histOk || benchOk,
    // Sin benchmark no hay backtest: el criterio se mide CONTRA él.
    benchmark: { identificador: BENCHMARK, resuelto: benchOk },
    veredicto: contrato.verificado
      ? 'contrato descubierto — ya se puede cosechar'
      : 'contrato INCOMPLETO — revisar `cuerpo` de los pasos fallidos antes de cosechar',
    // El importe operado es un requisito del filtro de liquidez del backtest:
    // si no viene, el universo no se puede construir como está especificado.
    importe_operado_presente: pasos.some((p) => p.paso === 'historicos' && p.con_importe > 0),
    pasos,
    creditos: { corrida: cartera.creditos, requests: cartera.requests, mes: gastoMes, paro: cartera.razonParo },
  };
}

/**
 * Saca el emisora_serie REAL del censo que el propio probe acaba de bajar.
 * Sin esto, el probe de /v2/historicos tendría que adivinar la serie — y
 * adivinarla es justo lo que el censo existe para no hacer.
 */
function serieDelCenso(pasos, emisora) {
  const paso = pasos.find((p) => p.paso === 'emisoras' && p.json_censo);
  if (!paso) return null;
  const fila = filasDelCenso(paso.json_censo).find((f) => f.emisora === emisora);
  return fila ? fila.emisora_serie : null;
}

/** Un pedacito del crudo para ver la forma sin vomitar 200 KB en la respuesta. */
function muestraChica(json, limite = 1200) {
  if (json === null || json === undefined) return null;
  const s = JSON.stringify(json);
  return s.length <= limite ? json : s.slice(0, limite) + `… (+${s.length - limite} chars)`;
}

/* ═══════════════ job: emisoras (el censo) ═══════════════ */

// Llaves que son CAMPOS de la emisora, nunca una serie. Importa porque algunas
// traen objetos como valor —`rango_financieros` puede venir como
// {inicio, fin}— y detectar series por "su valor es un objeto" las confundiría
// con una serie llamada `rango_financieros`.
// Llaves que, si aparecen, son contenedores del cuerpo real y no emisoras.
const CONTENEDORES = new Set(['data', 'datos', 'resultado', 'resultados', 'emisoras', 'items']);

const CAMPOS_NO_SERIE = new Set([
  'emisora', 'clave', 'clavecotizacion', 'serie', 'razonsocial', 'nombre',
  'tipovalorid', 'tipovalor', 'estatus', 'status',
  'rangofinancieros', 'rangohistoricos', 'rangodividendos',
  'distribuciones', 'dividendos', 'cupones', 'repartos',
]);

/**
 * Una llave de SERIE: `*`, `B`, `UBD`, `CPO`, `C-1`, `CK`, `CPI`, ` ISHRS`.
 * Corta y en mayúsculas. Es la segunda defensa además de la lista de campos:
 * `rango_financieros` no la pasa ni por asomo.
 */
function pareceSerie(k) {
  const t = String(k).trim();
  if (!t || t.length > 10) return false;
  return /^[A-Z0-9*\-.]+$/.test(t.toUpperCase());
}

/**
 * Las series que cuelgan del objeto de una emisora. Devuelve [] si no hay
 * ninguna — y entonces la emisora se guarda con `serie = null`, que es un
 * hecho reportable, no un default silencioso: sin serie, /v2/historicos no se
 * puede pedir para esa emisora.
 */
function seriesDeEmisora(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (CAMPOS_NO_SERIE.has(normalizaLlave(k))) continue;
    if (!pareceSerie(k)) continue;
    out.push({ serie: k, datos: v });
  }
  return out;
}

/**
 * Normaliza UNA fila del censo. `serieEntrada` viene de `filasDelCenso`, que ya
 * desdobló la emisora en sus series: acá sólo se mezclan los campos de la serie
 * ENCIMA de los de la emisora, porque `tipo_valor_id` y `estatus` son del
 * instrumento, no de la empresa — NAFTRAC ISHRS es 1B y un CKD es 1R.
 */
function filaCenso(clave, valor, serieEntrada = null) {
  const obj = (valor && typeof valor === 'object' && !Array.isArray(valor)) ? valor : {};
  const bajo = {};
  for (const [k, v] of Object.entries(obj)) bajo[String(k).toLowerCase()] = v;
  if (serieEntrada && serieEntrada.datos) {
    for (const [k, v] of Object.entries(serieEntrada.datos)) bajo[String(k).toLowerCase()] = v;
  }

  // El campo explícito del objeto gana sobre la llave del mapa: en un arreglo
  // de filas la llave no existe, y en un mapa con envoltorio la llave puede ser
  // un índice ('fila_1') mientras la pizarra real vive adentro.
  const emisora = String(
    bajo.emisora ?? bajo.clave ?? bajo.clave_cotizacion ?? clave ?? '',
  ).trim().toUpperCase();
  if (!emisora) return null;

  const fin = parsearRangoPeriodos(bajo.rango_financieros ?? bajo.rangofinancieros ?? null);
  const hist = parsearRangoFechas(bajo.rango_historicos ?? bajo.rangohistoricos ?? null);

  const tipo = bajo.tipo_valor_id ?? bajo.tipovalorid ?? bajo.tipo_valor ?? null;
  const serie = serieEntrada ? serieEntrada.serie : (bajo.serie ?? null);

  return {
    emisora,
    serie: serie === null || serie === undefined ? null : String(serie),
    emisora_serie: emisoraSerie(emisora, serie),
    razon_social: bajo.razon_social ?? bajo.razonsocial ?? bajo.nombre ?? null,
    tipo_valor_id: tipo === null || tipo === undefined ? null : String(tipo),
    estatus: bajo.estatus ?? bajo.status ?? null,
    fin_desde: fin.rango ? clavePeriodo(fin.rango.desde.anio, fin.rango.desde.trimestre) : null,
    fin_hasta: fin.rango ? clavePeriodo(fin.rango.hasta.anio, fin.rango.hasta.trimestre) : null,
    fin_motivo: fin.motivo,
    hist_desde: hist.rango ? hist.rango.desde : null,
    hist_hasta: hist.rango ? hist.rango.hasta : null,
    hist_motivo: hist.motivo,
    // La ENUMERACIÓN de trimestres reportados, no sólo los extremos. Con ella
    // la cosecha pide sólo lo que existe: un hueco en la serie no es un
    // trimestre que valga un request, y tampoco es un trimestre en el que la
    // emisora deba entrar al universo.
    fin_periodos: fin.periodos && fin.periodos.length
      ? fin.periodos.map((x) => clavePeriodo(x.anio, x.trimestre)) : null,
    raw: valor,
    // El sub-objeto de ESTA serie. Los dividendos cuelgan de aquí, no de la
    // emisora: extraerlos del objeto completo le daba a cada serie los
    // repartos de TODAS sus hermanas (LIVEPOL C-1 se llevaba los de LIVEPOL 1).
    raw_serie: serieEntrada && serieEntrada.datos ? serieEntrada.datos : null,
  };
}

/** El censo puede venir como mapa {CLAVE: {...}} o como arreglo de objetos. */
function filasDelCenso(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  if (Array.isArray(json)) {
    for (const it of json) { const f = filaCenso(null, it); if (f) out.push(f); }
    return out;
  }
  // ── Detección de envoltorio, SIN depender de cuántas emisoras vengan ──
  //
  // La versión anterior decía `llaves.length <= 3`, y eso hacía que la MISMA
  // emisora se parseara distinto según el lote: `?job=emisoras` pasa cientos de
  // llaves de golpe (nunca envoltorio) y `?job=reparse` pasaba una a la vez
  // (envoltorio si la pizarra no matchaba el regex). Con una pizarra de UN
  // carácter —Quálitas cotiza como `Q`— el heurístico se disparaba y la fila
  // salía como `*` en vez de `Q*`: filas que aparecen de la nada y tipos que se
  // pierden, sobre el mismo crudo guardado.
  //
  // **Un censo que cambia solo no sirve para un universo point-in-time**, así
  // que la regla ahora mira la FORMA y no el tamaño: es envoltorio sólo si el
  // valor de la llave contiene, él mismo, dos o más llaves con pinta de
  // pizarra. Eso da el mismo resultado se pase una emisora o quinientas.
  const llaves = Object.keys(json);
  const envoltorios = llaves.filter((k) => {
    const v = json[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (pareceClave(k) && !CONTENEDORES.has(normalizaLlave(k))) return false;
    return Object.keys(v).filter((x) => pareceClave(x)).length >= 2;
  });
  if (envoltorios.length) {
    for (const k of envoltorios) out.push(...filasDelCenso(json[k]));
    if (out.length) return out;
  }
  for (const [k, v] of Object.entries(json)) {
    // Una llave cuyo valor no es un objeto —`{"creditos": 5}` colgando del
    // mismo nivel— NO es una emisora. Sin este filtro, "creditos" entraría al
    // censo como si cotizara.
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!pareceClave(k) && !tieneCampoDeEmisora(v)) continue;
    // Una emisora puede cotizar VARIAS series (A y B, CPO y L…). Cada una es
    // su propio instrumento con su propio precio, así que cada una es su
    // propia fila. Los financieros siguen siendo por emisora y se deduplican
    // al armar esa lista de trabajo.
    const series = seriesDeEmisora(v);
    if (series.length) {
      for (const se of series) { const f = filaCenso(k, v, se); if (f) out.push(f); }
    } else {
      const f = filaCenso(k, v);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Una clave de pizarra: 'WALMEX', 'PE&OLES', 'AC' — y también 'NAFTRAC ISHRS',
 * que lleva la serie pegada con un espacio.
 *
 * Ese espacio importa: la primera versión de este filtro exigía una sola
 * palabra y habría TIRADO la fila del benchmark del censo, silenciosamente.
 * Por eso se admite UN espacio y un segundo token corto — con dos o más, ya es
 * prosa ('RESULTADO DE LA CONSULTA') y no una pizarra.
 */
function pareceClave(k) {
  return /^[A-Z][A-Z0-9&*.-]{0,11}(?: [A-Z0-9&*.-]{1,8})?$/.test(String(k).trim().toUpperCase());
}

function tieneCampoDeEmisora(v) {
  return Object.keys(v).some((k) => /^(emisora|clave|serie|razon_social|tipo_valor_id)/i.test(k));
}

async function jobEmisoras() {
  const mes = mesPresupuesto();
  const saldo = await presupuesto(mes);
  const cartera = nuevaCartera({ mes, gastadoMes: saldo.creditos, tope: 1 });

  if (!cartera.puedeSeguir()) {
    return { job: 'emisoras', paro: cartera.razonParo, saldo };
  }
  const r = await traer(construirUrl('/emisoras', { mercado: 'local' }));
  cartera.anota(r);
  const gastoMes = await cerrarCartera(cartera);

  if (!r.ok) {
    return { job: 'emisoras', error: r.error, status: r.status, cuerpo: r.texto, url: r.url, creditos: gastoMes };
  }

  const filas = filasDelCenso(r.json);
  // Las distribuciones vienen DENTRO de esta misma respuesta, así que se
  // extraen aquí y para TODAS las emisoras: pedirlas después costaría otro
  // request, y el retorno total las necesita de los DOS lados — el benchmark
  // y la canasta.
  let distribuciones = 0;
  const conReparto = [];
  // Los nombres de campo que trajo el reparto. De ellos depende si la fecha
  // guardada es la EX o la de PAGO — son días distintos y el retorno total se
  // arma con la ex, así que esto se reporta en vez de suponerse.
  const camposDividendo = new Set();
  const tiposDividendo = {};
  const divisasDividendo = {};
  let aproximadas = 0;
  let repartosTotales = 0;
  let colapsadas = 0;
  let sumadas = 0;
  let bajoUmbral = 0;
  let requierenConversion = 0;
  const categoriasDividendo = {};
  const seriesExtranjeras = [];
  for (const f of filas) {
    await upsertEmisora(f);
    const d = extraerDistribuciones(f.raw_serie || f.raw);
    for (const c of d.campos || []) camposDividendo.add(c);
    for (const [k, v] of Object.entries(d.tipos || {})) tiposDividendo[k] = (tiposDividendo[k] || 0) + v;
    for (const [k, v] of Object.entries(d.divisas || {})) divisasDividendo[k] = (divisasDividendo[k] || 0) + v;
    aproximadas += d.aproximadas || 0;
    colapsadas += d.colapsadas || 0;
    sumadas += d.sumadas || 0;
    bajoUmbral += d.bajo_umbral || 0;
    requierenConversion += d.requieren_conversion || 0;
    for (const [k, v] of Object.entries(d.categorias || {})) categoriasDividendo[k] = (categoriasDividendo[k] || 0) + v;
    if (d.requieren_conversion) {
      const divs = Object.keys(d.divisas || {}).filter((x) => x.toUpperCase() !== 'MXN');
      seriesExtranjeras.push({ emisora_serie: f.emisora_serie, tipo_valor_id: f.tipo_valor_id || null, divisas: divs, n: d.requieren_conversion });
    }
    repartosTotales += d.distribuciones.length;
    if (d.distribuciones.length) {
      distribuciones += await insertarDistribuciones(f.emisora, f.emisora_serie, d.distribuciones);
      conReparto.push(f.emisora_serie);
    }
  }

  const ics = filas.filter((f) => f.tipo_valor_id === '1');
  const sinRango = ics.filter((f) => !f.fin_desde);
  const bench = filas.find((f) => f.emisora === BENCHMARK) || null;

  await marcarLedger('emisoras', '(todas)', 'local', { estado: 'hecho', filas: filas.length, requests: 1 });

  return {
    job: 'emisoras',
    guardadas: filas.length,
    ics: ics.length,
    ics_emisoras_unicas: new Set(ics.map((f) => f.emisora)).size,
    // Sin serie no se puede pedir /v2/historicos: esa emisora no tendría precios
    // y quedaría fuera del universo sin que nadie lo note.
    ics_sin_serie: ics.filter((f) => !f.serie).map((f) => f.emisora),
    ejemplos_emisora_serie: ics.slice(0, 10).map((f) => f.emisora_serie),
    ics_por_estatus: contar(ics.map((f) => f.estatus || '(null)')),
    // El rango_financieros es EL dato point-in-time. Una ICS sin rango es una
    // emisora que no se puede meter al universo sin inventarle una fecha de
    // nacimiento, así que se reporta aparte y en voz alta.
    ics_sin_rango_financieros: sinRango.map((f) => ({ emisora: f.emisora_serie, motivo: f.fin_motivo })),
    distribuciones_guardadas: distribuciones,
    // La fecha EX viene sólo en el bloque "reciente"; el histórico se aproxima
    // (pago − 3 días). El porcentaje se reporta porque una aproximación que no
    // se cuenta se vuelve un dato a los dos días.
    ex_aproximadas: aproximadas,
    pct_ex_aproximada: repartosTotales ? Math.round((100 * aproximadas) / repartosTotales) : 0,
    // "reciente" e "historico" se traslapan: esto dice cuánto de ese traslape
    // se colapsó, y cuántas veces hubo DOS montos el mismo día que se sumaron.
    repartos_colapsados: colapsadas,
    repartos_sumados: sumadas,
    // Pagos de centésimas de centavo (NAFTRAC trae varios de 1e-07). NO se
    // filtran: se cuentan para que la decisión sea tuya y no mía.
    repartos_bajo_umbral: bajoUmbral,
    umbral_placeholder: UMBRAL_PLACEHOLDER,
    // Clasificación EXPLÍCITA: qué entra al retorno total y qué no. Antes que
    // "REEMBOLSO" quedara fuera era efecto colateral de un regex, no decisión.
    repartos_por_categoria: categoriasDividendo,
    // BLOQUEANTE si toca al universo elegible: no se convierte con el tipo de
    // cambio de hoy (sería mirar el futuro) ni se trata como pesos.
    repartos_requieren_conversion: requierenConversion,
    series_divisa_extranjera: seriesExtranjeras,
    series_divisa_extranjera_ics: seriesExtranjeras.filter((x) => x.tipo_valor_id === '1'),
    dividendos_campos_vistos: [...camposDividendo],
    dividendos_por_tipo: tiposDividendo,
    // Una divisa distinta de MXN exige conversión antes de reinvertir.
    dividendos_por_divisa: divisasDividendo,
    // Insumo del retorno total de la CANASTA. Una ICS sin reparto puede ser que
    // de verdad no reparta, o que el dato no venga — y la diferencia importa:
    // lo segundo mide esa emisora a precio contra un benchmark que sí trae
    // distribuciones, o sea que rompe la simetría justo donde no se ve.
    ics_con_reparto: ics.filter((f) => conReparto.includes(f.emisora_serie)).length,
    ics_sin_reparto: ics.filter((f) => !conReparto.includes(f.emisora_serie)).map((f) => f.emisora_serie),
    benchmark: bench
      ? {
          emisora: BENCHMARK,
          tipo_valor_id: bench.tipo_valor_id,
          // El benchmark NO debe estar en el universo. Con tipo 1B la
          // exclusión es estructural (el filtro es `= '1'`, texto exacto);
          // esto lo verifica contra el dato real, no contra el supuesto.
          fuera_del_universo: bench.tipo_valor_id !== '1',
          tipo_esperado: BENCHMARK_TIPO,
          tipo_como_esperado: bench.tipo_valor_id === BENCHMARK_TIPO,
          estatus: bench.estatus,
          hist_desde: bench.hist_desde,
          hist_hasta: bench.hist_hasta,
          distribuciones: extraerDistribuciones(bench.raw).distribuciones.length,
        }
      : { emisora: BENCHMARK, presente: false, nota: `${BENCHMARK} no aparece en /v2/emisoras?mercado=local — PREGUNTAR antes de sustituirlo por el índice IPC` },
    censo: await censoResumen(),
    creditos: gastoMes,
  };
}

function contar(lista) {
  const m = {};
  for (const x of lista) m[x] = (m[x] || 0) + 1;
  return m;
}

/* ═══════════════ job: inspect (cero créditos, NO normaliza) ═══════════════ */

// Los tres campos que se miran literales: uno de `posicion`, uno de
// `resultado_trimestre`, y el que bloquea el backtest.
const CAMPOS_INSPECCION = ['assets', 'revenue', 'basicearningslosspershare'];

/** El tipo de dato REAL, con arreglo y null distinguidos de 'object'. */
function tipoDe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/** Un valor recortado para que quepa en la respuesta sin dejar de ser literal. */
function literal(v, limite = 200) {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length <= limite ? v : s.slice(0, limite) + `… (+${s.length - limite})`;
}

/**
 * Describe la forma de un crudo SIN interpretarla: llaves de primer nivel con
 * su tipo, llaves de segundo nivel de cada bloque, y dónde aparece cada campo
 * de interés con su valor y tipo literales.
 *
 * Deliberadamente no usa `resolverCampo` ni `valorDeCampo`: el punto es ver qué
 * hay, no qué entiende el parser. Si el parser y esto no coinciden, el
 * desacuerdo es el hallazgo.
 */
function describirCrudo(raw) {
  const tipoRaiz = tipoDe(raw);
  // Un ARREGLO también entra por `typeof === 'object'`, y describirlo como
  // "objeto con 0 llaves" sería exactamente la clase de descripción engañosa
  // que este job existe para no producir. Si la raíz no es un objeto plano, se
  // dice qué es y se muestra el valor.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tipo_raiz: tipoRaiz, valor: literal(raw), nivel_1: null, nivel_2: null, campos: null };
  }

  const nivel1 = Object.entries(raw).map(([k, v]) => ({
    llave: k,
    tipo: tipoDe(v),
    n_llaves: v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : null,
  }));

  const nivel2 = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    nivel2[k] = Object.keys(v).slice(0, 12).map((x) => ({ llave: x, tipo: tipoDe(v[x]) }));
    if (Object.keys(v).length > 12) nivel2[k].push({ llave: `… (+${Object.keys(v).length - 12})`, tipo: '' });
  }

  // Dónde está cada campo de interés, en CUALQUIER nivel, tal cual.
  const campos = {};
  for (const nombre of CAMPOS_INSPECCION) {
    const objetivo = normalizaLlave(nombre);
    const hallazgos = [];
    const visto = new Set();
    const caminar = (nodo, ruta) => {
      if (!nodo || typeof nodo !== 'object' || visto.has(nodo) || ruta.length > 8) return;
      visto.add(nodo);
      for (const [k, v] of Object.entries(nodo)) {
        const aqui = [...ruta, k];
        if (normalizaLlave(k) === objetivo) {
          hallazgos.push({ ruta: aqui.join('.'), tipo: tipoDe(v), valor: literal(v) });
        }
        if (v && typeof v === 'object') caminar(v, aqui);
      }
    };
    caminar(raw, []);
    campos[nombre] = hallazgos.length ? hallazgos : 'NO APARECE en ningún nivel';
  }

  return { tipo_raiz: tipoRaiz, nivel_1: nivel1, nivel_2: nivel2, campos };
}

/**
 * `?job=inspect&emisora=WALMEX&periodo=2T_2017` — cero créditos, cero
 * normalización. Devuelve la forma del crudo guardado y la de una fila que SÍ
 * produjo campos, para compararlas lado a lado.
 *
 * Existe porque el arreglo del `["etiqueta", valor]` no fue la causa raíz: de
 * 1,000 filas re-parseadas sólo 65 quedaron con campos. Dos formas distintas de
 * crudo conviven en la tabla, y la única manera de saber cuáles es mirarlas.
 */
async function jobInspect(req) {
  const q = req.query || {};
  const emisora = q.emisora ? String(q.emisora).toUpperCase() : null;
  const periodo = q.periodo ? parseClavePeriodo(String(q.periodo)) : null;

  const [formas, ok] = await Promise.all([formasDelCrudo(), financieroQueSiSirvio()]);

  let fila = null;
  if (emisora && periodo) {
    fila = await financieroCrudo({ emisora, anio: periodo.anio, trimestre: periodo.trimestre });
  }

  const resumen = (f) => (f ? {
    emisora: f.emisora,
    periodo: clavePeriodo(f.anio, f.trimestre),
    cosechado_at: f.cosechado_at,
    normalizado: {
      basicearningslosspershare: f.basicearningslosspershare,
      revenue: f.revenue,
      assets: f.assets,
    },
    faltantes: f.faltantes,
    crudo: describirCrudo(f.raw),
  } : null);

  return {
    job: 'inspect',
    creditos: 0,
    // EL DISCRIMINADOR: cuántas formas distintas de crudo hay en la tabla, y
    // cuál produce campos. Si aquí sale una sola forma, el problema es del
    // parser; si salen varias, la cosecha guardó cosas distintas.
    formas_del_crudo: formas,
    solicitada: emisora && periodo
      ? (resumen(fila) || { error: `no hay fila para ${emisora} ${q.periodo}` })
      : { nota: 'pasa &emisora=WALMEX&periodo=2T_2017 para inspeccionar una fila concreta' },
    // Una fila que SÍ normalizó, para ver en qué se diferencia.
    ejemplo_que_si_sirvio: resumen(ok) || { nota: 'ninguna fila tiene campos normalizados' },
    campos_inspeccionados: CAMPOS_INSPECCION,
  };
}

/* ═══════════════ job: reparse-fin (cero créditos) ═══════════════ */

/**
 * Re-normaliza los financieros desde el `raw` ya guardado. **No toca la API.**
 *
 * Esta es la razón por la que `raw jsonb NOT NULL` estaba en el schema desde el
 * primer día, y es la primera vez que se cobra la póliza: 4,174 respuestas
 * cosechadas con la normalización rota se arreglan **sin gastar un crédito**.
 * Si el crudo no se hubiera guardado, esto costaría otra cosecha completa.
 *
 * Va paginado por (emisora, año, trimestre) y con reloj: son 4,174 filas con un
 * jsonb grande cada una, y la lambda tiene 300s.
 */
async function jobReparseFinancieros(req) {
  const t0 = Date.now();
  const lote = Math.max(1, Math.min(1000, Number((req.query && req.query.max) || 1500)));

  let cursor = null;
  let leidas = 0;
  let arregladas = 0;
  let siguenSinCampos = 0;
  const porAnio = {};
  const faltantesPorCampo = {};

  while (leidas < lote && Date.now() - t0 < LIMITE_MS) {
    const filas = await financierosCrudos({ limite: Math.min(200, lote - leidas), desde: cursor });
    if (!filas.length) { cursor = null; break; }

    for (const f of filas) {
      const { valores, faltantes } = normalizarFinancieros(f.raw);
      await actualizarFinancieros({ emisora: f.emisora, anio: f.anio, trimestre: f.trimestre, valores, faltantes });

      const sinCampos = CAMPOS.every((c) => valores[c] === null);
      if (sinCampos) siguenSinCampos += 1; else arregladas += 1;
      for (const c of Object.keys(faltantes || {})) faltantesPorCampo[c] = (faltantesPorCampo[c] || 0) + 1;

      if (!porAnio[f.anio]) porAnio[f.anio] = { filas: 0, con_eps: 0 };
      porAnio[f.anio].filas += 1;
      if (valores.basicearningslosspershare !== null) porAnio[f.anio].con_eps += 1;

      // El ledger se pone al día con la realidad: una fila que ahora sí
      // normaliza deja de ser `sin_campos`.
      await marcarLedger('financieros', f.emisora, clavePeriodo(f.anio, f.trimestre),
        { estado: sinCampos ? 'sin_campos' : 'hecho', intentos: 0 });
    }
    leidas += filas.length;
    const ultima = filas[filas.length - 1];
    cursor = { emisora: ultima.emisora, anio: ultima.anio, trimestre: ultima.trimestre };
    if (filas.length < 200) { cursor = null; break; }
  }

  return {
    job: 'reparse-fin',
    creditos: 0,
    leidas,
    arregladas,
    siguen_sin_campos: siguenSinCampos,
    // Por año, que es como el reporte de cobertura lo muestra y como se ve de
    // un golpe si algún periodo quedó fuera.
    con_eps_por_anio: Object.fromEntries(Object.entries(porAnio).sort()),
    faltantes_por_campo: faltantesPorCampo,
    continuar_desde: cursor,
    hay_mas: cursor !== null,
    nota: cursor ? 'quedan filas: vuelve a llamar con el mismo job' : 'no quedan filas',
  };
}

/* ═══════════════ job: reparse (cero créditos) ═══════════════ */

/**
 * Vuelve a derivar el censo desde el `raw` ya guardado. **No toca la API.**
 *
 * Es el cobro de la póliza: guardar el crudo completo sólo vale la pena si
 * existe la forma de re-leerlo. Si mañana resulta que la serie se detectaba mal
 * o que un rango venía en otra forma, esto lo arregla sin gastar un crédito y
 * sin volver a bajar 441 KB.
 */
async function jobReparse() {
  const previas = await sql(`select emisora, emisora_serie, raw from bmv_emisoras`);
  if (!previas.length) return { job: 'reparse', error: 'no hay censo guardado' };

  // Se re-desdobla desde el crudo pasando el censo COMPLETO de una vez, que es
  // exactamente lo que hace `?job=emisoras`. Pasarlo emisora por emisora era la
  // otra mitad del no-determinismo: aunque el heurístico de envoltorio ya no
  // depende del tamaño del lote, los dos caminos deben ser el MISMO camino, no
  // dos que casualmente coinciden.
  const crudo = {};
  for (const p of previas) {
    if (!p.raw || crudo[p.emisora]) continue;
    crudo[p.emisora] = p.raw;
  }
  const filas = filasDelCenso(crudo);
  let distribuciones = 0;
  let aproximadas = 0;
  let repartosTotales = 0;
  let colapsadas = 0;
  let sumadas = 0;
  let bajoUmbral = 0;
  let requierenConversion = 0;
  const categoriasDividendo = {};
  const seriesExtranjeras = [];
  const tiposDividendo = {};
  const divisasDividendo = {};
  const conReparto = [];
  for (const f of filas) {
    await upsertEmisora(f);
    const d = extraerDistribuciones(f.raw_serie || f.raw);
    for (const [k, v] of Object.entries(d.tipos || {})) tiposDividendo[k] = (tiposDividendo[k] || 0) + v;
    for (const [k, v] of Object.entries(d.divisas || {})) divisasDividendo[k] = (divisasDividendo[k] || 0) + v;
    aproximadas += d.aproximadas || 0;
    colapsadas += d.colapsadas || 0;
    sumadas += d.sumadas || 0;
    bajoUmbral += d.bajo_umbral || 0;
    requierenConversion += d.requieren_conversion || 0;
    for (const [k, v] of Object.entries(d.categorias || {})) categoriasDividendo[k] = (categoriasDividendo[k] || 0) + v;
    if (d.requieren_conversion) {
      const divs = Object.keys(d.divisas || {}).filter((x) => x.toUpperCase() !== 'MXN');
      seriesExtranjeras.push({ emisora_serie: f.emisora_serie, tipo_valor_id: f.tipo_valor_id || null, divisas: divs, n: d.requieren_conversion });
    }
    repartosTotales += d.distribuciones.length;
    if (d.distribuciones.length) {
      distribuciones += await insertarDistribuciones(f.emisora, f.emisora_serie, d.distribuciones);
      conReparto.push(f.emisora_serie);
    }
  }
  // La DERIVA, explícita. Si re-derivar el mismo crudo produce filas distintas
  // a las guardadas, eso es exactamente lo que no se puede tolerar en un censo
  // point-in-time — y hay que verlo, no deducirlo comparando dos corridas.
  const antes = new Set(previas.map((p) => p.emisora_serie).filter(Boolean));
  const ahora = new Set(filas.map((f) => f.emisora_serie));
  const aparecieron = [...ahora].filter((x) => !antes.has(x));
  const desaparecieron = [...antes].filter((x) => !ahora.has(x));

  return {
    job: 'reparse',
    creditos: 0,
    filas_previas: previas.length,
    filas_rederivadas: filas.length,
    deriva: {
      estable: aparecieron.length === 0 && desaparecieron.length === 0,
      aparecieron: aparecieron.slice(0, 40),
      desaparecieron: desaparecieron.slice(0, 40),
      n_aparecieron: aparecieron.length,
      n_desaparecieron: desaparecieron.length,
    },
    ics: filas.filter((f) => f.tipo_valor_id === '1').length,
    con_serie: filas.filter((f) => f.serie).length,
    con_cobertura: filas.filter((f) => f.fin_desde).length,
    sin_cobertura: filas.filter((f) => f.tipo_valor_id === '1' && !f.fin_desde)
      .map((f) => ({ emisora: f.emisora_serie, motivo: f.fin_motivo })).slice(0, 20),
    distribuciones,
    series_con_reparto: conReparto.length,
    ex_aproximadas: aproximadas,
    pct_ex_aproximada: repartosTotales ? Math.round((100 * aproximadas) / repartosTotales) : 0,
    repartos_colapsados: colapsadas,
    repartos_sumados: sumadas,
    repartos_bajo_umbral: bajoUmbral,
    umbral_placeholder: UMBRAL_PLACEHOLDER,
    // Clasificación EXPLÍCITA: qué entra al retorno total y qué no. Antes que
    // "REEMBOLSO" quedara fuera era efecto colateral de un regex, no decisión.
    repartos_por_categoria: categoriasDividendo,
    // BLOQUEANTE si toca al universo elegible: no se convierte con el tipo de
    // cambio de hoy (sería mirar el futuro) ni se trata como pesos.
    repartos_requieren_conversion: requierenConversion,
    series_divisa_extranjera: seriesExtranjeras,
    series_divisa_extranjera_ics: seriesExtranjeras.filter((x) => x.tipo_valor_id === '1'),
    dividendos_por_tipo: tiposDividendo,
    dividendos_por_divisa: divisasDividendo,
    censo: await censoResumen(),
  };
}

/* ═══════════════ job: financieros ═══════════════ */

/**
 * La lista de trabajo de financieros: qué (emisora, trimestre) falta pedir.
 * Pura y exportada para que los tests la fijen — es donde se decide en qué
 * gastar los créditos, así que una equivocación acá se paga en requests.
 *
 * Dos reglas que no son obvias:
 *
 * 1. **Por EMISORA, no por serie.** `/v2/financieros` no conoce series, así que
 *    LIVEPOL `C-1` y LIVEPOL `1` son el mismo request. Pero los campos del
 *    censo SÍ son del instrumento, así que una serie puede traer cobertura y la
 *    otra no: al deduplicar se prefiere **la que tenga cobertura**, o se
 *    perderían los financieros de la emisora entera según cuál ordene primero.
 *
 * 2. **La enumeración gana sobre el rango.** `rango_financieros` lista los
 *    trimestres que la emisora SÍ reportó y puede tener huecos. Pedir min..max
 *    los rellena con requests que vuelven vacíos y —peor— mete a la emisora al
 *    universo en trimestres en los que no reportó. El `?job=estimate` ya cuenta
 *    con la enumeración: sin esto, la cosecha pediría más de lo presupuestado.
 */
function pendientesFinancieros(ics, { soloEmisora = null, hechas = new Set() } = {}) {
  const tiene = (x) => !!((Array.isArray(x.fin_periodos) && x.fin_periodos.length) || x.fin_desde);
  const porEmisora = new Map();
  for (const e of ics) {
    if (soloEmisora && e.emisora !== soloEmisora) continue;
    const previa = porEmisora.get(e.emisora);
    if (!previa || (!tiene(previa) && tiene(e))) porEmisora.set(e.emisora, e);
  }

  const pendientes = [];
  for (const e of porEmisora.values()) {
    const lista = Array.isArray(e.fin_periodos) && e.fin_periodos.length
      ? e.fin_periodos.map(parsePeriodoTexto).filter(Boolean)
      : null;
    let trimestres;
    if (lista) {
      trimestres = lista.filter((t) => recortarACobertura(t, t, COBERTURA_FIN));
    } else {
      const desde = e.fin_desde ? parsePeriodoTexto(e.fin_desde) : null;
      const hasta = e.fin_hasta ? parsePeriodoTexto(e.fin_hasta) : null;
      const rango = recortarACobertura(desde, hasta, COBERTURA_FIN);
      if (!rango) continue;          // los bancos y casas de bolsa caen acá
      trimestres = trimestresEntre(rango.desde, rango.hasta);
    }
    for (const t of trimestres) {
      const clave = clavePeriodo(t.anio, t.trimestre);
      if (hechas.has(`${e.emisora}|${clave}`)) continue;
      pendientes.push({ emisora: e.emisora, anio: t.anio, trimestre: t.trimestre, clave });
    }
  }
  return pendientes;
}

async function jobFinancieros(req) {
  const tope = Math.max(1, Math.min(2000, Number((req.query && req.query.max) || LOTE_DEFECTO)));
  const soloEmisora = req.query && req.query.emisora ? String(req.query.emisora).toUpperCase() : null;

  const mes = mesPresupuesto();
  const [saldo, contrato, ics, hechas] = await Promise.all([
    presupuesto(mes), contratoVigente(), emisorasIcs(),
    clavesHechas('financieros', { reintentar: req.query && req.query.reintentar === '1' }),
  ]);

  if (!ics.length) {
    return { job: 'financieros', error: 'no hay censo: corre ?job=emisoras primero' };
  }
  // Un contrato sin verificar NO bloquea: bloquear obligaría a un deploy para
  // destrabar la cosecha. Viaja como `aviso` en la respuesta, y el `&max=N`
  // de la corrida limita lo que puede costar equivocarse.

  // Lista de trabajo: emisora × trimestre de SU rango, menos lo ya hecho.
  const pendientes = pendientesFinancieros(ics, { soloEmisora, hechas });
  const vistasN = new Set(pendientes.map((p) => p.emisora)).size;

  const cartera = nuevaCartera({ mes, gastadoMes: saldo.creditos, tope });
  const hecho = [];
  let i = 0;
  for (; i < pendientes.length; i++) {
    if (!cartera.puedeSeguir()) break;
    const p = pendientes[i];
    const r = await traer(construirUrl('/financieros', paramsFinancieros(contrato, p.emisora, p.anio, p.trimestre)));
    cartera.anota(r);

    if (!r.ok) {
      await marcarLedger('financieros', p.emisora, p.clave, { estado: 'error', requests: 1, error_msg: `${r.status}: ${r.error} · ${String(r.texto || '').slice(0, 200)}` });
      hecho.push({ ...p, estado: 'error', error: r.error });
    } else {
      const { valores, faltantes } = normalizarFinancieros(r.json);
      // NO es "la respuesta venía vacía": es "no le entendí a la respuesta".
      // Las 4,174 filas de la primera cosecha cayeron aquí porque los valores
      // llegan como ["etiqueta", 0.77] y el parser sólo leía números sueltos.
      // El ledger lo dijo; el nombre `vacio` lo hizo sonar benigno.
      const sinCampos = CAMPOS.every((c) => valores[c] === null);
      await upsertFinancieros({
        emisora: p.emisora, anio: p.anio, trimestre: p.trimestre,
        fecha_cierre: finDeTrimestre(p.anio, p.trimestre),
        raw: r.json, valores, faltantes,
      });
      // 'vacio' ≠ 'error': un trimestre en el que la emisora no reportó es un
      // hecho del mundo, no una falla. Se marca resuelto para no re-pedirlo.
      await marcarLedger('financieros', p.emisora, p.clave, { estado: sinCampos ? 'sin_campos' : 'hecho', requests: 1, filas: 1 });
      hecho.push({ ...p, estado: sinCampos ? 'sin_campos' : 'hecho', eps: valores.basicearningslosspershare });
    }
    await dormir(PAUSA_MS);
  }

  const gastoMes = await cerrarCartera(cartera);
  return {
    job: 'financieros',
    contrato_verificado: !!contrato.verificado,
    aviso: contrato.verificado ? null : 'CONTRATO NO VERIFICADO — corre ?job=probe primero; lo cosechado puede venir vacío',
    emisoras_unicas: vistasN,
    pendientes_al_empezar: pendientes.length,
    procesadas: hecho.length,
    restantes: Math.max(0, pendientes.length - i),
    se_quedo_en: i < pendientes.length ? pendientes[i] : null,
    paro: cartera.razonParo,
    resumen: contar(hecho.map((h) => h.estado)),
    agotadas: await clavesAgotadas('financieros'),
    max_intentos: MAX_INTENTOS,
    creditos: { corrida: cartera.creditos, requests: cartera.requests, mes: gastoMes },
    detalle: hecho.slice(-25),
  };
}

function parsePeriodoTexto(s) {
  const m = /^(\d{4})-([1-4])$/.exec(String(s).trim());
  return m ? { anio: Number(m[1]), trimestre: Number(m[2]) } : null;
}

/* ═══════════════ job: historicos ═══════════════ */

async function jobHistoricos(req) {
  const tope = Math.max(1, Math.min(500, Number((req.query && req.query.max) || 30)));
  const desdeForzado = req.query && req.query.desde ? String(req.query.desde).slice(0, 10) : null;
  const porAnio = String((req.query && req.query.chunk) || '') === 'anio';
  const soloEmisora = req.query && req.query.emisora ? String(req.query.emisora).toUpperCase() : null;

  const mes = mesPresupuesto();
  const [saldo, contrato, ics, hechas] = await Promise.all([
    presupuesto(mes), contratoVigente(), emisorasIcs(),
    clavesHechas('historicos', { reintentar: req.query && req.query.reintentar === '1' }),
  ]);
  if (!ics.length) return { job: 'historicos', error: 'no hay censo: corre ?job=emisoras primero' };

  // El benchmark se cosecha AUNQUE no sea ICS: NAFTRAC es un ETF, no una
  // acción, así que nunca va a salir en el universo tipo_valor_id=1. Sin él no
  // hay contra qué medir el backtest.
  const objetivo = [...ics];
  if (!objetivo.some((e) => e.emisora_serie === BENCHMARK)) {
    const b = await emisoraPorClave(BENCHMARK);
    objetivo.push(b || { emisora: BENCHMARK_EMISORA, emisora_serie: BENCHMARK, hist_desde: null, hist_hasta: null });
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const yaTengo = await ultimaFechaPrecios();
  const pendientes = [];
  for (const e of objetivo) {
    const clave = e.emisora_serie || e.emisora;
    if (soloEmisora && e.emisora !== soloEmisora && clave !== soloEmisora) continue;
    // Sin serie no hay con qué pedir /v2/historicos. Se salta y se reporta:
    // una emisora sin precios queda fuera del universo, y eso tiene que verse.
    if (!clave) continue;
    let d = e.hist_desde ? String(e.hist_desde).slice(0, 10) : PRECIOS_DESDE_DEFECTO;
    const h = e.hist_hasta ? String(e.hist_hasta).slice(0, 10) : hoy;
    if (desdeForzado && desdeForzado > d) d = desdeForzado;
    // INCREMENTAL: si ya hay precios guardados, se pide sólo la cola. El rango
    // del censo termina en "hoy", así que sin esto la clave del ledger se
    // movería cada día y se re-cosecharían 10 años enteros por gusto.
    const tengoHasta = yaTengo.get(clave);
    if (tengoHasta && tengoHasta > d) {
      d = new Date(Date.parse(tengoHasta) + 86400000).toISOString().slice(0, 10);
    }
    if (d >= h) continue;

    if (porAnio) {
      for (let a = Number(d.slice(0, 4)); a <= Number(h.slice(0, 4)); a++) {
        const di = a === Number(d.slice(0, 4)) ? d : `${a}-01-01`;
        const hf = a === Number(h.slice(0, 4)) ? h : `${a}-12-31`;
        const ck = `${di}..${hf}`;
        if (hechas.has(`${clave}|${ck}`)) continue;
        pendientes.push({ emisora: e.emisora, emisora_serie: clave, desde: di, hasta: hf, clave: ck });
      }
    } else {
      const ck = `${d}..${h}`;
      if (hechas.has(`${clave}|${ck}`)) continue;
      pendientes.push({ emisora: e.emisora, emisora_serie: clave, desde: d, hasta: h, clave: ck });
    }
  }

  const cartera = nuevaCartera({ mes, gastadoMes: saldo.creditos, tope });
  const hecho = [];
  let i = 0;
  for (; i < pendientes.length; i++) {
    if (!cartera.puedeSeguir()) break;
    const p = pendientes[i];
    const params = p.emisora_serie === BENCHMARK
      ? paramsBenchmark(contrato, p.desde, p.hasta)
      : paramsHistoricos(contrato, p.emisora_serie, p.desde, p.hasta);
    const r = await traer(construirUrl('/historicos', params));
    cartera.anota(r);

    if (!r.ok) {
      // El CUERPO del 400 es donde la API dice qué no le gustó. Sin él, VISTAC y
      // GAVB sólo dejaron "HTTP 400" repetido 6 y 10 veces.
      await marcarLedger('historicos', p.emisora_serie, p.clave, { estado: 'error', requests: 1, error_msg: `${r.status}: ${r.error} · ${String(r.texto || '').slice(0, 200)}` });
      hecho.push({ ...p, estado: 'error', error: r.error });
    } else {
      const { filas, descartadas } = aplanarHistoricos(r.json);
      const escritas = filas.length ? await insertarPrecios(p.emisora, p.emisora_serie, filas) : 0;
      const conImporte = filas.filter((f) => f.importe !== null).length;
      await marcarLedger('historicos', p.emisora_serie, p.clave, {
        estado: filas.length ? 'hecho' : 'vacio', requests: 1, filas: escritas,
        error_msg: descartadas ? `${descartadas} filas descartadas (sin fecha o sin cierre)` : null,
      });
      hecho.push({ ...p, estado: filas.length ? 'hecho' : 'vacio', dias: escritas, con_importe: conImporte, descartadas });
    }
    await dormir(PAUSA_MS);
  }

  const gastoMes = await cerrarCartera(cartera);
  return {
    job: 'historicos',
    contrato_verificado: !!contrato.verificado,
    chunk: porAnio ? 'anio' : 'rango completo',
    pendientes_al_empezar: pendientes.length,
    procesadas: hecho.length,
    restantes: Math.max(0, pendientes.length - i),
    se_quedo_en: i < pendientes.length ? pendientes[i] : null,
    paro: cartera.razonParo,
    resumen: contar(hecho.map((h) => h.estado)),
    // Sin importe operado no se puede aplicar el filtro de liquidez del
    // backtest. Se dice aquí, no en Fase B, cuando ya sería tarde.
    dias_sin_importe: hecho.reduce((s, h) => s + ((h.dias || 0) - (h.con_importe || 0)), 0),
    // Las que se dejaron de intentar tras MAX_INTENTOS. No desaparecen del
    // reporte sólo porque el cosechador dejó de martillarlas.
    agotadas: await clavesAgotadas('historicos'),
    max_intentos: MAX_INTENTOS,
    creditos: { corrida: cartera.creditos, requests: cartera.requests, mes: gastoMes },
    detalle: hecho.slice(-30),
  };
}

/* ═══════════════ cobertura en markdown ═══════════════ */

function coberturaMd(c, est) {
  const L = [];
  L.push('# Cobertura de la cosecha DataBursatil (Fase A)', '');

  // ── CAVEATS DE PRIMER ORDEN, arriba y no enterrados ──────────────
  // Un caveat que hay que ir a buscar al pie de página no es un caveat: es una
  // coartada. Estos tres cambian cómo se lee TODO lo que sigue, así que van
  // antes que los números que califican.
  const d0 = c.distribuciones_ics || {};
  L.push('> ## Léase esto antes que los números', '>');
  L.push(`> · **Fecha ex aproximada en ${d0.pct_ex_aproximada || 0}% de los repartos.** La API sólo trae \`fechaexcupon\` en el bloque "reciente"; el resto es pago − 3 días. Aplica igual a canasta y benchmark, así que se cancela a primer orden en el exceso — pero es una aproximación, no un dato.`);
  if (d0.requieren_conversion) {
    L.push(`> · **${d0.requieren_conversion} repartos en moneda extranjera.** No se convierten ni se tratan como pesos: quedan marcados \`requiere_conversion\` y **fuera** del retorno total de la v1.`);
  }
  const reemb = (d0.por_categoria || []).find((x) => x.categoria === 'reembolso');
  if (reemb) {
    L.push(`> · **${reemb.n} reembolsos de capital**, excluidos del retorno total: devolver principal no es rendimiento. La bandera \`categoria\` permite incluirlos en una sensibilidad.`);
  }
  L.push('>', '');

  L.push(`Censo: **${c.censo.total}** emisoras guardadas; **${(c.censo.por_tipo.find((t) => t.tipo === '1') || { n: 0 }).n}** con \`tipo_valor_id=1\` (ICS).`, '');

  L.push('## Financieros por año', '', '| Año | Filas | Emisoras | Con EPS |', '|---|---:|---:|---:|');
  for (const r of c.financieros.por_anio) L.push(`| ${r.anio} | ${r.filas} | ${r.emisoras} | ${r.con_eps} |`);
  L.push('');

  const p = c.precios.total || {};
  L.push('## Precios', '', `Filas: **${p.filas || 0}** · emisoras: **${p.emisoras || 0}** · rango: ${p.desde || 'n/d'} → ${p.hasta || 'n/d'} · con importe operado: **${p.con_importe || 0}**`, '');

  const b = c.benchmark || {};
  L.push('## Benchmark', '', b.dias
    ? `${b.emisora || 'NAFTRAC ISHRS'}: **${b.dias}** días (${b.desde} → ${b.hasta}).`
    : '**BENCHMARK SIN DATOS.** El backtest no tiene contra qué medirse. No sustituir por el índice IPC sin preguntar: el IPC no es invertible y eso cambia el criterio, no sólo el dato.', '');
  const bd = b.distribuciones || {};
  L.push(bd.n
    ? `Distribuciones del benchmark: **${bd.n}** repartos (${bd.desde} → ${bd.hasta}).`
    : '**El benchmark no trae distribuciones.** Sin ellas sólo se puede calcular la serie de PRECIO, y compararse contra el precio pelón de NAFTRAC le resta ~3%/año: nos regalaría un exceso que no existió.', '');

  // La simetría del retorno total se rompe por el lado de la canasta, y se
  // rompe en silencio: una emisora sin reparto se mide a precio contra un
  // benchmark que sí lo trae.
  const di = c.distribuciones_ics || {};
  L.push('## Retorno total de la canasta', '',
    `ICS con reparto: **${di.emisoras_con_reparto || 0}** · repartos: **${di.filas || 0}** · rango: ${di.desde || 'n/d'} → ${di.hasta || 'n/d'}`, '');
  L.push(`Fecha ex **aproximada** (pago − 3 días) en **${di.ex_aproximadas || 0}** de ${di.filas || 0} repartos (**${di.pct_ex_aproximada || 0}%**). La API sólo trae \`fechaexcupon\` en el bloque "reciente".`, '');
  if ((di.por_categoria || []).length) {
    L.push('| Categoría | N | Suma | ¿entra al retorno total v1? |', '|---|---:|---:|---|');
    for (const cat of di.por_categoria) {
      const entra = cat.categoria === 'efectivo' ? '**sí**' : 'no';
      L.push(`| ${cat.categoria} | ${cat.n} | ${Number(cat.suma).toFixed(4)} | ${entra} |`);
    }
    L.push('');
  }
  const ext = di.series_divisa_extranjera || [];
  if (ext.length) {
    L.push('### Series con reparto en moneda extranjera', '',
      'No se convierten con el tipo de cambio de hoy —eso sería mirar el futuro— ni se tratan como pesos. Quedan **fuera del retorno total de la v1**. Si alguna está en el universo elegible, hay que resolverlo con el tipo de cambio en la **fecha ex**.', '',
      '| Serie | Divisa | N | Suma | tipo_valor_id | ¿ICS? |', '|---|---|---:|---:|---|---|');
    for (const x of ext) {
      L.push(`| ${x.emisora_serie} | ${x.divisa} | ${x.n} | ${Number(x.suma).toFixed(4)} | ${x.tipo_valor_id || 'n/d'} | ${x.tipo_valor_id === '1' ? '**SÍ**' : 'no'} |`);
    }
    L.push('');
    const enIcs = (di.series_divisa_extranjera_ics || []).length;
    L.push(enIcs
      ? `**${enIcs} de esas series SON ICS**, o sea que pueden entrar al universo elegible. Eso hay que resolverlo bien, no excluirlo.`
      : '**Ninguna es ICS**, así que ninguna entra al universo elegible: excluirlas de la v1 no le quita nada al backtest.', '');
  }
  if (di.consolidados) {
    L.push(`**${di.consolidados}** repartos son DOS pagos del mismo día que se sumaron (\`pago_consolidado\`), en vez de elegir uno en silencio.`, '');
  }
  if (di.bajo_umbral) {
    L.push(`**${di.bajo_umbral}** repartos están por debajo de 0.0001 pesos — centésimas de centavo, casi seguro placeholders de la fuente. **No se filtran**: la decisión de excluirlos es tuya, y va tomada antes de la Fase B.`, '');
  }
  if (di.no_efectivo) {
    L.push(`**${di.no_efectivo}** repartos NO son en efectivo y no se reinvierten como tales.`, '');
  }
  const divs = (di.por_divisa || []).filter((d) => d.divisa && d.divisa !== 'MXN' && d.divisa !== '(sin divisa)');
  if (divs.length) {
    L.push(`**Divisas distintas de MXN:** ${divs.map((d) => `${d.divisa} (${d.n})`).join(', ')} — hay que convertir antes de reinvertir.`, '');
  }
  if ((di.por_tipo || []).length > 1) {
    L.push('| Tipo de reparto | N |', '|---|---:|');
    for (const t of di.por_tipo) L.push(`| ${t.tipo} | ${t.n} |`);
    L.push('');
  }
  const sin = di.ics_sin_reparto || [];
  if (sin.length) {
    L.push(`**ICS sin ningún reparto (${sin.length}):** ${sin.join(', ')}`, '',
      'Puede ser que de verdad no repartan, o que el dato no venga. La diferencia importa: lo segundo las mide a PRECIO contra un benchmark de retorno total, que es exactamente la asimetría que este diseño corrige.', '');
  }

  L.push('## Financieros por emisora', '', '| Emisora | Trimestres | Primero | Último | Con EPS |', '|---|---:|---|---|---:|');
  for (const r of c.financieros.por_emisora) L.push(`| ${r.emisora} | ${r.trimestres} | ${r.primero} | ${r.ultimo} | ${r.con_eps} |`);
  L.push('');

  if (c.huecos && c.huecos.length) {
    L.push('## Huecos (una serie sin la otra)', '', '| Caso | Emisora |', '|---|---|');
    for (const h of c.huecos) L.push(`| ${h.caso} | ${h.emisora} |`);
    L.push('');
  }

  L.push('## Ledger', '', '| Job | Estado | N | Requests |', '|---|---|---:|---:|');
  for (const r of c.ledger.por_estado) L.push(`| ${r.job} | ${r.estado} | ${r.n} | ${r.requests} |`);
  if (c.ledger.errores.length) {
    L.push('', '### Errores recientes', '', '| Job | Emisora | Clave | Intentos | Error |', '|---|---|---|---:|---|');
    for (const e of c.ledger.errores) L.push(`| ${e.job} | ${e.emisora} | ${e.clave} | ${e.intentos} | ${String(e.error_msg || '').slice(0, 80)} |`);
  }
  if (est) {
    L.push('', '## Presupuesto', '',
      `Requests totales estimados: **${est.requests.total}** · modelo A (por request): ${est.modelos.A_por_request} · B (por dato): ${est.modelos.B_por_dato} · C (por campo×día): ${est.modelos.C_por_campo_dia} · tope mensual: ${est.presupuesto_mensual}.`);
  }
  return L.join('\n');
}

/* ═══════════════ handler ═══════════════ */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });

  const job = String((req.query && req.query.job) || '').toLowerCase();
  const protegidos = new Set(['probe', 'emisoras', 'financieros', 'historicos', 'reparse', 'reparse-fin', 'inspect']);

  try {
    await ensureBmvSchema();

    if (protegidos.has(job) && !authorized(req)) {
      return res.status(401).json({
        error: 'No autorizado.',
        detalle: adminSecret()
          ? 'header Authorization: Bearer <ADMIN_SECRET>'
          : 'ADMIN_SECRET no configurado — escritura deshabilitada (fail closed)',
      });
    }

    if (job === 'estimate') {
      const { fuente, lista } = await emisorasParaEstimar();
      const est = estimarConsumo({ emisoras: lista, preciosDesde: req.query && req.query.desde ? String(req.query.desde).slice(0, 10) : null });
      const mes = mesPresupuesto();
      return res.status(200).json({
        job: 'estimate', fuente, mes, gastado: await presupuesto(mes),
        creditos_por_request_supuestos: creditosPorRequest(),
        nota: 'Los tres modelos existen porque el costo por request de DataBursatil NO está verificado desde este sandbox. `?job=probe` lo calibra contra headers reales si la API los publica.',
        ...est,
      });
    }

    if (job === 'contrato') {
      const m = await leerMeta('contrato');
      return res.status(200).json({
        job: 'contrato',
        contrato: (m && m.value) || CONTRATO_DEFECTO,
        verificado: !!(m && m.value && m.value.verificado),
        nota: m ? m.nota : 'sin probe todavía — el contrato es la SUPOSICIÓN de arranque, no un hecho',
        actualizado: m ? m.updated_at : null,
      });
    }

    if (job === 'cobertura') {
      const c = await cobertura();
      if (String((req.query && req.query.format) || '') === 'md') {
        const { lista } = await emisorasParaEstimar();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(coberturaMd(c, estimarConsumo({ emisoras: lista })));
      }
      return res.status(200).json({ job: 'cobertura', ...c });
    }

    if (job === 'inspect') return res.status(200).json(await jobInspect(req));
    if (job === 'reparse-fin') return res.status(200).json(await jobReparseFinancieros(req));
    if (job === 'reparse') return res.status(200).json(await jobReparse());
    if (job === 'probe') return res.status(200).json(await jobProbe(req));
    if (job === 'emisoras') return res.status(200).json(await jobEmisoras());
    if (job === 'financieros') return res.status(200).json(await jobFinancieros(req));
    if (job === 'historicos') return res.status(200).json(await jobHistoricos(req));

    const mes = mesPresupuesto();
    return res.status(200).json({
      endpoint: '/api/bmv-harvest',
      que_es: 'Fase A del backtest BMV: cosecha DataBursatil → Neon (tablas bmv_*; xbrl_reports NO se toca).',
      orden_sugerido: ['?job=estimate', '?job=probe', '?job=emisoras', '?job=estimate (ya con censo real)', '?job=financieros&max=60 (repetir)', '?job=historicos&max=30 (repetir)', '?job=reparse-fin (si la normalización cambia)', '?job=cobertura&format=md'],
      jobs: {
        'estimate': 'público, sin red: presupuesto de créditos en tres modelos de costo',
        'probe': 'protegido, ≤15 requests: descubre el contrato de la API y lo guarda',
        'emisoras': 'protegido, 1 request: el censo point-in-time (rango_financieros)',
        'financieros': 'protegido, &max=N: emisora × trimestre, idempotente',
        'historicos': 'protegido, &max=N, &chunk=anio, &desde=AAAA-MM-DD',
        'cobertura': 'público, &format=md: qué hay y dónde están los hoyos',
        'contrato': 'público: el contrato descubierto por el probe',
        'reparse': 'protegido, CERO créditos: re-deriva el censo desde el crudo guardado',
        'reparse-fin': 'protegido, CERO créditos: re-normaliza los financieros desde el crudo guardado',
        'inspect': 'protegido, CERO créditos: describe la forma del crudo guardado, sin normalizar nada',
      },
      token_configurado: !!process.env.DATABURSATIL_TOKEN,
      escritura_habilitada: !!adminSecret(),
      mes_presupuesto: mes,
      gastado: await presupuesto(mes),
      presupuesto_mensual: PRESUPUESTO_MENSUAL,
      ledger: await ledgerResumen(),
    });
  } catch (err) {
    return res.status(500).json({ error: 'bmv-harvest: ' + (err && err.message ? err.message : 'desconocido') });
  }
}

export {
  CONTRATO_DEFECTO, PRECIOS_DESDE_DEFECTO, TOPE_PROBE, candidatosFinancieros, candidatosHistoricos, coberturaMd,
  contar, describirCrudo, estimarConsumo, filaCenso, filasDelCenso, literal,
  pareceClave, pareceSerie, tipoDe,
  pendientesFinancieros,
  seriesDeEmisora, muestraChica, nuevaCartera,
  paramsBenchmark, paramsFinancieros, paramsHistoricos, parsePeriodoTexto,
  sirveFinanciero,
};
