// ═══════════════════════════════════════════════════════════════
// api/_lib/arena-tools.js — B3: las HERRAMIENTAS del PM.
//
// El tablero (B2) le muestra el mercado; esto le deja INVESTIGARLO. Cuatro
// herramientas, un presupuesto duro y una secuencia que se publica:
//
//   screener({sector?, min_rvol?, min_mcap?, ret_1d/5d/1m, near_52w_high|low,
//             has_news, limit≤25})   — filtrar el universo por criterio
//   noticias({ticker?|tema?, days≤5, limit≤8})
//   ficha({ticker})                  — la hoja completa de un nombre
//   sector({etf})                    — un sector por dentro
//
// ── EL TOPE ES DEL HARNESS, NO DEL PROMPT ────────────────────────────
// Un tope que solo vive en el prompt no es un tope: es una sugerencia que el
// modelo cumple casi siempre, y "casi siempre" en un presupuesto es un
// presupuesto roto. La llamada 9 se responde con un `tool_result` que dice
// "presupuesto agotado, decidí con lo que tenés" — el modelo se entera de que
// se le acabó en lugar de descubrirlo por silencio.
//
// ── EL TRUNCAMIENTO SE DECLARA DENTRO DEL RESULTADO ──────────────────
// Cada resultado se corta a ~1.5K tokens y el corte VIAJA ADENTRO
// ("…(N filas más, truncado)"). Un modelo al que le cortaron los datos sin
// avisarle razona sobre una lista que cree completa — y después escribe "no hay
// ningún nombre de energía con RVOL alto" cuando lo que pasó es que no cupo.
//
// ── LA CACHÉ ES POR CONTENIDO, NO POR AGENTE ─────────────────────────
// Si dos agentes piden lo mismo, se paga una vez. Eso NO es herding: es el
// mismo dato, y el tablero ya es común para los siete. Lo que mide el
// experimento es QUÉ decidieron mirar, y eso queda intacto — la secuencia de
// llamadas de cada uno se journalea entera.
//
// ── DETERMINISMO PARA EL REPLAY ──────────────────────────────────────
// La secuencia se journalea con los argumentos y el resultado COMPLETO (no solo
// el resumen). Sin el resultado entero, un replay no puede reproducir la
// corrida: el modelo decidió mirando algo que no guardamos.
//
// JS con I/O acotado: las fuentes se inyectan, así que las reglas (tope,
// truncado, validación de argumentos) se prueban sin red.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getNews, getSnapshots } from './alpaca.js';
import { fetchDeepDive } from './finnhub-dive.js';
import { SECTOR_ETFS } from './arena-board.js';
import { readDayCache, writeDayCache, marketDay } from './arena-buffet-cache.js';

// Tope DURO de llamadas por corrida. Las rondas fijas tienen 8; una corrida por
// disparador tiene 3 (está acotada a un nombre — no necesita explorar).
// ── EL PRESUPUESTO DE INVESTIGACIÓN ──────────────────────────────────
// Eran 8 llamadas y punto. Ocho es un número redondo, no una medida de nada: no
// sale del costo, ni del reloj, ni del contexto. Cortar la investigación ahí
// era cortarla por la mitad de una tesis con presupuesto de sobra.
//
// Ahora son TRES techos simultáneos y gana el que se agote primero:
//
//   1. LLAMADAS (20)  — el tope grosero. Un modelo que pide veinte herramientas
//                       no está investigando, está en bucle.
//   2. CONTEXTO (30K) — el que de verdad aprieta. El payload crece de forma
//                       CUADRÁTICA: cada resultado se queda en la conversación y
//                       vuelve a viajar en cada vuelta siguiente. La vuelta 3 de
//                       qwen ya pesaba 36 KB con 8 llamadas.
//   3. RELOJ          — vive en el loop (ver _lib/arena-tool-loop.js), porque es
//                       el único que depende de cuánto tardó cada llamada.
//
// Los tres cortan IGUAL: se cierra con lo que haya. Ninguno aborta.
export const TOOL_BUDGET = {
  fixed_round: Number(process.env.ARENA_TOOLS_MAX) || 20,
  triggered: Number(process.env.ARENA_TOOLS_MAX_TRIGGER) || 3,
};

// Techo de CONTEXTO ACUMULADO de la conversación del loop, en tokens estimados.
// Es el techo que más manda de los tres: con resultados de ~1.5K tokens, veinte
// llamadas sin compactar serían ~30K solo de resultados, y cada uno viajando en
// todas las vueltas siguientes.
export const TOOL_CONTEXT_TOKENS = Number(process.env.ARENA_TOOL_CONTEXT_TOKENS) || 30000;

// Techo de cada resultado. ~1.5K tokens ≈ 6.000 caracteres.
export const RESULT_TOKEN_CAP = Number(process.env.ARENA_TOOL_RESULT_TOKENS) || 1500;
const RESULT_CHAR_CAP = RESULT_TOKEN_CAP * 4;

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

