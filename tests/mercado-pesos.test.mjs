// ═══════════════════════════════════════════════════════════════════════
// EL RENDIMIENTO EN PESOS — PROBADO CONTRA LOS PRECIOS, NO CONTRA SÍ MISMO
//
// El encargo pide "test unitario del cálculo con un caso conocido". Una prueba
// que verifique `(1+a)(1+b)−1` contra `(1+a)(1+b)−1` no prueba nada: repite la
// fórmula. Así que acá el caso conocido se arma AL REVÉS — se construyen los
// precios en pesos, se calcula el rendimiento directo, y se exige que la
// composición dé lo mismo. Si la fórmula estuviera mal, esto se pone rojo.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { rendimientoEnPesos, cruceContraPeso, enPesos, ETIQUETA_PESOS } from '../qd-pesos.js';

// El % que devolvería `qdPeriodChange`: de un valor a otro, en por ciento.
const pct = (de, a) => ((a / de) - 1) * 100;

test('el caso conocido: el S&P +20% con el dólar +10% da +32% en pesos, no +30%', () => {
  // Índice: 5,000 → 6,000 (+20%). FIX: 17.00 → 18.70 (+10%).
  const idx0 = 5000, idx1 = 6000, fix0 = 17.00, fix1 = 18.70;

  // La verdad, calculada desde los precios EN PESOS y sin usar la fórmula.
  const enPesos0 = idx0 * fix0;          //  85,000
  const enPesos1 = idx1 * fix1;          // 112,200
  const verdad = pct(enPesos0, enPesos1);

  const r = rendimientoEnPesos(pct(idx0, idx1), pct(fix0, fix1));
  assert.ok(Math.abs(r.pct - verdad) < 1e-9, `${r.pct} vs ${verdad}`);
  assert.ok(Math.abs(r.pct - 32) < 1e-9, `${r.pct}`);

  // Y el término que la suma ingenua se come: 0.20 × 0.10 = 2 puntos de
  // rendimiento real, no de redondeo.
  assert.ok(Math.abs(r.cruzado_pct - 2) < 1e-9, `${r.cruzado_pct}`);
  assert.notEqual(Math.round(r.pct), 30, 'sumar los dos porcientos es el error clásico');
});

test('también con signos cruzados: el índice sube y el peso se fortalece', () => {
  // Índice +20%, pero el dólar cae de 18.70 a 17.00 (−9.09%). En pesos se gana
  // menos que en dólares, y eso tiene que salir sin que nadie ajuste signos.
  const verdad = pct(5000 * 18.70, 6000 * 17.00);
  const r = rendimientoEnPesos(pct(5000, 6000), pct(18.70, 17.00));
  assert.ok(Math.abs(r.pct - verdad) < 1e-9, `${r.pct} vs ${verdad}`);
  assert.ok(r.pct > 0 && r.pct < 20, `${r.pct}: gana, pero menos que en dólares`);
});

test('el Nikkei: el cruce JPY/MXN se arma con el FIX y USD/JPY, y cuadra con los precios', () => {
  // Nikkei 40,000 → 42,000 en YENES.
  // USD/JPY (yenes por dólar) 150 → 157.5.  FIX (pesos por dólar) 17 → 18.70.
  const n0 = 40000, n1 = 42000, jpy0 = 150, jpy1 = 157.5, fix0 = 17, fix1 = 18.70;

  // La verdad: el Nikkei en pesos es yenes ÷ (yenes por dólar) × (pesos por dólar).
  const p0 = (n0 / jpy0) * fix0;
  const p1 = (n1 / jpy1) * fix1;
  const verdad = pct(p0, p1);

  const cruce = cruceContraPeso('JPY', {
    usdMxnPct: pct(fix0, fix1),
    usdPorUnidadPct: pct(jpy0, jpy1),
  });
  const r = rendimientoEnPesos(pct(n0, n1), cruce.pct);
  assert.ok(Math.abs(r.pct - verdad) < 1e-9, `${r.pct} vs ${verdad}`);
  assert.equal(cruce.via, 'fix÷JPYusd');
});

