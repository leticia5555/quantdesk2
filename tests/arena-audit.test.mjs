// ═══════════════════════════════════════════════════════════════
// Tests de /api/arena-audit (auditoría SOLO-LECTURA del Arena).
//
// El fetch a Neon está mockeado y CADA query que pasa por ahí se captura:
// la aserción central es que TODAS son SELECT — cero writes, cero heartbeat.
// El prompt del scan del fixture se construye con el MISMO builder que usa
// arena-run (buildScanUserPrompt), así el parser del buffet se prueba contra
// el formato REAL del productor y no contra una copia que puede envejecer.
//
// Cubre: gate del CRON_SECRET (header y ?secret), reconstrucción por corrida
// (canales del buffet con ítems reales, scout, slate con floor_reserved,
// veredictos del guard, fills, prosa, detector #93), markdown en español
// ordenado por fecha, y la vista ?view=resumen (ventas voluntarias, picks
// antes/después de buffet-quality, atención a posiciones heridas y cambios
// de veredicto tipo LYFT).
// Correr con `node tests/arena-audit.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
function mockRes() {
  return { code: null, body: null, text: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.text = s; return this; },
    end() { return this; } };
}

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
const SECRET = 's3cret-cron';
process.env.CRON_SECRET = SECRET;

const { buildScanUserPrompt } = await import('../api/arena-run.js');
const { default: handler } = await import('../api/arena-audit.js');
const { frasesConSimbolo, parsePct, jsonAfterMarker, BUFFET_QUALITY_DEPLOY } = await import('../api/_lib/arena-audit.js');

// ── fixture del buffet: 5 gainers + 5 losers + 8 actives = 18 ítems ──
const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const buffetLleno = {
  movers: {
    gainers: mk(5, (i) => ({ symbol: 'G' + i, price: 20 + i, changePct: 5 })),
    losers: mk(5, (i) => ({ symbol: 'L' + i, price: 20 + i, changePct: -5 })),
    actives: [{ symbol: 'LYFT', price: 15, changePct: 2 }, { symbol: 'MU', price: 100, changePct: -1 },
      ...mk(6, (i) => ({ symbol: 'A' + i, price: 30 + i, changePct: 1 }))],
  },
  earnings_this_week: mk(12, (i) => ({ ticker: 'E' + i, company: 'Empresa ' + i, date: '2026-08-06', time: 'amc' })),
  notable_insider_buys: mk(8, (i) => ({ insider: 'Persona ' + i, role: 'CEO', ticker: 'I' + i, value: 1e6, tradeDate: '2026-08-04' })),
  screener: { value: [{ symbol: 'KO', qualifiers: { pe_ttm: 18 } }], momentum: [{ symbol: 'HD', qualifiers: {} }] },
  screener_state: 'fresh',
  unavailable: [],
  fetch_errors: {},
  channelsByTicker: {},
};
// Corrida 2: earnings caído (llegó = no) y el screener vacío pero vivo.
const buffetParcial = {
  ...buffetLleno,
  earnings_this_week: [],
  screener: { value: [], momentum: [] },
  unavailable: ['earnings'],
  fetch_errors: { earnings: 'HTTP 502' },
};

const pos = (symbol, plpc) => ({ symbol, qty: 10, avg_entry_price: 100, market_value: 1000, unrealized_plpc: plpc });
function scanPrompt({ buffet, positions }) {
  return buildScanUserPrompt({
    account: { equity: 100000, cash: 50000 }, positions, openOrders: [], buffet, previous: null,
  });
}

const auditoria = (plan, promptText) => {
  // Forma del detector #93 tal como la journalea prose-audit.js.
  const tokens = [{ token: '-2.14%', value: -2.14, matched: false, nearest: 2.9, delta: 0.76 },
    { token: '+6.1%', value: 6.1, matched: true, nearest: 6.1, delta: 0 }];
  return { tolerance: { abs: 0.05, rel: 0.02 }, checked: tokens.length, unmatched: 1, tokens, _plan: !!plan && !!promptText };
};

