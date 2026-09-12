#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// FASE 0 — CONGRESO (STOCK Act): sonda de fuentes (cierra G1 y G2)
//
// v2 (2026-09-08) — tras la primera corrida real desde una Mac. Cambios:
//   · La muestra se PARTE por clase de DocID: e-filed (2xxxxxxx) vs papel
//     (9xxxxxx). Mezclarlas hacia un solo porcentaje escondia justo la
//     respuesta que la pregunta (a) del encargo pedia.
//   · El clasificador sin dependencias resulto ser un FALSO NEGATIVO en v1
//     (15/20 "indeterminado" con textOps=0 en PDFs de 60-90 KB). Ahora
//     DIAGNOSTICA por que falla —cifrado, streams no inflables, cuantos—
//     en vez de reportar un veredicto que no se gano.
//   · Extraccion autoritativa opcional con pdfjs-dist / pdf-parse si estan
//     instalados. El repo sigue sin dependencias; la sonda es local:
//         npm i --no-save pdfjs-dist && node scripts/congreso-phase0-probe.mjs
//   · G2 pacea 2 s entre pasos, reintenta el POST con payload DataTables
//     completo, y toma la huella del cuerpo de error (Akamai / Reference #).
//
// G1 — CAMARA: ¿el ZIP/XML del Clerk es alcanzable desde esta IP, y que
//      fraccion de los PTR **e-filed** trae capa de texto parseable?
//      Verde si >= 90% de los e-filed rinde los 5 campos del formulario.
//
// G2 — SENADO: ¿el flujo agreement -> CSRF -> POST JSON de efdsearch responde
//      desde esta IP, o hay 403/503 de bot mitigation?
//
// USO:
//   node scripts/congreso-phase0-probe.mjs
//   node scripts/congreso-phase0-probe.mjs --efiled=30 --paper=5
//   node scripts/congreso-phase0-probe.mjs --only=g2     # solo el Senado
//   node scripts/congreso-phase0-probe.mjs --year=2025 --only=g1
//
// Sin keys: las dos rutas son publicas y anonimas. Payloads crudos y los PDFs
// de muestra quedan en ./.congreso-phase0/ para diagnostico offline.
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
const N_EFILED = Number(args.efiled || 30);
const N_PAPER = Number(args.paper || 5);
// --only acepta g1/g2 como alias de house/senate (pedido: correr G2 solo, en
// horario habil de EE.UU., sin volver a bajar 35 PDFs).
const ONLY = ({ g1: 'house', g2: 'senate' })[String(args.only || '').toLowerCase()]
  || (args.only ? String(args.only).toLowerCase() : null);

const UA = 'QuantDesk research@quantdesk.app';
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

// DocID: los e-filed del sistema electronico son 2xxxxxxx (8 digitos); los
// escaneados de papel son 9xxxxxx (7). Es la particion que pidio el encargo.
const docClass = (docId) => (/^9/.test(String(docId)) ? 'papel' : 'e-filed');

// ─────────────────────────────────────────────────────────────────────────
// Extractor autoritativo OPCIONAL. Si pdfjs-dist o pdf-parse estan
// instalados, se usan y mandan. Si no, seguimos con la heuristica propia
// y lo decimos — nunca al reves.
// ─────────────────────────────────────────────────────────────────────────
let pdfLib = { name: null, extract: null, error: null };

async function initPdfLib() {
  try {
    const m = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const getDocument = m.getDocument || (m.default && m.default.getDocument);
    if (!getDocument) throw new Error('getDocument no expuesto');
    pdfLib = {
      name: 'pdfjs-dist',
      error: null,
      extract: async (buf) => {
        const doc = await getDocument({
          data: new Uint8Array(buf), useSystemFonts: true,
          isEvalSupported: false, verbosity: 0,
        }).promise;
        let text = '';
        for (let i = 1; i <= doc.numPages; i++) {
          const tc = await (await doc.getPage(i)).getTextContent();
          text += tc.items.map((it) => it.str).join(' ') + '\n';
        }
        if (doc.destroy) await doc.destroy();
        return text;
      },
    };
    return;
  } catch (e) { pdfLib.error = String(e.message || e); }

  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pdfParse = req('pdf-parse');
    pdfLib = { name: 'pdf-parse', error: null, extract: async (buf) => (await pdfParse(buf)).text };
  } catch { /* ninguna disponible: se queda la heuristica */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Extractor de strings de un content stream. Camina el stream en vez de usar
// un regex porque los parentesis ANIDAN en PDF: `(Apple Inc. (AAPL) Purchase)`
// es UN string y un regex ingenuo se queda con `(AAPL)`.
// ─────────────────────────────────────────────────────────────────────────
function extractStrings(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') {
      let depth = 1; i++; let buf = '';
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') { buf += s[i + 1] || ''; i += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) break; }
        buf += c; i++;
      }
      out += buf + ' ';
    } else if (ch === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end < 0) continue;
      const hex = s.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length >= 2 && hex.length % 2 === 0 && hex.length < 4096) {
        out += Buffer.from(hex, 'hex').toString('latin1').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') + ' ';
      }
      i = end;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Heuristica sin dependencias + DIAGNOSTICO. La v1 solo decia "0 textOps";
