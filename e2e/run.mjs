// AUDITORÍA E2E — app.html wrappers/#43/#44/#45. Solo diagnóstico.
// Playwright: local si está instalado; si no, la instalación global del entorno.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const BASE = 'http://127.0.0.1:8931/app.html';
const results = [];
const consoleLog = [];   // {tab, type, text}
let currentPhase = 'load';

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// ── canned API responses ──
const signalOK = (ticker) => ({
  ticker, verdict: 'VENTAJA REAL',
  explain: 'stub: señal validada.',
  rule: { type: 'rsi', direction: 'long', describe: 'RSI(14) 30/70', rsi_period: 14, entry_level: 30, exit_level: 70 },
  source: 'yahoo (2y daily)', n_bars: 500,
  metrics: { out_of_sample: { total_return: 0.12, win_rate: 0.6, profit_factor: 1.5, ret_sin_mejor: 0.08, sharpe: 1.1, max_drawdown: -0.08, n_trades: 14 } },
  honesty: { k_cumulative: 1, naive_p_value: 0.01, bonferroni: { significant_bonferroni: true } },
  benchmark: { buy_hold_oos: 0.05 },
});
const pairsOK = (x, y) => ({
  pair: { x, y }, verdict: 'VENTAJA REAL', gate_verdict: 'A+B+C', explain: 'stub par ok.',
  n_obs: 480, cointegration: null, ou_half_life: null, oos: { stationary: true, tradeable: true, half_life_bars: 9, adf_stat: -3.4, adf_crit: -2.86 },
  hedge: { beta: 1.02, alpha: 0.01, z_now: 0.4 },
});

let liqDelayMs = 0;
let liqCalls = [];
let apiCalls = [];
let externalUrls = [];
// S18 (relojes rotos): 'none' = stubs vacíos como siempre; 'stale' = solo
// eventos pasados (abril 2026); 'fresh' = eventos futuros relativos a hoy.
let calMode = 'none';
// Si está seteado, /api/claude devuelve este array como texto del modelo
// (para probar el guard de frescura sobre el calendario compuesto por IA).
let econAI = null;

async function routeApis(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    apiCalls.push({ phase: currentPhase, path: p + url.search });
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    if (p === '/api/signal-backtester') return json(signalOK(url.searchParams.get('ticker')));
    if (p === '/api/pairs-validator') return json(pairsOK(url.searchParams.get('x'), url.searchParams.get('y')));
    if (p === '/api/ticker-search') {
      if (url.searchParams.get('profile')) {
        const sym = url.searchParams.get('profile');
        return json({ symbol: sym, name: sym === 'AAPL' ? 'Apple Inc.' : sym + ' Stub Corp',
          industry: 'Technology', country: 'US', exchange: 'NASDAQ', currency: 'USD',
          market_cap_m: 2900000, ipo: '1980-12-12', weburl: 'https://stub' });
      }
      if (url.searchParams.get('liquidity')) {
        const sym = url.searchParams.get('liquidity');
        liqCalls.push({ phase: currentPhase, sym });
        const illiq = sym.startsWith('ILQ');
        if (liqDelayMs) await new Promise(r => setTimeout(r, liqDelayMs));
        return json({ symbol: sym, illiquid: illiq, adv_usd: illiq ? 250000 : 5e9 });
      }
      return json({ results: [{ symbol: 'ZZREMOTE.MX', name: 'Remota Prueba', exchange: 'MEX' }] });
    }
    if (p === '/api/agents' && route.request().method() === 'GET') return json({ agents: [] });
    if (p === '/api/agents' && route.request().method() === 'POST') return json({ ok: true, agent: { id: 'a1' } });
    if (p === '/api/agents-run') return json({ ok: true, processed: 0 });
    if (p === '/api/stripe-status') return json({ pro: false, status: 'none', email: url.searchParams.get('email') });
    if (p === '/api/price') {
      // sigma diferenciada por ticker para S17c/S17d (badge de riesgo)
      const tk = (url.searchParams.get('ticker') || '').toUpperCase();
      const sigma = tk.startsWith('KO') ? 0.20 : tk.startsWith('MU') ? 0.85 : 0.35;
      return json({ ticker: tk, currentPrice: 100, current_price: 100, mu: 0.1, sigma, return30d: 0.06, dayChange: 0.01, asset_type: 'stock', verdict: 'WATCH', longName: 'Stub Co' });
    }
    if (p === '/api/news') return json({ headlines: [] });
    if (p === '/api/earnings' && url.searchParams.get('from') && calMode !== 'none') {
      if (calMode === 'farfuture') {
        // futuro PERO fuera del horizonte "this week": +21/+24 días
        const f1 = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
        const f2 = new Date(Date.now() + 24 * 864e5).toISOString().slice(0, 10);
        return json({ earnings: [
          { ticker: 'FUT1', date: f1, time: 'BMO', eps_est: 2.0 },
          { ticker: 'FUT2', date: f2, time: 'AMC', eps_est: 1.1 },
        ] });
      }
      if (calMode === 'fresh') {
        const d1 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
        const d2 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
        // `company` = enriquecimiento server-side (symbol map de Finnhub en
        // /api/earnings). AAPL trae un nombre distinto al del catálogo local
        // a propósito: prueba que el local mantiene prioridad en el render.
        // ZZOUT está fuera del catálogo de 201: solo puede pintarse desde
        // el server (S21).
        return json({ earnings: [
          { ticker: 'AAPL', date: d1, time: 'AMC', eps_est: 1.5, company: 'Apple Inc (Server)' },
          { ticker: 'MELI', date: d2, time: 'BMO', eps_est: 9.8, company: 'Mercadolibre Inc' },
          { ticker: 'ZZOUT', date: d2, time: 'BMO', eps_est: null, company: 'Zz Outsider Corp' },
        ] });
      }
      return json({ earnings: [
        { ticker: 'JPM', date: '2026-04-10', time: 'BMO', eps_est: 4.6 },
        { ticker: 'DAL', date: '2026-04-09', time: 'BMO', eps_est: 0.4 },
      ] });
    }
    if (p === '/api/ipos' && calMode !== 'none') {
      if (calMode === 'fresh') {
        const up = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
        return json({ this_week: [], later: [], recent: [],
          next_30d: [{ symbol: 'NEWCO', name: 'NewCo', date: up, exchange: 'NASDAQ', status: 'expected', bucket: 'next_30d' }] });
      }
      return json({ this_week: [], next_30d: [], later: [],
        recent: [{ symbol: 'OLDCO', name: 'OldCo', date: '2026-04-12', exchange: 'NYSE', status: 'priced', bucket: 'recent' }] });
    }
    if (p === '/api/claude' && econAI) {
      return json({ content: [{ type: 'text', text: JSON.stringify(econAI) }] });
    }
    if (p === '/api/vc-feed') {
      // Deal flow real (PR del render VC): rounds trae 1 card con fuente
      // caída marcada; latam llega vacío para probar el fallback honesto.
      const cat = url.searchParams.get('cat');
      const d1 = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      if (cat === 'rounds') return json({ cat: 'rounds', items: [
        { title: 'Stubco Raises $12M in Series A Funding', company: 'Stubco', amount: '$12M',
          amount_millions: 12, currency: 'USD', stage: 'A', lead: 'Stub Capital', sector: 'AI',
          source: 'TechCrunch', link: 'https://stub.example/round', date: d1 },
      ], sources: { techcrunch: { ok: true, items: 1 }, crunchbase_news: { ok: false, error: 'HTTP 403' } },
        ai: 'ok', stale: false });
      return json({ cat, items: [], sources: {}, stale: false });
    }
    if (p === '/api/tape') {
      const syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
      const quotes = {};
      for (const s of syms) quotes[s] = { price: s === 'BTC/USD' ? 118000 : 190.55, prevClose: 185.25, changePct: 2.86 };
      return json({ quotes, generated_at: new Date().toISOString() });
    }
    if (p === '/api/macro-markets') {
      // Contrato nuevo: NADA de changePct. Solo price + serie {t,c} de ~3
      // meses. El % por periodo lo calcula el cliente (qdPeriodChange).
      // ^VIX bajo (CALM), curva invertida (^TNX 4.25% ×10 vs 2YY=F 4.60%).
      const nowSec = Math.floor(Date.now() / 1000);
      // Serie que sube ~0.15%/sesión hacia el precio final: 1S/1M/3M dan %
      // distintos y crecientes. La precisión (6 sig) preserva la variación
      // de FX (EUR/USD 1.0850 no se aplasta a 1.08).
      const mkSeries = (price, n = 66) => Array.from({ length: n }, (_, i) => ({
        t: nowSec - (n - 1 - i) * 86400,
        c: +(price * (1 - (n - 1 - i) * 0.0015)).toPrecision(6),
      }));
      const card = (price) => ({ price, currency: 'USD', series: mkSeries(price) });
      return json({ data: {
        '^VIX': card(18.5),
        '^TNX': card(42.5),   // ×10 → 4.25%
        '2YY=F': card(4.60),  // 2Y directo → spread 10Y-2Y invertido
        '^TYX': card(46.0),
        'DX-Y.NYB': card(104.2),
        'JPY=X': card(150.3),
        'EURUSD=X': card(1.0850),
        'CL=F': card(78.4),
        'BZ=F': card(82.1),
        '^N225': card(38500),
        '^KS11': card(2680),
        '^HSI': card(17800),
        '^GDAXI': card(18200),
        '^FTSE': card(7920),
        '^MXX': card(52800),
        '^BVSP': card(128000),
        'ES=F': card(5320),
        'NQ=F': card(18600),
        'YM=F': card(39100),
      }, generated_at: new Date().toISOString() });
    }
    if (p === '/api/candles') {
      // 30 velas sintéticas terminando en el bucket actual (S23).
      // OLDD: última vela 2 buckets atrás (mercado cerrado — S23f).
      // BADROW: 2 filas con OHLC inválido (whitespace guard — S23g).
      const sym = url.searchParams.get('symbol'); const iv = url.searchParams.get('interval') || '1d';
      const ivSec = iv === '5m' ? 300 : iv === '1h' ? 3600 : 86400;
      const nowB = Math.floor(Date.now() / 1000 / ivSec) * ivSec;
      const endB = sym === 'OLDD' ? nowB - 2 * ivSec : nowB;
      const candles = Array.from({ length: 30 }, (_, i) => {
        const base = 100 + i;
        return { t: endB - (29 - i) * ivSec, o: base, h: base + 2, l: base - 2, c: base + 1, v: 1000 + i };
      });
      if (sym === 'BADROW') {
        candles[10] = { t: candles[10].t, o: null, h: null, l: null, c: null, v: 0 };
        candles[20] = { t: candles[20].t, o: 'x', h: 121, l: 119, c: null, v: 0 };
      }
      return json({ symbol: sym, interval: iv, source: 'yahoo', currency: 'USD', candles, generated_at: new Date().toISOString() });
    }
    return json({});
  });
  // block anything external
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => { externalUrls.push(route.request().url()); route.abort(); });
}

