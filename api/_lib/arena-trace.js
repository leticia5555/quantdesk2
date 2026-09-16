// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-trace.js — LA CONVERSACIÓN ENTERA, turno por turno.
//
// Tres agentes de OpenRouter (grok, qwen, deepseek) abortan corrida tras
// corrida y llevamos tres rondas de hipótesis: primero que el cierre iba sin
// `tools` declaradas, después que la captura estaba en la capa del fetch,
// después que estaba en la capa de lectura. Cada una explicaba los síntomas y
// ninguna sobrevivió a la corrida siguiente.
//
// El problema no era la hipótesis: era que NO SE VE EL PAYLOAD. Todo lo que
// journaleamos son resúmenes —status, `bodySample` de 800 caracteres de la
// RESPUESTA, la secuencia de herramientas— y ninguno incluye lo único que
// decide el caso: QUÉ LE MANDAMOS al proveedor en la vuelta que falló.
//
// Esto lo captura. Por vuelta: el cuerpo HTTP exacto que salió y el texto
// crudo que volvió, recortados a 4 KB cada uno, más el status, el tiempo y el
// stack si algo lanzó.
//
// ── POR QUÉ NO ESTÁ PRENDIDO SIEMPRE ─────────────────────────────────
// El payload de una vuelta 8 lleva el tablero, el prompt del sistema y siete
// turnos de resultados de herramientas. Guardarlo en cada corrida de los siete
// agentes engordaría el journal en órdenes de magnitud para un dato que solo
// se mira cuando algo falla. Va detrás de `?trace=1` y de UN agente por vez.
//
// ── LO QUE NO HACE ───────────────────────────────────────────────────
// No decide nada, no reintenta nada y no cambia ningún payload. Si este módulo
// cambiara lo que se manda, dejaría de ser un trace y pasaría a ser otra
// corrida — justo la que no se quiere depurar.
// ═══════════════════════════════════════════════════════════════

// 16 KB y no 4: con 4096 los payloads de 28-36 KB se recortaban TODOS al mismo
// largo, así que el diff entre vueltas reportaba `delta 0` siempre — el número
// que más importaba era el único que el recorte destruía. Ver `diffTurnos`, que
// además ahora mide sobre el tamaño REAL y no sobre el recortado.
export const TRACE_MAX_BYTES = Number(process.env.ARENA_TRACE_BYTES) || 16384;
export const TRACE_MAX_ENTRIES = 40;

// Recorta y DECLARA el recorte. Un payload cortado en 4 KB que no dice que lo
// cortaron se lee como un payload que terminaba ahí — y eso, en un trace de
// depuración, es una pista falsa.
export function recortar(x, maxBytes = TRACE_MAX_BYTES) {
  if (x == null) return null;
  const s = typeof x === 'string' ? x : safeStringify(x);
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + `\n…[RECORTADO: ${s.length} caracteres en total, se muestran ${maxBytes}]`;
}

// El tamaño REAL, antes de recortar. Es el número que el diff necesita: dos
// payloads de 28 KB y 36 KB recortados a 16 KB miden lo mismo, y de ahí salía
// el `delta 0` que no servía para nada.
function tamanoReal(x) {
  if (x == null) return null;
  return (typeof x === 'string' ? x : safeStringify(x)).length;
}

// `JSON.stringify` puede lanzar con referencias circulares o BigInt. Un trace
// que tumba la corrida que intenta explicar no sirve para nada.
function safeStringify(x) {
  try { return JSON.stringify(x); } catch (e) { return `[no serializable: ${String((e && e.message) || e)}]`; }
}