// ── filas del journal (orden cronológico, como las devuelve el select) ──
const FILAS = [
  {
    id: 'arena-claude-2026-08-05T22:40:00.000Z', run_date: '2026-08-05', phase: 'decide', status: 'ok',
    prompt_version: 'arena-pm-v2', prompt_hash: 'h1', model: 'claude-x',
    plan: 'Compro MU: la caída de -2.14% no cambia la tesis de memoria. LYFT no me convence al precio de hoy, lo dejo en watch.',
    actions: [
      { symbol: 'LYFT', side: 'buy', qty: 100, limit_price: 12.5, notional: 1250, channels: ['movers'], origin: 'scout_picked',
        result: 'discarded', reason: 'LYFT: limit_price 12.5 fuera de la banda ±2% del último cierre (15.00 → [14.70, 15.30]).' },
      { symbol: 'MU', side: 'buy', qty: 20, limit_price: 100, notional: 2000, channels: ['movers'], origin: 'scout_picked',
        result: 'approved', alpaca_order_id: 'o1', order_status: 'filled', filled_qty: 20, filled_avg_price: 99.5,
        filled_at: '2026-08-06T13:31:02Z', conviction: 4, reasoning: 'Memoria en ciclo.' },
    ],
    account: { equity: 100000, cash: 50000, positions: 2 }, error: null,
    context: {
      unavailable: [], fetch_errors: {},
      risk: { peak: 101000, drawdown: 0.0099, stage: 'none', approved: [], discarded: [] },
      scan: {
        prompt: { system: 'SCOUT', user: scanPrompt({ buffet: buffetLleno, positions: [pos('MU', -0.062), pos('AAPL', 0.03)] }) },
        thesis: 'LYFT y MU se movieron fuerte; KO llega del screener de valor.',
        candidates: ['LYFT', 'MU', 'KO'],
        floor: { applied: true, reserved: ['HD'], reason: 'floor_applied', floor: 2 },
        screener_state: 'fresh',
        slate: [{ symbol: 'LYFT', origin: 'scout_picked' }, { symbol: 'MU', origin: 'scout_picked' },
          { symbol: 'KO', origin: 'scout_picked' }, { symbol: 'HD', origin: 'floor_reserved' }],
      },
      plan_number_audit: auditoria(true, true),
    },
    created_at: '2026-08-05T22:40:00.000Z', agent_id: 'claude',
  },
  {
    id: 'arena-claude-2026-08-07T22:40:00.000Z', run_date: '2026-08-07', phase: 'decide', status: 'ok_no_actions',
    prompt_version: 'arena-pm-v2', prompt_hash: 'h2', model: 'claude-x',
    plan: 'Hoy holdeo. MU sigue abajo pero la tesis aguanta; no abro nada nuevo.',
    actions: [], account: { equity: 99500, cash: 48000, positions: 2 }, error: null,
    context: {
      unavailable: ['earnings'], fetch_errors: { earnings: 'HTTP 502' },
      risk: { peak: 101000, drawdown: 0.0148, stage: 'none', approved: [], discarded: [] },
      scan: {
        prompt: { system: 'SCOUT', user: scanPrompt({ buffet: buffetParcial, positions: [pos('MU', -0.071), pos('AAPL', 0.04)] }) },
        thesis: 'Cinco nombres con movimiento real.',
        candidates: ['LYFT', 'MU', 'KO', 'HD', 'NVDA'],
        floor: { applied: false, reserved: [], reason: 'screener_empty', floor: 2 },
        screener_state: 'empty',
        slate: [{ symbol: 'LYFT', origin: 'scout_picked' }, { symbol: 'MU', origin: 'scout_picked' },
          { symbol: 'KO', origin: 'scout_picked' }, { symbol: 'HD', origin: 'scout_picked' }, { symbol: 'NVDA', origin: 'scout_picked' }],
      },
      plan_number_audit: { tolerance: { abs: 0.05, rel: 0.02 }, checked: 0, unmatched: 0, tokens: [] },
    },
    created_at: '2026-08-07T22:40:00.000Z', agent_id: 'claude',
  },
  {
    id: 'arena-claude-2026-08-13T22:40:00.000Z', run_date: '2026-08-13', phase: 'decide', status: 'ok',
    prompt_version: 'arena-pm-v2', prompt_hash: 'h3', model: 'claude-x',
    plan: 'Ahora sí entro a LYFT: el precio corrigió y la banda me deja. MU se queda.',
    actions: [
      { symbol: 'LYFT', side: 'buy', qty: 80, limit_price: 14.9, notional: 1192, channels: ['movers'], origin: 'scout_picked',
        result: 'approved', alpaca_order_id: 'o2', order_status: 'filled', filled_qty: 80, filled_avg_price: 14.88,
        filled_at: '2026-08-14T13:32:00Z', conviction: 3, reasoning: 'Corrigió a la banda.' },
    ],
    account: { equity: 99000, cash: 46000, positions: 3 }, error: null,
    context: {
      unavailable: [], fetch_errors: {},
      risk: { peak: 101000, drawdown: 0.0198, stage: 'none', approved: [], discarded: [] },
      scan: {
        prompt: { system: 'SCOUT', user: scanPrompt({ buffet: buffetLleno, positions: [pos('MU', -0.083), pos('AAPL', 0.05)] }) },
        thesis: 'LYFT corrigió; MU sigue en el libro.',
        candidates: ['LYFT', 'MU'],
        floor: { applied: false, reserved: [], reason: 'scout_met_floor', floor: 2 },
        screener_state: 'fresh',
        slate: [{ symbol: 'LYFT', origin: 'scout_picked' }, { symbol: 'MU', origin: 'scout_picked' }],
      },
      plan_number_audit: auditoria(true, true),
    },
    created_at: '2026-08-13T22:40:00.000Z', agent_id: 'claude',
  },
  {
    // Red de riesgo: fila propia el mismo día (stop catastrófico determinista).
    id: 'arena-claude-2026-08-13T22:40:00.000Z:risk', run_date: '2026-08-13', phase: 'decide', status: 'risk_exit',
    prompt_version: 'arena-pm-v2', prompt_hash: null, model: 'claude-x',
    plan: 'STOP CATASTRÓFICO — 1 posición cerró bajo su nivel ancho.',
    actions: [
      { symbol: 'GNTX', side: 'sell', qty: 30, limit_price: 21.5, notional: 645, channels: ['risk_exit'],
        origin: 'catastrophic_stop', reason_codes: ['catastrophic_stop'], result: 'approved',
        alpaca_order_id: 'o3', order_status: 'accepted', reasoning: 'Cerró -21% desde la entrada.' },
    ],
    account: { equity: 99000, cash: 46000, positions: 3 }, error: null,
    context: { risk: { peak: 101000, drawdown: 0.0198, stage: 'catastrophic', approved: [{ symbol: 'GNTX' }], discarded: [] } },
    created_at: '2026-08-13T22:41:00.000Z', agent_id: 'claude',
  },
];

