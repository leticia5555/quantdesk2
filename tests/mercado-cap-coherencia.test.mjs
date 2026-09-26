// ═══════════════════════════════════════════════════════════════════════
// EL JOB Y EL MAPA TIENEN QUE CONTAR LO MISMO
//
// El 2026-09-25, sobre la misma base de producción:
//
//     ?job=auditoria-cap  →  279 verificadas / 26 grises
//     /api/mercado-mapa   →  281 verificadas / 24 grises
//
// El veredicto era el mismo `veredictoCapUs` en los dos lados. Lo que difería era
// la FILA que cada uno le armaba: el mapa le pasaba las referencias de ADR y el
// job no, así que TSM y VALE salían grises "la cap viene en TWD/BRL" en el job y
// verificadas en el mapa. Dos opiniones sobre qué está verificado es el bug que
// #241 y #245 ya costaron, y ésta es la tercera vez.
//
// El arreglo estructural es `filaVeredictoCapUs`: un solo sitio que arma la fila.
// Esta prueba es el candado: compara los CONTEOS de los dos caminos sobre una
// misma base y falla si alguien vuelve a armar la fila a mano en uno de ellos.
// ═══════════════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { armaMapaUs } from '../api/_lib/mercado-mapa.js';
import {
  auditaCapUs, filaVeredictoCapUs, cierreHasta, MILLON,
} from '../api/_lib/mercado-cap-us.js';

