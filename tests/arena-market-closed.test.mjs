// ═══════════════════════════════════════════════════════════════
// tests/arena-market-closed.test.mjs — marketClosedReason() puro, con el
// calendario de Alpaca INYECTADO (sin red). Cubre:
//   - mercado abierto (el calendario trae sesión hoy),
//   - festivo entre semana (calendario vacío en día hábil) → el valor real que
//     este chequeo agrega sobre el cron `40 22 * * 1-5`,
//   - fin de semana en un dispatch manual (etiqueta informativa, mismo skip),
//   - fail-OPEN ante calendario caído (no perder un día del experimento),
//   - corrección de fecha ET vs UTC (medianoche-UTC del sábado que en ET es el
//     viernes hábil): el calendario se consulta y se etiqueta por la fecha ET.
// Correr con `node tests/arena-market-closed.test.mjs`; sale ≠ 0 si algo falla.
// ═══════════════════════════════════════════════════════════════

import { marketClosedReason } from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) { console.log('  PASS ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// Calendarios inyectados (ignoran las creds; cero red).
const calOpen = async () => [{ date: '2026-08-05', open: '09:30', close: '16:00' }];
const calEmpty = async () => [];
const calThrows = async () => { throw new Error('Alpaca 503: calendar down'); };

// ── mercado abierto: el calendario trae una sesión hoy ──
console.log('marketClosedReason: mercado abierto (el calendario trae sesión) → open');
{
  const r = await marketClosedReason({ now: new Date('2026-08-05T22:40:00Z'), cal: calOpen }); // miércoles
  ok(r.closed === false && r.reason === 'open', 'sesión presente → open (corre normal)', r);
}

// ── festivo entre semana: el VALOR que agrega sobre el cron 1-5 ──
console.log('marketClosedReason: festivo entre semana (calendario vacío en día hábil) → holiday');
{
  const r = await marketClosedReason({ now: new Date('2026-07-03T22:40:00Z'), cal: calEmpty }); // viernes hábil
  ok(r.closed === true && r.reason === 'holiday', 'vacío en día hábil → holiday (lo que el cron 1-5 no cubre)', r);
}

// ── fin de semana (dispatch manual): mismo skip, etiqueta informativa ──
console.log('marketClosedReason: fin de semana en dispatch manual → weekend (mismo skip)');
{
  const r = await marketClosedReason({ now: new Date('2026-08-08T16:00:00Z'), cal: calEmpty }); // sábado
  ok(r.closed === true && r.reason === 'weekend', 'vacío en sábado → weekend (etiqueta, no una rama de control aparte)', r);
}

// ── calendario caído → fail-OPEN ──
console.log('marketClosedReason: calendario CAÍDO → fail-OPEN (corre igual)');
{
  const r = await marketClosedReason({ now: new Date('2026-08-05T22:40:00Z'), cal: calThrows });
  ok(r.closed === false && r.reason === 'calendar_error', 'excepción → fail-open (perder un día es peor que correr de más)', r);
}

// ── fecha en horario del Este, no UTC ──
console.log('marketClosedReason: la fecha "de hoy" es ET, no UTC');
{
  // Sábado 00:30 UTC = viernes 20:30 ET → "hoy" es el VIERNES hábil (2026-08-07).
  // Con el calendario vacío se etiqueta holiday (día hábil ET), NO weekend: prueba
  // que la fecha y el dow salen de ET y no del sábado UTC.
  let asked = null;
  const calSpy = async (start) => { asked = start; return []; };
  const r = await marketClosedReason({ now: new Date('2026-08-08T00:30:00Z'), cal: calSpy });
  ok(r.date === '2026-08-07', 'medianoche-UTC del sábado → fecha ET viernes (2026-08-07)', r.date);
  ok(asked === '2026-08-07', 'el calendario se consulta con la fecha ET (viernes), no la UTC (sábado)', asked);
  ok(r.reason === 'holiday', 'viernes-ET con calendario vacío → holiday (dow sobre fecha ET, no weekend)', r);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
