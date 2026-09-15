// ═══════════════════════════════════════════════════════════════
// tests/arena-herramientas.test.mjs — B3: las herramientas y su loop.
//
// Lo que se blinda son las cinco cosas que el scope marcó como las que se
// hacen mal si nadie las mira:
//
//   1. EL TOPE ES DEL HARNESS, NO DEL PROMPT. La llamada 9 no se ejecuta, y el
//      modelo RECIBE un resultado que se lo dice. Un tope que solo vive en el
//      prompt es una sugerencia.
//   2. EL TRUNCAMIENTO SE DECLARA DENTRO DEL RESULTADO. Un modelo al que le
//      cortaron los datos sin avisarle razona sobre una lista que cree completa
//      y después afirma que "no hay ningún nombre que cumpla".
//   3. LAS DOS FORMAS DE TURNO. Anthropic quiere el eco VERBATIM y UN mensaje
//      con todos los tool_result; OpenAI quiere el `message` crudo y UN mensaje
//      `tool` POR CADA llamada. Hacerlo "parecido" en vez de exacto da un 400.
//   4. EL GUARD DE FECHAS NO PUEDE REINTENTAR sobre un turno con herramientas:
//      appendear un turno de usuario ahí es un payload inválido en los dos
//      proveedores.
//   5. LOS ARGUMENTOS SE ACOTAN, NO SE RECHAZAN. `limit: 500` es "dame todo",
//      no un error — rechazarlo gastaría una llamada del presupuesto por nada.
//
// Sin red: el LLM y las fuentes se inyectan.
// Correr con `node tests/arena-herramientas.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  createToolExecutor, clampArgs, cacheKey, truncateRows, toolsForProvider,
  TOOL_DEFS, TOOL_BUDGET, RESULT_TOKEN_CAP,
} from '../api/_lib/arena-tools.js';
import { runToolLoop, buildToolTurn, toolUseBlocks, MAX_TURNS } from '../api/_lib/arena-tool-loop.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const HOY = new Date('2026-09-16T15:00:00Z');

// Tablero sintético: 40 nombres, algunos en máximos, algunos con noticia.
const board = {
  gainers: Array.from({ length: 40 }, (_, i) => ({
    symbol: 'G' + String(i).padStart(2, '0'), price: 100 + i, change_pct: 9 - i * 0.2,
    rvol: 5 - i * 0.1, pct_from_high: i < 6 ? -0.4 : -25, pct_from_low: 90,
  })),
  losers: [], rvol: [], breakouts: { high: [], low: [] },
  sectors: [{ etf: 'XLK', d1: 1.2, d5: 3.4, m1: -2.1 }],
  headlines: [{ tag: 'UP', symbols: ['G00'], headline: 'Broker upgrades G00' }],
};
const sectorOf = (s) => (s === 'G00' || s === 'G01' ? 'XLK' : 'XLE');
const mkExec = (over = {}) => createToolExecutor({
  board, creds: {}, now: HOY, cache: false,
  deps: { sectorOf, getNews: async () => [], fetchDeepDive: async () => ({ data: {}, errors: {} }) },
  ...over,
});

// ── 5) ARGUMENTOS: se acotan, no se rechazan ─────────────────────────
console.log('\n── los argumentos se ACOTAN y se avisa, no se rechazan ──');
{
  const { args, notes } = clampArgs('screener', { limit: 500, min_rvol: -3, sector: 'xlk' });
  ok(args.limit === 25, 'limit 500 → 25 (es "dame todo", no un error)', String(args.limit));
  ok(args.min_rvol === 0, 'un RVOL negativo se acota a 0', String(args.min_rvol));
  ok(args.sector === 'XLK', 'el sector se normaliza a mayúsculas');
  ok(notes.some((n) => /limit acotado de 500 a 25/.test(n)), 'y CADA ajuste se anota para decírselo al modelo', JSON.stringify(notes));

  const malo = clampArgs('screener', { sector: 'SOXX' });
  ok(malo.args.sector === undefined, 'un ETF que NO es sector GICS se ignora');
  ok(/no es uno de los 11 ETFs GICS/.test(malo.notes.join(' ')), 'diciendo cuáles sí valen', malo.notes.join(' '));

  const ambos = clampArgs('noticias', { ticker: 'nvda', tema: 'merger' });
  ok(ambos.args.ticker === 'NVDA' && ambos.args.tema === undefined, 'ticker y tema son excluyentes: gana ticker');
  ok(clampArgs('noticias', {}).args.days === 2, 'los defaults se aplican');
  ok(clampArgs('screener', null).args.limit === 25, 'argumentos nulos no rompen');
  ok(clampArgs('screener', { min_rvol: 'mucho' }).args.min_rvol === undefined, 'un número que no es número se ignora');
}

