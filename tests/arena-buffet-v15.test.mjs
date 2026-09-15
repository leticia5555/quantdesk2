// ═══════════════════════════════════════════════════════════════
// tests/arena-buffet-v15.test.mjs — el universo del día con ojos propios.
//
// v1.5 le da al PM ~100 nombres de TRES preguntas distintas (qué se movió, qué
// se negoció, qué rompió su rango de 52 semanas) en vez de ~24 de una sola.
// Lo que se prueba son las cuatro cosas que pueden salir mal y no se verían:
//
//   1. DEDUPE CON BANDERAS. Un nombre en tres canales es UNA entrada con TRES
//      banderas. Perder la coincidencia al deduplicar sería tirar justo la
//      señal que hace interesante al nombre.
//   2. UN SOLO FILTRO DE ADMISIÓN, fail closed, para los tres canales. Es el
//      bug de DDDX: tres criterios y el más flojo mandando.
//   3. ORDEN TOTAL. Sin desempate final, dos corridas con los mismos datos
//      pueden devolver órdenes distintas y el replay deja de reproducir.
//   4. UN CANAL CAÍDO NO TUMBA EL BUFFET, y se NOMBRA.
//
// Alpaca se stubbea entero: se prueba la política, no la red.
// Correr con `node tests/arena-buffet-v15.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  mergeChannels, rankCandidates, buildBuffetV15,
  BUFFET_FLAGS, NEAR_52W_PCT, BUFFET_V15_TARGET,
} from '../api/_lib/arena-buffet.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// ── 1) DEDUPE CON BANDERAS ───────────────────────────────────────────
console.log('\n── dedupe con banderas: un nombre, todas sus procedencias ──');
{
  const m = mergeChannels({
    gainers: [{ symbol: 'NVDA', price: 190, percent_change: 8.2 }, { symbol: 'AMD', price: 140, percent_change: 6.1 }],
    losers: [{ symbol: 'ZM', price: 60, percent_change: -7.4 }],
    actives: [{ symbol: 'NVDA', volume: 9.1e7, trade_count: 800000 }, { symbol: 'TSLA', volume: 8e7 }],
    fiftyTwo: {
      NVDA: { high_52w: 191, low_52w: 90, last: 190, pct_from_high: -0.5, pct_from_low: 111 },
      ZM: { high_52w: 120, low_52w: 59.8, last: 60, pct_from_high: -50, pct_from_low: 0.3 },
      TSLA: { high_52w: 300, low_52w: 150, last: 220, pct_from_high: -26.7, pct_from_low: 46.7 },
      // Un nombre con rango pero que NO está en ningún canal: no debe aparecer.
      IBM: { high_52w: 200, low_52w: 100, last: 199, pct_from_high: -0.5, pct_from_low: 99 },
    },
  });

  ok(m.size === 4, 'cuatro nombres únicos (NVDA no se duplicó pese a estar en dos canales)', String(m.size));
  ok(!m.has('IBM'), 'el 52w NO aporta nombres nuevos: es contexto sobre los que ya están');

  const nvda = m.get('NVDA');
  ok(nvda.flags.length === 3 && nvda.flags.includes('gainer') && nvda.flags.includes('most_active') && nvda.flags.includes('high_52w'),
    'NVDA: UNA entrada con las TRES banderas (gainer + most_active + máximo de 52 semanas)', JSON.stringify(nvda.flags));
  ok(nvda.price === 190 && nvda.change_pct === 8.2 && nvda.volume === 9.1e7 && nvda.high_52w === 191,
    'y los datos de los tres canales se FUNDEN en la misma entrada, no compiten', JSON.stringify(nvda));

  const zm = m.get('ZM');
  ok(zm.flags.includes('loser') && zm.flags.includes('low_52w'), 'ZM: perdedor Y cerca del mínimo de 52 semanas', JSON.stringify(zm.flags));
  ok(!zm.flags.includes('high_52w'), 'y no se le cuelga la bandera del otro extremo');

  const tsla = m.get('TSLA');
  ok(tsla.flags.length === 1 && tsla.flags[0] === 'most_active', 'TSLA: activo pero lejos de los dos extremos → una sola bandera', JSON.stringify(tsla.flags));

  ok(nvda.flags.join(',') === BUFFET_FLAGS.filter((f) => nvda.flags.includes(f)).join(','),
    'las banderas quedan en el orden DECLARADO, no en el de inserción (el journal tiene que ser reproducible)');
}

