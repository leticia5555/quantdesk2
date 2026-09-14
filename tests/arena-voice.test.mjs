// ═══════════════════════════════════════════════════════════════
// tests/arena-voice.test.mjs — TITULAR de la corrida (voz del arquetipo).
//
// Lo que esta suite existe para blindar, por encima de todo, es EL CANDADO:
// el arquetipo NO entra al prompt que decide. Si entrara, `claude` y `control`
// dejarían de compartir prompt byte-idéntico y el control —la única medición
// que dice cuánto del delta entre modelos es ruido— se caería. Un cambio que
// "solo" mueva la voz al system del DIVE debe romper este archivo.
// Correr con `node tests/arena-voice.test.mjs`.
// ═══════════════════════════════════════════════════════════════

process.env.DATABASE_URL = 'postgres://u:p@ep-x-1.us-east-2.aws.neon.tech/db';
delete process.env.ARENA_LEAGUE;
delete process.env.ARENA_HEADLINES;

import {
  HEADLINE_MAX, headlinesEnabled, normalizeHeadline,
  buildHeadlineSystemPrompt, buildHeadlineUserPrompt, generateHeadline,
} from '../api/_lib/arena-voice.js';
import { ARENA_AGENTS, agentById } from '../api/_lib/arena-registry.js';
import { buildDiveSystemPrompt, buildScanSystemPrompt, buildDiveUserPrompt } from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ═══ arquetipos en el registry ═════════════════════════════════════
console.log('voz: arquetipo fijo por modelo, en el registry');
ok(ARENA_AGENTS.every((a) => a.archetype && a.archetype.name && a.archetype.voice),
  'los siete tienen arquetipo con nombre y voz', JSON.stringify(ARENA_AGENTS.filter((a) => !a.archetype).map((a) => a.id)));
const nombres = ARENA_AGENTS.map((a) => a.archetype.name);
ok(new Set(nombres).size === nombres.length, 'ningún arquetipo se repite: siete voces distinguibles', JSON.stringify(nombres));
ok(/escéptico/i.test(agentById('control').archetype.name) && /no cree en nadie/i.test(agentById('control').archetype.name),
  'el control es "el escéptico que no cree en nadie"', agentById('control').archetype.name);
ok(agentById('claude').archetype.name !== agentById('control').archetype.name,
  'claude y el control comparten modelo y prompt de decisión, pero NO la voz (ahí sí se distinguen)');

// ═══ EL CANDADO: la voz no toca el prompt que decide ═══════════════
console.log('voz: CANDADO — el arquetipo NO entra al prompt de decisión');
const scanSys = buildScanSystemPrompt();
const diveClaude = buildDiveSystemPrompt(agentById('claude').persona);
const diveControl = buildDiveSystemPrompt(agentById('control').persona);
ok(diveClaude === diveControl,
  'el DIVE de claude y el del control siguen siendo BYTE-IDÉNTICOS (el control sigue siendo piso de ruido)');
for (const a of ARENA_AGENTS) {
  const marcas = [a.archetype.name, a.archetype.voice.slice(0, 30)];
  const sucio = marcas.some((m) => scanSys.includes(m) || diveClaude.includes(m) || buildDiveSystemPrompt(a.persona).includes(m));
  ok(!sucio, `${a.id}: su arquetipo NO aparece en el prompt del SCAN ni del DIVE`, a.archetype.name);
}
const diveUser = buildDiveUserPrompt({
  account: { equity: 100000, cash: 50000 }, positions: [], openOrders: [], previous: null,
  scanThesis: 't', candidates: ['AAPL'], deepDive: {}, closes: { AAPL: 200 }, channels: {},
});
ok(!/TU VOZ|arquetipo|escéptico/i.test(diveUser), 'el user prompt del DIVE tampoco menciona la voz');
ok(/TU VOZ:/.test(buildHeadlineSystemPrompt(agentById('grok'))),
  'la voz vive SOLO en el prompt del titular, que es el marcador con el que el resto del código lo distingue');