console.log('\n── la caché es por CONTENIDO de los argumentos, no por agente ──');
{
  ok(cacheKey('screener', { a: 1, b: 2 }) === cacheKey('screener', { b: 2, a: 1 }),
    'el orden de las claves no cambia la entrada: dos agentes que piden lo mismo pagan una vez');
  ok(cacheKey('screener', { a: 1 }) !== cacheKey('screener', { a: 2 }), 'y argumentos distintos son entradas distintas');
  ok(cacheKey('screener', { a: 1 }) !== cacheKey('ficha', { a: 1 }), 'la herramienta forma parte de la clave');
}

// ── 2) TRUNCAMIENTO DECLARADO ────────────────────────────────────────
console.log('\n── el truncamiento viaja DENTRO del resultado ──');
{
  const rows = Array.from({ length: 200 }, (_, i) => `FILA${i} ` + 'x'.repeat(60));
  const t = truncateRows(rows, { cap: 400, header: 'CABECERA' });
  ok(t.truncated === true, 'se truncó');
  ok(/TRUNCADO por presupuesto de tokens/.test(t.text), 'y el texto lo DICE', t.text.slice(-120));
  ok(/no es que no existan, es que no cupieron/.test(t.text),
    'distinguiendo "no hay" de "no cupo" — es la confusión que hace que el modelo afirme que no existe nada');
  ok(/\(\d+ filas más/.test(t.text), 'con CUÁNTAS faltan', (t.text.match(/\(\d+ filas más/) || [])[0]);
  ok(t.text.startsWith('CABECERA'), 'la cabecera sobrevive');

  const corto = truncateRows(['a', 'b'], { cap: 1000 });
  ok(corto.truncated === false && !/TRUNCADO/.test(corto.text), 'lo que cabe no se marca truncado');
}

// ── 1) EL TOPE ───────────────────────────────────────────────────────
console.log('\n── 1) el tope es del HARNESS: la llamada 9 no se ejecuta ──');
{
  const ex = mkExec({ budget: 3 });
  const r1 = await ex.call('screener', { limit: 5 });
  ok(!r1.budget_exhausted && ex.used === 1, 'la primera corre');
  await ex.call('screener', { min_rvol: 1 });
  await ex.call('screener', { min_rvol: 2 });
  ok(ex.remaining === 0, 'presupuesto agotado tras 3', String(ex.remaining));

  const r4 = await ex.call('screener', { limit: 5 });
  ok(r4.budget_exhausted === true, 'la cuarta NO se ejecuta');
  ok(/PRESUPUESTO DE HERRAMIENTAS AGOTADO/.test(r4.text),
    'y el modelo RECIBE un resultado que se lo dice — no un silencio ni un error críptico', r4.text.slice(0, 70));
  ok(/Decidí con lo que ya tenés/.test(r4.text), 'con la instrucción de qué hacer ahora');
  ok(ex.sequence[3].refused === 'budget_exhausted',
    'el intento rechazado se journalea igual: es parte de CÓMO investigó', ex.sequence[3].refused);
  ok(TOOL_BUDGET.fixed_round === 8 && TOOL_BUDGET.triggered === 3,
    'los dos presupuestos declarados: 8 en ronda fija, 3 por disparador');
}

console.log('\n── una herramienta que no existe tampoco tumba la corrida ──');
{
  const ex = mkExec();
  const r = await ex.call('inventada', {});
  ok(r.unknown_tool === true && /No existe una herramienta/.test(r.text), 'se responde, no se lanza');
  ok(/screener, noticias, ficha, sector/.test(r.text), 'diciendo cuáles sí existen', r.text);
}

console.log('\n── una herramienta que revienta devuelve un resultado legible ──');
{
  const ex = createToolExecutor({
    board, creds: {}, now: HOY, cache: false,
    deps: { sectorOf, getNews: async () => { throw new Error('HTTP 500'); } },
  });
  const r = await ex.call('noticias', { ticker: 'NVDA' });
  ok(/No se pudieron traer noticias/.test(r.text) && /500/.test(r.text), 'el error viaja como resultado', r.text.slice(0, 80));
  ok(/no significa que no haya noticias/.test(r.text),
    'aclarando que es una falla nuestra y no una ausencia de noticias — el modelo no puede distinguirlas solo');
}

console.log('\n── el screener filtra de verdad ──');
{
  const ex = mkExec();
  const alto = await ex.call('screener', { min_rvol: 4, limit: 25 });
  ok(/^\d+ nombre/.test(alto.text) && alto.rows > 0 && alto.rows <= 11, 'filtra por RVOL', alto.text.split('\n')[0]);
  const sector = await ex.call('screener', { sector: 'XLK' });
  ok(sector.rows === 2, 'filtra por sector (G00 y G01 son XLK)', String(sector.rows));
  const maximos = await ex.call('screener', { near_52w_high: true });
  ok(maximos.rows === 6, 'filtra por cercanía al máximo de 52 semanas', String(maximos.rows));
  const noticia = await ex.call('screener', { has_news: true });
  ok(noticia.rows === 1, 'filtra por "tiene noticia hoy"', String(noticia.rows));
  const nada = await ex.call('screener', { min_rvol: 99 });
  ok(nada.rows === 0 && /Ningún nombre del universo cumple/.test(nada.text), 'cero resultados es una respuesta, no un error');
  ok(/no sobre el universo entero/.test(nada.text),
    'y dice sobre QUÉ filtró — que el screener mire el tablero y no los 600 es un límite que el PM tiene que saber');
}

console.log('\n── sin tablero, el screener lo dice en vez de decir "no hay nada" ──');
{
  const ex = createToolExecutor({ board: null, creds: {}, now: HOY, cache: false, deps: { sectorOf } });
  const r = await ex.call('screener', {});
  ok(/No es que no haya nombres que cumplan — es que no hay datos/.test(r.text),
    'distingue "ninguno cumple" de "no hay datos"', r.text);
}

// ── 3) LAS DOS FORMAS DE TURNO ───────────────────────────────────────
console.log('\n── 3) el turno de respuesta difiere por proveedor, y es exacto ──');
{
  const thinking = { type: 'thinking', thinking: 'pensando...' };
  const data = {
    content: [thinking, { type: 'text', text: 'voy a mirar' },
      { type: 'tool_use', id: 'tu_1', name: 'screener', input: { min_rvol: 3 } },
      { type: 'tool_use', id: 'tu_2', name: 'ficha', input: { ticker: 'NVDA' } }],
    _raw_message: { role: 'assistant', content: 'voy a mirar', tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'screener', arguments: '{}' } }] },
  };
  const resultados = [{ id: 'tu_1', name: 'screener', text: 'RES1' }, { id: 'tu_2', name: 'ficha', text: 'RES2' }];

  const ant = buildToolTurn('anthropic', data, resultados);
  ok(ant.length === 2, 'anthropic: DOS mensajes (eco + un user con todo)', String(ant.length));
  ok(ant[0].content === data.content,
    'y el eco es el array VERBATIM — reconstruirlo como texto plano rompe el chequeo de thinking de Fable 5.1');
  ok(ant[0].content.includes(thinking), 'con los bloques de thinking en su orden original');
  ok(ant[1].role === 'user' && ant[1].content.length === 2 && ant[1].content.every((c) => c.type === 'tool_result'),
    'UN mensaje user con los DOS tool_result adentro', JSON.stringify(ant[1].content.map((c) => c.tool_use_id)));

  const oai = buildToolTurn('openrouter', data, resultados);
  ok(oai.length === 3, 'openai: TRES mensajes (el asistente + UNO `tool` POR CADA llamada)', String(oai.length));
  ok(oai[0] === data._raw_message, 'el asistente va CRUDO: OpenAI exige el mismo objeto tool_calls que mandó');
  ok(oai[1].role === 'tool' && oai[1].tool_call_id === 'tu_1' && oai[2].tool_call_id === 'tu_2',
    'un mensaje `tool` por llamada — agruparlos como Anthropic da 400',
    JSON.stringify(oai.slice(1).map((m) => m.tool_call_id)));
  ok(oai[1].content === 'RES1' && oai[2].content === 'RES2', 'cada uno con SU resultado');

  // Sin `_raw_message` (p. ej. un proveedor que no lo devolvió) se reconstruye.
  const sinRaw = buildToolTurn('openrouter', { content: data.content }, resultados);
  ok(sinRaw[0].tool_calls.length === 2 && sinRaw[0].tool_calls[0].function.arguments === '{"min_rvol":3}',
    'sin el mensaje crudo se reconstruye, con los argumentos re-serializados a STRING (como los quiere OpenAI)',
    sinRaw[0].tool_calls[0].function.arguments);
}

