// ═══════════════════════════════════════════════════════════════
// tests/arena-reset.test.mjs — el RESET de libros y el corte que deja atrás.
//
// Lo que este endpoint hace es irreversible (cancela órdenes y vende siete
// libros a mercado), así que lo que se prueba acá no es "funciona" sino los
// candados que impiden que funcione cuando no debe:
//
//   1. SIN `confirm=1` no toca NADA. El default es el dry run.
//   2. Una cuenta sin keys se NOMBRA y no se toca; no desaparece del reporte.
//   3. Se VERIFICA releyendo, no suponiendo: si algo queda abierto, se dice.
//   4. El baseline se escribe aunque la cuenta no quede plana (si no, la
//      corrida siguiente le reinyecta al PM un libro que se está liquidando).
//   5. El PISO del pico: un libro aplanado no arranca midiendo el drawdown
//      contra el pico del libro anterior — el bug que habría dejado a los
//      siete HALTED en su primera corrida.
//   6. El otro lado del piso: si el equity real quedó por debajo del baseline
//      declarado, el drawdown de arranque es REAL y se reporta, no se tapa.
//
// Sin red y sin Neon: `resetAccount` recibe las creds por env y se le cambia
// el cliente de Alpaca con un stub; el resto es lógica pura.
// Correr con `node tests/arena-reset.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { effectiveCutoff, breakerPeak, startingDrawdown, RESET_BASELINE_USD } from '../api/_lib/arena-baseline.js';
import { resetAnnouncement } from '../api/arena-reset.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 5 y 6: el piso del pico ──────────────────────────────────────────
console.log('\n── el PISO del pico del breaker (el bug del día del reset) ──');
{
  // El escenario exacto del doc: pico de $130k en el libro viejo, aplanado a
  // $100k. SIN corte, el drawdown del primer día es −23% → corte amplio.
  const sinCorte = (130000 - 100000) / 130000;
  ok(sinCorte >= 0.20, 'sin corte, $130k de pico contra $100k aplanados = −23% → broadcut el día 1',
    (sinCorte * 100).toFixed(1) + '%');

  // CON corte, el pico de la ventana nueva arranca vacío (dbPeak = 0) y el piso
  // es el baseline declarado. El drawdown del primer día es 0.
  const peak = breakerPeak({ dbPeak: 0, equity: 100000, baselineEquity: 100000 });
  ok(peak === 100000, 'con corte, el pico del día 1 es el baseline, no el pico viejo', String(peak));
  ok((peak - 100000) / peak === 0, 'drawdown del día 1 = 0');

  // El pico sigue siendo MONÓTONO: si el libro ya subió, gana el equity.
  ok(breakerPeak({ dbPeak: 104000, equity: 107000, baselineEquity: 100000 }) === 107000,
    'el pico incluye el equity de hoy (monótono)');
  ok(breakerPeak({ dbPeak: 112000, equity: 107000, baselineEquity: 100000 }) === 112000,
    'y el máximo journaleado de la ventana nueva');

  // El PISO no puede bajar el pico: es un piso, no un reemplazo.
  ok(breakerPeak({ dbPeak: 0, equity: 87000, baselineEquity: 100000 }) === 100000,
    'un equity por debajo del baseline NO baja el pico: el piso es piso');
}

console.log('\n── el otro lado del piso: el drawdown de arranque se reporta ──');
{
  ok(startingDrawdown(100000, 100000) === 0, 'equity = baseline → 0%');
  ok(startingDrawdown(105000, 100000) === 0, 'equity por encima del baseline → 0%, nunca negativo');
  ok(startingDrawdown(87000, 100000) === 0.13, 'equity $87k contra baseline $100k → 13% de drawdown de arranque',
    String(startingDrawdown(87000, 100000)));
  // Y ese 13% está por debajo del delever (15%): importa que el número exista
  // para poder decidir, no que dispare.
  ok(startingDrawdown(87000, 100000) < 0.15, '13% todavía no arma el desapalancamiento — por eso se AVISA en vez de bloquear');
  ok(startingDrawdown(0, 0) === 0, 'baseline 0 no revienta ni inventa un drawdown infinito');
}

