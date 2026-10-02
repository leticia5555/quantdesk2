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
const { REGIONES, CATALOGO, SOLO_INSUMO, ultimoDiaDeSerie, serieConPrecio, armaMundo } =
  require(join(dirname(fileURLToPath(import.meta.url)), '..', 'qd-mundo.js'));

const serie = (n = 3) => Array.from({ length: n }, (_, i) => ({ t: 1758758400 + i * 86400, c: 100 + i }));
// El cuadro del peso sale del FIX, no de Yahoo, así que una rejilla completa
// necesita las dos fuentes — igual que la página, que pide las dos.
const FIX = { fecha: '2026-09-28', valor: 18.35, serie: serie(3) };
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
  // Diez monedas con cruce declarado: las cuatro de R2(a) más las que trajo
  // el artboard 4 (CAD, CNY, INR, AUD) y el euro. `CLP=X` se fue con `^IPSA`:
  // un cruce que no convierte ningún cuadro es una petición a Yahoo por nada.
  assert.deepEqual(SOLO_INSUMO.sort(),
    ['AUD=X', 'BRL=X', 'CAD=X', 'CNY=X', 'EURUSD=X', 'GBPUSD=X', 'HKD=X', 'INR=X', 'JPY=X', 'KRW=X']);
  const m = armaMundo({ data: conTodo(), fix: FIX });
  const pintados = m.regiones.flatMap((r) => r.cuadros.map((c) => c.symbol));
  for (const s of SOLO_INSUMO) assert.ok(!pintados.includes(s), `${s} no debería tener cuadro`);
  // Y son 15 cuadros de los 19 del catálogo: los 4 de diferencia son ésos.
  assert.equal(pintados.length, CATALOGO.length - SOLO_INSUMO.length);
});

test('cada cuadro trae la serie, NO un porcentaje: el % lo calcula la pantalla', () => {
  const m = armaMundo({ data: conTodo(), fix: FIX });
  for (const c of m.regiones.flatMap((r) => r.cuadros)) {
    assert.ok(Array.isArray(c.serie) && c.serie.length >= 2, `${c.symbol}: serie`);
    assert.equal(c.pct, undefined, `${c.symbol}: el endpoint no manda % y esto tampoco`);
    // El cuadro del peso declara Banxico; los demás, Yahoo. Cada número dice
    // su fuente (regla 3), y acá se comprueba que no digan todos la misma.
    assert.equal(c.fuente, c.symbol === 'MXN=X' ? 'banxico:SF43718' : 'yahoo:v8/chart', c.symbol);
  }
});

test('lo que el endpoint no devolvió NO desaparece: se cuenta con su causa', () => {
  const data = conTodo();
  delete data['^N225'];
  data['^HSI'] = { price: null, currency: 'HKD', series: serie() };
  data['^FTSE'] = { price: 9000, currency: 'GBP', series: [{ t: 1, c: 9000 }] };
  const m = armaMundo({ data, fix: FIX });
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
  const m = armaMundo({ data, fix: FIX });
  const n = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === '^N225');
  assert.equal(n.moneda, 'USD', 'se usa la declarada, no la esperada');
  assert.equal(n.moneda_esperada, 'JPY');
  assert.equal(n.moneda_discrepa, true, 'y la discrepancia viaja para poder decirla');
});

