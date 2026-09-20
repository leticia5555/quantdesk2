// ═══════════════════════════════════════════════════════════════════
// tests/mercado-fase0.test.mjs — el MEDIDOR de la Fase 0 de /mercado,
// probado contra fixtures sintéticos con la respuesta plantada.
//
// Por qué existe: el sandbox donde se escribió el medidor no llega a Yahoo,
// Finnhub ni EDGAR (403 del proxy de egress). Sin red no se ganan los números
// de las fuentes, pero sí se puede probar que el instrumento mide bien.
//
// La Fase 0 del Congreso perdió dos corridas enteras por un extractor que
// reportaba rojo sin estar probado (docs/congreso-fase0.md §6.1). Ese error
// no se repite: acá cada función del censo tiene su caso verde, su caso rojo,
// y —lo que más importa— su caso de "no se pudo medir", que NO es lo mismo
// que rojo.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CRITERIOS, CAMPOS_METRIC,
  censoUniversoUs, capMxCandidatas, errorPct, veredictoCapMx,
  presupuestoPrecios, censoRetornoTotal, anclaYtd,
  coberturaMetric, ventanaUpa, proximoReporte,
  coberturaCompanyFacts, censoForm4, tablero,
} from '../api/_lib/mercado-fase0.js';

// Reloj fijo para todo el archivo. Nada acá mide la hora en que corrió.
const AHORA = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));   // 20-sep-2026 12:00Z
const horasAntes = (h) => new Date(AHORA.getTime() - h * 3600000).toISOString();

// ───────────────────────── Q1 · universo US ─────────────────────────

test('Q1: un universo con cap y sector en 10 sectores pasa G1', () => {
  // 11 sectores × 12 nombres = 132 nombres, todos con cap fresca.
  const sectores = {}; const caps = []; const universo = [];
  const etfs = ['XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'];
  etfs.forEach((etf, i) => {
    for (let j = 0; j < 12; j++) {
      const sym = `S${i}_${j}`;
      universo.push(sym);
      sectores[sym] = etf;
      caps.push({ symbol: sym, market_cap: 5e9, fetched_at: horasAntes(10) });
    }
  });
  const r = censoUniversoUs({ caps, sectores, universo, ahora: AHORA });
  assert.equal(r.candidatos, 132);
  assert.equal(r.con_cap_y_sector, 132);
  assert.equal(r.sectores_con_piso.length, 11);
  assert.equal(r.horas_frescura_cap_mas_vieja, 10);
  assert.ok(r.verde, r.razones.join(' · '));
});

test('Q1: un total grande con sectores flacos NO pasa — el piso es por sector', () => {
  // 200 nombres, pero todos en 3 sectores. El total cumple; el mapa por
  // sector no existe. Este es exactamente el modo de falla que un piso
  // global no ve.
  const sectores = {}; const caps = []; const universo = [];
  ['XLK', 'XLF', 'XLV'].forEach((etf, i) => {
    for (let j = 0; j < 67; j++) {
      const sym = `T${i}_${j}`;
      universo.push(sym); sectores[sym] = etf;
      caps.push({ symbol: sym, market_cap: 3e9, fetched_at: horasAntes(5) });
    }
  });
  const r = censoUniversoUs({ caps, sectores, universo, ahora: AHORA });
  assert.ok(r.con_cap_y_sector >= CRITERIOS.g1_min_tickers_con_cap);
  assert.equal(r.sectores_con_piso.length, 3);
  assert.equal(r.verde, false);
  assert.match(r.razones.join(' '), /sectores llegan a/);
});

test('Q1: una cap rancia tumba G1 aunque la cobertura sea perfecta', () => {
  const sectores = {}; const caps = []; const universo = [];
  const etfs = ['XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'];
  etfs.forEach((etf, i) => {
    for (let j = 0; j < 12; j++) {
      const sym = `U${i}_${j}`;
      universo.push(sym); sectores[sym] = etf;
      // Una sola fila vieja: 30 días. Basta para tumbarlo — y tiene que
      // bastar, porque el tamaño del cuadro sale de ahí.
      caps.push({ symbol: sym, market_cap: 4e9, fetched_at: horasAntes(i === 0 && j === 0 ? 720 : 6) });
    }
  });
  const r = censoUniversoUs({ caps, sectores, universo, ahora: AHORA });
  assert.equal(r.verde, false);
  assert.match(r.razones.join(' '), /720h/);
});