console.log('\n── el umbral de "cerca del extremo" ──');
{
  const cerca = mergeChannels({ gainers: [{ symbol: 'A', price: 10, percent_change: 1 }], fiftyTwo: { A: { pct_from_high: -NEAR_52W_PCT + 0.1, pct_from_low: 90 } } });
  const lejos = mergeChannels({ gainers: [{ symbol: 'A', price: 10, percent_change: 1 }], fiftyTwo: { A: { pct_from_high: -NEAR_52W_PCT - 0.1, pct_from_low: 90 } } });
  ok(cerca.get('A').flags.includes('high_52w'), `a ${NEAR_52W_PCT}% del máximo cuenta como breakout`);
  ok(!lejos.get('A').flags.includes('high_52w'), 'un poco más abajo, no — el umbral es un umbral');
}

// ── 3) ORDEN TOTAL ───────────────────────────────────────────────────
console.log('\n── el orden es TOTAL: mismas entradas → mismo orden, siempre ──');
{
  const entradas = [
    { symbol: 'CCC', flags: ['gainer'], change_pct: 5 },
    { symbol: 'AAA', flags: ['gainer'], change_pct: 5 },
    { symbol: 'BBB', flags: ['gainer', 'most_active'], change_pct: 1 },
    { symbol: 'DDD', flags: ['loser'], change_pct: -9 },
  ];
  const r1 = rankCandidates(entradas).map((c) => c.symbol);
  const r2 = rankCandidates([...entradas].reverse()).map((c) => c.symbol);
  ok(r1[0] === 'BBB', 'primero el que aparece en MÁS canales, aunque se haya movido menos', r1.join(','));
  ok(r1[1] === 'DDD', 'después, por magnitud del movimiento (−9% pesa como +9%)', r1.join(','));
  ok(r1.join(',') === r2.join(','),
    'ORDEN ESTABLE: invertir la entrada no cambia la salida — sin esto, dos corridas con los mismos datos difieren y el replay deja de reproducir',
    `${r1.join(',')} vs ${r2.join(',')}`);
  ok(r1.indexOf('AAA') < r1.indexOf('CCC'), 'y el símbolo desempata lo que queda empatado');
  ok(rankCandidates(entradas, 2).length === 2, 'el recorte respeta el tope');
}

// ── el armado completo, con Alpaca stubbeado ─────────────────────────
const stubMovers = async () => ({
  gainers: [{ symbol: 'NVDA', price: 190, percent_change: 8.2 }, { symbol: 'PENNY', price: 0.4, percent_change: 90 }],
  losers: [{ symbol: 'ZM', price: 60, percent_change: -7.4 }],
  last_updated: '2026-09-15T18:00:00Z',
});
const stubActives = async () => ({
  most_actives: [{ symbol: 'NVDA', volume: 9e7 }, { symbol: 'TSLA', volume: 8e7 }, { symbol: 'PENNY', volume: 1e9 }],
  by: 'volume', last_updated: '2026-09-15T18:00:00Z',
});
const ADMISIBLE = { price: 100, marketCap: 5e11, dollarVolume: 5e9 };
const stubAdmission = async (syms) => {
  const out = {};
  for (const s of syms) out[s] = s === 'PENNY' ? { price: 0.4, marketCap: 2e6, dollarVolume: 1e5 } : ADMISIBLE;
  return out;
};

