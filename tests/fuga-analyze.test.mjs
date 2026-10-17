// ═══════════════════════════════════════════════════════════════
// Tests de /api/fuga-analyze ("FUGA PRE-EARNINGS", SOLO LECTURA).
//
//   1. Gate del CRON_SECRET y SOLO LECTURA (toda query capturada es SELECT).
//   2. CERO LOOK-AHEAD: D es la última sesión cuyo cierre es anterior al
//      anuncio y la salida es el primer cierre posterior (BMO/AMC/DMH/finde).
//   3. Placebo: ninguna sesión a −10/+3 de un reporte del símbolo.
//   4. Criterios pineados + cada frontera del veredicto.
//   5. Cadena completa contra sintéticos: fuga plantada → GO; sin efecto →
//      NO-GO; momentum (señal = placebo) → NO-GO por el criterio (2);
//      muestra corta → INCONCLUSO.
//
// Correr con `node tests/fuga-analyze.test.mjs`.
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

const L = await import('../api/_lib/fuga-analyze.js');
const { alineaAlCalendario } = await import('../api/_lib/pead-analyze.js');
const { default: handler } = await import('../api/fuga-analyze.js');

// ═══════════════════ fixture sintético determinista ═══════════════════

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

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

// modo:
//   'fuga'     → salto +8% en D−2 antes de 1/4 de los reportes y +3% en la
//                sesión de reacción SOLO en reportes; saltos fuera de reporte
//                sin reacción.
//   'nulo'     → mismos saltos, ninguna reacción.
//   'momentum' → tras CUALQUIER salto (reporte o no), +0.8%/día las 5
//                sesiones siguientes: señal y placebo ven lo mismo.
function fabrica({ nSimbolos = 40, sesiones = 1100, fin = '2026-06-30', modo = 'nulo', semilla = 11 } = {}) {
  const calendario = calendarioHabil(sesiones, fin);
  const r = rng(semilla);
  const simbolos = Array.from({ length: nSimbolos }, (_, i) => 'S' + String(i).padStart(3, '0'));
  const horas = ['bmo', 'amc', 'amc', 'dmh', null, 'bmo', 'amc'];

  // retornos diarios: ruido ±0.4% uniforme
  const ret = {};
  for (const s of simbolos) ret[s] = Array.from({ length: sesiones }, () => (r() - 0.5) * 0.008);
  const retSpy = Array.from({ length: sesiones }, () => (r() - 0.5) * 0.006);

  const eventos = [];
  let c = 0;
  for (let k = 0; k < simbolos.length; k++) {
    const sym = simbolos[k];
    for (let i = 30 + (k % 50); i < sesiones - 10; i += 63) {
      const hour = horas[c % horas.length];
      eventos.push({ symbol: sym, reported_date: calendario[i], hour, hour_source: hour ? 'sec_8k' : null });
      const { iD, iSalida } = L.sesionesEvento(calendario, calendario[i], L.horaEfectiva(hour, 'amc'));
      const tipo = c % 4;   // 0 → run-up · 3 → caída (lado corto) · resto → control
      if (tipo === 0) {
        ret[sym][iD - 2] += 0.08;
        if (modo === 'fuga') ret[sym][iSalida] += 0.03;
        if (modo === 'momentum') for (let d = iD - 1; d <= iD + 3; d++) ret[sym][d] += 0.008;
      } else if (tipo === 3) {
        ret[sym][iD - 2] -= 0.08;
      }
      // salto FUERA de reporte, a +31 sesiones (lejos de [−10, +3])
      const j = i + 31;
      if (j + 6 < sesiones) {
        ret[sym][j] += 0.08;
        if (modo === 'momentum') for (let d = j + 1; d <= j + 5; d++) ret[sym][d] += 0.008;
      }
      c++;
    }
  }

  const aSerie = (rs, p0) => {
    const closes = []; let p = p0;
    for (const x of rs) { p *= 1 + x; closes.push(p); }
    return { fechas: calendario, opens: closes.slice(), closes };
  };
  const series = {};
  for (const s of simbolos) series[s] = aSerie(ret[s], 50 + r() * 100);
  series.SPY = aSerie(retSpy, 400);
  return { calendario, eventos, series, simbolos };
}

