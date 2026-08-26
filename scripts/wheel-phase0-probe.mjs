#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// FASE 0 — Wheel / Covered Calls: sonda de cadenas de opciones HISTORICAS.
//
// Objetivo unico: cerrar la compuerta G0 de docs/wheel-fase0.md — ¿alguna
// fuente gratuita devuelve cadenas historicas REALES (no placeholders) con
// strikes, expiraciones y bid/ask utilizables para un covered call semanal?
//
// TRAMPA #1 (ya documentada en api/_lib/av-earnings.js): Alpha Vantage NO
// devuelve 429 cuando te corta — devuelve HTTP 200 con {"Note"} o
// {"Information"} y sin datos.
// TRAMPA #2 (el motivo de esta sonda): hay reportes de que el free tier
// devuelve DATOS PLACEHOLDER con forma de cadena valida (contractID tipo
// XXYYZZ, expiraciones en 2099, bid/ask en cero). Un harvest ingenuo
// cosecharia basura durante dos semanas sin enterarse. Se validan los dos
// casos por separado.
//
// USO:
//   ALPHAVANTAGE_API_KEY=xxx node scripts/wheel-phase0-probe.mjs
//   MARKETDATA_TOKEN=yyy     node scripts/wheel-phase0-probe.mjs   # candidata #2
//   ALPACA_PAPER_KEY=... ALPACA_PAPER_SECRET=... node scripts/...  # plan B
//   WHEEL_PROBE_SYMBOL=MSFT  node scripts/wheel-phase0-probe.mjs
//
// COSTO: por defecto 3 requests de las 25/dia del free tier de AV. Con PEAD
// retirado (NO-GO, ledger 99/99) el cupo esta libre, asi que no compite con
// nada. Ajustable con AV_PROBE_BUDGET=N (min 1, max 5).
//
// Los payloads crudos quedan en .wheel-phase0/ para pegarlos en el memo (§1.3).
// Sin dependencias (fetch global de Node >= 18). No toca ninguna lib del repo.
// ═══════════════════════════════════════════════════════════════════════

import { mkdirSync, writeFileSync } from 'node:fs';

const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || '';
const MD_TOKEN = process.env.MARKETDATA_TOKEN || '';
const ALPACA_KEY = process.env.ALPACA_PAPER_KEY || '';
const ALPACA_SECRET = process.env.ALPACA_PAPER_SECRET || '';

const SYMBOL = process.env.WHEEL_PROBE_SYMBOL || 'AAPL';
const AV_BUDGET = Math.min(5, Math.max(1, Number(process.env.AV_PROBE_BUDGET || 3)));
const OUT_DIR = '.wheel-phase0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().split('T')[0];
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) + '%' : 'n/a');

