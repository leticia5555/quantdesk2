#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// BETA DE EVENTO — sonda G0 de la seccion "LO QUE SI HAY" del Pairs Validator.
//
// El smoke que pedia el encargo NO se pudo correr desde el sandbox de
// desarrollo (403 del proxy a alphavantage.co, a Vercel y a Yahoo; ver
// docs/pairs-event-beta-scope.md §2 y el precedente de docs/wheel-fase0.md §0).
// Este script es el entregable que cierra ese hueco: se corre donde haya
// egress y key, e imprime lo que el diseno necesita saber.
//
// TRES PREGUNTAS QUE RESPONDE
//   1. Cuantas fechas de earnings trae AV para X, y con cuanta profundidad.
//   2. Si AV trae HORA del anuncio (esperado: NO -> supuesto AMC parejo).
//      No se asume: se listan TODAS las claves que devuelve AV y se busca
//      cualquier campo con pinta de hora/timestamp.
//   3. LA QUE DECIDE: con el umbral pre-registrado de +-3%, cuantos eventos
//      caen en cada grupo. Si UP y DOWN se quedan en N<10 para los pares
//      reales, la seccion nace etiquetada "descriptivo, no significativo" y
//      eso hay que saberlo ANTES de escribirla, no despues.
//
// TRAMPA de AV (ya documentada en api/_lib/av-earnings.js): cuando te corta
// NO devuelve 429 — devuelve HTTP 200 con {"Note"} o {"Information"} y sin
// datos. Se detecta explicitamente; un 200 no es senal de exito.
//
// TRAMPA de Yahoo (documentada en api/_lib/yahoo-daily.js): quote[0] viene
// ajustado SOLO por splits y adjclose[0] por splits Y dividendos. Mezclarlos
// inventa un retorno del tamano del dividendo el dia ex. Acá se deriva
// f = adjclose/close y se aplica TAMBIEN al open, igual que la lib.
//
// USO:
//   ALPHAVANTAGE_API_KEY=xxx node scripts/event-beta-probe.mjs
//     -> corre los dos pares del e2e: MU/NVDA y KO/PEP (2 requests de AV)
//   ALPHAVANTAGE_API_KEY=xxx node scripts/event-beta-probe.mjs MU NVDA
//     -> un solo par Y X (1 request de AV)
//
// COSTO: 1 request de AV por cada X distinto (las 25/dia estan libres: PEAD
// cerro con el ledger en 99/99, docs/wheel-fase0.md §4.3). Yahoo es gratis.
// Sin dependencias (fetch global de Node >= 18). No toca ninguna lib del repo
// a proposito: es una implementacion independiente, asi que si coincide con
// api/_lib/event-beta.js es una verificacion cruzada, no un eco.
// ═══════════════════════════════════════════════════════════════════════

import { mkdirSync, writeFileSync } from 'node:fs';

const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || '';
const OUT_DIR = '.event-beta-probe';

// Los mismos numeros que docs/pairs-event-beta-scope.md §5. Si el probe y el
// endpoint no comparten estos valores, uno de los dos esta mintiendo.
const CRITERIOS = {
  UMBRAL_SALTO: 0.03,
  HIT_FUERTE: 0.60,
  N_MIN: 10,
  RANGE_PRECIOS: '10y',
};

// Pares por default: los dos casos del e2e. MU/NVDA se espera RUIDO en las
// Puertas con beta de evento plausible; KO/PEP par valido con saltos de +-3%
// raros (ejercita el camino de N chico).
const PARES_DEFAULT = [
  { y: 'MU', x: 'NVDA' },
  { y: 'KO', x: 'PEP' },
];

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctS = (v) => (v == null ? '   n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%');
const hitS = (v) => (v == null ? '  —' : (v * 100).toFixed(0) + '%');

