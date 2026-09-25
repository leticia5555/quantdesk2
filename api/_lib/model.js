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

// El MISMO modelo por la otra ruta. La sonda de transporte (2026-09-25) corre
// Fable por OpenRouter para separar "es el modelo" de "es la ruta", y eso pide
// el slug de OpenRouter, que no es el de Anthropic.
//
// Está acá y no en _lib/arena-registry.js porque el lint de
// tests/claude-model.test.mjs lo cazó ahí, y tenía razón: un ID de modelo
// nuevo no se escribe fuera de este archivo, ni siquiera para una sonda que
// arranca apagada. Es exactamente la frase de arriba, puesta a prueba.
//
// El default NO está verificado contra el catálogo: es la forma que OpenRouter
// usa, no un slug confirmado. Por eso el brazo lleva `slug_verified: false` y
// no corre hasta que `ARENA_MODEL_RUTA_OR` traiga el real, que lo resuelve
// `/api/arena-smoke?catalog=1`. Un slug adivinado produciría un aborto NUESTRO
// que la sonda reportaría como si fuera de la ruta.
const ARENA_OPENROUTER_CLAUDE_MODEL = process.env.ARENA_MODEL_RUTA_OR || 'anthropic/claude-fable-5.1';

// Precio por MILLÓN de tokens del catálogo de Anthropic. Solo se usa para
// REPORTAR el costo del Arena (el smoke y el journal); ninguna decisión depende
// de esta tabla. Un modelo ausente devuelve costo null — jamás un precio
// supuesto, que es peor que no tener número.
//
// Actualizada: 2026-09-15. Si un precio cambia y esta tabla no, el costo
// reportado miente: la fecha está acá para que se note.
// ── El modelo de HISTORIA, la tercera perilla (2026-09-20) ──────────
// Misma lógica que la del Arena y el mismo motivo: blast radius distinto.
// HISTORIA narra con Opus 5 porque la tarea es leer ~12k tokens de evidencia
// citada y escribir cinco secciones sin inventar una cita; la app sigue en
// Haiku y la liga en Fable. Apuntar ANTHROPIC_MODEL acá habría subido sim,
// earnings, Smart $ y los seis agentes de $1/$5 a $5/$25 sin que nadie lo
// pidiera.
//
// Vive ACÁ y no en _lib/historia-prompt.js por la cicatriz de siempre: el
// retiro de claude-sonnet-4-20250514 tumbó la IA entera porque el ID estaba
// en 26 sitios. Un ID de modelo nuevo no se escribe fuera de este archivo.
const HISTORIA_ANTHROPIC_MODEL = process.env.HISTORIA_CLAUDE_MODEL || 'claude-opus-5';

const ANTHROPIC_PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cache_read: 0.25 },
  // `cache_write` es 1,25× la entrada y `cache_read` 0,1×. Están acá porque
  // HISTORIA reporta el costo desglosado: sin separar la lectura de caché de
  // la entrada fresca no hay manera de saber si el prefijo congelado está
  // pegando, y se pagaría 10× de más sin que nada falle.
  'claude-opus-5': { in: 5, out: 25, cache_read: 0.5, cache_write: 6.25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export { ANTHROPIC_MODEL, ARENA_ANTHROPIC_MODEL, ARENA_OPENROUTER_CLAUDE_MODEL, HISTORIA_ANTHROPIC_MODEL, ANTHROPIC_PRICES };
