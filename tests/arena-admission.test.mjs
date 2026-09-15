// ═══════════════════════════════════════════════════════════════
// tests/arena-admission.test.mjs — el FILTRO DE ADMISIÓN del universo (A4c).
//
// El bug que protege: DDDX, un OTC de $0.01, llegó al buffet del 14 por el
// canal INSIDER, que no filtraba nada. Los movers ya filtraban precio ≥ $5
// desde julio; el criterio más flojo de los tres era el que mandaba.
//
// Lo que esta suite garantiza:
//   1. Los tres criterios (precio, market cap, volumen en dólares) rechazan
//      con su motivo escrito, y el caso DDDX concreto no pasa.
//   2. FAIL CLOSED: sin datos, NO entra — y se distingue de un rechazo por
//      criterio, porque son problemas distintos (uno es el filtro haciendo su
//      trabajo, el otro es cobertura rota).
//   3. El volumen es POINT-IN-TIME: la vela del día en curso no cuenta.
//   4. El piso de precio del guard y el del filtro son el MISMO número.
// Correr con `node tests/arena-admission.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import {
  ADMISSION, isAdmissible, partitionByAdmission, resolveAdmission,
  fetchPriceAndVolume, _resetAdmissionCache,
} from '../api/_lib/arena-admission.js';
import { ARENA_RULES } from '../api/_lib/arena-guard.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const BIG = { price: 200, marketCap: 3e12, dollarVolume: 2e8 };

console.log('criterio: los tres pisos, con su motivo');
{
  ok(isAdmissible({ symbol: 'AAPL', ...BIG }).ok, 'una mega-cap líquida pasa');

  // EL CASO DDDX, literal: OTC de $0.01.
  const dddx = isAdmissible({ symbol: 'DDDX', price: 0.01, marketCap: 4e6, dollarVolume: 12000 });
  ok(!dddx.ok && /precio/.test(dddx.reason), 'DDDX ($0.01 OTC) → rechazada, y el motivo nombra el precio', dddx.reason);

  const barato = isAdmissible({ ...BIG, symbol: 'X', price: 4.99 });
  ok(!barato.ok && /precio/.test(barato.reason), 'precio justo por debajo del piso → rechazada', barato.reason);
  ok(isAdmissible({ ...BIG, symbol: 'X', price: 5 }).ok, 'precio EXACTAMENTE en el piso → pasa (el piso es inclusivo)');

  const chica = isAdmissible({ ...BIG, symbol: 'X', marketCap: 999e6 });
  ok(!chica.ok && /market cap/.test(chica.reason), 'market cap por debajo de $1B → rechazada', chica.reason);
  ok(isAdmissible({ ...BIG, symbol: 'X', marketCap: 1e9 }).ok, 'market cap exactamente $1B → pasa');

  const seca = isAdmissible({ ...BIG, symbol: 'X', dollarVolume: 9.9e6 });
  ok(!seca.ok && /volumen/.test(seca.reason), 'volumen en dólares bajo el piso → rechazada', seca.reason);
  ok(isAdmissible({ ...BIG, symbol: 'X', dollarVolume: 10e6 }).ok, 'volumen exactamente $10M/día → pasa');
}

console.log('\nfail closed: sin datos NO entra, y se distingue del rechazo por criterio');
{
  const sinNada = isAdmissible({ symbol: 'X' });
  ok(!sinNada.ok && sinNada.reason === 'data_unavailable', 'sin ningún dato → rechazada como data_unavailable', sinNada.reason);
  ok(sinNada.missing.length === 3, 'dice CUÁLES datos faltaron (los tres)', JSON.stringify(sinNada.missing));

  const sinCap = isAdmissible({ symbol: 'X', price: 200, dollarVolume: 2e8 });
  ok(!sinCap.ok && sinCap.reason === 'data_unavailable' && sinCap.missing.join() === 'market cap',
    'un solo dato faltante basta para rechazar, y se nombra', JSON.stringify(sinCap.missing));

  // Por qué importa la distinción: un `data_unavailable` alto significa
  // cobertura rota (hay que arreglarlo), no micro-caps (el filtro funcionando).
  ok(isAdmissible({ symbol: 'X', price: 0.01 }).reason === 'data_unavailable',
    'la falta de datos gana sobre el criterio: no se afirma "es micro-cap" sin haber podido medirlo');
}

