// ═══════════════════════════════════════════════════════════════
// Tests de /api/dualmom-analyze (Dual Momentum + gate de tendencia, SOLO LECTURA).
//
// Lo que se prueba con dientes:
//
//   1. SOLO LECTURA. El fetch a Neon está mockeado y CADA query que cruza la
//      frontera se captura: la aserción central es que TODAS son SELECT.
//      Además se lee el fuente y se verifica que no importa heartbeat,
//      ensurePeadSchema ni el camino de escritura.
//   2. CERO LOOK-AHEAD. El gate se evalúa con el CIERRE DE LA SESIÓN PREVIA
//      contra la SMA hasta esa misma sesión — el cierre del propio día de
//      rebalanceo no existe cuando se ejecuta el fill a la apertura. El
//      momentum 12-1 termina un mes antes.
//   3. EL SINTÉTICO CON CRASH PLANTADO: la máquina mide lo que dice medir.
//      Un mercado en tendencia con un crash plantado donde el gate DEBE
//      cortar el drawdown; se verifica que el gate se activa, que la cartera
//      queda en efectivo esos meses (retorno diario EXACTAMENTE 0) y que el
//      drawdown resultante es sustancialmente menor que el de la MISMA
//      estrategia sin gate. Si el gate no cortara nada, este test falla.
//   4. Mercado PLANO: sin tendencia no hay nada que ganar y los costos se
//      pagan igual (control negativo).
//   5. Muestra corta → INCONCLUSO, por la regla fijada de antemano.
//   6. CANDADO DE HONESTIDAD: en una ventana donde el SPY nunca cae debajo de
//      su SMA200, gate_activaciones = 0 y el veredicto se topa en
//      "GO frágil (gate sin evento en ventana)" aunque los 4 criterios pasen.
//   7. Los umbrales del veredicto son los FIJADOS ANTES DE CORRER, y son
//      RELATIVOS a SPY en la misma ventana.
//
// Correr con `node tests/dualmom-analyze.test.mjs`.
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

const L = await import('../api/_lib/dualmom-analyze.js');
const { default: handler } = await import('../api/dualmom-analyze.js');