test('Q1: el screener sin sector cuenta como cobertura faltante, no como sector nulo', () => {
  // arena_screener NO tiene columna de sector — es el hecho que el censo
  // tiene que reportar. Un símbolo sin sector no debe inventarse un bucket.
  const r = censoUniversoUs({
    screener: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
    caps: [{ symbol: 'AAPL', market_cap: 3e12, fetched_at: horasAntes(2) }],
    sectores: {},
    ahora: AHORA,
  });
  assert.equal(r.candidatos, 2);
  assert.equal(r.con_cap, 1);
  assert.equal(r.con_sector, 0);
  assert.equal(r.con_cap_y_sector, 0);
  assert.deepEqual(r.por_sector, {});
  assert.equal(r.verde, false);
});

// ───────────────────── Q2 · capitalización MX ───────────────────────

test('Q2: emisora de una sola serie — el cálculo cuadra y queda verificada', () => {
  // WALMEX sintética: 17,461 millones de acciones a 61.00 → 1.065 billones.
  const cand = capMxCandidatas({
    clave: 'WALMEX',
    acciones_circulacion: 17_461_000_000,
    precios: [{ emisora_serie: 'WALMEX*', cierre: 61 }],
  });
  assert.equal(cand.n_series, 1);
  assert.equal(cand.candidatas.length, 1);
  const v = veredictoCapMx(cand, 17_461_000_000 * 61);
  assert.equal(v.estado, 'verificada');
  assert.equal(v.error_pct, 0);
  assert.equal(v.mejor.serie, 'WALMEX*');
});

test('Q2: UNIDAD VINCULADA — el error es de VECES, y sale gris punteado', () => {
  // La trampa del encargo, plantada: la UBD es un paquete de 5 acciones. Con
  // acciones TOTALES × precio de la UNIDAD, la cap sale ~5× la real.
  const accionesTotales = 17_891_000_000;   // acciones, no unidades
  const precioUnidad = 200;                 // precio de FEMSAUBD (el paquete)
  const capReal = (accionesTotales / 5) * precioUnidad;
  const cand = capMxCandidatas({
    clave: 'FEMSA',
    acciones_circulacion: accionesTotales,
    precios: [{ emisora_serie: 'FEMSAUBD', cierre: precioUnidad }],
  });
  const v = veredictoCapMx(cand, capReal);
  assert.equal(v.estado, 'gris_punteado');
  // El múltiplo es lo que delata el caso: 5×, no "400% de error".
  assert.equal(Math.round(v.multiplo_vs_referencia), 5);
  assert.match(v.motivo, /error 400\.0% con la mejor serie \(FEMSAUBD\)/);
});

test('Q2: VARIAS SERIES — se elige la más cercana, y eso no es hacer trampa', () => {
  // AMX sintética con dos series a precios distintos. La pregunta de Fase 0
  // es "¿existe UNA serie con la que cuadre?". Con la serie B cuadra.
  const acciones = 62_000_000_000;
  const cand = capMxCandidatas({
    clave: 'AMX',
    acciones_circulacion: acciones,
    precios: [
      { emisora_serie: 'AMXA', cierre: 21.5 },
      { emisora_serie: 'AMXB', cierre: 18.0 },
    ],
  });
  assert.equal(cand.candidatas.length, 2);
  const v = veredictoCapMx(cand, acciones * 18.0);
  assert.equal(v.estado, 'verificada');
  assert.equal(v.mejor.serie, 'AMXB');
  assert.ok(Math.abs(v.error_pct) < 1e-9);
});

