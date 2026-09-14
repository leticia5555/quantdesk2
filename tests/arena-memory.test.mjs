// ═══════════════════════════════════════════════════════════════
// tests/arena-memory.test.mjs — MEMORIA del Arena (T2), unit.
//
// arena-memory.js es JS puro (sin I/O, sin LLM) como el guard y los exits, así
// que se prueba en aislamiento con filas de journal sintéticas. Cubre las tres
// piezas de la Temporada 2 que viven ahí:
//   #1 compromisos: normalización, fold sobre el journal, caducidad, auditoría.
//   #3/#4/#9 historia de la posición: fecha de apertura reconstruida de los
//      fills, pico desde la entrada, días, trailing armado y time stop.
//   #9 pronunciamiento: normalización de positions_review y su auditoría.
// Correr con `node tests/arena-memory.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  daysBetween, reconstructPositionOpens, peakSinceEntry, buildPositionMeta, peaksFromMeta,
  normalizeCommitments, normalizeCommitmentUpdates, foldCommitments, auditCommitments,
  normalizePositionsReview, auditPositionReview, COMMITMENT_MAX_AGE_DAYS,
  normalizeInvalidation, normalizeConfidence,
} from '../api/_lib/arena-memory.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const RULES = {
  trailing_arm_gain: 0.15, trailing_give_back: 0.08, time_stop_days: 45,
};
const NOW = new Date('2026-09-13T22:40:00Z');

// ═══ fecha de apertura desde los FILLS ═════════════════════════════
console.log('memoria: fecha de apertura reconstruida de los fills del journal');
const fillRows = [
  // Compra llenada: abre la posición.
  { run_date: '2026-08-01', actions: [{ symbol: 'AAPL', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 10, filled_at: '2026-08-01T13:35:00Z' }] },
  // Orden enviada que NO llenó: no abre nada.
  { run_date: '2026-08-02', actions: [{ symbol: 'MSFT', side: 'buy', result: 'approved', order_status: 'expired', qty: 5 }] },
  // Add sobre una posición viva: NO reinicia el reloj.
  { run_date: '2026-08-10', actions: [{ symbol: 'AAPL', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 5, filled_at: '2026-08-10T13:35:00Z' }] },
  // Ciclo completo de otro nombre: abre, cierra y vuelve a abrir → reloj nuevo.
  { run_date: '2026-08-03', actions: [{ symbol: 'KO', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 20, filled_at: '2026-08-03T13:35:00Z' }] },
  { run_date: '2026-08-20', actions: [{ symbol: 'KO', side: 'sell', result: 'approved', order_status: 'filled', filled_qty: 20, filled_at: '2026-08-20T13:35:00Z' }] },
  { run_date: '2026-09-01', actions: [{ symbol: 'KO', side: 'buy', result: 'approved', order_status: 'filled', filled_qty: 8, filled_at: '2026-09-01T13:35:00Z' }] },
  // Venta parcial: la posición sigue viva con su fecha original.
  { run_date: '2026-09-05', actions: [{ symbol: 'AAPL', side: 'sell', result: 'approved', order_status: 'filled', filled_qty: 3, filled_at: '2026-09-05T13:35:00Z' }] },
];
const opens = reconstructPositionOpens(fillRows);
ok(opens.AAPL && opens.AAPL.opened_at === '2026-08-01' && opens.AAPL.qty === 12,
  'la posición arranca en el PRIMER fill; un add no reinicia el reloj y la venta parcial no la cierra', JSON.stringify(opens.AAPL));
ok(!opens.MSFT, 'una orden que NO llenó no abre posición (solo cuentan fills reales)', JSON.stringify(opens.MSFT));
ok(opens.KO && opens.KO.opened_at === '2026-09-01',
  'cerrada y re-comprada → el reloj arranca de CERO en la nueva entrada (otra tesis)', JSON.stringify(opens.KO));
ok(Object.keys(reconstructPositionOpens([])).length === 0, 'journal vacío → ninguna apertura conocida (no inventa "abierta hoy")');
ok(daysBetween('2026-08-01', '2026-09-13') === 43 && daysBetween(null, '2026-09-13') === null,
  'daysBetween cuenta días calendario y devuelve null sin fecha (hueco honesto)', String(daysBetween('2026-08-01', '2026-09-13')));

// ═══ pico desde la entrada ═════════════════════════════════════════
console.log('memoria: pico de precio desde la entrada (ventana acotada por la apertura)');
const series = {
  dates: ['2026-07-20', '2026-07-25', '2026-08-01', '2026-08-15', '2026-09-01', '2026-09-12'],
  closes: [500, 480, 100, 140, 120, 118],
};
const pk = peakSinceEntry(series, '2026-08-01', 100);
ok(pk && pk.peak === 140 && pk.peak_at === '2026-08-15',
  'el pico se toma SOLO desde la apertura — el 500 anterior a la compra no cuenta', JSON.stringify(pk));
