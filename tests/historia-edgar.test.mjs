// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/edgar.js — el transporte de HISTORIA.
//
// Este contenedor NO alcanza sec.gov (docs/historia-fase0.md §0, §10): el
// proxy de egress deniega el CONNECT. Así que acá no se prueba EDGAR — se
// prueba EL CLIENTE, con `fetch`, reloj y `dormir` inyectados. Todo fixture
// es SINTÉTICO y está escrito a mano en este archivo; ninguno es una captura
// de EDGAR, y mientras G7 (§10 del memo) no cierre, nada de lo que pase acá
// autoriza a decir "funciona contra EDGAR".
//
// Lo que sí queda probado, que es lo que un transporte tiene que garantizar:
//
//   1. **El espaciado aguanta la concurrencia.** Es la razón de ser del
//      diseño: con un `lastCall` compartido, N llamadas simultáneas leen el
//      mismo reloj, esperan lo mismo y salen JUNTAS — el limitador dice
//      6 req/s y la SEC ve 6N. Acá se verifica el instante de cada salida,
//      no el promedio.
//   2. **Qué se reintenta y qué no.** Un 429 se reintenta; un 404 no (el
//      documento no va a aparecer por insistir) y un 403 tampoco.
//   3. **El Retry-After de la SEC le gana a nuestro backoff.** Nuestro
//      exponencial es una conjetura; su header es el dato.
//   4. **El 200 que no es JSON se corta.** Un portal cautivo o una página de
//      error contestan 200 con HTML; tragarlo sería ingerir basura como si
//      fuera un filing.
//   5. **Nada se pierde en silencio.** `bajarSubmissionsCompleto` avisa si
//      `maxPaginas` cortó la bajada, porque un recorte mudo convierte
//      "5 años de filings" en "los que cupieron".
//   6. **El CIK con ceros y el CIK entero no se confunden**, que es el error
//      clásico de EDGAR: data.sec.gov pide CIK0001397187 y /Archives/ pide
//      /data/1397187/.
//
// Correr con `node tests/historia-edgar.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  UA_DEFAULT, TECHO_SEC_REQ_POR_SEGUNDO, ESPERA_MAXIMA_MS,
  validarUA, crearCliente, esperaDeRetryAfter, ErrorEdgar,
  pad10, cikInt, sinGuiones,
  urlSubmissions, urlSubmissionsPagina, urlCompanyFacts, urlDocumento, urlIndice,
  bajarTickerMap, bajarSubmissionsCompleto, bajarCompanyFacts,
} from '../api/_lib/edgar.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

async function tira(fn, name, comprobar) {
  try {
    await fn();
    failures++;
    console.error('  FAIL', name, '→ no lanzó');
  } catch (e) {
    if (comprobar) comprobar(e, name);
    else console.log('  PASS', name);
  }
}

// ── El banco de pruebas: reloj falso y fetch falso ────────────────────────
// El reloj solo avanza cuando alguien duerme. Eso hace que las esperas del
// limitador sean observables y que la suite corra en milisegundos reales.
function relojFalso() {
  let t = 0;
  const esperas = [];
  return {
    ahora: () => t,
    dormir: async (ms) => { esperas.push(ms); t += ms; },
    esperas,
    get t() { return t; },
  };
}

// Cada respuesta es {status, body, headers}. `salidas` registra el instante
// del reloj en que se disparó cada request: es lo que prueba el espaciado.
function fetchFalso(respuestas, reloj) {
  const llamadas = [];
  const salidas = [];
  const cola = Array.isArray(respuestas) ? respuestas.slice() : null;
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    salidas.push(reloj ? reloj.ahora() : 0);
    const r = cola ? (cola.length > 1 ? cola.shift() : cola[0]) : respuestas(url, opciones);
    if (r && r.lanza) throw r.lanza;
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (n) => (headers.has(String(n).toLowerCase()) ? headers.get(String(n).toLowerCase()) : null) },
      text: async () => (r.body == null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return { impl, llamadas, salidas };
}

