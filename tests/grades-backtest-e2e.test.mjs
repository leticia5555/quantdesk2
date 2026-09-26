// ═══════════════════════════════════════════════════════════════
// Tests de /api/grades-backtest de punta a punta. Neon y FMP SIMULADOS.
//
//   1. SOLO LECTURA en Neon: cada query que cruza la frontera se captura y
//      todas tienen que ser SELECT. Sin ensureSchema, sin heartbeat.
//   2. La Fase 0 MIDE: meses de historia, cobertura, rate limits y el tamaño
//      de muestra REAL. Y no dictamina la señal.
//   3. Los 429 se cuentan aparte y cortan la corrida en vez de quemar cuota.
//   4. La Fase 1 respeta el candado: muestra corta → INCONCLUSO.
//   5. Sin FMP_API_KEY la respuesta DICE que falta la key (y que en Vercel una
//      env var vive por entorno), en vez de parecer "no hay datos".
//
// Correr con `node tests/grades-backtest-e2e.test.mjs`.
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
process.env.FMP_API_KEY = 'fake-key-para-el-test';

const { default: handler } = await import('../api/grades-backtest.js');
const { V0_UNIVERSE } = await import('../api/_lib/pead-universe.js');

// ═══════════════════ fixture ═══════════════════
// 12 símbolos del universo real × 12 reportes = 144 eventos, con grades
// mensuales y enfriamiento PLANTADO en la mitad.
const SIMS = [...new Set(V0_UNIVERSE)].slice(0, 12);

function fabrica({ mesesDeHistoria = 24, simbolosSinGrades = [] } = {}) {
  const mercados = [];
  let n = 0;
  for (const sym of SIMS) {
    for (let k = 0; k < 12; k++) {
      const mes = String((k % 12) + 1).padStart(2, '0');
      const anio = 2025 + Math.floor(k / 12);
      const frio = n % 2 === 1;
      mercados.push({
        market_id: 'mk-' + n, symbol: sym, report_date: `${anio}-${mes}-20`,
        outcome: (frio ? (n % 5 === 0) : (n % 20 !== 0)) ? 'Yes' : 'No',
        // Un tercio con precio rancio o volumen flaco: son los que los filtros
        // de la Fase 2 tirarían y este backtest SÍ usa.
        yes_price_estado: n % 3 === 0 ? 'rancio' : 'valido',
        volume: n % 3 === 0 ? '80' : '900',
      });
      n++;
    }
  }
  // Grades mensuales por símbolo. El salto varía con el símbolo para que los
  // deltas tengan dispersión y los terciles se puedan partir.
  const grades = {};
  for (const [idx, sym] of SIMS.entries()) {
    if (simbolosSinGrades.includes(sym)) continue;
    const filas = [];
    for (let m = 0; m < mesesDeHistoria; m++) {
      const d = new Date(Date.UTC(2024, 0, 15));
      d.setUTCMonth(d.getUTCMonth() + m);
      const salto = (idx % 6) + 2;
      // Sube y baja de forma alternada, así hay enfriamientos y calentamientos.
      const sb = (m % 2 === 0) ? salto : 0;
      filas.push({
        date: d.toISOString().slice(0, 10),
        analystRatingsStrongBuy: sb, analystRatingsBuy: 25 - sb,
        analystRatingsHold: 3, analystRatingsSell: 1, analystRatingsStrongSell: 0,
      });
    }
    grades[sym] = filas;
  }
  return { mercados, grades };
}

const NUM = 1700, TXT = 25;
const CAMPOS = [['market_id', TXT], ['symbol', TXT], ['report_date', TXT],
  ['outcome', TXT], ['yes_price_estado', TXT], ['volume', NUM]];
const respuesta = (filas) => ({
  fields: CAMPOS.map(([name, dataTypeID]) => ({ name, dataTypeID })),
  rows: filas.map((f) => CAMPOS.map(([name]) => (f[name] === undefined ? null : f[name]))),
});