test('Q2: sin acciones o sin precio → gris punteado CON MOTIVO, nunca un cero', () => {
  const sinAcciones = capMxCandidatas({ clave: 'X', acciones_circulacion: null, precios: [{ emisora_serie: 'X*', cierre: 10 }] });
  assert.equal(sinAcciones.motivo, 'sin acciones_circulacion');
  assert.equal(veredictoCapMx(sinAcciones, 1e9).estado, 'gris_punteado');

  const sinPrecio = capMxCandidatas({ clave: 'Y', acciones_circulacion: 1e9, precios: [] });
  assert.equal(sinPrecio.motivo, 'sin precio de ninguna serie');
  assert.equal(veredictoCapMx(sinPrecio, 1e9).estado, 'gris_punteado');
});

test('Q2: sin referencia pública NO se declara verificada — se declara no medida', () => {
  // Un cálculo sin contra qué compararse no es un acierto: es un número
  // suelto. Tiene que salir gris igual que un fallo.
  const cand = capMxCandidatas({ clave: 'Z', acciones_circulacion: 1e9, precios: [{ emisora_serie: 'Z*', cierre: 50 }] });
  const v = veredictoCapMx(cand, null);
  assert.equal(v.estado, 'gris_punteado');
  assert.match(v.motivo, /sin capitalización de referencia/);
});

test('Q2: el umbral del encargo es 5% — 4.9% pasa, 5.1% no', () => {
  const ACCIONES = 1000;
  const REFERENCIA = ACCIONES * 100;    // la cap pública: 1000 acciones a $100
  const mk = (precio) => capMxCandidatas({ clave: 'Q', acciones_circulacion: ACCIONES, precios: [{ emisora_serie: 'Q*', cierre: precio }] });
  assert.equal(veredictoCapMx(mk(104.9), REFERENCIA).estado, 'verificada');    // +4.9%
  assert.equal(veredictoCapMx(mk(105.1), REFERENCIA).estado, 'gris_punteado'); // +5.1%
  assert.equal(CRITERIOS.g2_max_error_pct, 5);
});

test('errorPct lleva signo y tolera la referencia en cero sin explotar', () => {
  assert.equal(errorPct(110, 100), 10);
  assert.equal(errorPct(90, 100), -10);
  assert.equal(errorPct(100, 0), null);
  assert.equal(errorPct(null, 100), null);
});

// ──────────────────── Q3 · presupuesto de precios ───────────────────

test('Q3: 200 símbolos on-request NO caben en el presupuesto del endpoint', () => {
  const p = presupuestoPrecios({ n_us: 150, n_mx: 30, n_idx: 20, ms_por_simbolo: 250, concurrencia: 8 });
  assert.equal(p.simbolos, 200);
  assert.equal(p.tandas, 25);
  assert.equal(p.on_request_ms, 6250);
  assert.equal(p.on_request_cabe, false);
  assert.equal(p.recomendacion, 'cron_neon');
});

test('Q3: con el cron ya escrito en Neon, el tiempo deja de depender de n', () => {
  const chico = presupuestoPrecios({ n_us: 10, ms_consulta_neon: 120 });
  const grande = presupuestoPrecios({ n_us: 500, ms_consulta_neon: 120 });
  assert.equal(chico.cron_neon_ms, grande.cron_neon_ms);
  assert.ok(grande.cron_neon_cabe);
});

// ─────────────────── Q4 · retorno total y el hueco YTD ──────────────

test('Q4: un chart con adjclose deja derivar el factor de dividendos', () => {
  const json = {
    chart: { result: [{
      timestamp: [1, 2, 3],
      indicators: {
        quote: [{ close: [100, 101, 102] }],
        adjclose: [{ adjclose: [99, 100.5, 102] }],
      },
      events: { dividends: { 1: { amount: 1, date: 1 } }, splits: {} },
    }] },
  };
  const r = censoRetornoTotal(json);
  assert.ok(r.ok);
  assert.equal(r.puntos, 3);
  assert.equal(r.dias_con_factor, 2);
  assert.equal(r.dividendos_en_events, 1);
  assert.equal(r.nota, null);
});

test('Q4: sin adjclose la serie es de PRECIO — y se dice, no se disfraza', () => {
  const json = { chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [10, 11] }] } }] } };
  const r = censoRetornoTotal(json);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sin adjclose/);
});

