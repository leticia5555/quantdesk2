// ═══════════════════════════════════════════════════════════════════
// La tab EARNINGS no puede contradecirse a sí misma.
//
// NFLX, el día de su reporte: la tarjeta de Polymarket decía "superó 15 de 20"
// y el panel EPS HISTORY, justo abajo, "0/4 beats, avg −7.1%". El revenue
// salía al doble ($24.81B, el acumulado del semestre), la reacción
// post-earnings se medía desde el CIERRE FISCAL en vez del reporte, el
// IMPLIED MOVE lo escribía el LLM ("±4.2% · AI" contra un straddle de ~±9.6%)
// y el veredicto de IA razonaba sobre todo eso: "MISS, 0% historical beat rate".
//
// Lo que este archivo fija:
//   1. La tarjeta y el panel dan EL MISMO beat rate para el mismo ticker
//      (falla si divergen — punto 5 del pedido).
//   2. El diagnóstico, reproducido: period≠fecha de reporte, YTD≠trimestre.
//   3. Finnhub solo como respaldo etiquetado.
//   4. IMPLIED MOVE: de la cadena de opciones o "—"; nunca del LLM (lint).
//   5. Veredicto fail-closed ante datos inconsistentes.
//
// Sin red: Neon, Finnhub y Yahoo van mockeados. `node tests/earnings-tab-coherencia.test.mjs`.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}
const jsonResponse = (obj, okFlag = true) => ({ ok: okFlag, status: okFlag ? 200 : 500,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => obj, text: async () => JSON.stringify(obj) });

process.env.FINNHUB_API_KEY = 'test-key';
process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';

const { default: earningsHandler } = await import('../api/earnings.js');
const { default: optionsHandler, eligeExpiracion, straddleAtm } = await import('../api/options.js');
const { estadisticasHistoricas } = await import('../api/_lib/earnings-beat.js');
const { leeHistoricoPead, reaccionAlReporte, revenueTrimestral, evaluaConsistencia, historiaDesdeFinnhub } =
  await import('../api/_lib/historial-pead.js');

// ─────────────────── fixtures (NFLX, forma real) ───────────────────
// Fechas relativas a "hoy" para que el fixture no envejezca. El ciclo es el de
// NFLX: cierre fiscal al final del trimestre de calendario, reporte ~16 días
// después, AMC.
const DIA = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const HOY = Date.now();
// 24 trimestres hacia atrás (más que la ventana de 20, para que la ventana importe).
const EVENTOS = Array.from({ length: 24 }, (_, i) => {
  const cierre = HOY - (i + 1) * 91 * DIA - 16 * DIA;
  return { fiscal: iso(cierre), reporte: iso(cierre + 16 * DIA) };
});
// 15 beats en los 20 más recientes; los 4 más viejos, misses (fuera de ventana).
const BEATS_VENTANA = new Set([0, 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 14, 15, 17, 19]);
const FILAS_PEAD = EVENTOS.map((e, i) => {
  const est = 0.79 - i * 0.02;
  const rep = (i < 20 ? BEATS_VENTANA.has(i) : false) ? est + 0.01 : est - 0.03;
  return { symbol: 'NFLX', reported_date: e.reporte, fiscal_date_ending: e.fiscal,
    reported_eps: rep.toFixed(4), estimated_eps: est.toFixed(4), surprise_pct: (((rep - est) / est) * 100).toFixed(4) };
});
// Finnhub: OTRO consenso (más alto), así que salen misses donde AV da beats.
// `period` es el cierre fiscal — no hay fecha de reporte en este endpoint.
const FINNHUB_EPS = EVENTOS.slice(0, 8).map((e, i) => ({
  symbol: 'NFLX', period: e.fiscal, year: 2000 + i, quarter: 1 + (i % 4),
  estimate: Number(FILAS_PEAD[i].reported_eps) + 0.0032, actual: Number(FILAS_PEAD[i].reported_eps),
}));

// Precios: un salto del 8% el día siguiente a cada reporte (AMC), y casi nada
// el día después del cierre fiscal. Es la diferencia que el bug escondía.
function serieDePrecios() {
  const out = []; let px = 1000;
  const saltos = new Set(EVENTOS.map((e) => iso(Date.parse(e.reporte) + DIA)));
  for (let t = HOY - 900 * DIA; t <= HOY; t += DIA) {
    const d = iso(t);
    px = saltos.has(d) ? px * 1.08 : px * 1.001;
    out.push({ date: d, close: px });
  }
  return out;
}
const PRECIOS = serieDePrecios();

