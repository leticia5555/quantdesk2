// ═══════════════════════════════════════════════════════════════
// Tests de la FASE 2 (análisis). JS puro, sin red ni DB:
//   - CRITERIOS_F2 pineados (mover una portería rompe un test)
//   - features: SOLO datos anteriores a report_date (el cero look-ahead)
//   - winsorización de la sorpresa, congelada antes de entrenar
//   - Brier, calibración por decil, simulación
//   - veredicto GO / NO-GO / INCONCLUSO contra datasets sintéticos
//   - la advertencia de "señal, no prueba" va SIEMPRE
//   - la vista de comparación: mismas predicciones, cero apuestas, cero retornos
// Correr con `node tests/earnings-beat-analyze.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  CRITERIOS_F2, featuresDeEvento, winsoriza, brier, calibracionPorDecil,
  simula, analiza, renderResumenF2, prediceCV, entrena, predice, ORDEN_FEATURES,
  comparacion, renderComparacionMd, acierta, TRAMOS, MIN_N_TRAMO,
} from '../api/_lib/earnings-beat-analyze.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('CRITERIOS_F2 congelados ANTES de correr');

ok(CRITERIOS_F2.min_mercados === 100, 'candado de muestra = 100', CRITERIOS_F2.min_mercados);
ok(CRITERIOS_F2.min_apuestas === 30, 'candado de apuestas = 30', CRITERIOS_F2.min_apuestas);
ok(CRITERIOS_F2.umbral_desacuerdo === 0.15, 'apuesta solo con ≥15 pts de desacuerdo');
ok(CRITERIOS_F2.costo_por_apuesta === 0.03, 'costo 3% por apuesta');
ok(CRITERIOS_F2.min_volumen_usd === 500, 'umbral de liquidez fijado en $500', CRITERIOS_F2.min_volumen_usd);
ok(CRITERIOS_F2.min_volumen_usd > CRITERIOS_F2.piso_de_ruido_declarado_usd,
  'y está por encima del piso de ruido declarado ($200)');
ok(CRITERIOS_F2.winsor_sorpresa_pct === 100, 'winsorización de la sorpresa congelada en ±100%', CRITERIOS_F2.winsor_sorpresa_pct);
ok(CRITERIOS_F2.ventana_trimestres === 20, 'ventana de 20 trimestres (5 años)');
ok(CRITERIOS_F2.baselines.length === 3 && CRITERIOS_F2.baselines.includes('mercado_t24h'),
  'los tres baselines, incluido el mercado');
ok(ORDEN_FEATURES.join(',') === 'tasa,racha,sorpresa_mediana,pares',
  'las cuatro features del encargo, sin ensembles', ORDEN_FEATURES.join(','));

console.log('winsoriza: acota sin descartar ni cambiar el signo');

ok(winsoriza(2800, 100) === 100, '+2800% → +100% (el caso INTC)');
ok(winsoriza(-6966, 100) === -100, '−6966% → −100% (el caso BA)');
ok(winsoriza(9.1, 100) === 9.1, 'un valor normal no se toca');
ok(winsoriza(null, 100) === null, 'null sigue null');

console.log('features: CERO look-ahead');

const HIST = [
  { reported_date: '2026-06-25', reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9 },
  { reported_date: '2026-03-25', reported_eps: 1.1, estimated_eps: 1.0, surprise_pct: 10 },
  { reported_date: '2025-12-20', reported_eps: 0.8, estimated_eps: 0.9, surprise_pct: -11 },
  // EL TRIMESTRE QUE SE QUIERE PREDECIR, fechado EXACTAMENTE en el report_date
  // del evento: es el que no puede entrar a sus propios features. Un trimestre
  // fechado un día ANTES sí entra, y debe entrar — es un reporte anterior.
  { reported_date: '2026-09-30', reported_eps: 9.9, estimated_eps: 1.0, surprise_pct: 890 },
];
const f = featuresDeEvento({ report_date: '2026-09-30', historial: HIST });
ok(f.trimestres_previos === 3, 'usa solo los trimestres ANTERIORES al report_date', f.trimestres_previos);
ok(Math.abs(f.tasa - 2 / 3) < 1e-9, 'tasa = 2 de 3', f.tasa);
// Los dos previos más recientes son beats y el tercero es miss → +2.
ok(f.racha === 2, 'racha CON SIGNO: +2 (dos beats al hilo antes del miss)', f.racha);
ok(f.sorpresa_mediana === 9, 'mediana de sorpresa de los previos (no el 890 del futuro)', f.sorpresa_mediana);