// ── LA COMPACTACIÓN ──────────────────────────────────────────────────
// El resultado de una herramienta de la vuelta 1 vuelve a viajar en las vueltas
// 2, 3, 4… Con veinte llamadas eso es crecimiento cuadrático, y el contexto se
// agota mucho antes que las llamadas.
//
// Se compactan los resultados VIEJOS: cabecera + las primeras filas, que es
// donde está lo que el modelo usó para decidir (las listas vienen ORDENADAS por
// relevancia — el screener por magnitud del movimiento, las noticias por
// fecha). Las últimas filas de una lista ordenada son, por construcción, las
// menos informativas.
//
// LA REGLA QUE NO SE NEGOCIA: el modelo tiene que SABER que se compactó. Un
// resultado recortado en silencio hace que razone sobre una lista que cree
// completa y después afirme "no hay ningún nombre que cumpla" — el mismo error
// que `truncateRows` ya evita para el recorte por tokens, una capa más arriba.
//
// Y lo que se compacta es SOLO lo que se re-envía. El resultado completo sigue
// entero en `executor.sequence`, que es lo que alimenta el journal y el replay:
// compactar el registro sería perder la evidencia de qué miró el modelo.
export const COMPACT_MARCA = '[COMPACTADO]';

export function compactarResultado(text, { lineas = 3 } = {}) {
  const s = String(text || '');
  // Idempotente: el loop compacta en cada vuelta y no puede ir comiéndose el
  // resultado de a poco hasta dejar solo la cabecera.
  if (s.includes(COMPACT_MARCA)) return s;
  const filas = s.split('\n');
  if (filas.length <= lineas + 1) return s;   // nada que ganar
  const omitidas = filas.length - 1 - lineas;
  return [
    filas[0],
    ...filas.slice(1, 1 + lineas),
    `${COMPACT_MARCA} ${omitidas} línea(s) más de este resultado se omitieron para que la conversación entrara en el presupuesto de contexto. NO significa que no existan: se mostraron completas cuando pediste la herramienta y quedaron enteras en el registro de la corrida. Si necesitás esas filas para decidir, volvé a pedirla con un filtro más angosto.`,
  ].join('\n');
}

// ── LAS DEFINICIONES, en forma NEUTRA ────────────────────────────────
// Una sola definición por herramienta; cada proveedor la traduce a su dialecto
// (ver toolsForProvider). Duplicar los schemas por proveedor es cómo se
// terminan corriendo dos experimentos distintos sin darse cuenta.
export const TOOL_DEFS = [
  {
    name: 'screener',
    description: 'Filter today\'s ~600-name universe by quantitative criteria. Returns matching names with price, day change, RVOL and distance to their 52-week extremes. Use it to answer "which names look like X", not to look up one name you already have in mind.',
    params: {
      sector: { type: 'string', desc: 'GICS sector ETF to restrict to, e.g. XLK, XLE. Omit for the whole universe.' },
      min_rvol: { type: 'number', desc: "Minimum RVOL (today's volume / 20-session average). INTRADAY THIS IS BIASED LOW: today's partial volume is compared against FULL sessions, so at 10:30 ET a genuinely heavy name may read 0.3. Use `rvol_top` instead while the session is running." },
      rvol_top: { type: 'boolean', desc: "Only names in today's TOP 20 by RVOL. This is a RANK, not a level, so it is NOT distorted by the time of day — prefer it over `min_rvol` before the close." },
      min_mcap_b: { type: 'number', desc: 'Minimum market cap in BILLIONS of USD.' },
      ret_1d_min: { type: 'number', desc: 'Minimum 1-day return in percent (can be negative).' },
      ret_1d_max: { type: 'number', desc: 'Maximum 1-day return in percent.' },
      ret_5d_min: { type: 'number', desc: 'Minimum 5-day return in percent.' },
      ret_1m_min: { type: 'number', desc: 'Minimum 1-month return in percent.' },
      near_52w_high: { type: 'boolean', desc: 'Only names within 2% of their 52-week high.' },
      near_52w_low: { type: 'boolean', desc: 'Only names within 2% of their 52-week low.' },
      has_news: { type: 'boolean', desc: 'Only names with a headline today.' },
      limit: { type: 'number', desc: 'Max rows to return (1-25, default 25).' },
    },
  },
  {
    name: 'noticias',
    description: 'Headlines for one ticker, or for a topic across the universe. Returns headline, source and date — not article bodies.',
    params: {
      ticker: { type: 'string', desc: 'One ticker. Mutually exclusive with `tema`.' },
      tema: { type: 'string', desc: 'A topic to match in headlines, e.g. "merger", "guidance". Mutually exclusive with `ticker`.' },
      days: { type: 'number', desc: 'How many days back (1-5, default 2).' },
      limit: { type: 'number', desc: 'Max headlines (1-8, default 8).' },
    },
  },
  {
    name: 'ficha',
    description: 'The full sheet for ONE name: price, changes 1d-6m, RVOL, 52-week range, market cap, P/E, margins, ROE, next earnings date, short interest and 5 recent headlines. This is the expensive one — use it on names you are seriously considering, not to browse.',
    params: { ticker: { type: 'string', desc: 'The ticker.', required: true } },
  },
  {
    name: 'sector',
    description: 'One sector from the inside: its ETF returns and the universe names inside it, ranked by today\'s move.',
    params: { etf: { type: 'string', desc: 'Sector ETF, e.g. XLK.', required: true } },
  },
];

// ── TRADUCCIÓN POR PROVEEDOR ─────────────────────────────────────────
// Anthropic: {name, description, input_schema}. OpenAI/OpenRouter:
// {type:'function', function:{name, description, parameters}}. El schema JSON
// de adentro es el MISMO — solo cambia el envoltorio.
function jsonSchema(params) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params)) {
    properties[k] = { type: v.type, description: v.desc };
    if (v.required) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export function toolsForProvider(provider, names = null) {
  const defs = names ? TOOL_DEFS.filter((d) => names.includes(d.name)) : TOOL_DEFS;
  if (provider === 'anthropic') {
    return defs.map((d) => ({ name: d.name, description: d.description, input_schema: jsonSchema(d.params) }));
  }
  return defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: jsonSchema(d.params) } }));
}