console.log('\npartición por canal: qué entró, qué no y por qué');
{
  const data = {
    AAPL: { price: 200, marketCap: 3e12, dollarVolume: 2e8 },
    DDDX: { price: 0.01, marketCap: 4e6, dollarVolume: 12000 },
    NOPE: {},
  };
  const items = [{ ticker: 'AAPL' }, { ticker: 'DDDX' }, { ticker: 'NOPE' }];
  const { admitted, rejected } = partitionByAdmission(items, data, (i) => i.ticker);
  ok(admitted.length === 1 && admitted[0].ticker === 'AAPL', 'solo AAPL admitida', JSON.stringify(admitted));
  ok(rejected.length === 2, 'dos rechazadas', JSON.stringify(rejected));
  ok(rejected.every((r) => typeof r.reason === 'string' && r.reason.length > 0),
    'CADA rechazo lleva su motivo escrito — el journal tiene que poder explicarlo');
  ok(rejected.find((r) => r.symbol === 'NOPE').reason === 'data_unavailable',
    'el rechazo por falta de datos se marca como tal, aparte de los de criterio');
  // `symbolOf` configurable: los canales tienen forma distinta (symbol vs ticker).
  const porSymbol = partitionByAdmission([{ symbol: 'AAPL' }], data, (m) => m.symbol);
  ok(porSymbol.admitted.length === 1, 'la partición funciona con `symbol` y con `ticker`');
}

console.log('\nvolumen POINT-IN-TIME: la vela del día en curso no cuenta');
{
  _resetAdmissionCache();
  const DAY = 86400000;
  // 5 sesiones cerradas a volumen normal + la de HOY con un volumen absurdo.
  // Si la vela viva contara, el promedio se dispararía y un nombre seco
  // parecería líquido justo el día en que se opera.
  const now = new Date('2026-09-15T12:00:00Z'); // 12:00 UTC → el día NO cerró
  const dias = [5, 4, 3, 2, 1].map((d) => Date.parse('2026-09-15T00:00:00Z') - d * DAY);
  const ts = [...dias.map((ms) => ms / 1000), Date.parse('2026-09-15T00:00:00Z') / 1000];
  const close = [10, 10, 10, 10, 10, 10];
  const volume = [100_000, 100_000, 100_000, 100_000, 100_000, 999_000_000];

  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close, open: close, high: close, low: close, volume }] } }] } }),
  });
  const pv = await fetchPriceAndVolume('SECO', now, fakeFetch);
  ok(pv.dollarVolume === 1_000_000,
    'el volumen promedio ignora la vela VIVA (5 sesiones × $1M, no el pico de hoy)', String(pv.dollarVolume));
  ok(!isAdmissible({ symbol: 'SECO', price: pv.price, marketCap: 5e9, dollarVolume: pv.dollarVolume }).ok,
    'y por eso el nombre seco sigue rechazado el día del pico — que es justo cuando se lo intentaría operar');
}

console.log('\nlas dos barreras dicen lo mismo');
{
  ok(ARENA_RULES.min_price === ADMISSION.min_price,
    'el piso de precio del guard === el del filtro de admisión', `${ARENA_RULES.min_price} vs ${ADMISSION.min_price}`);
}

console.log('\nresolveAdmission: reusa lo que el canal ya sabe y cachea por día');
{
  _resetAdmissionCache();
  let yahoo = 0, finnhub = 0;
  const now = new Date('2026-09-15T22:40:00Z');
  const ts = [Date.parse('2026-09-12T00:00:00Z') / 1000];
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes('profile2')) { finnhub++; return { ok: true, json: async () => ({ marketCapitalization: 50_000 }) }; }
    yahoo++;
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: [50], open: [50], high: [50], low: [50], volume: [1_000_000] }] } }] } }) };
  };
  const d1 = await resolveAdmission(['AAPL'], { finnhubKey: 'k', now, fetchImpl: fakeFetch });
  ok(d1.AAPL && d1.AAPL.marketCap === 50_000 * 1e6,
    'marketCapitalization de Finnhub viene en MILLONES y se escala ×1e6 (la trampa clásica)', String(d1.AAPL && d1.AAPL.marketCap));
  const llamadas = yahoo + finnhub;
  await resolveAdmission(['AAPL'], { finnhubKey: 'k', now, fetchImpl: fakeFetch });
  ok(yahoo + finnhub === llamadas, 'la segunda resolución del MISMO día sale del caché: 0 requests nuevas');

  // `known` evita la request de Yahoo cuando el canal ya trae el precio.
  _resetAdmissionCache();
  yahoo = 0; finnhub = 0;
  await resolveAdmission(['MSFT'], { finnhubKey: 'k', now, fetchImpl: fakeFetch, known: { MSFT: { price: 400, dollarVolume: 5e8 } } });
  ok(yahoo === 0 && finnhub === 1, 'con precio y volumen ya conocidos solo se pide el market cap', `yahoo=${yahoo} finnhub=${finnhub}`);
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : `\n${failures} FAIL`);
process.exit(failures ? 1 : 0);
