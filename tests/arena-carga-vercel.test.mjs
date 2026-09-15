// ═══════════════════════════════════════════════════════════════
// tests/arena-carga-vercel.test.mjs — que CADA archivo de api/ CARGUE.
//
// ── EL INCIDENTE (2026-09-15) ────────────────────────────────────────
// El merge del PR #136 rompió producción con dos errores que NINGUNA suite de
// este repo podía ver, porque los dos revientan al CARGAR el módulo y todas las
// suites importaban solo las funciones que probaban:
//
//   1. /api/_lib/arena-universe.js
//      SyntaxError: Cannot use 'import.meta' outside a module
//
//   2. /api/arena-run.js
//      TypeError: Cannot redefine property: ANTHROPIC_CACHE_MIN_TOKENS
//      → y como /api/arena-watch importa arena-run, EL VIGILANTE devolvió 500
//        en cada tick de 5 minutos. Muerto, sin una línea en el journal.
//
// La forma es la misma en los dos: **el archivo explota al importarse, no al
// usarse**. Un test que llama a `readStatic()` pasa en verde mientras el
// endpoint entero devuelve 500.
//
// ── HASTA DÓNDE LLEGA ESTE TEST, Y DÓNDE SE QUEDA CORTO ──────────────
// NO emula el cargador de Vercel, y conviene decir por qué en vez de fingir
// que sí. Lo intenté de dos formas y las dos FALLARON EN REPRODUCIR:
//
//   · esbuild a CJS: **shimea** `import.meta` a `{}` y solo tira un warning.
//     El arnés daba VERDE sobre el código exacto que estaba tumbando
//     producción. Un reproductor que esconde el bug es peor que no tenerlo.
//   · Babel a CJS: emite UN solo `defineProperty` por nombre re-exportado, así
//     que tampoco produce el "Cannot redefine property".
//
// Y medí el patrón que parecía culpable del error 2 —`import { X }` +
// `export { X }` del mismo binding—: hay 31 casos en api/ que llevan meses en
// producción sin romper, **incluido uno en el propio arena-run.js**. O sea que
// ese patrón NO es la causa, y prohibirlo sería superstición con forma de test.
//
// Así que este archivo hace lo que sí es verificable:
//
//   (A) IMPORTA todos los archivos de api/, uno por uno. Cubre la clase entera
//       de "el módulo revienta al cargarse" que Node puede ver: un throw en el
//       top level, un import roto, una constante que se evalúa mal. Es la red
//       que faltaba, y no existía.
//   (B) PROHÍBE las construcciones de ESM que literalmente NO tienen
//       traducción a CommonJS. Este repo no tiene package.json, así que un .js
//       en /api pasa por un transpilado a CJS y lo que no se puede representar
//       ahí no se usa acá. `import.meta` es la que rompió.
//   (C) Verifica el CONTRATO de Vercel: todo endpoint exporta un handler.
//
// Correr con `node tests/arena-carga-vercel.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const RAIZ = new URL('..', import.meta.url).pathname;
const API = join(RAIZ, 'api');

function archivosJs(dir) {
  const out = [];
  for (const nombre of readdirSync(dir).sort()) {
    const p = join(dir, nombre);
    if (statSync(p).isDirectory()) out.push(...archivosJs(p));
    else if (nombre.endsWith('.js')) out.push(p);
  }
  return out;
}
const archivos = archivosJs(API);
// Los endpoints son los .js de la RAÍZ de api/. Lo de _lib/ son módulos.
const endpoints = archivos.filter((f) => !relative(API, f).includes('/'));

// Los comentarios se sacan ANTES de buscar patrones. Sin esto el test se
// dispara con su propia explicación: arena-universe.js documenta el incidente y
// la palabra `import.meta` aparece ahí. Ya me pasó con un lint de `Math.random`
// que matcheaba el comentario que explicaba por qué no se usaba `Math.random`.
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

// ── (A) TODO ARCHIVO DE api/ TIENE QUE PODER IMPORTARSE ──────────────
console.log(`\n── (A) importar los ${archivos.length} archivos de api/ ──`);
const modulos = new Map();
{
  const rotos = [];
  for (const f of archivos) {
    try {
      modulos.set(f, await import(f));
    } catch (e) {
      rotos.push({ archivo: relative(RAIZ, f), error: `${e && e.constructor ? e.constructor.name : 'Error'}: ${(e && e.message) || e}` });
    }
  }
  ok(rotos.length === 0,
    'todos los archivos de api/ cargan sin reventar',
    rotos.length ? '\n' + JSON.stringify(rotos, null, 2) : undefined);
  ok(archivos.length > 20,
    'y el recorrido encontró de verdad el árbol de api/ (no una carpeta vacía)', String(archivos.length));
}

