// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-limpia-entidades.test.mjs
//
// EL 500 QUE SE FUE A PRODUCCIÓN. La limpieza hacía los reemplazos sobre
// `filas::text` —el documento JSON entero como cadena— con este argumento
// escrito en el comentario: "un `&` no necesita escape en JSON, así que el
// reemplazo no puede romper el documento".
//
// Cierto para `&amp;`. Falso para `&quot;`: decodificarlo adentro de un
// string JSON mete una comilla sin escapar y parte el string en dos. Postgres
// devolvió "invalid input syntax for type json" y las 79 filas candidatas se
// quedaron sin escribir, las dos veces (Lety, 2026-10-21).
//
// Y la prueba contra Postgres lo dejó pasar porque su fila sucia traía
// `&amp;` y `&apos;`: el apóstrofo es válido suelto en JSON. El fixture no
// cubría el único caso que rompía.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { limpiaDocumento, limpiaFilas } from '../api/stock-tracker.js';
import { desentidad } from '../api/_lib/form4.js';

const A = String.fromCharCode(38);        // el `&`, sin escribirlo literal
const QUOT = `${A}quot;`;
const NUM39 = `${A}#39;`;

test('POR QUÉ NO SE PARCHEA EL TEXTO: `&quot;` rompe el documento', () => {
  // Esta prueba no mide nuestro código: mide la premisa que estaba mal, para
  // que nadie vuelva a "simplificar" la limpieza a un replace sobre el texto.
  const doc = JSON.stringify([{ cargo: `VP ${QUOT}Ops${QUOT}` }]);
  const parcheado = doc.split(QUOT).join('"');
  assert.throws(() => JSON.parse(parcheado), /JSON/,
    'reemplazar sobre el texto del JSON produce un documento inválido');
  // Y por valor sale bien.
  const { limpio } = limpiaDocumento(JSON.parse(doc));
  assert.equal(limpio[0].cargo, 'VP "Ops"');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(limpio)));
});

test('decodifica strings a cualquier profundidad', () => {
  const doc = { a: [{ b: { c: `X ${A}amp; Y` } }], d: `Z ${QUOT}q${QUOT}` };
  const { limpio, cambios } = limpiaDocumento(doc);
  assert.equal(limpio.a[0].b.c, 'X & Y');
  assert.equal(limpio.d, 'Z "q"');
  assert.equal(cambios, 2);
});

test('lo que no es string conserva su tipo', () => {
  const doc = { n: 12345.67, b: true, z: null, s: `a ${A}amp; b` };
  const { limpio } = limpiaDocumento(doc);
  assert.equal(typeof limpio.n, 'number');
  assert.equal(limpio.n, 12345.67);
  assert.equal(limpio.b, true);
  assert.equal(limpio.z, null);
  assert.equal(limpio.s, 'a & b');
});

test('la numérica del apóstrofo también', () => {
  const { limpio } = limpiaDocumento({ quien: `O${NUM39}Brien` });
  assert.equal(limpio.quien, "O'Brien");
});

test('un documento sin entidades reporta 0 cambios y no se reescribe', () => {
  const doc = { cargo: 'Chief Executive Officer', n: 1 };
  const { limpio, cambios } = limpiaDocumento(doc);
  assert.equal(cambios, 0);
  assert.deepEqual(limpio, doc);
});

test('las llaves también se decodifican', () => {
  const { limpio, cambios } = limpiaDocumento({ [`a${A}amp;b`]: 1 });
  assert.deepEqual(Object.keys(limpio), ['a&b']);
  assert.equal(cambios, 1);
});

test('el mismo decodificador que el parser: una fila limpiada queda como una recién parseada', () => {
  // Si hubiera dos implementaciones del decodificado, se separarían, y
  // entonces "ya se limpió" dejaría de significar "está como si lo
  // hubiéramos parseado bien". Por eso `limpiaDocumento` importa `desentidad`.
  const crudo = `EVP, CFO ${A}amp; COO`;
  assert.equal(limpiaDocumento({ cargo: crudo }).limpio.cargo, desentidad(crudo));
});

// ── EL AISLAMIENTO POR FILA ────────────────────────────────────────────
// Lety: *"que el error de una fila no tumbe a las demás: limpia por fila y
// reporta cuáles fallaron"*. La versión que falló hacía un `update` masivo:
// una fila mala y las 79 se quedaban sin escribir.

test('la fila que falla se reporta y las demás se limpian igual', async () => {
  const filas = [
    { id: 'a', valor: { cargo: `A ${A}amp; B` } },
    { id: 'MALA', valor: { cargo: `C ${QUOT}D${QUOT}` } },
    { id: 'c', valor: { cargo: `E ${NUM39}F${NUM39}` } },
  ];
  const escritas = [];
  const r = await limpiaFilas(filas, async (id, limpio) => {
    if (id === 'MALA') throw new Error('Neon: invalid input syntax for type json');
    escritas.push([id, limpio.cargo]);
  });
  assert.deepEqual(r.limpias, ['a', 'c'], 'las buenas se escribieron');
  assert.deepEqual(escritas, [['a', 'A & B'], ['c', "E 'F'"]]);
  assert.equal(r.fallidas.length, 1);
  assert.equal(r.fallidas[0].id, 'MALA');
  assert.match(r.fallidas[0].error, /invalid input syntax/,
    'se reporta la causa, no sólo que falló');
});

test('la fila sin cambios no se escribe, pero se distingue de la que falló', async () => {
  const filas = [
    { id: 'limpia', valor: { cargo: 'Chief Executive Officer' } },
    { id: 'sucia', valor: { cargo: `X ${A}amp; Y` } },
  ];
  const escritas = [];
  const r = await limpiaFilas(filas, async (id) => { escritas.push(id); });
  assert.deepEqual(r.sin_cambio, ['limpia']);
  assert.deepEqual(r.limpias, ['sucia']);
  assert.deepEqual(escritas, ['sucia'], 'no se escribe lo que no cambió');
  assert.deepEqual(r.fallidas, []);
});

test('la fila que falla queda SIN marca, así que la próxima corrida la reintenta', async () => {
  // Es la diferencia entre "se reporta" y "se pierde": sin marca, vuelve a
  // ser candidata. Con marca, quedaría sucia para siempre y en silencio.
  const r = await limpiaFilas([{ id: 'x', valor: { c: `${A}amp;` } }],
    async () => { throw new Error('se cayó la red'); });
  assert.deepEqual(r.limpias, []);
  assert.deepEqual(r.sin_cambio, []);
  assert.equal(r.fallidas[0].id, 'x');
});
