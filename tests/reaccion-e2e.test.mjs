// ═══════════════════════════════════════════════════════════════
// Tests de /api/reaccion-analyze de punta a punta. TODA la red simulada:
// Neon, Yahoo, FMP, Finnhub, Alpha Vantage y EDGAR.
//
//   1. SOLO LECTURA en Neon, y gate antes que cualquier red.
//   2. La unidad es el REPORTE: dos mercados del mismo reporte cuentan una vez.
//   3. Los 402 se clasifican por el CUERPO: `period` es parámetro de pago,
//      `symbol` es empresa fuera del plan; ninguno es "auth".
//   4. La regla de estimados se aplica a la forma CRUDA, y `lastUpdated` no
//      convierte a FMP en point-in-time.
//   5. La elección de fuente sigue la regla congelada (mayor cobertura), y
//      nunca mezcla.
//   6. AV se sondea con UN símbolo: la cuota es del PEAD.
//   7. La guía devuelve el párrafo crudo y NO entra al análisis.
//   8. La Fase 1 aplica la regla del 50% en el código.
//   9. Ninguna URL publicada lleva una key; el código no llama a ningún LLM.
//
// Correr con `node tests/reaccion-e2e.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.text = s; return this; },
    end() { return this; } };
}
const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;
process.env.FMP_API_KEY = 'fmp-key-de-test';
process.env.FINNHUB_API_KEY = 'finnhub-key-de-test';
process.env.ALPHAVANTAGE_API_KEY = 'av-key-de-test';
process.env.SEC_REQ_POR_SEGUNDO = '10';   // el techo de la SEC: el test no tiene por qué ir más lento
process.env.REACCION_FINNHUB_PAUSA_MS = '0';  // la red es simulada: la pausa de 60/min no aplica

const { default: handler } = await import('../api/reaccion-analyze.js');
const { FMP_402_PERIOD, FMP_402_SYMBOL } = await import('./fixtures/fmp-402-reales.mjs');

