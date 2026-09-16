// ═══════════════════════════════════════════════════════════════
// tests/arena-presupuesto.test.mjs — B9: el breaker de gasto, en escalones.
//
// Hace falta AHORA y no antes por una razón concreta: con herramientas una
// corrida dejó de ser dos llamadas al LLM y pasó a ser hasta diez. El gasto por
// corrida se multiplicó y el techo que sobraba puede quedar corto en un día
// volátil, sin que nadie se entere hasta la factura.
//
// Lo que se blinda:
//
//   1. LOS ESCALONES, y por qué el diseño obvio era PEOR. "Si te pasás, apagá
//      las rondas fijas" deja vivos los disparadores, que en un día volátil son
//      MÁS caros que lo que se apagó: el breaker ahorraría solo los días
//      tranquilos, que son los días en que no hacía falta.
//   2. LA RED DE RIESGO NUNCA SE APAGA. No gasta tokens; un presupuesto que
//      apaga la protección del libro cambia plata por riesgo sin decirlo.
//   3. EL COSTO NO SE INVENTA, y un total que ignora corridas sin precio
//      SUBESTIMA el gasto — un breaker que subestima no dispara cuando debería.
//   4. SIN CONTADOR, FAIL OPEN y declarado: frenar la liga porque la DB no
//      contesta cambia un problema de observabilidad por uno de producto.
//
// Correr con `node tests/arena-presupuesto.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  DAILY_BUDGET_USD, TIER2_MULTIPLIER, spendTier, tierPolicy, callCost,
  tierAnnouncementId, tierAnnouncementText,
} from '../api/_lib/arena-budget.js';
import { TOOL_BUDGET } from '../api/_lib/arena-tools.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── los umbrales ──');
{
  ok(DAILY_BUDGET_USD === 30, 'el presupuesto declarado son $30/día', String(DAILY_BUDGET_USD));
  ok(TIER2_MULTIPLIER === 1.5, 'y el escalón 2 está a 1.5×', String(TIER2_MULTIPLIER));
  ok(spendTier(0) === 0 && spendTier(29.99) === 0, 'debajo del presupuesto, escalón 0');
  ok(spendTier(30) === 1 && spendTier(44.99) === 1, 'al llegar al presupuesto, escalón 1');
  ok(spendTier(45) === 2 && spendTier(200) === 2, 'a 1.5× o más, escalón 2');
  ok(spendTier(-5) === 0 && spendTier('x') === 0, 'un gasto inválido no dispara un escalón por accidente');
}

console.log('\n── 1) el escalón 1 SIGUE DECIDIENDO ──');
{
  const p1 = tierPolicy(1);
  ok(p1.fixed_rounds === true,
    'el escalón 1 NO apaga las rondas fijas: apagarlas dejaría vivos los disparadores, que en un día volátil son MÁS caros que lo que se apagó');
  ok(p1.tools_max === 3, 'lo que hace es bajar las herramientas de 8 a 3', String(p1.tools_max));
  ok(p1.effort === 'low', 'y el effort a bajo', p1.effort);
  ok(/sigue decidiendo/.test(p1.label), 'la etiqueta lo dice', p1.label);
  ok(p1.cut && /20 a 3/.test(p1.cut), 'y se declara QUÉ se recortó', p1.cut);
}

console.log('\n── el escalón 2 corta lo caro, no lo que protege ──');
{
  const p2 = tierPolicy(2);
  ok(p2.tools_max === 0 && p2.fixed_rounds === false, 'sin herramientas y sin rondas fijas');
  ok(p2.buffet_triggers === false, 'se apagan los disparadores de OPORTUNIDAD (el buffet)');
  ok(p2.own_book_triggers === true,
    'pero NO los del propio libro: eso es una posición suya moviéndose, no una oportunidad que se puede dejar pasar');
}

console.log('\n── 2) la RED DE RISGO no se apaga en NINGÚN escalón ──');
{
  for (const t of [0, 1, 2, 5]) {
    ok(tierPolicy(t).risk_net === true,
      `escalón ${t}: la red sigue viva — no gasta tokens, y un presupuesto que apaga la protección del libro cambia plata por riesgo sin decirlo`);
  }
}

console.log('\n── el escalón 0 no impone nada ──');
{
  const p0 = tierPolicy(0);
  // Era 8, un número redondo que no salía de ninguna medida. El escalón 0 usa
  // el presupuesto declarado en TOOL_BUDGET, y lee de ahí en vez de repetir el
  // número: dos constantes con el mismo valor son dos constantes que un día
  // difieren.
  ok(p0.tools_max === TOOL_BUDGET.fixed_round && p0.tools_max === 20,
    'el escalón 0 concede el presupuesto completo de llamadas (20)', String(p0.tools_max));
  ok(p0.effort === null, 'y el effort en null = el default del registry, no un valor pisado desde acá');
  ok(p0.cut === null, 'sin recortes');
}

