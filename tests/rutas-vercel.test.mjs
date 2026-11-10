// ═══════════════════════════════════════════════════════════════════════
// tests/rutas-vercel.test.mjs — LAS RUTAS RESPONDEN, Y SIRVEN LO QUE DICEN
//
// R9, regla uno: *"no borres ninguna página ni función. Solo se mueven cosas
// y se agregan ligas."* Y como prueba: *"Una comprobación de que las 4 rutas
// viejas (/app, /liga, /mercado, /calcula) responden 200."*
//
// POR QUÉ NO ALCANZA LEER `vercel.json`. Esto ya pasó, y pasó caro: el
// rewrite de `/` → `/mercado.html` está declarado desde R8 y NUNCA se aplicó
// en producción, porque **Vercel revisa el sistema de archivos ANTES de los
// rewrites** y en la raíz hay un `index.html`. Durante días `/` sirvió la
// calculadora mientras `vercel.json` decía otra cosa, y ninguna prueba podía
// verlo: las que había leían la configuración, que estaba bien.
//
// Y los arneses tampoco: su servidor falso aplica los rewrites EN LUGAR del
// sistema de archivos, o sea el orden inverso al de Vercel.
//
// Así que acá se levanta un servidor que resuelve EN EL ORDEN DE VERCEL
// —redirects, archivos, rewrites— y se piden las rutas de verdad. Lo que se
// mide es qué archivo sale, no qué dice la configuración.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));

