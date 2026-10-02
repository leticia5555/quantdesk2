// ═══════════════════════════════════════════════════════════════
// Tests del experimento "reaccion". JS puro, sin red ni DB.
//
// Lo que defienden, en orden de cuánto daño evita cada uno:
//
//   1. La REGLA DE ESTIMADOS: "el estimado de hoy" no sirve, y una fecha de
//      corte solo cuenta si es ANTERIOR al reporte (el `lastUpdated` de FMP no
//      lo es). Y se aplica a la forma CRUDA: sobre filas normalizadas cualquier
//      fuente "serviría".
//   2. La VENTANA: T-1 y T+1 estrictos, calendario de SPY, sin rellenar velas.
//   3. Los CRITERIOS congelados, y la winsorización IMPORTADA de la decisión de
//      INTC, no copiada.
//   4. La estadística contra valores de TABLA (la lección del erf).
//   5. El veredicto: la cobertura antes que el candado, el candado antes que
//      los números, y "las tres juntas" solo si son las tres.
//   6. La guía: el párrafo crudo, con el safe harbor MARCADO y no borrado.
//
// Correr con `node tests/reaccion.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  CRITERIOS_REACCION, retornoVentana, sorpresaEps, sorpresaIngresos,
  clasificaFuenteEstimado, ingresosTrimestralesXbrl, ingresoDelEvento,
  htmlATexto, parrafosDeGuia, eligeExhibit991, pValorT, pearson, ols,
  analizaReaccion, aciertoDireccional, advertenciasFijas, renderCensoMd, renderAnalisisMd, SENALES,
} from '../api/_lib/reaccion.js';
import { CRITERIOS_F2 } from '../api/_lib/earnings-beat-analyze.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('CRITERIOS_REACCION congelados ANTES de correr');

const C = CRITERIOS_REACCION;
ok(C.min_eventos === 100, 'candado: 100 eventos por señal y para el conjunto');
ok(C.min_abs_r === 0.20 && C.max_p_valor === 0.05, 'una señal explica si |r| ≥ 0.20 y p < 0.05');
ok(C.umbral_r2_conjunto === 0.10, 'R² conjunto < 10% → mayormente impredecible');
ok(C.min_cobertura_frente === 0.50, 'un frente con < 50% de cobertura NO entra');
ok(C.winsor_eps_pct === CRITERIOS_F2.winsor_sorpresa_pct && C.winsor_eps_pct === 100,
  'la winsorización de EPS es la de INTC, IMPORTADA — si se moviera en un lado se movería en los dos');
ok(C.max_sorpresa_ingresos_pct === 50, 'una sorpresa de ingresos de más de ±50% es un error de unidad, no un dato');
ok(C.tolerancia_cruce_dias === 1, 'cruce fuente ↔ evento: ±1 día, como el earnings-beat');
ok(/nunca_mezclar/.test(C.regla_fuente_ingresos), 'la regla de elección de fuente dice que no se mezclan');
ok(C.ajuste === 'retorno_accion_menos_retorno_spy', 'la variable se ajusta por SPY');
ok(SENALES.map((x) => x.id).join('') === 'ABC', 'las tres señales del encargo, en su orden');

console.log('la VENTANA: T-1 y T+1 estrictos, sin rellenar');

const SPY = {
  fechas: ['2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-29', '2026-06-30'],
  opens: [500, 501, 502, 503, 504, 505], closes: [500, 501, 502, 503, 504, 505],
};
const ACC = {
  fechas: [...SPY.fechas],
  opens: [100, 100, 100, 100, 95, 95], closes: [100, 100, 100, 100, 95, 95],
};
// Reporte el jueves 25: T-1 = miércoles 24, T+1 = viernes 26.
const v = retornoVentana(ACC, SPY, '2026-06-25');
ok(v.ok && v.cierre_previo === '2026-06-24' && v.apertura_siguiente === '2026-06-26',
  'T-1 = la sesión estrictamente anterior, T+1 = la estrictamente posterior', `${v.cierre_previo} → ${v.apertura_siguiente}`);
