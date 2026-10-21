// ═══════════════════════════════════════════════════════════════
// Tests del INSTRUMENTO de la tarjeta en vivo: qué métrica pide el mercado,
// el libro del Yes y el consenso — los números que la tarjeta pone LADO A
// LADO, cada uno con lo que mide.
//
// LA CICATRIZ: META, mercado abierto que resolvía el 2026-10-21
// (meta-quarterly-earnings-gaap-eps-10-21-2026-6pt31). La tarjeta dijo
// "DESACUERDO · 68 puntos" y era falsa: el mercado resuelve sobre GAAP EPS, el
// histórico cuenta EPS AJUSTADO de Alpha Vantage, y el libro estaba vacío
// (Yes a 28¢, No a 96.3¢). Lety decidió que QuantDesk NO juzga el desacuerdo:
// la alerta se retiró entera, y tests/earnings-beat-live.test.mjs vigila que
// no vuelva. Lo que queda es decir bien qué mide cada número.
//
// Y el arreglo del lector: 20 de 30 mercados salían "conflicto" por una
// cláusula condicional de respaldo («If … without a non-GAAP EPS, then the
// market will resolve according to the GAAP EPS listed in…»).
//
// Correr con `node tests/earnings-beat-instrumento.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  extraeMetricaMercado, comparaMetricas, libroDelYes, umbralDelSlug, METRICA_HISTORICO, sinCondicionales,
} from '../api/_lib/earnings-beat.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const SLUG_META = 'meta-quarterly-earnings-gaap-eps-10-21-2026-6pt31';

// ═══════════════════ 1. qué EPS pide el mercado ═══════════════════
console.log('extraeMetricaMercado: se LEE, no se adivina');

const meta = extraeMetricaMercado({ slug: SLUG_META, pregunta: 'Will Meta Platforms (META) beat quarterly earnings?' });
ok(meta.metrica === 'eps_gaap', 'el slug de META dice GAAP EPS', meta.metrica);
ok(meta.leida_de.join(',') === 'slug', 'y se dice DE DÓNDE se leyó', meta.leida_de);
ok(umbralDelSlug(SLUG_META) === 6.31, 'el umbral del slug: 6pt31 → 6.31', umbralDelSlug(SLUG_META));

ok(extraeMetricaMercado({ slug: 'x-quarterly-earnings-non-gaap-eps-1pt00' }).metrica === 'eps_ajustado',
  '"non-gaap-eps" CONTIENE "gaap-eps" y aun así se lee ajustado');
ok(extraeMetricaMercado({ slug: 'x-quarterly-earnings-nongaap-eps-1pt00' }).metrica === 'eps_ajustado', '"nongaap-eps" también');
ok(extraeMetricaMercado({ slug: 'x-adjusted-eps-1pt00' }).metrica === 'eps_ajustado', '"adjusted-eps" también');
ok(extraeMetricaMercado({ slug: 'x', descripcion: 'resolves Yes if the company reports adjusted diluted EPS above $1.00' }).metrica === 'eps_ajustado',
  'en el texto: "adjusted diluted EPS" es ajustado');
ok(extraeMetricaMercado({ slug: 'x', descripcion: 'resolves Yes if the company reports GAAP EPS above $1.00' }).metrica === 'eps_gaap',
  'en el texto: "GAAP EPS" es GAAP');

const splits = extraeMetricaMercado({ slug: 'x-beat-quarterly-earnings', descripcion: 'EPS figures will be adjusted for stock splits.' });
ok(splits.metrica === 'indeterminada' && splits.motivo === 'sin_mencion',
  '"adjusted for stock splits" NO es EPS ajustado: sin mención, indeterminada', `${splits.metrica}/${splits.motivo}`);

const choque = extraeMetricaMercado({ slug: SLUG_META, descripcion: 'Resolves on reported EPS. Non-GAAP figures will not be considered.' });
ok(choque.metrica === 'indeterminada' && choque.motivo === 'conflicto',
  'slug GAAP + descripción que menciona non-GAAP → conflicto: NO se elige una', `${choque.metrica}/${choque.motivo}`);