// Neon SQL-over-HTTP: lo que api/_lib/db.js espera recibir.
const OID_TEXT = 25, OID_NUM = 1700;
function neonRespuesta(body) {
  const q = String(body.query || '');
  if (/from pead_earnings/.test(q)) {
    const syms = body.params || [];
    const filas = FILAS_PEAD.filter((f) => syms.includes(f.symbol));
    const cols = [['symbol', OID_TEXT], ['reported_date', OID_TEXT], ['fiscal_date_ending', OID_TEXT],
      ['reported_eps', OID_NUM], ['estimated_eps', OID_NUM], ['surprise_pct', OID_NUM]];
    return { fields: cols.map(([name, dataTypeID]) => ({ name, dataTypeID })),
      rows: filas.map((f) => cols.map(([c]) => f[c])) };
  }
  if (/from pead_event_hour/.test(q)) {
    return { fields: [{ name: 'reported_date', dataTypeID: OID_TEXT }, { name: 'hour', dataTypeID: OID_TEXT }],
      rows: EVENTOS.map((e) => [e.reporte, 'amc']) };
  }
  throw new Error('consulta inesperada: ' + q);
}

function instalaFetch({ neon = true, calendarioPasado = [], financials = [] } = {}) {
  const llamadas = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    llamadas.push(u);
    if (u.includes('neon.tech/sql')) {
      if (!neon) return jsonResponse({ message: 'down' }, false);
      return jsonResponse(neonRespuesta(JSON.parse(opts.body)));
    }
    if (u.includes('/stock/earnings')) return jsonResponse(FINNHUB_EPS);
    if (u.includes('/calendar/earnings')) {
      const desde = /from=([\d-]+)/.exec(u)[1];
      const hoy = iso(HOY);
      return jsonResponse({ earningsCalendar: desde < hoy ? calendarioPasado
        : [{ symbol: 'NFLX', date: hoy, hour: 'amc', epsEstimate: 0.81, quarter: 3, year: 2026 }] });
    }
    if (u.includes('/financials-reported')) return jsonResponse({ data: financials });
    if (u.includes('/v8/finance/chart/')) {
      return jsonResponse({ chart: { result: [{
        timestamp: PRECIOS.map((p) => Date.parse(p.date) / 1000),
        indicators: { quote: [{ close: PRECIOS.map((p) => p.close) }] } }] } });
    }
    throw new Error('fetch inesperado: ' + u);
  };
  return llamadas;
}

async function panel(ticker = 'NFLX') {
  const r = mockRes();
  await earningsHandler({ method: 'GET', query: { ticker } }, r);
  return r.body;
}

// La tarjeta de Polymarket, tal como la arma `vistaLive` en api/earnings-beat.js:
// el SELECT compartido + estadisticasHistoricas por símbolo. El lint de abajo
// comprueba que vistaLive siga haciendo exactamente esto.
async function tarjeta(ticker = 'NFLX') {
  const porSimbolo = await leeHistoricoPead([ticker]);
  return estadisticasHistoricas(porSimbolo.get(ticker) || []);
}

const mismoBeatRate = (card, p) => card && card.ventana && p
  && card.ventana.beats === p.beats && card.ventana.total === p.total && card.ventana.pct === p.beat_rate_pct;

