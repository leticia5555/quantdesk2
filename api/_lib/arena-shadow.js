// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-shadow.js — MODO SOMBRA del Arena.
//
// Del martes 15 al viernes 18 la liga corre COMPLETA pero NO manda una sola
// orden a Alpaca. Todo lo demás pasa igual: el vigilante mira, los
// disparadores disparan, el PM decide, el guard valida, el titular se escribe
// y el journal guarda cada corrida con `shadow: true`.
//
// ── POR QUÉ NO BASTA CON APAGAR EL ARENA ─────────────────────────────
// `ARENA_ENABLED=0` apaga el endpoint entero: cero corridas, cero journal,
// cero evidencia. Eso sirve para un incendio, no para un ensayo. Lo que hace
// falta esta semana es JUSTO lo contrario: correr todo el arnés nuevo —modelos,
// buffet, lentes, vigilante— y poder leer al día siguiente qué habría hecho
// cada libro, sin que esas decisiones ensucien los libros que el lunes 21 se
// resetean a $100k. Un fill de sombra que quedara en la cuenta sería una
// posición heredada en la temporada nueva: exactamente la contaminación que el
// reset existe para evitar.
//
// ── DÓNDE MUERDE ─────────────────────────────────────────────────────
// En los DOS puntos de envío de arena-run.js, que son todos los que hay:
//   - `submitRiskExits()` — la red determinista (breaker, stop catastrófico,
//     trailing), que corre también dentro del vigilante vía runArenaRiskNet;
//   - el bucle de órdenes del PM en `runArenaDecide()`.
// NO muerde en `_lib/alpaca.js`: ese cliente es la frontera de la casa y lo
// usan también el smoke de venta y los paneles. Un flag del Arena no tiene por
// qué apagarle el smoke a nadie.
//
// ── LA ACCIÓN SOMBRA ─────────────────────────────────────────────────
// Una orden suprimida se journalea con `result: 'shadow'` — un valor PROPIO, no
// 'submit_failed' ni 'approved'. Importa que sea propio:
//   - 'approved' la contaría como enviada y `reconstructPositionOpens` podría
//     abrirle una posición fantasma al PM;
//   - 'submit_failed' la contaría como un stop que NO llenó, y
//     `escalationFromRiskRows` escalaría la banda de salida del día siguiente
//     por una orden que nunca existió.
// Con valor propio, los dos la ignoran solos y el post-mortem puede contarlas.
//
// ── EL APAGADO AUTOMÁTICO (punto 8) ──────────────────────────────────
// La sombra CADUCA sola el día del relanzamiento. Es deliberado que la fecha
// gane sobre la env var: el modo de fallar más caro de esta semana es que el
// lunes 21 alguien no borre `ARENA_SHADOW=1` en Vercel y la temporada real
// corra cuatro semanas sin mandar una orden, con todo el journal diciendo que
// sí decidió. Una env var olvidada no debe poder vaciar una temporada. Para
// extender la sombra más allá del 21 se mueve la FECHA
// (`ARENA_RELAUNCH_DATE`/`ARENA_SHADOW_UNTIL`), que es una decisión explícita.
//
// ENV VARS: ARENA_SHADOW (1 = sombra encendida) ·
//           ARENA_SHADOW_UNTIL (opc, default = relaunchDate(): el día en que la
//           sombra caduca sola, en horario del Este).
// ═══════════════════════════════════════════════════════════════

import { relaunchDate, easternDate } from './arena-relaunch.js';

// El día en que la sombra caduca (exclusivo: ese día YA se envían órdenes).
// Default: la fecha del relanzamiento, de su única función.
export function shadowUntilDate() {
  const raw = String(process.env.ARENA_SHADOW_UNTIL || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : relaunchDate();
}

// ¿Está la sombra activa AHORA? Env var encendida Y todavía antes del corte.
export function shadowActive(now = new Date()) {
  if (process.env.ARENA_SHADOW !== '1') return false;
  return easternDate(now) < shadowUntilDate();
}

// El bloque que viaja al journal (context.shadow). `expired` distingue las dos
// razones de NO estar en sombra: nunca se encendió, o se encendió y ya caducó
// — que es justo lo que se quiere ver en la fila del lunes 21.
export function shadowState(now = new Date()) {
  const flagged = process.env.ARENA_SHADOW === '1';
  const until = shadowUntilDate();
  const active = shadowActive(now);
  return {
    active,
    flag: flagged,
    until,
    ...(flagged && !active ? { expired: true } : {}),
    ...(active ? { note: `modo SOMBRA: la decisión y el journal corren completos, el envío a Alpaca está suprimido hasta ${until}` } : {}),
  };
}

// Una orden que NO se envió. Conserva TODO lo que la orden real habría
// journaleado (símbolo, lado, qty, límite, razonamiento, atribución) para que
// el post-mortem pueda comparar la semana de sombra con las reales — lo único
// que falta es lo que solo Alpaca puede dar: el id y el estado de la orden.
export function shadowAction(action, { runDate, clientOrderId } = {}) {
  return {
    ...action,
    result: 'shadow',
    shadow: true,
    // El id que HABRÍA llevado: hace la fila reproducible y deja ver que no
    // hay colisión de ids cuando la sombra se apague.
    client_order_id: clientOrderId || (runDate ? `arena:${runDate}:${action.symbol}:${action.side}` : null),
    reason: 'modo SOMBRA: orden NO enviada a Alpaca (la decisión, el guard y el journal corrieron completos)',
  };
}