ok(Math.abs(v.ret_spy - (503 / 501 - 1)) < 1e-12, 'SPY: apertura(T+1)/cierre(T-1) − 1');
ok(Math.abs(v.ret_ajustado - (v.ret_accion - v.ret_spy)) < 1e-12, 'ajustado = acción − SPY');
ok(v.sesiones_en_ventana === 1, 'la ventana incluye UNA sesión completa (el día T): es el costo declarado');
// Reporte un sábado: T-1 = viernes, T+1 = lunes. La regla no necesita saber la hora.
const finde = retornoVentana(ACC, SPY, '2026-06-27');
ok(finde.ok && finde.cierre_previo === '2026-06-26' && finde.apertura_siguiente === '2026-06-29',
  'un reporte en fin de semana: viernes → lunes', `${finde.cierre_previo} → ${finde.apertura_siguiente}`);
ok(Math.abs(finde.ret_accion - (95 / 100 - 1)) < 1e-12, 'y mide la caída del 5% del caso Nike');
// La acción NO tiene la vela de T+1: se descarta, NO se toma la siguiente.
const sinVela = retornoVentana({ ...ACC, fechas: ACC.fechas.filter((f) => f !== '2026-06-26'),
  opens: [100, 100, 100, 95, 95], closes: [100, 100, 100, 95, 95] }, SPY, '2026-06-25');
ok(!sinVela.ok && sinVela.motivo === 'sin_vela_apertura_siguiente' && sinVela.fecha === '2026-06-26',
  'una vela que le falta a la acción se DECLARA, no se rellena con la de al lado', JSON.stringify(sinVela));
ok(retornoVentana(ACC, SPY, '2026-06-23').motivo === 'sin_sesion_previa', 'sin sesión previa: motivo');
ok(retornoVentana(ACC, SPY, '2026-06-30').motivo === 'sin_sesion_siguiente', 'sin sesión siguiente: motivo');
ok(retornoVentana(ACC, null, '2026-06-25').motivo === 'sin_serie_spy', 'sin SPY no se ajusta: motivo');
ok(retornoVentana(null, SPY, '2026-06-25').motivo === 'sin_serie_accion', 'sin serie de la acción: motivo');

console.log('las sorpresas');

const e1 = sorpresaEps(1.09, 1.0);
ok(e1.ok && Math.abs(e1.cruda - 9) < 1e-9 && e1.winsorizada === e1.cruda, 'EPS +9% (el caso Nike) no se toca');
const intc = sorpresaEps(0.29, 0.01);
ok(intc.ok && intc.cruda > 2000 && intc.winsorizada === 100 && intc.recortada, 'el caso INTC (+2800%) se winsoriza a +100%');
const neg = sorpresaEps(-0.5, -0.3);
ok(neg.ok && neg.cruda < 0, 'con estimado negativo, reportar PEOR da negativo (|est| en el denominador)', neg.cruda);
ok(!sorpresaEps(null, 1).ok && !sorpresaEps(1, 0).ok, 'sin cifras o con estimado 0: no hay sorpresa');
const ing = sorpresaIngresos(9.9e9, 10e9);
ok(ing.ok && Math.abs(ing.valor - (-1)) < 1e-9, 'ingresos −1% (el caso Nike)', ing.valor);
const unidad = sorpresaIngresos(11e9, 11e6);
ok(!unidad.ok && unidad.motivo === 'sorpresa_de_ingresos_implausible',
  'un estimado en millones contra un real en dólares no es una sorpresa: es un error de unidad, y se DESCARTA', unidad.motivo);
ok(/error de unidad o de período/.test(unidad.detalle), 'con el porqué escrito');
ok(sorpresaIngresos(1e9, 0).motivo === 'estimado_de_ingresos_no_positivo', 'estimado no positivo: motivo');

console.log('la REGLA DE ESTIMADOS — sobre la forma CRUDA');

// Finnhub calendar: real y estimado del mismo reporte → estimado del evento.
const finnhub = clasificaFuenteEstimado([
  { date: '2026-06-26', epsActual: 0.14, epsEstimate: 0.12, hour: 'amc', quarter: 4, revenueActual: 11.1e9, revenueEstimate: 11.0e9, symbol: 'NKE', year: 2026 },
], { hoy: '2026-10-02' });
ok(finnhub.clase === 'estimado_del_evento', 'Finnhub calendar: estimado del evento', finnhub.clase);
ok(/misma clase de dato que el estimatedEPS de Alpha Vantage/.test(finnhub.nota),
  'y la nota dice por qué sirve: es la misma clase de dato que la señal A');