const JOURNAL_FIELDS = [
  ['id', 25], ['run_date', 1082], ['phase', 25], ['status', 25], ['prompt_version', 25], ['prompt_hash', 25],
  ['model', 25], ['plan', 25], ['actions', 3802], ['account', 3802], ['error', 25], ['context', 3802],
  ['created_at', 1184], ['agent_id', 25],
].map(([name, dataTypeID]) => ({ name, dataTypeID }));

const asRow = (f) => JOURNAL_FIELDS.map(({ name, dataTypeID }) => {
  const v = f[name];
  if (v == null) return null;
  return dataTypeID === 3802 ? JSON.stringify(v) : String(v);
});

// ── mock de Neon: captura TODA query (la aserción de solo-lectura) ──
let queries = [];
function neonMock() {
  queries = [];
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.queries) { queries.push(...body.queries.map((x) => x.query)); return { ok: true, status: 200, json: async () => ({ results: body.queries.map(() => ({ fields: [], rows: [] })) }) }; }
    const q = String(body.query || '');
    queries.push(q);
    if (q.includes('arena_journal')) {
      return { ok: true, status: 200, json: async () => ({ fields: JOURNAL_FIELDS, rows: FILAS.map(asRow) }) };
    }
    if (q.includes('arena_state')) {
      return { ok: true, status: 200, json: async () => ({
        fields: [{ name: 'agent_id', dataTypeID: 25 }, { name: 'halted', dataTypeID: 16 }, { name: 'halted_at', dataTypeID: 1184 },
          { name: 'halted_reason', dataTypeID: 25 }, { name: 'resumed_at', dataTypeID: 1184 }],
        rows: [['claude', 'f', null, null, null]] }) };
    }
    return { ok: true, status: 200, json: async () => ({ fields: [], rows: [] }) };
  };
}

