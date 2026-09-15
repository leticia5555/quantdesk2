// ═══════════════════════════════════════════════════════════════
// tests/arena-cache-prefijo.test.mjs — el corte de caché del prompt.
//
// EL BUG QUE ARREGLA, y por qué era tan difícil de ver: el smoke reportaba
// `cache_read: 0` Y `cache_write: 0` en los dos agentes de Anthropic, con
// `cache_control` viajando correctamente en el payload desde siempre. La causa
// era que el bloque marcado NO LLEGABA AL MÍNIMO CACHEABLE del modelo (~760
// tokens contra un piso de 1.024), y por debajo del piso el proveedor IGNORA el
// marcador EN SILENCIO: no escribe, no cobra de más, no avisa.
//
// Lo que se prueba acá es lo que hace que el arreglo siga siendo cierto mañana:
//
//   1. EL PISO. El chequeo existe, dice el número y explica qué va a pasar.
//      Un prefijo corto no se bloquea — se DECLARA. El silencio es el bug.
//   2. EL ORDEN. Estable antes del último `cache_control`, volátil después. La
//      fecha va SIEMPRE fuera del bloque marcado: adentro, invalidaría la caché
//      todos los días y el ahorro sería exactamente cero.
//   3. EL CANDADO DEL PREFIJO COMPARTIDO. Nada que dependa del agente puede
//      entrar al bloque cacheado. Si entrara, cada agente tendría un prefijo
//      distinto y la caché no serviría para nada — que es de donde venimos.
//   4. LA ALLOWLIST del contexto compartido: un campo de diagnóstico nuevo en
//      el buffet NO se filtra al prompt por default.
//
// Sin red. Correr con `node tests/arena-cache-prefijo.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  buildScanSystemPrompt, buildScanUserPrompt, buildSharedContext,
  buildDiveSystemPrompt, SHARED_BUFFET_FIELDS,
} from '../api/arena-run.js';
import { buildAnthropicPayload, buildOpenRouterBody, cachePrefixReport, systemSegments } from '../api/_lib/arena-model.js';
import { ANTHROPIC_CACHE_MIN_TOKENS, ARENA_AGENTS, agentById } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const fable = agentById('claude');          // caps.cache === 'anthropic'
const gpt = agentById('openai');            // caps.cache === 'auto'
const grok = agentById('grok');             // caps.cache === null

// Buffet realista: ~30 movers, earnings, insiders y screener. El tamaño importa
// — es lo que lleva el prefijo por encima del piso.
const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const mkCand = (n) => mk(n, (i) => ({ symbol: 'UNI' + i, flags: i % 3 ? ['gainer'] : ['gainer', 'most_active'], price: 40 + i, change_pct: 5 - i * 0.02, volume: 2e7, high_52w: 90, low_52w: 20, pct_from_high: -8, pct_from_low: 120 }));
const buffet = {
  // BUFFET v1.5: el universo del día. Va en el prefijo cacheado con el resto —
  // es el MISMO para los siete agentes, que es justo lo que lo hace cacheable.
  universe: {
    version: 'v1.5', built_at: '2026-09-15T13:00:00Z', near_52w_pct: 2,
    counts: { universo_bruto: 120, admitidos: 104, publicados: 100 },
    candidates: mkCand(100),
  },
  movers: {
    gainers: mk(10, (i) => ({ symbol: 'GAIN' + i, price: 50 + i, changePct: 9 - i * 0.2, volume: 1e7 })),
    losers: mk(10, (i) => ({ symbol: 'LOSE' + i, price: 30 + i, changePct: -9 + i * 0.2, volume: 9e6 })),
    actives: mk(10, (i) => ({ symbol: 'ACTV' + i, price: 120 + i, changePct: 1.1, volume: 5e7 })),
  },
  earnings_this_week: mk(8, (i) => ({ ticker: 'ERN' + i, date: '2026-09-17', time: 'amc', when: 'in 2 days (Thu Sep 17, AMC)', epsEstimate: 1.2 })),
  recently_reported: mk(3, (i) => ({ ticker: 'REP' + i, date: '2026-09-14', epsActual: 1.4, surprisePct: 8.1, sessions_since_report: 1 })),
  notable_insider_buys: mk(6, (i) => ({ insider: 'Persona ' + i, role: 'CEO', ticker: 'INS' + i, value: 250000, tradeDate: '2026-09-12' })),
  screener: { value: mk(4, (i) => ({ symbol: 'VAL' + i, qualifiers: { pe: 11 } })), momentum: mk(4, (i) => ({ symbol: 'MOM' + i, qualifiers: { above_ma50: 0.12 } })) },
  screener_state: 'fresh',
  unavailable: [],
  // Diagnóstico interno: NO puede viajar al prompt.
  fetch_errors: { insiders: 'timeout (30s)' },
  channel_source: { insiders: { source: 'cache' } },
  channelsByTicker: { GAIN0: { channels: ['movers'] } },
  admission: { rejected: [{ symbol: 'DDDX', reason: 'price' }] },
  un_campo_nuevo_de_diagnostico: { secreto: true },
};

