// ═══════════════════════════════════════════════════════════════
// Tests del backtest de ENFRIAMIENTO DE ANALISTAS. JS puro, sin red ni DB.
//
// Lo que defienden, en orden de cuánto daño evita cada uno:
//
//   1. CERO LOOK-AHEAD. Solo grades con fecha ESTRICTAMENTE anterior al
//      report_date. Una fila fechada EL DÍA del reporte ya puede contener la
//      reacción de los analistas al reporte.
//   2. CRITERIOS PINEADOS. Todos los umbrales del pre-registro. Mover una
//      portería rompe un test y se ve en el diff.
//   3. EL P-VALOR CONTRA TABLA. La primera versión del erf daba p(z=1.96) =
//      0.061 en vez de 0.050 — un p-valor equivocado justo en el umbral del
//      veredicto. Se compara contra valores de tabla, no contra "se ve bien".
//   4. Los candados van ANTES de los números: muestra corta = INCONCLUSO sin
//      mirar la diferencia.
//   5. La advertencia de "información pública, no es señal de apuesta" va
//      SIEMPRE, en GO, en NO-GO y en INCONCLUSO.
//
// Correr con `node tests/grades-backtest.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  CRITERIOS_GRADES, scoreSentimiento, seleccionaVentana, terciles, tercilDe,
  NOMBRE_TERCIL, testProporciones, erf, normalCDF, analizaGrades, renderGradesMd, ADVERTENCIA,
} from '../api/_lib/grades-backtest.js';
import { normalizaGrades } from '../api/_lib/fmp-grades.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('CRITERIOS_GRADES congelados ANTES de correr (pre-registro)');

const C = CRITERIOS_GRADES;
ok(C.pesos.strongBuy === 2 && C.pesos.buy === 1 && C.pesos.hold === 0
  && C.pesos.sell === -1 && C.pesos.strongSell === -2,
  'los pesos del score son los del encargo: 2/1/0/−1/−2', JSON.stringify(C.pesos));
ok(C.min_eventos === 100, 'candado de muestra = 100 (por debajo: INCONCLUSO)');
ok(C.min_por_tercil === 30, 'mínimo 30 eventos por tercil');
ok(C.min_diferencia_pp === 10, 'diferencia para GO = 10 puntos porcentuales');
ok(C.max_p_valor === 0.05, 'p-valor para GO < 0.05');
ok(C.terciles === 3, 'terciles, no deciles');
ok(C.tasa_base_universo === 0.8182, 'el baseline obligatorio es la tasa base del universo', C.tasa_base_universo);
ok(C.min_meses_grades === 3, 'al menos 3 meses de grades previos');
ok(C.max_dias_t1 === 45 && C.min_dias_ventana === 45 && C.max_dias_ventana === 135 && C.dias_objetivo_t3 === 90,
  'las tolerancias de la ventana están congeladas', JSON.stringify([C.max_dias_t1, C.min_dias_ventana, C.max_dias_ventana]));

console.log('el score: el HOLD cuenta en el denominador');

const s1 = scoreSentimiento({ strongBuy: 6, buy: 20, hold: 4, sell: 0, strongSell: 0 });
ok(s1.total_analistas === 30, 'total = los cinco conteos, hold incluido', s1.total_analistas);
ok(Math.abs(s1.score - (2 * 6 + 20) / 30) < 1e-12, 'score = (2·sb + b − s − 2·ss) / total', s1.score);
// EL CASO QUE JUSTIFICA EL DENOMINADOR: una casa que pasa de buy a hold TIENE
// que bajar el score. Si el hold no contara, subiría — lo contrario de enfriarse.
const antes = scoreSentimiento({ strongBuy: 0, buy: 10, hold: 0, sell: 0, strongSell: 0 });
const despues = scoreSentimiento({ strongBuy: 0, buy: 9, hold: 1, sell: 0, strongSell: 0 });
ok(despues.score < antes.score, 'pasar un buy a hold BAJA el score (por eso el hold va en el denominador)',
  `${antes.score} → ${despues.score}`);
ok(scoreSentimiento({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }) === null,
  'un mes SIN analistas da null, no cero: cero es "se cancelan", que es otra cosa');
