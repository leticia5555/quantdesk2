// ═══════════════════════════════════════════════════════════════
// Tests de /api/pead-analyze (FASE 2 del PEAD, SOLO LECTURA).
//
// Tres cosas se prueban con dientes:
//
//   1. SOLO LECTURA. El fetch a Neon está mockeado y CADA query que pasa por
//      la frontera se captura: la aserción central es que TODAS son SELECT.
//      Además se lee el fuente y se verifica que no importa heartbeat,
//      ensurePeadSchema ni el cron de cosecha.
//   2. CERO LOOK-AHEAD. La entrada es la PRIMERA apertura posterior al
//      reporte: BMO → open del mismo día, AMC/DMH → open del día siguiente,
//      y los eventos sin hora se tratan como AMC en la principal (tratarlos
//      como BMO podría comprar en una apertura anterior al anuncio).
//   3. Los umbrales del veredicto son los FIJADOS ANTES DE CORRER, y la
//      cadena entera (decil → calendar-time → simulación → veredicto)
//      produce GO / NO-GO / INCONCLUSO donde debe, contra un dataset
//      sintético con drift PLANTADO (GO), sin drift (NO-GO) y con muestra
//      corta (INCONCLUSO).
//
// Correr con `node tests/pead-analyze.test.mjs`.
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

const L = await import('../api/_lib/pead-analyze.js');
const { default: handler, extraeSerieAjustada } = await import('../api/pead-analyze.js');

// ═══════════════════ fixture sintético determinista ═══════════════════
//
// LCG (no Math.random): el fixture tiene que dar EXACTAMENTE lo mismo en cada
// corrida, o un test que falla una vez de cada diez no prueba nada.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// n sesiones hábiles terminando en `fin` (YYYY-MM-DD). Sin feriados: el
// calendario canónico del análisis es el de SPY, así que basta con que sea
// consistente entre símbolos.
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

// Construye eventos + series. `driftPlantado` = retorno diario extra inyectado
// en las 10 sesiones posteriores a la entrada de los eventos del decil superior.
function fabrica({ nSimbolos = 100, sesiones = 1100, fin = '2026-06-30', driftPlantado = 0, semilla = 7 } = {}) {
  const calendario = calendarioHabil(sesiones, fin);
  const r = rng(semilla);
  const simbolos = Array.from({ length: nSimbolos }, (_, i) => 'S' + String(i).padStart(3, '0'));

  // 1) eventos con sorpresa determinista y hora repartida
  const eventos = [];
  for (let k = 0; k < simbolos.length; k++) {
    const sym = simbolos[k];
    for (let i = 20 + (k % 60); i < sesiones - 15; i += 63) {
      const u = r();
      const surprise_pct = u < 0.25 ? -(r() * 40) : r() * 120;   // 25% negativas
      const hu = r();
      const hour = hu < 0.35 ? 'bmo' : hu < 0.95 ? 'amc' : null;
      eventos.push({
        symbol: sym, reported_date: calendario[i], hour,
        hour_source: hour ? 'sec_8k' : null,
        surprise: surprise_pct / 100, surprise_pct,
      });
    }
  }

  // 2) qué eventos caen en el decil superior (para saber dónde plantar drift).
  //    Se replica el corte del lib sobre TODOS los positivos del fixture.
  const positivos = eventos.filter((e) => e.surprise_pct > 0).map((e) => e.surprise_pct).sort((a, b) => a - b);
  const corte = L.percentil(positivos, 0.90);

  // 3) series: paseo aleatorio suave + el drift plantado donde toca
  const rp = rng(semilla + 991);
  const series = {};
  const idx = new Map(calendario.map((d, i) => [d, i]));
  for (const sym of simbolos) {
    const closes = [], opens = [];
    let p = 40 + rp() * 120;
    for (let i = 0; i < sesiones; i++) {
      const o = p * (1 + (rp() - 0.5) * 0.004);
      p = o * (1 + (rp() - 0.5) * 0.010);
      opens.push(o); closes.push(p);
    }
    series[sym] = { fechas: calendario, opens, closes };
  }
  if (driftPlantado) {
    for (const ev of eventos) {
      if (!(ev.surprise_pct >= corte)) continue;
      const hora = L.horaEfectiva(ev.hour, 'amc');
      const i = L.indiceEntrada(calendario, ev.reported_date, hora);
      if (i < 1) continue;
      const s = series[ev.symbol];
      // Escalón compuesto: 10 sesiones de drift y el nivel se queda arriba
      // (si se revirtiera, el drift sería un artefacto del fixture, no una señal).
      for (let d = i; d < sesiones; d++) {
        const pasos = Math.min(d - i + 1, 10);
        const f = (1 + driftPlantado) ** pasos;
        // El open del día de entrada NO se toca: se compra antes del drift.
        if (d > i) s.opens[d] *= f;
        s.closes[d] *= f;
      }
    }
  }

  // 4) SPY: paseo propio, sin drift plantado
  const rs = rng(semilla + 13);
  const so = [], sc = [];
  let sp = 400;
  for (let i = 0; i < sesiones; i++) {
    const o = sp * (1 + (rs() - 0.5) * 0.003);
    sp = o * (1 + (rs() - 0.5) * 0.008);
    so.push(o); sc.push(sp);
  }
  series.SPY = { fechas: calendario, opens: so, closes: sc };

  return { calendario, eventos, series, simbolos, corte, idx };
}

