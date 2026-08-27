// ═══════════════════════════════════════════════════════════════
// Tests de /api/rotation-analyze (rotación Value + Momentum, SOLO LECTURA).
//
// Cuatro cosas se prueban con dientes:
//
//   1. SOLO LECTURA. El fetch a Neon está mockeado y CADA query que pasa por
//      la frontera se captura: la aserción central es que TODAS son SELECT.
//      Además se lee el fuente y se verifica que no importa heartbeat,
//      ensurePeadSchema ni el camino de escritura.
//   2. CERO LOOK-AHEAD (la regla dura). El TTM de un rebalanceo suma SOLO
//      trimestres con reported_date ESTRICTAMENTE ANTERIOR a la fecha del
//      rebalanceo — un reporte del mismo día no cuenta, ni aunque sea
//      espectacular. El momentum 12-1 termina un mes antes. El precio del
//      ranking es el cierre PREVIO, no el open que todavía no imprimió.
//   3. Los huecos de datos se DETECTAN y se CUENTAN (eps nulo, trimestres
//      faltantes, dato rancio, restatements) en vez de desaparecer.
//   4. Los umbrales del veredicto son los FIJADOS ANTES DE CORRER, y la
//      cadena entera (ranks → canasta → rotación con costos → veredicto)
//      produce GO / NO-GO / INCONCLUSO donde debe, contra un dataset
//      sintético con combo PLANTADO (GO), sin señal (NO-GO) y con muestra
//      corta (INCONCLUSO).
//
// Correr con `node tests/rotation-analyze.test.mjs`.
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

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const L = await import('../api/_lib/rotation-analyze.js');
const { default: handler } = await import('../api/rotation-analyze.js');

// ═══════════════════ fixture sintético determinista ═══════════════════
//
// LCG (no Math.random): el fixture tiene que dar EXACTAMENTE lo mismo en cada
// corrida, o un test que falla una vez de cada diez no prueba nada.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ANCLA DEL CALENDARIO DEL FIXTURE — fija, NO `new Date()`.
//
// El LCG de arriba existe para que "el fixture dé EXACTAMENTE lo mismo en cada
// corrida". El calendario terminado "ayer" rompía esa promesa por la puerta de
// atrás: los retornos eran los mismos, pero las fechas de rebalanceo (primer
// día hábil del mes) se corrían un día por día contra ellos, así que cada día
// se repartían distinto entre canastas.
//
// No es teórico y no es inofensivo: medido sobre 9 fechas simuladas, este
// archivo fallaba en 5 — con el mismo código de producción, sin que nadie
// tocara nada. Hoy pasa por suerte del calendario. Su gemelo
// tests/dualmom-analyze.test.mjs ya se cayó por esto y ahí está el análisis
// largo de la causa.
//
// Los fixtures son sintéticos y el código que prueban no mira el reloj
// (`api/_lib/rotation-analyze.js` no tiene un solo `Date.now()`), así que un
// calendario "reciente" no compraba realismo: solo compraba un rojo aleatorio.
// (El lint anti "relojes rotos" exime tests justamente por esto.)
const ANCLA_FIXTURE = '2026-06-30T12:00:00Z';   // date-lint-ok: ancla de fixture sintético

const HOY = new Date(ANCLA_FIXTURE);
const AYER = new Date(HOY.getTime() - 86400000).toISOString().slice(0, 10);

