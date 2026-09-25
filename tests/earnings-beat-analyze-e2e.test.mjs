// ═══════════════════════════════════════════════════════════════
// Tests de /api/earnings-beat-analyze de punta a punta, con Neon SIMULADO.
//
// Lo que se defiende acá (el lib se prueba aparte, en
// tests/earnings-beat-analyze.test.mjs):
//
//   1. SOLO LECTURA. Cada query que cruza la frontera se captura y TODAS
//      tienen que ser SELECT. Nada de ensureSchema, nada de heartbeat: latir
//      en un endpoint de análisis enmascararía un cron muerto.
//   2. LAS DOS VISTAS MIRAN LO MISMO. El veredicto y la comparación corren
//      sobre el mismo filtro de liquidez y el mismo ajuste: si cada una
//      armara su dataset, la tabla sería incomparable con el veredicto sin
//      que se note.
//   3. LA COMPARACIÓN NO ES UNA SEÑAL. Cero campos de apuesta, costo o
//      retorno en la respuesta, y el veredicto de la Fase 2 viaja con ella.
//   4. Los parámetros (?zona=, ?orden=, ?asc=, ?format=md) hacen lo que dicen.
//
// Correr con `node tests/earnings-beat-analyze-e2e.test.mjs`.
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

const { default: handler } = await import('../api/earnings-beat-analyze.js');

// ═══════════════════ fixture determinista ═══════════════════
// Sin Math.random: un test que falla una vez de cada diez no prueba nada.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 140 mercados repartidos a lo ancho del rango de precios (para que los tramos
// de la comparación tengan casos, incluida la zona de duda) y 20 con volumen
// por debajo del umbral, que el filtro de liquidez tiene que tirar.
function fabrica({ nMercados = 140, nFlacos = 20 } = {}) {
  const r = rng(7);
  const SECTORES = ['Semiconductors', 'Retail', 'Biotechnology'];
  const mercados = [], historia = [], sectores = [];
  const simbolos = [];

  for (let i = 0; i < nMercados + nFlacos; i++) {
    const sym = 'SYM' + i;
    simbolos.push(sym);
    const flaco = i >= nMercados;
    // Precio del mercado a lo ancho de 0.20–0.99, sin huecos.
    const precio = +(0.20 + 0.79 * ((i % 40) / 39)).toFixed(2);
    // El resultado correlaciona con el precio pero no lo copia: así el
    // mercado tiene acierto realista y no del 100%.
    const beat = r() < precio;
    const mes = (i % 9) + 1;
    const report = `2026-0${mes}-15`;
    mercados.push({
      market_id: 'mk-' + i, symbol: sym, report_date: report,
      resolved_date: `2026-0${mes}-16`,
      outcome: beat ? 'Yes' : 'No',
      yes_price_t24h: String(precio), yes_price_estado: 'valido',
      volume: flaco ? '120' : String(600 + i * 10),
      consensus_pm: '1.00',
    });
    // Ocho trimestres previos, todos ANTERIORES al report_date.
    for (let q = 1; q <= 8; q++) {
      const y = 2026 - Math.ceil(q / 4);
      const m = ((mes + q * 3 - 1) % 12) + 1;
      const est = 1.00, rep = +(est + (r() < precio ? 0.08 : -0.08)).toFixed(2);
      historia.push({
        symbol: sym, reported_date: `${y}-${String(m).padStart(2, '0')}-10`,
        reported_eps: String(rep), estimated_eps: String(est),
        surprise_pct: String(+(((rep - est) / est) * 100).toFixed(2)),
      });
    }
    // Un símbolo de cada diez NO está en mercado_universo_us: su feature de
    // pares queda null, que es lo que pasa en producción.
    if (i % 10 !== 3) sectores.push({ symbol: sym, industria: SECTORES[i % 3] });
  }
  return { mercados, historia, sectores, simbolos };
}

// ── Neon simulado: despacha por el FROM de la query ──
const NUM = 1700, TXT = 25;
const CAMPOS = {
  mercados: [['market_id', TXT], ['symbol', TXT], ['report_date', TXT], ['resolved_date', TXT],
    ['outcome', TXT], ['yes_price_t24h', NUM], ['yes_price_estado', TXT], ['volume', NUM], ['consensus_pm', NUM]],
  historia: [['symbol', TXT], ['reported_date', TXT], ['reported_eps', NUM], ['estimated_eps', NUM], ['surprise_pct', NUM]],
  sectores: [['symbol', TXT], ['industria', TXT]],
};
const respuesta = (tipo, filas) => ({
  fields: CAMPOS[tipo].map(([name, dataTypeID]) => ({ name, dataTypeID })),
  rows: filas.map((f) => CAMPOS[tipo].map(([name]) => (f[name] === undefined ? null : f[name]))),
});

