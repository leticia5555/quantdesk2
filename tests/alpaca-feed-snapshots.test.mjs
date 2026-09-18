// ═══════════════════════════════════════════════════════════════
// tests/alpaca-feed-snapshots.test.mjs — la trampa de pagar SIP y seguir en IEX.
//
// `getSnapshots` usaba `alpacaDataFeed()` a secas: sin ALPACA_DATA_FEED eso es
// 'iex' y no prueba nada más. El universo SÍ intentaba SIP primero, así que las
// dos mitades del Arena podían leer feeds distintos — y el día que se contratara
// SIP, los PRECIOS DE REFERENCIA DE LOS LÍMITES habrían seguido saliendo de IEX
// en silencio. Se paga el consolidado y se siguen preciando las órdenes con una
// bolsa que es el ~2-3% del volumen.
//
// Se prueba: intenta SIP, cae a IEX SOLO con los status que significan "no
// tenés el plan", NO cae con un 500, respeta ALPACA_DATA_FEED, y cachea el
// veredicto para no pagar el 403 en cada llamada.
// Correr con `node tests/alpaca-feed-snapshots.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { getSnapshots, getSnapshotsConFeed, getAvgDailyVolume, feedDatosResuelto, resetFeedDatos as resetFeedSnapshots } from '../api/_lib/alpaca.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

process.env.ALPACA_PAPER_KEY = 'k';
process.env.ALPACA_PAPER_SECRET = 's';
delete process.env.ALPACA_DATA_FEED;

const CUERPO = { snapshots: { NVDA: { latestTrade: { p: 180, t: '2026-09-18T14:00:00Z' }, dailyBar: { v: 1000, o: 178, c: 179 }, prevDailyBar: { c: 175 } } } };