console.log('\n── 2) UN SOLO filtro de admisión, para los tres canales ──');
{
  let pedidos52 = null;
  const b = await buildBuffetV15({
    creds: {}, now: new Date('2026-09-15T18:00:00Z'),
    deps: {
      getMovers: stubMovers, getMostActives: stubActives, resolveAdmission: stubAdmission,
      getFiftyTwoWeek: async (syms) => { pedidos52 = syms; return {}; },
    },
  });
  const syms = b.candidates.map((c) => c.symbol);
  ok(!syms.includes('PENNY'), 'el OTC de $0.40 NO entra, aunque llegue por DOS canales (el bug de DDDX)', syms.join(','));
  ok(b.admission.applied === true && b.admission.rejected.some((r) => r.symbol === 'PENNY'),
    'y sale NOMBRADO en los rechazados, con su motivo',
    JSON.stringify(b.admission.rejected));
  ok(/precio \$0\.40/.test(b.admission.rejected.find((r) => r.symbol === 'PENNY').reason),
    'el motivo dice el número, no "no pasó el filtro"', b.admission.rejected.find((r) => r.symbol === 'PENNY').reason);
  ok(syms.length === 3 && syms.includes('NVDA') && syms.includes('ZM') && syms.includes('TSLA'), 'los tres admisibles sí entran', syms.join(','));

  // COSTO: el 52w se pide DESPUÉS de admisión y solo para los que pasaron.
  ok(pedidos52 && !pedidos52.includes('PENNY') && pedidos52.length === 3,
    'el rango de 52 semanas se pide SOLO para los admitidos — al revés se pagaría por nombres que quedan afuera igual',
    JSON.stringify(pedidos52));

  ok(b.counts.universo_bruto === 4 && b.counts.admitidos === 3 && b.counts.publicados === 3,
    'los conteos cuadran: bruto → admitidos → publicados', JSON.stringify(b.counts));
}

console.log('\n── la admisión que no resuelve NADA se declara, no se finge ──');
{
  const b = await buildBuffetV15({
    creds: {}, now: new Date('2026-09-15T18:00:00Z'),
    deps: {
      getMovers: stubMovers, getMostActives: stubActives,
      resolveAdmission: async () => { throw new Error('Finnhub 429'); },
      getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(b.admission.applied === false, 'sin datos de admisión, `applied:false` — no se afirma un filtro que no corrió');
  ok(b.candidates.some((c) => c.symbol === 'PENNY'),
    'y los nombres pasan sin filtrar: dejar el buffet vacío por una caída de Finnhub sería peor, fingir que se filtró sería lo peor');
  ok(/429/.test(b.errors.admission || ''), 'el error real queda registrado', b.errors.admission);
}

// ── 4) UN CANAL CAÍDO ────────────────────────────────────────────────
console.log('\n── un canal caído no tumba el buffet, y se nombra ──');
{
  const b = await buildBuffetV15({
    creds: {}, now: new Date('2026-09-15T18:00:00Z'),
    deps: {
      getMovers: async () => { throw new Error('HTTP 403'); },
      getMostActives: stubActives, resolveAdmission: stubAdmission,
      getFiftyTwoWeek: async () => ({ TSLA: { high_52w: 300, low_52w: 150, last: 299, pct_from_high: -0.3, pct_from_low: 99 } }),
    },
  });
  ok(b.unavailable.includes('movers'), 'el canal caído sale en `unavailable`', JSON.stringify(b.unavailable));
  ok(/403/.test(b.errors.movers || ''), 'con su error HTTP real, no un "falló"', b.errors.movers);
  ok(b.candidates.length === 2 && b.candidates.some((c) => c.symbol === 'TSLA'),
    'y el buffet se arma igual con el canal que sí llegó', b.candidates.map((c) => c.symbol).join(','));
  ok(b.candidates.find((c) => c.symbol === 'TSLA').flags.includes('high_52w'),
    'incluido el contexto de 52 semanas');

  const todoCaido = await buildBuffetV15({
    creds: {}, now: new Date('2026-09-15T18:00:00Z'),
    deps: {
      getMovers: async () => { throw new Error('HTTP 403'); },
      getMostActives: async () => { throw new Error('HTTP 403'); },
      resolveAdmission: stubAdmission, getFiftyTwoWeek: async () => ({}),
    },
  });
  ok(todoCaido.candidates.length === 0 && todoCaido.unavailable.length === 2,
    'con los dos canales caídos: cero candidatos y los dos nombrados — vacío honesto, no inventado');
}

console.log('\n── el tope declarado ──');
ok(BUFFET_V15_TARGET === 100, '~100 candidatos, el número del encargo', String(BUFFET_V15_TARGET));

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
