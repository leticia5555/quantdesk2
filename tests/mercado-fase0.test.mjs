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
  censoUniversoUs, censoUniversoUsDesdeTabla, SQL_UNIVERSO_US,
  capMxCandidatas, errorPct, veredictoCapMx,
  presupuestoPrecios, censoRetornoTotal, anclaYtd,
  coberturaMetric, ventanaUpa, proximoReporte,
  coberturaCompanyFacts, censoForm4,
  contarItemsFeed, veredictoFeed, censoFeeds,
  veredictoFuente, tablaFuentes, tablero,
} from '../api/_lib/mercado-fase0.js';
import { parseFeedsParam, fuenteAdHoc } from '../api/mercado-censo.js';
import FUENTES from '../api/_lib/news-sources.json' with { type: 'json' };

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

// ── Q1 desde mercado_universo_us: EL MISMO medidor, la MISMA tabla ──
// El 2026-09-21 `?job=universo` reportó 538/553 completas y G1 verde, y el
// censo del mismo día dijo `con_sector: 0` y G1 rojo. No era un desacuerdo
// sobre los datos: el censo leía las tablas viejas del Arena.

const filaUs = (symbol, sector_etf, cap, horas = 6, cap_fuente = 'finnhub:metric') => ({
  symbol, nombre: symbol, sector_etf,
  market_cap: cap, cap_fuente,
  cap_actualizado: cap == null ? null : horasAntes(horas),
});

test('Q1 tabla: 11 sectores × 12 nombres desde mercado_universo_us pasa G1', () => {
  const etfs = ['XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'];
  const filas = [];
  etfs.forEach((etf, i) => { for (let j = 0; j < 12; j++) filas.push(filaUs(`W${i}_${j}`, etf, 5e9, 10)); });
  const r = censoUniversoUsDesdeTabla(filas, { ahora: AHORA });
  assert.equal(r.candidatos, 132);
  assert.equal(r.con_cap_y_sector, 132);
  assert.equal(r.sectores_con_piso.length, 11);
  assert.equal(r.horas_frescura_cap_mas_vieja, 10);
  assert.ok(r.verde, r.razones.join(' · '));
  // De dónde salió cada cap viaja en la salida: regla 3 del encargo.
  assert.deepEqual(r.cap_por_fuente, { 'finnhub:metric': 132 });
});

test('Q1 tabla: la frescura se mide con cap_actualizado, no con `actualizado`', () => {
  // La fila se tocó hace un minuto, pero la cap se midió hace 30 días. El
  // bug que esto cierra es el de creer que tocar la fila refresca el número.
  const etfs = ['XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC'];
  const filas = [];
  etfs.forEach((etf, i) => {
    for (let j = 0; j < 12; j++) {
      const f = filaUs(`V${i}_${j}`, etf, 4e9, i === 0 && j === 0 ? 720 : 6);
      f.actualizado = AHORA.toISOString();
      filas.push(f);
    }
  });
  const r = censoUniversoUsDesdeTabla(filas, { ahora: AHORA });
  assert.equal(r.verde, false);
  assert.match(r.razones.join(' '), /720h/);
});

test('Q1 tabla: una fila sin sector cuenta como cobertura faltante', () => {
  const r = censoUniversoUsDesdeTabla([
    filaUs('AAPL', 'XLK', 3e12, 2),
    filaUs('MSFT', null, 2e12, 2),
    filaUs('XYZ', 'XLF', null),
  ], { ahora: AHORA });
  assert.equal(r.candidatos, 3);
  assert.equal(r.con_cap, 2);
  assert.equal(r.con_sector, 2);
  assert.equal(r.con_cap_y_sector, 1);
  assert.equal(r.verde, false);
});

test('Q1 tabla: sin filas no hay verde por descuido', () => {
  const r = censoUniversoUsDesdeTabla([], { ahora: AHORA });
  assert.equal(r.candidatos, 0);
  assert.equal(r.con_cap_y_sector, 0);
  assert.equal(r.verde, false);
});

