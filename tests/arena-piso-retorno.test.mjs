// ═══════════════════════════════════════════════════════════════
// tests/arena-piso-retorno.test.mjs — EL MARGEN DE ERROR DE LA TABLA.
//
// Lo que este archivo protege no es la resta (es una resta), sino las cuatro
// decisiones que la vuelven una declaración y no un adorno:
//
//   1. EL PISO ESTÁ EN PUNTOS DE RETORNO, no en coseno. Es la distancia entre
//      claude y control — mismo modelo, mismo prompt, distinta cuenta. No se
//      convierte desde ningún coseno ni se compara con ellos.
//   2. SIN EL PAR COMPLETO NO HAY PISO. Un piso calculado "con lo que haya" no
//      es un piso, y el bloque tiene que decir que no lo tiene.
//   3. UNA BRECHA MENOR QUE EL PISO NO ES UN PUESTO. La fila lo dice al lado
//      del número, no en la letra chica.
//   4. EL BENCHMARK NO ENTRA AL PISO NI AL SPREAD. No decidió nada: su
//      distancia a un agente es la PREGUNTA del experimento, no su ruido.
//
// Correr con `node tests/arena-piso-retorno.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  pisoDeRetorno, spreadDeModelos, empatesTecnicos, contraElIndice, margenDeLaTabla, METODO_RETORNO,
} from '../api/_lib/arena-piso-retorno.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// La tabla del 2026-09-21, con la forma que publica /api/leaderboard: el líder
// despegado y los otros seis apretados dentro de un punto y medio.
const LIGA = [
  { id: 'grok', name: 'Grok', return_pct: 1.42 },
  { id: 'control', name: 'Control · Haiku-B', control: true, return_pct: 1.06 },
  { id: 'gemini', name: 'Gemini', return_pct: 0.61 },
  { id: 'openai', name: 'ChatGPT', return_pct: 0.33 },
  { id: 'deepseek', name: 'DeepSeek', return_pct: 0.12 },
  { id: 'claude', name: 'Claude', return_pct: 0.07 },
  { id: 'qwen', name: 'Qwen', return_pct: -0.29 },
];
// El índice por encima de todos salvo el líder: seis de siete pierden contra él.
const SPY = 1.15;

// ── 1) EL PISO: claude ↔ control, en puntos ──────────────────────────
console.log('\n── el piso de ruido, en puntos de retorno ──');
{
  const p = pisoDeRetorno({ agentes: LIGA });
  ok(p.disponible === true, 'con el par completo, hay piso');
  ok(p.piso_pp === 0.99, 'el piso es |1.06 − 0.07| = 0.99 pp', String(p.piso_pp));
  ok(p.metodo === METODO_RETORNO && p.unidad === 'pp', 'viaja con su método y su unidad pegados: nadie lo compara con un coseno');
  ok(p.par.insignia.id === 'claude' && p.par.testigo.id === 'control', 'el par nombrado es claude↔control');

  // El orden de la resta no puede cambiar el signo del margen de error.
  const invertido = pisoDeRetorno({ agentes: LIGA, insignia: 'control', testigo: 'claude' });
  ok(invertido.piso_pp === 0.99, 'es un valor absoluto: dar vuelta el par no lo vuelve negativo', String(invertido.piso_pp));
}

// ── 2) SIN EL PAR COMPLETO NO HAY PISO ───────────────────────────────
console.log('\n── el par incompleto ──');
{
  const sinControl = pisoDeRetorno({ agentes: LIGA.filter((a) => a.id !== 'control') });
  ok(sinControl.disponible === false, 'sin control no se inventa un piso');
  ok(sinControl.piso_pp === null, 'y el número sale null, no 0 — un 0 se leería como "no hay ruido"', String(sinControl.piso_pp));
  ok(/control/.test(sinControl.motivo || ''), 'el motivo dice a quién le falta el retorno', sinControl.motivo);

  // Una cuenta caída (sin retorno legible) es lo mismo que una ausente.
  const caido = pisoDeRetorno({ agentes: LIGA.map((a) => (a.id === 'claude' ? { ...a, return_pct: null } : a)) });
  ok(caido.disponible === false, 'un agente sin retorno legible no produce medio piso');
}

// ── 3) EL SPREAD, y el spread sin el líder ───────────────────────────
console.log('\n── el spread entre modelos ──');
{
  const s = spreadDeModelos(LIGA);
  ok(s.spread_pp === 1.71, 'el rango completo es 1.42 − (−0.29) = 1.71 pp', String(s.spread_pp));
  ok(s.lider.id === 'grok' && s.ultimo.id === 'qwen', 'nombra al primero y al último');
  ok(s.spread_sin_lider_pp === 1.35, 'sin el líder, los otros seis caben en 1.35 pp', String(s.spread_sin_lider_pp));
  ok(s.modelos === 7, 'cuenta los siete que compiten', String(s.modelos));

  const solo = spreadDeModelos([LIGA[0]]);
  ok(solo.disponible === false, 'con un solo agente no hay spread que publicar');
}

