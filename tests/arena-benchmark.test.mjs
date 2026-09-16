// ═══════════════════════════════════════════════════════════════
// tests/arena-benchmark.test.mjs — el benchmark pasivo: $100k en SPY.
//
// Lo que este archivo protege no es la aritmética (es una resta), sino las
// tres decisiones que la vuelven significativa:
//
//   1. EL BENCHMARK NO COMPITE. Aparece ORDENADO por equity —si el índice va
//      arriba de los siete, eso tiene que verse en la primera fila— pero NO
//      toma número de puesto. Si lo tomara, "claude va 2º" sería falso de una
//      forma difícil de ver: 2º de ocho filas, una de las cuales no jugó.
//   2. SE ABRE UNA SOLA VEZ. Un benchmark que se re-abre a un precio nuevo
//      deja de medir la temporada y pasa a medir desde el último reset, en
//      silencio y sin que nada falle.
//   3. EL EXCESO SE LEE CONTRA EL PISO DE RUIDO. Un exceso más chico que la
//      distancia entre dos corridas IDÉNTICAS (claude↔control) no es
//      habilidad. Y un coseno NO se convierte a puntos porcentuales: son
//      unidades distintas, y fingir lo contrario sería inventar el número justo
//      en la línea que existe para no inventar números.
//
// Correr con `node tests/arena-benchmark.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import {
  BENCHMARK, benchmarkEquity, benchmarkReturnPct, filaBenchmark, excesoVsBenchmark,
} from '../api/_lib/arena-benchmark.js';
import { ordenarRanking } from '../api/leaderboard.js';
import { resetAnnouncement } from '../api/arena-reset.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// El estado que dejaría un reset con SPY a $660.
const ENTRADA = { symbol: 'SPY', capital: 100000, entry: 660, shares: +(100000 / 660).toFixed(6), opened_at: '2026-09-16T13:30:00.000Z', note: null };

// ── 1) EL EQUITY: acciones × precio, y nada más ──────────────────────
console.log('\n── el equity del benchmark ──');
{
  ok(benchmarkEquity(ENTRADA, 660) === 100000, 'al precio de entrada vale exactamente el capital', String(benchmarkEquity(ENTRADA, 660)));
  ok(benchmarkReturnPct(ENTRADA, 660) === 0, 'y su retorno es 0%');
  ok(benchmarkReturnPct(ENTRADA, 673.2) === 2, 'SPY +2% → el benchmark +2%: es el índice, no una cartera que casi lo replica',
    String(benchmarkReturnPct(ENTRADA, 673.2)));
  ok(benchmarkReturnPct(ENTRADA, 646.8) === -2, 'y baja igual de limpio');

  // Fracciones: con acciones enteras sobrarían ~$340 de efectivo, y ese
  // efectivo haría rendir MENOS al benchmark por una razón ajena a la
  // comparación. Con 151 acciones enteras el +2% se convertiría en +1,99%.
  const enteras = { ...ENTRADA, shares: Math.floor(100000 / 660) };
  ok(benchmarkReturnPct(enteras, 673.2) < 2,
    'con acciones ENTERAS el retorno se arrastra por el efectivo sobrante: por eso son fraccionarias',
    String(benchmarkReturnPct(enteras, 673.2)));

  ok(benchmarkEquity(ENTRADA, 0) === null && benchmarkEquity(ENTRADA, null) === null,
    'sin precio devuelve null, nunca cero: un benchmark en $0 sería una mentira, no un hueco');
  ok(benchmarkEquity(null, 660) === null, 'sin entrada tampoco inventa nada');
}

// ── 2) LA FILA: ordenada por equity, pero fuera de la competencia ────
console.log('\n── la fila del ranking ──');
{
  const fila = filaBenchmark(ENTRADA, 673.2);
  ok(fila.kind === 'BENCHMARK', 'lleva la etiqueta BENCHMARK');
  ok(fila.compite === false, 'y `compite: false`: no decidió nada, no puede ganar');
  ok(fila.account && fila.account.equity === 102000, 'con equity comparable al de las siete cuentas', JSON.stringify(fila.account));
  ok(fila.model === null && /sin modelo/.test(fila.model_label || ''),
    'sin modelo: la fila dice explícitamente que no hay LLM detrás');
  ok(/dividendos/i.test(fila.caveat_dividendos || ''),
    'y DECLARA el hueco de los dividendos en vez de estimarlo a ojo');

  const sinAbrir = filaBenchmark(null, 673.2);
  ok(sinAbrir.abierto === false && sinAbrir.account === null,
    'antes del reset la fila existe pero sin equity: hueco honesto, no un cero');
  ok(/se abre con el reset/.test(sinAbrir.detalle || ''), 'y dice cuándo se va a abrir');
}

