// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-home.test.mjs — R8: /mercado pasa a ser la home.
//
// Es el cambio más hacia afuera de todo el encargo: lo que ve alguien que
// escribe el dominio a secas. Por eso lo que se prueba acá no es el diseño
// —eso lo mira el Chromium— sino las DOS cosas que, mal hechas, no se
// pueden deshacer:
//
//   1. QUE NADA SE BORRE. El encargo lo dice con todas las letras. La
//      landing sigue alcanzable y `app.html` también: cambian de lugar, no
//      de existencia.
//   2. QUE EL REDIRECT DE /hoy SEA TEMPORAL. Un 301 se queda cacheado en el
//      navegador de cada lector durante meses; si mañana decidimos que /hoy
//      vuelve, quien ya lo visitó seguiría yendo a /mercado sin forma de
//      arreglarlo desde el servidor. Un 307 se puede deshacer.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const rw = vercel.rewrites || [];
const red = vercel.redirects || [];
const porFuente = (lista, s) => lista.find((r) => r.source === s);

test('la raíz sirve el mapa', () => {
  const r = porFuente(rw, '/');
  assert.ok(r, 'no hay rewrite para /');
  assert.equal(r.destination, '/mercado.html');
});

test('y la landing NO se borra: sigue alcanzable en /inicio', () => {
  // "Nada se borra" es textual en el encargo. La landing deja de ser la
  // puerta, no deja de existir.
  const r = porFuente(rw, '/inicio');
  assert.ok(r, 'la landing se quedó sin ruta');
  assert.equal(r.destination, '/index.html');
});

test('/hoy redirige al mapa, y el redirect es TEMPORAL', () => {
  const r = porFuente(red, '/hoy');
  assert.ok(r, 'no hay redirect para /hoy');
  assert.equal(r.destination, '/mercado');
  // 307, no 301: un permanente se cachea en cada navegador y no se puede
  // deshacer desde el servidor.
  assert.equal(r.permanent, false, 'un 301 aquí sería irreversible para quien ya lo visitó');
});

test('la terminal sigue en /app y en /terminal: cambia de NOMBRE, no de sitio', () => {
  assert.equal(porFuente(rw, '/app').destination, '/app.html');
  assert.equal(porFuente(rw, '/terminal').destination, '/app.html');
});

test('el orden importa: la raíz va ANTES de cualquier comodín', () => {
  // Vercel toma el PRIMER rewrite que casa. Una regla general arriba de `/`
  // se la comería, y la home serviría otra cosa.
  const i = rw.findIndex((r) => r.source === '/');
  const comodin = rw.findIndex((r) => /:\w+|\*/.test(r.source));
  assert.ok(i >= 0);
  if (comodin >= 0) assert.ok(i < comodin, `la raíz está en ${i} y un comodín en ${comodin}`);
});

test('las seis rutas de /mercado siguen declaradas', () => {
  for (const ruta of ['/mercado', '/mercado/noticias', '/mercado/indice/:idx',
                      '/mercado/insiders', '/analiza/:ticker']) {
    assert.ok(porFuente(rw, ruta), `falta la ruta ${ruta}`);
  }
});

test('la home ofrece la terminal completa, en el celular y en escritorio', () => {
  // El encargo: "Cada pantalla nueva tiene un botón 'Abrir la terminal
  // completa'". Siendo la home, no tenerlo dejaría a app.html sin puerta
  // desde el teléfono.
  const html = readFileSync(join(ROOT, 'mercado.html'), 'utf8');
  assert.match(html, /id="modo-experto"/, 'falta el enlace de escritorio');
  assert.match(html, /Modo experto/, 'el encargo lo llama así');
  assert.match(html, /Abrir la terminal completa/, 'falta el botón del celular');
  assert.match(html, /abrir-terminal/);
});

test('los dos enlaces apuntan a la terminal, no a otra parte', () => {
  const html = readFileSync(join(ROOT, 'mercado.html'), 'utf8');
  const experto = /id="modo-experto" href="([^"]+)"/.exec(html);
  assert.ok(experto, 'no encontré el href de Modo experto');
  assert.equal(experto[1], '/app');
  assert.match(html, /id="abrir-terminal" href="\/app"/);
});
