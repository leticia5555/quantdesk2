// ═══════════════════════════════════════════════════════════════
// Tests de la VISTA EN VIVO de earnings-beat. JS puro, sin red ni DB:
//   - estadisticasHistoricas: conteo, racha, sorpresa, últimos trimestres
//   - LINT de honestidad: el histórico NUNCA se pinta como probabilidad, y
//     QuantDesk no emite una propia hasta que la Fase 2 la valide
//
// El lint es lo importante. El riesgo real de esta pantalla no es un bug de
// render: es que alguien, con buena intención, convierta "superó 26 de 32
// (81%)" en "81% de probabilidad" — que es el mismo número diciendo algo que
// nadie validó. Un comentario pidiendo que no se haga se ignora; un test que
// falla, no.
// Correr con `node tests/earnings-beat-live.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { estadisticasHistoricas, sorpresaPct, escalaDelEstimado, PISO_ESCALA, CRITERIOS } from '../api/_lib/earnings-beat.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('estadisticasHistoricas: un CONTEO, no una probabilidad');

const q = (fecha, rep, est, sp) => ({ reported_date: fecha, reported_eps: rep, estimated_eps: est, surprise_pct: sp });
const base = estadisticasHistoricas([
  q('2026-06-25', 1.20, 1.10, 9.1), q('2026-03-25', 1.05, 1.00, 5.0),
  q('2025-12-20', 0.80, 0.90, -11.1), q('2025-09-20', 1.00, 0.95, 5.3),
]);
ok(base.ventana.total === 4 && base.ventana.beats === 3 && base.ventana.pct === 75,
  'cuenta beats sobre trimestres comparables', `${base.ventana.beats}/${base.ventana.total}=${base.ventana.pct}%`);
ok(base.racha.tipo === 'beats' && base.racha.largo === 2, 'racha actual: tipo Y largo', JSON.stringify(base.racha));
ok(base.ultimos.length === 4 && base.ultimos[0].fecha === '2026-06-25', 'últimos trimestres, más reciente primero');
ok(base.ultimos[0].beat === true && base.ultimos[2].beat === false, 'cada trimestre marcado ✓/✗');

const empate = estadisticasHistoricas([q('2026-06-25', 1.00, 1.00, 0)]);
ok(empate.ventana.beats === 0, 'un empate NO es un beat (reportado > estimado, estricto)', empate.ventana.beats);
const frontera = estadisticasHistoricas([q('2026-06-25', 1.005, 1.00, 0.5)]);
ok(frontera.ventana.beats === 1 && frontera.frontera === 1,
  'un beat de menos de un centavo cuenta pero se marca frontera', frontera.frontera);
ok(CRITERIOS.frontera_eps === 0.01, 'y la frontera es la misma constante congelada del scope');

const incompletos = estadisticasHistoricas([q('2026-06-25', 1.2, null, null), q('2026-03-25', 1.1, 1.0, 10)]);
ok(incompletos.ventana.total === 1, 'un trimestre sin estimado no puede decir si superó: no se cuenta', incompletos.ventana.total);
const vacio = estadisticasHistoricas([]);
ok(vacio.sin_datos === true && vacio.ventana === null && typeof vacio.motivo === 'string',
  'sin datos → lo dice con motivo, no inventa un 0%');
ok(estadisticasHistoricas(null).sin_datos === true, 'null → no crashea');

console.log('SIGNO con estimados NEGATIVOS (los dos casos reales de MU)');

// pead_earnings hereda el % de Alpha Vantage cuando AV lo trae, y solo lo
// recalcula con |estimado| cuando AV lo deja nulo. O sea: la convención de
// signo de AV nunca se verificó. Por eso el número que se MUESTRA se calcula
// acá — y acá se testea, con los dos trimestres reales que aparecieron en el
// diag de MU. Si el denominador dejara de estar en valor absoluto, un miss
// contra una pérdida esperada se vería como beat.
ok(sorpresaPct(-1.91, -0.88) < 0,
  'est −0.88 → −1.91 da NEGATIVO (reportó peor que la pérdida esperada)', sorpresaPct(-1.91, -0.88).toFixed(2));
ok(sorpresaPct(0.42, -0.25) > 0,
  'est −0.25 → 0.42 da POSITIVO (esperaban pérdida y ganó)', sorpresaPct(0.42, -0.25).toFixed(2));
