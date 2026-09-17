// ═══════════════════════════════════════════════════════════════
// tests/arena-piso-deltas.test.mjs — el piso de ruido SIN tocar las cuentas.
//
// EL PROBLEMA (2026-09-17): claude y control ya no arrancan del mismo libro,
// así que el coseno entre sus carteras mide HERENCIA y el piso no se puede
// publicar. La salida obvia —igualar las cuentas— cuesta órdenes reales y un
// salto en la curva de equity de las dos cuentas que MENOS deben contaminarse.
//
// LA SALIDA BARATA: comparar lo que cada uno CAMBIÓ (`objetivo − actual`), no
// lo que tiene. Dos PMs idénticos que heredan carteras distintas deberían
// moverse parecido.
//
// ── Y NO ES LA MISMA MÉTRICA ────────────────────────────────────────
// Un vector de deltas tiene componentes negativas, así que su coseno vive en
// [−1, 1]. El de libros long-only vive en [0, 1]. Comparar un 0.62 de deltas
// con el 0.86 de libros del 16 es comparar dos escalas — y es exactamente el
// error que el `metodo` existe para impedir.
//
// Correr con `node tests/arena-piso-deltas.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { deltaDePesos, pisoDeRuido, lecturaDelPiso, METODO_LIBROS, METODO_DELTAS } from '../api/_lib/arena-herding.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── el delta es lo que se decidió cambiar ──');
{
  const d = deltaDePesos({ NVDA: 0.10, ZM: 0.05 }, { NVDA: 0.15, AMD: 0.08 });
  ok(d.NVDA === 0.05, 'subir una posición es un delta positivo');
  ok(d.ZM === -0.05, 'salirse de una es un delta NEGATIVO — por eso el coseno puede ser negativo');
  ok(d.AMD === 0.08, 'y abrir una nueva cuenta como decisión');
  ok(!('SPY' in d), 'lo que no se tocó no entra');

  const quieto = deltaDePesos({ NVDA: 0.1 }, { NVDA: 0.1 });
  ok(Object.keys(quieto).length === 0,
    'un delta de CERO no es una decisión: es un nombre que no se tocó. Dejarlo infla el vector y hace creer que hubo más decisiones de las que hubo');
}

console.log('\n── con libros distintos, el piso SÍ se puede medir ──');
{
  const piso = pisoDeRuido({
    insignia: { enfoque: 'momentum', posiciones_iniciales: ['NVDA', 'ZM'] },
    testigo: { enfoque: 'momentum', posiciones_iniciales: ['COP'] },
    pesos: { claude: { NVDA: 0.15, AMD: 0.08 }, control: { COP: 0.1, AMD: 0.07 } },
    deltas: {
      claude: deltaDePesos({ NVDA: 0.10, ZM: 0.05 }, { NVDA: 0.15, AMD: 0.08 }),
      control: deltaDePesos({ COP: 0.12 }, { COP: 0.1, AMD: 0.07 }),
    },
  });
  ok(piso.comparable === true && piso.metodo === METODO_DELTAS,
    'con carteras distintas el piso se publica por DELTAS, no se declara incomparable');
  ok(piso.cosine === piso.cosine_deltas,
    'y el número publicado ES el de deltas', `${piso.cosine} / ${piso.cosine_deltas}`);
  ok(piso.cosine_observado === 0.2699,
    'el de LIBROS viaja al lado con su nombre — se guarda para comparar métodos, pero NO es el piso',
    String(piso.cosine_observado));
  ok(/NO se compara con los pisos entre libros/.test(piso.nota_metodo),
    'y la nota dice explícitamente que no se compara con los pisos entre libros');
  ok(piso.movimientos.claude === 3 && piso.movimientos.control === 2,
    'con cuántas decisiones tenía cada vector: un coseno entre dos vectores de una posición es aritmética, no una medición',
    JSON.stringify(piso.movimientos));
}

console.log('\n── con el MISMO libro sigue mandando el método viejo ──');
{
  const piso = pisoDeRuido({
    insignia: { enfoque: 'valor', posiciones_iniciales: ['NVDA'] },
    testigo: { enfoque: 'valor', posiciones_iniciales: ['NVDA'] },
    pesos: { claude: { NVDA: 0.1, AMD: 0.1 }, control: { NVDA: 0.1, AMD: 0.1 } },
    deltas: { claude: { AMD: 0.1 }, control: { AMD: 0.05, ZM: -0.02 } },
  });
  ok(piso.metodo === METODO_LIBROS && piso.cosine === 1,
    'cuando las dos cuentas arrancan igual, el piso entre LIBROS es el bueno y se publica ése');
  ok(piso.cosine_deltas != null,
    'y el de deltas se guarda igual — los dos números, siempre que se puedan',
    String(piso.cosine_deltas));
}