// ═══════════════════ fixture ═══════════════════
// 6 empresas × 20 reportes trimestrales = 120 reportes. NKE va adentro porque
// es el caso que motiva el experimento (y la guía la lee primero).
const SIMS = ['AAPL', 'KO', 'MSFT', 'NKE', 'PEP', 'XOM'];
const CIK = { AAPL: 320193, KO: 21344, MSFT: 789019, NKE: 320187, PEP: 77476, XOM: 34088 };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Calendario hábil (sin feriados): es el de SPY, consistente entre símbolos.
function habiles(desde, hasta) {
  const out = [];
  const d = new Date(desde + 'T00:00:00Z'), fin = new Date(hasta + 'T00:00:00Z');
  while (d <= fin) { const w = d.getUTCDay(); if (w && w !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const CAL = habiles('2021-01-01', '2026-09-30');

function fabrica() {
  const r = rng(11);
  const reportes = [];
  for (const s of SIMS) {
    for (let k = 0; k < 20; k++) {
      // Un reporte por trimestre, un día hábil a mitad de mes.
      const anio = 2021 + Math.floor(k / 4), mes = [2, 5, 8, 11][k % 4];
      const fecha = CAL.find((f) => f >= `${anio}-${String(mes).padStart(2, '0')}-15`);
      const finPeriodo = `${anio}-${String(mes - 1).padStart(2, '0')}-${mes - 1 === 2 ? '28' : '30'}`;
      const est = 1 + r(), sorpresa = (r() - 0.4) * 0.3;
      reportes.push({ symbol: s, report_date: fecha, fiscal_date_ending: finPeriodo,
        reported_eps: +(est * (1 + sorpresa)).toFixed(4), estimated_eps: +est.toFixed(4),
        rev_est: 10e9 + r() * 1e9, rev_surpr: (r() - 0.5) * 0.06, sorpresa });
    }
  }
  return reportes;
}
const REPORTES = fabrica();

// Series de precios: la acción salta en la ventana del reporte según la sorpresa.
function serie(sym) {
  const r = rng(sym.length * 97 + sym.charCodeAt(0));
  let p = 100;
  const ts = [], open = [], close = [];
  const saltos = new Map(REPORTES.filter((x) => x.symbol === sym).map((x) => [x.report_date, x.sorpresa]));
  for (const f of CAL) {
    const o = p * (1 + (r() - 0.5) * 0.01);
    let c = o * (1 + (r() - 0.5) * 0.01);
    if (saltos.has(f)) c *= 1 + saltos.get(f) * 0.5;   // la reacción plantada
    ts.push(Date.parse(f + 'T14:30:00Z') / 1000); open.push(o); close.push(c); p = c;
  }
  return { ts, open, close };
}
function chart(sym) {
  const s = sym === 'SPY' ? (() => { const ts = [], o = [], c = []; let p = 400; for (const f of CAL) { ts.push(Date.parse(f + 'T14:30:00Z') / 1000); o.push(p); p *= 1.0002; c.push(p); } return { ts, open: o, close: c }; })() : serie(sym);
  return { chart: { result: [{ timestamp: s.ts, indicators: { quote: [{ open: s.open, close: s.close }], adjclose: [{ adjclose: s.close }] } }] } };
}

// ═══════════════════ el router de red ═══════════════════
let queries = [], pedidos = [];
function resp(status, cuerpo, ct = 'application/json') {
  const texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  return { ok: status >= 200 && status < 300, status, text: async () => texto, json: async () => JSON.parse(texto),
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? ct : null) } };
}
const NUM = 1700, TXT = 25;
function neon(q, opciones) {
  if (/from pm_earnings_markets/i.test(q)) {
    const campos = [['symbol', TXT], ['report_date', TXT], ['fiscal_date_ending', TXT], ['reported_eps', NUM], ['estimated_eps', NUM]];
    // DOS mercados para el primer reporte: tiene que contar UNA vez.
    const filas = [REPORTES[0], ...REPORTES];
    return resp(200, { fields: campos.map(([name, dataTypeID]) => ({ name, dataTypeID })),
      rows: filas.map((f) => campos.map(([k]) => (f[k] === undefined ? null : String(f[k])))) });
  }
  if (/from pead_event_hour/i.test(q)) {
    if (opciones.sinTablaHora) return resp(400, { message: 'relation "pead_event_hour" does not exist' });
    return resp(200, { fields: [{ name: 'symbol', dataTypeID: TXT }, { name: 'reported_date', dataTypeID: TXT }, { name: 'hour', dataTypeID: TXT }],
      rows: REPORTES.slice(0, 40).map((f) => [f.symbol, f.report_date, 'amc']) });
  }
  throw new Error('query inesperada: ' + q);
}
const EX991 = (sym) => `<html><body><p>${sym} Reports Results</p>
<p>Revenues were $11.4 billion, down 1 percent.</p>
<p>For the second quarter of fiscal 2027, the company expects revenues to be down mid-single digits.</p>
<p>The Company now sees full-year fiscal 2027 revenue of $45.0 billion to $46.0 billion.</p>
<p>Statements that the company expects revenues and earnings to grow are forward-looking statements within the meaning of the Private Securities Litigation Reform Act.</p></body></html>`;

function mockFetch(opciones = {}) {
  queries = []; pedidos = [];
  return async (url, init) => {
    const u = String(url);
    pedidos.push(u);
    if (u.includes('/sql')) {
      const body = JSON.parse(init.body);
      const q = (body.queries ? body.queries[0] : body).query;
      queries.push(q);
      return neon(q, opciones);
    }
    if (u.includes('query1.finance.yahoo.com')) {
      const sym = decodeURIComponent(u.split('/chart/')[1].split('?')[0]);
      if (opciones.sinYahoo && sym !== 'SPY' && opciones.sinYahoo.includes(sym)) return resp(404, 'not found');
      return resp(200, chart(sym));
    }
    if (u.includes('financialmodelingprep.com/stable/analyst-estimates')) {
      // El 402 REAL de FMP por `period=quarter` (fixture verbatim): "Special Endpoint".
      return resp(402, FMP_402_PERIOD);   // la respuesta REAL, verbatim
    }
    if (u.includes('financialmodelingprep.com/stable/earnings')) {
      const sym = decodeURIComponent((u.match(/symbol=([^&]+)/) || [])[1]);
      if ((opciones.fmpBloqueados || ['KO', 'PEP', 'XOM']).includes(sym)) {
        return resp(402, FMP_402_SYMBOL);   // la respuesta REAL, verbatim (cortada como la corta el body_sample)
      }
      return resp(200, REPORTES.filter((x) => x.symbol === sym).map((x) => ({
        symbol: sym, date: x.report_date, epsActual: x.reported_eps, epsEstimated: x.estimated_eps,
        revenueActual: x.rev_est * (1 + x.rev_surpr), revenueEstimated: x.rev_est,
        // `lastUpdated` POSTERIOR al reporte: no convierte a FMP en PIT.
        lastUpdated: CAL[CAL.indexOf(x.report_date) + 1] })));
    }
    if (u.includes('finnhub.io/api/v1/calendar/earnings')) {
      const sym = decodeURIComponent((u.match(/symbol=([^&]+)/) || [])[1]);
      if (opciones.finnhubCaido) return resp(401, { error: 'Invalid API key.' });
      const lista = REPORTES.filter((x) => x.symbol === sym && (!opciones.finnhubParcial || opciones.finnhubParcial.includes(sym)))
        .map((x) => ({ date: x.report_date, epsActual: x.reported_eps, epsEstimate: x.estimated_eps, hour: 'amc', quarter: 1,
          revenueActual: x.rev_est * (1 + x.rev_surpr), revenueEstimate: x.rev_est, symbol: sym, year: 2026 }));
      return resp(200, { earningsCalendar: lista });
    }
    if (u.includes('alphavantage.co')) {
      // La trampa de AV: 200 con {"Note"}.
      return resp(200, { Note: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' });
    }
    if (u.includes('sec.gov/files/company_tickers.json')) {
      return resp(200, Object.fromEntries(SIMS.map((s, i) => [String(i), { cik_str: CIK[s], ticker: s, title: s + ' Inc' }])));
    }
    if (u.includes('data.sec.gov/api/xbrl/companyconcept')) {
      // El primer tag no existe (404): se prueba el siguiente.
      if (u.includes('RevenueFromContractWithCustomerExcludingAssessedTax')) return resp(404, 'not found');
      if (!u.includes('/Revenues.json')) return resp(404, 'not found');
      const cik = Number((u.match(/CIK(\d+)/) || [])[1]);
      const sym = SIMS.find((s) => CIK[s] === cik);
      const facts = REPORTES.filter((x) => x.symbol === sym).map((x) => {
        const fin = x.fiscal_date_ending;
        const ini = new Date(fin + 'T00:00:00Z'); ini.setUTCDate(ini.getUTCDate() - 89);
        return { start: ini.toISOString().slice(0, 10), end: fin, val: x.rev_est * (1 + x.rev_surpr), form: '10-Q', filed: x.report_date };
      });
      return resp(200, { cik, taxonomy: 'us-gaap', tag: 'Revenues', units: { USD: facts } });
    }
    if (u.includes('data.sec.gov/submissions/')) {
      const filas = [];
      for (let k = 0; k < 6; k++) filas.push({ form: '8-K', items: '2.02,9.01', filingDate: `2026-0${k + 1}-20`, acceptanceDateTime: `2026-0${k + 1}-20T16:05:00.000Z`, accessionNumber: `0000000000-26-00000${k}`, primaryDocument: 'form8k.htm' });
      filas.push({ form: '10-Q', items: '', filingDate: '2026-02-01', acceptanceDateTime: '', accessionNumber: '0000000000-26-999999', primaryDocument: 'q.htm' });
      const col = (k) => filas.map((f) => f[k]);
      return resp(200, { filings: { recent: { form: col('form'), items: col('items'), filingDate: col('filingDate'),
        acceptanceDateTime: col('acceptanceDateTime'), accessionNumber: col('accessionNumber'), primaryDocument: col('primaryDocument') }, files: [] } });
    }
    if (u.includes('/Archives/edgar/data/') && u.endsWith('index.json')) {
      return resp(200, { directory: { item: [{ name: 'form8k.htm', size: 20000 }, { name: 'ex991.htm', size: 80000 }, { name: 'logo.jpg', size: 3000 }] } });
    }
    if (u.includes('/Archives/edgar/data/') && u.endsWith('ex991.htm')) {
      const cik = Number((u.match(/data\/(\d+)\//) || [])[1]);
      return resp(200, EX991(SIMS.find((s) => CIK[s] === cik) || '?'), 'text/html');
    }
    return resp(404, 'ruta no simulada: ' + u);
  };
}

// ═══════════════════ 1. gate ═══════════════════
console.log('reaccion-analyze: gate del CRON_SECRET');
{
  global.fetch = mockFetch();
  const r = mockRes();
  await handler(GET({ fase: '0' }), r);
  ok(r.code === 401, 'sin secret → 401', r.code);
  ok(pedidos.length === 0, 'un 401 no toca NINGUNA red (ni Neon, ni Yahoo, ni FMP, ni EDGAR)', pedidos.length);
  const f1 = mockRes();
  await handler(GET({ fase: '1' }), f1);
  ok(f1.code === 401, 'la Fase 1 tampoco es una puerta lateral');
}

// ═══════════════════ 2. censo, frente PRECIOS ═══════════════════
console.log('FASE 0 · precios, y la unidad es el REPORTE');
let censoP;
{
  global.fetch = mockFetch();
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'precios' }), r);
  censoP = r.body;
  ok(r.code === 200 && censoP.fase === 0 && censoP.frente === 'precios', 'el censo de precios responde', r.code);
  ok(censoP.eventos.mercados === 121 && censoP.eventos.total === 120,
    'dos mercados del mismo reporte cuentan UNA vez: 121 mercados → 120 reportes', `${censoP.eventos.mercados} → ${censoP.eventos.total}`);
  ok(/cuentan una vez/.test(censoP.eventos.nota_unidad), 'y se dice por qué');
  const p = censoP.frentes.precios;
  ok(p.con_retorno === 120 && p.cobertura === 1 && p.entra === true, 'las 120 ventanas completas: el frente entra', `${p.con_retorno} ${p.cobertura}`);
  ok(p.series.spy === true && p.series.ok === SIMS.length, 'SPY y las seis series bajaron');
  ok(p.con_hora === 40, 'la hora (BMO/AMC) se cuenta, aunque no entra a la variable', p.con_hora);
  ok(!censoP.frentes.ingresos && !censoP.frentes.guia, 'con `frente=precios` no se toca ningún otro frente');
  ok(!pedidos.some((u) => /financialmodelingprep|finnhub|alphavantage|sec\.gov/.test(u)),
    'ni se gasta cuota en otras fuentes');
  // SOLO LECTURA.
  ok(queries.length > 0 && queries.every((q) => /^\s*select/i.test(q.trim())), 'TODAS las queries son SELECT', JSON.stringify(queries));
  ok(!queries.some((q) => /cron_heartbeat|insert into|create table|update |delete from/i.test(q)), 'ni heartbeat ni escrituras');
  ok(censoP.eventos.con_eps === 120, 'la señal A sale de pead_earnings', censoP.eventos.con_eps);
  // La SENSIBILIDAD se cuenta ya en el censo: 40 reportes con hora AMC.
  ok(p.sensibilidad && p.sensibilidad.con_salto === 40 && p.sensibilidad.de === 120,
    'el censo cuenta cuántos eventos permiten la sensibilidad del salto nocturno', JSON.stringify(p.sensibilidad && { c: p.sensibilidad.con_salto, d: p.sensibilidad.de }));
  ok(p.sensibilidad.alcanza_el_candado === false, 'y dice que con 40 NO alcanza el candado de 100 — antes de ver ningún resultado');
  ok(p.sensibilidad.descartes.sin_hora === 80, 'los demás caen por no tener hora', JSON.stringify(p.sensibilidad.descartes));
  ok(/no reemplaza a la principal/.test(p.sensibilidad.rol), 'con su rol dicho');

  // Una serie que falta se DECLARA con su motivo.
  global.fetch = mockFetch({ sinYahoo: ['XOM'] });
  const sin = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'precios' }), sin);
  ok(sin.body.frentes.precios.simbolos_sin_serie.includes('XOM'), 'un símbolo sin serie de Yahoo se nombra');
  ok(sin.body.frentes.precios.descartes.sin_serie_accion === 20, 'y sus 20 reportes caen con motivo', JSON.stringify(sin.body.frentes.precios.descartes));

  // Sin la tabla de horas, el censo no se cae.
  global.fetch = mockFetch({ sinTablaHora: true });
  const sh = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'precios' }), sh);
  ok(sh.code === 200 && typeof sh.body.frentes.precios.error_hora === 'string', 'sin pead_event_hour responde igual, y DECLARA el error');
}

