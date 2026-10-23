// ═══════════════════════════════════════════════════════════════════════
// tests/mercado-indice.test.mjs — R4: la aritmética de la ficha de índice.
//
// TODO SE PRUEBA CON SERIES ESCRITAS A MANO Y RESULTADOS CALCULABLES DE
// CABEZA. Una prueba que corre contra el mercado de ayer no distingue un bug
// de un martes, y la media de 200 días es justo el tipo de número que "se ve
// bien" estando mal.
//
// LAS TRES QUE MÁS IMPORTAN:
//   · la media de 200 días NO EXISTE con 60 puntos, y eso se dice. Dibujarla
//     igual sería una línea inventada — que es lo que el encargo prohíbe
//     cuando deja fuera las líneas de tendencia;
//   · la volatilidad usa rendimientos LOGARÍTMICOS: +10% y −10% tienen que
//     pesar lo mismo, y con rendimientos simples no pesan;
//   · el peso de los componentes se declara como POR CAPITALIZACIÓN, no como
//     el peso oficial del índice, y viaja con su cobertura.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  INDICES, indiceDe, mediaMovil, ultimaMedia, rango52, volatilidad,
  contraMedia, pesosPorCapitalizacion, PERIODOS_FICHA, serieConvertida,
} from '../api/_lib/mercado-indice.js';

const serieDe = (cs) => cs.map((c, i) => ({ t: 1000 + i * 86400, c }));

// ── EL CATÁLOGO ──────────────────────────────────────────────────────
test('los nueve índices de R4, con su símbolo y su ETF', () => {
  assert.equal(INDICES.length, 9);
  assert.deepEqual(INDICES.map((i) => i.id),
    ['SPX', 'NDX', 'DJI', 'IPC', 'BOVESPA', 'KOSPI', 'NIKKEI', 'DAX', 'HSI']);
  for (const i of INDICES) {
    assert.match(i.symbol, /^[\^0-9A-Z.]+$/, `${i.id}: símbolo raro`);
    assert.ok(i.etf, `${i.id}: sin ETF que lo replique`);
    assert.ok(i.bolsa, `${i.id}: sin bolsa, y sin bolsa no hay chip de estado`);
  }
});

test('un índice que no existe devuelve null, no "el primero"', () => {
  assert.equal(indiceDe('SPX').symbol, '^GSPC');
  assert.equal(indiceDe('spx').symbol, '^GSPC', 'no distingue mayúsculas');
  assert.equal(indiceDe('NASDAQ'), null);
  assert.equal(indiceDe(''), null);
  assert.equal(indiceDe(null), null);
});

// ── MEDIA MÓVIL ──────────────────────────────────────────────────────
test('la media móvil de 3 sobre una serie conocida', () => {
  // 1,2,3,4,5 → medias de 3: null, null, 2, 3, 4
  assert.deepEqual(mediaMovil(serieDe([1, 2, 3, 4, 5]), 3), [null, null, 2, 3, 4]);
});

test('la media de 200 días NO se dibuja con 60 puntos: se dice que no existe', () => {
  const corta = serieDe(Array.from({ length: 60 }, (_, i) => 100 + i));
  const m = mediaMovil(corta, 200);
  assert.equal(m.filter((x) => x != null).length, 0, 'ni un solo punto de media');
  const u = ultimaMedia(corta, 200);
  assert.equal(u.valor, null);
  assert.match(u.motivo, /60 cierres.*200/, u.motivo);
});

test('un hueco en la serie reinicia la ventana en vez de arrastrar una suma falsa', () => {
  // Con un cierre nulo en medio, la media de 3 no puede saltárselo: los tres
  // puntos de una media de 3 tienen que ser tres cierres seguidos.
  const s = [{ t: 1, c: 10 }, { t: 2, c: 20 }, { t: 3, c: null }, { t: 4, c: 40 }, { t: 5, c: 50 }, { t: 6, c: 60 }];
  const m = mediaMovil(s, 3);
  assert.equal(m[1], null);
  assert.equal(m[2], null, 'el punto sin cierre no produce media');
  assert.equal(m[3], null, 'ni el siguiente: la ventana arrancó de cero');
  assert.equal(m[5], 50, '40,50,60 → 50');
});

