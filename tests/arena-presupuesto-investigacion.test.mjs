// ═══════════════════════════════════════════════════════════════
// tests/arena-presupuesto-investigacion.test.mjs — los TRES techos.
//
// El tope era 8 llamadas. Ocho no sale del costo, ni del reloj, ni del
// contexto: es un número redondo, y cortaba la investigación a la mitad de una
// tesis con presupuesto de sobra.
//
// Ahora hay tres techos simultáneos y gana el que se agote primero:
//   · 20 LLAMADAS  — el tope grosero; veinte no es investigar, es un bucle.
//   · 30K TOKENS de contexto acumulado — el que de verdad aprieta.
//   · EL RELOJ     — derivado del deadline, no escrito a mano.
//
// Y los tres cortan IGUAL: se cierra con lo que haya. Ninguno aborta. Lo que
// cambia entre ellos es el NOMBRE, porque "se acabó el presupuesto" sin decir
// cuál de los tres no dice nada y los tres se arreglan distinto.
//
// La pieza que hace que el techo de 20 no sea decorativo es la COMPACTACIÓN:
// sin ella el contexto se agota alrededor de la vuelta 8 —el payload crece de
// forma cuadrática— y las otras doce llamadas no se podrían usar nunca.
//
// Correr con `node tests/arena-presupuesto-investigacion.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  runToolLoop, compactarConversacion, tokensDeConversacion,
  relojDisponible, LOOP_BUDGET_MS, RESERVA_CIERRE_MS, MARGEN_MS, MAX_TURNS,
} from '../api/_lib/arena-tool-loop.js';
import { createToolExecutor, compactarResultado, COMPACT_MARCA, TOOL_BUDGET, TOOL_CONTEXT_TOKENS } from '../api/_lib/arena-tools.js';
import { ARENA_AGENT_DEADLINE_MS, ARENA_LLM_TIMEOUT_MS } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const agent = { id: 'qwen', provider: 'openrouter', model: 'x' };
const pideHerramienta = (n) => ({
  status: 200,
  data: {
    content: [{ type: 'tool_use', id: 'c' + n, name: 'screener', input: { limit: 25 } }],
    _raw_message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + n, type: 'function', function: { name: 'screener', arguments: '{}' } }] },
  },
});
const cierra = { status: 200, data: { content: [{ type: 'text', text: '{"weights":{}}' }] } };

// Tablero grande: cada resultado del screener son ~25 filas.
const board = {
  gainers: Array.from({ length: 40 }, (_, i) => ({
    symbol: 'G' + String(i).padStart(2, '0'), price: 100 + i, change_pct: 9 - i * 0.2,
    rvol: 5 - i * 0.1, pct_from_high: -3, pct_from_low: 80,
  })),
  losers: [], rvol: [], breakouts: { high: [], low: [] }, headlines: [],
};
const mkExec = (budget) => createToolExecutor({ budget, board, creds: {}, now: new Date(), cache: false, deps: { sectorOf: () => 'XLK' } });

// ── 1) LOS TOPES DECLARADOS ──────────────────────────────────────────
console.log('\n── los tres techos, declarados ──');
{
  ok(TOOL_BUDGET.fixed_round === 20, '20 llamadas en la ronda fija', String(TOOL_BUDGET.fixed_round));
  ok(TOOL_CONTEXT_TOKENS === 30000, '30K tokens de contexto acumulado', String(TOOL_CONTEXT_TOKENS));
  ok(MAX_TURNS > TOOL_BUDGET.fixed_round,
    'y el tope de VUELTAS queda por encima del de llamadas: si no, sería el techo real con otro nombre',
    `${MAX_TURNS} vs ${TOOL_BUDGET.fixed_round}`);
}

