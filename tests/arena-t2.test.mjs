// ═══════════════════════════════════════════════════════════════
// tests/arena-t2.test.mjs — REGLAMENTO DE LA TEMPORADA 2 (2026-09-13).
//
// Las nueve reglas, donde cada una vive. Lo que ya se prueba en su propia
// suite NO se repite aquí (trailing/time stop → arena-exits; memoria y
// pronunciamiento → arena-memory; venta marketable → arena-guard). Aquí queda
// lo del RUNNER y los contratos de prompt:
//   #2 recién-reportados: aritmética de sesiones y la cubeta correcta.
//   #6 ratios outlier: la bandera de "posible artefacto contable".
//   #7 corrida matutina: qué cuenta como evento post-earnings.
//   #8 NO breaker SMA200: lint que impide reintroducirlo sin decisión.
//   #1/#9 contrato de prompt: el DIVE pide pronunciamiento y memoria, y el
//         contexto le llega con los números YA calculados.
// Correr con `node tests/arena-t2.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { flagRatioOutliers, RATIO_BOUNDS } from '../api/_lib/finnhub-dive.js';
import {
  sessionsAgo, hasReported, postEarningsTriggers,
  buildDiveSystemPrompt, buildDiveUserPrompt,
  T2_RULES_TEXT, T2_RULES_VERSION, T2_ANNOUNCEMENT_ID, PROMPT_VERSION, RECENT_REPORT_SESSIONS,
} from '../api/arena-run.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Miércoles 2026-09-16, 22:40 UTC (la hora del cron de decide, post-cierre).
const WED_NIGHT = new Date('2026-09-16T22:40:00Z');
// El mismo miércoles a las 14:50 UTC (la hora del cron matutino, mercado abierto).
const WED_MORNING = new Date('2026-09-16T14:50:00Z');
// Lunes 2026-09-14 por la mañana (para el cruce de fin de semana).
const MON_MORNING = new Date('2026-09-14T14:50:00Z');

// ═══ #2: aritmética de SESIONES ════════════════════════════════════
console.log('T2 #2: sesiones desde el reporte (L-V, sin delegar aritmética al modelo)');
ok(sessionsAgo('2026-09-16', WED_NIGHT) === 0, 'mismo día → 0 sesiones');
ok(sessionsAgo('2026-09-15', WED_NIGHT) === 1, 'martes visto el miércoles → 1 sesión');
ok(sessionsAgo('2026-09-11', MON_MORNING) === 1, 'VIERNES visto el LUNES → 1 sesión (el fin de semana no cuenta)', String(sessionsAgo('2026-09-11', MON_MORNING)));
ok(sessionsAgo('2026-09-18', WED_NIGHT) === -2, 'una fecha futura da negativo (no se confunde con pasado)', String(sessionsAgo('2026-09-18', WED_NIGHT)));
ok(sessionsAgo('no-es-fecha', WED_NIGHT) === null, 'fecha ilegible → null, no un cero inventado');

console.log('T2 #2: ¿ya reportó? depende de la HORA de la corrida, no solo del día');
ok(hasReported({ date: '2026-09-15', time: 'AMC' }, WED_NIGHT) === true, 'un AMC de ayer ya reportó');
ok(hasReported({ date: '2026-09-16', time: 'BMO' }, WED_MORNING) === true, 'un BMO de HOY ya reportó a media mañana');
ok(hasReported({ date: '2026-09-16', time: 'AMC' }, WED_MORNING) === false,
  'un AMC de HOY todavía NO reportó a las 14:50 UTC (el mercado ni ha cerrado)');
ok(hasReported({ date: '2026-09-16', time: 'AMC' }, WED_NIGHT) === true,
  'el MISMO AMC sí reportó a las 22:40 UTC — la corrida de decide lo ve, la matutina no');
