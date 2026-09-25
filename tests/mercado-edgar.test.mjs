// ═══════════════════════════════════════════════════════════════════════
// EDGAR DE ÁRBITRO — y su techo, que no es el de G2
//
// Las 21 emisoras en USD de la auditoría del 2026-09-24 no cuadraban porque
// `shareOutstanding` estaba viejo, no porque la cap estuviera mal: tres
// múltiplos pegados a 2× (VMRK 2.1765, MNST 2.0782, APH 1.9847) son un split
// que Finnhub no reflejó. Estas pruebas fijan que el conteo de la portada del
// 10-Q resuelva ese caso, que el split NO se cuele como verificado, y que el
// 10% de acá quede separado del 5% de G2.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapaCik, accionesDeCompanyConcept, veredictoCapEdgar, rutaCompanyConcept, UMBRAL_EDGAR_PCT,
} from '../api/_lib/mercado-edgar.js';
import { CRITERIOS } from '../api/_lib/mercado-fase0.js';

test('el techo de EDGAR es 10% y NO es el de G2', () => {
  // Si alguien los unifica, esta prueba se pone roja y obliga a decir por qué.
  // Son dos preguntas distintas: G2 compara dos medidas del mismo instante;
  // acá se comparan acciones de la portada del trimestre contra el cierre de
  // hoy, donde algo de deriva es lo esperado.
  assert.equal(UMBRAL_EDGAR_PCT, 10);
  assert.notEqual(UMBRAL_EDGAR_PCT, CRITERIOS.g2_max_error_pct);
});

test('el CIK se rellena a 10 dígitos y la ruta lo usa tal cual', () => {
  const m = mapaCik({ 0: { cik_str: 320193, ticker: 'aapl', title: 'Apple' }, 1: { cik_str: 789019, ticker: 'MSFT' } });
  assert.equal(m.get('AAPL'), '0000320193');
  assert.match(rutaCompanyConcept(m.get('AAPL')), /CIK0000320193\/dei\/EntityCommonStockSharesOutstanding\.json$/);
});

test('un ticker que EDGAR no conoce no se inventa', () => {
  const m = mapaCik({ 0: { cik_str: 320193, ticker: 'AAPL' } });
  assert.equal(m.get('SPCX'), undefined);
});

// ── LEER LA PORTADA ────────────────────────────────────────────────────
const CONCEPTO = {
  cik: 865752,
  units: {
    shares: [
      { end: '2025-05-01', val: 1000000000, form: '10-Q', filed: '2025-05-05', fy: 2025, fp: 'Q1' },
      { end: '2025-08-01', val: 2000000000, form: '10-Q', filed: '2025-08-04', fy: 2025, fp: 'Q2' },
      // Un 8-K no trae portada con conteo: no debe ganar por ser el más nuevo.
      { end: '2025-09-10', val: 999, form: '8-K', filed: '2025-09-10' },
    ],
  },
};

test('gana el último 10-Q por fecha de presentación, no el archivo más nuevo', () => {
  const a = accionesDeCompanyConcept(CONCEPTO);
  assert.equal(a.acciones, 2000000000);
  assert.equal(a.form, '10-Q');
  assert.equal(a.fecha_portada, '2025-08-01', 'la fecha de portada es el instante al que vale el conteo');
  assert.equal(a.presentado_en, '2025-08-04', 'y la de presentación es cuándo nos enteramos');
});

test('sin formas con portada lo dice en vez de devolver un número', () => {
  const a = accionesDeCompanyConcept({ units: { shares: [{ end: '2025-09-10', val: 5, form: '8-K' }] } });
  assert.equal(a.acciones, null);
  assert.match(a.motivo, /10-Q/);
});

test('un CIK sin el concepto lo dice con su causa', () => {
  const a = accionesDeCompanyConcept({});
  assert.equal(a.acciones, null);
  assert.match(a.motivo, /no reporta dei:EntityCommonStockSharesOutstanding/);
});

// ── EL VEREDICTO ───────────────────────────────────────────────────────
test('dentro del 10% queda verificada y la cap que viaja es EDGAR × nuestro cierre', () => {
  // ORCL en la auditoría: 10.69% contra Finnhub. Con las acciones de la
  // portada el desajuste baja y entra — que es justo el caso que el 5% de G2
  // habría dejado gris sin que nadie tuviera nada que arreglar.
  const v = veredictoCapEdgar({
    symbol: 'ORCL', declarada_usd: 1_050e9, acciones_edgar: 2_800_000_000,
    precio_usd: 360, fecha_portada: '2025-08-31',
  });
  assert.equal(v.estado, 'verificada');
  assert.equal(v.cap_usd, 2_800_000_000 * 360, 'el número pintado es el nuestro, no el declarado');
  assert.equal(v.fuente, 'calc: edgar×neon');
  assert.equal(v.fecha_portada, '2025-08-31', 'la portada viaja pegada al número');
  assert.ok(Math.abs(v.error_pct) <= 10);
});

test('un split 2:1 sigue siendo gris: 100 puntos de error no los tapa el 10%', () => {
  const v = veredictoCapEdgar({
    symbol: 'MNST', declarada_usd: 60e9, acciones_edgar: 500_000_000, precio_usd: 57.7,
    fecha_portada: '2025-07-31',
  });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null, 'sin tamaño antes que con un tamaño inventado');
  assert.ok(v.multiplo > 1.9 && v.multiplo < 2.3, `multiplo ${v.multiplo}`);
  assert.match(v.motivo, /techo propio 10%/);
});

test('sin acciones de EDGAR, o sin cierre nuestro, es insumo que falta y no hallazgo', () => {
  const sinAcc = veredictoCapEdgar({ symbol: 'X', declarada_usd: 10e9, acciones_edgar: null, precio_usd: 10 });
  assert.equal(sinAcc.estado, 'gris_punteado');
  assert.equal(sinAcc.auditable, false);
  assert.match(sinAcc.motivo, /no dio acciones/);

  const sinPx = veredictoCapEdgar({ symbol: 'X', declarada_usd: 10e9, acciones_edgar: 1e9, precio_usd: null });
  assert.equal(sinPx.auditable, false);
  assert.match(sinPx.motivo, /cierre nuestro/);
});

test('una sola fuente no se verifica a sí misma, tampoco EDGAR', () => {
  const v = veredictoCapEdgar({ symbol: 'X', declarada_usd: null, acciones_edgar: 1e9, precio_usd: 10 });
  assert.equal(v.estado, 'gris_punteado');
  assert.equal(v.cap_usd, null);
  assert.match(v.motivo, /ninguna cap declarada/);
});