ok(Math.abs(sorpresaPct(-1.91, -0.88) + 117.05) < 0.01, 'y la magnitud es (rep−est)/|est|', sorpresaPct(-1.91, -0.88));
ok(sorpresaPct(0.80, 1.00) < 0 && sorpresaPct(1.20, 1.00) > 0, 'con estimados positivos, los signos de siempre');
ok(sorpresaPct(0.10, 0) === null, 'estimado cero → null, no Infinity');
ok(sorpresaPct(null, 1) === null && sorpresaPct(1, null) === null, 'cifras faltantes → null');

// El conteo de beats NO usa el porcentaje: sale de comparar las dos cifras.
// Por eso un lío de signos en la fuente no puede contaminar el titular.
const negs = estadisticasHistoricas([
  { reported_date: '2026-06-25', reported_eps: -1.91, estimated_eps: -0.88, surprise_pct: -117 },
  { reported_date: '2026-03-25', reported_eps: 0.42, estimated_eps: -0.25, surprise_pct: 268 },
]);
ok(negs.ventana.beats === 1, 'reportar −1.91 contra −0.88 NO es un beat; 0.42 contra −0.25 SÍ', negs.ventana.beats);
ok(negs.sorpresa.estimado_no_positivo === 2, 'cuenta los trimestres con estimado cero o negativo', negs.sorpresa.estimado_no_positivo);

// Si AV mandara el signo al revés, se detecta en vez de heredarse en silencio.
const discrepa = estadisticasHistoricas([
  { reported_date: '2026-06-25', reported_eps: -1.91, estimated_eps: -0.88, surprise_pct: +117 },
]);
ok(discrepa.sorpresa.signo_discrepante === 1,
  'un signo al revés en la tabla se CUENTA (no se hereda callado)', discrepa.sorpresa.signo_discrepante);
ok(discrepa.sorpresa.mediana_pct < 0, 'y lo que se muestra es el nuestro, no el de la tabla', discrepa.sorpresa.mediana_pct);

console.log('CICATRIZ MU: lo que arregló el número fue la VENTANA, no la mediana');

// El diag en producción desmintió el primer diagnóstico: MU dio
// distorsionado:false y UN solo denominador chico. Sus extremos son
// trimestres de PÉRDIDA reales — es cíclica. Este test fija esa distinción:
// colas reales y artefacto de denominador se reportan DISTINTO.
const ciclica = [];
for (let i = 0; i < 20; i++) ciclica.push({ reported_date: `2026-${String(12 - (i % 12)).padStart(2, '0')}-15`.replace('2026', String(2026 - Math.floor(i / 4))), reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9.1 });
// …y la bajada del ciclo, fuera de la ventana de 5 años:
for (let i = 0; i < 12; i++) ciclica.push({ reported_date: `20${18 + Math.floor(i / 4)}-0${(i % 4) * 2 + 1}-15`, reported_eps: -1.91, estimated_eps: -0.88, surprise_pct: -117 });
const rc = estadisticasHistoricas(ciclica);
ok(rc.ventana.pct === 100 && rc.completo.pct < 70,
  'la ventana de 5 años y el historial completo difieren DE VERDAD en una cíclica', `${rc.ventana.pct}% vs ${rc.completo.pct}%`);
ok(rc.sorpresa.denominador_chico === 0, 'y sin un solo denominador chico: las colas son reales', rc.sorpresa.denominador_chico);

// Cuando la distorsión SÍ viene de denominadores, se dice que viene de ahí.
const artefacto = estadisticasHistoricas([
  ...Array.from({ length: 10 }, (_, i) => ({ reported_date: `2026-0${(i % 9) + 1}-15`, reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9.1 })),
  { reported_date: '2021-03-15', reported_eps: -0.29, estimated_eps: 0.01, surprise_pct: -3000 },
]);
ok(artefacto.sorpresa.distorsionado === true && artefacto.sorpresa.causa === 'artefacto_denominador',
  'distorsión por denominador chico → se nombra como artefacto', artefacto.sorpresa.causa);
const colas = estadisticasHistoricas([
  ...Array.from({ length: 10 }, (_, i) => ({ reported_date: `2026-0${(i % 9) + 1}-15`, reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9.1 })),
  { reported_date: '2021-03-15', reported_eps: -1.91, estimated_eps: -0.88, surprise_pct: -117 },
]);
ok(colas.sorpresa.distorsionado === true && colas.sorpresa.causa === 'colas_reales',
  'distorsión por colas reales → se nombra como tal, no como dato sucio', colas.sorpresa.causa);