ok(choque.por_fuente.slug.lee === 'eps_gaap' && choque.por_fuente.descripcion.lee === 'eps_ajustado',
  'y cada fuente queda a la vista para auditar la lectura');

const nada = extraeMetricaMercado({ slug: 'nvda-beat-quarterly-earnings', pregunta: 'Will NVIDIA beat quarterly earnings?', descripcion: 'Resolves Yes if NVIDIA beats the consensus estimate of $1.20.' });
ok(nada.metrica === 'indeterminada' && nada.motivo === 'sin_mencion', 'sin mención de la métrica → indeterminada, no "ajustado por default"');
ok(extraeMetricaMercado(null).metrica === 'indeterminada', 'null → indeterminada, no crashea');

console.log('la métrica del histórico, declarada');
ok(METRICA_HISTORICO.codigo === 'eps_ajustado' && /Alpha Vantage/.test(METRICA_HISTORICO.fuente),
  'el histórico cuenta EPS AJUSTADO de Alpha Vantage, y lo dice');
ok(/no el GAAP/.test(METRICA_HISTORICO.nota), 'con la nota de que no es GAAP');
ok(Object.isFrozen(METRICA_HISTORICO), 'congelada: nadie la "corrige" en runtime para que empate');

ok(comparaMetricas(meta).estado === 'distinta' && comparaMetricas(meta).empata === false, 'GAAP vs ajustado: distinta');
ok(comparaMetricas(meta).nota === 'El mercado mide GAAP EPS, el histórico cuenta EPS ajustado.',
  'la nota es NEUTRAL: dice qué mide cada uno', comparaMetricas(meta).nota);
ok(comparaMetricas(nada).nota === 'Métrica del mercado: no determinada.', 'no determinada: lo dice así, sin inventar', comparaMetricas(nada).nota);
for (const c of [meta, nada]) {
  const n = comparaMetricas(c).nota;
  ok(!/no son comparables|advertencia|⚠|no se comparan|alerta/i.test(n), 'la nota no es una advertencia ni un bloqueo', n);
}
ok(comparaMetricas(null).estado === 'indeterminada', 'sin métrica → no determinada, nunca "empata"');
ok(comparaMetricas({ metrica: 'eps_ajustado' }).empata === true && comparaMetricas({ metrica: 'eps_ajustado' }).nota === null,
  'ajustado vs ajustado: empata, y no hay nada que decir');

// ═══════════════════ 1b. las cláusulas CONDICIONALES de respaldo ═══════════════════
console.log('el lector ignora las cláusulas condicionales de respaldo');

// La forma de los 20 mercados que salían "conflicto": slug nongaap-eps, la
// oración principal sin métrica, y el respaldo condicional nombrando GAAP.
const DESC_RESPALDO = 'This market will resolve to "Yes" if Apple Inc. (AAPL) reports quarterly earnings per share (EPS) greater than $1.60 for Q4 2026. '
  + 'If Apple releases earnings without a non-GAAP EPS, then the market will resolve according to the GAAP EPS listed in the official earnings release. '
  + 'The resolution source will be the company\'s official earnings documentation.';
const respaldo = { slug: 'aapl-quarterly-earnings-nongaap-eps-10-30-2026-1pt60', pregunta: 'Will Apple (AAPL) beat quarterly earnings?', descripcion: DESC_RESPALDO };
const viejo = extraeMetricaMercado(respaldo, { ignorarCondicionales: false });
const nuevo = extraeMetricaMercado(respaldo);
ok(viejo.metrica === 'indeterminada' && viejo.motivo === 'conflicto', 'el lector VIEJO lo leía como conflicto (el bug)', `${viejo.metrica}/${viejo.motivo}`);
ok(/the market will resolve according to the GAAP EPS listed in/.test(viejo.por_fuente.descripcion.fragmento || ''),
  'con el MISMO fragmento que salió en los 20', viejo.por_fuente.descripcion.fragmento);
