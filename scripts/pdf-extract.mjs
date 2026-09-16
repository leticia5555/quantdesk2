#!/usr/bin/env node
/**
 * FASE 0b — Histórico vía PDF.
 *
 * Pregunta única: ¿se pueden extraer los 9 campos de Fase 0 desde PDFs viejos,
 * con un modelo, de forma confiable y verificable?
 *
 * NO es pipeline. No toca el app ni Neon. El raw vive en xbrl-raw/ (ignorada).
 *
 * ---------------------------------------------------------------------------
 * DECISIONES DE HERRAMIENTA (justificadas, no por defecto)
 *
 * 1) Extracción de texto: `pdftotext -layout` (poppler), NO pdf-parse.
 *    Un estado financiero es una TABLA: el significado está en la alineación de
 *    columnas ("Jun-20" vs "Dic-19" vs "% Inc."). `pdftotext -layout` conserva
 *    esa geometría en texto plano. pdf-parse (y pdfjs sin usar coordenadas)
 *    devuelve un stream de texto que aplana las columnas: los números de dos
 *    periodos quedan pegados y ni un humano ni el modelo pueden decir cuál es
 *    cuál. Probado sobre los 4 PDFs de esta fase: con -layout las tablas salen
 *    legibles tal cual.
 *    Si no está: `apt-get update && apt-get install -y poppler-utils`
 *    (en mac: `brew install poppler`).
 *
 * 2) Llamada al modelo: HTTP directo a /v1/messages, sin el SDK.
 *    El SDK oficial (@anthropic-ai/sdk) es lo normal y sería lo primero que yo
 *    elegiría en un proyecto con package.json. Este repo NO tiene package.json
 *    ni node_modules, y sus 6 scripts usan sólo builtins de `node:`. Meter npm
 *    install para una sonda de Fase 0 rompe esa convención y le agrega un paso
 *    de instalación al que corre esto. fetch es global en Node 18+. Si la Fase 1
 *    se construye de verdad, ahí sí entra el SDK.
 *
 * 3) JSON por prompt + parseo defensivo, no structured outputs.
 *    Para no depender de que el modelo elegido soporte output_config.format.
 *    El parseo tolera fences ``` y texto alrededor. Si no hay JSON válido, el
 *    archivo se reporta como error — nunca se rellena a mano.
 * ---------------------------------------------------------------------------
 *
 * USO
 *   node scripts/pdf-extract.mjs --dir xbrl-raw/pdf
 *   node scripts/pdf-extract.mjs --dir xbrl-raw/pdf --model claude-haiku-4-5
 *   node scripts/pdf-extract.mjs --file xbrl-raw/pdf/X.pdf --dry-run
 *
 *   --dry-run   arma el prompt, cuenta tokens aproximados y estima costo, pero
 *               NO llama a la API. Sirve para revisar qué se va a mandar.
 *   --pages N   páginas candidatas a mandar (default 6).
 *   --raw       guarda prompt y respuesta cruda en xbrl-raw/pdf-out/.
 *
 * Requiere ANTHROPIC_API_KEY en el entorno.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const OUT_DIR = 'xbrl-raw/pdf-out';

/* ========================================================================= */
/* Precios                                                                    */
/* ========================================================================= */
/* USD por 1M de tokens. Tomados de la tabla de modelos vigente al 2026-06-24.
 * Si cambian, esto es lo único que hay que tocar para que el costo siga bien. */
const PRECIOS = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
  'claude-sonnet-5':  { in: 2.00, out: 10.00 },
  'claude-opus-5':    { in: 5.00, out: 25.00 },
};
const MODELO_DEFAULT = 'claude-haiku-4-5';

/* ========================================================================= */
/* Los 9 campos (mismos keys que xbrl-smoke.mjs, para poder cruzar)           */
/* ========================================================================= */