// Y uno POSTERIOR al report_date tampoco, obviamente. Si el filtro se relajara
// a `<=`, el primer assert (3 previos) se pondría en 4 y este en 5.
const conPosterior = featuresDeEvento({ report_date: '2026-09-30',
  historial: [...HIST, { reported_date: '2026-12-20', reported_eps: 5, estimated_eps: 1, surprise_pct: 400 }] });
ok(conPosterior.trimestres_previos === 3, 'un trimestre posterior al report_date tampoco entra', conPosterior.trimestres_previos);

const sinHist = featuresDeEvento({ report_date: '2026-09-30', historial: [] });
ok(sinHist.sin_historial === true && sinHist.tasa === null, 'sin historial → null declarado, no un 0.5 inventado');

console.log('features: pares del mismo sector, misma temporada, ANTES');

const PARES = [
  { symbol: 'AMD', reported_date: '2026-09-28', beat: true },   // mismo mes, antes → cuenta
  { symbol: 'NVDA', reported_date: '2026-09-29', beat: false },  // mismo mes, antes → cuenta
  { symbol: 'MU', reported_date: '2026-10-02', beat: true },     // mes siguiente → NO
  { symbol: 'INTC', reported_date: '2026-06-20', beat: true },   // otra temporada → NO
];
const fp = featuresDeEvento({ report_date: '2026-09-30', historial: HIST, paresDelSector: PARES });
ok(fp.pares_n === 2, 'solo los pares del mismo mes y anteriores', fp.pares_n);
ok(fp.pares === 0.5, '1 de 2 beats → 0.5', fp.pares);
const fsp = featuresDeEvento({ report_date: '2026-09-30', historial: HIST, paresDelSector: [] });
ok(fsp.pares === null, 'sin pares → null (no 0, que significaría "ninguno superó")', fsp.pares);

console.log('brier y calibración');

ok(brier([1, 0], [1, 0]) === 0, 'predicción perfecta → 0');
ok(brier([0.5, 0.5], [1, 0]) === 0.25, 'moneda al aire → 0.25');
ok(brier([null, 0.5], [1, 0]) === 0.25, 'los null se saltan, no envenenan');
ok(brier([], []) === null, 'sin datos → null');

const cal = calibracionPorDecil([0.05, 0.15, 0.95, 0.95], [0, 0, 1, 0], { deciles: 10 });
ok(cal[0].n === 1 && cal[1].n === 1 && cal[9].n === 2, 'reparte por decil', `${cal[0].n}/${cal[1].n}/${cal[9].n}`);
ok(cal[9].observado === 0.5 && cal[9].predicho_medio === 0.95, 'el decil alto muestra predicho vs observado');
ok(cal[9].brecha === 0.45, 'y la brecha, que es donde se ve el exceso de confianza', cal[9].brecha);

console.log('simulación: mecánica de la apuesta binaria');

