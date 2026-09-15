// ═══════════════════════════════════════════════════════════════
// tests/arena-portafolio.test.mjs — B5 + B6 + B7.
//
// El cambio de contrato más grande de la temporada: el PM deja de entregar
// ÓRDENES y entrega un LIBRO. Lo que se blinda:
//
//   B5 · OMISIÓN = SALIDA. Un objetivo vacío LIQUIDA, no es un no-op. Es el
//        riesgo más grande del diseño y por eso es la primera aserción.
//   B5 · LA BANDA no frena un cierre completo. "Salir del 1.5%" es una decisión.
//   B5 · EL ORDEN libera antes de consumir; un cruce de signo son DOS patas.
//   B6 · DESCARTA, NO ESCALA. Y reporta TODAS las violaciones, no la primera.
//   B6 · FAIL CLOSED en el corto: sin confirmación de easy-to-borrow, no se abre.
//   B6 · R12 EL MOTOR RECORTA — rechazar entradas no sirve contra una posición
//        que se infla sola.
//   B7 · EL ESPEJO DEL PICO. En un corto lo que se recuerda es el MÍNIMO; usar
//        el máximo daría un trailing que dispara cuando la posición va bien.
//
// Todo puro, sin red. Correr con `node tests/arena-portafolio.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { RAILS, parseTarget, exposures, validateTarget, railTrims, SECTOR_UNKNOWN } from '../api/_lib/arena-rails.js';
import { currentWeights, diffToLegs, orderLegs, staleOrders, buildRebalance } from '../api/_lib/arena-rebalance.js';
import {
  SHORT_RULES, shortQty, isShort, shortCatastrophicLevel, shortTrailingState,
  planShortCatastrophicStops, planShortTrailingStops, lowsFromSeries, detectForcedBuyIns,
} from '../api/_lib/arena-exits-short.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const EQUITY = 100000;
const pos = (symbol, mv, qty, entry) => ({ symbol, market_value: mv, qty, avg_entry_price: entry });

// ── B5 · OMISIÓN = SALIDA ────────────────────────────────────────────
console.log('\n── B5: la omisión es una SALIDA, no un no-op ──');
{
  const libro = [pos('NVDA', 20000, 100, 180), pos('AAPL', 15000, 60, 240)];
  const r = buildRebalance({ positions: libro, equity: EQUITY, target: {} });
  ok(r.legs.length === 2, 'un objetivo VACÍO produce DOS órdenes de salida, no cero', String(r.legs.length));
  ok(r.legs.every((l) => l.side === 'sell' && l.closes_position),
    'las dos cierran la posición entera — todo el libro se re-afirma en cada corrida o desaparece',
    JSON.stringify(r.legs.map((l) => [l.symbol, l.side, l.closes_position])));

  // Y el caso que importa: un objetivo que menciona UNO cierra el OTRO.
  const r2 = buildRebalance({ positions: libro, equity: EQUITY, target: { NVDA: 0.20 } });
  const aapl = r2.legs.find((l) => l.symbol === 'AAPL');
  ok(aapl && aapl.closes_position, 'mencionar NVDA y omitir AAPL cierra AAPL: la omisión no pasa por decisión', JSON.stringify(aapl));
  ok(!r2.legs.some((l) => l.symbol === 'NVDA'), 'y NVDA, que ya estaba en 20%, no genera orden');
}

console.log('\n── B5: la banda de no-negociación, y su excepción ──');
{
  const libro = [pos('NVDA', 11600, 60, 180)];   // 11.6% del equity
  const r = buildRebalance({ positions: libro, equity: EQUITY, target: { NVDA: 0.12 } });
  ok(r.legs.length === 0, 'querer 12% teniendo 11.6% NO genera orden: eso es drift de precio, no una decisión');
  ok(r.skipped.length === 1 && /drift/.test(r.skipped[0].reason), 'y el salto queda registrado con su motivo', r.skipped[0].reason);

  const grande = buildRebalance({ positions: libro, equity: EQUITY, target: { NVDA: 0.20 } });
  ok(grande.legs.length === 1 && grande.legs[0].side === 'buy', 'un movimiento por encima de la banda sí opera');

  // LA EXCEPCIÓN: un cierre completo nunca se frena por banda.
  const chico = [pos('ZM', 1500, 25, 60)];       // 1.5%
  const cierre = buildRebalance({ positions: chico, equity: EQUITY, target: {} });
  ok(cierre.legs.length === 1 && cierre.legs[0].closes_position,
    'salir de una posición del 1.5% SÍ opera: un cierre completo es una decisión aunque el movimiento sea chico');
}