// ── mocks de red: Neon (POST /sql) + Yahoo (GET chart) ──
let queries = [];
function mockFetch({ eventos, series }) {
  queries = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const lista = body.queries || [body];
      for (const q of lista) queries.push(q.query);
      const fields = [
        { name: 'symbol', dataTypeID: 25 }, { name: 'reported_date', dataTypeID: 25 },
        { name: 'reported_eps', dataTypeID: 1700 }, { name: 'estimated_eps', dataTypeID: 1700 },
        { name: 'surprise', dataTypeID: 1700 }, { name: 'surprise_pct', dataTypeID: 1700 },
        { name: 'hour', dataTypeID: 25 }, { name: 'hour_source', dataTypeID: 25 },
      ];
      const rows = eventos.map((e) => [e.symbol, e.reported_date, '1', '0.9',
        String(e.surprise), String(e.surprise_pct), e.hour, e.hour_source]);
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
        // adjclose == close en el fixture: el ajuste se prueba aparte, en
        // extraeSerieAjustada(), con un factor distinto de 1.
        adjclose: [{ adjclose: s.closes }],
      },
    }] } }) };
  };
}

const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

// ═══════════════════ 1. gate del CRON_SECRET ═══════════════════
console.log('pead-analyze: gate del CRON_SECRET');
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
console.log('pead-analyze: SOLO LECTURA (cero writes a Neon)');
{
  const fx = fabrica({ nSimbolos: 6, sesiones: 400 });
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
  ok(res.headers['Cache-Control'] === 'no-store', 'no cachea (lleva secret en la URL)', res.headers['Cache-Control']);

  const src = readFileSync(new URL('../api/pead-analyze.js', import.meta.url), 'utf8');
  const sinComentarios = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/heartbeat/.test(sinComentarios), 'el código no importa heartbeat');
  ok(!/ensurePeadSchema|ensureSchema/.test(sinComentarios), 'el código no llama ensureSchema/ensurePeadSchema');
  ok(!/pead-harvest|pead-db/.test(sinComentarios), 'no importa el camino de escritura (pead-harvest / pead-db)');
  ok(/export const maxDuration = 300/.test(src), 'maxDuration = 300');

  const lib = readFileSync(new URL('../api/_lib/pead-analyze.js', import.meta.url), 'utf8');
  ok(!/\bfetch\s*\(|from '\.\/db\.js'/.test(lib.replace(/\/\/.*$/gm, '')), 'el lib de análisis es puro (sin fetch ni DB)');
}

