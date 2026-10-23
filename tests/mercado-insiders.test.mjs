// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-insiders.test.mjs — R5: todas las transacciones del Form 4.
//
// LAS TRES QUE MÁS IMPORTAN:
//
//   · "LE QUEDAN" NO SE INVENTA. Un filing sin `sharesOwnedFollowing` da
//     null con su causa, NUNCA cero — y cero es la afirmación más fuerte de
//     la pantalla ("vendió todo"). Confundirlas es acusar a alguien de
//     salirse de su empresa por un campo que no venía.
//   · EL TAMAÑO ES LO QUE SE MUEVE, no la tenencia. Es la cicatriz de TSLA:
//     leer `share` en vez de `change` infló un renglón a $287 mil millones.
//   · EL NETO SÓLO SUMA LO QUE TIENE PRECIO. Un otorgamiento sin precio no
//     es dinero que entró; contarlo como cero ensuciaría el neto sin que se
//     note.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  form4Completo, filasDeForm4, duenosDe, tipoDeCodigo, topDeLaSemana,
  filtraFilas, CHIPS, CODIGOS,
} from '../api/_lib/form4.js';
import { FORM4_COMPLETO, FORM4_CON_NAMESPACE } from './fixtures/form4.mjs';

const META = { accession: '0000320193-26-000111', updated: '2026-10-16T18:04:00-04:00',
               link: 'https://www.sec.gov/Archives/edgar/data/320193/x.html' };
const doc = form4Completo(FORM4_COMPLETO);
const filas = filasDeForm4(doc, META);

// ── EL PARSER ────────────────────────────────────────────────────────
test('lee TODAS las transacciones, no sólo las compras', () => {
  // El parser de TRACKER se queda con `code === 'P'` a propósito; éste no.
  assert.equal(doc.transacciones.length, 5);
  assert.deepEqual(doc.transacciones.map((t) => t.codigo), ['P', 'S', 'A', 'F', 'M']);
});

test('y la derivada (la opción) entra con su marca', () => {
  const m = doc.transacciones.find((t) => t.codigo === 'M');
  assert.equal(m.derivada, true, 'vive en la tabla de derivadas');
  assert.equal(m.tipo, 'opcion');
  assert.ok(doc.transacciones.filter((t) => !t.derivada).length === 4);
});

test('cada código dice qué fue, en español', () => {
  assert.equal(tipoDeCodigo('P').nombre, 'Compra en mercado abierto');
  assert.equal(tipoDeCodigo('F').tipo, 'impuesto');
  assert.equal(tipoDeCodigo('D').tipo, 'venta', 'la venta a la emisora sigue siendo una venta');
});

test('un código DESCONOCIDO se reporta como tal, no se adivina por el signo', () => {
  // Adivinar por el signo es como un otorgamiento termina contado como
  // compra de mercado abierto, que es la señal que la gente mira.
  const r = tipoDeCodigo('Z');
  assert.equal(r.tipo, 'otro');
  assert.match(r.nombre, /Código Z/);
  assert.ok(!Object.keys(CODIGOS).includes('Z'));
});

// ── "LE QUEDAN" ──────────────────────────────────────────────────────
test('"le quedan" sale del filing, y el cero es un cero DECLARADO', () => {
  const venta = doc.transacciones.find((t) => t.codigo === 'S');
  assert.equal(venta.le_quedan, 0);
  assert.equal(venta.salio_del_todo, true, 'con 0 declarado sí se puede afirmar');
});

test('sin tenencia posterior va null CON su causa, NUNCA cero', () => {
  const imp = doc.transacciones.find((t) => t.codigo === 'F');
  assert.equal(imp.le_quedan, null);
  assert.equal(imp.salio_del_todo, false, 'null no es "vendió todo"');
  assert.match(imp.le_quedan_motivo, /no declaró la tenencia posterior/);
});

// ── EL TAMAÑO ────────────────────────────────────────────────────────
test('el valor es lo que SE MOVIÓ por su precio, no la tenencia (cicatriz TSLA)', () => {
  const venta = doc.transacciones.find((t) => t.codigo === 'S');
  // 12,000 acciones × $52 = $624,000. Si usara la tenencia posterior (0) o
  // la previa, el número sería otro — y en el caso real, mil veces mayor.
  assert.equal(venta.valor, 624000);
  assert.equal(venta.acciones, 12000);
});

test('un otorgamiento sin precio NO vale cero: vale null con su causa', () => {
  const a = doc.transacciones.find((t) => t.codigo === 'A');
  assert.equal(a.valor, null);
  assert.match(a.valor_motivo, /no declaró precio/);
});

// ── LOS DUEÑOS ───────────────────────────────────────────────────────
test('el cargo sale del filing; sin puesto declarado se dice el rol y por qué', () => {
  const ds = duenosDe(FORM4_COMPLETO);
  assert.equal(ds.length, 2);
  assert.equal(ds[0].cargo, 'Chief Financial Officer');
  assert.equal(ds[0].cargo_motivo, null);
  // El segundo es dueño del 10% y NO declaró puesto.
  assert.equal(ds[1].es_duenio_10, true);
  assert.equal(ds[1].cargo, 'Dueño del 10%');
  assert.match(ds[1].cargo_motivo, /no declaró el puesto/);
});

test('con varios firmantes se usa el que declaró rol y se dice cuántos firman', () => {
  assert.equal(filas[0].quien, 'Ruiz Ana');
  assert.equal(filas[0].firmantes, 2, 'el otro firmante no se pierde: se cuenta');
});