test('Q4: factor ≡ 1 se reporta como ambiguo, no como falla ni como éxito', () => {
  const json = {
    chart: { result: [{
      timestamp: [1, 2],
      indicators: { quote: [{ close: [10, 11] }], adjclose: [{ adjclose: [10, 11] }] },
    }] },
  };
  const r = censoRetornoTotal(json);
  assert.ok(r.ok);
  assert.equal(r.dias_con_factor, 0);
  assert.match(r.nota, /o el nombre no pagó dividendos, o adjclose viene sin ajustar/);
});

test('Q4/YTD: el ancla es el último cierre del año anterior', () => {
  const d = (y, m, dd) => Math.floor(Date.UTC(y, m, dd) / 1000);
  const serie = [
    { t: d(2025, 11, 30), c: 100 },   // 30-dic-2025
    { t: d(2025, 11, 31), c: 102 },   // 31-dic-2025 ← ancla
    { t: d(2026, 0, 2), c: 105 },
    { t: d(2026, 8, 19), c: 120 },
  ];
  const a = anclaYtd(serie, AHORA);
  assert.equal(a.cubre, true);
  assert.equal(a.refIdx, 1);
  assert.equal(a.refValue, 102);
});

test('Q4/YTD: una serie que empieza DENTRO del año no cubre YTD — y lo dice', () => {
  // ÉSTE es el hallazgo que importa para R1: /api/macro-markets manda 70
  // puntos de una ventana de 3 meses, y /api/price manda 30 cierres SIN
  // timestamp. Ninguna de las dos puede anclar un YTD, y el modo de falla
  // silencioso sería devolver un número corto rotulado "YTD".
  const d = (y, m, dd) => Math.floor(Date.UTC(y, m, dd) / 1000);
  const serie = Array.from({ length: 70 }, (_, i) => ({ t: d(2026, 6, 1) + i * 86400, c: 100 + i }));
  const a = anclaYtd(serie, AHORA);
  assert.equal(a.cubre, false);
  assert.equal(a.refIdx, null);
  assert.match(a.motivo, /no llega al año anterior/);
});

test('Q4/YTD: una serie sin timestamps no produce un YTD a medias', () => {
  const serie = [100, 101, 102].map((c) => ({ c }));   // como recentPrices
  const a = anclaYtd(serie, AHORA);
  assert.equal(a.cubre, false);
  assert.equal(a.puntos, 0);
});

// ──────────────────── Q5 · fundamentales (metric) ───────────────────

test('Q5: coberturaMetric reporta la grafía que resolvió cada campo', () => {
  const metric = { metric: { marketCapitalization: 3000, peTTM: 28.4, psTTM: 7.1, pbQuarterly: 45, roeTTM: 150 } };
  const c = coberturaMetric(metric);
  assert.equal(c.total, CAMPOS_METRIC.length);
  assert.equal(c.presentes, 5);
  assert.equal(c.detalle.pe.clave_finnhub, 'peTTM');
  assert.ok(c.ausentes.includes('peg'));
  assert.equal(c.verde, false);   // 5 < 8
});

test('Q5: un campo presente pero no numérico cuenta como AUSENTE', () => {
  // Finnhub manda null y strings vacíos en el tier gratis. Un campo que
  // "existe" con valor null pintaría un hueco rotulado como dato.
  const c = coberturaMetric({ metric: { marketCapitalization: null, peTTM: '', psTTM: 7.1 } });
  assert.equal(c.presentes, 1);
  assert.ok(c.ausentes.includes('cap'));
});

test('Q5: con 8 de 12 campos, G5 queda verde', () => {
  const c = coberturaMetric({ metric: {
    marketCapitalization: 1, enterpriseValue: 2, peTTM: 3, peNormalizedAnnual: 4,
    psTTM: 5, pbAnnual: 6, netProfitMarginTTM: 7, roeTTM: 8,
  } });
  assert.equal(c.presentes, 8);
  assert.ok(c.verde);
});

// ──────────────────────── Q6 · UPA real vs est ──────────────────────

