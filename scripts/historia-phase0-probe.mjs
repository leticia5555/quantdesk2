#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// FASE 0 — HISTORIA (EDGAR): sonda de fuentes. Cierra G1..G6.
//
// Contesta, con números y no con opiniones, las cinco preguntas que el
// encargo pidió para la Fase 0:
//
//   (a) cobertura de company-facts por concepto,
//   (b) cuántos 8-K traen item parseable DESDE EL ÍNDICE (sin full-text),
//   (c) si los SC 13D/13D-A y los proxies aparecen limpios,
//   (d) latencia (y si el límite de 10 req/s de la SEC aguanta),
//   (e) insumos para la estimación de horas (tamaños, volúmenes, rarezas).
//
// NO escribe en la DB, NO toca api/ ni el Arena, NO llama a ninguna IA.
// Es una sonda: baja documentos públicos, mide y reporta.
//
// ── POR QUÉ ESTE ARCHIVO EXISTE EN VEZ DE UNA TABLA YA LLENA ──────────
// El contenedor donde se escribió esto tiene el egress a *.sec.gov cerrado
// por política de la organización (403 del proxy en www.sec.gov,
// data.sec.gov y efts.sec.gov; ver docs/historia-fase0.md §0). Los números
// de la Fase 0 se ganan corriendo ESTO desde una máquina con salida a
// internet. Ningún número de este módulo se inventa — es la regla de
// honestidad del producto y aplica primero a su propio reconocimiento.
//
// USO:
//   node scripts/historia-phase0-probe.mjs
//   node scripts/historia-phase0-probe.mjs --tickers=LULU,MSFT,MELI
//   node scripts/historia-phase0-probe.mjs --sin-control     # sin VIST
//   node scripts/historia-phase0-probe.mjs --only=g4         # solo latencia
//   node scripts/historia-phase0-probe.mjs --anios=3
//
// Sin keys: EDGAR es público y anónimo. Pide User-Agent descriptivo y
// pone un techo de 10 req/s (https://www.sec.gov/os/webmaster-faq#developers).
// Los payloads crudos quedan en ./.historia-fase0/ para diagnóstico offline.
// ═══════════════════════════════════════════════════════════════════════

// Las funciones puras (aplanado del índice, clasificación de periodos,
// cobertura por familia, censo de items de 8-K) se EXPORTAN y viven bajo
// tests/historia-phase0-probe.test.mjs con fixtures sintéticos. Sin red no
// se pueden ganar los números de EDGAR, pero sí se puede probar que el
// medidor mide bien — que es la otra mitad de no inventar nada.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OUT_DIR = '.historia-fase0';
const UA = 'QuantDesk research@quantdesk.app';

// La SEC permite 10 req/s. Vamos a 8 (125 ms) para dejar margen: que la sonda
// se gane un 429 sería medir nuestra imprudencia, no la fuente.
const THROTTLE_MS = 125;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

// Los 3 del encargo + un control de 20-F REAL.
//
// Por qué el control: MELI se pidió como "el ADR", pero MELI está constituida
// en Delaware y reporta como emisor doméstico (10-K/10-Q), no como emisor
// privado extranjero (20-F/6-K). Si la pregunta es "¿qué pasa con la
// cobertura de un 20-F?", MELI no la contesta: es un 10-K filer con ticker
// latino. VIST (Vista Energy) sí presenta 20-F. La sonda mide qué forma usa
// cada CIK en vez de creerle a esta nota — si MELI resulta 20-F, el reporte
// lo dirá y esta nota queda desmentida por los datos.
const DEFAULT_TICKERS = ['LULU', 'MSFT', 'MELI'];
const CONTROL_20F = 'VIST';

const TICKERS = (args.tickers
  ? String(args.tickers).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : (args['sin-control'] ? DEFAULT_TICKERS : [...DEFAULT_TICKERS, CONTROL_20F]));

const ANIOS = Number(args.anios || 3);          // ventana para cobertura trimestral
const ANIOS_FORMS = Number(args['anios-forms'] || 5); // ventana para el censo de formas
const ONLY = args.only ? String(args.only).toLowerCase().split(',') : null;
const runGate = (g) => !ONLY || ONLY.includes(g);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const pad10 = (cik) => String(cik).padStart(10, '0');

