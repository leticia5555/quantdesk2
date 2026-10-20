// ═══════════════════════════════════════════════════════════════════════
// LOS CONTRATOS DE FORMA — contra el PRODUCTOR, no contra mi memoria
//
// El 2026-10-20 Lety revisó el preview contra producción y encontró cuatro
// defectos. Tres eran el MISMO defecto:
//
//   · la ficha de índice leía `{time, open, high, low, close}` y
//     `/api/candles` devuelve `{t,o,h,l,c,v}`. La gráfica lanzaba, se
//     llevaba por delante a la tabla y al pie, y la pantalla se quedaba en
//     "cargando SPX…" con el endpoint contestando 200;
//   · `/analiza` leía `cal.json.earnings` y `/api/earnings?ticker=` devuelve
//     `history`, con `eps_estimate` y `period` (no `eps_est` ni `date`): el
//     bloque de UPA salía "sin trimestres" para NVDA, que tiene años de
//     historial;
//   · la pestaña de fondos leía `f.name` y `/api/stock-tracker?cat=13f`
//     devuelve `fund`: en pantalla salía el CIK, 1067983, en vez de
//     "Berkshire Hathaway".
//
// Los tres pasaron todas las pruebas porque los fixtures estaban ESCRITOS A
// MANO con la forma que yo creía. Un fixture inventado no puede desmentirme:
// repite lo que supuse.
//
// Así que acá la forma se saca del productor —ejecutándolo con la red
// fingida, o leyendo el literal que arma su respuesta— y se compara contra
// las llaves que la pantalla lee. No prueba que el número esté bien: prueba
// que la pantalla y el endpoint estén hablando del mismo campo, que es lo
// único que falló.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Corre un handler de Vercel en proceso y devuelve `{code, body}`. */
async function corre(handler, query = {}) {
  let code = 200; let body = null;
  const res = {
    setHeader() {}, getHeader() {}, status(c) { code = c; return this; },
    json(o) { body = o; return this; }, send(o) { body = o; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query, headers: {}, url: '/' }, res);
  return { code, body };
}

/** Finge la red para una corrida y la devuelve como estaba. */
async function conRed(responder, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (recurso, opciones) => {
    const u = String((recurso && recurso.url) || recurso || '');
    const r = await responder(u, opciones);
    if (!r) throw new Error('la prueba intentó salir a la red: ' + u);
    return r;
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json' },
});

// ── /api/candles → la ficha de índice ────────────────────────────────
test('una vela de /api/candles trae t,o,h,l,c — y NO time/open/close', async () => {
  const { default: candles } = await import(join(ROOT, 'api/candles.js'));
  const r = await conRed((u) => (u.includes('query1.finance.yahoo.com/v8/finance/chart/')
    ? json({ chart: { result: [{ meta: { currency: 'USD' },
        timestamp: [1760000000, 1760086400],
        indicators: { quote: [{ open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 12], volume: [1, 2] }] } }] } })
    : null), () => corre(candles, { symbol: '^GSPC', interval: '1d' }));

  assert.equal(r.code, 200);
  const v = r.body.candles[0];
  assert.deepEqual(Object.keys(v).sort(), ['c', 'h', 'l', 'o', 't', 'v']);
  // La afirmación que importa: la forma de la librería de gráficas NO es la
  // del endpoint, y confundirlas costó la ficha entera.
  for (const ajeno of ['time', 'open', 'high', 'low', 'close']) {
    assert.equal(v[ajeno], undefined, `una vela del endpoint no trae "${ajeno}"`);
  }
  // Y el tiempo va en SEGUNDOS: en milisegundos, `new Date(t*1000)` cae en el
  // año 57000 y `toISOString()` lanza.
  assert.ok(v.t > 1e9 && v.t < 1e10, 'segundos, no milisegundos: ' + v.t);
});

test('la ficha de índice normaliza la vela del endpoint antes de usarla', () => {
  const html = readFileSync(join(ROOT, 'indice.html'), 'utf8');
  assert.match(html, /normalizaVelas\(datos\.serie\.velas\)/,
    'la serie tiene que pasar por la puerta');

  // Y fuera de la puerta —y del único sitio donde se le habla a la librería—
  // nadie lee `time/open/high/low/close` de una vela. Se mira el código sin
  // comentarios: una prueba que se apaga borrando un comentario mide el
  // comentario.
  const codigo = html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ');
  const sinPuerta = codigo
    .replace(/function normalizaVela\(v\)\{[\s\S]*?\n  \}/, ' ')
    .replace(/function normalizaVela\(v\)\s*\{[\s\S]*?\n  \}/, ' ')
    // El único sitio que arma la forma de la librería: `setData` de velas.
    .replace(/return \{ time:v\.t[^;]*;/g, ' ');
  const sospechosas = sinPuerta.match(/\bv\.(time|open|high|low|close)\b/g) || [];
  assert.deepEqual(sospechosas, [],
    'la página vuelve a leer la forma de la librería fuera de la puerta');
});

// ── /api/candles con la fuente caída ─────────────────────────────────
test('sin velas, el error DICE qué contestó la fuente (no "502" a secas)', async () => {
  const { default: candles } = await import(join(ROOT, 'api/candles.js'));
  const r = await conRed((u) => (u.includes('yahoo') ? json({ error: 'no' }, 429) : null),
    () => corre(candles, { symbol: '^GSPC', interval: '1d' }));
  assert.equal(r.code, 502);
  assert.match(r.body.error, /429/);
  assert.match(r.body.error, /Yahoo/);
});

test('y enProceso conserva esa causa en vez de tapar con el código', async () => {
  const { enProceso } = await import(join(ROOT, 'api/mercado-paneles.js'));
  const handlerQueFalla = async (req, res) => res.status(502).json({ error: 'Yahoo respondió HTTP 429' });
  const r = await enProceso(handlerQueFalla, {});
  assert.match(r.error, /Yahoo respondió HTTP 429/);
  assert.equal(r.code, 502);
  // Un handler que falla SIN decir nada sigue teniendo un mensaje legible.
  const mudo = async (req, res) => res.status(500).end();
  assert.match((await enProceso(mudo, {})).error, /HTTP 500/);
});
