// ═══════════════════════════════════════════════════════════════
// tests/arena-inicio-temporada.test.mjs — LA TEMPORADA EMPIEZA EL DÍA
// QUE PASA LA PUERTA.
//
// EL CASO: `ARENA_SEASON.start` era una constante en el código, así que cada
// corrimiento de la apertura pedía un deploy — **y el deploy es el paso que
// falló el 29 de septiembre** y dejó a la liga corriendo un día entero contra
// los libros de la T2. En una semana la T3 tuvo CINCO fechas.
//
// Y el 2 de octubre quedó a la vista lo peor: la constante decía
// `2026-10-01`, así que `/liga` reportaba **"temporada T3, running, día 1"**
// sin que el reset hubiera corrido nunca. Los libros eran los de la T2 y el
// tablero decía día 1 de la T3.
//
// > **Una fecha escrita a mano se vuelve falsa sola, con solo que pase el
// > tiempo.** No hace falta que nadie se equivoque.
//
// Lo que fija:
//   1. SIN RESET, LA TEMPORADA NO ESTÁ ABIERTA. `abierta: false`, y eso es un
//      dato publicable — no un hueco.
//   2. EL RESET LA ESCRIBE, Y ES IDEMPOTENTE. Un segundo reset dentro de la
//      misma temporada NO mueve el día 1.
//   3. SI ABRIÓ TARDE, SE DICE CUÁNTO. La ventana se corrió y `weeks` ya no
//      cuadra: se declara en vez de recalcularse en silencio.
//   4. `/liga` CUENTA DESDE EL INICIO REAL, no desde la constante.
//
// Correr con `node tests/arena-inicio-temporada.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { ARENA_SEASON, temporadaEfectiva, seasonStatus, seasonDay } from '../api/_lib/arena-registry.js';
import { claveInicioTemporada } from '../api/_lib/arena-baseline.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}
const leer = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── 1) DECLARADA NO ES ABIERTA ───────────────────────────────────────
console.log('\n── sin reset, la temporada no está abierta ──');
{
  const t = temporadaEfectiva(null);
  ok(t.abierta === false, 'sin inicio escrito, `abierta: false`');
  ok(t.start === ARENA_SEASON.start && t.start_planeado === ARENA_SEASON.start,
    'la ventana cae a la fecha PLANEADA, que se publica aparte', `${t.start} / ${t.start_planeado}`);

  // Ésta es la propiedad que faltaba el 2-oct: poder distinguir las dos.
  ok(Object.prototype.hasOwnProperty.call(t, 'abierta'),
    'y la distinción viaja en el objeto: "declarada" y "abierta" dejaron de verse iguales');
}

// ── 2) EL RESET LA ESCRIBE, Y NO LA MUEVE DOS VECES ──────────────────
console.log('\n── idempotente, como el benchmark ──');
{
  const baseline = leer('api/_lib/arena-baseline.js');
  const fn = baseline.slice(baseline.indexOf('export async function marcarInicioTemporada'));
  ok(/const ya = await readFlag\(clave\);\s*\n\s*if \(ya && ya\.value && ya\.value\.start\) return/.test(fn.slice(0, 700)),
    'lee ANTES de escribir: un segundo reset no mueve el día 1');
  ok(/ya_estaba: true/.test(fn.slice(0, 700)),
    'y lo dice, para que el reset pueda reportarlo en vez de callarlo');
  ok(claveInicioTemporada('T3') !== claveInicioTemporada('T4'),
    'la clave lleva la temporada: la T4 escribe la suya sin pisar la T3',
    `${claveInicioTemporada('T3')} vs ${claveInicioTemporada('T4')}`);

  const reset = leer('api/arena-reset.js');
  ok(/out\.inicio_temporada = await marcarInicioTemporada\(ARENA_SEASON\.id, now\)/.test(reset),
    'el reset la escribe');
  // DESPUÉS del anuncio: si el journal falló, la temporada no se marca abierta.
  ok(reset.indexOf('out.journaled = true') < reset.indexOf('marcarInicioTemporada(ARENA_SEASON.id'),
    'y después de journalear: un reset que no dejó rastro no abre temporada');
  ok(/La fecha la escribe él|la temporada empieza el día que pasa la puerta/i.test(baseline),
    'con el motivo escrito al lado');
}

// ── 3) SI ABRIÓ TARDE, SE DICE CUÁNTO ────────────────────────────────
// Un reset que corre cuatro días después de lo planeado deja una temporada
// más corta que la que `weeks` declara. Recalcular `weeks` en silencio sería
// tapar el corrimiento; declararlo deja la resta a la vista.
console.log('\n── una apertura tardía no se disimula ──');
{
  const tarde = temporadaEfectiva({ start: '2026-10-05' });
  ok(tarde.abierta === true && tarde.start === '2026-10-05', 'manda el inicio real');
  ok(tarde.corrida_dias === 4, 'y se publica cuántos días se corrió contra lo planeado', String(tarde.corrida_dias));

  const aTiempo = temporadaEfectiva({ start: ARENA_SEASON.start });
  ok(aTiempo.corrida_dias === 0, 'abrir en la fecha planeada no reporta corrimiento');

  // Un reset ANTERIOR a lo planeado no da días negativos.
  const temprano = temporadaEfectiva({ start: '2026-09-28' });
  ok(temprano.corrida_dias === 0, 'y un inicio anterior tampoco: no hay corrimientos negativos', String(temprano.corrida_dias));
}

// ── 4) EL CASO DEL 2 DE OCTUBRE, REPRODUCIDO ─────────────────────────
// Con la constante en `2026-10-01` y hoy 2-oct, `seasonStatus` dice `running`
// y `seasonDay` dice 1 — sin que el reset hubiera corrido. La función pura NO
// cambia (no sabe de la DB); lo que cambia es que ahora hay un campo que
// permite NO creerle.
console.log('\n── el 2-oct: "running, día 1" sin reset ──');
{
  const dosDeOctubre = new Date('2026-10-02T18:00:00Z');
  ok(seasonStatus(dosDeOctubre, { ...ARENA_SEASON, start: '2026-10-01' }) === 'running'
    && seasonDay(dosDeOctubre, { ...ARENA_SEASON, start: '2026-10-01' }) === 2,
    'la fecha del calendario sigue diciendo que corre: eso NO se puede arreglar desde una función pura');
  ok(temporadaEfectiva(null).abierta === false,
    'lo que se arregla es tener con qué contradecirla: `abierta: false`');
}

// ── 5) /liga CUENTA DESDE EL INICIO REAL ─────────────────────────────
console.log('\n── el tablero usa el inicio escrito, no la constante ──');
{
  const api = leer('api/leaderboard.js');
  ok(/temporadaEfectiva\(await leerInicioTemporada\(ARENA_SEASON\.id\)\)/.test(api),
    'el leaderboard lee el inicio de la DB');
  ok(/\[temporada\.start\]\)/.test(api) && !/\[ARENA_SEASON\.start\]\)/.test(api),
    'y la ventana de la consulta sale de ahí, no de la constante');
  ok(/temporada,/.test(api), 'y la publica, con `abierta` adentro');
  ok(/cae a la planeada|catch \{/.test(api),
    'si la DB no contesta cae a la planeada en vez de romper el tablero');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