const CAMPOS = [
  ['ingresos',                 'Ingresos'],
  ['utilidad_neta_atribuible', 'Utilidad neta atribuible a la controladora'],
  ['activos_totales',          'Activos totales'],
  ['pasivos_totales',          'Pasivos totales'],
  ['capital_contable',         'Capital contable'],
  ['efectivo',                 'Efectivo y equivalentes'],
  ['deuda_corto',              'Deuda con costo — corto plazo'],
  ['deuda_largo',              'Deuda con costo — largo plazo'],
  ['acciones_circulacion',     'Acciones en circulación'],
];

/* Subtotales opcionales. No son de los 9, pero sin ellos sólo se puede correr
 * UNA identidad contable. Con ellos se corren las cuatro de xbrl-smoke.mjs. */
const EXTRAS = [
  ['activo_circulante',        'Activo circulante'],
  ['activo_no_circulante',     'Activo no circulante'],
  ['pasivo_circulante',        'Pasivo circulante'],
  ['pasivo_no_circulante',     'Pasivo no circulante'],
  ['capital_controladora',     'Capital contable de la controladora'],
  ['participacion_no_control', 'Participación no controladora'],
  ['arrendamientos_corto',     'Arrendamientos (IFRS-16) corto plazo'],
  ['arrendamientos_largo',     'Arrendamientos (IFRS-16) largo plazo'],
];

/* ========================================================================= */
/* 1. Texto del PDF                                                           */
/* ========================================================================= */