// ═══════════════════ 3. CERO LOOK-AHEAD ═══════════════════
console.log('pead-analyze: cero look-ahead en la alineación de la entrada');
{
  const cal = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09'];

  ok(L.indiceEntrada(cal, '2026-03-04', 'bmo') === 2, 'BMO → open del MISMO día del reporte');
  ok(L.indiceEntrada(cal, '2026-03-04', 'amc') === 3, 'AMC → open del día SIGUIENTE');
  // Reporte en sábado: la primera apertura posterior es el lunes, en ambas ramas.
  ok(L.indiceEntrada(cal, '2026-03-07', 'bmo') === 5, 'BMO con reporte en fin de semana → siguiente sesión');
  ok(L.indiceEntrada(cal, '2026-03-07', 'amc') === 5, 'AMC con reporte en fin de semana → siguiente sesión');
  ok(L.indiceEntrada(cal, '2026-03-09', 'amc') === -1, 'AMC sin sesión posterior → sin entrada (no se inventa)');

  ok(L.horaEfectiva('dmh', 'amc') === 'amc', 'DMH → AMC (con el mercado abierto, la primera apertura es la del día siguiente)');
  ok(L.horaEfectiva(null, 'amc') === 'amc', 'sin hora en la PRINCIPAL → AMC (conservador, nunca look-ahead)');
  ok(L.horaEfectiva(null, 'bmo') === 'bmo', 'sin hora en la sensibilidad todo-BMO → BMO');
  ok(L.horaEfectiva(null, 'drop') === null, 'sin hora en la sensibilidad de descarte → fuera');
  ok(L.horaEfectiva('BMO', 'amc') === 'bmo' && L.horaEfectiva('AMC', 'bmo') === 'amc',
    'una hora etiquetada manda sobre la política (mayúsculas incluidas)');

  // Invariante sobre la muestra completa del fixture: ninguna entrada AMC cae
  // en o antes del día del reporte, y ninguna BMO cae antes.
  const fx = fabrica({ nSimbolos: 20, sesiones: 900 });
  const alineadas = {};
  for (const s of fx.simbolos) alineadas[s] = L.alineaAlCalendario(fx.series[s], fx.calendario);
  const { operables } = L.construyeMuestra({
    eventos: fx.eventos, calendario: fx.calendario, seriesAlineadas: alineadas, politicaHora: 'amc',
  });
  const malAmc = operables.filter((e) => e.hora_efectiva === 'amc' && e.fecha_entrada <= e.reported_date);
  const malBmo = operables.filter((e) => e.hora_efectiva === 'bmo' && e.fecha_entrada < e.reported_date);
  ok(operables.length > 200, 'el fixture produce muestra suficiente para el invariante', operables.length);
  ok(malAmc.length === 0, 'ninguna entrada AMC es <= la fecha del reporte', JSON.stringify(malAmc.slice(0, 3)));
  ok(malBmo.length === 0, 'ninguna entrada BMO es anterior a la fecha del reporte', JSON.stringify(malBmo.slice(0, 3)));
  // Y es la PRIMERA apertura posterior, no una más lejana.
  const noPrimera = operables.filter((e) => {
    const esperado = L.indiceEntrada(fx.calendario, e.reported_date, e.hora_efectiva);
    return esperado !== e.i_entrada;
  });
  ok(noPrimera.length === 0, 'la entrada es SIEMPRE la primera apertura posible', noPrimera.length);

  // La vela en curso se recorta (misma convención que completedSlice de sim.js).
  const hoy = new Date('2026-08-19T15:00:00Z');
  const serie = { fechas: ['2026-08-17', '2026-08-18', '2026-08-19'], opens: [1, 2, 3], closes: [1, 2, 3] };
  ok(L.recortaVelasIncompletas(serie, hoy).fechas.length === 2, 'antes de las 22 UTC se corta la vela de hoy');
  ok(L.recortaVelasIncompletas(serie, new Date('2026-08-19T23:00:00Z')).fechas.length === 3,
    'después de las 22 UTC la vela de hoy ya cerró');
}