ok(nuevo.metrica === 'eps_ajustado', 'el lector nuevo: ajustado, como dice el slug', `${nuevo.metrica}/${nuevo.motivo}`);
ok(nuevo.por_fuente.descripcion.ignoradas.length === 1 && /^If Apple releases earnings without a non-GAAP EPS/.test(nuevo.por_fuente.descripcion.ignoradas[0]),
  'y dice QUÉ cláusula dejó de leer', JSON.stringify(nuevo.por_fuente.descripcion.ignoradas));
ok(!/\$1\.6\b|1\.60 for/.test(nuevo.por_fuente.descripcion.ignoradas.join(' ')), 'el "$1.60" no corta la oración: el punto decimal no es fin de oración');

// La oración principal NUNCA se descarta, aunque empiece con "If".
ok(extraeMetricaMercado({ slug: 'x', descripcion: 'If Meta reports GAAP EPS greater than $6.31, the market will resolve to "Yes". Otherwise it resolves No.' }).metrica === 'eps_gaap',
  'una principal que empieza con "If" sigue contando');
ok(extraeMetricaMercado({ slug: 'x', descripcion: 'This market will resolve to “Yes” if X reports non-GAAP EPS above $1.00; if X does not report non-GAAP EPS, GAAP EPS will be used.' }).metrica === 'eps_ajustado',
  'un respaldo después de ";" también es una cláusula condicional');
// Lo que NO encaja en el patrón se lee como siempre: si choca, sigue sin determinarse.
const noEncaja = extraeMetricaMercado({ slug: 'x-quarterly-earnings-nongaap-eps-1pt00',
  descripcion: 'This market will resolve to "Yes" if X reports EPS above $1.00, using GAAP EPS where non-GAAP EPS is unavailable.' });
ok(noEncaja.metrica === 'indeterminada' && noEncaja.motivo === 'conflicto',
  'un respaldo DENTRO de la principal (sin oración condicional aparte) no se adivina: sigue no determinada', `${noEncaja.metrica}/${noEncaja.motivo}`);
ok(sinCondicionales('Unless X reports, GAAP applies. Main text.').ignoradas.length === 1, '"Unless…" también es condicional');
ok(sinCondicionales('').ignoradas.length === 0, 'texto vacío: nada que ignorar');

// ═══════════════════ 2. el libro del Yes ═══════════════════
console.log('libroDelYes: bid, ask, mid y spread');

// El libro de META tal como se vio: Yes ask 28¢, No ask 96.3¢ → Yes bid 3.7¢.
// Viene DESORDENADO a propósito: no se confía en el orden del CLOB.
const libroMeta = libroDelYes({
  bids: [{ price: '0.01', size: '300' }, { price: '0.037', size: '40' }, { price: '0.02', size: '100' }],
  asks: [{ price: '0.5', size: '20' }, { price: '0.28', size: '12' }, { price: '0.35', size: '50' }],
});
ok(libroMeta.estado === 'ok' && libroMeta.bid === 0.037 && libroMeta.ask === 0.28, 'mejor bid y mejor ask, sin importar el orden', JSON.stringify(libroMeta));
ok(libroMeta.spread_puntos === 24.3, 'spread de META: 24.3 puntos', libroMeta.spread_puntos);
ok(Math.round(libroMeta.mid * 100) === 16, 'y el mid da el 16% del encabezado de Polymarket, no el 7%', libroMeta.mid);
ok(libroDelYes({ bids: [], asks: [] }).estado === 'vacio', 'libro vacío: se dice');
ok(libroDelYes({ bids: [], asks: [{ price: '0.3', size: '1' }] }).estado === 'sin_bid', 'sin bid: se dice');
ok(libroDelYes({ bids: [{ price: '0.3', size: '1' }], asks: [] }).estado === 'sin_ask', 'sin ask: se dice');
ok(libroDelYes({ bids: [{ price: '0.6', size: '1' }], asks: [{ price: '0.4', size: '1' }] }).estado === 'cruzado', 'libro cruzado: se dice, no se promedia');
ok(libroDelYes(null).mid === null, 'null → sin mid, no crashea');