let queries = [], fmpPedidos = [], todosLimitTope = null;
function mockFetch(fx, { forzar429Desde = null, httpError = null, todos = null } = {}) {
  queries = []; fmpPedidos = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const lista = body.queries || [body];
      for (const q of lista) queries.push(q.query);
      return { ok: true, status: 200, json: async () => respuesta(fx.mercados) };
    }
    if (u.includes('grades-historical')) {
      const sym = decodeURIComponent((u.match(/symbol=([^&]+)/) || [])[1] || '');
      fmpPedidos.push({ symbol: sym, url: u });
      // `todos` responde lo mismo a TODOS los símbolos: sirve para simular la
      // frontera caída, que es el caso que motivó esta tanda.
      if (todos) {
        const ct = todos.content_type || 'application/json';
        return { ok: todos.status >= 200 && todos.status < 300, status: todos.status,
          text: async () => (todos.body === undefined ? '' : todos.body),
          headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? ct : null) } };
      }
      // El `limit` de la URL: el smoke prueba variantes y el mock tiene que
      // poder rechazar una y aceptar otra.
      const lim = (u.match(/[?&]limit=(\d+)/) || [])[1];
      if (todosLimitTope !== null && lim !== undefined && Number(lim) > todosLimitTope) {
        return { ok: false, status: 400,
          text: async () => JSON.stringify({ 'Error Message': 'Invalid limit. Max is ' + todosLimitTope }),
          headers: { get: () => 'application/json' } };
      }
      if (forzar429Desde !== null && fmpPedidos.length > forzar429Desde) {
        return { ok: false, status: 429, text: async () => 'Limit Reach', headers: { get: () => '60' } };
      }
      if (httpError && httpError.symbol === sym) {
        return { ok: httpError.status === 200, status: httpError.status,
          text: async () => httpError.body, headers: { get: () => null } };
      }
      const filas = fx.grades[sym];
      if (!filas) {
        // HTTP 200 con objeto de error: el caso que más engaña de FMP.
        return { ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ 'Error Message': 'Symbol not found' }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(filas) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

const FX = fabrica();

// ═══════════════════ 1. gate ═══════════════════
console.log('grades-backtest: gate del CRON_SECRET');
{
  global.fetch = mockFetch(FX);
  const sinAuth = mockRes();
  await handler(GET({}), sinAuth);
  ok(sinAuth.code === 401, 'sin secret → 401', sinAuth.code);
  ok(queries.length === 0 && fmpPedidos.length === 0, 'un 401 no toca ni Neon ni FMP (no quema cuota)');
  const censoSinAuth = mockRes();
  await handler(GET({ fase: '0' }), censoSinAuth);
  ok(censoSinAuth.code === 401, 'el censo tampoco es una puerta lateral', censoSinAuth.code);
  const conAuth = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), conAuth);
  ok(conAuth.code === 200 && conAuth.headers['Cache-Control'] === 'no-store', '?secret= → 200 y no-store');
}

// ═══════════════════ 2. SOLO LECTURA ═══════════════════
console.log('SOLO LECTURA en Neon, verificado en la frontera');
{
  global.fetch = mockFetch(FX);
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), r);
  ok(queries.length > 0, 'consulta Neon', queries.length);
  ok(queries.every((q) => /^\s*select/i.test(q.trim())), 'TODAS las queries son SELECT',
    JSON.stringify(queries.filter((q) => !/^\s*select/i.test(q.trim()))));
  ok(!queries.some((q) => /create table|insert into|update |delete from|truncate/i.test(q)), 'ni un DDL ni un DML');
  ok(!queries.some((q) => /cron_heartbeat/i.test(q)), 'no late ningún heartbeat');

  const fuente = readFileSync(new URL('../api/grades-backtest.js', import.meta.url), 'utf8');
  const codigo = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/ensureSchema|\bbeat\s*\(/.test(codigo), 'el fuente no importa ensureSchema ni beat');
  ok(!/insert into|create table/i.test(codigo), 'y esta tanda NO crea tabla: los grades no se guardan');
}

