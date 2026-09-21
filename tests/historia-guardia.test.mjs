// ═══════════════════════════════════════════════════════════════
// Tests de api/_lib/historia-guardia.js — los guardias de la salida.
//
// Un prompt que pide "toda afirmación con su cita" es una intención. Esto es
// lo que la vuelve una propiedad, así que estas pruebas están escritas para
// INTENTAR PASAR el guardia, no para confirmar que anda.
//
//   1. El verificador es LITERAL: subcadena exacta, normalizando solo
//      espacios. Nada difuso. Un umbral de parecido convierte la cita en una
//      afirmación con buena presentación.
//   2. Se corta la AFIRMACIÓN, no el párrafo: una cita inventada en la
//      tercera oración no se lleva las dos buenas.
//   3. Si no queda nada, cae la sección entera.
//   4. Lo cortado se REGISTRA con su texto: sin eso no se puede ver qué dijo
//      el modelo, que es la queja que originó "la cruda se guarda siempre".
//   5. La lista de opinión no puede tragarse la descripción de un documento:
//      "avisó de un riesgo contable [acc]" es un hecho.
//
// Correr con `node tests/historia-guardia.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  normalizarEspacios, apareceLiteral, partirAfirmaciones, citasDe,
  tieneOpinion, tieneRelativoAHoy, guardar, RAICES_OPINION, RAICES_RELATIVAS,
  RAICES_CONSEJO, RAICES_VALUACION, entrecomillados, verificarEntrecomillados,
} from '../api/_lib/historia-guardia.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);
const hondo = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

