// ═══════════════════════════════════════════════════════════════
// tests/arena-apertura.test.mjs — el contexto del momento en que se abrió.
//
// Por cada posición que un agente ABRE se guarda el estado del mundo en ese
// instante: momentum, sector, noticias y lo que el mercado de opciones cobraba
// por que terminara arriba de la entrada.
//
// La pregunta que esto existe para contestar: ¿en qué CONDICIONES le va bien a
// cada modelo? "Compró NVDA y ganó 4%" no distingue al que entra en rupturas
// con volumen del que entra en nombres castigados.
//
// Lo que se blinda:
//   1. SÓLO APERTURAS. Un agregado a una posición viva es la misma tesis
//      promediada, no una decisión nueva.
//   2. LA PROBABILIDAD ES RISK-NEUTRAL Y DEL FRONT EXPIRY, con su método
//      declarado. Model-free cuando se puede; Black-Scholes cuando no.
//   3. NINGUNA PIEZA PUEDE TUMBAR LA CORRIDA. Esto corre DESPUÉS de mandar
//      órdenes: una excepción acá dejaría órdenes en Alpaca sin fila.
//
// Correr con `node tests/arena-apertura.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { esApertura, momentumDe, sectorDe, contextoDeApertura, MAX_SIMBOLOS } from '../api/_lib/arena-apertura.js';
import { normalCdf, probBlackScholes, probDesdeCadena, diasHasta, opcionesDeApertura } from '../api/_lib/arena-opciones.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

console.log('\n── qué cuenta como APERTURA ──');
{
  ok(esApertura({ side: 'buy', weight_from: 0 }) === true, 'entrar de cero es una apertura');
  ok(esApertura({ side: 'buy', weight_from: 0.08 }) === false,
    'agregar a una posición viva NO: es la misma tesis promediada, no una decisión nueva');
  ok(esApertura({ side: 'sell', weight_from: 0 }) === false, 'una venta nunca abre');
  ok(esApertura({ side: 'buy' }) === true,
    'sin `weight_from` se captura igual — mejor de más que de menos; el peso anterior se guarda para poder filtrar');
  ok(esApertura(null) === false, 'y nada no revienta');
}

console.log('\n── el momentum sale de lo que la corrida YA pagó ──');
{
  const m = momentumDe('NVDA', {
    universo: { retornos: { NVDA: { ret_5d: 3.2, ret_1m: 11.4 } }, sectores: { NVDA: 'XLK' } },
    buffet: { movers: [{ symbol: 'NVDA', change_pct: 2.1 }] },
  });
  ok(m.ret_1d === 2.1 && m.ret_5d === 3.2 && m.ret_1m === 11.4, 'los tres retornos', JSON.stringify(m));
  ok(/buffet/.test(m.fuente.ret_1d) && /universo/.test(m.fuente.ret_5d_1m),
    'con la fuente de cada uno: un null de "no estaba en los movers" no es lo mismo que "el universo no trajo retornos"');

  const sin = momentumDe('ZZZ', { universo: null, buffet: null });
  ok(sin.ret_1d === null && sin.ret_5d === null,
    'sin datos, null — nunca 0: un ret_1d de 0 se lee como "no se movió"');
  ok(/no estaba en las listas/.test(sin.fuente.ret_1d), 'y se dice por qué falta');

  ok(sectorDe('NVDA', { universo: { sectores: { NVDA: 'XLK' } } }) === 'XLK', 'el sector, del universo');
  ok(sectorDe('NVDA', { universo: null }) === null, 'y null cuando no está');
}

console.log('\n── la probabilidad implícita: dos métodos, y se declara cuál ──');
{
  ok(Math.abs(normalCdf(0) - 0.5) < 1e-6 && Math.abs(normalCdf(1.96) - 0.975) < 1e-3,
    'la normal acumulada, sin dependencias y determinista');

  // MODEL-FREE: la pendiente del precio del call respecto del strike ES la CDF.
  const p = probDesdeCadena([{ strike: 100, bid: 2.9, ask: 3.1 }, { strike: 105, bid: 1.1, ask: 1.3 }], 101);
  ok(p === 0.64, 'la CDF del mercado sale de dos strikes contiguos, sin suponer ninguna distribución', String(p));

  // Una cadena rota NO se usa: un call más caro con strike más alto viola
  // arbitraje, y una probabilidad sacada de ahí sale al revés.
  ok(probDesdeCadena([{ strike: 100, bid: 1, ask: 1 }, { strike: 105, bid: 3, ask: 3 }], 101) === null,
    'una cadena que viola monotonía se descarta en vez de publicar un número imposible');
  ok(probDesdeCadena([{ strike: 100, bid: 3, ask: 3 }], 101) === null, 'y con un solo strike no hay pendiente');

  // BLACK-SCHOLES como respaldo.
  const bs = probBlackScholes({ spot: 100, strike: 100, iv: 0.30, dias: 30 });
  ok(bs > 0.45 && bs < 0.5,
    'N(d₂) at-the-money queda apenas abajo de 0.5 — el arrastre de −σ²/2, que es correcto y contraintuitivo', String(bs));
  ok(probBlackScholes({ spot: 100, strike: 100, iv: 0, dias: 30 }) === null, 'IV cero no da probabilidad, da null');
  ok(probBlackScholes({ spot: 100, strike: 100, iv: 0.3, dias: null }) === null, 'ni sin horizonte');

  ok(diasHasta(Math.floor(Date.now() / 1000) - 86400) === null,
    'un vencimiento que ya pasó no es un horizonte: es una cadena vieja');
}

