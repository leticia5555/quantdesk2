// ═══════════════════════════════════════════════════════════════
// tests/vocabulario-mx.test.mjs — dos palabras que no se usan así en México.
//
// "solapamiento" y "lente" son correctas en español y NO son las que se usan
// acá. La liga se lee en México: la métrica es **coincidencia** y lo que rota
// por agente y por día es el **enfoque**.
//
// Esto es un lint, no una preferencia de estilo, porque el modo de falla es
// silencioso: alguien copia un bloque viejo de la sombra a un endpoint nuevo,
// la clave vuelve a llamarse `solapamiento`, y la página —que lee
// `coincidencia`— dibuja un hueco sin que nada falle. Un término renombrado a
// medias es peor que no haberlo renombrado.
//
// ── LO QUE NO SE TOCA, Y POR QUÉ ─────────────────────────────────────
//   · `lens` en el almacenamiento (la columna `arena_noise_floor.lens` y
//     `context->>'lens'` del journal). Renombrar una columna es una migración,
//     y reescribir el journal de septiembre para que diga otra palabra
//     rompería el replay de las corridas que ya ocurrieron. Es inglés, además,
//     así que no compite con el término en español.
//   · `YOUR LENS TODAY` en el prompt de los agentes: está en inglés y no dice
//     "lente". Cambiarlo sería cambiar el prompt —o sea, el experimento— por
//     un motivo de traducción.
//   · docs/wheel-fase0.md y docs/congreso-fase0.md hablan de "solapamiento
//     transversal" y "solapamiento de fechas": ésa es otra cosa (estadística
//     de un backtest), está bien dicha, y no la ve el público de la liga.
//
// Correr con `node tests/vocabulario-mx.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const EXENTOS = new Set(['docs/wheel-fase0.md', 'docs/congreso-fase0.md']);
const PROHIBIDAS = [
  { re: /\bsolapamiento\b/i, malo: 'solapamiento', bueno: 'coincidencia' },
  { re: /\blentes?\b/i, malo: 'lente', bueno: 'enfoque' },
];

function archivos(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git' || n === '.vercel') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) archivos(p, out);
    else if (/\.(js|mjs|html|md)$/.test(n)) out.push(p);
  }
  return out;
}

console.log('\n── ni "solapamiento" ni "lente" en lo que se publica ──');
{
  const raices = ['api', 'tests', 'docs'];
  const sueltos = readdirSync('.').filter((n) => /\.html$/.test(n));
  const todos = [...raices.flatMap((r) => archivos(r)), ...sueltos];
  const hallazgos = [];
  for (const f of todos) {
    if (EXENTOS.has(f.replace(/\\/g, '/'))) continue;
    if (f.endsWith('tests/vocabulario-mx.test.mjs')) continue;   // este archivo las nombra para prohibirlas
    const lineas = readFileSync(f, 'utf8').split('\n');
    lineas.forEach((l, i) => {
      for (const p of PROHIBIDAS) {
        if (p.re.test(l)) hallazgos.push(`${f}:${i + 1} "${p.malo}" → "${p.bueno}"`);
      }
    });
  }
  ok(hallazgos.length === 0,
    'ninguna de las dos palabras sobrevive en la UI, los reportes ni los docs de la liga',
    hallazgos.slice(0, 12).join(' · '));
}