// ═══════════════════ 3. lints de fuente ═══════════════════
console.log('lints: la tarjeta dice qué mide cada número');

const app = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const card = app.slice(app.indexOf('function ebLiveCard('), app.indexOf('\nfunction ebDiasHasta'));
ok(/precio_tipo==='mid'/.test(card) && /mid del libro/.test(card), 'dice de QUÉ precio se habla (mid / outcomePrices)');
ok(/'volumen '/.test(card) && /'liquidez '/.test(card) && /spread/.test(card), 'volumen, liquidez y spread junto al precio');
// El track record SE QUEDA TAL CUAL (pedido explícito): titular, completo,
// racha, sorpresa mediana y últimos trimestres.
for (const [nombre, re] of [['titular N de M', /'Histórico: superó '/], ['histórico completo', /histórico completo: /], ['racha', /'Racha: '/],
  ['sorpresa mediana', /'Sorpresa mediana: '/], ['últimos trimestres', /'ÚLTIMOS TRIMESTRES'/]]) {
  ok(re.test(card), `el track record conserva: ${nombre}`);
}

// ═══════════════════ 4. de punta a punta: la vista con el caso META ═══════════════════
console.log('vista en vivo, con Gamma + CLOB + Finnhub + Neon simulados');

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.FINNHUB_API_KEY = 'fh-test';
delete process.env.CRON_SECRET;
const { default: handler } = await import('../api/earnings-beat.js');

