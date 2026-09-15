// ═══════════════════════════════════════════════════════════════
// api/_lib/model.js — modelo de IA, UN solo lugar.
//
// El retiro de claude-sonnet-4-20250514 (15 jun 2026) tumbó SIM, EARNINGS,
// SMART $ y los 6 agentes a la vez porque el ID estaba hardcodeado en 26
// sitios. Ahora el próximo cambio de modelo es una env var en Vercel
// (ANTHROPIC_MODEL) o una línea aquí — nunca más un grep de 26 archivos.
//
// Default: claude-haiku-4-5 (decisión de producto 2026-07-15) — las
// llamadas de la app son generación de JSON corto (150-2000 tokens),
// el perfil exacto de Haiku: el más barato y rápido del catálogo vigente.
// ═══════════════════════════════════════════════════════════════

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// ── El modelo del ARENA, aparte y a propósito (2026-09-15) ───────────
// La liga sube a Claude Fable 5.1; el RESTO de la app se queda en Haiku.
// Son dos perillas separadas porque el blast radius es distinto: apuntar
// ANTHROPIC_MODEL a Fable subiría sim, earnings, Smart $ y los 6 agentes de la
// flota de $1/$5 a $10/$50 por MTok sin que nadie lo haya pedido. El Arena es
// un experimento de 7 cuentas paper; la app es el producto.
//
// Vive ACÁ y no en _lib/arena-registry.js por la cicatriz de siempre: el
// retiro de claude-sonnet-4-20250514 tumbó la IA entera porque el ID estaba en
// 26 sitios, y el lint de tests/claude-model.test.mjs existe para que no vuelva
// a pasar. Un ID de modelo nuevo no se escribe fuera de este archivo, ni
// siquiera "solo esta vez".
const ARENA_ANTHROPIC_MODEL = process.env.ARENA_CLAUDE_MODEL || 'claude-fable-5-1';

// Precio por MILLÓN de tokens del catálogo de Anthropic. Solo se usa para
// REPORTAR el costo del Arena (el smoke y el journal); ninguna decisión depende
// de esta tabla. Un modelo ausente devuelve costo null — jamás un precio
// supuesto, que es peor que no tener número.
//
// Actualizada: 2026-09-15. Si un precio cambia y esta tabla no, el costo
// reportado miente: la fecha está acá para que se note.
const ANTHROPIC_PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cache_read: 0.25 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export { ANTHROPIC_MODEL, ARENA_ANTHROPIC_MODEL, ANTHROPIC_PRICES };
