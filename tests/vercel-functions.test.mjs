// ═══════════════════════════════════════════════════════════════════
// tests/vercel-functions.test.mjs — cada patrón de `functions` en
// vercel.json tiene que ser EL patrón de al menos una función real.
//
// EL BUG QUE CIERRA. Del 18-oct en adelante ningún deploy llegó a
// producción (#278, #279, #280) con:
//   The pattern "api/libro.js" defined in `functions` doesn't match any
//   Serverless Functions inside the `api` directory.
// api/libro.js SÍ existía. Lo que pasa es que Vercel le asigna a cada
// función el PRIMER patrón que la cubre, en el orden del objeto, y después
// exige que todo patrón haya sido asignado a alguien. "api/libro.js" quedó
// DEBAJO de "api/*.js": el comodín se lo quedaba y la entrada específica
// quedaba huérfana. Vercel valida esto antes de construir, así que un solo
// patrón huérfano tumba TODOS los deploys, no sólo el suyo.
//
// Es el mismo patrón que COLUMNAS_CORRIDA: una lista que nombra algo que no
// está. Aquí "no está" tiene dos formas — el archivo no existe, o existe
// pero un patrón anterior se lo come — y la prueba cubre las dos.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
const patrones = Object.keys(vercel.functions || {});

// Funciones que Vercel detecta en api/: .js no ocultos y sin prefijo `_`
// (api/_lib/ no es función). Sólo hay un nivel en este repo.
const funciones = readdirSync(new URL('../api/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.js') && !/^[._]/.test(d.name))
  .map((d) => `api/${d.name}`);

// Glob mínimo: `*` no cruza `/`, `**` sí. Suficiente para lo que usa vercel.json.
function aRegex(glob) {
  const cuerpo = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${cuerpo}$`);
}

// Lo mismo que hace Vercel: a cada función, el primer patrón que la cubre.
export function patronesHuerfanos(pats, fns) {
  const usados = new Set();
  for (const f of fns) {
    const p = pats.find((x) => x === f || aRegex(x).test(f));
    if (p) usados.add(p);
  }
  return pats.filter((p) => !usados.has(p));
}

test('hay funciones y patrones que comparar (la prueba no pasa en vacío)', () => {
  assert.ok(funciones.length > 10, `sólo ${funciones.length} funciones en api/`);
  assert.ok(patrones.length > 10, `sólo ${patrones.length} patrones en vercel.json`);
});

test('ningún patrón de functions queda sin función (ni inexistente ni tapado)', () => {
  const huerfanos = patronesHuerfanos(patrones, funciones);
  const detalle = huerfanos.map((p) => {
    const existe = funciones.some((f) => aRegex(p).test(f));
    if (!existe) return `${p}: no hay archivo que coincida`;
    const tapa = patrones.find((x) => x !== p && funciones.some((f) => aRegex(p).test(f) && aRegex(x).test(f)));
    return `${p}: existe, pero "${tapa}" va antes y se lo queda — muévelo arriba`;
  });
  assert.deepEqual(detalle, [], `Vercel rechaza el deploy completo:\n  ${detalle.join('\n  ')}`);
});

test('el comparador detecta las dos formas del bug', () => {
  const fns = ['api/a.js', 'api/b.js'];
  assert.deepEqual(patronesHuerfanos(['api/a.js', 'api/*.js'], fns), []);
  assert.deepEqual(patronesHuerfanos(['api/*.js', 'api/a.js'], fns), ['api/a.js'], 'tapado por el comodín');
  assert.deepEqual(patronesHuerfanos(['api/zz.js', 'api/*.js'], fns), ['api/zz.js'], 'archivo inexistente');
});
