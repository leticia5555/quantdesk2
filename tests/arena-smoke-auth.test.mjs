// ═══════════════════════════════════════════════════════════════
// Tests de la compuerta de /api/arena-smoke (ARENA_ADMIN_KEY).
//
// El caso que originó esta suite: `curl -H "x-admin-key: ..."` devolvía
// "No autorizado." con la env var BIEN puesta en Vercel, porque el endpoint
// solo leía `Authorization: Bearer` y `?key=` — y el 401 no decía nada, así
// que la pista falsa era "la key está mal". Se prueba acá:
//
//   · las TRES formas de mandarla, cada una por su cuenta;
//   · que un `Authorization` inválido NO pise un `?key=` válido (el viejo
//     `a || b` hacía exactamente eso);
//   · el trim de los dos lados (el `\n` que se cuela al pegar en Vercel);
//   · que el 401 traiga pista accionable...
//   · ...Y QUE LA KEY NUNCA APAREZCA EN EL CUERPO DE LA RESPUESTA.
//
// Correr con `node tests/arena-smoke-auth.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { checkAdminAuth, adminKeyCandidates } from '../api/arena-smoke.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const KEY = 'ak_live_9f3c2b7e41d08a6520ffb1cd';
const req = (headers = {}, query = {}) => ({ method: 'GET', headers, query });

console.log('\n── Las tres formas de mandar la key ──');
ok(checkAdminAuth(req({ authorization: `Bearer ${KEY}` }), KEY).ok, 'Authorization: Bearer');
ok(checkAdminAuth(req({ 'x-admin-key': KEY }), KEY).ok, 'header x-admin-key (el caso reportado)');
ok(checkAdminAuth(req({}, { key: KEY }), KEY).ok, '?key=');
ok(checkAdminAuth(req({}, { admin_key: KEY }), KEY).ok, '?admin_key= (alias tolerado)');
ok(checkAdminAuth(req({ 'X-Admin-Key': KEY }), KEY).ok, 'x-admin-key con mayúsculas');
ok(checkAdminAuth(req({ authorization: KEY }), KEY).ok, 'Authorization con la key pelada (sin Bearer)');
ok(checkAdminAuth(req({ authorization: `bearer   ${KEY}` }), KEY).ok, 'bearer en minúscula y con espacios de más');
ok(checkAdminAuth(req({}, { key: [KEY] }), KEY).ok, '?key= repetido (Vercel lo entrega como array)');

console.log('\n── Ninguna fuente pisa a otra ──');
ok(checkAdminAuth(req({ authorization: 'Bearer basura' }, { key: KEY }), KEY).ok,
  'Authorization inválido NO invalida un ?key= correcto');
ok(checkAdminAuth(req({ authorization: 'Bearer basura', 'x-admin-key': KEY }), KEY).ok,
  'Authorization inválido NO invalida un x-admin-key correcto');
ok(adminKeyCandidates(req({ authorization: `Bearer ${KEY}`, 'x-admin-key': 'otra' }, { key: 'tercera' })).length === 3,
  'se juntan los tres candidatos, no el primero que aparezca');

console.log('\n── Trim de los dos lados ──');
ok(checkAdminAuth(req({ 'x-admin-key': KEY }), `${KEY}\n`).ok, 'env con \\n al final (el clásico de Vercel)');
ok(checkAdminAuth(req({ 'x-admin-key': KEY }), `  ${KEY}  `).ok, 'env con espacios alrededor');
ok(checkAdminAuth(req({ 'x-admin-key': ` ${KEY} ` }), KEY).ok, 'key mandada con espacios alrededor');
ok(checkAdminAuth(req({ authorization: `Bearer ${KEY}\n` }), KEY).ok, 'Bearer con \\n al final');

console.log('\n── El 503: sin llave el endpoint NO queda abierto ──');
for (const [etiqueta, env] of [['env ausente', undefined], ['env vacía', ''], ['env solo espacios', '   ']]) {
  const r = checkAdminAuth(req({ 'x-admin-key': KEY }), env);
  ok(!r.ok && r.status === 503, `${etiqueta} → 503 (no 401, no 200)`, r.status);
  ok(!r.ok && /redeploy/i.test(r.body.hint || ''), `${etiqueta} → la pista menciona el redeploy`, r.body && r.body.hint);
}

console.log('\n── El 401 con pista ──');
const sinKey = checkAdminAuth(req(), KEY);
ok(sinKey.status === 401 && sinKey.body.recibido === null, 'sin key → 401 y recibido:null');
ok((sinKey.body.acepta || []).length === 3 && sinKey.body.acepta.some((a) => a.startsWith('x-admin-key')),
  'el 401 lista las tres formas aceptadas', JSON.stringify(sinKey.body.acepta));
ok(/NINGUNA key/.test(sinKey.body.hint), 'el 401 dice que no llegó ninguna key', sinKey.body.hint);

const otroHeader = checkAdminAuth(req({ 'x-api-key': KEY }), KEY);
ok(otroHeader.status === 401 && (otroHeader.body.headers_que_no_se_leen || []).includes('x-api-key'),
  'key mandada por un header que no se lee → se nombra ese header (y no los que sí)',
  JSON.stringify(otroHeader.body.headers_que_no_se_leen));
