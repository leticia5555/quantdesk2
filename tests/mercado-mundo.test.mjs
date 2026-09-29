// ═══════════════════════════════════════════════════════════════════════
// EL CATÁLOGO DE MUNDO — QUÉ SE PINTA, QUÉ NO, Y POR QUÉ
//
// Encargo §3/R2: cuatro regiones, un cuadro por índice, tamaño fijo. Lo que
// estas pruebas fijan es lo que NO se ve: los cuatro cruces de moneda que
// entraron como insumo del rendimiento en pesos no ocupan cuadro, y lo que el
// endpoint no devolvió se cuenta con su causa en vez de desaparecer.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { REGIONES, CATALOGO, SOLO_INSUMO, ultimoDiaDeSerie, armaMundo } =
  require(join(dirname(fileURLToPath(import.meta.url)), '..', 'qd-mundo.js'));

const serie = (n = 3) => Array.from({ length: n }, (_, i) => ({ t: 1758758400 + i * 86400, c: 100 + i }));
const conTodo = () => {
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: serie() };
  return data;
};

test('las cuatro regiones del encargo, en orden y con su nombre', () => {
  assert.deepEqual(REGIONES.map((r) => r.nombre),
    ['América', 'Europa', 'Asia', 'Cripto · FX · Materias primas']);
});

test('los cruces de moneda son INSUMO y no ocupan cuadro', () => {
  // Once monedas con cruce declarado: las cuatro de R2(a) más las cinco que
  // trajo el artboard 4 (CAD, COP, CNY, INR, AUD) y el euro.
  assert.deepEqual(SOLO_INSUMO.sort(),
    ['AUD=X', 'BRL=X', 'CAD=X', 'CNY=X', 'COP=X', 'EURUSD=X', 'GBPUSD=X', 'HKD=X', 'INR=X', 'JPY=X', 'KRW=X']);
  const m = armaMundo({ data: conTodo() });
  const pintados = m.regiones.flatMap((r) => r.cuadros.map((c) => c.symbol));
  for (const s of SOLO_INSUMO) assert.ok(!pintados.includes(s), `${s} no debería tener cuadro`);
  // Y son 15 cuadros de los 19 del catálogo: los 4 de diferencia son ésos.
  assert.equal(pintados.length, CATALOGO.length - SOLO_INSUMO.length);
});

test('cada cuadro trae la serie, NO un porcentaje: el % lo calcula la pantalla', () => {
  const m = armaMundo({ data: conTodo() });
  for (const c of m.regiones.flatMap((r) => r.cuadros)) {
    assert.ok(Array.isArray(c.serie) && c.serie.length >= 2, `${c.symbol}: serie`);
    assert.equal(c.pct, undefined, `${c.symbol}: el endpoint no manda % y esto tampoco`);
    assert.equal(c.fuente, 'yahoo:v8/chart');
  }
});

test('lo que el endpoint no devolvió NO desaparece: se cuenta con su causa', () => {
  const data = conTodo();
  delete data['^N225'];
  data['^HSI'] = { price: null, currency: 'HKD', series: serie() };
  data['^FTSE'] = { price: 9000, currency: 'GBP', series: [{ t: 1, c: 9000 }] };
  const m = armaMundo({ data });
  const por = new Map(m.faltantes.map((f) => [f.symbol, f.motivo]));
  assert.match(por.get('^N225'), /no devolvió este símbolo/);
  assert.match(por.get('^HSI'), /sin precio actual/);
  assert.match(por.get('^FTSE'), /1 punto de serie/);
  assert.equal(m.faltantes.length, 3);
  // Y ninguno se cuela a la rejilla.
  const pintados = m.regiones.flatMap((r) => r.cuadros.map((c) => c.symbol));
  for (const s of ['^N225', '^HSI', '^FTSE']) assert.ok(!pintados.includes(s), s);
});

test('la moneda que manda es la que declaró la fuente, y si discrepa se dice', () => {
  const data = conTodo();
  data['^N225'] = { price: 42000, currency: 'USD', series: serie() };  // no es yenes
  const m = armaMundo({ data });
  const n = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === '^N225');
  assert.equal(n.moneda, 'USD', 'se usa la declarada, no la esperada');
  assert.equal(n.moneda_esperada, 'JPY');
  assert.equal(n.moneda_discrepa, true, 'y la discrepancia viaja para poder decirla');
});

test('cripto no se finge: la región lo declara en vez de dejar el hueco mudo', () => {
  const m = armaMundo({ data: conTodo() });
  const otros = m.regiones.find((r) => r.clave === 'otros');
  assert.match(otros.aviso, /cripto todavía no/);
  assert.equal(m.regiones.find((r) => r.clave === 'asia').aviso, null);
});

test('el último día de la serie sale del timestamp, no de hoy', () => {
  assert.equal(ultimoDiaDeSerie([{ t: 1758758400, c: 1 }, { t: 1758672000, c: 2 }]), '2025-09-25');
  assert.equal(ultimoDiaDeSerie([]), null);
  assert.equal(ultimoDiaDeSerie([{ t: null, c: 1 }]), null);
});

test('las bolsas del catálogo existen en la tabla única, o son 24h', () => {
  // Un cuadro que apunte a una bolsa inexistente saldría "sin horario
  // declarado" en pantalla; que no pase se prueba acá y no en el navegador.
  const { BOLSAS } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'qd-mercados.js'));
  for (const c of CATALOGO) {
    assert.ok(c.bolsa === '24h' || BOLSAS[c.bolsa], `${c.symbol} apunta a ${c.bolsa}`);
  }
});