console.log('\n── B5: el orden de ejecución libera antes de consumir ──');
{
  const legs = orderLegs([
    { symbol: 'D', side: 'short', notional: 5000 }, { symbol: 'C', side: 'buy', notional: 5000 },
    { symbol: 'B', side: 'cover', notional: 5000 }, { symbol: 'A', side: 'sell', notional: 5000 },
  ]);
  ok(legs.map((l) => l.side).join(',') === 'sell,cover,buy,short',
    'ventas → coberturas → compras → cortos nuevos', legs.map((l) => l.side).join(','));

  const empate = orderLegs([
    { symbol: 'ZZ', side: 'buy', notional: 100 }, { symbol: 'AA', side: 'buy', notional: 100 },
    { symbol: 'MM', side: 'buy', notional: 900 },
  ]);
  ok(empate[0].symbol === 'MM', 'dentro del grupo, lo grande primero: si algo falla por cash, que falle lo chico');
  ok(empate[1].symbol === 'AA' && empate[2].symbol === 'ZZ',
    'y el símbolo desempata — sin orden total, dos corridas con los mismos datos dan secuencias distintas y el replay no reproduce');
}

console.log('\n── B5: un cruce de signo son DOS patas, no una ──');
{
  const libro = [pos('TSLA', 10000, 40, 250)];
  const r = buildRebalance({ positions: libro, equity: EQUITY, target: { TSLA: -0.10 } });
  ok(r.legs.length === 2, 'largo → corto produce dos patas', String(r.legs.length));
  ok(r.legs[0].side === 'sell' && r.legs[0].weight_to === 0, 'primero se cierra el largo');
  ok(r.legs[1].side === 'short' && r.legs[1].weight_to === -0.10, 'después se abre el corto');
  ok(/antes de cruzar/.test(r.legs[0].note || ''), 'y se dice por qué', r.legs[0].note);

  const inverso = buildRebalance({ positions: [pos('ZM', -8000, -100, 80)], equity: EQUITY, target: { ZM: 0.10 } });
  ok(inverso.legs[0].side === 'cover' && inverso.legs[1].side === 'buy', 'corto → largo: cubrir y después comprar',
    inverso.legs.map((l) => l.side).join(','));
}

console.log('\n── B5: el signo del corto no se adivina mal ──');
{
  // Alpaca no siempre manda market_value negativo en un corto. Si el signo se
  // tomara solo de ahí, un corto se leería como un largo del mismo tamaño.
  const w = currentWeights([pos('ZM', 8000, -100, 80)], EQUITY);
  ok(w.ZM === -0.08, 'con market_value POSITIVO pero qty negativa, el peso sale NEGATIVO', String(w.ZM));
  ok(currentWeights([pos('ZM', -8000, -100, 80)], EQUITY).ZM === -0.08, 'y con los dos negativos, igual');
}

console.log('\n── B5: las órdenes viejas que ya no aplican se cancelan ──');
{
  const legs = [{ symbol: 'NVDA', side: 'buy' }, { symbol: 'AAPL', side: 'sell' }];
  const abiertas = [
    { id: '1', symbol: 'NVDA', side: 'buy' },
    { id: '2', symbol: 'NVDA', side: 'sell' },
    { id: '3', symbol: 'ZM', side: 'buy' },
  ];
  const c = staleOrders(abiertas, legs);
  ok(!c.some((x) => x.id === '1'), 'la orden que coincide con el plan de hoy se deja viva');
  ok(c.some((x) => x.id === '2' && /dirección contraria/.test(x.reason)),
    'la que va al revés se cancela: ejecutaría una decisión que el PM ya cambió');
  ok(c.some((x) => x.id === '3' && /decisión vieja/.test(x.reason)), 'y la de un nombre que el objetivo ya no toca, también');
}

// ── B6 · LOS RIELES ──────────────────────────────────────────────────
console.log('\n── B6: el parser no adivina la escala ──');
{
  ok(parseTarget({ pesos: { NVDA: 12 } }).weights.NVDA === 0.12, '12 es 12%');
  ok(parseTarget({ pesos: { ZM: -15 } }).weights.ZM === -0.15, 'y el signo negativo es un corto');
  const malo = parseTarget({ pesos: { NVDA: 1200 } });
  ok(!malo.ok && /PORCENTAJE/.test(malo.error),
    'un peso de 1200 se RECHAZA en vez de adivinarse: adivinar la escala es cómo un libro del 12% se vuelve uno del 1200%', malo.error);
  ok(parseTarget({ pesos: { NVDA: 'mucho' } }).ok === false, 'un peso no numérico se rechaza');
  ok(parseTarget({}).ok === false, 'sin pesos, se rechaza');
  ok(Object.keys(parseTarget({ pesos: { NVDA: 0 } }).weights).length === 0, 'un 0% explícito equivale a omitirlo: salir');
}