const EV = [
  { symbol: 'A', report_date: '2026-01-01', beat: true, mercado: 0.50 },
  { symbol: 'B', report_date: '2026-01-02', beat: false, mercado: 0.50 },
  { symbol: 'C', report_date: '2026-01-03', beat: true, mercado: 0.60 },
];
const s1 = simula(EV, [0.90, 0.10, 0.62], { umbral: 0.15, costo: 0.03 });
ok(s1.apuestas === 2, 'solo apuesta donde el desacuerdo llega al umbral (0.62 vs 0.60 no)', s1.apuestas);
ok(s1.aciertos === 2, 'las dos aciertan');
// A: compra SÍ a 0.50 → gana 1/0.5−1 = 1.0, menos 3% = 0.97
// B: compra NO a 0.50 → gana 1.0, menos 3% = 0.97
ok(Math.abs(s1.neto_unidades - 1.94) < 1e-9, 'el neto usa 1/p − 1 y cobra el costo siempre', s1.neto_unidades);
const s2 = simula(EV, [0.10, 0.90, 0.62], { umbral: 0.15, costo: 0.03 });
ok(s2.aciertos === 0 && Math.abs(s2.neto_unidades + 2.06) < 1e-9, 'y las pérdidas son −1 menos el costo', s2.neto_unidades);
ok(simula(EV, [0.5, 0.5, 0.5], { umbral: 0.15 }).apuestas === 0, 'sin desacuerdo, cero apuestas');

console.log('veredicto: los candados van ANTES que los números');

// Dataset chico: aunque el modelo fuera perfecto, la muestra no alcanza.
const chico = Array.from({ length: 40 }, (_, i) => ({
  symbol: 'S' + i, report_date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
  beat: i % 2 === 0, mercado: 0.5,
  features: { tasa: i % 2 === 0 ? 0.9 : 0.1, racha: 1, sorpresa_mediana: 5, pares: 0.5, sin_historial: false },
}));
const rc = analiza(chico);
ok(rc.veredicto === 'INCONCLUSO', 'muestra < 100 → INCONCLUSO aunque el modelo separe perfecto', rc.veredicto);
ok(rc.porque.some((p) => /muestra/.test(p)), 'y el porqué nombra la muestra');

// Dataset grande donde el modelo NO tiene señal: NO-GO.
const ruido = Array.from({ length: 200 }, (_, i) => ({
  symbol: 'S' + (i % 20), report_date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
  beat: i % 3 === 0, mercado: 0.34,
  features: { tasa: 0.34, racha: 0, sorpresa_mediana: 0, pares: 0.34, sin_historial: false },
}));
const rr = analiza(ruido);
ok(rr.veredicto === 'NO-GO' || rr.veredicto === 'INCONCLUSO', 'sin señal → NO-GO o INCONCLUSO, nunca GO', rr.veredicto);

// Dataset con señal real Y desacuerdo con el mercado: puede dar GO.
const senal = Array.from({ length: 200 }, (_, i) => {
  const bueno = i % 2 === 0;
  return {
    symbol: 'S' + (i % 20), report_date: '2026-0' + ((i % 9) + 1) + '-15',
    beat: bueno, mercado: 0.5,
    features: { tasa: bueno ? 0.95 : 0.05, racha: bueno ? 5 : -5,
      sorpresa_mediana: bueno ? 20 : -20, pares: bueno ? 0.9 : 0.1, sin_historial: false },
  };
});
const rs = analiza(senal);
ok(rs.briers.modelo_cv < rs.briers.mercado_t24h, 'con señal real, el modelo le gana al mercado', `${rs.briers.modelo_cv} vs ${rs.briers.mercado_t24h}`);
ok(rs.simulacion.apuestas >= 30, 'y hay apuestas suficientes para leer el neto', rs.simulacion.apuestas);
ok(rs.veredicto === 'GO', 'veredicto GO cuando pasa lectura y edge', rs.veredicto);

console.log('un feature siempre nulo se DENUNCIA, no se traga');

