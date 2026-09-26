// ═══════════════════════════════════════════════════════════════
// Tests de `evaluaDesacuerdo` — la tarjeta de DESACUERDO.
//
// Lo que defienden, en orden de cuánto daño evita cada uno:
//
//   1. Un hueco grande NO se lee como "el mercado sabe algo". La causa más
//      probable es que los dos números sean sobre preguntas distintas, y
//      cuanto más grande el hueco, más arriba va esa revisión.
//   2. La tasa histórica nunca se presenta como pronóstico. La frase que lo
//      dice viaja en TODOS los caminos, no solo en el bonito.
//   3. La ventana es la MISMA del titular de la tarjeta (20 trimestres): un
//      conteo "21 de 27" no puede salir de acá.
//   4. Una fecha ya pasada no produce tarjeta: eso es una fila rancia, no una
//      advertencia.
//   5. Muestra corta y consenso ausente cierran el dictamen antes de restar.
//
// Correr con `node tests/earnings-beat-desacuerdo.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  evaluaDesacuerdo, CRITERIOS_DESACUERDO, estadisticasHistoricas, VENTANA_TRIMESTRES,
} from '../api/_lib/earnings-beat.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('CRITERIOS_DESACUERDO congelados');

ok(CRITERIOS_DESACUERDO.ventana_trimestres === VENTANA_TRIMESTRES,
  'la ventana es LA MISMA del titular de la tarjeta', CRITERIOS_DESACUERDO.ventana_trimestres);
ok(CRITERIOS_DESACUERDO.min_trimestres === 12, 'mínimo 12 trimestres para dictaminar');
ok(CRITERIOS_DESACUERDO.gap_min_puntos === 25, 'por debajo de 25 puntos: coincide');
ok(CRITERIOS_DESACUERDO.gap_instrumento_primero_puntos === 50,
  'a 50 puntos o más, el instrumento se revisa PRIMERO');
ok(CRITERIOS_DESACUERDO.gap_instrumento_primero_puntos > CRITERIOS_DESACUERDO.gap_min_puntos,
  'y el umbral de "instrumento primero" está por encima del de "hay algo que mirar"');

// ── Un histórico armado a mano, con la forma que devuelve estadisticasHistoricas ──
const hist = ({ beats, total, estimados = [2.70, 2.68, 2.75, 2.72] }) => ({
  sin_datos: false,
  ventana: { trimestres: 20, beats, total, pct: Math.round((beats / total) * 100) },
  ultimos: estimados.map((e, i) => ({ fecha: `2026-0${i + 1}-15`, estimado: e, reportado: e + 0.05, beat: true })),
});

console.log('el caso de la tarjeta: precio 8%, histórico 78%');

// 21 de 27 da 78%, pero 27 NO es la ventana — ese conteo se prueba abajo.
// Acá se usa 15 de 20 (75%) contra un precio de 8%: hueco de 67 puntos.
const ibm = evaluaDesacuerdo({
  historico: hist({ beats: 15, total: 20 }),
  precio_mercado: 0.08,
  consenso_declarado: 2.75,
  fecha_reporte: '2026-10-22',
  hoy: '2026-09-25',
});
ok(ibm.clasificacion === 'desacuerdo', 'un hueco así es un desacuerdo', ibm.clasificacion);
ok(ibm.gap_puntos === -67, 'el hueco lleva SIGNO: negativo = el mercado por debajo', ibm.gap_puntos);
ok(ibm.tasa_historica_pct === 75 && ibm.precio_pct === 8, 'y los dos números que se restaron van a la vista');
ok(ibm.instrumento_primero === true, 'a 67 puntos, el instrumento va primero');
ok(ibm.donde_mirar[0].codigo === 'instrumento',
  'el PRIMER lugar donde mirar es si las dos cifras miden lo mismo', ibm.donde_mirar[0].codigo);
ok(/umbral por encima del consenso cotiza bajo con toda la razón/.test(ibm.donde_mirar[0].texto),
  'y explica el mecanismo concreto, no dice "verificar" a secas');
ok(ibm.donde_mirar.map((d) => d.codigo).join(',') === 'instrumento,revisiones,ocho_k,pares',
  'las otras tres pistas siguen ahí, debajo', ibm.donde_mirar.map((d) => d.codigo).join(','));
// La pantalla es bilingüe: cada pista viaja con CÓDIGO, así el front traduce
// sin volver a decidir la causa (la lección de la nota de sorpresa de BA).
ok(ibm.donde_mirar.every((d) => d.codigo && d.texto), 'cada pista lleva código Y texto');
ok(ibm.lectura_codigo === 'instrumento_primero', 'y la lectura también viaja como código', ibm.lectura_codigo);
ok(/No es señal de compra ni de venta/.test(ibm.no_es_senal), 'no es señal de compra ni de venta');

