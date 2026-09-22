// ═══════════════════════════════════════════════════════════════════
// tests/mercado-mapa.test.mjs — qué viaja al teléfono, y qué se dice de lo
// que falta.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  empaquetaSerie, armaMapaUs, armaMapaMx, resumenFaltantes, CIERRES_RECIENTES, MOTIVOS,
} from '../api/_lib/mercado-mapa.js';
import { recorteMapa } from '../api/_lib/mercado-r0.js';
import { cierreQueSePinta } from '../api/_lib/mercado-precios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const QD = req(join(ROOT, 'qd-periods.js'));
const TM = req(join(ROOT, 'qd-treemap.js'));

const T = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
const AHORA = new Date('2026-09-21T22:00:00Z');

// Una serie diaria desde el 2025-12-30 hasta el 2026-09-18.
function serieLarga(base = 100) {
  const filas = [];
  let d = Date.parse('2025-12-30T00:00:00Z');
  const fin = Date.parse('2026-09-18T00:00:00Z');
  let i = 0;
  while (d <= fin) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const c = base + i * 0.3;
      filas.push({ fecha: new Date(d).toISOString().slice(0, 10), t: Math.floor(d / 1000), cierre: c, cierre_ajustado: c * 0.98 });
      i++;
    }
    d += 86400000;
  }
  return filas;
}

test('el paquete manda 22 cierres, no la serie entera de un año', () => {
  const filas = serieLarga();
  assert.ok(filas.length > 150, 'la serie de prueba tiene un año');
  const p = empaquetaSerie(filas, { ahora: AHORA });
  assert.equal(p.serie.length, CIERRES_RECIENTES);
  assert.equal(p.puntos, filas.length, 'el conteo real viaja aunque la serie se recorte');
});

test('el ancla YTD viaja como punto explícito, no como número de sesiones', () => {
  const p = empaquetaSerie(serieLarga(), { ahora: AHORA });
  assert.ok(p.ytd, 'debería haber ancla');
  assert.equal(new Date(p.ytd.t * 1000).toISOString().slice(0, 10), '2025-12-31');
  assert.equal(p.ytd_motivo, null);
});

test('los cuatro periodos se calculan con qdPeriodChange sobre lo que viajó', () => {
  const p = empaquetaSerie(serieLarga(), { ahora: AHORA });
  for (const per of ['1D', '1S', '1M']) {
    const r = QD.qdPeriodChange(p.serie, per, AHORA);
    assert.ok(Number.isFinite(r.pct), `${per} debería tener %`);
  }
  // YTD se arma con [ancla, último]: dos puntos y la regla de fecha.
  const ytd = QD.qdPeriodChange([p.ytd, p.serie[p.serie.length - 1]], 'YTD', AHORA);
  assert.ok(Number.isFinite(ytd.pct));
  assert.equal(ytd.periodLabel, 'YTD');
});

test('una serie que no llega al año pasado manda ytd null CON motivo', () => {
  const filas = serieLarga().slice(-40);   // sólo desde ~julio
  const p = empaquetaSerie(filas, { ahora: AHORA });
  assert.equal(p.ytd, null);
  assert.match(p.ytd_motivo, /no llega al año anterior/);
  // Y el "—" que se pinta lleva la causa.
  const r = QD.qdPeriodChange([], 'YTD', AHORA);
  assert.match(QD.qdPctTag(r.pct, 'YTD', { motivo: p.ytd_motivo }), /title="[^"]*año anterior/);
});

test('el precio que se muestra es el cierre SIN ajustar; el % usa el ajustado', () => {
  const p = empaquetaSerie(serieLarga(), { ahora: AHORA });
  const ultima = serieLarga().pop();
  assert.equal(p.precio, ultima.cierre, 'el precio de pantalla es el cierre real');
  assert.equal(p.serie[p.serie.length - 1].c, ultima.cierre_ajustado, 'el % va por el ajustado');
  assert.equal(p.fecha_precio, '2026-09-18');
});

