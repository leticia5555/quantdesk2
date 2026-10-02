// ═══════════════════════════════════════════════════════════════
// Blindajes #0 — "agentes desaparecidos" no vuelve a pasar.
//
// 1) Migración NO destructiva (estático): el SCHEMA es 100% CREATE TABLE/INDEX
//    IF NOT EXISTS y ningún camino de api/ contiene DROP/TRUNCATE.
// 2) Audit de DELETEs (estático): todo DELETE de api/ está en una allowlist
//    revisada a mano — el de agentes doble-scoped por id+user_id, el de
//    macro_events gated por ADMIN_SECRET. Un DELETE nuevo fuera de la lista
//    tumba el test a propósito.
// 3) Crear agente → "redeploy" (re-corre ensureSchema en frío) → el agente
//    PERSISTE y el listado lo devuelve (Neon fake stateful que ejecuta la
//    semántica real de IF NOT EXISTS).
// 4) Re-adopción por email verificado de Stripe (0.2): agentes/edges de un
//    uid anterior se re-parentan al uid nuevo; sin suscripción activa no
//    se adopta nada.
//
// Correr con `node tests/agents-persistence.test.mjs` — sin red.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import agentsHandler from '../api/agents.js';

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';

// ─────────────────── 1) migración no destructiva (estático) ───────────────────
console.log('schema: 100% CREATE TABLE IF NOT EXISTS, cero DROP/TRUNCATE en api/');
{
  const db = readFileSync(join(ROOT, 'api', '_lib', 'db.js'), 'utf8');
  const schemaMatch = /const SCHEMA = \[(.*?)\n\];/s.exec(db);
  ok(!!schemaMatch, 'SCHEMA localizado en db.js');
  const stmts = [...schemaMatch[1].matchAll(/`\s*(create[^`]+)`/gi)].map((m) => m[1].trim());
  ok(stmts.length >= 6, `schema con ${stmts.length} sentencias`);
  for (const st of stmts) {
    // Idempotente = `create table/index if not exists` (incl. `unique index`,
    // como el de arena_state.agent_id que re-llavea el halt por agente). El
    // índice de macro_events también es re-ejecutable.
    ok(/^create (table|(unique )?index) if not exists/i.test(st), 'idempotente: ' + st.slice(0, 45) + '…');
  }

  const files = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, 'api'));
  const destructive = files.filter((p) => /\b(drop\s+table|truncate)\b/i.test(readFileSync(p, 'utf8')));
  ok(destructive.length === 0, 'ningún api/*.js contiene DROP TABLE/TRUNCATE', destructive.join(','));

  // ── 2) audit de DELETEs ──
  // Cada DELETE de api/ debe estar en esta allowlist revisada a mano. El de
  // agentes va doble-scoped por id+user_id; el de macro_events es del admin
  // curado (gated por ADMIN_SECRET, no toca datos de usuario). Un DELETE nuevo
  // fuera de la lista tumba este test a propósito — para que nadie meta un
  // borrado destructivo sin revisión.
  // ── LOS REGEX VAN ANCLADOS, Y ÉSA ES LA MITAD QUE PROTEGE ───────
  // Hasta el 2026-09-29 los cuatro estaban SIN anclar, así que pedían que los
  // nombres aparecieran y nada más. Los cuatro dejaban pasar esto:
  //
  //     delete from agents where id = $1 and user_id = $2 or 1=1
  //
  // Contiene las dos columnas del scope, pasa el regex, y borra la tabla
  // entera. Es la forma clásica en que un delete acotado deja de serlo sin
  // perder los nombres que la guarda busca — y una allowlist que no la caza
  // es una allowlist decorativa.
  //
  // Con `^...$` el statement tiene que ser EXACTAMENTE el aprobado. Un `or`,
  // un `where` extra, un cambio de columna: cualquier cosa distinta cae fuera
  // y hay que revisarla a mano, que es el punto de la lista.
  //
  // El costo es que un cambio inocuo (reordenar el where, agregar un
  // `returning`) también la rompe. Es el costo correcto: se paga una vez por
  // cambio, y lo que compra es que nadie amplíe un DELETE sin que alguien lo
  // lea.
  const ALLOWED_DELETES = {
    'api/agents.js': /^delete from agents where id = \$1 and user_id = \$2$/i,          // doble-scoped por dueño
    'api/macro-events.js': /^delete from macro_events where id = \$1 returning id$/i, // admin curado, gated
    // El kv de flags dinámicos del Arena (hoy: la pausa del vigilante que pone
    // /api/arena-reset mientras aplana las cuentas). Borra UNA fila por clave y
    // no guarda datos de usuario: el "dato" que vive ahí es un vencimiento.
    'api/_lib/arena-baseline.js': /^delete from arena_flags where key = \$1$/i,
    // ── REVISADO EL 2026-09-29, y por qué pasa ───────────────────────
    // `historia-db.guardarItems(cik, accession, items)` reemplaza EN BLOQUE
    // los items de UN filing: si EDGAR corrigió la lista, dejar los viejos
    // conviviendo con los nuevos inventaría items que el filing ya no declara.
    //
    // Estuvo rojo varios días porque revisarlo era afirmar que lo revisé, y no
    // lo había hecho. Los cuatro puntos, ahora que sí:
    //
    //   1. ALCANCE. `cik + accession` es la clave compuesta de UN filing. No
    //      puede barrer una tabla, ni una empresa, ni un año.
    //   2. ATOMICIDAD. El delete y el insert de los items nuevos viajan en el
    //      MISMO `sqlBatch`, o sea un solo request con `queries[]` al endpoint
    //      de Neon, que lo corre como una transacción.
    //   3. Y SI NO LO FUERA: el peor caso es un filing con cero items. Es dato
    //      DERIVADO de EDGAR, público y re-ingestable — se arregla volviendo a
    //      correr la ingesta. Es la diferencia con el DELETE de `agents.js`,
    //      que borra algo que el usuario escribió y no se puede reconstruir.
    //   4. SUPERFICIE. Vive en el camino de ingesta de HISTORIA, no en un
    //      endpoint de usuario.
    //
    // El regex exige las DOS columnas del scope: un `delete from
    // company_filing_items` sin ellas —o con una sola— no pasa esta lista.
    'api/_lib/historia-db.js': /^delete from company_filing_items where cik = \$1 and accession = \$2$/i,
    // ── REVISADO EL 2026-10-02 ───────────────────────────────────────
    // El reset borra las anclas de precio del vigilante
    // (`arena_watch_mark`), que es la única tabla con estado por
    // agente+símbolo SIN columna de fecha: no caduca sola y el reset la
    // dejaba viva, así que el día 1 de una temporada nueva el vigilante medía
    // el ±3% contra precios de la anterior.
    //
    // Es un DELETE SIN WHERE, que es justo lo que esta lista existe para
    // frenar. Pasa por cuatro razones:
    //   1. La tabla es CACHÉ, no registro: `markPrice` trata la ausencia de
    //      fila como "el ancla es el cierre anterior", que es el
    //      comportamiento correcto para una cartera recién nacida.
    //   2. El rastro narrativo NO vive acá — vive en `arena_journal`, que el
    //      reset no toca.
    //   3. Un `where` por agente sería PEOR: dejaría anclas de agentes que
    //      salieron de la liga, que es el mismo bug con menos filas.
    //   4. Solo lo corre `/api/arena-reset?confirm=1`, que es manual, nunca
    //      un cron y nunca un LLM.
    'api/arena-reset.js': /^delete from arena_watch_mark returning agent_id$/i,
  };
  let deletes = [];
  for (const p of files) {
    for (const m of readFileSync(p, 'utf8').matchAll(/delete\s+from\s+\w+[^'"`]*/gi)) {
      deletes.push({ file: p.slice(ROOT.length + 1), stmt: m[0].trim() });
    }
  }
  const unexpected = deletes.filter((d) => !ALLOWED_DELETES[d.file] || !ALLOWED_DELETES[d.file].test(d.stmt));
  ok(unexpected.length === 0, 'todo DELETE de api/ está en la allowlist revisada', JSON.stringify(unexpected));
  // ── LA GUARDA, VERIFICADA ROMPIÉNDOLA ───────────────────────────
  // Una guarda que no se probó rompiendo algo es una guarda que suponemos.
  // Contra CADA entrada de la lista se corre el statement real con un `or`
  // pegado: si alguno pasa, el regex de ése está sin anclar y la allowlist
  // no protege lo que dice proteger.
  const SUFIJOS_DE_ATAQUE = [' or 1=1', ' or true', ' or id is not null'];
  const permisivos = [];
  for (const [archivo, re] of Object.entries(ALLOWED_DELETES)) {
    const real = deletes.find((d) => d.file === archivo);
    if (!real) continue;
    for (const suf of SUFIJOS_DE_ATAQUE) {
      if (re.test(real.stmt + suf)) permisivos.push(`${archivo} acepta "${real.stmt}${suf}"`);
    }
    // Y el control positivo: el statement REAL tiene que seguir pasando. Sin
    // esto, un regex que no acepta nada también daría verde acá.
    ok(re.test(real.stmt), `${archivo}: el DELETE real sigue aprobado`, real.stmt);
  }
  ok(permisivos.length === 0,
    'NINGÚN regex de la allowlist acepta el mismo DELETE con un `or` pegado (que borraría la tabla entera)',
    permisivos.join(' · '));

  // Y que la lista no tenga entradas muertas: un regex para un archivo que ya
  // no tiene DELETE es una aprobación colgada que alguien va a reusar.
  const huerfanas = Object.keys(ALLOWED_DELETES).filter((f) => !deletes.some((d) => d.file === f));
  ok(huerfanas.length === 0, 'ninguna entrada de la allowlist quedó sin su DELETE', huerfanas.join(', '));

  const agentDel = deletes.find((d) => d.file === 'api/agents.js');
  ok(agentDel && /id = \$1 and user_id = \$2/.test(agentDel.stmt),
    'el DELETE de agentes está doble-scoped por id + user_id', agentDel && agentDel.stmt);
}

// ─────────────────── Neon fake stateful ───────────────────
// Ejecuta la semántica que importa: IF NOT EXISTS conserva filas, inserts
// acumulan, updates de user_id re-parentan, selects filtran por uid.
const DB = { tables: {}, log: [] };
function ensureTable(name) { if (!DB.tables[name]) DB.tables[name] = []; }
const F = (names, types) => names.map((n, i) => ({ name: n, dataTypeID: types ? types[i] : 25 }));

function execQuery(query, params = []) {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
  DB.log.push({ q, params });

  if (q.startsWith('create table if not exists')) {
    const name = /create table if not exists (\w+)/.exec(q)[1];
    ensureTable(name); // IF NOT EXISTS: si existe, NO toca las filas
    return { fields: [], rows: [] };
  }
  if (q.startsWith('insert into users')) {
    ensureTable('users');
    const existing = DB.tables.users.find((u) => u.id === params[0]);
    if (existing) { if (params[1] != null) existing.email = params[1]; }
    else DB.tables.users.push({ id: params[0], email: params[1] });
    return { fields: [], rows: [] };
  }
  if (q.startsWith('insert into edges')) {
    ensureTable('edges');
    const existing = DB.tables.edges.find((e) => e.id === params[0]);
    if (existing) Object.assign(existing, { verdict: params[5] });
    else DB.tables.edges.push({ id: params[0], user_id: params[1], engine: params[3], verdict: params[5] });
    return { fields: [], rows: [] };
  }
  if (q.startsWith('insert into agents')) {
    ensureTable('agents');
    DB.tables.agents.push({ id: params[0], user_id: params[1], name: params[2], status: 'alive',
      capital_start: params[3], cash: params[3], equity: params[3], equity_peak: params[3], created_at: '2026-07-15T00:00:00Z' });
    return { fields: [], rows: [] };
  }
  if (q.startsWith('insert into agent_edges')) {
    ensureTable('agent_edges');
    DB.tables.agent_edges.push({ agent_id: params[0], edge_id: params[1] });
    return { fields: [], rows: [] };
  }
  if (q.includes('select count(*)::int as n from agents')) {
    ensureTable('agents');
    const n = DB.tables.agents.filter((a) => a.user_id === params[0]).length;
    return { fields: F(['n'], [23]), rows: [[String(n)]] };
  }
  if (q.startsWith('select id from edges')) {
    ensureTable('edges');
    const wanted = params[1].replace(/[{}]/g, '').split(',');
    const found = DB.tables.edges.filter((e) => e.user_id === params[0] && wanted.includes(e.id));
    return { fields: F(['id']), rows: found.map((e) => [e.id]) };
  }
  if (q.startsWith('select id from users')) {
    ensureTable('users');
    const found = DB.tables.users.filter((u) => (u.email || '').toLowerCase() === params[0] && u.id !== params[1]);
    return { fields: F(['id']), rows: found.map((u) => [u.id]) };
  }
  if (q.startsWith('update agents set user_id')) {
    const olds = params[1].replace(/[{}]/g, '').split(',');
    DB.tables.agents.forEach((a) => { if (olds.includes(a.user_id)) a.user_id = params[0]; });
    return { fields: [], rows: [] };
  }
  if (q.startsWith('update edges set user_id')) {
    const olds = params[1].replace(/[{}]/g, '').split(',');
    DB.tables.edges.forEach((e) => { if (olds.includes(e.user_id)) e.user_id = params[0]; });
    return { fields: [], rows: [] };
  }
  if (q.startsWith('select a.*')) { // listado con n_edges
    ensureTable('agents'); ensureTable('agent_edges');
    const rows = DB.tables.agents.filter((a) => a.user_id === params[0]).map((a) => [
      a.id, a.user_id, a.name, a.status, String(a.equity),
      String(DB.tables.agent_edges.filter((ae) => ae.agent_id === a.id).length),
    ]);
    return { fields: F(['id', 'user_id', 'name', 'status', 'equity', 'n_edges'], [25, 25, 25, 25, 1700, 23]), rows };
  }
  if (q.startsWith('select * from agents where id = $1 and user_id = $2')) {
    const a = DB.tables.agents.find((x) => x.id === params[0] && x.user_id === params[1]);
    return a ? { fields: F(['id', 'user_id', 'name', 'status']), rows: [[a.id, a.user_id, a.name, a.status]] }
             : { fields: [], rows: [] };
  }
  if (q.startsWith('select * from agents where id = $1')) {
    const a = DB.tables.agents.find((x) => x.id === params[0]);
    return a ? { fields: F(['id', 'user_id', 'name', 'status']), rows: [[a.id, a.user_id, a.name, a.status]] }
             : { fields: [], rows: [] };
  }
  if (q.startsWith('delete from agents')) {
    DB.tables.agents = DB.tables.agents.filter((a) => !(a.id === params[0] && a.user_id === params[1]));
    return { fields: [], rows: [] };
  }
  return { fields: [], rows: [] };
}

let stripeHasActiveSub = false;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.stripe.com/v1/customers')) {
    return { ok: true, json: async () => ({ data: stripeHasActiveSub ? [{ id: 'cus_1' }] : [] }) };
  }
  if (u.includes('api.stripe.com/v1/subscriptions')) {
    return { ok: true, json: async () => ({ data: stripeHasActiveSub ? [{ status: 'active' }] : [] }) };
  }
  // Neon
  const body = JSON.parse(opts.body);
  if (body.queries) {
    return { ok: true, json: async () => ({ results: body.queries.map((it) => execQuery(it.query, it.params)) }) };
  }
  return { ok: true, json: async () => execQuery(body.query, body.params) };
};