ok(colas.sorpresa.extremos[0].estimado_no_positivo === true,
  'y el extremo muestra que el estimado era negativo, para poder leerlo bien');

console.log('CICATRIZ BA: la tarjeta NO puede afirmar una causa que el dato no dice');

// BA salió con distorsionado:true y denominador_chico:0, y la tarjeta imprimía
// "distorsionado por 0 trimestre(s) con estimado cerca de cero". Falso: su
// extremo es est 0.09 → −6.18 (737 MAX), un trimestre REAL. El mismo error que
// ya habíamos corregido en el endpoint, repetido por el texto de la UI.
const ba = estadisticasHistoricas([
  { reported_date: '2026-06-25', reported_eps: -6.18, estimated_eps: 0.09, surprise_pct: -6966 },
  ...Array.from({ length: 9 }, (_, i) => ({ reported_date: `2025-0${(i % 9) + 1}-15`, reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9 })),
]);
ok(ba.sorpresa.distorsionado === true && ba.sorpresa.denominador_chico === 0,
  'BA: distorsionado SIN denominadores chicos', `${ba.sorpresa.distorsionado}/${ba.sorpresa.denominador_chico}`);
ok(ba.sorpresa.causa === 'colas_reales', 'la causa es COLAS REALES, no artefacto', ba.sorpresa.causa);
ok(!/cerca de cero/.test(ba.sorpresa.causa_probable) && /REALES/.test(ba.sorpresa.causa_probable),
  'y la prosa no menciona estimados cerca de cero cuando no los hay', ba.sorpresa.causa_probable);

const conChicos = estadisticasHistoricas([
  { reported_date: '2026-06-25', reported_eps: -0.29, estimated_eps: 0.01, surprise_pct: -3000 },
  ...Array.from({ length: 9 }, (_, i) => ({ reported_date: `2025-0${(i % 9) + 1}-15`, reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9 })),
]);
ok(conChicos.sorpresa.causa === 'artefacto_denominador', 'y cuando SÍ hay denominador de centavos, la causa cambia', conChicos.sorpresa.causa);
ok(/centavos/.test(conChicos.sorpresa.causa_probable), 'con su prosa propia');
ok(ba.sorpresa.causa !== conChicos.sorpresa.causa,
  'LAS DOS CAUSAS NO COMPARTEN TEXTO — mismo texto para las dos es lo que nos tuvo equivocados dos vueltas');

console.log('ESCALA del estimado: la fragilidad que `frontera` no ve');

// INTC: estimados de un centavo. Un beat de $0.28 es +2800% y NO es "frontera"
// (que mide ≤$0.01 en dólares absolutos), pero esa racha es frágil igual.
const intc = escalaDelEstimado([
  { reported_date: '2026-06-25', estimated_eps: 0.01 }, { reported_date: '2026-03-25', estimated_eps: 0.02 },
  { reported_date: '2025-12-20', estimated_eps: 0.01 }, { reported_date: '2025-09-20', estimated_eps: 0.05 },
]);
ok(intc.escala_chica === true && intc.estimado_mediano === 0.015, 'INTC queda marcado por escala', intc.estimado_mediano);
const aapl = escalaDelEstimado([
  { reported_date: '2026-06-25', estimated_eps: 1.42 }, { reported_date: '2026-03-25', estimated_eps: 1.51 },
]);
ok(aapl.escala_chica === false, 'AAPL no', aapl.estimado_mediano);
ok(escalaDelEstimado([{ reported_date: '2026-06-25', estimated_eps: -0.30 }]).escala_chica === false,
  'usa el VALOR ABSOLUTO: un estimado de −$0.30 no es de escala chica');
ok(escalaDelEstimado([]).estimado_mediano === null && escalaDelEstimado(null).escala_chica === false,
  'sin datos → null, no crashea');
ok(escalaDelEstimado([
  { reported_date: '2026-06-25', estimated_eps: 0.01 }, { reported_date: '2020-06-25', estimated_eps: 5.00 },
  { reported_date: '2019-06-25', estimated_eps: 5.00 }, { reported_date: '2018-06-25', estimated_eps: 5.00 },
  { reported_date: '2017-06-25', estimated_eps: 5.00 },
], { n: 1 }).escala_chica === true, 'mira los ÚLTIMOS trimestres, no la historia entera');
ok(PISO_ESCALA === 0.20, 'el piso propuesto es $0.20 y está en una constante, no suelto en el código');