test('mapa US: recorta al top por cap y el "+N más" lleva su % medido', () => {
  const universo = Array.from({ length: 12 }, (_, i) => ({
    symbol: `S${i}`, nombre: `Nombre ${i}`, sector_etf: 'XLK',
    market_cap: (12 - i) * 1e9, cap_fuente: 'finnhub:metric', cap_actualizado: '2026-09-21',
  }));
  const recorte = recorteMapa(universo, 10);
  const { cuadros } = armaMapaUs({ universo, precios: [], recorte, ahora: AHORA });
  assert.equal(cuadros.length, 10);
  assert.equal(cuadros[0].symbol, 'S0', 'el más grande primero');
  assert.equal(recorte.resto.n, 2);
  assert.ok(recorte.resto.pct > 0, 'el porcentaje del resto se MIDE');
});

test('mapa US: un símbolo sin serie sale listado con su motivo', () => {
  const universo = [{ symbol: 'AAPL', nombre: 'Apple', sector_etf: 'XLK', market_cap: 3e12 }];
  const { cuadros, faltantes } = armaMapaUs({ universo, precios: [], recorte: recorteMapa(universo, 10), ahora: AHORA });
  assert.equal(cuadros[0].serie.length, 0);
  assert.equal(faltantes[0].motivo, MOTIVOS.SIN_SERIE);
  assert.deepEqual(resumenFaltantes(faltantes).por_motivo, { no_hay_serie: 1 });
});

test('mapa MX: la cap sólo se pinta si está verificada', () => {
  const detalle = [
    { clave: 'WALMEX', nombre: 'Walmex', sector: 'Consumo', serie_liquida: 'WALMEX*', estado: 'verificada', via: 'individual', etiqueta: 'cap: calc · verificada', cap_calculada: 8e11, acciones_por_unidad: 1 },
    { clave: 'FEMSA', nombre: 'FEMSA', sector: 'Consumo', serie_liquida: 'FEMSAUBD', estado: 'gris_punteado', via: 'requiere_desglose', motivo_estado: 'series con precio distinto, sin desglose', cap_calculada: 7e11, acciones_por_unidad: 5 },
  ];
  const { cuadros, faltantes } = armaMapaMx({ detalleG2: detalle, precios: [], ahora: AHORA });
  assert.equal(cuadros[0].cap, 8e11);
  // FEMSA tiene cap_calculada, pero NO se pinta: un cuadro dimensionado con
  // una cap que no cuadra miente de tamaño, no sólo de color.
  assert.equal(cuadros[1].cap, null);
  assert.match(cuadros[1].motivo, /sin desglose/);
  // Dos faltantes por causas distintas: FEMSA por gris, y WALMEX —que SÍ
  // está verificada— porque en este fixture no tiene serie con qué anclar
  // YTD. Verificada y pintable no son lo mismo.
  assert.equal(faltantes.find((f) => f.symbol === 'FEMSA').motivo, 'requiere_desglose');
  assert.equal(faltantes.find((f) => f.symbol === 'WALMEX').motivo, MOTIVOS.SIN_ANCLA_YTD);
});

test('mapa MX: los tres grises no son el mismo mensaje', () => {
  const detalle = [
    { clave: 'FEMSA', estado: 'gris_punteado', via: 'requiere_desglose', motivo_estado: 'series con precio distinto, sin desglose' },
    { clave: 'PENOLES', estado: 'gris_punteado', via: 'individual_obligatoria', motivo_estado: 'sin serie de precio' },
    { clave: 'TLEVISA', estado: 'gris_punteado', via: 'individual', motivo_estado: 'no cuadra: error 5.6%' },
  ];
  const { faltantes } = armaMapaMx({ detalleG2: detalle, precios: [], ahora: AHORA });
  assert.equal(new Set(faltantes.map((f) => f.motivo)).size, 3, 'cada gris se arregla distinto');
});

// ───── el treemap: áreas proporcionales y cuadros que se pueden tocar ─────

test('squarify conserva el área total: un cuadro miente de tamaño o no miente', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ key: 'k' + i, value: v }));
  const r = TM.squarify(items, { w: 6, h: 4 });
  const area = r.reduce((a, x) => a + x.w * x.h, 0);
  assert.ok(Math.abs(area - 24) < 1e-9, `área ${area}, esperada 24`);
  assert.equal(r.length, 7);
});