function save(name, body) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${name}`, JSON.stringify(body, null, 2));
    return `${OUT_DIR}/${name}`;
  } catch (e) {
    return `(no se pudo guardar: ${e.message})`;
  }
}

async function getJson(url, headers) {
  try {
    const res = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, body: null, note: String(e.message || e) };
  }
}

// ─────────────── Sonda 1: AV EARNINGS ───────────────

// Devuelve { quarters, dates[], keys[], camposHora[], muestra, note }.
// `camposHora` es el punto: cualquier clave que huela a hora/timestamp.
async function sondaEarnings(symbol) {
  const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${AV_KEY}`;
  const r = await getJson(url);
  if (!r.ok) return { error: `HTTP ${r.status}${r.note ? ' ' + r.note : ''}` };

  const b = r.body || {};
  // La trampa: 200 OK con Note/Information = te cortaron, no hay datos.
  if (b.Note || b.Information) return { error: `AV rate-limited: ${String(b.Note || b.Information).slice(0, 120)}` };
  if (b['Error Message']) return { error: `AV: ${String(b['Error Message']).slice(0, 120)}` };

  const q = Array.isArray(b.quarterlyEarnings) ? b.quarterlyEarnings : [];
  if (!q.length) return { error: 'sin quarterlyEarnings en la respuesta' };

  const path = save(`av-earnings-${symbol}.json`, b);

  // Todas las claves que aparecen en CUALQUIER trimestre (AV no siempre manda
  // el mismo set en todas las filas).
  const keys = [...new Set(q.flatMap((row) => Object.keys(row || {})))].sort();
  const camposHora = keys.filter((k) => /time|hour|hora|when|session|bmo|amc|announc/i.test(k));

  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const dates = q.map((row) => row && row.reportedDate).filter(isDate).sort();
  const malas = q.length - dates.length;

  return { quarters: q.length, dates, keys, camposHora, malas, muestra: q[0], path };
}

// ─────────────── Sonda 2: precios ajustados de Yahoo ───────────────

