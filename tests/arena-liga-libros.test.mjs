// ═══════════════════════════════════════════════════════════════
// tests/arena-liga-libros.test.mjs — B11: /api/liga/libros.
//
// Lo que se blinda:
//
//   1. LA FUENTE NUNCA SE INFIERE. Cada libro dice si vino de la liga VIVA o de
//      la SOMBRA. Confundir una decisión de sombra con una real es exactamente
//      el error que las tablas separadas existen para impedir — publicarlas
//      juntas sin etiqueta sería re-crear el problema en la capa de arriba.
//   2. EL CONTROL VA MARCADO. Es el piso de ruido: leer su resultado como el de
//      un competidor más invalida la única referencia que hace significativo
//      cualquier delta entre modelos.
//   3. LA ETIQUETA DE MODELO, no el slug. El slug cambia con un override de env
//      var; publicarlo haría que la tabla dijera cosas distintas según qué env
//      vars estuvieran puestas ese día.
//   4. LA SECUENCIA ES UNA HISTORIA, no ocho volcados: viaja el resumen, nunca
//      el resultado completo.
//   5. SOLO LECTURA, como /eventos y /audit.
//
// Correr con `node tests/arena-liga-libros.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { identidad, secuenciaPublicable, libroDeFila, ejecucionPublicable, resumenPorDia, selloDe, SELLOS,
  resumenDeHerramientas, deslizamientoPorAgente } from '../api/liga-libros.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 2) y 3) LA IDENTIDAD ─────────────────────────────────────────────
console.log('\n── el control va MARCADO, y el modelo va con su etiqueta ──');
{
  const c = identidad('control');
  ok(c.control === true, 'el control se marca');
  ok(/piso de ruido/.test(c.control_nota || ''),
    'y se explica QUÉ significa: su resultado no es el de un competidor, es cuánto varía el mismo modelo consigo mismo', c.control_nota);

  const cl = identidad('claude');
  ok(cl.control === false, 'claude no es control');
  ok(cl.modelo && !/^claude-/.test(cl.modelo),
    'el modelo sale como ETIQUETA legible, no como slug de API — el slug cambia con un override de env var', cl.modelo);
  ok(cl.nombre === 'Claude', 'con su nombre de liga', cl.nombre);

  ok(identidad('control').modelo === identidad('claude').modelo,
    'claude y control comparten modelo: es lo que los hace comparables');

  const raro = identidad('no-existe');
  ok(raro.id === 'no-existe' && raro.control === false,
    'un agente desconocido no revienta ni se marca como control por accidente');
}

// ── 4) LA SECUENCIA ──────────────────────────────────────────────────
console.log('\n── la secuencia es una historia, no ocho volcados ──');
{
  const ctx = {
    tools: {
      budget: 8, used: 3, turns: 3, stopped_by: 'end_turn',
      summary: [
        { n: 1, tool: 'screener', args: { sector: 'XLK', min_rvol: 3 }, rows: 12, truncated: false, ms: 40 },
        { n: 2, tool: 'noticias', args: { ticker: 'NVDA' }, rows: 5, truncated: false, ms: 320 },
        { n: 3, tool: 'ficha', args: { ticker: 'AMD' }, rows: 9, truncated: true, ms: 800 },
      ],
      // El resultado COMPLETO existe en el journal para el replay…
      sequence: [{ n: 1, tool: 'screener', result: 'X'.repeat(5000) }],
    },
  };
  const s = secuenciaPublicable(ctx);
  ok(s.usó_herramientas === true && s.pasos.length === 3, 'los tres pasos', String(s.pasos.length));
  ok(s.pasos[0].herramienta === 'screener' && s.pasos[1].herramienta === 'noticias' && s.pasos[2].herramienta === 'ficha',
    '"buscó semis → leyó noticias de NVDA → pidió la ficha de AMD" — eso es una historia');
  ok(s.pasos[2].truncado === true, 'y se ve cuál resultado vino truncado');
  ok(JSON.stringify(s).length < 600,
    '…pero el RESULTADO COMPLETO no viaja: mover megabytes por un feed público que no los usa sería pagarlos en cada carga',
    String(JSON.stringify(s).length));
  ok(!/XXXX/.test(JSON.stringify(s)), 'literalmente: el volcado no está en la respuesta');

  const sin = secuenciaPublicable({ tools: { enabled: false, reason: 'ARENA_TOOLS=0' } });
  ok(sin.usó_herramientas === false && sin.motivo === 'ARENA_TOOLS=0', 'y cuando no hubo herramientas, se dice por qué');
  ok(secuenciaPublicable({}) === null, 'sin bloque de herramientas, null');
}