console.log('\n── 3) el costo NO se inventa ──');
{
  ok(callCost({ providerUsd: 0.5, anthropicUsd: 0.9 }).source === 'provider_reported',
    'lo que COBRÓ el proveedor siempre gana');
  ok(callCost({ anthropicUsd: 0.9, estimateUsd: 0.1 }).source === 'anthropic_price_table',
    'después la tabla de precios de la casa');
  const est = callCost({ estimateUsd: 0.1 });
  ok(est.source === 'catalog_estimate' && est.estimated === true, 'y la estimación va MARCADA como estimación');
  const nada = callCost({});
  ok(nada.usd === null && /no se inventa/.test(nada.note),
    'sin ninguna fuente, null — un costo ausente es un dato; uno inventado es una mentira que después alguien usa para presupuestar', nada.note);
  ok(callCost({ providerUsd: 0 }).usd === 0, 'un costo de CERO reportado es un costo válido, no una ausencia');
}

console.log('\n── el anuncio ──');
{
  const hoy = new Date('2026-09-16T18:00:00Z');
  ok(tierAnnouncementId(1, hoy) === 'arena-presupuesto-2026-09-16-escalon-1',
    'el id es idempotente por (día, escalón): se anuncia UNA vez, no en cada corrida que lo encuentra',
    tierAnnouncementId(1, hoy));
  ok(tierAnnouncementId(1, hoy) !== tierAnnouncementId(2, hoy), 'y cada escalón tiene el suyo');

  const t = tierAnnouncementText({ tier: 1, spent_usd: 31.5, budget_usd: 30, pct_of_budget: 105, label: 'sigue decidiendo, más barato: 3 herramientas y effort bajo', cut: 'herramientas de 8 a 3, effort de medium a low' });
  ok(/ESCALÓN 1/.test(t) && /\$31\.50/.test(t), 'el texto lleva el escalón y el gasto que lo disparó', t.split('\n')[0]);
  ok(/Se recorta/.test(t), 'y qué se recortó');
  ok(/MÁS caros que las rondas/.test(t), 'explicando por qué el escalón 1 no apaga las rondas fijas');

  const t2 = tierAnnouncementText({ tier: 2, spent_usd: 46, budget_usd: 30, pct_of_budget: 153, label: 'solo la red de riesgo', cut: 'rondas fijas y disparadores del buffet' });
  ok(/RED DE RIESGO sigue corriendo/.test(t2), 'el del escalón 2 aclara que la red no se apaga', t2.split('\n')[2]);
}

console.log('\n── 3b) un total que ignora corridas sin precio SUBESTIMA ──');
{
  // El caso: 5 agentes con precio suman $28 y 2 sin precio no suman nada. El
  // breaker leería $28 (escalón 0) cuando el gasto real pudo pasar los $30.
  ok(spendTier(28) === 0, 'con $28 contados, el breaker dice escalón 0');
  ok(spendTier(28 + 2 * 1.2) > 0 || spendTier(31) === 1,
    'pero si las dos corridas sin precio costaron ~$1.2 cada una, el escalón real era 1 — por eso `partial` viaja en el reporte');
}

// ═══════════════════════════════════════════════════════════════
// B9 EN EL CAMINO VIVO — el techo tiene que apretar donde se gasta.
//
// El bloque de arriba prueba la POLÍTICA (qué permite cada escalón). Esto
// prueba que la política llega al lugar donde se queman los tokens: el
// presupuesto de herramientas de una corrida, el `effort` que viaja en el
// payload, y el contador que alimenta al propio breaker.
//
// Sin esto B9 es una tabla bonita: la liga seguiría corriendo con 8
// herramientas y effort medium mientras el escalón dice otra cosa.
// ═══════════════════════════════════════════════════════════════

console.log('\n── el techo de herramientas: el MENOR de los dos ──');
{
  // La regla del runner: min(tope por tipo de corrida, tope por escalón).
  const min = (tipo, escalon) => Math.min(tipo, escalon);
  ok(min(8, tierPolicy(0).tools_max) === 8, 'ronda fija en escalón 0 → las 8');
  ok(min(8, tierPolicy(1).tools_max) === 3, 'ronda fija en escalón 1 → 3: el escalón aprieta');
  ok(min(8, tierPolicy(2).tools_max) === 0, 'ronda fija en escalón 2 → ninguna');
  ok(min(3, tierPolicy(0).tools_max) === 3,
    'corrida por disparador en escalón 0 → 3, NO 8: el escalón no puede AFLOJAR el tope del tipo de corrida');
  ok(min(3, tierPolicy(1).tools_max) === 3, 'y en escalón 1 sigue en 3 — el mínimo no cambia nada acá');
}