// ═══════════════════ 4. primitivas estadísticas ═══════════════════
console.log('pead-analyze: primitivas');
{
  ok(L.percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.90) === 9, 'percentil 90 por rango-más-cercano', L.percentil([1,2,3,4,5,6,7,8,9,10], 0.90));
  const t = L.tStat([1, 1, 1, 1]);
  ok(t.t === null && t.media === 1, 'sd = 0 → t null (no Infinity, no NaN)', JSON.stringify(t));
  const t2 = L.tStat([2, 4, 4, 4, 5, 5, 7, 9]);
  ok(Math.abs(t2.sd - 2.13809) < 1e-4, 'sd MUESTRAL (n−1)', t2.sd);
  ok(Math.abs(t2.t - 6.61438) < 1e-4, 't = media/(sd/√n)', t2.t);
  ok(L.tStat([]).t === null && L.tStat([1]).t === null, 'muestra vacía o de 1 → t null');
  const sh = L.sharpeAnual([0.01, -0.005, 0.007, 0.002, -0.001]);
  ok(Math.abs(sh - (L.media([0.01, -0.005, 0.007, 0.002, -0.001]) / L.desvest([0.01, -0.005, 0.007, 0.002, -0.001])) * Math.sqrt(252)) < 1e-9,
    'Sharpe anualizado ×√252 (convención de la casa)');
  ok(Math.abs(L.maxDrawdown([1, 1.2, 0.9, 1.1]) - (0.9 / 1.2 - 1)) < 1e-12, 'max drawdown desde el pico', L.maxDrawdown([1, 1.2, 0.9, 1.1]));

  // Decil: el corte sale SOLO de las sorpresas positivas.
  const evs = [...Array(100)].map((_, i) => ({ surprise_pct: i - 30 }));   // −30..69
  const d = L.seleccionaDecil(evs);
  ok(d.positivos === 69, 'el decil se calcula sobre las sorpresas POSITIVAS', d.positivos);
  ok(d.seleccion.length === 7 && d.seleccion.every((e) => e.surprise_pct >= d.corte), 'decil superior ≈ 10% de los positivos', d.seleccion.length);
}

// ═══════════════════ 5. la vela ajustada ═══════════════════
console.log('pead-analyze: velas AJUSTADAS (open en la misma escala que el close)');
{
  // close 100 con adjclose 90 → factor 0.9: el open también tiene que bajar,
  // o el retorno overnight del día ex-dividendo sale inventado.
  const json = { chart: { result: [{
    timestamp: [Date.parse('2026-03-02T00:00:00Z') / 1000, Date.parse('2026-03-03T00:00:00Z') / 1000],
    indicators: { quote: [{ open: [98, 101], close: [100, 102] }], adjclose: [{ adjclose: [90, 102] }] } }] } };
  const s = extraeSerieAjustada(json);
  ok(Math.abs(s.opens[0] - 98 * 0.9) < 1e-9, 'el factor adjclose/close se aplica AL OPEN', s.opens[0]);
  ok(Math.abs(s.closes[0] - 90) < 1e-9, 'el close ajustado es el adjclose', s.closes[0]);
  ok(Math.abs(s.opens[0] / s.closes[0] - 98 / 100) < 1e-12, 'open/close del día queda intacto (el factor no distorsiona el intradía)');
  ok(s.opens[1] === 101 && s.closes[1] === 102, 'sin ajuste (factor 1) los precios pasan tal cual');
  const sinAdj = extraeSerieAjustada({ chart: { result: [{ timestamp: [1], indicators: { quote: [{ open: [10], close: [11] }] } }] } });
  ok(sinAdj.opens[0] === 10 && sinAdj.closes[0] === 11, 'sin adjclose se cae a los precios crudos, no a null');
  ok(extraeSerieAjustada({}) === null, 'JSON basura → null (no serie fantasma)');
}

