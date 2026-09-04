#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// FASE 0 — CONGRESO (STOCK Act): sonda de fuentes (cierra G1 y G2)
//
// Este script existe porque el entorno donde se escribio el memo NO tiene
// egress a *.gov (proxy 403, ver docs/congreso-fase0.md §0). Todo lo que el
// memo dice sobre accesibilidad y formato es documentacion de terceros. Esto
// lo convierte en numeros propios.
//
// G1 — CAMARA: ¿el ZIP/XML del Clerk es alcanzable desde una IP de datacenter,
//      y que fraccion de los PDFs de PTR trae capa de texto (vs escaneados)?
//      Verde si >= 90% de la muestra del ano en curso tiene texto extraible.
//
// G2 — SENADO: ¿el flujo agreement -> CSRF -> POST JSON de efdsearch responde
//      desde esta IP, o hay 403 / challenge de Akamai?
//      Verde si /search/report/data/ devuelve JSON con filas.
//
// USO:
//   node scripts/congreso-phase0-probe.mjs
//   node scripts/congreso-phase0-probe.mjs --pdfs=40      # muestra mas grande
//   node scripts/congreso-phase0-probe.mjs --year=2025    # otro ano
//   node scripts/congreso-phase0-probe.mjs --only=house   # o --only=senate
//
// Sin dependencias (fetch global + zlib de Node >= 18). Sin keys: las dos
// rutas son publicas y anonimas. ~15 requests en total.
// Los payloads crudos quedan en ./.congreso-phase0/ para inspeccion.
// ═══════════════════════════════════════════════════════════════════════

import { inflateSync, inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_DIR = '.congreso-phase0';
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const YEAR = String(args.year || new Date().getUTCFullYear());
const PDF_SAMPLE = Number(args.pdfs || 20);
const ONLY = args.only || null;

// UA identificado, mismo criterio que usamos con SEC (api/stock-tracker.js).
const UA = 'QuantDesk research@quantdesk.app';
// Piso entre requests al Clerk: no hay limite publicado, somos educados igual.
const THROTTLE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

function save(name, body) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${name}`, body);
    return `${OUT_DIR}/${name}`;
  } catch (e) {
    return `(no se pudo guardar: ${e.message})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Lector de ZIP minimo (metodos 0=store y 8=deflate). El FD.zip del Clerk
// trae un solo XML adentro; no vale una dependencia.
// ─────────────────────────────────────────────────────────────────────────
function unzip(buf) {
  // End of Central Directory: 0x06054b50, buscado desde el final.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no se encontro el End of Central Directory (¿es un ZIP?)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset del central directory
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // El header local manda: sus lengths pueden diferir de los del central.
    const method = buf.readUInt16LE(localOff + 8);
    const compSize = buf.readUInt32LE(localOff + 18) || buf.readUInt32LE(p + 20);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);

    entries.push({
      name,
      data: method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null,
      method,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// Extractor de strings de un content stream de PDF. Camina el stream en vez
// de usar un regex porque los parentesis ANIDAN en PDF —
// `(Apple Inc. (AAPL) Purchase)` es UN string, y un regex ingenuo se queda
// con `(AAPL)` y tira el resto. Tambien decodifica strings hexadecimales.
function extractStrings(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') {
      let depth = 1;
      i++;
      let buf = '';
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') { buf += s[i + 1] || ''; i += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) break; }
        buf += c;
        i++;
      }
      out += buf + ' ';
    } else if (ch === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end < 0) continue;
      const hex = s.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length >= 2 && hex.length % 2 === 0 && hex.length < 4096) {
        out += Buffer.from(hex, 'hex').toString('latin1').replace(/\u0000/g, '') + ' ';
      }
      i = end;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Clasificador de PDF sin librerias: infla los content streams y busca
// operadores de texto. No es un parser — solo responde "¿hay capa de texto?".
// ─────────────────────────────────────────────────────────────────────────
function classifyPdf(buf) {
  const raw = buf.toString('latin1');
  const hasFont = /\/Font\b/.test(raw);
  const hasImage = /\/Subtype\s*\/Image/.test(raw);

  let textOps = 0;
  let extracted = '';
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const chunk = buf.subarray(start, end);
    let out = null;
    try { out = inflateSync(chunk); } catch { /* no comprimido o no-Flate */ }
    if (!out) {
      // Puede ser un content stream sin comprimir.
      const asText = chunk.toString('latin1');
      if (/\bBT\b/.test(asText)) out = Buffer.from(asText, 'latin1');
    }
    if (!out) continue;
    const s = out.toString('latin1');
    const hits = (s.match(/\bT[jJ]\b/g) || []).length;
    if (hits) {
      textOps += hits;
      // El texto que veria un parser real (literales y hex).
      extracted += extractStrings(s);
    }
    if (extracted.length > 200000) break;
  }

  const kind = textOps > 0 ? 'texto' : hasImage && !hasFont ? 'escaneado' : 'indeterminado';
  return { kind, textOps, hasFont, hasImage, extracted, bytes: buf.length };
}

