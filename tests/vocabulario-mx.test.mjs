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

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