test('contraMedia dice arriba/abajo y CUÁNTO, que es lo accionable', () => {
  const s = serieDe([10, 10, 10, 10, 13]);   // media de 4 al final = 10.75
  const r = contraMedia(s, 4);
  assert.equal(r.arriba, true);
  assert.ok(Math.abs(r.media - 10.75) < 1e-9, String(r.media));
  assert.ok(Math.abs(r.pct - ((13 - 10.75) / 10.75) * 100) < 1e-9, String(r.pct));
});

// ── 52 SEMANAS ───────────────────────────────────────────────────────
test('máximo, mínimo y distancia al máximo, con las fechas', () => {
  const s = serieDe([100, 120, 90, 110]);
  const r = rango52(s);
  assert.equal(r.max, 120);
  assert.equal(r.min, 90);
  assert.equal(r.ultimo, 110);
  // 110 contra un máximo de 120: −8.33%
  assert.ok(Math.abs(r.desde_max_pct - (-100 / 12)) < 1e-9, String(r.desde_max_pct));
  assert.equal(r.max_t, s[1].t, 'la fecha del máximo viaja: "cuándo" es la mitad del dato');
});

test('con menos de un año bursátil se DICE: ocho meses no son 52 semanas', () => {
  const s = serieDe(Array.from({ length: 120 }, (_, i) => 100 + i));
  const r = rango52(s);
  assert.equal(r.completa, false);
  assert.equal(r.sesiones, 120);
  assert.match(r.motivo, /120 sesiones de las 252/, r.motivo);
});

test('la ventana es de SESIONES y recorta de verdad', () => {
  // 300 puntos subiendo: el máximo de las últimas 252 NO es el de la serie
  // entera, y el mínimo tampoco.
  const s = serieDe(Array.from({ length: 300 }, (_, i) => 100 + i));
  const r = rango52(s);
  assert.equal(r.sesiones, 252);
  assert.equal(r.min, 100 + 48, 'el mínimo es el primero DE LA VENTANA, no de la serie');
});

// ── VOLATILIDAD ──────────────────────────────────────────────────────
test('una serie perfectamente plana tiene volatilidad CERO, no "—"', () => {
  const s = serieDe(Array.from({ length: 40 }, () => 100));
  const v = volatilidad(s);
  assert.ok(Math.abs(v.pct) < 1e-12, String(v.pct));
  assert.equal(v.motivo, null);
});

test('sin suficientes cierres la volatilidad es null CON su causa, no cero', () => {
  // Cero sería una afirmación: "este índice no se movió". Es falso.
  const v = volatilidad(serieDe([100, 101, 102]));
  assert.equal(v.pct, null);
  assert.match(v.motivo, /hacen falta 31 cierres y hay 3/, v.motivo);
});

test('la volatilidad usa rendimientos logarítmicos: +10% y −10% pesan igual', () => {
  // Una serie que alterna ×1.1 y ÷1.1 tiene |log| idéntico en cada paso, así
  // que la desviación muestral de los rendimientos es exactamente |ln(1.1)|
  // (media cero con un número par de pasos). Con rendimientos SIMPLES los
  // pasos serían +10% y −9.09% y el resultado saldría distinto.
  const cs = [100];
  for (let i = 0; i < 40; i++) cs.push(i % 2 === 0 ? cs[cs.length - 1] * 1.1 : cs[cs.length - 1] / 1.1);
  const v = volatilidad(serieDe(cs), { ventana: 40 });
  const esperado = Math.log(1.1) * Math.sqrt(40 / 39) * Math.sqrt(252) * 100;
  assert.ok(Math.abs(v.pct - esperado) < 1e-6, `${v.pct} vs ${esperado}`);
});

