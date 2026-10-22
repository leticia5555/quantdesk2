// ═══════════════════════════════════════════════════════════════
// Tests de la cosecha de RANGOS de KPI (pm_kpi_markets). JS puro, SIN RED NI
// DB: Gamma y CLOB son dobles que sirven fixtures.
//   - parseaRango: los casos exigidos + variantes
//   - símbolo y nombre del KPI desde el título
//   - filasDeEvento: una fila por cajón, exclusiones con motivo
//   - cosechaKpi en seco: conteos por semilla, 422 = parar sin reintentar,
//     cero datos = falla de frontera (nunca veredicto)
//   - markdown de lectura, ordenado por end_date
// Correr con `node tests/earnings-kpi.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  parseaRango, rangoDeMercado, extraeSimboloKpi, kpiDeTitulo, excluyeTitulo, filasDeEvento,
  conteos, veredictoFrontera, markdownEventos, SEMILLAS_KPI,
} from '../api/_lib/earnings-kpi.js';
import { cosechaKpi, markdownSeco } from '../api/_lib/earnings-kpi-cosecha.js';
import { FRASES_BUSQUEDA } from '../api/_lib/earnings-beat.js';
import {
  EVENTO_MA, EVENTO_DKS, EVENTO_BEAT, EVENTO_MENCION, EVENTO_AZURE_SIN_RANGOS, busqueda,
} from './fixtures/pm-kpi-eventos.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('parseaRango: los casos exigidos');

const CASOS = [
  ['<22%', null, 22],
  ['22% to 24%', 22, 24],
  ['28%+', 28, null],
  ['between 3% and 4%', 3, 4],
  ['above 4%', 4, null],
  ['below 1%', null, 1],
  ['11.5% to 12.5%', 11.5, 12.5],
  ['<3.5%', null, 3.5],
  ['6.5%+', 6.5, null],
];
for (const [txt, low, high] of CASOS) {
  const r = parseaRango(txt);
  ok(r && r.low === low && r.high === high && r.unidad === '%', `"${txt}" → [${low}, ${high}] %`, JSON.stringify(r));
}

console.log('parseaRango: variantes');
ok(eq(pick(parseaRango('-2% to 0%')), [-2, 0]), 'negativos: "-2% to 0%"', JSON.stringify(parseaRango('-2% to 0%')));
ok(eq(pick(parseaRango('<-2%')), [null, -2]), '"<-2%" (comps negativos)');
ok(eq(pick(parseaRango('22-24%')), [22, 24]) && parseaRango('22-24%').unidad === '%', '"22-24%": la unidad de un extremo vale para el rango');
ok(eq(pick(parseaRango('≥ 98%')), [98, null]), '"≥ 98%"');
ok(eq(pick(parseaRango('95.0 or less')), [null, 95]) && parseaRango('95.0 or less').unidad === null, 'combined ratio sin %: "95.0 or less"');
ok(eq(pick(parseaRango('400k to 450k')), [400000, 450000]), 'deliveries: "400k to 450k" → absolutos');
ok(eq(pick(parseaRango('1.2M+')), [1200000, null]), 'net adds: "1.2M+"');
ok(eq(pick(parseaRango('less than 3%')), [null, 3]), '"less than 3%"');
ok(eq(pick(parseaRango('5% or more')), [5, null]), '"5% or more"');
ok(eq(pick(parseaRango('24% to 22%')), [22, 24]), 'extremos invertidos se ordenan');
ok(parseaRango('Yes') === null, '"Yes" no es un rango');
ok(parseaRango('December 31') === null || parseaRango('December 31').forma !== 'entre', '"December 31" no es un rango "entre"');
ok(parseaRango('') === null && parseaRango(null) === null, 'vacío → null, no un rango inventado');

function pick(r) { return r ? [r.low, r.high] : null; }

console.log('rangoDeMercado: de dónde sale el cajón');
const r1 = rangoDeMercado({ groupItemTitle: '22% to 24%', question: 'MA cross-border Q3: 22% to 24%?' });
ok(r1.via === 'groupItemTitle' && r1.low === 22, 'groupItemTitle primero');
const r2 = rangoDeMercado({ question: 'Mastercard cross-border volume growth Q3 2026: 28%+?' });
ok(r2 && r2.via === 'pregunta:cola' && r2.low === 28 && r2.high === null, 'sin groupItemTitle → cola tras ":"', JSON.stringify(r2));
const r3 = rangoDeMercado({ question: 'Will Visa cross-border volume growth be between 11.5% and 12.5% in Q3 2026?' });
ok(r3 && r3.low === 11.5 && r3.high === 12.5, '"…be between 11.5% and 12.5% in Q3 2026?" → recorta el trimestre', JSON.stringify(r3));