ok(peakSinceEntry(series, null, 100).peak === 100,
  'sin fecha de apertura NO se abre la ventana: el pico cae a la entrada (nunca un pico ajeno)', JSON.stringify(peakSinceEntry(series, null, 100)));
ok(peakSinceEntry(series, '2026-09-13', 130).peak === 130,
  'comprada hoy (sin sesiones completas todavía) → el pico es el costo, piso del high-water-mark');

// ═══ meta por posición: trailing + time stop ═══════════════════════
console.log('memoria: meta por posición (trailing armado, time stop, distancia al pico)');
const winnerSeries = { dates: ['2026-09-01', '2026-09-05', '2026-09-10'], closes: [105, 125, 118] };
const laggardSeries = { dates: ['2026-09-01', '2026-09-05', '2026-09-10'], closes: [101, 104, 99] };
const meta = buildPositionMeta({
  positions: [
    { symbol: 'WIN', qty: '10', avg_entry_price: '100', current_price: '118' }, // pico 125 = +25% → ARMA
    { symbol: 'MEH', qty: '10', avg_entry_price: '100', current_price: '99' },  // pico 104 = +4% → NO arma
    { symbol: 'OLD', qty: '10', avg_entry_price: '100', current_price: '100' }, // sin apertura conocida
  ],
  opens: { WIN: { opened_at: '2026-09-01' }, MEH: { opened_at: '2026-07-01' } },
  seriesBySymbol: { WIN: winnerSeries, MEH: laggardSeries, OLD: winnerSeries },
  now: NOW, rules: RULES,
});
ok(meta.WIN.trailing.armed === true && meta.WIN.trailing.level === 115,
  'pico +25% ARMA el trailing y fija el nivel en pico×0.92 (125 → 115)', JSON.stringify(meta.WIN.trailing));
ok(meta.WIN.trailing.level > Number(100), 'el nivel del trailing queda SOBRE la entrada: por construcción no vende en pérdida', String(meta.WIN.trailing.level));
ok(meta.MEH.trailing.armed === false && meta.MEH.trailing.level === null,
  'pico +4% NO arma: sin armar no hay salida por trailing (ahí es donde un stop apretado destruiría valor)', JSON.stringify(meta.MEH.trailing));
ok(meta.WIN.from_peak_pct === -5.6 && meta.WIN.gain_at_peak_pct === 25,
  'distancia al pico y ganancia en el pico YA calculadas para el pronunciamiento (#9)', JSON.stringify({ f: meta.WIN.from_peak_pct, g: meta.WIN.gain_at_peak_pct }));
ok(meta.MEH.time_stop.due === true && meta.MEH.time_stop.days === 74 && meta.MEH.time_stop.limit === 45,
  'time stop VENCIDO a los 74 días (límite 45) → obliga a pronunciarse, no vende', JSON.stringify(meta.MEH.time_stop));
ok(meta.WIN.time_stop.due === false, 'una posición de 12 días no dispara el time stop', JSON.stringify(meta.WIN.time_stop));
ok(meta.OLD.days_in_position === null && meta.OLD.time_stop.days === null && meta.OLD.time_stop.due === false && meta.OLD.trailing.armed === false,
  'sin fecha de apertura: días null, time stop NO vence y el trailing no arma — fail-safe, no se liquida sobre un dato que no existe',
  JSON.stringify({ d: meta.OLD.days_in_position, t: meta.OLD.time_stop, tr: meta.OLD.trailing }));
const peaks = peaksFromMeta(meta);
ok(peaks.WIN === 125 && peaks.MEH === 104, 'peaksFromMeta entrega el mapa que consume buildRiskExits', JSON.stringify(peaks));

// ═══ compromisos: normalización ════════════════════════════════════
console.log('memoria: compromisos — normalización tolerante');
const created = normalizeCommitments([
  { symbol: 'nvda', text: '  Revisar NVDA tras el reporte  ', due: '2026-09-18' },
  { ticker: 'CRM', commitment: 'Salir si pierde el soporte' },
  { text: '' },            // vacío → se descarta
  'basura',                // no-objeto → se descarta
  { symbol: 'X', text: 'ok', due: 'mañana' }, // due inválido → null, el texto sobrevive
], { runDate: '2026-09-13', tag: 'd' });
ok(created.length === 3, 'lo ilegible se descarta sin abortar el run (contrato tolerante)', JSON.stringify(created.map((c) => c.text)));
ok(created[0].id === '2026-09-13:d#1' && created[0].symbol === 'NVDA' && created[0].due === '2026-09-18',
  'id determinista con fecha + tag de corrida, símbolo normalizado y vencimiento válido', JSON.stringify(created[0]));
