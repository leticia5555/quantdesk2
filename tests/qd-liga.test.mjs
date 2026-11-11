// ═══════════════════════════════════════════════════════════════════════
// tests/qd-liga.test.mjs — LA TARJETA DE LA LIGA, UNA SOLA PARA DOS PANTALLAS
//
// La portada y `/mercado` pintan La Liga desde `/api/leaderboard` pasando por
// `qdLigaModelo`. Lo que se fija acá es lo que, mal hecho, haría que las dos
// pantallas digan cosas distintas o que una tabla de dinero invente algo:
//
//   1. el orden es el del servidor, y los SIN DATOS van al final sin puesto;
//   2. "sin datos" lleva su causa, y la causa es la MISMA que arma el
//      servidor para `/api/mercado-paneles` (son un espejo);
//   3. no se calcula ningún rendimiento: el número sale tal cual;
//   4. las dos pantallas leen `/api/leaderboard` y usan esta función.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { armaArena } from '../api/_lib/mercado-paneles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { qdLigaModelo, qdLigaCausa, qdLigaDia } = require(join(ROOT, 'qd-liga.js'));

const T3 = { id: 'T3', name: 'Temporada 3', start: '2026-10-20', end: '2026-11-18', abierta: true };
const ag = (id, ret, rank, extra = {}) => ({
  id, name: id.toUpperCase(), model_label: 'modelo-' + id, has_keys: true,
  account: { equity: 100000 }, baseline_equity: 100000, return_pct: ret, rank, ...extra,
});

test('la temporada se dice con su nombre y sus fechas, las del leaderboard', () => {
  const m = qdLigaModelo({ temporada: T3, agents: [ag('a', 1, 1)] });
  assert.equal(m.temporada, 'Temporada 3 · 20 oct → 18 nov');
  assert.equal(qdLigaModelo({ temporada: { ...T3, abierta: false }, agents: [ag('a', null, null)] }).temporada,
    'Temporada 3 · 20 oct → 18 nov · todavía no abre');
  assert.equal(qdLigaDia('2026-01-05'), '5 ene');
  assert.equal(qdLigaDia('basura'), null);
});

test('el orden es el `rank` del servidor, y el número NO se toca', () => {
  const m = qdLigaModelo({ temporada: T3, agents: [ag('c', -8.14, 3), ag('a', 1.02, 1), ag('b', -1.12, 2)] });
  assert.deepEqual(m.filas.map((f) => [f.id, f.puesto, f.pct]), [['a', 1, 1.02], ['b', 2, -1.12], ['c', 3, -8.14]]);
});

test('un modelo sin datos va AL FINAL, sin puesto y con su causa', () => {
  const m = qdLigaModelo({ temporada: T3, agents: [
    ag('mudo', null, 1, { account: null }),      // aunque el servidor le diera puesto
    ag('a', 1.02, 2),
  ] });
  assert.deepEqual(m.filas.map((f) => f.id), ['a', 'mudo']);
  const mudo = m.filas[1];
  assert.equal(mudo.sinDatos, true);
  assert.equal(mudo.puesto, null, 'sin datos no hay puesto: no se le compara con nadie');
  assert.equal(mudo.pct, null);
  assert.equal(mudo.causa, 'No se pudo leer su cuenta de Alpaca');
  assert.equal(mudo.empate, false, 'ni empate técnico');
  assert.equal(m.causaComun, null, 'con uno que sí tiene número no hay causa común');
});

test('cuando NINGUNO tiene número y todos por lo mismo, la causa va una vez', () => {
  const cerrada = [1, 2, 3].map((i) => ag('x' + i, null, null, { temporada_abierta: false }));
  const m = qdLigaModelo({ temporada: { ...T3, abierta: false }, agents: cerrada });
  assert.equal(m.causaComun, 'Temporada nueva sin arrancar · el reset no ha corrido');
  const mezcla = qdLigaModelo({ temporada: T3, agents: [
    ag('x', null, null, { has_keys: false }), ag('y', null, null, { account: null }) ] });
  assert.equal(mezcla.causaComun, null, 'con mezcla de causas cada fila dice la suya');
});