test('ninguna región lleva aviso: el de cripto se fue cuando entró Bitcoin', () => {
  // Decía "cripto todavía no: no hay ni un símbolo de cripto en la fuente".
  // Con `BTC-USD` en la rejilla eso pasó a ser falso, y un aviso falso es peor
  // que ninguno.
  const m = armaMundo({ data: conTodo(), fix: FIX });
  for (const r of m.regiones) assert.equal(r.aviso, null, r.clave);
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

// ═══════════════════════════════════════════════════════════════════════
// EL PRECIO Y EL % TIENEN QUE SER DEL MISMO DÍA — EL CASO DEL KOSPI
//
// Visto en prod el 2026-09-29: el cuadro mostraba 6,870.81 —el precio de HOY—
// con −2.70%, que era el 1D del LUNES (6,889.74 contra 7,080.92). El de hoy
// era −0.27%. La causa: `price` es el último precio de mercado y la serie
// diaria termina en el último CIERRE, así que cuando la sesión de hoy ya corrió
// pero su cierre no entró a la serie, son de días distintos.
// ═══════════════════════════════════════════════════════════════════════
const dia = (s) => Date.parse(s + 'T20:00:00Z') / 1000;

test('si el precio es MÁS NUEVO que la serie, entra como el punto de hoy', () => {
  const serie = [{ t: dia('2026-09-25'), c: 7080.92 }, { t: dia('2026-09-28'), c: 6889.74 }];
  const r = serieConPrecio(serie, 6870.81, dia('2026-09-29'));
  assert.equal(r.precio_es_de_hoy, true);
  assert.equal(r.precio, 6870.81);
  assert.equal(r.precio_fecha, '2026-09-29');
  assert.equal(r.serie.length, 3, 'el precio de hoy es un punto más');
  // Y el 1D que sale de esa serie es el de HOY, no el del lunes.
  const hoy = ((r.serie[2].c / r.serie[1].c) - 1) * 100;
  assert.ok(Math.abs(hoy - (-0.2748)) < 0.01, `${hoy.toFixed(4)}% — el real de hoy`);
  const lunes = ((6889.74 / 7080.92) - 1) * 100;
  assert.ok(Math.abs(lunes - (-2.70)) < 0.01, `${lunes.toFixed(2)}% — el que se estaba mostrando`);
});

test('si NO es más nuevo, el precio que se muestra es el del último cierre, con su fecha', () => {
  const serie = [{ t: dia('2026-09-25'), c: 7080.92 }, { t: dia('2026-09-28'), c: 6889.74 }];
  const r = serieConPrecio(serie, 6870.81, dia('2026-09-28'));
  assert.equal(r.precio_es_de_hoy, false);
  assert.equal(r.precio, 6889.74, 'el del último punto, no el de mercado');
  assert.equal(r.precio_fecha, '2026-09-28');
  assert.equal(r.serie.length, 2, 'no se agrega un punto del mismo día');
});

test('sin fecha del precio no se adivina: último cierre y se dice cuál', () => {
  const serie = [{ t: dia('2026-09-25'), c: 7080.92 }, { t: dia('2026-09-28'), c: 6889.74 }];
  for (const t of [null, undefined, '']) {
    const r = serieConPrecio(serie, 6870.81, t);
    assert.equal(r.precio_es_de_hoy, false, String(t));
    assert.equal(r.precio, 6889.74, String(t));
    assert.equal(r.precio_fecha, '2026-09-28', String(t));
  }
});

test('el % que viaja al render sale de la serie CON el precio de hoy', () => {
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: [{ t: dia('2026-09-25'), c: 90 }, { t: dia('2026-09-28'), c: 95 }] };
  data['^KS11'] = {
    price: 6870.81, precio_t: dia('2026-09-29'), currency: 'KRW',
    series: [{ t: dia('2026-09-25'), c: 7080.92 }, { t: dia('2026-09-28'), c: 6889.74 }],
  };
  const m = armaMundo({ data });
  const k = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === '^KS11');
  assert.equal(k.puntos, 3);
  assert.equal(k.precio, 6870.81);
  assert.equal(k.precio_es_de_hoy, true);
  // `ultimo_cierre` sigue siendo el del último CIERRE de verdad: el precio de
  // mercado no es un cierre, y el chip de la bolsa se contrasta contra cierres.
  assert.equal(k.ultimo_cierre, '2026-09-28');
});

// ═══════════════════════════════════════════════════════════════════════
// UNA SOLA FUENTE DE VERDAD PARA EL PESO
//
// El cuadro USD/MXN salía de `MXN=X` de Yahoo y daba +2.19% 1D —a esa serie le
// faltaba el 28-sep, así que comparaba 18.1376 contra 17.7487 del 27— mientras
// la conversión a pesos, que usa el FIX, daba +0.74%. Dos números del mismo
// peso en la misma pantalla.
// ═══════════════════════════════════════════════════════════════════════
test('el cuadro USD/MXN sale del MISMO FIX que convierte, no de Yahoo', () => {
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: [{ t: dia('2026-09-25'), c: 90 }, { t: dia('2026-09-28'), c: 95 }] };
  // Lo que Yahoo diría del peso, y que NO se debe usar.
  data['MXN=X'] = { price: 18.1376, currency: 'MXN', series: [{ t: dia('2026-09-25'), c: 17.7487 }, { t: dia('2026-09-27'), c: 17.7487 }] };
  const fix = {
    fecha: '2026-09-28', valor: 18.3542,
    serie: [{ t: dia('2026-09-25'), c: 18.2189 }, { t: dia('2026-09-28'), c: 18.3542 }],
  };
  const m = armaMundo({ data, fix });
  const peso = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === 'MXN=X');
  assert.equal(peso.precio, 18.3542, 'el valor del FIX, no el de Yahoo');
  assert.equal(peso.fuente, 'banxico:SF43718');
  assert.equal(peso.fecha_fix, '2026-09-28');
  assert.deepEqual(peso.serie, fix.serie, 'y la MISMA serie con la que se convierte');
  assert.equal(peso.pais, 'FIX Banxico');
});

