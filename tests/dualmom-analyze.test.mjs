// ═══════════════════════════════════════════════════════════════
// Tests de /api/dualmom-analyze (Dual Momentum + gate, SOLO LECTURA).
//
// Cuatro cosas se prueban con dientes:
//
//   1. SOLO LECTURA. El fetch a Neon está mockeado y CADA query que pasa por
//      la frontera se captura: la aserción central es que TODAS son SELECT.
//   2. CERO LOOK-AHEAD. El gate se decide con el ÚLTIMO CIERRE CONOCIDO antes
//      de la apertura en la que se ejecuta. Hay un fixture hecho a mano donde
//      SPY está ARRIBA de su SMA al cierre previo y ABAJO al cierre del propio
//      día: la principal tiene que quedarse invertida (no puede saber lo que
//      todavía no pasó) y solo el corte EXPLORATORIO se va a efectivo.
//   3. EL GATE MIDE LO QUE DICE MEDIR. Con un CRASH PLANTADO, el gate tiene
//      que activarse, sacar la cartera a efectivo DURANTE la caída y recortar
//      el drawdown muy por debajo del de SPY — y por debajo del de la misma
//      estrategia sin gate. Si esa prueba no pasa, el resto de los números no
//      significan nada.
//   4. El CANDADO DE HONESTIDAD: en un régimen alcista donde el gate nunca se
//      activa, un GO tiene que salir topado en "GO FRÁGIL (gate sin evento en
//      ventana)" y decirlo, aunque los cuatro criterios estén en verde.
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

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const AYER = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

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