const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString();
const dia = (n) => enDias(n).slice(0, 10);
const mercado = (o) => ({ outcomes: '["Yes","No"]', active: true, closed: false, endDate: enDias(10), ...o });
const MERCADOS = [
  mercado({ id: 'm-meta', slug: SLUG_META, question: 'Will Meta Platforms (META) beat quarterly earnings?',
    description: 'This market resolves to Yes if Meta reports EPS above $6.31 for the quarter.',
    outcomePrices: '["0.07","0.93"]', clobTokenIds: '["tok-meta-yes","tok-meta-no"]',
    volumeNum: 4200, liquidityNum: 1300, bestBid: 0.037, bestAsk: 0.28, lastTradePrice: 0.07 }),
  mercado({ id: 'm-aapl', slug: 'aapl-quarterly-earnings-nongaap-eps-1pt60', question: 'Will Apple (AAPL) beat quarterly earnings?',
    description: 'Resolves Yes if Apple reports non-GAAP EPS above $1.60.',
    outcomePrices: '["0.56","0.44"]', clobTokenIds: '["tok-aapl-yes","tok-aapl-no"]', volumeNum: 250000, liquidityNum: 40000 }),
  mercado({ id: 'm-nvda', slug: 'nvda-beat-quarterly-earnings', question: 'Will NVIDIA (NVDA) beat quarterly earnings?',
    description: 'Resolves Yes if NVIDIA beats the consensus estimate of $1.20 EPS.',
    outcomePrices: '["0.81","0.19"]', clobTokenIds: '["tok-nvda-yes","tok-nvda-no"]', volumeNum: 90000, liquidityNum: 9000 }),
  // La forma de los 20 "conflicto": slug nongaap + respaldo condicional GAAP.
  mercado({ id: 'm-msft', slug: 'msft-quarterly-earnings-nongaap-eps-3pt10', question: 'Will Microsoft (MSFT) beat quarterly earnings?',
    description: DESC_RESPALDO.replace(/Apple Inc\. \(AAPL\)|Apple/g, 'Microsoft').replace('$1.60', '$3.10'),
    outcomePrices: '["0.70","0.30"]', clobTokenIds: '["tok-msft-yes","tok-msft-no"]', volumeNum: 120000, liquidityNum: 15000 }),
];
const LIBROS = {
  'tok-meta-yes': { bids: [{ price: '0.037', size: '40' }], asks: [{ price: '0.28', size: '12' }] },
  'tok-aapl-yes': { bids: [{ price: '0.55', size: '800' }], asks: [{ price: '0.57', size: '700' }] },
  'tok-msft-yes': { bids: [{ price: '0.69', size: '300' }], asks: [{ price: '0.71', size: '300' }] },
  // NVDA: el CLOB falla. Se dice.
};
// Calendario de Finnhub: META con estimado, AAPL con la fila pero sin
// estimado, MSFT con estimado, NVDA sin fila.
const CALENDARIO = [
  { symbol: 'META', date: dia(10), epsEstimate: 6.71, quarter: 3, year: 2026 },
  { symbol: 'AAPL', date: dia(11), epsEstimate: null, quarter: 4, year: 2026 },
  { symbol: 'MSFT', date: dia(9), epsEstimate: 3.12, quarter: 1, year: 2027 },
  { symbol: 'META', date: dia(100), epsEstimate: 7.5 },   // otro trimestre: fuera de tolerancia
];
const historia = [];
for (const s of ['META', 'AAPL', 'NVDA', 'MSFT']) {
  for (let i = 0; i < 20; i++) {
    const anio = 2026 - Math.floor(i / 4);
    const mes = String(12 - (i % 4) * 3).padStart(2, '0');
    const beat = i % 4 !== 3;   // 15 de 20
    historia.push({ symbol: s, reported_date: `${anio}-${mes}-10`, reported_eps: beat ? '2.10' : '1.90', estimated_eps: '2.00', surprise_pct: beat ? '5' : '-5' });
  }
}
const NUM = 1700, TXT = 25;
const CAMPOS = [['symbol', TXT], ['reported_date', TXT], ['reported_eps', NUM], ['estimated_eps', NUM], ['surprise_pct', NUM]];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let pedidosFinnhub = 0;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === 'gamma-api.polymarket.com' && u.pathname === '/public-search') {
    return json({ events: [{ slug: 'earnings', markets: MERCADOS }] });
  }
  if (u.hostname === 'clob.polymarket.com' && u.pathname === '/book') {
    const b = LIBROS[u.searchParams.get('token_id')];
    return b ? json({ market: 'x', asset_id: u.searchParams.get('token_id'), ...b }) : json({ error: 'boom' }, 500);
  }
  if (u.hostname === 'finnhub.io' && u.pathname === '/api/v1/calendar/earnings') {
    pedidosFinnhub++;
    const desde = u.searchParams.get('from'), hasta = u.searchParams.get('to');
    return json({ earningsCalendar: CALENDARIO.filter((f) => f.date >= desde && f.date <= hasta) });
  }
  if (String(url).includes('/sql')) {
    const body = JSON.parse(opts.body);
    const q = (body.queries ? body.queries[0] : body).query;
    if (!/^\s*select/i.test(q)) throw new Error('query que no es SELECT: ' + q);
    const params = (body.queries ? body.queries[0] : body).params || [];
    const filas = historia.filter((f) => params.includes(f.symbol));
    return json({ fields: CAMPOS.map(([name, dataTypeID]) => ({ name, dataTypeID })), rows: filas.map((f) => CAMPOS.map(([n]) => f[n])) });
  }
  return json({ error: 'no simulado: ' + url }, 404);
};

function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, send(s) { this.text = s; return this; }, end() { return this; } };
}
// Todas las claves de un objeto, a cualquier profundidad.
function claves(o, out = new Set()) {
  if (Array.isArray(o)) { for (const x of o) claves(x, out); return out; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.add(k); claves(v, out); }
  return out;
}

