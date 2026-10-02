// ═══════════════════════════════════════════════════════════════════
// api/_lib/reaccion-fuentes.js — la FRONTERA DE RED del experimento "reaccion".
//
// Cuatro fuentes de ingresos estimados, EDGAR para los ingresos reportados y
// la guía, y Yahoo para los precios. Todas con la misma disciplina que pagó
// este repo a lo largo de las tandas anteriores:
//
//   · NO LANZA. Clasifica y devuelve el motivo. Una fuente caída se DECLARA.
//   · El STATUS y el CUERPO viajan siempre (la cicatriz del `http_error` mudo).
//   · Un 402 lo decide el CUERPO, no se adivina (`mencionaParametro`): la
//     cicatriz del texto que mandaba a rotar una llave sana.
//   · AV contesta 200 con {"Note"} cuando te limita: se detecta.
//   · Ningún fetch se hace sin poder inyectarlo: los tests corren sin red.
//
// Nada de esto interpreta. La regla de qué estimado sirve está en
// `clasificaFuenteEstimado` (reaccion.js), que es pura y testeada.
//
// ENV VARS: FMP_API_KEY · FINNHUB_API_KEY · ALPHAVANTAGE_API_KEY ·
//           SEC_USER_AGENT (opcional, edgar.js trae uno por defecto)
// ═══════════════════════════════════════════════════════════════════

import { clasifica402Fmp } from './fmp-grades.js';
import {
  crearCliente, bajarTickerMap, bajarSubmissionsCompleto, urlIndice, urlDocumento, pad10,
} from './edgar.js';
import { filasDeUnits, muestraCruda } from './mercado-edgar.js';
import { build8KIndex } from './pead-hour.js';
import {
  CRITERIOS_REACCION, clasificaFuenteEstimado, ingresosTrimestralesXbrl,
  parrafosDeGuia, eligeExhibit991, num, dia,
} from './reaccion.js';

const FMP = 'https://financialmodelingprep.com/stable';
const FINNHUB = 'https://finnhub.io/api/v1';
const AV = 'https://www.alphavantage.co/query';

// Pide, lee el cuerpo SIEMPRE, y devuelve status + muestra. Nunca lanza.
async function pedir(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const texto = await r.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(texto); } catch { /* el cuerpo crudo igual viaja */ }
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, json, body_sample: String(texto || '').slice(0, 500),
      longitud_cuerpo: String(texto || '').length };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, status: null, ms: Date.now() - t0, json: null, body_sample: null,
      motivo: /abort|timeout/i.test(m) ? 'timeout' : 'red', detalle: m.slice(0, 200) };
  }
}

// La URL que se publica NUNCA lleva la key.
const sinKey = (u) => String(u).replace(/([?&](apikey|token)=)[^&]*/gi, '$1***');

// ── Clasificación común de un fallo HTTP, con la lección del 402 ──
function clasificaFallo(r, fuente) {
  if (r.motivo) return { motivo: r.motivo, detalle: r.detalle };
  if (r.status === 401 || r.status === 403) {
    return { motivo: 'auth_error', detalle: `HTTP ${r.status}: la key fue rechazada. Se arregla en las env vars, no en el código.` };
  }
  if (r.status === 402) {
    // La MISMA clasificación que la frontera de grades. Antes había dos, y con
    // la respuesta real del 402 por `limit` una decía `parametro_fuera_de_rango`
    // y la otra `parametro_de_pago`.
    const c = clasifica402Fmp(r.body_sample, { symbol: r.symbol || null });
    return { motivo: c.motivo, parametro: c.parametro, tipo_402: c.tipo, etiqueta_fmp: c.etiqueta_fmp, detalle: c.detalle };
  }
  if (r.status === 429) return { motivo: 'rate_limit', detalle: 'HTTP 429: cuota agotada.' };
  return { motivo: 'http_error', detalle: `HTTP ${r.status}.` };
}

// ═══════════════════════════════════════════════════════════════════
// INGRESOS ESTIMADOS — una función por fuente, todas con la misma forma:
//   { fuente, ok, status, motivo, detalle, body_sample, url_sin_key, filas }
// `filas` normalizadas a { date, revenueActual, revenueEstimate } cuando hay.
// ═══════════════════════════════════════════════════════════════════