// ── VALIDACIÓN DE ARGUMENTOS ─────────────────────────────────────────
// Los argumentos se ACOTAN, no se rechazan. Un `limit: 500` es el modelo
// pidiendo "todo lo que haya", no un error: se le da 25 y se le DICE que se
// acotó. Rechazar la llamada le gastaría una del presupuesto sin darle nada.
export function clampArgs(name, raw) {
  const a = (raw && typeof raw === 'object') ? { ...raw } : {};
  const notes = [];
  const num = (k, lo, hi, def) => {
    if (a[k] == null) { if (def != null) a[k] = def; return; }
    const n = Number(a[k]);
    if (!Number.isFinite(n)) { delete a[k]; notes.push(`${k} no era un número, se ignoró`); return; }
    const c = Math.max(lo, Math.min(hi, n));
    if (c !== n) notes.push(`${k} acotado de ${n} a ${c}`);
    a[k] = c;
  };
  const up = (k) => { if (a[k] != null) a[k] = String(a[k]).trim().toUpperCase(); };
  // Un booleano que llega como "true"/"false" (los modelos los mandan así a
  // veces) se normaliza en vez de ignorarse: `"false"` es truthy en JS, y ese
  // filtro se aplicaría al revés sin que nada falle.
  const bool = (k) => {
    if (a[k] == null) return;
    const v = a[k];
    a[k] = v === true || v === 'true' || v === 1 || v === '1';
  };

  if (name === 'screener') {
    num('limit', 1, 25, 25);
    num('min_rvol', 0, 100);
    bool('rvol_top');
    num('min_mcap_b', 0, 1e5);
    num('ret_1d_min', -100, 1000);
    num('ret_1d_max', -100, 1000);
    num('ret_5d_min', -100, 1000);
    num('ret_1m_min', -100, 1000);
    up('sector');
    if (a.sector && !SECTOR_ETFS.some((s) => s.etf === a.sector)) {
      notes.push(`sector "${a.sector}" no es uno de los 11 ETFs GICS (${SECTOR_ETFS.map((s) => s.etf).join(', ')}); se ignoró`);
      delete a.sector;
    }
  } else if (name === 'noticias') {
    num('days', 1, 5, 2);
    num('limit', 1, 8, 8);
    up('ticker');
    if (a.ticker && a.tema) { delete a.tema; notes.push('ticker y tema son excluyentes; se usó ticker'); }
  } else if (name === 'ficha') {
    up('ticker');
  } else if (name === 'sector') {
    up('etf');
  }
  return { args: a, notes };
}

// Clave de caché: el CONTENIDO de los argumentos, normalizado. Dos agentes que
// piden lo mismo comparten la entrada; el mismo agente pidiendo lo mismo dos
// veces no paga dos veces.
export function cacheKey(name, args) {
  const orden = Object.keys(args || {}).sort();
  const norm = JSON.stringify(orden.map((k) => [k, args[k]]));
  return 'tool:' + name + ':' + createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ── TRUNCADO QUE SE DECLARA ──────────────────────────────────────────
// Corta una lista de filas al techo de caracteres y deja la nota DENTRO. El
// modelo tiene que poder distinguir "no hay más" de "no cupo más".
export function truncateRows(rows, { cap = RESULT_CHAR_CAP, header = '' } = {}) {
  const out = [];
  let len = header.length;
  for (let i = 0; i < rows.length; i++) {
    const linea = rows[i];
    if (len + linea.length + 1 > cap && out.length) {
      const faltan = rows.length - out.length;
      out.push(`…(${faltan} fila${faltan === 1 ? '' : 's'} más, TRUNCADO por presupuesto de tokens — no es que no existan, es que no cupieron)`);
      return { text: (header ? header + '\n' : '') + out.join('\n'), truncated: true, shown: out.length - 1, total: rows.length };
    }
    out.push(linea);
    len += linea.length + 1;
  }
  return { text: (header ? header + '\n' : '') + out.join('\n'), truncated: false, shown: out.length, total: rows.length };
}

// ── LAS CUATRO HERRAMIENTAS ──────────────────────────────────────────
// Todas reciben el CONTEXTO de la corrida (tablero + universo + creds) y
// devuelven texto ya truncado. Ninguna lanza: un error es un resultado que el
// modelo tiene que poder leer, no una excepción que tumbe la corrida.

const sg = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1));
const n2 = (v) => (v == null ? '—' : Number(v).toFixed(2));

function filasDelTablero(ctx) {
  // El tablero ya tiene precio, cambio, RVOL y distancia a los extremos de cada
  // nombre CUBIERTO. El screener filtra sobre eso en vez de volver a pedirlo:
  // una herramienta que re-consulta el mercado por cada llamada costaría más
  // que la decisión que informa.
  const b = ctx.board;
  if (!b) return [];
  const m = new Map();
  for (const lista of [b.gainers, b.losers, b.rvol, b.breakouts && b.breakouts.high, b.breakouts && b.breakouts.low]) {
    for (const f of lista || []) if (f && f.symbol && !m.has(f.symbol)) m.set(f.symbol, f);
  }
  return [...m.values()];
}