/** ¿Hay un archivo estático que atienda esta ruta tal cual? */
async function archivoEstatico(ruta) {
  const candidatos = ruta === '/' ? ['index.html'] : [ruta.replace(/^\//, ''), ruta.replace(/^\//, '') + '.html'];
  for (const c of candidatos) {
    if (!c || c.includes('..')) continue;
    try { const st = await stat(join(ROOT, c)); if (st.isFile()) return c; } catch { /* el siguiente */ }
  }
  return null;
}

/** Un `source` de vercel.json con `:param` → expresión regular. */
const aRegExp = (fuente) => new RegExp('^' + fuente.replace(/:[^/]+/g, '[^/]+') + '$');

/**
 * EL ORDEN DE VERCEL, y es el punto de todo el archivo:
 *   1. redirects
 *   2. el sistema de archivos          ← acá murió el rewrite de `/`
 *   3. rewrites
 */
async function resuelve(ruta) {
  for (const r of vercel.redirects || []) {
    if (aRegExp(r.source).test(ruta)) return { tipo: 'redirect', a: r.destination, status: r.statusCode || 308 };
  }
  const est = await archivoEstatico(ruta);
  if (est) return { tipo: 'archivo', archivo: est, status: 200 };
  for (const r of vercel.rewrites || []) {
    if (aRegExp(r.source).test(ruta)) {
      const dest = r.destination.replace(/^\//, '').replace(/:[^/]+/g, '');
      return existsSync(join(ROOT, dest))
        ? { tipo: 'rewrite', archivo: dest, status: 200 }
        : { tipo: 'rewrite-roto', archivo: dest, status: 404 };
    }
  }
  return { tipo: 'nada', status: 404 };
}

const server = createServer(async (req, res) => {
  const r = await resuelve(new URL(req.url, 'http://l').pathname);
  if (r.tipo === 'redirect') { res.writeHead(r.status, { location: r.a }); return res.end(); }
  if (r.status !== 200) { res.writeHead(404); return res.end('no'); }
  const buf = await readFile(join(ROOT, r.archivo));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-archivo': r.archivo });
  res.end(buf);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

// Las cuatro que pidió el encargo, más las que no se pueden perder.
const RUTAS = [
  { url: '/app', archivo: 'app.html' },
  { url: '/liga', archivo: 'leaderboard.html' },
  { url: '/mercado', archivo: 'mercado.html' },
  { url: '/', archivo: 'portada.html' },
  { url: '/calcula', archivo: 'inicio.html' },
  { url: '/inicio', archivo: 'inicio.html' },
  // La dirección vieja del archivo: quien la tenga guardada sigue llegando a
  // la calculadora, que es lo que había ahí.
  { url: '/index.html', archivo: 'inicio.html' },
  { url: '/mercado/noticias', archivo: 'noticias.html' },
  { url: '/mercado/insiders', archivo: 'insiders.html' },
  { url: '/liga/libros', archivo: 'libros.html' },
  { url: '/liga/equity', archivo: 'equity.html' },
  { url: '/terminal', archivo: 'app.html' },
  { url: '/leaderboard', archivo: 'leaderboard.html' },
];

for (const r of RUTAS) {
  test(`${r.url} responde 200 y sirve ${r.archivo}`, async () => {
    const res = await fetch(`${BASE}${r.url}`, { redirect: 'manual' });
    assert.equal(res.status, 200, `${r.url} dio ${res.status}`);
    assert.equal(res.headers.get('x-archivo'), r.archivo,
      `${r.url} sirve ${res.headers.get('x-archivo')} y no ${r.archivo}`);
  });
}

test('/calcula y /inicio sirven LA MISMA calculadora, las dos vivas', async () => {
  // R9: *"La calculadora se muda, no se borra."* Y la regla uno dice que
  // `/inicio` tampoco se borra, así que las dos tienen que funcionar.
  const a = await fetch(`${BASE}/calcula`);
  const b = await fetch(`${BASE}/inicio`);
  const ta = await a.text(); const tb = await b.text();
  assert.equal(ta, tb, 'las dos rutas tienen que servir el mismo archivo');
  assert.match(ta, /Empieza a entender invirtiendo/, 'y ese archivo es la calculadora');
});

test('la calculadora no se le cambió nada: /calcula es un rewrite, no una copia', async () => {
  // *"pasa a su propia ruta, por ejemplo /calcula, SIN CAMBIARLE NADA"*. Dos
  // archivos iguales se separan al primer arreglo que se haga en uno.
  const fuentes = (vercel.rewrites || []).filter((x) => x.destination === '/inicio.html').map((x) => x.source);
  assert.deepEqual(fuentes.sort(), ['/calcula', '/index.html', '/inicio']);
  assert.ok(!existsSync(join(ROOT, 'calcula.html')),
    'no hay un calcula.html: sería una copia que se separa del original');
});

// ═════════════════════════════════════════════════════════════════════════
// EL DEFECTO QUE NADIE PODÍA VER: UN ARCHIVO QUE TAPA UN REWRITE
// ═════════════════════════════════════════════════════════════════════════

// `/` FUE el caso: `index.html` en la raíz le ganaba al rewrite de R8, así que
// `/` sirvió la calculadora durante días mientras `vercel.json` prometía el
// mapa. Se arregló en el PR 5 de R9 renombrando el archivo a `inicio.html`.
// La lista queda VACÍA y así se tiene que quedar.
const TAPADOS_CONOCIDOS = [];

test('ningún rewrite queda tapado por un archivo de la raíz', async () => {
  const tapados = [];
  for (const r of vercel.rewrites || []) {
    if (r.source.includes(':')) continue;           // las dinámicas no matchean archivo
    const est = await archivoEstatico(r.source);
    if (!est) continue;
    // Tapado sólo si el archivo que gana NO es el que el rewrite pedía.
    if ('/' + est !== r.destination) tapados.push(r.source);
  }
  assert.deepEqual(tapados.sort(), TAPADOS_CONOCIDOS.slice().sort(),
    'un rewrite tapado sirve otra página que la que dice vercel.json, y leyendo '
    + 'la configuración no se nota: Vercel revisa el sistema de archivos ANTES');
});

test('la lista de tapados conocidos no crece en silencio', () => {
  // Si alguien agrega uno a la lista para poner la prueba en verde, esto
  // también se pone rojo.
  assert.deepEqual(TAPADOS_CONOCIDOS, [],
    'desde el PR 5 de R9 no hay ningún tapado aceptado');
});

test('no hay un `index.html` en la raíz: es lo que tapaba a `/`', () => {
  // Vercel sirve `index.html` para `/` ANTES de mirar los rewrites. Si
  // alguien vuelve a crear uno, `/` deja de ser la portada sin que
  // `vercel.json` cambie una letra.
  assert.ok(!existsSync(join(ROOT, 'index.html')),
    'un index.html en la raíz le gana al rewrite de `/`');
});

test('`/` sirve la portada, y es lo que vercel.json dice', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.headers.get('x-archivo'), 'portada.html');
  const txt = await res.text();
  assert.doesNotMatch(txt, /Empieza a entender invirtiendo/, '`/` ya no es la calculadora');
  assert.match(txt, /id="lienzo"/, 'la portada lleva el mapa');
  const rw = (vercel.rewrites || []).find((x) => x.source === '/');
  assert.equal(rw.destination, '/portada.html');
});
