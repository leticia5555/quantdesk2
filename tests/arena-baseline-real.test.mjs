// ═══════════════════════════════════════════════════════════════
// tests/arena-baseline-real.test.mjs — el baseline es el EQUITY REAL.
//
// El bug que este archivo congela, con los números del 2026-09-16: el reset
// aplanaba las siete cuentas y las re-basaba a un $100,000 DECLARADO, pero
// aplanar a mercado deja un residuo distinto en cada libro. `control` quedaba en
// $98,550 y `claude` en $99,590 — así que la temporada arrancaba con `control`
// en −1.45% y `claude` en −0.41% sin que ninguno hubiera perdido un centavo.
//
// No es cosmético, y menos en ESE par: `claude` y `control` corren el MISMO
// modelo con el MISMO prompt para medir el piso de ruido entre sí. Un punto
// porcentual de diferencia metido por el DENOMINADOR es más grande que el ruido
// que están ahí para medir, y es indistinguible de él.
//
// Tres piezas, y las tres tienen que moverse juntas o el arreglo es peor que el
// bug (el breaker en 0% y la tabla pública en −1.45% de la misma cuenta):
//   1. el reset escribe el equity real por agente,
//   2. los CUATRO consumidores dividen por ESE número y no por un $100k global,
//   3. el orden del ranking pasa a ser por RETORNO — que con capital de arranque
//      igual es exactamente el mismo orden que por equity.
//
// Correr con `node tests/arena-baseline-real.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { returnPct, baselineDe, startingDrawdown, RESET_BASELINE_USD } from '../api/_lib/arena-baseline.js';
import { resetAccount, resetAnnouncement } from '../api/arena-reset.js';
import { ordenarRanking } from '../api/leaderboard.js';
import { rankSeasonStandings } from '../api/arena-run.js';
import { cambiosDeLider } from '../api/liga-eventos.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Los números reales del dry run del 2026-09-16.
const EQUITY = { control: 98550.00, claude: 99590.00 };

// ── 1) EL DENOMINADOR PROPIO ─────────────────────────────────────────
console.log('\n── returnPct divide por el baseline del agente, no por $100k ──');
{
  ok(returnPct(EQUITY.control, 100000) === -1.45,
    'con $100k declarado, control arranca en −1.45% sin haber perdido nada', String(returnPct(EQUITY.control, 100000)));
  ok(returnPct(EQUITY.claude, 100000) === -0.41,
    'y claude en −0.41%: un punto de diferencia entre dos cuentas que corren el MISMO modelo');
  ok(returnPct(EQUITY.control, EQUITY.control) === 0 && returnPct(EQUITY.claude, EQUITY.claude) === 0,
    'con baseline = equity real, los dos arrancan en 0.00% — que es lo que de verdad pasó');

  // El sesgo que desaparece es exactamente el que contaminaba el piso de ruido.
  const sesgo = Math.abs(returnPct(EQUITY.control, 100000) - returnPct(EQUITY.claude, 100000));
  ok(+sesgo.toFixed(2) === 1.04,
    'el sesgo entre claude y control era de 1.04 pp — metido por el denominador, no por el mercado', String(sesgo));

  ok(returnPct(100000, 0) === null && returnPct(null, 100000) === null,
    'sin datos devuelve null, nunca un 0% inventado en la tabla pública');
  ok(baselineDe({ claude: { baseline_equity: '99590.00' } }, 'claude') === 99590,
    'baselineDe lee el número de la DB aunque venga como string (numeric de Postgres)');
  ok(baselineDe({}, 'claude') === RESET_BASELINE_USD,
    'y sin fila en la DB cae al declarado: un denominador ausente no puede tumbar /liga');
  ok(baselineDe({ claude: { baseline_equity: 0 } }, 'claude') === RESET_BASELINE_USD,
    'un baseline en cero también cae al default: dividir por cero sería infinito, no un retorno');
}

