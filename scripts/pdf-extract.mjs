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
  'claude-haiku-4-5':  { in: 1.00, out: 5.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-sonnet-5':   { in: 2.00, out: 10.00 },
  'claude-opus-5':     { in: 5.00, out: 25.00 },
};
const MODELO_DEFAULT = 'claude-haiku-4-5';

/* Modelo al que se escala cuando el refuerzo no basta (--modelo-escala).
 * Nota: claude-sonnet-5 es más nuevo Y más barato que claude-sonnet-4-6
 * ($2/$10 contra $3/$15). Se deja 4-6 por ser el pedido explícitamente; cambiarlo
 * es una bandera, no un cambio de código. */
const MODELO_ESCALA_DEFAULT = 'claude-sonnet-4-6';

/* Con este número de campos INCONSISTENTE en un archivo, se reintenta. */
const UMBRAL_REINTENTO = 3;

/* Refuerzo que se añade al prompt en los reintentos. Ataca exactamente el modo
 * de falla observado: el modelo cita bien y transcribe el número truncado. */
const REFUERZO = `

ATENCIÓN — en un intento anterior varios números NO coincidieron con su propia cita.
El error fue truncar: se citó "394,389,471" y se reportó 394389. NO vuelvas a hacerlo.

Por cada campo, antes de escribir "valor":
  1. Localiza el número en la línea que vas a citar.
  2. Cópialo COMPLETO, con TODOS sus grupos de dígitos, de principio a fin.
     "394,389,471" son tres grupos -> 394389471. No dos. No redondees a miles ni
     a millones: la escala se declara aparte en "unidad", nunca recortando dígitos.
  3. Relee: los dígitos de "valor" deben ser exactamente los de la cita.

Si un número no lo puedes copiar entero con certeza, pon null. Un null es
aceptable; un número truncado no lo es.`;

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

/*
 * FIX 1 — Formato BMV: usar el índice de secciones en vez de adivinar.
 *
 * El reporte en formato BMV (el XBRL impreso) trae en la p.1 un índice con los
 * códigos de sección de la taxonomía y su página. La corrida real falló justo
 * por no usarlo: el puntaje por palabras clave agarró balance y notas pero se
 * saltó el estado de resultados, los datos informativos (acciones) y la fecha,
 * y esos cuatro campos salieron NULL.
 *
 * Códigos que nos importan (los demás se ignoran):
 *   [210000] situación financiera      -> activos, pasivos, capital, efectivo
 *   [310000]/[320000] resultados       -> ingresos, utilidad controladora
 *   [700000] datos informativos        -> acciones en circulación
 *   [800200]/[800600] comentarios/notas-> deuda desglosada, fecha
 *
 * [NO VERIFICADO] El archivo en formato BMV no llegó a este entorno, así que
 * este parser está escrito contra la estructura descrita, no probado contra el
 * PDF. Si el índice no se deja leer, cae de vuelta al puntaje por palabras y lo
 * dice en pantalla — nunca falla en silencio. Compruébalo con --dry-run antes
 * de gastar tokens.
 */
const SECCIONES_BMV = [
  [/^21\d{4}$/, 'situación financiera'],
  [/^3[12]\d{4}$/, 'resultados'],
  [/^7\d{5}$/, 'datos informativos'],
  [/^8\d{5}$/, 'comentarios y notas'],
];

/* Máximo de páginas que se toma de una sección. Acota el costo si el índice
 * viene raro o una sección es enorme (notas al pie de 40 páginas). */
const MAX_PAGINAS_POR_SECCION = 6;

/**
 * Lee el índice de la p.1 y devuelve RANGOS completos por sección.
 *
 * Tomar sólo la página inicial (y la siguiente) no alcanzaba: en la corrida real
 * [800100] arranca en p.43 y el desglose de créditos bancarios y bursátiles está
 * en p.44, así que la deuda salió como "Otros pasivos financieros" con
 * comparable=NO. Una sección se lee **desde su página hasta la anterior a la
 * siguiente sección del índice**, sea cual sea esa siguiente — por eso se
 * recogen TODOS los códigos, no sólo los que interesan.
 */