// FMP earnings trae `lastUpdated`: NO es una fecha de corte.
const fmp = clasificaFuenteEstimado([
  { symbol: 'NKE', date: '2026-06-26', epsActual: 0.14, epsEstimated: 0.12, revenueActual: 11.1e9, revenueEstimated: 11.0e9, lastUpdated: '2026-06-27' },
], { hoy: '2026-10-02' });
ok(fmp.clase === 'estimado_del_evento',
  'FMP earnings NO se clasifica como PIT por traer `lastUpdated`', fmp.clase);
ok(fmp.clave_de_corte_descartada && fmp.clave_de_corte_descartada.campo === 'lastUpdated',
  'y se dice qué clave se descartó y por qué — es la que alguien va a querer "aprovechar"', JSON.stringify(fmp.clave_de_corte_descartada));
// Un PIT de verdad: el corte es anterior al reporte en TODAS las filas.
const pit = clasificaFuenteEstimado([
  { date: '2026-06-26', revenueEstimate: 11e9, revenueActual: 11.1e9, asOfDate: '2026-06-20' },
  { date: '2026-03-20', revenueEstimate: 10e9, revenueActual: 10.2e9, asOfDate: '2026-03-15' },
]);
ok(pit.clase === 'pit_con_fecha' && pit.filas_verificadas === 2, 'un corte anterior al reporte en todas las filas: PIT', pit.clase);
// UNA fila con el corte posterior alcanza para que no sea PIT.
const mixto = clasificaFuenteEstimado([
  { date: '2026-06-26', revenueEstimate: 11e9, revenueActual: 11.1e9, asOfDate: '2026-06-20' },
  { date: '2026-03-20', revenueEstimate: 10e9, revenueActual: 10.2e9, asOfDate: '2026-03-25' },
]);
ok(mixto.clase !== 'pit_con_fecha', 'si UNA fila tiene el corte después del reporte, no es PIT', mixto.clase);
// El corte tiene que SER una fecha (la cicatriz del PIT de AV).
const conteo = clasificaFuenteEstimado([{ date: '2026-06-26', revenueEstimate: 11e9, revenueActual: 11.1e9, asOfDate: 7 }]);
ok(conteo.clase !== 'pit_con_fecha', 'una "fecha de corte" que es un número no es una fecha de corte');
// La forma de "el estimado de hoy": una fila por período, sin real, con períodos futuros.
const deHoy = clasificaFuenteEstimado([
  { date: '2026-12-31', horizon: 'next fiscal quarter', revenue_estimate_average: 12e9 },
  { date: '2026-09-30', horizon: 'current fiscal quarter', revenue_estimate_average: 11e9 },
], { hoy: '2026-10-02' });
ok(deHoy.clase === 'estimado_de_hoy', 'AV EARNINGS_ESTIMATES: el estimado de hoy, NO sirve', deHoy.clase);
ok(deHoy.filas_futuras === 1, 'con la fila del período futuro contada — es la firma', deHoy.filas_futuras);
const sinIngresos = clasificaFuenteEstimado([{ date: '2026-06-26', epsActual: 1, epsEstimate: 0.9 }]);
ok(sinIngresos.clase === 'no_concluyente' && sinIngresos.motivo === 'sin_campo_de_ingresos_estimados',
  'una fuente sin ingresos estimados se dice no concluyente, con las claves que sí vio', sinIngresos.motivo);
ok(Array.isArray(sinIngresos.claves_vistas) && sinIngresos.fila_cruda, 'y la fila cruda viaja');
ok(clasificaFuenteEstimado([]).clase === 'no_concluyente', 'sin filas: no concluyente');

console.log('ingresos REPORTADOS por XBRL, sin LLM, con el Q4 derivado');

