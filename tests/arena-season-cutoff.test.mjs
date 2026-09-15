// ═══════════════════════════════════════════════════════════════
// tests/arena-season-cutoff.test.mjs — la memoria se corta en la temporada (A4a).
//
// DOS bugs distintos, la misma causa: ninguna de las cuatro consultas de
// memoria que alimentan el prompt tenía corte por temporada.
//
//   (a) EL PM RECUERDA OTRA TEMPORADA. El plan anterior salía del último
//       `decide` sin importar de qué temporada, y los fills miraban 180 días.
//       El 14 —primer día de la T2— eso significaba reinyectar el cierre de la
//       T1 sobre un libro ya aplanado. Un "ZM filled at $95.5" narrado sobre un
//       libro sin ZM tiene exactamente esa forma.
//   (b) EL BREAKER MATA AL AGENTE EL DÍA DEL RESET. El pico de equity
//       (`max(account->>'equity')`) no tenía corte: tras aplanar a $100k desde
//       un pico de $130k, el drawdown calculado es −23% → corte amplio y el
//       agente HALTED en su primera corrida. Esto habría pasado el lunes 21.
//
// Esta suite lee el SQL real de api/arena-run.js y verifica que las cuatro
// consultas lleven el corte. Es un lint de consulta, no un mock de Neon: lo que
// hay que garantizar es que nadie escriba una quinta consulta de memoria sin
// corte, y eso se ve en el texto del SQL.
// Correr con `node tests/arena-season-cutoff.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARENA_SEASON } from '../api/_lib/arena-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'api/arena-run.js'), 'utf8');

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Las cuatro consultas, por una firma única de cada una.
const CONSULTAS = [
  { nombre: 'plan anterior reinyectado', firma: "select run_date, plan, actions, status from arena_journal" },
  { nombre: 'pico de equity del breaker', firma: "select max((account->>'equity')::numeric) as peak" },
  { nombre: 'fills para reconstruir aperturas', firma: 'select run_date, actions from arena_journal' },
  { nombre: 'compromisos abiertos', firma: "select run_date, context->'commitments' as commitments" },
];

console.log('corte por temporada en las cuatro consultas de memoria');
for (const c of CONSULTAS) {
  const i = SRC.indexOf(c.firma);
  ok(i !== -1, `se encuentra la consulta: ${c.nombre}`);
  if (i === -1) continue;
  // El cuerpo del template literal hasta el backtick de cierre.
  const cuerpo = SRC.slice(i, SRC.indexOf('`', i));
  ok(/run_date\s*>=\s*\$\d+::date/.test(cuerpo),
    `${c.nombre}: corta con run_date >= $n::date`, cuerpo.replace(/\s+/g, ' ').slice(0, 160));
}

console.log('\nla fecha del corte sale del registry, no de un literal');
{
  ok(/const SEASON_CUTOFF = ARENA_SEASON\.start;/.test(SRC),
    'SEASON_CUTOFF se deriva de ARENA_SEASON.start');
  ok(!/run_date >= '20\d\d-\d\d-\d\d'/.test(SRC),
    'ninguna consulta tatúa una fecha de temporada como literal');
  ok(typeof ARENA_SEASON.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ARENA_SEASON.start),
    'ARENA_SEASON.start es una fecha ISO usable como corte', ARENA_SEASON.start);
}

console.log('\nel corte se pasa como parámetro, no interpolado');
{
  // Interpolar una fecha en el SQL sería inyección aunque hoy venga de una
  // constante nuestra: el día que alguien la haga configurable por env, deja de
  // serlo. Se comprueba que SEASON_CUTOFF viaje en el array de parámetros.
  const usos = SRC.split('SEASON_CUTOFF').length - 1;
  ok(usos >= 5, 'SEASON_CUTOFF se usa en la definición y en las cuatro consultas', String(usos));
  ok(!/\$\{SEASON_CUTOFF\}/.test(SRC), 'SEASON_CUTOFF nunca se interpola dentro del SQL');
}

console.log('\nel pico del breaker: por qué el corte lo salva del reset');
{
  // No hace falta Neon para razonarlo: si el pico incluye la temporada
  // anterior, el drawdown del primer día es (pico_viejo − 100k)/pico_viejo.
  const picoViejo = 130000, equityReset = 100000;
  const drawdownSinCorte = (picoViejo - equityReset) / picoViejo;
  ok(drawdownSinCorte >= 0.20,
    'sin corte, un pico de $130k contra un reset a $100k da −23% → corte amplio y HALT el primer día',
    (drawdownSinCorte * 100).toFixed(1) + '%');
  // Con corte, el pico del primer día ES el equity del primer día → drawdown 0.
  const drawdownConCorte = (equityReset - equityReset) / equityReset;
  ok(drawdownConCorte === 0, 'con corte, el pico del primer día es el equity del primer día → drawdown 0');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : `\n${failures} FAIL`);
process.exit(failures ? 1 : 0);