test('la causa es LA MISMA que arma el servidor para /api/mercado-paneles', () => {
  // `qdLigaCausa` es un espejo de `causaSinRetorno`, que es ESM de servidor.
  // Si una cambia y la otra no, esto se pone rojo.
  const casos = [
    { temporada_abierta: false, has_keys: true, equity: 1, baseline_equity: 1 },
    { has_keys: false },
    { has_keys: true, equity: null, baseline_equity: 1 },
    { has_keys: true, equity: 100, baseline_equity: null },
    { has_keys: true, equity: 100, baseline_equity: 100 },
  ];
  for (const c of casos) {
    const servidor = armaArena({ agents: [{ id: 'x', name: 'X', return_pct: null, ...c }] }).agentes[0];
    // El leaderboard publica el capital en `account.equity`; el espejo lee de ahí.
    const { equity, ...resto } = c;
    const cliente = qdLigaCausa({ ...resto, account: equity == null ? null : { equity } });
    assert.equal(cliente.clave, servidor.pct_clave, JSON.stringify(c));
    assert.equal(cliente.frase, servidor.pct_motivo, JSON.stringify(c));
  }
});

test('el índice va aparte, y la frase contra el índice es la del servidor', () => {
  const m = qdLigaModelo({ temporada: T3, agents: [ag('a', 1, 1)],
    benchmark: { name: 'S&P 500 · SPY', abierto: true, return_pct: -1.69 },
    margen_de_la_tabla: { indice: { lectura: '1 va por encima del índice (-1.69%).' } } });
  assert.deepEqual(m.indice, { nombre: 'S&P 500 · SPY', pct: -1.69, sinDatos: false, causa: null });
  assert.equal(m.lectura, '1 va por encima del índice (-1.69%).');
  assert.ok(!m.filas.some((f) => /S&P/.test(f.nombre)), 'el índice no es una fila más: no compite');
  const cerrado = qdLigaModelo({ temporada: T3, agents: [ag('a', 1, 1)], benchmark: { abierto: false, return_pct: null } });
  assert.equal(cerrado.indice.sinDatos, true);
  assert.match(cerrado.indice.causa, /reset/);
});

test('roto y vacío no son lo mismo, y los dos se dicen', () => {
  assert.match(qdLigaModelo({ error: 'HTTP 500', agents: [] }).error, /no se pudo leer la tabla: HTTP 500/);
  assert.equal(qdLigaModelo({ enabled: true, agents: [] }).vacio, 'el leaderboard no devolvió agentes');
  assert.equal(qdLigaModelo({ enabled: false, agents: [] }).vacio, 'la liga todavía no arranca');
  assert.equal(qdLigaModelo(null).vacio, 'el leaderboard no devolvió agentes', 'una respuesta nula no revienta');
});

test('la portada y /mercado leen /api/leaderboard y usan la MISMA función', () => {
  for (const pagina of ['portada.html', 'mercado.html']) {
    const html = readFileSync(join(ROOT, pagina), 'utf8');
    assert.match(html, /<script src="\/qd-liga\.js"><\/script>/, `${pagina} no carga qd-liga.js`);
    assert.match(html, /fetch\('\/api\/leaderboard'\)|pide\('\/api\/leaderboard'\)/, `${pagina} no lee /api/leaderboard`);
    assert.match(html, /qdLigaModelo\(/, `${pagina} no usa qdLigaModelo`);
  }
  const mercado = readFileSync(join(ROOT, 'mercado.html'), 'utf8');
  assert.doesNotMatch(mercado, /paneles\.arena/, '/mercado ya no arma La Liga desde /api/mercado-paneles');
  assert.doesNotMatch(mercado, /<h2>Arena<\/h2>/, 'el bloque se llama La Liga');
});