// ── 2) EL RESET ESCRIBE EL EQUITY REAL ───────────────────────────────
console.log('\n── resetAccount: el baseline sale del equity de DESPUÉS de aplanar ──');
{
  process.env.ALPACA_TESTBASE_KEY = 'k';
  process.env.ALPACA_TESTBASE_SECRET = 's';
  const agent = { id: 'testbase', name: 'TestBase', alpaca: 'TESTBASE' };
  const fetchReal = globalThis.fetch;
  const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v2/account')) return body({ equity: String(EQUITY.control), cash: String(EQUITY.control), last_equity: String(EQUITY.control) });
    if (u.includes('/v2/positions')) return body([]);
    if (u.includes('/v2/orders')) return body([]);
    return body({});
  };
  try {
    const real = await resetAccount(agent, { dry: false, baselineUsd: 100000, baselineModo: 'real', marketOpen: true, now: new Date() });
    ok(real.flat === true, 'la cuenta queda plana');
    ok(real.baseline_equity === EQUITY.control,
      'y su baseline es su equity real, no el $100k que se le pasó', String(real.baseline_equity));
    ok(real.starting_drawdown_pct === 0,
      'arranca con 0% de drawdown: el pico del breaker es su propio equity de arranque', String(real.starting_drawdown_pct));

    // El modo `fijo` sigue existiendo, y sigue haciendo lo que dice.
    const fijo = await resetAccount(agent, { dry: false, baselineUsd: 100000, baselineModo: 'fijo', marketOpen: true, now: new Date() });
    ok(fijo.baseline_equity === 100000, 'con &baseline=100000 vuelve el número declarado para todas');
    ok(fijo.starting_drawdown_pct === 1.45,
      'y con él vuelve el drawdown de arranque de 1.45% — el reporte lo dice en vez de taparlo', String(fijo.starting_drawdown_pct));

    // El dry run ESTIMA (el equity de después todavía no existe) y lo declara.
    const dry = await resetAccount(agent, { dry: true, baselineUsd: 100000, baselineModo: 'real', marketOpen: true, now: new Date() });
    ok(dry.baseline_equity === EQUITY.control && dry.baseline_estimado === true,
      'el dry run previsualiza el baseline y lo marca como ESTIMADO, no como hecho');
  } finally {
    globalThis.fetch = fetchReal;
    delete process.env.ALPACA_TESTBASE_KEY;
    delete process.env.ALPACA_TESTBASE_SECRET;
  }
}

// ── 3) EL ANUNCIO LISTA LOS SIETE DENOMINADORES ──────────────────────
// Con baselines distintos, el denominador de cada agente es lo que hace
// comparable (o no) su retorno. Tiene que quedar escrito EN el corte: si hay
// que reconstruirlo después, no es auditable.
console.log('\n── el anuncio del corte deja escrito el denominador de cada uno ──');
{
  const rows = [
    { agent: 'claude', flat: true, baseline_equity: EQUITY.claude, before: { position_count: 1, open_order_count: 0 } },
    { agent: 'control', flat: true, baseline_equity: EQUITY.control, before: { position_count: 6, open_order_count: 0 } },
  ];
  const texto = resetAnnouncement({ resetId: 'arena-t2-2026-09-16', baselineUsd: 100000, baselineModo: 'real', rows, now: new Date() });
  ok(/claude \$99590\.00/.test(texto) && /control \$98550\.00/.test(texto),
    'el anuncio lista el baseline de cada cuenta, uno por uno', texto.split('\n')[1]);
  ok(/arrancan en 0\.00%/.test(texto), 'y dice que los dos arrancan en cero');
  ok(/PISO del pico del breaker/.test(texto), 'sin perder que el baseline es también el piso del breaker');

  const fijo = resetAnnouncement({ resetId: 'x', baselineUsd: 100000, baselineModo: 'fijo', rows, now: new Date() });
  ok(/DECLARADO/.test(fijo) && /por el residuo de su aplanado, no por una pérdida/.test(fijo),
    'y en modo fijo AVISA que el negativo del primer día es el residuo del aplanado, no una pérdida');
}

