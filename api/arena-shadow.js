// ═══════════════════════════════════════════════════════════════
// /api/arena-shadow — B13: corre el CONTRATO NUEVO sin tocar un solo libro.
//
// El portafolio objetivo (B5) no puede estrenarse contra siete cuentas reales.
// Acá corre con el MISMO tablero, las MISMAS herramientas y el MISMO mercado —
// y CERO órdenes. Lo que sale es lo único que importa antes de encenderlo:
// ¿los siete producen un objetivo legible?, ¿pasa los rieles?, ¿qué órdenes
// habría mandado el motor?, y ¿cuánto costó?
//
//   GET /api/arena-shadow            → corre la sombra sobre la liga activa
//   GET /api/arena-shadow?agent=grok → un solo agente
//   GET /api/arena-shadow?report=1   → SOLO el reporte del día (0 tokens)
//
// GATES: CRON_SECRET (si corre por cron) **o** ARENA_ADMIN_KEY (a mano). NO
// exige ARENA_ENABLED: la sombra es lo que se corre ANTES de encender nada.
//
// ── LO QUE NO PUEDE PASAR, Y CÓMO SE IMPIDE ──────────────────────────
// No alcanza con no llamar a Alpaca: el runner recibe un `shadowBroker`, cuyas
// escrituras LANZAN. Si algún camino intentara mandar una orden, la corrida
// falla ruidosamente en vez de operar en silencio sobre una cuenta real.
// Y escribe en `arena_shadow_journal`, tabla aparte — no una columna booleana
// en la tabla real, que está a una consulta mal escrita de contaminar el
// post-mortem para siempre.
//
// ── LA SOMBRA GASTA DINERO DE VERDAD ─────────────────────────────────
// Son llamadas reales a siete proveedores. Va contra el MISMO
// ARENA_DAILY_BUDGET_USD que la liga viva y se registra con `phase='shadow'`.
// "La sombra es gratis" sería una creencia que se desmiente con la factura.
//
// ENV VARS: ARENA_ADMIN_KEY · CRON_SECRET · DATABASE_URL · las de la liga.
// ═══════════════════════════════════════════════════════════════

import { ensureSchema } from './_lib/db.js';
import { checkAdminAuth } from './_lib/arena-admin.js';
import * as alpaca from './_lib/alpaca.js';
import { activeAgents, agentById, agentAlpacaCreds, ARENA_MAX_TOKENS, ARENA_LLM_TIMEOUT_MS, ARENA_REINTENTO_JSON, PROMPT_VERSION } from './_lib/arena-registry.js';
import { callArenaLLM, withDeadline, cachePrefixReport, anthropicCostUsd, diagnosticoDeCorte } from './_lib/arena-model.js';
// `PROMPT_VERSION` ya NO viene de acá: era la única arista del ciclo que no
// hoisteaba. Sale de _lib/arena-registry.js, que es hoja. Los cuatro que
// quedan son `function` declarations y en un ciclo son benignos.
import { gatherContext, buildSharedContext, buildTargetSystemPrompt, resolveBaseUrl } from './arena-run.js';
import { parsePortfolioResponse, validateTarget, railTrims, normalizarTickersObjetivo, rescatarObjetivo, RAILS } from './_lib/arena-rails.js';
import { orderLegs } from './_lib/arena-rebalance.js';
import { legsAOrdenes, verificarOrdenesContraPesos, enviarOrdenes, mandaOrdenes, frenoPorTurnoverMinimo, contratoActivo, permiteCortos } from './_lib/arena-objetivo-vivo.js';
// El estado del agente (halt + baseline). Se lee ACÁ y no solo en el llamador:
// ver el bloque del halt en `runAgenteObjetivo`.
import { leerEstadoAgente as getArenaState } from './_lib/arena-baseline.js';
import { snapshotCuenta } from './_lib/arena-equity.js';
import { registrarAperturas } from './_lib/arena-apertura.js';
import { fetchOptionChain } from './options.js';
import { getNews } from './_lib/alpaca.js';
import { buildRebalance } from './_lib/arena-rebalance.js';
import { createToolExecutor, TOOL_BUDGET } from './_lib/arena-tools.js';
import { runToolLoop, relojDisponible, RESERVA_CIERRE_MS, PISO_VUELTA_MS } from './_lib/arena-tool-loop.js';
import { buildTail, enfoqueDelDia } from './_lib/arena-herding.js';
import { buildRailMeta, sectorFromGics } from './_lib/arena-meta.js';

// Sector ETF de un simbolo, desde los sectores GICS que el universo guardó.
// Sin esto, todo el tablero es "sin sector" para la herramienta `sector`.
function sectorEtfDe(buffet, sym) {
  const secs = (buffet && buffet.universe_raw && buffet.universe_raw.sectores) || null;
  if (!secs) return null;
  return sectorFromGics(secs[String(sym || '').toUpperCase()]);
}
import { shadowBroker, shadowJournalInsert as shadowJournalInsertReal, shadowRunId, shadowReport, ensureShadowSchema } from './_lib/arena-shadow.js';
import { rechazosPrevios, bloqueDeRechazos } from './_lib/arena-rechazos.js';
import { marcarDesagote, rechazosDeEnvio } from './_lib/arena-desagote.js';
import { currentTier, recordRunSpend, callCost } from './_lib/arena-budget.js';
import { marketDay } from './_lib/arena-buffet-cache.js';
import { createTrace } from './_lib/arena-trace.js';
import { buildInfo } from './_lib/build-info.js';
import { beat } from './_lib/heartbeat.js';

export const maxDuration = 300;

function autorizado(req) {
  const cron = process.env.CRON_SECRET;
  if (cron) {
    const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
    if (h === 'Bearer ' + cron) return { ok: true };
  }
  const admin = checkAdminAuth(req, process.env.ARENA_ADMIN_KEY);
  if (admin.ok) return { ok: true };
  return { ok: false, status: admin.status, body: admin.body };
}

// El libro de UN agente, leído a través del broker de sombra (las lecturas
// pasan; las escrituras lanzan).
async function leerLibro(broker, creds) {
  const [account, positions, openOrders] = await Promise.all([
    broker.getAccount(creds), broker.getPositions(creds), broker.getOrders('open', 100, creds),
  ]);
  return { account, positions: positions || [], openOrders: openOrders || [] };
}

// ── UNA CORRIDA EN SOMBRA ────────────────────────────────────────────
// ── UNA SOLA FUNCIÓN PARA LA SOMBRA Y PARA EL VIVO ───────────────────
// El camino vivo del contrato objetivo es EXACTAMENTE éste con tres cosas
// cambiadas: el broker (real en vez del que lanza), la tabla del journal, y que
// al final se mandan las órdenes.
//
// Se PARAMETRIZA en vez de duplicarse, y no por ahorrar líneas: una copia para
// producción empezaría idéntica y divergiría en el primer arreglo que alguien
// aplicara a una sola de las dos. La sombra corrió cuatro días y llegó a 7/7 —
// lo que se enciende mañana tiene que ser ESE código, no uno que se le parece.
// Es la misma razón por la que hay un solo loop de herramientas para los dos
// proveedores.
//
// `runShadowAgent` queda como envoltorio para que el endpoint de la sombra y
// sus tests no cambien.
//
// Nunca lanza: una corrida que falla tiene que aparecer como una FILA, no
// llevarse el reporte de los otros seis.
export function runShadowAgent(args) {
  return runAgenteObjetivo({ ...args, vivo: false });
}