function corrida(fx, extra = {}) {
  const seriesAlineadas = {};
  for (const s of fx.simbolos) seriesAlineadas[s] = alineaAlCalendario(fx.series[s], fx.calendario);
  const spyCloses = alineaAlCalendario(fx.series.SPY, fx.calendario).closes;
  return L.corre({ eventos: fx.eventos, calendario: fx.calendario, seriesAlineadas, spyCloses, ...extra });
}

// ── mocks de red: Neon + Yahoo ──
let queries = [];
function mockFetch({ eventos, series }) {
  queries = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      for (const q of body.queries || [body]) queries.push(q.query);
      const fields = [
        { name: 'symbol', dataTypeID: 25 }, { name: 'reported_date', dataTypeID: 25 },
        { name: 'hour', dataTypeID: 25 }, { name: 'hour_source', dataTypeID: 25 },
      ];
      const rows = eventos.map((e) => [e.symbol, e.reported_date, e.hour, e.hour_source]);
      return { ok: true, status: 200, json: async () => ({ fields, rows }) };
    }
    const m = u.match(/\/chart\/([^?]+)/);
    const s = m && series[decodeURIComponent(m[1])];
    if (!s) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: s.fechas.map((d) => Date.parse(d + 'T00:00:00Z') / 1000),
      indicators: { quote: [{ open: s.opens, close: s.closes }], adjclose: [{ adjclose: s.closes }] },
    }] } }) };
  };
}
const GET = (query, headers = {}) => ({ method: 'GET', query, headers });
const AUTH = { authorization: `Bearer ${SECRET}` };

