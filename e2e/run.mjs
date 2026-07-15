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

async function routeApis(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    apiCalls.push({ phase: currentPhase, path: p + url.search });
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    if (p === '/api/signal-backtester') return json(signalOK(url.searchParams.get('ticker')));
    if (p === '/api/pairs-validator') return json(pairsOK(url.searchParams.get('x'), url.searchParams.get('y')));
    if (p === '/api/ticker-search') {
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
    if (p === '/api/price') return json({ current_price: 100, mu: 0.1, sigma: 0.3, asset_type: 'stock', verdict: 'WATCH' });
    if (p === '/api/news') return json({ headlines: [] });
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
const tabs = ['agents', 'sim', 'compare', 'vc', 'portfolio', 'macro', 'smartmoney', 'earnings', 'ipos', 'movers', 'sectors', 'conexiones', 'screener', 'pairs', 'signals', 'edges', 'myagents', 'social', 'gallery'];
for (const tab of tabs) {
  currentPhase = 'tab:' + tab;
  await page.evaluate((t) => {
    if (t === 'edges') { showPage('edges'); qdRenderEdges(); }
    else if (t === 'myagents') { showPage('myagents'); qdAgentsOpen(); }
    else showPage(t);
  }, tab);
  await page.waitForTimeout(900);
}
report('S1 sweep de 19 tabs', true, 'consola al final');

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