console.log('símbolo y nombre del KPI');
ok(extraeSimboloKpi('Mastercard (MA) cross-border volume growth Q3?').symbol === 'MA', '"(MA)" → MA');
ok(extraeSimboloKpi('Microsoft (MSFT) Azure growth Q1 FY27?').symbol === 'MSFT', '"(MSFT)" → MSFT');
ok(extraeSimboloKpi("DICK'S comparable sales Q2?").symbol === 'DKS', `"DICK'S" → DKS`);
ok(extraeSimboloKpi('DICK’S comparable sales Q2?').symbol === 'DKS', '"DICK’S" (apóstrofo curvo) → DKS');
ok(extraeSimboloKpi('Target comparable sales Q3?').symbol === 'TGT', '"Target" → TGT');
ok(extraeSimboloKpi('Progressive combined ratio September?').symbol === 'PGR', '"Progressive" → PGR');
ok(extraeSimboloKpi('Revenue growth (GAAP) Q3?').symbol === null, '"(GAAP)" no es ticker');
ok(kpiDeTitulo('Mastercard (MA) cross-border volume growth Q3 2026?') === 'Mastercard (MA) cross-border volume growth Q3 2026', 'kpi_name: título sin "?"');
ok(kpiDeTitulo('Target comparable sales Q3: 1% to 2%?') === 'Target comparable sales Q3', 'kpi_name: sin el rango', kpiDeTitulo('Target comparable sales Q3: 1% to 2%?'));

console.log('exclusiones');
ok(excluyeTitulo('Will Costco (COST) beat quarterly earnings?') === 'beat_quarterly_earnings', 'beat/miss fuera (tiene su cosecha)');
ok(excluyeTitulo('Will Microsoft say "Azure" 10+ times?') === 'mencion', 'mención fuera');
ok(excluyeTitulo('What will Microsoft say during earnings call?') === 'mencion', 'mención (variante "What will X say") fuera');
ok(excluyeTitulo('Mastercard (MA) cross-border volume growth Q3?') === null, 'un KPI de rangos pasa');

console.log('filasDeEvento: una fila por cajón');
const ma = filasDeEvento(EVENTO_MA, { semilla: 'cross-border' });
ok(ma.motivo === 'ok' && ma.filas.length === 5, 'MA: 5 cajones', ma.motivo + ' ' + ma.filas.length);
const f0 = ma.filas[0];
ok(f0.market_id === '0xma1' && f0.event_slug === EVENTO_MA.slug, 'market_id = conditionId; event_slug del padre');
ok(f0.range_low === null && f0.range_high === 22, '"<22%": range_low NULL');
ok(ma.filas[4].range_low === 28 && ma.filas[4].range_high === null, '"28%+": range_high NULL');
ok(f0.symbol === 'MA' && f0.symbol_via === 'ticker', 'símbolo del título del evento');
ok(f0.price_yes_latest === 0.08 && f0.yes_token_id === 'tok-yes-0xma1', 'precio y token del Yes');
ok(f0.end_date === '2026-10-30T20:00:00Z' && f0.created_at_pm === '2026-10-01T15:00:00Z', 'end_date y created_at_pm');
ok(f0.volume === 12000 && f0.liquidity === 3400, 'volumen y liquidez');
ok(f0.resolved === false && f0.winning_range === null, 'abierto: resolved false, winning_range null');
ok(f0.semilla === 'cross-border', 'recuerda qué semilla lo trajo');

const dk = filasDeEvento(EVENTO_DKS);
ok(dk.motivo === 'ok' && dk.filas.length === 4, 'DKS: rangos desde la pregunta (sin groupItemTitle)', dk.motivo);
ok(dk.filas.every((f) => f.resolved), 'DKS cerrado con precios 0/1 → resueltos');
ok(eq(dk.filas.map((f) => f.winning_range), [false, false, true, false]), 'winning_range por fila: ganó "between 3% and 4%"');
ok(dk.filas[0].symbol === 'DKS', "DKS por alias (DICK'S)");

