// ═══════════════════════════════════════════════════════════════
// tests/arena-cadencia.test.mjs — B4: las tres rondas fijas y la nocturna.
//
// Lo que se blinda:
//
//   1. LAS RONDAS SE DERIVAN DE LA SESIÓN, no de una hora UTC. Tres crons de
//      Vercel serían tres horas fijas, y el horario del mercado no lo es:
//      cambia con el horario de verano, y una media sesión o una apertura
//      retrasada dejarían los tres apuntando a momentos que no existen.
//   2. IDEMPOTENCIA POR DÍA. El tick es de 5 minutos: sin ella, los seis ticks
//      que quedan de esa media hora dispararían seis rondas.
//   3. LA RED DE RIESGO AL PRIMER TICK. Antes corría a la apertura+30: media
//      hora en la que un stop ya disparado no se ejecutaba, y un gap de
//      apertura es exactamente cuando más falta hace.
//   4. EL CAMBIO DE CONTRATO DE LA NOCTURNA. Al volverse reporte, el "plan
//      anterior" deja de ser el suyo y pasa a ser el de la última ronda fija.
//      Sin ese filtro el PM construye sobre una crónica del día que pasó.
//
// Correr con `node tests/arena-cadencia.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { FIXED_ROUNDS, fixedRoundDue, riskNetDue, sessionPhase } from '../api/_lib/arena-watch.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const abierta = (desdeApertura, alCierre) => ({ open: true, reason: 'open', minutes_since_open: desdeApertura, minutes_to_close: alCierre });

console.log('\n── las tres rondas ──');
{
  ok(FIXED_ROUNDS.length === 3, 'son tres', String(FIXED_ROUNDS.length));
  ok(FIXED_ROUNDS.map((r) => r.id).join(',') === 'open_30,midday,close_30', 'apertura+30, mediodía, cierre−30');
}

console.log('\n── 1) se derivan de la SESIÓN, no de una hora UTC ──');
{
  // Sesión normal: 9:30-16:00 ET.
  ok(fixedRoundDue({ phase: abierta(10, 380), easternMinutes: 9 * 60 + 40, done: new Set() }) === null,
    'a los 10 minutos de sesión todavía no toca ninguna');
  ok(fixedRoundDue({ phase: abierta(32, 358), easternMinutes: 10 * 60 + 2, done: new Set() }).id === 'open_30',
    'a los 32 dispara la de apertura+30 (el tick es de 5 min: no cae en el minuto exacto)');
  ok(fixedRoundDue({ phase: abierta(155, 235), easternMinutes: 12 * 60 + 5, done: new Set(['open_30']) }).id === 'midday',
    'pasadas las 12:00 ET dispara la del mediodía');
  ok(fixedRoundDue({ phase: abierta(360, 25), easternMinutes: 15 * 60 + 35, done: new Set(['open_30', 'midday']) }).id === 'close_30',
    'a 25 minutos del cierre dispara la de cierre−30');

  // MEDIA SESIÓN (cierre a las 13:00 ET). Con crons de hora fija, el cierre−30
  // habría caído fuera de la sesión; derivado del calendario, cae donde debe.
  ok(fixedRoundDue({ phase: abierta(180, 20), easternMinutes: 12 * 60 + 40, done: new Set(['open_30', 'midday']) }).id === 'close_30',
    'MEDIA SESIÓN: el cierre−30 cae donde tiene que caer sin tocar nada — con un cron de hora fija habría caído fuera de la sesión');

  ok(fixedRoundDue({ phase: { open: false }, easternMinutes: 600, done: new Set() }) === null, 'con el mercado cerrado, ninguna');
  ok(fixedRoundDue({ phase: null, done: new Set() }) === null, 'sin fase, ninguna (no revienta)');
}

console.log('\n── 2) idempotencia: una ronda por tipo por día ──');
{
  const done = new Set();
  const r1 = fixedRoundDue({ phase: abierta(32, 358), easternMinutes: 10 * 60 + 2, done });
  done.add(r1.id);
  // Los seis ticks siguientes de esa media hora NO deben volver a disparar.
  for (let t = 0; t < 6; t++) {
    const otra = fixedRoundDue({ phase: abierta(35 + t * 5, 355 - t * 5), easternMinutes: 10 * 60 + 5 + t * 5, done });
    ok(otra === null || otra.id !== 'open_30',
      `tick +${t * 5}min: no se re-dispara open_30 — sin idempotencia serían seis rondas en media hora`);
  }
}

console.log('\n── el orden: no se saltea una ronda por llegar tarde ──');
{
  // Si el vigilante estuvo caído y vuelve a las 12:30 sin haber corrido la de
  // apertura, corre esa PRIMERO: son rondas distintas con propósitos distintos.
  const r = fixedRoundDue({ phase: abierta(180, 210), easternMinutes: 12 * 60 + 30, done: new Set() });
  ok(r.id === 'open_30',
    'volviendo tarde con ninguna corrida, sale primero la de apertura: la deuda se paga en orden, no se descarta', r.id);
}

console.log('\n── 3) la red de riesgo, al PRIMER tick ──');
{
  ok(riskNetDue({ phase: abierta(1, 389), done: false }) === true,
    'al minuto 1 de sesión la red ya corre — antes esperaba a la apertura+30, media hora en la que un stop ya disparado no se ejecutaba');
  ok(riskNetDue({ phase: abierta(1, 389), done: true }) === false, 'y una vez corrida, no se repite');
  ok(riskNetDue({ phase: { open: false }, done: false }) === false, 'con el mercado cerrado, no');
}

// ── 4) EL CONTRATO DE LA NOCTURNA ────────────────────────────────────
console.log('\n── 4) la nocturna es REPORTE: su texto no se reinyecta como plan ──');
{
  const src = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const i = src.indexOf("select run_date, plan, actions, status from arena_journal");
  ok(i !== -1, 'se encuentra la consulta del plan anterior');
  const cuerpo = src.slice(i, src.indexOf('`', i));
  ok(/'report'/.test(cuerpo) && /'nightly_report'/.test(cuerpo),
    'el reporte nocturno queda FUERA del plan anterior: si entrara, el PM de la apertura construiría sobre una crónica del día que pasó, no sobre una decisión',
    cuerpo.replace(/\s+/g, ' ').slice(0, 200));
  ok(/'rules_changed'/.test(cuerpo), 'y siguen fuera las filas operativas de siempre');
}

console.log('\n── sessionPhase: de dónde salen los minutos ──');
{
  const sesion = { open: '09:30', close: '16:00' };
  const p = sessionPhase(new Date('2026-09-16T14:05:00Z'), sesion);   // 10:05 ET
  ok(p.open === true && p.minutes_since_open === 35, 'minutos desde la apertura, del calendario REAL', String(p.minutes_since_open));
  ok(p.minutes_to_close === 355, 'y los que faltan para el cierre', String(p.minutes_to_close));
  const cerrado = sessionPhase(new Date('2026-09-16T12:00:00Z'), sesion);   // 8:00 ET
  ok(cerrado.open === false && cerrado.reason === 'pre_market', 'antes de la apertura, cerrado', cerrado.reason);
  ok(sessionPhase(new Date(), null).open === false, 'sin sesión (festivo), cerrado');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