// ── 2) EL RELOJ SE DERIVA ────────────────────────────────────────────
// Un número fijo no sigue al deadline: si alguien sube el deadline, el loop no
// se entera y se corta igual aunque sobre tiempo.
console.log('\n── el reloj sale de una resta, no de una constante escrita a mano ──');
{
  const conScan = relojDisponible({ scanMs: ARENA_LLM_TIMEOUT_MS });
  const sinScan = relojDisponible({ scanMs: 0 });
  ok(conScan === ARENA_AGENT_DEADLINE_MS - ARENA_LLM_TIMEOUT_MS - RESERVA_CIERRE_MS - MARGEN_MS,
    'con scan: deadline − scan − cierre − margen', String(conScan / 1000) + 's');
  ok(sinScan === ARENA_AGENT_DEADLINE_MS - RESERVA_CIERRE_MS - MARGEN_MS,
    'sin scan (la sombra, que es una sola cadena): deadline − cierre − margen', String(sinScan / 1000) + 's');
  ok(sinScan > conScan,
    'la sombra tiene MÁS reloj que arena-run, porque no paga una fase de scan que no corre',
    `${sinScan / 1000}s vs ${conScan / 1000}s`);

  // El peor caso tiene que caber con holgura ESTRICTA. "Exacto" en un
  // presupuesto de tiempo es lo que se come el primer hipo.
  ok(ARENA_LLM_TIMEOUT_MS + LOOP_BUDGET_MS + RESERVA_CIERRE_MS < ARENA_AGENT_DEADLINE_MS,
    'el peor caso cabe ESTRICTAMENTE dentro del deadline, no justo',
    `${(ARENA_LLM_TIMEOUT_MS + LOOP_BUDGET_MS + RESERVA_CIERRE_MS) / 1000}s < ${ARENA_AGENT_DEADLINE_MS / 1000}s`);

  // Los 240s que se pidieron NO caben, y el test lo deja escrito para que el
  // número no se cuele después sin la resta que lo desmiente.
  ok(sinScan < 240000,
    'los 240s pedidos NO caben: 300s de función − 30s de journaleo − 45s de cierre − 15s de margen = 210s',
    String(sinScan / 1000) + 's');
}

// ── 3) EL CUPO DE LLAMADAS CORTA, Y NO GASTA VUELTAS DE MÁS ──────────
console.log('\n── el cupo de llamadas: corta y se va al cierre ──');
{
  let n = 0;
  const call = async ({ toolChoice }) => {
    if (toolChoice) return cierra;
    return pideHerramienta(++n);
  };
  const ex = mkExec(3);
  const r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call, maxTurns: 20 });

  ok(r.stopped_by === 'call_budget', 'corta por `call_budget`, nombrado', r.stopped_by);
  ok(ex.used === 3, 'con las tres llamadas ejecutadas', String(ex.used));
  ok(r.turns === 3,
    'y en TRES vueltas: no gasta las 17 restantes pidiendo lo que ya no se puede ejecutar',
    String(r.turns));
  ok(r.llm === cierra, 'NO aborta: cierra con lo que investigó');
  ok(/presupuesto de LLAMADAS/.test(r.messages[r.messages.length - 1].content),
    'y el mensaje de cierre nombra el techo que se agotó');
  ok(r.limites.llamadas.pct === 100 && r.limites.contexto_tokens.pct < 100,
    'el bloque `limites` muestra los tres: llamadas al 100%, contexto lejos',
    JSON.stringify({ ll: r.limites.llamadas.pct, ctx: r.limites.contexto_tokens.pct }));
}

// ── 4) EL TECHO DE CONTEXTO CORTA ANTES QUE LAS LLAMADAS ─────────────
// Es el caso normal con resultados grandes, y el que la compactación existe
// para retrasar.
console.log('\n── el contexto: corta antes que las llamadas y se nombra distinto ──');
{
  let n = 0;
  const call = async ({ toolChoice }) => (toolChoice ? cierra : pideHerramienta(++n));
  const ex = mkExec(20);
  const r = await runToolLoop({
    agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call,
    maxTurns: 20, contextTokensMax: 900, compactar: false,
  });
  ok(r.stopped_by === 'context_budget', 'corta por `context_budget`', r.stopped_by);
  ok(ex.used < 20, 'con llamadas de sobra sin usar: el que se agotó fue el otro techo', String(ex.used));
  ok(r.llm === cierra, 'y también cierra en vez de abortar');
  ok(/presupuesto de CONTEXTO/.test(r.messages[r.messages.length - 1].content),
    'con su propio mensaje: los tres techos no se confunden entre sí');
  ok(r.limites.contexto_tokens.pico >= 900,
    'el pico de contexto queda registrado, no solo el del cierre', JSON.stringify(r.limites.contexto_tokens));
}

