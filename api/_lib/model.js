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

export { ANTHROPIC_MODEL };
