// ═══════════════════════════════════════════════════════════════════════
// LA CAP DE LOS ADR — el caso TSM
//
// El mapa dimensiona por capitalización. Una cap mal medida no es un número
// feo: es el cuadro más grande de la pantalla mintiendo de tamaño. Estas
// pruebas fijan que el desajuste se detecte SIN saber de antemano de dónde
// viene, y que un ADR sin confirmar salga gris punteado en vez de grande.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { veredictoCapUs, auditaCapUs, candidatasCapUs } from '../api/_lib/mercado-cap-us.js';

// Una estadounidense sana: la declarada en USD cuadra con acciones×precio.
const NVDA = { symbol: 'NVDA', moneda: 'USD', declarada: 4_000_000, acciones: 24_400, precio_usd: 163.93 };

test('una emisora en USD cuyas dos fuentes cuadran sale VERIFICADA', () => {
  const v = veredictoCapUs(NVDA);
  assert.equal(v.estado, 'verificada');
  assert.equal(v.motivo, null);
  assert.ok(Math.abs(v.error_pct) <= 5, `error ${v.error_pct}`);
  assert.ok(v.cap_usd > 0, 'la cap verificada viaja para dimensionar el cuadro');
});

test('la cap que viaja es la DECLARADA, no un promedio de las dos', () => {
  const v = veredictoCapUs(NVDA);
  // Promediar dos fuentes fabricaría un número que ninguna midió.
  assert.equal(v.cap_usd, NVDA.declarada * 1e6);
});

// ── EL CASO QUE DESTAPÓ EL TELÉFONO ────────────────────────────────────
test('una cap declarada en otra moneda sale GRIS y el motivo nombra la moneda', () => {
  // La forma del bug de TSM: la cap viene en la moneda de reporte y se guardó
  // como si fueran dólares. El número exacto da igual — lo que importa es que
  // no concuerde con acciones×precio y que la moneda lo explique.
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD',
    declarada: 32_000_000,          // millones de TWD
    acciones: 5_190, precio_usd: 200,
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null, 'sin tamaño antes que con un tamaño inventado');
  assert.match(v.motivo, /TWD/);
});

test('el múltiplo delata de qué tipo es el desajuste', () => {
  const v = veredictoCapUs({ symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, acciones: 5_190, precio_usd: 200 });
  // ~30× apunta a tipo de cambio; ~5× a ratio de ADR; ~1e6 a unidades.
  assert.ok(v.multiplo > 20 && v.multiplo < 45, `multiplo ${v.multiplo}`);
});

test('aunque la moneda sea USD, un desajuste >5% sale gris', () => {
  // El ratio del ADR es la otra trampa, y no la delata la moneda.
  const v = veredictoCapUs({ symbol: 'ADR', moneda: 'USD', declarada: 1_000_000, acciones: 1_000, precio_usd: 200 });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /difiere/);
});

// ── FALLAR CERRADO ─────────────────────────────────────────────────────
test('moneda desconocida NO se asume USD', () => {
  // Suponer USD es exactamente la suposición que rompió el mapa.
  const v = veredictoCapUs({ symbol: 'X', declarada: 1_000, acciones: 10, precio_usd: 100 });
  assert.equal(v.estado, 'gris_punteado');
  assert.match(v.motivo, /no se sabe en qué moneda/);
});

test('una sola fuente nunca se verifica a sí misma', () => {
  const soloDeclarada = veredictoCapUs({ symbol: 'A', moneda: 'USD', declarada: 1_000 });
  assert.equal(soloDeclarada.estado, 'gris_punteado');
  assert.match(soloDeclarada.motivo, /no se puede reconstruir/);

  const soloRecon = veredictoCapUs({ symbol: 'B', moneda: 'USD', acciones: 10, precio_usd: 100 });
  assert.equal(soloRecon.estado, 'gris_punteado');
  assert.match(soloRecon.motivo, /segunda fuente/);
});

test('sin ninguna fuente lo dice, no truena', () => {
  const v = veredictoCapUs({ symbol: 'C' });
  assert.equal(v.estado, 'gris_punteado');
  assert.match(v.motivo, /ninguna fuente/);
});

test('candidatasCapUs no marca como USD una declarada sin moneda', () => {
  const [decl] = candidatasCapUs({ declarada: 100, acciones: 1, precio_usd: 1 });
  assert.equal(decl.usd, false);
});

// ── LA AUDITORÍA, que es lo que hay que reportar ───────────────────────
test('la auditoría cuenta, agrupa por moneda y ordena por el que más miente', () => {
  const a = auditaCapUs([
    NVDA,
    { symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, acciones: 5_190, precio_usd: 200 },
    { symbol: 'SAP', moneda: 'EUR', declarada: 300_000, acciones: 1_200, precio_usd: 250 },
    { symbol: 'MSFT', moneda: 'USD', declarada: 3_700_000, acciones: 7_430, precio_usd: 498 },
  ]);
  assert.equal(a.total, 4);
  assert.equal(a.gris_punteado, 2, 'los dos no-USD');
  assert.equal(a.verificadas, 2);
  assert.equal(a.no_usd, 2);
  assert.deepEqual(a.por_moneda, { USD: 2, TWD: 1, EUR: 1 });
  assert.equal(a.umbral_pct, 5, 'el umbral es el congelado de G2, no uno nuevo');
  assert.equal(a.peores[0].symbol, 'TSM', 'el que más miente de tamaño va primero');
});