let pedidos = [];
function montarFetch({ sipStatus = 200 } = {}) {
  pedidos = [];
  global.fetch = async (url) => {
    const feed = new URL(url).searchParams.get('feed');
    pedidos.push(feed);
    if (feed === 'sip' && sipStatus !== 200) {
      return { ok: false, status: sipStatus, text: async () => JSON.stringify({ message: 'subscription does not permit' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(CUERPO) };
  };
}

console.log('\n── la cuenta SÍ tiene SIP ──');
{
  resetFeedSnapshots(); montarFetch({ sipStatus: 200 });
  const r = await getSnapshotsConFeed(['NVDA']);
  ok(pedidos[0] === 'sip', 'se intenta el CONSOLIDADO primero, no IEX por default', pedidos[0]);
  ok(r.feed === 'sip', 'y el feed que contestó viaja en el resultado', String(r.feed));
  ok(r.data.NVDA.price === 180, 'con los datos de siempre', JSON.stringify(r.data.NVDA));
}

console.log('\n── la cuenta NO tiene SIP (403) ──');
{
  resetFeedSnapshots(); montarFetch({ sipStatus: 403 });
  const r = await getSnapshotsConFeed(['NVDA']);
  ok(pedidos.join(',') === 'sip,iex', 'un 403 de SIP baja a IEX: "no tenés el plan" no deja ciego al vigilante', pedidos.join(','));
  ok(r.feed === 'iex', 'y lo DICE en vez de dejarlo implícito', String(r.feed));
  ok(r.data.NVDA.price === 180, 'los datos llegan igual');

  // LA CACHÉ: sin ella cada llamada vuelve a pagar el 403.
  pedidos = [];
  await getSnapshotsConFeed(['NVDA']);
  ok(pedidos.join(',') === 'iex', 'la segunda llamada ya no re-intenta SIP: el veredicto se recuerda', pedidos.join(','));
}

console.log('\n── un 500 NO es "no tenés el plan" ──');
{
  resetFeedSnapshots();
  pedidos = [];
  global.fetch = async (url) => {
    pedidos.push(new URL(url).searchParams.get('feed'));
    return { ok: false, status: 500, text: async () => 'boom' };
  };
  let lanzo = false;
  try { await getSnapshotsConFeed(['NVDA']); } catch (e) { lanzo = true; }
  ok(lanzo, 'un 500 se propaga: reintentar con otro feed taparía una caída de Alpaca');
  ok(pedidos.join(',') === 'sip', 'y NO se probó IEX', pedidos.join(','));
}

console.log('\n── ALPACA_DATA_FEED puesta a mano se respeta ──');
{
  resetFeedSnapshots(); montarFetch({ sipStatus: 200 });
  process.env.ALPACA_DATA_FEED = 'iex';
  const r = await getSnapshotsConFeed(['NVDA']);
  ok(pedidos.join(',') === 'iex', 'una preferencia explícita no se pisa ni se "mejora"', pedidos.join(','));
  ok(r.feed === 'iex', 'y es la que se reporta');
  delete process.env.ALPACA_DATA_FEED;
}

console.log('\n── getSnapshots conserva su firma: ningún llamador cambia ──');
{
  resetFeedSnapshots(); montarFetch({ sipStatus: 403 });
  const mapa = await getSnapshots(['NVDA']);
  ok(mapa.NVDA && mapa.NVDA.price === 180 && mapa.NVDA.prev_close === 175,
    'devuelve el mapa pelado de siempre, sin envoltorio', JSON.stringify(mapa.NVDA));
  ok((await getSnapshots([])).NVDA === undefined, 'y una lista vacía sigue devolviendo {} sin pedir nada');
}

console.log('\n── EL VEREDICTO ES UNO SOLO PARA TODO EL MÓDULO ──');
{
  // ESTE es el bug que importa con SIP contratado: el vigilante pide el volumen
  // de HOY por snapshot y el promedio de 20 sesiones por bars. Si los snapshots
  // resuelven SIP y el promedio se queda en IEX, el RVOL sale inflado ~30-50× y
  // el vigilante marca el mercado entero como "volumen inusual" cada 5 minutos.
  resetFeedSnapshots();
  const feedsPedidos = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    feedsPedidos.push({ ruta: u.pathname.includes('snapshots') ? 'snapshots' : 'bars', feed: u.searchParams.get('feed') });
    return { ok: true, status: 200, text: async () => JSON.stringify({ snapshots: CUERPO.snapshots, bars: { NVDA: [{ t: '2026-09-17T00:00:00Z', v: 900, c: 179 }] } }) };
  };
  await getSnapshots(['NVDA']);
  await getAvgDailyVolume(['NVDA'], { days: 20, today: '2026-09-18' });
  const snap = feedsPedidos.find((f) => f.ruta === 'snapshots');
  const bars = feedsPedidos.find((f) => f.ruta === 'bars');
  ok(snap.feed === 'sip' && bars.feed === 'sip',
    'el promedio de volumen sigue al snapshot: numerador y denominador del RVOL NO pueden quedar en feeds distintos',
    JSON.stringify(feedsPedidos));
  ok(feedDatosResuelto() === 'sip', 'y el veredicto queda legible desde afuera', String(feedDatosResuelto()));
}

console.log('\n── el 403 de SIP también se comparte, no se re-paga por función ──');
{
  resetFeedSnapshots();
  const feedsPedidos = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    const feed = u.searchParams.get('feed');
    feedsPedidos.push(feed);
    if (feed === 'sip') return { ok: false, status: 403, text: async () => '{"message":"no plan"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ snapshots: CUERPO.snapshots, bars: { NVDA: [{ t: '2026-09-17T00:00:00Z', v: 900, c: 179 }] } }) };
  };
  await getSnapshots(['NVDA']);
  await getAvgDailyVolume(['NVDA'], { days: 20, today: '2026-09-18' });
  ok(feedsPedidos.join(',') === 'sip,iex,iex',
    'el 403 se paga UNA vez en todo el proceso: la segunda función ya arranca en IEX',
    feedsPedidos.join(','));
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