ok(created[2].due === null, 'un vencimiento que no es una fecha se guarda como null, no se inventa', JSON.stringify(created[2]));
ok(normalizeCommitments([{ text: 'a' }], { runDate: '2026-09-13', tag: 'm' })[0].id === '2026-09-13:m#1',
  'la corrida matutina usa tag propio → dos corridas del mismo día no colisionan en el id');

const updates = normalizeCommitmentUpdates([
  { id: 'c1', status: 'CUMPLIDO', note: 'vendido' },
  { id: 'c2', status: 'inventado' },   // status fuera del vocabulario → fuera
  { id: 'c1', status: 'vigente' },     // duplicado → gana el primero
  { status: 'vigente' },               // sin id → fuera
]);
ok(updates.length === 1 && updates[0].id === 'c1' && updates[0].status === 'cumplido',
  'updates: vocabulario cerrado (cumplido/vigente/cancelado), sin duplicados y sin ids vacíos', JSON.stringify(updates));

// ═══ compromisos: el fold sobre el journal ═════════════════════════
console.log('memoria: compromisos — fold del journal (qué sigue abierto)');
const journal = [
  { run_date: '2026-09-08', context: { commitments: { created: [
    { id: '2026-09-08:d#1', on: '2026-09-08', symbol: 'NVDA', text: 'Esperar el reporte de NVDA para decidir', due: '2026-09-11' },
    { id: '2026-09-08:d#2', on: '2026-09-08', symbol: 'CRM', text: 'Recortar CRM si rebota', due: null },
  ], updates: [] } } },
  { run_date: '2026-09-10', context: { commitments: { created: [], updates: [{ id: '2026-09-08:d#2', status: 'cumplido', note: 'recortado' }] } } },
  { run_date: '2026-09-11', context: { commitments: { created: [], updates: [{ id: '2026-09-08:d#1', status: 'vigente', note: 'el reporte se movió' }] } } },
  // Un compromiso viejísimo que nadie cerró → caduca, no envejece para siempre.
  { run_date: '2026-07-01', context: { commitments: { created: [{ id: '2026-07-01:d#1', on: '2026-07-01', symbol: 'OLD', text: 'algo de julio', due: null }], updates: [] } } },
];
const folded = foldCommitments(journal, { now: NOW });
const openIds = folded.open.map((c) => c.id);
ok(openIds.includes('2026-09-08:d#1') && !openIds.includes('2026-09-08:d#2'),
  'un "cumplido" cierra el compromiso; el que sigue esperando queda ABIERTO', JSON.stringify(openIds));
const nvda = folded.open.find((c) => c.id === '2026-09-08:d#1');
ok(nvda.age_days === 5 && nvda.overdue === true && nvda.reaffirmed === 1,
  'el abierto viaja con edad, vencimiento y cuántas veces se re-afirmó (todo ya calculado)', JSON.stringify(nvda));
ok(!openIds.includes('2026-07-01:d#1') && folded.resolved.some((c) => c.id === '2026-07-01:d#1' && c.status === 'caducado'),
  `a los ${COMMITMENT_MAX_AGE_DAYS} días sin resolver, el compromiso CADUCA (queda marcado, no desaparece en silencio)`,
  JSON.stringify(folded.resolved.map((c) => c.id + ':' + c.status)));

console.log('memoria: auditoría de cumplimiento (mide, no censura)');
const audit = auditCommitments(folded.open, [{ id: '2026-09-08:d#1', status: 'vigente', note: 'sigo esperando' }]);
ok(audit.required === 1 && audit.missing.length === 0 && audit.rate === 1, 'pronunciarse sobre todos → rate 1', JSON.stringify(audit));
const audit2 = auditCommitments(folded.open, []);
ok(audit2.missing.length === 1 && audit2.rate === 0,
  'ignorar un compromiso abierto NO rompe el run: queda contado como incumplimiento', JSON.stringify(audit2));
const audit3 = auditCommitments(folded.open, [{ id: 'inventado#9', status: 'cumplido' }]);
ok(audit3.unknown.length === 1 && audit3.missing.length === 1,
  'un id que nunca existió se marca `unknown` (memoria alucinada) y el real sigue pendiente', JSON.stringify(audit3));