const res = mockRes();
await handler({ method: 'GET', query: { vista: 'live' }, headers: {} }, res);
ok(res.code === 200, 'la vista contesta 200', res.code + ' ' + JSON.stringify(res.body).slice(0, 200));
const emp = Object.fromEntries((res.body.empresas || []).map((e) => [e.symbol, e]));
ok(emp.META && emp.AAPL && emp.NVDA && emp.MSFT, 'las cuatro empresas en la vista', Object.keys(emp).join(','));

// LA ALERTA NO EXISTE en la respuesta: ni el dictamen, ni la brecha, ni "dónde mirar".
const k = claves(res.body);
for (const prohibida of ['desacuerdo', 'desacuerdos', 'gap_puntos', 'donde_mirar', 'clasificacion', 'instrumento_primero', 'destacado', 'lectura_codigo']) {
  ok(!k.has(prohibida), `la respuesta no trae "${prohibida}"`);
}
ok(pedidosFinnhub === 1, 'el consenso cuesta UN request a Finnhub para toda la vista', pedidosFinnhub);

const mMeta = emp.META.mercados[0];
ok(mMeta.metrica.metrica === 'eps_gaap', 'META: el mercado pide GAAP EPS', mMeta.metrica.metrica);
ok(mMeta.umbral_slug === 6.31 && mMeta.consenso_eps === 6.31, 'META: umbral 6.31, del slug y de la descripción');
ok(mMeta.metrica_vs_historico.estado === 'distinta'
  && mMeta.metrica_vs_historico.nota === 'El mercado mide GAAP EPS, el histórico cuenta EPS ajustado.',
  'META: la línea neutral dice qué mide cada uno', mMeta.metrica_vs_historico.nota);
ok(mMeta.precio_tipo === 'mid' && mMeta.polymarket_yes_pct === 16, 'META: el precio es el mid del libro (16%), dicho como mid', `${mMeta.precio_tipo} ${mMeta.polymarket_yes_pct}`);
ok(mMeta.outcome_prices_yes === 0.07, 'y el 7% de outcomePrices queda aparte, para cotejar');
ok(mMeta.libro.spread_puntos === 24.3 && mMeta.libro.bid === 0.037 && mMeta.libro.ask === 0.28, 'META: bid, ask y spread en la respuesta');
ok(mMeta.volumen === 4200 && mMeta.liquidez === 1300, 'META: volumen y liquidez');
ok(mMeta.consenso_analistas.valor === 6.71 && mMeta.consenso_analistas.metrica === 'no declarada por la fuente',
  'META: consenso de analistas de Finnhub, del trimestre cercano (no el de 100 días)', JSON.stringify(mMeta.consenso_analistas));
ok(emp.META.historico.ventana.total === 20 && emp.META.historico.ventana.beats === 15 && emp.META.historico.ultimos.length === 8,
  'META: el track record intacto (15 de 20, últimos 8)');
ok(emp.META.historico_metrica.codigo === 'eps_ajustado', 'y declarado como EPS ajustado');

const mAapl = emp.AAPL.mercados[0];
ok(mAapl.metrica.metrica === 'eps_ajustado' && mAapl.metrica_vs_historico.nota === null, 'AAPL: misma métrica, sin línea que decir');
ok(mAapl.consenso_analistas.valor === null && mAapl.consenso_analistas.motivo === 'sin_estimado', 'AAPL: la fila existe sin estimado → se dice');
const mNvda = emp.NVDA.mercados[0];
ok(mNvda.metrica.metrica === 'indeterminada' && mNvda.metrica_vs_historico.nota === 'Métrica del mercado: no determinada.',
  'NVDA: métrica no determinada, dicho así');
ok(mNvda.libro.estado === 'clob_httperror' && mNvda.precio_tipo === 'outcome_prices',
  'NVDA: el CLOB falló, se dice, y el precio se nombra outcomePrices', `${mNvda.libro.estado} ${mNvda.precio_tipo}`);
