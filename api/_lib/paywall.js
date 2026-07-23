// ═══════════════════════════════════════════════════════════════
// _lib/paywall.js — kill-switch global del paywall.
//
// Un solo flag de entorno decide si el paywall existe:
//
//   PAYWALL_ENABLED = 'true'   → paywall ACTIVO (comportamiento normal:
//                                3 validaciones/día free, límite de agentes,
//                                verificación Stripe, modal de upsell).
//   PAYWALL_ENABLED ausente / cualquier otra cosa (false, '0', '')
//                              → paywall APAGADO: TODO usuario es Pro,
//                                sin límites, sin modal.
//
// Diseñado para fase de testing: abre la app entera como Pro sin borrar
// nada del código de Stripe/checkout/webhook. Se reactiva poniendo la env
// var en 'true' cuando toque monetizar.
//
// El default (ausente ⇒ apagado) es deliberado: mientras no exista la env
// var, la app queda abierta.
// ═══════════════════════════════════════════════════════════════

// ¿Está el paywall activo? Solo el string 'true' (sin importar mayúsculas
// ni espacios) lo enciende; todo lo demás lo deja apagado.
export function paywallEnabled() {
  const raw = process.env.PAYWALL_ENABLED;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

export default paywallEnabled;
