// ═══════════════════════════════════════════════════════════════
// tests/alpaca-feed-por-cuenta.test.mjs — el viernes que la liga no operó.
//
// EL CASO (2026-09-18): los siete agentes, todo el día. Cada corrida decía
// "modo enviado · EN VIVO · pasa los rieles" y terminaba con CERO ÓRDENES,
// todas las patas en "sin precio de referencia para X". Libros congelados.
//
// LA CAUSA, y es un error de diseño: el Arena usa OCHO cuentas de Alpaca —la
// maestra (tablero y universo) y una por agente— y la suscripción a SIP es POR
// CUENTA. El veredicto de feed estaba en UNA variable de módulo compartida por
// las ocho, y además RESTRINGÍA los intentos en vez de ordenarlos:
//
//   1. el tablero corre con la maestra, SIP contesta, se recuerda 'sip';
//   2. cada agente pide precios con SU cuenta, que no tiene SIP → 403;
//   3. `[feedResuelto]` era la lista COMPLETA, sin IEX detrás → la llamada LANZA;
//   4. `arena-meta.js` traga el error y devuelve {} → sin precios;
//   5. cada pata se descarta "sin precio de referencia" → cero órdenes.
//
// Correr con `node tests/alpaca-feed-por-cuenta.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { getSnapshots, getAvgDailyVolume, feedDatosResuelto, resetFeedDatos } from '../api/_lib/alpaca.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const MAESTRA = { key: 'MAESTRA', secret: 's' };
const AGENTE = { key: 'AGENTE_CLAUDE', secret: 's' };
const OTRO = { key: 'AGENTE_GROK', secret: 's' };

const CUERPO = JSON.stringify({
  snapshots: { NVDA: { latestTrade: { p: 180, t: 't' }, dailyBar: { v: 1000, c: 179 }, prevDailyBar: { c: 175 } } },
  bars: { NVDA: [{ t: '2026-09-17T00:00:00Z', v: 900, c: 179 }] },
});

let pedidos = [];
// Solo la MAESTRA tiene SIP. Es la situación real de la cuenta de Lety.
function montar({ conSip = ['MAESTRA'] } = {}) {
  pedidos = [];
  global.fetch = async (url, opt) => {
    const feed = new URL(url).searchParams.get('feed');
    const quien = opt.headers['APCA-API-KEY-ID'];
    pedidos.push(`${quien}:${feed}`);
    if (feed === 'sip' && !conSip.includes(quien)) {
      return { ok: false, status: 403, text: async () => '{"message":"subscription does not permit"}' };
    }
    return { ok: true, status: 200, text: async () => CUERPO };
  };
}

process.env.ALPACA_PAPER_KEY = 'x';
process.env.ALPACA_PAPER_SECRET = 'y';
delete process.env.ALPACA_DATA_FEED;

console.log('\n── LA REGRESIÓN DEL VIERNES ──');
{
  resetFeedDatos(); montar();
  const maestra = await getSnapshots(['NVDA'], MAESTRA);
  ok(maestra.NVDA.price === 180, 'la maestra resuelve SIP, como el viernes');
  ok(feedDatosResuelto(MAESTRA) === 'sip', 'y su veredicto queda en sip');

  // ÉSTA es la llamada que el viernes lanzaba y dejaba la corrida sin precios.
  const agente = await getSnapshots(['NVDA'], AGENTE);
  ok(agente.NVDA && agente.NVDA.price === 180,
    'la cuenta del agente, SIN SIP, igual obtiene precio: el 403 cae a IEX en vez de lanzar',
    JSON.stringify(agente.NVDA));
  ok(pedidos.join(' ') === 'MAESTRA:sip AGENTE_CLAUDE:sip AGENTE_CLAUDE:iex',
    'y se ve la caída: sip, 403, iex', pedidos.join(' '));
}

console.log('\n── el veredicto es POR CUENTA ──');
{
  ok(feedDatosResuelto(MAESTRA) === 'sip' && feedDatosResuelto(AGENTE) === 'iex',
    'la maestra queda en sip y el agente en iex: una sola variable para las ocho era el bug',
    JSON.stringify({ maestra: feedDatosResuelto(MAESTRA), agente: feedDatosResuelto(AGENTE) }));
  ok(feedDatosResuelto(OTRO) === null, 'y una cuenta que no se usó todavía no tiene veredicto');
  ok(feedDatosResuelto(null) === null, 'sin creds tampoco inventa uno');
}

console.log('\n── el veredicto ORDENA, no restringe ──');
{
  // Esto es lo que salva el caso aunque la clave fuera perfecta: una
  // suscripción que caduca deja a la cuenta con un veredicto que ya no vale.
  resetFeedDatos(); montar({ conSip: ['MAESTRA', 'AGENTE_CLAUDE'] });
  await getSnapshots(['NVDA'], AGENTE);
  ok(feedDatosResuelto(AGENTE) === 'sip', 'el agente tiene SIP hoy y se recuerda');

  montar({ conSip: ['MAESTRA'] });              // mañana le caducó
  const despues = await getSnapshots(['NVDA'], AGENTE);
  ok(despues.NVDA && despues.NVDA.price === 180,
    'y si mañana le caduca, el veredicto guardado NO lo deja sin salida: reintenta y cae a IEX',
    pedidos.join(' '));
  ok(feedDatosResuelto(AGENTE) === 'iex', 'el veredicto se corrige solo');
}

console.log('\n── no se re-paga el 403 en cada llamada ──');
{
  resetFeedDatos(); montar();
  await getSnapshots(['NVDA'], AGENTE);
  const primera = pedidos.length;
  pedidos = [];
  await getSnapshots(['NVDA'], AGENTE);
  ok(primera === 2 && pedidos.join(' ') === 'AGENTE_CLAUDE:iex',
    'la primera paga sip+iex; la segunda arranca directo en iex', `${primera} → ${pedidos.join(' ')}`);
}

console.log('\n── el RVOL del vigilante sigue coherente por cuenta ──');
{
  resetFeedDatos(); montar();
  await getSnapshots(['NVDA'], AGENTE);
  pedidos = [];
  await getAvgDailyVolume(['NVDA'], { days: 20, today: '2026-09-18', creds: AGENTE });
  ok(pedidos.join(' ') === 'AGENTE_CLAUDE:iex',
    'el promedio de volumen usa el MISMO feed que el snapshot de esa cuenta: numerador y denominador no se pueden separar',
    pedidos.join(' '));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