// ── Y LO QUE SÍ TIENE QUE SEGUIR AHÍ ─────────────────────────────────
console.log('\n── el almacenamiento y el prompt NO se renombraron ──');
{
  const shadow = readFileSync('api/_lib/arena-shadow.js', 'utf8');
  ok(/lens\s+text,/.test(shadow) && /insert into arena_noise_floor \(day, cosine, lens,/.test(shadow),
    'la columna `lens` sigue llamándose `lens`: renombrarla es una migración, y reescribir el journal de septiembre rompería el replay');
  const libros = readFileSync('api/liga-libros.js', 'utf8');
  ok(/'lens', context->>'lens'/.test(libros),
    'y el journal se sigue leyendo por `context->>\'lens\'` — el renombre es de la salida, no del dato guardado');
  ok(/enfoque: ctx\.lens/.test(libros),
    'la traducción ocurre al publicar: dato `lens` adentro, `enfoque` afuera');

  const herding = readFileSync('api/_lib/arena-herding.js', 'utf8');
  ok(/YOUR LENS TODAY/.test(herding),
    'el prompt de los agentes queda igual: está en inglés, no dice "lente", y cambiarlo sería cambiar el experimento por una traducción');
  ok(/id: 'momentum'/.test(herding) && /id: 'catalizador'/.test(herding),
    'y los ids de los cuatro enfoques tampoco cambian: son valores journaleados, no prosa');
}

// ═══════════════════════════════════════════════════════════════
// LOS SELLOS: "VIVA" Y "SOMBRA" NO VUELVEN A LA SUPERFICIE.
//
// ── POR QUÉ ESTA REGLA ES DE ALCANCE ACOTADO Y LA DE ARRIBA NO ───────
// "solapamiento" y "lente" se pueden prohibir en todo el repo: no nombran
// nada. "sombra" SÍ nombra algo — el subsistema entero (`arena-shadow.js`,
// `arena_shadow_journal`, `shadowBroker`, `runShadowAgent`) y páginas de
// documentación que lo explican bien. Prohibirla en todas partes obligaría a
// renombrar una tabla, que es una migración, y a reescribir prosa correcta.
//
// Lo que NO puede volver es la ETIQUETA: lo que se lee en la tarjeta, en el
// sello de la auditoría y en el valor de `fuente` que viaja en la respuesta.
// Por eso esta parte mira lugares concretos en vez de barrer el repo — una
// regla que no se puede cumplir se termina desactivando, y entonces no protege
// nada.
// ═══════════════════════════════════════════════════════════════
console.log('\n── los sellos: EN VIVO · PRUEBA · EN VIVO · SIN ENVIAR ──');
{
  const html = readFileSync('libros.html', 'utf8');
  const libros = readFileSync('api/liga-libros.js', 'utf8');
  const audit = readFileSync('api/_lib/arena-audit.js', 'utf8');

  // La página: ni una etiqueta vieja, ni como texto ni como clase.
  ok(!/>viva<|>sombra<|>seco<|>simulación</i.test(html),
    'la página no pinta ninguna etiqueta vieja');
  ok(!/\btag (viva|sombra|sim)\b/.test(html) && !/\bcard\.(viva|sombra)\b/.test(html),
    'ni quedan las clases viejas, que son por dónde vuelve el texto viejo');
  ok(/EN VIVO · SIN ENVIAR/.test(html) && /data-f="en_vivo"/.test(html) && /data-f="prueba"/.test(html),
    'y están los tres sellos nuevos, incluido el filtro');

  // El endpoint: los valores publicados de `fuente`.
  ok(/export const FUENTE_VIVA = 'en_vivo'/.test(libros) && /export const FUENTE_PRUEBA = 'prueba'/.test(libros),
    '`fuente` se publica con los nombres que se leen, no con el de la tabla');
  ok(/SELLOS = \{ en_vivo: 'EN VIVO', prueba: 'PRUEBA', sin_enviar: 'EN VIVO · SIN ENVIAR' \}/.test(libros),
    'y los tres sellos viven en UN solo lugar, del lado del servidor');
  ok(/viva: FUENTE_VIVA, sombra: FUENTE_PRUEBA/.test(libros),
    'los nombres viejos siguen aceptándose COMO ENTRADA: un curl guardado no se rompe porque la etiqueta cambie');

  // La auditoría dice lo mismo que la tarjeta.
  ok(/EN VIVO · SIN ENVIAR/.test(audit) && !/SIMULACIÓN/.test(audit),
    'la auditoría usa el mismo sello que la página — dos redacciones del mismo estado terminan difiriendo');
  ok(/'sin enviar'/.test(audit) && !/'seca'/.test(audit) && !/'simulación'/.test(audit),
    'incluso en la columna `estado` de la tabla de órdenes, que es la que se lee de un vistazo');
}

// ── Y LO QUE SIGUE LLAMÁNDOSE SOMBRA ─────────────────────────────────
console.log('\n── el subsistema conserva su nombre ──');
{
  const shadow = readFileSync('api/_lib/arena-shadow.js', 'utf8');
  ok(/arena_shadow_journal/.test(shadow),
    'la tabla sigue siendo `arena_shadow_journal`: renombrarla es una migración, y el renombre es de la etiqueta, no del dato');
  const libros = readFileSync('api/liga-libros.js', 'utf8');
  ok(/from arena_shadow_journal/.test(libros),
    'y el endpoint la sigue leyendo por su nombre real — la traducción ocurre al publicar');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