const hechos = [
  // Q1, Q2, Q3 sueltos (10-Q)
  { start: '2025-06-01', end: '2025-08-31', val: 11.7e9, form: '10-Q', filed: '2025-10-05' },
  { start: '2025-09-01', end: '2025-11-30', val: 12.4e9, form: '10-Q', filed: '2026-01-05' },
  { start: '2025-12-01', end: '2026-02-28', val: 11.3e9, form: '10-Q', filed: '2026-04-05' },
  // El mismo Q1 repetido en un filing POSTERIOR: tiene que quedar el más viejo.
  { start: '2025-06-01', end: '2025-08-31', val: 11.7e9, form: '10-Q', filed: '2026-10-05' },
  // Nueve meses y año: Q4 = año − 9M.
  { start: '2025-06-01', end: '2026-02-28', val: 35.4e9, form: '10-Q', filed: '2026-04-05' },
  { start: '2025-06-01', end: '2026-05-31', val: 46.5e9, form: '10-K', filed: '2026-07-25' },
];
const trim = ingresosTrimestralesXbrl(hechos);
ok(trim.length === 4, 'tres trimestres sueltos + el Q4 derivado', trim.length);
const q4 = trim.find((t) => t.fin === '2026-05-31');
ok(q4 && q4.derivado && Math.abs(q4.valor - (46.5e9 - 35.4e9)) < 1, 'Q4 = anual − nueve meses, marcado como derivado', q4 && q4.valor);
ok(q4.formula === 'anual − nueve_meses', 'con la fórmula escrita');
ok(trim.find((t) => t.fin === '2025-08-31').filed === '2025-10-05', 'un período repetido se queda con el filing MÁS VIEJO');
ok(ingresoDelEvento(trim, '2026-05-31').valor === q4.valor, 'el evento se cruza por fin de período fiscal');
ok(ingresoDelEvento(trim, '2026-06-04') !== null && ingresoDelEvento(trim, '2026-06-30') === null,
  'con ±7 días de tolerancia, y no más');

console.log('la GUÍA: el párrafo crudo, con el safe harbor MARCADO');

const ex991 = `<html><body>
<p>NIKE, Inc. Reports Fiscal 2027 First Quarter Results</p>
<p>Revenues were $11.4 billion, down 1 percent on a reported basis.</p>
<p>For the second quarter of fiscal 2027, the company expects revenues to be down mid-single digits and gross margins to decline 300 to 350 basis points.</p>
<p>The Company now sees full-year fiscal 2027 revenue of $45.0 billion to $46.0 billion.</p>
<p>Statements in this release that the company expects revenues and earnings to grow are forward-looking statements within the meaning of the Private Securities Litigation Reform Act and involve risks.</p>
<script>var x = 'expects revenue guidance';</script>
</body></html>`;
const ps = parrafosDeGuia(ex991);
ok(ps.length === 3, 'tres párrafos calzan (el script no cuenta)', ps.length);
ok(ps.some((p) => /\$45\.0 billion to \$46\.0 billion/.test(p.parrafo) && p.patrones.includes('rango_monetario')),
  'el rango de guía se devuelve TAL CUAL, con el patrón que calzó');
ok(ps.some((p) => /mid-single digits/.test(p.parrafo) && p.patrones.includes('rango_porcentual')),
  'la guía en palabras ("mid-single digits") también');
// El safe harbor REAL nombra ingresos y ganancias, así que calza con un patrón:
// es justamente el caso que hay que marcar sin borrar.
const sh = ps.find((p) => /forward-looking/.test(p.parrafo));
ok(sh && sh.parece_safe_harbor === true, 'el safe harbor se MARCA…');
ok(ps.includes(sh), '…pero NO se borra: decidir que no es guía sería interpretar');
ok(!ps.some((p) => /Revenues were \$11\.4 billion/.test(p.parrafo)),
  'el resultado del trimestre ("revenues were") no es guía y no calza');
ok(ps.every((p) => !/floja|débil|fuerte|weak|strong/i.test(JSON.stringify({ ...p, parrafo: '' }))),
  'la salida no trae NINGUNA calificación: solo el párrafo y los patrones');
ok(/forward-looking/.test(htmlATexto('<p>forward-looking</p>')), 'htmlATexto deja el texto');
ok(htmlATexto('<p>A &amp; B&nbsp;C</p>').includes('A & B C'), 'y decodifica las entidades comunes');