console.log('\n── los schemas se traducen, la definición es UNA ──');
{
  const a = toolsForProvider('anthropic');
  const o = toolsForProvider('openrouter');
  ok(a.length === TOOL_DEFS.length && o.length === TOOL_DEFS.length, 'las cuatro herramientas en los dos dialectos');
  ok(a[0].input_schema && a[0].name === 'screener', 'anthropic: {name, description, input_schema}');
  ok(o[0].type === 'function' && o[0].function.parameters, 'openai: {type:function, function:{parameters}}');
  ok(JSON.stringify(a[0].input_schema) === JSON.stringify(o[0].function.parameters),
    'y el schema JSON de adentro es el MISMO: duplicarlo por proveedor es cómo se corren dos experimentos sin darse cuenta');
  const ficha = a.find((t) => t.name === 'ficha');
  ok(ficha.input_schema.required.includes('ticker'), 'los campos obligatorios viajan');
  ok(toolsForProvider('anthropic', ['ficha']).length === 1, 'se puede recortar el set (corrida por disparador)');
}

// ── EL LOOP ──────────────────────────────────────────────────────────
console.log('\n── el loop: pide, ejecuta, y vuelve con el JSON ──');
{
  const agent = { id: 'x', provider: 'anthropic', model: 'm', caps: {} };
  let vuelta = 0;
  const call = async ({ messages, tools }) => {
    vuelta++;
    if (vuelta === 1) {
      return { status: 200, data: { content: [{ type: 'tool_use', id: 't1', name: 'screener', input: { min_rvol: 3 } }] } };
    }
    return { status: 200, data: { content: [{ type: 'text', text: '{"plan":"listo"}' }] }, _tools: !!tools, _msgs: messages.length };
  };
  const ex = mkExec();
  const r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call });
  ok(r.stopped_by === 'end_turn', 'termina cuando el modelo deja de pedir', r.stopped_by);
  ok(r.turns === 2, 'dos vueltas', String(r.turns));
  ok(ex.used === 1, 'y una llamada de presupuesto consumida', String(ex.used));
  ok(r.messages.length === 3, 'la conversación creció con el eco y el resultado', String(r.messages.length));
  ok(/listo/.test(r.llm.data.content[0].text), 'devuelve el ÚLTIMO turno, el que trae el JSON');
}