function rangosDelIndice(textoP1) {
  const re = /\[(\d{6})\][^\n\[]*?(\d{1,4})\s*$/gm;
  const todas = [];
  let m;
  while ((m = re.exec(textoP1)) !== null) {
    const codigo = m[1], pagina = Number(m[2]);
    if (!(pagina > 0 && pagina < 5000)) continue;
    const quiero = SECCIONES_BMV.find(([re2]) => re2.test(codigo));
    todas.push({ codigo, pagina, quiero: !!quiero, etiqueta: quiero ? quiero[1] : null });
  }
  if (!todas.length) return null;

  todas.sort((a, b) => a.pagina - b.pagina);
  const rangos = [];
  for (let i = 0; i < todas.length; i++) {
    if (!todas[i].quiero) continue;
    const ini = todas[i].pagina;
    // Fin = una antes de la SIGUIENTE sección del índice (la que sea).
    const sig = todas.slice(i + 1).find((x) => x.pagina > ini);
    const finNatural = sig ? sig.pagina - 1 : ini + MAX_PAGINAS_POR_SECCION - 1;
    const fin = Math.min(Math.max(finNatural, ini), ini + MAX_PAGINAS_POR_SECCION - 1);
    rangos.push({ codigo: todas[i].codigo, etiqueta: todas[i].etiqueta, ini, fin,
                  truncado: finNatural > fin });
  }
  return rangos.length ? rangos : null;
}

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
  // (a) Si hay índice de secciones (formato BMV), manda.
  const rangos = rangosDelIndice(paginas[0]?.texto || '');
  if (rangos) {
    const elegidas = new Set([1, 2]); // portada + comentarios/fecha
    for (const r of rangos) for (let pg = r.ini; pg <= r.fin; pg++) elegidas.add(pg);
    const lista = [...elegidas]
      .filter((x) => x >= 1 && x <= paginas.length)
      .sort((a, b) => a - b)
      .map((x) => paginas[x - 1]);
    return Object.assign(lista, { via: 'índice de secciones BMV', rangos });
  }

  // (b) Si no, puntaje por palabras clave (comunicados).
  const ordenadas = [...paginas].sort((a, b) => b.score - a.score).slice(0, maxPaginas);
  if (!ordenadas.some((x) => x.p === 1) && paginas[0]) ordenadas.push(paginas[0]); // portada
  const lista = ordenadas.sort((a, b) => a.p - b.p);
  return Object.assign(lista, { via: 'puntaje por palabras clave' });
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
   solo, "6m" si es acumulado de seis meses, "12m" si son doce meses. Para saldos
   de balance (activos, pasivos, capital, efectivo, deuda, acciones) usa null.

   REGLA DE PRIORIDAD — el trimestre manda:
   Estos reportes casi siempre traen VARIAS ventanas en la MISMA tabla, en
   columnas contiguas, con encabezados como "Por el trimestre / Trimestre /
   3 meses" y "Acumulado / Acumulado a / 6 meses / Del 1 de enero al".
     - Si existe la columna de TRES MESES, ése es el valor principal: va en
       "valor" con ventana "3m". NO uses el acumulado como principal cuando el
       trimestre está disponible.
     - Las demás ventanas que encuentres para el mismo concepto van en
       "otras_ventanas", cada una con su ventana, su valor y su cita.
     - Si el documento SÓLO trae acumulado, entonces ése es el principal, con su
       ventana real ("6m" o "12m"), y "otras_ventanas" queda en [].
   Mira el encabezado de cada columna con cuidado antes de decidir: equivocar la
   ventana no produce ningún error visible, produce una serie equivocada.
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
    "ingresos":                 {"valor": <num>|null, "unidad": "miles"|"millones"|"pesos"|null, "ventana": "3m"|"6m"|"12m"|null, "cita": "<literal>"|null, "otras_ventanas": [{"ventana": "6m", "valor": <num>, "cita": "<literal>"}]},
    "utilidad_neta_atribuible": {"valor": ..., "unidad": ..., "ventana": ..., "cita": ..., "otras_ventanas": [...]},
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
/* 4.bis VALIDACIÓN DURA: el número debe aparecer literal en su cita           */
/* ========================================================================= */
/*
 * Esta es la clase de error más peligrosa que salió en la corrida real, porque
 * es SILENCIOSA: el modelo cita bien y transcribe mal.
 *
 *   Walmex 4T2021 -> valor 394,389 [miles], cita "Suma activos $ 394,389,471"
 *   Walmex 2T2022 -> valor 396,362,084 [miles], cita "Suma activos $ 396,362,084"
 *
 * Mismo campo, misma empresa, dos trimestres: factor 1000 de diferencia. El
 * modelo truncó/redondeó el número de la cita a sus primeros dígitos. Las
 * identidades contables NO lo detectan, porque TODOS los campos del archivo
 * salieron redondeados igual y la suma sigue cerrando.
 *
 * La regla: los dígitos del valor tienen que aparecer como un token numérico
 * COMPLETO dentro de la cita. "394389" contra la cita "394,389,471" no pasa,
 * porque ahí el token completo es 394389471. Un campo que no pasa se marca
 * INCONSISTENTE, no se normaliza y NO entra a las identidades.
 */
function citaRespalda(valor, cita) {
  if (valor == null) return { ok: null, motivo: 'sin valor' };
  if (!cita) return { ok: false, motivo: 'sin cita' };

  const objetivo = String(Math.abs(valor)).replace(/[.,]/g, '');
  const tokens = String(cita).match(/\d[\d.,]*/g) || [];
  for (const t of tokens) {
    const sinMiles = t.replace(/,/g, '');          // 394,389,471 -> 394389471
    const sinDecimales = sinMiles.replace(/\.\d+$/, ''); // 2.652 -> 2
    if (sinMiles.replace(/\./g, '') === objetivo) return { ok: true };
    if (sinDecimales === objetivo) return { ok: true };
  }
  return { ok: false, motivo: `el valor ${valor} no aparece como número completo en la cita` };
}

/**
 * Valida un campo completo. Los campos de SUMA (deuda con costo) son un caso
 * aparte: su total es una suma que por definición NO está impresa como tal, así
 * que se validan por sus componentes.
 */
function validarCampo(campo) {
  if (!campo || campo.valor == null) return { ok: null, motivo: 'sin valor' };

  const comps = Array.isArray(campo.componentes) ? campo.componentes.filter((c) => c && c.valor != null) : [];
  if (comps.length) {
    const suma = comps.reduce((a, b) => a + b.valor, 0);
    const tol = Math.max(1, Math.abs(campo.valor) * 1e-9);
    if (Math.abs(suma - campo.valor) > tol) {
      return { ok: false, motivo: `los componentes suman ${suma}, no ${campo.valor}` };
    }
    // Basta con que el total O algún componente esté respaldado por la cita:
    // la cita suele venir de una sola de las dos tablas (balance o resumen).
    if (citaRespalda(campo.valor, campo.cita).ok) return { ok: true };
    if (comps.some((c) => c.valor !== 0 && citaRespalda(c.valor, campo.cita).ok)) return { ok: true };
    return { ok: false, motivo: 'ni el total ni ningún componente aparecen en la cita' };
  }

  return citaRespalda(campo.valor, campo.cita);
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
  if (r.intentos && r.intentos.length > 1) {
    console.log(`intentos: ${r.intentos.map((x) => `${x.etiqueta}(${x.modelo}, ${x.malos} malos, ${usd(x.costo)})`).join('  ->  ')}`);
    console.log(`   se quedó: ${r.elegido}`);
  }

  console.log(`\n--- 9 CAMPOS ---`);
  for (const [k, label] of CAMPOS) {
    const c = (d.campos || {})[k] || {};
    const esConteo = k === 'acciones_circulacion';
    const { pesos, nota } = aPesos(c, esConteo);
    const vent = c.ventana ? ` ${c.ventana}` : '';
    const uni = c.unidad ? ` [${c.unidad}]` : (esConteo ? '' : ' [unidad NULL]');
    const val = (r.validacion || {})[k] || {};
    if (c.valor == null) {
      console.log(`  ${label.padEnd(44)} NULL${c.nota ? '  — ' + c.nota : ''}`);
    } else if (val.ok === false) {
      console.log(`  ${label.padEnd(44)} ${fmt(c.valor).padStart(20)}${uni}${vent}  <-- INCONSISTENTE, descartado`);
      console.log(`  ${''.padEnd(44)} ${val.motivo}`);
    } else {
      console.log(`  ${label.padEnd(44)} ${fmt(pesos ?? c.valor).padStart(20)}${uni}${vent}${pesos == null ? '  <-- ' + nota : ''}`);
    }
    if (c.otras_ventanas?.length) {
      for (const o of c.otras_ventanas) {
        console.log(`  ${''.padEnd(44)} ${fmt(o.valor).padStart(20)}     · también ${o.ventana}`);
      }
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

  console.log(`\n[${nombre}] páginas: ${paginas.map((x) => x.p).join(', ')}  vía ${paginas.via}  (~${Math.round(prompt.length / 4)} tok)`);
  if (paginas.rangos) {
    for (const r of paginas.rangos) {
      console.log(`     [${r.codigo}] ${r.etiqueta}: p${r.ini}${r.fin > r.ini ? `-${r.fin}` : ''}${r.truncado ? `  (truncada a ${MAX_PAGINAS_POR_SECCION} pp.)` : ''}`);
    }
  }

  if (opts.dryRun) {
    const p = PRECIOS[opts.model] || PRECIOS[MODELO_DEFAULT];
    const est = (prompt.length / 4 / 1e6) * p.in + (1200 / 1e6) * p.out;
    console.log(`   DRY-RUN: no se llamó a la API. Costo estimado ~${usd(est)} con ${opts.model}.`);
    return { dryRun: true, estimado: est };
  }

  /* Un intento = una llamada. Devuelve el resultado ya validado. */
  async function intento(txtPrompt, modelo, etiqueta) {
    const r = await llamar(txtPrompt, modelo);
    if (opts.raw) writeFileSync(join(OUT_DIR, `${nombre}.${etiqueta}.respuesta.json`), r.texto);
    const datos = parsearJson(r.texto);

    const norm = {}, validacion = {};
    for (const [k] of CAMPOS) {
      const c = (datos.campos || {})[k];
      const v = validarCampo(c);
      validacion[k] = v;
      const { pesos } = aPesos(c, k === 'acciones_circulacion');
      // Un valor que su cita no respalda NUNCA se acepta.
      norm[k] = v.ok === false ? null : pesos;
    }
    for (const [k] of EXTRAS) {
      const c = (datos.extras || {})[k];
      const v = validarCampo(c);
      validacion['extra_' + k] = v;
      const { pesos } = aPesos(c);
      norm[k] = v.ok === false ? null : pesos;
    }

    const pr = PRECIOS[r.modelo] || PRECIOS[modelo] || PRECIOS[MODELO_DEFAULT];
    const costo = ((r.usage.input_tokens || 0) / 1e6) * pr.in + ((r.usage.output_tokens || 0) / 1e6) * pr.out;
    // Sólo cuentan los 9 campos para el umbral; los extras son informativos y
    // contarlos dispararía reintentos que no hacen falta.
    const malos = CAMPOS.filter(([k]) => validacion[k]?.ok === false).length;

    return { datos, norm, validacion, identidades: identidades(norm),
             usage: r.usage, costo, modelo: r.modelo, stopReason: r.stopReason, malos, etiqueta };
  }

  /*
   * Política de reintento. El disparador es la validación de cita, no una
   * corazonada: con UMBRAL_REINTENTO campos o más sin respaldo, el archivo
   * entero es sospechoso (en la corrida real Walmex 4T2021 salió 6/6 malo).
   *   intento 1: prompt normal, modelo por defecto
   *   intento 2: + REFUERZO, mismo modelo
   *   intento 3: + REFUERZO, modelo de escala (más caro)
   * Se queda el intento con MENOS campos inconsistentes; en empate, el primero.
   * El costo suma TODOS los intentos, no sólo el que se queda.
   */
  const intentos = [];
  try {
    intentos.push(await intento(prompt, opts.model, 'i1'));

    if (intentos[0].malos >= UMBRAL_REINTENTO) {
      console.log(`   ${intentos[0].malos} campos sin respaldo en la cita -> reintento con refuerzo`);
      intentos.push(await intento(prompt + REFUERZO, opts.model, 'i2-refuerzo'));

      if (intentos[1].malos >= UMBRAL_REINTENTO) {
        console.log(`   siguen ${intentos[1].malos} -> escalando a ${opts.modeloEscala}`);
        intentos.push(await intento(prompt + REFUERZO, opts.modeloEscala, 'i3-escala'));
      }
    }
  } catch (e) {
    if (!intentos.length) return { error: e.message };
    console.log(`   (un reintento falló: ${e.message} — me quedo con lo que haya)`);
  }

  const costoTotal = intentos.reduce((a, x) => a + x.costo, 0);
  let mejor = intentos[0];
  for (const x of intentos) if (x.malos < mejor.malos) mejor = x;

  return { ...mejor, costo: costoTotal,
           intentos: intentos.map((x) => ({ etiqueta: x.etiqueta, modelo: x.modelo, malos: x.malos, costo: x.costo })),
           elegido: mejor.etiqueta };
}

async function main() {
  const argv = process.argv.slice(2);
  const tiene = (f) => argv.includes(f);
  const valor = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

  const opts = {
    model: valor('--model', MODELO_DEFAULT),
    modeloEscala: valor('--modelo-escala', MODELO_ESCALA_DEFAULT),
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
  for (const m of [opts.model, opts.modeloEscala]) {
    if (!PRECIOS[m]) {
      console.error(`Modelo "${m}" sin precio en la tabla PRECIOS. Agrégalo antes de correr, o el costo saldría mal.`);
      process.exit(1);
    }
  }

  let archivos;
  if (tiene('--file')) archivos = [valor('--file')];
  else {
    const dir = valor('--dir', 'xbrl-raw/pdf');
    if (!existsSync(dir)) { console.error(`No existe ${dir}`); process.exit(1); }
    archivos = readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).map((f) => join(dir, f));
  }
  if (!archivos.length) { console.error('Sin PDFs que procesar.'); process.exit(1); }

  console.log(`modelo: ${opts.model}  |  escala a: ${opts.modeloEscala}  |  páginas por PDF: ${opts.pages}  |  archivos: ${archivos.length}`);

  const resultados = [];
  let costoTotal = 0, estTotal = 0;
  for (const f of archivos) {
    const r = await procesar(f, opts);
    resultados.push({ archivo: basename(f), ...r });
    if (r.dryRun) { estTotal += r.estimado; continue; }
    reportar(basename(f), r);
    if (r.costo) costoTotal += r.costo;
  }

  /* Chequeo de magnitud entre archivos de la misma emisora. Segunda red, por si
   * un error de escala pasa la validación de cita (p.ej. la unidad declarada
   * está mal pero el número se transcribió bien). */
  const porEmisora = new Map();
  for (const r of resultados) {
    if (r.error || r.dryRun) continue;
    const em = (r.datos?.emisora || r.archivo).toString().slice(0, 12).toUpperCase();
    if (!porEmisora.has(em)) porEmisora.set(em, []);
    porEmisora.get(em).push(r);
  }
  const SALDOS = ['activos_totales', 'pasivos_totales', 'capital_contable', 'efectivo'];
  let avisosMagnitud = 0;
  for (const [em, rs] of porEmisora) {
    if (rs.length < 2) continue;
    for (const k of SALDOS) {
      const vals = rs.map((r) => ({ a: r.archivo, v: r.norm?.[k] })).filter((x) => x.v != null && x.v !== 0);
      if (vals.length < 2) continue;
      const min = Math.min(...vals.map((x) => x.v)), max = Math.max(...vals.map((x) => x.v));
      if (max / min >= 100) {
        if (!avisosMagnitud++) console.log(`\n${'#'.repeat(80)}\n# AVISOS DE MAGNITUD (misma emisora, periodos distintos)\n${'#'.repeat(80)}`);
        console.log(`  ${em} · ${k}: factor ${Math.round(max / min)}x entre periodos — revisar unidad`);
        for (const x of vals) console.log(`      ${x.a}: ${fmt(x.v)}`);
      }
    }
  }

  const inconsistentes = resultados.flatMap((r) =>
    Object.entries(r.validacion || {}).filter(([, v]) => v.ok === false).map(([k]) => `${r.archivo}:${k}`));

  console.log(`\n${'#'.repeat(80)}`);
  if (inconsistentes.length) {
    console.log(`# ${inconsistentes.length} CAMPO(S) INCONSISTENTE(S) — descartados, no cuentan:`);
    for (const x of inconsistentes) console.log(`#   ${x}`);
    console.log(`${'#'.repeat(80)}`);
  }
  if (opts.dryRun) {
    console.log(`# DRY-RUN. Costo total estimado: ${usd(estTotal)} en ${archivos.length} PDFs`);
    console.log(`# (~${usd(estTotal / archivos.length)} por PDF; el criterio de GO es < $0.05)`);
  } else {
    const ok = resultados.filter((r) => !r.error).length;
    const costos = resultados.filter((r) => !r.error && r.costo).map((r) => r.costo);
    const promedio = costoTotal / Math.max(ok, 1);
    const peor = costos.length ? Math.max(...costos) : 0;
    const escalados = resultados.filter((r) => (r.intentos || []).length > 1);
    console.log(`# ${ok}/${resultados.length} PDFs extraídos  |  costo total ${usd(costoTotal)}`);
    console.log(`# promedio ${usd(promedio)} por PDF  |  el más caro ${usd(peor)}`);
    if (escalados.length) {
      console.log(`# ${escalados.length} PDF(s) necesitaron reintento: ${escalados.map((r) => r.archivo).join(', ')}`);
    }
    // El criterio está escrito POR PDF, así que se mide contra el peor, no
    // contra el promedio. Se reportan los dos para que la diferencia se vea.
    console.log(`# Criterio de GO (< $0.05 por PDF): promedio ${promedio < 0.05 ? 'CUMPLE' : 'NO CUMPLE'} · peor caso ${peor < 0.05 ? 'CUMPLE' : 'NO CUMPLE'}`);
    if (peor >= 0.05 && promedio < 0.05) {
      console.log(`# OJO: el promedio cumple y el peor caso no. Un PDF que escala los tres`);
      console.log(`#      intentos cuesta ~5x uno limpio. Decide si el criterio es por PDF o de corpus.`);
    }
  }
  console.log(`${'#'.repeat(80)}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'resultados.json'), JSON.stringify(resultados, null, 2));
  console.log(`\nResultados completos en ${OUT_DIR}/resultados.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