const GET = (query, headers = {}) => ({ method: 'GET', query, headers });

console.log('arena-audit: gate del CRON_SECRET');
{
  global.fetch = neonMock();
  const sinAuth = mockRes();
  await handler(GET({}), sinAuth);
  ok(sinAuth.code === 401 && sinAuth.body.error === 'No autorizado.', 'sin secret → 401 "No autorizado."', JSON.stringify(sinAuth.body));
  ok(queries.length === 0, 'un 401 no toca la DB', queries.length);

  const malAuth = mockRes();
  await handler(GET({}, { authorization: 'Bearer nope' }), malAuth);
  ok(malAuth.code === 401, 'secret equivocado → 401', malAuth.code);

  const porQuery = mockRes();
  await handler(GET({ secret: SECRET }), porQuery);
  ok(porQuery.code === 200, '?secret= (para abrirlo en el navegador) → 200', porQuery.code);

  const post = mockRes();
  await handler({ method: 'POST', query: {}, headers: { authorization: `Bearer ${SECRET}` } }, post);
  ok(post.code === 405, 'POST → 405 (endpoint de lectura)', post.code);
}

console.log('arena-audit: SOLO LECTURA');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const escritura = queries.filter((q) => !/^\s*select/i.test(q));
  ok(res.code === 200, 'responde 200', res.code);
  ok(queries.length > 0 && escritura.length === 0, 'todas las queries son SELECT (cero writes)', JSON.stringify(escritura));
  ok(!queries.some((q) => /cron_heartbeat/i.test(q)), 'no late ningún heartbeat');
  ok(!queries.some((q) => /create table|alter table|insert into|update /i.test(q)), 'no corre migraciones (ensureSchema)');
  ok(res.headers['Cache-Control'] === 'no-store', 'no cachea (lleva secret en la URL)', res.headers['Cache-Control']);

  const src = readFileSync(new URL('../api/arena-audit.js', import.meta.url), 'utf8');
  ok(!/heartbeat/.test(src.replace(/\/\/.*$/gm, '')), 'el código no importa heartbeat');
  ok(!/ensureSchema/.test(src.replace(/\/\/.*$/gm, '')), 'el código no llama ensureSchema');
  ok(!/arena-run|arena-guard|arena-exits/.test(src.replace(/\/\/.*$/gm, '')), 'no importa nada del camino de decisión');
}