function attachConsole(page) {
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') consoleLog.push({ tab: currentPhase, type: t, text: msg.text().slice(0, 300) });
  });
  page.on('pageerror', (err) => consoleLog.push({ tab: currentPhase, type: 'PAGEERROR', text: String(err).slice(0, 400) }));
}

const oldEdges = {
  schema_version: 1,
  edges: [
    { edge_schema_version: 1, id: 'eOLDpair', engine: 'pairs',
      config: { x: 'GOOGL', y: 'AMZN', range: '2y' }, verdict: 'VENTAJA REAL',
      metrics: { gate_verdict: 'A+B+C', stationary_oos: true, tradeable_oos: true, half_life_oos: 8, adf_stat_oos: -3.5, beta: 1.1, z_now: 0.2, n_obs: 480 },
      created_at: '2026-07-10T10:00:00Z', validated_at: '2026-07-10T10:00:00Z',
      verdict_history: [{ at: '2026-07-10T10:00:00Z', verdict: 'VENTAJA REAL', metrics: {} }], source: 'quantdesk-app-v0', notes: null },
    { edge_schema_version: 1, id: 'eOLDsig', engine: 'signals',
      config: { ticker: 'BTC', rule: 'rsi', direction: 'long', range: '2y', params: { rsiPeriod: 14, entryLevel: 30, exitLevel: 70 } },
      verdict: 'FRAGIL',
      metrics: { total_return_oos: 0.05, win_rate_oos: 0.52, profit_factor_oos: 1.1, ret_sin_mejor_oos: 0.01, sharpe_oos: 0.4, max_drawdown_oos: -0.12, n_trades_oos: 9, buy_hold_oos: 0.06, k_cumulative: 3, naive_p_value: 0.2, significant_bonferroni: false },
      created_at: '2026-07-10T10:00:00Z', validated_at: '2026-07-10T10:00:00Z',
      verdict_history: [{ at: '2026-07-10T10:00:00Z', verdict: 'FRAGIL', metrics: {} }], source: 'quantdesk-app-v0', notes: null },
    { edge_schema_version: 1, id: 'eOLDliq', engine: 'signals',
      config: { ticker: 'MSFT', rule: 'sma_cross', direction: 'long', range: '2y', params: { fast: 20, slow: 50 } },
      verdict: 'MARGINAL',
      metrics: { total_return_oos: 0.03, win_rate_oos: 0.51, profit_factor_oos: 1.05, ret_sin_mejor_oos: 0.01, sharpe_oos: 0.2, max_drawdown_oos: -0.1, n_trades_oos: 7, buy_hold_oos: 0.02, k_cumulative: 1, naive_p_value: 0.25, significant_bonferroni: false, illiquid: true, adv_usd: 300000 },
      created_at: '2026-01-05T10:00:00Z', validated_at: '2026-01-05T10:00:00Z',
      verdict_history: [{ at: '2026-01-05T10:00:00Z', verdict: 'MARGINAL', metrics: {} }], source: 'quantdesk-app-v0', notes: null },
    { edge_schema_version: 1, id: 'eILQsig', engine: 'signals',
      config: { ticker: 'ILQX', rule: 'rsi', direction: 'long', range: '2y', params: { rsiPeriod: 14, entryLevel: 30, exitLevel: 70 } },
      verdict: 'MARGINAL',
      metrics: { total_return_oos: 0.02, win_rate_oos: 0.5, profit_factor_oos: 1.0, ret_sin_mejor_oos: 0, sharpe_oos: 0.1, max_drawdown_oos: -0.2, n_trades_oos: 5, buy_hold_oos: 0.01, k_cumulative: 1, naive_p_value: 0.3, significant_bonferroni: false, illiquid: true, adv_usd: 250000 },
      created_at: '2026-07-11T10:00:00Z', validated_at: '2026-07-11T10:00:00Z',
      verdict_history: [{ at: '2026-07-11T10:00:00Z', verdict: 'MARGINAL', metrics: {} }], source: 'quantdesk-app-v0', notes: null },
  ],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
attachConsole(page);
await routeApis(page);

// seed BEFORE app scripts run
await page.addInitScript((edges) => {
  try {
    if (!localStorage.getItem('__seeded')) {
      localStorage.clear();
      localStorage.setItem('qd_edges', JSON.stringify(edges));
      localStorage.setItem('__seeded', '1');
    }
  } catch (e) {}
}, oldEdges);

currentPhase = 'load';
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// ── S0: wrapper sanity — who is wrapped, in what order ──
const wrapInfo = await page.evaluate(() => {
  const src = (f) => (typeof f === 'function' ? f.toString().slice(0, 120).replace(/\s+/g, ' ') : String(f));
  return {
    runPairs: src(window.runPairsValidator),
    runSignals: src(window.runSignalBacktester),
    renderPairs: src(window.renderPairsResult),
    renderSignals: src(window.renderSignalResult),
    metricsLine: src(window.qdEdgeMetricsLine),
    onTickerInput: src(window.onTickerInput),
    onCmpKey: src(window.onCmpKey),
  };
});
console.log('WRAPPERS:', JSON.stringify(wrapInfo, null, 1));

// ── S1: sweep all tabs, collect console ──
// SOCIAL quedó oculto tras el flag QD_HIDE_SOCIAL — fuera del sweep (showPage
// lo redirige a sectors, así que no aportaría nada al audit).
const tabs = ['agents', 'sim', 'compare', 'vc', 'portfolio', 'macro', 'smartmoney', 'earnings', 'ipos', 'movers', 'sectors', 'conexiones', 'screener', 'pairs', 'signals', 'edges', 'myagents', 'gallery'];
for (const tab of tabs) {
  currentPhase = 'tab:' + tab;
  await page.evaluate((t) => {
    if (t === 'edges') { showPage('edges'); qdRenderEdges(); }
    else if (t === 'myagents') { showPage('myagents'); qdAgentsOpen(); }
    else showPage(t);
  }, tab);
  await page.waitForTimeout(900);
}
report('S1 sweep de 18 tabs', true, 'consola al final');

// ── S2: MIS EDGES cards con edges pre-#45 ──
currentPhase = 'S2-edges-cards';
await page.evaluate(() => { showPage('edges'); qdRenderEdges(); });
const cards = await page.locator('.edge-card').count();
const edgesHtml = await page.locator('#edgesList').innerHTML();
report('S2a MIS EDGES renderea 4 cards pre-#45', cards === 4, 'cards=' + cards);
report('S2b sin "undefined"/"NaN" en cards', !/undefined|NaN/.test(edgesHtml), '');
report('S2c card ilíquida muestra aviso ⚠', edgesHtml.includes('ilíquido'), '');
report('S2d solo las cards con flag muestran aviso (2 de 4)', (edgesHtml.match(/ilíquido/g) || []).length === 2, 'ocurrencias=' + (edgesHtml.match(/ilíquido/g) || []).length);

// ── S3: picker de agentes con edges viejos ──
currentPhase = 'S3-agent-picker';
await page.evaluate(() => { showPage('myagents'); });
await page.evaluate(() => qdAgentCreateOpen());
await page.waitForTimeout(300);
const pickerOpts = await page.locator('#agEdgePicker .ag-edge-opt').count();
const pickerHtml = await page.locator('#agEdgePicker').innerHTML();
report('S3a picker muestra 4 edges', pickerOpts === 4, 'opts=' + pickerOpts);
report('S3b picker sin undefined', !/undefined|NaN/.test(pickerHtml), '');
// Enter en el input de nombre del agente no debe validar nada
const beforeEnter = apiCalls.length;
await page.locator('#agName').fill('Agente X');
await page.locator('#agName').press('Enter');
await page.waitForTimeout(400);
const newCalls = apiCalls.slice(beforeEnter).filter(c => /signal-backtester|pairs-validator/.test(c.path));
report('S3c Enter en nombre de agente no dispara validaciones', newCalls.length === 0, JSON.stringify(newCalls));
await page.evaluate(() => qdAgentCreateClose());

// ── S4: autocomplete en PARES — selección con Enter no valida; Enter sin selección sí ──
currentPhase = 'S4-pares-ac';
await page.evaluate(() => showPage('pairs'));
await page.locator('#pvY').click();
await page.keyboard.type('AMZN', { delay: 30 });
await page.keyboard.press('Escape');
await page.locator('#pvX').click();
await page.keyboard.type('BT', { delay: 40 });
await page.waitForTimeout(150);
const acVisible = await page.locator('.qd-ac-list').isVisible();
const acText = acVisible ? await page.locator('.qd-ac-list').innerText() : '';
report('S4a dropdown visible en pvX', acVisible, '');
report('S4b BTC normalizado (sin /USD) con chip CRYPTO', /BTC/.test(acText) && !/BTC\/USD/.test(acText) && /CRYPTO/.test(acText), acText.split('\n').slice(0, 3).join(' / '));
const beforeSel = apiCalls.filter(c => c.path.includes('pairs-validator')).length;
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const pvXval = await page.locator('#pvX').inputValue();
const afterSel = apiCalls.filter(c => c.path.includes('pairs-validator')).length;
report('S4c Enter con selección pone BTC y NO valida', pvXval === 'BTC' && afterSel === beforeSel, 'pvX=' + pvXval + ' fetches=' + (afterSel - beforeSel));
// Enter sin selección → valida (y pasa por el gate del paywall)
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const afterRun = apiCalls.filter(c => c.path.includes('pairs-validator')).length;
report('S4d Enter sin selección dispara la validación', afterRun === beforeSel + 1, 'fetches=' + (afterRun - beforeSel));
const proTxt = await page.locator('#qdProBtn').innerText();
report('S4e contador free descontó 1', /1\/3/.test(proTxt), proTxt);
await page.waitForTimeout(600);
const saveBtnPairs = await page.locator('#qdSaveBtn-pairs').count();
report('S4f botón GUARDAR EDGE inyectado (wrapper #43 vivo bajo #45)', saveBtnPairs === 1, '');

// ── S5: dropdown singleton al cambiar de tab + oclusión/z-index ──
currentPhase = 'S5-tab-switch';
await page.locator('#pvX').fill('');
await page.locator('#pvX').click();
await page.keyboard.type('BT', { delay: 40 });
await page.waitForTimeout(150);
const visBefore = await page.locator('.qd-ac-list').isVisible();
await page.locator('.nav-btn[onclick*="showPage(\'signals\')"]').click();
await page.waitForTimeout(400);
const visAfter = await page.locator('.qd-ac-list').isVisible();
report('S5a dropdown abierto en PARES se cierra al cambiar a SEÑALES', visBefore && !visAfter, 'antes=' + visBefore + ' después=' + visAfter);
// oclusión: abrir dropdown en cada tab con input conectado y verificar elementFromPoint
for (const [tab, inputId] of [['pairs', 'pvX'], ['signals', 'sbTicker'], ['sim', 'simTicker'], ['compare', 'cmp1']]) {
  currentPhase = 'S5-occlusion-' + tab;
  await page.evaluate((t) => showPage(t), tab);
  await page.waitForTimeout(300);
  await page.locator('#' + inputId).fill('');
  await page.locator('#' + inputId).click();
  await page.keyboard.type('BT', { delay: 40 });
  await page.waitForTimeout(200);
  const occl = await page.evaluate(() => {
    const el = document.querySelector('.qd-ac-list');
    if (!el || el.style.display === 'none') return 'dropdown no visible';
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2));
    return el.contains(hit) ? 'ok' : 'ocluido por ' + (hit ? hit.tagName + '.' + hit.className : 'null');
  });
  report('S5b dropdown sin oclusión en ' + tab, occl === 'ok', occl);
  await page.keyboard.press('Escape');
}