test('squarify mantiene los cuadros cerca de 1:1, que es lo que los hace tocables', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ key: 'k' + i, value: v }));
  const r = TM.squarify(items, { w: 6, h: 4 });
  for (const c of r) {
    const rel = Math.max(c.w / c.h, c.h / c.w);
    assert.ok(rel < 4, `${c.key} salió ${c.w.toFixed(2)}×${c.h.toFixed(2)} (relación ${rel.toFixed(1)}:1)`);
  }
});

test('squarify descarta los valores no positivos en vez de meter NaN', () => {
  const r = TM.squarify([{ key: 'a', value: 10 }, { key: 'b', value: 0 }, { key: 'c', value: null }], { w: 4, h: 4 });
  assert.deepEqual(r.map((x) => x.key), ['a']);
  assert.ok(Math.abs(r[0].w * r[0].h - 16) < 1e-9);
  assert.deepEqual(TM.squarify([], { w: 4, h: 4 }), []);
});

test('la escala de color: 7 pasos, gris dentro de ±0.5%, y sin dato NO es verde', () => {
  assert.equal(TM.colorDe(-4), TM.ESCALA_COLOR[0].color);
  assert.equal(TM.colorDe(-0.2), TM.ESCALA_COLOR[3].color, 'dentro de ±0.5% es gris');
  assert.equal(TM.colorDe(0.4), TM.ESCALA_COLOR[3].color);
  assert.equal(TM.colorDe(0.6), TM.ESCALA_COLOR[4].color);
  assert.equal(TM.colorDe(10), TM.ESCALA_COLOR[6].color);
  // Un cuadro sin dato tiene su propio color: pintarlo de gris de "sin
  // cambio" diría que no se movió, que es una afirmación, no un hueco.
  assert.equal(TM.colorDe(null), TM.COLOR_SIN_DATO);
  assert.notEqual(TM.COLOR_SIN_DATO, TM.ESCALA_COLOR[3].color);
  assert.equal(TM.ESCALA_COLOR.length, 7);
});

// ───── el mapa no puede discrepar del censo ─────
// Cuando /api/mercado-mapa se escribió, `periodos` y `cierres_captura` no
// existían todavía y el llamado a evaluaG2 se quedó sin ellos. En cuanto
// entraron, el mapa empezó a comparar la referencia contra el cálculo de HOY
// mientras el censo la comparaba contra la de su fecha de captura. Medido con
// el precio movido 8%: unidades decía `verificada` (0%) y el mapa
// `gris_punteado` (8%). Este test es el candado.

import { evaluaG2 } from '../api/_lib/mercado-r0.js';
import { readFileSync } from 'node:fs';

test('el mapa MX le pasa a evaluaG2 las MISMAS entradas que el censo', () => {
  const src = readFileSync(join(ROOT, 'api/mercado-mapa.js'), 'utf8');
  for (const arg of ['periodos', 'cierres_captura', 'SQL_G2.periodos', 'SQL_G2.cierres_captura', 'rangoDeCapturas']) {
    assert.ok(src.includes(arg), `/api/mercado-mapa dejó de usar ${arg}: va a discrepar del censo`);
  }
});