// ═══════════════════ fixture sintético determinista ═══════════════════
//
// LCG (no Math.random): el fixture tiene que dar EXACTAMENTE lo mismo en cada
// corrida, o un test que falla una vez de cada diez no prueba nada.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
// Normal estándar por Box-Muller sobre el LCG (colas más realistas que
// uniforme: el drawdown es justamente una cosa de colas).
function normal(u) {
  const a = Math.max(u(), 1e-12), b = u();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

const HOY = new Date();
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

// Régimen del SPY, sesión a sesión. `crash` planta una caída sostenida en un
// tramo del calendario — el evento que el gate TIENE que ver.
function derivaSpy(i, sesiones, regimen, crash) {
  if (regimen === 'plano') return 0;
  if (crash && i >= crash.desde && i < crash.desde + crash.sesiones) return crash.diario;
  return regimen === 'tendencia_limpia' ? 0.0012 : 0.0006;
}

// Cada símbolo lleva una "calidad" oculta q ∈ [0,1]: su drift idiosincrático es
// alpha·(q − 0.5), así que el rank de momentum 12-1 ordena por q y —si alpha >
// 0— el retorno FUTURO también. TODOS los nombres cargan además el retorno del
// SPY (beta 1): un crash de mercado se los lleva a todos, que es lo que hace
// que el gate macro tenga algo que hacer.
function fabrica({
  nSimbolos = 100, sesiones = 1400, fin = AYER, alpha = 0.0012, semilla = 7,
  regimen = 'tendencia_con_crash', volIdio = 0.010, volSpy = 0.008,
  crash = { desde: 900, sesiones: 120, diario: -0.005 },
} = {}) {
  const calendario = calendarioHabil(sesiones, fin);
  const simbolos = Array.from({ length: nSimbolos }, (_, i) => 'D' + String(i).padStart(3, '0'));

  // SPY primero: es el calendario canónico y el factor común.
  const rs = rng(semilla + 101);
  const spyRet = [];
  const so = [], sc = [];
  let sp = 400;
  for (let i = 0; i < sesiones; i++) {
    const r = derivaSpy(i, sesiones, regimen, regimen === 'tendencia_con_crash' ? crash : null)
      + normal(rs) * volSpy;
    spyRet.push(r);
    const o = sp * (1 + r * 0.35);      // el open recorre parte del movimiento
    sp = sp * (1 + r);
    so.push(o); sc.push(sp);
  }

  const series = { SPY: { fechas: calendario, opens: so, closes: sc } };
  const q = {};
  for (let k = 0; k < nSimbolos; k++) {
    const sym = simbolos[k];
    q[sym] = nSimbolos === 1 ? 0.5 : k / (nSimbolos - 1);
    const mu = alpha * (q[sym] - 0.5);
    const rp = rng(semilla + k * 977 + 1);
    const opens = [], closes = [];
    let p = 40 + rp() * 80;
    for (let i = 0; i < sesiones; i++) {
      const r = mu + spyRet[i] + normal(rp) * volIdio;
      const o = p * (1 + r * 0.35);
      p = p * (1 + r);
      opens.push(o); closes.push(p);
    }
    series[sym] = { fechas: calendario, opens, closes };
  }

  return { calendario, simbolos, series, q };
}

// ── mocks de red: Neon (POST /sql) + Yahoo (GET chart) ──
let queries = [];
function mockFetch({ simbolos, series }) {
  queries = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const lista = body.queries || [body];
      for (const qy of lista) queries.push(qy.query);
      return { ok: true, status: 200, json: async () => ({
        fields: [{ name: 'symbol', dataTypeID: 25 }],
        rows: simbolos.map((s) => [s]),
      }) };
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
console.log('dualmom-analyze: gate del CRON_SECRET');
{
  const fx = fabrica({ nSimbolos: 3, sesiones: 300, crash: null, regimen: 'plano' });
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
console.log('dualmom-analyze: SOLO LECTURA (cero writes a Neon)');
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
  ok(queries.length === 1, 'un solo SELECT (el universo heredado del rotation)', queries.length);
  ok(/select distinct/i.test(queries[0]) && /pead_earnings/i.test(queries[0]),
    'y es el SELECT DISTINCT de símbolos sobre pead_earnings', queries[0]);
  ok(res.headers['Cache-Control'] === 'no-store', 'no cachea (lleva secret en la URL)', res.headers['Cache-Control']);

  const src = readFileSync(new URL('../api/dualmom-analyze.js', import.meta.url), 'utf8');
  const sinComentarios = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/heartbeat/.test(sinComentarios), 'el código no importa heartbeat');
  ok(!/ensurePeadSchema|ensureSchema/.test(sinComentarios), 'el código no llama ensureSchema/ensurePeadSchema');
  ok(!/pead-harvest|pead-db/.test(sinComentarios), 'no importa el camino de escritura (pead-harvest / pead-db)');
  ok(/export const maxDuration = 300/.test(src), 'maxDuration = 300');

  const lib = readFileSync(new URL('../api/_lib/dualmom-analyze.js', import.meta.url), 'utf8');
  ok(!/\bfetch\s*\(|from '\.\/db\.js'/.test(lib.replace(/\/\/.*$/gm, '')), 'el lib de análisis es puro (sin fetch ni DB)');
  ok(/from '\.\/rotation-analyze\.js'/.test(lib), 'y REUSA los helpers de rotation-analyze en vez de reimplementarlos');
  for (const helper of ['simulaRotacion', 'serieSpy', 'momentum121', 'primerosHabilesDelMes', 'anualizado']) {
    ok(new RegExp(`\\b${helper}\\b`).test(lib.split("from './rotation-analyze.js'")[0]),
      `reusa ${helper} del rotation`);
  }
}

// ═══════════════════ 3. primitivas del gate ═══════════════════
console.log('dualmom-analyze: primitivas del gate (SMA de días y de meses)');
{
  const closes = Array.from({ length: 10 }, (_, i) => i + 1);   // 1..10
  ok(L.smaDias(closes, 9, 3) === 9, 'SMA3 al final = (8+9+10)/3', L.smaDias(closes, 9, 3));
  ok(L.smaDias(closes, 4, 5) === 3, 'SMA5 en el índice 4 = (1..5)/5', L.smaDias(closes, 4, 5));
  ok(L.smaDias(closes, 2, 5) === null, 'sin 5 observaciones → null (no se rellena una SMA a medias)');
  ok(L.smaDias(closes, -1, 3) === null, 'índice −1 → null');
  const conHuecos = [1, null, 3, null, 5];
  ok(L.smaDias(conHuecos, 4, 3) === 3, 'los nulls se saltan: se usan los 3 últimos CONOCIDOS', L.smaDias(conHuecos, 4, 3));

  const cal = ['2026-01-29', '2026-01-30', '2026-02-26', '2026-02-27', '2026-03-31', '2026-04-01'];
  const fdm = L.ultimosHabilesDelMes(cal);
  ok(JSON.stringify(fdm) === JSON.stringify([1, 3, 4]), 'último hábil de cada mes (el último elemento no cierra mes)', JSON.stringify(fdm));
  const cl = [10, 20, 30, 40, 60, 99];
  ok(L.smaMeses(cl, fdm, 5, 3) === 40, 'SMA de 3 cierres MENSUALES = (20+40+60)/3', L.smaMeses(cl, fdm, 5, 3));
  ok(L.smaMeses(cl, fdm, 3, 3) === null, 'con solo 2 cierres mensuales disponibles → null');
  ok(L.smaMeses(cl, fdm, 3, 2) === 30, 'y con 2 pedidos, usa los 2 que hay', L.smaMeses(cl, fdm, 3, 2));

  // evaluaGate: el precio de referencia es el CIERRE PREVIO, no el del día.
  const calendario = ['d0', 'd1', 'd2'];
  const spy = [100, 100, 1];        // desplome EN el día del rebalanceo (i=2)
  const finesDeMes = [];
  const previo = L.evaluaGate({ spyCloses: spy, calendario, finesDeMes, i: 2, gate: { tipo: 'sma_dias', n: 2, precio: 'cierre_previo' } });
  ok(previo.activo === false && previo.precio === 100,
    'el gate mira el cierre de la sesión PREVIA (el del propio día no existe al abrir)', JSON.stringify(previo));
  const literal = L.evaluaGate({ spyCloses: spy, calendario, finesDeMes, i: 2, gate: { tipo: 'sma_dias', n: 2, precio: 'cierre_del_dia' } });
  ok(literal.activo === true && literal.precio === 1,
    'la lectura literal (EXPLORATORIA) sí usa el cierre del día — y por eso "ve" el desplome', JSON.stringify(literal));
  const sinSma = L.evaluaGate({ spyCloses: spy, calendario, finesDeMes, i: 1, gate: { tipo: 'sma_dias', n: 50, precio: 'cierre_previo' } });
  ok(sinSma.activo === true && sinSma.motivo === 'sin_sma',
    'sin historia para la SMA → efectivo, pero marcado sin_sma (no cuenta como activación)', JSON.stringify(sinSma));
  const apagado = L.evaluaGate({ spyCloses: spy, calendario, finesDeMes, i: 2, gate: L.GATE_OFF });
  ok(apagado.activo === false && apagado.motivo === 'gate_apagado', 'gate apagado → nunca activo');

  // Debajo de la SMA → efectivo. Encima → invertido.
  const abajo = L.evaluaGate({ spyCloses: [100, 100, 100, 50, 9], calendario: ['a','b','c','d','e'], finesDeMes: [], i: 4, gate: { tipo: 'sma_dias', n: 4, precio: 'cierre_previo' } });
  ok(abajo.activo === true, 'cierre previo (50) debajo de la SMA4 (87.5) → gate ACTIVO', JSON.stringify(abajo));
}

// ═══════════════════ 4. curva y drawdown ═══════════════════
console.log('dualmom-analyze: curva de equity y drawdown');
{
  const c = L.curvaDesdeRetornos([0.10, -0.50, 0.20]);
  ok(Math.abs(c[0] - 1.1) < 1e-12 && Math.abs(c[1] - 0.55) < 1e-12 && Math.abs(c[2] - 0.66) < 1e-12,
    'la curva compone los retornos diarios', JSON.stringify(c));
  ok(Math.abs(L.maxDrawdown(c) - (0.55 / 1.1 - 1)) < 1e-12, 'max drawdown = −50% desde el pico', L.maxDrawdown(c));
}

// ═══════════════════ 5. LOS UMBRALES SON LOS CONGELADOS ═══════════════════
console.log('dualmom-analyze: umbrales congelados y RELATIVOS a SPY');
{
  const C = L.CRITERIOS;
  ok(C.min_rebalanceos === 30, '§1 · ≥ 30 rebalanceos completos', C.min_rebalanceos);
  ok(C.sharpe_prima_min === 0.15, '§2 · Sharpe ≥ SPY + 0.15', C.sharpe_prima_min);
  ok(C.drawdown_max_fraccion_spy === 0.70, '§3 · max drawdown ≤ 70% del de SPY', C.drawdown_max_fraccion_spy);
  ok(C.ret_anual_holgura_max === 0.01, '§4 · retorno anual ≥ SPY − 1 pp', C.ret_anual_holgura_max);
  ok(C.fraccion_decil === 0.10 && C.costo_por_lado === 0.0010, 'decil y 10 bp por lado', `${C.fraccion_decil}/${C.costo_por_lado}`);
  ok(C.gate_sma_dias === 200 && C.gate_sma_meses === 10, 'SMA200 (principal) y SMA10m (Faber)', `${C.gate_sma_dias}/${C.gate_sma_meses}`);
  ok(C.momentum_desde_meses === 12 && C.momentum_hasta_meses === 1, 'momentum 12-1');
  ok(C.momentum_absoluto_min === 0, 'el filtro absoluto exige 12-1 > 0');
  ok(C.anios_ventana === 3, 'MISMA ventana que rotation-analyze (comparabilidad)', C.anios_ventana);
}

// ═══════════════════ 6. EL SINTÉTICO CON CRASH PLANTADO ═══════════════════
// La prueba de que la máquina mide lo que dice medir: si el gate no cortara el
// drawdown, este bloque falla entero.
console.log('dualmom-analyze: crash plantado — el gate DEBE cortar el drawdown');
let crashBody = null;
{
  const fx = fabrica({ nSimbolos: 100, sesiones: 1400, regimen: 'tendencia_con_crash',
    crash: { desde: 950, sesiones: 120, diario: -0.005 } });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({ canastas: '1' }, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;
  crashBody = b;
  ok(res.code === 200, 'responde 200', res.code);

  const p = b.principal;
  const sinGate = b.sensibilidades.find((s) => s.resultado.etiqueta === 'sin_gate').resultado;

  ok(p.muestra.rebalanceos_completos >= 30, 'muestra suficiente (≥30 rebalanceos completos)', p.muestra.rebalanceos_completos);
  ok(b.gate_activaciones > 0, 'EL GATE SE ACTIVÓ: el crash plantado se ve desde la SMA200', b.gate_activaciones);
  ok(b.gate_probado === true, 'y por lo tanto el mecanismo defensivo SÍ se probó en esta ventana');
  ok(p.muestra.meses_en_efectivo >= b.gate_activaciones, 'los meses en efectivo incluyen los del gate',
    `${p.muestra.meses_en_efectivo} vs ${b.gate_activaciones}`);

  // El drawdown de SPY tiene que ser grande: si no, no hay crash que cortar.
  ok(p.economia.max_drawdown_spy < -0.25, 'el crash plantado hunde a SPY más de 25%', p.economia.max_drawdown_spy);
  // LA aserción: la MISMA estrategia sin gate sufre mucho más.
  ok(p.economia.max_drawdown > sinGate.economia.max_drawdown,
    'con gate el drawdown es MENOR que sin gate (el gate corta)',
    `${p.economia.max_drawdown} vs ${sinGate.economia.max_drawdown}`);
  ok(p.economia.max_drawdown / sinGate.economia.max_drawdown < 0.75,
    'y lo corta a menos de 3/4 del drawdown sin gate',
    p.economia.max_drawdown / sinGate.economia.max_drawdown);
  ok(p.cumple.drawdown === true, '§3 se cumple: el drawdown queda bajo el 70% del de SPY',
    `${p.economia.max_drawdown} vs tope ${p.economia.max_drawdown_tope}`);

  // "La cartera se va a EFECTIVO": en un mes de gate no hay posiciones, así que
  // el retorno diario tiene que ser EXACTAMENTE 0. Se verifica sobre el detalle.
  const cash = p.detalle_canastas.filter((c) => c.motivo_efectivo === 'gate');
  ok(cash.length === b.gate_activaciones, 'hay una canasta vacía por cada activación del gate',
    `${cash.length} vs ${b.gate_activaciones}`);
  ok(cash.every((c) => c.nombres.length === 0), 'y todas están efectivamente vacías (100% efectivo)');
  ok(cash.every((c) => c.gate.precio_spy < c.gate.sma), 'en todas, el cierre previo de SPY estaba DEBAJO de la SMA200',
    JSON.stringify(cash.map((c) => [c.fecha, c.gate.precio_spy, c.gate.sma])[0]));

  // Atribución: el reporte la calcula, no la narra.
  ok(typeof b.atribucion === 'string' && /gate/.test(b.atribucion), 'la atribución del gate viene calculada', b.atribucion);

  // Las 5 sensibilidades obligatorias, todas presentes y etiquetadas.
  const etiquetas = b.sensibilidades.map((s) => s.resultado.etiqueta).join(',');
  ok(etiquetas === 'sin_gate,sin_absoluto,faber_10m,bimestral,sin_filtros',
    'las sensibilidades obligatorias están, incluido el puente "sin filtros"', etiquetas);
  ok(b.sensibilidades[0].resultado.gate_activaciones === null, 'la corrida SIN GATE no reporta activaciones (no hay gate)');
  ok(b.sensibilidades[2].resultado.gate.tipo === 'sma_meses' && b.sensibilidades[2].resultado.gate.n === 10,
    'la variante Faber usa SMA de 10 MESES', JSON.stringify(b.sensibilidades[2].resultado.gate));
  ok(b.sensibilidades[2].resultado.gate_activaciones > 0, 'y también ve el crash', b.sensibilidades[2].resultado.gate_activaciones);
  ok(b.sensibilidades[3].resultado.muestra.rebalanceos_ejecutados < p.muestra.rebalanceos_ejecutados,
    'el bimestral rebalancea la mitad de las veces');
  ok(typeof b.nota_bimestral === 'string' && /ARITMÉTICO/.test(b.nota_bimestral),
    'y se avisa que su INCONCLUSO es de muestra, no de señal', b.nota_bimestral);
  ok(b.sensibilidades[4].resultado.gate_activaciones === null
    && b.sensibilidades[4].resultado.filtro_absoluto.aplicado === false,
    'el puente "sin filtros" corre sin gate y sin absoluto (momentum relativo puro)');

  // El filtro absoluto tiene que haberse ejercido en un crash de este tamaño.
  ok(p.filtro_absoluto.nombres_recortados > 0,
    'el filtro de momentum absoluto recortó nombres del decil durante el crash', p.filtro_absoluto.nombres_recortados);

  ok(b.exploratorio.every((e) => e.etiqueta === 'EXPLORATORIO'), 'todo corte extra va etiquetado EXPLORATORIO');
  ok(b.exploratorio.length === 3 && /cierre del propio día/i.test(b.exploratorio[0].nombre),
    'y el primero mide el look-ahead del gate literal', b.exploratorio[0].nombre);
  ok(/no es una prueba independiente/i.test(b.caveat) && /rotation-analyze/.test(b.caveat)
    && /supervivencia/i.test(b.caveat) && /puente/i.test(b.caveat),
    'el caveat pre-registrado viaja en la respuesta y nombra el puente con el rotation');

  // markdown
  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(md.headers['Content-Type'] === 'text/plain; charset=utf-8', 'format=md → text/plain');
  ok(/^# Dual Momentum/m.test(md.text), 'el markdown abre con el título');
  ok(/\*\*VEREDICTO: /.test(md.text), 'y con el veredicto');
  ok(md.text.split('\n').filter((l) => l.startsWith('| ')).every((l) => l.split('|').length === 5),
    'todas las filas de la tabla tienen exactamente 3 columnas (ningún pipe suelto)');
  for (const clave of ['≥ 30 rebalanceos mensuales completos', 'Sharpe neto ≥ Sharpe SPY + 0.15',
    'Max drawdown ≤ 70% del de SPY', 'Retorno anual neto ≥ SPY − 1%']) {
    ok(md.text.includes(clave), `el markdown lista el criterio "${clave}"`);
  }
  ok(/Candado de honestidad/.test(md.text) && /gate_activaciones = \d/.test(md.text),
    'el markdown reporta gate_activaciones en el candado de honestidad');
  ok(/Sin gate macro/.test(md.text) && /variante Faber/.test(md.text) && /cada 2 meses/.test(md.text)
    && /SIN FILTROS/.test(md.text) && /momentum absoluto/i.test(md.text),
    'el markdown trae las sensibilidades obligatorias');
  ok(/EXPLORATORIO/.test(md.text), 'el markdown marca los cortes exploratorios');
  ok(/no es una prueba independiente/i.test(md.text), 'y cierra con el caveat');
  ok(/diagn[óo]stico/i.test(md.text) && /no cuelga de [ée]l/i.test(md.text),
    'el t se reporta como diagnóstico, no como criterio');
}

// ═══════════════════ 7. CANDADO DE HONESTIDAD: gate sin evento ═══════════════════
console.log('dualmom-analyze: gate_activaciones = 0 → el GO se topa en GO frágil');
{
  // Tendencia limpia y fuerte: el SPY nunca cierra debajo de su SMA200 en una
  // fecha de rebalanceo, así que el gate NUNCA se dispara. Los nombres llevan
  // alfa plantado, así que los 4 criterios pasan… y aun así no es un GO limpio.
  const fx = fabrica({ nSimbolos: 100, sesiones: 1400, regimen: 'tendencia_limpia',
    crash: null, alpha: 0.0016, volSpy: 0.0030, volIdio: 0.003, semilla: 23 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body, p = b.principal;

  ok(p.muestra.rebalanceos_completos >= 30, 'muestra suficiente', p.muestra.rebalanceos_completos);
  ok(b.gate_activaciones === 0, 'el gate NUNCA se activó en esta ventana', b.gate_activaciones);
  ok(b.gate_probado === false, 'gate_probado = false: el mecanismo defensivo no se ejerció');
  ok(p.cumple.sharpe && p.cumple.drawdown && p.cumple.retorno,
    'los tres criterios económicos PASAN', JSON.stringify(p.cumple));
  ok(b.veredicto === 'GO', 'el veredicto crudo es GO', b.veredicto);
  ok(b.go_fragil === true, 'pero el candado pre-registrado lo marca FRÁGIL', b.go_fragil);
  ok(b.go_fragil_motivo === 'gate sin evento en ventana', 'con el motivo explícito', b.go_fragil_motivo);
  ok(L.etiquetaVeredicto(p) === 'GO frágil (gate sin evento en ventana)',
    'y se renderiza "GO frágil (gate sin evento en ventana)"', L.etiquetaVeredicto(p));

  // Sin activaciones, con-gate y sin-gate son LA MISMA cartera. Si no lo
  // fueran, sería un bug del gate, no un hallazgo.
  const sinGate = b.sensibilidades[0].resultado;
  ok(Math.abs(p.economia.ret_total_neto - sinGate.economia.ret_total_neto) < 1e-12,
    'con gate_activaciones = 0, la corrida con gate y la sin gate son idénticas',
    `${p.economia.ret_total_neto} vs ${sinGate.economia.ret_total_neto}`);

  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/VEREDICTO: GO frágil \(gate sin evento en ventana\)/.test(md.text),
    'el markdown abre con el GO frágil, no con un GO pelado');
  ok(/gate_activaciones = 0/.test(md.text) && /no se ejerció ni una vez/.test(md.text),
    'y dice explícito que el mecanismo defensivo no se probó');
}

// ═══════════════════ 8. MERCADO PLANO (control negativo) ═══════════════════
console.log('dualmom-analyze: mercado plano — no hay nada que ganar y los costos se pagan');
{
  const fx = fabrica({ nSimbolos: 100, sesiones: 1400, regimen: 'plano', crash: null,
    alpha: 0, volSpy: 0.008, volIdio: 0.010, semilla: 41 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body, p = b.principal;

  ok(p.cumple.muestra === true, 'muestra suficiente (el veredicto NO es por falta de datos)', p.muestra.rebalanceos_completos);
  ok(p.economia.ret_total_neto < p.economia.ret_total_bruto, 'el neto es menor que el bruto (los costos se pagan)',
    `${p.economia.ret_total_neto} vs ${p.economia.ret_total_bruto}`);
  ok(p.economia.costo_total > 0, 'y el costo acumulado es positivo', p.economia.costo_total);
  ok(b.veredicto !== 'INCONCLUSO', 'con muestra, el veredicto se pronuncia', b.veredicto);
  ok(p.gate_activaciones > 0, 'en un mercado plano y ruidoso el SPY cruza su SMA200 y el gate se activa', p.gate_activaciones);
  ok(p.muestra.meses_invertidos + p.muestra.meses_en_efectivo === p.muestra.rebalanceos_ejecutados,
    'todo rebalanceo está o invertido o en efectivo (nada desaparece)',
    `${p.muestra.meses_invertidos}+${p.muestra.meses_en_efectivo} vs ${p.muestra.rebalanceos_ejecutados}`);
}

// ═══════════════════ 9. MUESTRA CORTA → INCONCLUSO ═══════════════════
console.log('dualmom-analyze: muestra corta → INCONCLUSO (regla dura, no "casi")');
{
  const fx = fabrica({ nSimbolos: 100, sesiones: 900, regimen: 'tendencia_limpia', crash: null,
    alpha: 0.0016, volSpy: 0.0030, volIdio: 0.003, semilla: 23 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({ anios: 1 }, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;
  ok(b.principal.muestra.rebalanceos_completos < 30, 'menos de 30 rebalanceos completos',
    b.principal.muestra.rebalanceos_completos);
  ok(b.veredicto === 'INCONCLUSO', 'muestra corta → INCONCLUSO aunque los números sean buenos', b.veredicto);
  ok(b.go_fragil === false, 'un INCONCLUSO no se marca frágil');

  const md = mockRes();
  await handler(GET({ anios: 1, format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/VEREDICTO: INCONCLUSO/.test(md.text), 'el markdown reporta INCONCLUSO');
  ok(/no "casi"/.test(md.text), 'y dice que la regla se fijó de antemano');
}

// ═══════════════════ 10. contabilidad y detalle ═══════════════════
console.log('dualmom-analyze: contabilidad (nada desaparece en silencio)');
{
  const b = crashBody;
  const p = b.principal;
  const elegibles = p.detalle_canastas.reduce((a, c) => a + (c.motivo_efectivo === 'gate' ? 0 : c.elegibles), 0);
  const excl = p.muestra.motivos_exclusion;
  // Los recortes del filtro absoluto salen de nombres YA contados como
  // elegibles, así que no entran en el cuadre de cobertura.
  const excluidos = excl.sin_serie + excl.sin_precio_previo + excl.sin_open_rebalanceo
    + excl.sin_momentum + excl.gate_efectivo;
  const programados = p.muestra.rebalanceos_programados;
  const saltados = p.muestra.rebalanceos_saltados;
  ok(elegibles + excluidos === b.datos.simbolos * (programados - saltados),
    'elegibles + exclusiones = símbolos × rebalanceos ejecutados',
    `${elegibles}+${excluidos} vs ${b.datos.simbolos * (programados - saltados)}`);
  ok(excl.gate_efectivo === b.gate_activaciones * b.datos.simbolos,
    'los meses de gate excluyen al universo ENTERO, y así se cuentan',
    `${excl.gate_efectivo} vs ${b.gate_activaciones * b.datos.simbolos}`);

  // Sin ?canastas=1 el detalle no viaja.
  const sinDetalle = mockRes();
  global.fetch = mockFetch(fabrica({ nSimbolos: 40, sesiones: 1400 }));
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), sinDetalle);
  ok(sinDetalle.body.principal.detalle_canastas === undefined, 'sin ?canastas=1 no viaja el detalle canasta a canasta');
}

// ═══════════════════ 11. sin canastas ejecutadas ═══════════════════
console.log('dualmom-analyze: universo por debajo del piso de elegibles → INCONCLUSO, no un veredicto inventado');
{
  // 5 símbolos: nunca se llega a `min_elegibles_rebalanceo`. Con tendencia
  // limpia el gate tampoco dispara, así que NO hay una sola canasta.
  const fx = fabrica({ nSimbolos: 5, sesiones: 1400, regimen: 'tendencia_limpia', crash: null,
    alpha: 0.0016, volSpy: 0.0030, volIdio: 0.003, semilla: 23 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const p = res.body.principal;
  ok(p.muestra.rebalanceos_ejecutados === 0, 'ningún rebalanceo se ejecuta', p.muestra.rebalanceos_ejecutados);
  ok(p.muestra.rebalanceos_saltados > 0, 'y todos quedan contados como saltados', p.muestra.rebalanceos_saltados);
  ok(p.economia === null && p.senal === null, 'sin canastas no se inventan métricas');
  ok(res.body.veredicto === 'INCONCLUSO', 'veredicto INCONCLUSO (no NO-GO)', res.body.veredicto);

  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/Sin canastas ejecutadas/.test(md.text), 'el markdown lo dice en vez de pintar veinte "n/d"');
  ok(/no es una prueba independiente/i.test(md.text), 'y aun así cierra con el caveat');
  ok(md.text.split('\n').filter((l) => l.startsWith('| ')).every((l) => l.split('|').length === 5),
    'la tabla de criterios sigue bien formada');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