// ── LAS FILAS ────────────────────────────────────────────────────────
test('una fila por transacción, con la emisora, el link y la hora del filing', () => {
  assert.equal(filas.length, 5);
  assert.equal(filas[0].ticker, 'ACME');
  assert.equal(filas[0].emisora, 'Acme Corp');
  assert.equal(filas[0].link, META.link);
  // La HORA del filing, no sólo el día: la pantalla ordena por hora.
  assert.equal(filas[0].filing_en, META.updated);
  assert.equal(filas[0].filing_fecha, '2026-10-16');
});

test('la fecha de la OPERACIÓN y la del filing son distintas y viajan las dos', () => {
  // Entre una y otra hay hasta dos días hábiles; mezclarlas desordena la lista.
  const compra = filas.find((f) => f.codigo === 'P');
  assert.equal(compra.fecha, '2026-10-15');
  assert.equal(compra.filing_fecha, '2026-10-16');
});

test('la tenencia indirecta se declara con su naturaleza', () => {
  const a = filas.find((f) => f.codigo === 'A');
  assert.equal(a.indirecta, true);
  assert.equal(a.naturaleza, 'By trust');
});

test('el plan 10b5-1 viaja: una venta programada no es la misma señal', () => {
  assert.equal(doc.plan_10b5, true);
  assert.equal(filas[0].plan_10b5, true);
});

test('un XML con prefijo de namespace se lee igual', () => {
  const d2 = form4Completo(FORM4_CON_NAMESPACE);
  assert.equal(d2.emisora.ticker, 'NSPC');
  assert.equal(d2.transacciones.length, 1);
  assert.equal(d2.transacciones[0].le_quedan, 300);
  assert.equal(d2.duenos[0].cargo, 'Director');
});

test('lo que no es un Form 4 devuelve null; un Form 4 vacío devuelve cero filas', () => {
  // Son dos cosas distintas: una se arregla cambiando la fuente y la otra no
  // se arregla porque no está rota.
  assert.equal(form4Completo('<html>nope</html>'), null);
  const vacio = form4Completo('<ownershipDocument><issuer><issuerName>X</issuerName></issuer></ownershipDocument>');
  assert.ok(vacio);
  assert.deepEqual(vacio.transacciones, []);
});

// ── EL TOP DE LA SEMANA ──────────────────────────────────────────────
test('el neto suma compras y resta ventas, y sólo cuenta lo que tiene precio', () => {
  const t = topDeLaSemana(filas);
  const g = t.grupos[0];
  // +50,250 (compra) − 624,000 (venta) = −573,750. El otorgamiento sin
  // precio NO entra, y el de impuestos tampoco (no es compra ni venta).
  assert.equal(g.neto_usd, 50250 - 624000);
  assert.equal(g.compras, 1);
  assert.equal(g.ventas, 1);
});

test('"vendió todo" es por PERSONA, no por ticker', () => {
  const t = topDeLaSemana(filas);
  assert.deepEqual(t.grupos[0].vendio_todo, ['Ruiz Ana']);
});

test('sin una sola operación con precio, el neto es null con su causa, no cero', () => {
  const soloOtorgamientos = filas.filter((f) => f.codigo === 'A');
  const t = topDeLaSemana(soloOtorgamientos);
  assert.equal(t.grupos[0].neto_usd, null);
  assert.match(t.grupos[0].neto_motivo, /ninguna compra ni venta/);
});

test('el top ordena por tamaño del neto en valor absoluto: una venta grande importa', () => {
  const otras = filasDeForm4(form4Completo(FORM4_CON_NAMESPACE), { accession: 'x', updated: '2026-10-11T10:00:00Z' });
  const t = topDeLaSemana([...filas, ...otras]);
  assert.equal(t.tickers, 2);
  assert.equal(t.grupos[0].ticker, 'ACME', 'el neto de −573,750 pesa más que el de +3,000');
});

// ── LOS CHIPS ────────────────────────────────────────────────────────
test('los cinco chips del artboard, y "Venta propuesta" declarada sin fuente', () => {
  assert.deepEqual(CHIPS.map((c) => c.id),
    ['compra', 'venta', 'opcion', 'venta_propuesta', 'duenio_10']);
  const vp = CHIPS.find((c) => c.id === 'venta_propuesta');
  assert.equal(vp.sin_fuente, true);
  // El Form 4 reporta lo que YA pasó; la venta propuesta es un Form 144.
  assert.match(vp.motivo, /Form 144/);
});

test('sin chips activos se ven TODAS: ése es el default del encargo', () => {
  assert.equal(filtraFilas(filas, { chips: [] }).length, 5);
});

test('un chip filtra por tipo, y "Dueño 10%" filtra por QUIÉN', () => {
  assert.equal(filtraFilas(filas, { chips: ['compra'] }).length, 1);
  assert.equal(filtraFilas(filas, { chips: ['compra', 'venta'] }).length, 2);
  assert.equal(filtraFilas(filas, { chips: ['opcion'] }).length, 1);
  // En este filing el líder es la CFO, no el dueño del 10%: cero filas.
  assert.equal(filtraFilas(filas, { chips: ['duenio_10'] }).length, 0);
});

test('el chip sin fuente NO filtra nada: no puede fingir que buscó', () => {
  // Si filtrara por una lista vacía devolvería cero filas y parecería que
  // "no hubo ventas propuestas", cuando lo cierto es que no las miramos.
  assert.equal(filtraFilas(filas, { chips: ['venta_propuesta'] }).length, 5);
});

test('la búsqueda alcanza ticker, emisora, quién y cargo', () => {
  assert.equal(filtraFilas(filas, { q: 'acme' }).length, 5);
  assert.equal(filtraFilas(filas, { q: 'ruiz' }).length, 5);
  assert.equal(filtraFilas(filas, { q: 'financial' }).length, 5);
  assert.equal(filtraFilas(filas, { q: 'zzz' }).length, 0);
});
