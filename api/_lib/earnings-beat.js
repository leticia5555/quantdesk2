// ═══════════════════════════════════════════════════════════════════
// api/_lib/earnings-beat.js — lectura del censo "earnings-beat" (Fase 0).
//
// Pregunta del experimento: ¿QuantDesk predice beat/miss de EPS mejor que
// Polymarket? Ver docs/earnings-beat-scope.md.
//
// TODO ACÁ ES PURO: sin fetch, sin DB, sin Date.now() escondido. Entra JSON
// crudo de Gamma/CLOB y filas de Neon, sale estructura normalizada. Así el
// censo se testea con fixtures (tests/earnings-beat.test.mjs) y no con red —
// regla de la casa: los tests no salen a internet.
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO: no hay una línea de modelo. La
// Fase 0 es censo y smoke; el modelo no se escribe hasta que la Fase 0 pase.
// Lo único de Fase 2 que vive acá son los CRITERIOS — congelados ANTES de ver
// un solo dato, para que mover una portería después se vea en el diff.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────── CRITERIOS (CONGELADOS, Fase 2) ───────────────────
// Fijados antes de correr nada. El endpoint los exporta en cada respuesta.
// Si alguien los mueve después de ver los números, el diff lo delata.
const CRITERIOS = {
  version: 1,

  // ── Candado de muestra: por debajo de esto el veredicto es INCONCLUSO,
  // no "casi". Un puñado de mercados es ruido con forma de resultado.
  min_mercados_cruzados: 100,   // mercados con precio del Yes a T-24h Y cruce con pead_earnings
  min_apuestas: 30,             // apuestas simuladas mínimas para leer el neto

  // ── Lectura: el modelo tiene que ganarle al baseline barato.
  // Brier (menor = mejor) contra "tasa histórica de beats por empresa" en OOS.
  // Baselines obligatorios: "siempre sí" y "tasa por empresa".
  baselines: ['siempre_si', 'tasa_por_empresa'],

  // ── Edge: además de ganarle al baseline, ganarle al MERCADO.
  umbral_desacuerdo: 0.15,      // apuesta solo si |modelo − mercado| ≥ 15 pts
  costo_por_apuesta: 0.03,      // 3% por apuesta (spread + fees), aplicado a cada una

  // ── Corte temporal. Entrena ≤ corte, prueba corte → hoy.
  // Es el mismo punto donde arranca la ventana de ~3 años del PEAD
  // (docs/pead-backtest-scope.md §FASE 2), para no tener dos verdades.
  corte_entrenamiento: /* date-lint-ok: corte de entrenamiento/prueba congelado por diseño, un hecho fijo — no es una referencia a "hoy" */ '2023-08-31',

  // ── Cruce y precio.
  tolerancia_dias_cruce: 1,     // mercado ↔ pead_earnings por símbolo + fecha ±1 día
  horas_antes_precio: 24,       // precio del Yes a T-24h de la resolución
  tolerancia_rancio_horas: 12,  // si el último tick es más viejo que esto, se marca rancio

  // ── Consenso. Polymarket resuelve contra SU consenso; nosotros solo
  // tenemos estimatedEPS de Alpha Vantage. Los beats de ≤ $0.01 se etiquetan
  // "frontera" y se reportan aparte: ahí es donde las dos definiciones se
  // pueden separar y un acierto puede ser un artefacto de la fuente.
  frontera_eps: 0.01,
};

// ─────────────────── utilidades puras ───────────────────

function num(v) {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Gamma manda varios campos como STRING con JSON adentro
// (outcomes: "[\"Yes\", \"No\"]"). Tolera ambas formas.
function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (e) { return null; }
  }
  return null;
}