console.log('CONTEOS: por qué filas_en_tabla y completo.total no cuadran');

const conHuecos = estadisticasHistoricas([
  { reported_date: '2026-06-25', reported_eps: 1.2, estimated_eps: 1.1, surprise_pct: 9 },
  { reported_date: '2026-03-25', reported_eps: 1.1, estimated_eps: null, surprise_pct: null },
  { reported_date: '2025-12-20', reported_eps: null, estimated_eps: 1.0, surprise_pct: null },
]);
ok(conHuecos.filas_en_tabla === 3 && conHuecos.completo.total === 1,
  'filas en tabla ≠ trimestres comparables', `${conHuecos.filas_en_tabla} vs ${conHuecos.completo.total}`);
ok(conHuecos.descartados_sin_cifras === 2,
  'la diferencia se publica: son los trimestres sin estimado o sin reportado (AV no siempre los da)',
  conHuecos.descartados_sin_cifras);

console.log('VENTANA: 5 años manda, el historial completo acompaña');

const largo = [];
for (let i = 0; i < 121; i++) largo.push(q(`${2026 - Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, '0')}-15`, i < 20 ? 1.2 : 0.9, 1.0, i < 20 ? 20 : -10));
const rL = estadisticasHistoricas(largo);
ok(rL.ventana.total === 20 && rL.ventana.trimestres === 20, 'el titular mira 20 trimestres, no 121', rL.ventana.total);
ok(rL.ventana.anios === 5, 'y lo dice en años para que se lea', rL.ventana.anios);
ok(rL.completo.total === 121, 'el historial completo sigue disponible como secundario', rL.completo.total);
ok(rL.ventana.pct === 100 && rL.completo.pct < 30, 'los dos números pueden diferir mucho — por eso se muestran los dos');
ok(rL.ultimos.length === 8, 'la lista visible sigue siendo de 8 trimestres');

// Punto 3 del reporte: la racha tiene que salir de los MISMOS datos del titular.
ok(rL.racha.sobre === 'ventana', 'la racha se calcula sobre la ventana del titular, no sobre 30 años');
ok(rL.racha.largo === 20 && rL.racha.tope === true,
  'si toda la ventana es del mismo signo, se marca `tope`: la racha puede ser más larga, pero afirmarlo sería inventar el trimestre 21',
  `${rL.racha.largo}/${rL.racha.tope}`);
const medianos = estadisticasHistoricas(largo).sorpresa.mediana_pct;
ok(medianos === 20, 'la sorpresa también sale de la ventana (si no, la tarjeta se contradice)', medianos);

console.log('LINT de honestidad sobre el código real');

const app = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api/earnings-beat.js', import.meta.url), 'utf8');

// La tarjeta se recorta del archivo real: lo que se testea es lo que se sirve.
const iCard = app.indexOf('function ebLiveCard(');
ok(iCard > 0, 'la tarjeta existe en app.html');
const card = app.slice(iCard, app.indexOf('\nfunction ebDiasHasta', iCard));

ok(card.includes("'Histórico: superó '"), 'la etiqueta es EXACTAMENTE "Histórico: superó N de M (P%)"');
ok(card.includes("'Track record: beat '"), 'y su par en inglés');
ok(card.includes("'Polymarket hoy: '") || card.includes("'Polymarket hoy: '+"), 'la etiqueta del mercado es "Polymarket hoy: N%"');
ok(/fuente/.test(card) && /source/.test(card), 'la fuente se cita en las dos lenguas');

// LA REGLA: el histórico no se pinta como probabilidad. Se prohíben las formas
// que lo dirían, no una cadena puntual — para que renombrar no la esquive.
// La NEGACIÓN de un pronóstico ("no es predicción" / "is not a forecast") es
// justamente lo que queremos que esté. Se aparta antes de buscar afirmaciones,
// y se comprueba por separado que siga ahí — si no, el lint se volvería
// trivial de pasar borrando el aviso.
const lineasAviso = card.split('\n').filter((l) => /no es predicci|not a forecast/i.test(l));
ok(lineasAviso.length > 0, 'la tarjeta lleva su propia nota "no es predicción" (sobrevive a un recorte de pantalla)');
const cardSinAvisos = card.split('\n').filter((l) => !/no es predicci|not a forecast/i.test(l)).join('\n');