test('con las entradas completas, mapa y censo dan el MISMO veredicto', () => {
  const base = {
    emisoras: [{ clave: 'W', nombre: 'W', sector: 'X', serie_liquida: 'W*', acciones_por_unidad: 1 }],
    acciones: [{ clave: 'W', anio: 2026, trimestre: 2, acciones_circulacion: 1e9 }],
    // El precio se movió 8% desde que se capturó la referencia.
    precios: [{ emisora: 'W', emisora_serie: 'W*', fecha: '2026-09-18', cierre: 21.6, importe: 5e8 }],
    volumenes: [{ emisora_serie: 'W*', volumen_ventana: null, importe_ventana: 9e9, filas_ventana: 20 }],
    periodos: [{ clave: 'W', anio: 2026, trimestre: 2, acciones_circulacion: 1e9, fecha_publicacion: '2026-07-22T00:00:00Z' }],
    cierres_captura: [{ emisora: 'W', emisora_serie: 'W*', fecha: '2026-09-18', cierre: 20 }],
    referencias: { gracia_dias: 3, tope_dias: 120, referencias: [{ clave: 'W', market_cap: 20e9, fuente: 'Yahoo', capturada_en: '2026-09-20' }] },
    frescura: { alerta: false, dias_habiles_atraso: 0 },
    ahora: AHORA, criterios: { g2_max_error_pct: 5, g2_min_emisoras_verificadas: 15, g2_metodo_min_muestras: 3, g2_metodo_max_error_pct: 2 },
  };
  const completo = evaluaG2(base);
  assert.equal(completo.detalle[0].estado, 'verificada');
  assert.equal(completo.detalle[0].verificacion.por_referencia[0].error_pct, 0);

  // Y la prueba de que la omisión NO era inocua: sin esas dos entradas, la
  // misma emisora con los mismos datos sale gris.
  const sinEllas = evaluaG2({ ...base, periodos: [], cierres_captura: [] });
  assert.equal(sinEllas.detalle[0].estado, 'gris_punteado');
  assert.equal(sinEllas.detalle[0].verificacion.por_referencia[0].error_pct, 8);
});

// ═══════════════════════════════════════════════════════════════════
// LO QUE EL TELÉFONO CORRIGIÓ
//
// Tres cosas que sólo se vieron con el mapa en la mano:
//   1. Con la tabla al viernes y el cron sin correr, el mapa salía vacío.
//   2. Abrir en sectores: un mapa de mercado sin una sola empresa no es un
//      mapa de mercado.
//   3. "omunicacione" — etiquetas cortadas a mitad de palabra.
// ═══════════════════════════════════════════════════════════════════

test('1D se calcula sobre lo que HAY: viernes contra jueves, sin exigir hoy', () => {
  // Tabla que termina el viernes 18; se consulta el lunes 21 por la tarde.
  const filas = serieLarga();
  const p = empaquetaSerie(filas, { ahora: new Date('2026-09-21T23:00:00Z') });
  const r = QD.qdPeriodChange(p.serie, '1D');
  assert.ok(Number.isFinite(r.pct), 'el 1D tiene que salir aunque falte el cierre del lunes');
  assert.equal(r.motivo, null);
  // Y el ancla es el penúltimo cierre GUARDADO, no "ayer" del calendario.
  assert.equal(r.refValue, p.serie[p.serie.length - 2].c);
});

test('el primer nivel son EMPRESAS agrupadas por sector, no sectores', () => {
  const cuadros = [];
  for (let i = 0; i < 40; i++) {
    cuadros.push({ symbol: 'S' + i, sector: ['XLK', 'XLF', 'XLV'][i % 3], cap: (40 - i) * 1e9 });
  }
  const { grupos, visibles } = TM.agrupaPrimerNivel(cuadros, { n: 30 });
  assert.equal(visibles, 30);
  assert.equal(grupos.length, 3);
  // Cada grupo trae sus empresas visibles y su resto.
  for (const g of grupos) {
    assert.ok(g.visibles.length > 0);
    assert.ok(g.resto && g.resto.n > 0, `${g.sector} debería tener resto`);
    assert.ok(g.visibles[0].cap >= g.visibles[g.visibles.length - 1].cap, 'ordenadas por cap');
  }
  assert.equal(grupos.reduce((a, g) => a + g.visibles.length, 0), 30);
});

test('el área del sector es su capitalización TOTAL, resto incluido', () => {
  const cuadros = [
    { symbol: 'A', sector: 'XLK', cap: 100 },
    { symbol: 'B', sector: 'XLK', cap: 50 },
    { symbol: 'C', sector: 'XLF', cap: 10 },
  ];
  const { grupos } = TM.agrupaPrimerNivel(cuadros, { n: 2 });   // sólo A y B visibles
  const tec = grupos.find((g) => g.sector === 'XLK');
  const fin = grupos.find((g) => g.sector === 'XLF');
  assert.equal(tec.cap_total, 150);
  assert.equal(tec.resto, null, 'sin ocultos no hay cuadro de resto');
  // XLF no tiene ningún nombre entre los 2 más grandes, pero SIGUE apareciendo:
  // si no, sus empresas serían inalcanzables desde el primer nivel.
  assert.equal(fin.visibles.length, 0);
  assert.equal(fin.resto.n, 1);
  assert.equal(fin.resto.pct, 100);
});