function calendarioHabil(n, fin) {
  const out = [];
  const d = new Date(fin + 'T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

const menosDias = (fecha, n) =>
  new Date(Date.parse(fecha + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

// Cada símbolo lleva una "calidad" oculta q ∈ [0,1]:
//   · su earnings yield objetivo es 1% + 10%·q  → el rank VALUE ordena por q
//   · su drift diario es alpha·(q − 0.5)        → el rank MOMENTUM ordena por q
//     y, si alpha > 0, el retorno FUTURO también → el decil combinado gana.
// Con alpha = 0 los ranks siguen ordenando por q pero el futuro es ruido: la
// estrategia no puede ganar nada y los costos la hunden. Ese es el control.
function fabrica({
  nSimbolos = 100, sesiones = 1300, fin = AYER, alpha = 0, semilla = 11,
  trimestreCada = 63, epsNulosEn = null, sinReportesDesde = null,
} = {}) {
  const calendario = calendarioHabil(sesiones, fin);
  const simbolos = Array.from({ length: nSimbolos }, (_, i) => 'R' + String(i).padStart(3, '0'));
  const rp = rng(semilla);
  const series = {};
  const q = {};

  for (let k = 0; k < nSimbolos; k++) {
    const sym = simbolos[k];
    q[sym] = nSimbolos === 1 ? 0.5 : k / (nSimbolos - 1);
    const mu = alpha * (q[sym] - 0.5);
    const opens = [], closes = [];
    let p = 40 + rp() * 80;
    for (let i = 0; i < sesiones; i++) {
      const o = p * (1 + (rp() - 0.5) * 0.004);
      p = o * (1 + mu + (rp() - 0.5) * 0.020);
      opens.push(o); closes.push(p);
    }
    series[sym] = { fechas: calendario, opens, closes };
  }

  // Earnings trimestrales: reported_eps = (yield objetivo × precio) / 4, para
  // que el earnings yield del nombre sea ~constante y ordenado por q aunque el
  // precio derive. fiscal_date_ending 45 días antes del reporte.
  const filas = [];
  for (let k = 0; k < nSimbolos; k++) {
    const sym = simbolos[k];
    const yObjetivo = 0.01 + 0.10 * q[sym];
    for (let i = 8 + (k % trimestreCada); i < sesiones; i += trimestreCada) {
      const fecha = calendario[i];
      if (sinReportesDesde && sym === sinReportesDesde.symbol && fecha >= sinReportesDesde.desde) continue;
      const nulo = epsNulosEn && epsNulosEn.symbol === sym && fecha >= epsNulosEn.desde;
      filas.push({
        symbol: sym,
        fiscal_date_ending: menosDias(fecha, 45),
        reported_date: fecha,
        reported_eps: nulo ? null : (yObjetivo * series[sym].closes[i]) / 4,
      });
    }
  }
  filas.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : (a.reported_date < b.reported_date ? -1 : 1)));

  // SPY: paseo propio, sin el drift plantado.
  const rs = rng(semilla + 13);
  const so = [], sc = [];
  let sp = 400;
  for (let i = 0; i < sesiones; i++) {
    const o = sp * (1 + (rs() - 0.5) * 0.003);
    sp = o * (1 + 0.0002 + (rs() - 0.5) * 0.010);
    so.push(o); sc.push(sp);
  }
  series.SPY = { fechas: calendario, opens: so, closes: sc };

  return { calendario, simbolos, series, filas, q };
}

// ── mocks de red: Neon (POST /sql) + Yahoo (GET chart) ──
let queries = [];
function mockFetch({ filas, series }) {
  queries = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const lista = body.queries || [body];
      for (const qy of lista) queries.push(qy.query);
      const fields = [
        { name: 'symbol', dataTypeID: 25 }, { name: 'fiscal_date_ending', dataTypeID: 25 },
        { name: 'reported_date', dataTypeID: 25 }, { name: 'reported_eps', dataTypeID: 1700 },
      ];
      const rows = filas.map((f) => [f.symbol, f.fiscal_date_ending, f.reported_date,
        f.reported_eps == null ? null : String(f.reported_eps)]);
      return { ok: true, status: 200, json: async () => ({ fields, rows }) };
    }
    const m = u.match(/\/chart\/([^?]+)/);
    const sym = m ? decodeURIComponent(m[1]) : null;
    const s = sym && series[sym];
    if (!s) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: s.fechas.map((d) => Date.parse(d + 'T00:00:00Z') / 1000),
      indicators: {
        quote: [{ open: s.opens, close: s.closes, high: s.closes, low: s.opens, volume: s.opens.map(() => 1e6) }],
        adjclose: [{ adjclose: s.closes }],
      },
    }] } }) };
  };
}

const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

// ═══════════════════ 1. gate del CRON_SECRET ═══════════════════
console.log('rotation-analyze: gate del CRON_SECRET');
{
  const fx = fabrica({ nSimbolos: 3, sesiones: 300 });
  global.fetch = mockFetch(fx);

  const sinAuth = mockRes();
  await handler(GET({}), sinAuth);
  ok(sinAuth.code === 401 && sinAuth.body.error === 'No autorizado.', 'sin secret → 401 "No autorizado."', JSON.stringify(sinAuth.body));
  ok(queries.length === 0, 'un 401 no toca la DB', queries.length);

  const malAuth = mockRes();
  await handler(GET({}, { authorization: 'Bearer nope' }), malAuth);
  ok(malAuth.code === 401, 'secret equivocado → 401', malAuth.code);

  const porQuery = mockRes();
  await handler(GET({ secret: SECRET }), porQuery);
  ok(porQuery.code === 200, '?secret= (para abrirlo en el navegador) → 200', porQuery.code);

  const post = mockRes();
  await handler({ method: 'POST', query: {}, headers: { authorization: `Bearer ${SECRET}` } }, post);
  ok(post.code === 405, 'POST → 405 (endpoint de lectura)', post.code);
}