// Si los pares del sector no reportaron en la misma temporada *según
// pead_earnings*, el feature sale null en todos los eventos y el modelo corre
// de hecho con 3 features. Dejar que lo reciba como "la media" en silencio es
// cómo un feature muerto pasa por vivo.
const sinPares = senal.map((e) => ({ ...e, features: { ...e.features, pares: null } }));
const rsp = analiza(sinPares);
ok(rsp.muestra.sin_pares === sinPares.length, 'cuenta los eventos sin pares', rsp.muestra.sin_pares);
ok(typeof rsp.muestra.aviso_pares === 'string' && /3 features/.test(rsp.muestra.aviso_pares),
  'y avisa que el modelo corre con 3 features, no con 4');
ok(/deuda/.test(rsp.muestra.aviso_pares), 'nombrando la causa típica (la cosecha del PEAD atrasada)');
// Exactamente la mitad NO dispara (el umbral es "más de la mitad", estricto);
// dos tercios sí.
const mitadJusta = senal.map((e, i) => (i % 2 ? { ...e, features: { ...e.features, pares: null } } : e));
ok(analiza(mitadJusta).muestra.aviso_pares === null, 'exactamente la mitad nulos → sin aviso (el umbral es estricto)');
const mayoria = senal.map((e, i) => (i % 3 ? { ...e, features: { ...e.features, pares: null } } : e));
ok(/más de la mitad/.test(analiza(mayoria).muestra.aviso_pares || ''), 'dos tercios nulos → avisa');
ok(analiza(senal).muestra.aviso_pares === null, 'con pares presentes, sin aviso');
ok(/feature de pares es null/.test(renderResumenF2({ ...rsp, generado_en: 'x' })),
  'el aviso aparece en el markdown, no solo en el JSON');

console.log('la advertencia y lo EXPLORATORIO');

for (const r of [rc, rr, rs]) {
  ok(/SEÑAL, no prueba/.test(r.advertencia), 'la advertencia va SIEMPRE, no solo en GO');
}
ok(/grabar hacia adelante/.test(rs.advertencia), 'y nombra la prueba de verdad: grabar hacia adelante congelado');
ok(Number.isFinite(rs.briers.modelo_en_muestra_EXPLORATORIO), 'el Brier en muestra se publica…');
ok(/EXPLORATORIO/.test(Object.keys(rs.briers).join(',')), '…etiquetado EXPLORATORIO, para que no decida');
ok(rs.briers.modelo_cv >= rs.briers.modelo_en_muestra_EXPLORATORIO - 1e-9,
  'y el de CV no puede ser mejor que el de muestra (si lo fuera, algo está mal)',
  `${rs.briers.modelo_cv} vs ${rs.briers.modelo_en_muestra_EXPLORATORIO}`);

console.log('determinismo: el mismo dataset da el mismo modelo');

const a1 = analiza(senal), a2 = analiza(senal);
ok(a1.briers.modelo_cv === a2.briers.modelo_cv, 'sin aleatoriedad: dos corridas, el mismo Brier');
ok(JSON.stringify(a1.modelo.pesos_en_muestra) === JSON.stringify(a2.modelo.pesos_en_muestra), 'y los mismos pesos');

console.log('markdown');

const md = renderResumenF2({ ...rs, generado_en: '2026-09-24T00:00:00Z', liquidez: { antes: 240, sobreviven: 200, descartados: 40 } });
ok(/VEREDICTO: GO/.test(md), 'el veredicto va arriba');
ok(/SEÑAL, no prueba/.test(md), 'la advertencia también');
ok(/Polymarket T-24h/.test(md) && /tasa por empresa/.test(md), 'los baselines se nombran');
ok(/Calibración por decil/.test(md), 'la calibración por tramo está en el resumen');
ok(/\$500/.test(md) && /240/.test(md), 'el umbral de liquidez y cuántos sobreviven');
ok(/EXPLORATORIO/.test(md), 'lo exploratorio va marcado');
ok(typeof renderResumenF2({ veredicto: 'INCONCLUSO', porque: [], muestra: {}, briers: {}, calibracion: {}, modelo: {}, advertencia: 'x' }) === 'string',
  'un análisis a medias no rompe el render');