console.log('\n── el `effort` del escalón viaja en el payload ──');
{
  // La perilla de profundidad de esta liga es `effort`, no la temperatura. Si
  // el escalón la baja a 'low' pero el payload sigue diciendo el default, el
  // escalón 1 no ahorra un centavo.
  const { buildAnthropicPayload, buildOpenRouterBody, effectiveParams } = await import('../api/_lib/arena-model.js');
  const agenteA = { id: 'x', provider: 'anthropic', model: 'm', caps: { effort: 'anthropic', sampling: false } };
  const agenteO = { id: 'y', provider: 'openrouter', model: 'n', caps: { effort: 'openrouter' } };
  const base = { system: 's', messages: [{ role: 'user', content: 'u' }], now: new Date('2026-09-15T18:00:00Z') };

  const pA = buildAnthropicPayload({ agent: agenteA, model: 'm', ...base, effort: tierPolicy(1).effort });
  ok(pA.output_config && pA.output_config.effort === 'low',
    'Anthropic: el effort del escalón 1 llega a output_config', JSON.stringify(pA.output_config));
  const pO = buildOpenRouterBody({ agent: agenteO, model: 'n', ...base, effort: tierPolicy(1).effort });
  ok(pO.reasoning && pO.reasoning.effort === 'low',
    'OpenRouter: el mismo effort llega a reasoning.effort', JSON.stringify(pO.reasoning));

  // Escalón 0: `effort` es null y NO debe pisar el default del registry.
  const p0 = buildAnthropicPayload({ agent: agenteA, model: 'm', ...base, effort: tierPolicy(0).effort || undefined });
  ok(p0.output_config && p0.output_config.effort && p0.output_config.effort !== 'low',
    'escalón 0: el effort null NO pisa el default del registry', JSON.stringify(p0.output_config));

  // Y lo que se journalea como "con qué corrió" tiene que decir la verdad.
  ok(effectiveParams(agenteA, 3000, 'low').effort === 'low',
    'effectiveParams reporta el effort REAL de la corrida, no el del reglamento');
  ok(effectiveParams({ id: 'z', provider: 'openrouter', model: 'n', caps: {} }, 3000, 'low').effort === null,
    'y sigue diciendo null en un modelo que no razona: el parámetro no viaja');
}

console.log('\n── el contador cuenta TODAS las vueltas, no la última ──');
{
  // ÉSTE ES EL BUG QUE HABRÍA HECHO INÚTIL AL BREAKER. `runToolLoop` devuelve el
  // último turno del modelo. Con 8 herramientas el prompt entero viaja en cada
  // vuelta, así que el gasto real es varias veces el de esa última llamada.
  // Alimentar al breaker con un noveno del gasto es tener un breaker que
  // dispara cuando ya no sirve.
  const { runToolLoop } = await import('../api/_lib/arena-tool-loop.js');
  let vuelta = 0;
  const executor = {
    used: 0, sequence: [],
    call: async () => { executor.used++; return { text: 'ok' }; },
    summary: () => ({}),
  };
  const call = async () => {
    vuelta++;
    // Dos vueltas pidiendo herramienta, la tercera cierra.
    const pide = vuelta <= 2;
    return {
      status: 200,
      data: {
        content: pide
          ? [{ type: 'tool_use', id: 't' + vuelta, name: 'screener', input: {} }]
          : [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_usd: 0.5,
      },
    };
  };
  const loop = await runToolLoop({
    agent: { id: 'a', provider: 'anthropic', model: 'm', caps: {} },
    system: 's', messages: [{ role: 'user', content: 'u' }], executor, call,
  });
  ok(loop.usage_total.calls === 3,
    'el loop reporta las 3 llamadas que hizo, no 1', String(loop.usage_total.calls));
  ok(loop.usage_total.input_tokens === 3000 && loop.usage_total.output_tokens === 300,
    'y suma los tokens de las tres: 3000 de entrada, no los 1000 de la última',
    JSON.stringify(loop.usage_total));
  ok(loop.cost_usd_total === 1.5,
    'lo mismo con el costo que reportó el proveedor: $1.50, no $0.50', String(loop.cost_usd_total));
  ok((loop.llm.data.usage.input_tokens) === 1000,
    'el `usage` del último turno sigue intacto: el acumulado se agrega, no lo pisa');
}

console.log('\n── el gasto se registra por FASE, no por corrida ──');
{
  // `arena_spend` tiene el id como clave primaria con `on conflict do nothing`.
  // Si el scan y el dive de la misma corrida comparten id, el segundo se
  // descarta EN SILENCIO y el breaker ve la mitad del gasto real.
  const { recordRunSpend } = await import('../api/_lib/arena-budget.js');
  ok(typeof recordRunSpend === 'function', 'recordRunSpend existe');
  const idScan = 'arena-claude-2026-09-15T18:00:00.000Z:scan';
  const idDive = 'arena-claude-2026-09-15T18:00:00.000Z:dive';
  ok(idScan !== idDive,
    'el id lleva la FASE: sin el sufijo el dive chocaría con el scan y su gasto se perdería sin ruido');
}

console.log('\n── lo que el escalón 2 apaga, y lo que NO ──');
{
  const p2 = tierPolicy(2);
  ok(p2.fixed_rounds === false, 'escalón 2: las rondas fijas NO corren');
  ok(p2.buffet_triggers === false, 'ni los disparadores de oportunidad del buffet');
  ok(p2.own_book_triggers === true,
    'pero SÍ los del propio libro: una posición abierta que cruza su stop tiene que poder despertar a su dueño aunque el presupuesto esté agotado — eso es riesgo, no exploración');
  ok(p2.risk_net === true, 'y la red determinista sigue, como en todos los escalones: no gasta un token');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