// ── QUÉ CAMBIÓ ENTRE UNA VUELTA Y LA SIGUIENTE ───────────────────────
// Lo estructural, no el texto: cuántos mensajes, de qué roles, qué claves
// aparecieron en los mensajes `assistant`, y cuánto creció el cuerpo. Es lo que
// contesta "¿qué tiene la vuelta 3 que no tenía la 2?" sin leer 36.000
// caracteres a ojo.
//
// Trabaja sobre el texto YA RECORTADO, así que un payload grande puede venir
// truncado y el conteo de mensajes salir corto. Se DECLARA en vez de fingir
// precisión: un diff que miente sobre datos incompletos es peor que uno que
// avisa.
export function diffTurnos(turns) {
  const forma = (t) => {
    const s = t && t.request;
    if (!s) return null;
    const truncado = /\[RECORTADO:/.test(s);
    let parsed = null;
    try { parsed = JSON.parse(truncado ? s.split('\n…[RECORTADO:')[0] : s); } catch { parsed = null; }
    const msgs = (parsed && Array.isArray(parsed.messages)) ? parsed.messages : null;
    return {
      // El tamaño REAL si se guardó; el recortado solo como último recurso.
      // Medir sobre el recortado es lo que hacía que todos los diff dieran 0.
      bytes: t.request_bytes ?? s.length,
      truncado,
      mensajes: msgs ? msgs.length : null,
      roles: msgs ? msgs.map((m) => m && m.role).join(',') : null,
      // Las claves de los mensajes `assistant`: acá se ve si viaja `reasoning`
      // o `reasoning_details` de vuelta al proveedor.
      claves_assistant: msgs
        ? [...new Set(msgs.filter((m) => m && m.role === 'assistant').flatMap((m) => Object.keys(m)))].sort()
        : null,
      mensajes_tool: msgs ? msgs.filter((m) => m && m.role === 'tool').length : null,
      tool_call_ids: msgs
        ? msgs.filter((m) => m && m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap((m) => m.tool_calls.map((c) => c.id)).length
        : null,
      tool_result_ids: msgs ? msgs.filter((m) => m && m.role === 'tool' && m.tool_call_id).length : null,
    };
  };
  const out = [];
  for (let i = 1; i < turns.length; i++) {
    const a = forma(turns[i - 1]);
    const b = forma(turns[i]);
    if (!a || !b) continue;
    const cambios = [];
    for (const k of ['mensajes', 'roles', 'claves_assistant', 'mensajes_tool', 'tool_call_ids', 'tool_result_ids']) {
      const va = JSON.stringify(a[k]); const vb = JSON.stringify(b[k]);
      if (va !== vb) cambios.push({ campo: k, antes: a[k], despues: b[k] });
    }
    out.push({
      de: turns[i - 1].fase, a: turns[i].fase,
      proveedor: { antes: turns[i - 1].provider || null, despues: turns[i].provider || null },
      ms: { antes: turns[i - 1].ms ?? null, despues: turns[i].ms ?? null },
      bytes: { antes: a.bytes, despues: b.bytes, delta: b.bytes - a.bytes },
      // Si las llamadas pedidas y los resultados devueltos no coinciden, el
      // payload está roto y se ve acá sin leer nada más.
      descuadre_tool: b.tool_call_ids != null && b.tool_result_ids != null && b.tool_call_ids !== b.tool_result_ids
        ? { tool_calls: b.tool_call_ids, tool_results: b.tool_result_ids, nota: 'DESCUADRE: hay tool_calls sin su mensaje `tool`. Ese payload rompe en OpenAI-compatible.' }
        : null,
      cambios: cambios.length ? cambios : 'ninguno estructural',
      ...(a.truncado || b.truncado ? { aviso: 'uno de los dos cuerpos viene RECORTADO: el conteo de mensajes puede quedar corto. Subí el tope si hace falta precisión.' } : {}),
    });
  }
  return out;
}

// El colector. `null` es un sink válido en todas las firmas que lo aceptan, así
// que el camino normal no paga nada: sin `?trace=1` no se construye ni se
// recorre.
export function createTrace({ maxBytes = TRACE_MAX_BYTES, maxEntries = TRACE_MAX_ENTRIES, label = null } = {}) {
  const turns = [];
  let descartados = 0;
  return {
    label,
    get turns() { return turns; },
    get descartados() { return descartados; },

    // Una vuelta HTTP. `fase` dice DÓNDE del ciclo ocurrió: 'scan', 'loop',
    // 'cierre', 'reintento_sin_herramientas', 'retry_fechas'.
    push({ fase = null, provider = null, model = null, request = null, response = null, status = null, ms = null, threw = null, stack = null } = {}) {
      if (turns.length >= maxEntries) { descartados++; return; }
      turns.push({
        n: turns.length + 1, fase, provider, model, status, ms,
        // Los tamaños sin recortar, para que el diff mida lo que de verdad
        // viajó y no lo que cupo en la respuesta.
        request_bytes: tamanoReal(request),
        response_bytes: tamanoReal(response),
        // El cuerpo que SALIÓ. Es el dato que no teníamos y el que decide el
        // caso: si el payload de la vuelta 8 está mal formado, se ve acá.
        request: recortar(request, maxBytes),
        // El texto crudo que VOLVIÓ, antes de parsear. Si `JSON.parse` falló, es
        // lo único que queda.
        response: recortar(response, maxBytes),
        ...(threw ? { threw: String(threw) } : {}),
        ...(stack ? { stack: String(stack).slice(0, 2000) } : {}),
      });
    },

    // Lo que se devuelve en la respuesta del endpoint.
    report() {
      return {
        turnos: turns.length,
        descartados_por_tope: descartados,
        max_bytes_por_turno: maxBytes,
        nota: 'Cada turno trae el CUERPO HTTP que se envió y el TEXTO CRUDO que volvió, recortados. `fase` dice en qué parte del ciclo ocurrió la vuelta.',
        // EL DIFF, calculado acá y no a ojo. Con payloads de 36.000 caracteres
        // recortados a 4 KB, comparar la vuelta que falló contra la anterior
        // leyendo JSON en una terminal no es viable — y es justo la comparación
        // que decide el diagnóstico.
        diff_entre_turnos: diffTurnos(turns),
        turnos_detalle: turns,
      };
    },
  };
}
