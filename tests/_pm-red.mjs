// Neon + CLOB falsos para los tests de pm-fechas-av, pm-centavos2 y
// pm-drift2h. No es un test (no termina en .test.mjs).
//
//   mercados: filas como las devuelve SQL_MERCADOS (objetos)
//   hist:     filas de pm_v2_hist ({symbol, fiscal_quarter_end, reported_date, reported_eps, estimated_eps})
//   horas:    filas de pead_event_hour ({symbol, reported_date, hour})
//   pead:     filas de pead_earnings ({symbol, reported_date})
//   puntosPorToken: Map token → [{t (ms), p}] que sirve el CLOB
//   cachePrevia: Map market_id → [{t, p}] ya en pm_price_hist ('ok')

export const COLS_MERCADOS = ['market_id', 'symbol', 'slug', 'question', 'descripcion', 'report_date', 'resolved_date', 'creado',
  'outcome', 'volume', 'yes_token_id', 'cosecha', 'orden'];

const txt = (v) => (v === null || v === undefined ? null : String(v));
const campos = (nombres, numericos = []) => nombres.map((name) => ({ name, dataTypeID: numericos.includes(name) ? 1700 : 25 }));

export function mockRed({ mercados = [], hist = [], horas = [], pead = [], puntosPorToken = new Map(), cachePrevia = new Map(), clobCaido = false } = {}) {
  const db = { estados: new Map(), puntos: new Map(), fechas: new Map() };
  for (const [id, pts] of cachePrevia) { db.estados.set(id, 'ok'); db.puntos.set(id, new Map(pts.map((p) => [p.t, p.p]))); }
  const queries = [];
  const clobLlamadas = [];
  const fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/sql')) {
      const body = JSON.parse(opts.body);
      const results = [];
      for (const q of body.queries || [body]) {
        queries.push(q.query);
        const s = q.query.trim();
        const p = q.params || [];
        let fields = [], rows = [];
        if (/^insert into pm_price_hist \(/.test(s)) {
          for (let i = 0; i < p.length; i += 3) {
            if (!db.puntos.has(p[i])) db.puntos.set(p[i], new Map());
            db.puntos.get(p[i]).set(Date.parse(p[i + 1]), p[i + 2]);
          }
        } else if (/^insert into pm_price_hist_fetch/.test(s)) {
          db.estados.set(p[0], p[2]);
        } else if (/^insert into pm_fecha_av/.test(s)) {
          for (let i = 0; i < p.length; i += 11) db.fechas.set(p[i], p.slice(i, i + 11));
        } else if (/pm_earnings_markets_v2/.test(s)) {
          fields = campos(COLS_MERCADOS, ['volume', 'orden']);
          rows = mercados.map((m) => COLS_MERCADOS.map((k) => (k === 'orden' ? (m.cosecha === 'v1' ? '1' : '0') : txt(m[k]))));
        } else if (/from pm_v2_hist/.test(s)) {
          const cols = ['symbol', 'fiscal_quarter_end', 'reported_date', 'reported_eps', 'estimated_eps'];
          fields = campos(cols, ['reported_eps', 'estimated_eps']);
          rows = hist.filter((h) => p.includes(h.symbol) && h.reported_date).map((h) => cols.map((k) => txt(h[k])));
        } else if (/from pead_event_hour/.test(s)) {
          fields = campos(['symbol', 'reported_date', 'hour']);
          rows = horas.filter((h) => p.includes(h.symbol)).map((h) => [h.symbol, h.reported_date, h.hour]);
        } else if (/from pead_earnings/.test(s)) {
          fields = campos(['symbol', 'reported_date']);
          rows = pead.filter((h) => p.includes(h.symbol)).map((h) => [h.symbol, h.reported_date]);
        } else if (/from pm_price_hist_fetch/.test(s)) {
          fields = campos(['market_id', 'estado']);
          rows = [...db.estados].map(([k, v]) => [k, v]);
        } else if (/from pm_price_hist /.test(s)) {
          fields = [{ name: 'market_id', dataTypeID: 25 }, { name: 't', dataTypeID: 20 }, { name: 'p', dataTypeID: 1700 }];
          for (const id of p) for (const [t, pr] of db.puntos.get(id) || []) rows.push([id, String(t), String(pr)]);
        }
        results.push({ fields, rows });
      }
      const out = body.queries ? { results } : results[0];
      return { ok: true, status: 200, json: async () => out };
    }
    if (u.includes('clob.polymarket.com')) {
      const market = new URL(u).searchParams.get('market');
      clobLlamadas.push(market);
      if (clobCaido) return { ok: false, status: 503, headers: new Headers(), text: async () => 'caído' };
      const pts = puntosPorToken.get(market) || [];
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ history: pts.map((x) => ({ t: x.t / 1000, p: x.p })) }) };
    }
    throw new Error('red inesperada: ' + u);
  };
  return { fetch, queries, clobLlamadas, db };
}

export function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.text = s; return this; },
    end() { return this; } };
}
export const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

// Lo único que puede escribir cada endpoint; todo lo demás, SELECT.
export function soloEscribe(assert, queries, tablas) {
  const re = new RegExp(`^(insert into|create table if not exists) (${tablas.join('|')})[ (]`);
  for (const q of queries) {
    const s = q.trim().toLowerCase();
    if (/^(insert|update|delete|alter|drop|truncate|create)/.test(s)) assert.match(s, re, q.slice(0, 80));
    else assert.match(s, /^select/, q.slice(0, 80));
  }
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function fechaMas(fecha, dias) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
export const sig = (z) => 1 / (1 + Math.exp(-z));
export const lg = (p) => Math.log(p / (1 - p));
export const slugDe = (sym, b) => `${sym.toLowerCase()}-quarterly-earnings-nongaap-eps-${b < 0 ? 'neg-' : ''}${Math.abs(b).toFixed(2).replace('.', 'pt')}`;
export const descDe = (c) => `The Street consensus estimate for the company’s non-GAAP EPS for the relevant quarter is ${c < 0 ? '-' : ''}$${Math.abs(c).toFixed(2)} as of market creation.`;