// ═══ pronunciamiento por posición ══════════════════════════════════
console.log('memoria: pronunciamiento por posición (#9)');
const review = normalizePositionsReview([
  { symbol: 'win', stance: 'HOLD', reason: 'sigue +25% sobre la entrada', invalidation_condition: 'si cierra dos sesiones bajo 100', confidence: 0.75 },
  { symbol: 'MEH', stance: 'exit' },              // sin razón → cuenta, pero se marca
  { symbol: 'MEH', stance: 'hold' },              // duplicado → gana el primero
  { symbol: 'ZZZ', stance: 'comprar más' },       // stance inválido → fuera
]);
ok(review.length === 2 && review[0].symbol === 'WIN' && review[0].stance === 'hold',
  'normaliza símbolo y stance, vocabulario cerrado hold/trim/exit, sin duplicados', JSON.stringify(review));
const rAudit = auditPositionReview(['WIN', 'MEH', 'OLD'], review, meta);
ok(rAudit.missing.length === 1 && rAudit.missing[0] === 'OLD' && rAudit.rate === +(2 / 3).toFixed(3),
  'la posición que el PM no mencionó queda contada como olvidada, con su tasa', JSON.stringify(rAudit));
ok(rAudit.without_reason.includes('MEH'), 'un stance sin razón se marca aparte (pronunciarse ≠ justificarse)', JSON.stringify(rAudit.without_reason));
const rAudit2 = auditPositionReview(['MEH'], [], meta);
ok(rAudit2.time_stop_missing.includes('MEH'),
  'olvidar una posición con el TIME STOP VENCIDO es el incumplimiento que se mide aparte (#4)', JSON.stringify(rAudit2));
ok(auditPositionReview([], [], meta).rate === null,
  'libro vacío → rate null, no un 100% inventado sobre cero posiciones');

// ═══ ADDENDUM 2026-09-14: condición de invalidación + confianza ════
console.log('memoria: ADDENDUM — la decisión por posición declara qué la invalida y cuánto cree en ella');

ok(review[0].invalidation_condition === 'si cierra dos sesiones bajo 100' && review[0].confidence === 0.75 && review[0].complete === true,
  'una decisión con los dos campos queda COMPLETA (es la que el guard deja operar)', JSON.stringify(review[0]));
ok(review[1].invalidation_condition === null && review[1].confidence === null && review[1].complete === false,
  'una decisión sin ellos NO se tira: se guarda con los huecos en null y complete:false — el journal tiene que mostrar qué dijo el PM cuando su orden se cayó',
  JSON.stringify(review[1]));

ok(normalizeConfidence(0) === 0 && normalizeConfidence(1) === 1 && normalizeConfidence(0.6666) === 0.667,
  'confianza: el rango [0,1] es inclusivo y se redondea a 3 decimales');
ok([70, 1.01, -0.01, 'alta', null, undefined, NaN].every((v) => normalizeConfidence(v) === null),
  'fuera de rango o ilegible → null, NUNCA clampada: un 70 puede ser "70%" o un dedazo, y elegir por él sería ajustarle la decisión en silencio');
ok(normalizeConfidence('0.4') === 0.4, 'un número en string sí se lee (des-serializar no es ajustar)');

ok(normalizeInvalidation('  si el guidance baja  ') === 'si el guidance baja', 'la condición se recorta, no se reescribe');
ok(['', '   ', 'N/A', 'n/a', 'none', 'TBD', 'ninguna', '-', 'nada.'].every((v) => normalizeInvalidation(v) === null),
  'el relleno tipo "N/A" NO cuenta como condición: pasaría el gate del guard como si el PM hubiera declarado algo');
ok(normalizeInvalidation('x'.repeat(600)).length === 400, 'la condición se corta a 400: es una condición, no un ensayo');
ok(normalizePositionsReview([{ symbol: 'ALT', stance: 'hold', invalidation: 'si rompe el soporte', confidence: 0.3 }])[0].invalidation_condition === 'si rompe el soporte',
  'se tolera el alias `invalidation` (mismo criterio que text/commitment en los compromisos)');

const aud = auditPositionReview(['WIN', 'MEH'], review, meta);
ok(aud.without_invalidation.includes('MEH') && aud.without_confidence.includes('MEH') && aud.incomplete.includes('MEH'),
  'la auditoría cuenta aparte a quién le faltó cada campo (medir, no censurar: quien frena es el guard)', JSON.stringify(aud));
ok(aud.rate === 1 && aud.complete_rate === 0.5,
  'se pronunció sobre las dos (rate 1) pero solo una está completa (complete_rate 0.5): la tasa exigente del addendum no contamina la serie de la T2',
  JSON.stringify({ rate: aud.rate, complete_rate: aud.complete_rate }));

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