console.log('\n── un modelo que NO pide herramientas sale en la primera ──');
{
  const agent = { id: 'x', provider: 'anthropic', model: 'm', caps: {} };
  const call = async () => ({ status: 200, data: { content: [{ type: 'text', text: '{"plan":"sin investigar"}' }] } });
  const r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: mkExec(), call });
  ok(r.stopped_by === 'no_tools' && r.turns === 1, 'una sola vuelta, y se distingue de "terminó tras investigar"', r.stopped_by);
}

console.log('\n── un modelo en BUCLE se corta, con una vuelta final para cerrar ──');
{
  const agent = { id: 'x', provider: 'anthropic', model: 'm', caps: {} };
  let conHerramientas = 0;
  let sinHerramientas = 0;
  const call = async ({ tools }) => {
    if (tools) { conHerramientas++; return { status: 200, data: { content: [{ type: 'tool_use', id: 't' + conHerramientas, name: 'screener', input: {} }] } }; }
    sinHerramientas++;
    return { status: 200, data: { content: [{ type: 'text', text: '{"plan":"forzado"}' }] } };
  };
  const ex = mkExec({ budget: 2 });
  const r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: ex, call, maxTurns: 4 });
  ok(r.stopped_by === 'max_turns', 'se corta por vueltas', r.stopped_by);
  ok(sinHerramientas === 1, 'y hay UNA vuelta final SIN herramientas para que pueda cerrar', String(sinHerramientas));
  ok(/forzado/.test(r.llm.data.content[0].text),
    'que devuelve el JSON — sin esa vuelta, un modelo en bucle daría una corrida abortada teniendo todo lo que necesitaba');
  ok(/Se acabó el presupuesto de investigación/.test(r.messages[r.messages.length - 1].content), 'y se le dice por qué');
  ok(ex.used === 4 && ex.sequence.filter((s) => s.refused).length === 2,
    'las llamadas de más allá del presupuesto quedan journaleadas como rechazadas', String(ex.sequence.filter((s) => s.refused).length));
}