console.log('arena-audit: reconstrucción por corrida (JSON)');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({}, { authorization: `Bearer ${SECRET}` }), res);
  const a = res.body;
  ok(a.agente === 'claude' && a.solo_lectura === true, 'cabecera de la auditoría', JSON.stringify({ ag: a.agente, sl: a.solo_lectura }));
  ok(a.corridas.length === 3, '3 corridas (agrupadas por fecha)', a.corridas.length);
  ok(a.corridas.map((c) => c.fecha).join(',') === '2026-08-05,2026-08-07,2026-08-13', 'ordenadas por fecha', a.corridas.map((c) => c.fecha).join(','));
  ok(a.corridas[2].filas.length === 2 && a.corridas[2].filas[1].tipo === 'red_de_riesgo', 'el día con red de riesgo trae 2 filas', JSON.stringify(a.corridas[2].filas.map((f) => f.tipo)));

  const f1 = a.corridas[0].filas[0];
  const c = f1.buffet.canales;
  ok(f1.buffet.reconstruido === true, 'el buffet se reconstruye del prompt del scan');
  ok(c.movers.llego && c.movers.items === 18, 'movers: llegó con 18 ítems reales', JSON.stringify(c.movers));
  ok(c.movers.detalle.gainers === 5 && c.movers.detalle.losers === 5 && c.movers.detalle.actives === 8, 'movers: desglose gainers/losers/actives', JSON.stringify(c.movers.detalle));
  ok(c.earnings.llego && c.earnings.items === 12, 'earnings: 12 ítems', JSON.stringify(c.earnings));
  ok(c.insiders.llego && c.insiders.items === 8, 'insiders: 8 ítems', JSON.stringify(c.insiders));
  ok(c.screener.llego && c.screener.items === 2 && c.screener.detalle.value === 1, 'screener: 2 ítems (1 value, 1 momentum)', JSON.stringify(c.screener));
  ok(c.movers.simbolos.includes('LYFT') && c.movers.simbolos.includes('MU'), 'símbolos por canal', JSON.stringify(c.movers.simbolos.slice(0, 4)));

  const f2 = a.corridas[1].filas[0].buffet.canales;
  ok(f2.earnings.llego === false && f2.earnings.error === 'HTTP 502', 'canal caído: llegó=no + error real', JSON.stringify(f2.earnings));
  ok(f2.screener.llego === true && f2.screener.items === 0, 'canal vivo pero vacío ≠ canal caído', JSON.stringify(f2.screener));

  ok(f1.scout.picks_n === 3 && f1.scout.picks.join(',') === 'LYFT,MU,KO', 'scout_picks crudos', JSON.stringify(f1.scout));
  ok(f1.slate_final.length === 4 && f1.slate_final.some((s) => s.origin === 'floor_reserved' && s.symbol === 'HD'), 'slate final con floor_reserved', JSON.stringify(f1.slate_final));
  ok(f1.floor.applied === true && f1.floor.reason === 'floor_applied', 'marca del floor del screener', JSON.stringify(f1.floor));

  const lyft = f1.acciones.find((x) => x.simbolo === 'LYFT');
  const mu = f1.acciones.find((x) => x.simbolo === 'MU');
  ok(lyft.veredicto === 'descartada' && /banda ±2%/.test(lyft.motivo), 'veredicto del guard: descartada + por qué', JSON.stringify(lyft.motivo));
  ok(lyft.side === 'buy' && lyft.limite === 12.5, 'acción propuesta: side/símbolo/límite', JSON.stringify([lyft.side, lyft.limite]));
  ok(mu.veredicto === 'aprobada' && mu.lleno === true, 'veredicto aprobada + llenó', JSON.stringify([mu.veredicto, mu.lleno]));
  ok(f1.fills.length === 1 && f1.fills[0].precio === 99.5, 'fills con precio real', JSON.stringify(f1.fills));
  ok(f1.guard.aprobadas === 1 && f1.guard.descartadas === 1, 'conteo del guard por corrida', JSON.stringify(f1.guard));
  ok(/Compro MU/.test(f1.plan), 'prosa del plan verbatim');
  ok(f1.deteccion_fabricacion.unmatched === 1 && f1.deteccion_fabricacion.tokens.length === 2, 'detector de fabricación (#93)', JSON.stringify(f1.deteccion_fabricacion.unmatched));
  ok(f1.portafolio.posiciones.find((p) => p.simbolo === 'MU').pnl_pct === -6.2, 'libro que vio el PM, con P&L parseado', JSON.stringify(f1.portafolio.posiciones));
  ok(!JSON.stringify(a).includes('PORTFOLIO (Alpaca paper'), 'el texto del prompt NO se re-emite (solo lo destilado)');
}