// ═══════════════════ 1. tarjeta = panel ═══════════════════
console.log('1. la tarjeta y el panel dan el MISMO beat rate (punto 5)');
{
  instalaFetch();
  const card = await tarjeta();
  const p = await panel();
  ok(card.ventana.beats === 15 && card.ventana.total === 20, 'el fixture da 15 de 20 en la tarjeta', card.ventana);
  ok(p.source === 'pead_earnings' && p.fallback === false, 'el panel lee pead_earnings, no Finnhub', p.source);
  ok(mismoBeatRate(card, p), 'tarjeta y panel: mismos beats, mismo total, mismo %',
    { tarjeta: card.ventana, panel: { beats: p.beats, total: p.total, pct: p.beat_rate_pct } });
  ok(p.median_surprise_pct === card.sorpresa.mediana_pct, 'y la misma sorpresa mediana');
  // El row-a-row también: el panel no puede marcar MISS donde la tarjeta marca ✓.
  const filasCard = card.ultimos.map((u) => u.fecha + ':' + u.beat).join(',');
  const filasPanel = p.history.map((h) => h.report_date + ':' + h.beat).join(',');
  ok(filasCard === filasPanel, 'trimestre a trimestre, mismo BEAT/MISS en la misma fecha de reporte', { filasCard, filasPanel });

  // CONTROL: la comparación MUERDE. El panel viejo (Finnhub) sobre el mismo
  // ticker da otro número, y `mismoBeatRate` lo detecta.
  const viejo = historiaDesdeFinnhub({ simbolo: 'NFLX', quarters: FINNHUB_EPS });
  ok(viejo.beats === 0 && !mismoBeatRate(card, viejo),
    'control: con Finnhub (0 de 8) el test FALLARÍA — la comparación detecta la contradicción', viejo.beats);
  ok(p.contraste_finnhub && p.contraste_finnhub.beats === 0 && p.contraste_finnhub.trimestres === 4,
    'la diferencia con Finnhub queda a la vista como contraste, no como titular', p.contraste_finnhub);
  ok(p.consistencia && p.consistencia.ok === true, 'con datos sanos, la consistencia da ok', p.consistencia);
}

// ═══════════════════ 2. el diagnóstico, reproducido ═══════════════════
console.log('2a. reacción: desde la FECHA DE REPORTE, no desde el cierre fiscal');
{
  const e = EVENTOS[0];
  const desdeReporte = reaccionAlReporte(PRECIOS, e.reporte, 'amc');
  const desdeCierre = reaccionAlReporte(PRECIOS, e.fiscal, 'amc');
  ok(desdeReporte && Math.abs(desdeReporte.pct - 8) < 0.01, 'AMC: cierre del reporte → cierre siguiente = el salto real', desdeReporte);
  ok(desdeCierre && Math.abs(desdeCierre.pct) < 0.5, 'desde el cierre fiscal (el bug) sale un día cualquiera', desdeCierre);
  const bmo = reaccionAlReporte(PRECIOS, iso(Date.parse(e.reporte) + DIA), 'bmo');
  ok(bmo && Math.abs(bmo.pct - 8) < 0.01, 'BMO: cierre previo → cierre del día', bmo);
  ok(reaccionAlReporte(PRECIOS, iso(HOY - 2000 * DIA), 'amc') === null, 'sin precios alrededor del reporte → null, no un número');

  instalaFetch();
  const p = await panel();
  ok(p.history.every((h) => h.report_date && h.stock_reaction_pct !== null && Math.abs(h.stock_reaction_pct - 8) < 0.01),
    'el panel mide cada reacción desde su reporte', p.history.map((h) => h.stock_reaction_pct));
  ok(p.avg_abs_stock_reaction_pct > 7.9, 'el promedio absoluto refleja los saltos reales', p.avg_abs_stock_reaction_pct);
}

console.log('2b. revenue: el trimestre, no el acumulado fiscal; y nunca CostOfRevenue');
{
  const rep = (ini, fin, valor, extra = []) => ({ startDate: ini + ' 00:00:00', endDate: fin + ' 00:00:00',
    report: { ic: [...extra, { concept: 'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax', value: valor }] } });
  const costo = [{ concept: 'us-gaap_CostOfRevenue', value: 5e9 }];
  // Las cifras REALES de NFLX: 10.543 + 11.079 + 11.510 = 33.132 (el "$33.13B").
  const reports = [
    rep('2025-01-01', '2025-03-31', 10.543e9, costo),
    rep('2025-01-01', '2025-06-30', 21.622e9, costo),
    rep('2025-01-01', '2025-09-30', 33.132e9, costo),
    rep('2026-01-01', '2026-03-31', 12.25e9, costo),
    rep('2026-01-01', '2026-06-30', 24.81e9, costo),
  ];
  const q = revenueTrimestral(reports);
  const de = (fin) => (q.find((x) => x.endDate === fin) || {}).revenue;
  ok(Math.abs(de('2025-09-30') - 11.51e9) < 1e6, 'el "$33.13B" era el acumulado de 9 meses: el trimestre es $11.51B', de('2025-09-30'));
  ok(Math.abs(de('2026-06-30') - 12.56e9) < 1e6, 'el "$24.81B" era el semestre: el trimestre es $12.56B', de('2026-06-30'));
  ok(q.every((x) => x.revenue !== 5e9), 'CostOfRevenue nunca se toma por revenue');
  // Un 10-Q que ya viene en 3 meses se usa tal cual.
  const tres = revenueTrimestral([rep('2026-04-01', '2026-06-30', 12.56e9)]);
  ok(tres.length === 1 && tres[0].revenue === 12.56e9 && tres[0].base === '3 meses', 'un valor de 3 meses no se toca');
  // Acumulado SIN el acumulado anterior: no se adivina.
  const huerfano = revenueTrimestral([rep('2026-01-01', '2026-06-30', 24.81e9)]);
  ok(huerfano.length === 0, 'acumulado sin su anterior → sin revenue, no el YTD');
  const sinInicio = revenueTrimestral([{ endDate: '2026-06-30', report: { ic: [{ concept: 'Revenues', value: 24.81e9 }] } }]);
  ok(sinInicio.length === 0, 'sin startDate no se sabe qué periodo cubre → sin revenue');
}

