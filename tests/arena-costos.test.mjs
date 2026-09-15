// ═══════════════════════════════════════════════════════════════
// Tests del COSTO REPORTADO del Arena.
//
// El bug: `cost_usd: null` en los CINCO de OpenRouter. OpenRouter manda
// `usage.cost` (el cobro real) solo a veces, y cuando no lo manda no había
// plan B — siete modelos quemando tokens y un total de $0.0000. Peor en
// /api/ai-usage: su tabla de precios solo conoce modelos de Anthropic, así que
// el gasto de la liga contaba a dos de siete y nadie lo notaba porque el número
// igual salía.
//
// La regla que estos tests protegen: se prefiere SIEMPRE el cobro real; el
// catálogo vivo es el plan B y va MARCADO; y si no hay ninguno de los dos, el
// costo es null con su nota. Nunca un número inventado que parezca medido.
//
// Correr con `node tests/arena-costos.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { openRouterCostUsd, openRouterPrices, __resetPriceCache } from '../api/_lib/arena-model.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── openRouterCostUsd: la aritmética ──');
ok(openRouterCostUsd({ input_tokens: 1e6, output_tokens: 0 }, { input: 2, output: 6 }) === 2,
  '1M de entrada a $2/MTok = $2');
ok(openRouterCostUsd({ input_tokens: 0, output_tokens: 1e6 }, { input: 2, output: 6 }) === 6,
  '1M de salida a $6/MTok = $6');
ok(openRouterCostUsd({ input_tokens: 12000, output_tokens: 4000 }, { input: 2, output: 6 }) === 0.048,
  'grok con 12k/4k = $0.048');
// GPT-6 Astra a $10/$50: la corrida cara de la liga.
ok(openRouterCostUsd({ input_tokens: 20000, output_tokens: 6000 }, { input: 10, output: 50 }) === 0.5,
  'astra con 20k/6k = $0.50 (5x el resto, por eso importa verlo)');

console.log('\n── El razonamiento NO se cuenta dos veces ──');
// OpenRouter ya incluye reasoning_tokens dentro de completion_tokens.
const conRazonamiento = { input_tokens: 1000, output_tokens: 5000, reasoning_tokens: 4000 };
ok(openRouterCostUsd(conRazonamiento, { input: 10, output: 50 }) === +((1000/1e6)*10 + (5000/1e6)*50).toFixed(6),
  'reasoning_tokens no se suma aparte (ya viene en output_tokens)');

console.log('\n── Nunca inventa un número ──');
ok(openRouterCostUsd({ input_tokens: 100, output_tokens: 100 }, null) === null, 'sin precio → null');
ok(openRouterCostUsd(null, { input: 2, output: 6 }) === null, 'sin usage → null');
ok(openRouterCostUsd({ input_tokens: 100, output_tokens: 100 }, { input: 'gratis', output: 6 }) === null,
  'precio no numérico → null, no NaN');
ok(openRouterCostUsd({ input_tokens: 100, output_tokens: 100 }, {}) === null, 'precio vacío → null');
// Un 0 legítimo (modelo free) NO es lo mismo que "no sé".
ok(openRouterCostUsd({ input_tokens: 1000, output_tokens: 1000 }, { input: 0, output: 0 }) === 0,
  'un modelo gratis cuesta 0, y eso NO es null');

console.log('\n── openRouterPrices: catálogo, caché y caída ──');
const realFetch = globalThis.fetch;
let llamadas = 0;
globalThis.fetch = async () => {
  llamadas++;
  return { ok: true, json: async () => ({ data: [
    { id: 'x-ai/grok-4.6', pricing: { prompt: '0.000002', completion: '0.000006' } },
    { id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00005' } },
    { id: 'sin/precio' },
  ] }) };
};
__resetPriceCache();
const precios = await openRouterPrices();
ok(precios['x-ai/grok-4.6'].input === 2 && precios['x-ai/grok-4.6'].output === 6,
  'el precio por token del catálogo se convierte a $/MTok', JSON.stringify(precios['x-ai/grok-4.6']));
ok(precios['openai/gpt-6-astra'].input === 10 && precios['openai/gpt-6-astra'].output === 50,
  'astra: $10/$50 por MTok');
ok(!('sin/precio' in precios), 'un modelo sin bloque pricing se omite, no entra con 0');

await openRouterPrices();
ok(llamadas === 1, 'el catálogo se baja UNA vez por proceso (no 446 modelos por agente)', `${llamadas} llamadas`);

// Catálogo caído: devuelve lo último bueno, y nunca lanza.
globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
__resetPriceCache();
let lanzo = false;
let caido;
try { caido = await openRouterPrices(); } catch { lanzo = true; }
ok(!lanzo, 'el catálogo caído NO lanza (el costo es observabilidad, no puede tumbar una corrida)');
ok(caido === null, 'sin catálogo y sin caché previa → null, y arriba eso se vuelve priced:false');
globalThis.fetch = realFetch;

console.log('\n── El smoke prefiere el cobro real sobre la estimación ──');
const smoke = readFileSync(new URL('../api/arena-smoke.js', import.meta.url), 'utf8');
const bloque = smoke.slice(smoke.indexOf('// COSTO, en orden de preferencia'), smoke.indexOf('¿LA CACHÉ ESTÁ VIVA?'));
ok(bloque.indexOf("'openrouter_reported'") < bloque.indexOf("'catalog_estimate'"),
  'usage.cost se evalúa ANTES que el catálogo');
ok(/cost_estimated = true/.test(bloque), 'la estimación queda marcada con cost_estimated');
ok(/pricing_per_mtok = pricing/.test(bloque), 'y viaja el precio con el que se calculó, para poder auditarlo');
ok(/no se inventa/.test(bloque), 'sin precio: null y la nota, no un cero silencioso');

console.log('\n── ai-usage cotiza a los de OpenRouter ──');
const usage = readFileSync(new URL('../api/ai-usage.js', import.meta.url), 'utf8');
ok(/openRouterPrices/.test(usage), 'ai-usage baja el catálogo');
ok(/price_source/.test(usage), 'y dice de dónde salió cada precio');
ok(/orPrices\s*=\s*rows\.some/.test(usage), 'solo lo baja si hay algún slug de OpenRouter en las filas');

console.log('\n── El canal insiders tiene su propio techo ──');
const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
ok(/BUFFET_TIMEOUT_MS = \{\s*\n\s*insiders:/.test(run), 'insiders tiene un techo propio');
ok(/ARENA_BUFFET_TIMEOUT_INSIDERS_MS/.test(run), 'y es ajustable por env var sin deploy');
ok(!/timeout \(12s\)'/.test(run), 'ya no se reporta "12s" fijo (mentía apenas los techos dejaron de ser iguales)');
ok(/SEC EDGAR/.test(run), 'el error nombra a SEC EDGAR, que es quien tarda');

console.log(failures ? `\n${failures} FALLAS\n` : '\nTodo en verde\n');
process.exit(failures ? 1 : 0);