console.log('\n── B6: las exposiciones ──');
{
  const e = exposures({ A: 0.30, B: 0.20, C: -0.15 });
  ok(e.gross === 0.65 && e.net === 0.35 && e.short_gross === 0.15, 'bruto, neto y corto total', JSON.stringify(e));
  ok(e.cash_implied === 0.35, 'y el cash implícito');
}

console.log('\n── B6: DESCARTA, NO ESCALA — y reporta TODAS las violaciones ──');
{
  const meta = { A: { sector: 'XLK', price: 100 }, B: { sector: 'XLK', price: 100 }, C: { sector: 'XLE', price: 100 } };
  const v = validateTarget({ A: 0.35, B: 0.30, C: 0.50 }, meta);
  ok(!v.ok, 'un objetivo que viola se rechaza');
  const rieles = v.violations.map((x) => x.rail);
  ok(rieles.includes('R1'), 'R1: A al 35% pasa el tope de 30%');
  ok(rieles.includes('R3'), 'R3: el bruto suma 115%');
  ok(rieles.includes('R6'), 'R6: XLK suma 65%');
  ok(v.violations.length >= 3,
    'se reportan TODAS, no la primera — un PM que recibe "violaste R3" arregla R3 y choca con R6 mañana', String(v.violations.length));
  ok(validateTarget({ A: 0.20, C: 0.20 }, meta).ok, 'y un objetivo sano pasa');
}

console.log('\n── B6: el mínimo por posición ──');
{
  const v = validateTarget({ A: 0.01 }, { A: { sector: 'XLK' } });
  ok(v.violations.some((x) => x.rail === 'R8'), 'una posición del 1% viola el mínimo del 2%');
  ok(/no mueve la aguja/.test(v.violations.find((x) => x.rail === 'R8').detail), 'y se dice por qué existe la regla');
}

console.log('\n── B6: el corto FALLA CERRADO ──');
{
  const sinDato = validateTarget({ ZM: -0.10 }, { ZM: { sector: 'XLK', price: 60 } });
  ok(sinDato.violations.some((x) => x.rail === 'R9'),
    'sin confirmación de shortable + easy-to-borrow, el corto NO se abre');
  ok(/Fail closed/.test(sinDato.violations.find((x) => x.rail === 'R9').detail),
    'un campo ausente NO es un permiso: un buy-in forzado es ruido del broker metido en el resultado del experimento');

  const conDato = validateTarget({ ZM: -0.10 }, { ZM: { sector: 'XLK', price: 60, shortable: true, easy_to_borrow: true } });
  ok(conDato.ok, 'con los dos campos en true, pasa');

  const barato = validateTarget({ PENNY: -0.10 }, { PENNY: { sector: 'XLK', price: 7, shortable: true, easy_to_borrow: true } });
  ok(barato.violations.some((x) => x.rail === 'R10'), 'un corto bajo $10 se rechaza aunque el universo admita desde $5');
  ok(/squeezes/.test(barato.violations.find((x) => x.rail === 'R10').detail), 'porque ahí es donde viven los squeezes');
}

console.log('\n── B6: los topes del corto son la MITAD, y el total tiene techo ──');
{
  ok(RAILS.max_short_weight * 2 === RAILS.max_long_weight,
    'el tope del corto por nombre es la mitad del largo — la asimetría no es prudencia decorativa',
    `${RAILS.max_short_weight} vs ${RAILS.max_long_weight}`);
  const meta = (s) => Object.fromEntries(s.map((x) => [x, { sector: 'XLK', price: 100, shortable: true, easy_to_borrow: true }]));
  const v = validateTarget({ A: -0.14, B: -0.14, C: -0.14, D: -0.14 }, meta(['A', 'B', 'C', 'D']));
  ok(v.violations.some((x) => x.rail === 'R5'), 'cuatro cortos del 14% suman 56% > 50% del riel de corto total');
  const neto = validateTarget({ A: -0.15, B: -0.15, C: -0.15, D: -0.15 }, meta(['A', 'B', 'C', 'D']));
  ok(neto.violations.some((x) => x.rail === 'R4'),
    'y un libro 0% largo / 60% corto viola el neto: en 4 semanas eso no es un portafolio, es una apuesta direccional');
}

