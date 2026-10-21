#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// scripts/arena-js-medir.mjs — ¿cuánto tarda /api/arena?
//
// DOS MODOS, y miden cosas distintas:
//
//   --local  (default)  Corre el handler REAL con la red simulada. Mide la
//            ESTRUCTURA: cuántas idas a Neon y a Alpaca hace, en qué orden, y
//            cuál es el camino crítico con las latencias que le pases. No toca
//            ningún servicio. NO es "cuánto tarda de verdad".
//              node scripts/arena-js-medir.mjs --neon-ms 60 --schema-ms 900 --alpaca-ms 250
//
//   --url    Le pega a un despliegue N veces y junta el tiempo del cliente y el
//            `Server-Timing` que devuelve la función. ESTO es lo de verdad.
//            Cada pedido lleva `?_m=<azar>` para saltarse el CDN (la respuesta
//            tiene s-maxage=60: sin eso se mediría la caché, no la función).
//              node scripts/arena-js-medir.mjs --url https://quantdesk2.vercel.app/api/arena --n 20
//
// Solo GET. No escribe nada (salvo lo que ya hace /api/arena: ensureSchema,
// que es idempotente — ver docs/arena-js-60s.md, es uno de los motivos).
// ═══════════════════════════════════════════════════════════════

const arg = (k, def) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))] : null; };

// ── MODO LOCAL: el handler real, la red simulada ─────────────────────
export async function medirLocal({ neonMs = 60, schemaMs = 900, alpacaMs = 250 } = {}) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_MEDIR || 'postgres://u:p@ep-medir.us-east-2.aws.neon.tech/db';
  process.env.ALPACA_PAPER_KEY = 'k';
  process.env.ALPACA_PAPER_SECRET = 's';
  const llamadas = [];
  const t0 = Date.now();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const inicio = Date.now() - t0;
    let cuerpo;
    if (/neon\.tech\/sql/.test(u)) {
      const b = JSON.parse(opts.body || '{}');
      if (b.queries) { await dormir(schemaMs); cuerpo = { results: b.queries.map(() => ({ fields: [], rows: [] })) }; llamadas.push({ a: 'neon:schema', sentencias: b.queries.length, inicio }); }
      else { await dormir(neonMs); cuerpo = { fields: [], rows: [] }; llamadas.push({ a: 'neon:select', inicio }); }
    } else if (/alpaca/.test(u)) {
      await dormir(alpacaMs);
      cuerpo = /positions/.test(u) ? [] : { equity: '100000', cash: '1000', status: 'ACTIVE' };
      llamadas.push({ a: 'alpaca:' + (u.split('/v2/')[1] || '?'), inicio });
    } else {
      throw new Error('medir --local: fetch inesperado a ' + u);
    }
    return { ok: true, status: 200, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo), headers: { get: () => 'application/json' } };
  };
  try {
    const { default: handler } = await import('../api/arena.js');
    const correr = async () => {
      const headers = {};
      let body = null;
      const res = { setHeader: (k, v) => { headers[k] = v; }, status() { return this; }, json(b) { body = b; return this; }, end() { return this; } };
      const a = Date.now();
      await handler({ method: 'GET', query: {} }, res);
      return { cliente_ms: Date.now() - a, tiempos: body.tiempos_ms, server_timing: headers['Server-Timing'] };
    };
    const fria = await correr();
    const n0 = llamadas.length;
    const caliente = await correr();
    return { latencias_supuestas: { neonMs, schemaMs, alpacaMs }, fria, caliente, llamadas_fria: llamadas.slice(0, n0), llamadas_caliente: llamadas.slice(n0).length };
  } finally {
    globalThis.fetch = original;
  }
}

// ── MODO URL: producción ─────────────────────────────────────────────
async function medirUrl(url, n) {
  const filas = [];
  for (let i = 0; i < n; i++) {
    const u = url + (url.includes('?') ? '&' : '?') + '_m=' + Math.random().toString(36).slice(2);
    const a = Date.now();
    let st = null, status = null, tiempos = null;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(65000) });
      status = r.status;
      st = r.headers.get('server-timing');
      tiempos = (await r.json().catch(() => ({}))).tiempos_ms || null;
    } catch (e) { status = 'ERR ' + String((e && e.message) || e); }
    filas.push({ i, status, cliente_ms: Date.now() - a, server_timing: st, tiempos });
    await dormir(500);
  }
  const ok = filas.filter((f) => f.status === 200);
  const col = (k) => ok.map((f) => f.tiempos && f.tiempos[k]).filter(Number.isFinite);
  return {
    url, n, ok: ok.length,
    cliente_ms: { p50: pct(ok.map((f) => f.cliente_ms), 50), p95: pct(ok.map((f) => f.cliente_ms), 95), max: Math.max(0, ...ok.map((f) => f.cliente_ms)) },
    funcion_total_ms: { p50: pct(col('total_ms'), 50), p95: pct(col('total_ms'), 95), max: Math.max(0, ...col('total_ms')) },
    schema_ms_max: Math.max(0, ...col('schema_ms')), journal_ms_p95: pct(col('journal_ms'), 95), alpaca_ms_p95: pct(col('alpaca_ms'), 95),
    filas,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = arg('url', null);
  const r = url
    ? await medirUrl(url, Number(arg('n', 20)))
    : await medirLocal({ neonMs: Number(arg('neon-ms', 60)), schemaMs: Number(arg('schema-ms', 900)), alpacaMs: Number(arg('alpaca-ms', 250)) });
  console.log(JSON.stringify(r, null, 2));
}