test('Q6: solo cuentan los trimestres con actual Y estimate', () => {
  const r = ventanaUpa([
    { period: '2026-06-30', actual: 1.4, estimate: 1.34 },
    { period: '2026-03-31', actual: 1.2, estimate: 1.19 },
    { period: '2025-12-31', actual: 1.5, estimate: null },   // media fila → no cuenta
    { period: '2025-09-30', actual: 1.1, estimate: 1.05 },
    { period: '2025-06-30', actual: 1.0, estimate: 0.98 },
  ]);
  assert.equal(r.filas, 5);
  assert.equal(r.con_actual_y_estimate, 4);
  assert.equal(r.periodo_mas_viejo, '2025-06-30');
  assert.equal(r.periodo_mas_nuevo, '2026-06-30');
  assert.ok(r.verde);
});

test('Q6: 3 trimestres no alcanzan (el encargo pide 4–8)', () => {
  const r = ventanaUpa([
    { period: '2026-06-30', actual: 1, estimate: 1 },
    { period: '2026-03-31', actual: 1, estimate: 1 },
    { period: '2025-12-31', actual: 1, estimate: 1 },
  ]);
  assert.equal(r.verde, false);
});

test('Q6: el próximo reporte sale del calendario, o null — nunca inventado', () => {
  const cal = { earningsCalendar: [
    { symbol: 'NVDA', date: '2026-11-18', hour: 'amc', epsEstimate: 1.42 },
    { symbol: 'NVDA', date: '2027-02-24', hour: 'amc', epsEstimate: null },
    { symbol: 'AAPL', date: '2026-10-29', hour: 'amc', epsEstimate: 2.1 },
  ] };
  const p = proximoReporte(cal, 'nvda');
  assert.equal(p.fecha, '2026-11-18');
  assert.equal(p.eps_estimado, 1.42);
  assert.equal(proximoReporte(cal, 'TSLA'), null);
  assert.equal(proximoReporte({}, 'NVDA'), null);
});

// ─────────────── Q7 · ingresos/utilidad con cita a EDGAR ────────────

test('Q7: solo cuentan los hechos TRIMESTRALES y con accession', () => {
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [
      { start: '2026-04-01', end: '2026-06-30', val: 10, accn: '0000320193-26-000070', form: '10-Q' },
      { start: '2026-01-01', end: '2026-03-31', val: 9, accn: '0000320193-26-000050', form: '10-Q' },
      // anual: 365 días → se descarta, no es un trimestre
      { start: '2025-01-01', end: '2025-12-31', val: 40, accn: '0000320193-26-000010', form: '10-K' },
      // trimestral pero SIN accession → no se puede citar, no cuenta
      { start: '2025-10-01', end: '2025-12-31', val: 11 },
    ] } },
    NetIncomeLoss: { units: { USD: [
      { start: '2026-04-01', end: '2026-06-30', val: 2, accn: 'a', form: '10-Q' },
    ] } },
  } } };
  const c = coberturaCompanyFacts(facts);
  assert.equal(c.por_concepto.Revenues.trimestrales, 3);
  assert.equal(c.por_concepto.Revenues.con_cita, 2);
  assert.deepEqual(c.por_concepto.Revenues.formas, { '10-Q': 2 });
  assert.equal(c.trimestres_utilidad_con_cita, 1);
  assert.equal(c.verde, false);   // 2 y 1 < 8
});

test('Q7: se toma el MEJOR de los dos tags de ingresos, no su suma', () => {
  // Sumar Revenues y RevenueFromContract... contaría el mismo trimestre dos
  // veces cuando una empresa reporta bajo los dos tags.
  const mk = (n, start) => Array.from({ length: n }, (_, i) => ({
    start: `202${start}-01-01`, end: `202${start}-03-31`, val: i, accn: `a${i}`, form: '10-Q',
  }));
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: mk(5, 4) } },
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: mk(9, 5) } },
    NetIncomeLoss: { units: { USD: mk(9, 5) } },
  } } };
  const c = coberturaCompanyFacts(facts);
  assert.equal(c.trimestres_ingresos_con_cita, 9);   // el mejor, no 14
  assert.ok(c.verde);
});