export async function runScreener(args, ctx) {
  const filas = filasDelTablero(ctx);
  if (!filas.length) {
    return { text: 'El tablero no está disponible en esta corrida, así que el screener no tiene sobre qué filtrar. No es que no haya nombres que cumplan — es que no hay datos.', rows: 0 };
  }
  const sectorDe = ctx.sectorOf || (() => null);
  const conNoticia = ctx.newsSymbols || new Set();
  let r = filas;

  // ── EL EMBUDO: QUÉ FILTRO SE LLEVÓ LAS FILAS ───────────────────────
  // "0 filas" es la respuesta menos accionable posible: no distingue un
  // criterio exigente de un campo que no existe en los datos. Con seis filtros
  // encadenados, saber que `sector:XLK` dejó 0 de 118 y que `ret_1d_min` no
  // llegó a evaluarse es la diferencia entre arreglar un bug y adivinar cuál.
  //
  // Se mide SIEMPRE (cuesta un contador por filtro) y se REPORTA solo cuando el
  // resultado es cero: en una respuesta con filas, el embudo sería ruido que el
  // modelo paga en tokens.
  const embudo = [];
  const aplicar = (nombre, valor, fn) => {
    if (valor === undefined || valor === null || valor === false) return;
    const antes = r.length;
    r = r.filter(fn);
    // `con_dato` separa "no cumple el criterio" de "no tenemos el dato": son
    // dos ceros distintos y llevan a decisiones distintas.
    embudo.push({ filtro: nombre, valor, antes, despues: r.length });
  };

  aplicar('sector', args.sector, (f) => sectorDe(f.symbol) === args.sector);
  aplicar('min_rvol', args.min_rvol, (f) => f.rvol != null && f.rvol >= args.min_rvol);
  // El RANGO, que no sufre el sesgo intradía: todos los nombres se miden a la
  // misma hora, así que "está entre los 20 de más RVOL" significa lo mismo a
  // las 10:30 que a las 15:45. El nivel, no.
  const enTopRvol = new Set(((ctx.board && ctx.board.rvol_top) || []).map((x) => String(x || '').toUpperCase()));
  aplicar('rvol_top', args.rvol_top, (f) => enTopRvol.has(String(f.symbol || '').toUpperCase()));
  aplicar('ret_1d_min', args.ret_1d_min, (f) => f.change_pct != null && f.change_pct >= args.ret_1d_min);
  aplicar('ret_1d_max', args.ret_1d_max, (f) => f.change_pct != null && f.change_pct <= args.ret_1d_max);
  aplicar('near_52w_high', args.near_52w_high, (f) => f.pct_from_high != null && f.pct_from_high >= -2);
  aplicar('near_52w_low', args.near_52w_low, (f) => f.pct_from_low != null && f.pct_from_low <= 2);
  aplicar('has_news', args.has_news, (f) => conNoticia.has(f.symbol));
  // ── TRES FILTROS QUE SE DECLARABAN Y NO EXISTÍAN ───────────────────
  // `ret_5d_min`, `ret_1m_min` y `min_mcap_b` estaban en el schema que ve el
  // modelo y NO se aplicaban: los dos primeros porque nadie los implementó, el
  // tercero porque dependía de `ctx.marketCapOf`, que la sombra nunca pasaba.
  //
  // Eso es PEOR que devolver cero. Un filtro que se ignora en silencio hace que
  // el modelo construya su tesis creyendo que filtró — "estos son los nombres
  // con +5% en el mes" cuando son todos los nombres. Un dato faltante se puede
  // declarar; un filtro que miente, no.
  //
  // Ahora los tres leen del universo, y si el dato no está para un nombre, ese
  // nombre NO pasa el filtro: pedir "+5% en el mes" y recibir uno del que no
  // sabemos el retorno sería el mismo error con otra cara.
  const retDe = ctx.retornosOf || (() => null);
  const mcapDe = ctx.marketCapOf || (() => null);
  aplicar('ret_5d_min', args.ret_5d_min, (f) => { const x = retDe(f.symbol); return !!(x && x.ret_5d != null && x.ret_5d >= args.ret_5d_min); });
  aplicar('ret_1m_min', args.ret_1m_min, (f) => { const x = retDe(f.symbol); return !!(x && x.ret_1m != null && x.ret_1m >= args.ret_1m_min); });
  // ── EL MARKET CAP ASUMIDO ES UNA COTA, NO UNA MEDIDA ───────────────
  // A los nombres del índice se les asume el piso de $1B sin medirlo (ver
  // arena-universe). Ese número satisface `min_mcap_b: 1` —sabemos que valen AL
  // MENOS eso— pero NO puede satisfacer `min_mcap_b: 10`: no sabemos si Apple
  // vale $3.5T o el piso, porque no lo medimos.
  //
  // Antes pasaba lo contrario: el piso se comparaba como si fuera medición, así
  // que `min_mcap_b: 10` dejaba fuera a los 502 del índice —Apple y Microsoft
  // incluidas— y el modelo leía "ningún nombre grande cumple". Dejar pasar un
  // nombre por una cota que no lo respalda sería el error simétrico.
  // El FILTRO no cambia —una cota inferior de $1B no alcanza para un umbral de
  // $10B, igual que no alcanzaría una medición de $1B— y ése es el
  // comportamiento correcto: fail-closed, como el resto de los rieles. Lo que
  // estaba mal era el REPORTE: el modelo recibía "ningún nombre cumple" cuando
  // la verdad es "no medimos el market cap de esos nombres". Son dos respuestas
  // distintas y llevan a decisiones distintas — la primera le dice que no hay
  // nombres grandes (falso: están Apple y Microsoft), la segunda le dice que
  // filtre por otra cosa.
  const esAsumido = ctx.capEsAsumido || (() => false);
  aplicar('min_mcap_b', args.min_mcap_b, (f) => {
    const mc = mcapDe(f.symbol);
    return mc != null && mc >= args.min_mcap_b * 1e9;
  });
  r = r.sort((a, b) => (Math.abs(b.change_pct || 0) - Math.abs(a.change_pct || 0)) || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, args.limit || 25);

  if (!r.length) {
    // EL CERO TIENE QUE DECIR DE QUÉ CERO SE TRATA. Si el filtro pedía un dato
    // que no tenemos para NINGÚN nombre, "ninguno cumple" es falso: lo correcto
    // es "no lo sabemos". Son dos respuestas distintas y llevan a decisiones
    // distintas.
    // La traza del embudo se arma ARRIBA de todos los ceros especializados: los
    // tres la usan, y declararla después dejaba uno en zona muerta temporal —
    // que la herramienta convertía en "La herramienta falló", o sea en un hueco
    // sin causa visible.
    const traza = embudo.map((e) => `${e.filtro}=${e.valor}: ${e.antes}→${e.despues}`).join(' · ');
    const faltantes = [];
    if (args.ret_5d_min != null && !filas.some((f) => (retDe(f.symbol) || {}).ret_5d != null)) faltantes.push('retorno a 5 días');
    if (args.ret_1m_min != null && !filas.some((f) => (retDe(f.symbol) || {}).ret_1m != null)) faltantes.push('retorno a 1 mes');
    if (args.min_mcap_b != null && !filas.some((f) => mcapDe(f.symbol) != null)) faltantes.push('market cap');
    // ── EL CERO DE `min_rvol` A MITAD DE SESIÓN ──────────────────────
    // Reportado el 2026-09-17: `ret_1d_min:2` + `min_rvol` daba 0 filas, y las
    // mismas llamadas SIN `min_rvol` daban 5. No es que esos nombres no tengan
    // volumen: es que el RVOL compara el volumen PARCIAL de hoy contra
    // sesiones COMPLETAS, así que a mitad de sesión está estructuralmente por
    // debajo de 1 y cualquier umbral "de volumen inusual" lo vacía.
    //
    // El tablero ya lo etiquetaba en el prompt, pero un filtro no lee etiquetas.
    const corteRvol = embudo.find((e) => e.filtro === 'min_rvol' && e.despues === 0 && e.antes > 0);
    const sesion = (ctx.board && ctx.board.sesion_pct);
    if (corteRvol && Number.isFinite(sesion) && sesion < 0.95) {
      const maxRvol = Math.max(0, ...filas.map((f) => f.rvol || 0));
      return {
        text: `El filtro \`min_rvol: ${args.min_rvol}\` dejó 0 de ${corteRvol.antes} nombres, pero NO porque no haya volumen inusual: la sesión lleva ${Math.round(sesion * 100)}% y el RVOL compara el volumen PARCIAL de hoy contra sesiones COMPLETAS, así que a esta hora está sesgado hacia abajo por construcción. El RVOL más alto de todo el tablero ahora mismo es ${maxRvol.toFixed(2)}.\nUsá \`rvol_top: true\` en su lugar: es el TOP 20 por RVOL del día, y un ranking no se distorsiona con la hora porque todos se miden al mismo tiempo.\nEmbudo: ${traza}`,
        rows: 0, sesgo_intradia: { sesion_pct: sesion, max_rvol_tablero: +maxRvol.toFixed(2), umbral_pedido: args.min_rvol }, embudo,
      };
    }

    // El caso que parecía "ningún nombre grande cumple": todos los que tienen
    // cap lo tienen ASUMIDO, y el umbral pedido supera la cota.
    const conCap = filas.filter((f) => mcapDe(f.symbol) != null);
    if (args.min_mcap_b != null && conCap.length && conCap.every((f) => esAsumido(f.symbol))
        && args.min_mcap_b * 1e9 > (mcapDe(conCap[0].symbol) || 0)) {
      return {
        text: `No se puede contestar con este criterio. A los ${conCap.length} nombres del tablero que vienen de un índice NO se les midió el market cap: se les asume el piso de $${((mcapDe(conCap[0].symbol) || 0) / 1e9).toFixed(0)}B por pertenecer al índice, que es una COTA INFERIOR. Pedir \`min_mcap_b: ${args.min_mcap_b}\` es pedir un dato que no tenemos — no es que ninguno llegue (varios son de cientos de miles de millones). Filtrá por otra cosa, o usá \`min_mcap_b\` de 1 o menos, que la cota sí respalda.`,
        rows: 0, datos_faltantes: ['market cap medido'], market_cap_asumido: conCap.length, embudo,
      };
    }
    if (args.sector && !filas.some((f) => sectorDe(f.symbol) != null)) faltantes.push('sector');

    // EL CULPABLE: el primer filtro que dejó la lista en cero. Con seis filtros
    // encadenados, decir "ninguno cumple" sin decir CUÁL no cumple obliga al
    // modelo a probar de a uno, y cada prueba cuesta una llamada del
    // presupuesto.
    const culpable = embudo.find((e) => e.despues === 0) || null;

    if (faltantes.length) {
      return {
        text: `No se puede contestar: el universo de hoy no trae ${faltantes.join(' ni ')} para ninguno de los ${filas.length} nombres del tablero. NO significa que ninguno cumpla — significa que no tenemos ese dato en esta corrida. Probá con otro criterio.\nEmbudo: ${traza}`,
        rows: 0, datos_faltantes: faltantes, embudo,
      };
    }
    return {
      // El caveat del alcance va en LAS DOS ramas: que el screener mire el
      // tablero y no el universo entero es un límite que el PM tiene que saber
      // para interpretar cualquier cero, tenga culpable identificado o no.
      text: `Ningún nombre del universo cumple esos criterios hoy. (El screener filtra sobre los ${filas.length} nombres que el tablero cubre, no sobre el universo entero: los que no están en ningún extremo del tablero no se evalúan.)`
        + (culpable
          ? `\nEL FILTRO QUE SE LLEVÓ LOS ÚLTIMOS NOMBRES: \`${culpable.filtro}=${culpable.valor}\` (${culpable.antes} → 0). Aflojá ESE criterio, no los otros.\nEmbudo completo: ${traza}.`
          : ''),
      rows: 0, embudo,
    };
  }
  const header = `${r.length} nombre(s). Columnas: TICKER precio cambio_1d RVOL dist_máx52s`;
  const rows = r.map((f) => `${f.symbol} ${n2(f.price)} ${sg(f.change_pct)}% rv${f.rvol ?? '—'} ${sg(f.pct_from_high)}%`);
  const t = truncateRows(rows, { header });
  return { text: t.text, rows: t.shown, truncated: t.truncated };
}