// ── S6: SEÑALES — validar, GUARDAR EDGE con flag illiquid (fetch rápido) ──
currentPhase = 'S6-signals-illiquid';
await page.evaluate(() => showPage('signals'));
await page.locator('#sbTicker').fill('ILQX');
await page.keyboard.press('Escape');
await page.locator('#sbTicker').press('Enter');
await page.waitForTimeout(800);
const warn = await page.locator('#qdLiqWarn-signals').count();
report('S6a aviso LIQUIDEZ BAJA visible', warn === 1, '');
const draftFlag = await page.evaluate(() => window.__qdEdgeDraft.signals && window.__qdEdgeDraft.signals.metrics.illiquid);
report('S6b draft lleva metrics.illiquid', draftFlag === true, String(draftFlag));
await page.locator('#qdSaveBtn-signals').click();
await page.waitForTimeout(200);
const savedFlag = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.config.ticker === 'ILQX' && e.id !== 'eILQsig');
  return e ? { count: s.edges.length, illiquid: e.metrics.illiquid, dedup: false } : { count: s.edges.length, dedup: true };
});
report('S6c edge guardado con illiquid persistido', savedFlag.illiquid === true || savedFlag.dedup, JSON.stringify(savedFlag));

// reset de cuota free y cierre de modales para no contaminar escenarios
async function resetQuota() {
  await page.evaluate(() => { localStorage.removeItem('qd_valids'); qdRenderProUi(); qdCloseModal(); });
}
await resetQuota();
// ── S7: re-validar edge ilíquido — ¿conserva metrics.illiquid? ──
currentPhase = 'S7-revalidate';
await page.evaluate(() => { showPage('edges'); qdRenderEdges(); });
await page.waitForTimeout(200);
await page.locator('#qdReval-eILQsig').click();
await page.waitForTimeout(1400);
const afterReval = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.id === 'eILQsig');
  return { illiquid: e.metrics.illiquid, verdict: e.verdict, histLen: e.verdict_history.length };
});
report('S7 re-validar RE-CHEQUEA liquidez (sigue ilíquido → true)', afterReval.illiquid === true, JSON.stringify(afterReval));
// S7b: edge marcado ilíquido cuyo ticker HOY es líquido → el flag decae a false
currentPhase = 'S7b-liquidity-decay';
await resetQuota();
await page.locator('#qdReval-eOLDliq').click();
await page.waitForTimeout(1400);
const s7b = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.id === 'eOLDliq');
  return { illiquid: e.metrics.illiquid, adv: e.metrics.adv_usd };
});
report('S7b re-validar LIMPIA el flag si ya es líquido', s7b.illiquid === false, JSON.stringify(s7b));

