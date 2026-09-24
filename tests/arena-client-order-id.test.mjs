// ═══════════════════════════════════════════════════════════════
// tests/arena-client-order-id.test.mjs — EL ID QUE COLISIONABA CONSIGO MISMO.
//
// EL CASO, medido en producción el 2026-09-24: 525 órdenes calculadas del 21 al
// 24, ~216 que nunca llegaron a Alpaca, y las VENTAS fallando muchísimo más que
// las compras (en la muestra de quince filas: 2 de 8 compras, 5 de 6 ventas).
//
// Dos filas reales del mismo agente, el mismo día, el mismo ticker y el mismo
// lado, con cinco minutos de diferencia:
//
//     control 19:31 GDDY buy → approved, filled 29 @ 101.81
//     control 19:36 GDDY buy → submit_failed
//
// El `client_order_id` llevaba agente, fecha, ticker y lado, y NO la corrida.
// Alpaca rechaza un id repetido, así que cada agente podía tocar cada nombre
// UNA vez por día por lado y el resto moría con un 422 silencioso.
//
// Lo que este archivo fija:
//
//   1. DOS CORRIDAS DEL MISMO DÍA NO COMPARTEN ID. Es el bug.
//   2. LA MISMA CORRIDA SÍ. Es la idempotencia que NO se puede perder: un cron
//      que se repite no puede mandar la orden dos veces.
//   3. EL LADO NUNCA SE PIERDE POR RECORTE. Truncar por la cola convertía
//      `-buy` y `-sell` en el mismo id, y una compra cancelaba una venta.
//   4. LOS DOS CAMINOS SE ARREGLAN JUNTOS. El del PM y el de los stops. Este
//      repo ya arregló esto una vez en el contrato de acciones y no se lo
//      llevó al objetivo; el tercer camino no se va a quedar afuera.
//
// Correr con `node tests/arena-client-order-id.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { clientOrderIdObjetivo, minutoDeCorrida, AGENTE_EN_ID } from '../api/_lib/arena-objetivo-vivo.js';
import { ARENA_AGENTS } from '../api/_lib/arena-registry.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

// Las dos corridas reales del jueves, tal cual.
const R1931 = new Date('2026-09-24T19:31:12Z');
const R1936 = new Date('2026-09-24T19:36:04Z');
const GDDY = { agentId: 'control', runDate: '2026-09-24', symbol: 'GDDY', side: 'buy' };

// ── 1) EL BUG ────────────────────────────────────────────────────────
console.log('\n── dos corridas del mismo día ya no comparten id ──');
{
  const a = clientOrderIdObjetivo({ ...GDDY, now: R1931 });
  const b = clientOrderIdObjetivo({ ...GDDY, now: R1936 });
  ok(a !== b, 'las 19:31 y las 19:36 producen ids distintos — antes eran byte a byte el mismo',
    JSON.stringify([a, b]));
  ok(/1931/.test(a) && /1936/.test(b), 'y el minuto está a la vista en el id, no escondido en un hash', a);

  // El id viejo, para que quede en el archivo qué era exactamente lo que fallaba.
  const viejo = (now) => `arena-${GDDY.agentId}-f-${GDDY.runDate}-${GDDY.symbol}-${GDDY.side}`.slice(0, 48);
  ok(viejo(R1931) === viejo(R1936),
    'el id VIEJO sí era idéntico entre las dos: es la reproducción del 422', viejo(R1931));
}

// ── 2) LA IDEMPOTENCIA QUE NO SE PUEDE PERDER ────────────────────────
// Si esto se rompe, un cron que se repite manda la orden dos veces. Es el
// motivo por el que el id existe, y arreglar la colisión no puede costarlo.
console.log('\n── la MISMA corrida sigue produciendo el mismo id ──');
{
  const a = clientOrderIdObjetivo({ ...GDDY, now: new Date('2026-09-24T19:31:12Z') });
  const b = clientOrderIdObjetivo({ ...GDDY, now: new Date('2026-09-24T19:31:58Z') });
  ok(a === b, 'dos invocaciones de la misma corrida (46 segundos aparte) dan el MISMO id: el reintento no duplica', a);
}

// ── 3) EL LADO Y EL DÍA NUNCA SE CONFUNDEN ───────────────────────────
console.log('\n── lo que el id tiene que distinguir, lo distingue ──');
{
  const base = { ...GDDY, now: R1931 };
  const buy = clientOrderIdObjetivo(base);
  const sell = clientOrderIdObjetivo({ ...base, side: 'sell' });
  ok(buy !== sell, 'compra y venta del mismo nombre en la misma corrida: ids distintos');
  ok(clientOrderIdObjetivo({ ...base, symbol: 'AAPL' }) !== buy, 'dos nombres distintos: ids distintos');
  ok(clientOrderIdObjetivo({ ...base, agentId: 'claude' }) !== buy, 'dos agentes distintos: ids distintos');
  ok(clientOrderIdObjetivo({ ...base, runDate: '2026-09-25' }) !== buy,
    'y dos DÍAS distintos, aunque el minuto coincida — el minuto solo no alcanza');
}