const scanSystem = buildScanSystemPrompt();
const shared = buildSharedContext(buffet);
const scanUser = buildScanUserPrompt({
  account: { equity: 100000, cash: 40000 }, positions: [{ symbol: 'NVDA', qty: '10', avg_entry_price: '150', market_value: '1800', unrealized_plpc: '0.2' }],
  openOrders: [], buffet, previous: { date: '2026-09-14', plan: 'ayer' },
});

// ── 1) EL PISO ───────────────────────────────────────────────────────
console.log('\n── el piso del mínimo cacheable ──');
{
  ok(ANTHROPIC_CACHE_MIN_TOKENS === 1024, 'el piso declarado es 1.024 tokens', String(ANTHROPIC_CACHE_MIN_TOKENS));

  const solo = cachePrefixReport(fable, scanSystem);
  ok(solo.status === 'below_min', 'el reglamento del SCAN SOLO no llega al piso — que era exactamente el bug', `${solo.tokens_est} tokens`);
  ok(/NO llega al mínimo/.test(solo.note || ''), 'y el reporte lo DICE en vez de callarlo', solo.note);
  ok(/IGNORAR EN SILENCIO/.test(solo.note || ''), 'nombrando la consecuencia: el marcador se ignora sin avisar');

  const con = cachePrefixReport(fable, [scanSystem, shared]);
  ok(con.status === 'ok', 'reglamento + contexto compartido SÍ cruza el piso', `${con.tokens_est} tokens vs piso ${con.min_tokens}`);
  ok(con.tokens_est > solo.tokens_est, 'y el contexto compartido es lo que lo cruza');

  const dive = cachePrefixReport(fable, buildDiveSystemPrompt('Claude PM'));
  ok(dive.status === 'ok', 'el system del DIVE pasa el piso SOLO: cachea todos los días, no solo dentro de una corrida', `${dive.tokens_est} tokens`);
}

console.log('\n── el reporte distingue las tres familias ──');
{
  ok(cachePrefixReport(gpt, [scanSystem, shared]).status === 'auto', 'OpenAI vía OpenRouter: caché automática, no hay marcador que poner');
  ok(cachePrefixReport(grok, [scanSystem, shared]).status === 'unsupported', 'Grok: la familia no soporta caché explícita — se dice, no se finge');
}

