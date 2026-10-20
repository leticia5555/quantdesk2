// ═══════════════════════════════════════════════════════════════
// tests/arena-prompt-borrador.test.mjs — el borrador «¿la comprarías hoy?».
//
// El borrador vive en docs/arena-prompt-borrador-comprarias-hoy.md y NO está
// activado. Esta prueba fija las dos cosas que lo hacen útil mañana:
//
//   1. NO ESTÁ ACTIVO: la línea no está en el prompt que corre. Activarlo es
//      una decisión con Lety, no un efecto colateral de un merge.
//   2. NO SE PUDRE: el contexto del diff sigue existiendo en arena-run.js. Si
//      alguien cambia esas líneas, el borrador deja de aplicar y esta prueba lo
//      dice HOY, no el día que se quiera activar.
//
// Correr con `node tests/arena-prompt-borrador.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const doc = readFileSync(new URL('../docs/arena-prompt-borrador-comprarias-hoy.md', import.meta.url), 'utf8');
const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');

const m = /```diff\n([\s\S]*?)```/.exec(doc);
ok(!!m, 'el doc trae el diff');
const lineas = (m ? m[1] : '').split('\n');
const nuevas = lineas.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
const contexto = lineas.filter((l) => l.startsWith(' ')).map((l) => l.slice(1));
const quitadas = lineas.filter((l) => l.startsWith('-') && !l.startsWith('---'));

console.log('\n── 1) no está activo ──');
ok(nuevas.length === 1 && /JUSTIFIED AS A NEW BUY/.test(nuevas[0]), 'el borrador agrega UNA línea', String(nuevas.length));
ok(quitadas.length === 0, 'y no quita ninguna');
ok(!run.includes(nuevas[0] || '\u0000'), 'la línea NO está en el prompt que corre');
ok(/NO ACTIVADO/.test(doc), 'el doc dice que no está activado');

console.log('\n── 2) sigue aplicando ──');
ok(contexto.length >= 3, 'hay contexto suficiente para ubicarlo', String(contexto.length));
const bloque = contexto.join('\n');
// El contexto, en orden y contiguo, tal como lo espera el diff.
const antes = lineas.slice(lineas.findIndex((l) => l.startsWith('@@')) + 1).filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1)).join('\n');
ok(run.includes(antes), 'las líneas de contexto existen, contiguas, en arena-run.js: el borrador aplica', bloque.slice(0, 120));
const aplicado = run.replace(antes, lineas.slice(lineas.findIndex((l) => l.startsWith('@@')) + 1)
  .filter((l) => l.startsWith(' ') || l.startsWith('+')).map((l) => l.slice(1)).join('\n'));
ok(aplicado !== run && aplicado.includes(nuevas[0]), 'y aplicado, la línea queda dentro del prompt');
ok(aplicado.indexOf(nuevas[0]) > aplicado.indexOf('WILL BE SOLD. Restate everything you want to keep.')
  && aplicado.indexOf(nuevas[0]) < aplicado.indexOf('Trading more is not the objective.'),
'en el lugar pensado: después de "lo que no nombrás se vende", antes del cierre');

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