// esta dice CUANTOS streams encontro, cuantos pudo inflar, y con que error
// fallaron los demas — que es lo unico que permite distinguir "PDF escaneado"
// de "mi extractor no sirve".
// ─────────────────────────────────────────────────────────────────────────
function classifyPdf(buf) {
  const raw = buf.toString('latin1');
  const hasFont = /\/Font\b/.test(raw);
  const hasImage = /\/Subtype\s*\/Image/.test(raw);
  const encrypted = /\/Encrypt\b/.test(raw);
  const xfa = /\/XFA\b/.test(raw);

  let streams = 0, inflated = 0, failed = 0, firstErr = null;
  let textOps = 0, extracted = '';

  // `(?<!end)stream` evita casar la palabra dentro de `endstream`, y el EOL
  // es obligatorio: el byte siguiente al keyword ya es dato comprimido.
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    streams++;
    const chunk = buf.subarray(start, end);
    let out = null;
    for (const fn of [inflateSync, inflateRawSync]) {
      try { out = fn(chunk); break; } catch (e) { if (!firstErr) firstErr = String(e.message || e); }
    }
    if (!out) {
      const asText = chunk.toString('latin1');
      if (/\bBT\b/.test(asText)) out = Buffer.from(asText, 'latin1');  // stream sin comprimir
    }
    if (!out) { failed++; continue; }
    inflated++;
    const s = out.toString('latin1');
    const hits = (s.match(/\bT[jJ]\b/g) || []).length;
    if (hits) { textOps += hits; extracted += extractStrings(s); }
    if (extracted.length > 200000) break;
  }

  const kind = textOps > 0 ? 'texto'
    : hasImage && !hasFont ? 'escaneado'
    : 'indeterminado';
  return { kind, textOps, hasFont, hasImage, encrypted, xfa, extracted, bytes: buf.length,
           diag: { streams, inflated, failed, firstErr } };
}

// Marcadores del formulario PTR: presencia de texto no basta, queremos los
// CAMPOS que la Fase 1 tendria que parsear.
//
// `required` decide el score de "campos completos". `ticker` es OPCIONAL a
// proposito: bonos, fondos y cripto llegan SIN ticker (el propio formulario
// deja `--`), asi que exigirlo penalizaria filings perfectamente parseables.
//
// El regex de `tipo` se corrigio tras la corrida 2 (3/30 con la version vieja,
// contra encabezado 30/30 y owner 30/30): el formulario de la Camara imprime
// el tipo como CODIGO de una letra en su columna —`P`, `S`, `S (partial)`,
// `E`— no como palabra. Las palabras completas solo aparecen en algunos
// filings. Se aceptan las dos formas, y el codigo solo cuando esta pegado a
// una fecha o a un monto (un `S` suelto aparece por todos lados).
// HIPOTESIS a confirmar con el diagnostico de ventana de la corrida 3.
const PTR_MARKERS = [
  { key: 'encabezado', required: true, re: /Transaction\s*Date|Notification\s*Date/i },
  { key: 'tipo', required: true, re: /\bS\s*\(partial\)|\b(?:Purchase|Sale|Exchange)\b|\b[PSE](?=\s+\d{1,2}\/\d{1,2}\/\d{4})|\d{1,2}\/\d{1,2}\/\d{4}\s+[PSE](?=\s|$)|\b[PSE](?=\s+\$[\d,]+\s*-)/ },
  // Corregido tras la corrida 3 (24/30). La version vieja ENUMERABA cuatro
  // literales de bucket ($1,001 / $15,000 / $50,001 / $1,000,001), asi que
  // acertaba solo con el bucket mas comun y fallaba con $15,001-$50,000,
  // $100,001-$250,000 y $250,001-$500,000. No tenia que ver con bonos ni con
  // nombres largos: `20033779` es una fila de Pfizer y tambien fallaba.
  // Ahora se busca la FORMA del bucket —un rango de dolares, o el tope
  // abierto— en vez de una lista de valores que se queda corta sola.
  { key: 'bucket_monto', required: true, re: /\$[\d,]{3,}\s*[-–—]\s*\$[\d,]{3,}|(?:Over|Más de|>)\s*\$[\d,]{7,}/i },
  { key: 'owner', required: true, re: /\bSP\b|\bJT\b|\bDC\b|Spouse|Joint/i },
  { key: 'ticker', required: false, re: /\(([A-Z]{1,5})\)/ },
];
const REQUIRED_MARKERS = PTR_MARKERS.filter((m) => m.required);