// ═══════════════════ 2. SOLO LECTURA ═══════════════════
console.log('rotation-analyze: SOLO LECTURA (cero writes a Neon)');
{
  const fx = fabrica({ nSimbolos: 25, sesiones: 900 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);

  const escritura = queries.filter((q) => !/^\s*select/i.test(q));
  ok(res.code === 200, 'responde 200', res.code);
  ok(queries.length > 0, 'sí consulta la DB', queries.length);
  ok(escritura.length === 0, 'TODAS las queries son SELECT (cero writes)', JSON.stringify(escritura));
  ok(!queries.some((q) => /create table|alter table|insert into|update |delete from|truncate/i.test(q)),
    'ni DDL ni DML en ninguna query');
  ok(!queries.some((q) => /cron_heartbeat/i.test(q)), 'no late ningún heartbeat');
  ok(queries.length === 1, 'un solo SELECT a pead_earnings', queries.length);
  ok(res.headers['Cache-Control'] === 'no-store', 'no cachea (lleva secret en la URL)', res.headers['Cache-Control']);

  const src = readFileSync(new URL('../api/rotation-analyze.js', import.meta.url), 'utf8');
  const sinComentarios = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/heartbeat/.test(sinComentarios), 'el código no importa heartbeat');
  ok(!/ensurePeadSchema|ensureSchema/.test(sinComentarios), 'el código no llama ensureSchema/ensurePeadSchema');
  ok(!/pead-harvest|pead-db/.test(sinComentarios), 'no importa el camino de escritura (pead-harvest / pead-db)');
  ok(/export const maxDuration = 300/.test(src), 'maxDuration = 300');

  const lib = readFileSync(new URL('../api/_lib/rotation-analyze.js', import.meta.url), 'utf8');
  ok(!/\bfetch\s*\(|from '\.\/db\.js'/.test(lib.replace(/\/\/.*$/gm, '')), 'el lib de análisis es puro (sin fetch ni DB)');
}

// ═══════════════════ 3. CERO LOOK-AHEAD ═══════════════════
console.log('rotation-analyze: cero look-ahead (TTM point-in-time y momentum 12-1)');
{
  const C = L.CRITERIOS;
  const ev = (reported, eps, fiscal) => ({ reported_date: reported, fiscal_date_ending: fiscal || menosDias(reported, 45), reported_eps: eps });
  // 4 trimestres publicados + uno ENORME publicado el MISMO día del rebalanceo.
  const base = [
    ev('2025-02-10', 1), ev('2025-05-12', 1), ev('2025-08-11', 1), ev('2025-11-10', 1),
  ];
  const conTrampa = [...base, ev('2026-02-02', 999)];
  const r1 = L.ttmPointInTime(base, '2026-02-02');
  const r2 = L.ttmPointInTime(conTrampa, '2026-02-02');
  ok(r1.ttm === 4, 'TTM = suma de los 4 trimestres previos', r1.ttm);
  ok(r2.ttm === 4, 'un reporte del MISMO día del rebalanceo NO entra (regla dura)', r2.ttm);
  const r3 = L.ttmPointInTime(conTrampa, '2026-02-03');
  ok(r3.ttm === 999 + 3, 'al día siguiente sí entra (y desplaza al más viejo)', r3.ttm);
  ok(r1.ultimo_reporte < '2026-02-02', 'el último reporte usado es anterior a la fecha', r1.ultimo_reporte);

  // Momentum 12-1: la ventana termina un mes ANTES del rebalanceo.
  const cal = L.primerosHabilesDelMes; // (referencia usada abajo)
  const calendario = calendarioHabil(600, AYER);
  const fecha = calendario[500];
  const closes = calendario.map((_, i) => 100 * (1 + i / 1000));
  const mom = L.momentum121(closes, fecha, C, calendario);
  const iFin = L.indiceHasta(calendario, L.restaMeses(fecha, 1));
  const iIni = L.indiceHasta(calendario, L.restaMeses(fecha, 12));
  ok(Math.abs(mom - (closes[iFin] / closes[iIni] - 1)) < 1e-12, 'momentum = close(t−1m)/close(t−12m) − 1', mom);
  ok(iFin < 500 && calendario[iFin] <= L.restaMeses(fecha, 1), 'la ventana termina ANTES del último mes (no toca el mes del rebalanceo)');
  ok(L.momentum121(closes, calendario[5], C, calendario) === null, 'sin 12 meses de historia → null (no se inventa momentum)');

  // El precio del ranking es el cierre PREVIO, no el open del día del fill.
  const src = readFileSync(new URL('../api/_lib/rotation-analyze.js', import.meta.url), 'utf8');
  ok(/precioYield === 'open' \? serie\.opens\[i\] : cierreVigente\(serie\.closes, i - 1\)/.test(src),
    'el yield de la principal usa cierreVigente(closes, i−1)');
  ok(typeof cal === 'function', 'primerosHabilesDelMes exportada');
}

// ═══════════════════ 4. primitivas ═══════════════════
console.log('rotation-analyze: primitivas (fechas, ranks, anualización)');
{
  ok(L.restaMeses('2026-03-31', 1) === '2026-02-28', 'restaMeses hace clamp de fin de mes', L.restaMeses('2026-03-31', 1));
  ok(L.restaMeses('2026-01-15', 12) === '2025-01-15', '12 meses atrás = mismo día del año anterior', L.restaMeses('2026-01-15', 12));
  ok(L.diasEntre('2026-01-01', '2026-01-31') === 30, 'diasEntre cuenta días calendario', L.diasEntre('2026-01-01', '2026-01-31'));

  const cal = ['2026-01-02', '2026-01-05', '2026-02-02', '2026-02-03', '2026-03-02', '2026-04-01'];
  const pr = L.primerosHabilesDelMes(cal);
  ok(JSON.stringify(pr) === JSON.stringify([2, 4, 5]), 'primer hábil de cada mes (el índice 0 se salta: mes incompleto)', JSON.stringify(pr));
  const cada2 = L.primerosHabilesDelMes(cal, { cadaMeses: 2 });
  ok(JSON.stringify(cada2) === JSON.stringify([2, 5]), 'cadaMeses=2 toma uno de cada dos', JSON.stringify(cada2));
  const desde = L.primerosHabilesDelMes(cal, { desde: '2026-03-01' });
  ok(JSON.stringify(desde) === JSON.stringify([4, 5]), 'el filtro `desde` recorta la ventana', JSON.stringify(desde));

  ok(L.indiceHasta(cal, '2026-02-02') === 2 && L.indiceHasta(cal, '2026-02-28') === 3,
    'indiceHasta = última sesión <= la fecha');
  ok(L.indiceHasta(cal, '2020-01-01') === -1, 'sin sesión anterior → −1');

  const r = L.rankPercentil([10, 20, 30, 40, 50]);
  ok(JSON.stringify(r) === JSON.stringify([0, 0.25, 0.5, 0.75, 1]), 'rank percentil en [0,1]', JSON.stringify(r));
  const emp = L.rankPercentil([5, 5, 9]);
  ok(emp[0] === 0.25 && emp[1] === 0.25 && emp[2] === 1, 'empates promediados', JSON.stringify(emp));
  ok(JSON.stringify(L.rankPercentil([7])) === '[0.5]', 'un solo valor → 0.5 (no divide por cero)');

  const diarios = Array.from({ length: 252 }, () => 0.001);
  ok(Math.abs(L.anualizado(diarios) - (1.001 ** 252 - 1)) < 1e-12, 'anualizado compone 252 sesiones', L.anualizado(diarios));
  ok(L.anualizado([]) === null, 'sin retornos → null');
}

// ═══════════════════ 5. huecos de datos: se detectan y se CUENTAN ═══════════════════
console.log('rotation-analyze: los huecos de TTM se detectan (no desaparecen)');
{
  const C = L.CRITERIOS;
  const ev = (reported, eps, fiscal) => ({ reported_date: reported, fiscal_date_ending: fiscal || menosDias(reported, 45), reported_eps: eps });
  const F = '2026-02-02';

  ok(L.ttmPointInTime([ev('2025-05-12', 1), ev('2025-08-11', 1), ev('2025-11-10', 1)], F).motivo === 'pocos_trimestres',
    'menos de 4 trimestres → pocos_trimestres');
  ok(L.ttmPointInTime([ev('2025-02-10', 1), ev('2025-05-12', null), ev('2025-08-11', 1), ev('2025-11-10', 1)], F).motivo === 'eps_nulo',
    'un reported_eps nulo entre los 4 → eps_nulo (NO se suma como cero)');
  ok(L.ttmPointInTime([ev('2025-02-10', 1, 'FQ1'), ev('2025-05-12', 1, 'FQ1'), ev('2025-08-11', 1, 'FQ3'), ev('2025-11-10', 1, 'FQ4')], F).motivo === 'trimestres_duplicados',
    'dos filas del mismo fiscal_date_ending → trimestres_duplicados (restatement)');
  ok(L.ttmPointInTime([ev('2024-02-10', 1), ev('2024-05-12', 1), ev('2024-08-11', 1), ev('2024-11-10', 1)], F).motivo === 'rancio',
    `sin reportes en más de ${C.max_dias_desde_ultimo_reporte} días → rancio`);
  ok(L.ttmPointInTime([ev('2024-01-10', 1), ev('2025-05-12', 1), ev('2025-08-11', 1), ev('2025-11-10', 1)], F).motivo === 'span_excedido',
    `4 trimestres que no caben en ${C.max_span_ttm_dias} días → span_excedido (falta un trimestre)`);
  ok(L.ttmPointInTime([ev('2025-02-10', 2), ev('2025-05-12', -1), ev('2025-08-11', 1), ev('2025-11-10', 0.5)], F).ttm === 2.5,
    'un trimestre en PÉRDIDA se suma con su signo (no se descarta)');

  // La contabilidad cuadra sobre el fixture: elegibles + exclusiones = universo × rebalanceos.
  const fx = fabrica({ nSimbolos: 30, sesiones: 1300 });
  const seriesAlineadas = {};
  for (const s of fx.simbolos) seriesAlineadas[s] = L.alineaAlCalendario(fx.series[s], fx.calendario);
  const porSimbolo = {};
  for (const f of fx.filas) (porSimbolo[f.symbol] ||= []).push(f);
  const iRebal = L.primerosHabilesDelMes(fx.calendario, { desde: fx.calendario[fx.calendario.length - 1 - 756] });
  const { canastas, motivos } = L.construyeCanastas({
    eventosPorSimbolo: porSimbolo, simbolos: fx.simbolos, calendario: fx.calendario,
    seriesAlineadas, iRebalanceos: iRebal,
  });
  const elegibles = canastas.reduce((a, c) => a + c.elegibles, 0);
  const excluidos = Object.values(motivos).reduce((a, b) => a + b, 0);
  ok(elegibles + excluidos === fx.simbolos.length * iRebal.length,
    'elegibles + exclusiones = símbolos × rebalanceos (nada desaparece en silencio)',
    `${elegibles}+${excluidos} vs ${fx.simbolos.length * iRebal.length}`);

  // Un símbolo que deja de reportar sale por "rancio", contado.
  const fx2 = fabrica({ nSimbolos: 30, sesiones: 1300, sinReportesDesde: { symbol: 'R005', desde: fx.calendario[400] } });
  const porSimbolo2 = {};
  for (const f of fx2.filas) (porSimbolo2[f.symbol] ||= []).push(f);
  const seriesAlineadas2 = {};
  for (const s of fx2.simbolos) seriesAlineadas2[s] = L.alineaAlCalendario(fx2.series[s], fx2.calendario);
  const r2 = L.construyeCanastas({
    eventosPorSimbolo: porSimbolo2, simbolos: fx2.simbolos, calendario: fx2.calendario,
    seriesAlineadas: seriesAlineadas2, iRebalanceos: iRebal,
  });
  ok(r2.motivos.rancio > motivos.rancio, 'el símbolo que deja de reportar se cuenta como rancio', `${r2.motivos.rancio} vs ${motivos.rancio}`);
  ok(!r2.canastas.some((c) => c.nombres.includes('R005') && c.fecha > fx.calendario[600]),
    'y deja de poder entrar a la canasta con datos viejos');
}

// ═══════════════════ 6. rotación: turnover real y 10 bp por lado ═══════════════════
console.log('rotation-analyze: costos sobre el turnover REAL');
{
  const cal = Array.from({ length: 30 }, (_, i) => 'D' + String(i).padStart(2, '0'));
  const plana = { opens: cal.map(() => 100), closes: cal.map(() => 100) };
  const seriesAlineadas = { A: { ...plana }, B: { ...plana }, C: { ...plana }, D: { ...plana } };
  const canastas = [
    { i: 0, fecha: cal[0], elegibles: 4, nombres: ['A', 'B'] },
    { i: 10, fecha: cal[10], elegibles: 4, nombres: ['C', 'D'] },
  ];
  const sim = L.simulaRotacion({ canastas, seriesAlineadas, calendario: cal, costo: 0.0010 });
  ok(Math.abs(sim.turnover_medio - 1.5) < 1e-12, 'turnover: 100% al armar + 200% al rotar entero → medio 150%', sim.turnover_medio);
  // equity tras el primer fill: 1 − 0.001. Tras el segundo: ×(1 − 0.002).
  const esperado = (1 - 0.0010) * (1 - 0.0020);
  ok(Math.abs(sim.equity_final - esperado) < 1e-12, '10 bp por lado sobre el notional negociado', `${sim.equity_final} vs ${esperado}`);
  const bruto = L.simulaRotacion({ canastas, seriesAlineadas, calendario: cal, costo: 0 });
  ok(Math.abs(bruto.equity_final - 1) < 1e-12, 'con precios planos y sin costos la equity no se mueve', bruto.equity_final);

  // Rotación PARCIAL: el nombre que se queda no paga turnover.
  const parcial = [
    { i: 0, fecha: cal[0], elegibles: 4, nombres: ['A', 'B'] },
    { i: 10, fecha: cal[10], elegibles: 4, nombres: ['B', 'C'] },
  ];
  const simP = L.simulaRotacion({ canastas: parcial, seriesAlineadas, calendario: cal, costo: 0.0010 });
  ok(Math.abs(simP.turnover_mediana - 1.0) < 1e-9, 'rotar la mitad de la canasta = 100% de turnover (vender A + comprar C)', simP.turnover_mediana);

  // Un rebalanceo sin nombres colocables deja el capital en EFECTIVO (no lo
  // evapora): la equity se queda quieta en vez de irse a cero.
  const sinNombres = [
    { i: 0, fecha: cal[0], elegibles: 4, nombres: ['A'] },
    { i: 10, fecha: cal[10], elegibles: 4, nombres: [] },
  ];
  const simV = L.simulaRotacion({ canastas: sinNombres, seriesAlineadas, calendario: cal, costo: 0 });
  ok(Math.abs(simV.equity_final - 1) < 1e-12, 'canasta vacía → el capital queda en efectivo, no se evapora', simV.equity_final);

  // Los pesos DERIVAN entre rebalanceos (no hay re-equiponderación diaria).
  const suben = { opens: cal.map(() => 100), closes: cal.map((_, i) => 100 * 1.05 ** i) };
  const series2 = { A: suben, B: { ...plana } };
  const uno = [{ i: 0, fecha: cal[0], elegibles: 2, nombres: ['A', 'B'] }];
  const simD = L.simulaRotacion({ canastas: uno, seriesAlineadas: series2, calendario: cal, costo: 0 });
  ok(simD.turnover_medio === 1, 'un solo rebalanceo: 100% de turnover y nada más', simD.turnover_medio);
  ok(simD.equity_final > 1.5, 'la posición ganadora crece sin que la cartera la recorte a diario', simD.equity_final);
}

// ═══════════════════ 7. veredicto contra los umbrales congelados ═══════════════════
console.log('rotation-analyze: veredicto GO / NO-GO / INCONCLUSO');
{
  const C = L.CRITERIOS;
  ok(C.min_rebalanceos === 30 && C.min_nombres_promedio === 8 && C.t_minimo === 2
    && C.sharpe_min === 0.9 && C.exceso_anual_min === 0.02 && C.fraccion_decil === 0.10
    && C.fraccion_quintil === 0.20 && C.costo_por_lado === 0.0010 && C.t_go_fragil_max === 2.5,
    'los umbrales son los FIJADOS ANTES DE CORRER', JSON.stringify(C));

  // ── INCONCLUSO: ventana corta (regla dura, no "casi") ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 700, alpha: 0.0015 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({ anios: 1 }, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.rebalanceos_completos < 30, 'menos de 30 rebalanceos completos', b.principal.muestra.rebalanceos_completos);
    ok(b.veredicto === 'INCONCLUSO', 'muestra corta → INCONCLUSO aunque el combo plantado sea enorme', b.veredicto);
  }

  // ── INCONCLUSO: canastas de menos de 8 nombres ──
  {
    const fx = fabrica({ nSimbolos: 40, sesiones: 1300, alpha: 0.0015 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.rebalanceos_completos >= 30, 'rebalanceos de sobra', b.principal.muestra.rebalanceos_completos);
    ok(b.principal.muestra.nombres_promedio < 8, 'pero el decil de 40 nombres deja canastas de 4', b.principal.muestra.nombres_promedio);
    ok(b.veredicto === 'INCONCLUSO', '< 8 nombres promedio → INCONCLUSO sin importar los números', b.veredicto);
    const md = mockRes();
    await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
    ok(/VEREDICTO: INCONCLUSO/.test(md.text), 'el markdown reporta INCONCLUSO');
    ok(/no "casi"/.test(md.text), 'y dice que la regla se fijó de antemano');
  }

  // ── GO: combo plantado fuerte ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1300, alpha: 0.0015 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.rebalanceos_completos >= 30, 'rebalanceos completos sobre el piso', b.principal.muestra.rebalanceos_completos);
    ok(b.principal.muestra.nombres_promedio >= 8, 'canastas de ~10 nombres', b.principal.muestra.nombres_promedio);
    ok(Math.abs(b.principal.senal.t) >= 2, '|t| ≥ 2 con el combo plantado', b.principal.senal.t);
    ok(b.principal.economia.sharpe_neto >= 0.9, 'Sharpe neto sobre el umbral', b.principal.economia.sharpe_neto);
    ok(b.principal.economia.exceso_anual >= 0.02, 'exceso sobre SPY ≥ 2 pp', b.principal.economia.exceso_anual);
    ok(b.veredicto === 'GO', 'los criterios en verde → GO', b.veredicto);
    ok(b.viabilidad_ttm.viable === true, 'el TTM point-in-time se reporta VIABLE', JSON.stringify(b.viabilidad_ttm.nota));
    ok(b.principal.economia.ret_total_neto < b.principal.economia.ret_total_bruto, 'el neto es menor que el bruto (los costos se pagan)');

    // Sensibilidades obligatorias, todas presentes y etiquetadas.
    const etiquetas = b.sensibilidades.map((s) => s.resultado.etiqueta).join(',');
    ok(etiquetas === 'quintil,solo_value,solo_momentum,bimestral', 'las 4 sensibilidades obligatorias están', etiquetas);
    ok(b.sensibilidades[0].resultado.muestra.nombres_promedio > b.principal.muestra.nombres_promedio,
      'el quintil arma canastas más grandes que el decil');
    ok(b.sensibilidades[3].resultado.muestra.rebalanceos_ejecutados < b.principal.muestra.rebalanceos_ejecutados,
      'el bimestral rebalancea la mitad de las veces');
    ok(typeof b.nota_bimestral === 'string' && /ARITMÉTICO/.test(b.nota_bimestral),
      'y se avisa que su INCONCLUSO es de muestra, no de señal', b.nota_bimestral);
    ok(b.exploratorio.every((e) => e.etiqueta === 'EXPLORATORIO'), 'todo corte extra va etiquetado EXPLORATORIO');
    ok(b.principal.detalle_canastas === undefined, 'sin ?canastas=1 no viaja el detalle canasta a canasta');
    ok(/supervivencia/i.test(b.caveat) && /INFLA/.test(b.caveat), 'el caveat de supervivencia viaja en la respuesta');

    const conDetalle = mockRes();
    await handler(GET({ canastas: '1' }, { authorization: `Bearer ${SECRET}` }), conDetalle);
    const det = conDetalle.body.principal.detalle_canastas;
    ok(Array.isArray(det) && det[0].detalle.length === det[0].nombres.length, 'con ?canastas=1 sí viaja el detalle');
    // El decil plantado tiene que estar poblado por nombres de q alta.
    const medias = det.map((c) => L.media(c.nombres.map((s) => fx.q[s])));
    ok(L.media(medias) > 0.75, 'el decil combinado selecciona los nombres de calidad alta', L.media(medias));

    // markdown
    const md = mockRes();
    await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
    ok(md.headers['Content-Type'] === 'text/plain; charset=utf-8', 'format=md → text/plain');
    ok(/VEREDICTO: GO/.test(md.text), 'el markdown abre con el veredicto');
    ok(md.text.split('\n').filter((l) => l.startsWith('| ')).every((l) => l.split('|').length === 5),
      'todas las filas de la tabla tienen exactamente 3 columnas (ningún pipe suelto)');
    for (const clave of ['≥ 30 rebalanceos mensuales completos', '≥ 8 nombres promedio por canasta',
      't ≥ 2 en valor absoluto', 'Sharpe neto ≥ 0.9', 'SPY + 2%']) {
      ok(md.text.includes(clave), `el markdown lista el criterio "${clave}"`);
    }
    ok(/Solo VALUE/.test(md.text) && /Solo MOMENTUM/.test(md.text) && /Quintil/.test(md.text) && /cada 2 meses/.test(md.text),
      'el markdown trae las 4 sensibilidades obligatorias');
    ok(/EXPLORATORIO/.test(md.text), 'el markdown marca los cortes exploratorios');
    ok(/sesgo de supervivencia/i.test(md.text), 'el markdown cierra con el caveat de supervivencia');
    ok(/TTM point-in-time desde `pead_earnings` es viable/.test(md.text), 'el markdown contesta si el TTM es viable ANTES que nada');
  }

  // ── GO FRÁGIL: el t apenas pasa ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1300, alpha: 0.0015 });
    const seriesAlineadas = {};
    for (const s of fx.simbolos) seriesAlineadas[s] = L.alineaAlCalendario(fx.series[s], fx.calendario);
    const spy = L.alineaAlCalendario(fx.series.SPY, fx.calendario);
    const porSimbolo = {};
    for (const f of fx.filas) (porSimbolo[f.symbol] ||= []).push(f);
    // Mismo dataset, umbral de fragilidad subido: el GO tiene que salir FRÁGIL.
    const criterios = { ...L.CRITERIOS, t_go_fragil_max: 99 };
    const b = L.corre({
      eventosPorSimbolo: porSimbolo, simbolos: fx.simbolos, calendario: fx.calendario, seriesAlineadas,
      spyOpens: spy.opens, spyCloses: spy.closes,
      desde: fx.calendario[fx.calendario.length - 1 - 756], criterios,
    });
    ok(b.veredicto === 'GO' && b.fragil === true, 'un GO con t bajo el corte de fragilidad se marca FRÁGIL', `${b.veredicto}/${b.fragil}`);
    ok(L.etiquetaVeredicto(b) === 'GO FRÁGIL', 'y se renderiza como "GO FRÁGIL"', L.etiquetaVeredicto(b));
  }

  // ── NO-GO: mismos datos, sin señal plantada ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1300, alpha: 0 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.cumple.muestra === true, 'muestra suficiente (el veredicto NO es por falta de datos)',
      `${b.principal.muestra.rebalanceos_completos}/${b.principal.muestra.nombres_promedio}`);
    ok(b.veredicto === 'NO-GO', 'sin señal → NO-GO', b.veredicto);
    ok(b.principal.cumple.economia === false, 'la economía no llega (los costos se comen el ruido)',
      JSON.stringify(b.principal.economia));
    ok(b.go_fragil === false, 'un NO-GO no se marca frágil');

    // El §2 es de DOS COLAS: si el t pasa el umbral pero es NEGATIVO, el
    // markdown no puede dejar un ✅ mudo — la señal apunta en contra.
    if (b.principal.senal.t <= -2) {
      const md = mockRes();
      await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
      ok(/t es NEGATIVO/.test(md.text) && /pierde contra SPY/.test(md.text),
        'un t significativo pero negativo se explica (dos colas, no media victoria)');
    }
  }
}