// ═══════════════════ 3. censo, frente INGRESOS ═══════════════════
console.log('FASE 0 · ingresos: los 402 por el CUERPO, la forma CRUDA, la regla de elección');
let censoI;
{
  global.fetch = mockFetch();
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'ingresos' }), r);
  censoI = r.body;
  ok(r.code === 200, 'el censo de ingresos responde', r.code);
  const x = censoI.frentes.ingresos;
  const sondas = x.estimados.sondas;

  // FMP analyst-estimates trimestral: CONFIRMADO de pago, por el cuerpo.
  const ae = sondas.find((s) => /analyst-estimates/.test(s.fuente));
  ok(ae && ae.status === 402 && ae.motivo === 'parametro_de_pago' && ae.parametro === 'period',
    'FMP analyst-estimates period=quarter: 402 por el PARÁMETRO `period`, confirmado — no asumido', JSON.stringify(ae && { s: ae.status, m: ae.motivo, p: ae.parametro }));
  ok(!/auth/.test(ae.motivo) && !/rotar/.test(ae.detalle || ''), 'y NO se dice auth ni se manda a tocar la key');
  ok(/No es la key/.test(ae.detalle), 'se dice explícitamente que no es la key', ae.detalle);
  // Con la respuesta REAL: FMP lo etiqueta "Special Endpoint" — un valor de pago,
  // no un rango. Es lo que separa `period` de `limit` ("Special Parameters").
  ok(/Special Endpoint/.test(ae.detalle) && /función de pago/.test(ae.detalle),
    'y con la respuesta real, el detalle cita la etiqueta de FMP: es un valor de pago, no un rango', ae.detalle);

  // AV: UNA llamada, y la trampa del 200 con Note detectada.
  const av = sondas.find((s) => /Alpha Vantage/.test(s.fuente));
  ok(av && av.motivo === 'rate_limit_av', 'AV: el 200 con {"Note"} se detecta como límite, no como "sin datos"', av && av.motivo);
  ok(pedidos.filter((u) => u.includes('alphavantage.co')).length === 1, 'AV se llamó UNA vez: la cuota es del PEAD');
  ok(/cuota de Alpha Vantage/.test(av.nota_cuota), 'y se dice por qué');

  // FMP earnings: 3 de 6 empresas fuera del plan; la forma es "del evento", NO PIT.
  const fe = x.estimados.cobertura_por_fuente.find((c) => c.fuente === 'FMP earnings');
  ok(fe.clase === 'estimado_del_evento', 'FMP earnings con `lastUpdated` posterior: estimado del evento, NO point-in-time', fe.clase);
  ok(fe.simbolos_sin_acceso.sort().join(',') === 'KO,PEP,XOM', 'las empresas fuera del plan se nombran', fe.simbolos_sin_acceso.join(','));
  ok(fe.cobertura === 0.5, 'FMP cubre la mitad de los reportes', fe.cobertura);
  const feSonda = sondas.find((s) => s.fuente === 'FMP earnings');
  ok(/sin_acceso_al_simbolo: 3/.test(feSonda.detalle), 'el barrido dice cuántas fallaron y por qué', feSonda.detalle);

  // Finnhub: cubre todo → gana por la regla congelada.
  const fh = x.estimados.cobertura_por_fuente.find((c) => c.fuente === 'Finnhub calendar/earnings');
  ok(fh.clase === 'estimado_del_evento' && fh.cobertura === 1, 'Finnhub: estimado del evento, 100%', `${fh.clase} ${fh.cobertura}`);
  ok(x.estimados.elegida === 'Finnhub calendar/earnings', 'se elige la de MAYOR cobertura, por la regla congelada', x.estimados.elegida);
  ok(/nunca mezclar/.test(x.estimados.porque_eleccion), 'y la elección cita la regla — incluida la de no mezclar');
  ok(x.entra === true && /ENTRA con Finnhub/.test(x.porque), 'el frente entra, diciendo con qué fuente', x.porque);

  // EDGAR: el primer tag no existe, se usa el siguiente.
  const rep = x.reportados_edgar;
  ok(rep.simbolos_con_dato === SIMS.length && rep.eventos_con_dato === 120, 'EDGAR: ingreso trimestral de las seis empresas', `${rep.simbolos_con_dato} ${rep.eventos_con_dato}`);
  ok(Object.values(rep.tags_usados).every((t) => t === 'Revenues'), 'un tag que no existe (404) no corta: se prueba el siguiente', JSON.stringify(rep.tags_usados));
  ok(rep.acuerdo_con_fuente && rep.acuerdo_con_fuente.coinciden === rep.acuerdo_con_fuente.comparados && rep.acuerdo_con_fuente.comparados > 0,
    'y la AUDITORÍA: el ingreso real de la fuente elegida coincide con el de EDGAR', JSON.stringify(rep.acuerdo_con_fuente));

  // Ninguna URL publicada lleva una key.
  const json = JSON.stringify(censoI);
  ok(!json.includes('fmp-key-de-test') && !json.includes('finnhub-key-de-test') && !json.includes('av-key-de-test'),
    'NINGUNA key aparece en la respuesta');
  ok(sondas.filter((s) => s.url_sin_key).every((s) => /\*\*\*/.test(s.url_sin_key)), 'las URLs publicadas llevan la key tapada');

  const md = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'ingresos', format: 'md' }), md);
  ok(/Ingresos \(señal B\)/.test(md.text) && /parametro_de_pago/.test(md.text), 'el md del frente de ingresos trae las sondas');
  ok(/Fuente elegida: \*\*Finnhub/.test(md.text), 'y la fuente elegida');
  ok(/Los ingresos REPORTADOS solos no hacen una sorpresa/.test(md.text), 'y por qué EDGAR solo no alcanza');
  ok(!md.text.includes('fmp-key-de-test'), 'el md tampoco filtra keys');

  // Si Finnhub se cae y FMP cubre 50%, entra con FMP (justo en el borde).
  global.fetch = mockFetch({ finnhubCaido: true });
  const caido = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'ingresos' }), caido);
  const fhC = caido.body.frentes.ingresos.estimados.sondas.find((s) => /Finnhub/.test(s.fuente));
  ok(fhC.motivo === 'auth_error', 'un 401 de Finnhub es auth_error, con su nombre', fhC.motivo);
  ok(caido.body.frentes.ingresos.estimados.elegida === 'FMP earnings', 'sin Finnhub, la única que sirve es FMP');
}

