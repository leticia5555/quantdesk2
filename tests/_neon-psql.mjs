// ═══════════════════════════════════════════════════════════════════════
// tests/_neon-psql.mjs — db.js habla HTTP con Neon; esto lo ejecuta de verdad
// en el Postgres efímero de _postgres.mjs. Así un endpoint se prueba de punta
// a punta sin red: cada {query, params} se corre con los parámetros como
// literales y la respuesta vuelve con la forma de Neon (fields + rows de
// texto). Lo usan las pruebas de earnings-beat v2.
// ═══════════════════════════════════════════════════════════════════════

// Puente Neon → psql: db.js habla HTTP con Neon; acá ese HTTP se ejecuta de
// verdad en el Postgres efímero (PREPARE + EXECUTE con los parámetros como
// literales), para que los upserts nuevos se prueben como SQL, no como texto.
export function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}
export function sustituye(query, params) {
  return query.replace(/\$(\d+)/g, (_, i) => literal(params[Number(i) - 1]));
}
export function puenteNeon(psql) {
  const corre = ({ query, params = [] }) => {
    const q = sustituye(query, params).trim().replace(/;\s*$/, '');
    const lee = /^(select|with)\b/i.test(q) ? `select coalesce(json_agg(t), '[]') from (${q}) t`
      : /\breturning\b/i.test(q) ? `with t as (${q}) select coalesce(json_agg(t), '[]') from t`
        : null;
    if (!lee) { psql(q + ';'); return { fields: [], rows: [] }; }
    const objs = JSON.parse(psql(lee + ';').trim() || '[]');
    const nombres = objs.length ? Object.keys(objs[0]) : [];
    const oid = (v) => (typeof v === 'number' ? 1700 : typeof v === 'boolean' ? 16 : v && typeof v === 'object' ? 3802 : 25);
    const fields = nombres.map((n) => ({ name: n, dataTypeID: oid(objs.find((o) => o[n] !== null)?.[n] ?? null) }));
    const rows = objs.map((o) => nombres.map((n) => (o[n] === null ? null
      : typeof o[n] === 'object' ? JSON.stringify(o[n]) : typeof o[n] === 'boolean' ? (o[n] ? 't' : 'f') : String(o[n]))));
    return { fields, rows };
  };
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.queries ? { results: body.queries.map(corre) } : corre(body);
    return { ok: true, status: 200, json: async () => data };
  };
}

export function resFalsa() {
  const r = { code: null, headers: {}, cuerpo: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.cuerpo = b; return r; };
  r.send = (b) => { r.cuerpo = b; return r; };
  r.end = () => r;
  return r;
}

