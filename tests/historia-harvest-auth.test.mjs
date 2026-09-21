// ═══════════════════════════════════════════════════════════════
// Tests de la autorización de api/historia-harvest.js.
//
// Este endpoint escribe en Neon y le pega a EDGAR con nuestro User-Agent, así
// que su autorización no es un trámite: es lo único entre el mundo y las dos
// cosas. Se prueba con `env` inyectado, sin tocar process.env.
//
// Las dos propiedades que importan y que son opuestas entre sí:
//
//   1. **Tres llaves, cuatro puertas.** En Vercel una env var marcada como
//      Secret no se puede volver a leer, así que un endpoint de una sola llave
//      termina con una llave ilegible para quien la necesita. Varias llaves
//      válidas no debilitan nada; una llave ilegible sí, porque termina pegada
//      en un archivo para no perderla.
//   2. **Fail CLOSED.** Sin ninguna llave configurada no queda abierto: 503.
//      api/_lib/arena-admin.js hace fail-OPEN en `checkLecturaAuth` y está
//      bien ahí —es una lectura—; acá sería regalar escrituras.
//
// Correr con `node tests/historia-harvest-auth.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import handler, { autorizar, llavesDeLaPeticion, llavesConfiguradas, LLAVES } from '../api/historia-harvest.js';
import { conErrorJson, sinSecretos } from '../api/_lib/historia-http.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const pedir = ({ headers = {}, query = {} } = {}) => ({ headers, query });
const CLAVE = 'una-llave-larga-de-verdad-123456';

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las tres llaves');
{
  hondo(LLAVES, ['ADMIN_SECRET', 'CRON_SECRET', 'ARENA_ADMIN_KEY'], 'las tres que acepta');

  for (const nombre of LLAVES) {
    const env = { [nombre]: CLAVE };
    const r = autorizar(pedir({ headers: { 'x-admin-key': CLAVE } }), env);
    ok(r.ok, `${nombre} autoriza`);
    eq(r.via, nombre, `y la respuesta dice cuál fue: ${nombre}`);
  }

  // ARENA_ADMIN_KEY es la que resuelve el caso real: ADMIN_SECRET quedó como
  // Secret en Vercel y no se puede leer.
  const soloArena = { ARENA_ADMIN_KEY: CLAVE };
  ok(autorizar(pedir({ headers: { 'x-admin-key': CLAVE } }), soloArena).ok,
    'con solo ARENA_ADMIN_KEY el endpoint funciona: es el caso que motivó el cambio');

  // Y ADMIN_SECRET sigue sirviendo para lo que ya lo use.
  ok(autorizar(pedir({ headers: { authorization: `Bearer ${CLAVE}` } }), { ADMIN_SECRET: CLAVE }).ok,
    'ADMIN_SECRET sigue funcionando por Bearer, como antes');

  // Varias configuradas: cualquiera sirve.
  const dos = { ADMIN_SECRET: 'otra-llave-distinta-aaaaaaaaaaaa', ARENA_ADMIN_KEY: CLAVE };
  eq(autorizar(pedir({ query: { key: CLAVE } }), dos).via, 'ARENA_ADMIN_KEY', 'con dos puestas, gana la que coincide');
  eq(autorizar(pedir({ query: { key: 'otra-llave-distinta-aaaaaaaaaaaa' } }), dos).via, 'ADMIN_SECRET', 'y la otra también');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Las cuatro puertas');
{
  const env = { ARENA_ADMIN_KEY: CLAVE };
  ok(autorizar(pedir({ headers: { 'x-admin-key': CLAVE } }), env).ok, 'x-admin-key');
  ok(autorizar(pedir({ headers: { authorization: `Bearer ${CLAVE}` } }), env).ok, 'Authorization: Bearer');
  ok(autorizar(pedir({ query: { key: CLAVE } }), env).ok, '?key=');
  ok(autorizar(pedir({ query: { secret: CLAVE } }), env).ok, '?secret= (la puerta histórica del cron)');

  // Mandar la llave pelada en Authorization es un error de dedo, no un ataque.
  const pelada = autorizar(pedir({ headers: { authorization: CLAVE } }), env);
  ok(pelada.ok, 'Authorization sin el prefijo Bearer también entra');
  eq(pelada.fuente, 'Authorization (sin Bearer)', 'y la respuesta dice por dónde llegó');

  // Node baja los headers a minúsculas, pero no todo runtime lo hace.
  ok(autorizar(pedir({ headers: { 'X-Admin-Key': CLAVE } }), env).ok, 'el header se busca sin distinguir mayúsculas');

  // Espacios de un copy-paste.
  ok(autorizar(pedir({ headers: { 'x-admin-key': `  ${CLAVE}  ` } }), env).ok, 'los espacios de un copy-paste no rompen');

  // Un query repetido llega como arreglo.
  ok(autorizar(pedir({ query: { key: ['vieja', CLAVE] } }), env).ok, 'un ?key= repetido usa el último');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Fail CLOSED: sin llave no se escribe, y no es culpa de quien llama');
{
  const r = autorizar(pedir({ headers: { 'x-admin-key': CLAVE } }), {});
  eq(r.ok, false, 'sin ninguna llave configurada NO autoriza');
  eq(r.status, 503, 'y contesta 503, no 401: el que se equivocó es el servidor');
  ok(/Poné una de/.test(r.cuerpo.detalle), 'con la instrucción de qué poner en Vercel');
  hondo(r.cuerpo.acepta, LLAVES, 'y qué nombres sirven');

  // El caso que hay que mirar de frente: una llave VACÍA no configura nada.
  eq(autorizar(pedir({ headers: { 'x-admin-key': '' } }), { ADMIN_SECRET: '' }).status, 503,
    'una env var puesta pero vacía es lo mismo que no tenerla');
  eq(autorizar(pedir({ headers: { 'x-admin-key': '   ' } }), { ADMIN_SECRET: '   ' }).status, 503,
    'y una con solo espacios también');
  hondo(llavesConfiguradas({ ADMIN_SECRET: '', ARENA_ADMIN_KEY: CLAVE }), ['ARENA_ADMIN_KEY'],
    'llavesConfiguradas ignora las vacías');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El 401 dice qué acepta y qué llegó, nunca cuánto vale');
{
  const env = { ARENA_ADMIN_KEY: CLAVE };
  const r = autorizar(pedir({ headers: { 'x-admin-key': 'equivocada' } }), env);
  eq(r.ok, false, 'una llave equivocada no entra');
  eq(r.status, 401, 'y eso sí es 401');
  ok(r.cuerpo.acepta.some((a) => a.includes('ARENA_ADMIN_KEY')), 'el error dice qué llave espera');
  ok(!r.cuerpo.acepta.some((a) => a.includes('ADMIN_SECRET')), 'y no ofrece las que no están configuradas');

  // El largo no es el secreto, y decirlo ahorra media hora de "pero si la mandé".
  hondo(r.cuerpo.recibido, [{ fuente: 'x-admin-key', chars: 10 }], 'dice por dónde llegó y cuántos caracteres');
  const json = JSON.stringify(r.cuerpo);
  ok(!json.includes(CLAVE), 'el valor de la llave BUENA nunca aparece en la respuesta');
  ok(!json.includes('equivocada'), 'ni el de la que mandaron');

  eq(autorizar(pedir({}), env).cuerpo.recibido, 'ninguna llave en la petición',
    'sin llave lo dice así, en vez de una lista vacía que no se entiende');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Detalles de la comparación');
{
  const env = { ARENA_ADMIN_KEY: CLAVE };
  eq(autorizar(pedir({ headers: { 'x-admin-key': CLAVE.slice(0, -1) } }), env).ok, false,
    'un prefijo de la llave no entra');
  eq(autorizar(pedir({ headers: { 'x-admin-key': `${CLAVE}x` } }), env).ok, false, 'ni la llave con algo pegado');
  eq(autorizar(pedir({ headers: { 'x-admin-key': CLAVE.toUpperCase() } }), env).ok, false, 'la comparación distingue mayúsculas');

  // Con timingSafeEqual, dos cadenas vacías serían "iguales". Por eso el
  // largo cero se rechaza antes: si no, una env var vacía autorizaría a
  // cualquiera que mandara un header vacío.
  eq(autorizar(pedir({ headers: { 'x-admin-key': '' } }), { ARENA_ADMIN_KEY: CLAVE }).ok, false,
    'un header vacío no entra');

  hondo(llavesDeLaPeticion(pedir({})), [], 'sin nada en la petición no hay candidatas');
  eq(llavesDeLaPeticion(pedir({ headers: { 'x-admin-key': 'a' }, query: { key: 'b', secret: 'c' } })).length, 3,
    'se juntan todas las candidatas: una puerta equivocada no descarta a las otras');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La puerta de diagnóstico (GET sin ?job=)');
//
// Esta rama no tenía NINGUNA prueba, y por eso se rompió sin que nadie se
// enterara hasta el día que hizo falta. La causa fue un `export … from`, que
// re-exporta sin crear binding local: `llavesConfiguradas` quedó sin definir
// en el módulo, la rama de diagnóstico la usaba y las otras no, así que solo
// se caía ésa. Un diagnóstico que se cae cuando lo necesitás no es un
// diagnóstico.
{
  const resFalso = () => {
    const r = { code: null, cuerpo: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.cuerpo = b; return r; };
    r.end = () => r;
    return r;
  };
  const pedir = async (req, env = {}) => {
    const previo = {};
    for (const k of LLAVES) { previo[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    const res = resFalso();
    try { await handler({ method: 'GET', headers: {}, ...req }, res); } finally {
      for (const k of LLAVES) { delete process.env[k]; if (previo[k] !== undefined) process.env[k] = previo[k]; }
    }
    return res;
  };

  // LA REGRESIÓN, directa.
  {
    const res = await pedir({ query: {} }, { ADMIN_SECRET: 'valor-que-no-debe-salir' });
    eq(res.code, 200, 'el diagnóstico contesta 200, no 500');
    eq(res.cuerpo.modulo, 'historia', 'y devuelve el estado del módulo');
    ok(!res.cuerpo.error, 'sin error adentro');
    eq(res.cuerpo.escritura.estado, 'protegida', 'dice que la escritura está protegida');
    hondo(res.cuerpo.escritura.llaves, ['ADMIN_SECRET'], 'nombrando QUÉ llave está configurada');
    // El valor NUNCA sale. Es la razón de ser de este endpoint: se puede
    // mirar sin miedo cuando la llave no entra.
    ok(!JSON.stringify(res.cuerpo).includes('valor-que-no-debe-salir'),
      'y jamás el valor de la llave');
  }

  // Fail-closed también se ve acá: sin ninguna llave, el diagnóstico avisa
  // que hoy no escribiría nada aunque tuvieras la llave.
  {
    const res = await pedir({ query: {} });
    eq(res.code, 200, 'sin llaves configuradas sigue contestando 200');
    eq(res.cuerpo.escritura.estado, 'DESHABILITADA', 'y lo dice');
    ok(/fail closed/.test(res.cuerpo.escritura.detalle), 'explicando que es fail closed');
    ok(LLAVES.every((k) => res.cuerpo.escritura.detalle.includes(k)), 'y qué llaves acepta');
  }

  // La pregunta que se hace quien llega acá: "¿mi llave está entrando?".
  {
    const buena = await pedir(
      { query: {}, headers: { 'x-admin-key': 'la-correcta' } }, { ADMIN_SECRET: 'la-correcta' },
    );
    eq(buena.cuerpo.escritura.la_tuya_sirve, true, 'con la llave correcta, lo dice');
    hondo(buena.cuerpo.escritura.recibido, [{ fuente: 'x-admin-key', chars: 11 }],
      'y por dónde llegó y de qué largo — nunca el valor');
    ok(!JSON.stringify(buena.cuerpo).includes('la-correcta'), 'sin filtrar lo que se mandó');

    const mala = await pedir(
      { query: {}, headers: { 'x-admin-key': 'la-vieja' } }, { ADMIN_SECRET: 'la-correcta' },
    );
    eq(mala.cuerpo.escritura.la_tuya_sirve, false, 'con la llave equivocada, también lo dice');
    eq(mala.cuerpo.escritura.recibido[0].chars, 8, 'con el largo, que ahorra media hora de "pero si la mandé"');

    const nada = await pedir({ query: {} }, { ADMIN_SECRET: 'la-correcta' });
    eq(nada.cuerpo.escritura.la_tuya_sirve, null, 'sin mandar llave no se afirma nada sobre ella');
    eq(nada.cuerpo.escritura.recibido, 'ninguna llave en esta petición', 'y se dice que no llegó ninguna');
  }

  // El diagnóstico es lo que se agarra cuando todo lo demás falla: tiene que
  // aguantar hasta una petición sin `query`.
  {
    const res = await pedir({}, { ADMIN_SECRET: 'x' });
    eq(res.code, 200, 'sin `query` en la petición sigue contestando');
  }

  // Y la rama protegida sigue pidiendo llave, que es lo que no se rompió.
  {
    const res = await pedir({ query: { job: 'goteo' } }, { ADMIN_SECRET: 'x' });
    eq(res.code, 401, 'un job sin llave sigue dando 401');
    ok(res.cuerpo.error, 'con su JSON de error');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Un 500 en /api/ sale como JSON, no como HTML');
//
// Todo esto se consume con `jq`. La página de error de Vercel convierte un
// `ReferenceError` con nombre y todo en "parse error: Invalid numeric
// literal", que no dice absolutamente nada.
{
  const resFalso = () => {
    const r = { code: null, cuerpo: null, headers: {}, headersSent: false };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.cuerpo = b; return r; };
    return r;
  };

  {
    const revienta = conErrorJson(async () => { throw new ReferenceError('algoConfiguradas is not defined'); },
      { ruta: '/api/prueba' });
    const res = resFalso();
    await revienta({}, res);
    eq(res.code, 500, 'una excepción sale como 500');
    eq(res.cuerpo.tipo, 'ReferenceError', 'con el TIPO del error');
    eq(res.cuerpo.detalle, 'algoConfiguradas is not defined', 'y el mensaje, que es lo que se necesita para arreglarlo');
    eq(res.cuerpo.ruta, '/api/prueba', 'más la ruta');
    ok(/json/i.test(res.headers['Content-Type'] || ''), 'con Content-Type JSON');
    eq(res.headers['Cache-Control'], 'no-store', 'y sin cachear un error');
  }

  // Un handler que anda no se toca.
  {
    const ok200 = conErrorJson(async (req, res) => res.status(200).json({ bien: true }));
    const res = resFalso();
    await ok200({}, res);
    eq(res.code, 200, 'un handler que anda pasa igual');
    eq(res.cuerpo.bien, true, 'con su cuerpo intacto');
  }

  // Si ya se empezó a escribir, no se pisa media respuesta con un JSON que el
  // cliente pegaría al final de lo anterior.
  {
    const tarde = conErrorJson(async (req, res) => { res.headersSent = true; throw new Error('tarde'); });
    const res = resFalso();
    let relanzo = false;
    try { await tarde({}, res); } catch { relanzo = true; }
    ok(relanzo, 'con headers ya enviados se relanza en vez de pisar la respuesta');
    eq(res.code, null, 'y no se escribe un 500 a destiempo');
  }

  // El tamiz: el motivo va, los secretos no. Neon mete la URL completa —con
  // contraseña— en algunos errores de conexión.
  {
    ok(!/cl4v3/.test(sinSecretos('postgres://user:cl4v3@host/db')), 'una contraseña en una URL se borra');
    ok(/host\/db/.test(sinSecretos('postgres://user:cl4v3@host/db')), 'pero el resto del mensaje queda');
    ok(!/AAAABBBBCCCC/.test(sinSecretos('bad key sk-ant-AAAABBBBCCCCDDDD1234')), 'una llave con prefijo se borra');
    eq(sinSecretos('llavesConfiguradas is not defined'), 'llavesConfiguradas is not defined',
      'y un mensaje sin secretos pasa entero: taparlo dejaría al operador donde estaba');
    ok(sinSecretos('x'.repeat(2000)).length <= 400, 'y no se devuelve un mensaje interminable');
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Todo endpoint de Historia sale como JSON ante una excepción');
{
  // Sin esto, el próximo endpoint que se agregue repite el mismo bug: un 500
  // que llega como HTML a algo que se consume con jq.
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../api/', import.meta.url);
  const archivos = readdirSync(dir).filter((f) => /^historia.*\.js$/.test(f));
  ok(archivos.length >= 3, `hay endpoints de historia que revisar (${archivos.length})`);
  for (const f of archivos) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    ok(/export default conErrorJson\(/.test(src), `api/${f} envuelve su handler en conErrorJson`);
  }
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