const CITABLES = new Set(['acc-1', 'acc-2', '0000320193-25-000073']);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El verificador literal: nada difuso');
{
  // Lo ÚNICO que se normaliza. El HTML de EDGAR parte frases con saltos de
  // línea en lugares arbitrarios, y una corrida de espacios no es una
  // diferencia de contenido.
  ok(apareceLiteral('el director renunció', 'Texto: el director\n   renunció el lunes.'),
    'los saltos de línea y los espacios de más no cuentan');
  ok(apareceLiteral('  el  director  ', 'el director'), 'ni los espacios de los bordes');
  eq(normalizarEspacios('a \n\t b  c '), 'a b c', 'la normalización colapsa a un espacio');

  // Todo lo demás SÍ cuenta. Cada una de estas es una diferencia de
  // contenido, y aceptarla es aceptar una paráfrasis.
  ok(!apareceLiteral('el director renuncio', 'el director renunció'), 'un acento SÍ cuenta');
  ok(!apareceLiteral('El Director renunció', 'el director renunció'), 'una mayúscula SÍ cuenta');
  ok(!apareceLiteral('el "director" renunció', 'el “director” renunció'), 'una comilla tipográfica SÍ cuenta');
  ok(!apareceLiteral('el director-general', 'el director—general'), 'un guión distinto SÍ cuenta');
  ok(!apareceLiteral('el director renunció.', 'el director renunció'), 'un punto de más SÍ cuenta');

  // Y lo que un umbral de parecido dejaría pasar.
  ok(!apareceLiteral('el director financiero renunció', 'el director renunció'),
    'una palabra agregada no pasa, por más parecido que sea');
  ok(!apareceLiteral('renunció el director', 'el director renunció'),
    'ni el mismo significado en otro orden');
  ok(!apareceLiteral('', 'cualquier cosa'), 'un fragmento vacío no "aparece" en todo');
  ok(!apareceLiteral('   ', 'cualquier cosa'), 'ni uno de solo espacios');
  ok(!apareceLiteral('algo', null), 'y un cuerpo nulo no rompe');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Partir en afirmaciones: los tres casos que rompen un split ingenuo');
{
  hondo(partirAfirmaciones('Subió 12.3% en el trimestre [acc-1]. Cerró en 1.234 unidades.'),
    ['Subió 12.3% en el trimestre [acc-1].', 'Cerró en 1.234 unidades.'],
    'un punto entre dígitos es un decimal, no un final de oración');

  hondo(partirAfirmaciones('Opera en EE.UU. y en México [acc-1]. Nada más.'),
    ['Opera en EE.UU. y en México [acc-1].', 'Nada más.'],
    'una abreviatura conocida no parte la oración');

  // La cita va ANTES del punto: si el corte quedara mal, la cita se le
  // atribuiría a la afirmación equivocada, que es peor que no cortar.
  const tres = partirAfirmaciones('Nombró un CFO [acc-1]. Firmó un contrato [acc-2]. Cerró la compra [acc-3].');
  eq(tres.length, 3, 'tres afirmaciones');
  hondo(citasDe(tres[0]), ['acc-1'], 'cada cita queda con SU afirmación');
  hondo(citasDe(tres[1]), ['acc-2'], 'la segunda también');
  hondo(citasDe(tres[2]), ['acc-3'], 'y la tercera');

  hondo(partirAfirmaciones(''), [], 'un texto vacío no da afirmaciones');
  hondo(partirAfirmaciones('Sin punto final [acc-1]'), ['Sin punto final [acc-1]'],
    'una oración sin punto final igual cuenta');
  hondo(partirAfirmaciones('¿Y esto? Sí.'), ['¿Y esto?', 'Sí.'], 'los signos de pregunta también cortan');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Se corta la afirmación, no el párrafo');
{
  const r = guardar([{
    id: 'direccion',
    texto: 'Nombró un director financiero [acc-1]. Compró una empresa [acc-inventado]. Firmó un contrato [acc-2].',
  }], CITABLES);

  eq(r.estado, 'ok_con_cortes', 'con algo cortado y algo vivo, el estado lo dice');
  eq(r.secciones.length, 1, 'la sección sobrevive');
  eq(r.secciones[0].texto, 'Nombró un director financiero [acc-1]. Firmó un contrato [acc-2].',
    'las dos afirmaciones buenas quedan, y la inventada no');
  eq(r.cortes.length, 1, 'se registra un corte');
  eq(r.cortes[0].motivo, 'cita_desconocida', 'con su motivo');
  hondo(r.cortes[0].citas, ['acc-inventado'], 'y la cita que lo causó');
  // El texto cortado VIAJA. Sin él no se puede ver qué dijo el modelo.
  ok(/Compró una empresa/.test(r.cortes[0].texto), 'y el texto cortado, para poder verlo');
  eq(r.resumen.afirmaciones_cortadas, 1, 'el resumen cuenta');

  // Nada que cortar: el estado es limpio y el texto no se toca.
  const limpia = guardar([{ id: 'direccion', texto: 'Nombró un CFO [acc-1]. Firmó [acc-2].' }], CITABLES);
  eq(limpia.estado, 'ok', 'sin cortes, el estado es ok a secas');
  hondo(limpia.cortes, [], 'y no hay cortes');
  eq(limpia.secciones[0].texto, 'Nombró un CFO [acc-1]. Firmó [acc-2].', 'el texto queda igual');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Si no queda nada, cae la sección');
{
  const r = guardar([
    { id: 'direccion', texto: 'Todo inventado [no-existe-1]. Esto también [no-existe-2].' },
    { id: 'catalizador', texto: 'Firmó un contrato [acc-1].' },
  ], CITABLES);

  eq(r.secciones.length, 1, 'la sección sin nada que sostener desaparece');
  eq(r.secciones[0].id, 'catalizador', 'y la buena queda');
  eq(r.resumen.secciones_cortadas, 1, 'se cuenta la sección caída');
  ok(r.cortes.some((c) => c.motivo === 'seccion_vacia' && c.seccion === 'direccion'),
    'con su registro y el id de la sección');
  eq(r.estado, 'ok_con_cortes', 'todavía sirve: algo sobrevivió');

  // Si NO sobrevive ninguna sección, no hay narración que servir.
  const todo = guardar([{ id: 'direccion', texto: 'Inventado [no-existe].' }], CITABLES);
  eq(todo.estado, 'rechazada', 'sin ninguna sección viva, la narración se rechaza');
  hondo(todo.secciones, [], 'y no se devuelve texto');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Intentos de pasar el guardia de opinión');
{
  const intentar = (texto) => guardar([{ id: 'x', texto: `${texto} [acc-1].` }], CITABLES);

  // Lo que tiene que caer. Cada uno es una forma distinta de lo mismo.
  const prohibidas = [
    'Recomendamos seguir de cerca este emisor',
    'La acción está barata a estos precios',
    'El precio objetivo implícito es más alto',
    'Conviene sobreponderar el sector',
    'Es una buena inversión para el largo plazo',
    'La acción va a subir cuando se confirme',
    'Sería aconsejable tomar una posición',
    'Está sobrevalorada frente a sus pares',
    'Esperamos que el precio reaccione',
    'Vale la pena comprar antes del reporte',
  ];
  for (const p of prohibidas) {
    const r = intentar(p);
    eq(r.secciones.length, 0, `se corta: "${p.slice(0, 40)}…"`);
    ok(r.cortes.some((c) => c.motivo === 'opinion'), '…marcado como opinión');
  }

  // Lo que NO puede caer: describir lo que un documento dice no es calificar.
  // Es el límite exacto del módulo, y una lista de prohibiciones demasiado
  // ancha se come justamente lo que el módulo existe para decir.
  const permitidas = [
    'Avisó que no se puede confiar en sus estados financieros ya publicados',
    'La empresa reportó un riesgo de ciberseguridad material',
    'El inventario subió 18% contra el mismo trimestre del año anterior',
    'Un tercero presentó material de solicitación impugnada',
    'La empresa volvió a presentar el trimestre con otro valor',
    'El contrato firmado es material según la propia empresa',
    'La compañía declaró una pérdida neta en el periodo',
  ];
  for (const p of permitidas) {
    const r = intentar(p);
    eq(r.secciones.length, 1, `NO se corta: "${p.slice(0, 40)}…"`);
  }

  ok(RAICES_OPINION.length >= 15, 'la lista de opinión cubre varias formas, no una');
  ok(!RAICES_OPINION.some((x) => /riesgo|problema/.test(x)),
    'y no incluye palabras que aparecen legítimamente al describir un filing');
  ok(RAICES_CONSEJO.length && RAICES_VALUACION.length, 'la lista está partida en consejo y valuación');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El consejo de OTRO es un hecho; el nuestro es una recomendación');
{
  const intentar = (texto) => guardar([{ id: 'x', texto: `${texto} [acc-1].` }], CITABLES);

  // EL BUG QUE ESTO ARREGLA. La primera versión tenía la raíz `recomend` y
  // cortaba esto — un hecho sobre un proxy, y justamente lo que la pregunta 2
  // existe para decir. Peor: de forma arbitraria, porque en español el tallo
  // alterna y `recomend` agarra "recomendó" pero no "recomienda".
  for (const p of [
    'El consejo recomendó votar a favor de la propuesta',
    'Un tercero recomendó a los accionistas rechazar el acuerdo',
    'La empresa recomienda a sus accionistas votar en contra',
    'El material de solicitación incluye una recomendación del consejo',
    'La propuesta fue aconsejada por el comité',
  ]) {
    eq(intentar(p).secciones.length, 1, `discurso referido NO se corta: "${p.slice(0, 42)}…"`);
  }

  // Y en NUESTRA voz sigue cayendo, que es de lo que se trata.
  for (const p of [
    'Recomendamos votar a favor',
    'Recomiendo mirar el próximo reporte',
    'Sería aconsejable tomar una posición',
    'Sugerimos esperar al cierre del trimestre',
    'Deberías mirar el 4.02 antes que nada',
  ]) {
    eq(intentar(p).secciones.length, 0, `nuestra voz SÍ se corta: "${p.slice(0, 42)}…"`);
  }

  // El tiempo verbal no puede cambiar el veredicto. Era el síntoma del bug.
  eq(intentar('El consejo recomendó X').secciones.length,
    intentar('El consejo recomienda X').secciones.length,
    'el mismo hecho en dos tiempos verbales se trata igual');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── La cita textual verificada se exime; la no verificada se corta');
{
  // La colisión que iba a pasar seguro: la extracción trae frases TEXTUALES
  // de los documentos, y una carta de un activista dice "la acción está
  // infravalorada" con todas las letras. Sin exención, el guardia cortaría
  // una cita literal verificada — lo más verificable que el módulo tiene.
  const CUERPO = new Map([['acc-1', 'El consejo cree que la acción está infravalorada y que el mercado no lo ve.']]);
  const conCuerpo = (texto) => guardar([{ id: 'x', texto }], CITABLES, { cuerpos: CUERPO });

  {
    const r = conCuerpo('La carta del disidente dice «la acción está infravalorada» [acc-1].');
    eq(r.estado, 'ok', 'una cita textual verificada pasa, aunque diga una valuación');
    ok(/infravalorada/.test(r.secciones[0].texto), 'y el texto queda entero, con sus comillas');
  }

  // FAIL-CLOSED: sin cuerpo no hay verificación, y sin verificación no hay
  // exención. Una comilla sin respaldo lava la voz del narrador como si
  // fuera la de la empresa, que es peor que decir la opinión de frente.
  {
    const r = guardar([{ id: 'x', texto: 'La carta dice «la acción está infravalorada» [acc-1].' }], CITABLES);
    eq(r.estado, 'rechazada', 'sin cuerpo guardado, la cita textual NO se exime');
    eq(r.cortes[0].motivo, 'cita_textual_no_verificada', 'y el motivo lo dice');
    hondo(r.cortes[0].frases, ['la acción está infravalorada'], 'nombrando la frase que no verificó');
  }

  // Una frase que NO está en el cuerpo tampoco pasa, aunque el cuerpo exista.
  eq(conCuerpo('La carta dice «la acción está regalada» [acc-1].').estado, 'rechazada',
    'una frase que no aparece en el cuerpo no verifica');

  // Ni con un acento cambiado: el verificador es literal.
  eq(conCuerpo('La carta dice «la accion está infravalorada» [acc-1].').estado, 'rechazada',
    'ni con un acento distinto');

  // Se verifica contra el cuerpo del documento QUE LA AFIRMACIÓN CITA, no
  // contra cualquiera: si no, se le atribuiría a un papel lo que dijo otro.
  eq(guardar([{ id: 'x', texto: 'El 8-K dice «la acción está infravalorada» [acc-2].' }],
    CITABLES, { cuerpos: CUERPO }).estado, 'rechazada',
  'la frase tiene que estar en el cuerpo del documento citado, no en otro');

  // La exención cubre lo entrecomillado y NADA MÁS: la opinión propia
  // pegada al lado de una cita válida sigue cayendo.
  eq(conCuerpo('La carta dice «la acción está infravalorada» [acc-1] y recomendamos comprar.').estado,
    'rechazada', 'una cita válida no habilita una opinión nuestra en la misma oración');

  // El extractor de comillas, aparte.
  hondo(entrecomillados('dice «uno» y también «dos»'), ['uno', 'dos'], 'saca todas las citas textuales');
  hondo(entrecomillados('sin comillas'), [], 'y ninguna cuando no hay');
  hondo(verificarEntrecomillados('«x» [acc-1]', { 'acc-1': 'algo con x adentro' }).map((c) => c.verificada),
    [true], 'acepta un objeto además de un Map');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Lo relativo a hoy: una narración cacheada envejece mintiendo');
{
  const intentar = (texto) => guardar([{ id: 'x', texto: `${texto} [acc-1].` }], CITABLES);

  for (const p of [
    'Recientemente presentó un cambio de directivos',
    'Actualmente la empresa no tiene deuda registrada',
    'En los últimos meses hubo tres presentaciones',
    'Hace poco volvió a presentar el trimestre',
    'Este año se presentaron nueve documentos',
  ]) {
    const r = intentar(p);
    eq(r.secciones.length, 0, `se corta: "${p.slice(0, 38)}…"`);
    ok(r.cortes.some((c) => c.motivo === 'relativo_a_hoy'), '…marcado como relativo a hoy');
  }

  // "el filing más reciente" es una comparación ENTRE documentos, no una
  // referencia a hoy, y es correcta. Si `reciente` entrara como raíz suelta,
  // esto caería.
  for (const p of [
    'El filing más reciente de esta serie es de marzo',
    'El 2026-02-20 presentó un cambio de directivos',
    'Entre diciembre de 2025 y mayo de 2026 hubo 34 documentos',
  ]) {
    eq(intentar(p).secciones.length, 1, `NO se corta: "${p.slice(0, 38)}…"`);
  }

  ok(!RAICES_RELATIVAS.includes('reciente'), '`reciente` no está como raíz suelta, a propósito');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── El guardia no se puede evadir con la forma del texto');
{
  // Una cita inventada en una oración sin punto final.
  eq(guardar([{ id: 'x', texto: 'Algo inventado [no-existe]' }], CITABLES).estado, 'rechazada',
    'sin punto final igual se corta');

  // Dos citas en la misma oración, una buena y una inventada: cae la oración
  // entera. No se puede salvar media afirmación.
  const mixta = guardar([{ id: 'x', texto: 'Firmó con la contraparte [acc-1] el mismo día [no-existe].' }], CITABLES);
  eq(mixta.estado, 'rechazada', 'una cita mala contamina su afirmación aunque tenga una buena al lado');

  // Opinión escondida detrás de una cita válida.
  eq(guardar([{ id: 'x', texto: 'Nombró un CFO [acc-1]. La acción está barata [acc-2].' }], CITABLES)
    .secciones[0].texto, 'Nombró un CFO [acc-1].',
  'una cita válida no habilita una opinión');

  // Mayúsculas y acentos no evaden la lista.
  eq(guardar([{ id: 'x', texto: 'RECOMENDAMOS comprar [acc-1].' }], CITABLES).estado, 'rechazada',
    'las mayúsculas no evaden el guardia de opinión');

  // Una sección sin texto no explota ni inventa un corte.
  const vacia = guardar([{ id: 'x', texto: '' }, { id: 'y', texto: null }], CITABLES);
  hondo(vacia.cortes, [], 'una sección sin texto no genera cortes');
  eq(vacia.estado, 'rechazada', 'pero tampoco sobrevive: no hay nada que mostrar');

  // Sin lista de citables, TODO lo citado se cae. Fail-closed: una lista
  // vacía no puede significar "todo vale".
  eq(guardar([{ id: 'x', texto: 'Algo [acc-1].' }], new Set()).estado, 'rechazada',
    'con el inventario vacío no pasa ninguna cita: fail-closed');
  eq(guardar([{ id: 'x', texto: 'Sin documentos.' }], new Set()).secciones.length, 1,
    'pero una frase SIN citas pasa: "Sin documentos." es lo que el prompt manda decir');

  // Un arreglo en vez de un Set también funciona: el llamador no tiene que
  // acordarse de cuál de los dos era.
  eq(guardar([{ id: 'x', texto: 'Algo [acc-1].' }], ['acc-1']).estado, 'ok',
    'acepta un arreglo igual que un Set');
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