// ── 5) LA COMPACTACIÓN: sin ella, el techo de 20 es decorativo ───────
console.log('\n── compactar hace que las 20 llamadas se puedan usar de verdad ──');
{
  const correr = async (compactar) => {
    let n = 0;
    const call = async ({ toolChoice }) => (toolChoice ? cierra : pideHerramienta(++n));
    const ex = mkExec(20);
    const r = await runToolLoop({
      agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call,
      maxTurns: 25, contextTokensMax: 4000, compactar,
    });
    return { usadas: ex.used, stopped_by: r.stopped_by, limites: r.limites };
  };
  const sin = await correr(false);
  const con = await correr(true);

  ok(con.usadas > sin.usadas,
    'con el mismo techo de contexto, compactar deja hacer MÁS llamadas',
    `sin compactar: ${sin.usadas} · compactando: ${con.usadas}`);
  ok(con.limites.compactacion.resultados_compactados > 0,
    'y se reporta cuántos resultados se compactaron: un recorte que ocurre y no se dice es un recorte invisible',
    JSON.stringify(con.limites.compactacion));
}

// ── 6) QUÉ SE COMPACTA Y QUÉ NO ──────────────────────────────────────
console.log('\n── lo recién traído queda entero; lo viejo se resume y se DICE ──');
{
  const largo = ['CABECERA', ...Array.from({ length: 20 }, (_, i) => 'FILA' + i)].join('\n');
  const convo = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a', content: largo },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b' }] },
    { role: 'tool', tool_call_id: 'b', content: largo },
  ];
  const c = compactarConversacion(convo, { completas: 1 });
  ok(c.compactados === 1 && c.intactos === 1, 'se compacta el viejo y se deja el último entero', JSON.stringify(c));
  ok(convo[4].content === largo, 'el resultado que el modelo acaba de pedir NO se toca: está razonando sobre eso ahora');
  ok(convo[2].content.includes(COMPACT_MARCA), 'el viejo lleva la marca');
  ok(convo[2].content.startsWith('CABECERA'), 'conservando la cabecera, que es donde están las columnas');
  ok(/NO significa que no existan/.test(convo[2].content),
    'y DICE que las filas existen: un recorte en silencio hace que el modelo afirme "no hay ninguno que cumpla"');
  ok(/17 línea\(s\) más/.test(convo[2].content), 'con cuántas se omitieron', convo[2].content.split('\n')[4].slice(0, 40));

  // Idempotente: el loop compacta en CADA vuelta y no puede ir comiéndose el
  // resultado de a poco hasta dejar solo la cabecera.
  const antes = convo[2].content;
  compactarConversacion(convo, { completas: 0 });
  compactarConversacion(convo, { completas: 0 });
  ok(convo[2].content === antes, 'compactar dos veces no lo encoge más: es idempotente');

  // Lo corto no se toca: compactar 2 filas no ahorra nada y pierde datos.
  ok(compactarResultado('CAB\nsolo\ndos') === 'CAB\nsolo\ndos', 'un resultado corto se deja como está');

  // Anthropic guarda el resultado en otra forma; las dos se compactan.
  const ant = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: largo }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'y' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: largo }] },
  ];
  const ca = compactarConversacion(ant, { completas: 1 });
  ok(ca.compactados === 1 && ant[1].content[0].content.includes(COMPACT_MARCA),
    'la forma de Anthropic (tool_result dentro de un user) se compacta igual', JSON.stringify(ca));
  ok(ant[3].content[0].content === largo, 'y también respeta el último intacto');
}

// ── 7) EL REGISTRO NO SE COMPACTA ────────────────────────────────────
// Lo que se compacta es lo que se RE-ENVÍA. El journal y el replay tienen que
// seguir viendo lo que el modelo miró de verdad para decidir.
console.log('\n── el journal conserva los resultados COMPLETOS ──');
{
  let n = 0;
  const call = async ({ toolChoice }) => (toolChoice ? cierra : pideHerramienta(++n));
  const ex = mkExec(6);
  const r = await runToolLoop({
    agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call,
    maxTurns: 10, contextTokensMax: 3000, compactar: true,
  });
  ok(r.limites.compactacion.resultados_compactados > 0, 'hubo compactación en la conversación');
  const enConvo = r.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  ok(enConvo.some((t) => t.includes(COMPACT_MARCA)), 'y se ve en lo que se re-envió');
  ok(ex.sequence.every((s2) => !String(s2.result || '').includes(COMPACT_MARCA)),
    'pero NINGUNA fila del registro está compactada: el replay ve lo que el modelo vio',
    String(ex.sequence.length));
  ok(ex.sequence.every((s2) => s2.result && s2.result.split('\n').length > 4),
    'los resultados del registro conservan sus filas completas');
}