let queries = [];
function mockFetch(fx, { sinSectores = false } = {}) {
  queries = [];
  return async (url, opts) => {
    const u = String(url);
    if (!u.includes('/sql')) return { ok: false, status: 404, json: async () => null };
    const body = JSON.parse(opts.body);
    const lista = body.queries || [body];
    for (const q of lista) queries.push(q.query);
    const q = lista[0].query;
    if (/from pm_earnings_markets/i.test(q)) return { ok: true, status: 200, json: async () => respuesta('mercados', fx.mercados) };
    if (/from pead_earnings/i.test(q)) return { ok: true, status: 200, json: async () => respuesta('historia', fx.historia) };
    if (/from mercado_universo_us/i.test(q)) {
      // La tabla de sectores puede no existir en un despliegue viejo: el
      // endpoint tiene que sobrevivirlo y decirlo, no morirse.
      if (sinSectores) return { ok: false, status: 400, json: async () => ({ message: 'relation "mercado_universo_us" does not exist' }), text: async () => 'relation does not exist' };
      return { ok: true, status: 200, json: async () => respuesta('sectores', fx.sectores) };
    }
    throw new Error('query inesperada: ' + q);
  };
}

const FX = fabrica();

// ═══════════════════ 1. gate ═══════════════════
console.log('earnings-beat-analyze: gate del CRON_SECRET');
{
  global.fetch = mockFetch(FX);
  const sinAuth = mockRes();
  await handler(GET({}), sinAuth);
  ok(sinAuth.code === 401, 'sin secret → 401', sinAuth.code);
  ok(queries.length === 0, 'un 401 no toca la DB', queries.length);

  const vistaSinAuth = mockRes();
  await handler(GET({ vista: 'comparacion' }), vistaSinAuth);
  ok(vistaSinAuth.code === 401, 'la vista de comparación NO es una puerta lateral al gate', vistaSinAuth.code);
  ok(queries.length === 0, 'y tampoco toca la DB', queries.length);

  const porQuery = mockRes();
  await handler(GET({ secret: SECRET }), porQuery);
  ok(porQuery.code === 200, '?secret= (para abrirlo en el navegador) → 200', porQuery.code);
  const porHeader = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), porHeader);
  ok(porHeader.code === 200, 'y por header también', porHeader.code);
  ok(porQuery.headers['Cache-Control'] === 'no-store', 'no-store: esto no se cachea');
}