console.log('\n── un error del proveedor NO se traga ──');
{
  const agent = { id: 'x', provider: 'anthropic', model: 'm', caps: {} };
  const call = async () => ({ status: 429, data: null, error_detail: 'rate limited' });
  const r = await runToolLoop({ agent, system: 'S', messages: [{ role: 'user', content: 'U' }], executor: mkExec(), call });
  ok(r.stopped_by === 'error' && r.llm.status === 429,
    'sale entero hacia arriba: el caller ya sabe journalear un aborted_llm_error y tragarlo acá lo dejaría ciego', r.stopped_by);
}

console.log('\n── la secuencia journaleada ──');
{
  const ex = mkExec();
  await ex.call('screener', { min_rvol: 3, limit: 500 });
  const s = ex.sequence[0];
  ok(s.result && s.result.length > 0,
    'el resultado COMPLETO se guarda: sin él, un replay no puede reproducir la corrida — el modelo decidió mirando algo que no guardamos');
  ok(s.tokens_est > 0 && s.ms >= 0 && s.args.limit === 25, 'con tokens, latencia y los argumentos YA acotados');
  const pub = ex.summary();
  ok(pub[0].result === undefined,
    'y lo que se publica en /liga es la SECUENCIA sin los volcados: "buscó semis con RVOL alto → pidió la ficha de AMD" es una historia; 8 volcados no lo son');
  ok(pub[0].tool === 'screener' && pub[0].args.limit === 25, 'pero sí qué pidió y con qué argumentos');
}

console.log('\n── constantes declaradas ──');
ok(RESULT_TOKEN_CAP === 1500, 'cada resultado se corta a ~1.5K tokens', String(RESULT_TOKEN_CAP));
ok(MAX_TURNS === 10, 'y el loop tiene un tope de vueltas propio, distinto del de llamadas', String(MAX_TURNS));

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