ok(mNvda.consenso_analistas.motivo === 'sin_fila_en_el_calendario', 'NVDA: sin fila en el calendario → se dice', mNvda.consenso_analistas.motivo);
const mMsft = emp.MSFT.mercados[0];
ok(mMsft.metrica.metrica === 'eps_ajustado', 'MSFT (forma de los 20): con el arreglo, ajustado', mMsft.metrica.metrica);
ok(mMsft.metrica_lector_viejo === undefined, 'la lectura vieja NO viaja en la vista pública: es solo del censo');
ok(res.body.empresas.every((e) => e.probabilidad_quantdesk === null), 'y QuantDesk sigue sin probabilidad propia');

console.log('el censo del instrumento');
const rd = mockRes();
await handler({ method: 'GET', query: { vista: 'live', diag: 'instrumento' }, headers: {} }, rd);
ok(rd.code === 200 && rd.body.diag === 'instrumento', 'diag=instrumento contesta', rd.code);
ok(JSON.stringify(rd.body.metrica.por_metrica) === JSON.stringify({ eps_gaap: 1, eps_ajustado: 2, indeterminada: 1 }),
  'cuenta GAAP / ajustado / no determinada', JSON.stringify(rd.body.metrica.por_metrica));
const ac = rd.body.arreglo_condicionales;
ok(ac.eran_conflicto === 1 && ac.de_esas_cambian === 1 && ac.de_esas_a.eps_ajustado === 1 && ac.de_esas_siguen_indeterminadas.length === 0,
  'el arreglo: 1 era conflicto, cambia a ajustado, ninguna sigue no determinada', JSON.stringify(ac));
ok(ac.cambian === 1, 'y solo cambia ESA: el resto lee igual que antes', ac.cambian);
const filaMsft = rd.body.filas.find((f) => f.symbol === 'MSFT');
ok(filaMsft.lector_viejo === 'indeterminada' && filaMsft.cambia_con_el_arreglo && filaMsft.clausulas_condicionales_ignoradas.length === 1,
  'la fila de MSFT muestra el veredicto viejo y la cláusula ignorada');
ok(rd.body.libro.con_spread === 3 && rd.body.libro.spread_puntos.max === 24.3, 'el spread se describe con los libros que contestaron');
ok(!('candidatos' in rd.body.libro) && !('umbral_congelado' in rd.body.libro), 'y no hay umbral de spread: ya no condiciona nada');
const rm = mockRes();
await handler({ method: 'GET', query: { vista: 'live', diag: 'instrumento', format: 'md' }, headers: {} }, rm);
ok(rm.code === 200 && /censo del instrumento/.test(rm.text) && /meta-quarterly-earnings-gaap-eps/.test(rm.text),
  'y en markdown, con la fila de META', (rm.text || '').slice(0, 120));
ok(/Eran "no determinada por conflicto": \*\*1\*\* → cambian \*\*1\*\*/.test(rm.text), 'el markdown reporta cuántas cambian', (rm.text.match(/Eran.*$/m) || [])[0]);
ok(/ignorada \(condicional\): «If Microsoft releases earnings/.test(rm.text), 'y cita la cláusula ignorada');
ok(/no se auto-aprueba/.test(rm.text), 'el censo reporta; no se auto-aprueba');

const rr = mockRes();
await handler({ method: 'GET', query: { vista: 'live', diag: 'desacuerdos' }, headers: {} }, rr);
ok(rr.body && rr.body.retirado === true, 'diag=desacuerdos dice que se retiró, no cae al diag por símbolo', JSON.stringify(rr.body).slice(0, 120));

console.log('sin key de Finnhub: se dice');
delete process.env.FINNHUB_API_KEY;
const rs = mockRes();
await handler({ method: 'GET', query: { vista: 'live' }, headers: {} }, rs);
ok(rs.body.empresas[0].mercados[0].consenso_analistas.motivo === 'sin_key' && rs.body.consenso_analistas.estado === 'sin_key',
  'consenso no disponible, con el motivo "sin_key"');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