// FMP analyst-estimates con period=quarter. El encargo dice que es de pago en
// este plan: se CONFIRMA, no se asume. Aunque contestara, su forma es "una fila
// por período fiscal con el número de hoy" — `clasificaFuenteEstimado` lo dice.
async function fmpAnalystEstimatesTrimestral(symbol, { apiKey = process.env.FMP_API_KEY, fetchImpl } = {}) {
  const fuente = 'FMP analyst-estimates (period=quarter)';
  if (!apiKey) return { fuente, ok: false, motivo: 'sin_key', detalle: 'FMP_API_KEY vacía en ESTE entorno.' };
  const url = `${FMP}/analyst-estimates?symbol=${encodeURIComponent(symbol)}&period=quarter&apikey=${encodeURIComponent(apiKey)}`;
  const r = await pedir(url, { fetchImpl });
  const base = { fuente, status: r.status, ms: r.ms, body_sample: r.body_sample, url_sin_key: sinKey(url) };
  if (!r.ok) return { ...base, ok: false, ...clasificaFallo({ ...r, symbol }, fuente) };
  if (!Array.isArray(r.json)) {
    const msg = r.json && (r.json['Error Message'] || r.json.error || r.json.message);
    return { ...base, ok: false, motivo: msg ? 'fmp_error_message' : 'cuerpo_no_es_lista', detalle: msg || null };
  }
  return { ...base, ok: true, filas_crudas: r.json };
}

// FMP /stable/earnings: el registro de CADA reporte, con real y estimado de EPS
// e ingresos. Es "estimado del evento" si la forma lo confirma.
async function fmpEarnings(symbol, { apiKey = process.env.FMP_API_KEY, fetchImpl } = {}) {
  const fuente = 'FMP earnings';
  if (!apiKey) return { fuente, ok: false, motivo: 'sin_key', detalle: 'FMP_API_KEY vacía en ESTE entorno.' };
  const url = `${FMP}/earnings?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  const r = await pedir(url, { fetchImpl });
  const base = { fuente, symbol, status: r.status, ms: r.ms, body_sample: r.body_sample, url_sin_key: sinKey(url) };
  if (!r.ok) return { ...base, ok: false, ...clasificaFallo({ ...r, symbol }, fuente) };
  if (!Array.isArray(r.json)) {
    const msg = r.json && (r.json['Error Message'] || r.json.error || r.json.message);
    return { ...base, ok: false, motivo: msg ? 'fmp_error_message' : 'cuerpo_no_es_lista', detalle: msg || null };
  }
  return { ...base, ok: true, filas_crudas: r.json,
    filas: r.json.map((f) => ({ date: dia(f.date), revenueActual: num(f.revenueActual), revenueEstimate: num(f.revenueEstimated) })) };
}

// Finnhub calendar/earnings con símbolo y rango: devuelve los reportes con
// epsActual/epsEstimate y revenueActual/revenueEstimate.
async function finnhubCalendario(symbol, { desde, hasta, apiKey = process.env.FINNHUB_API_KEY, fetchImpl } = {}) {
  const fuente = 'Finnhub calendar/earnings';
  if (!apiKey) return { fuente, ok: false, motivo: 'sin_key', detalle: 'FINNHUB_API_KEY vacía en ESTE entorno.' };
  const url = `${FINNHUB}/calendar/earnings?from=${desde}&to=${hasta}&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const r = await pedir(url, { fetchImpl });
  const base = { fuente, symbol, status: r.status, ms: r.ms, body_sample: r.body_sample, url_sin_key: sinKey(url) };
  if (!r.ok) return { ...base, ok: false, ...clasificaFallo({ ...r, symbol }, fuente) };
  const lista = r.json && Array.isArray(r.json.earningsCalendar) ? r.json.earningsCalendar : null;
  if (!lista) {
    const msg = r.json && (r.json.error || r.json.message);
    return { ...base, ok: false, motivo: msg ? 'finnhub_error_message' : 'sin_earningsCalendar', detalle: msg || null };
  }
  return { ...base, ok: true, filas_crudas: lista,
    filas: lista.map((f) => ({ date: dia(f.date), revenueActual: num(f.revenueActual), revenueEstimate: num(f.revenueEstimate) })) };
}