// ── 1) LA FUENTE ─────────────────────────────────────────────────────
console.log('\n── 1) la fuente NUNCA se infiere ──');
{
  const fila = {
    run_date: '2026-09-17', created_at: '2026-09-17T14:05:00Z', agent_id: 'claude',
    status: 'ok_target', plan: 'Roto hacia semis.',
    target: { weights: { NVDA: 0.12, ZM: -0.08 }, cash: 0.8, theses: { NVDA: 'la demanda sigue' } },
    rebalance: { legs: [1, 2], turnover: 0.2, rail_trims: [], cancel: [1] },
    context: { lens: 'momentum', tools: { budget: 8, used: 2, summary: [{ n: 1, tool: 'screener', args: {}, rows: 3 }] } },
  };
  const sombra = libroDeFila(fila, 'prueba');
  ok(sombra.fuente === 'prueba', 'una fila de sombra viaja etiquetada como sombra');
  const viva = libroDeFila(fila, 'en_vivo');
  ok(viva.fuente === 'en_vivo', 'y una de la liga viva, como viva');

  ok(sombra.portafolio.pesos.ZM === -0.08, 'el portafolio objetivo, con el signo del corto', String(sombra.portafolio.pesos.ZM));
  ok(sombra.portafolio.tesis.NVDA === 'la demanda sigue', 'y la tesis por posición');
  ok(sombra.rebalanceo.ordenes === 2 && sombra.rebalanceo.turnover === 0.2, 'qué habría hecho el motor', JSON.stringify(sombra.rebalanceo));

  ok(sombra.enfoque === 'momentum', 'el enfoque del día');
  ok(/confound DELIBERADO/.test(sombra.enfoque_nota || ''),
    'publicada CON su advertencia: dos agentes con enfoques distintos el mismo día no son comparables ese día');

  // Una corrida del contrato VIEJO no tiene portafolio, y eso también informa.
  const vieja = libroDeFila({ ...fila, target: null, rebalance: null }, 'en_vivo');
  ok(vieja.portafolio === null && vieja.rebalanceo === null,
    'una corrida del contrato viejo sale con portafolio null — eso dice QUÉ contrato corrió ese día, no es un hueco');
}

// ── 5) SOLO LECTURA ──────────────────────────────────────────────────
console.log('\n── solo lectura, como /eventos y /audit ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/ensureSchema/.test(codigo), 'no llama ensureSchema (hace CREATE/ALTER)');
  ok(!/\bbeat\(/.test(codigo), 'no late: latir acá enmascararía un cron muerto');
  ok(!/insert into|update |delete from|create table|alter table/i.test(codigo), 'cero escrituras');
  ok(!/arena-run|arena-guard|arena-exits/.test(codigo), 'no importa nada del camino de decisión');
  ok(!/prompt/.test(codigo.toLowerCase()) || !/context->'(dive|scan)'/.test(codigo),
    'no proyecta los prompts completos: son material para reconstruir la corrida, no material de show');
}

console.log('\n── la tabla de sombra puede no existir todavía ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(/nunca se corrió el contrato nuevo en paralelo, o la tabla no existe/.test(src),
    'y eso NO es un error del endpoint: es un estado, y se dice como tal');
}