// ═══ el prompt del titular ═════════════════════════════════════════
console.log('voz: el prompt del titular narra, no decide');
const sysGrok = buildHeadlineSystemPrompt(agentById('grok'));
ok(sysGrok.includes('el provocador') && /ESPAÑOL/.test(sysGrok), 'lleva el arquetipo del agente y exige español', agentById('grok').archetype.name);
ok(/la decisión ya está tomada/i.test(sysGrok), 'le dice explícitamente que NO está decidiendo nada');
ok(/NO inventes cifras/i.test(sysGrok) && /no anuncies una operación que no esté en la lista/i.test(sysGrok),
  'prohíbe inventar números y anunciar operaciones inexistentes (misma regla de la casa que en el DIVE)');
ok(/no operaste/i.test(sysGrok), 'un día sin operar TAMBIÉN tiene titular — no se empuja a operar para tener qué contar');
ok(!/limit_price|max_positions|HARD RULES/i.test(sysGrok), 'no lleva reglas de trading: este modelo no puede decidir nada');

const userTitular = buildHeadlineUserPrompt({
  plan: 'I am buying AAPL.',
  actions: [
    { symbol: 'AAPL', side: 'buy', qty: 25, limit_price: 200, result: 'approved' },
    { symbol: 'FAKEZ', side: 'buy', result: 'discarded', reason: 'FAKEZ: no existe en el symbol map US' },
  ],
  equity: 101234.5, positions: 3, breakerStage: 'none',
});
ok(/COMPRA AAPL ×25 — ejecutada @ 200/.test(userTitular), 'la orden ejecutada llega resuelta, sin que el modelo interprete el journal');
ok(/DESCARTADA por el guard: FAKEZ: no existe/.test(userTitular), 'y el rechazo del guard llega con su razón verbatim (material de titular)');
ok(/equity 101235/.test(userTitular), 'el equity va redondeado: el titular no debe citar centavos');
ok(!/breaker/i.test(userTitular), "stage 'none' no ensucia el prompt con un breaker que no disparó");
ok(/etapa delever/.test(buildHeadlineUserPrompt({ plan: 'x', actions: [], breakerStage: 'delever' })),
  'pero un breaker activo SÍ se le dice (es la noticia del día)');
ok(/hoy no operaste/.test(buildHeadlineUserPrompt({ plan: 'x', actions: [] })), 'sin órdenes, el prompt lo dice tal cual');

// ── ADDENDUM 2026-09-14: la decisión por posición es material de titular ──
console.log('voz: ADDENDUM — condición de invalidación y confianza llegan al titular');
const userDec = buildHeadlineUserPrompt({
  plan: 'Holdeo NVDA.',
  actions: [],
  decisions: [
    { symbol: 'NVDA', stance: 'hold', invalidation_condition: 'si cierra dos sesiones bajo 140', confidence: 0.65 },
    { symbol: 'KO', stance: 'trim', invalidation_condition: null, confidence: null },
  ],
});
ok(/NVDA — hold · confianza 0.65 · vendes si: si cierra dos sesiones bajo 140/.test(userDec),
  'la decisión llega resuelta: stance, confianza y condición de venta en una línea', userDec);
ok(/KO — trim · sin confianza declarada · sin condición de venta declarada/.test(userDec),
  'un hueco se dice como hueco: el titular jamás rellena una confianza que el PM no declaró');
ok(/CONFIANZA/.test(buildHeadlineSystemPrompt(agentById('grok'))) && /no redondees la confianza a tu favor/.test(buildHeadlineSystemPrompt(agentById('grok'))),
  'y el system le dice que puede citarlas, pero tal como están');
ok(!/DECISIONES POR POSICIÓN/.test(buildHeadlineUserPrompt({ plan: 'x', actions: [] })),
  'sin decisiones no se imprime un encabezado vacío (un día sin libro no inventa una sección)');