// ── 3) EL ORDEN vs. EL PUESTO ────────────────────────────────────────
// La distinción entera de la funcionalidad. El índice se ordena entre los
// agentes; los números 1..N se reparten solo entre los que compiten.
console.log('\n── el índice se ordena pero NO toma puesto ──');
{
  const ag = (id, equity, ret) => ({ id, name: id, account: { equity }, return_pct: ret });
  const agentes = [ag('claude', 101000, 1), ag('openai', 103000, 3), ag('grok', 99000, -1)];
  const bench = filaBenchmark(ENTRADA, 673.2); // 102000, +2%

  const r = ordenarRanking({ agentes, bench });
  ok(r.map((x) => x.id).join(',') === 'openai,benchmark-spy,claude,grok',
    'el índice queda ORDENADO por equity entre medio de los agentes', r.map((x) => x.id).join(','));

  const benchFila = r.find((x) => x.id === BENCHMARK.id);
  ok(benchFila.rank === null, 'pero su puesto es null: no compite');
  ok(r.find((x) => x.id === 'openai').rank === 1, 'openai es 1º');
  ok(r.find((x) => x.id === 'claude').rank === 2,
    'y claude es 2º — NO 3º. El índice no le come el puesto aunque esté arriba en la tabla',
    String(r.find((x) => x.id === 'claude').rank));
  ok(r.find((x) => x.id === 'grok').rank === 3, 'y grok 3º: los puestos son 1..3 para tres competidores');

  // Un agente sin equity (sin keys / Alpaca caída) cae al final sin puesto, y
  // el benchmark no lo empuja ni lo tapa.
  const conCaido = ordenarRanking({ agentes: [...agentes, { id: 'qwen', name: 'qwen', account: null }], bench });
  ok(conCaido[conCaido.length - 1].id === 'qwen', 'el que no opera sigue cayendo al final');
  ok(conCaido[conCaido.length - 1].rank === null, 'sin puesto');

  // Y sin benchmark abierto la tabla es exactamente la de antes.
  const sinBench = ordenarRanking({ agentes, bench: filaBenchmark(null, null) });
  ok(sinBench.filter((x) => x.rank !== null).length === 3,
    'con el benchmark sin abrir, los tres agentes siguen teniendo puesto');
  ok(sinBench[sinBench.length - 1].id === BENCHMARK.id,
    'y el benchmark sin equity cae al final, como cualquier fila sin equity');
}

// ── 4) EL EXCESO, contra el piso de ruido ────────────────────────────
console.log('\n── el exceso vs. SPY y el piso de ruido ──');
{
  const agentes = [
    { id: 'openai', name: 'openai', return_pct: 3 },
    { id: 'claude', name: 'claude', return_pct: 1 },
    { id: 'grok', name: 'grok', return_pct: -1 },
  ];
  const piso = { comparable: true, cosine: 0.93, enfoque: 'momentum' };
  const out = excesoVsBenchmark({ agentes, benchmarkReturn: 2, pisoDeRuido: piso });

  ok(out.agentes[0].id === 'openai' && out.agentes[0].exceso_pp === 1,
    'el mejor exceso primero: +3% contra un índice de +2% son +1 pp', JSON.stringify(out.agentes[0]));
  ok(out.agentes.find((a) => a.id === 'claude').exceso_pp === -1,
    'y quien subió MENOS que el índice tiene exceso negativo aunque su retorno sea positivo');
  ok(out.agentes.map((a) => a.id).join(',') === 'openai,claude,grok', 'ordenados por exceso, no por retorno');
  ok(out.piso_de_ruido.comparable === true && out.piso_de_ruido.cosine === 0.93,
    'el piso de ruido viaja al lado del exceso');
  ok(/piso de ruido/i.test(out.lectura), 'y la lectura dice cómo leer uno contra el otro');

  // La línea que NO se cruza: el coseno mide parecido entre libros, no
  // diferencia de retorno. Convertirlo a puntos porcentuales sería inventar.
  const json = JSON.stringify(out);
  ok(!/"piso_pp"|"ruido_pp"/.test(json),
    'el coseno NO se convierte a puntos porcentuales: son unidades distintas');

  const sinPiso = excesoVsBenchmark({ agentes, benchmarkReturn: 2, pisoDeRuido: { comparable: false, motivo: 'enfoques distintos' } });
  ok(sinPiso.piso_de_ruido.comparable === false, 'un piso no comparable se marca como tal');
  ok(/no hay contra qué medir/.test(sinPiso.lectura),
    'y la lectura AVISA que sin piso no se distingue habilidad de azar');

  const sinBench = excesoVsBenchmark({ agentes, benchmarkReturn: null });
  ok(sinBench.agentes.every((a) => a.exceso_pp === null),
    'sin benchmark abierto el exceso es null, nunca un retorno disfrazado de exceso');
  ok(/se abre con el reset/.test(sinBench.note || ''), 'y dice por qué');
}