const PROHIBIDO = [
  { nombre: 'probabilidad del histórico', re: /probabilidad[^']{0,20}'\s*\+\s*(h|v|comp|sp)\./i },
  { nombre: 'probability del histórico', re: /probability[^']{0,20}'\s*\+\s*(h|v|comp|sp)\./i },
  { nombre: 'chance/odds del histórico', re: /(chance|odds)[^']{0,20}'\s*\+\s*(h|v|comp|sp)\./i },
  { nombre: 'el número presentado como pronóstico', re: /(predice|pronóstico|forecast|expected probability|probabilidad de que)/i },
];
for (const p of PROHIBIDO) {
  ok(!p.re.test(cardSinAvisos), `la tarjeta NO dice ${p.nombre}`, p.re.exec(cardSinAvisos) && p.re.exec(cardSinAvisos)[0]);
}
ok(!/probabilidad_quantdesk\s*\|\||probabilidad_quantdesk\s*\?/.test(card),
  'la tarjeta no intenta pintar una probabilidad de QuantDesk (todavía no existe)');

// CICATRIZ MU, pineada: el titular de sorpresa NO puede volver a ser el promedio.
ok(/Sorpresa mediana: /.test(card) && /Median surprise: /.test(card),
  'la sorpresa se titula como MEDIANA en las dos lenguas');
ok(!/'Sorpresa promedio: '|'Average surprise: '/.test(card),
  'y NADIE volvió a poner el promedio de titular (fue el "-26.06%" de MU)');
ok(/sp\.distorsionado/.test(card), 'cuando promedio y mediana divergen, la tarjeta lo dice');
// CICATRIZ BA pineada: la tarjeta elige el texto por `causa`, no lo afirma.
ok(/sp\.causa\s*===\s*'artefacto_denominador'/.test(card),
  'la tarjeta elige el texto de la causa por CÓDIGO (sp.causa), no lo arma sola');
ok(!/distorsionado por '\+sp\.denominador_chico\+' trimestre\(s\) con estimado cerca de cero/.test(card),
  'y NADIE volvió a hardcodear "estimado cerca de cero" (el bug de BA)');
const lineasCausa = card.split('\n')
  .filter((l) => !/^\s*\/\//.test(l))   // los comentarios explican el bug: no son texto de pantalla
  .filter((l) => /cerca de cero|near-zero|pennies-sized|de centavos/i.test(l));
ok(lineasCausa.every((l) => /artefacto_denominador|denominador_chico/.test(l)),
  'toda mención a estimados de centavos vive dentro de la rama del artefacto', lineasCausa.length);
ok(/v\.beats\+' de '\+v\.total|v\.beats\+' of '\+v\.total/.test(card),
  'el titular sale de la VENTANA (v), no del historial completo');
ok(/completo/.test(card) && /full history/.test(card),
  'y el historial completo aparece como secundario, en las dos lenguas');

// El disclaimer bilingüe, obligatorio y con las dos lenguas.
const iDisc = app.indexOf('function ebLiveDisclaimer(');
const disc = app.slice(iDisc, app.indexOf('\nfunction ebLiveAviso', iDisc));
ok(/no una predicción/.test(disc) && /not a forecast/.test(disc), 'el disclaimer va en español Y en inglés');
ok(/en validación/.test(disc) && /being validated/.test(disc), 'y dice que QuantDesk está en validación, en las dos');
ok(/const primero=smL\(es,en\), segundo=smL\(en,es\)/.test(disc), 'se pintan las DOS lenguas, no solo la activa');

// El endpoint: la ausencia de probabilidad propia es explícita, no un olvido.
ok(/probabilidad_quantdesk: null/.test(api), 'el endpoint devuelve probabilidad_quantdesk: null, explícito');
ok(/probabilidad_quantdesk_estado/.test(api), 'con su estado escrito al lado');
ok(!/probabilidad_quantdesk:\s*(?!null)[a-z0-9_.]/i.test(api), 'y NADIE le asignó un número');

// El estado vacío no puede ser un error disfrazado (ni al revés).
ok(/d && d\.error/.test(app.slice(app.indexOf('function renderEbLive('), app.indexOf('function ebLiveCard('))),
  'un error se pinta como error, no como "no hay mercados"');
ok(/vacio\.motivo/.test(app), 'el estado vacío muestra el MOTIVO que dio el endpoint');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