// `evento` viaja SOLO PARA JOURNALEAR, y esa distinción es todo el punto: el
// contrato objetivo produce un portafolio COMPLETO, así que no existe la
// corrida "sobre NVDA" y el evento NO cambia ninguna decisión. Pero el registro
// sí tiene que decir QUÉ despertó la corrida — ver el bloque de `ctx.event`.
// ── EL RELOJ QUE LE QUEDA A UN RESCATE (2026-10-02) ──────────────────
// El presupuesto TOTAL de una corrida es `loop + reserva de cierre` = 255s. El
// MARGEN (15s) no es presupuesto: es lo que separa 255 de los 270 del deadline,
// y existe para que una corrida que se desbordó alcance a ESCRIBIR que se
// desbordó. Un reintento que se lo come convierte una corrida malformada en
// una corrida sin journal, que es peor.
//
// Se mide contra `elapsed_ms` del loop —que ya incluye el cierre— y NO contra
// `restante()`, que mide contra el presupuesto de investigación y da negativo
// después de cualquier cierre normal (el descuadre de B45).
export function relojDeReintento({ budgetMs, elapsedMs }) {
  const total = (Number(budgetMs) || 0) + RESERVA_CIERRE_MS;
  return total - (Number(elapsedMs) || 0);
}

// ── EL RESCATE DE UN CIERRE MALFORMADO ───────────────────────────────
// Devuelve SIEMPRE un objeto, también cuando no se concede: "no hubo
// reintento" y "hubo y falló" no pueden verse iguales, y el motivo de la
// omisión es el dato (ver `motivo`).
//
// LA DESIGUALDAD QUE HAY QUE PUBLICAR. El riel es el mismo para los siete en
// el REGLAMENTO y no en el RESULTADO: gemini cierra a los 42s y le quedan
// ~213s para un rescate; qwen cerró a los 253s de 270 y no le queda nada. O
// sea que el reintento se lo lleva, de hecho, el que es rápido. Eso no se
// puede arreglar con más reloj (el deadline es el deadline), así que se
// DECLARA: `omitido_por_reloj` se cuenta por agente al lado de
// `necesitó_reintento`, y las dos cifras se leen juntas. Un riel que en la
// práctica alcanza a cinco de siete y no lo dice es el patrón de B45 otra vez,
// un límite que no llega al camino que corre.
async function rescatarConSoloJson({ agent, system, loop, textoMalo, corte, parseError, now, trace }) {
  // La CAUSA, del diagnóstico del cierre y no de una suposición. Se publica
  // separada porque manda a lugares opuestos: `corte` es NUESTRO techo de
  // tokens (se sube `ARENA_MAX_TOKENS`), `formato` es el modelo (es hallazgo).
  const causa = corte.truncado === true ? 'corte' : corte.truncado === false ? 'formato' : 'desconocida';
  const restante = relojDeReintento({ budgetMs: loop.budget_ms, elapsedMs: loop.elapsed_ms });
  const base = { causa, parse_error: parseError, reloj_restante_ms: restante };

  if (!ARENA_REINTENTO_JSON) {
    return { ...base, concedido: false, motivo: 'el riel está apagado (ARENA_REINTENTO_JSON=0)' };
  }
  if (restante < PISO_VUELTA_MS) {
    // El MISMO piso que el loop usa para decidir si una vuelta vale la pena.
    // Un número nuevo acá serían dos reglas sobre el mismo presupuesto, que es
    // exactamente la forma de B45.
    return {
      ...base, concedido: false, omitido_por_reloj: true,
      motivo: `quedan ${restante}ms del presupuesto total (loop ${loop.budget_ms}ms + reserva ${RESERVA_CIERRE_MS}ms, gastados ${loop.elapsed_ms}ms): por debajo del piso de vuelta (${PISO_VUELTA_MS}ms). El margen de ${15000}ms que separa del deadline NO se toca: es lo que garantiza que esta corrida alcance a journalearse.`,
    };
  }

  // EL MENSAJE COMPRA FORMATO, NO DELIBERACIÓN. Sin herramientas, sin contexto
  // nuevo, y con la instrucción explícita de no cambiar la decisión: un
  // segundo turno para volver a PENSAR sería una ventaja sobre los agentes que
  // acertaron el formato de una; reimprimir lo ya decidido no lo es.
  const msgs = [
    ...(loop.messages || []),
    { role: 'assistant', content: String(textoMalo || '').slice(0, 4000) },
    { role: 'user', content: [
      'Your previous answer is not a valid JSON object.',
      '',
      'Resend the SAME target portfolio you just decided — do not change a single weight, ticker or thesis.',
      'Reply with ONLY the JSON object: no prose before or after, no markdown fences, no commentary.',
    ].join('\n') },
  ];

  const t0 = Date.now();
  let r = null; let threw = null;
  try {
    r = await callArenaLLM({
      agent, system, messages: msgs, maxTokens: ARENA_MAX_TOKENS, now,
      // Mismo criterio que el cierre: es la ÚLTIMA llamada de la corrida, así
      // que no hay "siguientes" cuyo presupuesto proteger con un techo.
      timeoutMs: Math.max(PISO_VUELTA_MS, restante),
      origenTecho: `reintento solo-JSON: ${restante}ms de presupuesto total sin gastar`,
      ...(trace ? { trace, fase: 'reintento_solo_json' } : {}),
    });
  } catch (e) { threw = String((e && e.message) || e); }

  const ms = Date.now() - t0;
  if (threw || !r || r.status !== 200 || !r.data) {
    return { ...base, concedido: true, resuelto: false, ms, error: threw || (r ? `HTTP ${r.status}${r.error_detail ? ': ' + r.error_detail : ''}` : 'sin respuesta') };
  }
  const texto = ((r.data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')).trim();
  const corte2 = diagnosticoDeCorte(r.data, { maxTokens: ARENA_MAX_TOKENS, texto });
  const parsed = parsePortfolioResponse(texto);
  return {
    ...base, concedido: true, resuelto: !!parsed.ok, ms,
    lectura: corte2,
    ...(parsed.ok ? {} : { parse_error_2: parsed.error }),
    // El PRIMER intento no se pierde. Si el rescate funciona, el hallazgo
    // ("este agente no entregó JSON de una") sigue estando: borrarlo
    // convertiría un dato en un salvataje silencioso.
    texto_1: String(textoMalo || '').slice(0, 1200),
    llm: r, texto, parsed,
  };
}

// ── EL RESUMEN DEL LOOP, EN TODAS LAS SALIDAS (2026-10-02) ───────────
// La respuesta HTTP de un aborto traía `{agent, status, error, cost_usd}` y
// nada más. Las salidas buenas traían `tools_used`. O sea: la tabla de la
// puerta de apertura —vueltas, qué techo cortó, lectura máxima, vacías— NO se
// podía armar desde la respuesta, justo en las filas que importan. Lety las
// armó cruzando a mano con /api/liga-libros, que lee el journal.
//
// Un diagnóstico que existe en la base y no en la respuesta es un diagnóstico
// que obliga a una consulta SQL para contestar la primera pregunta de la fila.
// La puerta la corre ella desde el navegador, no una consulta.
//
// MISMA FORMA EN LAS TRES SALIDAS, a propósito: el script no puede tener un
// `if` por estado, porque el estado es justo lo que está en duda.
export function resumenDelLoop(loop, executor) {
  const v = (loop && loop.vueltas_medidas) || [];
  const lim = (loop && loop.limites) || {};
  const ms = v.map((x) => Number(x && x.ms) || 0);
  return {
    vueltas: (loop && loop.turns) || 0,
    cortó_por: (loop && loop.stopped_by) || null,
    herramientas: executor ? executor.used : null,
    reloj_pct: (lim.reloj_ms && lim.reloj_ms.pct) ?? null,
    lectura_max_ms: ms.length ? Math.max(...ms) : null,
    vacias: v.filter((x) => x && x.vacio).length,
    cortes_nuestros: v.filter((x) => x && x.reloj_nuestro).length,
  };
}

export async function runAgenteObjetivo({ agent, buffet, now = new Date(), tier = null, deps = {}, trace = null, vivo = false, journalInsert = null, runId: runIdDado = null, esDisparador = false, evento = null }) {
  const runId = runIdDado || shadowRunId(agent.id, now);
  const base = { id: runId, run_date: marketDay(now), agent_id: agent.id, phase: 'decide', prompt_version: PROMPT_VERSION, model: agent.model };

  // ── EL HALT, ADENTRO DE LA FUNCIÓN QUE DECIDE (2026-09-29) ─────────
  // Hasta hoy el chequeo vivía SOLO en `runArenaDecide`, o sea en un LLAMADOR.
  // Con el contrato de acciones eso estaba bien porque ahí decidía el llamador;
  // con el contrato objetivo la función que decide es ÉSTA, y el comentario de
  // `runArenaDecide` dice textualmente por qué eso importa: *"la guarda va en
  // la función que DECIDE, no sólo en un llamador: un segundo llamador que se
  // olvide de filtrar no puede volver a abrir el agujero"*.
  //
  // Hoy hay dos llamadores y los dos son seguros —`runArenaDecide` chequea
  // antes, y `runShadowAgent` fuerza `vivo: false`— así que no había agujero.
  // Pero era cierto POR ACCIDENTE: un tercer llamador con `vivo: true` lo
  // reabría, que es exactamente el escenario del que hablaba ese comentario.
  //
  // ── Y POR QUÉ EL BYPASS ES `vivo` Y NO UN PARÁMETRO ───────────────
  // El halt existe para que NO SALGAN ÓRDENES. La sombra no puede mandar una:
  // su broker LANZA en toda escritura (ver `const broker` abajo). Un freno que
  // existe para detener órdenes no tiene por qué aplicarle a un camino que
  // estructuralmente no puede emitirlas — si le aplicara, verificar el sistema
  // exigiría levantar el freno, que es lo contrario de lo que un freno es.
  //
  // El bypass se ata a `vivo`, que `runShadowAgent` fija en `false` de manera
  // literal. NO es una bandera que un llamador pueda pasar para saltarse el
  // halt en vivo: para eludirlo habría que pedir `vivo: false`, y entonces el
  // broker que lanza viene en el mismo paquete. La excepción y la garantía son
  // el MISMO valor.
  if (vivo) {
    const estadoHalt = await getArenaState(agent.id);
    if (estadoHalt && estadoHalt.halted) {
      return {
        agent: agent.id, status: 'halted',
        halted_since: estadoHalt.halted_at || null,
        reason: estadoHalt.halted_reason || null,
        nota: 'La corrida VIVA está detenida por el halt. La corrida de SOMBRA (`/api/arena-shadow`) sigue disponible: no puede mandar órdenes, así que el freno no le aplica.',
      };
    }
  }
  // EN VIVO EL BROKER ES EL DE VERDAD. En sombra es el que LANZA en cualquier
  // escritura — ese candado es lo que hace que una sombra no pueda operar ni
  // por accidente, y por eso no se toca: se elige uno u otro acá y en ningún
  // otro lado.
  const broker = vivo ? alpaca : (deps.shadowBroker || shadowBroker)(alpaca);
  // Dónde se escribe. La sombra tiene tabla propia a propósito (una bandera en
  // la misma tabla está a una consulta mal escrita de contaminar el post-mortem).
  const shadowJournalInsert = journalInsert || shadowJournalInsertReal;
  const creds = agentAlpacaCreds(agent);
  if (!creds) {
    await shadowJournalInsert({ ...base, status: 'aborted_no_alpaca_keys', error: `Faltan ALPACA_${agent.alpaca}_KEY/SECRET.` });
    return { agent: agent.id, status: 'aborted_no_alpaca_keys' };
  }

  let libro;
  try { libro = await leerLibro(broker, creds); }
  catch (e) {
    await shadowJournalInsert({ ...base, status: 'aborted_alpaca_read', error: String((e && e.message) || e) });
    return { agent: agent.id, status: 'aborted_alpaca_read' };
  }
  const equity = Number(libro.account.equity);
  // POSICIONES DE ARRANQUE. El piso de ruido compara a claude con control, y
  // eso solo mide ruido si los dos ARRANCAN del mismo libro: si uno hereda 6
  // posiciones y el otro 1, el coseno mide herencia, no ruido.
  const posicionesIniciales = (libro.positions || []).map((x) => String((x && x.symbol) || '').toUpperCase()).filter(Boolean).sort();

  // El prompt: MISMO system y MISMO contexto compartido que la liga; la cola
  // (enfoque + orden aleatorizado) es lo único por agente, del lado no cacheado.
  const system = buildTargetSystemPrompt(agent.persona);
  const shared = buildSharedContext(buffet);
  const cola = buildTail({
    agentId: agent.id, runId,
    movers: ((buffet.board_raw && buffet.board_raw.gainers) || []).concat((buffet.board_raw && buffet.board_raw.losers) || []),
    now,
  });
  // ── LO QUE LE FUE RECHAZADO LA CORRIDA PASADA ──────────────────────
  // Cada corrida arrancaba SIN memoria de la anterior: el prompt decía qué
  // tiene y qué puede pedir, nunca qué pidió y le fue rechazado. Sin esa
  // línea, insistir con el mismo nombre no es obstinación del modelo — es la
  // única conducta posible, y deepseek pasó un día entero sin operar por eso.
  //
  // Va DESPUÉS del libro y ANTES de la instrucción final, que es donde el
  // modelo ya está decidiendo. Si no hay nada que enseñar el bloque es '' y el
  // prompt queda idéntico al de siempre: un prompt no lleva secciones vacías
  // que el modelo tenga que aprender a ignorar.
  const rechazos = deps.rechazosPrevios
    ? await deps.rechazosPrevios(agent.id, { vivo })
    : await rechazosPrevios(agent.id, { vivo });
  // El universo de HOY se le pasa al bloque: un ticker rechazado el viernes
  // puede estar admitido el lunes, y nombrarlo entonces sería enseñarle algo
  // falso al PM. Sin universo el bloque no filtra y degrada al comportamiento
  // anterior, que es lo correcto cuando no se sabe.
  const universoHoy = (buffet && buffet.universe_raw && buffet.universe_raw.symbols) || null;
  const avisoRechazos = bloqueDeRechazos(rechazos, { universo: universoHoy });

  const user = [
    cola.text,
    '',
    'YOUR BOOK (Alpaca paper, live):',
    JSON.stringify({
      equity_total_incl_cash: equity,
      cash_included_in_equity: Number(libro.account.cash),
      positions: libro.positions.map((p) => ({
        symbol: p.symbol, qty: Number(p.qty), avg_entry: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        weight_pct: Number.isFinite(equity) && equity > 0 ? +((Number(p.market_value) / equity) * 100).toFixed(2) : null,
      })),
      open_orders: libro.openOrders.map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, status: o.status })),
    }),
    '',
    ...(avisoRechazos ? [avisoRechazos, ''] : []),
    'State the book you want to hold. Remember: anything you hold and do not list gets sold.',
  ].join('\n');

  const toolsMax = tier ? tier.tools_max : TOOL_BUDGET.fixed_round;
  const executor = createToolExecutor({
    budget: toolsMax, board: buffet.board_raw || null, universe: buffet.universe_raw || null,
    creds, now,
    // ── `sectorOf` DEVOLVÍA null LITERALMENTE ──────────────────────────
    // Por eso `sector({etf:'XLE'})` daba 0 filas: ningún nombre del tablero
    // podía coincidir con ningún sector, porque la función decía que nadie
    // tiene sector. La herramienta no estaba rota — estaba conectada a nada.
    //
    // Ahora lee los sectores GICS del universo, que vienen del CSV de IVV. Es
    // el MISMO dato que arregló R6: una vez cargado, sirve para los dos.
    deps: { sectorOf: (sym) => sectorEtfDe(buffet, sym) },
    // `marketCapOf` y `retornosOf` salen del universo por default (ver
    // createToolExecutor): sin ellos, `min_mcap_b` y `ret_*_min` se ignoraban
    // en silencio y el modelo creía que había filtrado.
  });

  // EL LIBRO CON EL QUE SE DECIDIÓ, en estructura. Iba sólo dentro del texto
  // del prompt, y el prompt es prosa: parsear precios de ahí es la derivación
  // frágil que ya mordió con el buffet. Es el estado de ESE día — si no se
  // guarda cuando pasa, mañana no existe.
  const cuenta = snapshotCuenta(libro.account, libro.positions);

  const ctx = {
    prompt: { system, shared, user },
    posiciones_iniciales: posicionesIniciales,
    cache_prefix: cachePrefixReport(agent, [system, shared]),
    lens: cola.lens, tail_tokens: cola.tokens_est,
    tier: tier ? { tier: tier.tier, tools_max: toolsMax } : null,
  };

  let loop;
  try {
    loop = toolsMax > 0
      // ── EL RELOJ DE LA SOMBRA ES MÁS LARGO QUE EL DE arena-run ────
      // El contrato nuevo NO tiene fase de scan: es una sola cadena que arranca
      // directo en el loop. El default de `LOOP_BUDGET_MS` descuenta un scan de
      // 90s que acá no existe, así que usar el default regalaría 90 segundos de
      // investigación por una fase que no se corre.
      ? await runToolLoop({
        agent, system: [system, shared], messages: [{ role: 'user', content: user }],
        executor, maxTokens: ARENA_MAX_TOKENS, now, trace,
        budgetMs: relojDisponible({ scanMs: 0 }),
        // ── EL TECHO POR LLAMADA, QUE NUNCA LLEGABA (2026-09-29) ────
        // `ARENA_LLM_TIMEOUT_MS` (90s) existe, está documentado y tiene hasta
        // un campo `origen` para diagnosticarlo. Y NO se le pasaba al loop.
        //
        // Adentro, las dos aritméticas lo tratan como opcional:
        //   vuelta:  Math.min(timeoutMs || Infinity, restante - RESERVA)
        //   cierre:  timeoutMs ? Math.min(timeoutMs, disponible) : disponible
        // Sin él, `|| Infinity` y el `: disponible` dejan el techo SIN TAPA.
        //
        // Medido el 2026-09-29: un cierre corrió con **104.984 ms** de techo.
        // No es una constante que alguien escribió — es `(185s + 70s) − 150s`
        // de lo ya usado. El tope de 90s existía y no aplicaba.
        //
        // Es la misma forma que B45: no un número mal elegido, sino un límite
        // real que no alcanza al camino que corre. Y es el TERCER reloj de la
        // misma corrida, que es exactamente lo que Lety pidió no volver a
        // descubrir la semana que viene.
        timeoutMs: ARENA_LLM_TIMEOUT_MS,
      })
      : { llm: await callArenaLLM({ agent, system: [system, shared], messages: [{ role: 'user', content: user }], maxTokens: ARENA_MAX_TOKENS, now, trace, fase: 'sin_herramientas' }), turns: 1, stopped_by: 'tools_disabled' };
  } catch (e) {
    // EL STACK, no solo el mensaje. `aborted_llm_threw` con un string suelto no
    // distingue un error de red de un TypeError nuestro, y son diagnósticos
    // opuestos: uno se reintenta, el otro se arregla.
    const err = { message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).slice(0, 2000) : null, name: (e && e.name) || null };
    ctx.threw = err;
    if (trace) ctx.trace = trace.report();
    await shadowJournalInsert({ ...base, account: cuenta, status: 'aborted_llm_threw', error: err.message, context: ctx });
    return { agent: agent.id, status: 'aborted_llm_threw', threw: err, ...(trace ? { trace: trace.report() } : {}) };
  }

  const llm = loop.llm;
  ctx.tools = {
    budget: toolsMax, used: executor.used, intentos: executor.intentos,
    // ── CUÁNTO TARDÓ CADA VUELTA ─────────────────────────────────────
    // La corrida de humo tiene que MEDIR, no solo pasar o fallar: elegir el
    // techo por llamada depende de cuánto tarda de verdad cada agente en
    // devolver un cuerpo, y ese número no existía en ningún lado.
    vueltas_medidas: loop.vueltas_medidas || null,
    turns: loop.turns, stopped_by: loop.stopped_by,
    // CUÁL DE LOS TRES TECHOS CORTÓ, con los tres al lado. `stopped_by` dice
    // cuál ganó; `limites` dice si ganó por poco o por lejos — y eso es lo que
    // decide si el número que hay que mover es ése o el otro.
    limites: loop.limites || null,
    // QUIÉN ATENDIÓ CADA VUELTA. Un mismo modelo en OpenRouter lo sirven varios
    // proveedores y no rinden igual: sin esto, "qwen se cuelga" y "Alibaba se
    // cuelga" se journalean idéntico, y son cosas distintas — la segunda se
    // arregla con routing y la primera no se arregla.
    proveedores: loop.proveedores || null,
    proveedores_colgados: loop.proveedores_colgados || null,
    sequence: executor.sequence, summary: executor.summary(),
  };
  if (loop.cierre_diagnostico) ctx.cierre = loop.cierre_diagnostico;
  // DÓNDE MURIÓ. `cierre: null` significaba dos cosas opuestas —el cierre salió
  // bien, o el loop murió antes de llegar a él— y se veían iguales. Esto las
  // separa: si hay `murio_en`, el cierre nunca ocurrió.
  if (loop.murio_en) ctx.murio_en = loop.murio_en;

  // El gasto se registra SIEMPRE, haya salido bien o mal: una corrida abortada
  // igual gastó tokens, y un contador que solo cuenta los éxitos subestima.
  // El acumulado del LOOP, no el de la última llamada: con herramientas el
  // prompt entero viaja en cada vuelta, así que contar solo la última es contar
  // una llamada de nueve — y el escalón del breaker sale de este número.
  const usage = (loop && loop.usage_total) || (llm.data && llm.data.usage) || {};
  const costo = callCost({
    anthropicUsd: agent.provider === 'anthropic' ? anthropicCostUsd(agent.model, usage) : null,
    providerUsd: Number.isFinite(loop && loop.cost_usd_total) ? loop.cost_usd_total
      : (llm.data && Number.isFinite(llm.data.cost_usd) ? llm.data.cost_usd : null),
  });
  await recordRunSpend({
    // ── LA FASE, NO 'shadow' A MANO (2026-09-29) ─────────────────────
    // Esta función corre los DOS caminos: la sombra y la liga VIVA (`vivo:
    // true`, desde `runArenaDecide`). El literal estampaba `'shadow'` en las
    // dos, así que el gasto de una ronda viva se registraba como si fuera de
    // sombra.
    //
    // NO rompía el breaker: la consulta del gasto del día
    // (`arena-budget.js`) agrupa por `agent_id` y no filtra por `phase`, así
    // que el total siempre fue correcto. Lo que no se podía contestar era
    // "cuánto costó la liga viva contra cuánto costó la sombra" — y con la T3
    // arrancando, eso habría sido un mes entero de datos mezclados.
    //
    // `'decide'` es la misma fase que el journal ya usa para una corrida viva
    // (`base.phase`), así que las dos tablas hablan el mismo idioma.
    agentId: agent.id, runId, phase: vivo ? 'decide' : 'shadow', usd: costo.usd, usdSource: costo.source,
    tokens: { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_write: usage.cache_creation_input_tokens },
    llmCalls: (loop.usage_total && loop.usage_total.calls) || loop.turns || 1, toolCalls: executor.used, now,
  });
  ctx.cost = costo;

  if (llm.status !== 200 || !llm.data) {
    // ── `cuerpo_vacio` ES UN MOTIVO PROPIO, no un "HTTP 200" ───────────
    // Durante cuatro sombras esto se journaleó como `HTTP 200` con todo lo demás
    // en null, y se leyó como "algo falló al parsear". Era el proveedor cerrando
    // el stream sin mandar nada. Un motivo que se confunde con otro es un
    // diagnóstico que no existe.
    const vacio = !!llm.emptyBody;
    // ── EL MOTIVO SE DERIVA, NO SE ESCRIBE APARTE (2026-09-29) ────────
    // Este texto decía SIEMPRE "el proveedor cerró el stream", sin mirar
    // `timedOutLeyendo`. Mientras tanto `llm.error_detail` —tres archivos más
    // allá— sí se ramificaba y decía "TIMEOUT NUESTRO". Dos textos para el
    // MISMO hecho, y el que la pantalla muestra en
    // `censo.detalle_fuera.motivo` era el equivocado.
    //
    // Consecuencia medida el 2026-09-29: el aborto de deepseek salía en la
    // ficha culpando al proveedor de un corte que fue NUESTRO
    // (`reloj_nuestro: true`). Con 24 días por delante, eso archiva nuestro
    // bug como fallas de DeepSeek — la tercera culpa de B44 otra vez, un
    // escalón más abajo: no ya en el conteo, sino en la prosa.
    //
    // Ahora sale del MISMO booleano que `error_detail`, así que no se pueden
    // contradecir. Si hace falta cambiar el texto, se cambia una vez.
    const nuestroReloj = !!llm.timedOutLeyendo;
    const error = vacio
      ? (nuestroReloj
        ? `cuerpo_vacio por NUESTRO reloj: el proveedor devolvió HTTP ${llm.status} y seguía mandando keepalives cuando nuestro techo de lectura venció${llm.ms ? ` (${Math.round(llm.ms / 1000)}s)` : ''}. NO es el proveedor cerrando el stream: somos nosotros cortando.`
        : `cuerpo_vacio: el proveedor devolvió HTTP ${llm.status} y cerró el stream sin cuerpo, dos veces (con reintento). NO es un error de formato del payload.`)
      : llm.stale ? 'fechas rotas tras retry' : `HTTP ${llm.status}${llm.error_detail ? ': ' + llm.error_detail : ''}`;
    // EL CUERPO CRUDO AL JOURNAL. Tres agentes abortaron con "HTTP 200" y no
    // había forma de saber qué había contestado el proveedor: el error decía el
    // status y nada más. Sin el cuerpo, diagnosticar esto es adivinar.
    ctx.llm_error = {
      status: llm.status, detail: llm.error_detail || null,
      provider_error: llm.provider_error || null,
      raw_body: llm.raw_body || null,
      // EL ID DE LA GENERACIÓN. Cuando el cuerpo no llegó, es lo ÚNICO con lo
      // que se puede recuperar después quién sirvió la llamada: OpenRouter
      // guarda el registro de su lado. Sin esto, un `cuerpo_vacio` es
      // inatribuible para siempre — y eso fue exactamente lo que pasó con los
      // 23 de la T2.
      generation_id: llm.generation_id || null,
      cabeceras: llm.cabeceras || null,
      // EL TURNO DE CIERRE ENTERO. Los abortos llegaron con status 200 y todo
      // lo de arriba en null: el fetch iba bien y la falla estaba al LEER la
      // respuesta. Esto es lo que faltaba.
      cierre: llm.cierre_diagnostico || (loop && loop.cierre_diagnostico) || null,
      // Si esto viene poblado, el `cierre: null` de arriba NO es un cierre que
      // salió bien: es un cierre que nunca se ejecutó.
      murio_en: (loop && loop.murio_en) || null,
      threw_stack: llm.threw_stack || null,
      // El motivo CORTO, también derivado: el largo y el corto no pueden
      // discrepar, que es el bug que esto cierra.
      motivo: vacio ? (nuestroReloj ? 'cuerpo_vacio_reloj_nuestro' : 'cuerpo_vacio_proveedor') : null,
      // Todos los cortes de la corrida, con su vuelta y su intento. Si un agente
      // acumula varios, el problema es del proveedor y no de una vuelta suelta.
      cuerpos_vacios: (loop && loop.cuerpos_vacios) || null,
      proveedores_colgados: (loop && loop.proveedores_colgados) || null,
      // El que se colgó, y si fue NUESTRO reloj o el suyo. Se arreglan al revés.
      proveedor: llm.proveedor || null,
      timeout_nuestro: !!llm.timedOutLeyendo,
      timed_out: !!llm.timedOut, stale: !!llm.stale, retry_failed: !!llm.retry_failed,
      // CUÁL reloj cortó. "Se pasó de 15s" no dice si ese 15 lo puso una env
      // var o el reparto del loop, y se arreglan en lugares opuestos.
      techo_ms: llm.techo_ms ?? null, techo_origen: llm.techo_origen || null,
    };
    if (trace) ctx.trace = trace.report();
    const status = vacio ? 'aborted_cuerpo_vacio' : 'aborted_llm_error';
    await shadowJournalInsert({ ...base, account: cuenta, status, error, context: ctx });
    return {
      agent: agent.id, status, error, cost_usd: costo.usd,
      loop: resumenDelLoop(loop, executor),
      cuerpos_vacios: (loop && loop.cuerpos_vacios) || null,
      murio_en: (loop && loop.murio_en) || null,
      llm_error: ctx.llm_error,
      ...(trace ? { trace: trace.report() } : {}),
    };
  }

  const text = ((llm.data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')).trim();
  // ── ¿JSON MALO O JSON CORTADO? (2026-10-02) ─────────────────────────
  // Se mide SIEMPRE, no solo cuando falla el parseo. Dos razones:
  //
  //   1. Un `ok_target` que salió con `stop_reason: max_tokens` entregó libro
  //      POR SUERTE: el JSON cerró justo antes del techo. Eso es un aviso, y
  //      si solo se mide en la falla no se ve hasta que muerde.
  //   2. La línea base. Sin saber cuánto del techo gastan los que SÍ entregan,
  //      no hay con qué comparar a los que no — y entonces "subir el techo"
  //      es una corazonada, no una medida.
  //
  // Sale del objeto `llm` que de verdad se PARSEÓ, no del array de intentos del
  // cierre: ahí hay hasta tres turnos (cierre, otro proveedor, reintento sin
  // herramientas) y cuál ganó se deducía de `resuelto_por`. Una derivación
  // frágil para el dato que decide el diagnóstico.
  const corte = diagnosticoDeCorte(llm.data, { maxTokens: ARENA_MAX_TOKENS, texto: text });
  ctx.lectura_cierre = corte;
  let texto = text;
  let parsed = parsePortfolioResponse(texto);
  // EL MOTIVO, ADELANTE DEL ERROR DEL PARSER. "Expected ',' or '}' at
  // position 771" describe el síntoma; `truncado` dice la causa. Sin esto, los
  // dos abortos de la segunda tanda se leían idénticos y no lo eran.
  const porQueMalo = (pe) => (corte.truncado === true
    ? `CORTADO (${corte.truncado_por}) · ${pe}`
    : corte.truncado === false
      ? `el modelo cerró el turno solo y el JSON no sirve · ${pe}`
      : `no se sabe si fue corte o formato (${corte.por_que_no_se_sabe}) · ${pe}`);

  if (!parsed.ok) {
    const rescate = await rescatarConSoloJson({
      agent, system: [system, shared], loop, textoMalo: texto, corte,
      parseError: parsed.error, now, trace,
    });
    // LO QUE SE PUBLICA del rescate: sin el objeto `llm` crudo ni el texto
    // entero (eso ya va en `llm_response`). Se publica SIEMPRE, también
    // cuando no se concedió — "no hubo reintento" y "hubo y falló" no pueden
    // verse iguales.
    const { llm: _l, texto: _t, parsed: _p, ...publicable } = rescate;
    ctx.reintento_json = publicable;

    // EL GASTO DEL RESCATE, con su propio id. `arena_spend` tiene
    // `on conflict (id) do nothing` y el id es el runId: una segunda llamada
    // con el mismo id se descarta en silencio y el reintento habría salido
    // GRATIS en el breaker. Un contador que no ve una llamada que se pagó no
    // es un breaker.
    if (rescate.concedido && rescate.llm && rescate.llm.data) {
      const u2 = rescate.llm.data.usage || {};
      const c2 = callCost({
        anthropicUsd: agent.provider === 'anthropic' ? anthropicCostUsd(agent.model, u2) : null,
        providerUsd: Number.isFinite(rescate.llm.data.cost_usd) ? rescate.llm.data.cost_usd : null,
      });
      await recordRunSpend({
        agentId: agent.id, runId: `${runId}:reintento`, phase: vivo ? 'decide' : 'shadow',
        usd: c2.usd, usdSource: c2.source,
        tokens: { input: u2.input_tokens, output: u2.output_tokens, cache_read: u2.cache_read_input_tokens, cache_write: u2.cache_creation_input_tokens },
        llmCalls: 1, toolCalls: 0, now,
      });
      ctx.reintento_json.cost = c2;
      costo.usd = (Number(costo.usd) || 0) + (Number(c2.usd) || 0);
    }

    if (rescate.resuelto) {
      // SE RESCATÓ, Y SE DICE. El texto que decide es el del reintento; el
      // primero queda en `context.reintento_json.texto_1` y el hallazgo
      // ("no entregó JSON de una") sigue contado.
      texto = rescate.texto;
      parsed = rescate.parsed;
      ctx.lectura_cierre_reintento = rescate.lectura;
    } else {
      const error = `${porQueMalo(parsed.error)} · reintento solo-JSON: ${rescate.concedido ? (rescate.resuelto === false ? 'concedido y tampoco' : 'concedido') : 'NO concedido (' + rescate.motivo + ')'}`;
      await shadowJournalInsert({ ...base, account: cuenta, status: 'aborted_malformed_target', error, llm_response: texto, context: ctx });
      // VA EN LA RESPUESTA HTTP, no solo en el journal. La tabla del humo se
      // lee desde el navegador; un campo que solo existe en Neon obliga a una
      // consulta SQL para contestar la primera pregunta de la fila — y la
      // puerta de apertura la corre Lety, no una consulta.
      return {
        agent: agent.id, status: 'aborted_malformed_target', error, cost_usd: costo.usd,
        loop: resumenDelLoop(loop, executor),
        lectura_cierre: corte, parse_error: parsed.error,
        reintento_json: publicable,
      };
    }
  }

  // ── LOS TICKERS, ANTES DE LOS RIELES ────────────────────────────────
  // Va acá y no dentro de `validateTarget` porque es una pregunta distinta: los
  // rieles juzgan una CARTERA (pesos, concentración, cortos); esto juzga si los
  // NOMBRES existen. Un objetivo con un símbolo inventado no tiene una
  // violación de riel — no tiene sentido siquiera evaluarlo.
  const universoSimbolos = (buffet && buffet.universe_raw && buffet.universe_raw.symbols) || null;
  // ── LO QUE PUEDE TENER NO ES LO QUE PUEDE VER (2026-09-22) ─────────
  // El universo del día decide qué se puede ABRIR. Lo que YA se tiene sigue
  // siendo legal aunque su ticker no esté hoy en la lista: una posición sale
  // por un riel, por un stop o porque el agente la vende — nunca porque la
  // lista rotó. Sin esto, deepseek compró NKE al 25% por la mañana y lo
  // liquidó por la tarde "porque el universo admisible de hoy fuerza la
  // salida", y tenía razón: así estaba cableado.
  //
  // El peso ACTUAL viaja porque el permiso no es ilimitado: un nombre que se
  // tiene y no está en el universo se puede mantener o reducir, no aumentar
  // (ver `normalizarTickersObjetivo`).
  const tenencias = {};
  for (const p of (libro.positions || [])) {
    const sym = String((p && p.symbol) || '').trim().toUpperCase();
    const mv = Math.abs(Number(p && p.market_value));
    if (sym && Number.isFinite(mv) && Number.isFinite(equity) && equity > 0) tenencias[sym] = mv / equity;
  }
  const tick = normalizarTickersObjetivo(parsed.weights, { universo: universoSimbolos, tenencias });
  // ── QUÉ DESPERTÓ ESTA CORRIDA (2026-09-19) ──────────────────────────
  // ESTO FALTABA Y DEJÓ MUERTO EL TOPE DIARIO. El vigilante cuenta las
  // corridas del día con:
  //     where context->'event'->>'type' in ('watch_trigger','watch_floor')
  // y el contrato objetivo NUNCA escribía `context.event` — `grep event` en
  // este archivo daba CERO. Así que `runsToday` era {} para todos los agentes
  // todos los días, `used` era 0, y el tope de 12 corridas/agente/día no
  // frenaba nada: el viernes claude corrió ~20 veces.
  //
  // El evento se journalea y NO se usa para decidir: el objetivo sigue siendo
  // el libro entero, igual que antes. Lo que cambia es que el registro ahora
  // dice de dónde vino la corrida, que es lo que el tope necesita para contar.
  if (evento && evento.type) {
    ctx.event = { type: evento.type, symbol: evento.symbol || null, detail: evento.detail || null };
  }

  ctx.tickers = {
    reparados: tick.reparados, desconocidos: tick.desconocidos, colisiones: tick.colisiones,
    validado_contra_universo: tick.validado_contra_universo,
    // Los nombres que siguieron vivos SOLO porque ya estaban en el libro. Es
    // la medida directa de cuántas salidas habría forzado la rotación del
    // universo si esto no estuviera — y es lo que hace auditable el conteo.
    admitidos_por_tenencia: tick.admitidos_por_tenencia,
    // Si el aviso viajó Y el modelo volvió a pedir el mismo nombre, eso ya no
    // es falta de información: es el modelo ignorando un hecho que tenía
    // enfrente, y el post-mortem tiene que poder distinguir las dos cosas.
    aviso_previo: avisoRechazos ? { habia: true, nombres: rechazos.length } : { habia: false },
  };
  // ── EL RESCATE (2026-09-18) ─────────────────────────────────────────
  // Antes, un solo ticker malo rechazaba el objetivo ENTERO y el agente se
  // quedaba con el libro de AYER —incluidas las posiciones que había decidido
  // cerrar—. Rechazar no era neutral: era ejecutar la cartera vieja.
  //
  // Ahora se intenta descartar SOLO esa pata. La decisión vive en
  // `rescatarObjetivo` (pura, con sus dos topes); acá solo se actúa sobre ella.
  let rescate = null;
  if (!tick.ok) {
    rescate = rescatarObjetivo(tick);
    ctx.tickers.rescate = rescate;
    if (!rescate.rescatable) {
      await shadowJournalInsert({ ...base, account: cuenta, status: 'rejected_tickers', error: tick.error, llm_response: texto, context: ctx });
      return { agent: agent.id, status: 'rejected_tickers', error: tick.error, motivo_rescate: rescate.motivo, tickers: ctx.tickers, cost_usd: costo.usd };
    }
  }
  // A partir de acá se trabaja con los símbolos ya canónicos. Si hubo rescate,
  // `tick.weights` ya viene SIN las patas descartadas y SIN reescalar: el peso
  // huérfano queda en cash, que es lo que el PM no eligió pero tampoco apostó.
  parsed.weights = tick.weights;

  // ── RIELES ──
  // La metadata por nombre (precio, sector, shortable, easy-to-borrow) se
  // resuelve ACÁ, sobre los símbolos que el objetivo realmente nombra — no
  // sobre el universo entero. Son unidades de nombres, no centenas, y el dato
  // de borrow viene de la MISMA fuente que después va a aceptar o rechazar la
  // orden (Alpaca /v2/assets).
  //
  // Lo que falte sale ausente y los rieles lo leen como "sin dato": R9 rechaza
  // el corto (fail closed) y el nombre cae al bucket UNKNOWN de R6. Que ahora
  // haya datos no afloja ningún riel — deja de rechazarlos a todos por igual.
  const simbolosDelObjetivo = [...new Set([
    ...Object.keys(parsed.weights || {}),
    ...(libro.positions || []).map((p) => String((p && p.symbol) || '').toUpperCase()),
  ].filter(Boolean))];
  let meta = {};
  let metaDiag = null;
  try {
    // Los sectores del universo (GICS del CSV de IVV) llegan acá: son la
    // clasificación del índice, no una heurística, y son lo que evita que R6
    // rechace carteras por un bucket UNKNOWN inventado por la falta de datos.
    const sectoresUniverso = (buffet && buffet.universe_raw && buffet.universe_raw.sectores) || null;
    const rm = await buildRailMeta(simbolosDelObjetivo, { creds, now, sectoresConocidos: sectoresUniverso });
    meta = rm.meta; metaDiag = { ...rm.diagnostics, errors: rm.errors };
  } catch (e) {
    metaDiag = { error: String((e && e.message) || e), note: 'sin metadata: R9 rechaza todo corto y R6 manda todo al bucket UNKNOWN' };
  }
  ctx.rail_meta = metaDiag;
  const v = validateTarget(parsed.weights, meta, RAILS);
  const trims = railTrims(libro.positions, equity, meta, RAILS);
  const rebalance = v.ok
    ? buildRebalance({ positions: libro.positions, openOrders: libro.openOrders, equity, target: parsed.weights, trims })
    : null;

  // ── EL ÚNICO TRAMO QUE NO EXISTE EN SOMBRA: MANDAR ──────────────────
  // Todo lo de arriba corrió cuatro días en sombra. Esto no puede correr en
  // sombra por definición, así que es el tramo con menos kilómetros — y por eso
  // lleva el candado más duro del repo.
  let ejecucion = null;
  if (vivo && rebalance) {
    const { ordenes, descartadas } = legsAOrdenes({
      legs: orderLegs(rebalance.legs), meta,
      // ÉSTA ES LA COMPUERTA DE LOS CORTOS (D8, 2026-09-18). Estaba en `false`
      // duro: el reglamento v4 decía long-only por un error de redacción, así
      // que el motor DESCARTABA cada pata de corto aunque el prompt le dijera
      // al PM "you may go long and short" y los rieles del corto existieran.
      // Ahora depende de la bandera, que solo sirve para APAGARLOS en vivo
      // (ARENA_CORTOS=0) — nunca para encenderlos sin la red cableada.
      permitirCortos: permiteCortos(),
    });

    // EL CANDADO DE LETY, aplicado ANTES de mandar y no después de leer el
    // journal: si alguna orden no corresponde a ningún peso, no se manda
    // NINGUNA de esta corrida.
    const candado = verificarOrdenesContraPesos({ ordenes, target: parsed.weights, current: rebalance.current });

    // ── EL PISO DE MOVIMIENTO PARA UNA CORRIDA POR DISPARADOR ────────
    // Un disparador despertó al agente, el agente miró, y si lo que quiere
    // hacer no mueve lo suficiente, no se paga el spread. Se evalúa ANTES del
    // candado y del envío, y el objetivo se journalea igual: la decisión
    // existió, sólo no se ejecutó.
    const frenoTurnover = frenoPorTurnoverMinimo(rebalance, { esDisparador });

    ejecucion = {
      modo: frenoTurnover ? 'sin_operar' : (mandaOrdenes() ? 'enviado' : 'dry'),
      candado,
      ordenes_calculadas: ordenes,
      descartadas,
      ...(frenoTurnover ? { turnover_minimo: frenoTurnover } : {}),
    };

    if (frenoTurnover) {
      ejecucion.enviadas = [];
      ejecucion.freno = frenoTurnover.detalle;
    } else if (!candado.ok) {
      ejecucion.enviadas = [];
      ejecucion.freno = candado.error;
    } else if (mandaOrdenes()) {
      ejecucion.enviadas = await enviarOrdenes({
        ordenes, creds, runDate: base.run_date, agentId: agent.id, now,
        // ── EL TAG DECÍA SIEMPRE 'f' ─────────────────────────────────
        // 'f' es "revisión de piso" en el vocabulario del contrato viejo, y acá
        // estaba escrito a mano: TODAS las órdenes del contrato objetivo salían
        // estampadas como revisión de piso, vinieran de una ronda fija, de la
        // matutina o de un disparador. Con el minuto adentro el tag ya no
        // decide la unicidad del id — pero sí es lo que uno lee para saber qué
        // despertó una orden, y decir siempre lo mismo es no decir nada.
        runTag: evento
          ? (evento.type === 'post_earnings_morning' ? 'm' : 'w')
          : 'd',
      });
    } else {
      // `objetivo_dry`: se calculó todo y NO se mandó nada. Es el escalón que
      // convierte "confío en que las órdenes están bien" en "vi las órdenes".
      ejecucion.enviadas = [];
      ejecucion.nota = 'ARENA_CONTRATO=objetivo_dry: las órdenes se calcularon y se journalearon COMPLETAS, y no se mandó ninguna. Poné `objetivo` para que se manden.';
    }
  }

  // ── ¿ESTA CORRIDA ESTÁ DESAGOTANDO UN ATRASO? ───────────────────────
  // Del 21 al 24 de septiembre el `client_order_id` no llevaba la corrida y 180
  // órdenes murieron con `Alpaca 422: client_order_id must be unique`, sobre
  // todo VENTAS. La primera corrida con el id arreglado las suelta de golpe y
  // parece un evento de mercado. No lo es, y la fila tiene que decirlo.
  //
  // Se MIDE contra el journal en vez de escribir la fecha del deploy a mano:
  // así se apaga sola cuando el atraso se termina, y marca a cada agente por lo
  // suyo (uno que aborta veinte veces lo arrastra más días que uno que corre
  // tres veces al día). Nunca tumba la corrida: es una etiqueta de post-mortem.
  if (vivo && ejecucion && (ejecucion.enviadas || []).length) {
    try {
      const desagote = marcarDesagote({
        ordenes: (ejecucion.enviadas || []).filter((o) => o.result === 'approved'),
        rechazadasAntes: await rechazosDeEnvio(agent.id),
      });
      if (desagote) ctx.desagote = desagote;
    } catch (e) { /* una marca perdida es una fila de estudio menos, no una corrida menos */ }
  }

  // ── EL CONTEXTO DE CADA APERTURA ────────────────────────────────────
  // DESPUÉS de mandar las órdenes y antes de journalear: una noticia que tarda
  // en bajar no puede retrasar un fill. Y nunca lanza — perder un snapshot es
  // perder una fila de estudio; tumbar la corrida después de operar deja
  // órdenes en Alpaca sin la fila que las explica.
  //
  // Sólo en VIVO: una corrida de prueba no abre nada, así que su "apertura" no
  // es un momento que haya existido.
  let aperturas = null;
  if (vivo && ejecucion && (ejecucion.enviadas || []).length) {
    try {
      const enviadasOk = (ejecucion.enviadas || []).filter((o) => o.result === 'approved');
      aperturas = await registrarAperturas({
        agentId: agent.id, runDate: base.run_date,
        ordenes: enviadasOk,
        target: { weights: parsed.weights, theses: parsed.theses },
        enfoque: cola.lens, contrato: contratoActivo(),
        universo: (buffet && buffet.universe_raw) || null, buffet,
        deps: {
          news: (sym) => getNews({ symbols: [sym], limit: 5, creds }),
          chain: async (sym) => (await fetchOptionChain(sym)).res,
        },
        now,
      });
    } catch (e) {
      aperturas = { guardadas: 0, error: String((e && e.message) || e) };
    }
  }

  await shadowJournalInsert({
    ...base,
    // El libro con el que se decidió, en estructura. Va en TODAS las salidas
    // que ocurren después de leerlo, incluidas las abortadas: una corrida que
    // falló igual tenía un libro, y sin él no se puede estudiar por qué falló.
    account: cuenta,
    // `ejecutado_parcial` es un estado PROPIO y no un `ok_target` con una nota
    // al pie: el post-mortem tiene que poder contar por separado las corridas
    // que se ejecutaron enteras y las que se ejecutaron sin una pata. Si se
    // mezclaran, un agente al que se le descarta una posición cada día se
    // vería igual de sano que uno que nunca falla.
    status: !v.ok ? 'rejected_rails' : (rescate && rescate.rescatable ? 'ejecutado_parcial' : 'ok_target'),
    // `texto` y no `text`: si el reintento solo-JSON rescató la corrida, el
    // libro que se ejecutó es el del REINTENTO. Journalear el primero dejaría
    // el `target` y el `llm_response` describiendo respuestas distintas.
    plan: parsed.plan, llm_response: texto,
    target: { weights: parsed.weights, cash: parsed.cash, theses: parsed.theses },
    rebalance,
    context: { ...ctx, rails: v, rail_trims: trims, ...(ejecucion ? { ejecucion } : {}), ...(aperturas ? { aperturas } : {}) },
    // Un rescate NO es un error, pero tampoco es silencio: si el campo `error`
    // queda null, la única huella del descarte estaría dentro de `context` y
    // nadie la mira al escanear el journal.
    error: !v.ok
      ? `violó ${v.violations.length} riel(es): ${v.violations.map((x) => x.rail).join(', ')}`
      : (rescate && rescate.rescatable
        ? `ejecución parcial: se descartaron ${rescate.nombres} pata(s) que no existen en el universo (${rescate.descartados.map((d) => d.symbol).join(', ')}), ${(rescate.fraccion * 100).toFixed(1)}% del bruto, y su peso quedó en cash sin reescalar el resto.`
        : null),
  });

  return {
    agent: agent.id,
    status: !v.ok ? 'rejected_rails' : (rescate && rescate.rescatable ? 'ejecutado_parcial' : 'ok_target'),
    ...(rescate && rescate.rescatable ? { rescate: { nombres: rescate.nombres, fraccion: rescate.fraccion, descartados: rescate.descartados.map((d) => d.symbol) } } : {}),
    ...(ejecucion ? {
      ejecucion: {
        modo: ejecucion.modo,
        candado_ok: ejecucion.candado.ok,
        ordenes: ejecucion.ordenes_calculadas.length,
        enviadas: (ejecucion.enviadas || []).filter((o) => o.result === 'approved').length,
        fallidas: (ejecucion.enviadas || []).filter((o) => o.result === 'submit_failed').length,
        descartadas: ejecucion.descartadas.length,
        ...(ejecucion.freno ? { freno: ejecucion.freno } : {}),
        ...(ejecucion.nota ? { nota: ejecucion.nota } : {}),
      },
    } : {}),
    lens: cola.lens, tools_used: executor.used, tools_intentos: executor.intentos, cost_usd: costo.usd,
    loop: resumenDelLoop(loop, executor),
    // ¿NECESITÓ AYUDA? La estadística por agente que Lety pidió, en la misma
    // respuesta que la tabla de la puerta: un `ok_target` rescatado por el
    // reintento y uno que entregó de una no pueden leerse igual.
    ...(ctx.reintento_json ? { reintento_json: ctx.reintento_json } : {}),
    // El corte también cuando SALIÓ BIEN. Un libro entregado con el techo al
    // 0.99 entregó por centímetros, y eso solo se ve si se publica siempre.
    lectura_cierre: corte,
    weights: parsed.weights,
    exposures: v.exposures,
    violations: v.violations,
    would_place: rebalance ? rebalance.legs.length : 0,
    turnover: rebalance ? rebalance.turnover : null,
    rail_trims: trims.length,
    rail_meta: metaDiag ? {
      shortable_ok: metaDiag.shortable_ok, with_borrow: metaDiag.with_borrow,
      with_sector: metaDiag.with_sector, sector_unknown_bucket: metaDiag.sector_unknown_bucket,
      symbols: metaDiag.symbols, note: metaDiag.note || metaDiag.error || null,
    } : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no soportado.' });
  const auth = autorizado(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const now = new Date();
  try {
    await ensureSchema();
    await ensureShadowSchema();

    // ?report=1 — gratis, cero tokens: qué pasó hoy en la sombra.
    if (String(q.report || '') === '1') {
      return res.status(200).json({ build: buildInfo(), ...(await shadowReport(String(q.day || marketDay(now)))) });
    }

    const only = String(q.agent || '').toLowerCase();
    const agents = only ? [agentById(only)].filter(Boolean) : activeAgents();
    if (!agents.length) return res.status(400).json({ error: 'Ningún agente activo con ese id.' });

    // ── ?trace=1 — LA CONVERSACIÓN ENTERA, TURNO POR TURNO ─────────────
    // EXIGE `?agent=<uno>`. No es una restricción arbitraria: el trace de una
    // vuelta lleva el tablero, el prompt del sistema y todos los resultados de
    // herramientas acumulados. Siete de esos en una respuesta HTTP no caben, y
    // el caso de uso es "este agente falla, quiero ver por qué", no "quiero
    // siete conversaciones".
    const quiereTrace = String(q.trace || '') === '1';
    if (quiereTrace && !only) {
      return res.status(400).json({
        error: '?trace=1 exige ?agent=<id>.',
        detalle: 'El trace de UNA vuelta lleva el prompt entero más todos los resultados de herramientas acumulados; siete agentes no caben en una respuesta. Corré uno por vez.',
        ejemplo: '/api/arena-shadow?agent=qwen&trace=1&key=<ARENA_ADMIN_KEY>',
      });
    }

    // El presupuesto manda también acá: la sombra gasta dinero de verdad.
    const tier = await currentTier(now);

    const buffet = await gatherContext({ baseUrl: resolveBaseUrl(req), now });

    const trazas = new Map();
    const settled = await Promise.allSettled(
      agents.map((a) => {
        const trace = quiereTrace ? createTrace({ label: a.id }) : null;
        if (trace) trazas.set(a.id, trace);
        return withDeadline(
          runShadowAgent({ agent: a, buffet, now, tier, trace }),
          270000,
          // El timeout TAMBIÉN devuelve el trace: una corrida que se pasó del
          // reloj es justo la que hay que poder mirar vuelta por vuelta, y
          // perderlo acá deja el peor caso sin evidencia.
          () => ({ agent: a.id, status: 'timeout', ...(trace ? { trace: trace.report() } : {}) }),
        );
      }),
    );
    const results = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : {
      agent: agents[i].id, status: 'threw',
      error: String((r.reason && r.reason.message) || r.reason),
      stack: r.reason && r.reason.stack ? String(r.reason.stack).slice(0, 2000) : null,
      ...(trazas.has(agents[i].id) ? { trace: trazas.get(agents[i].id).report() } : {}),
    }));

    // Red de seguridad del trace: si un agente salió por un camino que no lo
    // adjuntó, se adjunta acá. Pedir `?trace=1` y recibir una respuesta sin
    // trace es exactamente el fallo que este endpoint existe para no repetir.
    if (quiereTrace) {
      for (const r of results) {
        if (r && !r.trace && trazas.has(r.agent)) r.trace = trazas.get(r.agent).report();
      }
    }

    const costo = results.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const verdes = results.filter((r) => r.status === 'ok_target');
    const out = {
      ran_at: now.toISOString(),
      build: buildInfo(),
      shadow: true,
      orders_placed: 0,
      orders_note: 'La sombra NO manda órdenes por construcción: el broker de sombra LANZA en cualquier escritura.',
      budget: { tier: tier.tier, spent_before_usd: tier.spent_usd, budget_usd: tier.budget_usd, tools_max: tier.tools_max, note: tier.note || null },
      cost_usd: +costo.toFixed(4),
      board: buffet.board_meta || null,
      universe: (buffet.universe_diagnostics && buffet.universe_diagnostics.base) || null,
      agents: results,
      verdict: verdes.length === results.length
        ? `VERDE: los ${verdes.length} produjeron un objetivo que pasa los rieles. Costo de la sombra: $${costo.toFixed(4)}.`
        : `${verdes.length}/${results.length} en verde. Revisá \`agents[].status\` y \`violations\` antes de encender el contrato nuevo.`,
    };
    if (quiereTrace) {
      out.trace_note = 'TRACE ACTIVO: `agents[].trace.turnos_detalle[]` trae, por vuelta, el CUERPO HTTP enviado y el TEXTO CRUDO recibido (4 KB c/u), más el stack de cualquier throw. Lleva los prompts completos: no se cachea y no se publica en ninguna ruta pública.';
      res.setHeader('Cache-Control', 'no-store');
    }
    await beat('arena:shadow', verdes.length === results.length ? 'ok' : 'partial', { verdes: verdes.length, costo: +costo.toFixed(4) });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'arena-shadow: ' + ((err && err.message) || 'unknown') });
  }
}
