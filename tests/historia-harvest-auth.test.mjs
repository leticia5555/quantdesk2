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

import { autorizar, llavesDeLaPeticion, llavesConfiguradas, LLAVES } from '../api/historia-harvest.js';

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

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