test('el IPC ya está en pesos: el cruce es 0 y el rendimiento en pesos ES el local', () => {
  const c = cruceContraPeso('MXN', { usdMxnPct: 10 });
  assert.equal(c.pct, 0);
  assert.equal(c.via, 'mxn_es_el_peso');
  const r = rendimientoEnPesos(7.5, c.pct);
  assert.ok(Math.abs(r.pct - 7.5) < 1e-9, `${r.pct}`);
});

// ── REGLA 2: SIN EL CRUCE, "—" CON CAUSA ───────────────────────────────
test('sin serie de la moneda no se estima: null con la causa dicha', () => {
  // Del FTSE en libras no hay serie GBP en `/api/macro-markets`.
  const c = cruceContraPeso('GBP', { usdMxnPct: 10 });
  assert.equal(c.pct, null);
  assert.match(c.motivo, /no hay serie GBP\/USD/);

  const r = enPesos({ pctLocal: 5, moneda: 'GBP', usdMxnPct: 10 });
  assert.equal(r.pct, null);
  assert.equal(r.local_pct, 5, 'el local se conserva: es un dato bueno');
  assert.match(r.motivo, /GBP\/USD/);
  assert.equal(r.fuente, null, 'sin número no hay fuente que declarar');
});

test('sin FIX no hay rendimiento en pesos, ni siquiera para un activo en dólares', () => {
  const c = cruceContraPeso('USD', {});
  assert.equal(c.pct, null);
  assert.match(c.motivo, /FIX USD\/MXN/);
});

test('un activo sin moneda declarada no se asume en dólares', () => {
  // Es el mismo fallo que XNDU en el mapa de EE.UU.: no saber la moneda es un
  // insumo que falta, y suponer USD es la suposición que rompió el mapa.
  const c = cruceContraPeso(null, { usdMxnPct: 10 });
  assert.equal(c.pct, null);
  assert.match(c.motivo, /no declara en qué moneda/);
});

test('`num(null)` es 0: un rendimiento ausente no vale cero', () => {
  // Cuarta vez que esta coerción aparece en el proyecto. Un 0 acá diría
  // "no se movió", que es una afirmación, y lo que hay es una ausencia.
  for (const v of [null, undefined, '', NaN]) {
    assert.equal(rendimientoEnPesos(v, 10).pct, null, String(v));
    assert.equal(rendimientoEnPesos(10, v).pct, null, String(v));
  }
  // Y un cero de verdad sí se respeta.
  assert.equal(rendimientoEnPesos(0, 0).pct, 0);
  assert.equal(rendimientoEnPesos(-100, 10).pct, -100, 'un activo a cero sigue siendo −100%');
});

// ── REGLA 3: CADA NÚMERO DICE SU FUENTE Y SU FECHA ─────────────────────
test('cada rendimiento en pesos dice qué FIX usó y de qué fecha', () => {
  const r = enPesos({
    pctLocal: 20, moneda: 'USD', usdMxnPct: 10,
    fix: { serie: 'SF43718', fecha: '2026-09-28', valor: 18.70 },
  });
  assert.ok(Math.abs(r.pct - 32) < 1e-9);
  assert.equal(r.fuente, 'calc: banxico:SF43718 (FIX del 2026-09-28)');
  assert.equal(r.fix_fecha, '2026-09-28');
  assert.equal(r.fix_valor, 18.70);
  assert.equal(r.etiqueta, ETIQUETA_PESOS);
  assert.equal(ETIQUETA_PESOS, 'rendimiento en pesos', 'la etiqueta del encargo, sin abreviar');
});

test('un FIX sin fecha se declara como lo que es, no se calla', () => {
  const r = enPesos({ pctLocal: 20, moneda: 'USD', usdMxnPct: 10 });
  assert.match(r.fuente, /FIX sin fecha declarada/);
});