// Mismo ajuste que api/_lib/yahoo-daily.js: f = adjclose/close aplicado al
// open TAMBIEN, para que open y close queden en la misma escala.
async function sondaPrecios(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=1d&range=${encodeURIComponent(range)}&events=div%2Csplit`;
  const r = await getJson(url, UA);
  if (!r.ok) return { error: `HTTP ${r.status}${r.note ? ' ' + r.note : ''}` };

  const res = r.body?.chart?.result?.[0];
  const ts = res?.timestamp;
  const qt = res?.indicators?.quote?.[0];
  const adj = res?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(ts) || !qt) return { error: 'respuesta de Yahoo sin serie utilizable' };

  const fechas = [], opens = [], closes = [];
  let ajustados = 0;
  for (let i = 0; i < ts.length; i++) {
    const o = qt.open?.[i], c = qt.close?.[i];
    if (![o, c].every((v) => Number.isFinite(v) && v > 0)) continue;
    const a = Array.isArray(adj) ? adj[i] : null;
    const f = Number.isFinite(a) && a > 0 ? a / c : 1;
    if (Math.abs(f - 1) > 1e-9) ajustados++;
    fechas.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    opens.push(o * f);
    closes.push(c * f);
  }
  if (!fechas.length) return { error: 'serie vacia tras limpiar nulls' };
  // `ajustados` mide cuanto muerde el ajuste por dividendos: si es 0 en KO,
  // algo esta mal con adjclose y el c2c estaria inventando retornos.
  return { fechas, opens, closes, n: fechas.length, ajustados };
}

// ─────────────── El event study ───────────────

const signo = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// Indice por fecha para alinear las dos series sin suponer calendarios iguales.
function indexar(serie) {
  const m = new Map();
  for (let i = 0; i < serie.fechas.length; i++) m.set(serie.fechas[i], i);
  return m;
}

// Dia de evento = primera sesion POSTERIOR a reportedDate con precio en AMBOS.
// Supuesto AMC parejo: AV no da hora (docs/pairs-event-beta-scope.md §4.2).
// Devuelve { fechaE, iY, iX } o un motivo de descarte.
function diaDeEvento(reportedDate, serieY, idxY, idxX) {
  // serieY.fechas esta ordenada; busca la primera fecha > reportedDate.
  let lo = 0, hi = serieY.fechas.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (serieY.fechas[mid] > reportedDate) hi = mid; else lo = mid + 1;
  }
  if (lo >= serieY.fechas.length) return { drop: 'no_next_session' };
  const fechaE = serieY.fechas[lo];
  const iY = idxY.get(fechaE);
  const iX = idxX.get(fechaE);
  if (iY == null || iX == null) return { drop: 'no_price' };
  if (iY === 0 || iX === 0) return { drop: 'no_prior_close' };
  return { fechaE, iY, iX };
}

function estudio(serieY, serieX, fechasReporte) {
  const idxY = indexar(serieY);
  const idxX = indexar(serieX);
  const primera = serieY.fechas[0];
  const ultima = serieY.fechas[serieY.fechas.length - 1];

  const dropped = { no_next_session: 0, no_price: 0, no_prior_close: 0, out_of_window: 0 };
  const eventos = [];

  for (const d of fechasReporte) {
    if (d < primera || d > ultima) { dropped.out_of_window++; continue; }
    const e = diaDeEvento(d, serieY, idxY, idxX);
    if (e.drop) { dropped[e.drop]++; continue; }
    const { fechaE, iY, iX } = e;
    eventos.push({
      reportedDate: d,
      fechaE,
      x_c2c: serieX.closes[iX] / serieX.closes[iX - 1] - 1,
      x_o2c: serieX.closes[iX] / serieX.opens[iX] - 1,
      y_c2c: serieY.closes[iY] / serieY.closes[iY - 1] - 1,
      y_o2c: serieY.closes[iY] / serieY.opens[iY] - 1,
    });
  }

  const U = CRITERIOS.UMBRAL_SALTO;
  const eps = 1e-9; // la frontera de +-3% es INCLUSIVA (§4.4)
  const grupos = {
    UP: eventos.filter((e) => e.x_c2c >= U - eps),
    DOWN: eventos.filter((e) => e.x_c2c <= -U + eps),
    ALL: eventos,
  };

  const stats = (evs, campoY, campoX) => {
    if (!evs.length) return { n: 0, n_zero: 0, hit_rate: null, avg: null };
    let hits = 0, ceros = 0, suma = 0;
    for (const e of evs) {
      const sY = signo(e[campoY]);
      const sX = signo(e[campoX]);
      if (sY === 0 || sX === 0) ceros++;
      else if (sY === sX) hits++;
      suma += e[campoY];
    }
    return { n: evs.length, n_zero: ceros, hit_rate: hits / evs.length, avg: suma / evs.length };
  };

  // BASELINE: Y en TODOS los dias de la ventana. Sin hit rate (no hay X con
  // que comparar) — es el contrafactico, no un grupo de eventos.
  let sc = 0, so = 0, n = 0;
  for (let i = 1; i < serieY.fechas.length; i++) {
    sc += serieY.closes[i] / serieY.closes[i - 1] - 1;
    so += serieY.closes[i] / serieY.opens[i] - 1;
    n++;
  }
  const baseline = { n, c2c: { hit_rate: null, avg: n ? sc / n : null }, o2c: { hit_rate: null, avg: n ? so / n : null } };

  const filas = {};
  for (const k of ['UP', 'DOWN', 'ALL']) {
    filas[k] = {
      n: grupos[k].length,
      c2c: stats(grupos[k], 'y_c2c', 'x_c2c'),
      o2c: stats(grupos[k], 'y_o2c', 'x_o2c'),
    };
  }
  return { eventos, dropped, filas, baseline, ventana: { from: primera, to: ultima } };
}

// ─────────────── Un par ───────────────

async function correPar({ y, x }, cacheEarnings) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`PAR  ${y} ~ ${x}   (X = ${x} es el que reporta)`);
  console.log('═'.repeat(70));

  // ── 1. earnings de X ──
  let ern = cacheEarnings.get(x);
  if (!ern) {
    if (!AV_KEY) {
      console.log('\n[1] AV EARNINGS: SALTADO — falta ALPHAVANTAGE_API_KEY.');
      return null;
    }
    console.log(`\n[1] AV EARNINGS ${x} … (1 request)`);
    ern = await sondaEarnings(x);
    cacheEarnings.set(x, ern);
    await sleep(1000); // cortesia con el ~5/min de AV
  } else {
    console.log(`\n[1] AV EARNINGS ${x} — reusando la respuesta ya bajada (0 requests)`);
  }

  if (ern.error) {
    console.log(`    ERROR: ${ern.error}`);
    return null;
  }

  const span = ((new Date(ern.dates[ern.dates.length - 1]) - new Date(ern.dates[0])) / (365 * 86400_000)).toFixed(1);
  console.log(`    ${ern.quarters} trimestres · ${ern.dates[0]} -> ${ern.dates[ern.dates.length - 1]} (~${span} anos)`);
  if (ern.malas) console.log(`    ${ern.malas} fila(s) con reportedDate no parseable (descartadas)`);
  console.log(`    claves por trimestre: ${ern.keys.join(', ')}`);
  console.log(`    HORA DEL ANUNCIO: ${ern.camposHora.length
    ? '⚠️  campos candidatos -> ' + ern.camposHora.join(', ') + '  (revisar: cambiaria el supuesto AMC)'
    : 'NO hay ningun campo de hora  -> supuesto AMC parejo CONFIRMADO (§4.2)'}`);
  console.log(`    muestra (trimestre mas reciente): ${JSON.stringify(ern.muestra)}`);
  console.log(`    payload crudo: ${ern.path}`);

  // ── 2. precios ──
  console.log(`\n[2] Yahoo ajustado ${CRITERIOS.RANGE_PRECIOS} para ${y} y ${x} …`);
  const [sy, sx] = await Promise.all([
    sondaPrecios(y, CRITERIOS.RANGE_PRECIOS),
    sondaPrecios(x, CRITERIOS.RANGE_PRECIOS),
  ]);
  if (sy.error) { console.log(`    ERROR ${y}: ${sy.error}`); return null; }
  if (sx.error) { console.log(`    ERROR ${x}: ${sx.error}`); return null; }
  console.log(`    ${y}: ${sy.n} sesiones (${sy.fechas[0]} -> ${sy.fechas[sy.n - 1]}), ${sy.ajustados} dias con factor de ajuste != 1`);
  console.log(`    ${x}: ${sx.n} sesiones (${sx.fechas[0]} -> ${sx.fechas[sx.n - 1]}), ${sx.ajustados} dias con factor de ajuste != 1`);
  if (sy.ajustados === 0 && sx.ajustados === 0) {
    console.log('    ⚠️  ningun dia ajustado en NINGUNA de las dos series: sospechoso si alguno paga dividendo.');
  }

  // ── 3. el estudio ──
  const r = estudio(sy, sx, ern.dates);
  console.log(`\n[3] Event study — ventana ${r.ventana.from} -> ${r.ventana.to}`);
  const d = r.dropped;
  console.log(`    eventos usables: ${r.filas.ALL.n}  ·  descartados: `
    + `fuera de ventana ${d.out_of_window}, sin sesion siguiente ${d.no_next_session}, `
    + `sin precio ${d.no_price}, sin cierre previo ${d.no_prior_close}`);

  const etiqueta = { UP: `X sube >= +${(CRITERIOS.UMBRAL_SALTO * 100).toFixed(0)}%`, DOWN: `X cae <= -${(CRITERIOS.UMBRAL_SALTO * 100).toFixed(0)}%`, ALL: 'todos los eventos' };
  console.log('');
  console.log('    GRUPO                 N   hit c2c  avg c2c   hit o2c  avg o2c');
  console.log('    ' + '-'.repeat(62));
  for (const k of ['UP', 'DOWN', 'ALL']) {
    const f = r.filas[k];
    const marca = f.n === 0 ? ' (vacio)' : f.n < CRITERIOS.N_MIN ? ' *' : '';
    console.log('    ' + etiqueta[k].padEnd(20)
      + String(f.n).padStart(3)
      + hitS(f.c2c.hit_rate).padStart(9) + pctS(f.c2c.avg).padStart(9)
      + hitS(f.o2c.hit_rate).padStart(10) + pctS(f.o2c.avg).padStart(9) + marca);
  }
  const b = r.baseline;
  console.log('    ' + `${y}, dia cualquiera`.padEnd(20)
    + String(b.n).padStart(3)
    + '  —'.padStart(9) + pctS(b.c2c.avg).padStart(9)
    + '  —'.padStart(10) + pctS(b.o2c.avg).padStart(9));
  console.log(`    * N < ${CRITERIOS.N_MIN} -> "descriptivo, no significativo"`);

  save(`estudio-${y}-${x}.json`, { pair: { y, x }, ...r, eventos: r.eventos });
  console.log(`    detalle evento a evento: ${OUT_DIR}/estudio-${y}-${x}.json`);

  return { y, x, filas: r.filas, baseline: r.baseline };
}

// ─────────────── main ───────────────

(async () => {
  console.log('BETA DE EVENTO — sonda G0 (docs/pairs-event-beta-scope.md §2)');
  console.log('Fecha:', new Date().toISOString().slice(0, 10));

  const args = process.argv.slice(2).map((s) => s.toUpperCase());
  const pares = args.length >= 2 ? [{ y: args[0], x: args[1] }] : PARES_DEFAULT;
  const xs = [...new Set(pares.map((p) => p.x))];
  console.log(`Pares: ${pares.map((p) => p.y + '/' + p.x).join(', ')}  ·  costo en AV: ${AV_KEY ? xs.length : 0} request(s) de 25/dia`);
  if (!AV_KEY) console.log('\n⚠️  Sin ALPHAVANTAGE_API_KEY no hay sonda. Exportala y volve a correr.');

  const cache = new Map();
  const out = [];
  for (const p of pares) {
    const r = await correPar(p, cache).catch((e) => { console.log(`    EXCEPCION: ${e.message}`); return null; });
    if (r) out.push(r);
  }

  // ── veredicto G0 ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log('VEREDICTO G0 — ¿la seccion puede decir algo, o nace descriptiva?');
  console.log('═'.repeat(70));
  if (!out.length) {
    console.log('  Sin datos: ninguna sonda completo. Revisa la key y el egress.');
    process.exit(1);
  }
  for (const r of out) {
    const up = r.filas.UP.n, dn = r.filas.DOWN.n, all = r.filas.ALL.n;
    const sig = up >= CRITERIOS.N_MIN || dn >= CRITERIOS.N_MIN;
    console.log(`  ${(r.y + '/' + r.x).padEnd(12)} UP=${String(up).padStart(3)}  DOWN=${String(dn).padStart(3)}  TODOS=${String(all).padStart(3)}  -> `
      + (sig
        ? 'al menos un grupo llega a N>=10: veredicto SIGNIFICATIVO posible'
        : all > 0
          ? 'ningun grupo llega a N>=10: la seccion nace DESCRIPTIVA (es un resultado, no un bug)'
          : 'CERO eventos usables: revisar la ventana de precios'));
  }
  console.log(`\n  Payloads y detalle evento a evento en ./${OUT_DIR}/`);
  console.log('  Pegar la salida en docs/pairs-event-beta-scope.md §2 (cierra el aviso de honestidad).');
})();