// ═══════════════════════════════════════════════════════════════
// VISTA DE COMPARACIÓN
// Lo que estos tests defienden: que no re-entrene, que el filtro sea por la
// probabilidad del MERCADO, que "más cerca" sea distancia y no lado, que los
// tramos flacos salgan marcados, que el titular se calcule, y que en ninguna
// parte aparezca una apuesta o un retorno.
// ═══════════════════════════════════════════════════════════════

console.log('comparación: el acierto de una probabilidad, congelado');

ok(acierta(0.5, true) === true, 'p = 0.5 apuesta a beat (el corte está en ≥ 0.5, no en >)');
ok(acierta(0.49, false) === true, 'p < 0.5 acierta cuando fue miss');
ok(acierta(0.8, false) === false, 'y falla cuando fue beat');
ok(acierta(null, true) === null, 'sin probabilidad no hay acierto: null, no false');
ok(MIN_N_TRAMO === 20, 'el mínimo para concluir por tramo = 20', MIN_N_TRAMO);
ok(TRAMOS.some(([a, b]) => a === 0.55 && b === 0.65) && TRAMOS.some(([a, b]) => a === 0.65 && b === 0.75),
  'la zona de duda 0.55–0.75 va partida en dos, no en un solo bloque');

console.log('comparación: NO re-entrena, consume las predicciones que le pasan');

ok(Array.isArray(analiza(senal).predicciones) && analiza(senal).predicciones.length === senal.length,
  'analiza() devuelve una predicción por evento — la única fuente de la columna QD');
const predAjenas = senal.map(() => 0.999);
const cAjenas = comparacion(senal, predAjenas);
ok(cAjenas.filas.every((f) => f.prob_quantdesk === 0.999),
  'si le pasan 0.999 muestra 0.999: no vuelve a ajustar el modelo por su cuenta');
// Y con las de verdad: las filas son EXACTAMENTE las que dictaron el veredicto.
const cReal = comparacion(senal, rs.predicciones);
const dichas = cReal.filas.map((f) => f.prob_quantdesk).sort((a, b) => a - b).join(',');
const delVeredicto = rs.predicciones.map((p) => +p.toFixed(3)).sort((a, b) => a - b).join(',');
ok(dichas === delVeredicto, 'la tabla y el veredicto salen del mismo ajuste, número por número');
ok(cReal.filtro.filas_totales === senal.length, 'y no se pierde ningún mercado en el camino', cReal.filtro.filas_totales);

console.log('comparación: una fila que no se puede comparar se DENUNCIA');

const EVF = [
  { symbol: 'OK', report_date: '2026-06-01', beat: true, mercado: 0.60 },
  { symbol: 'SIN_PM', report_date: '2026-06-02', beat: true, mercado: NaN },
  { symbol: 'SIN_QD', report_date: '2026-06-03', beat: false, mercado: 0.40 },
];
const cf = comparacion(EVF, [0.7, 0.7, null]);
ok(cf.filas.length === 1 && cf.filtro.filas_totales === 1, 'solo la fila comparable entra a la tabla', cf.filas.length);
ok(cf.filtro.eventos_recibidos === 3 && cf.filtro.descartadas === 2,
  'pero dice de cuántos partió y cuántos descartó: la tabla no se encoge en silencio',
  `${cf.filtro.eventos_recibidos} → ${cf.filtro.descartadas}`);
ok(/2 de 3 mercados quedaron fuera/.test(cf.filtro.aviso_descartadas || ''), 'con aviso en letras', cf.filtro.aviso_descartadas);
ok(cf.filtro.detalle_descartadas.find((d) => d.symbol === 'SIN_QD').motivo === 'sin_prediccion'
  && cf.filtro.detalle_descartadas.find((d) => d.symbol === 'SIN_PM').motivo === 'sin_precio_de_mercado',
  'y nombrando cuál de los dos números faltaba', JSON.stringify(cf.filtro.detalle_descartadas));
