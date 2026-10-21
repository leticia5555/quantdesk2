// ═══════════════════════════════════════════════════════════════
// Tests del INSTRUMENTO de la alerta de desacuerdo: la métrica que pide el
// mercado y la profundidad de su libro.
//
// LA CICATRIZ: META, mercado abierto que resolvía el 2026-10-21
// (meta-quarterly-earnings-gaap-eps-10-21-2026-6pt31). La tarjeta dijo
// "DESACUERDO · 68 puntos": Polymarket 7% contra un histórico de 15 de 20.
// Dos causas, y ninguna era información:
//
//   1. MÉTRICA DISTINTA. El mercado resuelve sobre GAAP EPS; el histórico
//      cuenta el EPS AJUSTADO de Alpha Vantage. En 2025-10-29 el histórico
//      marca ✓ (6.71 → 7.25) y el GAAP fue $1.05 por un cargo fiscal único.
//   2. LIBRO VACÍO. $4.2K de volumen, $1.3K de liquidez, Yes a 28¢ y No a
//      96.3¢. La tarjeta mostró 7% (outcomePrices), Polymarket 16% (mid).
//
// La aserción central — y la que tiene que ponerse ROJA si alguien la
// reactiva — es la sección 4: la alerta de desacuerdo NO puede dispararse si
// la métrica no empata o si no se pudo determinar. Ningún override la apaga.
//
// Correr con `node tests/earnings-beat-instrumento.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  extraeMetricaMercado, comparaMetricas, libroDelYes, umbralDelSlug, METRICA_HISTORICO,
  evaluaDesacuerdo, CRITERIOS_DESACUERDO,
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
ok(/el mercado pide GAAP EPS, el histórico cuenta EPS ajustado — no son comparables/.test(comparaMetricas(meta).aviso),
  'y el aviso nombra las dos métricas', comparaMetricas(meta).aviso);
ok(comparaMetricas(nada).estado === 'indeterminada' && /No se pudo leer qué EPS pide el mercado/.test(comparaMetricas(nada).aviso),
  'indeterminada: dice que no se sabe');
ok(comparaMetricas(null).estado === 'indeterminada', 'sin métrica → indeterminada, nunca "empata"');
ok(comparaMetricas({ metrica: 'eps_ajustado' }).empata === true, 'ajustado vs ajustado: empata');

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

// ═══════════════════ 3. el umbral de spread: SIN congelar ═══════════════════
console.log('el umbral de spread se fija CON DATOS, no antes');

// Cuando se elija con el censo (?vista=live&diag=instrumento), este test se
// cambia JUNTO con el valor, en el mismo commit, citando la distribución.
ok(CRITERIOS_DESACUERDO.spread_max_puntos === null,
  'spread_max_puntos sigue en null: el censo de spreads va ANTES de fijarlo', CRITERIOS_DESACUERDO.spread_max_puntos);

// ═══════════════════ 4. LA ALERTA NO PUEDE DISPARAR SIN MÉTRICA QUE EMPATE ═══════════════════
console.log('LA ALERTA DE DESACUERDO no dispara si la métrica no empata o no se sabe');

const hist = {
  sin_datos: false,
  ventana: { trimestres: 20, beats: 15, total: 20, pct: 75 },
  ultimos: [6.71, 6.30, 5.25, 4.70].map((e, i) => ({ fecha: `2026-0${i + 1}-15`, estimado: e, reportado: e + 0.4, beat: true })),
};
const libroAngosto = libroDelYes({ bids: [{ price: '0.06', size: '900' }], asks: [{ price: '0.08', size: '900' }] });
// Criterios lo más PERMISIVOS posible: cualquier spread pasa. Si aun así la
// alerta no dispara, es por la métrica y solo por la métrica.
const PERMISIVO = { ...CRITERIOS_DESACUERDO, spread_max_puntos: 100 };
const caso = (metrica_mercado, extra = {}) => evaluaDesacuerdo({
  historico: hist, precio_mercado: 0.07, consenso_declarado: 6.31,
  fecha_reporte: '2026-10-21', hoy: '2026-10-20', libro: libroAngosto, criterios: PERMISIVO,
  metrica_mercado, ...extra,
});