// Un FACTOR DE MERCADO común a SPY y a todos los nombres, más un drift por
// "calidad" q y ruido idiosincrático. Así el momentum 12-1 ordena por q, el
// gate mira el mismo mercado que sufren los nombres, y un crash plantado en el
// factor arrastra a todo el universo — que es justo el escenario en el que la
// defensa tiene que aparecer.
function fabrica({
  nSimbolos = 100, sesiones = 1300, fin = AYER, regimen = 'alcista', semilla = 17,
  alpha = 0.0015, volMercado = 0.004, volIdio = 0.003,
  crashLargo = 130, crashDiario = -0.0045, crashDesde = null,
} = {}) {
  const calendario = calendarioHabil(sesiones, fin);
  const rm = rng(semilla);
  const unif = (r, sd) => (r() - 0.5) * 2 * sd * Math.sqrt(3);

  const iCrash = crashDesde == null ? sesiones - 460 : crashDesde;
  const mkt = [];
  for (let i = 0; i < sesiones; i++) {
    let mu = regimen === 'plano' ? 0 : 0.0005;
    if (regimen === 'crash' && i >= iCrash && i < iCrash + crashLargo) mu = crashDiario;
    mkt.push(mu + unif(rm, volMercado));
  }

  const series = {};
  const q = {};
  const rp = rng(semilla + 101);
  const serieDesdeRetornos = (rets, p0) => {
    const opens = [], closes = [];
    let p = p0;
    for (let i = 0; i < rets.length; i++) {
      // El open del día arranca donde cerró el anterior (más un pelo de ruido);
      // el retorno del día lleva el cierre a su nivel.
      const o = p * (1 + unif(rp, 0.0005));
      p = p * (1 + rets[i]);
      opens.push(o); closes.push(p);
    }
    return { fechas: calendario, opens, closes };
  };

  for (let k = 0; k < nSimbolos; k++) {
    const sym = 'D' + String(k).padStart(3, '0');
    q[sym] = nSimbolos === 1 ? 0.5 : k / (nSimbolos - 1);
    const extra = alpha * (q[sym] - 0.5);
    const rets = mkt.map((m) => m + extra + unif(rp, volIdio));
    series[sym] = serieDesdeRetornos(rets, 40 + rp() * 60);
  }
  series.SPY = serieDesdeRetornos(mkt, 400);

  const simbolos = Object.keys(series).filter((s) => s !== 'SPY');
  return { calendario, simbolos, series, q, iCrash };
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
console.log('dualmom-analyze: SOLO LECTURA (cero writes a Neon)');
{
  const fx = fabrica({ nSimbolos: 25, sesiones: 900 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);

  const escritura = queries.filter((q) => !/^\s*select/i.test(q));
  ok(res.code === 200, 'responde 200', res.code);
  ok(queries.length === 1, 'una sola query a la DB', queries.length);
  ok(escritura.length === 0, 'TODAS las queries son SELECT (cero writes)', JSON.stringify(escritura));
  ok(/select distinct/i.test(queries[0]), 'el universo sale de un SELECT DISTINCT sobre pead_earnings', queries[0]);
  ok(!queries.some((q) => /create table|alter table|insert into|update |delete from|truncate/i.test(q)),
    'ni DDL ni DML en ninguna query');
  ok(!queries.some((q) => /cron_heartbeat/i.test(q)), 'no late ningún heartbeat');
  ok(res.headers['Cache-Control'] === 'no-store', 'no cachea (lleva secret en la URL)', res.headers['Cache-Control']);

  const src = readFileSync(new URL('../api/dualmom-analyze.js', import.meta.url), 'utf8');
  const sinComentarios = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/heartbeat/.test(sinComentarios), 'el código no importa heartbeat');
  ok(!/ensurePeadSchema|ensureSchema/.test(sinComentarios), 'el código no llama ensureSchema/ensurePeadSchema');
  ok(!/pead-harvest|pead-db/.test(sinComentarios), 'no importa el camino de escritura (pead-harvest / pead-db)');
  ok(/export const maxDuration = 300/.test(src), 'maxDuration = 300');
  ok(/from '\.\/_lib\/yahoo-daily\.js'/.test(src) && /from '\.\/_lib\/rotation-analyze\.js'/.test(src),
    'reusa los helpers de la rotación (yahoo-daily + rotation-analyze)');

  const lib = readFileSync(new URL('../api/_lib/dualmom-analyze.js', import.meta.url), 'utf8');
  ok(!/\bfetch\s*\(|from '\.\/db\.js'/.test(lib.replace(/\/\/.*$/gm, '')), 'el lib de análisis es puro (sin fetch ni DB)');
  ok(/from '\.\/rotation-analyze\.js'/.test(lib), 'el motor (momentum, simulación, calendar-time) es el de la rotación');
}

// ═══════════════════ 3. mecánica del gate ═══════════════════
console.log('dualmom-analyze: mecánica del gate (SMA, cruce, cierre de decisión)');
{
  const C = L.CRITERIOS;
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i);   // sube monótono
  ok(L.smaDiaria(closes, 249, 200) === L.media(closes.slice(50)), 'SMA de 200 = promedio de las últimas 200', L.smaDiaria(closes, 249, 200));
  ok(L.smaDiaria(closes, 100, 200) === null, 'sin 200 cierres → null (una SMA de 200 con 101 datos no es una SMA de 200)');

  const cal = calendarioHabil(250, AYER);
  const arriba = L.evaluaGate(closes, cal, 249, C, 'dias');
  ok(arriba.risk_on === true && arriba.evaluable === true, 'precio sobre la SMA → risk-on');
  const bajando = closes.map((_, i) => (i < 200 ? 100 + i : 300 - (i - 200) * 5));
  const g = L.evaluaGate(bajando, cal, 249, C, 'dias');
  ok(g.risk_on === false && g.cierre < g.sma, 'precio bajo la SMA → gate ACTIVADO (a efectivo)', `${g.cierre} vs ${g.sma}`);
  const plano = new Array(250).fill(100);
  ok(L.evaluaGate(plano, cal, 249, C, 'dias').risk_on === true, 'precio EXACTAMENTE en la SMA → risk-on (el corte es <, no ≤)');
  ok(L.evaluaGate(closes, cal, 100, C, 'dias').evaluable === false, 'sin SMA computable → no evaluable…');
  ok(L.evaluaGate(closes, cal, 100, C, 'dias').risk_on === false, '…y se va a EFECTIVO (conservador), no risk-on por defecto');

  // Variante Faber: 10 cierres mensuales.
  const finesMes = L.finesDeMesHasta(cal, 249, 10);
  ok(finesMes.length === 10 && finesMes[0] === 249, 'finesDeMesHasta ancla en el cierre de decisión y va hacia atrás', JSON.stringify(finesMes.slice(0, 3)));
  ok(finesMes.every((k, i) => i === 0 || cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)), 'y los demás son cierres de FIN DE MES');
  const smaM = L.smaMensual(closes, cal, 249, 10);
  ok(smaM === L.media(finesMes.map((k) => closes[k])), 'SMA mensual = promedio de esos 10 cierres', smaM);
  ok(L.smaMensual(closes, cal, 20, 10) === null, 'sin 10 meses de historia → null');

  // Las dos SMA son señales DISTINTAS, no dos nombres de la misma: un desplome
  // que cae justo en un cierre de fin de mes pesa 1/10 en la mensual y 1/200 en
  // la diaria, así que pueden dar veredictos opuestos el mismo día.
  const conHueco = new Array(250).fill(100);
  const finesPrevios = L.finesDeMesHasta(cal, 248, 10);
  conHueco[finesPrevios[3]] = 50;                 // desplome en un cierre mensual
  conHueco[249] = 97;                             // precio de hoy: entre las dos SMA
  const gDias = L.evaluaGate(conHueco, cal, 249, C, 'dias');
  const gMeses = L.evaluaGate(conHueco, cal, 249, C, 'meses');
  ok(gDias.sma !== gMeses.sma, 'la SMA diaria y la mensual no dan el mismo número', `${gDias.sma} vs ${gMeses.sma}`);
  ok(gDias.risk_on === false && gMeses.risk_on === true,
    'y pueden discrepar el mismo día: el tipoSma cambia la decisión de verdad',
    `dias=${gDias.risk_on} meses=${gMeses.risk_on}`);
}