ok(comparacion([EVF[0]], [0.7]).filtro.aviso_descartadas === null,
  'sin descartes, sin aviso: no se avisa de nada');

console.log('comparación: el desacuerdo lleva signo y "más cerca" es distancia');

const EVC = [
  { symbol: 'OPT', report_date: '2026-02-01', beat: true, mercado: 0.40 },  // QD más optimista
  { symbol: 'PES', report_date: '2026-02-02', beat: false, mercado: 0.80 }, // QD más pesimista
  { symbol: 'IGU', report_date: '2026-02-03', beat: true, mercado: 0.70 },  // idénticos
  { symbol: 'AMB', report_date: '2026-02-04', beat: true, mercado: 0.95 },  // los dos aciertan el lado
];
const cc = comparacion(EVC, [0.75, 0.20, 0.70, 0.55], { orden: 'fecha', descendente: false });
const [fOpt, fPes, fIgu, fAmb] = cc.filas;
ok(fOpt.desacuerdo === 0.35, '+0.35: QuantDesk más optimista que el mercado', fOpt.desacuerdo);
ok(fPes.desacuerdo === -0.6, '−0.60: QuantDesk más pesimista', fPes.desacuerdo);
ok(fOpt.desacuerdo_abs === 0.35 && fPes.desacuerdo_abs === 0.6, 'y el abs va aparte, para ordenar');
ok(fIgu.mas_cerca === 'empate' && fIgu.desacuerdo === 0, 'iguales → empate, no un ganador inventado');
ok(fAmb.acierta_quantdesk === true && fAmb.acierta_polymarket === true && fAmb.mas_cerca === 'polymarket',
  'los dos aciertan el LADO y el mercado igual queda más cerca: "más cerca" no es "acertó"');
ok(fPes.acierta_quantdesk === true && fPes.acierta_polymarket === false,
  'y cuando el lado difiere, el acierto también');

console.log('comparación: el filtro de zona es por el precio del MERCADO');

const EVZ = [
  { symbol: 'DENTRO', report_date: '2026-03-01', beat: true, mercado: 0.60 },
  { symbol: 'BORDE_BAJO', report_date: '2026-03-02', beat: true, mercado: 0.55 },
  { symbol: 'BORDE_ALTO', report_date: '2026-03-03', beat: true, mercado: 0.75 },
  { symbol: 'FUERA', report_date: '2026-03-04', beat: true, mercado: 0.95 },
];
// La cuarta fila tiene un QD DENTRO de la zona y un mercado fuera: si el filtro
// mirara al modelo, entraría. Es la confusión que este test cierra.
const cz = comparacion(EVZ, [0.10, 0.10, 0.10, 0.60], { zonaDesde: 0.55, zonaHasta: 0.75 });
ok(cz.filas.length === 2, 'la zona 0.55–0.75 deja 2 de 4: desde inclusivo, hasta exclusivo', cz.filas.length);
ok(cz.filas.every((f) => f.symbol !== 'FUERA'), 'un QD dentro de la zona NO mete a su mercado en la zona');
ok(cz.filas.some((f) => f.symbol === 'BORDE_BAJO') && !cz.filas.some((f) => f.symbol === 'BORDE_ALTO'),
  'el borde de abajo entra y el de arriba no (así no se cuenta dos veces entre tramos)');
ok(cz.filtro.filas_totales === 4 && cz.filtro.filas_en_zona === 2,
  'y el filtro dice de cuántas partió, no solo cuántas quedaron');
// Los tramos y la distribución se calculan sobre TODO, no sobre lo filtrado: un
// titular que cambia con el filtro no es un titular, es un artefacto.
ok(cz.extremos.de === 4, 'el titular se calcula sobre el total, no sobre la zona filtrada', cz.extremos.de);

console.log('comparación: los órdenes');

const ordenados = (o, asc) => comparacion(EVC, [0.75, 0.20, 0.70, 0.55], { orden: o, descendente: !asc })
  .filas.map((f) => f.symbol).join(',');