test('y declara su método: un número sin método no se puede revisar', () => {
  const v = volatilidad(serieDe(Array.from({ length: 40 }, (_, i) => 100 + (i % 3))));
  assert.equal(v.fuente, 'calc');
  assert.match(v.metodo, /logarítmicos/);
  assert.match(v.metodo, /√252/);
});

// ── PESOS ────────────────────────────────────────────────────────────
test('el peso se declara POR CAPITALIZACIÓN, no como el oficial del índice', () => {
  const r = pesosPorCapitalizacion(['AAA', 'BBB'], { AAA: 300, BBB: 100 });
  assert.equal(r.metodo, 'cap');
  assert.match(r.fuente, /NO el peso oficial/);
  assert.equal(r.componentes[0].symbol, 'AAA');
  assert.ok(Math.abs(r.componentes[0].peso_pct - 75) < 1e-9);
});

test('y viaja con su COBERTURA: un peso sin cobertura es un peso inventado', () => {
  const r = pesosPorCapitalizacion(['AAA', 'BBB', 'CCC'], { AAA: 300 });
  assert.equal(r.cubiertos, 1);
  assert.equal(r.miembros, 3);
  assert.ok(Math.abs(r.cobertura_pct - (100 / 3)) < 1e-9);
  assert.match(r.motivo, /1 de 3 miembros/, r.motivo);
  // Y el único que hay pesa 100% DE LO CUBIERTO, no del índice: por eso la
  // cobertura tiene que verse al lado.
  assert.ok(Math.abs(r.componentes[0].peso_pct - 100) < 1e-9);
});

test('sin miembros y sin caps NO se inventa una tira: se dice cuál de las dos falta', () => {
  const sinLista = pesosPorCapitalizacion([], {});
  assert.deepEqual(sinLista.componentes, []);
  assert.match(sinLista.motivo, /no tenemos la lista de miembros/);

  const sinCaps = pesosPorCapitalizacion(['AAA', 'BBB'], {});
  assert.deepEqual(sinCaps.componentes, []);
  assert.match(sinCaps.motivo, /ninguno con capitalización verificada/);
});

test('"+N más = X%" sale del resto, no de una resta a ojo', () => {
  const caps = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['S' + i, 20 - i]));
  const r = pesosPorCapitalizacion(Object.keys(caps), caps, { tope: 5 });
  assert.equal(r.componentes.length, 5);
  assert.equal(r.resto, 15);
  const suma = r.componentes.reduce((a, c) => a + c.peso_pct, 0) + r.resto_pct;
  assert.ok(Math.abs(suma - 100) < 1e-9, `los pesos suman ${suma}`);
});

// ── PERIODOS ─────────────────────────────────────────────────────────
//
// `periodosDisponibles` SE FUE. Era una tabla de sesiones mínimas que decidía
// lo mismo que `qdPeriodChange` y no coincidía con él: decía que "1A"
// alcanzaba con 252 cierres mientras el calculador devolvía "—" (Lety,
// 2026-10-21). La ficha pinta lo que dice el calculador.
//
// Lo que sí se fija acá es que la lista de periodos de la ficha y la del
// calculador sean la MISMA. Si alguien agrega "10A" a una sola, esto se pone
// rojo antes de que la ficha pinte una fila que nadie sabe calcular.
test('los nueve periodos de la ficha son los que el calculador conoce', () => {
  const require2 = createRequire(import.meta.url);
  const { QD_PERIODS, qdPeriodChange } = require2(join(ROOT, 'qd-periods.js'));
  assert.equal(PERIODOS_FICHA.length, 9);
  for (const p of PERIODOS_FICHA) {
    assert.ok(QD_PERIODS[p], `el calculador no conoce ${p}`);
  }
  // Y una serie de un año contesta lo que tiene que contestar: 1A sí, 3A no.
  // Es el caso que salía "—" con un año entero de datos.
  const unAnio = Array.from({ length: 252 }, (_, i) => ({
    t: Math.round(1000 + i * (365 * 86400) / 251), c: 100 + i,
  }));
  assert.ok(Number.isFinite(qdPeriodChange(unAnio, '1A').pct), 'un año de datos tiene que dar 1A');
  assert.equal(qdPeriodChange(unAnio, '3A').pct, null, 'un año no son tres');
});

