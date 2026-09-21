// ═══════════════════════════════════════════════════════════════
// api/_lib/historia-http.js — que un 500 en /api/ salga como JSON.
//
// ── EL BUG QUE LO MOTIVA (2026-09-21) ───────────────────────────────
// `GET /api/historia-harvest` sin `?job=` —la puerta de diagnóstico, la que
// dice qué llaves están configuradas— tiraba 500. La causa fue un
// `export … from` que re-exporta pero NO crea binding local, así que
// `llavesConfiguradas` quedó sin definir en el módulo; la rama de diagnóstico
// la usaba y las otras no, por eso solo se caía ésa.
//
// Lo que convirtió un bug de una línea en media hora perdida fue la forma del
// error: Vercel devuelve su página HTML, y todo esto se consume con `jq`. Un
// `ReferenceError` con nombre y todo llegaba como "parse error: Invalid
// numeric literal", que no dice absolutamente nada.
//
// Un error legible es la diferencia entre leerlo y adivinarlo. El envoltorio
// garantiza que cualquier excepción salga como JSON con su motivo.
//
// ── POR QUÉ EL MOTIVO VA, Y NO UN "error interno" ───────────────────
// La tentación de tapar el mensaje es real, pero el genérico deja al operador
// exactamente donde estaba: sabiendo que algo falló y nada más — que es el
// mismo problema que esto viene a arreglar. Va el tipo y el mensaje, sin
// stack, y pasados por un tamiz que borra lo que parece secreto (una URL con
// credenciales, una llave tipo `sk-…`, un token largo). El mensaje de un
// ReferenceError es exactamente lo que hace falta y no es secreto de nadie.
// ═══════════════════════════════════════════════════════════════

// Lo que nunca sale en una respuesta, aunque venga adentro del mensaje de
// error. Neon mete la URL completa en algunos errores de conexión, y esa URL
// trae la contraseña.
export function sinSecretos(texto) {
  return String(texto == null ? '' : texto)
    // usuario:contraseña@host en cualquier URL
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, '$1***:***@')
    // llaves con prefijo reconocible
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    // cualquier cosa larga que parezca un token o un hash
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
    .slice(0, 400);
}

// Envuelve un handler para que TODA excepción salga como JSON.
//
// `res.headersSent` se mira porque un handler que ya empezó a escribir no se
// puede rescatar: ahí lo único honesto es cortar, no pisar media respuesta
// con un JSON que el cliente va a pegar al final de lo anterior.
export function conErrorJson(handler, { ruta = null } = {}) {
  return async function envuelto(req, res) {
    try {
      return await handler(req, res);
    } catch (e) {
      if (res.headersSent) throw e;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).json({
        error: 'error interno',
        // El tipo y el mensaje, que es lo que se necesita para arreglarlo.
        // Un "error interno" pelado deja al operador donde estaba.
        tipo: (e && e.constructor && e.constructor.name) || 'Error',
        detalle: sinSecretos((e && e.message) || String(e)),
        ...(ruta ? { ruta } : {}),
      });
    }
  };
}
