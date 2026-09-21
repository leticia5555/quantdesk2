// ═══════════════════════════════════════════════════════════════
// Tests de scripts/historia-h1.mjs — la aritmética de la sonda H1.
//
// El script pega a EDGAR y no se puede correr desde este contenedor, pero
// las dos funciones que producen los NÚMEROS sí se prueban — y son las que
// pueden mentir sin que se note:
//
//   · `percentil` — mediana y p95, no promedio. Un 10-K con anexos mueve un
//     promedio y no representa nada.
//   · `texto` — quitar el marcado. Si deja etiquetas adentro, el factor
//     texto/bytes sale inflado y toda la aritmética del memo con él.
//
// Correr con `node tests/historia-h1.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { percentil, texto } from '../scripts/historia-h1.mjs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const eq = (a, b, name) => ok(a === b, name, `esperaba ${JSON.stringify(b)}, dio ${JSON.stringify(a)}`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Percentiles: mediana y p95, no promedio');
{
  eq(percentil([1, 2, 3, 4, 5], 0.5), 3, 'la mediana de una lista impar');
  eq(percentil([1, 2, 3, 4], 0.5), 2.5, 'y de una par, interpolando');
  eq(percentil([10], 0.95), 10, 'con un solo valor, ese valor');
  eq(percentil([], 0.5), null, 'sin valores no se inventa un número');
  eq(percentil([1, 2, null, 3], 0.5), 2, 'los nulos no entran al cálculo');

  // EL CASO QUE JUSTIFICA NO USAR PROMEDIO: un documento enorme entre
  // muchos chicos. El promedio dice algo que no le pasa a ningún documento.
  const conAnexo = [20, 22, 21, 19, 23, 900];
  const promedio = conAnexo.reduce((a, b) => a + b, 0) / conAnexo.length;
  eq(percentil(conAnexo, 0.5), 21.5, 'la mediana describe el documento típico');
  ok(promedio > 160, `el promedio (${promedio.toFixed(0)}) no describe a ninguno`);
  ok(percentil(conAnexo, 0.95) > 200, 'y el p95 sí muestra qué tan mal se puede poner');

  // Postgres interpola igual: el número de acá y el de una consulta coinciden.
  eq(percentil([1, 2, 3, 4], 0.25), 1.75, 'la interpolación es la de percentile_cont');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n── Quitar el marcado: si queda HTML, el factor sale inflado');
{
  eq(texto('<p>Hola <b>mundo</b></p>'), 'Hola mundo', 'las etiquetas se van y el texto queda');
  eq(texto('<script>var x = "texto falso";</script>Real'), 'Real',
    'el contenido de <script> NO cuenta como texto: es el que más infla');
  eq(texto('<style>.a{color:red}</style>Real'), 'Real', 'ni el de <style>');
  eq(texto('<!-- comentario largo -->Real'), 'Real', 'ni los comentarios');
  eq(texto('a&nbsp;b'), 'a b', 'las entidades de espacio se vuelven espacio');
  eq(texto('AT&amp;T'), 'AT&T', 'y el ampersand se resuelve');
  eq(texto('a\n\n\t  b'), 'a b', 'los espacios se colapsan');
  eq(texto(''), '', 'un documento vacío da texto vacío');
  eq(texto(null), '', 'y uno nulo no rompe');

  // La forma de un 8-K real: tabla de una celda con estilo inline, que es
  // donde vive la mitad del peso de un filing de EDGAR.
  const real = '<html><head><style>td{font:10pt}</style></head><body>'
    + '<table style="border-collapse:collapse;width:100%"><tr><td style="padding:2pt">'
    + 'On March 1, 2026, the Company announced the departure of its Chief Financial Officer.'
    + '</td></tr></table></body></html>';
  const t = texto(real);
  ok(!/[<>]/.test(t), 'no queda ningún signo de etiqueta en el texto medido');
  ok(/departure of its Chief Financial Officer/.test(t), 'y la frase del documento sobrevive entera');
  ok(t.length / real.length < 0.4, `el factor es bien menor que 1 (${(t.length / real.length * 100).toFixed(0)}%)`);
}

console.log(failures ? `\n${failures} FALLA(S)\n` : '\nTODO EN VERDE\n');
process.exit(failures ? 1 : 0);
