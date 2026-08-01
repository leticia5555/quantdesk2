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
    // Idempotente = `create table/index if not exists`. El índice de
    // macro_events (create index if not exists) también es re-ejecutable.
    ok(/^create (table|index) if not exists/i.test(st), 'idempotente: ' + st.slice(0, 45) + '…');
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
  const ALLOWED_DELETES = {
    'api/agents.js': /id = \$1 and user_id = \$2/,          // doble-scoped por dueño
    'api/macro-events.js': /delete from macro_events where id = \$1/i, // admin curado, gated
  };
  let deletes = [];
  for (const p of files) {
    for (const m of readFileSync(p, 'utf8').matchAll(/delete\s+from\s+\w+[^'"`]*/gi)) {
      deletes.push({ file: p.slice(ROOT.length + 1), stmt: m[0].trim() });
    }
  }
  const unexpected = deletes.filter((d) => !ALLOWED_DELETES[d.file] || !ALLOWED_DELETES[d.file].test(d.stmt));
  ok(unexpected.length === 0, 'todo DELETE de api/ está en la allowlist revisada', JSON.stringify(unexpected));
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