// ═══════════════════════════════════════════════════════════════════════
// LA RAZÓN DEL ADR, Y EL ORDEN DE PRECEDENCIA
//
// La referencia manual de Yahoo NO SE PINTA: despeja la razón y nada más. Lo
// que el mapa dibuja es `acciones ÷ razón × nuestro cierre`, así que el cuadro
// sigue al mercado en vez de quedarse clavado en la fecha de captura.
// ═══════════════════════════════════════════════════════════════════════
import { razonAdr, referenciaVigente, MILLON } from '../api/_lib/mercado-cap-us.js';

// Un ADR de 5 ordinarias por ADR: 5,190M ordinarias, ADR a 200 USD, y una
// referencia que dice que la empresa vale 5,190M/5 × 200.
const TSM = { acciones: 5_190, precio_usd: 200 };
const REF_TSM = {
  // 1% arriba de la razón exacta, como una captura de verdad: la razón sigue
  // resolviendo a 5:1 y la cap pintada NO coincide con la referencia.
  clave: 'TSM', market_cap_usd: ((TSM.acciones * MILLON * TSM.precio_usd) / 5) * 1.01,
  fuente: 'yahoo-finance-market-cap-intraday', capturada_en: '2026-09-23', vigente_hasta: '2026-09-30',
};
const HOY = new Date('2026-09-24T12:00:00Z');

test('la razón se despeja y sale una proporción de ADR, no un decimal suelto', () => {
  const r = razonAdr({ cap_referencia_usd: REF_TSM.market_cap_usd, acciones_millones: TSM.acciones, precio_usd: TSM.precio_usd });
  assert.equal(r.ok, true);
  assert.equal(r.razon, 5);
  assert.equal(r.etiqueta, '5:1');
});

test('una razón que no se parece a ninguna proporción NO se fuerza a la más cercana', () => {
  // Captura vieja, o acciones de otra clase: el desajuste no es una razón de
  // ADR y darle un tamaño igual sería el bug que esto vino a cerrar.
  const r = razonAdr({ cap_referencia_usd: REF_TSM.market_cap_usd / 1.13, acciones_millones: TSM.acciones, precio_usd: TSM.precio_usd });
  assert.equal(r.ok, false);
  assert.equal(r.razon, null);
  assert.match(r.motivo, /no se parece a ninguna proporción/);
});

test('con referencia vigente la cap pintada es NUESTRO cálculo, no la referencia', () => {
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    referencia: REF_TSM, hoy: HOY,
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.cap_usd, (TSM.acciones * MILLON * TSM.precio_usd) / 5);
  assert.equal(v.fuente, 'calc: acciones÷5:1×neon');
  assert.equal(v.via, 'referencia_manual');
  // Y la cap de referencia no viaja al render en ningún campo.
  assert.equal(JSON.stringify(v).includes(String(REF_TSM.market_cap_usd)), false,
    'la referencia manual nunca se pinta: sólo el veredicto');
});

test('una referencia vencida no rescata a nadie: gris y decí que hay que recapturar', () => {
  const v = veredictoCapUs({
    symbol: 'TSM', moneda: 'TWD', declarada: 32_000_000, ...TSM,
    referencia: { ...REF_TSM, vigente_hasta: '2026-06-30' }, hoy: HOY,
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /venció el 2026-06-30/);
});

test('referenciaVigente exige que la fila diga hasta cuándo vale', () => {
  const v = referenciaVigente({ clave: 'X', market_cap_usd: 1 }, HOY);
  assert.equal(v.vigente, false);
  assert.match(v.motivo, /no declara hasta cuándo/);
});

// ── EDGAR entra SÓLO como segunda oportunidad ──────────────────────────
test('si el par de Finnhub ya concuerda, EDGAR no cambia nada', () => {
  // Las 279 verificadas de la auditoría no se mueven de fuente por haber
  // agregado un árbitro: nadie reportó que estuvieran rotas.
  const v = veredictoCapUs({ ...NVDA, edgar: { acciones: 1, fecha_portada: '2025-08-01' } });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.via, 'finnhub');
  assert.equal(v.cap_usd, NVDA.declarada * 1e6);
});

test('cuando Finnhub no concuerda, EDGAR decide y la fuente lo dice', () => {
  const v = veredictoCapUs({
    symbol: 'MNST', moneda: 'USD', declarada: 60_000, acciones: 500, precio_usd: 57.7,
    edgar: { acciones: 1_040_000_000, fecha_portada: '2025-07-31' },
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.via, 'edgar');
  assert.equal(v.fuente, 'calc: edgar×neon');
  assert.equal(v.cap_usd, 1_040_000_000 * 57.7);
  assert.ok(Math.abs(v.finnhub_error_pct) > 5, 'el desajuste con Finnhub queda dicho, no se borra');
});

test('si EDGAR tampoco cuadra, gris con las DOS causas', () => {
  const v = veredictoCapUs({
    symbol: 'VMRK', moneda: 'USD', declarada: 10_000, acciones: 100, precio_usd: 46,
    edgar: { acciones: 100_000_000, fecha_portada: '2025-07-31' },
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /techo propio 10%/);
  assert.match(v.motivo, /contra Finnhub/);
});
