// ═══════════════════════════════════════════════════════════════
// tests/arena-padron.test.mjs — QUIÉN ESTÁ INSCRIPTO NO ES QUIÉN CORRE HOY.
//
// Lo que queda de la sonda de ruta, que se retiró sin correr (los datos
// contestaron la pregunta antes — ver la lápida en arena-registry.js). Esto
// se queda porque no dependía de ella: fue el hallazgo que la sonda destapó
// de paso, y el más caro de los tres del barrido.
//
// EL CASO: hasta el 2026-09-25 toda entrada de `ARENA_AGENTS` era un
// competidor, así que medio repo usaba el array crudo para decir "los siete".
// Meter tres sondas —la primera entrada que NO competía— rompió cinco pruebas
// de un saque y, más caro, apagó `announceSeasonOpen`: 7 < 10, la apertura de
// la T3 no salía nunca. El id es idempotente y la T2 ya está sellada, así que
// nadie se habría enterado hasta noviembre.
//
// B41 en el registro. Esto es la MITAD QUE HACE TRABAJO de la norma: una
// función compartida sin una prueba que falle al divergir se vuelve a
// bifurcar en el próximo copy-paste.
//
// Correr con `node tests/arena-padron.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { ARENA_AGENTS, activeAgents, competidores, PROBE_IDS, esProbe } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) EL PADRÓN NO SE PREGUNTA AL ARRAY CRUDO ───────────────────────
// B41 en el registro. Hasta que entraron estas sondas, `ARENA_AGENTS` y "la
// liga" eran lo mismo, así que medio repo preguntaba por el array crudo. La
// primera entrada que NO era un competidor rompió cinco pruebas — y, más caro,
// apagó `announceSeasonOpen`: 7 < 10, la apertura de la T3 no salía nunca. El
// id es idempotente y la T2 ya está sellada, así que nadie se habría enterado
// hasta noviembre.
//
// Esto es la MITAD que hace trabajo de la norma: la función compartida sin una
// prueba que falle al divergir se vuelve a bifurcar en el próximo copy-paste.
console.log('\n── el padrón es una función, no un array ──');
{
  ok(competidores().length === 7 && !competidores().some((a) => a.probe),
    'competidores() son los siete inscritos, sin sondas', String(competidores().length));

  // Y es la pregunta que NO contesta activeAgents(). Un agente recortado por
  // ARENA_LEAGUE deja de correr hoy y sigue inscrito; una sonda nunca lo
  // estuvo. Fusionar las dos habría sido la misma bifurcación con otra ropa.
  const antes = process.env.ARENA_LEAGUE;
  process.env.ARENA_LEAGUE = 'claude,control';
  ok(activeAgents().length === 2 && competidores().length === 7,
    'con la parrilla recortada a dos, el padrón sigue siendo siete: son dos preguntas distintas',
    JSON.stringify([activeAgents().length, competidores().length]));
  if (antes === undefined) delete process.env.ARENA_LEAGUE; else process.env.ARENA_LEAGUE = antes;

  // El sitio que costaba caro, verificado en el fuente: la guarda de apertura
  // compara contra el padrón, no contra el array.
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const guarda = run.slice(run.indexOf('export async function announceSeasonOpen'));
  ok(/const padron = competidores\(\);/.test(guarda.slice(0, 900))
    && !/agents\.length < ARENA_AGENTS\.length/.test(guarda.slice(0, 900)),
    'announceSeasonOpen cuenta contra competidores(), no contra ARENA_AGENTS');
}

// ── 2) LA MAQUINARIA SIGUE EN PIE SIN SONDAS ─────────────────────────
// Hoy no hay ninguna, y `PROBE_IDS` es `[]`. Eso NO puede volver silenciosa la
// exclusión: el día que entre la próxima, tiene que quedar afuera de las
// pantallas sin que nadie se acuerde de tocar la consulta.
console.log('\n── sin sondas hoy, con la puerta cerrada igual ──');
{
  ok(PROBE_IDS.length === 0 && !esProbe('claude'),
    'hoy el registry no tiene sondas: la lista está vacía y nadie es una', JSON.stringify(PROBE_IDS));
  ok(competidores().length === ARENA_AGENTS.length,
    'así que padrón y array crudo coinciden — y por eso mismo esta prueba importa: el bug NO se ve cuando coinciden');

  // Un registry SINTÉTICO con una sonda adentro. Se prueba la regla, no el
  // contenido de hoy: si la verificación dependiera de que exista una sonda
  // real, al retirarla nos quedábamos sin guarda justo cuando hace falta.
  const conSonda = [...ARENA_AGENTS, { id: 'x', probe: true, enabled: false }];
  const padron = conSonda.filter((a) => !a.probe);
  ok(padron.length === 7 && !padron.some((a) => a.probe),
    'con una sonda en el array, el padrón sigue siendo siete: es el filtro que arregló la apertura');

  const libros = readFileSync(new URL('../api/liga-libros.js', import.meta.url), 'utf8');
  ok((libros.match(/agent_id <> all\(\$2::text\[\]\)/g) || []).length === 2,
    'las DOS consultas de /liga/libros siguen excluyendo la lista: una sola dejaría la mitad a la vista');
  ok(/PROBE_IDS/.test(libros), 'y usan la lista del registry, no una copia de los ids');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