await resetQuota();
// ── S8: re-validar edge viejo con ticker BTC (formato normalizado) ──
currentPhase = 'S8-btc-reval';
const beforeBtc = apiCalls.filter(c => c.path.includes('signal-backtester')).length;
await page.locator('#qdReval-eOLDsig').click();
await page.waitForTimeout(900);
const btcCall = apiCalls.filter(c => c.path.includes('signal-backtester')).slice(-1)[0] || { path: 'NINGUNA LLAMADA' };
const afterBtc = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.id === 'eOLDsig');
  return { verdict: e.verdict, histLen: e.verdict_history.length };
});
report('S8 re-validar edge viejo BTC funciona', /ticker=BTC(&|$)/.test(btcCall.path) && afterBtc.histLen === 2, btcCall.path.slice(0, 90) + ' → ' + JSON.stringify(afterBtc));

// ── S9: paywall — email input con Enter (capture listener no interfiere) ──
currentPhase = 'S9-paywall-email';
await page.evaluate(() => qdShowEstado());
await page.waitForTimeout(200);
await page.locator('#qdProEmailInput').fill('lety@test.com');
const beforeVerify = apiCalls.filter(c => c.path.includes('stripe-status')).length;
await page.locator('#qdProEmailInput').press('Enter');
await page.waitForTimeout(500);
const afterVerify = apiCalls.filter(c => c.path.includes('stripe-status')).length;
const verifyMsg = await page.locator('#qdVerifyMsg').innerText();
report('S9 Enter en email del paywall dispara verificación', afterVerify === beforeVerify + 1, 'msg=' + verifyMsg);
await page.evaluate(() => qdCloseModal());

await resetQuota();
// ── S10: race del draft — liquidez lenta contamina el draft siguiente ──
currentPhase = 'S10-draft-race';
liqDelayMs = 900;
await page.evaluate(() => { showPage('signals'); const c = window.qdLiqCache; for (const k in c) delete c[k]; });
await page.locator('#sbTicker').fill('ILQZ');
await page.keyboard.press('Escape');
await page.locator('#sbTicker').press('Enter');   // liquidez de ILQZ tarda 900ms
await page.waitForTimeout(350);
await page.locator('#sbTicker').fill('MSFT');      // segunda validación antes de que resuelva
await page.keyboard.press('Escape');
await page.locator('#sbTicker').press('Enter');
await page.waitForTimeout(1600);
const raceDraft = await page.evaluate(() => ({
  ticker: window.__qdEdgeDraft.signals.config.ticker,
  illiquid: window.__qdEdgeDraft.signals.metrics.illiquid,
  adv: window.__qdEdgeDraft.signals.metrics.adv_usd,
}));
report('S10pre segunda validación sí corrió (draft=MSFT)', raceDraft.ticker === 'MSFT', JSON.stringify(raceDraft));
report('S10 draft de MSFT NO contaminado por illiquid de ILQZ', !(raceDraft.ticker === 'MSFT' && raceDraft.illiquid === true), JSON.stringify(raceDraft));
liqDelayMs = 0;

// ── S10b: GUARDAR antes de que resuelva el check → flag llega igual (eventual) ──
currentPhase = 'S10b-save-race';
await resetQuota();
liqDelayMs = 900;
await page.evaluate(() => { const c = window.qdLiqCache; for (const k in c) delete c[k]; });
await page.locator('#sbTicker').fill('ILQW');
await page.keyboard.press('Escape');
await page.locator('#sbTicker').press('Enter');
await page.waitForTimeout(400);                    // render listo, check aún pendiente
await page.locator('#qdSaveBtn-signals').click();  // guardar ANTES del resolve
const atSave = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.config.ticker === 'ILQW');
  return e ? e.metrics.illiquid : 'NO-EDGE';
});
await page.waitForTimeout(1200);                   // resolve + sync
const afterResolve = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('qd_edges'));
  const e = s.edges.find(e => e.config.ticker === 'ILQW');
  return e ? { illiquid: e.metrics.illiquid, adv: e.metrics.adv_usd } : 'NO-EDGE';
});
report('S10b guardar con check pendiente persiste null (nunca un flag ajeno)', atSave === null, String(atSave));
report('S10b el flag llega al edge guardado al resolver (eventual)', afterResolve.illiquid === true, JSON.stringify(afterResolve));
liqDelayMs = 0;

// ── S11: restore de tab qd_lastTab=edges renderea la lista ──
currentPhase = 'S11-restore';
await page.evaluate(() => localStorage.setItem('qd_lastTab', 'edges'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const restored = await page.evaluate(() => {
  const active = document.querySelector('.page.active');
  const list = document.getElementById('edgesList');
  const nEdges = JSON.parse(localStorage.getItem('qd_edges')).edges.length;
  return { page: active && active.id, cards: list.querySelectorAll('.edge-card').length, nEdges, placeholder: /Todavía no guardas|No edges saved yet/.test(list.innerText) };
});
report('S11 restore a MIS EDGES muestra las cards', restored.page === 'page-edges' && restored.cards === restored.nEdges, JSON.stringify(restored));

// ── S12: fallback remoto del autocomplete (una sola llamada) ──
currentPhase = 'S12-remote-ac';
await page.evaluate(() => showPage('signals'));
const beforeRemote = apiCalls.filter(c => /ticker-search\?q=/.test(c.path)).length;
await page.locator('#sbTicker').fill('');
await page.locator('#sbTicker').click();
await page.keyboard.type('ZZREM', { delay: 60 });
await page.waitForTimeout(900);
const remoteCalls = apiCalls.filter(c => /ticker-search\?q=/.test(c.path)).length - beforeRemote;
const acText2 = await page.locator('.qd-ac-list').innerText().catch(() => '');
report('S12 fallback remoto: 1 llamada y resultado visible', remoteCalls === 1 && /ZZREMOTE\.MX/.test(acText2), 'llamadas=' + remoteCalls);


// ── S13: dropdown sin matches + ArrowDown + Enter → ¿se traga el Enter? ──
currentPhase = 'S13-empty-enter';
await resetQuota();
await page.evaluate(() => showPage('signals'));
const beforeS13 = apiCalls.filter(c => c.path.includes('signal-backtester')).length;
await page.locator('#sbTicker').fill('');
await page.locator('#sbTicker').click();
await page.keyboard.type('QQQQZ', { delay: 50 });   // 0 matches locales, remoto pendiente (nota visible)
await page.waitForTimeout(120);                      // antes del debounce de 300ms
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const s13Fetches = apiCalls.filter(c => c.path.includes('signal-backtester')).length - beforeS13;
const s13Vis = await page.locator('.qd-ac-list').isVisible();
report('S13 Enter tras ArrowDown en dropdown vacío SÍ valida', s13Fetches === 1, 'fetches=' + s13Fetches + ' dropdownVisible=' + s13Vis);

// ── S14: restore qd_lastTab=myagents ──
currentPhase = 'S14-restore-myagents';
await page.evaluate(() => localStorage.setItem('qd_lastTab', 'myagents'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const s14 = await page.evaluate(() => {
  const active = document.querySelector('.page.active');
  return { page: active && active.id, status: document.getElementById('agStatus').textContent,
           listText: document.getElementById('agList').innerText.slice(0, 80),
           fetchedAgents: null };
});
const s14Fetched = apiCalls.some(c => c.phase === 'S14-restore-myagents' && c.path.startsWith('/api/agents'));
report('S14 restore a MIS AGENTES carga los agentes', s14.page === 'page-myagents' && s14Fetched, JSON.stringify({ ...s14, fetchedAgents: s14Fetched }));

// ── S15: IA caída → fallback honesto (capa unificada de errores) ──
// El stub devuelve {} para /api/claude (sin .content): qdAI → null.
currentPhase = 'S15-ai-down';
await page.evaluate(() => showPage('smartmoney'));
await page.evaluate(() => loadMarketSignals());
await page.waitForTimeout(600);
const s15a = await page.evaluate(() => document.getElementById('marketSignalsPanel').innerText);
report('S15a market-wide con IA caída muestra fallback honesto',
  /free-tier|plan gratuito/.test(s15a) && !/Loading market signals/.test(s15a), s15a.slice(0, 80));
await page.evaluate(() => { document.getElementById('smTicker').value = 'AAPL'; return runSmartMoney(); });
await page.waitForTimeout(800);
const s15b = await page.evaluate(() => document.getElementById('smVerdictPanel').innerText);
report('S15b SMART $ con IA caída: fallback, nunca "API error: N"',
  /free-tier|plan gratuito/.test(s15b) && !/API error/.test(s15b), s15b.slice(0, 80));
const pageErrors = consoleLog.filter(c => c.type === 'PAGEERROR');
report('S15c cero PAGEERROR en toda la corrida', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

// ── S16: screener — universo entrelazado, presets sin filtros pegados ──
currentPhase = 'S16-screener';
await page.evaluate(() => showPage('screener'));
await page.evaluate(() => runScreener());
await page.waitForTimeout(3000);
const s16 = await page.evaluate(() => ({
  status: document.getElementById('screenerStatus').textContent,
  text: document.getElementById('screenerResults').innerText.slice(0, 3000),
}));
report('S16a All Markets entrelaza el universo e incluye LATAM',
  /MELI|NU\b|VALE|AMXB|PETR4/.test(s16.text), s16.status + ' · ' + s16.text.slice(0, 60));
await page.evaluate(() => applyPreset('volatile'));
await page.waitForTimeout(2000);
await page.evaluate(() => { document.getElementById('scSector').value = 'tech'; applyPreset('latam'); });
await page.waitForTimeout(2000);
const s16b = await page.evaluate(() => ({
  sigmaMin: document.getElementById('scSigmaMin').value,
  sector: document.getElementById('scSector').value,
  universe: document.getElementById('scUniverse').value,
}));
report('S16b cambiar de preset resetea sigma y sector (nada pegado)',
  s16b.sigmaMin === '0' && s16b.sector === 'all' && s16b.universe === 'latam', JSON.stringify(s16b));
const s16c = await page.evaluate(() => document.querySelector('[data-i18n="screenerSubtitle"]').textContent);
report('S16c subtítulo del screener con conteo real, sin "500+"',
  /^3\d\d /.test(s16c) && !/500/.test(s16c), s16c);

// ── S17: SIM — el canvas de trayectorias dibuja (regresión canvas 0×0)
//    y el badge de riesgo sigue la sigma del ticker (no está clavado) ──
currentPhase = 'S17-sim-canvas';
await page.evaluate(() => showPage('sim'));
await page.waitForTimeout(200);
const s17size = await page.evaluate(() => {
  const sc = document.getElementById('simCanvas');
  return { w: sc.width, h: sc.height };
});
report('S17a al mostrar SIM el canvas queda dimensionado (no 0×0)',
  s17size.w > 0 && s17size.h > 0, JSON.stringify(s17size));

async function runSimAndSample(ticker) {
  await page.evaluate((tk) => {
    document.getElementById('simTicker').value = tk;
    document.getElementById('simPaths').value = '300';
    const spd = document.getElementById('simSpeed'); if (spd) spd.value = '3';
    startSim();
  }, ticker);
  await page.waitForFunction(() => {
    const m = /(\d+) \/ (\d+)/.exec(document.getElementById('progLbl').textContent);
    return m && m[1] === m[2] && +m[1] > 0;
  }, { timeout: 30000 });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const sc = document.getElementById('simCanvas');
    const img = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
    let colored = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] > 0 && (img[i] > 25 || img[i + 1] > 25 || img[i + 2] > 25)) colored++;
    }
    return {
      pct: +(100 * colored / (img.length / 4)).toFixed(2),
      verdict: document.getElementById('simVerdict').textContent,
    };
  });
}
const s17ko = await runSimAndSample('KO');
report('S17b SIM dibuja píxeles no-negros tras simular',
  s17ko.pct > 3, s17ko.pct + '% coloreado');