function isoDia(v) {
  if (!v) return null;
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function ts(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;   // segundos → ms
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// Diferencia en días entre dos 'YYYY-MM-DD' (UTC, sin husos de por medio).
function diasEntre(a, b) {
  const da = Date.parse(a + 'T00:00:00Z');
  const db = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((da - db) / 86400000);
}

// minúsculas, sin acentos, sin puntuación (conserva $ y &: "$NVDA", "P&G").
function normalizaTexto(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9$&.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────── normalización de un mercado de Gamma ───────────────────

// De JSON crudo de Gamma a la forma que usa el censo. NO asume que los campos
// existan: lo que falte queda null y `claves` guarda los nombres reales que
// vinieron, para que el censo reporte el esquema observado en vez de el que
// yo supuse.
function normalizaMercado(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const outcomes = jsonArray(raw.outcomes) || [];
  const precios = (jsonArray(raw.outcomePrices) || []).map(num);
  const tokens = (jsonArray(raw.clobTokenIds) || []).map((t) => (t === null || t === undefined ? null : String(t)));
  // Fecha de resolución: endDate es la declarada; closedTime/closed_time es la
  // real cuando existe. Se guardan las dos y el censo dice cuál usó.
  const finDeclarado = raw.endDate || raw.end_date_iso || raw.endDateIso || null;
  const finReal = raw.closedTime || raw.closed_time || null;
  return {
    id: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    slug: raw.slug || null,
    pregunta: raw.question || raw.title || null,
    descripcion: raw.description || null,
    outcomes,
    precios_outcome: precios,
    token_ids: tokens,
    fin_declarado: finDeclarado ? String(finDeclarado) : null,
    fin_real: finReal ? String(finReal) : null,
    fin: finReal ? String(finReal) : finDeclarado ? String(finDeclarado) : null,
    cerrado: raw.closed === true || raw.closed === 'true',
    activo: raw.active === true || raw.active === 'true',
    uma: raw.umaResolutionStatus || raw.uma_resolution_status || null,
    volumen: num(raw.volumeNum) ?? num(raw.volume) ?? null,
    liquidez: num(raw.liquidityNum) ?? num(raw.liquidity) ?? null,
    claves: Object.keys(raw),
  };
}

// Índice del outcome "Yes". Sin Yes explícito → null (y el censo lo cuenta:
// un mercado de earnings sin token Yes no sirve para el estudio).
function indiceYes(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  const i = outcomes.findIndex((o) => typeof o === 'string' && /^\s*(yes|sí|si)\s*$/i.test(o));
  return i >= 0 ? i : null;
}

// Token del Yes (para pedirle el historial al CLOB).
function tokenYes(m) {
  const i = indiceYes(m.outcomes);
  if (i === null || !Array.isArray(m.token_ids) || !m.token_ids[i]) return null;
  return m.token_ids[i];
}

// Outcome resuelto leído de outcomePrices: en un mercado resuelto el ganador
// vale 1 y el perdedor 0. Si ninguno está pegado a los extremos, NO está
// resuelto (o está en disputa) y se devuelve null en vez de adivinar.
function outcomeResuelto(m, { umbral = 0.99 } = {}) {
  const precios = m && Array.isArray(m.precios_outcome) ? m.precios_outcome : [];
  const outcomes = m && Array.isArray(m.outcomes) ? m.outcomes : [];
  if (!precios.length || precios.length !== outcomes.length) return null;
  const ganadores = [];
  for (let i = 0; i < precios.length; i++) {
    if (precios[i] !== null && precios[i] >= umbral) ganadores.push(i);
  }
  if (ganadores.length !== 1) return null;
  const i = ganadores[0];
  const yes = indiceYes(outcomes);
  return {
    outcome: outcomes[i],
    es_yes: yes !== null ? i === yes : null,
    via: 'outcomePrices',
  };
}

// ─────────────────── ¿es un mercado de earnings? ───────────────────

// Señales sobre pregunta + slug. Se devuelve CUÁL matcheó para que el censo
// reporte la composición y se pueda auditar el filtro sin adivinar.
const SENALES_EARNINGS = [
  { nombre: 'earnings', re: /\bearnings\b/i },
  { nombre: 'eps', re: /\beps\b/i },
  { nombre: 'beat_estimates', re: /\bbeat\b[^.?]{0,40}\b(estimates?|expectations?|consensus|street)\b/i },
  { nombre: 'report_quarter', re: /\breports?\b[^.?]{0,30}\bq[1-4]\b/i },
];

function pareceEarnings(m) {
  const texto = [m && m.pregunta, m && m.slug, m && m.descripcion].filter(Boolean).join(' • ');
  if (!texto) return { si: false, senales: [] };
  const senales = SENALES_EARNINGS.filter((s) => s.re.test(texto)).map((s) => s.nombre);
  return { si: senales.length > 0, senales };
}

// ─────────────────── símbolo ───────────────────

// Alias nombre→ticker. Cubre las empresas que Polymarket nombra por nombre
// comercial y no por ticker. NO se limita al universo v0 del PEAD a propósito:
// el censo quiere contar TODOS los mercados de earnings y, aparte, cuántos
// caen en nuestros símbolos. Dos números distintos, dos preguntas distintas.
const ALIAS_EMPRESAS = {
  'nvidia': 'NVDA', 'apple': 'AAPL', 'microsoft': 'MSFT', 'alphabet': 'GOOGL', 'google': 'GOOGL',
  'amazon': 'AMZN', 'amazon.com': 'AMZN', 'meta': 'META', 'meta platforms': 'META', 'facebook': 'META',
  'tesla': 'TSLA', 'netflix': 'NFLX', 'broadcom': 'AVGO', 'oracle': 'ORCL', 'salesforce': 'CRM',
  'adobe': 'ADBE', 'advanced micro devices': 'AMD', 'intel': 'INTC', 'qualcomm': 'QCOM',
  'texas instruments': 'TXN', 'cisco': 'CSCO', 'accenture': 'ACN', 'servicenow': 'NOW', 'intuit': 'INTU',
  'micron': 'MU', 'applied materials': 'AMAT', 'lam research': 'LRCX', 'palo alto networks': 'PANW',
  'marvell': 'MRVL', 'fortinet': 'FTNT', 'synopsys': 'SNPS', 'cadence': 'CDNS', 'arm': 'ARM',
  'super micro': 'SMCI', 'supermicro': 'SMCI', 'dell': 'DELL', 'hp': 'HPQ', 'snowflake': 'SNOW',
  'palantir': 'PLTR', 'coinbase': 'COIN', 'robinhood': 'HOOD', 'microstrategy': 'MSTR', 'strategy': 'MSTR',
  'uber': 'UBER', 'lyft': 'LYFT', 'airbnb': 'ABNB', 'booking': 'BKNG', 'doordash': 'DASH',
  'spotify': 'SPOT', 'shopify': 'SHOP', 'block': 'XYZ', 'paypal': 'PYPL', 'visa': 'V', 'mastercard': 'MA',
  'jpmorgan': 'JPM', 'jp morgan': 'JPM', 'goldman sachs': 'GS', 'morgan stanley': 'MS',
  'bank of america': 'BAC', 'wells fargo': 'WFC', 'citigroup': 'C', 'american express': 'AXP',
  'blackrock': 'BLK', 'charles schwab': 'SCHW', 'capital one': 'COF',
  'walmart': 'WMT', 'costco': 'COST', 'target': 'TGT', 'home depot': 'HD', 'lowe.s': 'LOW',
  'nike': 'NKE', 'starbucks': 'SBUX', 'mcdonald.s': 'MCD', 'chipotle': 'CMG', 'tjx': 'TJX',
  'disney': 'DIS', 'comcast': 'CMCSA', 'verizon': 'VZ', 't-mobile': 'TMUS', 'at&t': 'T',
  'coca-cola': 'KO', 'coca cola': 'KO', 'pepsico': 'PEP', 'pepsi': 'PEP', 'procter & gamble': 'PG',
  'philip morris': 'PM', 'altria': 'MO', 'mondelez': 'MDLZ', 'colgate': 'CL',
  'eli lilly': 'LLY', 'johnson & johnson': 'JNJ', 'unitedhealth': 'UNH', 'pfizer': 'PFE',
  'merck': 'MRK', 'abbvie': 'ABBV', 'amgen': 'AMGN', 'gilead': 'GILD', 'moderna': 'MRNA',
  'thermo fisher': 'TMO', 'abbott': 'ABT', 'danaher': 'DHR', 'bristol': 'BMY', 'cvs': 'CVS',
  'intuitive surgical': 'ISRG', 'vertex': 'VRTX',
  'exxon': 'XOM', 'exxonmobil': 'XOM', 'chevron': 'CVX', 'conocophillips': 'COP', 'schlumberger': 'SLB',
  'boeing': 'BA', 'caterpillar': 'CAT', 'general electric': 'GE', 'ge aerospace': 'GE',
  'honeywell': 'HON', 'lockheed': 'LMT', 'raytheon': 'RTX', 'rtx': 'RTX', 'deere': 'DE',
  'union pacific': 'UNP', 'ups': 'UPS', 'fedex': 'FDX', 'ford': 'F', 'general motors': 'GM',
  'rivian': 'RIVN', 'lucid': 'LCID', 'marathon digital': 'MARA', 'riot': 'RIOT',
};

// Índice de nombres ordenado por longitud descendente: "advanced micro devices"
// tiene que ganarle a "amd" y "general motors" a "gm". El orden es la defensa
// contra el match corto que se come al largo.
function construyeIndiceNombres({ alias = ALIAS_EMPRESAS, nombres = null, universo = null } = {}) {
  const entradas = [];
  for (const [nombre, symbol] of Object.entries(alias || {})) {
    entradas.push({ clave: normalizaTexto(nombre), symbol, via: 'alias' });
  }
  // nombres: { SYMBOL: 'Apple Inc' } — el symbol map de Finnhub (earnings.js).
  // Se recorta al universo si se pasa uno: un mapa de ~30k nombres mete
  // coincidencias absurdas ("Meta Materials" por "meta").
  if (nombres && typeof nombres === 'object') {
    for (const [symbol, nombre] of Object.entries(nombres)) {
      if (universo && !universo.has(symbol)) continue;
      const limpio = normalizaTexto(String(nombre || '')
        .replace(/\b(inc|corp|corporation|company|co|plc|ltd|limited|holdings|group|class [a-c]|common stock)\b/gi, ''));
      if (limpio.length < 4) continue;
      entradas.push({ clave: limpio, symbol, via: 'symbol_map' });
    }
  }
  const vistas = new Set();
  return entradas
    .filter((e) => e.clave && !vistas.has(e.clave + '|' + e.symbol) && vistas.add(e.clave + '|' + e.symbol))
    .sort((a, b) => b.clave.length - a.clave.length);
}

// Ticker explícito: solo $NVDA o (NVDA). Un token suelto en mayúsculas se
// acepta únicamente si tiene ≥3 letras Y está en el universo — "T", "V" y "MA"
// aparecen en cualquier título en inglés y no son Ford, Visa ni Mastercard.
function tickerExplicito(texto, universo) {
  if (!texto) return null;
  const m = /\$([A-Za-z]{1,5})\b/.exec(texto) || /\(([A-Z]{1,5})\)/.exec(texto);
  if (m) return m[1].toUpperCase();
  if (universo) {
    for (const tok of String(texto).match(/\b[A-Z]{3,5}\b/g) || []) {
      if (universo.has(tok)) return tok;
    }
  }
  return null;
}

// Resuelve el símbolo de un mercado. Devuelve también POR DÓNDE lo resolvió:
// un censo que no dice cómo resolvió sus nombres no es auditable.
function resuelveSimbolo(m, indice, universo = null) {
  const textos = [m && m.pregunta, m && m.slug, m && m.descripcion].filter(Boolean);
  const crudo = textos.join(' • ');
  const explicito = tickerExplicito(crudo, universo);
  if (explicito) return { symbol: explicito, via: 'ticker', coincidencia: explicito };
  const texto = ' ' + normalizaTexto(crudo.replace(/-/g, ' ')) + ' ';
  const hits = [];
  for (const e of indice || []) {
    // límite de palabra a ambos lados: "meta" no matchea "metallurgy".
    if (texto.includes(' ' + e.clave + ' ') || texto.includes(' ' + e.clave + '.')) hits.push(e);
  }
  if (!hits.length) return { symbol: null, via: null, coincidencia: null, ambiguo: false };
  // El índice viene ordenado por longitud: gana el nombre más largo. Si además
  // matchearon OTROS símbolos, el mercado queda marcado `ambiguo` — un nombre
  // corto ("meta") se mete adentro de otro nombre ("Meta Materials") y acá no
  // hay forma de saberlo. Se reporta para revisar a ojo; no se resuelve a la
  // brava. La Fase 1 lo cierra si Gamma expone el ticker en algún campo
  // (por eso el censo publica `esquema_observado`).
  const otros = [...new Set(hits.map((h) => h.symbol))].filter((s) => s !== hits[0].symbol);
  return { symbol: hits[0].symbol, via: hits[0].via, coincidencia: hits[0].clave, ambiguo: otros.length > 0, otros };
}

// ─────────────────── consenso EPS en la descripción ───────────────────

// Polymarket resuelve contra el consenso que DECLARA en la descripción del
// mercado. Ese número es el que hay que leer: no es necesariamente el
// estimatedEPS de Alpha Vantage, y toda la comparación depende de saberlo.
// Patrones ordenados de más específico a más laxo; se devuelve cuál matcheó.
const PATRONES_CONSENSO = [
  { nombre: 'consensus_monto', re: /\bconsensus\b[^.$]{0,60}?\(?\$\s*(-?\d+(?:\.\d+)?)\)?/i },
  { nombre: 'estimate_monto', re: /\b(?:estimate|estimates|forecast|expectation|expected)\b[^.$]{0,60}?\(?\$\s*(-?\d+(?:\.\d+)?)\)?/i },
  { nombre: 'eps_monto', re: /\beps\b[^.$]{0,60}?\(?\$\s*(-?\d+(?:\.\d+)?)\)?/i },
  { nombre: 'monto_por_accion', re: /\$\s*(-?\d+(?:\.\d+)?)\s*(?:per share|\/share|a share)/i },
];

function extraeConsensoEps(texto) {
  if (!texto || typeof texto !== 'string') return null;
  for (const p of PATRONES_CONSENSO) {
    const m = p.re.exec(texto);
    if (!m) continue;
    const valor = num(m[1]);
    if (valor === null) continue;
    // Paréntesis a la izquierda del $ = negativo en notación contable.
    const negativo = /\(\s*\$?\s*$/.test(texto.slice(0, m.index + m[0].indexOf('$')));
    const inicio = Math.max(0, m.index - 40);
    return {
      valor: negativo ? -Math.abs(valor) : valor,
      patron: p.nombre,
      fragmento: texto.slice(inicio, Math.min(texto.length, m.index + m[0].length + 40)).replace(/\s+/g, ' ').trim(),
    };
  }
  return null;
}

// ─────────────────── precio del Yes a T-24h ───────────────────

// history: [{t, p}] del CLOB (t en segundos o ms — se detecta).
// Se toma el ÚLTIMO tick con t ≤ resolución − 24h. Nunca uno posterior: ese
// sería el precio del futuro y el estudio entero se cae.
function precioEnT24h(history, finMs, { horas = CRITERIOS.horas_antes_precio, toleranciaHoras = CRITERIOS.tolerancia_rancio_horas } = {}) {
  const puntos = (Array.isArray(history) ? history : [])
    .map((x) => ({ t: ts(x && (x.t !== undefined ? x.t : x.timestamp)), p: num(x && (x.p !== undefined ? x.p : x.price)) }))
    .filter((x) => x.t !== null && x.p !== null)
    .sort((a, b) => a.t - b.t);
  if (!puntos.length) return { precio: null, motivo: 'historial_vacio' };
  if (!finMs) return { precio: null, motivo: 'sin_fecha_de_resolucion' };

  const objetivo = finMs - horas * 3600 * 1000;
  let elegido = null;
  for (const pt of puntos) {
    if (pt.t <= objetivo) elegido = pt; else break;
  }
  if (!elegido) {
    return {
      precio: null, motivo: 'sin_ticks_antes_de_t24h',
      primer_tick: new Date(puntos[0].t).toISOString(),
      objetivo: new Date(objetivo).toISOString(),
    };
  }
  const horasAntes = (finMs - elegido.t) / 3600000;
  return {
    precio: elegido.p,
    ts: new Date(elegido.t).toISOString(),
    objetivo: new Date(objetivo).toISOString(),
    horas_antes_real: Number(horasAntes.toFixed(2)),
    // rancio = el último tick previo a T-24h es MUY viejo: el "precio a 24h"
    // existe pero no dice lo que creemos. Se reporta, no se descarta en silencio.
    rancio: horasAntes > horas + toleranciaHoras,
    puntos: puntos.length,
  };
}

// ─────────────────── cruce con pead_earnings ───────────────────

// mercados: [{symbol, fecha_resolucion (YYYY-MM-DD), ...}]
// filas:    [{symbol, reported_date}] de Neon.
// Casa por símbolo y fecha ±tolerancia; con varios candidatos gana el más
// cercano. La fecha de resolución NO es la de reporte (el mercado puede
// resolver un día después), por eso hay tolerancia y por eso se guarda `dias`.
function cruzaConPead(mercados, filas, { tolerancia = CRITERIOS.tolerancia_dias_cruce } = {}) {
  const porSimbolo = new Map();
  for (const f of filas || []) {
    const s = String(f.symbol || '').toUpperCase();
    if (!s) continue;
    const d = isoDia(f.reported_date);
    if (!d) continue;
    if (!porSimbolo.has(s)) porSimbolo.set(s, []);
    porSimbolo.get(s).push(d);
  }
  const salida = [];
  for (const m of mercados || []) {
    const s = m && m.symbol ? String(m.symbol).toUpperCase() : null;
    const fecha = m && isoDia(m.fecha_resolucion);
    if (!s || !fecha) { salida.push({ ...m, cruce: null, motivo_sin_cruce: 'sin_simbolo_o_fecha' }); continue; }
    const candidatos = porSimbolo.get(s) || [];
    let mejor = null;
    for (const d of candidatos) {
      const dias = diasEntre(fecha, d);
      if (dias === null || Math.abs(dias) > tolerancia) continue;
      if (!mejor || Math.abs(dias) < Math.abs(mejor.dias)) mejor = { reported_date: d, dias };
    }
    salida.push({
      ...m,
      cruce: mejor,
      motivo_sin_cruce: mejor ? null : candidatos.length ? 'fecha_fuera_de_tolerancia' : 'simbolo_no_esta_en_pead_earnings',
    });
  }
  return salida;
}

// ─────────────────── ¿hay fuente point-in-time de revisiones? ───────────────────

// Regla dura, decidida ANTES de probar y NO relajada después: una fuente sirve
// para revisiones solo si da (a) una FECHA DE CORTE por estimado —una fecha de
// verdad, no un número— y (b) más de un VALOR del estimado para el MISMO
// período con fechas de corte distintas. Un endpoint que devuelve "el estimado
// de hoy" para trimestres futuros NO es point-in-time: no permite saber qué se
// creía antes del reporte, que es justo lo que el modelo usaría.
//
// ── CICATRIZ (falso positivo de la primera corrida) ────────────────────────
// La primera versión marcó `pit: true` una respuesta que NO es point-in-time.
// Dos bugs encadenados:
//   1. la clave de corte se buscaba con /revision/, así que un campo de
//      CONTEO de revisiones (`eps_revisions_last_7_days_up`) pasaba por
//      "fecha de corte";
//   2. no se validaba que el VALOR fuera una fecha, así que dos filas del
//      mismo período con conteos distintos parecían "dos cortes".
// Un conteo de cuántos analistas revisaron arriba/abajo en los últimos 7/30
// días es un snapshot de HOY: no dice qué se creía antes de un reporte de
// 2024, que es lo único que serviría. Ahora se exige que el valor PAREZCA
// FECHA y se descartan explícitamente las claves de conteo — y la sonda
// devuelve `fila_cruda` para que la decisión se pueda revisar a ojo en vez de
// confiar en la heurística.
const CLAVE_CORTE = /(as[_-]?of|asof|updated_?(at|on)?|revision_?date|revised_?(at|on|date)|snapshot|retrieved|effective_?date|estimate_?date)/i;
// Claves que PARECEN de revisión pero son conteos/agregados, no fechas de corte.
const CLAVE_CONTEO = /(count|total|number|_up$|_down$|up_?\d|down_?\d|last_?\d+_?days|_high$|_low$|_average$|_avg$|analysts?)/i;
// Forma típica de "revisiones como conteo": el hallazgo que hay que nombrar.
const CLAVE_REVISION_CONTEO = /revisions?.*(up|down)|revisions?_?last_?\d+|(up|down).*revisions?/i;
const CLAVE_PERIODO = /(period|fiscal|quarter|horizon|date)/i;

function evaluaFuentePIT(body) {
  const filas = Array.isArray(body) ? body
    : body && Array.isArray(body.data) ? body.data
    : body && Array.isArray(body.quarterlyEarnings) ? body.quarterlyEarnings
    : body && Array.isArray(body.estimates) ? body.estimates
    : null;
  const base = {
    tiene_fecha_de_corte: false, tiene_varios_valores_por_periodo: false,
    revisiones_como_conteo: false, filas: 0, claves: [], fila_cruda: null,
  };
  if (!filas || !filas.length) return { pit: false, motivo: 'sin_filas', ...base };

  const claves = Object.keys(filas[0] || {});
  const ev = {
    ...base,
    filas: filas.length,
    claves,
    // La fila cruda viaja SIEMPRE, no solo cuando falla: es lo que permite
    // desmentir a la heurística sin volver a pedirle nada a la fuente.
    fila_cruda: recortaFila(filas[0]),
    revisiones_como_conteo: claves.some((k) => CLAVE_REVISION_CONTEO.test(k)),
  };

  const claveCorte = claves.find((k) => CLAVE_CORTE.test(k) && !CLAVE_CONTEO.test(k) && esFecha(filas[0][k]));
  if (!claveCorte) {
    return {
      pit: false,
      motivo: ev.revisiones_como_conteo
        ? 'las_revisiones_vienen_como_CONTEOS_no_como_valores_fechados'
        : 'sin_fecha_de_corte_por_estimado',
      ...ev,
    };
  }
  ev.tiene_fecha_de_corte = true;

  const clavePeriodo = claves.find((k) => CLAVE_PERIODO.test(k) && k !== claveCorte);
  if (!clavePeriodo) return { pit: false, motivo: 'sin_clave_de_periodo', ...ev, clave_corte: claveCorte };

  // El valor que tiene que variar es el ESTIMADO, no cualquier campo: un
  // conteo distinto entre dos filas no convierte una foto en una serie.
  const claveValor = claves.find((k) => /(eps|estimate|value|avg|average)/i.test(k)
    && !CLAVE_REVISION_CONTEO.test(k) && k !== claveCorte && k !== clavePeriodo);

  const porPeriodo = new Map();
  for (const f of filas) {
    const k = String(f[clavePeriodo]);
    if (!porPeriodo.has(k)) porPeriodo.set(k, new Map());
    if (esFecha(f[claveCorte])) porPeriodo.get(k).set(String(f[claveCorte]), claveValor ? f[claveValor] : null);
  }
  ev.tiene_varios_valores_por_periodo = [...porPeriodo.values()].some((m) => m.size > 1);

  return ev.tiene_varios_valores_por_periodo
    ? { pit: true, motivo: null, ...ev, clave_corte: claveCorte, clave_periodo: clavePeriodo, clave_valor: claveValor || null }
    : { pit: false, motivo: 'un_solo_corte_por_periodo_no_es_point_in_time', ...ev, clave_corte: claveCorte, clave_periodo: clavePeriodo };
}

// ¿El VALOR parece una fecha? No basta con que la clave se llame bonito.
function esFecha(v) {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  if (typeof v !== 'string') return false;              // un número NO es fecha acá
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) && !/^\d{2}\/\d{2}\/\d{4}/.test(s)) return false;
  return !Number.isNaN(new Date(s).getTime());
}

// La fila cruda se muestra, pero acotada: un censo no es un volcado.
function recortaFila(fila, maxClaves = 24, maxLargo = 80) {
  if (!fila || typeof fila !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(fila).slice(0, maxClaves)) {
    out[k] = typeof v === 'string' && v.length > maxLargo ? v.slice(0, maxLargo) + '…' : v;
  }
  return out;
}

// ─────────────────── descubrimiento dirigido ───────────────────

// Frases REALES con las que Polymarket redacta estos mercados. No son
// palabras clave inventadas: salen de mercados que existen y ya resolvieron.
// El barrido por paginación no sirve para encontrarlos (ver el tope de offset
// en docs/earnings-beat-scope.md §1.1); la búsqueda dirigida sí.
const FRASES_BUSQUEDA = [
  'beat quarterly earnings',
  'beat its quarterly EPS estimate',
  'quarterly EPS estimate',
  'earnings',
];

// Tags/categorías que trae un mercado crudo, en cualquiera de las formas en
// que Gamma los cuelga (del mercado, o del evento que lo contiene).
function extraeTags(raw) {
  const out = [];
  const empuja = (t) => {
    if (!t) return;
    if (typeof t === 'string') { out.push({ id: null, slug: t, label: t }); return; }
    if (typeof t !== 'object') return;
    const id = t.id !== undefined && t.id !== null ? String(t.id) : null;
    const slug = t.slug || t.label || t.name || null;
    if (id || slug) out.push({ id, slug, label: t.label || t.name || slug });
  };
  for (const t of (Array.isArray(raw && raw.tags) ? raw.tags : [])) empuja(t);
  for (const ev of (Array.isArray(raw && raw.events) ? raw.events : [])) {
    for (const t of (Array.isArray(ev && ev.tags) ? ev.tags : [])) empuja(t);
  }
  const vistos = new Set();
  return out.filter((t) => {
    const k = (t.id || '') + '|' + (t.slug || '');
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

// Desde UN mercado de earnings, los identificadores que pueden llevar al resto
// del racimo: su evento, su serie, su grupo. Si alguno existe, es el segundo
// camino para enumerar sin paginar el catálogo entero.
function extraeCluster(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const ev = Array.isArray(raw.events) && raw.events.length ? raw.events[0] : null;
  const serie = Array.isArray(raw.series) && raw.series.length ? raw.series[0] : (raw.series || null);
  const id = (v) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    evento_id: id(raw.eventId) || id(ev && ev.id),
    evento_slug: raw.eventSlug || (ev && ev.slug) || null,
    serie_id: id(raw.seriesId) || id(serie && serie.id) || (typeof serie === 'string' ? serie : null),
    serie_slug: (serie && serie.slug) || (ev && ev.seriesSlug) || null,
    grupo: raw.groupItemTitle || (ev && ev.groupItemTitle) || null,
  };
}

// ─────────────────── resumen en español ───────────────────

// El censo se lee en el navegador (?format=md). Reporta lo que VIO, incluidos
// los fallos: una sonda en rojo es un resultado de Fase 0, no un accidente.
function resumenMarkdown(c) {
  const L = [];
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '—');

  L.push('# CENSO earnings-beat — FASE 0');
  L.push('');
  L.push(`Generado: ${c.generado_en || '—'} · ventana: ${c.ventana ? c.ventana.desde + ' → ' + c.ventana.hasta : '—'}`);
  L.push('');
  if (c.error) {
    L.push(`## FUENTE CAÍDA`);
    L.push('');
    L.push(c.error);
    L.push('');
  }

  L.push('## 1. ¿Contesta la API pública de Polymarket?');
  L.push('');
  L.push('| Estrategia | Endpoint | Status | HTTP | ms | Filas |');
  L.push('|---|---|---|---|---|---|');
  for (const s of c.sondas || []) {
    L.push(`| ${s.estrategia} | ${s.endpoint} | ${s.status} | ${s.http ?? '—'} | ${s.ms ?? '—'} | ${s.filas ?? '—'} |`);
  }
  L.push('');
  const conAuth = (c.sondas || []).filter((s) => s.status === 'auth');
  L.push(`**Auth:** ${conAuth.length ? 'SÍ la pide (' + conAuth.map((s) => s.endpoint).join(', ') + ')' : 'no la pidió en esta corrida — lectura pública.'}`);
  const rl = c.rate_limit || {};
  const hs = Object.entries(rl.headers_observados || {});
  L.push(`**Rate limit:** ${hs.length ? hs.map(([k, v]) => k + '=' + v).join(' · ') : 'sin headers de presupuesto'} · respuestas 429: ${rl.http_429 ?? 0}. ${rl.nota || ''}`);
  L.push('');

  const d = c.descubrimiento || {};
  L.push('## 2. Descubrimiento dirigido');
  L.push('');
  L.push(d.metodo || '—');
  L.push('');
  L.push('| Camino | Intento | Status | Filas |');
  L.push('|---|---|---|---|');
  for (const i of (d.busqueda && d.busqueda.intentos) || []) {
    L.push(`| búsqueda | "${i.frase || i.nota || '—'}" | ${i.status || '—'}${i.http ? '/' + i.http : ''} | ${i.filas ?? '—'} |`);
  }
  for (const i of (d.tags && d.tags.intentos) || []) {
    const etiqueta = i.tag !== undefined && i.pagina !== undefined ? `${i.tag} p${i.pagina}` : (i.nota || i.tag || '—');
    const filas = i.filas === undefined ? '—' : `${i.filas}${i.de_earnings !== undefined ? ' (' + i.de_earnings + ' de earnings)' : ''}`;
    L.push(`| tags | ${etiqueta} | ${i.status || '—'} | ${filas} |`);
  }
  for (const i of (d.cluster && d.cluster.intentos) || []) {
    L.push(`| racimo | ${i.via || i.nota || '—'} | ${i.status || '—'}${i.http ? '/' + i.http : ''} | ${i.filas ?? '—'} |`);
  }
  L.push('');
  const porCamino = Object.entries(d.mercados_de_earnings_por_camino || {});
  L.push(`**Mercados de earnings por camino:** ${porCamino.length ? porCamino.map(([k, v]) => k + '=' + v).join(' · ') : 'ninguno'}.`);
  if (d.estrategia_ganadora) {
    L.push('');
    L.push(`**Ganó \`${d.estrategia_ganadora.camino}\`** con ${d.estrategia_ganadora.mercados_de_earnings} mercados de earnings. Ése es el camino que hereda la Fase 1.`);
  }
  L.push('');

  // El tope de offset es un HECHO del censo: queda escrito para que no vuelva
  // a morder (la primera corrida lo leyó como "no hay mercados de earnings").
  const topes = c.topes_de_offset || [];
  L.push('### Tope de offset de Gamma (hecho del censo)');
  L.push('');
  if (!topes.length) {
    L.push('No se topó ningún 422 en esta corrida.');
  } else {
    L.push('| Endpoint | offset | limit | Mensaje |');
    L.push('|---|---|---|---|');
    for (const t of topes) L.push(`| ${t.endpoint} | ${t.offset ?? '—'} | ${t.limit ?? '—'} | ${(t.mensaje || '').slice(0, 70)} |`);
    L.push('');
    L.push('> **422 no es rate limit: es tope de offset.** Paginar el catálogo entero es imposible, y un barrido que ve ~500 de decenas de miles no puede concluir "no hay mercados de earnings" — eso sería ceguera del método, no un hallazgo.');
  }
  L.push('');
  const b = c.barrido || {};
  if (b.corrido) {
    L.push(`Barrido de control: páginas ${b.paginas ?? 0} · filas ${b.filas ?? 0} · corte: ${b.motivo_corte || '—'}.`);
  } else {
    L.push(`Barrido de control: **apagado** (${b.nota || 'no corrió'}).`);
  }
  L.push('');

  const n = c.conteos || {};
  L.push('## 3. ¿Hay mercados de earnings, con símbolo, consenso y outcome?');
  L.push('');
  L.push('| Qué | Cuántos | % |');
  L.push('|---|---|---|');
  L.push(`| Mercados de earnings en ventana | ${n.mercados_de_earnings_en_ventana ?? 0} | — |`);
  L.push(`| …resueltos (outcome legible) | ${n.resueltos ?? 0} | ${pct(n.resueltos, n.mercados_de_earnings_en_ventana)} |`);
  L.push(`| …con símbolo resuelto | ${n.con_simbolo ?? 0} | ${pct(n.con_simbolo, n.mercados_de_earnings_en_ventana)} |`);
  L.push(`| …en el universo v0 del PEAD (${n.universo_v0 ?? 0} símbolos) | ${n.en_universo_v0 ?? 0} | ${pct(n.en_universo_v0, n.mercados_de_earnings_en_ventana)} |`);
  L.push(`| …con consenso EPS en la descripción | ${n.con_consenso_en_descripcion ?? 0} | ${pct(n.con_consenso_en_descripcion, n.mercados_de_earnings_en_ventana)} |`);
  L.push(`| …con token del "Yes" | ${n.con_token_yes ?? 0} | ${pct(n.con_token_yes, n.mercados_de_earnings_en_ventana)} |`);
  L.push('');

  L.push('## 4. Precio del Yes a T-24h (los ejemplos)');
  L.push('');
  if (!(c.ejemplos || []).length) {
    L.push('Ninguno: sin mercados con token del Yes y fecha de resolución no hay qué pedirle al CLOB.');
  } else {
    L.push('| Mercado | Símbolo | Resolución | Outcome | CLOB | Puntos | Yes T-24h |');
    L.push('|---|---|---|---|---|---|---|');
    for (const e of c.ejemplos) {
      const p = e.yes_t24h || {};
      const precio = p.precio !== null && p.precio !== undefined
        ? `${p.precio} (${p.horas_antes_real}h antes${p.rancio ? ', RANCIO' : ''})`
        : `— (${p.motivo || 'sin dato'})`;
      L.push(`| ${(e.slug || e.pregunta || '—').slice(0, 44)} | ${e.symbol || '—'} | ${e.fecha_resolucion || '—'} | ${e.outcome || '—'} | ${e.clob ? e.clob.status + '/' + e.clob.forma : '—'} | ${e.clob ? e.clob.puntos : '—'} | ${precio} |`);
    }
  }
  L.push('');

  const x = c.cruce || {};
  L.push('## 5. Cruce con `pead_earnings` (símbolo + fecha ±1 día)');
  L.push('');
  if (x.error) {
    L.push(`Falló el SELECT: ${x.error}`);
  } else if (!x.consultado) {
    L.push('No se consultó.');
  } else {
    L.push(`Filas de \`pead_earnings\` en ventana: **${x.filas_pead}** · mercados cruzados: **${x.cruzados}** · de ésos en el universo v0: **${x.en_universo_v0}**.`);
    const motivos = Object.entries(x.sin_cruce || {});
    if (motivos.length) {
      L.push('');
      L.push('Sin cruce, por motivo: ' + motivos.map(([k, v]) => `${k}=${v}`).join(' · '));
    }
    L.push('');
    const cand = c.criterios_congelados ? c.criterios_congelados.min_mercados_cruzados : 100;
    L.push(`**Candado de la Fase 2:** se exigen ≥ ${cand} mercados cruzados CON precio a T-24h. Hoy el cruce da ${x.cruzados} (sin verificar todavía el precio de cada uno).`);
  }
  L.push('');

  L.push('## 6. Revisiones de estimados: ¿hay fuente point-in-time gratis?');
  L.push('');
  L.push('| Fuente | Status | HTTP | ¿PIT? | Motivo |');
  L.push('|---|---|---|---|---|');
  for (const r of c.revisiones || []) {
    L.push(`| ${r.fuente} | ${r.status} | ${r.http ?? '—'} | ${r.pit ? 'SÍ' : 'no'} | ${(r.motivo || '').slice(0, 80)} |`);
  }
  L.push('');
  L.push('Regla congelada: una fuente sirve solo si da **fecha de corte por estimado** (una fecha de verdad, no un número) y **más de un VALOR del estimado para el mismo período**. Si ninguna la cumple, las revisiones quedan **FUERA de v1** y se documenta. No se inventa proxy.');
  L.push('');
  // La fila cruda va SIEMPRE: un `pit: SÍ` que nadie puede auditar no sirve.
  // La primera corrida marcó PIT una respuesta de CONTEOS de revisiones; se
  // detectó leyendo la fila, no confiando en la heurística.
  for (const r of c.revisiones || []) {
    if (!r.fila_cruda) continue;
    L.push(`**Fila cruda de \`${r.fuente}\`** (${r.filas ?? '?'} filas · ${r.revisiones_como_conteo ? '**trae revisiones como CONTEO**' : 'sin conteos de revisión'}):`);
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(r.fila_cruda, null, 1).slice(0, 1200));
    L.push('```');
    L.push('');
  }

  const m = c.muestras || {};
  if ((m.earnings || []).length) {
    L.push('## 7. Muestras (para revisar el filtro a ojo)');
    L.push('');
    for (const e of m.earnings) L.push(`- ${e.symbol || '¿?'} (${e.via || 'sin resolver'}, vía ${e.camino || '—'}) · ${e.fecha || '—'} · outcome=${e.outcome || '—'} · consenso=${e.consenso ?? '—'} · ${String(e.pregunta || '').slice(0, 90)}`);
    if ((m.sin_simbolo || []).length) {
      L.push('');
      L.push('Sin símbolo resuelto:');
      for (const p of m.sin_simbolo) L.push(`- ${String(p).slice(0, 100)}`);
    }
    if ((m.descartados_por_el_filtro || []).length) {
      L.push('');
      L.push('Descartados por el filtro de earnings (deberían NO ser de earnings):');
      for (const p of m.descartados_por_el_filtro) L.push(`- ${String(p).slice(0, 100)}`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('**GO / NO-GO de la Fase 0 lo decide quien lee esto contra los candados de `docs/earnings-beat-scope.md`.** El censo reporta; no se auto-aprueba.');
  return L.join('\n');
}

export {
  CRITERIOS, ALIAS_EMPRESAS, SENALES_EARNINGS, PATRONES_CONSENSO,
  num, jsonArray, isoDia, ts, diasEntre, normalizaTexto,
  normalizaMercado, indiceYes, tokenYes, outcomeResuelto, pareceEarnings,
  construyeIndiceNombres, tickerExplicito, resuelveSimbolo,
  extraeConsensoEps, precioEnT24h, cruzaConPead, evaluaFuentePIT, resumenMarkdown,
  esFecha, recortaFila, extraeTags, extraeCluster, FRASES_BUSQUEDA,
};