// ── LA SERIE EN OTRA MONEDA ──────────────────────────────────────────
// Existe porque un toggle que no hace nada es un bug: pasó con el de moneda
// en el mapa de México y no vuelve a pasar sin que una prueba lo note.
test('cada cierre se convierte con el tipo de cambio DE SU DÍA, no con el último', () => {
  const velas = [{ time: 100, close: 10 }, { time: 200, close: 20 }, { time: 300, close: 30 }];
  const fx = [{ t: 50, c: 2 }, { t: 250, c: 3 }];
  const r = serieConvertida(velas, fx);
  // t=100 y t=200 usan el FX de t=50 (=2); t=300 usa el de t=250 (=3).
  assert.deepEqual(r.velas.map((v) => v.close), [20, 40, 90]);
  assert.equal(r.descartadas, 0);
});

test('convertir con el ÚLTIMO tipo de cambio daría el mismo % que el local: por eso no se hace', () => {
  // Esta prueba es la que explica la anterior. Con un solo factor k, el
  // cambio porcentual no se mueve — el toggle se encendería sin cambiar nada.
  const velas = [{ time: 100, close: 10 }, { time: 300, close: 20 }];
  const pctLocal = (20 / 10 - 1) * 100;
  const conUnFactor = (20 * 3) / (10 * 3) - 1;
  assert.equal(conUnFactor * 100, pctLocal, 'con un factor único el % no cambia');
  // Con el FX de cada día, SÍ cambia.
  const r = serieConvertida(velas, [{ t: 50, c: 2 }, { t: 250, c: 3 }]);
  const pctConvertido = (r.velas[1].close / r.velas[0].close - 1) * 100;
  assert.notEqual(Math.round(pctConvertido), Math.round(pctLocal));
});

test('un cierre anterior al primer tipo de cambio conocido se DESCARTA, no se inventa', () => {
  const r = serieConvertida([{ time: 100, close: 10 }, { time: 300, close: 30 }], [{ t: 200, c: 2 }, { t: 400, c: 2 }]);
  assert.equal(r.velas.length, 1);
  assert.equal(r.descartadas, 1);
  assert.match(r.motivo, /anteriores al primer tipo de cambio/);
});

test('sin tipo de cambio no se convierte NADA: se dice', () => {
  const r = serieConvertida([{ time: 1, close: 10 }], [{ t: 1, c: 2 }]);
  assert.deepEqual(r.velas, []);
  assert.match(r.motivo, /1 punto\(s\)/);
});

test('las velas conservan apertura, máximo y mínimo al convertirse', () => {
  const r = serieConvertida([{ time: 100, open: 9, high: 11, low: 8, close: 10 }], [{ t: 1, c: 2 }, { t: 2, c: 2 }]);
  assert.deepEqual(r.velas[0], { time: 100, open: 18, high: 22, low: 16, close: 20 });
});

test('una vela con cierre NULO se descarta, no se convierte en un cierre de 0', () => {
  // `Number(null)` es CERO, no NaN. Sin el guardia, la vela entraba con un
  // precio de 0 — inventado, y encima hunde la gráfica hasta el eje.
  const r = serieConvertida(
    [{ time: 100, c: null }, { time: 200, c: 10 }],
    [{ t: 1, c: 2 }, { t: 2, c: 2 }],
  );
  assert.equal(r.velas.length, 1);
  assert.equal(r.velas[0].close, 20);
  assert.equal(r.descartadas, 1);
});