report('S17c badge sigue la sigma: KO (σ=0.20) no sale HIGH RISK/AVOID',
  !/HIGH RISK|AVOID/.test(s17ko.verdict), s17ko.verdict);
const s17mu = await runSimAndSample('MU');
report('S17d badge sigue la sigma: MU (σ=0.85) sale HIGH RISK/AVOID',
  /HIGH RISK|AVOID/.test(s17mu.verdict), s17mu.verdict);

// ── S18: relojes rotos — calendarios stale nunca se muestran como próximos ──
currentPhase = 'S18-calendars';
const apiCount = (path) => apiCalls.filter(c => c.phase === currentPhase && c.path.startsWith(path)).length;

// a) earnings con SOLO eventos pasados → re-fetch sin caché → fallback honesto
calMode = 'stale';
// sin showPage: dispararía initEarningsPage → segundo loadUpcomingEarnings
// en paralelo y el conteo de llamadas dejaría de ser determinista
await page.evaluate(() => loadUpcomingEarnings());
await page.waitForTimeout(1200);
const s18a = await page.evaluate(() => document.getElementById('upcomingEarnings').innerText);
report('S18a earnings stale (abril) → fallback honesto, sin eventos viejos',
  /unavailable|no disponible/i.test(s18a) && !/JPM|DAL/.test(s18a), s18a.slice(0, 60));
report('S18b earnings stale disparó re-fetch sin caché (2 llamadas)',
  apiCount('/api/earnings?from') === 2, apiCount('/api/earnings?from') + ' llamadas');

// b) earnings frescos → se renderean
calMode = 'fresh';
await page.evaluate(() => loadUpcomingEarnings());
await page.waitForTimeout(800);
const s18c = await page.evaluate(() => document.getElementById('upcomingEarnings').innerText);
report('S18c earnings frescos se renderean', /AAPL/.test(s18c) && /MELI/.test(s18c), s18c.slice(0, 60));

// c) IPOs con todo más viejo que la ventana del server → re-fetch → fallback honesto
calMode = 'stale';
await page.evaluate(() => loadIPOs());
await page.waitForTimeout(1200);
const s18d = await page.evaluate(() => document.getElementById('iposContent').innerText);
report('S18d IPOs stale → fallback honesto, sin IPOs viejas',
  /unavailable|no disponible/i.test(s18d) && !/OLDCO/.test(s18d), s18d.slice(0, 60));
report('S18e IPOs stale disparó re-fetch sin caché (2 llamadas)',
  apiCount('/api/ipos') === 2, apiCount('/api/ipos') + ' llamadas');

calMode = 'fresh';
await page.evaluate(() => loadIPOs());
await page.waitForTimeout(800);
const s18f = await page.evaluate(() => document.getElementById('iposContent').innerText);
report('S18f IPOs frescas se renderean', /NEWCO/.test(s18f), s18f.slice(0, 60));
calMode = 'none';

// ── S19: coherencia label-vs-datos — "THIS WEEK" con eventos a +21 días ──
// (el guard de frescura solo no lo atrapa: Aug 7 ES futuro; el horizonte sí)
currentPhase = 'S19-week-coherence';
const apiCount19 = (path) => apiCalls.filter(c => c.phase === currentPhase && c.path.startsWith(path)).length;
calMode = 'farfuture';
await page.evaluate(() => loadUpcomingEarnings());
await page.waitForTimeout(1200);
const s19a = await page.evaluate(() => document.getElementById('upcomingEarnings').innerText);
report('S19a earnings a +21d bajo label THIS WEEK → guard de horizonte → fallback honesto',
  /unavailable|no disponible/i.test(s19a) && !/FUT1|FUT2/.test(s19a), s19a.slice(0, 60));
report('S19b la incoherencia disparó re-fetch sin caché (2 llamadas)',
  apiCount19('/api/earnings?from') === 2, apiCount19('/api/earnings?from') + ' llamadas');
const earnCall19 = apiCalls.find(c => c.phase === currentPhase && c.path.startsWith('/api/earnings?from'));
const q19 = new URLSearchParams(earnCall19.path.split('?')[1]);
const window19 = (new Date(q19.get('to')) - new Date(q19.get('from'))) / 864e5;
report('S19c el request pide ventana de 7 días (from=hoy, to=hoy+7d)',
  window19 === 7, q19.get('from') + ' → ' + q19.get('to'));
calMode = 'none';

// d) calendario económico compuesto por IA: stale → 2 intentos → fallback honesto
econAI = [
  { date: 'Apr 9', event: 'FOMC Minutes', country: 'US', impact: 'HIGH', expected: '', previous: '', description: 'old' },
  { date: 'Apr 10', event: 'CPI Inflation', country: 'US', impact: 'HIGH', expected: '', previous: '', description: 'old' },
];
const claudeBefore = apiCalls.filter(c => c.path.startsWith('/api/claude')).length;
await page.evaluate(() => loadEconCalendar());
await page.waitForTimeout(1200);
const s18g = await page.evaluate(() => document.getElementById('econCalendar').innerText);
const claudeCalls = apiCalls.filter(c => c.path.startsWith('/api/claude')).length - claudeBefore;
report('S18g econ calendar IA con fechas de abril → fallback honesto (no FOMC Apr 9)',
  /unavailable|no disponible/i.test(s18g) && !/FOMC/.test(s18g), s18g.slice(0, 60) + ' · ' + claudeCalls + ' intentos IA');

