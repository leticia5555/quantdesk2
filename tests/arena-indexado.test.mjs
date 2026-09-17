// ═══════════════════════════════════════════════════════════════
// tests/arena-indexado.test.mjs — la vista indexada a $100,000.
//
// Las siete cuentas arrancaron la temporada en $98,677–$100,130: el reset las
// aplanó y aplanar no las dejó parejas. Cada una se mide contra SU baseline,
// que es correcto — y en pantalla se lee como si algunas hubieran empezado con
// ventaja.
//
// Indexar arregla la lectura sin tocar un dato:
//     equity_mostrado = 100,000 × equity_real / baseline
//
// Lo que se blinda:
//   1. EL RANKING Y LOS PORCENTAJES NO CAMBIAN. Indexar es multiplicar por una
//      constante positiva por cuenta: no altera el orden ni el retorno.
//   2. EL EQUITY REAL SIGUE AHÍ, con su nombre. La cuenta de Alpaca dice ese
//      número, no el indexado.
//   3. NADA DEL CAMINO DE DECISIÓN LO LEE. El breaker mide drawdown contra el
//      equity real: uno que mirara el indexado estaría midiendo una pantalla.
//   4. SIN BASELINE NO SE INVENTA UN ÍNDICE.
//
// Correr con `node tests/arena-indexado.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { indexarEquity, returnPct, BASE_INDEX_USD } from '../api/_lib/arena-baseline.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── todas parten de 100,000 ──');
{
  ok(BASE_INDEX_USD === 100000, 'la base son $100,000', String(BASE_INDEX_USD));
  ok(indexarEquity(98677, 98677) === 100000, 'una cuenta en su baseline muestra exactamente 100,000');
  ok(indexarEquity(100130, 100130) === 100000, 'y la otra también, aunque su baseline sea otro');
  ok(indexarEquity(100650, 98677) === 101999.45,
    'una cuenta arriba de su baseline muestra arriba de 100,000', String(indexarEquity(100650, 98677)));
}

console.log('\n── el ranking y los porcentajes son IDÉNTICOS ──');
{
  // Ésta es la propiedad que hace que indexar sea una vista y no un truco.
  const cuentas = [
    { id: 'claude', equity: 100650, base: 98677 },
    { id: 'qwen', equity: 100130, base: 100130 },
    { id: 'control', equity: 99000, base: 98900 },
  ];
  const porReal = [...cuentas].sort((a, b) => returnPct(b.equity, b.base) - returnPct(a.equity, a.base)).map((x) => x.id);
  const porIndexado = [...cuentas].sort((a, b) => indexarEquity(b.equity, b.base) - indexarEquity(a.equity, a.base)).map((x) => x.id);
  ok(JSON.stringify(porReal) === JSON.stringify(porIndexado),
    'ordenar por retorno real y por equity indexado da el MISMO orden — por eso el ranking no se toca',
    `${porReal} vs ${porIndexado}`);

  for (const c of cuentas) {
    const real = returnPct(c.equity, c.base);
    const idx = returnPct(indexarEquity(c.equity, c.base), BASE_INDEX_USD);
    ok(Math.abs(real - idx) < 0.01,
      `el retorno de ${c.id} es el mismo por los dos caminos (${real}% / ${idx}%)`);
  }

  // Y ordenar por equity BRUTO no daba el mismo orden: es el problema que esto
  // resuelve, no una coincidencia.
  const porBruto = [...cuentas].sort((a, b) => b.equity - a.equity).map((x) => x.id);
  ok(JSON.stringify(porBruto) !== JSON.stringify(porReal),
    'mientras que ordenar por equity BRUTO daría otro orden — que es exactamente lo que confundía en pantalla',
    `bruto ${porBruto} vs retorno ${porReal}`);
}

console.log('\n── sin baseline no se inventa un índice ──');
{
  ok(indexarEquity(100000, null) === null,
    'sin baseline, null — devolver el equity crudo lo haría pasar por indexado, que es peor que no tenerlo');
  ok(indexarEquity(100000, 0) === null, 'ni con baseline 0 (división por cero disfrazada)');
  ok(indexarEquity(null, 100000) === null, 'ni sin equity');
  // `Number(null)` es 0: el guard de `num` ya mordió dos veces en esta casa.
  ok(indexarEquity(0, 100000) === 0, 'un equity de CERO sí es un índice de 0: una cuenta vaciada es un hecho, no un hueco');
}

console.log('\n── el equity real sigue publicado, y es el que decide ──');
{
  const lb = readFileSync(new URL('../api/leaderboard.js', import.meta.url), 'utf8');
  ok(/out\.equity_indexado = indexarEquity\(equity, out\.baseline_equity\)/.test(lb),
    'el leaderboard publica el indexado COMO UN CAMPO MÁS, sin pisar el equity');
  ok(/account:/.test(lb), 'y `account.equity` (el real) se queda donde estaba');

  const html = readFileSync(new URL('../leaderboard.html', import.meta.url), 'utf8');
  ok(/real '\+money\(acct\.equity\)/.test(html),
    'la tarjeta muestra el indexado grande y el REAL al lado: la cuenta de Alpaca dice ese número, no el otro');
  ok(/indexada/.test(html) && /El ranking y los porcentajes son/.test(html),
    'y el pie explica qué es y qué no cambia');

  // ── LO QUE NO PUEDE PASAR ──
  // El camino de decisión no puede leer una pantalla.
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  const rails = readFileSync(new URL('../api/_lib/arena-rails.js', import.meta.url), 'utf8');
  const exits = readFileSync(new URL('../api/_lib/arena-exits.js', import.meta.url), 'utf8');
  ok(!/equity_indexado/.test(run) && !/equity_indexado/.test(rails) && !/equity_indexado/.test(exits),
    'ni arena-run, ni los rieles, ni la red de riesgo mencionan el indexado — el breaker mide contra el equity REAL');
}

console.log('\n── la serie intradía y el benchmark, en la misma regla ──');
{
  const eq = readFileSync(new URL('../api/liga-equity.js', import.meta.url), 'utf8');
  ok(/equity_indexado: indexarEquity\(p2\.equity, base\)/.test(eq),
    'cada punto de la serie trae su indexado, contra el baseline de SU cuenta');
  ok(/indexado: \{\s*\n?\s*base: BASE_INDEX_USD/.test(eq),
    'y la respuesta explica qué es ese número');

  const bench = readFileSync(new URL('../api/_lib/arena-benchmark.js', import.meta.url), 'utf8');
  ok(/const capital = Number\(estado\.capital\)/.test(bench),
    'el benchmark se indexa contra `estado.capital` — el MISMO denominador que usa su retorno, para que no puedan discrepar por un redondeo');
  ok(/equity_indexado/.test(bench), 'y publica el suyo, para que la línea del índice se lea en la misma escala');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
