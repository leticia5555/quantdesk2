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
function patronDe(pats, f) {
  return pats.find((x) => x === f || aRegex(x).test(f));
}

export function patronesHuerfanos(pats, fns) {
  const usados = new Set(fns.map((f) => patronDe(pats, f)).filter(Boolean));
  return pats.filter((p) => !usados.has(p));
}

// El techo que Vercel CONCEDE, no el que el archivo o el catálogo creen tener.
function techoEfectivo(fnsConfig, f) {
  const p = patronDe(Object.keys(fnsConfig), f);
  return p ? fnsConfig[p].maxDuration : undefined;
}

// Un patrón literal debajo de un comodín que lo cubre está muerto, tenga o no
// archivo hoy. Es la regla de orden, independiente de qué hay en api/.
export function tapadosPorComodin(pats) {
  const malos = [];
  pats.forEach((p, i) => {
    if (/[*?]/.test(p)) return;
    const tapa = pats.slice(0, i).find((x) => /[*?]/.test(x) && aRegex(x).test(p));
    if (tapa) malos.push(`${p} (debajo de ${tapa})`);
  });
  return malos;
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

test('todo patrón específico va antes de cualquier comodín que lo cubriría', () => {
  assert.deepEqual(tapadosPorComodin(patrones), []);
});

// ── EL ARENA: 300s CONCEDIDOS, NO DECLARADOS ─────────────────────────
// La aritmética de relojes de arena-smoke ("loop + cierre + margen = 270s
// contra un deadline de 270s") se apoya en 300s de función. El catálogo
// reporta `funcion_max_duration_s` como LITERAL: si vercel.json le asignara
// otro patrón a un endpoint del Arena, el catálogo seguiría diciendo 300 y
// nada fallaría. Esta prueba resuelve el techo como lo resuelve Vercel.
// api/arena.js (lectura para la UI) NO es de este grupo: va al comodín de 60s
// a propósito, igual que antes de este cambio.
const arena = funciones.filter((f) => /^api\/arena-[^/]+\.js$/.test(f));

test('cada endpoint del Arena resuelve a su propio patrón con 300s', () => {
  assert.ok(arena.length >= 8, `sólo ${arena.length} endpoints arena-*.js`);
  const mal = arena
    .map((f) => [f, patronDe(patrones, f), techoEfectivo(vercel.functions, f)])
    .filter(([f, p, t]) => p !== f || t !== 300)
    .map(([f, p, t]) => `${f} → "${p}" @ ${t}s`);
  assert.deepEqual(mal, [], 'el Arena no tiene los 300s que su aritmética supone');
});

test('el catálogo de arena-smoke dice el techo que Vercel concede', () => {
  const src = readFileSync(new URL('../api/arena-smoke.js', import.meta.url), 'utf8');
  const m = /funcion_max_duration_s:\s*(\d+)/.exec(src);
  assert.ok(m, 'arena-smoke ya no reporta funcion_max_duration_s');
  for (const f of ['api/arena-smoke.js', 'api/arena-run.js']) {
    assert.equal(techoEfectivo(vercel.functions, f), Number(m[1]),
      `el catálogo dice ${m[1]}s pero Vercel le concede ${techoEfectivo(vercel.functions, f)}s a ${f}`);
  }
});

test('el comparador de orden detecta un literal debajo del comodín', () => {
  assert.deepEqual(tapadosPorComodin(['api/a.js', 'api/*.js']), []);
  assert.deepEqual(tapadosPorComodin(['api/*.js', 'api/a.js']), ['api/a.js (debajo de api/*.js)']);
});