// Control: con la métrica que EMPATA, este mismo caso SÍ es un desacuerdo. Sin
// esto, el resto de la sección podría pasar por cualquier otro motivo.
const control = caso({ metrica: 'eps_ajustado' });
ok(control.clasificacion === 'desacuerdo' && control.gap_puntos === -68,
  'CONTROL: con métrica que empata, el caso META da desacuerdo de 68 puntos', `${control.clasificacion} ${control.gap_puntos}`);

const noEmpatan = {
  'GAAP (el caso META)': meta,
  'indeterminada por conflicto': choque,
  'indeterminada sin mención': nada,
  'métrica null': null,
  'métrica undefined': undefined,
  'objeto vacío': {},
  'código desconocido': { metrica: 'ebitda' },
};
for (const [nombre, mm] of Object.entries(noEmpatan)) {
  const r = caso(mm);
  ok(r.clasificacion !== 'desacuerdo', `${nombre}: la alerta de desacuerdo NO dispara`, r.clasificacion);
  ok(r.clasificacion !== 'coincide', `${nombre}: y tampoco se afirma que "coincide"`, r.clasificacion);
  ok(r.gap_puntos === null, `${nombre}: no se publica la brecha de dos métricas distintas`, r.gap_puntos);
  ok(r.motivo === 'metrica_distinta' || r.motivo === 'metrica_indeterminada', `${nombre}: con el motivo dicho`, r.motivo);
}
ok(caso(meta).motivo === 'metrica_distinta', 'META: motivo métrica distinta');
ok(caso(nada).motivo === 'metrica_indeterminada', 'sin mención: motivo métrica indeterminada');
ok(/no son comparables/.test(caso(meta).metrica.aviso), 'y el aviso de métricas distintas viaja en la respuesta');
// Sin pasar el parámetro en absoluto (el llamador viejo): tampoco dispara.
const sinParam = evaluaDesacuerdo({ historico: hist, precio_mercado: 0.07, consenso_declarado: 6.31, libro: libroAngosto, criterios: PERMISIVO });
ok(sinParam.clasificacion !== 'desacuerdo' && sinParam.motivo === 'metrica_indeterminada',
  'un llamador que NO pasa la métrica no recupera la alerta vieja', sinParam.motivo);

// Ningún criterio la apaga: el cierre de métrica no vive en `criterios`.
for (const intento of [{ exigir_metrica: false }, { metrica: false }, { metrica_requerida: null }, { compara_metrica: false }]) {
  const r = caso(meta, { criterios: { ...PERMISIVO, ...intento } });
  ok(r.clasificacion !== 'desacuerdo', `override ${JSON.stringify(intento)} no reactiva la alerta`, r.clasificacion);
}

console.log('y el libro: sin libro, sin umbral o con spread ancho, tampoco');
const conMet = (extra) => evaluaDesacuerdo({ historico: hist, precio_mercado: 0.16, consenso_declarado: 6.31,
  fecha_reporte: '2026-10-21', hoy: '2026-10-20', metrica_mercado: { metrica: 'eps_ajustado' }, ...extra });
ok(conMet({ libro: libroAngosto }).motivo === 'umbral_spread_sin_congelar',
  'con el umbral congelado en null, la alerta no dispara en NINGÚN mercado', conMet({ libro: libroAngosto }).motivo);
ok(conMet({ libro: libroMeta, criterios: { ...CRITERIOS_DESACUERDO, spread_max_puntos: 10 } }).motivo === 'spread_ancho',
  'spread de 24.3 contra un umbral de 10: spread ancho, no dispara');
ok(conMet({ libro: null, criterios: PERMISIVO }).motivo === 'sin_libro', 'sin libro: no dispara');
ok(conMet({ libro: libroDelYes({ bids: [], asks: [] }), criterios: PERMISIVO }).motivo === 'sin_libro', 'libro vacío: no dispara');

// ═══════════════════ 5. lints de fuente ═══════════════════
console.log('lints: el cierre de métrica está ANTES de cualquier dictamen');