// ── 5) EL RESET: una sola apertura, en el mismo corte ────────────────
console.log('\n── el reset abre el benchmark UNA vez ──');
{
  const src = readFileSync('api/_lib/arena-benchmark.js', 'utf8');
  ok(/const ya = await leerBenchmark\(\);\s*\n\s*if \(ya\) return/.test(src),
    'abrirBenchmark lee ANTES de insertar: si ya estaba, no se pisa el precio de entrada');
  ok(/on conflict \(key\) do nothing/.test(src),
    'y el insert es idempotente en la DB, no solo en el chequeo previo');
  ok(/const guardado = await leerBenchmark\(\)/.test(src),
    'RELEE después de insertar: dos resets en paralelo reportan la MISMA entrada, no dos precios');

  const reset = readFileSync('api/arena-reset.js', 'utf8');
  ok(/migrar: false/.test(reset),
    'el DRY RUN lee sin crear la tabla: cero escrituras es cero escrituras, incluida la migración');
  ok(/if \(only\) \{\s*\n\s*out\.benchmark = \{ skipped: true/.test(reset),
    'con ?agent=<uno> el benchmark NO se abre: eso es arreglar una cuenta, no arrancar una temporada');

  // El anuncio del season_started tiene que NOMBRAR el benchmark: si la
  // comparación aparece recién en el post-mortem, se lee como inventada después.
  const rows = [{ agent: 'claude', flat: true, before: { position_count: 2, open_order_count: 1 } }];
  const texto = resetAnnouncement({
    resetId: 'arena-t2-2026-09-16', baselineUsd: 100000, rows, now: new Date(),
    benchmark: { abierto: true, symbol: 'SPY', entry: 660, shares: 151.515152, capital: 100000 },
  });
  ok(/BENCHMARK PASIVO/.test(texto), 'el anuncio del reset nombra el benchmark');
  ok(/SPY a \$660/.test(texto), 'con su precio de entrada, que es el dato auditable');
  ok(/NO compite/.test(texto), 'y deja dicho que no compite');

  const sinB = resetAnnouncement({
    resetId: 'x', baselineUsd: 100000, rows, now: new Date(),
    benchmark: { abierto: false, motivo: 'Alpaca no devolvió snapshot de SPY.' },
  });
  ok(/NO se abrió/.test(sinB) && /Alpaca no devolvió/.test(sinB),
    'y si no se pudo abrir, el anuncio lo DICE con el motivo en vez de callarlo');
}

// ── 6) NO DECIDE NADA ────────────────────────────────────────────────
// La regla estructural: si este archivo algún día importa el camino de
// decisión, el benchmark dejó de ser pasivo y nadie se enteró.
console.log('\n── el benchmark no toca el camino de decisión ──');
{
  const src = readFileSync('api/_lib/arena-benchmark.js', 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const prohibidos = imports.filter((i) => /arena-(run|model|tools|tool-loop|rails|prompt|herding)/.test(i));
  ok(prohibidos.length === 0,
    'cero imports del camino de decisión: sin LLM, sin herramientas, sin rieles', prohibidos.join(','));
  ok(!/createLimitOrder|closeAllPositions|cancelOrder/.test(src),
    'y no puede mandar NI UNA orden: es una línea calculada, no una octava cuenta');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