// ═══════════════════ 6. simulación: cupos y costos ═══════════════════
console.log('pead-analyze: simulación (tope de 8 concurrentes y 10 bp por lado)');
{
  const cal = Array.from({ length: 40 }, (_, i) => 'D' + String(i).padStart(2, '0'));
  // 20 candidatos el MISMO día → solo 8 pueden entrar.
  const series = {}, seleccion = [];
  for (let k = 0; k < 20; k++) {
    const sym = 'X' + k;
    series[sym] = { opens: cal.map(() => 100), closes: cal.map(() => 110) };
    seleccion.push({ symbol: sym, reported_date: 'D04', hora_efectiva: 'amc', surprise_pct: k,
      i_entrada: 5, fecha_entrada: 'D05', open_entrada: 100, close_previo: 100, gap_incapturable: 0 });
  }
  const sim = L.simula({ seleccion, seriesAlineadas: series, calendario: cal, N: 10, maxPos: 8, costo: 0.0010 });
  ok(sim.trades === 8, 'entran exactamente 8 (el tope de concurrentes se respeta)', sim.trades);
  ok(sim.rechazados_por_cupo === 12, 'los 12 rechazados por cupo se CUENTAN, no se ocultan', sim.rechazados_por_cupo);
  ok(sim.detalle_trades.every((t) => t.symbol !== 'X0'), 'con cupo lleno entran los de MAYOR sorpresa');
  const esperadoNeto = (110 * 0.999) / (100 * 1.001) - 1;
  ok(Math.abs(sim.ret_neto_medio - esperadoNeto) < 1e-12, 'costo de 10 bp por lado: compra ×1.001, venta ×0.999', sim.ret_neto_medio);
  ok(Math.abs(sim.ret_bruto_medio - 0.10) < 1e-12, 'el bruto es 110/100 − 1 = 10%', sim.ret_bruto_medio);
  ok(Math.abs(sim.ret_neto_medio - sim.ret_bruto_medio + 0.002) < 5e-4, 'neto ≈ bruto − 20 bp round-trip');
  // Se mide al CIERRE, ya liquidadas las salidas: entran en d=5 y salen al
  // close de d=14, así que quedan contadas en d=5..13 → 9 sesiones × 8 cupos.
  ok(Math.abs(sim.ocupacion_media_cupos - (8 * 9) / 40) < 1e-9, 'ocupación media = cupos ocupados al cierre / sesiones', sim.ocupacion_media_cupos);
  ok(sim.detalle_trades.every((t) => t.fecha_salida === cal[14]), 'tenencia de 10 sesiones: entrada open(i), salida close(i+9)');

  // Un cupo liberado se reutiliza: 9 candidatos, el 9º entra tras el primer exit.
  const sel2 = seleccion.slice(0, 9).map((e, k) => ({ ...e, i_entrada: k < 8 ? 5 : 16, fecha_entrada: cal[k < 8 ? 5 : 16] }));
  const sim2 = L.simula({ seleccion: sel2, seriesAlineadas: series, calendario: cal, N: 10, maxPos: 8, costo: 0 });
  ok(sim2.trades === 9 && sim2.rechazados_por_cupo === 0, 'el cupo liberado al cierre se reutiliza', `${sim2.trades}/${sim2.rechazados_por_cupo}`);
}

// ═══════════════════ 7. cartera calendar-time ═══════════════════
console.log('pead-analyze: cartera calendar-time');
{
  const cal = Array.from({ length: 20 }, (_, i) => 'D' + String(i).padStart(2, '0'));
  const closes = cal.map((_, i) => 100 * 1.01 ** i);
  const series = { A: { opens: cal.map((_, i) => closes[i] / 1.01), closes } };
  const spy = cal.map(() => 50);   // benchmark plano → abnormal = retorno crudo
  const ev = { symbol: 'A', i_entrada: 3, open_entrada: series.A.opens[3], surprise_pct: 50 };
  const dias = L.carteraCalendarTime({ seleccion: [ev], seriesAlineadas: series, spyCloses: spy, calendario: cal, N: 5 });
  ok(dias.length === 5, 'una posición de 5 sesiones aporta 5 días de cartera', dias.length);
  const compuesto = dias.reduce((a, d) => a * (1 + d.cartera), 1) - 1;
  const directo = closes[7] / series.A.opens[3] - 1;
  ok(Math.abs(compuesto - directo) < 1e-12, 'los retornos diarios compuestos = close(i+N−1)/open(i) − 1', `${compuesto} vs ${directo}`);
  ok(dias.every((d) => Math.abs(d.abnormal - d.cartera) < 1e-12), 'con SPY plano el abnormal es el retorno crudo');
  ok(dias.every((d) => d.n === 1), 'la exposición cuenta los nombres abiertos ese día');
  // Días sin posiciones NO entran (una cartera vacía con abnormal 0 solo
  // diluiría la varianza y regalaría un t-stat más grande).
  ok(dias[0].fecha === cal[3] && dias[4].fecha === cal[7], 'solo los días con cartera abierta', `${dias[0].fecha}..${dias[4].fecha}`);
  const conCosto = L.carteraCalendarTime({ seleccion: [ev], seriesAlineadas: series, spyCloses: spy, calendario: cal, N: 5, costo: 0.001 });
  const compNeto = conCosto.reduce((a, d) => a * (1 + d.cartera), 1) - 1;
  ok(compNeto < compuesto - 0.0019, 'la versión neta carga los 20 bp round-trip', `${compNeto} vs ${compuesto}`);
}