// ═══════════════════════════════════════════════════════════════
// EL OBJETIVO VIVO NO VIVE DONDE VIVE EL DE SOMBRA.
//
// `arena_shadow_journal` tiene columnas `target` y `rebalance`. `arena_journal`
// —la tabla del contrato VIEJO, que journaleaba órdenes— no las tiene: el
// contrato objetivo las mete DENTRO de `context`. La proyección de la liga viva
// no las sacaba, así que TODA corrida viva salía con `portafolio: null` y la
// página habría dibujado siete tarjetas vacías el día del encendido, sin que
// nada fallara a la vista. La sombra se veía bien porque allá sí son columnas.
// ═══════════════════════════════════════════════════════════════
console.log('\n── la liga VIVA guarda el objetivo dentro de context ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  // ── LA VENTANA, ACTUALIZADA EL 2026-09-26 ────────────────────────
  // Eran 1400 caracteres hacia atrás desde `from arena_journal`. Se rompió al
  // sumar la proyección de `llm_error` (el motivo de los abortos, que no
  // llegaba a la ficha): la consulta creció y el `select` quedó afuera de la
  // ventana, así que las cuatro aserciones fallaban aunque todo estuviera.
  //
  // Un número de caracteres no es un límite: es una apuesta a que la consulta
  // no crezca. Ahora la ventana va desde el `select` REAL hasta su `from`.
  const finViva = src.indexOf('from arena_journal');
  const viva = src.slice(src.lastIndexOf('`select', finViva), finViva);
  ok(/context->'target' as target/.test(viva),
    'la consulta de la liga viva proyecta el objetivo desde context: sin esto, toda corrida viva sale con portafolio null');
  ok(/context->'rebalance' as rebalance/.test(viva), 'y el rebalanceo');
  ok(/'ejecucion', context->'ejecucion'/.test(viva),
    'y la ejecución: es donde viven las órdenes que la corrida calculó o mandó');
  ok(/'rails', context->'rails'/.test(viva),
    'y los rieles: `rejected_rails` dice QUE se rechazó, `rails` dice cuál y por qué');
}

// ── LAS ÓRDENES: SIN ENVIAR Y EN VIVO NO SE CONFUNDEN ────────────────
// Una corrida SIN ENVIAR y una que movió dinero se journalean en la MISMA tabla. Que
// la página no pueda distinguirlas sería el mismo error que las tablas
// separadas existen para impedir del lado de la sombra.
console.log('\n── las órdenes, y el modo que las hace legibles ──');
{
  const simulacion = ejecucionPublicable({
    modo: 'dry',
    candado: { ok: true },
    ordenes_calculadas: [
      { symbol: 'NVDA', side: 'buy', qty: 12, limit_price: 181.5, referencia: 180.6,
        notional_real: 2178, delta_weight: 0.043, intencion: 'buy', closes_position: false },
    ],
    enviadas: [],
    descartadas: [{ symbol: 'ZM', side: 'short', motivo: 'la T2 es long-only' }],
    nota: 'ARENA_CONTRATO=objetivo_dry: las órdenes se calcularon y se journalearon COMPLETAS, y no se mandó ninguna.',
  });
  // El VALOR journaleado sigue siendo `dry` —es el dato— y la ETIQUETA que se
  // lee es "SIN ENVIAR", que es lo que de verdad la distingue: no es otro
  // camino, es el mismo camino sin que salga una orden.
  ok(simulacion.modo === 'dry' && /^SIN ENVIAR:/.test(simulacion.modo_nota) && /NO se mandó ninguna/.test(simulacion.modo_nota),
    'una corrida sin envío se publica como tal, con lo que eso significa dicho', simulacion.modo_nota);
  ok(simulacion.ordenes.length === 1 && simulacion.ordenes[0].ticker === 'NVDA' && simulacion.ordenes[0].cantidad === 12,
    'las órdenes CALCULADAS viajan igual: ese es el punto del escalón — ver las órdenes antes de mandarlas');
  ok(simulacion.ordenes[0].resultado === null,
    'y sin resultado, porque no se mandó: un "enviada" en simulación sería la peor mentira posible de esta página');
  ok(simulacion.ordenes[0].delta_pp === 4.3, 'el delta en puntos porcentuales, que es como se lee', String(simulacion.ordenes[0].delta_pp));
  ok(simulacion.descartadas[0].motivo === 'la T2 es long-only', 'y lo descartado con su motivo');

  const vivo = ejecucionPublicable({
    modo: 'enviado', candado: { ok: true },
    ordenes_calculadas: [{ symbol: 'NVDA', side: 'buy', qty: 12, limit_price: 181.5, client_order_id: 'arena:x:NVDA:f' }],
    enviadas: [{ symbol: 'NVDA', client_order_id: 'arena:x:NVDA:f', result: 'approved', order_status: 'accepted' }],
  });
  ok(vivo.ordenes[0].resultado === 'approved' && vivo.ordenes[0].estado_alpaca === 'accepted',
    'y en vivo el resultado se pega sobre la orden calculada, por client_order_id');

  const frenado = ejecucionPublicable({
    modo: 'enviado', candado: { ok: false, error: 'la orden de EOG no corresponde a ningún peso' },
    ordenes_calculadas: [{ symbol: 'EOG', side: 'buy', qty: 3, limit_price: 120 }],
    enviadas: [], freno: 'la orden de EOG no corresponde a ningún peso',
  });
  ok(frenado.candado_ok === false && /no corresponde a ningún peso/.test(frenado.freno),
    'y cuando el candado frenó la corrida entera, se ve QUÉ lo frenó — no una lista de órdenes sin explicación');

  ok(ejecucionPublicable(null) === null, 'sin ejecución journaleada, null (una corrida de sombra no manda nunca)');
}