// ── 4) LOS EMPATES TÉCNICOS ──────────────────────────────────────────
console.log('\n── qué puestos significan algo ──');
{
  const e = empatesTecnicos({ agentes: LIGA, pisoPp: 0.99 });
  ok(e.brechas.length === 6, 'seis brechas entre siete puestos', String(e.brechas.length));
  // grok↔control = 0.36; todas las demás son menores todavía. Con un piso de
  // 0.99, NINGUNA brecha consecutiva lo alcanza.
  ok(e.empates.length === 6, 'las seis brechas son menores que el piso', String(e.empates.length));
  ok(e.separados.length === 0, 'así que ningún puesto se separa del ruido', JSON.stringify(e.separados));
  ok(e.por_agente.claude.empate_tecnico === true, 'claude queda marcado como empate técnico');
  ok(e.por_agente.claude.brecha_min_pp === 0.05, 'su vecino más cercano está a 0.05 pp (deepseek)', String(e.por_agente.claude.brecha_min_pp));

  // Con un piso chico, los puestos vuelven a significar algo: la marca depende
  // del piso y no de la posición en la tabla.
  const conPisoChico = empatesTecnicos({ agentes: LIGA, pisoPp: 0.03 });
  ok(conPisoChico.separados.length === 7, 'con un piso de 0.03 pp los siete puestos se separan', JSON.stringify(conPisoChico.separados));
  ok(conPisoChico.por_agente.claude.empate_tecnico === false, 'claude ya no está empatado: su brecha mínima (0.05) supera ese piso',
    JSON.stringify(conPisoChico.por_agente.claude));
  // El piso intermedio es el que prueba que la marca sigue al PISO y no a la
  // posición: con 0.10, claude (0.05) queda empatado y grok (0.36) no.
  const medio = empatesTecnicos({ agentes: LIGA, pisoPp: 0.10 });
  ok(medio.por_agente.claude.empate_tecnico === true && medio.por_agente.grok.separado === true,
    'con un piso de 0.10 pp, claude queda dentro del ruido y grok fuera',
    JSON.stringify({ claude: medio.por_agente.claude.brecha_min_pp, grok: medio.por_agente.grok.brecha_min_pp }));

  const sinPiso = empatesTecnicos({ agentes: LIGA, pisoPp: null });
  ok(sinPiso.disponible === false, 'sin piso no se declara ningún empate: no hay contra qué');
}

// ── 5) CONTRA EL ÍNDICE, CONTADO ─────────────────────────────────────
console.log('\n── ¿le ganan al SPY? ──');
{
  const i = contraElIndice({ agentes: LIGA, benchmarkReturn: SPY });
  ok(i.pierden === 6, 'seis de siete van por debajo del índice', String(i.pierden));
  ok(i.ganan === 1 && i.ganan_ids[0] === 'grok', 'le gana uno solo, y se nombra', JSON.stringify(i.ganan_ids));
  ok(i.total === 7, 'el total son los que compiten');
  ok(/6 de 7/.test(i.lectura), 'la lectura dice el conteo, no lo deja para que el lector reste', i.lectura);

  const sinIndice = contraElIndice({ agentes: LIGA, benchmarkReturn: null });
  ok(sinIndice.disponible === false, 'sin índice abierto no se afirma nada sobre el índice');
}

// ── 6) EL BENCHMARK NO CONTAMINA NI EL PISO NI EL SPREAD ─────────────
console.log('\n── el benchmark no compite, tampoco acá ──');
{
  const conBench = [...LIGA, { id: 'benchmark-spy', name: 'S&P 500 · SPY', compite: false, return_pct: SPY }];
  const s = spreadDeModelos(conBench);
  ok(s.modelos === 7, 'el spread sigue contando SIETE modelos, no ocho', String(s.modelos));
  ok(s.spread_pp === 1.71, 'y el rango no cambia por una fila que no decidió nada', String(s.spread_pp));
  const e = empatesTecnicos({ agentes: conBench, pisoPp: 0.99 });
  ok(e.por_agente['benchmark-spy'] === undefined, 'el índice no recibe marca de empate: no tiene puesto que defender');
}