ok(ordenados('desacuerdo') === 'PES,AMB,OPT,IGU', 'por defecto: el desacuerdo más grande arriba', ordenados('desacuerdo'));
ok(ordenados('desacuerdo', true) === 'IGU,OPT,AMB,PES', 'y al revés con asc', ordenados('desacuerdo', true));
ok(ordenados('desacuerdo_con_signo') === 'OPT,IGU,AMB,PES', 'con signo: el más optimista arriba', ordenados('desacuerdo_con_signo'));
ok(ordenados('fecha', true) === 'OPT,PES,IGU,AMB', 'por fecha ascendente');
ok(ordenados('simbolo', true) === 'AMB,IGU,OPT,PES', 'por símbolo');
ok(ordenados('mercado', true) === 'OPT,IGU,PES,AMB', 'por precio del mercado');
ok(ordenados('inventado') === ordenados('desacuerdo'), 'un orden que no existe cae al default, no rompe');

console.log('comparación: los tramos flacos salen MARCADOS');

// 25 mercados en 0.65–0.75 (alcanza para concluir) y 5 en 0.55–0.65 (no).
const EVT = [
  // 5 de los 25 son miss (i = 0, 5, 10, 15, 20) → 20 beats = 0.80.
  ...Array.from({ length: 25 }, (_, i) => ({ symbol: 'G' + i, report_date: '2026-04-01', beat: i % 5 !== 0, mercado: 0.70 })),
  ...Array.from({ length: 5 }, (_, i) => ({ symbol: 'P' + i, report_date: '2026-04-02', beat: true, mercado: 0.60 })),
];
// QD dice 0.30 en todos → apuesta a "miss" siempre, y acierta solo los 5 misses.
const ct = comparacion(EVT, EVT.map(() => 0.30));
const t65 = ct.por_tramo.find((t) => t.tramo === '0.65–0.75');
const t55 = ct.por_tramo.find((t) => t.tramo === '0.55–0.65');
ok(t65.n === 25 && t65.muestra_insuficiente === false, '25 casos: alcanza para concluir', `${t65.n}`);
ok(t55.n === 5 && t55.muestra_insuficiente === true, '5 casos: MUESTRA INSUFICIENTE, marcado', `${t55.n}`);
ok(Math.abs(t65.acierto_polymarket - 0.80) < 1e-9, 'el acierto del mercado por tramo sale de los resultados reales', t65.acierto_polymarket);
ok(Math.abs(t65.beats_reales - 0.80) < 1e-9, 'y los beats reales del tramo se publican al lado', t65.beats_reales);
ok(Math.abs(t65.acierto_quantdesk - 0.20) < 1e-9,
  'y el del modelo al lado, medido igual: QD dijo 0.30 → "miss" en los 25, acertó los 5', t65.acierto_quantdesk);
ok(t65.desacuerdo_mediano === -0.4, 'el desacuerdo mediano del tramo conserva el signo', t65.desacuerdo_mediano);
ok(t65.quantdesk_mas_cerca + t65.polymarket_mas_cerca + t65.empates === t65.n,
  'cada mercado del tramo cae en exactamente una de las tres columnas');
ok(ct.por_tramo.every((t) => typeof t.muestra_insuficiente === 'boolean'),
  'ningún tramo se publica sin decir si alcanza o no');

console.log('comparación: el titular se CALCULA, no se escribe a mano');