ok(filasDeEvento(EVENTO_BEAT).motivo === 'beat_quarterly_earnings', 'evento beat/miss → excluido con motivo');
ok(filasDeEvento(EVENTO_MENCION).motivo === 'mencion', 'evento de mención → excluido con motivo');
ok(filasDeEvento(EVENTO_AZURE_SIN_RANGOS).motivo === 'sin_rangos', '"Azure outage" (1 mercado, sin rango) → sin_rangos');

const disputa = { ...EVENTO_MA, markets: EVENTO_MA.markets.map((m) => ({ ...m, closed: true })) };
ok(filasDeEvento(disputa).filas.every((f) => !f.resolved), 'cerrado sin 0/1 limpio (disputa) → NO resuelto');

console.log('conteos y frontera');
const AHORA = Date.parse('2026-10-22T23:20:00Z');
const c = conteos([...ma.filas, ...dk.filas], AHORA);
ok(c.eventos === 2 && c.rangos === 9, '2 eventos, 9 rangos');
ok(c.con_precio_valido === 9 && c.con_precio_vivo === 5, 'precio válido 9 (incluye 0/1 resueltos), vivo 5');
ok(c.con_end_date_futura === 5 && c.eventos_con_end_date_futura === 1, 'end_date futura: los 5 de MA');
ok(veredictoFrontera({ intentos: [{ status: 'ok' }], eventosCrudos: 0 }).estado === 'falla_de_frontera',
  'Gamma contesta pero 0 eventos en TODO → falla de frontera, no "no hay mercados"');
ok(veredictoFrontera({ intentos: [{ status: 'neterror' }], eventosCrudos: 0 }).estado === 'falla_de_frontera', 'ningún ok → falla de frontera');
ok(veredictoFrontera({ intentos: [], eventosCrudos: 0 }).estado === 'falla_de_frontera', 'sin requests → falla de frontera');
ok(veredictoFrontera({ intentos: [{ status: 'ok' }], eventosCrudos: 3 }).estado === 'ok', 'con datos → ok');

console.log('semillas');
ok(SEMILLAS_KPI.length === 15 && new Set(SEMILLAS_KPI).size === 15, '15 semillas, sin repetidas');
ok(FRASES_BUSQUEDA.includes('beat quarterly earnings'), 'las frases del v1 siguen intactas (no se tocan)');

// ── cosechaKpi en seco, con dobles de red ──
function dobleGamma({ porSemilla = {}, eventos = {}, falla422En = null } = {}) {
  const llamadas = [];
  const fn = async (path, params) => {
    llamadas.push({ path, params });
    if (path === '/public-search') {
      if (falla422En && params.q === falla422En.q && (params.page || 1) === falla422En.page) {
        return { status: 'httperror', http: 422, url: 'x', message: 'offset too large' };
      }
      const evs = (params.page || 1) === 1 ? (porSemilla[params.q] || []) : [];
      return { status: 'ok', http: 200, body: busqueda(evs) };
    }
    if (path === '/events') {
      const ev = eventos[params.slug];
      return ev ? { status: 'ok', http: 200, body: [ev] } : { status: 'ok', http: 200, body: [] };
    }
    return { status: 'httperror', http: 404 };
  };
  fn.llamadas = llamadas;
  return fn;
}
const clobVacio = async () => ({ status: 'ok', http: 200, body: { history: [] } });
const TODOS = { [EVENTO_MA.slug]: EVENTO_MA, [EVENTO_DKS.slug]: EVENTO_DKS, [EVENTO_BEAT.slug]: EVENTO_BEAT,
  [EVENTO_MENCION.slug]: EVENTO_MENCION, [EVENTO_AZURE_SIN_RANGOS.slug]: EVENTO_AZURE_SIN_RANGOS };

