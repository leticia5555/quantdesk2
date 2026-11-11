// ═══════════════════════════════════════════════════════════════
// Unit tests de /api/macro-events (calendario macro curado).
// El fetch a Neon (SQL-over-HTTP) está mockeado — sin red, sin DB.
// Correr con `node tests/macro-events.test.mjs`.
// ═══════════════════════════════════════════════════════════════

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}

// Env necesario: DATABASE_URL (para que connString no lance) + ADMIN_SECRET.
const realFetch = global.fetch;
const realDb = process.env.DATABASE_URL;
const realAdmin = process.env.ADMIN_SECRET;
const realCron = process.env.CRON_SECRET;
process.env.DATABASE_URL = 'postgres://u:p@ep-test.us-east-1.aws.neon.tech/db';
process.env.ADMIN_SECRET = 's3cret';
delete process.env.CRON_SECRET;

// Mock de Neon: enruta por el contenido del body ({queries}=batch schema,
// {query}=consulta suelta). Devuelve la forma que espera db.js.
function neonMock() {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.queries) {                       // ensureSchema (sqlBatch)
      return { ok: true, status: 200, json: async () => ({ results: body.queries.map(() => ({ fields: [], rows: [] })) }) };
    }
    const q = String(body.query || '');
    const textField = (n) => ({ name: n, dataTypeID: 25 });
    if (/^\s*select/i.test(q)) {              // GET
      return { ok: true, status: 200, json: async () => ({
        fields: ['id', 'event_date', 'title', 'category', 'importance', 'note'].map(textField),
        rows: [
          ['me_1', '2026-08-15', 'Decisión de tasas de la Fed', 'fed', 'high', null],
          ['me_2', '2026-08-20', 'CPI de julio', 'cpi', 'high', 'Consenso 2.9%'],
        ] }) };
    }
    if (/returning\s+id/i.test(q)) {          // DELETE ... returning id
      return { ok: true, status: 200, json: async () => ({ fields: [textField('id')], rows: [[body.params[0]]] }) };
    }
    return { ok: true, status: 200, json: async () => ({ fields: [], rows: [] }) }; // INSERT
  };
}

const { default: handler } = await import('../api/macro-events.js');

console.log('macro-events: GET público');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  // El GET público suma las fechas oficiales del repo (Fed y BLS,
  // `_lib/macro-oficial.js`) a lo curado. Cuántas oficiales entran depende de
  // qué día se corre —se sirven de hoy en adelante—, así que NO se cuenta el
  // total: se cuenta lo curado, y se exige que todo lo demás sea oficial.
  const curados = (res.body.events || []).filter((e) => !String(e.id).startsWith('oficial_'));
  const oficiales = (res.body.events || []).filter((e) => String(e.id).startsWith('oficial_'));
  ok(res.code === 200 && Array.isArray(res.body.events) && curados.length === 2, 'GET devuelve los eventos curados', JSON.stringify(res.body));
  ok(oficiales.every((e) => /^oficial:(federalreserve|bls)\.gov$/.test(e.fuente) && /^https:/.test(e.fuente_url)),
    'y lo que no es curado es oficial, con su fuente', JSON.stringify(oficiales.slice(0, 2)));
  ok(res.body.count === res.body.events.length && typeof res.body.oficial_hasta === 'string',
    'el conteo es el de lo que viaja, y dice hasta dónde llega la lista oficial', JSON.stringify({ count: res.body.count, hasta: res.body.oficial_hasta }));
  {
    const admin = mockRes();
    await handler({ method: 'GET', query: { all: '1' }, headers: {} }, admin);
    ok(admin.body.events.length === 2 && admin.body.events.every((e) => !String(e.id).startsWith('oficial_')),
      'el admin (?all=1) ve SÓLO lo curado: es lo único que puede borrar', JSON.stringify(admin.body.events.map((e) => e.id)));
  }
  ok(res.body.events[0].event_date === '2026-08-15' && res.body.events[0].title.includes('Fed'), 'evento bien formado', JSON.stringify(res.body.events[0]));
  ok(res.headers['Cache-Control'] && res.headers['Cache-Control'].includes('s-maxage'), 'GET público lleva cache CDN');
}

console.log('macro-events: gating de escritura');
{
  global.fetch = neonMock();
  const noauth = mockRes();
  await handler({ method: 'POST', query: {}, headers: {}, body: { event_date: '2026-09-01', title: 'X' } }, noauth);
  ok(noauth.code === 401, 'POST sin Authorization → 401', noauth.code);

  const wrong = mockRes();
  await handler({ method: 'POST', query: {}, headers: { authorization: 'Bearer nope' }, body: { event_date: '2026-09-01', title: 'X' } }, wrong);
  ok(wrong.code === 401, 'POST con secret equivocado → 401', wrong.code);

  const del = mockRes();
  await handler({ method: 'DELETE', query: { id: 'me_1' }, headers: {} }, del);
  ok(del.code === 401, 'DELETE sin auth → 401', del.code);
}

console.log('macro-events: validación (con auth)');
{
  global.fetch = neonMock();
  const auth = { authorization: 'Bearer s3cret' };
  const badDate = mockRes();
  await handler({ method: 'POST', query: {}, headers: auth, body: { event_date: '15/08/2026', title: 'X' } }, badDate);
  ok(badDate.code === 400, 'fecha con formato inválido → 400', badDate.code);

  const noTitle = mockRes();
  await handler({ method: 'POST', query: {}, headers: auth, body: { event_date: '2026-09-01', title: '  ' } }, noTitle);
  ok(noTitle.code === 400, 'title vacío → 400', noTitle.code);
}

console.log('macro-events: happy path (con auth)');
{
  global.fetch = neonMock();
  const auth = { authorization: 'Bearer s3cret' };
  const add = mockRes();
  await handler({ method: 'POST', query: {}, headers: auth,
    body: { event_date: '2026-09-18', title: 'Vencimientos trimestrales', category: 'opex', importance: 'med' } }, add);
  ok(add.code === 200 && add.body.ok === true && add.body.id.startsWith('me_'), 'POST válido → 200 con id me_*', JSON.stringify(add.body));

  const del = mockRes();
  await handler({ method: 'DELETE', query: { id: 'me_1' }, headers: auth }, del);
  ok(del.code === 200 && del.body.deleted === 1, 'DELETE con auth → 200 deleted:1', JSON.stringify(del.body));

  const delNoId = mockRes();
  await handler({ method: 'DELETE', query: {}, headers: auth }, delNoId);
  ok(delNoId.code === 400, 'DELETE sin ?id → 400', delNoId.code);
}

console.log('macro-events: fail closed sin secret configurado');
{
  delete process.env.ADMIN_SECRET;
  delete process.env.CRON_SECRET;
  global.fetch = neonMock();
  const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: { authorization: 'Bearer anything' }, body: { event_date: '2026-09-01', title: 'X' } }, res);
  ok(res.code === 401, 'sin ADMIN_SECRET/CRON_SECRET, cualquier escritura → 401 (nunca abierta)', res.code);
  process.env.ADMIN_SECRET = 's3cret';
}

// restore
global.fetch = realFetch;
if (realDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = realDb;
if (realAdmin === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = realAdmin;
if (realCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = realCron;

if (failures) { console.error('\n' + failures + ' TEST(S) FALLARON'); process.exit(1); }
console.log('\nTODOS LOS TESTS PASAN');