// ── 4) EL ORDEN DEL RANKING ──────────────────────────────────────────
// La parte que parece un cambio de criterio y no lo es.
console.log('\n── ordenar por retorno: idéntico con capital igual, justo con capital distinto ──');
{
  const ag = (id, equity, baseline) => ({ id, name: id, account: { equity }, baseline_equity: baseline, return_pct: returnPct(equity, baseline) });

  // (a) Capital de arranque IGUAL → el orden por retorno y el orden por equity
  // son EL MISMO. Ordenar por retorno no reescribe la decisión #6: la generaliza.
  const iguales = [ag('a', 103000, 100000), ag('b', 101000, 100000), ag('c', 99000, 100000)];
  const porRetorno = ordenarRanking({ agentes: iguales }).map((r) => r.id).join(',');
  const porEquity = [...iguales].sort((x, y) => y.account.equity - x.account.equity).map((r) => r.id).join(',');
  ok(porRetorno === porEquity,
    'con el mismo capital de arranque, ordenar por retorno da EXACTAMENTE el mismo orden que por equity', porRetorno);

  // (b) Capital distinto → se separan, y el equity bruto es el que miente.
  // claude y control rinden IDÉNTICO (+1.00%): es el par que existe para eso.
  const par = [
    ag('claude', +(EQUITY.claude * 1.01).toFixed(2), EQUITY.claude),
    ag('control', +(EQUITY.control * 1.01).toFixed(2), EQUITY.control),
  ];
  ok(par[0].return_pct === par[1].return_pct, 'claude y control rinden idéntico: +1.00% los dos', String(par[0].return_pct));
  ok(par[0].account.equity > par[1].account.equity,
    'pero claude tiene MÁS equity, solo porque arrancó con más: ordenar por equity lo corona sin haber ganado nada');
  const r = ordenarRanking({ agentes: par });
  ok(r[0].return_pct === r[1].return_pct,
    'el orden por retorno los deja empatados en retorno, que es lo que de verdad pasó');
  ok(r[0].rank === 1 && r[1].rank === 2 && r[0].id === 'claude',
    'el empate lo desempata el equity: hay un orden estable, no el del array');

  // (c) Y un tercero que rindió MÁS con MENOS plata gana, que es el punto.
  const conTercero = ordenarRanking({ agentes: [...par, ag('qwen', 95000 * 1.05, 95000)] });
  ok(conTercero[0].id === 'qwen',
    'quien rindió +5% con $95k le gana a quien rindió +1% con $99.6k — con equity bruto habría salido último',
    conTercero.map((x) => x.id + ':' + x.return_pct).join(' '));
}

// ── 5) LOS OTROS DOS CONSUMIDORES ────────────────────────────────────
// Escribir el baseline y que /liga lo lea no alcanza: el cierre de temporada y
// la crónica del liderazgo tenían su propio $100k global cada uno.
console.log('\n── el cierre de temporada y el líder de la crónica ──');
{
  const results = [
    { id: 'claude', name: 'claude', equity: EQUITY.claude * 1.01 },
    { id: 'qwen', name: 'qwen', equity: 95000 * 1.05 },
  ];
  const conMapa = rankSeasonStandings(results, { claude: EQUITY.claude, qwen: 95000 });
  ok(conMapa.winner.id === 'qwen',
    'gana la temporada quien más RINDIÓ, no quien más equity tiene', conMapa.winner.id);
  ok(conMapa.winner.baseline_equity === 95000, 'y el standing publica el denominador que usó');
  const conGlobal = rankSeasonStandings(results, 100000);
  ok(conGlobal.winner.id === 'claude',
    'con un $100k global habría ganado claude — el bug, congelado acá para que se vea la diferencia');

  // La crónica: el líder del día también se decide por retorno.
  const porFecha = { '2026-09-20': { claude: EQUITY.claude * 1.01, qwen: 95000 * 1.05 } };
  const eventos = cambiosDeLider(porFecha, {}, { claude: EQUITY.claude, qwen: 95000 });
  ok(eventos.length === 1 && eventos[0].agente === 'qwen',
    'el líder de la crónica es el de mayor retorno, no el de mayor equity', JSON.stringify(eventos[0] && eventos[0].agente));
  ok(eventos[0].return_pct === 5 && eventos[0].baseline_equity === 95000,
    'con su retorno real y su denominador al lado', JSON.stringify(eventos[0]));

  const sinBaselines = cambiosDeLider(porFecha, {}, {});
  ok(sinBaselines[0].agente === 'claude',
    'sin baselines en la DB cae al global de siempre: degrada al comportamiento viejo, no a un error');
}

// ── 6) LAS DOS MITADES NO PUEDEN DIVERGIR ────────────────────────────
// El baseline es el piso del breaker Y el denominador del retorno. Si alguien
// arregla una sola mitad, la misma cuenta arranca en 0% para el breaker y en
// −1.45% en la tabla pública — que es peor que el bug original, porque los dos
// números se contradicen y ninguno de los dos se ve mal por sí solo.
console.log('\n── el piso del breaker y el denominador son EL MISMO número ──');
{
  const base = EQUITY.control;
  ok(startingDrawdown(EQUITY.control, base) === 0 && returnPct(EQUITY.control, base) === 0,
    'con el mismo baseline, el drawdown de arranque y el retorno de arranque son ambos cero');
  ok(startingDrawdown(EQUITY.control, 100000) > 0 && returnPct(EQUITY.control, 100000) < 0,
    'y con denominadores distintos, los dos se rompen a la vez: por eso se arreglan a la vez');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