console.log('lo que la lectura NO puede afirmar');

// Ésta es la aserción central de todo el archivo. Decir "algo que el historial
// no contiene está moviendo el precio" afirma que el mercado está informado —
// y eso es exactamente lo que no se sabe hasta abrir el mercado.
ok(!/algo que el historial no contiene está moviendo/i.test(ibm.lectura),
  'la lectura NO afirma que el mercado sepa algo', ibm.lectura);
ok(/pregunta OTRA cosa/.test(ibm.lectura), 'nombra la causa que hay que descartar primero');

const medio = evaluaDesacuerdo({
  historico: hist({ beats: 15, total: 20 }),
  precio_mercado: 0.40, consenso_declarado: 2.75, fecha_reporte: '2026-10-22', hoy: '2026-09-25',
});
ok(medio.clasificacion === 'desacuerdo' && medio.instrumento_primero === false,
  'con 35 puntos de hueco el instrumento NO pasa primero', `${medio.gap_puntos}`);
ok(/Puede ser información que el historial no contiene, o que las dos cifras no midan lo mismo/.test(medio.lectura),
  'pero la lectura sigue nombrando LAS DOS causas, sin elegir una', medio.lectura);
ok(medio.donde_mirar[medio.donde_mirar.length - 1].codigo === 'instrumento',
  'y la revisión del instrumento queda abajo, no desaparece');
ok(medio.lectura_codigo === 'ambas_causas', 'con el código de "las dos causas"', medio.lectura_codigo);

console.log('la tasa histórica NUNCA es un pronóstico, en TODOS los caminos');

const caminos = {
  desacuerdo: ibm,
  coincide: evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.70, consenso_declarado: 2.75 }),
  sin_precio: evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: null }),
  sin_historial: evaluaDesacuerdo({ historico: null, precio_mercado: 0.08 }),
  muestra_corta: evaluaDesacuerdo({ historico: hist({ beats: 5, total: 6 }), precio_mercado: 0.08 }),
  fecha_pasada: evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.08, consenso_declarado: 2.75, fecha_reporte: '2026-07-22', hoy: '2026-09-25' }),
  sin_consenso: evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.08, consenso_declarado: null }),
};
for (const [nombre, r] of Object.entries(caminos)) {
  ok(/no un pronóstico de este trimestre/.test(r.la_tasa_no_es_pronostico || ''),
    `"${nombre}": la frase de que el conteo no es pronóstico va igual`);
}
for (const [nombre, r] of Object.entries(caminos)) {
  ok(!/probabilidad de que supere|probabilidad \d/i.test(JSON.stringify(r)),
    `"${nombre}": en ninguna parte se llama probabilidad a la tasa histórica`);
}
ok(/Fase 2: NO-GO/.test(ibm.la_tasa_no_es_pronostico),
  'y se dice que el pronóstico de QuantDesk no está validado');

console.log('coincidir NO es un hallazgo');

ok(caminos.coincide.clasificacion === 'coincide' && caminos.coincide.comparable === true,
  'un hueco de 5 puntos es coincidencia, no desacuerdo', `${caminos.coincide.gap_puntos}`);
ok(caminos.coincide.donde_mirar.length === 0, 'y no manda a mirar nada: no hay nada que mirar');
ok(caminos.coincide.lectura === undefined, 'ni inventa una lectura');

console.log('los cierres que van ANTES de restar');

// El bug que este test cerró: `Number(null)` es 0, así que un mercado sin
// consenso declarado pasaba como si declarara $0.00.
ok(evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.08, consenso_declarado: undefined }).motivo === 'sin_consenso_declarado',
  'undefined también cuenta como "no declara consenso", no como $0.00');
ok(evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.08, consenso_declarado: '' }).motivo === 'sin_consenso_declarado',
  'y una cadena vacía igual');

ok(caminos.muestra_corta.comparable === false && caminos.muestra_corta.motivo === 'muestra_corta',
  '6 trimestres no dictaminan, aunque el hueco sea de 70 puntos', caminos.muestra_corta.motivo);
ok(caminos.muestra_corta.gap_puntos === null, 'y no se publica un hueco que no se puede leer');
ok(caminos.fecha_pasada.comparable === false && caminos.fecha_pasada.motivo === 'fecha_pasada',
  'una fecha de reporte ya pasada no produce tarjeta: es una fila rancia', caminos.fecha_pasada.motivo);
ok(caminos.fecha_pasada.fecha_reporte === '2026-07-22' && caminos.fecha_pasada.hoy === '2026-09-25',
  'y dice qué fecha traía y contra qué día se comparó');