// Viernes mas reciente >= `daysBack` dias atras. Todo relativo a hoy: sin
// fechas tatuadas (lint anti "relojes rotos", tests/no-hardcoded-dates.test.mjs).
function fridayBack(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400_000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

// Sondas de profundidad: reciente / ~1 ano / ~2 anos. La 1a prueba que el
// endpoint responde; las otras dos son las que deciden la ventana cosechable.
const DEPTHS = [
  { label: 'reciente (~10d)', days: 10 },
  { label: '~1 ano',          days: 365 },
  { label: '~2 anos',         days: 730 },
  { label: '~3 anos',         days: 1095 },
  { label: '~5 anos',         days: 1825 },
].slice(0, AV_BUDGET);

function save(name, body) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${name}`, JSON.stringify(body, null, 2));
    return `${OUT_DIR}/${name}`;
  } catch (e) {
    return `(no se pudo guardar: ${e.message})`;
  }
}

async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'quantdesk-wheel-phase0', ...headers } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* HTML de error */ }
    return {
      ok: res.ok, status: res.status, body,
      raw: body ? null : text.slice(0, 200),
      headers: res.headers,
    };
  } catch (e) {
    return { ok: false, status: 0, body: null, raw: String(e.message || e) };
  }
}

// ── Clasificador de una cadena AV ───────────────────────────────────────
// Devuelve { status, ...metricas }. status:
//   'rate_limited' → Note/Information (o paywall disfrazado de eso)
//   'empty'        → 200 sin contratos
//   'placeholder'  → contratos con forma valida pero contenido falso (TRAMPA #2)
//   'ok'           → datos reales
export function classifyAvChain(body) {
  if (!body || typeof body !== 'object') return { status: 'empty', note: 'sin JSON' };
  if (body.Note || body.Information) {
    return { status: 'rate_limited', note: String(body.Note || body.Information).slice(0, 160) };
  }
  if (body['Error Message']) return { status: 'empty', note: String(body['Error Message']).slice(0, 160) };

  const data = Array.isArray(body.data) ? body.data : [];
  if (!data.length) return { status: 'empty', note: 'data[] vacio' };

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const strikes = new Set(), expirations = new Set();
  let calls = 0, withBid = 0, withAsk = 0, withVol = 0, withOi = 0, withDelta = 0, withIv = 0;
  let fakeId = 0, fakeExp = 0;

  for (const c of data) {
    if (!c || typeof c !== 'object') continue;
    if (c.strike != null) strikes.add(String(c.strike));
    if (c.expiration) expirations.add(String(c.expiration));
    if (String(c.type).toLowerCase() === 'call') calls++;
    if ((num(c.bid) || 0) > 0) withBid++;
    if ((num(c.ask) || 0) > 0) withAsk++;
    if (num(c.volume) != null) withVol++;
    if (num(c.open_interest) != null) withOi++;
    if (num(c.delta) != null) withDelta++;
    if (num(c.implied_volatility) != null) withIv++;
    if (/XXYYZZ|DEMO|SAMPLE/i.test(String(c.contractID || ''))) fakeId++;
    if (/^(2[0-9]{3})/.test(String(c.expiration || '')) && Number(String(c.expiration).slice(0, 4)) >= 2090) fakeExp++;
  }

  const n = data.length;
  const m = {
    n, calls, strikes: strikes.size, expirations: expirations.size,
    withBid, withAsk, withVol, withOi, withDelta, withIv,
    fields: Object.keys(data[0] || {}),
    sample: data.slice(0, 2),
  };

  // Placeholder: centinelas explicitos, o una cadena sin NINGUN bid/ask vivo,
  // o una "cadena" degenerada (1 strike / 1 expiracion en un nombre liquido).
  const sentinel = fakeId > 0 || fakeExp > 0;
  const deadQuotes = withBid === 0 && withAsk === 0;
  const degenerate = strikes.size <= 1 || expirations.size <= 1;
  if (sentinel || deadQuotes || degenerate) {
    return {
      status: 'placeholder', ...m,
      note: [
        sentinel && `centinelas (contractID falso: ${fakeId}, expiracion >=2090: ${fakeExp})`,
        deadQuotes && 'ningun bid/ask > 0',
        degenerate && `cadena degenerada (${strikes.size} strikes, ${expirations.size} expiraciones)`,
      ].filter(Boolean).join(' + '),
    };
  }
  return { status: 'ok', ...m };
}

// Expiraciones a 5-14 dias de la fecha de observacion = los weeklies que el
// covered call semanal vende. Sin esto, la fuente sirve para mensuales nomas.
export function weeklyExpirations(data, asOf) {
  const base = Date.parse(asOf + 'T00:00:00Z');
  const out = new Set();
  for (const c of Array.isArray(data) ? data : []) {
    const t = Date.parse(String(c && c.expiration) + 'T00:00:00Z');
    if (!Number.isFinite(t) || !Number.isFinite(base)) continue;
    const dte = Math.round((t - base) / 86400_000);
    if (dte >= 5 && dte <= 14) out.add(String(c.expiration));
  }
  return [...out].sort();
}

// ── Sonda 1: Alpha Vantage HISTORICAL_OPTIONS ───────────────────────────
async function probeAlphaVantage() {
  console.log('\n═══ (1) ALPHA VANTAGE — HISTORICAL_OPTIONS ═══');
  if (!AV_KEY) { console.log('  SALTADO: ALPHAVANTAGE_API_KEY no seteada.\n'); return null; }
  console.log(`  simbolo=${SYMBOL}  presupuesto=${AV_BUDGET} request(s) (de las 25/dia del free tier)\n`);

  const rows = [];
  for (const d of DEPTHS) {
    const date = fridayBack(d.days);
    const url = `https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${encodeURIComponent(SYMBOL)}&date=${date}&apikey=${AV_KEY}`;
    const r = await getJson(url);
    if (!r.body) {
      rows.push({ d, date, status: `ERR ${r.status}`, note: r.raw || '' });
      await sleep(13_000);
      continue;
    }
    const path = save(`av-${SYMBOL}-${date}.json`, r.body);
    const c = classifyAvChain(r.body);
    const weeklies = c.status === 'ok' ? weeklyExpirations(r.body.data, date) : [];
    rows.push({ d, date, status: c.status, c, weeklies, path });
    await sleep(13_000); // AV free ~5/min
  }

  console.log('  profundidad        fecha        estado        contratos  strikes  expir  weeklies(5-14d)');
  console.log('  ' + '-'.repeat(88));
  for (const row of rows) {
    const c = row.c || {};
    console.log(
      '  ' + String(row.d.label).padEnd(18) +
      String(row.date).padEnd(13) +
      String(row.status).padEnd(14) +
      String(c.n ?? '-').padStart(9) +
      String(c.strikes ?? '-').padStart(9) +
      String(c.expirations ?? '-').padStart(7) +
      String((row.weeklies || []).length || '-').padStart(9)
    );
    if (row.note || (row.c && row.c.note)) console.log(`      nota: ${row.note || row.c.note}`);
  }

  const good = rows.find((r) => r.status === 'ok');
  if (good) {
    const c = good.c;
    console.log(`\n  Campos del primer contrato (${good.date}):\n    ${c.fields.join(', ')}`);
    console.log('  Cobertura de campos load-bearing:');
    console.log(`    bid > 0        ${String(c.withBid).padStart(6)} / ${c.n}  (${pct(c.withBid, c.n)})`);
    console.log(`    ask > 0        ${String(c.withAsk).padStart(6)} / ${c.n}  (${pct(c.withAsk, c.n)})`);
    console.log(`    volumen        ${String(c.withVol).padStart(6)} / ${c.n}  (${pct(c.withVol, c.n)})`);
    console.log(`    open interest  ${String(c.withOi).padStart(6)} / ${c.n}  (${pct(c.withOi, c.n)})`);
    console.log(`    delta (greeks) ${String(c.withDelta).padStart(6)} / ${c.n}  (${pct(c.withDelta, c.n)})`);
    console.log(`    IV             ${String(c.withIv).padStart(6)} / ${c.n}  (${pct(c.withIv, c.n)})`);
    console.log(`  Weeklies detectados: ${(good.weeklies || []).join(', ') || 'NINGUNO'}`);
    console.log(`\n  ── PEGAR ESTO EN docs/wheel-fase0.md §1.3 ──`);
    console.log(JSON.stringify(c.sample, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
    console.log(`  (payload completo: ${good.path})`);
  }

  const deepest = [...rows].reverse().find((r) => r.status === 'ok');
  const verdict =
    !rows.some((r) => r.status === 'ok')
      ? (rows.some((r) => r.status === 'placeholder') ? 'G0 FALLA — PLACEHOLDER (free tier no sirve)'
        : rows.every((r) => r.status === 'rate_limited') ? 'G0 INDETERMINADO — rate limit/paywall: reintentar manana'
        : 'G0 FALLA — sin datos')
      : `G0 PASA — datos reales hasta ${deepest.d.label} (${deepest.date})`;
  console.log(`\n  >>> ${verdict}`);
  return { source: 'alphavantage', rows, verdict };
}

// ── Sonda 2: Market Data (marketdata.app) ───────────────────────────────
// Free Forever = 100 creditos/dia; historico = 1 credito / 1000 contratos.
// Techo declarado del free: no se puede pedir data de mas de 1 ano.
// La 2a sonda (~13 meses) existe justamente para VERIFICAR ese techo.
async function probeMarketData() {
  console.log('\n═══ (3a) MARKET DATA — /v1/options/chain?date= ═══');
  if (!MD_TOKEN) { console.log('  SALTADO: MARKETDATA_TOKEN no seteado (registro gratis).\n'); return null; }

  const probes = [
    { label: '~1 mes',    date: fridayBack(30) },
    { label: '~11 meses', date: fridayBack(330) },
    { label: '~13 meses', date: fridayBack(395) }, // debe REBOTAR si el techo es real
  ];
  const rows = [];
  for (const p of probes) {
    // side=call + strikeLimit acota la respuesta para que cueste 1 credito.
    const url = `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(SYMBOL)}/?date=${p.date}&side=call&strikeLimit=10`;
    const r = await getJson(url, { Authorization: `Bearer ${MD_TOKEN}` });
    const b = r.body || {};
    const n = Array.isArray(b.optionSymbol) ? b.optionSymbol.length : 0;
    const bids = Array.isArray(b.bid) ? b.bid.filter((x) => Number(x) > 0).length : 0;
    if (r.body) save(`md-${SYMBOL}-${p.date}.json`, r.body);
    rows.push({
      ...p, http: r.status, s: b.s || (r.raw ? 'raw' : '-'), n, bids,
      creditos: r.headers && r.headers.get ? (r.headers.get('x-api-ratelimit-consumed') || '?') : '?',
      restantes: r.headers && r.headers.get ? (r.headers.get('x-api-ratelimit-remaining') || '?') : '?',
      err: b.errmsg || r.raw || '',
    });
    await sleep(1500);
  }

  console.log('  antiguedad    fecha        http  s        contratos  c/bid>0  creditos  restantes');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) {
    console.log(
      '  ' + r.label.padEnd(13) + String(r.date).padEnd(13) + String(r.http).padEnd(6) +
      String(r.s).padEnd(9) + String(r.n).padStart(9) + String(r.bids).padStart(9) +
      String(r.creditos).padStart(10) + String(r.restantes).padStart(11)
    );
    if (r.err) console.log(`      nota: ${String(r.err).slice(0, 140)}`);
  }
  const near = rows[0], far = rows[2];
  console.log(`\n  >>> ${near && near.n > 0 ? 'SIRVE' : 'NO SIRVE'} para la ventana reciente; ` +
    `techo de 12 meses ${far && far.n > 0 ? 'NO confirmado (mejor de lo esperado)' : 'CONFIRMADO (el free no pasa de ~1 ano)'}`);
  return { source: 'marketdata', rows };
}

// ── Sonda 3: Alpaca (plan B; keys ya en casa, presupuesto independiente) ──
// Historia declarada desde feb-2024. No hay "cadena as-of": hay que listar
// contratos expirados y despues pedir barras/quotes por contrato.
async function probeAlpaca() {
  console.log('\n═══ (3b) ALPACA — contratos expirados + barras historicas ═══');
  if (!ALPACA_KEY || !ALPACA_SECRET) { console.log('  SALTADO: ALPACA_PAPER_KEY/SECRET no seteadas.\n'); return null; }
  const H = { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET };

  const expFrom = fridayBack(400), expTo = fridayBack(365);
  const listUrl = `https://paper-api.alpaca.markets/v2/options/contracts` +
    `?underlying_symbols=${encodeURIComponent(SYMBOL)}&status=inactive&type=call` +
    `&expiration_date_gte=${expFrom}&expiration_date_lte=${expTo}&limit=50`;
  const l = await getJson(listUrl, H);
  const contracts = (l.body && l.body.option_contracts) || [];
  console.log(`  contratos expirados listados (${expFrom}..${expTo}): ${contracts.length} (http ${l.status})`);
  if (!contracts.length) {
    console.log(`  >>> NO SIRVE: sin contratos expirados listables. ${(l.body && l.body.message) || l.raw || ''}`);
    return { source: 'alpaca', ok: false };
  }

  const occ = contracts[0].symbol;
  const barsUrl = `https://data.alpaca.markets/v1beta1/options/bars?symbols=${encodeURIComponent(occ)}` +
    `&timeframe=1Day&start=${fridayBack(430)}&end=${fridayBack(360)}&limit=100`;
  const b = await getJson(barsUrl, H);
  const bars = (b.body && b.body.bars && b.body.bars[occ]) || [];
  console.log(`  barras diarias de ${occ}: ${bars.length} (http ${b.status})`);
  if (bars.length) console.log(`  muestra: ${JSON.stringify(bars[0])}`);
  console.log(`  >>> ${bars.length >= 5
    ? 'SIRVE con plomeria (barras = precios OPERADOS, no bid/ask: strikes OTM poco operados pueden no tener barra)'
    : 'NO SIRVE / huecos: el contrato no tiene barras suficientes'}`);
  return { source: 'alpaca', ok: bars.length >= 5, occ, bars: bars.length };
}

