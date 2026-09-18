// ═══════════════════════════════════════════════════════════════
// tests/arena-mcap-cache.test.mjs — la caché de market cap persistida.
//
// EL PROBLEMA (2026-09-18): 40 de 50 llamadas a Finnhub ok, 10 nombres sin
// market cap por cuota. La caché de admisión era un Map del PROCESO, y en
// Vercel cada cold start arranca vacío: el mismo nombre se re-pedía el mismo
// día hasta chocar con el tier gratis (60/min). Los que sobraban salían como
// `rate_budget` — descartados por un límite NUESTRO, no por el nombre.
//
// Se prueba la REGLA de vigencia (pura, sin DB) y el efecto sobre
// resolveAdmission con la caché inyectada.
// Correr con `node tests/arena-mcap-cache.test.mjs`.
// ═══════════════════════════════════════════════════════════════

import { ttlDiasPara, vigente, TTL_DIAS_LEJOS, TTL_DIAS_BORDE, PISO_MCAP_DEFAULT } from '../api/_lib/arena-mcap-cache.js';
import { resolveAdmission, _resetAdmissionCache } from '../api/_lib/arena-admission.js';

let failures = 0;
function ok(cond, name, detail) {
  if (cond) console.log('  PASS', name);
  else { failures++; console.error('  FAIL', name, detail !== undefined ? '→ ' + detail : ''); }
}

const AHORA = new Date('2026-09-18T15:00:00Z');
const haceDias = (d) => new Date(AHORA.getTime() - d * 86400000).toISOString();

console.log('\n── la ventana depende de la distancia al piso ──');
{
  ok(ttlDiasPara(80e9) === TTL_DIAS_LEJOS, 'un nombre de $80.000M usa la ventana larga: ninguna semana normal lo baja de $1B');
  ok(ttlDiasPara(2e9) === TTL_DIAS_LEJOS, 'justo en 2× el piso todavía es "lejos"', String(ttlDiasPara(2e9)));
  ok(ttlDiasPara(1.1e9) === TTL_DIAS_BORDE, 'uno de $1.100M es de BORDE: una foto vieja ahí decide MAL, y la decisión es binaria');
  ok(ttlDiasPara(0.5e9) === TTL_DIAS_BORDE, 'y uno POR DEBAJO del piso también: un rechazado puede recuperarse y la caché no lo condena una semana');
  ok(ttlDiasPara(null) === 0 && ttlDiasPara(0) === 0, 'sin dato no se cachea nada: "no se pudo" hay que reintentarlo, no guardarlo');
}

console.log('\n── vigencia ──');
{
  ok(vigente({ market_cap: 80e9, fetched_at: haceDias(3) }, { now: AHORA }), 'lejos del piso y de hace 3 días → vigente');
  ok(!vigente({ market_cap: 80e9, fetched_at: haceDias(9) }, { now: AHORA }), 'lejos pero de hace 9 días → vencida');
  ok(!vigente({ market_cap: 1.1e9, fetched_at: haceDias(3) }, { now: AHORA }), 'de BORDE y de hace 3 días → vencida, aunque el mismo plazo sirva para uno grande');
  ok(vigente({ market_cap: 1.1e9, fetched_at: haceDias(0.5) }, { now: AHORA }), 'de borde pero de hace 12 horas → vigente');
  ok(!vigente({ market_cap: 80e9, fetched_at: null }, { now: AHORA }), 'sin fecha no se confía');
  ok(!vigente(null, { now: AHORA }) && !vigente({}, { now: AHORA }), 'una fila vacía tampoco');
  ok(!vigente({ market_cap: 80e9, fetched_at: new Date(AHORA.getTime() + 86400000).toISOString() }, { now: AHORA }),
    'una foto del FUTURO no se usa: un reloj raro no puede alargar la vigencia');
  ok(vigente({ market_cap: 5e9, fetched_at: haceDias(3) }, { now: AHORA, piso: 10e9 }) === false,
    'el piso es parámetro: con un piso de $10B, $5B pasa a ser de borde y 3 días ya no valen');
}

