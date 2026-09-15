// ═══════════════════════════════════════════════════════════════
// data/universe/constituents.js — ESCALÓN 3 del universo (arranque en frío).
//
// ── POR QUÉ ESTO ES UN .js Y NO UN .json ─────────────────────────────
// Era un par de .json que se leían del disco con
// `new URL('../../data/universe/x.json', import.meta.url)`. Eso TUMBÓ
// PRODUCCIÓN:
//
//   /api/_lib/arena-universe.js:185
//   SyntaxError: Cannot use 'import.meta' outside a module
//
// Este repo no tiene package.json, así que un `.js` en /api NO es un módulo ESM
// para el runtime de Vercel: el código se transpila a CommonJS, y `import.meta`
// es lo único de ESM que NO tiene traducción a CJS — no existe un equivalente,
// así que el transpilador lo deja pasar y revienta al cargar el archivo. No
// falla en la función que lo usa: falla al IMPORTAR el módulo, o sea que se
// lleva puesto todo lo que dependa de él.
//
// Mudarlo a `process.cwd()` habría cambiado un problema por otro más callado:
// depende de que el bundler incluya archivos de datos, y si no los incluye la
// lectura falla en silencio y el escalón 3 queda muerto sin que nadie se entere.
//
// Un módulo importado estáticamente no tiene ninguno de los dos problemas: el
// bundler lo mete por definición, funciona igual en ESM y en CJS, y si faltara
// el build falla en vez de romper en producción.
//
// ── ESTÁ VACÍO A PROPÓSITO Y NO HACE FALTA LLENARLO ──────────────────
// El universo tiene tres fuentes: FMP (fresco, semanal) → Neon (se escribe SOLA
// en el mismo paso en que se baja de FMP) → esto. O sea que el escalón 3 solo
// se consulta si las dos primeras fallan EL MISMO DÍA. Una lista vacía no
// cuenta como respaldo (`readStatic` devuelve null), así que estar vacío es
// inofensivo por construcción.
//
// Si algún día querés congelar un snapshot: `GET /api/arena-universe?emit=1`
// devuelve los símbolos, y se pegan en el array de abajo. Es opcional.
// ═══════════════════════════════════════════════════════════════

export const CONSTITUENTS = {
  sp500: { index: 'sp500', source: 'seed', built_at: null, symbols: [] },
  nasdaq100: { index: 'nasdaq100', source: 'seed', built_at: null, symbols: [] },
};

export default CONSTITUENTS;