// ═══════════════════ 4. censo, frente GUÍA ═══════════════════
console.log('FASE 0 · guía: el párrafo crudo, y NO entra');
{
  global.fetch = mockFetch();
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'guia' }), r);
  const g = r.body.frentes.guia;
  ok(g.simbolos[0].symbol === 'NKE', 'NKE se lee primero: es el caso que motiva el experimento', g.simbolos[0].symbol);
  ok(g.simbolos.length === SIMS.length, 'hasta 10 símbolos — acá hay seis', g.simbolos.length);
  ok(g.simbolos.every((s) => s.filings.length === 4), 'cuatro 8-K Item 2.02 por símbolo, los más recientes', g.simbolos.map((s) => s.filings.length).join(','));
  ok(g.simbolos[0].filings.every((f) => f.exhibit === 'ex991.htm' && f.regla_exhibit === 'nombre_ex99_1'),
    'el Exhibit 99.1 se encuentra por nombre, y se dice qué regla lo encontró');
  const parr = g.simbolos[0].filings[0].parrafos;
  ok(parr.some((p) => /\$45\.0 billion to \$46\.0 billion/.test(p.parrafo)), 'el rango de guía viene TAL CUAL');
  ok(parr.some((p) => p.parece_safe_harbor), 'el safe harbor viene MARCADO, no borrado');
  ok(g.filings_con_guia === g.filings_leidos, 'cada filing tiene al menos un párrafo que no parece safe harbor', `${g.filings_con_guia}/${g.filings_leidos}`);
  ok(g.entra === false && g.cobertura_como_variable === 0, 'la guía NO entra al análisis: como variable, 0%');
  ok(/SIN LLM/.test(g.porque) && /consenso del trimestre siguiente/.test(g.porque),
    'y el porqué nombra las DOS piezas que faltan', g.porque);
  ok(!pedidos.some((u) => /10-Q|q\.htm/.test(u)), 'solo se leen los 8-K con Item 2.02, no los 10-Q');

  const override = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'guia', simbolos_guia: 'msft,ko' }), override);
  ok(override.body.frentes.guia.simbolos.map((s) => s.symbol).join(',') === 'MSFT,KO', '?simbolos_guia= elige a quién leer (es un censo)');

  const md = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', frente: 'guia', format: 'md' }), md);
  ok(/Guía \(señal C\) — \*\*NO ENTRA\*\*/.test(md.text), 'el md dice que no entra');
  ok(/45\.0 billion to \$46\.0 billion/.test(md.text) && /\[parece safe harbor\]/.test(md.text), 'con los párrafos crudos y la marca');
}

