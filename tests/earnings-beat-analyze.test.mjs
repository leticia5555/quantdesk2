// ═══════════════════════════════════════════════════════════════
// Tests de la FASE 2 (análisis). JS puro, sin red ni DB:
//   - CRITERIOS_F2 pineados (mover una portería rompe un test)
//   - features: SOLO datos anteriores a report_date (el cero look-ahead)
//   - winsorización de la sorpresa, congelada antes de entrenar
//   - Brier, calibración por decil, simulación
//   - veredicto GO / NO-GO / INCONCLUSO contra datasets sintéticos
//   - la advertencia de "señal, no prueba" va SIEMPRE
// Correr con `node tests/earnings-beat-analyze.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  CRITERIOS_F2, featuresDeEvento, winsoriza, brier, calibracionPorDecil,
  simula, analiza, renderResumenF2, prediceCV, entrena, predice, ORDEN_FEATURES,
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

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