console.log('\n── el enfoque confunde LOS DOS métodos ──');
{
  const piso = pisoDeRuido({
    insignia: { enfoque: 'momentum', posiciones_iniciales: ['NVDA'] },
    testigo: { enfoque: 'valor', posiciones_iniciales: ['COP'] },
    pesos: { claude: { NVDA: 0.1 }, control: { COP: 0.1 } },
    deltas: { claude: { NVDA: 0.05 }, control: { COP: 0.05 } },
  });
  ok(piso.comparable === false && piso.metodo === null,
    'con enfoques distintos NO hay piso por ningún método: el enfoque cambia qué decide mover cada uno');
  ok(piso.cosine_deltas != null,
    'pero el número se guarda igual, para que la serie no tenga huecos donde sí hubo cálculo');
}

console.log('\n── cuando ni el delta alcanza, se dice por qué ──');
{
  const piso = pisoDeRuido({
    insignia: { enfoque: 'momentum', posiciones_iniciales: ['NVDA'] },
    testigo: { enfoque: 'momentum', posiciones_iniciales: ['COP', 'ZM'] },
    pesos: { claude: { NVDA: 0.1 }, control: { COP: 0.1 } },
    deltas: { claude: { NVDA: 0.05 }, control: {} },   // control no movió nada
  });
  ok(piso.comparable === false && /no cambió nada hoy/.test(piso.motivo),
    'si uno de los dos no movió nada, no hay deltas que comparar — y se dice, en vez de publicar un 0');
  ok(!/un reset las iguala/.test(piso.motivo),
    'y NO manda a resetear: ése era el consejo de antes y ahora sería el equivocado');
}

console.log('\n── las dos escalas tienen lecturas distintas ──');
{
  ok(/entre DELTAS/.test(lecturaDelPiso(0.62, METODO_DELTAS)),
    'la lectura de un piso por deltas se nombra como tal');
  ok(!/entre DELTAS/.test(lecturaDelPiso(0.62, METODO_LIBROS)),
    'y la de libros no');
  // 0.62 es MEDIO entre deltas y BAJO entre libros: el mismo número, dos
  // lecturas. Es la prueba de que compararlos sería un error.
  ok(/PISO MEDIO entre DELTAS/.test(lecturaDelPiso(0.62, METODO_DELTAS))
    && /PISO BAJO/.test(lecturaDelPiso(0.62, METODO_LIBROS)),
    'el MISMO 0.62 es MEDIO entre deltas y BAJO entre libros — por eso no se comparan');
  ok(/PISO NEGATIVO/.test(lecturaDelPiso(-0.4, METODO_DELTAS)),
    'y un coseno negativo tiene su propia lectura: uno compró lo que el otro vendió, que entre corridas idénticas es el resultado más fuerte posible');
}

console.log('\n── los dos números se ARCHIVAN ──');
{
  const shadow = readFileSync(new URL('../api/_lib/arena-shadow.js', import.meta.url), 'utf8');
  ok(/add column if not exists metodo text/.test(shadow)
    && /add column if not exists cosine_libros numeric/.test(shadow)
    && /add column if not exists cosine_deltas numeric/.test(shadow),
    'la tabla guarda el método y los DOS cosenos, con migración idempotente');
  ok(/metodo: r\.metodo \|\| 'libros'/.test(shadow),
    'y al leer, una fila vieja sin método se interpreta como "libros" — que es lo que era');
  ok(/cosine_libros, cosine_deltas\)/.test(shadow), 'el insert escribe los dos');
}

console.log('\n── y la página no deja confundirlos ──');
{
  const html = readFileSync(new URL('../libros.html', import.meta.url), 'utf8');
  ok(/entre DELTAS/.test(html) && /entre LIBROS/.test(html),
    'el método va en el TÍTULO del número, no en la letra chica');
  ok(/0\.76 y 0\.86/.test(html),
    'y nombra los pisos del 16 para decir explícitamente que no se comparan con éste');
  ok(/p\.cosine>=0\.7\?'solido':p\.cosine>=0\.3/.test(html),
    'con umbrales de color propios: 0.62 no puede pintarse igual en las dos escalas');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