console.log('\n── B6: el bucket UNKNOWN tiene el mismo tope, y se dice ──');
{
  const v = validateTarget({ A: 0.30, B: 0.30 }, { A: {}, B: {} });
  const r6 = v.violations.find((x) => x.rail === 'R6');
  ok(r6 && r6.sector === SECTOR_UNKNOWN, 'los nombres sin sector caen en UNKNOWN y el tope aplica igual');
  ok(/falla de cobertura nuestra/.test(r6.detail),
    'diciendo que es una falla NUESTRA — prohibir operar sin sector castigaría al PM por eso', r6.detail);
}

// ── B6 · R12 EL RECORTE ──────────────────────────────────────────────
console.log('\n── B6 · R12: el motor RECORTA lo que se infló solo ──');
{
  // El caso del doc: un corto del 15% cuyo subyacente subió, ahora pesa 25%.
  const libro = [pos('ZM', -25000, -300, 80)];
  const t = railTrims(libro, EQUITY);
  ok(t.length === 1 && t[0].side === 'short', 'el corto inflado se detecta', JSON.stringify(t[0] && t[0].symbol));
  ok(t[0].weight_before === -0.25 && t[0].weight_after === -0.15, 'y se recorta al riel', `${t[0].weight_before} → ${t[0].weight_after}`);
  ok(/no tiene techo/.test(t[0].reason), 'con el motivo: un corto que sale mal crece', t[0].reason);
  ok(Math.abs(t[0].trim_fraction - 0.4) < 0.01, 'la fracción a cerrar es 40% de la posición', String(t[0].trim_fraction));

  // Y EL RECORTE GANA SOBRE EL OBJETIVO DEL PM.
  const r = buildRebalance({ positions: libro, equity: EQUITY, target: { ZM: -0.25 }, trims: t });
  ok(r.target.ZM === -0.15,
    'aunque el PM pida seguir al 25%, el recorte manda: rechazar entradas nuevas no sirve contra una posición que se infla sola',
    String(r.target.ZM));
  ok(r.rail_trims[0].target_asked === -0.25 && r.rail_trims[0].target_applied === -0.15,
    'y queda journaleado lo que pidió Y lo que se aplicó', JSON.stringify(r.rail_trims[0]));
  ok(r.legs.length === 1 && r.legs[0].side === 'cover', 'produce una cobertura parcial', JSON.stringify(r.legs[0]));

  // Un nombre recortado que el PM NI MENCIONA queda en el riel, no en cero: el
  // recorte es de la red, no una salida decidida por nadie.
  const sinMencion = buildRebalance({ positions: libro, equity: EQUITY, target: {}, trims: t });
  ok(sinMencion.target.ZM === -0.15, 'un recorte sobre un nombre omitido lo deja EN EL RIEL, no en cero', String(sinMencion.target.ZM));

  // Un largo inflado también se recorta (aunque tiende a auto-corregirse).
  const largo = railTrims([pos('NVDA', 40000, 200, 150)], EQUITY);
  ok(largo.length === 1 && largo[0].weight_after === 0.30, 'un largo del 40% se recorta al 30%', String(largo[0].weight_after));
  ok(railTrims([pos('NVDA', 25000, 100, 150)], EQUITY).length === 0, 'y uno dentro del riel no se toca');
}

// ── B7 · LA RED DEL CORTO ────────────────────────────────────────────
console.log('\n── B7: los números del corto NO son simétricos ──');
{
  ok(SHORT_RULES.catastrophic_stop_pct === 0.20,
    'el stop del corto es +20%, no +22%: a 20% en contra la posición ya creció de 15% a ~18% del libro',
    String(SHORT_RULES.catastrophic_stop_pct));
  ok(shortQty(pos('ZM', -8000, -100, 80)) === 100, 'la cantidad a cubrir es el valor absoluto de qty');
  ok(shortQty(pos('NVDA', 8000, 100, 80)) === 0, 'y un LARGO devuelve 0: pasar el libro entero da solo los cortos');
  ok(isShort(pos('ZM', -8000, -100, 80)) && !isShort(pos('NVDA', 8000, 100, 80)), 'isShort distingue');
}

console.log('\n── B7: el stop catastrófico del corto va HACIA ARRIBA ──');
{
  const p = pos('ZM', -8000, -100, 80);
  ok(shortCatastrophicLevel(p) === 96, 'entrada 80 → nivel 96 (+20%)', String(shortCatastrophicLevel(p)));
  ok(planShortCatastrophicStops({ positions: [p], closes: { ZM: 97 } }).exits.length === 1, 'cierre 97 > 96 → cubre');
  ok(planShortCatastrophicStops({ positions: [p], closes: { ZM: 95 } }).exits.length === 0, 'cierre 95 < 96 → no');
  ok(planShortCatastrophicStops({ positions: [p], closes: {} }).exits.length === 0,
    'sin cierre NO se dispara a ciegas: un dato faltante no cierra una posición por sorpresa');
  const e = planShortCatastrophicStops({ positions: [p], closes: { ZM: 97 } }).exits[0];
  ok(e.side === 'cover' && e.reason_code === 'short_catastrophic_stop', 'la salida se marca como cobertura', e.reason_code);
}