// Marcadores del formulario PTR: si aparecen, el PDF no solo tiene texto,
// tiene los CAMPOS que la Fase 1 necesita parsear.
const PTR_MARKERS = [
  { key: 'encabezado', re: /Transaction\s*Date|Notification\s*Date/i },
  { key: 'tipo', re: /\bPurchase\b|\bSale\b|\bExchange\b/i },
  { key: 'bucket_monto', re: /\$1,?001|\$15,?000|\$50,?001|\$1,?000,?001/ },
  { key: 'owner', re: /\bSP\b|\bJT\b|\bDC\b|Spouse|Joint/i },
  { key: 'ticker', re: /\(([A-Z]{1,5})\)/ },
];

async function fetchBuf(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
    const ab = await res.arrayBuffer();
    return { ok: res.ok, status: res.status, buf: Buffer.from(ab), res, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, buf: Buffer.alloc(0), note: String(e.message || e), ms: Date.now() - t0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// G1 — CAMARA
// ═══════════════════════════════════════════════════════════════════════
async function probeHouse() {
  console.log('\n═══ G1 — CAMARA (disclosures-clerk.house.gov) ═══');
  const zipUrl = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${YEAR}FD.zip`;
  console.log(`  [1/3] ZIP indice: ${zipUrl}`);

  const zip = await fetchBuf(zipUrl);
  if (!zip.ok) {
    console.log(`  ✗ HTTP ${zip.status}${zip.note ? ` — ${zip.note}` : ''} (${zip.ms}ms)`);
    console.log('  → G1 ROJO por acceso: el ZIP no se pudo bajar desde esta IP.');
    return { gate: 'ROJO', reason: `ZIP HTTP ${zip.status}` };
  }
  console.log(`  ✓ HTTP 200 — ${(zip.buf.length / 1024 / 1024).toFixed(2)} MB en ${zip.ms}ms`);

  let entries;
  try { entries = unzip(zip.buf); } catch (e) {
    console.log(`  ✗ no se pudo descomprimir: ${e.message}`);
    return { gate: 'ROJO', reason: 'ZIP ilegible' };
  }
  const xmlEntry = entries.find((e) => /\.xml$/i.test(e.name) && e.data);
  if (!xmlEntry) {
    console.log(`  ✗ el ZIP no trae XML. Contenido: ${entries.map((e) => e.name).join(', ')}`);
    return { gate: 'ROJO', reason: 'sin XML en el ZIP' };
  }
  const xml = xmlEntry.data.toString('utf8');
  console.log(`  ✓ ${xmlEntry.name} — ${(xml.length / 1024 / 1024).toFixed(2)} MB · guardado en ${save(`${YEAR}FD.xml`, xml)}`);

  // ── Parse del indice (solo lo que la Fase 1 necesitaria) ──
  console.log('\n  [2/3] Indice XML');
  const members = [...xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((m) => {
    const f = (tag) => (m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ''])[1].trim();
    return {
      last: f('Last'), first: f('First'), type: f('FilingType'),
      stateDst: f('StateDst'), year: f('Year'), filingDate: f('FilingDate'), docId: f('DocID'),
    };
  });
  const ptrs = members.filter((m) => m.type === 'P');
  console.log(`  ✓ ${members.length} filings en el indice · ${ptrs.length} son PTR (FilingType=P)`);
  const types = {};
  for (const m of members) types[m.type] = (types[m.type] || 0) + 1;
  console.log(`    tipos: ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (!ptrs.length) {
    console.log('  → G1 ROJO: el indice no trae PTRs para este ano.');
    return { gate: 'ROJO', reason: 'sin PTRs en el indice' };
  }

  // Campos disponibles vs los que necesitamos.
  const s = ptrs[0];
  console.log(`    ejemplo: ${s.first} ${s.last} · ${s.stateDst} · filed ${s.filingDate} · DocID ${s.docId}`);
  console.log(`    ⚠ el indice NO trae partido ni bioguide ID (matching manual, ver §7.3 del memo)`);
  console.log(`    ⚠ el indice NO trae transacciones — viven dentro del PDF`);

  // ── Muestra de PDFs: la pregunta (a) del encargo ──
  console.log(`\n  [3/3] Muestra de ${Math.min(PDF_SAMPLE, ptrs.length)} PDFs (los mas recientes por FilingDate)`);
  const sorted = [...ptrs].sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
  const sample = sorted.slice(0, Math.min(PDF_SAMPLE, sorted.length));

  const tally = { texto: 0, escaneado: 0, indeterminado: 0, error: 0 };
  const markerHits = {};
  const rows = [];

  for (const p of sample) {
    await sleep(THROTTLE_MS);
    const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${p.year || YEAR}/${p.docId}.pdf`;
    const r = await fetchBuf(url);
    if (!r.ok) {
      tally.error++;
      rows.push({ docId: p.docId, kind: `HTTP ${r.status}` });
      continue;
    }
    const c = classifyPdf(r.buf);
    tally[c.kind]++;
    const hits = PTR_MARKERS.filter((mk) => mk.re.test(c.extracted)).map((mk) => mk.key);
    for (const h of hits) markerHits[h] = (markerHits[h] || 0) + 1;
    rows.push({ docId: p.docId, kind: c.kind, textOps: c.textOps, kb: Math.round(c.bytes / 1024), markers: hits.length });
    if (rows.length === 1 && c.extracted) save(`sample-${p.docId}.txt`, c.extracted.slice(0, 20000));
  }

  console.log('    DocID       clase          textOps   KB   marcadores');
  for (const r of rows) {
    console.log(`    ${String(r.docId).padEnd(11)} ${String(r.kind).padEnd(14)} ${String(r.textOps ?? '-').padStart(7)} ${String(r.kb ?? '-').padStart(4)}   ${r.markers ?? '-'}/5`);
  }
  const n = sample.length;
  console.log(`\n    con capa de texto: ${tally.texto}/${n} (${pct(tally.texto, n)})`);
  console.log(`    escaneados:        ${tally.escaneado}/${n} (${pct(tally.escaneado, n)})`);
  console.log(`    indeterminados:    ${tally.indeterminado}/${n} · errores HTTP: ${tally.error}`);
  console.log(`    marcadores del formulario PTR encontrados: ${PTR_MARKERS.map((mk) => `${mk.key}=${markerHits[mk.key] || 0}`).join(' · ')}`);
  save('house-sample.json', JSON.stringify({ year: YEAR, total: members.length, ptrs: ptrs.length, tally, markerHits, rows }, null, 2));

  const ratio = tally.texto / n;
  const gate = ratio >= 0.9 ? 'VERDE' : 'ROJO';
  console.log(`\n  → G1 ${gate}: ${pct(tally.texto, n)} con texto (umbral 90%).`);
  if (gate === 'ROJO') console.log('    Implica decidir OCR (+8-12h, fuera del serverless) o recortar alcance.');
  return { gate, reason: `${pct(tally.texto, n)} con texto`, ptrs: ptrs.length, tally };
}

// ═══════════════════════════════════════════════════════════════════════
// G2 — SENADO
// ═══════════════════════════════════════════════════════════════════════
function cookiesFrom(res, jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function probeSenate() {
  console.log('\n═══ G2 — SENADO (efdsearch.senate.gov) ═══');
  // UA de navegador a proposito: es el escenario que queremos medir (¿pasa un
  // cliente honesto desde IP de datacenter?), no un intento de evasion.
  const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const jar = {};
  const base = 'https://efdsearch.senate.gov';

  console.log('  [1/3] GET /search/home/ (agreement + CSRF)');
  const home = await fetchBuf(`${base}/search/home/`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!home.ok) {
    console.log(`  ✗ HTTP ${home.status}${home.note ? ` — ${home.note}` : ''} (${home.ms}ms)`);
    console.log('  → G2 ROJO en el primer request.');
    console.log('    Puede ser el WAF del Senado (§2.2 del memo) O un proxy de egress local.');
    console.log('    Si G1 tambien fallo en su primer request, sospecha del entorno, no de la fuente.');
    return { gate: 'ROJO', reason: `home HTTP ${home.status}` };
  }
  const html = home.buf.toString('utf8');
  save('senate-home.html', html);
  const cookieHeader = cookiesFrom(home.res, jar);
  const csrf = (html.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)/) || [])[1] || jar.csrftoken;
  console.log(`  ✓ HTTP 200 (${home.ms}ms) · csrf ${csrf ? 'encontrado' : 'AUSENTE'} · cookies: ${Object.keys(jar).join(', ') || 'ninguna'}`);
  if (/akamai|reference\s*#|access denied/i.test(html)) console.log('  ⚠ el HTML huele a challenge/denegacion, no al formulario real.');
  if (!csrf) return { gate: 'ROJO', reason: 'sin csrfmiddlewaretoken' };

  console.log('  [2/3] POST /search/home/ (prohibition_agreement=1)');
  const agree = await fetchBuf(`${base}/search/home/`, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA, Cookie: cookieHeader, Referer: `${base}/search/home/`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ prohibition_agreement: '1', csrfmiddlewaretoken: csrf }).toString(),
  });
  if (!agree.ok) {
    console.log(`  ✗ HTTP ${agree.status} — el agreement no paso.`);
    return { gate: 'ROJO', reason: `agreement HTTP ${agree.status}` };
  }
  const cookie2 = cookiesFrom(agree.res, jar);
  console.log(`  ✓ HTTP ${agree.status} (${agree.ms}ms)`);

  console.log('  [3/3] POST /search/report/data/ (report_types=[11] = PTR)');
  const data = await fetchBuf(`${base}/search/report/data/`, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA, Cookie: cookie2, Referer: `${base}/search/home/`,
      'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': jar.csrftoken || csrf,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      start: '0', length: '25', report_types: '[11]', filer_types: '[]',
      submitted_start_date: '', submitted_end_date: '', candidate_state: '',
      senator_state: '', office_id: '', first_name: '', last_name: '',
      csrfmiddlewaretoken: jar.csrftoken || csrf,
    }).toString(),
  });
  const body = data.buf.toString('utf8');
  save('senate-report-data.txt', body.slice(0, 40000));
  if (!data.ok) {
    console.log(`  ✗ HTTP ${data.status} (${data.ms}ms) — primeros bytes: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    console.log('  → G2 ROJO: el endpoint JSON no responde desde esta IP.');
    return { gate: 'ROJO', reason: `data HTTP ${data.status}` };
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* no era JSON */ }
  if (!json || !Array.isArray(json.data)) {
    console.log(`  ✗ HTTP 200 pero no es el JSON esperado — primeros bytes: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    return { gate: 'ROJO', reason: 'respuesta no-JSON' };
  }
  console.log(`  ✓ HTTP 200 (${data.ms}ms) · ${json.data.length} filas · total declarado: ${json.recordsTotal ?? '?'}`);
  if (json.data[0]) console.log(`    ejemplo: ${JSON.stringify(json.data[0]).slice(0, 200)}`);
  console.log('\n  → G2 VERDE: el flujo completo funciona desde esta IP.');
  return { gate: 'VERDE', reason: `${json.data.length} filas`, total: json.recordsTotal };
}

// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  FASE 0 CONGRESO — sonda de fuentes · ano ${YEAR} · ${new Date().toISOString()}`);
  console.log('  Memo: docs/congreso-fase0.md  ·  payloads: ' + OUT_DIR);
  console.log('═══════════════════════════════════════════════════════════');

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || '';
  if (proxy) {
    console.log(`\n  ⚠ Hay un proxy de egress configurado (${proxy}). Un 403 puede venir de EL,`);
    console.log('    no de la fuente. Este script solo cierra las compuertas desde una IP con');
    console.log('    salida directa (Vercel, tu maquina, un runner sin proxy de politica).');
  }

  const house = ONLY === 'senate' ? null : await probeHouse().catch((e) => ({ gate: 'ROJO', reason: `excepcion: ${e.message}` }));
  const senate = ONLY === 'house' ? null : await probeSenate().catch((e) => ({ gate: 'ROJO', reason: `excepcion: ${e.message}` }));

  console.log('\n═══ VEREDICTO ═══');
  if (house) console.log(`  G1 CAMARA: ${house.gate} — ${house.reason}`);
  if (senate) console.log(`  G2 SENADO: ${senate.gate} — ${senate.reason}`);
  console.log('');
  if (house?.gate === 'VERDE') {
    console.log('  La ruta recomendada del memo (House directo) queda confirmada.');
    console.log(senate?.gate === 'VERDE'
      ? '  El Senado tambien entra: la Fase 1 puede cubrir las dos camaras.'
      : '  El Senado queda FUERA del MVP: la UI tiene que decir "solo Camara de Representantes".');
  } else if (house) {
    const ambos403 = /403/.test(house.reason || '') && /403/.test(senate?.reason || '');
    if (ambos403) {
      console.log('  ⚠ LAS DOS fuentes dieron 403 en el primer request. Eso no es un veredicto');
      console.log('    sobre las fuentes: es casi seguro el entorno (proxy de egress bloqueando');
      console.log('    *.gov). NO anotes esto como G1/G2 rojo — vuelve a correrlo con salida real.');
    } else {
      console.log('  ⚠ La ruta recomendada NO se confirma. No arranca la Fase 1 hasta resolverlo.');
    }
  }
  console.log('\n  Pega esta salida en docs/congreso-fase0.md §6.1 antes de cerrar la Fase 0.');
  console.log('  Recordatorio: la consulta legal puntual (condicion 2) sigue abierta y es previa.\n');

  save('veredicto.json', JSON.stringify({ ts: new Date().toISOString(), year: YEAR, house, senate }, null, 2));
}

main().catch((e) => { console.error('\nFALLO INESPERADO:', e); process.exit(1); });