// ── 8) EL REPARTO ENTRE INVESTIGAR Y DECIDIR ─────────────────────────
// EL BUG DEL 2026-09-17 (sombra de los 7, 6/7): grok gastó sus 20 herramientas,
// cortó por `call_budget` con reloj de sobra, y después recibió 45s para
// redactar el libro final sobre un payload enorme. Timeout NUESTRO a los 45.003
// ms — y el resto del presupuesto del loop, minutos en ese caso, se tiró.
//
// El turno de cierre es el que convierte una corrida en una decisión: es el
// último lugar donde tiene sentido ahorrar tiempo.
console.log('\n── el cierre se lleva la reserva MÁS lo que sobró del loop ──');
{
  ok(RESERVA_CIERRE_MS === 70000,
    'la reserva mínima del cierre subió de 45s a 70s: un modelo que razona mucho no redacta el JSON en 45',
    String(RESERVA_CIERRE_MS / 1000) + 's');

  // Un loop que corta TEMPRANO (por cupo de llamadas) tiene que ceder su
  // sobrante al cierre, no tirarlo.
  let techoDelCierre = null;
  let n = 0;
  const call = async ({ toolChoice, timeoutMs }) => {
    if (toolChoice) { techoDelCierre = timeoutMs; return cierra; }
    return pideHerramienta(++n);
  };
  const ex = mkExec(2);
  const t = { ahora: 0 };
  const r = await runToolLoop({
    agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call,
    maxTurns: 20, budgetMs: 185000, clock: () => (t.ahora += 20000),
  });

  ok(r.stopped_by === 'call_budget', 'el loop corta por cupo, con reloj de sobra', r.stopped_by);
  ok(techoDelCierre > RESERVA_CIERRE_MS,
    'y el cierre recibe MÁS que la reserva: se lleva lo que el loop no usó',
    `${Math.round(techoDelCierre / 1000)}s > ${RESERVA_CIERRE_MS / 1000}s`);
  ok(r.limites.reparto_ms.investigacion_sobrante > 0,
    'el sobrante de investigación queda journaleado', JSON.stringify(r.limites.reparto_ms));
  ok(r.limites.reparto_ms.cierre_concedido === techoDelCierre,
    'y cuánto se le concedió de verdad al cierre: sin esto, "se pasó de tiempo" no dice si le faltó reloj o si le sobró y no se lo dimos');

  // El techo TOTAL no se mueve: la reserva ya se descontó del presupuesto del
  // loop, así que `loop + cierre` sigue acotado pase lo que pase.
  // El invariante se juzga con el instante DEL REPARTO, no con el `usado` final:
  // `limites()` lee el reloj después de conceder el cierre, así que sumar ése
  // contra un techo calculado antes compara dos momentos distintos. Lo detectó
  // este mismo test al ponerse rojo con un reloj falso que salta de a 20s.
  const rep = r.limites.reparto_ms;
  ok(rep.reparto_en_ms != null && rep.reparto_en_ms + techoDelCierre <= 185000 + RESERVA_CIERRE_MS,
    'el total sigue acotado: lo que cambia es QUIÉN usa el tiempo que sobra',
    `${rep.reparto_en_ms} + ${techoDelCierre} ≤ ${185000 + RESERVA_CIERRE_MS}`);
  ok(rep.reparto_en_ms <= rep.investigacion_usada,
    'y el instante del reparto es anterior a la medición final, como tiene que ser',
    `${rep.reparto_en_ms} ≤ ${rep.investigacion_usada}`);

  // Y la resta del deadline sigue cerrando con la reserva más grande.
  ok(ARENA_LLM_TIMEOUT_MS + LOOP_BUDGET_MS + RESERVA_CIERRE_MS < ARENA_AGENT_DEADLINE_MS,
    'con la reserva en 70s, el peor caso SIGUE cabiendo en el deadline',
    `${(ARENA_LLM_TIMEOUT_MS + LOOP_BUDGET_MS + RESERVA_CIERRE_MS) / 1000}s < ${ARENA_AGENT_DEADLINE_MS / 1000}s`);
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
