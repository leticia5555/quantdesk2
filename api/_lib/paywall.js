// ═══════════════════════════════════════════════════════════════
// api/_lib/paywall.js — kill-switch central del paywall (fase testing).
//
// Un único gate DELANTE del paywall existente. NO borra nada de Stripe:
// checkout, webhook, status y portal quedan intactos y listos para
// reactivarse con un solo cambio de env var.
//
//   PAYWALL_ENABLED === 'true'  → paywall ACTIVO: comportamiento normal
//                                 (cuota free + verificación Stripe).
//   ausente / cualquier otro    → paywall APAGADO: TODO usuario es Pro,
//                                 sin límites, acceso completo.
//
// Default deliberado = APAGADO: durante testing la app abre entera. Para
// volver a cobrar, basta setear PAYWALL_ENABLED=true en Vercel (ver abajo).
//
// ENV VAR (Vercel → Settings → Environment Variables):
//   PAYWALL_ENABLED   'true' para activar el paywall; ausente/otra = off
// ═══════════════════════════════════════════════════════════════

export function paywallEnabled() {
  return process.env.PAYWALL_ENABLED === 'true';
}