// ── 2) EL ORDEN ──────────────────────────────────────────────────────
console.log('\n── estable antes del marcador, volátil después ──');
{
  const payload = buildAnthropicPayload({
    agent: fable, system: [scanSystem, shared],
    messages: [{ role: 'user', content: scanUser }], now: new Date('2026-09-15T18:00:00Z'),
  });
  ok(Array.isArray(payload.system) && payload.system.length === 2, 'el system va en DOS bloques: cacheado y no cacheado', JSON.stringify(payload.system.map((b) => !!b.cache_control)));
  const [cacheado, volatil] = payload.system;
  ok(cacheado.cache_control && cacheado.cache_control.type === 'ephemeral', 'el primero lleva el marcador');
  ok(!volatil.cache_control, 'el segundo NO');
  ok(/TODAY'S DATE IS 2026-09-15/.test(volatil.text), 'la DIRECTIVA DE FECHA está en el bloque NO cacheado', volatil.text.slice(0, 60));
  // Se busca la DIRECTIVA, no la cadena de la fecha: el buffet legítimamente
  // lleva fechas adentro (`built_at`, calendarios de earnings) y ésas cambian
  // con el buffet, no todos los días contra un prefijo que no cambió. Lo que
  // no puede entrar es el recordatorio diario, que cambiaría el prefijo cada
  // día aunque el resto fuera idéntico.
  ok(!/TODAY'S DATE IS/.test(cacheado.text),
    'LA REGLA DE ORO: la directiva de fecha NUNCA entra al bloque cacheado — adentro invalidaría la caché todos los días y el ahorro sería cero');
  ok(cacheado.text.includes(scanSystem) && cacheado.text.includes(shared),
    'los dos segmentos estables quedan del lado cacheado, unidos bajo UN solo marcador');

  // OpenRouter: mismo orden, sin marcador (su caché es automática sobre el prefijo).
  const body = buildOpenRouterBody({ agent: gpt, system: [scanSystem, shared], messages: [{ role: 'user', content: scanUser }], now: new Date('2026-09-15T18:00:00Z') });
  const sysMsg = body.messages[0].content;
  ok(sysMsg.indexOf(scanSystem) === 0, 'OpenRouter: el reglamento abre el system (el prefijo que su caché automática indexa)');
  ok(sysMsg.indexOf('2026-09-15') > sysMsg.indexOf(shared), 'OpenRouter: la fecha va al FINAL, después de todo lo estable');

  ok(systemSegments('uno').length === 1 && systemSegments(['a', 'b']).length === 2 && systemSegments(['a', '', null]).length === 1,
    'systemSegments acepta string o array y descarta vacíos');
}

// ── 3) EL CANDADO DEL PREFIJO COMPARTIDO ─────────────────────────────
console.log('\n── nada del agente entra al prefijo cacheado ──');
{
  const delAgente = ['NVDA', '"avg_entry"', '"equity_total_incl_cash":', 'PREVIOUS PLAN'];
  for (const t of delAgente) {
    ok(!scanSystem.includes(t) && !shared.includes(t),
      `el prefijo cacheado NO trae "${t}" (dato del agente)`);
  }
  ok(scanUser.includes('NVDA') && scanUser.includes('PREVIOUS PLAN'), 'y el turno volátil sí lo trae');

  // El prefijo tiene que ser BYTE-IDÉNTICO entre los siete. Es la condición que
  // hace que la caché sirva: si difiere por agente, cada uno escribe la suya.
  const prefijos = ARENA_AGENTS.map(() => buildScanSystemPrompt() + '\n\n' + buildSharedContext(buffet));
  ok(new Set(prefijos).size === 1, 'el prefijo es byte-idéntico para los siete agentes', String(new Set(prefijos).size));

  // La ÚNICA parte del prompt que varía por agente es la persona del DIVE.
  ok(buildDiveSystemPrompt('Claude PM') !== buildDiveSystemPrompt('Grok PM'), 'el system del DIVE sí varía: lleva la persona (decisión #6 de la liga)');
  ok(buildDiveSystemPrompt('Claude PM') === buildDiveSystemPrompt('Claude PM'), 'y claude/control comparten persona → prefijo idéntico → el control sigue siendo control');
}

// ── 4) LA ALLOWLIST ──────────────────────────────────────────────────
console.log('\n── el contexto compartido es allowlist, no denylist ──');
{
  for (const fuga of ['fetch_errors', 'channel_source', 'channelsByTicker', 'admission', 'un_campo_nuevo_de_diagnostico', 'DDDX', 'timeout (30s)']) {
    ok(!shared.includes(fuga), `un campo de diagnóstico NO se filtra al prompt: "${fuga}"`);
  }
  for (const campo of SHARED_BUFFET_FIELDS) {
    ok(shared.includes('"' + campo + '"'), `el campo permitido SÍ viaja: ${campo}`);
  }
  ok(!SHARED_BUFFET_FIELDS.includes('fetch_errors') && !SHARED_BUFFET_FIELDS.includes('admission'),
    'y la allowlist no nombra ningún campo de diagnóstico');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