// ═══════════════════ 2. SOLO LECTURA ═══════════════════
console.log('SOLO LECTURA, verificado en la frontera');
{
  global.fetch = mockFetch(FX);
  const res = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion' }), res);
  ok(res.code === 200, 'la vista de comparación responde 200', res.code);
  ok(queries.length > 0, 'sí consulta la DB', queries.length);
  const escritura = queries.filter((q) => !/^\s*select/i.test(q.trim()));
  ok(escritura.length === 0, 'TODAS las queries son SELECT (cero writes)', JSON.stringify(escritura));
  ok(!queries.some((q) => /create table|alter table|insert into|update |delete from|truncate/i.test(q)),
    'ni un DDL ni un DML se cuela');
  ok(!queries.some((q) => /cron_heartbeat/i.test(q)),
    'no late ningún heartbeat: latir acá enmascararía un cron muerto');

  const fuente = readFileSync(new URL('../api/earnings-beat-analyze.js', import.meta.url), 'utf8');
  // Los comentarios se quitan antes de mirar: la cabecera NOMBRA a
  // ensureSchema y a beat justamente para decir que no se usan, y un lint que
  // se tropieza con su propia documentación no vigila nada.
  const codigo = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/ensureSchema|ensurePeadSchema|\bbeat\s*\(/.test(codigo),
    'el fuente no importa ni ensureSchema ni beat',
    (codigo.match(/.*(ensureSchema|\bbeat\s*\().*/) || [''])[0].trim());
  ok(/ensureSchema/.test(fuente) && /beat\(\)/.test(fuente),
    'y lo dice en la cabecera, para que el próximo no los agregue sin pensarlo');
  // El ajuste corre UNA vez y la comparación consume lo que devolvió. Dos
  // llamadas a analiza() darían dos QuantDesk y ninguna forma de saber cuál
  // dictaminó el veredicto.
  ok((fuente.match(/=\s*analiza\(/g) || []).length === 1, 'analiza() se llama UNA sola vez en el endpoint');
  ok(/comparacion\(eventos,\s*resultado\.predicciones/.test(fuente),
    'y la comparación recibe las predicciones del veredicto, no un ajuste nuevo');
}

// ═══════════════════ 3. las dos vistas, el mismo dataset ═══════════════════
console.log('las dos vistas miran exactamente los mismos mercados');
let comp, ver;
{
  global.fetch = mockFetch(FX);
  const rv = mockRes(); await handler(GET({ secret: SECRET }), rv); ver = rv.body;
  const rc = mockRes(); await handler(GET({ secret: SECRET, vista: 'comparacion' }), rc); comp = rc.body;

  ok(ver.liquidez.antes === 160 && ver.liquidez.sobreviven === 140,
    'el filtro de liquidez tira los 20 flacos', `${ver.liquidez.sobreviven} de ${ver.liquidez.antes}`);
  ok(JSON.stringify(comp.liquidez) === JSON.stringify(ver.liquidez), 'y las dos vistas reportan el MISMO filtro');
  ok(comp.muestra.mercados === ver.muestra.mercados, 'la misma cantidad de mercados', `${comp.muestra.mercados} vs ${ver.muestra.mercados}`);
  ok(comp.muestra.tasa_base === ver.muestra.tasa_base, 'y la misma tasa base');
  ok(comp.filtro.filas_totales === ver.muestra.mercados,
    'una fila por mercado, sin perder ninguno', `${comp.filtro.filas_totales} vs ${ver.muestra.mercados}`);
  ok(comp.filtro.eventos_recibidos === ver.muestra.mercados && comp.filtro.descartadas === 0
    && comp.filtro.aviso_descartadas === null,
    'y la vista declara que no descartó ninguno, en vez de dejarlo suponer',
    JSON.stringify({ r: comp.filtro.eventos_recibidos, d: comp.filtro.descartadas }));
  ok(comp.veredicto_fase2 === ver.veredicto,
    'el veredicto que viaja con la comparación es EL del veredicto, no otro', `${comp.veredicto_fase2} vs ${ver.veredicto}`);
  ok(ver.predicciones === undefined, 'la vista del veredicto no vuelca las 140 predicciones crudas');
  ok(typeof comp.advertencia === 'string' && /SEÑAL, no prueba/.test(comp.advertencia),
    'y la advertencia de "señal, no prueba" también va en la comparación');
}

// ═══════════════════ 4. no es una señal ═══════════════════
console.log('la comparación NO es una señal de apuesta');
{
  function claves(o, acc = new Set()) {
    if (Array.isArray(o)) { for (const x of o) claves(x, acc); return acc; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.add(k); claves(v, acc); }
    return acc;
  }
  const delatoras = [...claves(comp)].filter((k) => /apuesta|neto|retorno|unidad|costo|simulacion|ganancia|edge|kelly|stake/i.test(k));
  ok(delatoras.length === 0, 'ni un campo de apuesta, costo o retorno en la respuesta', delatoras.join(','));
  ok(comp.simulacion === undefined && comp.briers === undefined,
    'la simulación y los Brier del veredicto NO se cuelan en la vista de comparación');
  ok(/NO es una señal de apuesta y NO calcula retornos/.test(comp.no_es_senal), 'y lo dice de frente');
  // Contraste: la vista del veredicto SÍ los trae. Si ésta también los trajera,
  // el test de arriba estaría pasando por vacío.
  ok(ver.simulacion && Number.isFinite(ver.simulacion.neto_unidades),
    'el veredicto sí simula — la diferencia entre las dos vistas es real, no un descuido');
}

// ═══════════════════ 5. titular y tramos ═══════════════════
console.log('titular y tramos');
{
  ok(typeof comp.titular === 'string' && /duda más|se mojan parecido/.test(comp.titular),
    'el titular se dice en letras', comp.titular);
  ok(comp.extremos.de === comp.filtro.filas_totales, 'y se calcula sobre todos los mercados');
  const conCasos = comp.por_tramo.filter((t) => t.n > 0);
  ok(conCasos.length >= 4, 'el fixture cubre varios tramos', conCasos.length);
  ok(comp.por_tramo.some((t) => t.tramo === '0.55–0.65') && comp.por_tramo.some((t) => t.tramo === '0.65–0.75'),
    'la zona de duda aparece partida en dos');
  ok(comp.por_tramo.every((t) => typeof t.muestra_insuficiente === 'boolean'),
    'ningún tramo se publica sin decir si la muestra alcanza');
  ok(comp.por_tramo.reduce((a, t) => a + t.n, 0) === comp.filtro.filas_totales,
    'los tramos suman el total: ningún mercado se cae entre dos tramos');
  ok(comp.distribucion.reduce((a, d) => a + d.quantdesk, 0) === comp.filtro.filas_totales
    && comp.distribucion.reduce((a, d) => a + d.polymarket, 0) === comp.filtro.filas_totales,
    'y la distribución también cuadra por los dos lados');
}

// ═══════════════════ 6. parámetros ═══════════════════
console.log('?zona= · ?orden= · ?asc= · ?format=md');
{
  global.fetch = mockFetch(FX);
  const zona = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', zona: '0.55-0.75' }), zona);
  ok(zona.body.filtro.zona_mercado_desde === 0.55 && zona.body.filtro.zona_mercado_hasta === 0.75,
    'la zona se parsea de "0.55-0.75"');
  ok(zona.body.filas.every((f) => f.prob_polymarket >= 0.55 && f.prob_polymarket < 0.75),
    'y TODAS las filas caen dentro, medidas por el precio del MERCADO');
  ok(zona.body.filas.length > 0 && zona.body.filas.length < zona.body.filtro.filas_totales,
    'filtra de verdad: menos filas que el total, y no cero', `${zona.body.filas.length} de ${zona.body.filtro.filas_totales}`);
  ok(zona.body.filtro.filas_totales === comp.filtro.filas_totales,
    'el total no cambia con el filtro (el titular sigue siendo del universo entero)');

  const duda = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', zona: 'duda' }), duda);
  ok(duda.body.filtro.zona_mercado_desde === 0.55 && duda.body.filtro.zona_mercado_hasta === 0.75,
    '?zona=duda es un alias de 0.55–0.75');
  ok(duda.body.filas.length === zona.body.filas.length, 'y da exactamente lo mismo');

  const basura = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', zona: 'ahí nomás' }), basura);
  ok(basura.body.filtro.zona_mercado_desde === null && basura.body.filas.length === basura.body.filtro.filas_totales,
    'una zona ilegible NO se corrige a la de duda: se ignora y se muestra todo');

  // Un mercado a 1.00 existe (el precio llega al tope) y "hasta 1" tiene que
  // incluirlo: es justo la población de la que habla el titular.
  const alTope = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', zona: '0.9-1' }), alTope);
  ok(alTope.body.filtro.zona_mercado_hasta > 1,
    '?zona=0.9-1 estira el tope para que el precio 1.00 quede DENTRO', alTope.body.filtro.zona_mercado_hasta);
  ok(alTope.body.filas.every((f) => f.prob_polymarket >= 0.9), 'y el piso sigue siendo 0.9');

  const ordenado = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', orden: 'fecha', asc: '1' }), ordenado);
  const fechas = ordenado.body.filas.map((f) => f.report_date);
  ok(fechas.join(',') === fechas.slice().sort().join(','), '?orden=fecha&asc=1 ordena por fecha ascendente');
  const porDefecto = comp.filas.map((f) => f.desacuerdo_abs);
  ok(porDefecto.every((v, i) => i === 0 || porDefecto[i - 1] >= v),
    'y por defecto el desacuerdo más grande va arriba');

  const md = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion', format: 'md' }), md);
  ok(md.code === 200 && typeof md.text === 'string', '?format=md devuelve texto', md.code);
  ok(/text\/plain/.test(md.headers['Content-Type'] || ''), 'con Content-Type de texto');
  ok(new RegExp(`veredicto de la Fase 2 sigue siendo ${comp.veredicto_fase2}`).test(md.text),
    'y el markdown abre con el veredicto que sigue en pie');
  ok(/muestra insuficiente para concluir/.test(md.text), 'la leyenda del ⚠ está escrita, no solo el símbolo');
  ok(/NO es una señal de apuesta y NO calcula retornos/.test(md.text), 'el disclaimer se queda');

  const mdVeredicto = mockRes();
  await handler(GET({ secret: SECRET, format: 'md' }), mdVeredicto);
  ok(/VEREDICTO:/.test(mdVeredicto.text), 'y el markdown del veredicto sigue siendo el de siempre');
}

// ═══════════════════ 7. degradaciones ═══════════════════
console.log('cuando falta algo, se declara');
{
  global.fetch = mockFetch(FX, { sinSectores: true });
  const res = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion' }), res);
  ok(res.code === 200, 'sin la tabla de sectores la vista igual responde', res.code);
  ok(typeof res.body.sectores.error === 'string' && res.body.sectores.con_sector === 0,
    'y el error queda DECLARADO, no tragado', JSON.stringify(res.body.sectores));

  // Tabla vacía: el mensaje manda a la cosecha, no inventa una vista vacía
  // que parezca un resultado.
  global.fetch = mockFetch({ mercados: [], historia: [], sectores: [] });
  const vacia = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion' }), vacia);
  ok(vacia.code === 200 && /corré primero la cosecha/.test(vacia.body.error || ''),
    'sin mercados resueltos: manda a la Fase 1, no devuelve una tabla vacía', JSON.stringify(vacia.body).slice(0, 120));

  // Y un error de la DB sale como 500, no como una vista a medias.
  global.fetch = async () => { throw new Error('boom de red'); };
  const roto = mockRes();
  await handler(GET({ secret: SECRET, vista: 'comparacion' }), roto);
  ok(roto.code === 500 && /earnings-beat-analyze/.test(roto.body.error || ''), 'un error de DB sale 500 con contexto', roto.code);
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