const lib = readFileSync(new URL('../api/_lib/earnings-beat.js', import.meta.url), 'utf8');
const cuerpo = lib.slice(lib.indexOf('function evaluaDesacuerdo'), lib.indexOf('function dondeMirarInstrumento'));
const iCierre = cuerpo.indexOf('if (!metrica.empata)');
ok(iCierre > 0, 'evaluaDesacuerdo tiene el cierre de métrica');
ok(iCierre < cuerpo.indexOf("clasificacion: 'desacuerdo'") && iCierre < cuerpo.indexOf("clasificacion: 'coincide'"),
  'y va ANTES de cualquier "desacuerdo" o "coincide"');
const lineaCierre = cuerpo.slice(iCierre, cuerpo.indexOf('\n', iCierre));
ok(!/criterios/.test(lineaCierre), 'y no depende de `criterios`', lineaCierre);

const api = readFileSync(new URL('../api/earnings-beat.js', import.meta.url), 'utf8');
ok(/metrica_mercado: m\.metrica/.test(api) && /libro: m\.libro/.test(api),
  'la vista en vivo le pasa la métrica y el libro a evaluaDesacuerdo');

const app = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const card = app.slice(app.indexOf('function ebLiveCard('), app.indexOf('\nfunction ebDiasHasta'));
ok(/'El mercado pide: '/.test(card) && /'The market asks for: '/.test(card), 'la tarjeta dice qué métrica pide el mercado, en las dos lenguas');
ok(/EPS AJUSTADO \(Alpha Vantage\), no GAAP/.test(card) && /ADJUSTED EPS \(Alpha Vantage\), not GAAP/.test(card),
  'y cuál es la nuestra');
ok(/precio_tipo==='mid'/.test(card) && /mid del libro/.test(card), 'dice de QUÉ precio se habla (mid / outcomePrices)');
ok(/'volumen '/.test(card) && /'liquidez '/.test(card) && /spread/.test(card), 'volumen, liquidez y spread junto al precio');
ok(/metrica_distinta/.test(card) && /no son comparables|not comparable/.test(card), 'y el aviso de métricas distintas, en vez de la alerta');

// ═══════════════════ 6. de punta a punta: la vista con el caso META ═══════════════════
console.log('vista en vivo, con Gamma + CLOB + Neon simulados');

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
delete process.env.CRON_SECRET;
const { default: handler } = await import('../api/earnings-beat.js');

