// ═══════════════════════════════════════════════════════════════
// tests/arena-fallo-visible.test.mjs — EL MOTIVO DEL ABORTO, EN LA FICHA.
//
// EL CASO (medido en producción, diez días, 2026-09-26): 84 corridas abortadas
// y en TODAS la ficha decía `error: null`. El reparto:
//
//     error 52 (62%) · cuerpo_vacio 23 (27%) · time_budget 3 · call_budget 3
//     end_turn 2 · no_tools 1
//
// Y 28 de los 52 caen en siete racimos multi-agente que se parten EXACTAMENTE
// por proveedor y nunca se mezclan (OpenRouter el 23-24, Anthropic el 25).
// Cinco modelos de cinco empresas no fallan solos en el mismo minuto: falla la
// cuenta. Para llegar a eso hubo que hacer arqueología en la base, porque el
// texto del proveedor no salía por ningún lado.
//
// DOS CAUSAS, no una, y las dos hacían falta:
//   1. `journalObjetivoVivo` no escribía la columna `error`. El journal de
//      SOMBRA sí. Dos escritores del mismo journal, uno con la columna y el
//      otro sin ella — el patrón de B41, octava instancia.
//   2. La lista blanca de `/liga/libros` no pedía `context.llm_error`, que es
//      donde vive el texto del proveedor desde B23.
//
// Lo que este archivo fija:
//   1. LA COLUMNA `error` SE ESCRIBE EN EL CAMINO VIVO.
//   2. LAS DOS CONSULTAS PIDEN `llm_error`. Una sola dejaría la mitad de las
//      fichas diciendo "no falló" cuando lo que pasa es que no se preguntó.
//   3. `reloj_nuestro` SOBREVIVE HASTA LA PANTALLA. Es la pregunta de B23 y es
//      la que decide si se arregla el reloj o se cambia de proveedor.
//   4. UN CUERPO VACÍO NO SE PUBLICA COMO UN HUECO DE LA PANTALLA.
//
// Correr con `node tests/arena-fallo-visible.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { falloPublicable } from '../api/liga-libros.js';
import { COLUMNAS_CORRIDA } from '../api/_lib/arena-journal.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) LA COLUMNA QUE NO SE ESCRIBÍA ─────────────────────────────────
console.log('\n── el camino vivo journalea el motivo ──');
{
  // ── ACTUALIZADA EL MISMO DÍA QUE SE ESCRIBIÓ, CON EL MOTIVO ──────
  // Nació mirando el INSERT dentro de `journalObjetivoVivo`. Horas después
  // ese INSERT desapareció de ahí: `error` era la TERCERA columna que se
  // perdía en esa lista (después de `account` y antes de descubrir
  // `prompt_hash`), así que la lista pasó a ser UNA constante compartida.
  //
  // Arreglar el bug de fondo rompió la prueba del síntoma, que es lo que tiene
  // que pasar. Ahora pregunta por la propiedad donde vive.
  ok(COLUMNAS_CORRIDA.includes('error'),
    'la columna `error` está en la lista que usan los DOS escritores', COLUMNAS_CORRIDA.join(', '));
  const jrn = readFileSync(new URL('../api/_lib/arena-journal.js', import.meta.url), 'utf8');
  ok(/error: row\.error \?\? null/.test(jrn),
    'y le pasa el valor: una columna en la lista sin su parámetro es el mismo bug con otra cara');

  // Y el camino del objetivo pasa por ahí en vez de tener su propio insert:
  // es la bifurcación que costó tres columnas.
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const fn = run.slice(run.indexOf('async function journalObjetivoVivo'));
  ok(/await escribirCorrida\(/.test(fn.slice(0, 2500)),
    'el camino del objetivo escribe por el escritor compartido');
}

// ── 2) LAS DOS CONSULTAS, NO UNA ─────────────────────────────────────
console.log('\n── la viva y la de prueba piden lo mismo ──');
{
  const libros = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok((libros.match(/'llm_error', jsonb_build_object\(/g) || []).length === 2,
    'las DOS consultas proyectan llm_error: con una sola, media pantalla se lee como "no falló"');
  ok((libros.match(/'timeout_nuestro',\s*context->'llm_error'->'timeout_nuestro'/g) || []).length === 2,
    'y las dos traen el discriminante de B23');
  // `raw_body` acotado EN LA CONSULTA: 200 filas con el cuerpo crudo entero es
  // una respuesta que no baja, y un recorte del lado del cliente es un recorte
  // que alguien se olvida.
  ok((libros.match(/left\(context->'llm_error'->>'raw_body', 800\)/g) || []).length === 2,
    'el cuerpo crudo va acotado en la consulta, no del lado del cliente');
  ok(!/`/.test(libros.slice(libros.indexOf("'llm_error', jsonb_build_object"), libros.indexOf("'llm_error', jsonb_build_object") + 1400)),
    'sin comillas invertidas dentro del SQL: viven en un template literal de JS y una sola cierra el string');
}

// ── 3) LA PREGUNTA DE B23 LLEGA ENTERA ───────────────────────────────
// `timeout_nuestro` es la diferencia entre "dale más reloj" y "cambiá de
// proveedor". Si se pierde en la proyección, el diagnóstico se vuelve a hacer
// a mano cada vez.
console.log('\n── ¿cortó nuestro reloj o el proveedor? ──');
{
  const nuestro = falloPublicable({ llm_error: {
    status: 200, proveedor: 'Alibaba', timeout_nuestro: true, motivo: 'cuerpo_vacio',
    techo_ms: 70000, techo_origen: 'reserva_cierre',
    cuerpos_vacios: [{ vuelta: 4, intento: 1, bytes: 0, proveedor: 'Alibaba', timeout_nuestro: true, ms: 70002 }],
  } }, 'cuerpo_vacio: el proveedor devolvió HTTP 200 y cerró el stream');
  ok(nuestro.reloj_nuestro === true, 'un corte NUESTRO se publica como nuestro');
  ok(nuestro.proveedor === 'Alibaba', 'con el nombre de quien atendió');
  ok(nuestro.techo_ms === 70000 && nuestro.techo_origen === 'reserva_cierre',
    'y de qué techo salió el número: "se pasó de 70s" no dice si lo puso una env var o el reparto del loop');

  const suyo = falloPublicable({ llm_error: { status: 200, timeout_nuestro: false, proveedor: 'Novita' } });
  ok(suyo.reloj_nuestro === false, 'y uno del PROVEEDOR se publica como suyo: se arreglan al revés');

  // Sin el campo NO se inventa una respuesta. `null` es "no lo sabemos", que
  // es distinto de "cortó el proveedor" — y afirmarlo mandaría a cambiar de
  // proveedor por un timeout nuestro.
  const mudo = falloPublicable({ llm_error: { status: 500 } });
  ok(mudo.reloj_nuestro === null, 'sin el dato, null — no se adivina la culpa');

  // Dos cortes de la misma corrida pueden ser uno nuestro y uno suyo.
  const mixto = falloPublicable({ llm_error: { status: 200, cuerpos_vacios: [
    { vuelta: 3, timeout_nuestro: false, proveedor: 'A' }, { vuelta: 'cierre', timeout_nuestro: true, proveedor: 'A' },
  ] } });
  ok(mixto.cortes.length === 2 && mixto.cortes[0].reloj_nuestro === false && mixto.cortes[1].reloj_nuestro === true,
    'cada corte conserva SU culpa: promediarlos borraría justo eso');
}

// ── 4) EL HUECO QUE NO ES HUECO ──────────────────────────────────────
console.log('\n── un cuerpo vacío es el síntoma, no una pantalla rota ──');
{
  const page = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  ok(/function falloHtml/.test(page) && /falloHtml\(l\.fallo\)/.test(page),
    'la página tiene el bloque y lo pinta');
  ok(/Eso ES el síntoma, no un hueco de la pantalla/.test(page),
    'y cuando no hay texto lo DICE, en vez de dejar un espacio que se lee como un bug nuestro');
  ok(/cortó NUESTRO reloj/.test(page) && /cortó el PROVEEDOR/.test(page),
    'las dos culpas se pintan distinto: es la decisión de qué arreglar');
  ok(/no declarado/.test(page),
    'y un proveedor que no se pudo saber se nombra como tal — OpenRouter lo manda dentro del cuerpo que no llegó');

  // El bloque va ARRIBA, en el cuerpo de la ficha, no escondido en el detalle
  // plegado: el motivo de una corrida caída es lo primero que se busca.
  const iFallo = page.indexOf('falloHtml(l.fallo)');
  const iDetalle = page.indexOf("'<div class=\"detalle\">'");
  ok(iFallo > 0 && iDetalle > 0 && iFallo < iDetalle,
    'y se pinta antes del detalle plegado, no adentro');

  // Y no se repite abajo: el mismo texto dos veces en una ficha entrena a no
  // leer ninguno.
  ok(/l\.error&&!l\.fallo\?/.test(page), 'la nota vieja solo sale cuando NO hay bloque de fallo');
}

// ── 5) UNA CORRIDA SANA NO LLEVA BLOQUE ──────────────────────────────
console.log('\n── lo que no se pinta ──');
{
  ok(falloPublicable({ lens: 'momentum' }, null) === null, 'una corrida que no falló no trae bloque');
  ok(falloPublicable(null, null) === null, 'ni una fila sin contexto');
  // Pero un `error` sin `llm_error` (las filas viejas, y los abortos que ni
  // llegan al LLM) SÍ tiene que salir: es el único motivo que existe.
  const viejo = falloPublicable({}, 'Faltan ALPACA_PAPER_KEY/SECRET.');
  ok(viejo && viejo.motivo === 'Faltan ALPACA_PAPER_KEY/SECRET.' && viejo.http === null,
    'una fila con motivo y sin llm_error igual se publica: es el caso de los abortos que no llegan al modelo');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