// ═══════════════════ 1. gate + SOLO LECTURA ═══════════════════
console.log('fuga-analyze: gate del CRON_SECRET y SOLO LECTURA');
{
  const fx = fabrica({ nSimbolos: 6, sesiones: 500 });
  global.fetch = mockFetch(fx);

  const sinAuth = mockRes();
  await handler(GET({}), sinAuth);
  ok(sinAuth.code === 401, 'sin secret → 401', sinAuth.code);
  ok(queries.length === 0, 'un 401 no toca la DB', queries.length);

  const porQuery = mockRes();
  await handler(GET({ secret: SECRET, format: 'md' }), porQuery);
  ok(porQuery.code === 200 && typeof porQuery.text === 'string', '?secret=&format=md → 200 con markdown', porQuery.code);

  const post = mockRes();
  await handler({ method: 'POST', query: {}, headers: AUTH }, post);
  ok(post.code === 405, 'POST → 405', post.code);

  const res = mockRes();
  await handler(GET({}, AUTH), res);
  ok(res.code === 200, 'responde 200', res.code);
  ok(queries.length > 0 && queries.every((q) => /^\s*select/i.test(q)), 'TODAS las queries son SELECT', JSON.stringify(queries));
  ok(!queries.some((q) => /create table|alter table|insert into|update |delete from|truncate|cron_heartbeat/i.test(q)), 'ni DDL, ni DML, ni heartbeat');
  ok(res.headers['Cache-Control'] === 'no-store', 'no-store');
  ok(res.body.criterios === L.CRITERIOS_FUGA, 'el JSON publica los criterios congelados');
  ok(!('_obs' in res.body.principal), 'sin ?obs=1 no viaja el detalle por evento');

  const src = readFileSync(new URL('../api/fuga-analyze.js', import.meta.url), 'utf8');
  const sinCom = src.replace(/\/\/.*$/gm, '');
  ok(!/heartbeat|ensurePeadSchema|ensureSchema|pead-db|pead-harvest/.test(sinCom), 'no importa heartbeat ni el camino de escritura');
  ok(/export const maxDuration = 300/.test(src), 'maxDuration = 300');
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  ok(vercel.functions['api/fuga-analyze.js']?.maxDuration === 300, 'vercel.json le concede 300s');
  const lib = readFileSync(new URL('../api/_lib/fuga-analyze.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  ok(!/\bfetch\s*\(|from '\.\/db\.js'|import /.test(lib), 'el lib es puro (sin fetch, sin DB, sin imports)');

  // Cobertura primero, y ?solo=cobertura no enseña resultados.
  const md = porQuery.text;
  ok(md.indexOf('## 1. Cobertura') > 0 && md.indexOf('## 1. Cobertura') < md.indexOf('VEREDICTO'), 'el markdown abre con la cobertura, antes del veredicto');
  const solo = mockRes();
  await handler(GET({ solo: 'cobertura', format: 'md' }, AUTH), solo);
  ok(/Cobertura/.test(solo.text) && !/VEREDICTO/.test(solo.text), '?solo=cobertura → cobertura sin veredicto');
  const soloJ = mockRes();
  await handler(GET({ solo: 'cobertura' }, AUTH), soloJ);
  ok(soloJ.body.veredicto === null && !soloJ.body.principal.grupos && soloJ.body.principal.cobertura, '?solo=cobertura (JSON) → sin grupos ni veredicto');
}

// ═══════════════════ 2. CERO LOOK-AHEAD ═══════════════════
console.log('fuga-analyze: cero look-ahead (D y salida)');
{
  // lu 02 · ma 03 · mi 04 · ju 05 · vi 06 · lu 09
  const cal = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09'];
  const ev = (d, h) => L.sesionesEvento(cal, d, h);
  let x = ev('2026-03-04', 'bmo');
  ok(x.iD === 1 && x.iSalida === 2, 'BMO → D = E−1, salida = cierre de E', JSON.stringify(x));
  x = ev('2026-03-04', 'amc');
  ok(x.iD === 2 && x.iSalida === 3, 'AMC → D = E, salida = cierre de E+1', JSON.stringify(x));
  x = ev('2026-03-07', 'bmo');
  ok(x.iD === 4 && x.iSalida === 5, 'BMO en sábado → D = viernes, salida = lunes', JSON.stringify(x));
  x = ev('2026-03-07', 'amc');
  ok(x.iD === 4 && x.iSalida === 5, 'AMC en sábado → D = viernes, salida = lunes', JSON.stringify(x));
  ok(ev('2026-03-09', 'amc').iSalida === -1, 'AMC sin sesión posterior → sin salida (no se inventa)');
  ok(ev('2026-03-02', 'bmo').iD === -1, 'BMO el primer día → sin D');

  ok(L.horaEfectiva('dmh', 'amc') === 'bmo', 'DMH → BMO (el cierre de E ya vio el anuncio)');
  ok(L.horaEfectiva(null, 'amc') === 'amc', 'sin hora en la principal → AMC (convención del encargo)');
  ok(L.horaEfectiva(null, 'drop') === null, 'sin hora en la sensibilidad → descartado');
  ok(L.horaEfectiva('AMC', 'bmo') === 'amc', 'una hora etiquetada manda sobre la política');

  // Invariante: toda la formación cae ≤ D < anuncio, y la salida > D.
  const fx = fabrica({ nSimbolos: 10, sesiones: 600 });
  const r = corrida(fx);
  const todas = [...r._obs.senal, ...r._obs.control, ...r._obs.corto];
  const malas = todas.filter((o) => {
    const h = o.hora_efectiva;
    const antes = h === 'bmo' ? o.fecha_d < o.reported_date : o.fecha_d <= o.reported_date;
    const despues = h === 'bmo' ? o.fecha_salida >= o.reported_date : o.fecha_salida > o.reported_date;
    return !antes || !despues;
  });
  ok(todas.length > 50 && malas.length === 0, 'formación ≤ D < anuncio < salida en toda observación', malas.length);

  // Una vela faltante NO se rellena: el evento se cae con su motivo.
  const s = { closes: [10, 10, null, 10, 10, 10, 11] };
  const spy = [1, 1, 1, 1, 1, 1, 1];
  ok(L.exceso(s.closes, spy, 6, 4).motivo === 'sin_vela_formacion', 'falta la vela de D−k → sin_vela_formacion');
  ok(L.exceso(s.closes, spy, 2, 1).motivo === 'sin_vela_d', 'falta la vela de D → sin_vela_d');
  ok(Math.abs(L.exceso(s.closes, spy, 6, 3).valor - 0.1) < 1e-12, 'exceso = ret acción − ret SPY');
  const re = L.reaccion([100, 102], [100, 101], 0, 1, 0.001);
  ok(Math.abs(re.abnormal - 0.01) < 1e-12, 'reacción anormal = 2% − 1%');
  ok(Math.abs(re.abnormal_neto - ((102 * 0.999) / (100 * 1.001) - 1 - 0.01)) < 1e-12, 'neto = 10 bp por lado sobre el largo');
}

// ═══════════════════ 3. PLACEBO ═══════════════════
console.log('fuga-analyze: placebo lejos de los reportes');
{
  const fx = fabrica({ nSimbolos: 10, sesiones: 600, modo: 'nulo' });
  const r = corrida(fx);
  const idx = new Map(fx.calendario.map((d, i) => [d, i]));
  const reportes = {};
  for (const e of fx.eventos) (reportes[e.symbol] ||= []).push(L.primeraSesion(fx.calendario, e.reported_date, false));
  const cerca = r._obs.placebo.filter((o) => reportes[o.symbol].some((iE) => {
    const i = idx.get(o.fecha_d);
    return i >= iE - 10 && i <= iE + 3;
  }));
  ok(r._obs.placebo.length > 0, 'hay placebo', r._obs.placebo.length);
  ok(cerca.length === 0, 'ninguna sesión placebo a −10/+3 de un reporte del símbolo', cerca.length);
  ok(r._obs.placebo.every((o) => o.exceso >= 0.06), 'placebo = misma señal (excess_5 ≥ +6%)');
  ok(r.cobertura.placebo >= r.cobertura.senal, 'N(PLACEBO) ≥ N(SEÑAL)', `${r.cobertura.placebo} vs ${r.cobertura.senal}`);

  // Un reporte de FUERA de la ventana también veda sesiones vecinas.
  const z = L.zonasProhibidas([{ symbol: 'X', reported_date: fx.calendario[20] }], fx.calendario, 10, 3);
  ok(z.X.has(10) && z.X.has(23) && !z.X.has(9) && !z.X.has(24), 'zona prohibida = [iE−10, iE+3]');
}

// ═══════════════════ 4. CRITERIOS + fronteras del veredicto ═══════════════════
console.log('fuga-analyze: criterios congelados y veredicto');
{
  const C = L.CRITERIOS_FUGA;
  ok(C.min_senal === 30 && C.min_control === 100, 'candado: SEÑAL ≥ 30, CONTROL ≥ 100');
  ok(C.t_minimo === 2 && C.t_solido === 2.5 && C.t_reversion === -2, 't: 2 / 2.5 / −2');
  ok(C.neto_min_por_operacion === 0.003, 'neto ≥ +0.30% por operación');
  ok(C.ventana_formacion === 5 && C.umbral_senal === 0.06 && C.umbral_control === 0.02, 'excess_5 ≥ 6%; control |x| < 2%');
  ok(C.tenencia === 1 && C.costo_por_lado === 0.001, 'tenencia 1 sesión; 10 bp por lado');
  ok(C.placebo_antes === 10 && C.placebo_despues === 3, 'placebo fuera de [−10, +3]');
  ok(C.sens_ventana_formacion === 10 && JSON.stringify(C.sens_umbrales) === '[0.04,0.08]' && C.sens_tenencia === 3, 'sensibilidades pre-registradas');

  const base = { n_senal: 50, n_control: 200, t_senal: 3, media_senal: 0.01, t_dif_placebo: 3, dif_placebo: 0.01, neto_senal: 0.008 };
  const v = (o) => L.veredicto({ ...base, ...o });
  ok(v({}).veredicto === 'GO', 'tres criterios con t ≥ 2.5 → GO');
  ok(v({ t_senal: 2.2 }).veredicto === 'GO FRÁGIL', 't(1) en [2, 2.5) → GO FRÁGIL');
  ok(v({ t_dif_placebo: 2.4 }).veredicto === 'GO FRÁGIL', 't(2) en [2, 2.5) → GO FRÁGIL');
  ok(v({ t_dif_placebo: 1.9 }).veredicto === 'NO-GO', 't(2) < 2 → NO-GO');
  ok(v({ dif_placebo: -0.01, t_dif_placebo: 3 }).veredicto === 'NO-GO', 'señal peor que placebo → NO-GO');
  ok(v({ neto_senal: 0.0029 }).veredicto === 'NO-GO', 'neto < 0.30% → NO-GO');
  ok(v({ t_senal: 2.2, neto_senal: 0.001 }).veredicto === 'NO-GO', 'GO FRÁGIL también exige el neto');
  ok(v({ n_senal: 29 }).veredicto === 'INCONCLUSO', 'SEÑAL 29 → INCONCLUSO');
  ok(v({ n_control: 99 }).veredicto === 'INCONCLUSO', 'CONTROL 99 → INCONCLUSO');
  const rev = v({ t_senal: -2.5, media_senal: -0.01 });
  ok(rev.veredicto === 'NO-GO' && rev.hallazgo_reversion, 't ≤ −2 → NO-GO + hallazgo de reversión');
  ok(v({ t_senal: null }).veredicto === 'NO-GO', 't ausente no cuenta como pase');

  // Clustering: dos eventos de la misma fecha cuentan como UNA observación del t.
  const obs = [{ fecha_d: 'a', abnormal: 0.02 }, { fecha_d: 'a', abnormal: 0.04 }, { fecha_d: 'b', abnormal: 0.01 }];
  const cl = L.porFecha(obs);
  ok(cl.length === 2 && Math.abs(cl[0] - 0.03) < 1e-12, 'se promedia por fecha antes del t');
  ok(Math.abs(L.tWelch([1, 2, 3], [1, 2, 3])) < 1e-12 && L.tWelch([5, 6, 7], [1, 2, 3]) > 0, 'Welch: 0 con muestras iguales, > 0 si la primera es mayor');
}

// ═══════════════════ 5. cadena completa contra sintéticos ═══════════════════
console.log('fuga-analyze: sintéticos (fuga / nulo / momentum / muestra corta)');
{
  const fuga = corrida(fabrica({ modo: 'fuga' }));
  ok(fuga.cobertura.senal >= 30 && fuga.cobertura.control >= 100, 'el fixture pasa el candado', `${fuga.cobertura.senal}/${fuga.cobertura.control}`);
  ok(fuga.veredicto === 'GO', 'fuga plantada → GO', `${fuga.veredicto} ${JSON.stringify(fuga.cumple)}`);
  ok(Math.abs(fuga.grupos.senal.media - 0.03) < 0.005, 'la reacción media de SEÑAL recupera el +3% plantado', fuga.grupos.senal.media);
  ok(Math.abs(fuga.grupos.placebo.media) < 0.002, 'placebo ≈ 0 cuando no hay momentum', fuga.grupos.placebo.media);

  const nulo = corrida(fabrica({ modo: 'nulo' }));
  ok(nulo.veredicto === 'NO-GO', 'sin efecto → NO-GO', `${nulo.veredicto} ${JSON.stringify(nulo.cumple)}`);
  ok(!nulo.cumple.c1_senal, 'sin efecto: (1) no pasa');

  const mom = corrida(fabrica({ modo: 'momentum' }));
  ok(mom.veredicto === 'NO-GO', 'momentum (señal = placebo) → NO-GO', `${mom.veredicto} ${JSON.stringify(mom.cumple)}`);
  ok(mom.cumple.c1_senal && mom.cumple.c3_neto && !mom.cumple.c2_vs_placebo,
    'momentum: pasa (1) y (3), muere en (2)', JSON.stringify(mom.cumple));
  ok(mom.grupos.placebo.media > 0.005, 'el placebo SÍ ve el momentum', mom.grupos.placebo.media);

  const corta = corrida(fabrica({ modo: 'fuga', nSimbolos: 3 }));
  ok(corta.veredicto === 'INCONCLUSO', 'muestra corta → INCONCLUSO aunque haya fuga', `${corta.veredicto} ${corta.cobertura.senal}`);

  // El lado corto se mide pero no decide.
  ok(fuga.grupos.corto_informativo.n > 0, 'el lado corto (≤ −6%) se reporta');

  // Las sensibilidades corren y no tocan el veredicto principal.
  const fx = fabrica({ modo: 'fuga', nSimbolos: 40 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({ format: 'md' }, AUTH), res);
  ok(res.code === 200 && /VEREDICTO: GO/.test(res.text), 'endpoint end-to-end con fuga plantada → GO', res.text && res.text.slice(0, 300));
  const resJ = mockRes();
  await handler(GET({}, AUTH), resJ);
  ok(resJ.body.sensibilidades.length === 7 && resJ.body.exploratorio.length === 1, '7 sensibilidades + 1 exploratorio');
  ok(/EXPLORATORIO/.test(res.text) && /NO deciden/.test(res.text), 'sensibilidades y exploratorio etiquetados en el markdown');
  const t3 = resJ.body.sensibilidades.find((x) => /Tenencia 3/.test(x.nombre)).resultado;
  ok(t3.especificacion.tenencia === 3, 'la sensibilidad de tenencia corre con 3 sesiones');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