// ═══════════════════ 4. CERO LOOK-AHEAD en el gate ═══════════════════
console.log('dualmom-analyze: el gate se decide con el cierre PREVIO, no con el del día');
{
  const C = L.CRITERIOS;
  const n = 400;
  const cal = calendarioHabil(n, AYER);
  // SPY plano en 100 (SMA = 100) y un DESPLOME solo en el cierre del día del
  // rebalanceo: al cierre previo sigue arriba de la SMA.
  const spyCloses = new Array(n).fill(100);
  const iRebal = L.primerosHabilesDelMes(cal).slice(-1)[0];
  spyCloses[iRebal] = 50;
  const seriesAlineadas = {};
  const simbolos = [];
  for (let k = 0; k < 30; k++) {
    const s = 'D' + k;
    simbolos.push(s);
    // Momentum positivo para todos: lo único que decide es el gate.
    seriesAlineadas[s] = { opens: cal.map((_, i) => 10 + i * 0.01), closes: cal.map((_, i) => 10 + i * 0.01) };
  }
  const comun = { simbolos, calendario: cal, seriesAlineadas, spyCloses, iRebalanceos: [iRebal], criterios: C };

  const previo = L.construyeCanastasDual({ ...comun });
  ok(previo.gate.activaciones === 0 && previo.canastas[0].nombres.length > 0,
    'con el cierre PREVIO el gate no se entera del desplome del día → sigue invertida (no hay look-ahead)',
    JSON.stringify(previo.canastas[0].nombres.length));
  const mismoDia = L.construyeCanastasDual({ ...comun, gateEnCierreDelDia: true });
  ok(mismoDia.gate.activaciones === 1 && mismoDia.canastas[0].nombres.length === 0,
    'con el cierre DEL MISMO DÍA (solo EXPLORATORIO) se va a efectivo: ese dato no existe al abrir');
  ok(previo.canastas[0].en_efectivo === false && mismoDia.canastas[0].en_efectivo === true,
    'la diferencia queda marcada en la canasta');
}