const clienteDePrueba = (respuestas, extra = {}) => {
  const reloj = relojFalso();
  const f = fetchFalso(respuestas, reloj);
  const cli = crearCliente({ fetch: f.impl, ahora: reloj.ahora, dormir: reloj.dormir, reqPorSegundo: 10, ...extra });
  return { cli, reloj, ...f };
};

const OK = (body) => ({ status: 200, body });

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── User-Agent: se valida al crear, no en la request 300');
{
  eq(validarUA(UA_DEFAULT), UA_DEFAULT, 'el UA por defecto pasa la validación');
  ok(UA_DEFAULT.includes('@'), 'el UA por defecto trae contacto');

  for (const malo of ['', '   ', 'bot', 'QuantDesk', 'QuantDesk research']) {
    let lanzo = false;
    try { validarUA(malo); } catch { lanzo = true; }
    ok(lanzo, `rechaza el UA sin contacto: ${JSON.stringify(malo)}`);
  }

  eq(validarUA('  Otra Cosa contacto@ejemplo.com  '), 'Otra Cosa contacto@ejemplo.com', 'recorta espacios');

  let lanzoCliente = false;
  try { crearCliente({ fetch: async () => ({}), ua: 'bot' }); } catch { lanzoCliente = true; }
  ok(lanzoCliente, 'crearCliente falla de entrada con un UA inválido');

  // Sin fetch no hay cliente: mejor un error claro que un `undefined is not a
  // function` a mitad de una ingesta.
  let sinFetch = false;
  try { crearCliente({ fetch: null }); } catch { sinFetch = true; }
  ok(sinFetch, 'crearCliente falla si no hay fetch');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── URLs: el CIK con ceros y el CIK entero son distintos');
{
  eq(pad10(1397187), '0001397187', 'pad10 rellena a diez dígitos');
  eq(pad10('0001397187'), '0001397187', 'pad10 es idempotente');
  eq(pad10('CIK0000320193'), '0000320193', 'pad10 tolera el prefijo CIK');
  eq(cikInt('0001397187'), '1397187', 'cikInt quita los ceros de la izquierda');
  eq(cikInt(320193), '320193', 'cikInt acepta número');
  eq(sinGuiones('0000320193-25-000073'), '000032019325000073', 'sinGuiones limpia el accession');

  eq(urlSubmissions(1397187), 'https://data.sec.gov/submissions/CIK0001397187.json', 'submissions usa el CIK con ceros');
  eq(urlCompanyFacts('1397187'), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001397187.json', 'companyfacts usa el CIK con ceros');
  eq(urlSubmissionsPagina('CIK0001397187-submissions-001.json'),
    'https://data.sec.gov/submissions/CIK0001397187-submissions-001.json', 'la página extra cuelga del mismo host');

  // Ésta es la que se rompe sola si alguien "uniforma" los builders.
  eq(urlDocumento('0000320193', '0000320193-25-000073', 'aapl-20250628.htm'),
    'https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20250628.htm',
    'el documento usa CIK entero y accession sin guiones');
  eq(urlIndice('0000320193', '0000320193-25-000073'),
    'https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/index.json',
    'el index.json usa CIK entero y accession sin guiones');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El UA viaja en TODAS las requests');
{
  const { cli, llamadas } = clienteDePrueba([OK({ a: 1 })]);
  await cli.json('https://data.sec.gov/x.json', { kind: 'x' });
  await cli.json('https://data.sec.gov/y.json', { kind: 'y' });
  eq(llamadas.length, 2, 'se hicieron las dos llamadas');
  ok(llamadas.every((c) => c.opciones.headers['User-Agent'] === UA_DEFAULT), 'toda request lleva el User-Agent');
  ok(llamadas.every((c) => c.opciones.headers['Accept-Encoding'].includes('gzip')), 'toda request pide compresión');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El espaciado: secuencial y, sobre todo, CONCURRENTE');
{
  // Secuencial: a 10 req/s, un turno cada 100 ms.
  const a = clienteDePrueba([OK({})]);
  for (let i = 0; i < 4; i++) await a.cli.json(`https://data.sec.gov/${i}.json`, { kind: 'x' });
  hondo(a.salidas, [0, 100, 200, 300], 'secuencial: una salida cada 100 ms');

  // Concurrente: la prueba que separa este diseño del `lastCall` de la sonda.
  // Con `lastCall`, las cinco leerían t=0, esperarían 100 y saldrían las
  // cinco en t=100 → [100,100,100,100,100]. Acá salen escalonadas.
  const b = clienteDePrueba([OK({})]);
  await Promise.all([0, 1, 2, 3, 4].map((i) => b.cli.json(`https://data.sec.gov/${i}.json`, { kind: 'x' })));
  hondo(b.salidas, [0, 100, 200, 300, 400], 'concurrente: cinco en paralelo salen escalonadas, no en manada');
  eq(new Set(b.salidas).size, 5, 'no hay dos requests en el mismo instante');

  // El techo de la SEC no es negociable hacia arriba.
  const c = clienteDePrueba([OK({})], { reqPorSegundo: 50 });
  eq(c.cli.reqPorSegundo, TECHO_SEC_REQ_POR_SEGUNDO, 'un rps absurdo se recorta al techo de la SEC');
  eq(c.cli.recortadoAlTecho, true, 'y el recorte se declara, no se hace en silencio');

  const d = clienteDePrueba([OK({})], { reqPorSegundo: 0 });
  eq(d.cli.reqPorSegundo, 6, 'un rps inválido cae al default');
  eq(d.cli.recortadoAlTecho, false, 'el default no cuenta como recorte');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Qué se reintenta y qué no');
{
  // 429 dos veces y después sale. El backoff es 1000, 2000.
  const a = clienteDePrueba([
    { status: 429, body: 'slow down' },
    { status: 429, body: 'slow down' },
    OK({ listo: true }),
  ]);
  const r = await a.cli.json('https://data.sec.gov/x.json', { kind: 'x' });
  eq(r.json.listo, true, '429 transitorio: reintenta y entrega');
  eq(a.llamadas.length, 3, 'fueron tres intentos');
  hondo(a.reloj.esperas.filter((ms) => ms >= 1000), [1000, 2000], 'el backoff es exponencial');

  // 429 hasta agotar: el error sale con forma, no con prosa.
  const b = clienteDePrueba([{ status: 429, body: 'no' }]);
  await tira(
    () => b.cli.json('https://data.sec.gov/x.json', { kind: 'x' }),
    '429 persistente lanza',
    (e, name) => {
      ok(e instanceof ErrorEdgar && e.status === 429 && e.clase === 'tasa', name + ' con status y clase');
      eq(b.llamadas.length, 4, 'agotó los 3 reintentos (4 intentos en total)');
    },
  );

  // 503 también es transitorio.
  const c = clienteDePrueba([{ status: 503, body: '' }, OK({ ok: 1 })]);
  const rc = await c.cli.json('https://data.sec.gov/x.json', { kind: 'x' });
  eq(rc.json.ok, 1, '503 se reintenta');

  // 404: insistir no crea el documento.
  const d = clienteDePrueba([{ status: 404, body: 'not found' }]);
  await tira(
    () => d.cli.json('https://data.sec.gov/x.json', { kind: 'x' }),
    '404 lanza',
    (e, name) => {
      ok(e.clase === 'ausente' && e.status === 404, name + ' con clase "ausente"');
      eq(d.llamadas.length, 1, '404 NO se reintenta');
    },
  );

  // 403: ambiguo entre egress y UA, y el mensaje tiene que decir las dos.
  const f = clienteDePrueba([{ status: 403, body: '' }]);
  await tira(
    () => f.cli.json('https://www.sec.gov/x.json', { kind: 'x' }),
    '403 lanza',
    (e, name) => {
      ok(e.clase === 'egress' && e.status === 403, name + ' con clase "egress"');
      ok(/egress/i.test(e.message) && /User-Agent/i.test(e.message), name + ' y nombra las dos causas posibles');
      eq(f.llamadas.length, 1, '403 NO se reintenta');
    },
  );

  // 500: no es de los transitorios conocidos, pero tampoco se traga.
  const g = clienteDePrueba([{ status: 500, body: '' }]);
  await tira(
    () => g.cli.json('https://data.sec.gov/x.json', { kind: 'x' }),
    '500 lanza',
    (e, name) => ok(e.clase === 'http' && e.status === 500, name + ' con clase "http"'),
  );

  // Red caída: se reintenta y termina con clase 'red'.
  const h = clienteDePrueba([{ lanza: new Error('ECONNRESET') }]);
  await tira(
    () => h.cli.json('https://data.sec.gov/x.json', { kind: 'x' }),
    'la red caída lanza',
    (e, name) => {
      eq(e.clase, 'red', name + ' con clase "red"');
      eq(h.llamadas.length, 4, 'la red caída sí se reintenta');
    },
  );

  // Timeout: mismo trato, mensaje propio. companyfacts pesa MB y colgarse
  // sin decir por qué es el peor final posible.
  const abort = Object.assign(new Error('abortado'), { name: 'AbortError' });
  const i = clienteDePrueba([{ lanza: abort }]);
  await tira(
    () => i.cli.json('https://data.sec.gov/x.json', { kind: 'companyfacts' }),
    'el timeout lanza',
    (e, name) => ok(e.clase === 'red' && /timeout/i.test(e.message), name + ' y se nombra como timeout'),
  );
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El Retry-After de la SEC le gana a nuestro backoff');
{
  const a = clienteDePrueba([{ status: 429, body: '', headers: { 'Retry-After': '2' } }, OK({ ok: 1 })]);
  await a.cli.json('https://data.sec.gov/x.json', { kind: 'x' });
  ok(a.reloj.esperas.includes(2000), 'se espera lo que la SEC pidió (2 s), no el 1 s del backoff');
  ok(!a.reloj.esperas.includes(1000), 'y no se usa el backoff cuando hay Retry-After');

  // La función, aparte: segundos, fecha, basura y el tope.
  eq(esperaDeRetryAfter('3', 0), 3000, 'Retry-After en segundos');
  eq(esperaDeRetryAfter('0', 0), 0, 'Retry-After de cero es cero, no "sin dato"');
  eq(esperaDeRetryAfter(null, 0), null, 'sin header no hay espera pedida');
  eq(esperaDeRetryAfter('mañana', 0), null, 'un Retry-After ilegible se ignora');
  eq(esperaDeRetryAfter('99999', 0), ESPERA_MAXIMA_MS, 'un Retry-After eterno se recorta: el lambda tiene 60 s');
  const fecha = new Date(Date.UTC(2026, 0, 1, 0, 0, 10)).toUTCString();
  eq(esperaDeRetryAfter(fecha, Date.UTC(2026, 0, 1, 0, 0, 0)), 10_000, 'Retry-After con fecha HTTP');
  eq(esperaDeRetryAfter(fecha, Date.UTC(2026, 0, 1, 0, 0, 30)), 0, 'una fecha ya pasada no da espera negativa');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El 200 que no es JSON se corta');
{
  const a = clienteDePrueba([{ status: 200, body: '<html><body>Access denied</body></html>' }]);
  await tira(
    () => a.cli.json('https://data.sec.gov/x.json', { kind: 'submissions' }),
    'un 200 con HTML lanza',
    (e, name) => {
      eq(e.clase, 'formato', name + ' con clase "formato"');
      ok(e.message.includes('<html>'), name + ' y muestra el principio del cuerpo');
    },
  );

  // texto() sí acepta cualquier cuerpo: es para el EX-99.1, que es prosa.
  const prosa = 'Exhibit 99.1 — we expect revenue of $1.0B';
  const b = clienteDePrueba([{ status: 200, body: prosa }]);
  const t = await b.cli.texto('https://www.sec.gov/Archives/x.htm', { kind: 'exhibit' });
  ok(t.texto.startsWith('Exhibit 99.1'), 'texto() entrega prosa sin intentar parsearla');
  // El guion largo ocupa 3 bytes en UTF-8 y 1 unidad en UTF-16: si el peso se
  // midiera con `.length` daría 41 en vez de 43, y la cuenta de G4 arrastraría
  // ese error en cada filing con un acento.
  eq(t.bytes, Buffer.byteLength(prosa, 'utf8'), 'texto() reporta el peso en bytes UTF-8');
  eq(t.bytes, 43, 'y son 43 bytes, no las 41 unidades UTF-16 de .length');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── head(): el estado ES la respuesta, no una excepción');
{
  const a = clienteDePrueba([{ status: 200, body: '' }]);
  eq(await a.cli.head('https://www.sec.gov/Archives/x.htm'), 200, 'URL viva → 200');
  eq(a.llamadas[0].opciones.method, 'HEAD', 'usa HEAD y no baja el documento');

  const b = clienteDePrueba([{ status: 404, body: '' }]);
  eq(await b.cli.head('https://www.sec.gov/Archives/x.htm'), 404, 'URL muerta → 404 devuelto, no lanzado');

  const c = clienteDePrueba([{ lanza: new Error('sin red') }]);
  eq(await c.cli.head('https://www.sec.gov/Archives/x.htm'), 'ERR', 'la red caída da ERR, no tumba el censo');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── bajarTickerMap');
{
  const crudo = {
    0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    1: { cik_str: 1397187, ticker: 'meli', title: 'MercadoLibre, Inc.' },
    2: { cik_str: null, ticker: 'ROTO', title: 'sin cik' },
  };
  const { cli } = clienteDePrueba([OK(crudo)]);
  const { map } = await bajarTickerMap(cli);
  eq(map.AAPL.cik, '320193', 'guarda el CIK entero');
  eq(map.AAPL.cikPad, '0000320193', 'y el CIK con ceros, ya calculado');
  eq(map.MELI.nombre, 'MercadoLibre, Inc.', 'normaliza el ticker a mayúsculas');
  eq(map.ROTO, undefined, 'la fila sin CIK se descarta en vez de guardar un cik nulo');

  const vacio = clienteDePrueba([OK({})]);
  await tira(
    () => bajarTickerMap(vacio.cli),
    'un ticker-map vacío lanza',
    (e, name) => ok(e.clase === 'formato', name + ': que EDGAR cambie de forma no puede leerse como "no hay tickers"'),
  );
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── bajarSubmissionsCompleto: los ~1.000 de `recent` no son el historial');
{
  const principal = (files) => OK({
    cik: '1397187',
    name: 'MercadoLibre, Inc.',
    filings: { recent: { form: ['8-K'], accessionNumber: ['0001-24-1'] }, files },
  });
  const pagina = (n) => OK({ form: [`FORMA-${n}`], accessionNumber: [`0009-0${n}-1`] });

  // Caso normal: baja la principal y las dos páginas extra.
  {
    const files = [
      { name: 'CIK0001397187-submissions-001.json', filingFrom: '2018-01-02', filingTo: '2021-06-30' },
      { name: 'CIK0001397187-submissions-002.json', filingFrom: '2012-01-02', filingTo: '2017-12-30' },
    ];
    const { cli, llamadas } = clienteDePrueba([principal(files), pagina(1), pagina(2)]);
    const r = await bajarSubmissionsCompleto(cli, '1397187');
    eq(llamadas.length, 3, 'baja la principal y las dos páginas');
    eq(r.paginas.length, 2, 'devuelve las dos páginas');
    eq(r.paginas[0].archivo, files[0].name, 'cada página viene con su nombre de archivo');
    eq(r.truncado, false, 'nada quedó truncado');
    eq(r.principal.name, 'MercadoLibre, Inc.', 'la principal se entrega cruda');
    ok(r.bytes > 0, 'reporta el peso total');
  }

  // `desde` salta páginas enteras: son cientos de KB que nadie necesita.
  {
    const files = [
      { name: 'p-001.json', filingFrom: '2018-01-02', filingTo: '2021-06-30' },
      { name: 'p-002.json', filingFrom: '2012-01-02', filingTo: '2017-12-30' },
    ];
    const { cli, llamadas } = clienteDePrueba([principal(files), pagina(1)]);
    const r = await bajarSubmissionsCompleto(cli, '1397187', { desde: '2020-01-01' });
    eq(llamadas.length, 2, 'la página que termina antes de la ventana no se baja');
    eq(r.paginasOmitidasPorVentana, 1, 'y la omisión se cuenta');
    eq(r.truncado, false, 'omitir por ventana no es truncar: fue una decisión, no un recorte');
  }

  // Sin filingTo no se puede descartar: ante la duda, se baja.
  {
    const files = [{ name: 'p-001.json' }];
    const { cli, llamadas } = clienteDePrueba([principal(files), pagina(1)]);
    const r = await bajarSubmissionsCompleto(cli, '1397187', { desde: '2024-01-01' });
    eq(llamadas.length, 2, 'una página sin filingTo se baja igual');
    eq(r.paginasOmitidasPorVentana, 0, 'y no se cuenta como omitida');
  }

  // El recorte se declara. Es la línea que evita que "5 años" sea mentira.
  {
    const files = [
      { name: 'p-001.json', filingTo: '2021-06-30' },
      { name: 'p-002.json', filingTo: '2017-12-30' },
      { name: 'p-003.json', filingTo: '2014-12-30' },
    ];
    const { cli, llamadas } = clienteDePrueba([principal(files), pagina(1)]);
    const r = await bajarSubmissionsCompleto(cli, '1397187', { maxPaginas: 1 });
    eq(llamadas.length, 2, 'con maxPaginas=1 se baja una sola página extra');
    eq(r.truncado, true, 'y TRUNCADO queda en true: el recorte nunca es silencioso');
  }

  // Un emisor sin páginas extra (lo normal para los chicos) no rompe nada.
  {
    const { cli, llamadas } = clienteDePrueba([principal(undefined)]);
    const r = await bajarSubmissionsCompleto(cli, '1397187');
    eq(llamadas.length, 1, 'sin files[] se baja solo la principal');
    hondo(r.paginas, [], 'y la lista de páginas es vacía, no undefined');
    eq(r.truncado, false, 'nada truncado');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── bajarCompanyFacts y el contador de bytes (insumo de G4)');
{
  const facts = { cik: 1397187, facts: { 'us-gaap': { Revenues: { units: { USD: [] } } } } };
  const { cli } = clienteDePrueba([OK(facts)]);
  const r = await bajarCompanyFacts(cli, 1397187);
  eq(r.facts.cik, 1397187, 'entrega los facts crudos, sin interpretar');
  eq(r.bytes, JSON.stringify(facts).length, 'y su peso exacto: es el número que decide goteo vs bajo demanda');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── stats(): lo que la ingesta va a querer loguear');
{
  const { cli, reloj } = clienteDePrueba([
    { status: 429, body: '' },
    OK({ a: 1 }),
  ]);
  await cli.json('https://data.sec.gov/x.json', { kind: 'x' });
  await cli.json('https://data.sec.gov/y.json', { kind: 'y' });
  const s = cli.stats();
  eq(s.llamadas, 3, 'cuenta todas las requests, reintentos incluidos');
  eq(s.reintentos, 1, 'y cuántas fueron reintento');
  ok(s.esperaTotalMs > 0, 'suma el tiempo que pasamos esperando nuestro propio turno');
  ok(s.bytes > 0, 'suma los bytes bajados');
  eq(s.detalle.length, 3, 'el detalle por llamada queda disponible');
  ok(s.detalle.every((c) => c.host === 'data.sec.gov'), 'cada llamada anota su host');
  eq(reloj.t > 0, true, 'el reloj falso avanzó solo por las esperas');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