console.log('\n── B7: EL ESPEJO DEL PICO — en un corto se recuerda el MÍNIMO ──');
{
  const p = pos('ZM', -8000, -100, 100);
  // El piso llegó a 85 (−15% a favor) → arma. Techo = 85 × 1.08 = 91.8.
  const st = shortTrailingState(p, 85);
  ok(st.armed === true, 'un piso en 85 desde una entrada de 100 ARMA el trailing (−15% a favor)');
  ok(st.level === 91.8, 'y el nivel de disparo es 91.8 (+8% desde el piso)', String(st.level));
  ok(shortTrailingState(p, 90).armed === false, 'un piso en 90 (solo −10%) NO arma todavía');

  ok(planShortTrailingStops({ positions: [p], closes: { ZM: 92 }, lows: { ZM: 85 } }).exits.length === 1,
    'el precio rebota a 92 ≥ 91.8 → cubre');
  ok(planShortTrailingStops({ positions: [p], closes: { ZM: 86 }, lows: { ZM: 85 } }).exits.length === 0,
    'a 86 sigue abierto');

  // LA REGLA QUE IMPORTA: por construcción cubre CON GANANCIA.
  ok(st.level < 100,
    'el nivel del trailing está SIEMPRE por debajo de la entrada → por construcción cubre con ganancia, nunca en pérdida',
    `${st.level} < 100`);

  // Y el error que este espejo evita: usar el MÁXIMO dispararía yendo bien.
  const conMaximo = shortTrailingState(p, 120);   // como si se hubiera guardado el máximo
  ok(conMaximo.armed === false,
    'si por error se guardara el MÁXIMO en vez del mínimo, el trailing no armaría — el bug sería silencioso, por eso hay un test');
}

console.log('\n── B7: el mínimo se techa a la ENTRADA ──');
{
  const p = pos('ZM', -8000, -100, 100);
  const serie = { ZM: { closes: [105, 110, 108], dates: ['2026-09-10', '2026-09-11', '2026-09-12'] } };
  const lows = lowsFromSeries([p], serie);
  ok(lows.ZM === 100,
    'un corto que nunca bajó de su entrada tiene piso = entrada, no 105: sin ese techo el trailing armaría por aritmética, no por haber ganado', String(lows.ZM));
  const bajo = lowsFromSeries([p], { ZM: { closes: [95, 84, 88], dates: ['2026-09-10', '2026-09-11', '2026-09-12'] } });
  ok(bajo.ZM === 84, 'y cuando sí bajó, el piso es el mínimo real', String(bajo.ZM));
  ok(Object.keys(lowsFromSeries([pos('NVDA', 8000, 100, 80)], serie)).length === 0, 'un largo no produce piso');
}

console.log('\n── B7 · R11: un buy-in forzado NO es una decisión del PM ──');
{
  const f = detectForcedBuyIns({ previousShorts: ['ZM', 'GME'], currentPositions: [pos('GME', -5000, -50, 100)], ourCovers: [] });
  ok(f.length === 1 && f[0].symbol === 'ZM', 'ZM desapareció sin cobertura nuestra → buy-in forzado', JSON.stringify(f.map((x) => x.symbol)));
  ok(/NO es una decisión del PM/.test(f[0].detail),
    'y se marca como tal: contarlo como salida contaminaría el post-mortem con una decisión que el modelo nunca tomó');
  ok(detectForcedBuyIns({ previousShorts: ['ZM'], currentPositions: [], ourCovers: [{ symbol: 'ZM' }] }).length === 0,
    'si la cobertura fue NUESTRA, no es un buy-in');
  ok(detectForcedBuyIns({ previousShorts: ['GME'], currentPositions: [pos('GME', -5000, -50, 100)] }).length === 0,
    'y un corto que sigue abierto tampoco');
}

console.log('\n── el turnover, como métrica de churn (D6: sin slippage simulado) ──');
{
  const r = buildRebalance({
    positions: [pos('A', 20000, 100, 200)], equity: EQUITY, target: { A: 0.10, B: 0.10 },
  });
  ok(r.turnover === 0.20, 'la suma de |Δpeso| de las patas ejecutadas', String(r.turnover));
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