// ── EL DÍA, NO LA VENTANA ────────────────────────────────────────────
console.log('\n── la coincidencia y el piso son hechos de UN día y de UNA fuente ──');
{
  const libro = (agente, fuente, fecha, pesos, enfoque, pos) => libroDeFila({
    created_at: fecha, agent_id: agente, status: 'ok_target', plan: 'x',
    target: { weights: pesos, cash: 0.1, theses: {} },
    context: { lens: enfoque, posiciones_iniciales: pos },
  }, fuente);

  // Ordenados de más nuevo a más viejo, como los entrega el handler.
  const libros = [
    libro('claude', 'prueba', '2026-09-17T20:00:00Z', { NVDA: 0.2, AMD: 0.1 }, 'momentum', []),
    libro('control', 'prueba', '2026-09-17T20:00:00Z', { NVDA: 0.2, AMD: 0.1 }, 'momentum', []),
    // La corrida VIEJA del mismo agente y del mismo día: NO debe ganarle a la última.
    libro('claude', 'prueba', '2026-09-17T14:00:00Z', { TSLA: 0.9 }, 'momentum', []),
    libro('claude', 'en_vivo', '2026-09-16T20:00:00Z', { NVDA: 0.2 }, 'valor', []),
  ];
  const dias = resumenPorDia(libros);

  ok(dias.length === 2, 'un bloque por día Y por fuente', String(dias.length));
  const d17 = dias.find((d) => d.dia === '2026-09-17');
  ok(d17.fuente === 'prueba' && d17.corridas === 2,
    'del 17 sale la corrida de sombra con sus dos agentes — no tres: de cada agente cuenta su ÚLTIMA corrida del día',
    JSON.stringify({ f: d17.fuente, n: d17.corridas }));
  ok(d17.coincidencia.mean === 1,
    'dos libros idénticos solapan 1', String(d17.coincidencia.mean));
  ok(/ALTO/.test(d17.coincidencia.lectura),
    'y el número viaja con su lectura: un coseno alto entre modelos distintos NO es "la liga funciona"');
  ok(d17.piso_de_ruido.comparable === true && d17.piso_de_ruido.cosine === 1,
    'con mismo enfoque y mismo libro de arranque, claude↔control SÍ es piso de ruido');

  const d16 = dias.find((d) => d.dia === '2026-09-16');
  ok(d16.fuente === 'en_vivo' && d16.coincidencia.mean === null,
    'un solo libro no solapa con nada, y se dice en vez de publicar un número', JSON.stringify(d16.coincidencia.mean));
  ok(d16.piso_de_ruido.comparable === false,
    'y sin control ese día, no hay piso — no un piso de 0');

  // Enfoques distintas: el par mide el enfoque, no el ruido.
  const enfoques = resumenPorDia([
    libro('claude', 'prueba', '2026-09-18T20:00:00Z', { NVDA: 0.2 }, 'momentum', []),
    libro('control', 'prueba', '2026-09-18T20:00:00Z', { NVDA: 0.2 }, 'catalizador', []),
  ])[0];
  ok(enfoques.piso_de_ruido.comparable === false && /mide el enfoque/.test(enfoques.piso_de_ruido.motivo),
    'con enfoques distintos el par NO se publica como piso: mide el enfoque', enfoques.piso_de_ruido.motivo);
  ok(enfoques.piso_de_ruido.cosine_observado === 1 && enfoques.piso_de_ruido.cosine === undefined,
    'y el número observado no se esconde: viaja con otro nombre');

  // La sombra y la viva del mismo día NO se mezclan en el mismo coseno.
  const mezcla = resumenPorDia([
    libro('claude', 'en_vivo', '2026-09-19T20:00:00Z', { NVDA: 0.2 }, 'momentum', []),
    libro('control', 'prueba', '2026-09-19T20:00:00Z', { NVDA: 0.2 }, 'momentum', []),
  ]);
  ok(mezcla.length === 2 && mezcla.every((d) => d.coincidencia.mean === null),
    'una corrida viva y una de sombra del mismo día no son el mismo experimento: no entran al mismo coseno');
}