const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString();
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
];
const LIBROS = {
  'tok-meta-yes': { bids: [{ price: '0.037', size: '40' }], asks: [{ price: '0.28', size: '12' }] },
  'tok-aapl-yes': { bids: [{ price: '0.55', size: '800' }], asks: [{ price: '0.57', size: '700' }] },
  // NVDA: el CLOB falla. Se dice, y la alerta no dispara.
};
const historia = [];
for (const s of ['META', 'AAPL', 'NVDA']) {
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
let pedidosLibro = 0;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === 'gamma-api.polymarket.com' && u.pathname === '/public-search') {
    return json({ events: [{ slug: 'earnings', markets: MERCADOS }] });
  }
  if (u.hostname === 'clob.polymarket.com' && u.pathname === '/book') {
    pedidosLibro++;
    const b = LIBROS[u.searchParams.get('token_id')];
    return b ? json({ market: 'x', asset_id: u.searchParams.get('token_id'), ...b }) : json({ error: 'boom' }, 500);
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

const res = mockRes();
await handler({ method: 'GET', query: { vista: 'live' }, headers: {} }, res);
ok(res.code === 200, 'la vista contesta 200', res.code + ' ' + JSON.stringify(res.body).slice(0, 200));
const emp = Object.fromEntries((res.body.empresas || []).map((e) => [e.symbol, e]));
ok(emp.META && emp.AAPL && emp.NVDA, 'las tres empresas en la vista', Object.keys(emp).join(','));

const mMeta = emp.META.mercados[0];
ok(mMeta.metrica.metrica === 'eps_gaap', 'META: el mercado pide GAAP EPS', mMeta.metrica.metrica);
ok(mMeta.umbral_slug === 6.31 && mMeta.consenso_eps === 6.31, 'META: umbral 6.31, del slug y de la descripción');
ok(mMeta.desacuerdo.clasificacion !== 'desacuerdo' && mMeta.desacuerdo.motivo === 'metrica_distinta',
  'META: la alerta FALSA ya no dispara — métricas distintas', `${mMeta.desacuerdo.clasificacion}/${mMeta.desacuerdo.motivo}`);
ok(emp.META.desacuerdos.destacado === null, 'META: nada destacado como desacuerdo');
ok(mMeta.precio_tipo === 'mid' && mMeta.polymarket_yes_pct === 16, 'META: el precio es el mid del libro (16%), dicho como mid', `${mMeta.precio_tipo} ${mMeta.polymarket_yes_pct}`);
ok(mMeta.outcome_prices_yes === 0.07, 'y el 7% de outcomePrices queda aparte, para cotejar');
ok(mMeta.libro.spread_puntos === 24.3 && mMeta.volumen === 4200 && mMeta.liquidez === 1300, 'META: spread, volumen y liquidez en la respuesta');

const mAapl = emp.AAPL.mercados[0];
ok(mAapl.metrica.metrica === 'eps_ajustado' && mAapl.desacuerdo.motivo === 'umbral_spread_sin_congelar',
  'AAPL: la métrica empata, pero el umbral de spread no está fijado → no dispara', mAapl.desacuerdo.motivo);
const mNvda = emp.NVDA.mercados[0];
ok(mNvda.metrica.metrica === 'indeterminada' && mNvda.desacuerdo.motivo === 'metrica_indeterminada',
  'NVDA: no se sabe qué EPS pide → no dispara', mNvda.desacuerdo.motivo);
ok(mNvda.libro.estado === 'clob_httperror' && mNvda.precio_tipo === 'outcome_prices',
  'NVDA: el CLOB falló, se dice, y el precio se nombra outcomePrices', `${mNvda.libro.estado} ${mNvda.precio_tipo}`);
const disparadas = (res.body.empresas || []).flatMap((e) => e.mercados).filter((m) => m.desacuerdo.clasificacion === 'desacuerdo');
ok(disparadas.length === 0, 'ninguna alerta de desacuerdo en toda la vista', disparadas.length);
ok(res.body.empresas.every((e) => e.probabilidad_quantdesk === null), 'y QuantDesk sigue sin probabilidad propia');

console.log('el censo del instrumento');
const rd = mockRes();
await handler({ method: 'GET', query: { vista: 'live', diag: 'instrumento' }, headers: {} }, rd);
ok(rd.code === 200 && rd.body.diag === 'instrumento', 'diag=instrumento contesta', rd.code);
ok(rd.body.metrica.por_metrica.eps_gaap === 1 && rd.body.metrica.por_metrica.eps_ajustado === 1 && rd.body.metrica.por_metrica.indeterminada === 1,
  'cuenta GAAP / ajustado / indeterminada', JSON.stringify(rd.body.metrica.por_metrica));
ok(rd.body.libro.con_spread === 2 && rd.body.libro.spread_puntos.max === 24.3, 'la distribución de spreads sale de los libros que contestaron');
ok(rd.body.libro.umbral_congelado === null, 'y reporta que el umbral no está fijado');
const c10 = rd.body.libro.candidatos.find((c) => c.spread_max_puntos === 10);
ok(c10.pasan === 1 && c10.pasan_y_empatan_metrica === 1, 'con 10¢: pasa AAPL, no META', JSON.stringify(c10));
const rm = mockRes();
await handler({ method: 'GET', query: { vista: 'live', diag: 'instrumento', format: 'md' }, headers: {} }, rm);
ok(rm.code === 200 && /censo del instrumento/.test(rm.text) && /meta-quarterly-earnings-gaap-eps/.test(rm.text),
  'y en markdown, con la fila de META', (rm.text || '').slice(0, 120));
ok(/no se auto-aprueba/.test(rm.text), 'el censo reporta; no se auto-aprueba');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