// ═══════════════════ 8. veredicto contra los umbrales congelados ═══════════════════
console.log('pead-analyze: veredicto GO / NO-GO / INCONCLUSO');
{
  const C = L.CRITERIOS;
  ok(C.min_eventos_operables === 300 && C.t_minimo === 2 && C.ret_neto_min_por_trade === 0.0030
    && C.sharpe_min === 0.7 && C.decil === 0.90 && C.hold_principal === 10
    && C.max_concurrentes === 8 && C.costo_por_lado === 0.0010,
    'los umbrales son los FIJADOS ANTES DE CORRER', JSON.stringify(C));

  // ── INCONCLUSO: muestra corta (regla dura, no "casi") ──
  {
    const fx = fabrica({ nSimbolos: 8, sesiones: 900, driftPlantado: 0.01 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({ anios: 3 }, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.eventos_operables < 300, 'la muestra corta queda bajo el piso', b.principal.muestra.eventos_operables);
    ok(b.veredicto === 'INCONCLUSO', 'muestra < 300 → INCONCLUSO aunque el drift plantado sea enorme', b.veredicto);
    ok(b.principal.cumple.t === true, 'y eso pasa incluso con el criterio de señal cumplido', JSON.stringify(b.principal.cumple));
  }

  // ── GO: drift plantado fuerte ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1100, driftPlantado: 0.006 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({ anios: 3 }, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.eventos_operables >= 300, 'muestra por encima del piso', b.principal.muestra.eventos_operables);
    ok(Math.abs(b.principal.senal.t) >= 2, '|t| ≥ 2 con drift plantado', b.principal.senal.t);
    ok(b.principal.operabilidad.ret_neto_medio_por_trade >= 0.0030, 'retorno neto por trade sobre el umbral', b.principal.operabilidad.ret_neto_medio_por_trade);
    ok(b.principal.operabilidad.sharpe_estrategia >= 0.7, 'Sharpe de la estrategia sobre el umbral', b.principal.operabilidad.sharpe_estrategia);
    ok(b.veredicto === 'GO', 'los 4 criterios en verde → GO', b.veredicto);
    ok(b.principal.operabilidad.trades > 0 && b.principal.muestra.eventos_senal > 0, 'hay trades y señal', `${b.principal.operabilidad.trades}/${b.principal.muestra.eventos_senal}`);
    ok(b.sensibilidades.split_bmo.muestra.por_hora.amc === 0 && b.sensibilidades.split_amc.muestra.por_hora.bmo === 0,
      'el split BMO/AMC separa de verdad las dos ramas');
    ok(b.sensibilidades.holds.map((h) => h.hold_dias).join(',') === '5,20', 'las sensibilidades de tenencia son 5 y 20', b.sensibilidades.holds.map((h) => h.hold_dias).join(','));
    ok(b.exploratorio.every((e) => e.etiqueta === 'EXPLORATORIO'), 'todo corte extra va etiquetado EXPLORATORIO');
    ok(!('exploratorio' in b.principal), 'la principal no mezcla cortes exploratorios');
    ok(b.principal.operabilidad.detalle_trades === undefined, 'sin ?trades=1 no viaja el detalle trade a trade');

    const conDetalle = mockRes();
    await handler(GET({ anios: 3, trades: '1' }, { authorization: `Bearer ${SECRET}` }), conDetalle);
    ok(Array.isArray(conDetalle.body.principal.operabilidad.detalle_trades), 'con ?trades=1 sí viaja el detalle');

    // markdown
    const md = mockRes();
    await handler(GET({ anios: 3, format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
    ok(md.headers['Content-Type'] === 'text/plain; charset=utf-8', 'format=md → text/plain');
    ok(/VEREDICTO: GO/.test(md.text), 'el markdown abre con el veredicto');
    // Ojo con el pipe: un "|t|" literal parte la fila de la tabla markdown en
    // dos columnas de más. Por eso el criterio se escribe "t ≥ 2 en valor absoluto".
    ok(md.text.split('\n').filter((l) => l.startsWith('| ')).every((l) => l.split('|').length === 5),
      'todas las filas de la tabla tienen exactamente 3 columnas (ningún pipe suelto)');
    for (const clave of ['Muestra ≥ 300', 't ≥ 2 en valor absoluto', 'Retorno neto ≥ 0.30%', 'Sharpe estrategia ≥ 0.7']) {
      ok(md.text.includes(clave), `el markdown lista el criterio "${clave}"`);
    }
    ok(/todo-BMO/.test(md.text) && /Split BMO/.test(md.text) && /Split AMC/.test(md.text), 'el markdown trae las sensibilidades obligatorias');
    ok(/EXPLORATORIO/.test(md.text), 'el markdown marca los cortes exploratorios');
  }

  // ── NO-GO: mismos datos, sin drift ──
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1100, driftPlantado: 0 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({ anios: 3 }, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.eventos_operables >= 300, 'muestra suficiente (el veredicto NO es por falta de datos)', b.principal.muestra.eventos_operables);
    ok(b.veredicto === 'NO-GO', 'sin drift → NO-GO', b.veredicto);
    ok(b.principal.cumple.ret_neto === false, 'el retorno neto no llega (los costos se comen el ruido)', b.principal.operabilidad.ret_neto_medio_por_trade);
    ok(typeof b.sensibilidades.veredicto_cambia_entre_bmo_y_amc === 'boolean', 'se reporta si el veredicto cambia entre todo-BMO y todo-AMC');
  }
}

// ═══════════════════ 9. contabilidad de la muestra ═══════════════════
console.log('pead-analyze: la muestra cuadra (nada desaparece en silencio)');
{
  const fx = fabrica({ nSimbolos: 30, sesiones: 900 });
  const alineadas = {};
  for (const s of fx.simbolos) alineadas[s] = L.alineaAlCalendario(fx.series[s], fx.calendario);
  const desde = fx.calendario[fx.calendario.length - 1 - 756];
  const { operables, descartes } = L.construyeMuestra({
    eventos: fx.eventos, calendario: fx.calendario, seriesAlineadas: alineadas, politicaHora: 'amc', desde,
  });
  const total = operables.length + Object.values(descartes).reduce((a, b) => a + b, 0);
  ok(total === fx.eventos.length, 'operables + descartes = eventos de entrada', `${total} vs ${fx.eventos.length}`);
  ok(descartes.fuera_de_ventana > 0, 'la ventana de ~3 años recorta de verdad', descartes.fuera_de_ventana);
  ok(operables.every((e) => e.fecha_entrada >= e.reported_date), 'toda entrada es posterior o igual al reporte');

  const conDrop = L.construyeMuestra({
    eventos: fx.eventos, calendario: fx.calendario, seriesAlineadas: alineadas, politicaHora: 'drop', desde,
  });
  ok(conDrop.descartes.sin_hora_descartada > 0, 'la sensibilidad de descarte sí saca los eventos sin hora', conDrop.descartes.sin_hora_descartada);
  ok(conDrop.operables.length < operables.length, 'y deja menos muestra que la principal');
  ok(conDrop.operables.every((e) => !e.hora_imputada), 'lo que queda tiene hora real');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