ok(/ninguno de esos se lee/.test(otroHeader.body.hint), 'y la pista dice que ese header no se lee', otroHeader.body.hint);
const ambos = checkAdminAuth(req({ 'x-api-key': KEY, 'x-admin-key': 'loquesea', authorization: 'Bearer nope' }), KEY);
ok((ambos.body.headers_que_no_se_leen || []).join() === 'x-api-key',
  'la lista SOLO nombra headers que no se leen (x-admin-key y Authorization no están)',
  JSON.stringify(ambos.body.headers_que_no_se_leen));
ok(checkAdminAuth(req({}, { token: KEY, key: 'nope' }), KEY).body.query_que_no_se_lee.join() === '?token',
  'idem para los query params');

const mismoLargo = checkAdminAuth(req({ 'x-admin-key': 'ak_live_000000000000000000000000' }), KEY);
ok(mismoLargo.status === 401 && mismoLargo.body.recibido[0].mismo_largo_que_la_env === true,
  'key distinta del mismo largo → mismo_largo_que_la_env:true');
ok(/OTRA key/.test(mismoLargo.body.hint), 'y la pista apunta a "es otra key / redeploy / Preview vs Production"', mismoLargo.body.hint);

const otroLargo = checkAdminAuth(req({ 'x-admin-key': 'ak_live_corta' }), KEY);
ok(otroLargo.body.recibido[0].mismo_largo_que_la_env === false, 'key de otro largo → mismo_largo_que_la_env:false');
ok(otroLargo.body.recibido[0].fuente === 'x-admin-key', 'y el 401 dice POR DÓNDE llegó', otroLargo.body.recibido[0].fuente);
ok(otroLargo.body.recibido[0].chars === 13, 'y cuántos chars traía', otroLargo.body.recibido[0].chars);

const comillas = checkAdminAuth(req({ 'x-admin-key': KEY }), `"${KEY}"`);
ok(comillas.status === 401 && comillas.body.env.parece_entre_comillas === true,
  'env guardada entre comillas → se marca (Vercel guarda el literal)');
ok(/comillas/.test(comillas.body.hint), 'y la pista lo dice', comillas.body.hint);

console.log('\n── La key NUNCA viaja en la respuesta ──');
const fugas = [
  ['sin key', checkAdminAuth(req(), KEY)],
  ['key correcta por header que no se lee', checkAdminAuth(req({ 'x-api-key': KEY }), KEY)],
  ['key casi correcta', checkAdminAuth(req({ 'x-admin-key': KEY + 'x' }), KEY)],
  ['key correcta en query mal nombrada', checkAdminAuth(req({}, { token: KEY }), KEY)],
  ['env entre comillas', comillas],
  ['sin env configurada', checkAdminAuth(req({ 'x-admin-key': KEY }), '')],
];
for (const [etiqueta, r] of fugas) {
  const cuerpo = JSON.stringify(r.body);
  ok(!cuerpo.includes(KEY), `${etiqueta}: la key no aparece en el cuerpo`);
  ok(!cuerpo.includes(KEY.slice(8)), `${etiqueta}: tampoco un pedazo reconocible`);
}
// La huella es de LO RECIBIDO, nunca de lo esperado: publicar el hash de la
// key real a cualquiera que pegue un 401 es regalar material para romperla.
const huella = checkAdminAuth(req({ 'x-admin-key': 'loquesea' }), KEY);
ok(/^[0-9a-f]{12}$/.test(huella.body.recibido[0].huella_sha256_12), 'la huella es sha256 corto de lo recibido');
const { createHash } = await import('node:crypto');
const hashKey = createHash('sha256').update(KEY, 'utf8').digest('hex').slice(0, 12);
ok(!JSON.stringify(huella.body).includes(hashKey), 'el cuerpo NO trae la huella de la key esperada');

console.log('\n── El handler usa la compuerta (no una copia) ──');
const { default: handler } = await import('../api/arena-smoke.js');
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; } };
}
const envPrevia = process.env.ARENA_ADMIN_KEY;
process.env.ARENA_ADMIN_KEY = KEY;
const r401 = mockRes();
await handler(req(), r401);
ok(r401.code === 401 && r401.body.acepta, 'GET sin key → 401 con las formas aceptadas', r401.code);
ok(/x-admin-key/.test(r401.headers['Access-Control-Allow-Headers'] || ''),
  'CORS deja mandar x-admin-key desde el browser', r401.headers['Access-Control-Allow-Headers']);
delete process.env.ARENA_ADMIN_KEY;
const r503 = mockRes();
await handler(req({ 'x-admin-key': KEY }), r503);
ok(r503.code === 503, 'sin ARENA_ADMIN_KEY → 503 aunque manden una key', r503.code);
if (envPrevia === undefined) delete process.env.ARENA_ADMIN_KEY; else process.env.ARENA_ADMIN_KEY = envPrevia;

console.log(failures ? `\n${failures} FALLAS\n` : '\nTodo en verde\n');
process.exit(failures ? 1 : 0);