const AHORA = new Date('2026-09-25T22:00:00Z');
const DIAS = ['2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];

/** Serie plana: el precio no cambia salvo en la fecha que interese. */
function precios(symbol, porFecha) {
  return DIAS.map((fecha) => ({
    symbol, fecha, cierre: porFecha[fecha], cierre_ajustado: porFecha[fecha],
  }));
}
const plano = (v, ultimo = v) => Object.fromEntries(
  DIAS.map((d, i) => [d, i === DIAS.length - 1 ? ultimo : v]),
);

// ── La base: una de cada clase de veredicto ───────────────────────────
const UNIVERSO = [
  // Par de Finnhub que concuerda → verificada por finnhub.
  { symbol: 'NVDA', nombre: 'Nvidia', sector_etf: 'XLK', market_cap: 4_000_000e6,
    cap_moneda: 'USD', acciones_millones: 24_400, cap_fuente: 'finnhub:metric' },
  // ADR con referencia manual: la cap declarada viene en TWD y las acciones son
  // ordinarias. Sin la referencia esto es gris; con ella, verificada 5:1.
  { symbol: 'TSM', nombre: 'TSMC', sector_etf: 'XLK', market_cap: 32_000_000e6,
    cap_moneda: 'TWD', acciones_millones: 5_190, cap_fuente: 'finnhub:metric' },
  // Desajuste en USD sin EDGAR → gris.
  { symbol: 'MNST', nombre: 'Monster', sector_etf: 'XLP', market_cap: 60_000e6,
    cap_moneda: 'USD', acciones_millones: 500, cap_fuente: 'finnhub:metric' },
  // Desajuste en USD CON acciones de EDGAR que cuadran → verificada por edgar.
  { symbol: 'ORCL', nombre: 'Oracle', sector_etf: 'XLK', market_cap: 1_008_000e6,
    cap_moneda: 'USD', acciones_millones: 2_000, cap_fuente: 'finnhub:metric',
    acciones_edgar_millones: 2_800, acciones_edgar_portada: '2025-08-31' },
];

const PRECIOS = [
  ...precios('NVDA', plano(163.93)),
  // TSM: 200 el día de la captura (2026-09-23), 210 hoy. La razón se despeja con
  // 200 y el tamaño se pinta con 210.
  ...precios('TSM', { ...plano(200), '2026-09-24': 205, '2026-09-25': 210 }),
  ...precios('MNST', plano(57.7)),
  ...precios('ORCL', plano(360)),
];

const REFS = new Map([
  ['TSM', {
    clave: 'TSM', market_cap_usd: (5_190 * MILLON * 200) / 5,
    fuente: 'yahoo-finance-market-cap-intraday', capturada_en: '2026-09-23', vigente_hasta: '2026-09-30',
  }],
]);

/** Lo que hace el job: una fila por símbolo, con el MISMO adaptador que el mapa. */
function entradasComoElJob() {
  const porSymbol = new Map();
  for (const p of PRECIOS) {
    if (!porSymbol.has(p.symbol)) porSymbol.set(p.symbol, []);
    porSymbol.get(p.symbol).push(p);
  }
  return UNIVERSO.map((u) => {
    const filasP = porSymbol.get(u.symbol) || [];
    const ref = REFS.get(u.symbol) || null;
    const enCaptura = ref ? cierreHasta(filasP, ref.capturada_en) : null;
    const ultimo = filasP[filasP.length - 1];
    return filaVeredictoCapUs(u, {
      precio_usd: ultimo ? ultimo.cierre : null,
      precio_captura: enCaptura ? enCaptura.cierre : null,
      referencias: REFS,
      hoy: AHORA,
    });
  });
}

test('el job y el mapa dan el MISMO conteo de verificadas y grises', () => {
  const { cuadros } = armaMapaUs({ universo: UNIVERSO, precios: PRECIOS, ahora: AHORA, referencias: REFS });
  const mapa = {
    verificadas: cuadros.filter((c) => c.estado === 'verificada').length,
    grises: cuadros.filter((c) => c.estado === 'gris_punteado').length,
  };

  const a = auditaCapUs(entradasComoElJob());
  const job = { verificadas: a.verificadas, grises: a.gris_punteado };

  assert.deepEqual(job, mapa, `job ${JSON.stringify(job)} vs mapa ${JSON.stringify(mapa)}`);
  assert.equal(mapa.verificadas, 3, 'NVDA por finnhub, TSM por referencia, ORCL por edgar');
  assert.equal(mapa.grises, 1, 'MNST, que no tiene EDGAR todavía');
});

test('y el MISMO veredicto símbolo por símbolo, con la misma fuente', () => {
  const { cuadros } = armaMapaUs({ universo: UNIVERSO, precios: PRECIOS, ahora: AHORA, referencias: REFS });
  const porJob = new Map(auditaCapUs(entradasComoElJob()).veredictos.map((v) => [v.symbol, v]));

  for (const c of cuadros) {
    const v = porJob.get(c.symbol);
    assert.ok(v, `el job no tiene veredicto para ${c.symbol}`);
    assert.equal(v.estado, c.estado, `${c.symbol}: job ${v.estado} vs mapa ${c.estado}`);
    assert.equal(v.via || null, c.cap_via || null, `${c.symbol}: vía distinta`);
  }

  // Y el caso que destapó la divergencia, nombrado: TSM verificada en los dos.
  assert.equal(porJob.get('TSM').estado, 'verificada');
  assert.equal(porJob.get('TSM').via, 'referencia_manual');
});

test('el tamaño de TSM usa el cierre de HOY, y la razón el de la captura', () => {
  const { cuadros } = armaMapaUs({ universo: UNIVERSO, precios: PRECIOS, ahora: AHORA, referencias: REFS });
  const tsm = cuadros.find((c) => c.symbol === 'TSM');
  assert.equal(tsm.estado, 'verificada');
  assert.equal(tsm.cap_razon_adr, '5:1');
  // 5,190M ordinarias ÷ 5 × 210 (el cierre del 25), no × 200 (el de la captura).
  assert.equal(tsm.cap, (5_190 * MILLON * 210) / 5);
  assert.equal(tsm.cap_fuente, 'calc: acciones÷5:1×neon');
});

test('sin la referencia, TSM se va a gris en los DOS lados — nunca en uno solo', () => {
  const sinRefs = new Map();
  const { cuadros } = armaMapaUs({ universo: UNIVERSO, precios: PRECIOS, ahora: AHORA, referencias: sinRefs });
  const mapaGris = cuadros.filter((c) => c.estado === 'gris_punteado').map((c) => c.symbol).sort();

  const porSymbol = new Map();
  for (const p of PRECIOS) {
    if (!porSymbol.has(p.symbol)) porSymbol.set(p.symbol, []);
    porSymbol.get(p.symbol).push(p);
  }
  const entradas = UNIVERSO.map((u) => {
    const filasP = porSymbol.get(u.symbol) || [];
    const ultimo = filasP[filasP.length - 1];
    return filaVeredictoCapUs(u, {
      precio_usd: ultimo ? ultimo.cierre : null, precio_captura: null, referencias: sinRefs, hoy: AHORA,
    });
  });
  const jobGris = auditaCapUs(entradas).veredictos
    .filter((v) => v.estado === 'gris_punteado').map((v) => v.symbol).sort();

  assert.deepEqual(jobGris, mapaGris);
  assert.deepEqual(mapaGris, ['MNST', 'TSM']);
});