// ─────────────────── 3) crear → redeploy → persiste ───────────────────
console.log('integración: crear agente → redeploy → el agente persiste');
{
  const libEdge = { id: 'edge1', engine: 'signals', config: { ticker: 'TST', rule: 'rsi' },
    verdict: 'VENTAJA REAL', metrics: {}, verdict_history: [], source: 'quantdesk-app-v0' };

  let res = mockRes();
  await agentsHandler({ method: 'POST', query: {}, body: {
    uid: 'uOLD', email: 'lety@x.com', name: 'Mi Agente', edge_ids: ['edge1'], edges: [libEdge],
  } }, res);
  ok(res.code === 201 && res.body.agent && res.body.agent.id, 'agente creado (201)', JSON.stringify(res.body));
  const agentId = res.body.agent && res.body.agent.id;

  // "redeploy": instancia lambda nueva → ensureSchema corre de cero contra
  // la MISMA DB (import con cache-bust = módulo fresco, schemaReady=false).
  const freshDb = await import('../api/_lib/db.js?redeploy=1');
  await freshDb.ensureSchema();
  ok(DB.tables.agents.length === 1, 'ensureSchema en frío NO borró los agentes', JSON.stringify(DB.tables.agents));

  res = mockRes();
  await agentsHandler({ method: 'GET', query: { uid: 'uOLD' } }, res);
  ok(res.code === 200 && res.body.agents.length === 1 && res.body.agents[0].id === agentId,
    'el listado devuelve el agente tras el redeploy', JSON.stringify(res.body.agents));
}