console.log('cosechaKpi en seco');
const g1 = dobleGamma({
  porSemilla: {
    'cross-border': [EVENTO_MA],
    'volume growth': [EVENTO_MA],                    // duplicado: dedupe por slug
    'comparable sales': [EVENTO_DKS, EVENTO_BEAT],
    'Azure': [EVENTO_MENCION, EVENTO_AZURE_SIN_RANGOS],
  },
  eventos: TODOS,
});
const seco = await cosechaKpi({ gamma: g1, clob: clobVacio, db: null, ahora: new Date(AHORA) });
ok(seco.seco === true && seco.escritura === undefined, 'en seco: no hay escritura');
ok(seco.frontera.estado === 'ok', 'frontera ok');
ok(seco.descubrimiento.eventos_unicos === 5, 'dedupe por event_slug: 5 únicos', seco.descubrimiento.eventos_unicos);
// 'volume growth' va antes que 'cross-border' en SEMILLAS_KPI: se queda el evento.
ok(seco.por_semilla['volume growth'].nuevos === 1 && seco.por_semilla['cross-border'].eventos_crudos === 1
  && seco.por_semilla['cross-border'].nuevos === 0, 'semilla duplicada: lo vio (1) pero no aporta nuevos (0)');
ok(seco.por_semilla['deliveries'].eventos_crudos === 0, 'semilla con 0 → se reporta en 0, no desaparece');
ok(Object.keys(seco.por_semilla).length === 15, 'las 15 semillas en el reporte');
ok(seco.conteos.eventos === 2 && seco.conteos.rangos === 9, 'conteos: 2 eventos KPI, 9 rangos', JSON.stringify(seco.conteos));
ok(seco.filtro.motivos.beat_quarterly_earnings === 1 && seco.filtro.motivos.mencion === 1 && seco.filtro.motivos.sin_rangos === 1,
  'motivos de exclusión contados', JSON.stringify(seco.filtro.motivos));
ok(seco.por_semilla['comparable sales'].eventos_kpi === 1, 'por semilla: eventos KPI aceptados');
ok(seco.hidratacion.ok === 5, 'hidratación por slug: 5');
const md = markdownSeco(seco);
ok(/Semillas con 0 eventos:\*\* .*deliveries/.test(md), 'el markdown NOMBRA las semillas en 0');
ok(/\| rangos \(cajones\) \| 9 \|/.test(md), 'el markdown trae el conteo de rangos');

console.log('422 = parar, sin reintentar');
const g422 = dobleGamma({ porSemilla: { 'comparable sales': [EVENTO_DKS] }, eventos: TODOS, falla422En: { q: 'same store sales', page: 1 } });
const r422 = await cosechaKpi({ gamma: g422, clob: clobVacio, db: null, ahora: new Date(AHORA) });
ok(r422.frontera.estado === 'falla_de_frontera' && /422/.test(r422.frontera.motivo), '422 → falla de frontera, dicha', r422.frontera.motivo);
const llamadas422 = g422.llamadas.filter((l) => l.params.q === 'same store sales');
ok(llamadas422.length === 1, 'la semilla del 422 se pidió UNA vez (sin loop)', llamadas422.length);
ok(g422.llamadas.filter((l) => l.path === '/public-search').length === 2, 'después del 422 no se pide nada más', g422.llamadas.length);
ok(r422.por_semilla['organic sales growth'].status === 'no_corrida_por_422', 'las semillas siguientes quedan marcadas, no en 0');
ok(!g422.llamadas.some((l) => l.path === '/events'), 'ni se hidrata: se paró');

console.log('cero datos = falla de frontera');
const gCero = dobleGamma({});
const rCero = await cosechaKpi({ gamma: gCero, clob: clobVacio, db: null, ahora: new Date(AHORA) });
ok(rCero.frontera.estado === 'falla_de_frontera', 'todas las semillas en 0 → falla_de_frontera', rCero.frontera.estado);
const gCaida = async () => ({ status: 'neterror', message: 'fetch failed' });
const rCaida = await cosechaKpi({ gamma: gCaida, clob: clobVacio, db: null, ahora: new Date(AHORA) });
ok(rCaida.frontera.estado === 'falla_de_frontera' && /ningún request/.test(rCaida.frontera.motivo), 'red caída → falla de frontera');

console.log('cosechaKpi con DB: frontera caída no escribe');
let escribio = false;
const dbEspia = new Proxy({ eventosAbiertos: async () => [] }, {
  get(t, k) { if (k in t) return t[k]; return async () => { escribio = true; return {}; }; },
});
const rNoEscribe = await cosechaKpi({ gamma: gCero, clob: clobVacio, db: dbEspia, ahora: new Date(AHORA) });
ok(rNoEscribe.frontera.estado === 'falla_de_frontera' && !escribio, 'cero datos + DB → no toca la tabla');