ok(scoreSentimiento(null) === null && scoreSentimiento(undefined) === null, 'y una fila ausente también');
const negativo = scoreSentimiento({ strongBuy: 0, buy: 0, hold: 0, sell: 5, strongSell: 5 });
ok(Math.abs(negativo.score - (-1.5)) < 1e-12, 'puros sell y strongSell dan −1.5', negativo.score);

console.log('CERO LOOK-AHEAD: el corte en report_date es ESTRICTO');

// Serie mensual limpia. La fila del 2026-07-15 está fechada EXACTAMENTE en el
// report_date: no puede entrar. La del día anterior sí, y debe.
const serie = [
  { date: '2026-03-15', strongBuy: 6, buy: 20, hold: 4, sell: 0, strongSell: 0 },  // T-4
  { date: '2026-04-15', strongBuy: 5, buy: 20, hold: 5, sell: 0, strongSell: 0 },  // ≈T-3
  { date: '2026-05-15', strongBuy: 3, buy: 18, hold: 8, sell: 1, strongSell: 0 },
  { date: '2026-06-15', strongBuy: 1, buy: 10, hold: 15, sell: 4, strongSell: 0 }, // ≈T-1
  { date: '2026-07-15', strongBuy: 9, buy: 20, hold: 1, sell: 0, strongSell: 0 },  // EL DÍA del reporte
];
const v = seleccionaVentana(serie, '2026-07-15');
ok(v.ok === true, 'la ventana se arma', JSON.stringify(v.motivo));
ok(v.t1.fecha === '2026-06-15', 'T-1 es la última fila ANTERIOR al reporte, no la del mismo día', v.t1.fecha);
ok(v.t3.fecha === '2026-04-15', 'T-3 es la más cercana a 90 días antes', v.t3.fecha);
ok(v.delta < 0, 'este caso se ENFRIÓ: delta negativo', v.delta);
// La prueba dura: si la fila del día del reporte entrara, el delta sería POSITIVO.
const conFuturo = seleccionaVentana(serie.map((g) => (g.date === '2026-07-15' ? { ...g, date: '2026-07-14' } : g)), '2026-07-15');
ok(conFuturo.t1.fecha === '2026-07-14' && conFuturo.delta > 0,
  'movida UN día antes, esa misma fila entra y da vuelta el signo — de ahí la importancia del corte',
  `${conFuturo.delta}`);
ok(seleccionaVentana(serie, '2026-07-15').delta !== conFuturo.delta,
  'y los dos casos NO dan lo mismo: el corte cambia el resultado, no es decorativo');

console.log('la ventana se cierra cuando no es la ventana');

ok(seleccionaVentana(serie.slice(0, 2), '2026-07-15').motivo === 'menos_de_3_meses',
  'menos de 3 meses previos: se descarta con su motivo');