// Ventana de texto alrededor de la primera fecha: cuando a un filing le falta
// un marcador requerido, esto muestra COMO viene la fila de verdad. Sin esto,
// arreglar un regex es adivinar.
function windowAroundRow(text) {
  const m = /\d{1,2}\/\d{1,2}\/\d{4}/.exec(text || '');
  if (!m) return '';
  return String(text).slice(Math.max(0, m.index - 120), m.index + 120).replace(/\s+/g, ' ');
}

async function fetchBuf(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    const ab = await res.arrayBuffer();
    return { ok: res.ok, status: res.status, buf: Buffer.from(ab), res, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, buf: Buffer.alloc(0), note: String(e.message || e), ms: Date.now() - t0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Lector de ZIP minimo (metodos 0=store, 8=deflate).
// ─────────────────────────────────────────────────────────────────────────
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no se encontro el End of Central Directory (¿es un ZIP?)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const method = buf.readUInt16LE(localOff + 8);
    const compSize = buf.readUInt32LE(localOff + 18) || buf.readUInt32LE(p + 20);
    const dataOff = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const rawData = buf.subarray(dataOff, dataOff + compSize);
    entries.push({ name, method, data: method === 8 ? inflateRawSync(rawData) : method === 0 ? rawData : null });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
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
    return { gate: 'ROJO', reason: `ZIP HTTP ${zip.status}` };
  }
  console.log(`  ✓ HTTP 200 — ${(zip.buf.length / 1024 / 1024).toFixed(2)} MB en ${zip.ms}ms`);

  let entries;
  try { entries = unzip(zip.buf); } catch (e) {
    console.log(`  ✗ no se pudo descomprimir: ${e.message}`);
    return { gate: 'ROJO', reason: 'ZIP ilegible' };
  }
  const xmlEntry = entries.find((e) => /\.xml$/i.test(e.name) && e.data);
  if (!xmlEntry) return { gate: 'ROJO', reason: 'sin XML en el ZIP' };
  const xml = xmlEntry.data.toString('utf8');
  console.log(`  ✓ ${xmlEntry.name} — ${(xml.length / 1024 / 1024).toFixed(2)} MB · ${save(`${YEAR}FD.xml`, xml)}`);

  console.log('\n  [2/3] Indice XML');
  const members = [...xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((m) => {
    const f = (tag) => (m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ''])[1].trim();
    return { last: f('Last'), first: f('First'), type: f('FilingType'), stateDst: f('StateDst'),
             year: f('Year'), filingDate: f('FilingDate'), docId: f('DocID') };
  });
  const ptrs = members.filter((m) => m.type === 'P');
  const types = {};
  for (const m of members) types[m.type] = (types[m.type] || 0) + 1;
  console.log(`  ✓ ${members.length} filings · ${ptrs.length} PTR (FilingType=P)`);
  console.log(`    tipos: ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (!ptrs.length) return { gate: 'ROJO', reason: 'sin PTRs en el indice' };

  const byClass = { 'e-filed': ptrs.filter((p) => docClass(p.docId) === 'e-filed'),
                    papel: ptrs.filter((p) => docClass(p.docId) === 'papel') };
  console.log(`    de esos PTR: ${byClass['e-filed'].length} e-filed (DocID 2xxxxxxx) · ${byClass.papel.length} papel (9xxxxxx)`);
  console.log('    ⚠ el indice NO trae partido ni bioguide ID · NO trae transacciones (viven en el PDF)');

  // ── Muestra PARTIDA por clase: es la pregunta (a) del encargo ──
  await initPdfLib();
  console.log(`\n  [3/3] Muestra: ${N_EFILED} e-filed + ${N_PAPER} papel (mas recientes por FilingDate)`);
  console.log(`    extractor: ${pdfLib.name ? `${pdfLib.name} (autoritativo)` : 'heuristica propia (sin libreria)'}`);
  if (!pdfLib.name) console.log('    → para una medicion autoritativa: npm i --no-save pdfjs-dist  y volver a correr');

  const byDate = (a, b) => new Date(b.filingDate) - new Date(a.filingDate);
  const sample = [
    ...[...byClass['e-filed']].sort(byDate).slice(0, N_EFILED),
    ...[...byClass.papel].sort(byDate).slice(0, N_PAPER),
  ];

  const stats = {
    'e-filed': { n: 0, texto: 0, escaneado: 0, indeterminado: 0, error: 0, cifrados: 0, completos: 0 },
    papel: { n: 0, texto: 0, escaneado: 0, indeterminado: 0, error: 0, cifrados: 0, completos: 0 },
  };
  const markerHits = {};
  const rows = [];
  const windows = [];
  const savedRaw = { 'e-filed': false, papel: false };

  for (const p of sample) {
    await sleep(THROTTLE_MS);
    const cls = docClass(p.docId);
    const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${p.year || YEAR}/${p.docId}.pdf`;
    const r = await fetchBuf(url);
    stats[cls].n++;
    if (!r.ok) { stats[cls].error++; rows.push({ cls, docId: p.docId, type: p.type, kind: `HTTP ${r.status}` }); continue; }

    // Un PDF crudo por clase queda en disco: sin el, un falso negativo del
    // extractor no se puede diagnosticar despues.
    if (!savedRaw[cls]) { save(`raw-${cls}-${p.docId}.pdf`, r.buf); savedRaw[cls] = true; }

    const c = classifyPdf(r.buf);
    let text = c.extracted;
    let libFailed = false;
    if (pdfLib.extract) {
      try { text = await pdfLib.extract(r.buf); } catch (e) { text = ''; libFailed = true; }
    }
    const chars = (text || '').trim().length;
    // Con extractor autoritativo, SU veredicto manda: la heuristica no puede
    // "rescatar" un PDF del que la libreria no saco nada (corrida 2: el DocID
    // 9116328 salio "texto" con 0 chars, que es una contradiccion).
    const kind = pdfLib.extract
      ? (chars > 40 ? 'texto' : c.hasImage ? 'escaneado' : 'indeterminado')
      : (chars > 40 ? 'texto' : c.kind);
    stats[cls][kind]++;
    if (c.encrypted) stats[cls].cifrados++;

    const hits = PTR_MARKERS.filter((mk) => mk.re.test(text)).map((mk) => mk.key);
    for (const h of hits) markerHits[h] = (markerHits[h] || 0) + 1;
    const req = REQUIRED_MARKERS.filter((mk) => mk.re.test(text)).length;
    if (req === REQUIRED_MARKERS.length) stats[cls].completos++;

    const missing = REQUIRED_MARKERS.filter((mk) => !mk.re.test(text)).map((mk) => mk.key);
    if (missing.length && chars) windows.push({ docId: p.docId, missing, window: windowAroundRow(text) });

    rows.push({ cls, docId: p.docId, type: p.type, kind, chars, kb: Math.round(c.bytes / 1024),
                req, ticker: hits.includes('ticker'), enc: c.encrypted, xfa: c.xfa, libFailed,
                streams: c.diag.streams, inflated: c.diag.inflated, failed: c.diag.failed });
    // TODOS los textos, no solo el primero: sin esto no se pueden comparar los
    // filings que pasan contra los que fallan (que es como se arreglo `tipo`).
    if (text) save(`text-${cls}-${p.docId}.txt`, String(text).slice(0, 40000));
  }

  console.log('    clase    DocID       tipo  clase-pdf      chars  KB  req tkr cif  streams(inf/fall)');
  for (const r of rows) {
    console.log(`    ${r.cls.padEnd(8)} ${String(r.docId).padEnd(11)} ${String(r.type).padEnd(5)} ${String(r.kind).padEnd(14)} ${String(r.chars ?? '-').padStart(6)} ${String(r.kb ?? '-').padStart(3)} ${String(r.req ?? '-')}/${REQUIRED_MARKERS.length} ${r.ticker ? ' si' : ' no'} ${r.enc ? 'SI ' : 'no '} ${r.streams ?? '-'}(${r.inflated ?? '-'}/${r.failed ?? '-'})`);
  }

  for (const cls of ['e-filed', 'papel']) {
    const s = stats[cls];
    if (!s.n) continue;
    console.log(`\n    ── ${cls.toUpperCase()} (n=${s.n}) ──`);
    console.log(`       [1] con capa de texto:   ${s.texto}/${s.n} (${pct(s.texto, s.n)})  ← ESTE decide la compuerta`);
    console.log(`       [2] con campos completos: ${s.completos}/${s.n} (${pct(s.completos, s.n)})  ← calidad del parser, no de la fuente`);
    console.log(`       escaneados: ${s.escaneado} · indeterminados: ${s.indeterminado} · errores HTTP: ${s.error} · cifrados (/Encrypt): ${s.cifrados}`);
  }
  console.log(`\n    marcadores agregados: ${PTR_MARKERS.map((mk) => `${mk.key}=${markerHits[mk.key] || 0}`).join(' · ')}`);

  if (windows.length) {
    console.log(`\n    ── filings a los que les falta algun campo requerido (${windows.length}) ──`);
    console.log('       ventana de +-120 chars alrededor de la primera fecha, para ver la fila REAL:');
    for (const w of windows.slice(0, 5)) {
      console.log(`       ${w.docId} falta[${w.missing.join(',')}]: ...${w.window}...`);
    }
    if (windows.length > 5) console.log(`       (+${windows.length - 5} mas en house-sample.json)`);
  }

  const diagTotal = rows.reduce((a, r) => ({ s: a.s + (r.streams || 0), i: a.i + (r.inflated || 0), f: a.f + (r.failed || 0) }), { s: 0, i: 0, f: 0 });
  console.log(`    diagnostico de streams (heuristica): ${diagTotal.s} encontrados · ${diagTotal.i} inflados · ${diagTotal.f} fallidos`);
  if (diagTotal.s && diagTotal.i === 0) {
    console.log('    ⚠ CERO streams inflados: el problema es el extractor, no los PDFs.');
    console.log('      Si la columna "cif" dice SI, los PDFs estan cifrados (password vacio) y');
    console.log('      solo una libreria real los abre → instala pdfjs-dist y vuelve a correr.');
  }

  save('house-sample.json', JSON.stringify({ year: YEAR, extractor: pdfLib.name, total: members.length,
       ptrs: ptrs.length, byClass: { efiled: byClass['e-filed'].length, papel: byClass.papel.length },
       stats, markerHits, rows, windows }, null, 2));

  // El veredicto de G1 se juega SOLO en los e-filed: los de papel se sabe que
  // necesitan OCR y estan fuera del MVP por diseño.
  // La COMPUERTA pregunta por la FUENTE: ¿los PTR e-filed traen capa de texto?
  // El % de campos completos mide MI PARSER, no la Camara — es informativo y
  // se arregla con un regex, no con OCR ni con otra fuente. Confundirlos fue
  // el error de la corrida 2 (G1 "ROJO" con 100% de los PDFs legibles).
  const e = stats['e-filed'];
  const rText = e.n ? e.texto / e.n : 0;
  const gate = !pdfLib.name && e.texto === 0 ? 'INDETERMINADO' : rText >= 0.9 ? 'VERDE' : 'ROJO';
  console.log(`\n  → G1 ${gate}: ${pct(e.texto, e.n)} de los e-filed trae capa de texto (umbral 90%).`);
  console.log(`    Campos completos: ${pct(e.completos, e.n)} — calidad del parser, NO decide la compuerta.`);
  if (gate === 'INDETERMINADO') console.log('    Sin libreria de PDF y con cero texto extraido, esto NO es un veredicto.');
  return { gate, reason: `e-filed ${pct(e.texto, e.n)} con texto · ${pct(e.completos, e.n)} campos completos`,
           extractor: pdfLib.name, stats };
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

const jarHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// Redirects a mano, porque `redirect: 'follow'` PIERDE cookies.
//
// Verificado contra un servidor local que imita a Django (corrida 4): con
// `redirect: 'follow'`, el `Set-Cookie` que viaja en el 302 es INVISIBLE
// —`res.headers.getSetCookie()` sobre la respuesta final devuelve []— y undici
// no tiene jar propio, asi que tampoco reenvia esa cookie en el salto
// siguiente. En el flujo del Senado el 302 del agreement es justamente donde
// nace `sessionid` ({"search_agreement":true}) y donde Django ROTA el
// `csrftoken`. Siguiendo el redirect a mano capturamos ambos en cada salto.
async function fetchJar(url, opts = {}, jar = {}, maxHops = 5) {
  const t0 = Date.now();
  let current = url;
  let hops = 0;
  let init = { ...opts };
  try {
    for (;;) {
      const cookie = jarHeader(jar);
      const res = await fetch(current, {
        ...init,
        redirect: 'manual',
        headers: { 'User-Agent': UA, ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
      });
      cookiesFrom(res, jar); // capturar ANTES de saltar
      const loc = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc || hops >= maxHops) {
        const ab = await res.arrayBuffer();
        return { ok: res.ok, status: res.status, buf: Buffer.from(ab), res,
                 url: current, hops, ms: Date.now() - t0 };
      }
      await res.arrayBuffer();
      current = new URL(loc, current).toString();
      hops++;
      // 301/302/303 tras un POST se siguen como GET sin cuerpo (igual que el navegador).
      if (init.method && init.method !== 'GET' && res.status !== 307 && res.status !== 308) {
        const { body, method, ...rest } = init;
        init = { ...rest, method: 'GET' };
      }
    }
  } catch (e) {
    return { ok: false, status: 0, buf: Buffer.alloc(0), note: String(e.message || e),
             url: current, hops, ms: Date.now() - t0 };
  }
}

// Huella del cuerpo de error: distingue bot-mitigation de un 500 de la app.
function fingerprint(body) {
  const title = (body.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim();
  const ref = (body.match(/Reference\s*#\s*([\w.]+)/i) || [, ''])[1];
  const waf = /akamai|reference\s*#|access\s*denied/i.test(body);
  const maintenance = /under\s*maintenance|mantenimiento|temporarily\s*unavailable/i.test(title + ' ' + body);
  const tag = maintenance ? '· VENTANA DE MANTENIMIENTO (no es bloqueo)'
    : waf ? '· huella de bot-mitigation' : '· sin huella de WAF';
  return { title, ref, waf, maintenance,
           text: `title="${title || '-'}"${ref ? ` ref=${ref}` : ''} ${tag}` };
}

// Un 403 del proxy de egress no dice nada sobre la fuente. Sin esto, una
// corrida desde un contenedor con allowlist declara ROJO una compuerta que
// nunca se midio.
function bloqueoDeProxy(r) {
  const deny = r && r.res && r.res.headers.get('x-deny-reason');
  const body = r && r.buf ? r.buf.toString('utf8').slice(0, 300) : '';
  if (deny || /Host not in allowlist/i.test(body)) {
    return `bloqueado por el proxy de egress (${deny || 'host_not_allowed'}) — NO se midio la fuente`;
  }
  return null;
}

async function probeSenate() {
  console.log('\n═══ G2 — SENADO (efdsearch.senate.gov) ═══');
  // UA real de Chrome. El anterior ("Chrome/126.0") no existe: Chrome siempre
  // manda cuatro componentes (126.0.0.0). Un UA que ningun Chrome emite es
  // justo lo que una regla de bot-mitigation marca.
  const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const CH = {
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const jar = {};
  const base = 'https://efdsearch.senate.gov';
  const PACE_MS = 2000; // pacing entre pasos (pedido tras la corrida v1)

  console.log('  [1/4] GET /search/home/ (agreement + CSRF)');
  const home = await fetchJar(`${base}/search/home/`, { headers: { 'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...CH,
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1' } }, jar);
  if (!home.ok) {
    const proxyMsg = bloqueoDeProxy(home);
    console.log(`  ✗ HTTP ${home.status}${home.note ? ` — ${home.note}` : ''} (${home.ms}ms)`);
    if (proxyMsg) {
      console.log(`  → G2 INCONCLUSO: ${proxyMsg}.`);
      console.log('    Correr desde una maquina con salida directa, no desde el contenedor.');
      return { gate: 'INCONCLUSO', reason: proxyMsg };
    }
    return { gate: 'ROJO', reason: `home HTTP ${home.status}` };
  }
  const html = home.buf.toString('utf8');
  save('senate-home.html', html);
  const csrf = (html.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)/) || [])[1] || jar.csrftoken;
  console.log(`  ✓ HTTP 200 (${home.ms}ms) · csrf ${csrf ? 'encontrado' : 'AUSENTE'} · cookies: ${Object.keys(jar).join(', ') || 'ninguna'}`);
  if (!csrf) return { gate: 'ROJO', reason: 'sin csrfmiddlewaretoken' };

  await sleep(PACE_MS);
  console.log('  [2/4] POST /search/home/ (prohibition_agreement=1)');
  const agree = await fetchJar(`${base}/search/home/`, {
    method: 'POST',
    headers: { 'User-Agent': BROWSER_UA, Referer: `${base}/search/home/`, Origin: base, ...CH,
               Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
               'Content-Type': 'application/x-www-form-urlencoded',
               'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ prohibition_agreement: '1', csrfmiddlewaretoken: csrf }).toString(),
  }, jar);
  if (!agree.ok) {
    console.log(`  ✗ HTTP ${agree.status} — el agreement no paso.`);
    return { gate: 'ROJO', reason: `agreement HTTP ${agree.status}` };
  }
  console.log(`  ✓ HTTP ${agree.status} (${agree.ms}ms) · ${agree.hops} redirect(s) → ${agree.url}`);
  console.log(`    cookies tras el agreement: ${Object.keys(jar).join(', ') || 'ninguna'}`);

  // El agreement solo cuenta si dejo la sesion firmada. Sin `sessionid` el
  // POST de datos sale como visitante que nunca acepto: eso NO es un veredicto
  // sobre la puerta, es un flujo incompleto, y hay que decirlo.
  const tieneSesion = Boolean(jar.sessionid);
  if (!tieneSesion) {
    console.log('    ⚠ No hay cookie `sessionid`: el agreement no dejo sesion firmada.');
  } else {
    const payload = String(jar.sessionid).split(':')[0];
    let decoded = '';
    try { decoded = Buffer.from(payload, 'base64').toString('utf8'); } catch { /* opaca */ }
    console.log(`    sessionid presente${/search_agreement/.test(decoded) ? ' · search_agreement=true ✓' : ''}`);
  }

  await sleep(PACE_MS);
  console.log('  [3/4] GET /search/ (la pagina que hace el POST — de aqui sale el Referer real)');
  const searchPage = await fetchJar(`${base}/search/`, { headers: { 'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...CH,
    Referer: `${base}/search/home/`,
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' } }, jar);
  const searchHtml = searchPage.buf.toString('utf8');
  save('senate-search.html', searchHtml.slice(0, 40000));
  console.log(`  ${searchPage.ok ? '✓' : '✗'} HTTP ${searchPage.status} (${searchPage.ms}ms) · ${searchPage.hops} redirect(s) → ${searchPage.url}`);
  if (searchPage.hops > 0 && /\/search\/home/.test(searchPage.url)) {
    console.log('    ⚠ Nos devolvio a /search/home/: la sesion NO trae el agreement aceptado.');
  }
  const csrf2 = jar.csrftoken
    || (searchHtml.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)/) || [])[1]
    || csrf;
  if (csrf2 !== csrf) console.log('    (Django roto el csrftoken en el agreement — usando el nuevo.)');

  // Headers identicos a los del XHR de DataTables en Chrome, con el Referer
  // que manda de verdad el navegador: /search/, no /search/home/.
  const headers = () => ({
    'User-Agent': BROWSER_UA, Referer: `${base}/search/`, Origin: base, ...CH,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-CSRFToken': csrf2, 'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
  });

  // Payload calcado del "Copy as cURL" del navegador (corrida 4). Lo anterior
  // omitia 17 claves que DataTables SIEMPRE manda (columns[i][name] y el
  // search[value]/search[regex] por columna, mas el segundo criterio de orden)
  // y mandaba `submitted_start_date` vacio, que el navegador nunca manda vacio.
  const navegador = {
    draw: '1', start: '0', length: '25',
    'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '1', 'order[0][dir]': 'asc',
    'order[1][column]': '0', 'order[1][dir]': 'asc',
    report_types: '[11]', filer_types: '[]',
    submitted_start_date: '01/01/2012 00:00:00', submitted_end_date: '',
    candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: '',
  };
  for (let i = 0; i < 5; i++) {
    navegador[`columns[${i}][data]`] = String(i);
    navegador[`columns[${i}][name]`] = '';
    navegador[`columns[${i}][searchable]`] = 'true';
    navegador[`columns[${i}][orderable]`] = 'true';
    navegador[`columns[${i}][search][value]`] = '';
    navegador[`columns[${i}][search][regex]`] = 'false';
  }
  // El shape viejo, para saber si la diferencia estaba en el payload o no.
  const viejo = {
    start: '0', length: '25', report_types: '[11]', filer_types: '[]',
    submitted_start_date: '', submitted_end_date: '', candidate_state: '',
    senator_state: '', office_id: '', first_name: '', last_name: '',
    csrfmiddlewaretoken: csrf2,
  };

  let lastFp = null, lastStatus = 0;
  for (const [label, payload] of [['navegador', navegador], ['viejo', viejo]]) {
    await sleep(PACE_MS);
    console.log(`  [4/4] POST /search/report/data/ — intento "${label}"`);
    const data = await fetchJar(`${base}/search/report/data/`, {
      method: 'POST', headers: headers(), body: new URLSearchParams(payload).toString(),
    }, jar);
    const body = data.buf.toString('utf8');
    save(`senate-report-data-${label}.txt`, body.slice(0, 40000));
    if (data.ok) {
      let json = null;
      try { json = JSON.parse(body); } catch { /* no era JSON */ }
      if (json && Array.isArray(json.data)) {
        console.log(`  ✓ HTTP 200 (${data.ms}ms) · ${json.data.length} filas · total: ${json.recordsTotal ?? '?'}`);
        if (json.data[0]) console.log(`    ejemplo: ${JSON.stringify(json.data[0]).slice(0, 200)}`);
        return { gate: 'VERDE', reason: `${json.data.length} filas (intento ${label})`, total: json.recordsTotal };
      }
      const fp = fingerprint(body);
      console.log(`  ✗ HTTP 200 pero no es JSON — ${fp.text}`);
      lastFp = fp;
    } else {
      const fp = fingerprint(body);
      console.log(`  ✗ HTTP ${data.status} (${data.ms}ms) — ${fp.text}`);
      lastFp = fp; lastStatus = data.status;
    }
  }

  // Un flujo sin `sessionid` no puede cerrar la compuerta: el fallo se explica
  // solo con que nunca aceptamos el agreement.
  if (!tieneSesion) {
    console.log('\n  → G2 INCONCLUSO: el POST salio SIN cookie de sesion (agreement no aceptado).');
    console.log('    El fallo se explica por el flujo, no por la puerta. No cierra nada.');
    return { gate: 'INCONCLUSO', reason: `sin sessionid tras el agreement (HTTP ${lastStatus || 200})` };
  }

  // "Site Under Maintenance" ya NO es coartada por si solo: en la corrida 4
  // (jueves 15:28 ET, horario habil de DC) el navegador cargo el sitio y la
  // busqueda de PTRs funciono desde la MISMA IP, en el mismo momento en que el
  // probe recibia el 503. Un mantenimiento real habria roto tambien a Chrome.
  // O sea: esa pagina es la respuesta de senate.gov a ESTE request, no el sitio
  // apagado. Sirve para contrastar contra la escalera.
  if (lastFp && lastFp.maintenance) {
    console.log('\n  → G2 INCONCLUSO: "Site Under Maintenance" en el ultimo paso.');
    console.log('    OJO: en la corrida 4 el navegador funcionaba desde la misma IP a la misma');
    console.log('    hora. Si vuelve a pasar, NO es ventana de mantenimiento: es la respuesta a');
    console.log('    este request. Aislar con:  node scripts/congreso-senate-ladder.mjs');
    return { gate: 'INCONCLUSO', reason: `"${lastFp.title}" (HTTP ${lastStatus}) con navegador OK en paralelo` };
  }

  console.log('\n  → G2 ROJO: los dos shapes de request fallan igual desde esta IP.');
  console.log('    Mismo error con el payload del navegador y con el viejo ⇒ no es el shape,');
  console.log('    es la puerta. El Senado queda FUERA del MVP y se declara en la UI.');
  return { gate: 'ROJO', reason: 'ambos intentos fallan (no es el shape del request)' };
}

// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  FASE 0 CONGRESO — sonda v2 · ano ${YEAR} · ${new Date().toISOString()}`);
  console.log('  Memo: docs/congreso-fase0.md  ·  payloads: ' + OUT_DIR);
  console.log('═══════════════════════════════════════════════════════════');

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || '';
  if (proxy) {
    console.log(`\n  ⚠ Hay un proxy de egress configurado (${proxy}). Un 403 puede venir de EL,`);
    console.log('    no de la fuente. Las compuertas solo se cierran desde una IP con salida directa.');
  }

  const house = ONLY === 'senate' ? null : await probeHouse().catch((e) => ({ gate: 'ROJO', reason: `excepcion: ${e.message}` }));
  const senate = ONLY === 'house' ? null : await probeSenate().catch((e) => ({ gate: 'ROJO', reason: `excepcion: ${e.message}` }));

  console.log('\n═══ VEREDICTO ═══');
  if (house) console.log(`  G1 CAMARA: ${house.gate} — ${house.reason}${house.extractor ? ` (extractor: ${house.extractor})` : ''}`);
  if (senate) console.log(`  G2 SENADO: ${senate.gate} — ${senate.reason}`);
  console.log('');
  if (house && house.gate === 'VERDE') {
    console.log('  La ruta recomendada del memo (House directo) queda confirmada.');
    console.log(senate && senate.gate === 'VERDE'
      ? '  El Senado tambien entra: la Fase 1 puede cubrir las dos camaras.'
      : senate && senate.gate === 'INCONCLUSO'
        ? '  El Senado sigue SIN decidir (mantenimiento). Repetir con --only=g2 en horario habil.'
        : '  El Senado queda FUERA del MVP: la UI dice "solo Camara de Representantes".');
  } else if (house && house.gate === 'INDETERMINADO') {
    console.log('  ⚠ G1 sin veredicto por falta de extractor. npm i --no-save pdfjs-dist y repetir.');
  } else if (house) {
    const ambos403 = /403/.test(house.reason || '') && /403/.test((senate && senate.reason) || '');
    if (ambos403) {
      console.log('  ⚠ LAS DOS fuentes dieron 403 en el primer request: es el entorno (proxy),');
      console.log('    no las fuentes. NO lo anotes como G1/G2 rojo.');
    } else {
      console.log('  ⚠ La ruta recomendada NO se confirma. No arranca la Fase 1 hasta resolverlo.');
    }
  }
  console.log('\n  Pega esta salida en docs/congreso-fase0.md §6.1.');
  console.log('  Recordatorio: la compuerta legal §13107(c) (§4.2) sigue ABIERTA y es previa.\n');

  save('veredicto.json', JSON.stringify({ ts: new Date().toISOString(), year: YEAR, house, senate }, null, 2));
}

main().catch((e) => { console.error('\nFALLO INESPERADO:', e); process.exit(1); });