console.log('cosechaKpi con DB: abiertos conocidos se re-hidratan aunque la búsqueda no los traiga');
const llamadasDb = [];
const dbFalsa = {
  eventosAbiertos: async () => [EVENTO_DKS.slug],
  preparaFilaKpi: (f, a) => ({ ...f, _ahora: a }),
  upsertMercadosKpi: async (fs) => { llamadasDb.push(['upsert', fs.length]); return { insertados: fs.length, actualizados: 0 }; },
  puntosDeSnapshot: (fs, a) => fs.filter((f) => !f.resolved).map((f) => ({ market_id: f.market_id, ts: a, price_yes: f.price_yes_latest, fuente: 'gamma' })),
  insertaPrecios: async (ps) => { llamadasDb.push(['precios', ps.length]); return { puntos: ps.length }; },
  pendientesClob: async () => [{ market_id: '0xma2', yes_token_id: 'tok', end_date: '2026-10-30T20:00:00Z', created_at_pm: '2026-10-01T15:00:00Z' }],
  marcaBackfill: async (ids) => { llamadasDb.push(['marca', ids.length]); },
  recalculaT24h: async () => ({ actualizados: 0 }),
  statsKpi: async () => ({}),
};
const clobUno = async (path, params) => ({ status: 'ok', http: 200, body: { history: [{ t: params.endTs - 3600, p: 0.4 }, { t: params.endTs, p: 0.41 }] } });
const gDb = dobleGamma({ porSemilla: { 'cross-border': [EVENTO_MA] }, eventos: TODOS });
const rDb = await cosechaKpi({ gamma: gDb, clob: clobUno, db: dbFalsa, ahora: new Date(AHORA) });
ok(rDb.descubrimiento.abiertos_conocidos === 1, 'DKS (conocido, no buscado) entra a la corrida');
ok(eq(llamadasDb[0], ['upsert', 9]), 'upsert de 9 cajones (MA + DKS)', JSON.stringify(llamadasDb));
ok(eq(llamadasDb[1], ['precios', 5]), 'snapshot: solo los 5 abiertos con precio (DKS resuelto no)', JSON.stringify(llamadasDb));
ok(eq(llamadasDb[2], ['precios', 2]) && eq(llamadasDb[3], ['marca', 1]), 'backfill CLOB: 2 puntos, 1 cajón marcado');
const clobRoto = async () => ({ status: 'httperror', http: 500 });
llamadasDb.length = 0;
await cosechaKpi({ gamma: gDb, clob: clobRoto, db: dbFalsa, ahora: new Date(AHORA) });
ok(eq(llamadasDb.find((l) => l[0] === 'marca'), ['marca', 0]), 'CLOB con error NO marca el backfill (se reintenta mañana)');

console.log('markdown de lectura (?job=kpi&format=md)');
const filasMd = [
  { event_slug: 'b', event_title: 'B tarde', symbol: 'TGT', end_date: '2026-11-19T12:00', range_low: 2, range_high: null, range_unit: '%', price_yes_latest: 0.3 },
  { event_slug: 'a', event_title: 'A pronto', symbol: 'MA', end_date: '2026-10-30T20:00', range_low: 22, range_high: 24, range_unit: '%', price_yes_latest: 0.31, price_yes_first_seen: 0.25 },
  { event_slug: 'a', event_title: 'A pronto', symbol: 'MA', end_date: '2026-10-30T20:00', range_low: null, range_high: 22, range_unit: '%', price_yes_latest: 0.08 },
];
const mdL = markdownEventos(filasMd);
ok(mdL.indexOf('A pronto') < mdL.indexOf('B tarde'), 'eventos ordenados por end_date');
ok(mdL.indexOf('< 22%') < mdL.indexOf('22% – 24%'), 'cajones de abajo hacia arriba');
ok(/\| 2%\+ \|/.test(mdL), '"2%+" para el extremo abierto');
ok(/Σ Yes = 0\.390/.test(mdL), 'suma de Yes por evento (chequeo de coherencia)');
ok(/Sin eventos abiertos/.test(markdownEventos([])), 'tabla vacía → lo dice');

if (failures) { console.error(`\n${failures} FALLAS`); process.exit(1); }
console.log('\nTODO VERDE');