test('sin FIX, el cuadro del peso dice por qué no está en vez de caer a Yahoo', () => {
  const data = { 'MXN=X': { price: 18.1376, currency: 'MXN', series: [{ t: 1, c: 17 }, { t: 2, c: 18 }] } };
  const m = armaMundo({ data, fix: { motivo: 'no llegó el FIX de Banxico' } });
  const pintados = m.regiones.flatMap((r) => r.cuadros.map((c) => c.symbol));
  assert.ok(!pintados.includes('MXN=X'), 'no se dibuja con la fuente equivocada');
  const f = m.faltantes.find((x) => x.symbol === 'MXN=X');
  assert.match(f.motivo, /no llegó el FIX/);
});

test('los índices que Yahoo no tiene NO están, y el aviso de cripto se fue con Bitcoin', () => {
  // Los dos candidatos de Sudamérica devolvieron 404 contra producción:
  // `^COLCAP` el 2026-09-29 y `^IPSA` el 2026-10-02. Ninguno se sustituye por
  // un ticker parecido —un índice que no se pudo comprobar no entra— y con
  // `^IPSA` se fue su cruce, que ya no convertía nada.
  const claves = CATALOGO.map((c) => c.symbol);
  assert.ok(!claves.includes('^COLCAP'), 'COLCAP no existe en Yahoo');
  assert.ok(!claves.includes('^IPSA'), 'IPSA tampoco: 404');
  assert.ok(!claves.includes('CLP=X'), 'y su cruce se fue con él');
  assert.ok(claves.includes('^BVSP'), 'Sudamérica se queda en Brasil');
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: [{ t: 1, c: 1 }, { t: 2, c: 2 }] };
  const m = armaMundo({ data });
  for (const r of m.regiones) assert.equal(r.aviso, null, `${r.clave}: Bitcoin ya está, el aviso sería falso`);
});

// ═══════════════════════════════════════════════════════════════════════
// EL ESTADO SALE DE LA MISMA FECHA QUE EL NÚMERO
//
// El encabezado de Asia decía "cierre del lunes" mientras los cuadros
// mostraban el martes: miraba `ultimo_cierre` —la última fecha de la SERIE—
// y los cuadros miraban el precio, que desde el arreglo del KOSPI puede ser
// más nuevo. Dos fechas para el mismo cuadro es media pantalla mintiendo.
// ═══════════════════════════════════════════════════════════════════════
test('cuando el precio de hoy entró a la serie, la fecha del dato es la de hoy', () => {
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: [{ t: dia('2026-09-25'), c: 90 }, { t: dia('2026-09-28'), c: 95 }] };
  data['^N225'] = {
    price: 45800, precio_t: dia('2026-09-29'), currency: 'JPY',
    series: [{ t: dia('2026-09-25'), c: 44000 }, { t: dia('2026-09-28'), c: 45000 }],
  };
  const m = armaMundo({ data, fix: FIX });
  const n = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === '^N225');
  assert.equal(n.fecha_dato, '2026-09-29', 'la del número que se ve');
  assert.equal(n.ultimo_cierre, '2026-09-28', 'y el último CIERRE sigue siendo el suyo');

  // El que no tiene precio nuevo: las dos fechas coinciden.
  const otro = m.regiones.flatMap((r) => r.cuadros).find((c) => c.symbol === '^GSPC');
  assert.equal(otro.fecha_dato, '2026-09-28');
  assert.equal(otro.fecha_dato, otro.ultimo_cierre);
});

test('la causa de un símbolo ausente la da el ENDPOINT, no se inventa', () => {
  const data = {};
  for (const c of CATALOGO) data[c.symbol] = { price: 100, currency: c.moneda, series: serie() };
  delete data['^FTSE'];
  delete data['^AXJO'];
  const m = armaMundo({ data, fix: FIX, omitidos: { '^FTSE': 'Yahoo respondió HTTP 404' } });
  const por = new Map(m.faltantes.map((f) => [f.symbol, f.motivo]));
  // Con razón declarada: se usa tal cual, porque un 404 se arregla cambiando
  // el ticker y un timeout no.
  assert.equal(por.get('^FTSE'), 'Yahoo respondió HTTP 404');
  // Sin razón declarada: se dice que no la hay, en vez de afirmar una.
  assert.match(por.get('^AXJO'), /ni dijo por qué/);
});