// ─────────────────── 4) re-adopción por email de Stripe ───────────────────
console.log('re-adopción: uid nuevo + email Pro hereda agentes y edges del uid viejo');
{
  // sin suscripción activa → NO se adopta
  stripeHasActiveSub = false;
  let res = mockRes();
  await agentsHandler({ method: 'GET', query: { uid: 'uNEW', email: 'lety@x.com' } }, res);
  ok(res.code === 200 && res.body.agents.length === 0,
    'email sin suscripción activa: no adopta nada', JSON.stringify(res.body.agents));
  ok(DB.tables.agents[0].user_id === 'uOLD', 'el agente sigue bajo el uid viejo');

  // con suscripción activa → re-parenta agentes + edges
  stripeHasActiveSub = true;
  res = mockRes();
  await agentsHandler({ method: 'GET', query: { uid: 'uNEW', email: 'lety@x.com' } }, res);
  ok(res.code === 200 && res.body.agents.length === 1,
    'con Stripe activo el listado ya trae el agente re-adoptado', JSON.stringify(res.body.agents));
  ok(DB.tables.agents[0].user_id === 'uNEW', 'agents.user_id re-parentado');
  ok(DB.tables.edges[0].user_id === 'uNEW', 'edges.user_id re-parentado (el picker sigue funcionando)');

  // idempotente: repetir no duplica ni rompe
  res = mockRes();
  await agentsHandler({ method: 'GET', query: { uid: 'uNEW', email: 'lety@x.com' } }, res);
  ok(res.code === 200 && res.body.agents.length === 1 && DB.tables.agents.length === 1,
    'repetir la adopción es idempotente');
}

console.log(failures ? `\n${failures} FAIL` : '\nOK — blindajes #0 verificados');
process.exit(failures ? 1 : 0);