console.log('\n── el bloque de opciones, armado ──');
{
  const exp = Math.floor((Date.now() + 7 * 86400000) / 1000);
  const chainRes = {
    quote: { regularMarketPrice: 100 },
    options: [{
      expirationDate: exp,
      calls: [
        { strike: 95, bid: 6.0, ask: 6.2, impliedVolatility: 0.32, inTheMoney: true },
        { strike: 100, bid: 2.9, ask: 3.1, impliedVolatility: 0.30, inTheMoney: false },
        { strike: 105, bid: 1.1, ask: 1.3, impliedVolatility: 0.29, inTheMoney: false },
      ],
      puts: [{ strike: 100, bid: 2.8, ask: 3.0, impliedVolatility: 0.31 }],
    }],
  };
  const o = opcionesDeApertura(chainRes, { entrada: 101 });
  ok(o.disponible === true && o.metodo === 'cdf',
    'se prefiere el método model-free cuando la cadena lo permite', o.metodo);
  ok(o.prob_cdf != null && o.prob_bs != null,
    'y se guardan LOS DOS: son números distintos y sin los dos no se pueden comparar los métodos',
    JSON.stringify({ cdf: o.prob_cdf, bs: o.prob_bs }));
  ok(o.iv_atm > 0.29 && o.iv_atm < 0.32, 'la IV at-the-money, promedio del call y el put más cercanos', String(o.iv_atm));
  ok(/RISK-NEUTRAL/.test(o.nota) && /lo que el mercado COBRA, no lo que cree/.test(o.nota),
    'la nota dice lo que el número NO es — que es donde se malinterpreta');
  ok(/días/.test(o.nota) && o.dias_al_vencimiento > 6,
    'y el horizonte: es "al cierre de ese viernes", no "algún día"');

  ok(opcionesDeApertura(null, { entrada: 100 }).disponible === false, 'sin cadena, no se inventa');
  ok(opcionesDeApertura(chainRes, {}).disponible === false, 'sin precio de entrada tampoco: no hay strike contra qué medir');
}

console.log('\n── ninguna pieza puede tumbar la corrida ──');
{
  // Esto corre DESPUÉS de mandar órdenes: una excepción dejaría órdenes en
  // Alpaca sin la fila que las explica.
  const ctx = await contextoDeApertura({ symbol: 'NVDA', limit_price: 101 }, {
    universo: { retornos: { NVDA: { ret_5d: 1 } }, sectores: { NVDA: 'XLK' } },
    deps: {
      news: async () => { throw new Error('Alpaca caída'); },
      chain: async () => { throw new Error('Yahoo caído'); },
    },
  });
  ok(ctx.symbol === 'NVDA' && ctx.momentum.ret_5d === 1 && ctx.sector === 'XLK',
    'con las dos fuentes de red caídas, el snapshot sigue teniendo lo que ya estaba en memoria');
  ok(ctx.noticias.error === 'Alpaca caída' && ctx.opciones.motivo === 'Yahoo caído',
    'y cada fallo queda con su motivo, por separado', JSON.stringify({ n: ctx.noticias.error, o: ctx.opciones.motivo }));

  const src = readFileSync(new URL('../api/_lib/arena-apertura.js', import.meta.url), 'utf8');
  ok(/for \(const orden of aperturas\)[\s\S]{0,900}?try \{/.test(src),
    'cada símbolo se guarda en su propio try: un símbolo raro no se lleva a los otros');
  ok(MAX_SIMBOLOS > 0 && MAX_SIMBOLOS <= 20,
    'y hay un tope por corrida: siete agentes × ocho posiciones son 56 cadenas de opciones en una lambda con reloj',
    String(MAX_SIMBOLOS));
}

console.log('\n── corre DESPUÉS de mandar las órdenes ──');
{
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  const iEnviar = shadow.indexOf('ejecucion.enviadas = await enviarOrdenes(');
  const iCtx = shadow.indexOf('registrarAperturas({');
  ok(iEnviar > 0 && iCtx > iEnviar,
    'el contexto se arma DESPUÉS del envío: una noticia que tarda en bajar no puede retrasar un fill',
    `enviar@${iEnviar} contexto@${iCtx}`);
  ok(/if \(vivo && ejecucion/.test(shadow),
    'y sólo en VIVO: una corrida de prueba no abre nada, así que su "apertura" no es un momento que haya existido');
  ok(/aperturas = \{ guardadas: 0, error:/.test(shadow),
    'con un catch alrededor de todo: perder un snapshot es perder una fila de estudio; tumbar la corrida deja órdenes sin explicación');
}

console.log(failures ? `\n${failures} FAIL` : '\nTODOS LOS TESTS PASAN');
process.exit(failures ? 1 : 0);