// ── LA COINCIDENCIA SE CALCULA SOBRE LOS QUE TERMINARON ──────────────
// El número no estaba mal: estaba mal ROTULADO. "Entre 4 libros" se lee como un
// hecho del día y es un hecho de un SUBCONJUNTO que cambia solo — el día que
// tres agentes abortan, el denominador se mueve sin que nada lo diga y la serie
// deja de ser comparable consigo misma.
console.log('\n── quién entró, quién quedó fuera y por qué ──');
{
  const conLibro = (agente, pesos) => libroDeFila({
    created_at: '2026-09-21T20:00:00Z', agent_id: agente, status: 'ok_target', plan: 'x',
    target: { weights: pesos, cash: 0.1, theses: {} },
    context: { lens: 'momentum', posiciones_iniciales: [] },
  }, 'en_vivo');
  const abortado = (agente, status, error) => libroDeFila({
    created_at: '2026-09-21T20:00:00Z', agent_id: agente, status, plan: null, error,
    target: null, context: { lens: 'momentum', posiciones_iniciales: [] },
  }, 'en_vivo');

  // Siete agentes entraron; tres abortaron su última corrida. El coseno de hoy
  // sale de CUATRO libros, y eso es lo que la etiqueta tiene que decir.
  const d = resumenPorDia([
    conLibro('claude', { NVDA: 0.2, MSFT: 0.1 }),
    conLibro('control', { NVDA: 0.2, MSFT: 0.1 }),
    conLibro('openai', { AAPL: 0.15 }),
    conLibro('gemini', { NVDA: 0.25 }),
    abortado('grok', 'aborted_cuerpo_vacio', 'cuerpo_vacio: el proveedor cerró el stream'),
    abortado('deepseek', 'aborted_llm_error', 'HTTP 502'),
    abortado('qwen', 'aborted_malformed_target', 'pesos ausente'),
  ])[0];

  ok(d.coincidencia.libros === 4, 'el coseno se calcula sobre los CUATRO que terminaron', String(d.coincidencia.libros));
  ok(d.coincidencia.agentes_en_la_corrida === 7,
    'pero la etiqueta dice que entraron SIETE: sin el denominador, "entre 4 libros" parece del día y es de un subconjunto',
    String(d.coincidencia.agentes_en_la_corrida));
  ok(d.coincidencia.fuera === 3 && d.coincidencia.abortados === 3,
    'tres quedaron fuera, los tres por aborto', JSON.stringify({ f: d.coincidencia.fuera, a: d.coincidencia.abortados }));
  ok(/entre 4 de 7 libros/.test(d.coincidencia.etiqueta),
    'la frase se arma UNA vez en el servidor, para que la página y la auditoría no digan cosas distintas', d.coincidencia.etiqueta);
  ok(d.coincidencia.detalle_fuera.every((f) => f.agente && f.estado),
    'y cada ausente viaja con su motivo: un aborto es un resultado del experimento, no una fila que falta',
    JSON.stringify(d.coincidencia.detalle_fuera));
  ok(d.censo.agentes_en_la_corrida === 7 && d.censo.con_libro === 4,
    'el censo también cuelga del día: un consumidor del resumen no debería entrar a la métrica para saber cuántos hubo');

  // Un rechazo por rieles NO es un aborto, y contarlos juntos mandaría a buscar
  // el problema al proveedor cuando está en el libro que pidió el modelo.
  const conRiel = resumenPorDia([
    conLibro('claude', { NVDA: 0.2 }),
    conLibro('control', { NVDA: 0.2 }),
    abortado('grok', 'rejected_rails', 'R6 sector 61%'),
  ])[0];
  ok(conRiel.censo.fuera === 1 && conRiel.censo.abortados === 0,
    'un rechazo por rieles cuenta como FUERA pero no como ABORTO: llevan a arreglar cosas distintas',
    JSON.stringify({ f: conRiel.censo.fuera, a: conRiel.censo.abortados }));

  // Con todos adentro, la etiqueta lo dice en vez de callarse.
  const completo = resumenPorDia([
    conLibro('claude', { NVDA: 0.2 }),
    conLibro('control', { MSFT: 0.2 }),
  ])[0];
  ok(completo.censo.fuera === 0 && /ningún agente quedó fuera/.test(completo.coincidencia.etiqueta),
    'y cuando no falta nadie, se dice — el silencio se leería igual que el dato ausente', completo.coincidencia.etiqueta);
}