// ── 7) EL BLOQUE COMPLETO ────────────────────────────────────────────
console.log('\n── el bloque que publica la pantalla ──');
{
  const m = margenDeLaTabla({ agentes: LIGA, benchmarkReturn: SPY });
  ok(m.piso.piso_pp === 0.99 && m.spread.spread_pp === 1.71, 'trae los dos números juntos: uno sin el otro no se puede leer');
  ok(m.piso_sobre_spread_pct === 58, 'el ruido explica el 58% del rango completo', String(m.piso_sobre_spread_pct));
  ok(m.piso_sobre_spread_sin_lider_pct === 73, 'y el 73% del rango sin el líder', String(m.piso_sobre_spread_sin_lider_pct));
  ok(/RUIDO SE COME EL RANKING/.test(m.lectura), 'con el piso arriba del 50% del spread, lo dice con esas palabras', m.lectura);
  ok(/NINGÚN puesto/.test(m.detalle_separados || ''), 'y dice que ningún puesto se distingue del ruido', m.detalle_separados);
  ok(m.indice.pierden === 6, 'la línea del índice viaja en el mismo bloque');
  ok(/NO es el piso de ruido en coseno/.test(m.caveat), 'el caveat que impide comparar con los cosenos viaja con el bloque');

  // Sin el par, el bloque NO se calla: dice que la tabla se está leyendo sin
  // margen. Es el caso que hay que gritar, no el que hay que esconder.
  const sinPar = margenDeLaTabla({ agentes: LIGA.filter((a) => a.id !== 'control'), benchmarkReturn: SPY });
  ok(sinPar.piso.disponible === false, 'sin control no hay piso');
  ok(/SIN MARGEN DECLARADO/.test(sinPar.lectura), 'y la pantalla lo dice en vez de publicar el ranking a secas', sinPar.lectura);
  ok(sinPar.indice.pierden === 5, 'el conteo contra el índice sigue saliendo: no depende del piso', String(sinPar.indice.pierden));
}

// ── 8) EL CASO EN QUE EL RUIDO SE COME TODO ──────────────────────────
console.log('\n── cuando el piso es mayor que el spread entero ──');
{
  const apretada = [
    { id: 'claude', name: 'Claude', return_pct: 2.00 },
    { id: 'control', name: 'Control', control: true, return_pct: 0.10 },
    { id: 'openai', name: 'ChatGPT', return_pct: 1.50 },
  ];
  const m = margenDeLaTabla({ agentes: apretada, benchmarkReturn: 0 });
  ok(m.piso.piso_pp === 1.9, 'el piso es 1.90 pp', String(m.piso.piso_pp));
  ok(m.spread.spread_pp === 1.9, 'y el spread entero es 1.90 pp', String(m.spread.spread_pp));
  ok(m.piso_sobre_spread_pct === 100, 'el ruido es el 100% del spread', String(m.piso_sobre_spread_pct));
  ok(/ningún puesto de esta tabla es interpretable/i.test(m.lectura), 'y la lectura no lo suaviza', m.lectura);
}

// ── 9) EL CONTRATO CON LA PANTALLA ───────────────────────────────────
// El bloque solo sirve si /liga lo pinta ARRIBA del ranking. Un campo que el
// servidor publica y la página no lee es exactamente el "código muerto con un
// test verde" que ya pasó con `pairwiseOverlap`.
console.log('\n── /liga pinta el margen, y lo pinta antes del ranking ──');
{
  const page = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');

  ok(/margen_de_la_tabla:\s*margen/.test(api), 'el endpoint publica `margen_de_la_tabla` en el camino por defecto, sin bandera');
  ok(/r\.margen\s*=/.test(api), 'y cuelga el empate técnico de CADA fila, para que la marca vaya al lado del puesto');
  ok(/data\.margen_de_la_tabla/.test(page), 'la página lee ese campo');
  ok(/function margenHtml/.test(page), 'y tiene una función propia para pintarlo');

  // El orden en el DOM es la mitad del pedido: "arriba, donde se lee antes del
  // ranking". Si el bloque queda debajo de la tabla, el ranking se lee primero
  // y el margen pasa a ser una nota al pie — que es el estado que esto corrige.
  const iMargen = page.indexOf('id="margen"');
  const iBoard = page.indexOf('id="board"');
  ok(iMargen > 0 && iBoard > 0 && iMargen < iBoard,
    'y el contenedor va ANTES del ranking en el DOM: un margen debajo de la tabla es una nota al pie',
    JSON.stringify({ margen: iMargen, board: iBoard }));

  ok(/empate técnico/.test(page), 'la fila dice "empate técnico" cuando su brecha no llega al piso');

  // El "/8" era del contrato de acciones retirado el 2026-09-17. Los rieles
  // vigentes no acotan la CANTIDAD de posiciones — el propio prompt lo dice —
  // así que un denominador de 8 convierte "13 posiciones" en una violación que
  // no existe.
  ok(!/\/8 posiciones/.test(page), 'y ya no hay un tope de 8 posiciones en pantalla: el motor no aplica ninguno');
  const prompt = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(/NO cap on the NUMBER of positions/i.test(prompt),
    'el prompt del contrato vigente lo dice con todas las letras: no hay tope de cantidad de posiciones');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