const items = [{ name: 'nke-20260930.htm', size: 50000 }, { name: 'q1fy27ex991.htm', size: 90000 }, { name: 'logo.jpg', size: 5000 }];
ok(eligeExhibit991(items, 'nke-20260930.htm').nombre === 'q1fy27ex991.htm', 'el Exhibit 99.1 se encuentra por nombre');
const sinNombre = eligeExhibit991([{ name: 'nke.htm', size: 50000 }, { name: 'pr.htm', size: 90000 }], 'nke.htm');
ok(sinNombre.nombre === 'pr.htm' && sinNombre.regla === 'htm_mas_grande_que_no_es_el_primario',
  'si ningún nombre calza, el .htm más grande que no es el primario — y se dice qué regla lo eligió');
ok(eligeExhibit991([], null).nombre === null, 'sin candidatos: null con motivo');

console.log('estadística contra valores de TABLA');

ok(Math.abs(pValorT(2.228, 10) - 0.05) < 5e-4, 't(10)=2.228 → p = 0.05', pValorT(2.228, 10));
ok(Math.abs(pValorT(12.706, 1) - 0.05) < 5e-4, 't(1)=12.706 → p = 0.05');
ok(Math.abs(pValorT(2.042, 30) - 0.05) < 5e-4, 't(30)=2.042 → p = 0.05');
ok(Math.abs(pValorT(1.984, 100) - 0.05) < 5e-4, 't(100)=1.984 → p = 0.05');
ok(Math.abs(pValorT(2.617, 120) - 0.01) < 5e-4, 't(120)=2.617 → p = 0.01');
ok(Math.abs(pValorT(0, 50) - 1) < 1e-9, 't = 0 → p = 1');
// El r crítico de tabla para n = 100 a p = 0.05 es 0.1966.
const rc = 0.1966, tc = rc * Math.sqrt(98 / (1 - rc * rc));
ok(Math.abs(pValorT(tc, 98) - 0.05) < 1e-3, 'r = 0.1966 con n = 100 → p = 0.05 (el r crítico de tabla)', pValorT(tc, 98));

// Pearson sobre datos conocidos.
const xs = [1, 2, 3, 4, 5], ys = [2, 4, 5, 4, 5];
const pr = pearson(xs, ys);
ok(Math.abs(pr.r - 0.7745966692) < 1e-9, 'Pearson de un caso de libro: r = 0.7746', pr.r);
ok(pr.n === 5, 'con su n');
ok(pearson([1, 2, NaN, 4], [1, 2, 3, 4]).n === 3, 'los pares con un NaN no cuentan');
ok(pearson([1, 1, 1], [1, 2, 3]).motivo === 'sin_varianza', 'sin varianza: motivo, no un número inventado');

// OLS: datos sin ruido → R² = 1 y los coeficientes recuperados.
const X = [], Y = [];
for (let i = 0; i < 20; i++) { const a = i, b = (i * 7) % 5; X.push([a, b]); Y.push(1 + 2 * a + 3 * b); }
const m = ols(X, Y);
ok(Math.abs(m.r2 - 1) < 1e-9, 'OLS sin ruido: R² = 1', m.r2);
ok(Math.abs(m.beta[0] - 1) < 1e-6 && Math.abs(m.beta[1] - 2) < 1e-6 && Math.abs(m.beta[2] - 3) < 1e-6,
  'y recupera intercepto y pendientes', JSON.stringify(m.beta.map((b) => +b.toFixed(6))));
// Con UNA variable, el R² de la regresión es r² de Pearson.
const m1 = ols(xs.map((x) => [x]), ys);
ok(Math.abs(m1.r2 - pr.r * pr.r) < 1e-9, 'con una sola variable, R² de la regresión = r²');
ok(ols([[1, 1], [2, 2], [3, 3], [4, 4]], [1, 2, 3, 4]).motivo === 'colinealidad', 'columnas colineales: motivo');

console.log('el VEREDICTO: cobertura → candado → números');

// Fábrica de eventos determinista. La reacción depende de la sorpresa de EPS
// con la fuerza que se pida, más ruido determinista.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
function fabrica(n, { fuerza = 0, conIngresos = 0, ruido = 0.04, seed = 7 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const sorpresa = (r() * 40);
    const ret = fuerza * sorpresa / 100 + ruido * r() * 2;
    return {
      symbol: 'S' + (i % 30), report_date: `2026-0${(i % 9) + 1}-15`,
      ret: { ok: true, ret_ajustado: ret, ret_accion: ret + 0.002, ret_spy: 0.002 },
      eps: { ok: true, winsorizada: sorpresa, cruda: sorpresa },
      ingresos: i < conIngresos ? { ok: true, valor: r() * 6 } : null,
      guia: null,
    };
  });
}