// ── EL CONTEO DE HERRAMIENTAS, QUE ES UNA DECISIÓN DE PRODUCTO ───────
// El tablero es una MUESTRA del universo; el universo completo está a una
// llamada de `screener`. Meterlo entero en el tablero cuesta ~4,000 tokens por
// agente y por corrida. Antes de pagarlos hay que saber si el acceso es el
// problema: si casi no llaman al screener, no les falta acceso — les falta
// saber que lo tienen, y eso cuesta una línea de prompt.
console.log('\n── cuántas veces llamó cada agente a cada herramienta ──');
{
  const conPasos = (agente, estado, herramientas) => ({
    fuente: 'en_vivo', fecha: '2026-09-23T20:00:00Z',
    agente: { id: agente, nombre: agente }, estado,
    investigacion: herramientas ? { usó_herramientas: herramientas.length > 0, pasos: herramientas.map((h, i) => ({ n: i + 1, herramienta: h })) } : null,
  });

  const r = resumenDeHerramientas([
    // claude investiga: screener dos veces en una corrida, y en otra ninguna.
    conPasos('claude', 'ok_target', ['screener', 'screener', 'ficha']),
    conPasos('claude', 'ok_target', ['noticias']),
    // deepseek nunca la llama.
    conPasos('deepseek', 'ok_target', ['ficha', 'noticias']),
    conPasos('deepseek', 'ok_target', []),
    // y una corrida suya que abortó: NO cuenta como "decidió no investigar".
    conPasos('deepseek', 'aborted_cuerpo_vacio', null),
  ]);

  const claude = r.por_agente.find((a) => a.agente === 'claude');
  const deepseek = r.por_agente.find((a) => a.agente === 'deepseek');

  ok(claude.screener_llamadas === 2, 'cuenta las LLAMADAS: claude la usó dos veces', String(claude.screener_llamadas));
  ok(claude.screener_corridas === 1, 'y las CORRIDAS en que la tocó: dos llamadas en una sola corrida no son dos corridas',
    String(claude.screener_corridas));
  ok(claude.screener_pct_corridas === 50, 'el porcentaje es sobre corridas, no sobre llamadas', String(claude.screener_pct_corridas));

  ok(deepseek.screener_llamadas === 0 && deepseek.screener_pct_corridas === 0,
    'deepseek no la llama nunca, y eso sale como 0% y no como un hueco');
  ok(deepseek.abortadas === 1 && deepseek.corridas_vivas === 2,
    'su corrida abortada NO entra al denominador: no llegó a investigar, no decidió no hacerlo',
    JSON.stringify({ abortadas: deepseek.abortadas, vivas: deepseek.corridas_vivas }));
  ok(deepseek.sin_uso === 1, 'y la corrida en que investigó CERO sí se cuenta aparte: ésa sí es una decisión');

  ok(r.liga.screener_pct_corridas === 25, 'la liga entera: 1 de 4 corridas vivas tocó el screener', String(r.liga.screener_pct_corridas));
  ok(/les falta saber que lo tienen/.test(r.liga.lectura),
    'y con uso bajo la lectura dice la conclusión: el problema no es el acceso', r.liga.lectura);
  ok(r.liga.por_herramienta.ficha === 2 && r.liga.por_herramienta.noticias === 2,
    'las otras tres herramientas también se cuentan: sin ellas no se sabe si investigan poco o investigan otra cosa',
    JSON.stringify(r.liga.por_herramienta));

  // Con uso alto, la lectura cambia de conclusión — no es un texto fijo.
  const alto = resumenDeHerramientas([
    conPasos('claude', 'ok_target', ['screener']),
    conPasos('control', 'ok_target', ['screener', 'ficha']),
  ]);
  ok(alto.liga.screener_pct_corridas === 100 && /NO es el cuello de botella/.test(alto.liga.lectura),
    'con uso alto dice lo contrario: el acceso no es lo que falta', alto.liga.lectura);

  ok(resumenDeHerramientas([]).liga.screener_pct_corridas === null,
    'sin corridas no se publica un 0% que se leería como "no la usan"');
}