ok(hasReported({ date: '2026-09-18', time: 'BMO' }, WED_NIGHT) === false, 'un reporte futuro no reportó');
ok(RECENT_REPORT_SESSIONS === 2, 'la ventana de memoria del buffet es de 2 sesiones', String(RECENT_REPORT_SESSIONS));

// ═══ #7: disparadores de la corrida matutina ═══════════════════════
console.log('T2 #7: qué cuenta como evento post-earnings a media mañana');
const calendario = [
  { ticker: 'NVDA', date: '2026-09-15', time: 'AMC', eps_est: 1.0, eps_actual: 1.2 }, // ayer AMC → repreciando HOY
  { ticker: 'CRM', date: '2026-09-16', time: 'BMO', eps_est: 2.0, eps_actual: 1.8 },  // hoy BMO → repreciando HOY
  { ticker: 'AAPL', date: '2026-09-16', time: 'AMC' },   // hoy AMC → todavía no ocurre
  { ticker: 'KO', date: '2026-09-15', time: 'BMO' },     // ayer BMO → ya repreció AYER, el decide de anoche lo vio
  { ticker: 'MSFT', date: '2026-09-18', time: 'AMC' },   // futuro
];
const trig = postEarningsTriggers(calendario, WED_MORNING);
ok(Object.keys(trig).sort().join(',') === 'CRM,NVDA',
  'dispara SOLO con lo que repreciará en el open de hoy: AMC de la sesión anterior + BMO de hoy', JSON.stringify(Object.keys(trig)));
ok(!trig.KO, 'un BMO de AYER no dispara: ya repreció ayer y el decide de anoche cerró con ese precio adentro');
ok(!trig.AAPL && !trig.MSFT, 'lo que todavía no reportó no dispara nada');
ok(trig.NVDA.eps_surprise_pct === 20 && trig.CRM.eps_surprise_pct === -10,
  'la sorpresa de EPS viaja YA calculada, con signo (+20% / −10%)', JSON.stringify({ n: trig.NVDA.eps_surprise_pct, c: trig.CRM.eps_surprise_pct }));
ok(trig.NVDA.reported === true && /yesterday|days? ago/.test(trig.NVDA.when),
  'el disparador trae el label relativo resuelto y la marca de reportado', JSON.stringify(trig.NVDA.when));
ok(Object.keys(postEarningsTriggers([], WED_MORNING)).length === 0, 'calendario vacío → cero disparadores (la corrida no ocurre)');

// ═══ #6: ratios outlier ════════════════════════════════════════════
console.log('T2 #6: ratios fuera de rango plausible → "posible artefacto contable"');
const limpio = flagRatioOutliers({ peTTM: 22, roeTTM: 18, debtToEquity: 0.8, netMarginTTM: 12 });
ok(limpio === null, 'fundamentales normales → SIN bandera (un candidato limpio no arrastra ruido al prompt)', JSON.stringify(limpio));
// El caso LYFT: equity contable negativo + P/E disparado por un cargo de una vez.
const lyft = flagRatioOutliers({ peTTM: 912, roeTTM: 4200, debtToEquity: -3.1, netMarginTTM: 2 });
ok(lyft && lyft.flags.length === 3, 'P/E de 912, ROE de 4200% y deuda/equity negativa: los tres se marcan', JSON.stringify(lyft.flags.map((f) => f.field)));
ok(/POSIBLE ARTEFACTO CONTABLE/.test(lyft.note) && /artefacto/.test(lyft.note),
  'la nota le dice al PM qué hacer: o lo omite, o dice que puede ser un artefacto', lyft.note);
ok(lyft.flags.find((f) => f.field === 'debtToEquity').bound === '< 0',
  'la bandera dice POR QUÉ es implausible (qué límite se cruzó)', JSON.stringify(lyft.flags));
ok(flagRatioOutliers({ peTTM: null, roeTTM: undefined }) === null,
  'un dato AUSENTE no es sospechoso: null ≠ outlier (no se inventa una bandera sobre un hueco)');