// ── (B) LO QUE NO SOBREVIVE AL TRANSPILADO A CommonJS ────────────────
console.log('\n── (B) construcciones de ESM que no tienen traducción a CJS ──');

// B1 · import.meta — LA CAUSA CONFIRMADA DEL ERROR 1.
// No hay forma de expresar "la URL de este módulo" en CommonJS. El
// transpilador o lo deja crudo —y el parser de V8 revienta con "Cannot use
// 'import.meta' outside a module", que es literalmente lo que pasó— o lo
// reemplaza por un objeto vacío, con lo cual la ruta que se calculaba a partir
// de él apunta a cualquier lado. Las dos salidas son malas y ninguna avisa a
// tiempo, así que acá no se usa.
//
// Ojo: ESTE archivo sí lo usa (`new URL('..', import.meta.url)`), y está bien:
// los tests corren con `node` directo, como ESM nativo, y nunca los toca
// Vercel. La prohibición es sobre api/.
{
  const culpables = archivos
    .filter((f) => /import\s*\.\s*meta/.test(sinComentarios(readFileSync(f, 'utf8'))))
    .map((f) => relative(RAIZ, f));
  ok(culpables.length === 0,
    'ningún archivo de api/ usa import.meta (tumbó /api/arena-universe el 2026-09-15)',
    culpables.join(', '));
}

// B2 · await de nivel superior.
// También es solo-ESM: en CJS no hay forma de esperar antes de devolver
// `module.exports`. Un módulo que se exporta a medias es peor que uno que no
// carga, porque falla más tarde y más lejos.
{
  const culpables = archivos
    .filter((f) => /^await\s/m.test(sinComentarios(readFileSync(f, 'utf8'))))
    .map((f) => relative(RAIZ, f));
  ok(culpables.length === 0,
    'ningún archivo de api/ usa await de nivel superior', culpables.join(', '));
}

// ── (C) EL CONTRATO DE VERCEL: todo endpoint exporta su handler ──────
// Un endpoint sin `export default function` deploya bien y devuelve 500 al
// primer request. Es la otra mitad de "carga pero no sirve".
console.log(`\n── (C) los ${endpoints.length} endpoints exportan un handler ──`);
{
  const sinHandler = [];
  for (const f of endpoints) {
    const m = modulos.get(f);
    if (!m) continue;   // ya lo reportó (A)
    if (typeof m.default !== 'function') sinHandler.push(relative(RAIZ, f));
  }
  ok(sinHandler.length === 0,
    'todo endpoint de api/ exporta por default una función handler', sinHandler.join(', '));

  // `maxDuration`, cuando se declara, tiene que ser un número que Vercel acepte.
  const malDuration = [];
  for (const f of endpoints) {
    const m = modulos.get(f);
    if (!m || m.maxDuration === undefined) continue;
    if (!Number.isFinite(m.maxDuration) || m.maxDuration <= 0 || m.maxDuration > 900) malDuration.push(`${basename(f)}=${m.maxDuration}`);
  }
  ok(malDuration.length === 0,
    'y el `maxDuration` declarado es un número plausible donde existe', malDuration.join(', '));
}

// ── (D) EL CANDADO DEL PROPIO TEST ───────────────────────────────────
// Un test que no puede fallar no protege nada.
console.log('\n── (D) los detectores detectan ──');
{
  ok(/import\s*\.\s*meta/.test(sinComentarios('const u = new URL("./x", import.meta.url);')),
    'B1 agarra un import.meta real');
  ok(!/import\s*\.\s*meta/.test(sinComentarios('// esto habla de import.meta y no cuenta\nconst a = 1;')),
    'y NO se dispara con la palabra dentro de un comentario de línea');
  ok(!/import\s*\.\s*meta/.test(sinComentarios('/* import.meta en bloque */\nconst a = 1;')),
    'ni dentro de un comentario de bloque');
  ok(/^await\s/m.test('await algo();'), 'B2 agarra un await de nivel superior');
  ok(!/^await\s/m.test('async function f() {\n  await algo();\n}'),
    'y no se dispara con un await adentro de una función');
  ok(endpoints.length > 10 && endpoints.every((f) => !relative(API, f).includes('/')),
    'la lista de endpoints son los .js de la raíz de api/, sin los de _lib/', String(endpoints.length));
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