test('Q7: un companyfacts vacío no truena y sale rojo', () => {
  const c = coberturaCompanyFacts({});
  assert.equal(c.trimestres_ingresos_con_cita, 0);
  assert.equal(c.verde, false);
});

// ────────────────────────── Q9 · Form 4 ─────────────────────────────

test('Q9: un feed con todos los códigos, remanente y hora de aceptación pasa', () => {
  const txs = ['P', 'S', 'A', 'M', 'F'].map((c, i) => ({
    transactionCode: c, share: 1000 + i,
    acceptanceDateTime: '2026-09-19T20:14:00Z', officerTitle: 'CFO',
  }));
  const r = censoForm4(txs);
  assert.deepEqual(r.codigos, ['A', 'F', 'M', 'P', 'S']);
  assert.equal(r.solo_compras, false);
  assert.equal(r.con_le_quedan, 5);
  assert.equal(r.con_hora_aceptacion, 5);
  assert.ok(r.verde);
});

test('Q9: un feed SOLO de compras es exactamente el hallazgo que R5 necesita', () => {
  const txs = [
    { transactionCode: 'P', share: 100, acceptanceDateTime: 'x' },
    { transactionCode: 'P', share: 200, acceptanceDateTime: 'x' },
  ];
  const r = censoForm4(txs);
  assert.equal(r.solo_compras, true);
  assert.equal(r.verde, false);
});

test('Q9: "le quedan" en cero es un DATO (vendió todo), no un hueco', () => {
  // La vista "Top de la semana" del encargo usa `le quedan = 0` para decir
  // "vendió todo". Si el censo tratara el 0 como ausente, ese caso —el más
  // informativo de todos— se contaría como cobertura faltante.
  const r = censoForm4([{ transactionCode: 'S', share: 0, acceptanceDateTime: 'x' }]);
  assert.equal(r.con_le_quedan, 1);
});

test('Q9: una fila sin remanente rompe el verde aunque los códigos estén', () => {
  const txs = ['P', 'S', 'A', 'M'].map((c, i) => ({
    transactionCode: c,
    ...(i === 0 ? {} : { share: 10 }),        // la primera, sin remanente
    acceptanceDateTime: 'x',
  }));
  const r = censoForm4(txs);
  assert.equal(r.codigos.length, 4);
  assert.equal(r.con_le_quedan, 3);
  assert.equal(r.verde, false);
});

// ────────────────────────── el tablero ──────────────────────────────

test('tablero: una compuerta SIN MEDIR no es verde ni roja — y bloquea el GO', () => {
  const t = tablero({
    g1: { verde: true }, g2: { verde: true }, g3: { verde: true }, g4: { verde: true },
    g5: { verde: true }, g6: { verde: true }, g7: { verde: true }, g8: { verde: true },
    g9: { verde: true },
    // g10 ausente a propósito
  });
  assert.deepEqual(t.sin_medir, ['g10']);
  assert.equal(t.veredicto, 'INCOMPLETO');
});

test('tablero: todas verdes → GO; una roja → NO-GO con su razón', () => {
  const todas = {};
  for (const g of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10']) todas[g] = { verde: true };
  assert.equal(tablero(todas).veredicto, 'GO');

  const conRojo = { ...todas, g2: { verde: false, motivo: 'FEMSA no cuadra' } };
  const t = tablero(conRojo);
  assert.equal(t.veredicto, 'NO-GO');
  assert.deepEqual(t.rojos, ['g2']);
  assert.deepEqual(t.filas.find((f) => f.gate === 'g2').razones, ['FEMSA no cuadra']);
});

test('los criterios están congelados y versionados', () => {
  // Si alguien mueve una portería, este test no lo impide — pero el diff de
  // estas líneas lo deja a la vista en la revisión, que es el punto.
  assert.equal(CRITERIOS.version, 1);
  assert.equal(CRITERIOS.g2_max_error_pct, 5);
  assert.equal(CRITERIOS.g6_min_trimestres_upa, 4);
  assert.equal(tablero({}).criterios_version, 1);
});