function save(name, body) {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${name}`, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return `${OUT_DIR}/${name}`;
  } catch (e) {
    return `(no se pudo guardar: ${e.message})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Transporte: un solo lugar que respeta el UA obligatorio, el throttle y
// registra la latencia de TODAS las llamadas (insumo de G4).
// ─────────────────────────────────────────────────────────────────────────
const latencias = [];   // { host, kind, ms, status, bytes }
let lastCall = 0;

async function throttled() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function get(url, { kind = 'otro', raw = false, retries = 3 } = {}) {
  for (let intento = 0; intento <= retries; intento++) {
    await throttled();
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': '*/*' },
      });
    } catch (e) {
      const ms = Date.now() - t0;
      latencias.push({ host: new URL(url).host, kind, ms, status: 'ERR', bytes: 0 });
      if (intento === retries) throw new Error(`${kind}: red caída — ${e.message}`);
      await sleep(1000 * 2 ** intento);
      continue;
    }
    const body = await r.text();
    const ms = Date.now() - t0;
    latencias.push({ host: new URL(url).host, kind, ms, status: r.status, bytes: body.length });

    if (r.status === 429 || r.status === 503) {
      if (intento === retries) { const e = new Error(`${kind}: HTTP ${r.status} tras ${retries} reintentos`); e.status = r.status; throw e; }
      await sleep(1000 * 2 ** intento);
      continue;
    }
    if (!r.ok) { const e = new Error(`${kind}: HTTP ${r.status}`); e.status = r.status; throw e; }

    if (raw) return { body, bytes: body.length };
    try { return { json: JSON.parse(body), bytes: body.length }; }
    catch { throw new Error(`${kind}: respuesta no es JSON (${body.slice(0, 120)}…)`); }
  }
}

async function head(url) {
  await throttled();
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    latencias.push({ host: new URL(url).host, kind: 'head-doc', ms: Date.now() - t0, status: r.status, bytes: 0 });
    return r.status;
  } catch {
    latencias.push({ host: new URL(url).host, kind: 'head-doc', ms: Date.now() - t0, status: 'ERR', bytes: 0 });
    return 'ERR';
  }
}

function percentil(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ─────────────────────────────────────────────────────────────────────────
// Conceptos XBRL por pregunta del esqueleto. Cada familia lleva ALIAS porque
// us-gaap cambió de etiqueta con el tiempo (Revenues → SalesRevenueNet →
// RevenueFromContractWithCustomerExcludingAssessedTax con ASC 606 en 2018).
// Una serie que cruza 2018 CAMBIA de concepto a mitad de camino: por eso la
// unidad de cobertura es la FAMILIA, no el tag. Esto es medición, no opinión:
// el reporte imprime qué alias aportó cada trimestre.
// ─────────────────────────────────────────────────────────────────────────
export const FAMILIAS = [
  { id: 'ingresos',   pregunta: 3, tipo: 'duracion', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet'], ifrs: ['Revenue', 'RevenueFromContractsWithCustomers'] },
  { id: 'costo',      pregunta: 3, tipo: 'duracion', tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'], ifrs: ['CostOfSales'] },
  { id: 'margen',     pregunta: 3, tipo: 'duracion', tags: ['GrossProfit'], ifrs: ['GrossProfit'] },
  { id: 'sgya',       pregunta: 3, tipo: 'duracion', tags: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'], ifrs: ['SellingGeneralAndAdministrativeExpense'] },
  { id: 'op',         pregunta: 3, tipo: 'duracion', tags: ['OperatingIncomeLoss'], ifrs: ['ProfitLossFromOperatingActivities'] },
  { id: 'neto',       pregunta: 3, tipo: 'duracion', tags: ['NetIncomeLoss', 'ProfitLoss'], ifrs: ['ProfitLoss'] },
  { id: 'eps',        pregunta: 3, tipo: 'duracion', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], ifrs: ['DilutedEarningsLossPerShare'] },
  { id: 'inventario', pregunta: 3, tipo: 'instante', tags: ['InventoryNet', 'InventoryFinishedGoods'], ifrs: ['Inventories'] },
  // `caja` dio 0 tags en LULU en la corrida 1: no usa
  // CashAndCashEquivalentsAtCarryingValue. La hipótesis es que etiqueta bajo
  // el tag de ASU 2016-18 (efectivo + efectivo restringido), que es lo normal
  // en retail. Se agrega como alias y la PRÓXIMA corrida lo confirma o lo
  // desmiente — no se da por cierto acá.
  { id: 'caja',       pregunta: 3, tipo: 'instante', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], ifrs: ['CashAndCashEquivalents'] },
  { id: 'deuda',      pregunta: 3, tipo: 'instante', tags: ['LongTermDebtNoncurrent', 'LongTermDebt'], ifrs: ['NoncurrentPortionOfNoncurrentBorrowings'] },
  { id: 'acciones',   pregunta: 2, tipo: 'instante', tags: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'], ifrs: ['NumberOfSharesOutstanding'] },
];

// Formas que el esqueleto de 7 preguntas necesita del índice de filings.
const FORMAS_INTERES = {
  1: ['8-K', 'DEF 14A'],                                        // quién dirige
  2: ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', 'PREC14A', 'DEFC14A', 'PRRN14A', 'DEFN14A', 'DFAN14A', '4'], // quién posee / quién pelea
  3: ['8-K', '10-Q', '10-K', '20-F', '6-K'],                    // prometido vs entregado
  7: ['8-K'],                                                   // catalizador
};
const FORMAS_PLANAS = [...new Set(Object.values(FORMAS_INTERES).flat())];

// Ítems de 8-K que el esqueleto usa por nombre.
const ITEMS_CLAVE = {
  '1.01': 'contrato material (pregunta 7)',
  '2.02': 'resultados / guía (pregunta 3)',
  '5.02': 'salida o llegada de directivos (pregunta 1)',
  '5.07': 'votos de la junta (pregunta 2)',
  '7.01': 'Reg FD — guía fuera de resultados (pregunta 3)',
  '8.01': 'otro evento material (pregunta 7)',
};

// ═════════════════════════════════════════════════════════════════════════
// Descarga por ticker
// ═════════════════════════════════════════════════════════════════════════

let _tickerMap = null;
async function tickerMap() {
  if (_tickerMap) return _tickerMap;
  const { json, bytes } = await get('https://www.sec.gov/files/company_tickers.json', { kind: 'ticker-map' });
  const map = {};
  Object.values(json || {}).forEach((row) => {
    if (row && row.ticker) map[String(row.ticker).toUpperCase()] = { cik: String(row.cik_str), title: row.title || '' };
  });
  _tickerMap = map;
  console.log(`  · company_tickers.json: ${Object.keys(map).length} tickers, ${mb(bytes)}`);
  return map;
}

// submissions.recent trae ~1.000 filings; el resto vive en filings.files[].
// Para LULU (IPO 2007) eso importa: sin paginar, la "historia completa" se
// corta donde EDGAR decidió cortar la página, no donde la empresa empezó.
async function submissions(cik) {
  const { json, bytes } = await get(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`, { kind: 'submissions' });
  const paginas = [json.filings?.recent].filter(Boolean);
  let bytesTotal = bytes;
  for (const f of (json.filings?.files || [])) {
    const p = await get(`https://data.sec.gov/submissions/${f.name}`, { kind: 'submissions-old' });
    paginas.push(p.json);
    bytesTotal += p.bytes;
  }
  return { meta: json, filings: aplanarSubmissions(paginas), paginas: paginas.length, bytes: bytesTotal };
}

// submissions guarda columnas PARALELAS (accessionNumber[], form[], items[]…),
// no objetos. Si una columna opcional falta —`items` no existe en las páginas
// viejas— el aplanado tiene que rendir '' y no `undefined`: el censo de G2
// cuenta strings vacíos y un undefined lo rompería en silencio.
export function aplanarSubmissions(paginas) {
  const filings = [];
  for (const p of paginas) {
    const n = (p.accessionNumber || []).length;
    for (let i = 0; i < n; i++) {
      filings.push({
        accession: p.accessionNumber[i],
        form: (p.form?.[i] || '').toUpperCase(),
        filed: p.filingDate?.[i] || null,
        reportDate: p.reportDate?.[i] || null,
        items: p.items?.[i] || '',
        primaryDocument: p.primaryDocument?.[i] || '',
        isXBRL: p.isXBRL?.[i] || 0,
        size: p.size?.[i] || 0,
      });
    }
  }
  // Reverse-cron: EDGAR ya las devuelve así por página, pero al concatenar
  // páginas viejas el orden se rompe y las ventanas de N años saldrían mal.
  filings.sort((a, b) => (a.filed < b.filed ? 1 : -1));
  return filings;
}

// G2 — el censo de items de 8-K, hecho SOLO con la columna `items` del
// índice. Si esto sale verde, el full-text search no hace falta para
// clasificar (sí para leer el contenido, que es otra cosa).
export function analizarItems8K(filings) {
  const ochoK = filings.filter((f) => f.form === '8-K' || f.form === '8-K/A');
  const conItems = ochoK.filter((f) => f.items && f.items.trim());
  // Un item canónico es "N.NN". Cualquier otra cosa (texto libre, item sin
  // punto, basura) cuenta como mal formado: el parser de la Fase A no puede
  // asumir un formato que el índice no garantiza.
  const malFormados = conItems.filter((f) => !f.items.split(',').every((i) => /^\d{1,2}\.\d{2}$/.test(i.trim())));
  const histo = {};
  for (const f of conItems) for (const i of f.items.split(',')) { const k = i.trim(); histo[k] = (histo[k] || 0) + 1; }
  return {
    ochoK: ochoK.length,
    conItems: conItems.length,
    cobertura: pct(conItems.length, ochoK.length),
    malFormados: malFormados.length,
    ejemplosMalFormados: malFormados.slice(0, 5).map((f) => ({ accession: f.accession, items: f.items })),
    claves: Object.fromEntries(Object.keys(ITEMS_CLAVE).map((k) => [k, histo[k] || 0])),
    top: Object.entries(histo).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

async function companyFacts(cik) {
  const { json, bytes } = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`, { kind: 'companyfacts' });
  return { facts: json, bytes };
}

// ═════════════════════════════════════════════════════════════════════════
// G1 — company-facts: ¿existe la "película" trimestral, y es citable?
// ═════════════════════════════════════════════════════════════════════════

export const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const clasePeriodo = (d) => (d >= 60 && d <= 115 ? 'Q' : d >= 150 && d <= 200 ? 'H1' : d >= 240 && d <= 300 ? '9M' : d >= 330 && d <= 400 ? 'FY' : 'otro');

// Aplana units.{USD,shares,USD/shares,pure} → arreglo de hechos normalizados.
export function hechosDe(nodo) {
  const out = [];
  for (const [unidad, filas] of Object.entries(nodo?.units || {})) {
    for (const f of filas) {
      out.push({
        unidad,
        start: f.start || null,
        end: f.end,
        val: f.val,
        fy: f.fy, fp: f.fp, form: f.form,
        filed: f.filed,
        accn: f.accn || null,
        frame: f.frame || null,
      });
    }
  }
  return out;
}

export function analizarFamilia(facts, fam, desdeISO) {
  const usg = facts.facts?.['us-gaap'] || {};
  const ifrs = facts.facts?.['ifrs-full'] || {};
  const dei = facts.facts?.dei || {};

  const candidatos = [];
  for (const t of fam.tags) if (usg[t]) candidatos.push({ tag: `us-gaap:${t}`, nodo: usg[t] });
  for (const t of fam.tags) if (dei[t]) candidatos.push({ tag: `dei:${t}`, nodo: dei[t] });
  for (const t of (fam.ifrs || [])) if (ifrs[t]) candidatos.push({ tag: `ifrs-full:${t}`, nodo: ifrs[t] });

  if (!candidatos.length) {
    return { id: fam.id, presente: false, tags: [], trimestres: 0, derivables: 0, efectivos: 0, sinAccn: 0, revisiones: 0, desacuerdoAlias: 0 };
  }

  // Unir TODOS los alias: la serie real cruza el cambio de taxonomía.
  const todos = [];
  for (const c of candidatos) for (const h of hechosDe(c.nodo)) todos.push({ ...h, tag: c.tag });

  const enVentana = todos.filter((h) => h.end >= desdeISO);

  // Citabilidad: sin accn no hay [accession] y la afirmación no se puede citar.
  const sinAccn = enVentana.filter((h) => !h.accn).length;

  // Revisiones vs desacuerdo entre alias — DOS fenómenos distintos que la
  // corrida 1 mezcló en un solo número.
  //
  // BUG de la corrida 1 (2026-09-12): la clave era `start|end|unidad`, SIN el
  // tag. Como una familia une varios alias, dos tags que cubren el mismo
  // periodo se contaban como si la empresa se hubiera corregido. La huella
  // era inconfundible: TODA familia con revisiones == trimestres tenía
  // tags=2 (LULU inventario 12/12, MSFT deuda 12/12), y toda familia con
  // tags=1 daba un conteo chico y plausible (MELI costo 3, margen 4, op 3).
  // MELI ingresos "19 revisiones" era, en su mayor parte, ese artefacto.
  //
  //   revisiones  = el MISMO tag reporta el mismo periodo con otro valor.
  //                 Eso sí es la empresa re-expresando, y es la materia prima
  //                 de "qué prometieron vs qué entregaron".
  //   desacuerdoAlias = dos tags DISTINTOS de la familia dan valores distintos
  //                 para el mismo periodo. No es una corrección: es el corte
  //                 de taxonomía (ASC 606) o dos medidas que no son la misma
  //                 cosa. La vista tiene que elegir uno, no promediarlos.
  const porTagPeriodo = new Map();   // tag|start|end|unidad -> Set(val)
  const porPeriodo = new Map();      // start|end|unidad     -> Map(tag -> Set(val))
  for (const h of enVentana) {
    const kPeriodo = `${h.start || ''}|${h.end}|${h.unidad}`;
    const kTag = `${h.tag}|${kPeriodo}`;
    if (!porTagPeriodo.has(kTag)) porTagPeriodo.set(kTag, new Set());
    porTagPeriodo.get(kTag).add(String(h.val));
    if (!porPeriodo.has(kPeriodo)) porPeriodo.set(kPeriodo, new Map());
    const porTag = porPeriodo.get(kPeriodo);
    if (!porTag.has(h.tag)) porTag.set(h.tag, new Set());
    porTag.get(h.tag).add(String(h.val));
  }
  const revisiones = [...porTagPeriodo.values()].filter((s) => s.size > 1).length;
  const desacuerdoAlias = [...porPeriodo.values()].filter((porTag) => {
    if (porTag.size < 2) return false;
    const valores = new Set();
    for (const s of porTag.values()) for (const v of s) valores.add(v);
    return valores.size > 1;
  }).length;

  if (fam.tipo === 'instante') {
    const cortes = new Set(enVentana.filter((h) => !h.start).map((h) => h.end));
    return {
      id: fam.id, presente: true, tipo: 'instante',
      tags: [...new Set(enVentana.map((h) => h.tag))],
      trimestres: cortes.size, derivables: 0, efectivos: cortes.size,
      primero: [...cortes].sort()[0] || null, ultimo: [...cortes].sort().pop() || null,
      sinAccn, revisiones, desacuerdoAlias, hechos: enVentana.length,
    };
  }

  // Duración: clasificar por largo del periodo.
  const porClase = { Q: new Set(), H1: new Set(), '9M': new Set(), FY: new Set(), otro: new Set() };
  for (const h of enVentana) {
    if (!h.start) continue;
    porClase[clasePeriodo(dias(h.start, h.end))].add(h.end);
  }

  // Q4 casi nunca se reporta directo: el 10-K trae el año y el último 10-Q
  // trae los 9 meses. Q4 = FY − 9M. Contar cuántos Q4 son DERIVABLES es la
  // diferencia entre "tenemos la película" y "tenemos la película con un
  // fotograma negro cada cuatro".
  const fines9M = [...porClase['9M']];
  const finesFY = [...porClase.FY];
  let derivables = 0;
  for (const fy of finesFY) {
    // El 9M del mismo año fiscal cierra ~3 meses antes del cierre anual.
    const hay = fines9M.some((n) => { const d = dias(n, fy); return d >= 60 && d <= 115; });
    if (hay) derivables++;
  }

  return {
    id: fam.id, presente: true, tipo: 'duracion',
    tags: [...new Set(enVentana.map((h) => h.tag))],
    trimestres: porClase.Q.size,
    anuales: porClase.FY.size,
    nueveMeses: porClase['9M'].size,
    semestres: porClase.H1.size,
    derivables,
    efectivos: porClase.Q.size + derivables,
    primero: [...porClase.Q].sort()[0] || null,
    ultimo: [...porClase.Q].sort().pop() || null,
    sinAccn, revisiones, desacuerdoAlias, hechos: enVentana.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Sonda por ticker
// ═════════════════════════════════════════════════════════════════════════

async function sondearTicker(ticker, map) {
  const hit = map[ticker];
  if (!hit) return { ticker, error: 'no está en company_tickers.json (¿no cotiza en EE.UU.?)' };

  const cik = hit.cik;
  const r = { ticker, cik: pad10(cik), nombre: hit.title };
  console.log(`\n━━━ ${ticker} · CIK ${pad10(cik)} · ${hit.title}`);

  // ── Índice de filings ──────────────────────────────────────────────
  const sub = await submissions(cik);
  r.nombre = sub.meta.name || hit.title;
  r.sic = `${sub.meta.sic || '?'} ${sub.meta.sicDescription || ''}`.trim();
  r.fiscalYearEnd = sub.meta.fiscalYearEnd || null;
  r.paginasIndice = sub.paginas;
  r.bytesIndice = sub.bytes;
  r.filingsTotal = sub.filings.length;
  r.primerFiling = sub.filings[sub.filings.length - 1]?.filed || null;
  save(`${ticker}-submissions.json`, sub.filings);
  console.log(`  · índice: ${sub.filings.length} filings en ${sub.paginas} página(s), ${mb(sub.bytes)}, desde ${r.primerFiling}`);

  const corteForms = new Date(Date.now() - ANIOS_FORMS * 365.25 * 86400000).toISOString().slice(0, 10);
  const recientes = sub.filings.filter((f) => f.filed >= corteForms);

  // ── G2 — ¿el índice ya trae el item del 8-K? ───────────────────────
  r.g2 = analizarItems8K(recientes);
  console.log(`  · 8-K (${ANIOS_FORMS}a): ${r.g2.ochoK} · con item en el índice: ${r.g2.conItems} (${r.g2.cobertura}) · mal formados: ${r.g2.malFormados}`);
  console.log(`    items clave → ${Object.entries(r.g2.claves).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  // ── G3 — ¿aparecen 13D y proxies, y su URL resuelve? ───────────────
  const censo = {};
  for (const f of recientes) censo[f.form] = (censo[f.form] || 0) + 1;
  r.g3 = { censo: Object.fromEntries(FORMAS_PLANAS.map((f) => [f, censo[f] || 0])), urls: [] };

  // Muestra: un filing de cada forma de interés que exista → HEAD al doc.
  const muestra = [];
  for (const forma of FORMAS_PLANAS) {
    const f = recientes.find((x) => x.form === forma && x.primaryDocument);
    if (f) muestra.push(f);
  }
  for (const f of muestra.slice(0, 12)) {
    const url = docUrl(cik, f);
    const status = await head(url);
    r.g3.urls.push({ form: f.form, accession: f.accession, filed: f.filed, status, url });
  }
  const urlsOk = r.g3.urls.filter((u) => u.status === 200).length;
  console.log(`  · formas (${ANIOS_FORMS}a): ${Object.entries(r.g3.censo).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join('  ') || '(ninguna)'}`);
  console.log(`  · URLs de documento primario resueltas: ${urlsOk}/${r.g3.urls.length}`);

  // ── G6 — ¿doméstico o emisor privado extranjero? ───────────────────
  const anual = sub.filings.find((f) => ['10-K', '20-F', '40-F'].includes(f.form));
  r.g6 = {
    formaAnual: anual?.form || null,
    tiene10Q: sub.filings.some((f) => f.form === '10-Q'),
    tiene6K: sub.filings.some((f) => f.form === '6-K'),
    tiene20F: sub.filings.some((f) => f.form === '20-F'),
    entityType: sub.meta.entityType || null,
  };
  console.log(`  · perfil: anual=${r.g6.formaAnual} · 10-Q=${r.g6.tiene10Q} · 6-K=${r.g6.tiene6K} · 20-F=${r.g6.tiene20F}`);

  // ── G1 — company-facts ─────────────────────────────────────────────
  let cf = null;
  try {
    cf = await companyFacts(cik);
  } catch (e) {
    r.g1 = { error: e.message };
    console.log(`  · company-facts: ERROR — ${e.message}`);
  }

  if (cf) {
    const desde = new Date(Date.now() - ANIOS * 365.25 * 86400000).toISOString().slice(0, 10);
    const taxonomias = Object.keys(cf.facts.facts || {});
    const nConceptos = taxonomias.reduce((a, t) => a + Object.keys(cf.facts.facts[t]).length, 0);
    const familias = FAMILIAS.map((f) => analizarFamilia(cf.facts, f, desde));

    // G5(a) — ¿hay ALGÚN concepto que huela a guía? (spoiler medible)
    const guia = [];
    for (const t of taxonomias) {
      for (const c of Object.keys(cf.facts.facts[t])) {
        if (/guidance|forecast|outlook|projected|guided/i.test(c)) guia.push(`${t}:${c}`);
      }
    }

    r.g1 = {
      bytes: cf.bytes,
      taxonomias,
      conceptos: nConceptos,
      ventanaDesde: desde,
      familias,
      sinAccnTotal: familias.reduce((a, f) => a + (f.sinAccn || 0), 0),
      revisionesTotal: familias.reduce((a, f) => a + (f.revisiones || 0), 0),
    };
    r.g5a = { conceptosDeGuia: guia };

    save(`${ticker}-familias.json`, familias);
    console.log(`  · company-facts: ${mb(cf.bytes)} · taxonomías [${taxonomias.join(', ')}] · ${nConceptos} conceptos`);
    console.log(`    familia           tags   Q    FY   9M   Q4-deriv  efectivos  revis.  desac.  sin-accn`);
    for (const f of familias) {
      if (!f.presente) { console.log(`    ${f.id.padEnd(17)} —      AUSENTE`); continue; }
      console.log(`    ${f.id.padEnd(17)}${String(f.tags.length).padEnd(7)}${String(f.trimestres).padEnd(5)}${String(f.anuales ?? '-').padEnd(5)}${String(f.nueveMeses ?? '-').padEnd(5)}${String(f.derivables).padEnd(10)}${String(f.efectivos).padEnd(11)}${String(f.revisiones).padEnd(8)}${String(f.desacuerdoAlias).padEnd(8)}${f.sinAccn}`);
    }
    console.log(`    conceptos de guía en XBRL: ${guia.length ? guia.join(', ') : '0  ← la guía NO está etiquetada'}`);
  }

  // ── G5(b) — ¿dónde vive la guía entonces? En el EX-99.1 del 8-K 2.02 ──
  const conResultados = recientes.filter((f) => f.form === '8-K' && /(^|,)\s*2\.02\s*(,|$)/.test(f.items)).slice(0, 5);
  r.g5b = { revisados: 0, conEx99: 0, detalle: [] };
  for (const f of conResultados) {
    try {
      const { json } = await get(idxUrl(cik, f), { kind: 'filing-index' });
      const items = json.directory?.item || [];
      const ex99 = items.filter((i) => /^ex-?99/i.test(i.name) || /ex99/i.test(i.name));
      r.g5b.revisados++;
      if (ex99.length) r.g5b.conEx99++;
      r.g5b.detalle.push({
        accession: f.accession, filed: f.filed,
        docs: items.length,
        ex99: ex99.map((i) => `${i.name} (${i.size}B)`),
      });
    } catch (e) {
      r.g5b.detalle.push({ accession: f.accession, error: e.message });
    }
  }
  console.log(`  · 8-K item 2.02 revisados: ${r.g5b.revisados} · con exhibit EX-99: ${r.g5b.conEx99}`);

  // ── Full-text search: ¿hace falta, sabiendo que el índice ya trae items? ──
  try {
    const q = `https://efts.sec.gov/LATEST/search-index?q=%22results+of+operations%22&forms=8-K&ciks=${pad10(cik)}`;
    const { json } = await get(q, { kind: 'fts' });
    r.fts = { ok: true, total: json.hits?.total?.value ?? null, devueltos: (json.hits?.hits || []).length };
    console.log(`  · full-text search: OK · ${r.fts.total} hits`);
  } catch (e) {
    r.fts = { ok: false, error: e.message };
    console.log(`  · full-text search: ${e.message}`);
  }

  save(`${ticker}-reporte.json`, r);
  return r;
}

const cikInt = (cik) => parseInt(cik, 10);
const noDash = (acc) => String(acc).replace(/-/g, '');
const docUrl = (cik, f) => `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${noDash(f.accession)}/${f.primaryDocument}`;
const idxUrl = (cik, f) => `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${noDash(f.accession)}/index.json`;

// ═════════════════════════════════════════════════════════════════════════
// G4 — límite de 10 req/s: ¿aguanta o la SEC contesta 429?
// ═════════════════════════════════════════════════════════════════════════
async function sondearRateLimit(map) {
  console.log('\n━━━ G4b — ráfaga contra el techo de 10 req/s');
  const cik = pad10(map.MSFT?.cik || '789019');
  const urls = Array.from({ length: 10 }, (_, i) =>
    `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${['Assets', 'Revenues', 'NetIncomeLoss', 'Liabilities', 'StockholdersEquity', 'CashAndCashEquivalentsAtCarryingValue', 'OperatingIncomeLoss', 'GrossProfit', 'InventoryNet', 'CommonStockSharesOutstanding'][i]}.json`);

  const t0 = Date.now();
  const res = await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      await r.text();
      return r.status;
    } catch (e) { return 'ERR'; }
  }));
  const ms = Date.now() - t0;
  const conteo = res.reduce((a, s) => { a[s] = (a[s] || 0) + 1; return a; }, {});
  console.log(`  · 10 concurrentes en ${ms} ms → ${JSON.stringify(conteo)}`);
  return { concurrentes: 10, ms, conteo, limitado: res.some((s) => s === 429) };
}

// ═════════════════════════════════════════════════════════════════════════
// Reporte
// ═════════════════════════════════════════════════════════════════════════
function reporteLatencia() {
  const porKind = {};
  for (const l of latencias) {
    (porKind[l.kind] ||= []).push(l);
  }
  const filas = Object.entries(porKind).map(([kind, ls]) => {
    const ms = ls.map((l) => l.ms);
    return {
      kind, n: ls.length,
      p50: percentil(ms, 50), p95: percentil(ms, 95), max: Math.max(...ms),
      bytesProm: Math.round(ls.reduce((a, l) => a + l.bytes, 0) / ls.length),
      noOk: ls.filter((l) => l.status !== 200).length,
    };
  });
  console.log('\n━━━ G4 — latencia por tipo de llamada');
  console.log('  endpoint          n     p50     p95     max     bytes-prom   no-200');
  for (const f of filas.sort((a, b) => b.n - a.n)) {
    console.log(`  ${f.kind.padEnd(18)}${String(f.n).padEnd(6)}${String(f.p50 + 'ms').padEnd(8)}${String(f.p95 + 'ms').padEnd(8)}${String(f.max + 'ms').padEnd(8)}${String(f.bytesProm).padEnd(13)}${f.noOk}`);
  }
  return filas;
}

function veredicto(reportes) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  COMPUERTAS — criterio fijado ANTES de la corrida');
  console.log('═══════════════════════════════════════════════════════════');

  const vivos = reportes.filter((r) => !r.error && r.g1 && !r.g1.error);

  // ── El criterio se CONDICIONA al perfil del emisor (corrida 1) ──────
  //
  // G1 y G2 miden cosas que un emisor privado extranjero NO PRESENTA: no hay
  // 10-Q del que salgan trimestres, ni 8-K del que salgan items — presenta
  // 20-F anual y 6-K sin columna `items`. Correrle a VIST el criterio de un
  // emisor doméstico no mide una falla de EDGAR: mide que le pedimos peras
  // al olmo, y pinta de rojo dos compuertas que están verdes donde aplican.
  //
  // La ausencia de trimestres en un 20-F ya la CLASIFICA G6 y se declara en
  // la UI como COBERTURA PARCIAL. Por eso G1/G2 evalúan solo a los emisores
  // domésticos, y los extranjeros se listan aparte como "no aplica" — que no
  // es lo mismo que aprobado, y por eso se imprime, no se esconde.
  const esDomestico = (r) => !!(r.g6 && !r.g6.tiene20F);
  const domesticos = vivos.filter(esDomestico);
  const extranjeros = reportes.filter((r) => r.g6 && r.g6.tiene20F);
  const noAplica = (xs) => (xs.length ? `  ·  no aplica: ${xs.map((r) => r.ticker).join(', ')} (20-F, ver G6)` : '');

  // G1: la película trimestral existe para las familias del núcleo.
  const NUCLEO = ['ingresos', 'margen', 'inventario', 'neto'];
  const esperados = ANIOS * 4;
  const g1 = domesticos.map((r) => {
    const nucleo = r.g1.familias.filter((f) => NUCLEO.includes(f.id));
    const peor = Math.min(...nucleo.map((f) => f.efectivos));
    return { ticker: r.ticker, peor, ok: peor >= esperados - 1 };
  });
  const g1Verde = g1.length > 0 && g1.every((x) => x.ok);
  console.log(`  G1 company-facts   ${g1Verde ? '🟢 VERDE' : '🔴 ROJO '}  (criterio: ≥${esperados - 1}/${esperados} trimestres efectivos en ingresos+margen+inventario+neto, SOLO emisores domésticos)${noAplica(extranjeros)}`);
  for (const x of g1) console.log(`       ${x.ticker.padEnd(6)} peor familia del núcleo: ${x.peor}/${esperados}`);
  for (const r of extranjeros) {
    const nucleo = (r.g1?.familias || []).filter((f) => NUCLEO.includes(f.id));
    const anuales = nucleo.length ? Math.min(...nucleo.map((f) => f.anuales ?? f.efectivos)) : 0;
    console.log(`       ${r.ticker.padEnd(6)} n/a — 20-F: ${anuales} periodo(s) anual(es) en el núcleo, 0 trimestres. Es el dato, no una falla.`);
  }

  // G2: el índice ya clasifica los 8-K.
  const g2 = reportes.filter((r) => r.g2 && esDomestico(r)).map((r) => ({
    ticker: r.ticker,
    cob: r.g2.ochoK ? r.g2.conItems / r.g2.ochoK : 0,
    mal: r.g2.malFormados,
  }));
  const g2Verde = g2.length > 0 && g2.every((x) => x.cob >= 0.95 && x.mal === 0);
  console.log(`  G2 items de 8-K    ${g2Verde ? '🟢 VERDE' : '🔴 ROJO '}  (criterio: ≥95% con item y 0 mal formados, desde el índice, SOLO emisores domésticos)${noAplica(extranjeros)}`);
  for (const x of g2) console.log(`       ${x.ticker.padEnd(6)} ${(x.cob * 100).toFixed(1)}% · mal formados ${x.mal}`);
  for (const r of extranjeros) {
    const seisK = r.g3?.censo?.['6-K'] ?? 0;
    console.log(`       ${r.ticker.padEnd(6)} n/a — 20-F: 0 8-K, ${seisK} 6-K. El 6-K NO trae columna items: la pregunta 1 y la 7 quedan sin clasificar.`);
  }

  // G3: 13D/proxies presentes y con URL viva.
  const g3 = reportes.filter((r) => r.g3).map((r) => {
    const urls = r.g3.urls;
    return {
      ticker: r.ticker,
      ok: urls.length > 0 && urls.every((u) => u.status === 200),
      resueltas: `${urls.filter((u) => u.status === 200).length}/${urls.length}`,
      pelea: (r.g3.censo['SC 13D'] || 0) + (r.g3.censo['SC 13D/A'] || 0) + (r.g3.censo.PREC14A || 0) + (r.g3.censo.DEFC14A || 0),
    };
  });
  const g3Verde = g3.length && g3.every((x) => x.ok);
  console.log(`  G3 13D / proxies   ${g3Verde ? '🟢 VERDE' : '🔴 ROJO '}  (criterio: toda URL de documento primario muestreada da 200)`);
  for (const x of g3) console.log(`       ${x.ticker.padEnd(6)} URLs ${x.resueltas} · filings de pelea (13D/PREC14A/DEFC14A): ${x.pelea}`);

  // G5: la guía NO está en XBRL — se confirma o se desmiente.
  const conGuia = vivos.filter((r) => (r.g5a?.conceptosDeGuia || []).length > 0);
  console.log(`  G5 guía en XBRL    ${conGuia.length ? '🟡 HAY ALGO' : '🔴 NO EXISTE'}  (${conGuia.length}/${vivos.length} emisores con algún concepto de guía etiquetado)`);
  console.log('       → si es 0, la pregunta 3 NO se contesta con XBRL solo: la guía vive en prosa del EX-99.1.');

  // G6: cobertura del emisor extranjero.
  console.log('  G6 perfil de emisor');
  for (const r of reportes.filter((x) => x.g6)) {
    const tipo = r.g6.tiene20F ? 'emisor privado extranjero (20-F/6-K) → COBERTURA PARCIAL' : 'emisor doméstico (10-K/10-Q) → cobertura completa';
    console.log(`       ${r.ticker.padEnd(6)} ${tipo}`);
  }

  return {
    g1Verde, g2Verde, g3Verde,
    guiaEnXbrl: conGuia.length > 0,
    evaluados: domesticos.map((r) => r.ticker),
    noAplica: extranjeros.map((r) => r.ticker),
    detalle: { g1, g2, g3 },
  };
}

// ═════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  FASE 0 — HISTORIA (EDGAR). Sonda de fuentes.');
  console.log(`  tickers: ${TICKERS.join(', ')}  ·  ventana facts: ${ANIOS}a  ·  ventana formas: ${ANIOS_FORMS}a`);
  console.log(`  UA: ${UA}  ·  throttle: ${THROTTLE_MS} ms (${(1000 / THROTTLE_MS).toFixed(1)} req/s, techo SEC 10)`);
  console.log(`  salida cruda: ./${OUT_DIR}/`);
  console.log('═══════════════════════════════════════════════════════════');

  const t0 = Date.now();
  let map;
  try {
    map = await tickerMap();
  } catch (e) {
    console.error(`\n✗ No se pudo bajar company_tickers.json: ${e.message}`);
    console.error('  Si es un 403 del proxy de egress, esta máquina no tiene salida a sec.gov.');
    console.error('  La sonda se corre desde una máquina con internet abierto. Ver docs/historia-fase0.md §0.');
    process.exit(1);
  }

  const reportes = [];
  for (const t of TICKERS) {
    try {
      reportes.push(await sondearTicker(t, map));
    } catch (e) {
      console.log(`  ✗ ${t}: ${e.message}`);
      reportes.push({ ticker: t, error: e.message });
    }
  }

  const lat = reporteLatencia();
  let rl = null;
  if (runGate('g4')) rl = await sondearRateLimit(map);

  const v = veredicto(reportes);

  const segundos = ((Date.now() - t0) / 1000).toFixed(1);
  const llamadas = latencias.length;
  console.log(`\n  corrida: ${segundos}s · ${llamadas} llamadas HTTP · ${mb(latencias.reduce((a, l) => a + l.bytes, 0))} bajados`);
  console.log(`  costo por ticker (extrapolado): ${(llamadas / TICKERS.length).toFixed(0)} llamadas, ${((Date.now() - t0) / TICKERS.length / 1000).toFixed(1)}s`);

  const ruta = save('reporte.json', {
    corridaISO: new Date().toISOString(),
    tickers: TICKERS, anios: ANIOS, aniosForms: ANIOS_FORMS,
    reportes, latencia: lat, rateLimit: rl, veredicto: v,
    segundos: Number(segundos), llamadas,
  });
  console.log(`  reporte completo: ${ruta}\n`);
}

// Solo corre cuando se INVOCA como script. Importado desde el test, el módulo
// expone las funciones puras y no toca la red.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n✗ sonda abortada:', e); process.exit(1); });
}