// ── main ────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('════════════════════════════════════════════════════════════');
  console.log(' FASE 0 — WHEEL/COVERED CALLS: sonda de cadenas historicas');
  console.log(' Criterio (docs/wheel-fase0.md §6): >=1 ano de cadenas');
  console.log(' muestreables, >=3-5 nombres liquidos, premium utilizable,');
  console.log(' cosecha <=3 semanas de goteo.');
  console.log('════════════════════════════════════════════════════════════');

  const av = await probeAlphaVantage();
  const md = await probeMarketData();
  const al = await probeAlpaca();

  console.log('\n═══ RESUMEN ═══');
  console.log(`  Alpha Vantage : ${av ? av.verdict : 'no sondeado'}`);
  console.log(`  Market Data   : ${md ? (md.rows[0] && md.rows[0].n > 0 ? 'datos reales en ventana <=1 ano' : 'sin datos') : 'no sondeado'}`);
  console.log(`  Alpaca        : ${al ? (al.ok ? 'barras historicas OK (con plomeria)' : 'no utilizable tal cual') : 'no sondeado'}`);
  console.log(`\n  Payloads crudos en ./${OUT_DIR}/ — pegar la muestra en docs/wheel-fase0.md §1.3`);
  console.log('  y anotar el resultado de G0 en §6 antes de escribir una linea de harvester.\n');
}