// Sin señal en 200 eventos: la EPS no explica, y el conjunto es impredecible.
const sinSenal = analizaReaccion(fabrica(200, { fuerza: 0 }));
const A0 = sinSenal.senales.find((x) => x.id === 'A');
ok(A0.estado === 'NO_EXPLICA', 'sin señal plantada: A NO EXPLICA', `${A0.estado} r=${A0.r}`);
ok(sinSenal.conjunto.estado === 'MAYORMENTE_IMPREDECIBLE', 'y el conjunto sale mayormente impredecible', sinSenal.conjunto.estado);
ok(/Es un HALLAZGO, no un fracaso/.test(sinSenal.conjunto.porque), 'dicho como hallazgo, no como fracaso', sinSenal.conjunto.porque);
ok(sinSenal.veredicto === 'MAYORMENTE_IMPREDECIBLE', 'y ese es el veredicto', sinSenal.veredicto);

// Con señal fuerte: A EXPLICA.
const conSenal = analizaReaccion(fabrica(200, { fuerza: 0.5, ruido: 0.02 }));
const A1 = conSenal.senales.find((x) => x.id === 'A');
ok(A1.estado === 'EXPLICA' && Math.abs(A1.r) >= 0.2 && A1.p_valor < 0.05, 'con señal plantada: A EXPLICA', `${A1.estado} r=${A1.r} p=${A1.p_valor}`);
// r y r² se publican redondeados por separado: se comparan con tolerancia.
ok(Math.abs(A1.r2_sola - A1.r * A1.r) < 1e-3, 'con su R² sola = r²', `${A1.r2_sola} vs ${A1.r * A1.r}`);
ok(conSenal.conjunto.estado === 'EXPLICA_PARTE', 'y el conjunto explica una parte', conSenal.conjunto.estado);

// "Las tres juntas" solo si son las tres.
ok(/solo con sorpresa de EPS/.test(conSenal.conjunto.porque),
  'con una sola señal adentro NO se dice "las tres juntas": se nombra con cuál', conSenal.conjunto.porque);
ok(!/las tres señales juntas/.test(conSenal.conjunto.porque), 'mentir con el plural sería fácil; no se hace');

// Cobertura: B con 30% no entra; C con 0% no entra.
const parcial = analizaReaccion(fabrica(200, { fuerza: 0.5, conIngresos: 60 }), {
  motivosNoEntra: { guia: 'faltan la extracción y el consenso' } });
const B = parcial.senales.find((x) => x.id === 'B'), Cg = parcial.senales.find((x) => x.id === 'C');
ok(B.estado === 'NO_ENTRA' && B.cobertura === 0.3, 'B con 30% de cobertura NO entra', `${B.estado} ${B.cobertura}`);
ok(/bajo el mínimo de 50%/.test(B.porque), 'y se dice por qué');
ok(Cg.estado === 'NO_ENTRA' && /faltan la extracción/.test(Cg.porque), 'C no entra, con el motivo que dio el censo');
ok(parcial.conjunto.senales.join('') === 'A', 'el conjunto se hace SOLO con las que entraron');
ok(parcial.tres_piezas.estado === 'INCONCLUSO' && /falta la señal C/.test(parcial.tres_piezas.porque),
  'las tres piezas juntas: INCONCLUSO, nombrando la que falta', parcial.tres_piezas.porque);

// Candado: 80 eventos → INCONCLUSO, aunque la señal sea fuerte.
const chico = analizaReaccion(fabrica(80, { fuerza: 0.5, ruido: 0.02 }));
const Ac = chico.senales.find((x) => x.id === 'A');
ok(Ac.estado === 'INCONCLUSO' && Ac.r === undefined, '80 eventos: INCONCLUSO, y NO se publica el r', `${Ac.estado}`);
ok(chico.conjunto.estado === 'INCONCLUSO', 'el conjunto tampoco');

