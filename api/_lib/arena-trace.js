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

export const TRACE_MAX_BYTES = 4096;
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

// `JSON.stringify` puede lanzar con referencias circulares o BigInt. Un trace
// que tumba la corrida que intenta explicar no sirve para nada.
function safeStringify(x) {
  try { return JSON.stringify(x); } catch (e) { return `[no serializable: ${String((e && e.message) || e)}]`; }
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
        turnos_detalle: turns,
      };
    },
  };
}