// El mercado se moja (0.95) y el modelo no (0.70): QuantDesk duda más.
const EVD = Array.from({ length: 30 }, (_, i) => ({ symbol: 'D' + i, report_date: '2026-05-01', beat: true, mercado: 0.95 }));
const cd = comparacion(EVD, EVD.map(() => 0.70));
ok(/QuantDesk duda más que el mercado/.test(cd.titular), 'lo dice en letras, no lo deja deducir de la tabla', cd.titular);
ok(cd.extremos.quantdesk === 0 && cd.extremos.polymarket === 30, 'con los números que lo sostienen');
ok(/0\.9–1/.test((cd.titular_detalle || []).join(' ')), 'y el detalle nombra el tramo 0.9–1 del encargo');
// Dado vuelta, la frase se da vuelta: si mañana el modelo se moja más, el
// titular cambia con él. Eso es lo que significa "calculado".
const cinv = comparacion(EVD.map((e) => ({ ...e, mercado: 0.70 })), EVD.map(() => 0.95));
ok(/El mercado duda más que QuantDesk/.test(cinv.titular), 'al revés, la frase se da vuelta', cinv.titular);
const cemp = comparacion(EVD, EVD.map(() => 0.95));
ok(/se mojan parecido/.test(cemp.titular), 'y empatados no se inventa un ganador', cemp.titular);

console.log('comparación: NI UNA apuesta, NI UN retorno');

// Se revisan los CAMPOS, no el texto: el disclaimer nombra "señal de apuesta" y
// "no calcula retornos" a propósito, y buscar la palabra suelta lo marcaría a él.
function todasLasClaves(o, acc = new Set()) {
  if (Array.isArray(o)) { for (const x of o) todasLasClaves(x, acc); return acc; }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) { acc.add(k); todasLasClaves(v, acc); }
  }
  return acc;
}
const claves = [...todasLasClaves(comparacion(senal, rs.predicciones))];
const PROHIBIDAS = /apuesta|neto|retorno|unidad|costo|simulacion|ganancia|edge|kelly|stake/i;
const delatoras = claves.filter((k) => PROHIBIDAS.test(k));
ok(delatoras.length === 0, 'ni un campo de apuesta, costo o retorno en toda la vista', delatoras.join(','));
ok(claves.includes('prob_quantdesk') && claves.includes('prob_polymarket') && claves.includes('desacuerdo'),
  'lo que sí trae: las dos probabilidades y el desacuerdo', claves.length + ' campos');
ok(/NO es una señal de apuesta y NO calcula retornos/.test(cReal.no_es_senal),
  'y lo dice de frente, en el propio JSON');
ok(cReal.es_vista_de_comparacion === true, 'la vista se identifica como lo que es');

console.log('comparación: markdown');

const mdC = renderComparacionMd({ ...cReal, generado_en: '2026-09-24T00:00:00Z' }, { veredicto: 'NO-GO' });
ok(/veredicto de la Fase 2 sigue siendo NO-GO/.test(mdC),
  'el veredicto que sigue en pie va ARRIBA: la columna QD no está validada');
ok(/no.{0,3} pasó sus criterios/.test(mdC), 'dicho sin eufemismo');
ok(/NO es una señal de apuesta y NO calcula retornos/.test(mdC), 'el disclaimer se queda');
ok(/muestra insuficiente para concluir/.test(mdC), 'la leyenda del ⚠ está, no solo el símbolo');
ok(/zona de duda es 0\.55–0\.75/.test(mdC), 'y la tabla por tramo nombra la zona que se persigue');
ok(/positivo = QuantDesk más optimista/.test(mdC), 'el signo del desacuerdo se explica');
ok(!/neto|apuesta[s]? :|unidades/.test(mdC.replace('señal de apuesta', '')), 'sin netos ni apuestas en el texto');
ok(/Dónde pone su masa cada uno/.test(mdC), 'la distribución comparada está en el resumen');
ok(typeof renderComparacionMd({ filtro: { filas_totales: 0, zona_mercado_desde: null }, titular: 'x', no_es_senal: 'y' }) === 'string',
  'una vista vacía no rompe el render');

console.log('comparación: determinismo');

const j1 = JSON.stringify(comparacion(senal, rs.predicciones));
const j2 = JSON.stringify(comparacion(senal, rs.predicciones));
ok(j1 === j2, 'dos corridas, la misma tabla');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