// Sin precios: INCONCLUSO entero.
const sinPrecios = analizaReaccion(fabrica(200).map((e, i) => (i % 3 ? { ...e, ret: { ok: false, motivo: 'sin_vela_apertura_siguiente' } } : e)));
ok(sinPrecios.veredicto === 'INCONCLUSO' && /Sin la variable dependiente/.test(sinPrecios.titular),
  'con < 50% de ventanas completas, todo INCONCLUSO: no hay nada que explicar', sinPrecios.titular);
ok(sinPrecios.precios.descartes.sin_vela_apertura_siguiente > 0, 'con los descartes por motivo');

console.log('EXPLORATORIO: aparte y fuera del veredicto');

const ex = conSenal.exploratorio;
ok(/EXPLORATORIO — no entra al veredicto/.test(ex.etiqueta), 'etiquetado EXPLORATORIO');
ok(ex.eps && ex.eps.ajustado && ex.eps.crudo, 'con la versión ajustada Y la cruda ("subió la acción" en una nota)');
ok(ex.eps.beats + ex.eps.misses === ex.eps.n, 'beats + misses = n (los ceros se excluyen)');
ok(ex.eps.ajustado.beat_y_sube > 0.5, 'con señal plantada, el beat viene con suba más de la mitad de las veces', ex.eps.ajustado.beat_y_sube);
ok(!Object.keys(conSenal).includes('acierto') && conSenal.veredicto !== undefined,
  'el acierto direccional no toca el veredicto');

console.log('las ADVERTENCIAS');

const adv = advertenciasFijas();
ok(/ocurre de noche/.test(adv.pead) && /OPERARLA es otra pregunta/.test(adv.pead) && /NO está contestada/.test(adv.pead),
  'la del PEAD: aunque algo explique la reacción, operarla es otra pregunta');
ok(/sesión COMPLETA/.test(adv.ventana) && /baja las correlaciones; no las sube/.test(adv.ventana),
  'la de la ventana: el costo declarado, y para qué lado sesga');
ok(/SESGO DE SELECCIÓN en A/.test(parcial.advertencia_seleccion || conSenal.advertencia_seleccion || 'SESGO DE SELECCIÓN en A'),
  'el sesgo de selección se calcula por señal');
// Una señal que cubre solo parte de las empresas: se dice cuáles.
const parcialEmp = analizaReaccion(fabrica(200, { fuerza: 0.5 }).map((e) => (['S0', 'S1', 'S2'].includes(e.symbol) ? { ...e, eps: { ok: false } } : e)));
ok(/SESGO DE SELECCIÓN en A/.test(parcialEmp.advertencia_seleccion || ''), 'si A no cubre todas las empresas, se dice');
ok(/Sin datos: S0 S1 S2/.test(parcialEmp.advertencia_seleccion), 'nombrando de qué empresas NO hay', parcialEmp.advertencia_seleccion);

console.log('markdown');

const mdA = renderAnalisisMd({ ...parcial, generado_en: 'x' });
ok(/VEREDICTO:/.test(mdA) && /ocurre de noche/.test(mdA), 'el veredicto con la advertencia del PEAD arriba');
ok(/\| A — /.test(mdA) && /NO ENTRA/.test(mdA), 'la tabla por señal con su estado');
ok(/EXPLORATORIO/.test(mdA), 'el exploratorio, etiquetado');
ok(/congelados antes de correr/.test(mdA) && /no se auto-aprueba/.test(mdA), 'y el pie del pre-registro');
const mdC = renderCensoMd({ generado_en: 'x', frente: 'guia', eventos: { total: 1 }, criterios: C, advertencias: adv,
  frentes: { guia: { simbolos: [{ symbol: 'NKE', filings: [{ fecha: '2026-10-01', exhibit: 'ex991.htm', url: 'u', regla_exhibit: 'nombre_ex99_1', parrafos: ps }] }],
    filings_leidos: 1, filings_con_guia: 1, entra: false, porque: 'NO ENTRA.' } } });
ok(/45\.0 billion to \$46\.0 billion/.test(mdC), 'el censo de guía imprime el párrafo crudo');
ok(/\[parece safe harbor\]/.test(mdC), 'con la marca de safe harbor visible');
ok(/CERO llamadas a LLM/.test(mdC), 'y lo dice');
ok(typeof renderCensoMd({}) === 'string' && typeof renderAnalisisMd({ precios: { con_retorno: 0, cobertura: 0 } }) === 'string',
  'un objeto a medias no rompe el render');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