// ── EL DESLIZAMIENTO POR AGENTE, CON SU PISO ─────────────────────────
console.log('\n── el deslizamiento se lee contra el par idéntico ──');
{
  const libro = (agente, fuente, ordenes) => ({
    fuente, fecha: '2026-09-23T20:00:00Z', agente: { id: agente, nombre: agente },
    estado: 'ok_target', ordenes: { ordenes },
  });
  const ord = (pp, monto) => ({ ticker: 'X', lado: 'buy', deslizamiento_pp: pp, cantidad_llena: 10,
    monto_usd: monto, precio_ejecucion: 100, limite: 101 });

  const d = deslizamientoPorAgente([
    libro('claude', 'en_vivo', [ord(0.10, 1000)]),
    libro('control', 'en_vivo', [ord(0.14, 1000)]),
    libro('qwen', 'en_vivo', [ord(0.40, 1000)]),
    // Una corrida de PRUEBA no manda órdenes: si entrara, diluiría el denominador.
    libro('qwen', 'prueba', [ord(9.99, 1000)]),
  ]);
  ok(d.por_agente.length === 3, 'las corridas de prueba no entran: no mandan órdenes', String(d.por_agente.length));
  ok(d.por_agente[0].agente === 'qwen', 'se ordena por el que más desliza, que es a quien hay que mirar');
  ok(d.piso_claude_control_pp === 0.04,
    'y trae el piso del par idéntico: claude↔control corren el MISMO modelo, así que lo que los separa acá es el mecanismo',
    String(d.piso_claude_control_pp));
  ok(/0.04 pp/.test(d.lectura) && /no es atribuible a nadie/.test(d.lectura),
    'la lectura dice que una diferencia menor que ese piso no se le puede cobrar a ningún modelo', d.lectura);
  ok(/Una semana de sesiones es el mínimo/.test(d.nota),
    'y avisa que con dos o tres fills la media no significa nada');

  const sinPar = deslizamientoPorAgente([libro('qwen', 'en_vivo', [ord(0.4, 1000)])]);
  ok(sinPar.piso_claude_control_pp === null && /Sin el par claude↔control/.test(sinPar.lectura),
    'sin el par completo no se inventa un piso, y se dice que sin él las brechas no se leen');
}

// ── EL PISO SE CALCULA, NO SE ARCHIVA ────────────────────────────────
console.log('\n── una sola implementación del piso, y acá no se archiva ──');
{
  const src = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok(/from '\.\/_lib\/arena-herding\.js'/.test(src),
    'el piso y la coincidencia salen de arena-herding: dos implementaciones del mismo número terminan difiriendo');
  // Sobre el CÓDIGO, no sobre los comentarios: el comentario sí nombra
  // `arena_noise_floor` para decir dónde vive el archivo histórico.
  const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/guardarPisoDeRuido|arena_noise_floor/.test(codigo),
    'y acá NO se archiva: archivar escribe, y este endpoint no escribe');
}