console.log('2c. el panel viejo SE PUEDE reconocer como inconsistente');
{
  const roto = { total: 4, beats: 0, fallback: true, history: [
    { period: '2026-06-30', report_date: null, eps_estimate: 0.8, eps_actual: 0.8, beat: false, stock_reaction_pct: 1.2, revenue_actual: 24.81e9 },
    { period: '2026-03-31', report_date: null, eps_estimate: 0.7, eps_actual: 0.7, beat: false, stock_reaction_pct: 0.4, revenue_actual: 12.25e9 },
    { period: '2025-12-31', report_date: null, eps_estimate: 0.6, eps_actual: 0.6, beat: false, stock_reaction_pct: -0.3, revenue_actual: 12.05e9 },
    { period: '2025-09-30', report_date: null, eps_estimate: 0.6, eps_actual: 0.6, beat: false, stock_reaction_pct: 2.0, revenue_actual: 33.13e9 },
  ] };
  const c = evaluaConsistencia(roto);
  const codigos = c.problemas.map((x) => x.codigo);
  ok(c.ok === false, 'los datos del panel viejo de NFLX NO pasan la consistencia', c);
  ok(codigos.includes('revenue_fuera_de_escala'), 'el revenue al doble se marca', codigos);
  ok(codigos.includes('reaccion_sin_fecha_de_reporte'), 'la reacción sin fecha de reporte se marca', codigos);
  ok(codigos.includes('fuente_de_respaldo') && !c.problemas.find((x) => x.codigo === 'fuente_de_respaldo').bloquea,
    'el respaldo se avisa pero, solo, no bloquea');
  const vacio = evaluaConsistencia({ total: 0, history: [] });
  ok(vacio.ok === false && vacio.problemas[0].codigo === 'sin_trimestres', 'sin trimestres → no hay veredicto');
}

// ═══════════════════ 3. Finnhub solo de respaldo ═══════════════════
console.log('3. símbolo fuera de Neon → Finnhub, ETIQUETADO');
{
  instalaFetch({ neon: false });
  const p = await panel();
  ok(p.source === 'finnhub' && p.fallback === true, 'Neon caído → respaldo Finnhub, marcado', { source: p.source, fallback: p.fallback });
  ok(/pead_earnings no disponible/.test(p.fallback_reason || ''), 'con el motivo del respaldo', p.fallback_reason);
  ok(p.history.every((h) => h.stock_reaction_pct === null && h.report_date === null),
    'sin fecha de reporte, NO se mide reacción desde el cierre fiscal', p.history.map((h) => h.stock_reaction_pct));
  ok(p.consistencia.problemas.some((x) => x.codigo === 'fuente_de_respaldo'), 'la consistencia lo avisa');

  // Con el calendario pasado de Finnhub, la fecha de reporte aparece y la reacción también.
  const cal = FINNHUB_EPS.map((q, i) => ({ symbol: 'NFLX', year: q.year, quarter: q.quarter, date: EVENTOS[i].reporte, hour: 'amc', revenueActual: 12e9 }));
  instalaFetch({ neon: false, calendarioPasado: cal });
  const p2 = await panel();
  ok(p2.history.every((h) => h.report_date && Math.abs(h.stock_reaction_pct - 8) < 0.01),
    'con fecha de reporte del calendario, la reacción del respaldo es la real', p2.history.map((h) => h.stock_reaction_pct));
  ok(p2.history.every((h) => h.revenue_actual === 12e9 && /calendar/.test(h.revenue_basis)),
    'y el revenue sale del calendario (trimestre), con su base dicha');
}