test('el % del resto se mide sobre el SECTOR, que es la pregunta que dispara', () => {
  const cuadros = [
    { symbol: 'A', sector: 'XLK', cap: 60 },
    { symbol: 'B', sector: 'XLK', cap: 40 },
    { symbol: 'C', sector: 'XLF', cap: 1000 },
  ];
  const { grupos } = TM.agrupaPrimerNivel(cuadros, { n: 2 });   // C y A
  const tec = grupos.find((g) => g.sector === 'XLK');
  assert.equal(tec.resto.n, 1);
  assert.equal(tec.resto.pct, 40, '40 de 100 del sector, no de los 1100 del mapa');
});

test('ETIQUETAS: si no cabe entera, abreviatura; nunca cortada a la mitad', () => {
  const cand = TM.candidatosSector('Comunicaciones');
  assert.equal(TM.etiquetaQueCabe(cand, 200, 13), 'Comunicaciones');
  assert.equal(TM.etiquetaQueCabe(cand, 90, 13), 'Com.');
  // Y si ni la abreviatura cabe, NADA — mejor un cuadro sin texto que
  // "omunicacione", que es lo que el teléfono mostraba.
  assert.equal(TM.etiquetaQueCabe(cand, 20, 13), null);
  for (const n of ['Industriales', 'Materiales', 'Consumo discrecional']) {
    const e = TM.etiquetaQueCabe(TM.candidatosSector(n), 80, 13);
    assert.ok(e === null || n.startsWith(e) || /\.$/.test(e), `"${e}" no es ni el nombre ni una abreviatura de "${n}"`);
  }
});

test('ETIQUETAS: toda abreviatura de sector es más corta que su nombre', () => {
  for (const [nombre, abrev] of Object.entries(TM.ABREV_SECTOR)) {
    assert.ok(abrev.length <= nombre.length, `${nombre} → ${abrev}`);
    assert.ok(abrev.length <= 12, `${abrev} sigue siendo largo para un cuadro`);
  }
});

// ── EL CIERRE QUE SE PINTA, no el máximo ────────────────────────────────
// El chip dijo "cierre del martes" un martes a las 15:54 con la cosecha sin
// correr. La causa no era el texto: era que `ultimo_cierre` se sacaba con un
// max() sobre los 300 cuadros.
test('el rótulo del cierre es el que usa la mayoría, no el más nuevo', () => {
  // 299 al lunes, 1 al martes: lo que se está viendo es el lunes.
  const cuadros = Array.from({ length: 300 }, (_, i) => ({ fecha_precio: i === 0 ? '2026-09-22' : '2026-09-21' }));
  const c = cierreQueSePinta(cuadros);
  assert.equal(c.fecha, '2026-09-21', 'un disidente no arrastra el rótulo');
  assert.equal(c.cuadros, 299);
  assert.ok(c.concuerdan);
});

test('si el mapa mezcla dos cierres de verdad, NO rotula ninguno y dice por qué', () => {
  const cuadros = [
    ...Array.from({ length: 5 }, () => ({ fecha_precio: '2026-09-22' })),
    ...Array.from({ length: 5 }, () => ({ fecha_precio: '2026-09-21' })),
  ];
  const c = cierreQueSePinta(cuadros);
  assert.equal(c.fecha, null, 'sin mayoría abrumadora no se inventa un rótulo');
  assert.equal(c.concuerdan, false);
  assert.match(c.motivo, /mezcla 2 cierres/);
  // Y el reparto viaja, para que la pantalla lo pueda mostrar en vez de callarse.
  assert.deepEqual(c.reparto, { '2026-09-22': 5, '2026-09-21': 5 });
});

test('sin ninguna fecha, el cierre se declara ausente con su motivo', () => {
  const c = cierreQueSePinta([{ symbol: 'X' }, {}]);
  assert.equal(c.fecha, null);
  assert.match(c.motivo, /ningún cuadro/);
});