// ═══════════════════ 5. el orden de los filtros ═══════════════════
console.log('dualmom-analyze: primero el decil, DESPUÉS el momentum absoluto');
{
  const C = L.CRITERIOS;
  const n = 400;
  const cal = calendarioHabil(n, AYER);
  const spyCloses = new Array(n).fill(100);          // gate siempre risk-on
  const iRebal = L.primerosHabilesDelMes(cal).slice(-1)[0];
  // 40 nombres: 2 con momentum POSITIVO, 38 negativos. El decil son 4.
  const seriesAlineadas = {};
  const simbolos = [];
  for (let k = 0; k < 40; k++) {
    const s = 'D' + String(k).padStart(2, '0');
    simbolos.push(s);
    const sube = k < 2;
    seriesAlineadas[s] = {
      opens: cal.map((_, i) => (sube ? 10 + i * 0.02 : 100 - i * 0.1)),
      closes: cal.map((_, i) => (sube ? 10 + i * 0.02 : 100 - i * 0.1)),
    };
  }
  const comun = { simbolos, calendario: cal, seriesAlineadas, spyCloses, iRebalanceos: [iRebal], criterios: C };

  const conFiltro = L.construyeCanastasDual({ ...comun });
  ok(conFiltro.canastas[0].nombres_antes_del_filtro_absoluto === 4, 'el decil de 40 elegibles son 4 nombres', conFiltro.canastas[0].nombres_antes_del_filtro_absoluto);
  ok(conFiltro.canastas[0].nombres.length === 2, 'y el filtro absoluto deja solo los 2 con 12-1 > 0 (canasta MÁS CHICA, no rellena)', conFiltro.canastas[0].nombres.length);
  ok(conFiltro.gate.descartados_por_momentum_absoluto === 2, 'los 2 descartados se cuentan', conFiltro.gate.descartados_por_momentum_absoluto);

  const sinFiltro = L.construyeCanastasDual({ ...comun, conFiltroAbsoluto: false });
  ok(sinFiltro.canastas[0].nombres.length === 4, 'sin filtro absoluto entran los 4 del decil (momentum relativo puro)', sinFiltro.canastas[0].nombres.length);

  // Si NADA sube, el decil queda vacío → efectivo por momentum absoluto.
  const todosBajan = { ...comun };
  for (const s of simbolos) todosBajan.seriesAlineadas[s] = { opens: cal.map((_, i) => 100 - i * 0.1), closes: cal.map((_, i) => 100 - i * 0.1) };
  const vacia = L.construyeCanastasDual(todosBajan);
  ok(vacia.canastas[0].nombres.length === 0 && vacia.canastas[0].motivo_efectivo === 'momentum_absoluto',
    'si nada sube, la cartera se va a efectivo por el filtro absoluto (no compra los menos malos)');
  ok(vacia.gate.meses_efectivo_por_momentum_absoluto === 1, 'y ese mes se cuenta aparte del gate macro');
}