// ═══════════════════ 4. IMPLIED MOVE real ═══════════════════
console.log('4a. implied move: straddle ATM de la expiración que contiene el reporte');
{
  const ep = (d) => Date.parse(d + 'T00:00:00Z') / 1000;
  const rep = iso(HOY);
  const mismoDia = ep(rep), viernes = ep(iso(HOY + 3 * DIA)), lejos = ep(iso(HOY + 30 * DIA));
  ok(eligeExpiracion([mismoDia, viernes], rep, 'amc').epoch === viernes, 'AMC: la expiración del mismo día NO contiene el reporte');
  ok(eligeExpiracion([mismoDia, viernes], rep, 'bmo').epoch === mismoDia, 'BMO: la del mismo día sí');
  ok(eligeExpiracion([mismoDia, viernes], rep, null).epoch === viernes, 'sin hora: se asume después del cierre');
  const lejana = eligeExpiracion([lejos], rep, 'amc');
  ok(lejana.epoch === null && /30 días/.test(lejana.motivo), 'expiración a 30 días → null con motivo, no un número', lejana);

  const s = straddleAtm(
    [{ strike: 1200, bid: 60, ask: 62 }, { strike: 1250, bid: 40, ask: 42 }],
    [{ strike: 1200, bid: 54, ask: 56 }, { strike: 1250, bid: 80, ask: 82 }], 1210);
  ok(s.strike === 1200 && s.straddle === 116 && s.implied_move_pct === 9.6 && s.base_precio === 'mid',
    'straddle ATM: (61 + 55) / 1210 = ±9.6%', s);
  ok(straddleAtm([{ strike: 1200 }], [{ strike: 1200 }], 1210).implied_move_pct === null, 'sin precios → null');
  ok(straddleAtm([], [], 0).implied_move_pct === null, 'sin spot → null');

  // Handler: el front expiry vence el día del reporte (AMC) → pide ?date= de la siguiente.
  const pedidas = [];
  global.fetch = async (url) => {
    const u = String(url); pedidas.push(u);
    const conFecha = /\?date=(\d+)/.exec(u);
    const exp = conFecha ? Number(conFecha[1]) : mismoDia;
    const chain = exp === viernes
      ? { expirationDate: viernes, calls: [{ strike: 1200, bid: 60, ask: 62 }], puts: [{ strike: 1200, bid: 54, ask: 56 }] }
      : { expirationDate: mismoDia, calls: [{ strike: 1200, bid: 5, ask: 6 }], puts: [{ strike: 1200, bid: 5, ask: 6 }] };
    return jsonResponse({ optionChain: { result: [{ expirationDates: [mismoDia, viernes], quote: { regularMarketPrice: 1210 }, options: [chain] }] } });
  };
  const r = mockRes();
  await optionsHandler({ method: 'GET', query: { ticker: 'NFLX', reporte: rep, hora: 'amc' } }, r);
  ok(r.body.available === true && r.body.implied_move_pct === 9.6 && r.body.expiration === iso(HOY + 3 * DIA),
    'el endpoint usa la expiración posterior al reporte, no el front', r.body);
  ok(pedidas.some((u) => u.includes('?date=' + viernes)), 'y la pidió por fecha');
}