// ═══════════════════ 5. FASE 1 ═══════════════════
console.log('FASE 1 · la regla del 50% la aplica el código');
{
  global.fetch = mockFetch();
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '1' }), r);
  const a = r.body;
  ok(r.code === 200 && a.fase === 1 && a.pre_registrado === true, 'la Fase 1 responde, pre-registrada', r.code);
  ok(a.unidad.reportes === 120 && a.unidad.mercados === 121, 'sobre REPORTES, no mercados');
  ok(a.fuente_ingresos.elegida === 'Finnhub calendar/earnings', 'usa la fuente que el censo habría elegido');
  const A = a.senales.find((x) => x.id === 'A'), B = a.senales.find((x) => x.id === 'B'), C = a.senales.find((x) => x.id === 'C');
  ok(A.estado === 'EXPLICA' && A.n === 120, 'A: la reacción plantada en el fixture se detecta', `${A.estado} r=${A.r} n=${A.n}`);
  ok(['EXPLICA', 'NO_EXPLICA'].includes(B.estado) && B.n === 120, 'B entra (Finnhub 100%) y se mide', `${B.estado} n=${B.n}`);
  ok(C.estado === 'NO_ENTRA' && /SIN LLM/.test(C.porque), 'C NO entra, con el motivo fijo', C.estado);
  ok(a.conjunto.senales.join('') === 'AB', 'el conjunto con las que entraron: A y B', a.conjunto.senales.join(''));
  ok(/\(1 no entró\)/.test(a.conjunto.porque), 'y dice cuántas no entraron, en vez de decir "las tres"', a.conjunto.porque);
  ok(a.tres_piezas.estado === 'INCONCLUSO' && /falta la señal C/.test(a.tres_piezas.porque), 'las tres piezas: INCONCLUSO por la C');
  ok(/ocurre de noche/.test(a.advertencias.pead), 'la advertencia del PEAD viaja');
  ok(/sesión COMPLETA/.test(a.advertencias.ventana), 'y la de la ventana');
  ok(/EXPLORATORIO/.test(a.exploratorio.etiqueta) && a.exploratorio.eps.n > 0, 'el exploratorio va aparte');
  ok(!pedidos.some((u) => /analyst-estimates|alphavantage/.test(u)), 'la Fase 1 no repite las sondas caras (AV, analyst-estimates)');
  ok(!pedidos.some((u) => /ex991\.htm|submissions/.test(u)), 'ni lee 8-K: la guía no entra');
  ok(a.detalle_eventos === undefined, 'el detalle por evento no viene por default');
  // LA SENSIBILIDAD: al lado, con su candado propio, sin tocar el veredicto.
  ok(a.ventana_principal === 'cierre(T-1) → apertura(T+1)', 'la respuesta dice cuál es la ventana principal');
  ok(a.sensibilidad && a.sensibilidad.reemplaza_a_la_principal === false && a.sensibilidad.decide_el_veredicto === false,
    'la sensibilidad viaja declarada como tal');
  ok(a.sensibilidad.eventos_con_salto === 40, 'sobre los 40 reportes con hora', a.sensibilidad.eventos_con_salto);
  ok(a.sensibilidad.senales.find((x) => x.id === 'A').estado === 'INCONCLUSO',
    'con 40 eventos, la sensibilidad de A es INCONCLUSO — y la principal sigue siendo EXPLICA', a.sensibilidad.senales.find((x) => x.id === 'A').estado);
  ok(a.sensibilidad.senales.find((x) => x.id === 'C').estado === 'NO_ENTRA', 'C tampoco entra en la sensibilidad');

  // Con Finnhub a medias y FMP con la mitad: B queda bajo 50% → NO ENTRA.
  global.fetch = mockFetch({ finnhubParcial: ['AAPL', 'MSFT'], fmpBloqueados: ['KO', 'PEP', 'XOM', 'NKE'] });
  const parcial = mockRes();
  await handler(GET({ secret: SECRET, fase: '1' }), parcial);
  const Bp = parcial.body.senales.find((x) => x.id === 'B');
  ok(Bp.estado === 'NO_ENTRA', 'con la mejor fuente bajo 50%, B NO ENTRA — lo decide el código', `${Bp.estado} ${Bp.cobertura}`);
  ok(parcial.body.conjunto.senales.join('') === 'A', 'y el conjunto queda solo con A');
  ok(/solo con sorpresa de EPS/.test(parcial.body.conjunto.porque), 'nombrado como tal');

  const md = mockRes();
  await handler(GET({ secret: SECRET, fase: '1', format: 'md' }), md);
  ok(/VEREDICTO:/.test(md.text) && /ocurre de noche/.test(md.text), 'el md abre con el veredicto y la advertencia del PEAD');
  ok(/\| C — /.test(md.text) && /NO ENTRA/.test(md.text), 'con la C marcada como no entra');
  ok(md.text.indexOf('SENSIBILIDAD pre-registrada') > md.text.indexOf('## Cada señal'),
    'y la sensibilidad aparece DESPUÉS de la principal, con su etiqueta');

  const det = mockRes();
  await handler(GET({ secret: SECRET, fase: '1', eventos: '1' }), det);
  ok(Array.isArray(det.body.detalle_eventos) && det.body.detalle_eventos.length === 120, '?eventos=1 trae el detalle');
}