// ── LA PÁGINA NO DIBUJA CAMPOS QUE EL ENDPOINT NO MANDA ──────────────
// Una página que lee `l.ordenes` cuando el endpoint publica `l.execution` no
// falla: muestra un hueco. Este test cierra esa puerta.
console.log('\n── /liga/libros dibuja lo que el endpoint publica ──');
{
  const html = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  const libro = libroDeFila({
    created_at: '2026-09-17T20:00:00Z', agent_id: 'claude', status: 'ok_target', plan: 'p',
    target: { weights: { NVDA: 0.2 }, cash: 0.1, theses: { NVDA: 't' } },
    rebalance: { legs: [], turnover: 0.1, rail_trims: [], cancel: [] },
    context: {
      lens: 'momentum', posiciones_iniciales: [], contrato: 'objetivo_dry',
      rails: { ok: true, violations: [] },
      ejecucion: { modo: 'dry', candado: { ok: true }, ordenes_calculadas: [], descartadas: [] },
      tools: { budget: 20, used: 1, turns: 2, stopped_by: 'end_turn', summary: [{ n: 1, tool: 'screener', args: {}, rows: 3 }] },
    },
  }, 'en_vivo');
  const claves = new Set(Object.keys(libro));
  const leidos = new Set([...html.matchAll(/\bl\.([a-záéíóúñ_]+)/gi)].map((m) => m[1]));
  const faltantes = [...leidos].filter((k) => !claves.has(k));
  ok(faltantes.length === 0,
    'todos los campos que la página lee de un libro existen en la respuesta', faltantes.join(', '));

  ok(/api\/liga\/libros/.test(html), 'y pega contra /api/liga/libros');
  ok(/l\.sello/.test(html) && !/>seco</.test(html) && !/>simulación</.test(html),
    'la página PINTA el sello que manda el servidor: si lo armara ella, la tarjeta y la auditoría podrían decir cosas distintas del mismo estado');
  ok(/\.tag\.en_vivo\{/.test(html) && /\.tag\.prueba\{/.test(html) && /\.tag\.sin_enviar\{/.test(html),
    'con un estilo propio para cada uno de los tres sellos: EN VIVO, PRUEBA y EN VIVO · SIN ENVIAR no pueden verse iguales');
  ok(/SELLO_SIN_ENVIAR='EN VIVO · SIN ENVIAR'/.test(html),
    'y la página conoce el sello combinado para pintarlo distinto — verde por el camino, borde ámbar porque no salió una orden');
  ok(/no comparable hoy/.test(html),
    'y si el piso no es comparable ese día, la página NO lo dibuja como piso: dice qué mide ese número');
  ok(/width=device-width/.test(html) && /max-width:640px/.test(html), 'y se ve en celular');
}

// ═══════════════════════════════════════════════════════════════
// EL SELLO DICE DOS COSAS, NO UNA.
//
// Un libro tiene que contestar dos preguntas que no son la misma:
//   1. QUÉ CAMINO corrió — la liga de verdad, o el contrato nuevo en paralelo.
//   2. SI SALIÓ UNA ORDEN — porque una corrida en vivo con la bandera en seco
//      calculó las órdenes completas y no mandó ninguna, en la MISMA tabla y
//      por el MISMO camino que una que sí movió dinero.
//
// Antes eran dos chips sueltos y el segundo se leía como una aclaración del
// primero. Una etiqueta que dice las dos no se puede leer a medias.
// ═══════════════════════════════════════════════════════════════
console.log('\n── el sello dice el camino Y si salió una orden ──');
{
  ok(selloDe('prueba', null) === 'PRUEBA',
    'una corrida de prueba es PRUEBA — no movió dinero y no puede verse como una que sí');
  ok(selloDe('prueba', { modo: 'dry' }) === 'PRUEBA',
    'y sigue siendo PRUEBA aunque traiga modo: el camino manda sobre el envío');
  ok(selloDe('en_vivo', null) === 'EN VIVO', 'la liga de verdad es EN VIVO');
  ok(selloDe('en_vivo', { modo: 'enviado' }) === 'EN VIVO', 'y con órdenes mandadas, también');
  ok(selloDe('en_vivo', { modo: 'dry' }) === 'EN VIVO · SIN ENVIAR',
    'y la bandera en seco NO cambia el camino: dice EN VIVO, y dice que no salió una orden',
    selloDe('en_vivo', { modo: 'dry' }));

  // El sello viaja ARMADO en el libro: la página lo pinta, no lo arma.
  const l = libroDeFila({
    created_at: '2026-09-17T14:00:00Z', agent_id: 'claude', status: 'ok_target',
    context: { ejecucion: { modo: 'dry', candado: { ok: true }, ordenes_calculadas: [] } },
  }, 'en_vivo');
  ok(l.sello === SELLOS.sin_enviar && l.fuente === 'en_vivo',
    'el libro trae el sello ya armado, y la fuente al lado', `${l.sello} / ${l.fuente}`);
  ok(l.ordenes.modo === 'dry',
    'y el VALOR journaleado sigue siendo `dry`: renombrarlo rompería las filas que ya existen. Lo que cambia es la etiqueta.');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