export async function runNoticias(args, ctx) {
  const dias = args.days || 2;
  const start = new Date(ctx.now.getTime() - dias * 86400000).toISOString();
  // ── LA BÚSQUEDA POR TEMA MIRABA 50 TITULARES ───────────────────────
  // Y después decía "sin titulares para el tema Hormuz". Eso se lee como "no
  // hay noticias de Hormuz" cuando lo que pasaba es "no estaba entre los 50 más
  // recientes" — una afirmación fuerte sobre una muestra chica, que es
  // exactamente la clase de error que el resto del sistema evita.
  //
  // Por tema se paginan 4 páginas (200 titulares). Por ticker alcanza con una:
  // el feed ya viene filtrado por el servidor.
  const porTema = !!args.tema && !args.ticker;
  let items = [];
  try {
    items = await (ctx.deps.getNews || getNews)({
      symbols: args.ticker ? [args.ticker] : [], limit: 50, start, creds: ctx.creds,
      pages: porTema ? 4 : 1,
    });
  } catch (e) {
    return { text: `No se pudieron traer noticias: ${String((e && e.message) || e)}. No hay titulares para esta consulta — no significa que no haya noticias.`, rows: 0, error: true };
  }
  const buscados = items.length;
  if (args.tema) {
    // Se busca en el TITULAR Y en el RESUMEN. Un tema como "Hormuz" o "crypto"
    // aparece muchas veces en el cuerpo y no en el título, y buscar solo el
    // título devolvía cero sobre noticias que sí estaban ahí.
    const re = new RegExp(String(args.tema).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    items = items.filter((n) => re.test(n.headline) || re.test(n.summary || ''));
  }
  const coincidencias = items.length;
  items = items.slice(0, args.limit || 8);
  if (!items.length) {
    // EL CERO HONESTO: dice sobre cuántos se buscó. "Sin titulares" a secas no
    // distingue "no hay noticias" de "no miramos suficientes".
    return {
      text: args.tema
        ? `Ningún titular menciona "${args.tema}" entre los ${buscados} más recientes de los últimos ${dias} día(s) (se buscó en título y resumen). Eso NO significa que no haya pasado nada sobre el tema: significa que no está en esta ventana.`
        : `Sin titulares para ${args.ticker} en los últimos ${dias} día(s).`,
      rows: 0, buscados,
    };
  }
  const header = args.tema
    ? `${coincidencias} titular(es) mencionan "${args.tema}" de ${buscados} revisados, últimos ${dias} día(s):`
    : `${items.length} titular(es), últimos ${dias} día(s):`;
  const rows = items.map((n) => `${String(n.created_at || '').slice(0, 10)} [${(n.symbols || []).slice(0, 3).join(',') || '—'}] ${n.headline}`);
  const t = truncateRows(rows, { header });
  return { text: t.text, rows: t.shown, truncated: t.truncated };
}

export async function runFicha(args, ctx) {
  const tk = args.ticker;
  if (!tk) return { text: 'ficha necesita un ticker.', rows: 0, error: true };
  let dive = null;
  try {
    const r = await (ctx.deps.fetchDeepDive || fetchDeepDive)([tk], ctx.finnhubKey, ctx.now);
    dive = (r && r.data && r.data[tk]) || null;
  } catch (e) { /* best-effort: la parte de mercado igual sirve */ }

  const enTablero = filasDelTablero(ctx).find((f) => f.symbol === tk) || null;
  const w = (ctx.universe && ctx.universe.fifty_two_week && ctx.universe.fifty_two_week[tk]) || null;

  const lineas = [`FICHA ${tk}`];
  if (enTablero) lineas.push(`precio ${n2(enTablero.price)} · 1d ${sg(enTablero.change_pct)}% · RVOL ${enTablero.rvol ?? '—'}`);
  else lineas.push('precio: no está entre los nombres que el tablero cubre hoy (no es que no cotice — es que no está en ningún extremo del tablero).');
  if (w) lineas.push(`52 semanas: máx ${n2(w.high_52w)} (${sg(w.pct_from_high)}%) · mín ${n2(w.low_52w)} (+${n2(w.pct_from_low)}%)`);
  if (dive && dive.profile) lineas.push(`${dive.profile.name || ''} · ${dive.profile.industry || 'sector s/d'} · mcap ${dive.profile.marketCapM != null ? '$' + (dive.profile.marketCapM / 1000).toFixed(1) + 'B' : '—'}`);
  if (dive && dive.fundamentals) {
    const f = dive.fundamentals;
    lineas.push(`P/E ${n2(f.peTTM)} · P/S ${n2(f.psTTM)} · margen bruto ${sg(f.grossMarginTTM)}% · margen neto ${sg(f.netMarginTTM)}% · ROE ${sg(f.roeTTM)} · deuda/equity ${n2(f.debtToEquity)}`);
  }
  if (dive && dive.fundamentals_quality) lineas.push(`⚠ RATIOS MARCADOS como posible artefacto contable: ${JSON.stringify(dive.fundamentals_quality)}`);
  if (dive && dive.recommendation) {
    const r = dive.recommendation;
    lineas.push(`analistas: ${r.strongBuy ?? 0} strong buy / ${r.buy ?? 0} buy / ${r.hold ?? 0} hold / ${r.sell ?? 0} sell`);
  }
  for (const n of ((dive && dive.news) || []).slice(0, 5)) lineas.push(`  ${String(n.date || '').slice(0, 10)} ${n.headline}`);
  if (!dive) lineas.push('(sin cobertura de fundamentales para este nombre: los campos de negocio no están disponibles, no son cero.)');

  const t = truncateRows(lineas.slice(1), { header: lineas[0] });
  return { text: t.text, rows: t.shown, truncated: t.truncated };
}

export async function runSector(args, ctx) {
  const etf = args.etf;
  const def = SECTOR_ETFS.find((s) => s.etf === etf);
  if (!def) {
    return { text: `"${etf}" no es uno de los 11 ETFs de sector GICS. Los válidos: ${SECTOR_ETFS.map((s) => s.etf).join(', ')}.`, rows: 0, error: true };
  }
  const b = ctx.board;
  const s = b && (b.sectors || []).find((x) => x.etf === etf);
  const sectorDe = ctx.sectorOf || (() => null);
  const dentro = filasDelTablero(ctx).filter((f) => sectorDe(f.symbol) === etf)
    .sort((a, b2) => Math.abs(b2.change_pct || 0) - Math.abs(a.change_pct || 0));
  const header = s
    ? `${etf} ${def.name}: 1d ${sg(s.d1)}% · 5d ${sg(s.d5)}% · 1m ${sg(s.m1)}% (velas cerradas)`
    : `${etf} ${def.name}: sin retornos del ETF en esta corrida.`;
  if (!dentro.length) return { text: header + '\nNingún nombre de este sector aparece en el tablero hoy.', rows: 0 };
  const t = truncateRows(dentro.map((f) => `${f.symbol} ${n2(f.price)} ${sg(f.change_pct)}% rv${f.rvol ?? '—'}`), { header });
  return { text: t.text, rows: t.shown, truncated: t.truncated };
}

export const RUNNERS = { screener: runScreener, noticias: runNoticias, ficha: runFicha, sector: runSector };

// ── EL EJECUTOR, con presupuesto y caché ─────────────────────────────
// Crea un ejecutor con estado PARA UNA CORRIDA DE UN AGENTE: lleva la cuenta
// de llamadas, la secuencia journaleada y la caché.
//
// `budget` es el tope DURO. La llamada que se pasa NO se ejecuta y devuelve un
// resultado que se lo dice al modelo — no un silencio ni un error críptico.
export function createToolExecutor({
  budget = TOOL_BUDGET.fixed_round, board = null, universe = null, creds = null,
  finnhubKey = process.env.FINNHUB_API_KEY, now = new Date(), deps = {}, cache = true,
} = {}) {
  const sectorOf = deps.sectorOf || (() => null);
  const newsSymbols = new Set();
  for (const h of (board && board.headlines) || []) for (const s of h.symbols || []) newsSymbols.add(s);
  const marketCapOf = deps.marketCapOf || null;

  // Retornos y market cap salen del UNIVERSO, que ya los calculó y los guardó.
  // Se leen de ahí en vez de pedirlos de nuevo: la corrida del PM no puede
  // pagar 600 consultas para contestar un filtro.
  const retornosOf = deps.retornosOf
    || ((sym) => ((universe && universe.retornos) || {})[String(sym || '').toUpperCase()] || null);
  const capOf = marketCapOf
    || ((sym) => ((universe && universe.market_caps) || {})[String(sym || '').toUpperCase()] ?? null);
  // Los nombres a los que se les ASUMIÓ el piso de $1B por pertenecer al índice.
  // Para ellos el market cap es una COTA INFERIOR, no una medición.
  const asumidos = new Set(((universe && universe.market_caps_asumidos) || []).map((x) => String(x || '').toUpperCase()));
  const capEsAsumido = deps.capEsAsumido || ((sym) => asumidos.has(String(sym || '').toUpperCase()));
  const ctx = { board, universe, creds, finnhubKey, now, deps, sectorOf, newsSymbols, marketCapOf: capOf, capEsAsumido, retornosOf };
  const sequence = [];
  // DOS CONTADORES, Y LA DIFERENCIA ES LA MITAD DEL BUG REPORTADO.
  //   `used`     = llamadas EJECUTADAS. Nunca puede pasar del techo.
  //   `intentos` = todo lo que el modelo pidió, incluidos los rechazos por
  //                presupuesto agotado y por herramienta inexistente.
  // Antes había uno solo que contaba las dos cosas, así que `tools_used: 15`
  // con `tools_max: 8` se leía como "el techo no se aplicó" cuando en realidad
  // 8 se ejecutaron y 7 se rechazaron. Los intentos importan —son parte de cómo
  // investigó, y un modelo que pide 7 veces después de quedarse sin cupo está
  // diciendo algo— pero mezclarlos en el mismo número hace ilegible el techo.
  let used = 0;
  let intentos = 0;

  return {
    get used() { return used; },
    get intentos() { return intentos; },
    get remaining() { return Math.max(0, budget - used); },
    get sequence() { return sequence; },
    budget,

    async call(name, rawArgs) {
      const t0 = Date.now();

      // ── EL TOPE, aplicado acá y no en el prompt ──
      //
      // EL BUG QUE ESTO ARREGLA (reportado el 2026-09-15): con `tools_max: 8`
      // los agentes hicieron 11, 15 y 10 llamadas. El techo SÍ estaba aplicado
      // —el chequeo de acá abajo— pero NO era atómico: entre el `if (used >=
      // budget)` y el `used++` había dos `await` (la caché y el runner), y el
      // loop ejecuta TODAS las herramientas de una vuelta EN PARALELO con
      // `Promise.all`.
      //
      // Así que si el modelo pedía 5 herramientas con `used` en 7 y el techo en
      // 8, las cinco evaluaban `7 >= 8` → false ANTES de que ninguna
      // incrementara, las cinco pasaban, y `used` terminaba en 12.
      //
      // LA CURA es reservar el cupo EN EL MISMO TICK del chequeo: JavaScript es
      // de un solo hilo, así que mientras no haya un `await` entre el `if` y el
      // `++`, la reserva es atómica. Por eso `n` se calcula acá arriba y no
      // después del trabajo.
      intentos++;
      if (used >= budget) {
        const text = `PRESUPUESTO DE HERRAMIENTAS AGOTADO: ya usaste las ${budget} llamadas de esta corrida. No se ejecutó nada. Decidí con lo que ya tenés — el tablero sigue completo en el contexto.`;
        // El intento se journalea (es parte de cómo investigó) pero NO consume
        // cupo: `used` se queda en el techo.
        sequence.push({ intento: intentos, tool: name, args: rawArgs, refused: 'budget_exhausted', ms: 0 });
        return { text, budget_exhausted: true };
      }

      // RESERVA ATÓMICA DEL CUPO. Todo lo que sigue puede tener `await`; el
      // contador ya está incrementado, así que una llamada paralela que entre
      // ahora ve el número correcto.
      const n = ++used;

      const runner = RUNNERS[name];
      if (!runner) {
        const text = `No existe una herramienta llamada "${name}". Las disponibles son: ${Object.keys(RUNNERS).join(', ')}.`;
        sequence.push({ n, intento: intentos, tool: name, args: rawArgs, refused: 'unknown_tool', ms: 0 });
        return { text, unknown_tool: true };
      }

      const { args, notes } = clampArgs(name, rawArgs);
      const key = cacheKey(name, args);

      // ── CACHÉ POR CONTENIDO ──
      // `noticias` se cachea igual por día: dentro de una corrida el feed no
      // cambia, y entre corridas del mismo día el `days` del argumento ya
      // distingue las ventanas. Un TTL por hora agregaría una dimensión de
      // caché para ahorrar poco.
      let hit = null;
      if (cache) hit = await readDayCache(key, now).catch(() => null);

      let out;
      let source = 'cache';
      if (hit && hit.payload && hit.payload.text) {
        out = hit.payload;
      } else {
        source = 'run';
        try {
          out = await runner(args, ctx);
        } catch (e) {
          out = { text: `La herramienta falló: ${String((e && e.message) || e)}. No hay resultado para esta consulta.`, rows: 0, error: true };
        }
        if (cache && !out.error) await writeDayCache(key, out, now).catch(() => {});
      }

      let text = out.text;
      if (notes.length) text += `\n(argumentos ajustados: ${notes.join('; ')})`;

      sequence.push({
        n, intento: intentos, tool: name, args, ms: Date.now() - t0, source,
        rows: out.rows ?? null, truncated: !!out.truncated, error: !!out.error,
        // El resultado COMPLETO, no el resumen: sin esto el replay no puede
        // reproducir la corrida — el modelo decidió mirando algo que no
        // guardamos. Ver el encabezado.
        result: text,
        tokens_est: estimateTokens(text),
        notes: notes.length ? notes : undefined,
      });
      return { text, ...out };
    },

    // Lo que se publica en /liga: la secuencia SIN los resultados completos.
    // "Buscó semis con RVOL alto → leyó las noticias de NVDA → pidió la ficha de
    // AMD → no compró ninguna" es una historia; 8 volcados de datos no lo son.
    summary() {
      return sequence.map((s) => ({
        n: s.n, tool: s.tool, args: s.args, ms: s.ms,
        rows: s.rows, truncated: s.truncated,
        ...(s.refused ? { refused: s.refused } : {}),
        ...(s.error ? { error: true } : {}),
      }));
    },
  };
}