ok(!/limit_price|max_positions/.test(userDec),
  'sigue sin llevar reglas de trading: narrar la decisión no es poder cambiarla');

// ═══ normalización (determinista) ══════════════════════════════════
console.log('voz: normalización del titular');
ok(normalizeHeadline('  Compro AAPL y me aguanto.  ') === 'Compro AAPL y me aguanto.', 'recorta espacios');
ok(normalizeHeadline('"Compro AAPL."') === 'Compro AAPL.', 'quita comillas rectas envolventes');
ok(normalizeHeadline('«Compro AAPL.»') === 'Compro AAPL.', 'y las tipográficas');
ok(normalizeHeadline('Titular: Compro AAPL.') === 'Compro AAPL.', 'quita el prefijo "Titular:"');
ok(normalizeHeadline('- Compro AAPL.') === 'Compro AAPL.', 'quita la viñeta de lista');
ok(normalizeHeadline('```\nCompro AAPL.\n```') === 'Compro AAPL.', 'quita fences de markdown');
ok(normalizeHeadline('Compro AAPL.\nY además vendo KO.') === 'Compro AAPL.', 'se queda con la PRIMERA línea: un titular es una línea');
ok(normalizeHeadline('   \n  ') === null && normalizeHeadline('') === null && normalizeHeadline(null) === null,
  'vacío → null (hueco honesto, nunca un titular en blanco)');
const largo = normalizeHeadline('NVDA '.repeat(60));
ok(largo.length <= HEADLINE_MAX && largo.endsWith('…'), `corta a ${HEADLINE_MAX} con elipsis`, String(largo.length));
ok(!/NVD…$/.test(largo), 'y corta en frontera de palabra, sin partir un ticker a la mitad', largo.slice(-12));

// ═══ generación best-effort ════════════════════════════════════════
console.log('voz: generación best-effort (narrar nunca tumba una corrida)');
const agente = agentById('deepseek');
const okLLM = async ({ system }) => ({ status: 200, data: { content: [{ text: system.includes('TU VOZ:') ? '"Cierro KO: los números dejaron de cuadrar."' : 'NO' }] } });
const h = await generateHeadline({ agent: agente, plan: 'p', actions: [], callLLM: okLLM });
ok(h && h.text === 'Cierro KO: los números dejaron de cuadrar.' && h.archetype === agente.archetype.name && h.model === agente.model,
  'devuelve texto normalizado + arquetipo + modelo (todo journaleable)', JSON.stringify(h));

ok(await generateHeadline({ agent: agente, plan: 'p', actions: [], callLLM: async () => { throw new Error('boom'); } }) === null,
  'si el proveedor revienta → null, sin propagar la excepción');
ok(await generateHeadline({ agent: agente, plan: 'p', actions: [], callLLM: async () => ({ status: 502, data: null }) }) === null,
  'si el proveedor responde error → null');
ok(await generateHeadline({ agent: agente, plan: 'p', actions: [], callLLM: async () => ({ status: 200, data: { content: [{ text: '   ' }] } }) }) === null,
  'si el titular sale vacío → null, no una cadena en blanco');
ok(await generateHeadline({ agent: { id: 'x', name: 'X' }, plan: 'p', actions: [], callLLM: okLLM }) === null,
  'un agente sin arquetipo no genera titular (no se inventa una voz)');

console.log('voz: apagable por env');
process.env.ARENA_HEADLINES = '0';
ok(headlinesEnabled() === false, 'ARENA_HEADLINES=0 apaga la función');
ok(await generateHeadline({ agent: agente, plan: 'p', actions: [], callLLM: okLLM }) === null,
  'apagado → null sin llamar al proveedor (se corta el gasto sin tocar código)');
delete process.env.ARENA_HEADLINES;
ok(headlinesEnabled() === true, 'por default está encendida');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
