// ═══════════════════════════════════════════════════════════════════
// tests/crons-declarados.test.mjs — que ningún cron quede sin agendar,
// y que ningún cron agendado quede sin vigilar.
//
// EL BUG QUE CIERRA. `bmv_precios` se quedó en el 15-sep y nadie se enteró
// hasta que `?job=unidades` puso G2 en 2/15 seis días después. No fue un
// cron que murió: NUNCA HUBO CRON. La cosecha de Fase 1b se corrió a mano,
// y a mano no se repite todos los días.
//
// Y la mitad simétrica: `arena:universe` SÍ estaba agendado y SÍ latía, pero
// no estaba en `EXPECTED`, así que salía en `untracked` — una lista que no
// pone nada en rojo. Un cron vigilado en una lista que nadie mira no está
// vigilado.
// ═══════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXPECTED, SIN_VIGILANCIA } from '../api/cron-status.js';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
const workflow = readFileSync(new URL('../.github/workflows/external-crons.yml', import.meta.url), 'utf8');

const crons = vercel.crons || [];
const exentos = new Set(SIN_VIGILANCIA.map((x) => x.path));

test('todo cron de vercel.json está vigilado o exento CON MOTIVO', () => {
  const huerfanos = [];
  for (const c of crons) {
    if (exentos.has(c.path)) continue;
    if (!EXPECTED.some((e) => e.path === c.path)) huerfanos.push(c.path);
  }
  assert.deepEqual(huerfanos, [], `sin entrada en EXPECTED de api/cron-status.js: ${huerfanos.join(', ')}`);
});

test('la exención declara su porqué, no sólo su path', () => {
  for (const x of SIN_VIGILANCIA) {
    assert.ok(x.path, 'una exención sin path no exime a nadie');
    assert.ok(x.porque && x.porque.length > 30, `la exención de ${x.path} no explica nada`);
    assert.ok(crons.some((c) => c.path === x.path), `${x.path} está exento pero no es un cron de vercel.json`);
  }
});

test('el schedule vigilado es el schedule agendado', () => {
  const discrepan = [];
  for (const e of EXPECTED) {
    if (e.vive_en === 'github-actions') continue;
    const c = crons.find((x) => x.path === e.path);
    if (!c) continue;
    if (c.schedule !== e.schedule) discrepan.push(`${e.job}: vercel.json dice "${c.schedule}" y cron-status "${e.schedule}"`);
  }
  assert.deepEqual(discrepan, []);
});

test('lo vigilado que NO está en vercel.json vive en GitHub Actions y se dice', () => {
  for (const e of EXPECTED) {
    if (crons.some((c) => c.path === e.path)) continue;
    assert.equal(e.vive_en, 'github-actions',
      `${e.job} no está en vercel.json y tampoco declara dónde vive: o se agenda o se quita de EXPECTED`);
    assert.ok(workflow.includes(e.path.split('?')[0]),
      `${e.job} dice vivir en Actions pero el workflow no lo menciona`);
  }
});

test('la cosecha diaria de precios BMV está agendada, que es de lo que se trataba', () => {
  const c = crons.find((x) => x.path === '/api/bmv-harvest?job=precios');
  assert.ok(c, 'sin este cron, bmv_precios sólo avanza cuando alguien se acuerda a mano');
  // Después del cierre de la BMV (15:00 CDMX = 21:00 UTC), no antes.
  const [, hora] = c.schedule.split(' ');
  assert.ok(Number(hora) >= 21, `pedir el cierre a las ${hora}:00 UTC es pedirlo antes de que exista`);
  const e = EXPECTED.find((x) => x.job === 'bmv:precios');
  assert.ok(e, 'agendado pero sin vigilancia: el modo de falla de xbrl-capture');
});