// e) calendario económico IA con fechas frescas → se renderea
const soonLbl = new Date(Date.now() + 5 * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
econAI = [
  { date: soonLbl, event: 'CPI Inflation', country: 'US', impact: 'HIGH', expected: '3.0%', previous: '3.1%', description: 'fresh' },
  { date: soonLbl, event: 'Banxico Decision', country: 'MX', impact: 'HIGH', expected: '8.0%', previous: '8.5%', description: 'fresh' },
];
await page.evaluate(() => loadEconCalendar());
await page.waitForTimeout(800);
const s18h = await page.evaluate(() => document.getElementById('econCalendar').innerText);
report('S18h econ calendar IA fresco se renderea', /CPI Inflation/.test(s18h) && /Banxico/.test(s18h), s18h.slice(0, 60));
econAI = null;

// ── S20: cards con nombre local + popover de identidad (opción A) ──
currentPhase = 'S20-company-popover';
const apiCount20 = (prefix) => apiCalls.filter(c => c.phase === currentPhase && c.path.startsWith(prefix)).length;
calMode = 'fresh';
await page.evaluate(() => showPage('earnings'));
await page.evaluate(() => loadUpcomingEarnings());
await page.waitForTimeout(800);
const s20cards = await page.evaluate(() => document.getElementById('upcomingEarnings').innerText);
report('S20a la card muestra el nombre del catálogo local bajo el ticker (0 requests)',
  /Apple Inc\./.test(s20cards) && /MercadoLibre/.test(s20cards) && apiCount20('/api/ticker-search?profile') === 0,
  s20cards.slice(0, 70));

await page.click('#upcomingEarnings [data-ticker="AAPL"]');
await page.waitForTimeout(500);
const s20pop = await page.evaluate(() => {
  const el = document.getElementById('qdCoPop');
  return { visible: !!el && el.style.display !== 'none', text: el ? el.innerText : '' };
});
report('S20b click → popover con nombre + industria + línea compuesta, SIN correr intel',
  s20pop.visible && /Apple Inc\./.test(s20pop.text) && /Technology/.test(s20pop.text)
    && /\$2\.9T/.test(s20pop.text) && /IPO 1980/.test(s20pop.text)
    && apiCount20('/api/earnings?ticker') === 0,
  s20pop.text.replace(/\n/g, ' · ').slice(0, 80));

await page.click('#upcomingEarnings [data-ticker="MELI"]');
await page.waitForTimeout(400);
await page.click('#upcomingEarnings [data-ticker="AAPL"]');
await page.waitForTimeout(400);
report('S20c memoización de sesión: 2 clicks a AAPL = 1 sola request de profile',
  apiCalls.filter(c => c.phase === currentPhase && c.path === '/api/ticker-search?profile=AAPL').length === 1,
  apiCount20('/api/ticker-search?profile') + ' requests de profile en total');

await page.click('#qdCoPop button');
await page.waitForTimeout(600);
const s20intel = await page.evaluate(() => ({
  ticker: document.getElementById('earningsTicker').value,
  popVisible: document.getElementById('qdCoPop').style.display !== 'none',
}));
report('S20d RUN INTEL → llena el ticker, cierra el popover y dispara el intel',
  s20intel.ticker === 'AAPL' && !s20intel.popVisible && apiCount20('/api/earnings?ticker') >= 1,
  JSON.stringify(s20intel));

// e) rótulo de empresa activa en el header: vía popover (0 requests extra,
//    AAPL ya está memoizado), gemelo SMART $, y backfill para un ticker
//    desconocido tecleado a mano (≤1 request, luego memo)
const s20e = await page.evaluate(() => document.getElementById('earningsActiveCo').innerText);
report('S20e header EARNINGS muestra ticker + nombre de la empresa activa',
  /AAPL/.test(s20e) && /Apple Inc\./.test(s20e), s20e);

// NVDA no fue clickeado antes → prueba el camino catálogo-local puro
// (0 requests de profile); MELI mostraría el nombre del profile memoizado.
await page.evaluate(() => { document.getElementById('smTicker').value = 'NVDA'; runSmartMoney(); });
await page.waitForTimeout(600);
const s20f = await page.evaluate(() => document.getElementById('smActiveCo').innerText);
report('S20f gemelo SMART $: header muestra NVDA + nombre (catálogo local, 0 requests)',
  /NVDA/.test(s20f) && /NVIDIA/.test(s20f)
    && apiCalls.filter(c => c.path === '/api/ticker-search?profile=NVDA').length === 0, s20f);

const profBefore = apiCalls.filter(c => c.path === '/api/ticker-search?profile=ZZUNKNOWN').length;
await page.evaluate(() => { document.getElementById('earningsTicker').value = 'ZZUNKNOWN'; runEarningsIntel(); });
await page.waitForTimeout(800);
const s20g = await page.evaluate(() => document.getElementById('earningsActiveCo').innerText);
const profCalls = apiCalls.filter(c => c.path === '/api/ticker-search?profile=ZZUNKNOWN').length - profBefore;
report('S20g ticker fuera de catálogo tecleado → backfill (1 request) y nombre en header',
  /ZZUNKNOWN/.test(s20g) && /Stub Corp/.test(s20g) && profCalls === 1, s20g + ' · ' + profCalls + ' request');

// ── S21: nombre server-side para símbolos FUERA del catálogo de 201 ──
// /api/earnings enriquece cada evento con `company` (symbol map de
// Finnhub title-cased); el render lo usa de fallback cuando qdCompanyName
// no conoce el símbolo. El calendario sigue pintado del render fresh de
// S20a — se lee el DOM directo, sin re-fetch ni requests de profile.
currentPhase = 'S21-server-name';
const s21 = await page.evaluate(() => {
  const txt = (sym) => {
    const el = document.querySelector('#upcomingEarnings [data-ticker="' + sym + '"] .qd-co-name');
    return el ? el.textContent : 'NO-CARD';
  };
  return { localZZOUT: qdCompanyName('ZZOUT'), zzout: txt('ZZOUT'), aapl: txt('AAPL') };
});
report('S21a símbolo fuera del catálogo pinta el nombre del server desde el render',
  s21.localZZOUT === '' && s21.zzout === 'Zz Outsider Corp', JSON.stringify(s21));
report('S21b el catálogo local mantiene prioridad sobre el nombre del server',
  s21.aapl === 'Apple Inc.', s21.aapl);
report('S21c el nombre llegó en el response del calendario: 0 requests de profile para ZZOUT',
  apiCalls.filter(c => c.path === '/api/ticker-search?profile=ZZOUT').length === 0, '');
calMode = 'none';

// ── S22: VC deal flow real — card desde /api/vc-feed + fallback honesto ──
currentPhase = 'S22-vc-feed';
await page.evaluate(() => showPage('vc'));
await page.waitForTimeout(700);
const s22 = await page.evaluate(() => {
  const feed = document.getElementById('vcFeed');
  const card = feed.querySelector('.deal-card');
  return {
    name: card ? card.querySelector('.deal-name').textContent : 'NO-CARD',
    amt: card ? card.querySelector('.deal-amt').textContent : '',
    link: !!(card && card.querySelector('a[href="https://stub.example/round"]')),
    src: card ? card.querySelector('.vcf-src').textContent : '',
    downFlag: feed.textContent.includes('crunchbase_news'),
  };
});
report('S22a card real: company/amount/link a la fuente',
  s22.name === 'Stubco' && s22.amt === '$12M' && s22.link === true, JSON.stringify(s22));
report('S22b la card lleva la fecha del pubDate del feed', /\d{4}-\d{2}-\d{2}/.test(s22.src), s22.src);
report('S22c fuente caída visible como flag honesto', s22.downFlag === true, '');
await page.evaluate(() => vcSetCat('latam'));
await page.waitForTimeout(700);
const s22d = await page.evaluate(() => document.getElementById('vcFeed').textContent);
report('S22d cat sin items → vacío honesto, jamás inventado',
  /unavailable|no disponible/i.test(s22d), s22d.slice(0, 80));

// ── S23: chart modal (Lightweight Charts) — cinta, popover, intervalos ──
currentPhase = 'S23-chart';
await page.evaluate(() => refreshLiveTape());
await page.waitForTimeout(600);
const s23a = await page.evaluate(async () => {
  const item = document.querySelector('.tape-item[data-chart-sym="NVDA"]');
  if (!item) return { err: 'sin tape item NVDA' };
  item.click();
  await new Promise((r) => setTimeout(r, 700));
  const ov = document.getElementById('qdChartOverlay');
  return {
    visible: !!ov && getComputedStyle(ov).display !== 'none',
    sym: document.getElementById('qdChartTSym').textContent,
    canvases: ov ? ov.querySelectorAll('canvas').length : 0,
    foot: document.getElementById('qdChartFoot').textContent,
  };
});
const s23aCalls = apiCalls.filter((c) => c.phase === 'S23-chart' && c.path.startsWith('/api/candles'));
report('S23a click en la cinta abre el chart con velas reales renderizadas',
  s23a.visible === true && s23a.sym === 'NVDA' && s23a.canvases >= 1 && /yahoo/.test(s23a.foot),
  JSON.stringify(s23a));
report('S23b una sola request a /api/candles (símbolo + intervalo default 1d)',
  s23aCalls.length === 1 && /symbol=NVDA/.test(s23aCalls[0].path) && /interval=1d/.test(s23aCalls[0].path),
  JSON.stringify(s23aCalls.map((c) => c.path)));

const s23c = await page.evaluate(async () => {
  qdChartClose();
  const el = qdCoPopEl();
  qdCoPopRender(el, 'AAPL', { name: 'Apple Inc.', industry: 'Technology', country: 'US',
    exchange: 'NASDAQ', market_cap_m: 2900000, ipo: '1980-12-12' });
  const hasBtn = /qdCoPopChart/.test(el.innerHTML);
  el.style.display = 'block';
  qdCoPopChart('AAPL');
  await new Promise((r) => setTimeout(r, 700));
  const ov = document.getElementById('qdChartOverlay');
  return { hasBtn, popHidden: el.style.display === 'none',
    open: !!ov && getComputedStyle(ov).display !== 'none',
    sym: document.getElementById('qdChartTSym').textContent,
    name: document.getElementById('qdChartTName').textContent };
});
const s23cIntel = apiCalls.filter((c) => c.phase === 'S23-chart'
  && !c.path.startsWith('/api/candles') && !c.path.startsWith('/api/tape'));
report('S23c popover VER CHART → cierra popover y abre el chart, SIN correr intel',
  s23c.hasBtn && s23c.popHidden && s23c.open && s23c.sym === 'AAPL' && /Apple/.test(s23c.name)
  && s23cIntel.length === 0,
  JSON.stringify({ ...s23c, otherCalls: s23cIntel.map((c) => c.path) }));

await page.evaluate(() => qdChartSetIv('5m'));
await page.waitForTimeout(600);
await page.evaluate(() => qdChartSetIv('1d'));
await page.waitForTimeout(500);
const iv5m = apiCalls.filter((c) => c.phase === 'S23-chart' && /api\/candles.*interval=5m/.test(c.path));
const iv1d = apiCalls.filter((c) => c.phase === 'S23-chart' && /api\/candles.*interval=1d/.test(c.path));
report('S23d cambio de intervalo pide 5m; volver a 1d usa el memo (0 requests nuevas)',
  iv5m.length === 1 && /symbol=AAPL/.test(iv5m[0].path) && iv1d.length === 2,
  JSON.stringify({ iv5m: iv5m.map((c) => c.path), iv1d: iv1d.map((c) => c.path) }));

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const s23e = await page.evaluate(() => {
  const ov = document.getElementById('qdChartOverlay');
  return { closed: !!ov && getComputedStyle(ov).display === 'none' };
});
report('S23e Escape cierra el chart modal', s23e.closed === true, JSON.stringify(s23e));

// S23f: el quote de acciones jamás abre vela nueva (bug SNOW: la vela
// fantasma plana o=h=l=c en el bucket de hoy se leía como slot vacío);
// el WS de cripto (allowNew) sí puede abrir bucket con un trade real.
const s23f = await page.evaluate(async () => {
  qdChartOpen('OLDD');
  await new Promise((r) => setTimeout(r, 700));
  const before = qdChartSeries.data().length;
  qdChartLiveTick(999, 1, false);           // tick de quote, mercado cerrado
  const afterQuote = qdChartSeries.data().length;
  qdChartLiveTick(999, null, true);         // trade real de WS
  const d = qdChartSeries.data();
  return { before, afterQuote, afterWs: d.length, wsLast: d[d.length - 1] };
});
report('S23f quote jamás abre vela nueva; el WS sí (trade real)',
  s23f.before === 30 && s23f.afterQuote === 30 && s23f.afterWs === 31
  && s23f.wsLast.open === 999 && s23f.wsLast.close === 999,
  JSON.stringify(s23f));

// S23g: filas con OHLC inválido jamás llegan a la serie (en LWC serían
// whitespace points → slots vacíos) y el foot avisa cuántas se descartaron.
const s23g = await page.evaluate(async () => {
  qdChartClose();
  qdChartOpen('BADROW');
  await new Promise((r) => setTimeout(r, 700));
  const bars = qdChartSeries.data().length;
  const foot = document.getElementById('qdChartFoot').textContent;
  qdChartClose();
  return { bars, foot };
});
report('S23g filas inválidas filtradas (cero whitespace) + foot honesto',
  s23g.bars === 28 && /incomplete|incompletos/.test(s23g.foot) && /\(2\)/.test(s23g.foot),
  JSON.stringify(s23g));

// ── S24: MACRO MARKETS — hero (VIX + spread), grupos colapsables,
//    sparklines y click en tarjeta → chart modal (/api/candles) ──
currentPhase = 'S24-macro-markets';
await page.evaluate(() => { qdChartClose(); showPage('macro'); });
await page.waitForTimeout(1400);
const s24 = await page.evaluate(() => {
  const hero = document.getElementById('macroHero').innerText;
  const groups = document.getElementById('macroMarkets');
  const secs = [...groups.querySelectorAll('details.mx-sec > summary')].map(s => s.innerText.replace(/\s+/g, ' ').trim());
  const cardEls = [...groups.querySelectorAll('.mx-card')];
  const cards = cardEls.length;
  const sparks = groups.querySelectorAll('svg.mx-spark').length;
  const tnxCard = cardEls.find(c => c.getAttribute('data-chart-sym') === '^TNX');
  const oneCard = cardEls[0];
  return {
    hero, secs, cards, sparks,
    // 10Y card muestra 4.25 (÷10 aplicado), no 42.5
    tnxVal: tnxCard ? tnxCard.querySelector('.mx-val').innerText : 'NO-CARD',
    heroHasVix: /VIX/.test(hero) && /18\.5/.test(hero),
    heroInverted: /INVERTED/.test(hero),
    // cada % pintado lleva su etiqueta de periodo (badge qd-pct-per)
    cardsWithPct: cardEls.filter(c => c.querySelector('.qd-pct')).length,
    cardsWithPeriodBadge: cardEls.filter(c => c.querySelector('.qd-pct .qd-pct-per')).length,
    everyPctHasPeriod: cardEls.every(c => {
      const pct = c.querySelector('.qd-pct');
      return !pct || pct.querySelector('.qd-pct-per');
    }),
    defaultPeriodLabel: oneCard ? (oneCard.querySelector('.qd-pct-per') || {}).textContent : null,
    heroPctBadge: !!document.querySelector('#macroHero .qd-pct .qd-pct-per'),
    // toolbar de periodo 1S · 1M · 3M
    periodBtns: [...groups.querySelectorAll('.mx-toolbar .mx-per')].map(b => b.textContent.trim()),
    activePeriod: (groups.querySelector('.mx-toolbar .mx-per.on') || {}).textContent,
    // sello de recencia por grupo
    recencyStamps: groups.querySelectorAll('.mx-sec > summary .mx-recency').length,
    recencySample: (groups.querySelector('.mx-recency') || {}).textContent,
    // sparkline viva: relleno + punto final + línea base
    sparkArea: groups.querySelectorAll('svg.mx-spark path.mx-area').length,
    sparkDot: groups.querySelectorAll('svg.mx-spark circle.mx-dot').length,
    sparkBase: groups.querySelectorAll('svg.mx-spark line.mx-base').length,
  };
});
report('S24a hero muestra el VIX con su nivel', s24.heroHasVix, s24.hero.replace(/\n/g, ' · ').slice(0, 80));
report('S24b hero calcula el spread 10Y-2Y invertido (recession signal)', s24.heroInverted, s24.hero.replace(/\n/g, ' · ').slice(0, 120));
report('S24c grupos por región presentes (RATES/FX/COMMODITIES/ASIA/EUROPE/LATAM/FUTURES)',
  ['RATES', 'FX GLOBAL', 'COMMODITIES', 'ASIA', 'EUROPE', 'LATAM', 'US FUTURES'].every(t => s24.secs.some(s => s.includes(t))),
  JSON.stringify(s24.secs));
report('S24d cada tarjeta tiene sparkline (svg sin ejes)', s24.cards > 0 && s24.sparks === s24.cards,
  'cards=' + s24.cards + ' sparks=' + s24.sparks);
report('S24e ^TNX se muestra ÷10 (4.25%, no 42.5)', s24.tnxVal.includes('4.25'), s24.tnxVal);
report('S24i TODO % pintado lleva su etiqueta de periodo (imposible un % mudo)',
  s24.cards > 0 && s24.cardsWithPct === s24.cards && s24.cardsWithPeriodBadge === s24.cards
    && s24.everyPctHasPeriod && s24.heroPctBadge,
  JSON.stringify({ cards: s24.cards, withPct: s24.cardsWithPct, withBadge: s24.cardsWithPeriodBadge, hero: s24.heroPctBadge }));
report('S24j toolbar de periodo 1S · 1M · 3M (1M por defecto)',
  JSON.stringify(s24.periodBtns) === JSON.stringify(['1S', '1M', '3M']) && s24.activePeriod === '1M'
    && s24.defaultPeriodLabel === '1M',
  JSON.stringify({ btns: s24.periodBtns, active: s24.activePeriod, badge: s24.defaultPeriodLabel }));
report('S24k sello de recencia visible por grupo ("hace"/"ago")',
  s24.recencyStamps === s24.secs.length && /hace|ago/.test(s24.recencySample || ''),
  JSON.stringify({ stamps: s24.recencyStamps, secs: s24.secs.length, sample: s24.recencySample }));
report('S24l sparkline viva: relleno + punto final + línea base en cada tarjeta',
  s24.sparkArea === s24.cards && s24.sparkDot === s24.cards && s24.sparkBase === s24.cards,
  JSON.stringify({ area: s24.sparkArea, dot: s24.sparkDot, base: s24.sparkBase, cards: s24.cards }));

// S24m: el toggle de periodo recalcula el % (mismo dato, ancla distinta) y
// re-etiqueta — sin repolear la red.
const beforeMacroCalls = apiCalls.filter(c => c.phase === 'S24-macro-markets' && c.path.startsWith('/api/macro-markets')).length;
const s24m = await page.evaluate(() => {
  const card = () => document.querySelector('#macroMarkets .mx-card');
  const read = () => {
    const c = card();
    return { pct: c.querySelector('.qd-pct').firstChild.textContent, per: c.querySelector('.qd-pct-per').textContent };
  };
  const at1M = read();
  mxSetPeriod('3M');
  const at3M = read();
  mxSetPeriod('1S');
  const at1S = read();
  mxSetPeriod('1M'); // restore
  return { at1M, at3M, at1S };
});
const afterMacroCalls = apiCalls.filter(c => c.phase === 'S24-macro-markets' && c.path.startsWith('/api/macro-markets')).length;
report('S24m toggle de periodo recalcula % + re-etiqueta sin repolear la red',
  s24m.at3M.per === '3M' && s24m.at1S.per === '1S' && s24m.at1M.per === '1M'
    && s24m.at3M.pct !== s24m.at1S.pct && afterMacroCalls === beforeMacroCalls,
  JSON.stringify({ ...s24m, netCalls: afterMacroCalls - beforeMacroCalls }));

// click en una tarjeta abre el chart modal con velas (misma plumbing candles)
const beforeCandles = apiCalls.filter(c => c.phase === 'S24-macro-markets' && c.path.startsWith('/api/candles')).length;
await page.evaluate(async () => {
  const c = document.querySelector('.mx-card[data-chart-sym="^MXX"]');
  c.click();
  await new Promise(r => setTimeout(r, 700));
});
const s24f = await page.evaluate(() => {
  const ov = document.getElementById('qdChartOverlay');
  return { open: !!ov && getComputedStyle(ov).display !== 'none', sym: document.getElementById('qdChartTSym').textContent };
});
const s24Candles = apiCalls.filter(c => c.phase === 'S24-macro-markets' && /symbol=%5EMXX/.test(c.path));
report('S24f click en tarjeta LATAM (^MXX) abre el chart modal con velas',
  s24f.open === true && s24f.sym === '^MXX' && s24Candles.length === 1,
  JSON.stringify({ ...s24f, candleCalls: s24Candles.map(c => c.path) }));
await page.evaluate(() => qdChartClose());

// colapsable: <details> nativo togglea
const s24g = await page.evaluate(() => {
  const d = document.querySelector('details.mx-sec');
  const openBefore = d.open;
  d.querySelector('summary').click();
  return { openBefore, openAfter: d.open };
});
report('S24g grupos colapsables (details nativo togglea)', s24g.openBefore === true && s24g.openAfter === false,
  JSON.stringify(s24g));

// S24h: el quote vivo del chart escala ÷10 SOLO para índices de rendimiento
// (^TNX 42.5 → 4.25), nunca para un stock — así la vela viva no salta a 42.5.
const s24h = await page.evaluate(() => ({
  tnx: qdScaleQuote('^TNX', 42.5), tyx: qdScaleQuote('^TYX', 46.0),
  nvda: qdScaleQuote('NVDA', 190), two: qdScaleQuote('2YY=F', 4.6),
}));
report('S24h qdScaleQuote: yields ÷10 (^TNX→4.25), stocks/2YY=F intactos',
  s24h.tnx === 4.25 && s24h.tyx === 4.6 && s24h.nvda === 190 && s24h.two === 4.6, JSON.stringify(s24h));

// S24n: MÓVIL DE VERDAD — un TAP (no hover, no .click() sintético) en una
// tarjeta abre el modal con la serie correcta. Contexto táctil real
// (hasTouch+isMobile, viewport de teléfono) → page.tap() emite la
// secuencia touchstart/touchend que el navegador sintetiza a click, el
// mismo camino que en un teléfono. Prueba el requisito #3.
currentPhase = 'S24-mobile-tap';
let s24n = { err: 'no-run' };
try {
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mpage = await mctx.newPage();
  attachConsole(mpage);
  await routeApis(mpage);
  await mpage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mpage.waitForTimeout(2000);
  await mpage.evaluate(() => { showPage('macro'); });
  await mpage.waitForTimeout(1400);
  // tap real sobre la tarjeta de Nikkei (^N225)
  await mpage.tap('#macroMarkets .mx-card[data-chart-sym="^N225"]');
  await mpage.waitForTimeout(700);
  s24n = await mpage.evaluate(() => {
    const ov = document.getElementById('qdChartOverlay');
    return {
      open: !!ov && getComputedStyle(ov).display !== 'none',
      sym: document.getElementById('qdChartTSym').textContent,
      candles: !!document.querySelector('#qdChartBody canvas, #qdChartBody table'),
    };
  });
  const mCandleCalls = apiCalls.filter(c => c.phase === 'S24-mobile-tap' && /symbol=%5EN225/.test(c.path));
  s24n.candleCall = mCandleCalls.length;
  await mctx.close();
} catch (e) { s24n = { err: String(e).slice(0, 200) }; }
report('S24n TAP móvil (no hover) abre el modal con la serie correcta (^N225)',
  s24n.open === true && s24n.sym === '^N225' && s24n.candleCall === 1,
  JSON.stringify(s24n));

// ── console summary ──
console.log('\n=== CONSOLA (errores/warnings/pageerrors) ===');
for (const c of consoleLog) console.log(`[${c.tab}] ${c.type}: ${c.text}`);
console.log('total console issues:', consoleLog.length);
console.log('\n=== EXTERNAS ABORTADAS ===');
for (const u of [...new Set(externalUrls)]) console.log(u);
console.log('\n=== RESUMEN ===');
console.log(results.filter(r => !r.ok).length + ' FAIL / ' + results.length + ' checks');

await browser.close();
process.exit(0);