// ═══════════════════ 3. la Fase 0 MIDE ═══════════════════
console.log('FASE 0: mide historia, cobertura, límites y muestra REAL');
let censo;
{
  global.fetch = mockFetch(FX);
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), r);
  censo = r.body;
  ok(censo.fase === 0, 'la respuesta se identifica como Fase 0');
  ok(censo.historia.simbolos_con_datos === SIMS.length, 'cuenta los símbolos con grades', censo.historia.simbolos_con_datos);
  ok(censo.historia.meses_por_simbolo.max === 24 && censo.historia.meses_por_simbolo.min === 24,
    'y cuántos MESES de historia devolvió cada uno', JSON.stringify(censo.historia.meses_por_simbolo));
  ok(censo.historia.mas_antiguo === '2024-01-15', 'con el rango de fechas', censo.historia.mas_antiguo);
  ok(censo.historia.alguno_en_el_tope_del_limit === false,
    'y avisa si alguno tocó el límite (acá no) — la cicatriz del limit=5');
  ok(censo.cobertura.universo_v0 === 99, 'el universo v0 son 99 símbolos', censo.cobertura.universo_v0);
  ok(censo.cobertura.con_grades === SIMS.length && censo.cobertura.sin_grades === 0,
    'reporta cuántos de los pedidos tienen grades', `${censo.cobertura.con_grades}/${censo.cobertura.pedidos}`);
  ok(censo.limites.pedidos === SIMS.length && censo.limites.rate_limit_429 === 0,
    'los límites se miden: pedidos y 429', JSON.stringify(censo.limites.rate_limit_429));
  ok(censo.limites.cuota_gastada_requests === SIMS.length,
    'y se dice qué cuota gastó la corrida', censo.limites.cuota_gastada_requests);
  ok(censo.limites.latencia_ms !== null && typeof censo.limites.duracion_ms === 'number',
    'con latencias y duración medidas, no asumidas', JSON.stringify(censo.limites.latencia_ms));
  // El mock contesta instantáneamente, así que la duración es 0 y req/s queda
  // null. Es lo correcto: dividir por cero daría Infinity, y publicar "Infinity
  // req/s" sería peor que decir que no se pudo medir.
  ok(censo.limites.duracion_ms === 0
    ? censo.limites.requests_por_segundo === null
    : censo.limites.requests_por_segundo > 0,
    'req/s se publica cuando se puede medir, y null cuando la corrida duró 0 ms',
    `${censo.limites.duracion_ms}ms → ${censo.limites.requests_por_segundo}`);
  ok(/no asumido/.test(censo.limites.nota), 'dicho explícitamente');
  ok(censo.muestra.eventos_etiquetados === 144, 'los eventos etiquetados', censo.muestra.eventos_etiquetados);
  ok(censo.muestra.con_filtros_de_la_fase_2 < censo.muestra.eventos_etiquetados,
    'y cuántos serían con los filtros de la Fase 2, para poder auditar la diferencia',
    `${censo.muestra.con_filtros_de_la_fase_2} vs ${censo.muestra.eventos_etiquetados}`);
  ok(/el precio no juega/.test(censo.muestra.nota_muestra), 'con el porqué de usar la muestra más amplia');
  ok(typeof censo.muestra.con_ventana_valida === 'number', 'y el tamaño de muestra REAL, con ventana válida', censo.muestra.con_ventana_valida);
  ok(censo.muestra.alcanza === (censo.muestra.con_ventana_valida >= 100), 'el candado de 100 se evalúa acá');
  // EL CENSO NO DICTAMINA LA SEÑAL.
  ok(censo.veredicto === undefined && censo.comparacion === undefined && censo.terciles === undefined,
    'el censo NO trae veredicto de la señal ni terciles: mide si hay con qué, nada más');
  ok(/HAY CON QUÉ|INCONCLUSO POR MUESTRA/.test(censo.veredicto_fase_0), 'su veredicto es sobre la MUESTRA', censo.veredicto_fase_0);
  ok(/INFORMACIÓN PÚBLICA/.test(censo.advertencia), 'y la advertencia viaja ya desde el censo');
  ok(censo.criterios.min_eventos === 100, 'los criterios de la Fase 1 van publicados desde el censo — ya estaban congelados');
}