test('Q1: la consulta compartida apunta a mercado_universo_us y trae cap_actualizado', () => {
  // Si alguien la cambia, que sea en UN lugar. Los dos endpoints importan
  // esta misma constante.
  assert.match(SQL_UNIVERSO_US, /from mercado_universo_us/);
  assert.match(SQL_UNIVERSO_US, /cap_actualizado/);
  assert.match(SQL_UNIVERSO_US, /sector_etf/);
  assert.doesNotMatch(SQL_UNIVERSO_US, /arena_/);
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

// ─────────────── punto 0.10 (adenda) · feeds de noticias ────────────

const itemRss = (t, l, f) => `<item><title>${t}</title><link>${l}</link><pubDate>${f}</pubDate></item>`;
const feedRss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;
const FECHA_RSS = 'Sat, 19 Sep 2026 14:30:00 GMT';

test('0.10: un feed RSS sano se cuenta entero', () => {
  const xml = feedRss(Array.from({ length: 7 }, (_, i) => itemRss(`T${i}`, `https://x/${i}`, FECHA_RSS)));
  const m = contarItemsFeed(xml);
  assert.equal(m.dialecto, 'rss');
  assert.equal(m.items, 7);
  assert.equal(m.usables, 7);
  assert.equal(m.pct_con_fecha, 100);
});

test('0.10: un feed ATOM también se cuenta — contar solo <item> sería un rojo inventado', () => {
  // Éste es el caso que importa: media web de noticias publica Atom, y
  // `parseRss` de vc-feed solo entiende <item>. Reportar "0 items" sobre un
  // feed sano cerraría una puerta que estaba abierta.
  const entries = Array.from({ length: 6 }, (_, i) =>
    `<entry><title>T${i}</title><link href="https://x/${i}"/><updated>2026-09-19T14:30:00Z</updated></entry>`);
  const m = contarItemsFeed(`<feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`);
  assert.equal(m.dialecto, 'atom');
  assert.equal(m.items, 6);
  assert.equal(m.usables, 6);
});

test('0.10: un feed SIN fecha parseable no sirve para "lo de hoy"', () => {
  // 200, items de sobra, títulos y links… y ninguna hora. "Lo de hoy"
  // muestra la hora del titular: con este feed habría que inventarla.
  const items = Array.from({ length: 10 }, (_, i) => `<item><title>T${i}</title><link>https://x/${i}</link></item>`);
  const v = veredictoFeed('sinfecha', 'https://x/rss', { ok: true, status: 200, ms: 40, texto: feedRss(items) });
  assert.equal(v.items, 10);
  assert.equal(v.pct_con_fecha, 0);
  assert.equal(v.vivo, false);
  assert.match(v.motivo, /no puede mostrar la hora/);
});

test('0.10: un 403 de Cloudflare se nombra por su nombre, no como "no disponible"', () => {
  // La lección de FinSMEs en vc-feed: responde desde una laptop y no desde
  // Vercel. Un 403 así se arregla distinto que una URL mal escrita, y por eso
  // el censo los distingue.
  const v = veredictoFeed('finsmes', 'https://www.finsmes.com/feed/', {
    ok: false, status: 403, ms: 120, texto: '<html><title>Attention Required! | Cloudflare</title></html>',
  });
  assert.equal(v.vivo, false);
  assert.equal(v.motivo, 'bloqueado_cloudflare');
  assert.match(v.pista, /IP de datacenter/);

  const otro = veredictoFeed('typo', 'https://x/rs', { ok: false, status: 404, ms: 10, texto: 'Not Found' });
  assert.equal(otro.motivo, 'HTTP 404');
  assert.equal(otro.pista, undefined);
});

test('0.10: una respuesta que no es un feed se dice, no se cuenta como cero items', () => {
  const v = veredictoFeed('portada', 'https://x/', { ok: true, status: 200, ms: 30, texto: '<html><body>hola</body></html>' });
  assert.equal(v.dialecto, null);
  assert.equal(v.vivo, false);
  assert.match(v.motivo, /no parece un feed/);
});

test('0.10: tres feeds vivos pasan G11', () => {
  const vivo = (n) => ({ nombre: n, vivo: true, usables: 8, pais: 'us' });
  const c = censoFeeds([vivo('a'), vivo('b'), vivo('c')]);
  assert.equal(c.vivos, 3);
  assert.equal(c.items_usables_totales, 24);
  assert.ok(c.verde);
});

test('0.10: feeds MX declarados y TODOS muertos → rojo, aunque sobren los gringos', () => {
  // "Lo de hoy" mezcla EE.UU. y México. Cinco feeds gringos vivos no llenan
  // la mitad mexicana, y un total sano lo escondería.
  const c = censoFeeds([
    { nombre: 'us1', vivo: true, usables: 10, pais: 'us' },
    { nombre: 'us2', vivo: true, usables: 10, pais: 'us' },
    { nombre: 'us3', vivo: true, usables: 10, pais: 'us' },
    { nombre: 'mx1', vivo: false, pais: 'mx', motivo: 'HTTP 403' },
  ]);
  assert.equal(c.vivos, 3);
  assert.deepEqual(c.mx, { declarados: 1, vivos: 0 });
  assert.equal(c.verde, false);
  assert.match(c.razones.join(' '), /mitad mexicana/);
});

test('0.10: sin feeds MX declarados no se inventa un rojo de México', () => {
  // El país se DECLARA, no se adivina por el dominio. Si la lista no trae
  // ninguno marcado `mx`, el censo no puede concluir nada sobre México — y
  // no concluir es distinto de concluir que está bien.
  const c = censoFeeds([
    { nombre: 'a', vivo: true, usables: 9, pais: 'us' },
    { nombre: 'b', vivo: true, usables: 9, pais: 'us' },
    { nombre: 'c', vivo: true, usables: 9, pais: 'us' },
  ]);
  assert.deepEqual(c.mx, { declarados: 0, vivos: 0 });
  assert.ok(c.verde);
});

test('0.10: ?feeds= acepta la lista de la adenda sin redeploy, y marca los MX', () => {
  const { feeds, invalidas } = parseFeedsParam(
    'eleconomista=https://eleconomista.com.mx/rss|mx, reuters=https://reuters.com/feed');
  assert.equal(feeds.length, 2);
  assert.deepEqual(feeds[0], { nombre: 'eleconomista', url: 'https://eleconomista.com.mx/rss', pais: 'mx' });
  assert.equal(feeds[1].pais, 'us');
  assert.deepEqual(invalidas, []);
});

test('0.10: una entrada mal formada se REPORTA, no se descarta en silencio', () => {
  // Un feed que falta por un typo se lee igual que un feed que no existe.
  const { feeds, invalidas } = parseFeedsParam('bueno=https://x/rss, sinigual, malo=ftp://y/rss');
  assert.equal(feeds.length, 1);
  assert.equal(invalidas.length, 2);
  assert.match(invalidas[0].motivo, /falta el "="/);
  assert.match(invalidas[1].motivo, /no empieza con http/);
});

test('0.10: sin parámetro, la lista es null y el endpoint cae al default declarado', () => {
  assert.equal(parseFeedsParam(undefined).feeds, null);
  assert.equal(parseFeedsParam('  ').feeds, null);
});

// ───────── punto 0.10 · imagen, categoría y tabla por fuente ────────

test('0.10: media:content cuenta como imagen; un enclosure de AUDIO no', () => {
  // R3b pone foto SOLO si el feed la trae. Un enclosure sin type lo usan los
  // podcasts para audio: contarlo pintaría un <img> roto, que es peor que el
  // bloque de color que ya está previsto como caída.
  const xml = feedRss([
    `<item><title>A</title><link>https://x/a</link><pubDate>${FECHA_RSS}</pubDate>`
      + '<media:content url="https://i/1.jpg" type="image/jpeg"/></item>',
    `<item><title>B</title><link>https://x/b</link><pubDate>${FECHA_RSS}</pubDate>`
      + '<enclosure url="https://a/x.mp3" type="audio/mpeg"/></item>',
    `<item><title>C</title><link>https://x/c</link><pubDate>${FECHA_RSS}</pubDate>`
      + '<enclosure url="https://i/2.jpg" type="image/jpeg"/></item>',
    `<item><title>D</title><link>https://x/d</link><pubDate>${FECHA_RSS}</pubDate>`
      + '<media:thumbnail url="https://i/3.jpg"/></item>',
  ]);
  const m = contarItemsFeed(xml);
  assert.equal(m.items, 4);
  assert.equal(m.con_imagen, 3);
  assert.deepEqual(m.vias_imagen, { 'media:content': 1, 'enclosure': 1, 'media:thumbnail': 1 });
  assert.equal(m.pct_con_imagen, 75);
});

test('0.10: un enclosure SIN type no se cuenta como imagen', () => {
  const xml = feedRss([`<item><title>A</title><link>https://x/a</link><pubDate>${FECHA_RSS}</pubDate>`
    + '<enclosure url="https://algo/sin-extension"/></item>']);
  assert.equal(contarItemsFeed(xml).con_imagen, 0);
});

test('0.10: la imagen NO entra en "usables" — R3b ya tiene su caída', () => {
  // Un feed sin fotos es usable, solo que más feo (bloque de color con la
  // fuente). Un feed sin FECHA no lo es. La distinción tiene que estar en el
  // número, no solo en el comentario.
  const xml = feedRss(Array.from({ length: 6 }, (_, i) =>
    itemRss(`T${i}`, `https://x/${i}`, FECHA_RSS)));
  const m = contarItemsFeed(xml);
  assert.equal(m.con_imagen, 0);
  assert.equal(m.usables, 6);
});

test('0.10: categorías en RSS (<category>) y en Atom (term=)', () => {
  const rss = contarItemsFeed(feedRss([
    `<item><title>A</title><link>https://x/a</link><pubDate>${FECHA_RSS}</pubDate>`
      + '<category>Markets</category><category>Earnings</category></item>',
    `<item><title>B</title><link>https://x/b</link><pubDate>${FECHA_RSS}</pubDate></item>`,
  ]));
  assert.equal(rss.con_categoria, 1);
  assert.equal(rss.pct_con_categoria, 50);
  assert.deepEqual(rss.categorias_ejemplo, ['Markets', 'Earnings']);

  const atom = contarItemsFeed('<feed><entry><title>A</title><link href="https://x/a"/>'
    + '<updated>2026-09-19T10:00:00Z</updated><category term="Tech"/></entry></feed>');
  assert.equal(atom.con_categoria, 1);
  assert.deepEqual(atom.categorias_ejemplo, ['Tech']);
});

test('0.10: una fuente con 2 candidatas — la 1 muere, la 2 gana, y se reportan las dos', () => {
  const fuente = { id: 'x', nombre: 'X', idioma: 'es', tipo: 'medio', seccion: 'mexico_latam',
    feeds: ['https://x/viejo.xml', 'https://x/nuevo.xml'] };
  const bueno = feedRss(Array.from({ length: 6 }, (_, i) => itemRss(`T${i}`, `https://x/${i}`, FECHA_RSS)));
  const v = veredictoFuente(fuente, [
    { url: 'https://x/viejo.xml', resp: { ok: false, status: 404, ms: 20, texto: 'Not Found' } },
    { url: 'https://x/nuevo.xml', resp: { ok: true, status: 200, ms: 90, texto: bueno } },
  ]);
  assert.equal(v.veredicto, 'GO');
  assert.equal(v.feed, 'https://x/nuevo.xml');
  assert.equal(v.candidatas.length, 2);
  assert.equal(v.candidatas[0].vivo, false);
  assert.equal(v.candidatas[1].vivo, true);
});

test('0.10: si ninguna candidata sirve, el NO-GO dice CUÁNTAS se probaron', () => {
  // "Ninguna de las 3 rutas sirve" es un hecho. "Probé una URL adivinada" no
  // lo sería, y el motivo tiene que dejar ver la diferencia.
  const fuente = { id: 'y', nombre: 'Y', idioma: 'en', tipo: 'medio', seccion: 'mercado',
    feeds: ['https://y/1', 'https://y/2', 'https://y/3'] };
  const muerta = (u) => ({ url: u, resp: { ok: false, status: 404, ms: 5, texto: '' } });
  const v = veredictoFuente(fuente, [muerta('https://y/1'), muerta('https://y/2'), muerta('https://y/3')]);
  assert.equal(v.veredicto, 'NO-GO');
  assert.match(v.motivo, /ninguna de las 3 candidatas/);
  assert.equal(v.bloqueado_cloudflare, false);
});

test('0.10: Cloudflare se propaga al veredicto de la fuente', () => {
  const v = veredictoFuente(
    { id: 'sa', nombre: 'Seeking Alpha', idioma: 'en', tipo: 'medio', seccion: 'acciones', feeds: ['https://sa/x'] },
    [{ url: 'https://sa/x', resp: { ok: false, status: 403, ms: 30, texto: '<title>Just a moment...</title>' } }]);
  assert.equal(v.veredicto, 'NO-GO');
  assert.equal(v.bloqueado_cloudflare, true);
});

test('0.10: ASUMIDO_NO no es un NO-GO medido — y no se sondea', () => {
  // Bloomberg y NYT los declara NO el encargo. Contarlos como NO-GO haría
  // parecer que se probó algo que nunca se probó.
  const v = veredictoFuente(
    { id: 'bbg', nombre: 'Bloomberg', idioma: 'en', tipo: 'medio', seccion: 'mercado',
      feeds: [], asumido_no: 'el encargo lo declara NO de antemano' }, []);
  assert.equal(v.veredicto, 'ASUMIDO_NO');
  assert.equal(v.candidatas.length, 0);

  const t = tablaFuentes([v]);
  assert.equal(t.asumidas_no, 1);
  assert.equal(t.medidas, 0);
  assert.equal(t.no_go, 0);
});

test('0.10: la tabla avisa qué secciones de R3b quedarían VACÍAS', () => {
  // Una sección sin fuentes no es un detalle estético: es una pestaña que se
  // abre en blanco.
  const go = (id, seccion, idioma, pctImg) => ({
    id, nombre: id, tipo: 'medio', seccion, idioma, veredicto: 'GO', pct_con_imagen: pctImg,
  });
  const t = tablaFuentes([
    go('a', 'mercado', 'en', 90), go('b', 'mercado', 'en', 10), go('c', 'mexico_latam', 'es', 80),
  ]);
  assert.equal(t.go, 3);
  assert.deepEqual(t.secciones_vacias, ['acciones', 'oficiales']);
  assert.equal(t.fuentes_con_foto, 2);
  assert.equal(t.verde, false);
  assert.match(t.razones.join(' '), /secciones de R3b sin ninguna fuente/);
});

test('0.10: sin NINGUNA fuente en español, G11 es rojo aunque sobren las gringas', () => {
  const go = (id, seccion) => ({ id, nombre: id, tipo: 'medio', seccion, idioma: 'en', veredicto: 'GO', pct_con_imagen: 90 });
  const t = tablaFuentes([go('a', 'mercado'), go('b', 'acciones'), go('c', 'oficiales'), go('d', 'mexico_latam')]);
  assert.equal(t.go, 4);
  assert.deepEqual(t.secciones_vacias, []);
  assert.equal(t.verde, false);
  assert.match(t.razones.join(' '), /ninguna fuente en español/);
});

test('0.10: una tabla completa y en español sale verde', () => {
  const go = (id, seccion, idioma) => ({ id, nombre: id, tipo: 'medio', seccion, idioma, veredicto: 'GO', pct_con_imagen: 70 });
  const t = tablaFuentes([
    go('a', 'mercado', 'en'), go('b', 'acciones', 'en'),
    go('c', 'mexico_latam', 'es'), go('d', 'oficiales', 'es'),
  ]);
  assert.ok(t.verde, t.razones.join(' · '));
  assert.deepEqual(t.por_idioma, { en: 2, es: 2 });
});

// ───────────── el registro de fuentes (news-sources.json) ───────────

test('registro: están las 30 fuentes de la adenda, con Bloomberg y NYT asumidas NO', () => {
  const f = FUENTES.fuentes;
  assert.equal(f.length, 30);
  const asumidas = f.filter((x) => x.asumido_no).map((x) => x.nombre).sort();
  assert.deepEqual(asumidas, ['Bloomberg', 'New York Times']);
  // Y las asumidas NO no llevan candidatas: sondearlas sería gastar requests
  // en confirmar una decisión ya tomada.
  for (const x of f.filter((y) => y.asumido_no)) assert.deepEqual(x.feeds, []);
});

test('registro: toda fuente sondeable tiene id único, idioma, tipo, sección y candidatas', () => {
  const ids = new Set();
  const TIPOS = new Set(['medio', 'newsletter', 'oficial']);
  const SECCIONES = new Set(['mercado', 'mexico_latam', 'acciones', 'etfs', 'cripto', 'oficiales']);
  for (const f of FUENTES.fuentes) {
    assert.ok(f.id && !ids.has(f.id), `id duplicado o ausente: ${f.id}`);
    ids.add(f.id);
    assert.ok(f.nombre, `sin nombre: ${f.id}`);
    assert.ok(TIPOS.has(f.tipo), `tipo inválido en ${f.id}: ${f.tipo}`);
    assert.ok(SECCIONES.has(f.seccion), `sección inválida en ${f.id}: ${f.seccion}`);
    assert.ok(f.idioma, `sin idioma: ${f.id}`);
    assert.ok(Object.prototype.hasOwnProperty.call(f, 'smoke'), `sin campo smoke: ${f.id}`);
    if (!f.asumido_no) {
      assert.ok(Array.isArray(f.feeds) && f.feeds.length, `sin candidatas: ${f.id}`);
      for (const u of f.feeds) assert.match(u, /^https:\/\//, `candidata no https en ${f.id}: ${u}`);
    }
  }
});

test('registro: el smoke ya está CONGELADO con la corrida, y cada fuente dice su veredicto', () => {
  // Nació en null ("no medido" no es "no sirve"). La corrida del 2026-09-20 lo
  // llenó vía scripts/mercado-congelar-fuentes.mjs, así que ahora la
  // invariante es la contraria: ninguna fuente puede quedar muda.
  const VEREDICTOS = new Set(['GO', 'NO-GO', 'ASUMIDO_NO']);
  for (const f of FUENTES.fuentes) {
    assert.ok(f.smoke && VEREDICTOS.has(f.smoke.veredicto), `${f.id}: sin veredicto de smoke`);
    if (f.smoke.veredicto === 'GO') {
      assert.match(f.feed || '', /^https:\/\//, `${f.id}: GO sin url ganadora`);
      // La ganadora queda PRIMERA y las candidatas no se borran: si mañana
      // muere, la siguiente ya está escrita.
      assert.equal(f.feeds[0], f.feed, `${f.id}: la ganadora no quedó primera`);
      assert.ok(f.verificado_en, `${f.id}: GO sin fecha de verificación`);
    } else {
      assert.equal(f.feed, null, `${f.id}: no es GO y sin embargo tiene feed`);
    }
  }
});

test('registro: 22 GO y 6 NO-GO, con las 2 asumidas fuera del denominador', () => {
  const v = (x) => FUENTES.fuentes.filter((f) => f.smoke.veredicto === x).length;
  assert.equal(v('GO'), 22);
  assert.equal(v('NO-GO'), 6);
  assert.equal(v('ASUMIDO_NO'), 2);
});

test('registro: Banxico y BMV quedan como fuente NO-RSS con su plan B, no como agujero', () => {
  // Un NO-GO de RSS no vacía la sección de oficiales cuando el repo ya sabe
  // cosechar la fuente de otra manera.
  for (const id of ['banxico', 'bmv_emisnet']) {
    const f = FUENTES.fuentes.find((x) => x.id === id);
    assert.equal(f.smoke.veredicto, 'NO-GO');
    assert.equal(f.plan_b, 'no_rss');
    assert.ok(f.plan_b_detalle && f.plan_b_detalle.length > 40, `${id}: plan B sin detalle`);
  }
});

test('registro: al menos una fuente en español quedó viva — la mitad mexicana existe', () => {
  // Era la condición de G11 que podía caer con el conteo global en verde.
  const esVivas = FUENTES.fuentes.filter((f) => f.idioma === 'es' && f.smoke.veredicto === 'GO');
  assert.ok(esVivas.length >= 4, `solo ${esVivas.length} fuentes ES vivas`);
  assert.ok(esVivas.some((f) => f.seccion === 'mexico_latam'));
});

test('registro: hay fuentes en español, y Valor va como pt (el filtro tiene que distinguirlas)', () => {
  const es = FUENTES.fuentes.filter((f) => f.idioma === 'es');
  assert.ok(es.length >= 6, `solo ${es.length} fuentes en español`);
  const valor = FUENTES.fuentes.find((f) => f.id === 'valor_br');
  assert.equal(valor.idioma, 'pt');
});

test('registro: las cuatro secciones del layout de R3b tienen fuentes candidatas', () => {
  const sondeables = FUENTES.fuentes.filter((f) => !f.asumido_no);
  for (const sec of ['mercado', 'mexico_latam', 'acciones', 'oficiales']) {
    assert.ok(sondeables.some((f) => f.seccion === sec), `ninguna candidata para la sección ${sec}`);
  }
});

test('registro: una entrada de ?feeds= se convierte en fuente con idioma y sección coherentes', () => {
  const mx = fuenteAdHoc({ nombre: 'eco', url: 'https://x.mx/rss', pais: 'mx' });
  assert.equal(mx.idioma, 'es');
  assert.equal(mx.seccion, 'mexico_latam');
  assert.deepEqual(mx.feeds, ['https://x.mx/rss']);

  const us = fuenteAdHoc({ nombre: 'reu', url: 'https://r.com/feed', pais: 'us' });
  assert.equal(us.idioma, 'en');
  assert.equal(us.seccion, 'mercado');
});

// ────────────────────────── el tablero ──────────────────────────────

test('tablero: una compuerta SIN MEDIR no es verde ni roja — y bloquea el GO', () => {
  const t = tablero({
    g1: { verde: true }, g2: { verde: true }, g3: { verde: true }, g4: { verde: true },
    g5: { verde: true }, g6: { verde: true }, g7: { verde: true }, g8: { verde: true },
    g9: { verde: true }, g11: { verde: true },
    // g10 ausente a propósito
  });
  assert.deepEqual(t.sin_medir, ['g10']);
  assert.equal(t.veredicto, 'INCOMPLETO');
});

test('tablero: todas verdes → GO; una roja → NO-GO con su razón', () => {
  const todas = {};
  for (const g of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11']) todas[g] = { verde: true };
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
  //
  // v2 (2026-09-21): cambió CÓMO se cuenta G2 (dos vías hacia "verificada"),
  // NO sus umbrales. El 5% por emisora sigue donde estaba, y este test lo
  // fija para que moverlo requiera tocar esta línea a propósito.
  assert.equal(CRITERIOS.version, 2);
  assert.equal(CRITERIOS.g2_max_error_pct, 5);
  assert.equal(CRITERIOS.g6_min_trimestres_upa, 4);
  assert.equal(tablero({}).criterios_version, 2);
});

test('Q1 tabla: una cap sin fecha de medición se cuenta, no se promedia', () => {
  const filas = [
    { symbol: 'AAPL', sector_etf: 'XLK', market_cap: 3e12, cap_fuente: 'finnhub:metric', cap_actualizado: horasAntes(3) },
    { symbol: 'MSFT', sector_etf: 'XLK', market_cap: 2e12, cap_fuente: 'previa', cap_actualizado: null },
  ];
  const r = censoUniversoUsDesdeTabla(filas, { ahora: AHORA });
  assert.equal(r.caps_sin_fecha_de_medicion, 1);
  assert.deepEqual(r.caps_sin_fecha_ejemplos, ['MSFT']);
  // La frescura se mide con las que SÍ tienen fecha, no se inventa para la otra.
  assert.equal(r.horas_frescura_cap_mas_vieja, 3);
});