// ── 4) EL RECORTE NO PUEDE COMERSE EL LADO ───────────────────────────
// Ésta es la que importa de verdad: `.slice(0, 48)` recortaba por la cola, y la
// cola es el lado. Dos ids truncados al mismo largo serían el mismo id, y una
// compra cancelaría una venta. Ahora el largo está acotado por construcción y
// se verifica contra el REGISTRY, no contra un agente inventado.
console.log('\n── el largo, contra el registry entero ──');
{
  const TOPE = 48;
  const peores = [];
  for (const a of ARENA_AGENTS) {
    for (const sym of ['GOOGL', 'BRK.B', 'ABCDEF']) {
      for (const side of ['buy', 'sell']) {
        const id = clientOrderIdObjetivo({ agentId: a.id, runTag: 'w', runDate: '2026-09-24', symbol: sym, side, now: R1931 });
        peores.push({ id, len: id.length });
      }
    }
  }
  const max = peores.reduce((m, x) => (x.len > m.len ? x : m), peores[0]);
  ok(max.len <= TOPE, `el id más largo de los ${ARENA_AGENTS.length} agentes mide ${max.len} ≤ ${TOPE}`, max.id);
  ok(peores.every((x) => /-(buy|sell)$/.test(x.id)), 'y todos terminan con el lado entero: nada lo recorta');

  // Un agente con un id larguísimo se capa en el segmento del AGENTE, nunca en
  // el lado. Si algún día entra uno así, el test de arriba es el que avisa.
  const largo = clientOrderIdObjetivo({ agentId: 'un-agente-con-nombre-larguisimo', runDate: '2026-09-24', symbol: 'GOOGL', side: 'sell', now: R1931 });
  ok(/-sell$/.test(largo), 'incluso con un agente absurdo, el lado sobrevive', largo);
  ok(largo.includes('un-agente-'.slice(0, AGENTE_EN_ID)), 'lo que se capa es el agente, que es lo único de largo variable');
}

// ── 5) LOS DOS CAMINOS, Y QUE NO SE PISEN ENTRE SÍ ───────────────────
console.log('\n── el camino del PM y el de los stops ──');
{
  const run = readFileSync(new URL('../api/arena-run.js', import.meta.url), 'utf8');
  ok(/`arena:\$\{runDate\}:\$\{a\.symbol\}:exit:\$\{minuto\}`/.test(run),
    'el id de las salidas de riesgo también lleva el minuto');
  ok(/import \{ usaObjetivo, contratoActivo, permiteCortos, minutoDeCorrida \}/.test(run),
    'y usa el MISMO helper que el otro camino: el bug nació de que un camino tuviera el arreglo y el otro no');
  ok(/submitRiskExits\(risk\.approved, runDate, creds, createLimitOrder, now\)/.test(run),
    'los tres llamadores le pasan `now`, o el minuto sería el del import y no el de la corrida');

  // El stop y la venta del PM sobre el mismo nombre no pueden compartir id:
  // `:exit` es lo que los separa, y sigue ahí.
  const delPM = clientOrderIdObjetivo({ agentId: 'claude', runDate: '2026-09-24', symbol: 'PGR', side: 'sell', now: R1931 });
  const delStop = `arena:2026-09-24:PGR:exit:${minutoDeCorrida(R1931)}`;
  ok(delPM !== delStop, 'un stop y una venta del PM del mismo nombre y minuto siguen sin colisionar');

  // La escalera de escalamiento del stop catastrófico depende de poder
  // REINTENTAR con la banda ensanchada. Con el id viejo, el reintento se
  // rechazaba y la banda nunca llegaba al broker.
  const t1 = `arena:2026-09-24:PGR:exit:${minutoDeCorrida(new Date('2026-09-24T13:35:00Z'))}`;
  const t2 = `arena:2026-09-24:PGR:exit:${minutoDeCorrida(new Date('2026-09-24T14:05:00Z'))}`;
  ok(t1 !== t2, 'y un stop que no llenó puede reintentar más tarde: la escalera de bandas vuelve a poder subir');
}

// ── 6) EL LLAMADOR YA NO ESTAMPA 'f' A TODO ──────────────────────────
console.log('\n── el tag dice qué despertó la orden ──');
{
  const shadow = readFileSync(new URL('../api/arena-shadow.js', import.meta.url), 'utf8');
  ok(!/runTag: 'f',/.test(shadow), "ya no está el runTag: 'f' escrito a mano");
  ok(/evento\.type === 'post_earnings_morning' \? 'm' : 'w'/.test(shadow),
    'el tag sale del evento: matutina, disparador, o ronda fija');
  ok(/: 'd',/.test(shadow), 'y una ronda fija se estampa como decide, no como revisión de piso');
}

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo en verde');
process.exit(failures ? 1 : 0);