// T-1 rancio: la última fila previa es de hace 100 días.
const rancio = seleccionaVentana([
  { date: '2026-01-15', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-02-15', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-03-15', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
], '2026-07-15');
ok(rancio.motivo === 't1_rancio' && rancio.dias_t1 === 122,
  'T-1 más viejo que 45 días: rancio, con los días a la vista', `${rancio.dias_t1}`);
// Ventana demasiado corta: tres filas semanales.
const corta = seleccionaVentana([
  { date: '2026-06-24', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-07-01', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-07-08', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
], '2026-07-15');
ok(corta.motivo === 'ventana_fuera_de_rango' && corta.dias_ventana_min === 7 && corta.dias_ventana_max === 14,
  'tres filas semanales: ninguna ventana llega a mes y medio, y se reporta el RANGO que había',
  `${corta.dias_ventana_min}–${corta.dias_ventana_max}`);
const sinAnalistas = seleccionaVentana([
  { date: '2026-04-15', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-05-15', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-06-15', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
], '2026-07-15');
ok(sinAnalistas.motivo === 'sin_analistas', 'sin analistas en T-1 o T-3: se descarta, no se asume cero');
ok(seleccionaVentana(serie, null).motivo === 'sin_report_date', 'sin report_date no hay ventana');
ok(seleccionaVentana([], '2026-07-15').motivo === 'menos_de_3_meses', 'serie vacía: motivo, no excepción');

// EL ARREGLO QUE ESTE TEST FIJÓ: antes se elegía el T-3 más cercano a 90 días y
// DESPUÉS se miraba la ventana, así que un reporte de fin de mes se descartaba
// aunque hubiera otra fila que sí dejaba la ventana en rango.
const finDeMes = [
  { date: '2026-04-10', strongBuy: 10, buy: 15, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-05-10', strongBuy: 5, buy: 20, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-06-20', strongBuy: 0, buy: 25, hold: 0, sell: 0, strongSell: 0 },
];
const v27 = seleccionaVentana(finDeMes, '2026-07-27');
ok(v27.ok === true, 'un reporte de fin de mes NO se descarta si alguna fila deja la ventana en rango', v27.motivo);
ok(v27.t3.fecha === '2026-04-10' && v27.dias_ventana === 71,
  'se elige el T-3 más cercano a 90 días ENTRE los que dejan la ventana válida', `${v27.t3.fecha}/${v27.dias_ventana}`);
// Y cuando NINGUNA fila deja la ventana en rango, el motivo sigue saliendo.
const ningunaSirve = seleccionaVentana([
  { date: '2026-07-01', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-07-05', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-07-10', strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 },
], '2026-07-15');
ok(ningunaSirve.motivo === 'ventana_fuera_de_rango' && ningunaSirve.candidatas === 2,
  'si ninguna sirve, el motivo sale igual y dice cuántas candidatas había', JSON.stringify(ningunaSirve));

console.log('el p-valor, contra valores de TABLA');

ok(Math.abs(erf(1) - 0.842701) < 1e-5, 'erf(1) = 0.842701', erf(1));
ok(Math.abs(erf(0.5) - 0.520500) < 1e-5, 'erf(0.5) = 0.520500', erf(0.5));
ok(Math.abs(erf(-1) + 0.842701) < 1e-5, 'erf es impar: erf(−1) = −erf(1)');
const P = (z) => 2 * (1 - normalCDF(Math.abs(z)));
ok(Math.abs(P(1.96) - 0.05) < 1e-3, 'p(z=1.96) = 0.050 — EL valor del umbral del veredicto', P(1.96).toFixed(5));
ok(Math.abs(P(1.645) - 0.10) < 1e-3, 'p(z=1.645) = 0.100', P(1.645).toFixed(5));
ok(Math.abs(P(2.576) - 0.01) < 1e-3, 'p(z=2.576) = 0.010', P(2.576).toFixed(5));
ok(Math.abs(P(0) - 1) < 1e-6, 'p(z=0) = 1');

console.log('el test de proporciones');

// 80/100 contra 60/100: z ≈ 3.086, p ≈ 0.002
const t1 = testProporciones(80, 100, 60, 100);
ok(Math.abs(t1.diferencia - 0.2) < 1e-12, 'la diferencia es p1 − p2', t1.diferencia);
ok(Math.abs(t1.z - 3.086) < 0.01, 'z con varianza AGRUPADA ≈ 3.086', t1.z.toFixed(3));
ok(t1.p_valor < 0.01, 'y el p-valor a dos colas queda bajo 0.01', t1.p_valor.toFixed(4));
const iguales = testProporciones(50, 100, 50, 100);
ok(iguales.z === 0 && Math.abs(iguales.p_valor - 1) < 1e-6, 'tasas iguales: z = 0, p = 1');
const sinVar = testProporciones(100, 100, 100, 100);
ok(sinVar.p_valor === 1 && sinVar.motivo === 'sin_varianza',
  'las dos tasas al 100%: p = 1 y se dice por qué — un 0 sería una mentira aritmética');
ok(testProporciones(1, 0, 1, 10).p_valor === null, 'un grupo vacío no produce p-valor');
// SIMETRÍA: el p-valor no puede depender del orden de los grupos.
const ab = testProporciones(80, 100, 60, 100), ba = testProporciones(60, 100, 80, 100);
ok(Math.abs(ab.p_valor - ba.p_valor) < 1e-12 && Math.abs(ab.z + ba.z) < 1e-12,
  'dar vuelta los grupos cambia el signo de z pero NO el p-valor (es a dos colas)');

console.log('terciles: los empates no se parten');

const tt = terciles([1, 2, 3, 4, 5, 6, 7, 8, 9]);
ok(tt.cortes.length === 2, 'dos cortes para tres terciles', JSON.stringify(tt.cortes));
ok(tercilDe(1, tt.cortes) === 0 && tercilDe(9, tt.cortes) === 2, 'el más bajo al tercil 0, el más alto al 2');
// Nueve valores idénticos: todos al MISMO tercil. Es lo correcto — no se puede
// separar lo que no difiere — y por eso el n real de cada tercil se publica.
const empatados = terciles([5, 5, 5, 5, 5, 5, 5, 5, 5]);
const asignados = [5, 5, 5, 5, 5, 5, 5, 5, 5].map((x) => tercilDe(x, empatados.cortes));
ok(new Set(asignados).size === 1, 'nueve deltas idénticos caen TODOS en el mismo tercil, no se reparten');
ok(terciles([1, 2]).insuficiente === true, 'con menos valores que terciles se dice insuficiente');
ok(NOMBRE_TERCIL[0] === 'enfriamiento' && NOMBRE_TERCIL[2] === 'calentamiento',
  'el tercil de abajo es el que se ENFRIÓ (delta negativo)');

console.log('normalizaGrades: la forma cruda de FMP');

const norm = normalizaGrades([
  { date: '2025-12-31', analystRatingsStrongBuy: 6, analystRatingsBuy: 20, analystRatingsHold: 4, analystRatingsSell: 1, analystRatingsStrongSell: 0 },
  { date: '2026-09-30', strongBuy: 1, buy: 10, hold: 12, sell: 3, strongSell: 1 },
  { date: 'no-es-fecha', strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0 },
  { date: '2026-08-31', strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
]);
ok(norm.filas.length === 2, 'acepta los DOS nombres de campo de FMP y descarta lo ilegible', norm.filas.length);
ok(norm.filas[0].date === '2025-12-31', 'ordena más viejo primero');
ok(norm.filas[0].strongBuy === 6 && norm.filas[0].buy === 20, 'lee analystRatingsStrongBuy/Buy', JSON.stringify(norm.filas[0]));
ok(norm.filas[1].strongBuy === 1 && norm.filas[1].hold === 12, 'y también strongBuy/hold planos');
ok(norm.descartes.sin_fecha === 1 && norm.descartes.sin_conteos === 1,
  'los descartes se CUENTAN por motivo, no desaparecen', JSON.stringify(norm.descartes));
// El caso NKE del encargo: el enfriamiento existe en la serie.
const nke = seleccionaVentana([
  { date: '2026-03-31', strongBuy: 6, buy: 20, hold: 4, sell: 0, strongSell: 0 },
  { date: '2026-04-30', strongBuy: 4, buy: 18, hold: 7, sell: 1, strongSell: 0 },
  { date: '2026-05-31', strongBuy: 2, buy: 14, hold: 11, sell: 2, strongSell: 0 },
  { date: '2026-06-30', strongBuy: 1, buy: 10, hold: 12, sell: 3, strongSell: 1 },
], '2026-07-10');
ok(nke.ok && nke.delta < 0, 'el patrón de NKE (6+20 → 1+10) se lee como enfriamiento', nke.delta.toFixed(3));

console.log('el veredicto: los candados van ANTES de los números');

// Constructor de eventos con delta PLANTADO y una serie mensual real.
// El delta sale con DISPERSIÓN, no con dos valores: una distribución de dos
// puntos degenera los terciles (los cortes caen sobre los propios valores y el
// tercil de abajo queda vacío), y el dato real es continuo. El caso degenerado
// se prueba aparte, más abajo.
//
// OJO con cómo se genera: con buy = base − sb el score queda (25 + sb)/25, así
// que un desplazamiento igual en T-3 y T-1 se CANCELA en el delta. La primera
// versión de este fixture hacía eso y seguía teniendo dos deltas. Lo que tiene
// que variar es el TAMAÑO del salto, no el nivel.
function evento(i, { deltaPlantado, beat }) {
  const rep = `2026-07-${String((i % 27) + 1).padStart(2, '0')}`;
  const base = 25;
  const salto = 2 + (i % 9);           // 2..10 → nueve magnitudes de delta
  const sbT3 = deltaPlantado < 0 ? salto : 0;
  const sbT1 = deltaPlantado < 0 ? 0 : salto;
  return {
    symbol: 'S' + (i % 40), report_date: rep, beat,
    grades: [
      { date: '2026-04-10', strongBuy: sbT3, buy: base - sbT3, hold: 0, sell: 0, strongSell: 0 },
      { date: '2026-05-10', strongBuy: 5, buy: base - 5, hold: 0, sell: 0, strongSell: 0 },
      { date: '2026-06-20', strongBuy: sbT1, buy: base - sbT1, hold: 0, sell: 0, strongSell: 0 },
    ],
  };
}

// 60 eventos: por debajo del candado de 100.
const chico = Array.from({ length: 60 }, (_, i) => evento(i, { deltaPlantado: i % 2 ? -1 : 1, beat: i % 2 === 0 }));
const rc = analizaGrades(chico);
ok(rc.veredicto === 'INCONCLUSO', '60 eventos: INCONCLUSO, aunque la señal fuera perfecta', rc.veredicto);
ok(rc.comparacion === null && rc.terciles === null,
  'y NO se publica ni la diferencia ni los terciles: mirarlos y después decidir si alcanza es cómo se fabrica un hallazgo');
ok(rc.porque.some((p) => /INCONCLUSO no es NO-GO/.test(p)), 'se dice que INCONCLUSO no es NO-GO');

// 180 eventos SIN señal: el delta no dice nada del beat.
const sinSenal = Array.from({ length: 180 }, (_, i) => evento(i, { deltaPlantado: i % 2 ? -1 : 1, beat: i % 5 !== 0 }));
const rn = analizaGrades(sinSenal);
ok(rn.veredicto === 'NO-GO', 'sin señal: NO-GO', rn.veredicto);
ok(rn.comparacion.p_valor !== null && rn.comparacion.colas === 2, 'con su p-valor a dos colas publicado');
ok(rn.muestra.con_ventana_valida === 180, 'y los 180 eventos entraron', rn.muestra.con_ventana_valida);

// 180 eventos con señal PLANTADA: los que se enfriaron fallan mucho más.
const conSenal = Array.from({ length: 180 }, (_, i) => {
  const frio = i % 2 === 1;
  // el frío supera ~20% de las veces; el caliente, ~95%.
  const beat = frio ? (i % 5 === 0) : (i % 20 !== 0);
  return evento(i, { deltaPlantado: frio ? -1 : 1, beat });
});
const rg = analizaGrades(conSenal);
ok(rg.veredicto === 'GO', 'con señal plantada y muestra suficiente: GO', `${rg.veredicto} · ${JSON.stringify(rg.comparacion)}`);
ok(Math.abs(rg.comparacion.diferencia_pp) >= 10, 'la diferencia pasa los 10 pp', rg.comparacion.diferencia_pp);
ok(rg.comparacion.p_valor < 0.05, 'y el p-valor pasa el umbral', rg.comparacion.p_valor);
ok(rg.comparacion.diferencia_pp > 0 && /CALENTÓ/.test(rg.comparacion.direccion),
  'la DIRECCIÓN se dice en letras, no se deduce del signo', rg.comparacion.direccion);
ok(rg.terciles.every((t) => t.n >= 30), 'los tres terciles con al menos 30', rg.terciles.map((t) => t.n).join('/'));
ok(rg.terciles[0].nombre === 'enfriamiento' && rg.terciles[0].delta_max <= rg.terciles[2].delta_min,
  'el tercil de enfriamiento tiene los deltas más bajos');

console.log('el baseline obligatorio y los descartes');

ok(rg.muestra.tasa_base_universo === 0.8182, 'la tasa base del universo viaja con el resultado');
ok(rg.muestra.tasa_beats_en_muestra !== null, 'y la tasa observada EN LA MUESTRA al lado, para poder compararlas');
ok(rg.porque.some((p) => /tasa base del universo es 0\.8182/.test(p)),
  'el porqué nombra el baseline explícitamente');
// Eventos que no se pueden usar: se cuentan por motivo.
const conBasura = [...conSenal, { symbol: 'X', report_date: '2026-07-01', beat: true, grades: [] }];
const rb = analizaGrades(conBasura);
ok(rb.muestra.descartes.menos_de_3_meses === 1, 'un evento sin grades se descarta CONTADO', JSON.stringify(rb.muestra.descartes));
ok(rb.muestra.eventos_de_entrada === 181 && rb.muestra.con_ventana_valida === 180,
  'y los dos conteos van: cuántos entraron y cuántos sobrevivieron');

console.log('NO-GO por tamaño de tercil se distingue de NO-GO por falta de señal');

// 120 eventos repartidos en tres deltas con TAMAÑOS desparejos: 20 en el más
// bajo, 60 en el medio, 40 arriba. El tercil de enfriamiento queda con 20 — no
// vacío, pero por debajo del mínimo de 30.
function eventoConDelta(i, saltoT3, saltoT1, beat) {
  const base = 25;
  return { symbol: 'T' + i, report_date: '2026-07-15', beat, grades: [
    { date: '2026-04-10', strongBuy: saltoT3, buy: base - saltoT3, hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-05-10', strongBuy: 5, buy: base - 5, hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-06-20', strongBuy: saltoT1, buy: base - saltoT1, hold: 0, sell: 0, strongSell: 0 },
  ] };
}
const tercilChico = [
  ...Array.from({ length: 20 }, (_, i) => eventoConDelta(i, 10, 0, i % 5 !== 0)),
  ...Array.from({ length: 60 }, (_, i) => eventoConDelta(100 + i, 3, 0, i % 5 !== 0)),
  ...Array.from({ length: 40 }, (_, i) => eventoConDelta(200 + i, 0, 8, i % 5 !== 0)),
];
const rt = analizaGrades(tercilChico);
ok(rt.terciles && rt.terciles[0].n === 20 && rt.terciles[2].n === 40,
  'el tercil de enfriamiento queda con 20 (no vacío, pero corto)', rt.terciles ? rt.terciles.map((x) => x.n).join('/') : 'null');
ok(rt.veredicto === 'NO-GO', 'con un tercil extremo chico el criterio pre-registrado dice NO-GO', rt.veredicto);
ok(rt.porque.some((p) => /NO-GO por TAMAÑO de tercil/.test(p)),
  'pero se dice que eso es falta de evidencia, no evidencia de que no haya nada');
ok(rt.terciles.some((t) => t.muestra_insuficiente), 'y el tercil chico va marcado');

console.log('un tercil VACÍO no puede producir un NO-GO hecho de nulls');

// 150 eventos con SOLO DOS deltas distintos: los cortes caen sobre esos valores
// y, con asignación por `<` estricto, el tercil de abajo queda vacío. Antes eso
// llegaba al test de proporciones con n = 0, devolvía p-valor null y el
// veredicto salía NO-GO. Un NO-GO hecho de nulls es peor que no contestar.
function eventoPlano(i, frio, beat) {
  const base = 25, sb = frio ? 10 : 0;
  return { symbol: 'P' + i, report_date: '2026-07-15', beat, grades: [
    { date: '2026-04-10', strongBuy: frio ? 10 : 0, buy: base - (frio ? 10 : 0), hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-05-10', strongBuy: 5, buy: base - 5, hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-06-20', strongBuy: frio ? 0 : 10, buy: base - (frio ? 0 : 10), hold: 0, sell: 0, strongSell: 0 },
  ] };
}
const dosValores = Array.from({ length: 150 }, (_, i) => eventoPlano(i, i % 2 === 0, i % 3 !== 0));
const rv = analizaGrades(dosValores);
ok(rv.veredicto === 'INCONCLUSO', 'con dos deltas nada más el veredicto es INCONCLUSO, no NO-GO', rv.veredicto);
ok(rv.comparacion === null, 'y no se publica una comparación entre un grupo y la nada');
ok(/2 valor\(es\) distinto/.test(rv.porque[0]), 'el motivo nombra cuántos valores distintos había', rv.porque[0]);

// El caso que el primer candado NO agarra: TRES deltas distintos, pero la mitad
// de los eventos empatados en el MÁS BAJO. El corte de abajo cae sobre ese valor
// y, como la asignación es por `<` estricto, el tercil de enfriamiento queda
// vacío. Sin el chequeo, el test de proporciones recibía n = 0 y el veredicto
// salía NO-GO con p-valor null.
function eventoDelta(i, salto, beat) {
  const base = 25;
  return { symbol: 'D' + i, report_date: '2026-07-15', beat, grades: [
    { date: '2026-04-10', strongBuy: salto, buy: base - salto, hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-05-10', strongBuy: 5, buy: base - 5, hold: 0, sell: 0, strongSell: 0 },
    { date: '2026-06-20', strongBuy: 0, buy: base, hold: 0, sell: 0, strongSell: 0 },
  ] };
}
const apilados = [
  ...Array.from({ length: 60 }, (_, i) => eventoDelta(i, 9, i % 3 !== 0)),        // delta más bajo
  ...Array.from({ length: 30 }, (_, i) => eventoDelta(100 + i, 5, i % 3 !== 0)),
  ...Array.from({ length: 30 }, (_, i) => eventoDelta(200 + i, 1, i % 3 !== 0)),
];
const ra = analizaGrades(apilados);
ok(new Set(apilados.map((e) => e.grades[0].strongBuy)).size === 3, 'el fixture tiene tres deltas distintos');
ok(ra.veredicto === 'INCONCLUSO', 'con un tercil extremo VACÍO el veredicto es INCONCLUSO, no NO-GO', ra.veredicto);
ok(ra.comparacion === null && ra.terciles === null, 'y no se publica comparación');
ok(ra.porque.some((p) => /VACÍO/.test(p)) && ra.porque.some((p) => /ni a favor ni en contra/.test(p)),
  'diciendo que no hay dos grupos que comparar', JSON.stringify(ra.porque));
// Y el caso extremo: todos los deltas iguales.
const todosIguales = Array.from({ length: 120 }, (_, i) => eventoPlano(i, true, i % 4 !== 0));
const ri = analizaGrades(todosIguales);
ok(ri.veredicto === 'INCONCLUSO' && /1 valor\(es\) distinto/.test(ri.porque[0]),
  'todos los deltas iguales: INCONCLUSO por la forma de la distribución', ri.porque[0]);

console.log('la advertencia va SIEMPRE');

for (const [nombre, r] of Object.entries({ INCONCLUSO: rc, 'NO-GO': rn, GO: rg })) {
  ok(/INFORMACIÓN PÚBLICA/.test(r.advertencia), `"${nombre}": la advertencia va igual`);
  ok(/no implica ventaja contra Polymarket/i.test(r.advertencia), `"${nombre}": y nombra que no implica ventaja`);
}
ok(/NO-GO \(Fase 2 del earnings-beat\)/.test(ADVERTENCIA),
  'citando el veredicto que ya se corrió, no en abstracto');
ok(/feature descriptivo, no una señal de apuesta/.test(ADVERTENCIA), 'y que sería un feature descriptivo');

console.log('determinismo y markdown');

const a1 = analizaGrades(conSenal), a2 = analizaGrades(conSenal);
ok(JSON.stringify(a1.comparacion) === JSON.stringify(a2.comparacion), 'dos corridas, el mismo resultado');
const md = renderGradesMd({ ...rg, generado_en: 'x' });
ok(/VEREDICTO: GO/.test(md), 'el veredicto va arriba');
ok(/INFORMACIÓN PÚBLICA/.test(md), 'la advertencia también');
ok(/p-valor a DOS colas/.test(md) && /duplicaría la significancia/.test(md),
  'y se explica por qué el p-valor es a dos colas');
ok(/tasa base del universo = 0\.8182/.test(md), 'el baseline está en la tabla de criterios');
ok(/pre-registro está en `docs\/grades-backtest-scope\.md`/.test(md), 'el markdown apunta al pre-registro');
ok(/no se auto-aprueba/.test(md), 'y dice que el veredicto lo lee una persona');
ok(typeof renderGradesMd({ veredicto: 'INCONCLUSO', porque: [], muestra: {}, advertencia: 'x' }) === 'string',
  'un análisis a medias no rompe el render');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