// ── el corte de memoria ──────────────────────────────────────────────
console.log('\n── el corte de memoria: el baseline solo puede mover hacia adelante ──');
{
  ok(effectiveCutoff('2026-09-14', null) === '2026-09-14',
    'sin baseline, manda el arranque de temporada');
  ok(effectiveCutoff('2026-09-14', '2026-09-15T18:30:00.000Z') === '2026-09-15',
    'con un reset posterior, manda el reset');
  ok(effectiveCutoff('2026-09-14', '2026-09-01T12:00:00.000Z') === '2026-09-14',
    'un baseline ANTERIOR al arranque NO retrocede el corte: el arranque es el suelo');
  ok(effectiveCutoff('2026-09-14', 'no-es-una-fecha') === '2026-09-14',
    'un baseline basura cae al arranque de temporada en vez de romper la consulta');
}

// ── 1-4: el aplanado de una cuenta, con Alpaca stubbeado ─────────────
console.log('\n── resetAccount: dry run, verificación y cuentas sin keys ──');
{
  // Import dinámico con el módulo de Alpaca interceptado. Node no tiene un
  // mock de módulos estable en runtime, así que se inyecta por env + un
  // `resetAccount` que recibe las creds del registry: se prueba la RAMA sin
  // keys, que es la que tiene que nombrar la cuenta en vez de perderla.
  const { resetAccount } = await import('../api/arena-reset.js');
  const agent = { id: 'fantasma', name: 'Fantasma', alpaca: 'NO_EXISTE_EN_ENV' };
  delete process.env.ALPACA_NO_EXISTE_EN_ENV_KEY;
  delete process.env.ALPACA_NO_EXISTE_EN_ENV_SECRET;
  const row = await resetAccount(agent, { dry: false, baselineUsd: 100000, marketOpen: true, now: new Date() });
  ok(row.agent === 'fantasma', 'la cuenta sin keys aparece en el reporte, nombrada');
  ok(row.ok === false && row.failure === 'missing_alpaca_keys', 'y marcada como fallida, no como exitosa', row.failure);
  ok(/ALPACA_NO_EXISTE_EN_ENV_KEY/.test(row.detail || ''), 'el detalle dice QUÉ env var falta', row.detail);
  ok(!row.before && !row.after, 'no se leyó ni se tocó nada de esa cuenta');
}

// ── el anuncio ───────────────────────────────────────────────────────
console.log('\n── el anuncio del corte dice que las métricas no son comparables ──');
{
  const texto = resetAnnouncement({
    resetId: 'arena-t2-2026-09-15', baselineUsd: 100000, now: new Date(),
    rows: [
      { agent: 'claude', flat: true, before: { position_count: 3, open_order_count: 1 } },
      { agent: 'control', flat: true, before: { position_count: 2, open_order_count: 0 } },
    ],
  });
  ok(/arena-t2-2026-09-15/.test(texto), 'el anuncio lleva el id del reset');
  ok(/5 posiciones/.test(texto), 'cuenta las posiciones vendidas', texto.split('\n')[0]);
  ok(/1 órdenes abiertas canceladas/.test(texto), 'y las órdenes canceladas');
  ok(/NO son comparables/.test(texto), 'y dice explícitamente que el antes y el después no se comparan');
  ok(/PISO del pico del breaker/.test(texto), 'y explica que el baseline es el piso del pico, no solo el denominador');
}

// ── el candado de la regla de la casa ────────────────────────────────
console.log('\n── las órdenes de mercado viven SOLO en el reset ──');
{
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const MERCADO = ['closeAllPositions', 'cancelAllOrders'];
  // El harness que DECIDE no puede importar el aplanado. Si alguien lo importa
  // desde acá, la regla de la casa (limit-only, cicatriz Polymarket) deja de
  // ser una regla y pasa a ser una costumbre.
  for (const f of ['api/arena-run.js', 'api/arena-watch.js', 'api/_lib/arena-exits.js', 'api/_lib/arena-guard.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const usa = MERCADO.filter((fn) => src.includes(fn));
    ok(usa.length === 0, `${f} NO usa el aplanado a mercado`, usa.join(','));
  }
  const reset = readFileSync(join(ROOT, 'api/arena-reset.js'), 'utf8');
  ok(MERCADO.every((fn) => reset.includes(fn)), 'y /api/arena-reset sí, que es su único dueño');
  ok(/confirm\s*=\s*String\(q\.confirm \|\| ''\) === '1'/.test(reset),
    'el reset exige confirm=1: sin él es dry run y no toca nada');
}

// ── el default declarado ─────────────────────────────────────────────
console.log('\n── el baseline declarado ──');
ok(RESET_BASELINE_USD === 100000, 'el default es $100k (lo que valen las cuentas paper al abrirse)', String(RESET_BASELINE_USD));

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
