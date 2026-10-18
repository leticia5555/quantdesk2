// ═══════════════════════════════════════════════════════════════
// tests/arena-ventana-temporada.test.mjs — EL DÍA 1 LA PANTALLA NO ESTÁ
// VACÍA: ESTÁ MOSTRANDO LA TEMPORADA ANTERIOR.
//
// Yo había recomendado dejar las ventanas como estaban, con el argumento de
// que el día 1 `?dias=3` no tiene nada que mostrar. Lety: «Tu B parte de una
// premisa falsa: el día 1 la pantalla NO está vacía. Con ?dias=3 muestra la
// corrida contaminada del 29-sep como si fuera la temporada.» Tenía razón —
// el 29-sep corrió con el reglamento a medio cambiar (`corrio_contaminado`) y
// cae dentro de los 3 días del arranque de la T3.
//
// LA RESPUESTA A SU PREGUNTA (cuál de los dos casos es `api/liga-libros.js`):
// es el PRIMERO. Hay UN SOLO `desde`; las dos consultas (viva y prueba) lo
// toman como `$1::date`, y las cinco secciones de la respuesta (`por_dia`,
// `deslizamiento`, `herramientas`, `coincidencia` y el piso de ruido) se
// derivan en JS del MISMO array `libros`. No hay cinco ventanas que acotar.
// Por eso el arreglo es una línea, y esto es lo que la fija.
//
// LO QUE ESTE ARCHIVO FIJA:
//   1. EL PISO GANA sobre `?dias=N`, con cualquier N hasta el máximo.
//   2. Y NO AL REVÉS: una ventana corta dentro de la temporada se respeta. El
//      piso acota hacia atrás, no estira hacia adelante.
//   3. SIGUE SIENDO UNA SOLA VENTANA. Si alguien agrega un segundo `desde`,
//      esto se pone rojo: el arreglo de una línea deja de ser suficiente y hay
//      que saberlo en ese commit, no el día de la apertura.
//   4. LA VENTANA SE DECLARA. Una ventana acotada en silencio y una temporada
//      sin corridas se ven idénticas: las dos muestran menos filas.
//
// Correr con `node tests/arena-ventana-temporada.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { effectiveCutoff } from '../api/_lib/arena-baseline.js';
import { ARENA_SEASON, TEMPORADA_DIAS_CONTAMINADOS } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const FUENTE = readFileSync('api/liga-libros.js', 'utf8');
// La ventana, tal cual la calcula el handler.
const ventana = (dias, hoy, piso) => effectiveCutoff(
  piso,
  new Date(Date.parse(hoy + 'T12:00:00Z') - dias * 86400000).toISOString().slice(0, 10),
);

// ── 1) EL PISO GANA ──────────────────────────────────────────────────
console.log('\n── ?dias=N no puede mirar antes del arranque ──');
{
  const piso = ARENA_SEASON.start;       // '2026-10-01'
  // El día 1, con el default.
  ok(ventana(3, '2026-10-01', piso) === piso,
    'día 1 con ?dias=3: la ventana arranca en el inicio, no tres días antes', ventana(3, '2026-10-01', piso));

  // Y con CUALQUIER N, no sólo el default: el máximo del endpoint es 30.
  let todas = true;
  for (let n = 1; n <= 30; n++) if (ventana(n, '2026-10-01', piso) < piso) todas = false;
  ok(todas, 'con ?dias de 1 a 30 (el máximo del endpoint), nunca pasa del piso');

  // EL CASO CONCRETO que Lety nombró: el 29-sep queda afuera.
  const contaminados = Object.keys(TEMPORADA_DIAS_CONTAMINADOS || {});
  ok(contaminados.length > 0, 'hay días contaminados declarados', contaminados.join(','));
  const dentro = contaminados.filter((d) => d >= ventana(3, '2026-10-01', piso));
  ok(dentro.length === 0, 'y ninguno cae dentro de la ventana del día 1', dentro.join(',') || 'ninguno');
}

// ── 2) EL PISO ACOTA, NO ESTIRA ──────────────────────────────────────
console.log('\n── una ventana corta dentro de la temporada se respeta ──');
{
  const piso = '2026-10-01';
  ok(ventana(3, '2026-10-20', piso) === '2026-10-17',
    '?dias=3 el día 20 sigue siendo 3 días, no 20', ventana(3, '2026-10-20', piso));
  ok(ventana(30, '2026-10-20', piso) === piso,
    'y ?dias=30 el día 20 se acota al arranque', ventana(30, '2026-10-20', piso));
}

// ── 3) EL ARRANQUE REAL MANDA SOBRE EL DECLARADO ─────────────────────
console.log('\n── una temporada "abierta" en la config y nunca reseteada no empezó ──');
{
  // Si el reset marcó el arranque más tarde que lo declarado, ése es el piso:
  // lo que corrió antes del reset corrió contra baselines viejos.
  ok(ventana(30, '2026-10-20', '2026-10-05') === '2026-10-05',
    'el arranque real (más tarde) gana sobre el declarado', ventana(30, '2026-10-20', '2026-10-05'));
  ok(/leerInicioTemporada/.test(FUENTE), 'y el handler lo LEE de arena_flags, no lo supone');
  // Después de la LLAMADA (la última aparición), no después del import.
  ok(/catch[\s\S]{0,400}avisos\.push\(/.test(FUENTE.split('leerInicioTemporada').pop().slice(0, 500)),
    'si esa lectura falla, se REPORTA: un piso que falla en silencio deja la ventana abierta hacia atrás');
}

// ── 4) SIGUE SIENDO UNA SOLA VENTANA ─────────────────────────────────
console.log('\n── el arreglo de una línea deja de servir si aparece un segundo `desde` ──');
{
  // Una sola declaración de `desde` …
  const decls = (FUENTE.match(/\bconst\s+desde\s*=/g) || []).length;
  ok(decls === 1, 'hay exactamente UNA declaración de `desde`', String(decls));
  // … y sale de `effectiveCutoff`, no de un `Date.now()` suelto.
  ok(/const\s+desde\s*=\s*effectiveCutoff\(/.test(FUENTE),
    'y sale de `effectiveCutoff`, no de un `Date.now() - dias` crudo');
  // Las dos consultas lo toman como el MISMO parámetro.
  const usos = (FUENTE.match(/run_date\s*>=\s*\$1::date/g) || []).length;
  ok(usos === 2, 'las dos consultas (viva y prueba) usan `run_date >= $1::date`', String(usos));
  // Y ninguna otra resta de días quedó suelta en el archivo.
  const sueltas = (FUENTE.match(/Date\.now\(\)\s*-\s*\w*\s*\*\s*86400000/g) || []).length;
  ok(sueltas === 1, 'y hay UNA sola resta de días en todo el archivo (la del pedido)', String(sueltas));
}

// ── 5) LA VENTANA SE DECLARA ─────────────────────────────────────────
console.log('\n── acotada en silencio se lee igual que "no hay corridas" ──');
{
  for (const campo of ['desde_pedido', 'acotada', 'inicio_temporada', 'inicio_temporada_fuente']) {
    ok(FUENTE.includes(campo), `la respuesta publica \`${campo}\``);
  }
}

console.log(failures ? `\n${failures} FALLARON\n` : '\nTODO VERDE\n');
process.exit(failures ? 1 : 0);