ok(caminos.sin_consenso.comparable === false && caminos.sin_consenso.motivo === 'sin_consenso_declarado',
  'sin consenso declarado no se sabe contra qué resuelve el mercado', caminos.sin_consenso.motivo);
ok(caminos.sin_consenso.donde_mirar[0].codigo === 'instrumento_sin_consenso'
  && /no declara un consenso/.test(caminos.sin_consenso.donde_mirar[0].texto),
  'y lo único que manda a hacer es abrir el mercado y leer la pregunta');
ok(caminos.sin_precio.motivo === 'sin_precio' && caminos.sin_historial.motivo === 'sin_historial',
  'sin precio o sin historial: cada ausencia con su nombre');

console.log('el umbral declarado contra el nivel reciente de EPS');

// Un mercado que pregunta por $3.60 cuando la empresa viene de estimados de
// ~$2.70 no está preguntando "¿superó el consenso?". El hueco puede ser de 30
// puntos y aun así el instrumento va primero.
const umbralLejos = evaluaDesacuerdo({
  historico: hist({ beats: 15, total: 20 }),
  precio_mercado: 0.42, consenso_declarado: 3.60, fecha_reporte: '2026-10-22', hoy: '2026-09-25',
});
ok(umbralLejos.instrumento.umbral_lejos_del_nivel === true,
  '$3.60 contra un nivel de ~$2.71 queda fuera de tolerancia', umbralLejos.instrumento.desvio_umbral_pct);
ok(umbralLejos.instrumento_primero === true,
  'y eso solo ya manda el instrumento primero, con 33 puntos de hueco', `${umbralLejos.gap_puntos}`);
ok(umbralLejos.instrumento.nivel_eps_reciente === 2.71,
  'el nivel se publica para poder discutirlo', umbralLejos.instrumento.nivel_eps_reciente);
const umbralCerca = evaluaDesacuerdo({
  historico: hist({ beats: 15, total: 20 }),
  precio_mercado: 0.42, consenso_declarado: 2.75, fecha_reporte: '2026-10-22', hoy: '2026-09-25',
});
ok(umbralCerca.instrumento.umbral_lejos_del_nivel === false && umbralCerca.instrumento_primero === false,
  'un umbral a la altura del nivel no dispara la alarma del instrumento');

console.log('la ventana: "21 de 27" no puede salir de acá');

// 27 trimestres comparables, TODOS en la tabla. El conteo de la tarjeta tiene
// que ser sobre 20, que es la ventana congelada — el de 27 va como "completo".
const filas27 = Array.from({ length: 27 }, (_, i) => {
  const mes = String((i % 12) + 1).padStart(2, '0');
  const anio = 2026 - Math.floor(i / 4);
  // 21 beats de 27, pero repartidos para que la ventana de 20 NO dé 21.
  const beat = i % 9 !== 0;
  return { reported_date: `${anio}-${mes}-10`, estimated_eps: 2.70, reported_eps: beat ? 2.78 : 2.60, surprise_pct: beat ? 3 : -3.7 };
});
const h27 = estadisticasHistoricas(filas27);
ok(h27.ventana.total === 20, 'estadisticasHistoricas recorta a la ventana de 20', h27.ventana.total);
ok(h27.completo.total === 27, 'y el conteo completo de 27 va aparte', h27.completo.total);
const conVentana = evaluaDesacuerdo({ historico: h27, precio_mercado: 0.08, consenso_declarado: 2.70, fecha_reporte: '2026-10-22', hoy: '2026-09-25' });
ok(conVentana.trimestres === 20 && conVentana.beats === h27.ventana.beats,
  'y el desacuerdo se calcula sobre la ventana, no sobre los 27',
  `${conVentana.beats} de ${conVentana.trimestres}`);
ok(conVentana.tasa_historica_pct === h27.ventana.pct,
  'la tasa que se resta es la MISMA que muestra el titular de la tarjeta',
  `${conVentana.tasa_historica_pct} vs ${h27.ventana.pct}`);

console.log('función PURA: el día entra por parámetro');

const fuente = (await import('node:fs')).readFileSync(new URL('../api/_lib/earnings-beat.js', import.meta.url), 'utf8');
const cuerpo = fuente.slice(fuente.indexOf('function evaluaDesacuerdo'), fuente.indexOf('function dondeMirarInstrumento'));
ok(!/new Date\(\)|Date\.now\(\)/.test(cuerpo), 'evaluaDesacuerdo no lee el reloj: `hoy` entra por parámetro');
ok(evaluaDesacuerdo({ historico: hist({ beats: 15, total: 20 }), precio_mercado: 0.08, consenso_declarado: 2.75, fecha_reporte: '2020-01-01' }).clasificacion === 'desacuerdo',
  'y sin `hoy` no se inventa una comparación de fechas: no se cierra por rancia');

console.log(failures ? `\n${failures} FALLAS` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