// ═══════════════════ 6. el código, leído ═══════════════════
console.log('el código: sin LLM, sin heartbeat, y con su entrada en vercel.json');
{
  const ep = readFileSync(new URL('../api/reaccion-analyze.js', import.meta.url), 'utf8');
  ok(/: 1100;/.test(ep) && /REACCION_FINNHUB_PAUSA_MS/.test(ep),
    'la pausa de Finnhub en producción es 1100 ms por defecto — el test la apaga por env, no por código');
  const archivos = ['../api/reaccion-analyze.js', '../api/_lib/reaccion.js', '../api/_lib/reaccion-fuentes.js'];
  const sinComentarios = archivos.map((a) => readFileSync(new URL(a, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  ok(!sinComentarios.some((c) => /anthropic|openai|claude|messages\.create|\/v1\/messages|gpt-/i.test(c)),
    'NINGÚN archivo del experimento llama a un LLM');
  ok(!sinComentarios.some((c) => /ensureSchema|\bbeat\s*\(|insert into|create table/i.test(c)),
    'ni ensureSchema, ni heartbeat, ni escrituras');
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  ok(vercel.functions['api/reaccion-analyze.js'] && vercel.functions['api/reaccion-analyze.js'].maxDuration === 300,
    'maxDuration 300 CON su entrada en vercel.json (la cicatriz del lint)');
}

// ═══════════════════ 7. errores ═══════════════════
console.log('errores');
{
  global.fetch = mockFetch();
  const mal = mockRes();
  await handler(GET({ secret: SECRET, fase: '7' }), mal);
  ok(mal.code === 400 && /fase=/.test(mal.body.error), '?fase=7 → 400 que explica');
  global.fetch = async () => { throw new Error('boom de red'); };
  const roto = mockRes();
  await handler(GET({ secret: SECRET, fase: '1' }), roto);
  ok(roto.code === 500 && /reaccion-analyze/.test(roto.body.error), 'un error de Neon sale 500 con contexto', roto.code);
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