// ═══════════════════ 6. EL CRASH PLANTADO: el gate tiene que cortar el drawdown ═══════════════════
console.log('dualmom-analyze: CRASH PLANTADO — el gate corta el drawdown (la máquina mide lo que dice)');
{
  const fx = fabrica({ nSimbolos: 100, sesiones: 1300, regimen: 'crash' });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({ canastas: '1' }, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;
  const p = b.principal;
  const sinGate = b.sensibilidades[0].resultado;

  ok(p.gate.activaciones > 0, 'el gate SE ACTIVA con el crash plantado', p.gate.activaciones);
  ok(p.economia.max_drawdown_spy < -0.20, 'el crash le pega de verdad a SPY (drawdown grande)', p.economia.max_drawdown_spy);
  ok(Math.abs(p.economia.max_drawdown) < Math.abs(sinGate.economia.max_drawdown),
    'CON gate el drawdown es MENOR que sin gate (el gate es lo que defiende)',
    `${p.economia.max_drawdown} vs ${sinGate.economia.max_drawdown}`);
  ok(p.economia.dd_fraccion_de_spy < 0.70 && p.cumple.drawdown === true,
    'y queda debajo del 70% del drawdown de SPY (criterio §3 en verde)', p.economia.dd_fraccion_de_spy);
  ok(sinGate.gate.activaciones === 0, 'la corrida sin gate no activa nada (es la atribución)', sinGate.gate.activaciones);
  ok(p.muestra.meses_en_efectivo > 0, 'hubo meses en efectivo', p.muestra.meses_en_efectivo);
  ok(p.fragil === false, 'con el gate activado el veredicto NO es frágil por falta de evento', p.motivo_fragil);

  // El efectivo tiene que caer DENTRO de la caída, no después.
  const fechaCrash = fx.calendario[fx.iCrash];
  const fechaFin = fx.calendario[Math.min(fx.calendario.length - 1, fx.iCrash + 130)];
  const enEfectivoDuranteCrash = p.detalle_canastas.filter(
    (c) => c.en_efectivo && c.fecha >= fechaCrash && c.fecha <= fechaFin).length;
  ok(enEfectivoDuranteCrash > 0, 'la cartera está en efectivo DURANTE la caída, no después', enEfectivoDuranteCrash);
  const ultima = p.detalle_canastas[p.detalle_canastas.length - 1];
  ok(ultima.nombres.length > 0, 'y vuelve a invertirse cuando el mercado se recupera', JSON.stringify(ultima.fecha));
  ok(Array.isArray(p.gate_serie) && p.gate_serie.some((g) => !g.risk_on) && p.gate_serie.some((g) => g.risk_on),
    'la serie del gate muestra los dos estados (risk-on y risk-off)');

  const md = mockRes();
  await handler(GET({ format: 'md', regimen: 'crash' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/Activaciones del gate macro/.test(md.text), 'el markdown reporta las activaciones del gate');
}

// ═══════════════════ 7. CANDADO DE HONESTIDAD: gate sin evento ═══════════════════
console.log('dualmom-analyze: gate sin evento en ventana → GO topado en FRÁGIL');
{
  const fx = fabrica({ nSimbolos: 100, sesiones: 1300, regimen: 'alcista', volMercado: 0.0025, volIdio: 0.002, alpha: 0.0022 });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;
  const p = b.principal;
  ok(p.gate.activaciones === 0, 'en el régimen alcista el gate nunca se activa', p.gate.activaciones);
  ok(p.cumple.sharpe && p.cumple.drawdown && p.cumple.retorno,
    'los tres criterios económicos pasan', JSON.stringify(p.cumple));
  ok(p.veredicto === 'GO' && p.fragil === true, 'pero el veredicto sale GO FRÁGIL', `${p.veredicto}/${p.fragil}`);
  ok(p.motivo_fragil === 'gate sin evento en ventana', 'con el motivo pre-registrado', p.motivo_fragil);
  ok(L.etiquetaVeredicto(p) === 'GO FRÁGIL (gate sin evento en ventana)', 'y se renderiza con el motivo', L.etiquetaVeredicto(p));
  ok(b.gate_activaciones === 0 && b.go_fragil === true, 'el JSON expone gate_activaciones y go_fragil arriba de todo');

  // La sensibilidad SIN gate no lleva el candado: ahí no hay mecanismo que probar.
  const sinGate = b.sensibilidades[0].resultado;
  ok(sinGate.fragil === false, 'la corrida sin gate no se marca frágil por el candado (no tiene gate que probar)', sinGate.motivo_fragil);

  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(/VEREDICTO: GO FRÁGIL \(gate sin evento en ventana\)/.test(md.text), 'el markdown abre con el GO FRÁGIL y su motivo');
  ok(/el mecanismo defensivo de esta estrategia NO se probó/.test(md.text), 'y explica que la defensa no se probó');
  ok(/breaker macro de la liga/.test(md.text), 'y que como evidencia para el breaker macro no alcanza');
}

// ═══════════════════ 8. mercado plano y muestra corta ═══════════════════
console.log('dualmom-analyze: mercado plano → NO-GO · ventana corta → INCONCLUSO');
{
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 1300, regimen: 'plano', alpha: 0 });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.cumple.muestra === true, 'muestra suficiente (el veredicto NO es por falta de datos)', b.principal.muestra.rebalanceos_completos);
    ok(b.veredicto === 'NO-GO', 'sin tendencia ni señal → NO-GO', b.veredicto);
    ok(b.principal.economia.ret_total_neto < b.principal.economia.ret_total_bruto, 'y los costos del turnover se pagan igual');
  }
  {
    const fx = fabrica({ nSimbolos: 100, sesiones: 700, regimen: 'alcista' });
    global.fetch = mockFetch(fx);
    const res = mockRes();
    await handler(GET({ anios: 1 }, { authorization: `Bearer ${SECRET}` }), res);
    const b = res.body;
    ok(b.principal.muestra.rebalanceos_completos < 30, 'menos de 30 rebalanceos completos', b.principal.muestra.rebalanceos_completos);
    ok(b.veredicto === 'INCONCLUSO', 'muestra corta → INCONCLUSO (no NO-GO)', b.veredicto);
    const md = mockRes();
    await handler(GET({ anios: 1, format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
    ok(/no "casi"/.test(md.text), 'y el markdown dice que la regla se fijó de antemano');
  }
}

// ═══════════════════ 9. criterios congelados, sensibilidades y reporte ═══════════════════
console.log('dualmom-analyze: criterios congelados, sensibilidades obligatorias y reporte');
{
  const C = L.CRITERIOS;
  ok(C.min_rebalanceos === 30 && C.sharpe_sobre_spy_min === 0.15 && C.dd_max_fraccion_spy === 0.70
    && C.ret_vs_spy_min === -0.01 && C.fraccion_decil === 0.10 && C.sma_dias === 200
    && C.sma_meses_faber === 10 && C.costo_por_lado === 0.0010,
    'los umbrales son los FIJADOS ANTES DE CORRER', JSON.stringify(C));

  const fx = fabrica({ nSimbolos: 100, sesiones: 1300, regimen: 'crash' });
  global.fetch = mockFetch(fx);
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const b = res.body;

  const etiquetas = b.sensibilidades.map((s) => s.resultado.etiqueta).join(',');
  ok(etiquetas === 'sin_gate,sin_filtro_absoluto,sma_faber,bimestral', 'las 4 sensibilidades obligatorias están', etiquetas);
  ok(b.sensibilidades[2].resultado.tipo_sma === 'meses', 'la variante Faber usa la SMA mensual');
  ok(b.sensibilidades[3].resultado.muestra.rebalanceos_ejecutados < b.principal.muestra.rebalanceos_ejecutados,
    'el bimestral rebalancea la mitad de las veces');
  ok(typeof b.nota_bimestral === 'string' && /ARITMÉTICO/.test(b.nota_bimestral), 'y se avisa que su INCONCLUSO es de muestra', b.nota_bimestral);
  ok(b.exploratorio.every((e) => e.etiqueta === 'EXPLORATORIO'), 'todo corte extra va etiquetado EXPLORATORIO');
  ok(b.exploratorio[0].resultado.gate_en_cierre_del_dia === true, 'el exploratorio es el gate con el cierre del mismo día');
  ok(b.principal.detalle_canastas === undefined && b.principal.gate_serie === undefined,
    'sin ?canastas=1 no viajan ni el detalle ni la serie del gate');
  ok(/NO ES UNA PRUEBA INDEPENDIENTE/.test(b.caveat) && /rotation-analyze/.test(b.caveat),
    'el caveat de no-independencia viaja en la respuesta');

  const md = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), md);
  ok(md.headers['Content-Type'] === 'text/plain; charset=utf-8', 'format=md → text/plain');
  ok(md.text.split('\n').filter((l) => l.startsWith('| ')).every((l) => l.split('|').length === 5),
    'todas las filas de la tabla tienen exactamente 3 columnas (ningún pipe suelto)');
  for (const clave of ['≥ 30 rebalanceos completos', 'Sharpe neto ≥ Sharpe SPY + 0.15',
    'Max drawdown ≤ 70% del de SPY', 'Retorno anual neto ≥ SPY − 1%']) {
    ok(md.text.includes(clave), `el markdown lista el criterio "${clave}"`);
  }
  ok(/Sin gate macro/.test(md.text) && /Sin filtro absoluto/.test(md.text)
    && /variante Faber/.test(md.text) && /cada 2 meses/.test(md.text),
    'el markdown trae las 4 sensibilidades obligatorias');
  ok(/NO es evidencia independiente/i.test(md.text), 'el markdown cierra con el caveat de no-independencia');
  ok(/puente con/.test(md.text), 'y señala el puente con el momentum-solo del rotation-analyze');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