// ═══════════════════ 4. los 429 cortan, no queman cuota ═══════════════════
console.log('rate limit: se cuenta aparte y CORTA');
{
  global.fetch = mockFetch(FX, { forzar429Desde: 2 });
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), r);
  const lim = r.body.limites;
  ok(lim.rate_limit_429 > 0, 'los 429 se cuentan', lim.rate_limit_429);
  ok(lim.cortado_por === 'rate_limit', 'y la corrida se corta en vez de seguir quemando cuota', lim.cortado_por);
  ok(fmpPedidos.length < SIMS.length, 'no se pidieron los 12 símbolos', `${fmpPedidos.length} de ${SIMS.length}`);
  ok(lim.motivos.rate_limit > 0, 'el motivo queda separado de un http_error cualquiera', JSON.stringify(lim.motivos));
}

// ═══════════════════ 5. el HTTP 200 con error, y la key ausente ═══════════════════
console.log('FMP: el 200 con objeto de error, y la key ausente');
{
  const sinUno = fabrica({ simbolosSinGrades: [SIMS[0]] });
  global.fetch = mockFetch(sinUno);
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), r);
  const fallo = r.body.cobertura.simbolos_sin_grades.find((s) => s.symbol === SIMS[0]);
  ok(fallo && fallo.motivo === 'fmp_error_message',
    'HTTP 200 con `Error Message` se clasifica como error de FMP, no como "sin datos"', JSON.stringify(fallo));
  ok(fallo.fmp_message === 'Symbol not found', 'y el mensaje de FMP se publica tal cual', fallo.fmp_message);

  const key = process.env.FMP_API_KEY;
  delete process.env.FMP_API_KEY;
  global.fetch = mockFetch(FX);
  const sinKey = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), sinKey);
  process.env.FMP_API_KEY = key;
  ok(fmpPedidos.length === 0, 'sin key no se pega a la red: se clasifica antes');
  ok(sinKey.body.limites.motivos.sin_key > 0, 'y el motivo es sin_key, no "sin datos"', JSON.stringify(sinKey.body.limites.motivos));
  ok(sinKey.body.cobertura.con_grades === 0 && /FALLA DE FRONTERA/.test(sinKey.body.veredicto_fase_0),
    'sin key la Fase 0 sale FALLA DE FRONTERA — NO "INCONCLUSO por muestra": no hay con qué juzgar la muestra',
    sinKey.body.veredicto_fase_0);
  ok(/sin_key/.test(sinKey.body.veredicto_fase_0), 'y el veredicto NOMBRA el motivo dominante');
}

// ═══════════════════ 6. la Fase 1 ═══════════════════
console.log('FASE 1: el candado antes de los números');
{
  global.fetch = mockFetch(FX);
  const r = mockRes();
  await handler(GET({ secret: SECRET }), r);
  const b = r.body;
  ok(b.fase === 1 && b.pre_registrado === true, 'la respuesta se identifica como el backtest pre-registrado');
  ok(['GO', 'NO-GO', 'INCONCLUSO'].includes(b.veredicto), 'y trae uno de los tres veredictos', b.veredicto);
  ok(/INFORMACIÓN PÚBLICA/.test(b.advertencia), 'con la advertencia');
  ok(b.criterios.min_eventos === 100 && b.criterios.tasa_base_universo === 0.8182,
    'y los criterios congelados, incluido el baseline');
  ok(b.eventos === undefined, 'el detalle evento por evento no viene por default');
  if (b.veredicto === 'INCONCLUSO') {
    ok(b.comparacion === null, 'si es INCONCLUSO, NO se publica la diferencia (mirarla sería mover la portería)');
  } else {
    ok(b.comparacion && b.comparacion.colas === 2, 'si hay comparación, el p-valor es a dos colas');
    ok(b.terciles && b.terciles.length === 3, 'y los tres terciles', b.terciles && b.terciles.length);
  }
  ok(b.conteos_de_la_fuente.con_outcome === 144, 'los conteos de la fuente viajan con el resultado');
  ok(b.fmp && typeof b.fmp.cuota_gastada_requests === 'number', 'y la cuota que gastó esta corrida');

  const conEventos = mockRes();
  await handler(GET({ secret: SECRET, eventos: '1' }), conEventos);
  const tieneEventos = conEventos.body.veredicto === 'INCONCLUSO'
    ? conEventos.body.eventos === undefined : Array.isArray(conEventos.body.eventos);
  ok(tieneEventos, '?eventos=1 muestra el detalle cuando lo hay');

  // Muestra corta forzada: 2 mercados.
  global.fetch = mockFetch({ mercados: FX.mercados.slice(0, 2), grades: FX.grades });
  const corto = mockRes();
  await handler(GET({ secret: SECRET }), corto);
  ok(corto.body.veredicto === 'INCONCLUSO', 'con 2 eventos: INCONCLUSO', corto.body.veredicto);
  ok(corto.body.comparacion === null && corto.body.terciles === null,
    'y sin diferencia ni terciles publicados');
  ok(corto.body.porque.some((p) => /INCONCLUSO no es NO-GO/.test(p)), 'diciendo que INCONCLUSO no es NO-GO');
}