// Alpha Vantage EARNINGS_ESTIMATES. La cuota de AV es de 25/día y la comparte el
// PEAD (docs/wheel-fase0.md §4.3), así que esta fuente se SONDEA con un símbolo
// y no se barre: si la forma no sirve, barrerla gastaría la cuota del PEAD para
// confirmar lo mismo 75 veces.
async function avEarningsEstimates(symbol, { apiKey = process.env.ALPHAVANTAGE_API_KEY, fetchImpl } = {}) {
  const fuente = 'Alpha Vantage EARNINGS_ESTIMATES';
  if (!apiKey) return { fuente, ok: false, motivo: 'sin_key', detalle: 'ALPHAVANTAGE_API_KEY vacía en ESTE entorno.' };
  const url = `${AV}?function=EARNINGS_ESTIMATES&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  const r = await pedir(url, { fetchImpl });
  const base = { fuente, symbol, status: r.status, ms: r.ms, body_sample: r.body_sample, url_sin_key: sinKey(url) };
  if (!r.ok) return { ...base, ok: false, ...clasificaFallo({ ...r, symbol }, fuente) };
  // La trampa de AV: 200 con {"Note"} o {"Information"} cuando te limita.
  if (r.json && (r.json.Note || r.json.Information)) {
    return { ...base, ok: false, motivo: 'rate_limit_av', detalle: String(r.json.Note || r.json.Information).slice(0, 200) };
  }
  const lista = r.json && Array.isArray(r.json.estimates) ? r.json.estimates : null;
  if (!lista) return { ...base, ok: false, motivo: 'sin_estimates', detalle: 'La respuesta no trae `estimates`.' };
  return { ...base, ok: true, filas_crudas: lista };
}

// La sonda: una fuente, un símbolo, y la clase que dicta la regla.
async function sondaFuente(fn, symbol, opciones = {}) {
  const r = await fn(symbol, opciones);
  const out = {
    fuente: r.fuente, symbol, ok: r.ok, status: r.status ?? null, motivo: r.motivo || null,
    detalle: r.detalle || null, parametro: r.parametro || null, url_sin_key: r.url_sin_key || null,
    body_sample: r.ok ? null : (r.body_sample || null),
  };
  if (!r.ok) return { ...out, clase: null, sirve: false };
  const c = clasificaFuenteEstimado(r.filas_crudas, { hoy: opciones.hoy || null });
  return { ...out, clase: c.clase, sirve: c.clase === 'pit_con_fecha' || c.clase === 'estimado_del_evento',
    nota: c.nota || c.motivo || null, fila_cruda: c.fila_cruda, campos: { estimado: c.campo_estimado, real: c.campo_real, fecha: c.campo_fecha } };
}

// ═══════════════════════════════════════════════════════════════════
// COBERTURA de una fuente que califica: cuántos eventos tienen estimado Y real
// de ingresos en esa fuente, cruzando por símbolo y fecha ±1 día.
// ═══════════════════════════════════════════════════════════════════

const cruzaFila = (filas, reportDate, tol = CRITERIOS_REACCION.tolerancia_cruce_dias) => {
  const T = dia(reportDate);
  if (!T || !Array.isArray(filas)) return null;
  let mejor = null, d0 = Infinity;
  for (const f of filas) {
    if (!f || !f.date || f.revenueEstimate === null || f.revenueActual === null) continue;
    const d = Math.abs((Date.parse(f.date + 'T00:00:00Z') - Date.parse(T + 'T00:00:00Z')) / 86400000);
    if (d <= tol && d < d0) { mejor = f; d0 = d; }
  }
  return mejor;
};

// Corre una fuente sobre todos los símbolos, con concurrencia y pausa propias
// (Finnhub corta a 60/min; FMP se mide en la tanda de grades).
async function barreFuente(fn, simbolos, { concurrencia = 2, pausaMs = 0, deadline = Infinity, opciones = {} } = {}) {
  const porSimbolo = new Map();
  const fallos = {};
  const cola = [...simbolos];
  let cortado = false;
  let crudasPrimera = null;
  const worker = async () => {
    while (cola.length) {
      if (Date.now() > deadline) { cortado = true; return; }
      const s = cola.shift();
      const r = await fn(s, opciones);
      if (r.ok) {
        porSimbolo.set(s, r.filas || []);
        // La regla de estimados se aplica a la forma CRUDA. Las filas
        // normalizadas siempre traen fecha + real + estimado — clasificarlas a
        // ellas haría que cualquier fuente "sirviera".
        if (!crudasPrimera && Array.isArray(r.filas_crudas) && r.filas_crudas.length) crudasPrimera = r.filas_crudas;
      }
      else fallos[s] = { motivo: r.motivo, status: r.status ?? null, detalle: r.detalle || null };
      if (pausaMs) await new Promise((res) => setTimeout(res, pausaMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencia, simbolos.length) }, worker));
  return { porSimbolo, fallos, cortado, crudasPrimera, pedidos: porSimbolo.size + Object.keys(fallos).length };
}

// ═══════════════════════════════════════════════════════════════════
// EDGAR — ingresos REPORTADOS por XBRL, sin LLM
// ═══════════════════════════════════════════════════════════════════

const urlConcepto = (cik, tag) => `https://data.sec.gov/api/xbrl/companyconcept/CIK${pad10(cik)}/us-gaap/${tag}.json`;

async function ingresosReportadosEdgar(cli, cik, { criterios = CRITERIOS_REACCION } = {}) {
  const intentos = [];
  for (const tag of criterios.tags_ingresos) {
    try {
      const { json } = await cli.json(urlConcepto(cik, tag), { kind: 'companyconcept-ingresos' });
      const { filas, unidad } = filasDeUnits(json, { preferida: 'USD' });
      const trimestres = ingresosTrimestralesXbrl(filas, { criterios });
      intentos.push({ tag, hechos: filas.length, unidad, trimestres: trimestres.length });
      if (trimestres.length) return { ok: true, tag, unidad, trimestres, intentos };
    } catch (e) {
      // Un 404 es "esta empresa no usa ese tag": se prueba el siguiente.
      intentos.push({ tag, status: e && e.status ? e.status : null, error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return { ok: false, motivo: 'ningun_tag_con_trimestres', intentos };
}

// ═══════════════════════════════════════════════════════════════════
// EDGAR — la GUÍA: el párrafo crudo del Exhibit 99.1 de los 8-K Item 2.02
// ═══════════════════════════════════════════════════════════════════

// `desde` lo decide el endpoint (DESDE_FUENTES): una sola fuente de verdad para
// la fecha, no dos literales que se desincronizan.
async function guiaDeSimbolo(cli, cik, { desde, criterios = CRITERIOS_REACCION } = {}) {
  if (!desde) return { ok: false, motivo: 'sin_fecha_desde', filings: [] };
  let sub;
  try {
    sub = await bajarSubmissionsCompleto(cli, cik, { desde, maxPaginas: 3 });
  } catch (e) {
    return { ok: false, motivo: 'submissions_fallo', detalle: String((e && e.message) || e).slice(0, 200), filings: [] };
  }
  const indices = [build8KIndex(sub.principal && sub.principal.filings && sub.principal.filings.recent),
    ...sub.paginas.map((pg) => build8KIndex(pg.json))].flat();
  const recientes = indices.filter((f) => f.filingDate && f.filingDate >= desde)
    .sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate)))
    .slice(0, criterios.filings_guia_por_simbolo);
  const filings = [];
  for (const f of recientes) {
    const out = { fecha: f.filingDate, accession: f.accession, parrafos: [] };
    try {
      const { json } = await cli.json(urlIndice(cik, f.accession), { kind: 'indice-8k' });
      const items = json && json.directory && Array.isArray(json.directory.item) ? json.directory.item : [];
      const ex = eligeExhibit991(items, f.primaryDocument);
      out.exhibit = ex.nombre; out.regla_exhibit = ex.regla;
      if (!ex.nombre) { filings.push({ ...out, error: 'sin_exhibit_candidato' }); continue; }
      out.url = urlDocumento(cik, f.accession, ex.nombre);
      const { texto } = await cli.texto(out.url, { kind: 'exhibit-99-1' });
      out.parrafos = parrafosDeGuia(texto, { criterios });
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 200);
    }
    filings.push(out);
  }
  return { ok: true, filings, truncado: sub.truncado };
}

export {
  pedir, sinKey, clasificaFallo,
  fmpAnalystEstimatesTrimestral, fmpEarnings, finnhubCalendario, avEarningsEstimates,
  sondaFuente, cruzaFila, barreFuente,
  ingresosReportadosEdgar, guiaDeSimbolo, urlConcepto,
  crearCliente, bajarTickerMap, muestraCruda,
};