ok(flagRatioOutliers({ peTTM: 60 }) === null && flagRatioOutliers({ peTTM: RATIO_BOUNDS.peTTM.max + 1 }) !== null,
  'los límites son de PLAUSIBILIDAD, no de calidad: un P/E de 60 es caro pero real; uno de 151, roto');

// ═══ #8: NO hay breaker SMA200 (NO-GO del dualmom) ═════════════════
console.log('T2 #8: el gate de tendencia SMA200 NO entra al Arena (lint)');
const fuentesArena = ['api/arena-run.js', 'api/_lib/arena-exits.js', 'api/_lib/arena-guard.js', 'api/_lib/arena-memory.js']
  .map((f) => ({ f, src: readFileSync(new URL('../' + f, import.meta.url), 'utf8') }));
// Se prohíbe el USO (una SMA/media móvil calculada como regla de salida), no la
// palabra: la decisión #8 debe quedar documentada en prosa sin que el lint la
// confunda con código. Por eso el patrón busca identificadores, no texto.
const SMA_CODE = /\b(sma200|sma_200|movingAverage200|ma200)\b\s*[=(<>]/i;
for (const { f, src } of fuentesArena) {
  const lineas = src.split('\n').map((l, i) => ({ l, i: i + 1 })).filter(({ l }) => SMA_CODE.test(l) && !/^\s*\/\//.test(l));
  ok(lineas.length === 0,
    `${f}: sin breaker/gate por SMA200 (decisión #8, NO-GO del backtest dual-momentum)`,
    JSON.stringify(lineas.map((x) => x.i + ': ' + x.l.trim())));
}
ok(/NO hay breaker por SMA200/.test(T2_RULES_TEXT),
  'la decisión de NO usar SMA200 queda ANUNCIADA en el reglamento, no solo ausente del código');

// ═══ el anuncio del reglamento ═════════════════════════════════════
console.log('T2: el cambio de reglas se anuncia en el journal con fecha');
ok(T2_RULES_VERSION === '2026-09-13' && T2_ANNOUNCEMENT_ID.includes(T2_RULES_VERSION),
  'el anuncio lleva la fecha del cambio y un id idempotente derivado de ella', T2_ANNOUNCEMENT_ID);
ok(/^arena-pm-v3-t2$/.test(PROMPT_VERSION),
  'PROMPT_VERSION sube de temporada: el post-mortem puede cortar T1 vs T2 sin adivinar', PROMPT_VERSION);
for (const n of ['1)', '2)', '3)', '4)', '5)', '6)', '7)', '8)', '9)']) {
  ok(T2_RULES_TEXT.includes(n), `el reglamento anunciado enumera la regla ${n}`);
}
ok(/NO que opere más seguido/.test(T2_RULES_TEXT),
  'el objetivo declarado queda escrito: vender cuando debe y recordar lo prometido, NO operar más seguido');

// ═══ #1/#9: contrato del prompt del DIVE ═══════════════════════════
console.log('T2 #1/#9: el DIVE exige pronunciamiento por posición y memoria de compromisos');
const sys = buildDiveSystemPrompt('Claude PM');
ok(/positions_review/.test(sys) && /"hold"\|"trim"\|"exit"/.test(sys),
  'el system prompt pide UN pronunciamiento por posición con vocabulario cerrado');
ok(/commitment_updates/.test(sys) && /cumplido/.test(sys) && /vigente/.test(sys) && /cancelado/.test(sys),
  'y una respuesta por cada compromiso abierto, con los tres estados posibles');
ok(/TRAILING STOP/.test(sys) && /TIME STOP/.test(sys) && /MARKETABLE limits/.test(sys),
  'el PM conoce las capas deterministas que corren a su alrededor (trailing, time stop, venta marketable)');
ok(/You are NOT being asked to trade more often/.test(sys) && /zero orders is a fully valid outcome/.test(sys),
  'el prompt dice EXPLÍCITAMENTE que no se premia operar más — holdear todo es válido todos los días');

const user = buildDiveUserPrompt({
  account: { equity: 100000, cash: 40000 },
  positions: [{ symbol: 'WIN', qty: 10, avg_entry_price: 100, market_value: 1180, unrealized_plpc: 0.18, current_price: 118 }],
  openOrders: [],
  previous: null,
  scanThesis: 'tesis',
  candidates: ['WIN'],
  deepDive: { WIN: { fundamentals: { peTTM: 900 }, fundamentals_quality: flagRatioOutliers({ peTTM: 900 }) } },
  closes: { WIN: 118 },
  channels: { WIN: { channels: ['portfolio'], screens: [], qualifiers: {} } },
  meta: {
    WIN: {
      opened_at: '2026-08-01', days_in_position: 46, peak_since_entry: 125, peak_at: '2026-09-05',
      from_peak_pct: -5.6, gain_at_peak_pct: 25,
      trailing: { armed: true, arm_level: 115, level: 115 },
      time_stop: { days: 46, limit: 45, due: true },
    },
  },
  commitments: [{ id: '2026-09-08:d#1', on: '2026-09-08', symbol: 'WIN', text: 'revisar tras el reporte', due: '2026-09-11', age_days: 5, overdue: true }],
});
ok(/"days_in_position":46/.test(user) && /"peak_since_entry":125/.test(user) && /"from_peak_pct":-5.6/.test(user),
  'el libro llega con días en posición, pico y distancia al pico YA calculados (#9)');
ok(/"time_stop":\{"days":46,"limit":45,"due":true\}/.test(user), 'el time stop vencido llega marcado, no hay que derivarlo');
ok(/"sells_below":115/.test(user), 'el nivel del trailing armado viaja explícito (el PM no lo recalcula)');
ok(/OPEN COMMITMENTS/.test(user) && /2026-09-08:d#1/.test(user) && /"overdue":true/.test(user),
  'los compromisos abiertos vuelven con su id, su edad y si están vencidos (#1)');
ok(/MUST return a commitment_updates entry for EVERY id/.test(user),
  'y con la obligación explícita de pronunciarse sobre cada uno');
// La REGLA ("RATIO SANITY") se mudó al system con el fix de caché —es estática,
// igual para los siete y para todas las corridas—; la BANDERA del número
// concreto sigue en el turno del usuario, que es donde viaja el dato del día.
// Las dos tienen que llegar, y cada una de su lado del corte.
const sysT2 = buildDiveSystemPrompt('Claude PM');
ok(/RATIO SANITY/.test(sysT2) && /POSIBLE ARTEFACTO CONTABLE/.test(user),
  'la bandera de artefacto contable llega al prompt junto al número marcado (#6)');
ok(!/RATIO SANITY/.test(user), 'y la regla NO se duplica en el turno volátil: se paga una vez, del lado cacheado');
ok(/Trading more is not the objective/.test(user), 'el cierre del prompt repite el objetivo: decidir y recordar, no operar más');

// Corrida por evento: el encuadre cambia y se prohíbe abrir riesgo nuevo.
const userEvento = buildDiveUserPrompt({
  account: { equity: 100000, cash: 40000 }, positions: [], openOrders: [], previous: null,
  scanThesis: null, candidates: ['NVDA'], deepDive: {}, closes: { NVDA: 170 }, channels: {},
  event: { type: 'post_earnings_morning', symbols: ['NVDA'], headline: 'NVDA ya reportó.' },
});
ok(/EVENT-DRIVEN MORNING RUN/.test(userEvento) && /NVDA ya reportó/.test(userEvento),
  'la corrida por evento se presenta como tal, con el titular del evento (#7)');
ok(/NEW POSITIONS ARE NOT PART OF THIS RUN/.test(userEvento) && /Doing nothing is a valid outcome/.test(userEvento),
  'y deja claro que no abre riesgo nuevo y que no hacer nada es válido');
ok(!/EVENT-DRIVEN/.test(user), 'la corrida diaria NO lleva el encuadre de evento');

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