// ═══════════════════ 7. markdown y errores ═══════════════════
console.log('markdown y errores');
{
  global.fetch = mockFetch(FX);
  const md0 = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', format: 'md' }), md0);
  ok(md0.code === 200 && /text\/plain/.test(md0.headers['Content-Type'] || ''), 'el censo en md', md0.code);
  ok(/FASE 0/.test(md0.text) && /Rate limits \(MEDIDOS/.test(md0.text), 'con los límites medidos');
  ok(/Cuota gastada en esta corrida/.test(md0.text), 'y la cuota gastada, para no quemarla a ciegas');
  ok(/Tamaño de muestra REAL/.test(md0.text), 'y el tamaño de muestra real');

  const md1 = mockRes();
  await handler(GET({ secret: SECRET, format: 'md' }), md1);
  ok(/VEREDICTO:/.test(md1.text), 'el backtest en md abre con el veredicto');
  ok(/INFORMACIÓN PÚBLICA/.test(md1.text), 'con la advertencia');
  ok(/pre-registro está en/.test(md1.text), 'y apunta al pre-registro');

  global.fetch = async () => { throw new Error('boom de red'); };
  const roto = mockRes();
  await handler(GET({ secret: SECRET }), roto);
  ok(roto.code === 500 && /grades-backtest/.test(roto.body.error || ''), 'un error sale 500 con contexto', roto.code);
}


// ═══════════════════ 8. LA FRONTERA SE DIAGNOSTICA ═══════════════════
// La tanda que arregló esto nació de 20 de 20 símbolos con `http_error` y
// mensaje VACÍO: el status y el cuerpo existían en la respuesta del lib y la
// vista los TIRABA. Un error que no dice por qué manda a buscar donde no está.
console.log('la frontera: el status y el cuerpo SIEMPRE llegan a la vista');
{
  todosLimitTope = null;
  global.fetch = mockFetch(FX, { todos: { status: 400, body: '{"Error Message":"Invalid limit"}' } });
  const r = mockRes();
  await handler(GET({ secret: SECRET, fase: '0' }), r);
  const b = r.body;
  const fallo = b.cobertura.simbolos_sin_grades[0];
  ok(fallo.status === 400, 'el STATUS llega a la lista que se lee, no solo a la telemetría', fallo.status);
  ok(/Invalid limit/.test(fallo.body_sample || ''), 'y el CUERPO también', fallo.body_sample);
  ok(typeof fallo.longitud_cuerpo === 'number', 'con la longitud, porque un cuerpo vacío es en sí mismo un dato', fallo.longitud_cuerpo);
  ok(/grades-historical\?symbol=/.test(fallo.url_sin_key || ''),
    'y la URL que armó el código, SIN la key, para comparar con la que funciona a mano', fallo.url_sin_key);
  ok(!/apikey/.test(fallo.url_sin_key || ''), 'la URL publicada no lleva la key');

  // EL ARREGLO CENTRAL: esto NO es INCONCLUSO por muestra.
  ok(/FALLA DE FRONTERA/.test(b.veredicto_fase_0),
    'con cero símbolos con datos el veredicto es FALLA DE FRONTERA, no INCONCLUSO POR MUESTRA', b.veredicto_fase_0);
  ok(!/INCONCLUSO POR MUESTRA/.test(b.veredicto_fase_0), 'y no dice lo otro');
  ok(b.frontera.rota === true && b.frontera.con_datos === 0, 'la frontera se reporta como rota');
  ok(b.frontera.motivo_dominante.motivo === 'http_error', 'con el motivo dominante', JSON.stringify(b.frontera.motivo_dominante));
  ok(b.frontera.primer_fallo && b.frontera.primer_fallo.status === 400,
    'y el primer fallo COMPLETO, con la fila en la mano');
  ok(/smoke=NKE/.test(b.frontera.que_hacer || ''), 'diciendo qué correr para diagnosticarlo');
  ok(/NO dicen nada sobre el tamaño de muestra/.test(b.muestra.descartes_son_consecuencia_de_la_frontera || ''),
    'y los descartes quedan marcados como CONSECUENCIA, no como hallazgo',
    b.muestra.descartes_son_consecuencia_de_la_frontera);
  ok(b.muestra.descartes.menos_de_3_meses > 0, 'los descartes siguen publicándose, pero explicados');

  const md = mockRes();
  await handler(GET({ secret: SECRET, fase: '0', format: 'md' }), md);
  ok(/\*\*La frontera NO respondió\*\*/.test(md.text), 'el markdown lo dice arriba, antes de cualquier número');
  ok(/HTTP 400/.test(md.text) && /Invalid limit/.test(md.text), 'con el status y el cuerpo en la tabla');
  ok(/Key: presente/.test(md.text) && !/apikey=/.test(md.text), 'y el estado de la key, sin publicar su valor');
}

console.log('la frontera: un 401/403 es auth_error, nunca http_error mudo');
{
  for (const st of [401, 403, 402]) {
    global.fetch = mockFetch(FX, { todos: { status: st, body: 'Invalid API KEY' } });
    const r = mockRes();
    await handler(GET({ secret: SECRET, fase: '0' }), r);
    const fallo = r.body.cobertura.simbolos_sin_grades[0];
    ok(fallo.motivo === 'auth_error', `HTTP ${st} → auth_error, no http_error`, fallo.motivo);
    ok(fallo.status === st && /Invalid API KEY/.test(fallo.body_sample || ''), `con el status ${st} y el cuerpo`);
    ok(/env vars|plan de la key/.test(fallo.detalle || ''),
      'y el detalle dice que se arregla en las env vars, no en el código', fallo.detalle);
  }
}

console.log('el smoke: tres variantes, con URL, status y cuerpo de cada una');
{
  // Tope de limit en 100: la variante de 1000 falla, las otras dos andan. Es la
  // hipótesis más probable de un 400 y el smoke tiene que poder separarla.
  todosLimitTope = 100;
  global.fetch = mockFetch(FX);
  const r = mockRes();
  await handler(GET({ secret: SECRET, smoke: SIMS[0] }), r);
  const s = r.body;
  ok(queries.length === 0, 'el smoke NO toca Neon: son 3 requests y nada más');
  ok(s.variantes.length === 3, 'tres variantes', s.variantes.length);
  ok(s.cuota_gastada_requests === 3, 'y se dice qué cuota gastó');
  const alto = s.variantes.find((v) => v.id === 'limit_alto');
  const chico = s.variantes.find((v) => v.id === 'limit_chico');
  const sin = s.variantes.find((v) => v.id === 'sin_limit');
  ok(alto.ok === false && alto.status === 400, 'la variante con limit alto falla 400', `${alto.status}`);
  ok(/Max is 100/.test(alto.body_sample || ''), 'con el cuerpo que lo explica', alto.body_sample);
  ok(chico.ok === true && sin.ok === true, 'las de limit chico y sin limit traen filas');
  ok(sin.url_sin_key === `https://financialmodelingprep.com/stable/grades-historical?symbol=${SIMS[0]}`,
    'la variante sin limit arma la URL sin el parámetro', sin.url_sin_key);
  ok(s.causa === 'limit_rechazado' || s.causa === 'limit_fuera_de_rango',
    'y la LECTURA nombra al limit como causa, no a la key', `${s.causa}: ${s.lectura}`);
  ok(/PARÁMETRO, no la key|techo/.test(s.lectura), 'diciéndolo en letras', s.lectura);
  ok(s.variantes.every((v) => v.url_sin_key && !/apikey/.test(v.url_sin_key)), 'ninguna URL publicada lleva la key');
  ok(s.url_de_referencia.includes('financialmodelingprep.com/stable/grades-historical'),
    'y va la URL de referencia para comparar letra por letra');

  // La key: huella, nunca el valor.
  ok(s.key.presente === true && s.key.longitud > 0, 'la key se reporta como presente y con su longitud');
  ok(/^[0-9a-f]{10}$/.test(s.key.huella_sha256_10), 'con una HUELLA sha256 de 10 hex', s.key.huella_sha256_10);
  ok(!JSON.stringify(s).includes(process.env.FMP_API_KEY), 'y el valor de la key NO aparece en la respuesta');
  ok(/shasum -a 256/.test(s.key.como_comparar), 'con el comando para compararla sin exponerla');
  ok(/vive por ENTORNO/.test(s.key.nota_entorno), 'y la nota de que en Vercel la env var vive por entorno');

  const md = mockRes();
  await handler(GET({ secret: SECRET, smoke: SIMS[0], format: 'md' }), md);
  ok(/LECTURA:/.test(md.text) && /Max is 100/.test(md.text), 'el md del smoke trae la lectura y los cuerpos');
  ok(!md.text.includes(process.env.FMP_API_KEY), 'y tampoco filtra la key');
  todosLimitTope = null;
}

console.log('el smoke sin key, y con todo ok');
{
  const key = process.env.FMP_API_KEY;
  delete process.env.FMP_API_KEY;
  global.fetch = mockFetch(FX);
  const r = mockRes();
  await handler(GET({ secret: SECRET, smoke: 'NKE' }), r);
  process.env.FMP_API_KEY = key;
  ok(r.body.causa === 'sin_key', 'sin key la causa es sin_key, no un http_error', r.body.causa);
  ok(/vive por entorno/i.test(r.body.lectura), 'y la lectura nombra el entorno', r.body.lectura);
  ok(r.body.key.presente === false && r.body.key.huella_sha256_10 === null, 'la key se reporta ausente');

  global.fetch = mockFetch(FX);
  const ok3 = mockRes();
  await handler(GET({ secret: SECRET, smoke: SIMS[0] }), ok3);
  ok(ok3.body.causa === 'frontera_ok', 'con las tres variantes ok, la causa es frontera_ok', ok3.body.causa);
  ok(/La frontera funciona/.test(ok3.body.lectura), 'y lo dice', ok3.body.lectura);

  // Un símbolo que FMP no conoce: HTTP 200 con `Error Message`. No puede salir
  // como "http_error uniforme" — eso esconderría el mensaje que ya está ahí.
  global.fetch = mockFetch(FX);
  const inexistente = mockRes();
  await handler(GET({ secret: SECRET, smoke: 'NKE' }), inexistente);
  ok(inexistente.body.causa === 'fmp_error_message',
    'un 200 con Error Message se nombra como tal, no como http_error', inexistente.body.causa);
  ok(/Symbol not found/.test(inexistente.body.lectura),
    'y la lectura CITA el mensaje de FMP', inexistente.body.lectura);
  ok(/el caso que más engaña/.test(inexistente.body.lectura), 'diciendo por qué un 200 engaña');
}

console.log('concurrencia: bajó a 2 para el censo real');
{
  const fuente = readFileSync(new URL('../api/grades-backtest.js', import.meta.url), 'utf8');
  ok(/const CONCURRENCIA = 2;/.test(fuente), 'la concurrencia es 2, no 4');
  ok(/BAJÓ DE 4 A 2/.test(fuente), 'con el porqué escrito al lado');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