console.log('4b. LINT anti-pronóstico: el IMPLIED MOVE no sale del LLM');
const app = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
{
  const i = app.indexOf('async function runEarningsIntel(');
  const intel = app.slice(i, app.indexOf('\n}\n', i));
  ok(i > 0 && intel.length > 200, 'runEarningsIntel existe');
  const prompt = intel.slice(intel.indexOf('const claudePrompt'), intel.indexOf('const aiText'));
  ok(prompt.length > 100, 'se encuentra el prompt de la tab');
  ok(!/implied[_ ]?move/i.test(prompt.replace(/Options-implied move[^`]*`/g, '')),
    'el prompt NO le pide al LLM un implied move (solo le informa el real)');
  ok(!/\d+\s*-\s*\d+%\s*based on sector vol/i.test(app), 'ni la vieja instrucción "3-10% based on sector vol"');
  // En TODO app.html: ningún JSON pedido a un LLM trae un campo implied_move.
  ok(!/"implied_move[a-z_]*"\s*:\s*N/i.test(app), 'ningún prompt de app.html pide "implied_move…": N');
  ok(!/analysis\.[\w.]*implied/i.test(app), 'ningún implied move se lee de la respuesta de la IA');
  ok(!/IMPLIED MOVE[^']{0,80}· AI/.test(app), 'ningún "IMPLIED MOVE · AI" en pantalla');
  // Un solo renderer, y su fuente es la cadena de opciones.
  const iIm = app.indexOf('function impliedMoveHTML(');
  const imFn = app.slice(iIm, app.indexOf('\n}\n', iIm));
  const fuera = app.slice(0, iIm) + app.slice(iIm + imFn.length);
  ok(iIm > 0 && /IMPLIED MOVE/.test(imFn) && !/IMPLIED MOVE/.test(fuera.replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')),
    'el rótulo IMPLIED MOVE solo se pinta desde impliedMoveHTML');
  ok(/im\.implied_move_pct/.test(imFn) && /'—'|>—</.test(imFn), 'y pinta el número de /api/options, o "—"');
  ok(/\/api\/options\?ticker=[^\n]*reporte=/.test(app), 'el número sale de /api/options?reporte=');
  ok(/fetchImpliedMove\(ticker, realNext\)/.test(intel), 'runEarningsIntel lo pide a la cadena de opciones');
}

// ═══════════════════ 5. veredicto fail-closed ═══════════════════
console.log('5. veredicto: datos inconsistentes → no se llama a la IA');
{
  const i = app.indexOf('async function runEarningsIntel(');
  const intel = app.slice(i, app.indexOf('\n}\n', i));
  const iGate = intel.indexOf('if(!cons.ok)');
  const iAI = intel.indexOf('qdAI(');
  ok(iGate > 0 && iAI > iGate, 'la compuerta de consistencia va ANTES de la llamada a la IA', { iGate, iAI });
  ok(/renderEarningsVerdictBlocked\(cons, inputs, ticker\);\s*return;/.test(intel), 'y si no pasa, se pinta el bloqueo y se sale');
  ok(/hist\.consistencia \|\| \{ ok:false/.test(intel), 'sin `consistencia` del endpoint, también se bloquea (fail-closed)');
  const iBl = app.indexOf('function renderEarningsVerdictBlocked(');
  const bl = app.slice(iBl, app.indexOf('\n}\n', iBl));
  ok(/earningsInputsHTML\(inputs, cons\)/.test(bl), 'el bloqueo muestra qué datos recibió y qué falló');
  ok(/earningsInputsHTML\(inputs, cons\)/.test(app.slice(app.indexOf('function renderEarningsVerdict('))),
    'y el veredicto normal también muestra sus datos de entrada');
  ok(!/historical_beat_rate\s*=\s*hist\.beat_rate_pct/.test(app), 'el beat rate ya no se inyecta suelto en el veredicto');
}

// ═══════════════════ lint: una sola consulta ═══════════════════
console.log('lint: tarjeta y panel comparten consulta y función');
{
  const eb = readFileSync(new URL('../api/earnings-beat.js', import.meta.url), 'utf8');
  const iLive = eb.indexOf('async function vistaLive(');
  const live = eb.slice(iLive, eb.indexOf('\nasync function ', iLive + 10));
  ok(/await leeHistoricoPead\(simbolos\)/.test(live), 'la tarjeta lee con leeHistoricoPead');
  ok(/historico\[s\] = estadisticasHistoricas\(porSimbolo\.get\(s\) \|\| \[\]\)/.test(live), 'y cuenta con estadisticasHistoricas');
  ok(!/from pead_earnings/.test(live), 'sin un SELECT propio que pueda divergir');
  const er = readFileSync(new URL('../api/earnings.js', import.meta.url), 'utf8');
  ok(/leeHistoricoPead\(\[sym\]\)/.test(er) && /historiaDesdePead\(/.test(er), 'el panel lee con la misma función');
  const lib = readFileSync(new URL('../api/_lib/historial-pead.js', import.meta.url), 'utf8');
  ok(/const stats = estadisticasHistoricas\(filas\)/.test(lib), 'y cuenta con la misma función que la tarjeta');
}

console.log(failures ? `\n${failures} FALLA(S)` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