console.log('\n── el efecto: no se gasta cuota en lo que ya sabíamos ──');
{
  _resetAdmissionCache();
  let finnhubLlamadas = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('finnhub')) {
      finnhubLlamadas++;
      return { ok: true, status: 200, json: async () => ({ marketCapitalization: 50_000 }) };  // en MILLONES
    }
    // Yahoo: precio y volumen, que NUNCA se cachean.
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: [1757000000, 1757100000],
      indicators: { quote: [{ close: [100, 101], volume: [5e6, 5e6], open: [99, 100], high: [102, 102], low: [98, 99] }] },
      meta: { currency: 'USD' },
    }] } }) };
  };

  const guardados = {};
  const cacheFalsa = {
    leer: async () => ({ NVDA: 3_000_000_000_000 }),    // NVDA ya está en Neon
    guardar: async (caps) => { Object.assign(guardados, caps); return Object.keys(caps).length; },
  };

  const diag = [];
  const r = await resolveAdmission(['NVDA', 'AMD'], {
    finnhubKey: 'k', now: AHORA, fetchImpl: fakeFetch, diag, mcapCache: cacheFalsa,
  });

  ok(finnhubLlamadas === 1, 'solo se le pidió a Finnhub el nombre que NO estaba en Neon (AMD), no los dos', String(finnhubLlamadas));
  ok(r.NVDA.marketCap === 3e12, 'NVDA salió de la caché con su market cap', String(r.NVDA.marketCap));
  ok(r.AMD.marketCap === 50_000 * 1e6, 'y AMD con el que se acaba de pedir (profile2 viene en MILLONES)', String(r.AMD.marketCap));
  ok(Number.isFinite(r.NVDA.price) && Number.isFinite(r.NVDA.dollarVolume),
    'el PRECIO y el VOLUMEN se midieron igual para los dos: eso NO se cachea, es lo que cambia');

  ok(Object.keys(guardados).join(',') === 'AMD',
    'solo se persiste lo que se acaba de PEDIR: reescribir la foto de NVDA le renovaría la fecha sin haber mirado nada',
    JSON.stringify(guardados));

  const nota = diag.find((d) => d.reason === 'cache_persistida');
  ok(nota && nota.symbol === 'NVDA', 'y el journal DICE que no se pidió, en vez de que parezca una llamada más', JSON.stringify(nota));
}

console.log('\n── una caché caída no puede tumbar el universo ──');
{
  _resetAdmissionCache();
  let finnhubLlamadas = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('finnhub')) { finnhubLlamadas++; return { ok: true, status: 200, json: async () => ({ marketCapitalization: 9_000 }) }; }
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: [1757000000], indicators: { quote: [{ close: [50], volume: [4e6], open: [49], high: [51], low: [48] }] }, meta: { currency: 'USD' },
    }] } }) };
  };
  const rota = {
    leer: async () => { throw new Error('Neon no contesta'); },
    guardar: async () => { throw new Error('Neon no contesta'); },
  };
  const r = await resolveAdmission(['AMD'], { finnhubKey: 'k', now: AHORA, fetchImpl: fakeFetch, mcapCache: rota });
  ok(r.AMD && r.AMD.marketCap === 9_000 * 1e6,
    'si Neon hipa se degrada a pedirle a Finnhub, que es el comportamiento de siempre — no se cae el universo',
    JSON.stringify(r.AMD));
  ok(finnhubLlamadas === 1, 'y se gastó la llamada, que es el peor caso aceptable');
}

console.log('\n── sin caché inyectada, el comportamiento es el de antes ──');
{
  _resetAdmissionCache();
  let finnhubLlamadas = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('finnhub')) { finnhubLlamadas++; return { ok: true, status: 200, json: async () => ({ marketCapitalization: 9_000 }) }; }
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: [1757000000], indicators: { quote: [{ close: [50], volume: [4e6], open: [49], high: [51], low: [48] }] }, meta: { currency: 'USD' },
    }] } }) };
  };
  const r = await resolveAdmission(['AMD'], { finnhubKey: 'k', now: AHORA, fetchImpl: fakeFetch });
  ok(finnhubLlamadas === 1 && r.AMD.marketCap === 9e9, 'sin mcapCache se pide como siempre: el parámetro es opcional de verdad');
}

console.log('\n── el presupuesto sigue existiendo, y la caché NO cuenta contra él ──');
{
  _resetAdmissionCache();
  let finnhubLlamadas = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('finnhub')) { finnhubLlamadas++; return { ok: true, status: 200, json: async () => ({ marketCapitalization: 9_000 }) }; }
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{
      timestamp: [1757000000], indicators: { quote: [{ close: [50], volume: [4e6], open: [49], high: [51], low: [48] }] }, meta: { currency: 'USD' },
    }] } }) };
  };
  const enNeon = { A: 9e9, B: 9e9, C: 9e9 };
  const diag = [];
  const r = await resolveAdmission(['A', 'B', 'C', 'D'], {
    finnhubKey: 'k', now: AHORA, fetchImpl: fakeFetch, diag, maxFinnhub: 1,
    mcapCache: { leer: async () => enNeon, guardar: async () => 1 },
  });
  ok(finnhubLlamadas === 1, 'con presupuesto 1 y tres nombres en caché, se gasta la única llamada en el que falta', String(finnhubLlamadas));
  ok(['A', 'B', 'C'].every((s) => r[s].marketCap === 9e9) && r.D.marketCap === 9e9,
    'y los CUATRO salen con market cap, que es justo lo que antes no pasaba',
    JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.marketCap]))));
  ok(!diag.some((d) => d.reason === 'rate_budget'), 'sin un solo `rate_budget`: el hueco de hoy desaparece sin subir el presupuesto');
}

console.log(failures === 0 ? '\nTODOS LOS TESTS PASAN' : '\n' + failures + ' TEST(S) FALLARON');
process.exit(failures === 0 ? 0 : 1);