// ═══════════════════ 8. viabilidad del TTM cuando los datos NO alcanzan ═══════════════════
console.log('rotation-analyze: si el TTM point-in-time no alcanza, se DICE');
{
  // Cosecha de un solo trimestre por símbolo: nunca hay 4 → cero elegibles.
  const fx = fabrica({ nSimbolos: 100, sesiones: 1300, trimestreCada: 1300 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;
  ok(b.viabilidad_ttm.viable === false, 'con menos de 4 trimestres por símbolo el TTM NO es viable');
  ok(/NO sostiene el backtest/.test(b.viabilidad_ttm.nota), 'y se dice explícitamente', b.viabilidad_ttm.nota);
  ok(/no se improvisa otra fuente/i.test(b.viabilidad_ttm.nota), 'sin improvisar otra fuente de EPS');
  ok(b.viabilidad_ttm.exclusiones_por_hueco_de_ttm > 0, 'las exclusiones por hueco de TTM se cuentan', b.viabilidad_ttm.exclusiones_por_hueco_de_ttm);
  ok(b.veredicto === 'INCONCLUSO', 'y el veredicto es INCONCLUSO (no NO-GO)', b.veredicto);

  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/\*\*NO\*\*/.test(md.text), 'el markdown contesta NO a la pregunta de viabilidad');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