function hayPdftotext() {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function numPaginas(pdf) {
  try {
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    const m = /^Pages:\s+(\d+)/m.exec(info);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function textoPagina(pdf, p) {
  try {
    return execFileSync('pdftotext', ['-layout', '-f', String(p), '-l', String(p), pdf, '-'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { return ''; }
}

/* ========================================================================= */
/* 2. Selección de páginas                                                    */
/* ========================================================================= */
/*
 * Mandar 36 páginas al modelo es caro y además le mete ruido: estos
 * comunicados traen decenas de páginas de análisis por subsidiaria con cifras
 * parecidas. Se puntúan las páginas por señales de estado financiero y se
 * mandan las mejores. La página 1 va SIEMPRE porque ahí está la fecha de
 * publicación (Walmex en portada, FEMSA en el encabezado).
 */
const SENALES = [
  [/total\s+de\s+activo|activo\s+total|total\s+activos|suma\s+activos/i, 10],
  [/total\s+de\s+pasivo|total\s+pasivos|suma\s+pasivos/i, 10],
  [/total\s+capital\s+contable|suma\s+capital\s+contable|capital\s+contable/i, 8],
  [/balance\s+general|situaci[oó]n\s+financiera|estado\s+de\s+posici[oó]n/i, 12],
  [/estado\s+de\s+resultados|resultados\s+consolidados/i, 8],
  [/efectivo\s+y\s+(equivalentes|valores)/i, 6],
  [/pr[eé]stamos\s+bancarios|deuda\s+a\s+largo\s+plazo|vencimientos/i, 6],
  [/acciones\s+en\s+circulaci[oó]n|acciones\s+representativas|promedio\s+de\s+acciones/i, 5],
  [/ingresos\s+totales|ventas\s+netas|ingresos\s+netos/i, 4],
  [/utilidad\s+neta|participaci[oó]n\s+controladora/i, 4],
];

function elegirPaginas(pdf, n, maxPaginas) {
  const total = numPaginas(pdf);
  const paginas = [];
  for (let p = 1; p <= total; p++) {
    const t = textoPagina(pdf, p);
    let score = 0;
    for (const [re, w] of SENALES) if (re.test(t)) score += w;
    // Una página de estado financiero tiene muchos números con separador de miles.
    const densidad = (t.match(/\d{1,3}(?:,\d{3})+/g) || []).length;
    score += Math.min(densidad / 5, 10);
    paginas.push({ p, score, texto: t });
  }
  const ordenadas = [...paginas].sort((a, b) => b.score - a.score).slice(0, maxPaginas);
  if (!ordenadas.some((x) => x.p === 1) && paginas[0]) ordenadas.push(paginas[0]); // portada
  return ordenadas.sort((a, b) => a.p - b.p);
}

/* ========================================================================= */
/* 3. Prompt                                                                  */
/* ========================================================================= */

const INSTRUCCIONES = `Eres un extractor de datos financieros. Te doy páginas de un reporte trimestral
de una emisora mexicana listada en la BMV, en texto plano con la alineación de
columnas preservada.

Devuelve ÚNICAMENTE un objeto JSON, sin texto antes ni después, sin markdown.

REGLAS DURAS — su incumplimiento invalida la extracción:

1. NUNCA inventes un número. Si un campo no aparece en las páginas dadas, su
   "valor" es null. Un campo ausente es null, jamás una estimación, jamás un
   número parecido de otra línea.
2. Cada número debe venir acompañado de "cita": el texto LITERAL de la línea de
   donde lo sacaste, copiado tal cual del documento. Si no puedes citar, es null.
3. "unidad" es la unidad DECLARADA en el documento para ese número
   ("miles", "millones" o "pesos"). Los reportes suelen declararla en el
   encabezado de la tabla ("Millones de pesos", "(Miles de pesos)"). No conviertas
   nada: reporta el número tal como aparece impreso y la unidad por separado.
   Si no encuentras la unidad declarada, unidad es null.
4. "ventana" aplica sólo a flujos (ingresos, utilidad): "3m" si es el trimestre
   solo, "6m" si es acumulado de seis meses, "12m" si son doce meses. Estos
   reportes suelen traer AMBAS columnas (trimestre y acumulado) una al lado de
   la otra: mira el encabezado con cuidado y NO las confundas. Para saldos de
   balance (activos, pasivos, capital, efectivo, deuda, acciones) usa null.
5. Para el balance, toma SIEMPRE la columna del periodo MÁS RECIENTE. Estas
   tablas traen el periodo actual y el comparativo del año anterior o del cierre
   anterior; el que quiero es el actual.

DEFINICIÓN DE DEUDA CON COSTO (importante, es donde más se falla):
Deuda con costo = préstamos bancarios + deuda bursátil + vencimientos a corto
plazo de la deuda de largo plazo. Es decir, pasivo financiero que genera
intereses.
  - EXCLUYE arrendamientos / pasivos por arrendamiento (IFRS-16).
  - EXCLUYE intereses por pagar (son intereses devengados, no principal).
  - EXCLUYE proveedores, cuentas por pagar y cualquier pasivo de operación.
En "componentes" lista cada partida que sumaste, con su etiqueta literal y su
valor. En "comparable" pon true sólo si pudiste identificar las partidas de
deuda financiera con claridad; pon false si el documento sólo da un agregado que
mezcla arrendamientos o intereses, y explica en "nota". Si el balance no muestra
ninguna línea de deuda financiera, pon valor null y explica en "nota" que no
aparece — NO pongas 0, porque "no reportado" y "reportó cero" no son lo mismo.

FECHA DE PUBLICACIÓN: la del documento (Walmex la trae en portada tipo "Ciudad de
México, a 26 de julio de 2022"; FEMSA en el encabezado tipo "Monterrey, México,
24 de julio de 2020"). Formato YYYY-MM-DD. Si no está, null.

ESQUEMA EXACTO:
{
  "emisora": "<clave de pizarra o nombre>" | null,
  "periodo_fin": "YYYY-MM-DD" | null,
  "fecha_publicacion": {"valor": "YYYY-MM-DD"|null, "cita": "<literal>"|null},
  "campos": {
    "ingresos":                 {"valor": <num>|null, "unidad": "miles"|"millones"|"pesos"|null, "ventana": "3m"|"6m"|"12m"|null, "cita": "<literal>"|null},
    "utilidad_neta_atribuible": {"valor": ..., "unidad": ..., "ventana": ..., "cita": ...},
    "activos_totales":          {"valor": ..., "unidad": ..., "ventana": null, "cita": ...},
    "pasivos_totales":          {"valor": ..., "unidad": ..., "ventana": null, "cita": ...},
    "capital_contable":         {"valor": ..., "unidad": ..., "ventana": null, "cita": ...},
    "efectivo":                 {"valor": ..., "unidad": ..., "ventana": null, "cita": ...},
    "deuda_corto":              {"valor": ..., "unidad": ..., "ventana": null, "cita": ..., "componentes": [{"etiqueta": "<literal>", "valor": <num>}], "comparable": true|false, "nota": "<texto>"|null},
    "deuda_largo":              {"valor": ..., "unidad": ..., "ventana": null, "cita": ..., "componentes": [...], "comparable": true|false, "nota": "<texto>"|null},
    "acciones_circulacion":     {"valor": ..., "unidad": null, "ventana": null, "cita": ...}
  },
  "extras": {
    "activo_circulante": {"valor": ..., "unidad": ..., "cita": ...},
    "activo_no_circulante": {"valor": ..., "unidad": ..., "cita": ...},
    "pasivo_circulante": {"valor": ..., "unidad": ..., "cita": ...},
    "pasivo_no_circulante": {"valor": ..., "unidad": ..., "cita": ...},
    "capital_controladora": {"valor": ..., "unidad": ..., "cita": ...},
    "participacion_no_control": {"valor": ..., "unidad": ..., "cita": ...},
    "arrendamientos_corto": {"valor": ..., "unidad": ..., "cita": ...},
    "arrendamientos_largo": {"valor": ..., "unidad": ..., "cita": ...}
  }
}

Todo campo del esquema debe estar presente. Los que no encuentres, con valor null.`;

function armarPrompt(paginas) {
  const cuerpo = paginas
    .map((x) => `<pagina numero="${x.p}">\n${x.texto}\n</pagina>`)
    .join('\n\n');
  return `${INSTRUCCIONES}\n\n---\nPÁGINAS DEL DOCUMENTO:\n\n${cuerpo}`;
}

/* ========================================================================= */
/* 4. Llamada al modelo                                                       */
/* ========================================================================= */

async function llamar(prompt, modelo) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY en el entorno.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  const texto = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    texto,
    stopReason: j.stop_reason,
    usage: j.usage || {},
    modelo: j.model || modelo,
  };
}

/** Tolera fences y texto alrededor. Si no hay JSON válido, lanza. */
function parsearJson(texto) {
  let t = texto.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const ini = t.indexOf('{'), fin = t.lastIndexOf('}');
  if (ini < 0 || fin <= ini) throw new Error('la respuesta no contiene un objeto JSON');
  return JSON.parse(t.slice(ini, fin + 1));
}

/* ========================================================================= */
/* 5. Normalización a pesos                                                   */
/* ========================================================================= */

const FACTOR = { pesos: 1, miles: 1e3, millones: 1e6 };

/** Devuelve {pesos, nota}. Si no hay unidad declarada NO adivina: pesos=null. */
function aPesos(campo, esConteo = false) {
  if (!campo || campo.valor == null) return { pesos: null, nota: 'sin valor' };
  if (esConteo) return { pesos: campo.valor, nota: 'conteo, no monetario' };
  const f = FACTOR[campo.unidad];
  if (!f) return { pesos: null, nota: `unidad no declarada (${campo.unidad ?? 'null'}) — no se normaliza` };
  return { pesos: campo.valor * f, nota: null };
}

/* ========================================================================= */
/* 6. Identidades contables (mismas que xbrl-smoke.mjs)                       */
/* ========================================================================= */

function identidades(norm) {
  const g = (k) => (norm[k] === undefined ? null : norm[k]);
  const pruebas = [
    ['Activos = Pasivos + Capital', g('activos_totales'), [g('pasivos_totales'), g('capital_contable')]],
    ['Activos = Circulante + No circulante', g('activos_totales'), [g('activo_circulante'), g('activo_no_circulante')]],
    ['Pasivos = Circulante + No circulante', g('pasivos_totales'), [g('pasivo_circulante'), g('pasivo_no_circulante')]],
    ['Capital = Controladora + No controladora', g('capital_contable'), [g('capital_controladora'), g('participacion_no_control')]],
  ];
  return pruebas.map(([nombre, izq, partes]) => {
    if (izq == null || partes.some((x) => x == null)) return { nombre, estado: 'n/d', dif: null };
    const dif = izq - partes.reduce((a, b) => a + b, 0);
    return { nombre, estado: dif === 0 ? 'OK' : 'DIF', dif };
  });
}

/* ========================================================================= */
/* 7. Salida                                                                  */
/* ========================================================================= */

const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const usd = (n) => '$' + n.toFixed(4);

function reportar(nombre, r) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`PDF: ${nombre}`);
  console.log(`${'='.repeat(80)}`);
  if (r.error) { console.log(`  ERROR: ${r.error}`); return; }

  const d = r.datos;
  console.log(`emisora: ${d.emisora ?? '—'}   periodo_fin: ${d.periodo_fin ?? '—'}`);
  const fp = d.fecha_publicacion || {};
  console.log(`fecha de publicación: ${fp.valor ?? 'NULL'}`);
  if (fp.cita) console.log(`   cita: "${String(fp.cita).slice(0, 110)}"`);
  console.log(`modelo: ${r.modelo}  |  tokens in/out: ${r.usage.input_tokens ?? '?'}/${r.usage.output_tokens ?? '?'}  |  costo: ${usd(r.costo)}`);
  if (r.stopReason && r.stopReason !== 'end_turn') console.log(`   stop_reason: ${r.stopReason}`);

  console.log(`\n--- 9 CAMPOS ---`);
  for (const [k, label] of CAMPOS) {
    const c = (d.campos || {})[k] || {};
    const esConteo = k === 'acciones_circulacion';
    const { pesos, nota } = aPesos(c, esConteo);
    const vent = c.ventana ? ` ${c.ventana}` : '';
    const uni = c.unidad ? ` [${c.unidad}]` : (esConteo ? '' : ' [unidad NULL]');
    if (c.valor == null) {
      console.log(`  ${label.padEnd(44)} NULL${c.nota ? '  — ' + c.nota : ''}`);
    } else {
      console.log(`  ${label.padEnd(44)} ${fmt(pesos ?? c.valor).padStart(20)}${uni}${vent}${pesos == null ? '  <-- ' + nota : ''}`);
    }
    if (c.componentes?.length) {
      for (const comp of c.componentes) console.log(`  ${''.padEnd(44)} ${fmt(comp.valor).padStart(20)}     + ${comp.etiqueta}`);
      console.log(`  ${''.padEnd(44)} comparable con def. ifrs_mx: ${c.comparable === true ? 'SÍ' : c.comparable === false ? 'NO' : '?'}`);
    }
    if (c.nota && c.valor != null) console.log(`  ${''.padEnd(44)} nota: ${c.nota}`);
    if (c.cita) console.log(`  ${''.padEnd(44)} cita: "${String(c.cita).replace(/\s+/g, ' ').slice(0, 100)}"`);
  }

  console.log(`\n--- IDENTIDADES CONTABLES ---`);
  for (const id of r.identidades) {
    console.log(`  ${id.nombre.padEnd(46)} ${id.estado === 'n/d' ? 'n/d (falta algún subtotal)' : id.estado === 'OK' ? 'OK' : 'DIFIERE por ' + fmt(id.dif)}`);
  }
}

/* ========================================================================= */
/* 8. Main                                                                    */
/* ========================================================================= */

async function procesar(pdf, opts) {
  const paginas = elegirPaginas(pdf, 0, opts.pages);
  const prompt = armarPrompt(paginas);
  const nombre = basename(pdf);

  if (opts.raw) { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(join(OUT_DIR, nombre + '.prompt.txt'), prompt); }

  console.log(`\n[${nombre}] páginas elegidas: ${paginas.map((x) => x.p).join(', ')}  (~${Math.round(prompt.length / 4)} tokens aprox.)`);

  if (opts.dryRun) {
    const p = PRECIOS[opts.model] || PRECIOS[MODELO_DEFAULT];
    const est = (prompt.length / 4 / 1e6) * p.in + (1200 / 1e6) * p.out;
    console.log(`   DRY-RUN: no se llamó a la API. Costo estimado ~${usd(est)} con ${opts.model}.`);
    return { dryRun: true, estimado: est };
  }

  try {
    const r = await llamar(prompt, opts.model);
    if (opts.raw) writeFileSync(join(OUT_DIR, nombre + '.respuesta.json'), r.texto);
    const datos = parsearJson(r.texto);

    const norm = {};
    for (const [k] of CAMPOS) {
      const { pesos } = aPesos((datos.campos || {})[k], k === 'acciones_circulacion');
      norm[k] = pesos;
    }
    for (const [k] of EXTRAS) {
      const { pesos } = aPesos((datos.extras || {})[k]);
      norm[k] = pesos;
    }

    const p = PRECIOS[r.modelo] || PRECIOS[opts.model] || PRECIOS[MODELO_DEFAULT];
    const costo = ((r.usage.input_tokens || 0) / 1e6) * p.in + ((r.usage.output_tokens || 0) / 1e6) * p.out;

    return { datos, norm, identidades: identidades(norm), usage: r.usage, costo, modelo: r.modelo, stopReason: r.stopReason };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const tiene = (f) => argv.includes(f);
  const valor = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const opts = {
    model: valor('--model', MODELO_DEFAULT),
    pages: Number(valor('--pages', '6')),
    dryRun: tiene('--dry-run'),
    raw: tiene('--raw'),
  };

  if (!hayPdftotext()) {
    console.error(`Falta pdftotext (poppler). Instálalo:`);
    console.error(`  Linux:  apt-get update && apt-get install -y poppler-utils`);
    console.error(`  macOS:  brew install poppler`);
    process.exit(1);
  }
  if (!PRECIOS[opts.model]) {
    console.error(`Modelo "${opts.model}" sin precio en la tabla PRECIOS. Agrégalo antes de correr, o el costo saldría mal.`);
    process.exit(1);
  }

  let archivos;
  if (tiene('--file')) archivos = [valor('--file')];
  else {
    const dir = valor('--dir', 'xbrl-raw/pdf');
    if (!existsSync(dir)) { console.error(`No existe ${dir}`); process.exit(1); }
    archivos = readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).map((f) => join(dir, f));
  }
  if (!archivos.length) { console.error('Sin PDFs que procesar.'); process.exit(1); }

  console.log(`modelo: ${opts.model}  |  páginas por PDF: ${opts.pages}  |  archivos: ${archivos.length}`);

  const resultados = [];
  let costoTotal = 0, estTotal = 0;
  for (const f of archivos) {
    const r = await procesar(f, opts);
    resultados.push({ archivo: basename(f), ...r });
    if (r.dryRun) { estTotal += r.estimado; continue; }
    reportar(basename(f), r);
    if (r.costo) costoTotal += r.costo;
  }

  console.log(`\n${'#'.repeat(80)}`);
  if (opts.dryRun) {
    console.log(`# DRY-RUN. Costo total estimado: ${usd(estTotal)} en ${archivos.length} PDFs`);
    console.log(`# (~${usd(estTotal / archivos.length)} por PDF; el criterio de GO es < $0.05)`);
  } else {
    const ok = resultados.filter((r) => !r.error).length;
    console.log(`# ${ok}/${resultados.length} PDFs extraídos  |  costo total ${usd(costoTotal)}  |  ${usd(costoTotal / Math.max(ok, 1))} por PDF`);
    console.log(`# Criterio de GO: < $0.05 por PDF -> ${costoTotal / Math.max(ok, 1) < 0.05 ? 'CUMPLE' : 'NO CUMPLE'}`);
  }
  console.log(`${'#'.repeat(80)}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'resultados.json'), JSON.stringify(resultados, null, 2));
  console.log(`\nResultados completos en ${OUT_DIR}/resultados.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