console.log('arena-audit: markdown (?format=md)');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({ format: 'md' }, { authorization: `Bearer ${SECRET}` }), res);
  const md = res.text || '';
  ok(res.code === 200 && /text\/plain/.test(res.headers['Content-Type'] || ''), 'md se sirve como texto plano', res.headers['Content-Type']);
  ok(md.startsWith('# Auditoría del Arena'), 'título en español', md.slice(0, 40));
  ok(md.indexOf('## Corrida 2026-08-05') < md.indexOf('## Corrida 2026-08-13'), 'una sección por corrida, ordenadas por fecha');
  ok(/Buffet — qué canales llegaron/.test(md) && /\| movers \| sí \| 18 \|/.test(md), 'tabla del buffet con ítems reales');
  ok(/floor_reserved/.test(md) && /Slate final/.test(md), 'slate final con floor_reserved');
  ok(/Acciones propuestas y veredicto del guard/.test(md) && /descartada/.test(md), 'tabla de acciones + veredicto');
  ok(/\*\*Fills:\*\*.*99\.50/.test(md), 'fills en el markdown');
  ok(/Detector de fabricación \(#93\)/.test(md) && /1 sin ancla/.test(md), 'detector #93 en el markdown');
  ok(/Red de riesgo \(determinista\)/.test(md), 'la fila de red de riesgo se distingue del PM');
  ok(/> Compro MU/.test(md), 'prosa del plan citada verbatim');
}

console.log('arena-audit: vista agregada (?view=resumen)');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({ view: 'resumen' }, { authorization: `Bearer ${SECRET}` }), res);
  const r = res.body.resumen;
  ok(res.body.corridas === undefined, 'la vista resumen no re-emite las corridas');
  ok(r.corridas.fechas === 3 && r.corridas.filas_journal === 4 && r.corridas.decisiones === 3, 'conteo de corridas', JSON.stringify(r.corridas));
  ok(r.corridas.por_status.ok === 2 && r.corridas.por_status.risk_exit === 1, 'desglose por status', JSON.stringify(r.corridas.por_status));
  ok(r.ordenes.propuestas === 4 && r.ordenes.aprobadas === 3 && r.ordenes.descartadas === 1, 'órdenes totales', JSON.stringify(r.ordenes));
  ok(r.ordenes.fills === 2 && r.ordenes.del_pm.fills === 2, 'fills (la salida de riesgo aún no llenó)', JSON.stringify(r.ordenes));

  ok(r.ventas_voluntarias.total === 0 && r.ventas_voluntarias.esperado === 0,
    'ventas voluntarias = 0 (la venta de GNTX es red de riesgo, no del PM)', JSON.stringify(r.ventas_voluntarias));

  const s = r.scout_picks_vs_buffet_quality;
  ok(s.deploy === BUFFET_QUALITY_DEPLOY, 'corte por defecto = deploy de buffet-quality', s.deploy);
  ok(s.antes.corridas === 1 && s.antes.promedio === 3, 'picks antes del deploy', JSON.stringify(s.antes));
  ok(s.despues.corridas === 2 && s.despues.promedio === 3.5, 'picks después del deploy', JSON.stringify(s.despues));
  ok(s.delta_promedio === 0.5, 'delta del promedio de picks', s.delta_promedio);
  ok(s.por_corrida.length === 3 && s.por_corrida[0].periodo === 'antes', 'detalle por corrida', JSON.stringify(s.por_corrida[0]));

  const h = r.posiciones_heridas;
  const mu = h.detalle.find((x) => x.simbolo === 'MU');
  ok(h.umbral_pct === -5 && h.simbolos === 1, 'solo MU cruzó −5%', JSON.stringify(h.detalle.map((x) => x.simbolo)));
  ok(mu.primera_corrida_herida === '2026-08-05' && mu.peor_pnl_pct === -8.3, 'primera corrida herida + peor P&L', JSON.stringify([mu.primera_corrida_herida, mu.peor_pnl_pct]));
  ok(mu.corridas_posteriores_con_prosa === 2 && mu.corridas_que_la_mencionan === 2 && mu.tasa_mencion === 1,
    'el plan la nombró por nombre en las 2 corridas posteriores', JSON.stringify(mu));
  ok(mu.menciones[0].frases.some((f) => /MU sigue abajo/.test(f)), 'cita la frase donde la nombra', JSON.stringify(mu.menciones[0]));

  const lyft = r.cambios_de_veredicto.find((x) => x.simbolo === 'LYFT');
  ok(r.cambios_de_veredicto.length === 1 && lyft, 'un solo símbolo cambió de veredicto', JSON.stringify(r.cambios_de_veredicto.map((x) => x.simbolo)));
  ok(lyft.secuencia.join(' → ') === '2026-08-05:descartada → 2026-08-13:aprobada', 'secuencia de veredictos tipo LYFT', lyft.secuencia.join(' → '));
  ok(/banda ±2%/.test(lyft.apariciones[0].motivo), 'el porqué del descarte viene del guard', lyft.apariciones[0].motivo);
  ok(lyft.apariciones[0].frases_del_plan.some((f) => /no me convence/.test(f))
    && lyft.apariciones[1].frases_del_plan.some((f) => /Ahora sí entro a LYFT/.test(f)), 'frases citadas de ambas corridas', JSON.stringify(lyft.apariciones.map((x) => x.frases_del_plan)));
}

console.log('arena-audit: resumen en markdown');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({ view: 'resumen', format: 'md' }, { authorization: `Bearer ${SECRET}` }), res);
  const md = res.text || '';
  ok(md.startsWith('# Resumen del run'), 'título del resumen', md.slice(0, 30));
  ok(/\*\*0 ventas voluntarias\.\*\*/.test(md), 'ventas voluntarias en 0, explícito');
  ok(/scout_picks: antes vs después de buffet-quality/.test(md) && /Delta del promedio:\*\* \+0\.5/.test(md), 'sección del antes/después con delta');
  ok(/Atención a posiciones heridas/.test(md) && /MU/.test(md), 'sección de posiciones heridas');
  ok(/### LYFT — 2026-08-05:descartada → 2026-08-13:aprobada/.test(md), 'cambio de veredicto con su secuencia');
  ok(/“Ahora sí entro a LYFT: el precio corrigió y la banda me deja\.”/.test(md), 'frases citadas en el markdown');
}

console.log('arena-audit: filtros y helpers');
{
  global.fetch = neonMock();
  const res = mockRes();
  await handler(GET({ desde: '2026-08-07', limit: '2' }, { authorization: `Bearer ${SECRET}` }), res);
  const q = queries.find((x) => x.includes('arena_journal'));
  ok(/limit 2/.test(q) && q.includes('run_date >= $2::date'), 'limit clampeado + ?desde parametrizado', q.replace(/\s+/g, ' ').slice(-90));
  ok(res.body.limite === 2, 'el límite efectivo se reporta', res.body.limite);

  const inyeccion = mockRes();
  await handler(GET({ limit: '5; drop table arena_journal' }, { authorization: `Bearer ${SECRET}` }), inyeccion);
  ok(!queries.some((x) => /drop table/i.test(x)), 'el limit no acepta texto (sin inyección)');

  const todos = mockRes();
  await handler(GET({ agent: 'todos' }, { authorization: `Bearer ${SECRET}` }), todos);
  ok(todos.code === 200 && todos.body.agente === 'todos', '?agent=todos no filtra por agente', todos.body.agente);

  ok(parsePct('+6.1%') === 6.1 && parsePct('-2.14%') === -2.14 && parsePct(null) === null, 'parsePct');
  ok(frasesConSimbolo('Compro MU hoy. Muchos nombres caros.', 'MU').length === 1, 'frasesConSimbolo no confunde MU con "Muchos"');
  ok(frasesConSimbolo('Salgo de (LYFT) mañana.', 'LYFT').length === 1, 'frasesConSimbolo atrapa el símbolo entre paréntesis');
  ok(jsonAfterMarker('X:\n{"a":1}', 'X:').a === 1 && jsonAfterMarker('X:\nno-json', 'X:') === null, 'jsonAfterMarker tolera basura');
}

console.log(failures ? `\n${failures} FALLAS` : '\nTodo verde');
process.exit(failures ? 1 : 0);
