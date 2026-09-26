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
  // CUÁNDO NACIÓ EL MERCADO. Es lo que decide CONTRA QUÉ REPORTE apunta: un
  // mercado creado en septiembre no puede estar preguntando por el reporte de
  // junio, que ya ocurrió. Sin este campo el emparejamiento se va al trimestre
  // anterior y produce desfases de +90 días que parecen ruido y no lo son.
  const creado = raw.createdAt || raw.created_at || raw.startDate || raw.startDateIso || raw.start_date_iso || null;
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
    creado: creado ? String(creado) : null,
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

// ── FILTRO v1: SOLO beat/miss de EPS ──────────────────────────────────────
// La corrida con GO destapó tres poblaciones que pasaban el filtro de
// "parece earnings" sin ser lo que el experimento mide:
//
//   1. MERCADOS DE MENCIÓN — «Will X say "Y" during the earnings call?».
//      Ocurren EN un earnings call, pero no predicen beat/miss de nada. Peor:
//      26 de los 36 aceptados de símbolos ruidosos eran de esta forma (GEV
//      apareciendo al buscar GE, LYFT al buscar NOW), así que también eran la
//      vía por la que se colaba el símbolo equivocado.
//   2. OTRAS MÉTRICAS DE EARNINGS — los de MO son de Altria y son de earnings
//      de verdad, pero preguntan por volumen de cigarros, no por EPS. Fuera de
//      v1, documentado: v1 mide beat/miss de EPS y nada más.
//   3. SÍMBOLO DISTINTO AL BUSCADO — la búsqueda es por subcadena; si el
//      mercado resolvió a otro símbolo, se descarta salvo que el título nombre
//      al resuelto explícitamente ($SYM o (SYM)).
//
// Se excluye POR LA FORMA DEL TÍTULO, no por símbolo: prohibir "GEV" taparía
// el síntoma y dejaría la puerta abierta para el siguiente ticker ruidoso.
const FORMAS_EXCLUIDAS = [
  // «Will X say "tariffs" during the Q3 earnings call?» — el verbo + la frase
  // entre comillas es la firma; el "during ... call" la confirma.
  { nombre: 'mencion_con_frase', re: /\b(say|says|mention|mentions|utter|utters|use|uses)\b[^?]{0,80}["'\u201c\u201d\u2018\u2019][^"'\u201c\u201d\u2018\u2019]+["'\u201c\u201d\u2018\u2019]/i },
  { nombre: 'mencion_en_la_llamada', re: /\bduring\b[^?]{0,40}\b(earnings|conference)\s+call\b/i },
  { nombre: 'mencion_cuantas_veces', re: /\bhow many times\b/i },
];

// Para contar como v1 el mercado tiene que ser de BEAT/MISS DE EPS.
const SENALES_EPS = [
  { nombre: 'eps_explicito', re: /\b(eps|earnings per share)\b/i },
  { nombre: 'beat_earnings', re: /\bbeat\b[^.?]{0,40}\b(earnings|estimates?|expectations?|consensus|street)\b/i },
];

// Clasifica un mercado para v1. Devuelve SIEMPRE el motivo: un descarte sin
// motivo no se puede auditar, y este filtro se escribió precisamente porque
// el anterior descartaba y aceptaba sin decir por qué.
//   m        — mercado normalizado
//   etiqueta — el símbolo que se BUSCÓ (camino D); null si vino de una frase
function clasificaParaV1(m, { etiqueta = null, universo = null } = {}) {
  const texto = [m && m.pregunta, m && m.slug, m && m.descripcion].filter(Boolean).join(' • ');
  const esEarnings = pareceEarnings(m);
  if (!esEarnings.si) return { acepta: false, motivo: 'no_parece_earnings', senales: [] };

  const forma = FORMAS_EXCLUIDAS.find((f) => f.re.test(texto));
  if (forma) return { acepta: false, motivo: 'mercado_de_menciones', forma: forma.nombre, senales: esEarnings.senales };

  const eps = SENALES_EPS.filter((x) => x.re.test(texto)).map((x) => x.nombre);
  if (!eps.length) {
    return { acepta: false, motivo: 'no_es_beat_miss_de_eps', senales: esEarnings.senales };
  }

  // Regla dura del símbolo. Solo aplica cuando SABEMOS qué se buscó.
  if (etiqueta && m && m.symbol && m.symbol !== etiqueta) {
    const explicito = tickerExplicito(texto, universo) === m.symbol;
    if (!explicito) {
      return { acepta: false, motivo: 'simbolo_distinto_al_buscado', buscado: etiqueta, resuelto: m.symbol, senales: esEarnings.senales };
    }
  }
  return { acepta: true, motivo: 'ok', senales: esEarnings.senales, senales_eps: eps };
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
// ── EL EMPAREJAMIENTO, corregido ──────────────────────────────────────────
// Cicatriz: el histograma de 69 "fuera de tolerancia" NO era ruido, era señal.
// El grueso caía a +90/+119 días porque se emparejaba contra el reporte
// ANTERIOR: MU resolvió el 30 de septiembre y se casaba con el reporte de
// junio. Un mercado creado en septiembre no puede estar preguntando por un
// reporte que ya ocurrió cuando el mercado nació.
//
// La regla correcta: **el reporte tiene que ser POSTERIOR a la creación del
// mercado.** Eso no relaja nada — la tolerancia sigue en 1 día. Al contrario,
// vuelve honesto el conteo: un mercado cuyo reporte aún no está cosechado
// deja de parecer "desfase raro" y pasa a ser lo que es,
// `sin_reporte_posterior_a_la_creacion`, que es un problema de NUESTRA
// cosecha y se arregla cosechando, no moviendo umbrales.
function cruzaConPead(mercados, filas, {
  tolerancia = CRITERIOS.tolerancia_dias_cruce,
  exigirPosteriorACreacion = true,
} = {}) {
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
    const creado = m ? isoDia(m.creado) : null;
    // Solo los reportes que todavía NO habían ocurrido cuando nació el mercado.
    const elegibles = exigirPosteriorACreacion && creado
      ? candidatos.filter((d) => d >= creado)
      : candidatos;

    let mejor = null;
    let cercano = null;   // el más cercano SIN tolerancia: mide POR CUÁNTO no entró
    for (const d of elegibles) {
      const dias = diasEntre(fecha, d);
      if (dias === null) continue;
      if (!cercano || Math.abs(dias) < Math.abs(cercano.dias)) cercano = { reported_date: d, dias };
      if (Math.abs(dias) > tolerancia) continue;
      if (!mejor || Math.abs(dias) < Math.abs(mejor.dias)) mejor = { reported_date: d, dias };
    }

    const motivo = mejor ? null
      : !candidatos.length ? 'simbolo_no_esta_en_pead_earnings'
      : !elegibles.length ? 'sin_reporte_posterior_a_la_creacion'
      : 'fecha_fuera_de_tolerancia';

    salida.push({
      ...m,
      cruce: mejor,
      cercano_fuera_de_tolerancia: mejor ? null : cercano,
      reportes_anteriores_descartados: candidatos.length - elegibles.length,
      motivo_sin_cruce: motivo,
    });
  }
  return salida;
}

// Compara el emparejamiento VIEJO (contra cualquier reporte) con el NUEVO
// (solo reportes posteriores a la creación) y dice qué pasó con cada caso que
// antes caía en "fecha fuera de tolerancia": cuántos se recuperan, cuántos
// esperan cosecha, y cuántos son ruido de verdad.
function comparaEmparejamiento(mercados, filas, opciones = {}) {
  const antes = cruzaConPead(mercados, filas, { ...opciones, exigirPosteriorACreacion: false });
  const ahora = cruzaConPead(mercados, filas, { ...opciones, exigirPosteriorACreacion: true });
  const porId = new Map(ahora.map((m, i) => [m.id || 'i' + i, m]));

  const fueraAntes = antes.filter((m) => !m.cruce && m.motivo_sin_cruce === 'fecha_fuera_de_tolerancia');
  const destino = { recuperados: 0, sin_reporte_posterior: 0, sigue_fuera_de_tolerancia: 0, otro: 0 };
  for (let i = 0; i < antes.length; i++) {
    const m = antes[i];
    if (m.cruce || m.motivo_sin_cruce !== 'fecha_fuera_de_tolerancia') continue;
    const nuevo = porId.get(m.id || 'i' + i);
    if (!nuevo) { destino.otro++; continue; }
    if (nuevo.cruce) destino.recuperados++;
    else if (nuevo.motivo_sin_cruce === 'sin_reporte_posterior_a_la_creacion') destino.sin_reporte_posterior++;
    else if (nuevo.motivo_sin_cruce === 'fecha_fuera_de_tolerancia') destino.sigue_fuera_de_tolerancia++;
    else destino.otro++;
  }
  // Los que antes casaban y ahora no. Lo normal es que sean FALSOS
  // emparejamientos contra el trimestre anterior —o sea, una corrección—,
  // pero si el número es grande hay que sospechar de `creado`.
  let dejaronDeCasar = 0;
  for (let i = 0; i < antes.length; i++) {
    const nuevo = porId.get(antes[i].id || 'i' + i);
    if (antes[i].cruce && nuevo && !nuevo.cruce) dejaronDeCasar++;
  }
  // EL MODO DE FALLA SILENCIOSO: si Gamma no expone fecha de creación, la
  // regla no se aplica y todo queda igual sin que nada falle. Se cuenta.
  const sinCreacion = (mercados || []).filter((m) => !isoDia(m && m.creado)).length;
  return {
    cruzados_antes: antes.filter((m) => m.cruce).length,
    cruzados_ahora: ahora.filter((m) => m.cruce).length,
    fuera_de_tolerancia_antes: fueraAntes.length,
    destino_de_esos_casos: destino,
    dejaron_de_casar_con_la_regla_nueva: dejaronDeCasar,
    sin_fecha_de_creacion: sinCreacion,
    total: (mercados || []).length,
    nota_sin_creacion: sinCreacion
      ? `${sinCreacion} mercados NO traen fecha de creación: en ésos la regla no se aplica y el emparejamiento queda como antes. Si son la mayoría, el arreglo no está actuando.`
      : null,
    ahora,
  };
}

// ── ¿El desfase es SISTEMÁTICO o es ruido? ────────────────────────────────
// Regla fijada ANTES de ver los números, para que el diagnóstico no se acomode
// al resultado que convenga:
//   · sistemático  = un MISMO desfase (mismo valor con signo) explica ≥ 50% de
//     los casos fuera de tolerancia Y ese valor es ≤ 3 días;
//   · si no, es RUIDO y esos mercados se quedan afuera.
// La función PROPONE una tolerancia; no la cambia. Los CRITERIOS están
// congelados y se mueven a mano, en un diff que se vea.
const MAX_TOLERANCIA_PROPONIBLE = 3;

function analizaDesfases(cruzados, { tolerancia = CRITERIOS.tolerancia_dias_cruce } = {}) {
  const fuera = (cruzados || []).filter(
    (m) => m && !m.cruce && m.motivo_sin_cruce === 'fecha_fuera_de_tolerancia' && m.cercano_fuera_de_tolerancia);
  if (!fuera.length) return { casos: 0, histograma: {}, veredicto: 'sin_casos', propuesta: null };

  const histograma = {};
  for (const m of fuera) {
    const d = m.cercano_fuera_de_tolerancia.dias;
    histograma[d] = (histograma[d] || 0) + 1;
  }
  const orden = Object.entries(histograma)
    .map(([dias, n]) => ({ dias: Number(dias), n }))
    .sort((a, b) => b.n - a.n || Math.abs(a.dias) - Math.abs(b.dias));
  const dominante = orden[0];
  const fraccion = dominante.n / fuera.length;
  const sistematico = fraccion >= 0.5 && Math.abs(dominante.dias) <= MAX_TOLERANCIA_PROPONIBLE;

  // Cuántos mercados se recuperarían si la tolerancia subiera a |dominante|.
  const recuperables = fuera.filter(
    (m) => Math.abs(m.cercano_fuera_de_tolerancia.dias) <= Math.abs(dominante.dias)).length;

  return {
    casos: fuera.length,
    histograma,
    dominante,
    fraccion_dominante: Number(fraccion.toFixed(3)),
    veredicto: sistematico ? 'sistematico' : 'ruido',
    // PROPUESTA, no cambio. La decide una persona mirando el diff.
    propuesta: sistematico
      ? {
          tolerancia_actual: tolerancia,
          tolerancia_propuesta: Math.abs(dominante.dias),
          recuperaria: recuperables,
          por_que: `${dominante.n} de ${fuera.length} casos (${Math.round(fraccion * 100)}%) caen exactamente a ${dominante.dias} día(s) de la fecha de reporte: eso es un desfase de calendario, no dispersión.`,
        }
      : null,
    nota: sistematico
      ? 'PROPUESTA — los CRITERIOS están congelados; subir la tolerancia es una decisión a mano y se ve en el diff.'
      : 'Desfase disperso: no hay un patrón que justifique tocar la tolerancia. Estos mercados se quedan afuera.',
    // Una muestra con el mismo símbolo cinco veces no es una muestra: se
    // toma uno por símbolo para que se vea la variedad real de los casos.
    muestra: (() => {
      const vistos = new Set();
      const out = [];
      for (const m of fuera) {
        if (vistos.has(m.symbol)) continue;
        vistos.add(m.symbol);
        out.push({ symbol: m.symbol, resolucion: m.fecha_resolucion,
          reported_date: m.cercano_fuera_de_tolerancia.reported_date,
          dias: m.cercano_fuera_de_tolerancia.dias });
        if (out.length >= 5) break;
      }
      return out;
    })(),
  };
}

// ── El conteo del candado: T-24h sobre TODOS los cruzados ─────────────────
// Clasifica el resultado de precioEnT24h() en las categorías que decide el
// candado. `valido` es el único que cuenta: un precio rancio existe pero no
// dice lo que creemos, y uno sin ticks no existe.
function clasificaT24h(resultado) {
  if (!resultado) return 'error';
  if (resultado.precio === null || resultado.precio === undefined) {
    return resultado.motivo === 'historial_vacio' ? 'sin_ticks'
      : resultado.motivo === 'sin_ticks_antes_de_t24h' ? 'sin_ticks_antes'
      : 'sin_precio';
  }
  return resultado.rancio ? 'rancio' : 'valido';
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
// Dos PLANTILLAS observadas en los mercados que el censo ya trajo, y la
// diferencia importa porque una no matchea a la otra:
//   1. pregunta:  "Will Costco (COST) beat quarterly earnings?"
//   2. slug NKE:  "nke-quarterly-earnings-gaap-eps-…"
// La 2 no dice "beat" en ninguna parte: buscar solo por "beat" se comería
// media población sin que nada fallara. De ahí las frases de abajo, y de ahí
// el camino D (búsqueda por ticker), que es el que atraviesa las dos formas.
const FRASES_BUSQUEDA = [
  'beat quarterly earnings',
  'beat its quarterly EPS estimate',
  'quarterly earnings GAAP EPS',
  'quarterly earnings',
  'GAAP EPS',
  'earnings',
];

// ── Autodefensa contra el "5" (cicatriz de la 2ª corrida) ─────────────────
// Si TODAS las respuestas traen el mismo número y ese número es menor que el
// límite que pedimos, no estamos viendo el catálogo: estamos viendo un tope
// —nuestro o del servidor— disfrazado de resultado. El censo tiene que
// gritarlo solo; confiar en que alguien note la coincidencia a ojo ya falló
// una vez.
function detectaTopeUniforme(intentos, limitePedido, minIntentos = 3) {
  const conteos = (intentos || [])
    .filter((i) => i && i.status === 'ok' && typeof i.filas === 'number')
    .map((i) => i.filas);
  if (conteos.length < minIntentos) return null;
  const distintos = [...new Set(conteos)];
  if (distintos.length !== 1) return null;
  const valor = distintos[0];
  if (valor === 0) return null;                       // cero uniforme es otra cosa
  if (limitePedido && valor >= limitePedido) return null;  // llenó el límite: normal
  return {
    valor,
    intentos: conteos.length,
    limite_pedido: limitePedido || null,
    aviso: `Las ${conteos.length} respuestas trajeron EXACTAMENTE ${valor} filas` +
      (limitePedido ? `, por debajo del límite pedido (${limitePedido})` : '') +
      '. Eso no es un catálogo, es un tope: del cliente o el default del servidor. Los conteos NO son legibles hasta resolverlo.',
  };
}

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

// ─────────────────── base histórica de beats (vista EN VIVO) ─────────────
//
// Lo que esto ES: el conteo de cuántas veces una empresa superó el estimado,
// leído de pead_earnings. Lo que esto NO ES: una probabilidad.
//
// ── CICATRIZ, corregida con datos reales ───────────────────────────────────
// MU salió con "Average surprise: −26.06%" teniendo 13 beats al hilo. El
// primer diagnóstico fue "denominador cerca de cero", por analogía con el
// corte EXPLORATORIO del PEAD. **Era falso**, y lo desmintió la corrida del
// `diag` en producción: MU dio `distorsionado: false` y UN solo trimestre con
// denominador chico. Sus extremos son trimestres de PÉRDIDA REALES
// (est −0.88 → −1.91; est −0.25 → 0.42): Micron es cíclica y pierde dinero en
// las bajadas del ciclo de memoria.
//
// **Lo que arregló el número fue la VENTANA, no la mediana.** Mirar 20
// trimestres en vez de 121 sacó del cálculo las pérdidas de ciclos viejos. La
// mediana no está tapando un artefacto: está reportando otra cosa — la
// tendencia central en vez del promedio, que en una serie con colas gordas
// REALES es lo que uno quiere leer, pero no es un arreglo de un dato sucio.
// Las dos siguen publicadas; ninguna de las dos miente.
//
// Lo que sí es un problema de medición, y por eso se cuenta aparte: cuando el
// estimado es CERO, NEGATIVO o de centavos, el porcentaje de sorpresa deja de
// ser comparable entre trimestres — un −117% contra un estimado de −$0.88 no
// significa lo mismo que un −117% contra $2.00.
//
// ── EL PORCENTAJE SE RECALCULA ACÁ, A PROPÓSITO ───────────────────────────
// `pead_earnings.surprise_pct` viene de Alpha Vantage cuando AV lo trae
// (api/_lib/av-earnings.js:51) y solo se recalcula con |estimado| cuando AV lo
// deja nulo. O sea: **para la mayoría de las filas heredamos la convención de
// signo de AV sin haberla verificado**. Con estimados negativos eso importa:
// si el denominador no está en valor absoluto, el signo se voltea y un miss se
// ve como beat. Así que el número que se MUESTRA se calcula acá, con |est|, y
// el de la tabla se usa solo para comparar: `signo_discrepante` cuenta las
// filas donde AV y nosotros no coincidimos en el signo. Si ese contador deja
// de ser cero, hay algo que mirar en la fuente.
const VENTANA_TRIMESTRES = 20;   // 5 años
const PISO_ESTIMADO = 0.05;      // por debajo de esto el % de sorpresa no significa nada

function mediana(valores) {
  const v = (valores || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// (reportado − estimado) / |estimado|. El valor absoluto en el denominador es
// lo único que mantiene el signo con estimados negativos: reportar peor que un
// estimado de pérdida TIENE que dar negativo.
function sorpresaPct(reportado, estimado) {
  if (!Number.isFinite(reportado) || !Number.isFinite(estimado) || estimado === 0) return null;
  return ((reportado - estimado) / Math.abs(estimado)) * 100;
}

function estadisticasHistoricas(filas, {
  ventana = VENTANA_TRIMESTRES,
  ultimos = 8,
  frontera = CRITERIOS.frontera_eps,
  pisoEstimado = PISO_ESTIMADO,
} = {}) {
  const ordenadas = (filas || [])
    .filter((f) => f && f.reported_date)
    .map((f) => ({
      fecha: isoDia(f.reported_date),
      reportado: num(f.reported_eps),
      estimado: num(f.estimated_eps),
      sorpresa_guardada: num(f.surprise_pct),   // la de la tabla (AV), solo para comparar
    }))
    .filter((f) => f.fecha)
    .sort((a, b) => b.fecha.localeCompare(a.fecha));   // más reciente primero

  // Solo los trimestres con las DOS cifras pueden decir si superó o no.
  const comparables = ordenadas.filter((f) => f.reportado !== null && f.estimado !== null);
  const descartados = ordenadas.length - comparables.length;
  if (!comparables.length) {
    return { sin_datos: true, motivo: 'sin trimestres comparables en pead_earnings',
      filas_en_tabla: ordenadas.length, descartados_sin_cifras: descartados,
      ventana: null, completo: null, racha: null, sorpresa: null, ultimos: [] };
  }

  const marcar = (f) => {
    const pct = sorpresaPct(f.reportado, f.estimado);
    return {
      ...f,
      // `beat` NO depende del porcentaje: sale de comparar las dos cifras. Por
      // eso el conteo y la racha son inmunes a cualquier lío de signos.
      beat: f.reportado > f.estimado,
      frontera: Math.abs(f.reportado - f.estimado) <= frontera,
      sorpresa_pct: pct,
      denominador_chico: Math.abs(f.estimado) < pisoEstimado,
      estimado_no_positivo: f.estimado <= 0,
      // ¿AV y nosotros coincidimos en el SIGNO? Si no, el % de la tabla no es
      // confiable para esa fila — y lo que se muestra es el nuestro.
      signo_discrepante: pct !== null && f.sorpresa_guardada !== null
        && Math.sign(pct) !== Math.sign(f.sorpresa_guardada),
    };
  };
  const todos = comparables.map(marcar);
  const enVentana = todos.slice(0, ventana);

  const cuenta = (lista) => ({
    beats: lista.filter((f) => f.beat).length,
    total: lista.length,
    pct: lista.length ? Math.round((lista.filter((f) => f.beat).length / lista.length) * 100) : null,
  });

  // Racha sobre la MISMA ventana que el titular.
  let racha = 0;
  for (const f of enVentana) {
    if (f.beat !== enVentana[0].beat) break;
    racha++;
  }

  const pcts = enVentana.map((f) => f.sorpresa_pct).filter((x) => Number.isFinite(x));
  const med = mediana(pcts);
  const prom = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  // "Distorsionado" = promedio y mediana cuentan historias distintas. Puede ser
  // por denominadores chicos (artefacto) o por colas REALES (una cíclica con
  // trimestres de pérdida). El contador de al lado dice cuál de las dos.
  const distorsionado = med !== null && prom !== null
    && (Math.abs(prom - med) > 15 || (med > 0 && prom < 0) || (med < 0 && prom > 0));

  const extremos = [...enVentana]
    .filter((f) => Number.isFinite(f.sorpresa_pct))
    .sort((a, b) => Math.abs(b.sorpresa_pct) - Math.abs(a.sorpresa_pct))
    .slice(0, 3)
    .map((f) => ({
      fecha: f.fecha, estimado: f.estimado, reportado: f.reportado,
      sorpresa_pct: Number(f.sorpresa_pct.toFixed(2)),
      sorpresa_en_tabla: f.sorpresa_guardada === null ? null : Number(f.sorpresa_guardada.toFixed(2)),
      denominador_chico: f.denominador_chico,
      estimado_no_positivo: f.estimado_no_positivo,
      signo_discrepante: f.signo_discrepante,
    }));

  const noPositivos = enVentana.filter((f) => f.estimado_no_positivo).length;
  const chicos = enVentana.filter((f) => f.denominador_chico).length;

  return {
    sin_datos: false,
    // Por qué `filas_en_tabla` y `completo.total` no cuadran: los trimestres a
    // los que AV no les dio estimado (o reportado) no pueden decir si la
    // empresa superó, así que no se cuentan. Se publica la diferencia en vez
    // de dejar dos números que no cierran.
    filas_en_tabla: ordenadas.length,
    descartados_sin_cifras: descartados,
    ventana: { trimestres: ventana, ...cuenta(enVentana), anios: Math.round(ventana / 4) },
    completo: cuenta(todos),
    racha: {
      tipo: enVentana[0].beat ? 'beats' : 'misses',
      largo: racha,
      sobre: 'ventana',
      tope: racha === enVentana.length && todos.length > enVentana.length,
    },
    sorpresa: {
      // Calculada acá con |estimado|, no heredada de AV. Ver el comentario de
      // arriba: con estimados negativos la convención de signo importa.
      mediana_pct: med === null ? null : Number(med.toFixed(2)),
      promedio_pct: prom === null ? null : Number(prom.toFixed(2)),
      distorsionado,
      denominador_chico: chicos,
      estimado_no_positivo: noPositivos,
      signo_discrepante: enVentana.filter((f) => f.signo_discrepante).length,
      piso_estimado: pisoEstimado,
      extremos,
      // El motivo de la distorsión, dicho: artefacto de denominador, o colas
      // reales de una empresa que de verdad tuvo trimestres extremos.
      // OJO con la distinción, que es la que se entendió mal DOS VECES:
      //   · denominador de CENTAVOS  → el % es un artefacto (dividir por ~0);
      //   · estimado NEGATIVO o cola grande → el trimestre es REAL (una pérdida
      //     de verdad), solo que su % es menos comparable contra otros.
      // Meter los dos en la misma bolsa fue el diagnóstico falso de MU, y
      // después el texto de la tarjeta lo repitió con BA: `distorsionado:true`
      // con `denominador_chico:0` y aun así imprimía "estimado cerca de cero",
      // cuando el extremo de BA es est 0.09 → −6.18, el 737 MAX. Real.
      //
      // `causa` es el CÓDIGO (lo que consume la UI para elegir su texto en el
      // idioma que toque); `causa_probable` es la explicación en prosa para
      // quien lee el JSON. Un solo lugar decide cuál de las dos es: si la UI
      // arma su propia frase, vuelve a pasar lo de BA.
      causa: !distorsionado ? null : chicos > 0 ? 'artefacto_denominador' : 'colas_reales',
      causa_probable: !distorsionado ? null
        : chicos > 0
          ? 'artefacto de denominador: ' + chicos + ' trimestre(s) con estimado de centavos, donde el % no significa nada'
          // Describe lo que ES. La versión anterior terminaba con "no hay
          // ningún estimado cerca de cero acá" y volvía a meter la frase de la
          // otra causa en esta rama — que es justo la mezcla que nos tuvo
          // equivocados dos vueltas.
          : 'trimestres de pérdida o sorpresas muy grandes REALES'
            + (noPositivos ? ' (' + noPositivos + ' con estimado negativo, donde el % es menos comparable aunque el trimestre sea real)' : ''),
      nota: distorsionado
        ? 'Promedio y mediana no coinciden. Se muestra la MEDIANA; el promedio queda al lado para que la divergencia se vea. La CAUSA está en `causa`/`causa_probable` — no se asume.'
        : null,
    },
    frontera: enVentana.filter((f) => f.frontera).length,
    ultimos: enVentana.slice(0, ultimos).map((f) => ({
      fecha: f.fecha, estimado: f.estimado, reportado: f.reportado,
      beat: f.beat, frontera: f.frontera, sorpresa_pct: f.sorpresa_pct,
    })),
  };
}

// ── Escala del estimado: qué tan frágil es una racha ──────────────────────
//
// `frontera` mide beats de ≤ $0.01 en dólares ABSOLUTOS, y por eso se le
// escapa INTC: sus últimos estimados son de $0.01, así que un beat de $0.28 es
// +2800% y NO cae en "frontera" — pero la racha de una empresa cuyo estimado
// ronda el centavo es frágil de otra manera: cualquier ruido de redondeo la da
// vuelta. Para apostar beat/miss, la ESCALA del estimado es lo que dice qué
// tan sólida es la racha.
//
// Esto NO se muestra todavía. Primero hay que saber a cuántos de los 99
// símbolos les aplica: si son tres, es una nota al pie; si son treinta, es una
// columna. La medición va primero, la decisión de pantalla después.
const PISO_ESCALA = 0.20;   // estimado mediano de los últimos 4 trimestres

// Mediana del |estimado| de los últimos `n` trimestres con cifra.
function escalaDelEstimado(filas, { n = 4 } = {}) {
  const vals = (filas || [])
    .filter((f) => f && f.reported_date && num(f.estimated_eps) !== null)
    .sort((a, b) => String(isoDia(b.reported_date)).localeCompare(String(isoDia(a.reported_date))))
    .slice(0, n)
    .map((f) => Math.abs(num(f.estimated_eps)));
  const med = mediana(vals);
  return {
    trimestres_usados: vals.length,
    estimado_mediano: med === null ? null : Number(med.toFixed(4)),
    escala_chica: med !== null && med < PISO_ESCALA,
    piso: PISO_ESCALA,
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

  if (c.sospecha_de_tope) {
    L.push('## ⚠ LOS CONTEOS NO SON LEGIBLES');
    L.push('');
    L.push('> ' + c.sospecha_de_tope.aviso);
    L.push('');
  }
  L.push('## 1. ¿Contesta la API pública de Polymarket?');
  L.push('');
  L.push('| Estrategia | Endpoint | Status | HTTP | ms | Filas (topadas) |');
  L.push('|---|---|---|---|---|---|');
  for (const s of c.sondas || []) {
    L.push(`| ${s.estrategia} | ${s.endpoint} | ${s.status} | ${s.http ?? '—'} | ${s.ms ?? '—'} | ${s.filas ?? '—'}${s.limite_de_la_sonda ? ' / tope ' + s.limite_de_la_sonda : ''} |`);
  }
  L.push('');
  L.push('> Las filas de una sonda están **topadas por el límite de la propia sonda**: miden el ESQUEMA, no el catálogo. Si todas muestran el mismo número, es el tope hablando — no un hallazgo.');
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
  for (const i of (d.simbolo && d.simbolo.intentos) || []) {
    const et = i.etiqueta ? `${i.etiqueta}${i.pagina ? ' p' + i.pagina : ''}` : (i.nota || '—');
    L.push(`| símbolo | ${et} | ${i.status || '—'}${i.http ? '/' + i.http : ''} | ${i.filas ?? '—'}${i.nuevos !== undefined ? ' (' + i.nuevos + ' nuevos)' : ''} |`);
  }
  for (const i of (d.cluster && d.cluster.intentos) || []) {
    L.push(`| racimo | ${i.via || i.nota || '—'} | ${i.status || '—'}${i.http ? '/' + i.http : ''} | ${i.filas ?? '—'} |`);
  }
  L.push('');
  if (d.simbolo) {
    L.push(`Búsqueda por símbolo: **${d.simbolo.probados ?? 0} de ${d.simbolo.de ?? 0}** símbolos del universo v0 probados uno por uno.`);
    L.push('');
  }
  // Tags y racimo pueden fallar por dos motivos MUY distintos: no había
  // semillas, o las semillas no traen tags. Sin este conteo no se distinguen.
  const sem = d.semillas;
  if (sem) {
    L.push(`Semillas para tags/racimo: **${sem.total}** mercados de earnings (${sem.usadas} usadas) · con tags: **${sem.con_tags}** · con evento/serie: **${sem.con_racimo}**.`);
    if (sem.total > 0 && sem.con_tags === 0) L.push('');
    if (sem.total > 0 && sem.con_tags === 0) L.push('> Había semillas y **ninguna trae tags**: el camino B no existe para estos mercados, no es falta de material.');
    L.push('');
  }
  const porCamino = Object.entries(d.mercados_de_earnings_por_camino || {});
  L.push(`**Mercados de earnings por camino:** ${porCamino.length ? porCamino.map(([k, v]) => k + '=' + v).join(' · ') : 'ninguno'}.`);
  if (d.estrategia_ganadora) {
    L.push('');
    L.push(`**Ganó \`${d.estrategia_ganadora.camino}\`** con ${d.estrategia_ganadora.mercados_de_earnings} mercados de earnings. Ése es el camino que hereda la Fase 1.`);
  }
  L.push('');

  // La búsqueda por subcadena trae de todo cuando el ticker es palabra común.
  // "El filtro descartó bien" tiene que poder comprobarse, no creerse.
  const ruido = d.ruido_por_subcadena;
  if (ruido && (ruido.simbolos || []).length) {
    L.push('### Ruido de la búsqueda por subcadena');
    L.push('');
    L.push('| Símbolo | Filas traídas | Aceptados | Descartados | Aceptados con OTRO símbolo |');
    L.push('|---|---|---|---|---|');
    for (const r of ruido.simbolos) {
      L.push(`| ${r.symbol} | ${r.filas_traidas} | ${r.aceptados} | ${r.descartadas} | ${r.aceptados_con_otro_simbolo} |`);
    }
    L.push('');
    L.push(`De los símbolos ruidosos salieron **${ruido.aceptados_totales_de_ruidosos}** mercados aceptados, de los cuales **${ruido.aceptados_con_simbolo_distinto}** resolvieron a un símbolo distinto del buscado.`);
    if (ruido.aceptados_con_simbolo_distinto === 0) {
      L.push('');
      L.push('> Cero aceptados con símbolo distinto: **no se coló basura por la subcadena**. La muestra de abajo es para confirmarlo a ojo.');
    }
    L.push('');
    for (const r of ruido.simbolos.slice(0, 4)) {
      if (!r.muestra_aceptados.length) continue;
      L.push(`**Aceptados de \`${r.symbol}\`:**`);
      for (const m of r.muestra_aceptados) L.push(`- ${m.coincide_con_la_busqueda ? '✓' : '✗ (' + m.symbol_resuelto + ')'} ${m.pregunta}`);
      L.push('');
    }
  }

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

  const f = c.filtro_v1;
  if (f) {
    L.push('## 2b. Filtro v1 — solo beat/miss de EPS');
    L.push('');
    L.push(f.regla);
    L.push('');
    L.push('| Motivo | Mercados |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(f.motivos || {}).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${k === 'ok' ? '**ACEPTADOS**' : k} | ${v} |`);
    }
    L.push('');
    for (const [motivo, muestra] of Object.entries(f.muestras || {})) {
      if (!muestra.length) continue;
      L.push(`**Descartados por \`${motivo}\`:**`);
      for (const m of muestra) {
        L.push(`- ${m.texto}${m.buscado ? ` _(buscado ${m.buscado}${m.resuelto && m.resuelto !== m.buscado ? ` → resolvió ${m.resuelto}` : ''})_` : ''}`);
      }
      L.push('');
    }
  }

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

  const t = c.t24h || {};
  const cn = t.conteo || {};
  const crit = c.criterios_congelados || {};
  L.push('## 4. EL CONTEO DEL CANDADO — precio del Yes a T-24h');
  L.push('');
  L.push(`Medido sobre **${t.total ?? 0}** ${t.sobre || 'mercados'} · procesados: **${t.procesados ?? 0}**${t.truncado ? ` · **TRUNCADO** (${t.motivo_corte})` : ''}.`);
  L.push('');
  L.push('| Resultado | Cuántos | ¿Cuenta para el candado? |');
  L.push('|---|---|---|');
  L.push(`| **válido** (tick real ≤ T-24h, en ventana) | **${cn.valido ?? 0}** | **SÍ** |`);
  L.push(`| rancio (hay tick previo, pero muy viejo) | ${cn.rancio ?? 0} | no — existe, pero no dice lo que creemos |`);
  L.push(`| sin ticks antes de T-24h | ${cn.sin_ticks_antes ?? 0} | no |`);
  L.push(`| historial vacío | ${cn.sin_ticks ?? 0} | no |`);
  L.push(`| sin token del Yes | ${cn.sin_token ?? 0} | no |`);
  L.push(`| sin precio por otro motivo | ${cn.sin_precio ?? 0} | no |`);
  L.push(`| error del CLOB | ${cn.error ?? 0} | no |`);
  L.push('');
  const minimo = crit.min_mercados_cruzados ?? 100;
  const validos = cn.valido ?? 0;
  if (t.truncado) {
    L.push(`> **El conteo está TRUNCADO**: ${validos} válidos sobre ${t.procesados} procesados de ${t.total}. Es un **piso**. Re-correr con más presupuesto antes de leer el candado.`);
  } else if (validos >= minimo) {
    L.push(`> **Candado de muestra: SE CUMPLE.** ${validos} ≥ ${minimo} mercados cruzados con precio válido a T-24h.`);
  } else {
    L.push(`> **Candado de muestra: NO se cumple.** ${validos} < ${minimo}. Con esta muestra el veredicto de la Fase 2 sería INCONCLUSO, no "casi".`);
  }
  L.push('');
  const formas = Object.entries(t.formas || {});
  if (formas.length) { L.push(`Formas del CLOB que funcionaron: ${formas.map(([k, v]) => k + '=' + v).join(' · ')}.`); L.push(''); }

  if ((c.ejemplos || []).length) {
    L.push('Ejemplos (del mismo lote, sin requests extra):');
    L.push('');
    L.push('| Mercado | Símbolo | Resolución | reportedDate | Outcome | Puntos | Yes T-24h |');
    L.push('|---|---|---|---|---|---|---|');
    for (const e of c.ejemplos) {
      const p = e.yes_t24h || {};
      L.push(`| ${(e.slug || e.pregunta || '—').slice(0, 40)} | ${e.symbol || '—'} | ${e.fecha_resolucion || '—'} | ${e.reported_date || '—'} | ${e.outcome || '—'} | ${e.clob ? e.clob.puntos : '—'} | ${p.precio} (${p.horas_antes_real}h antes${p.rancio ? ', RANCIO' : ''}) |`);
    }
    L.push('');
  }

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
      // Los dos motivos apuntan a culpables opuestos, y de eso depende qué se
      // arregla después: nuestra cosecha, o la fuente externa.
      const fueraDeUniverso = x.sin_cruce.simbolo_no_esta_en_pead_earnings || 0;
      const fueraDeFecha = x.sin_cruce.fecha_fuera_de_tolerancia || 0;
      L.push('');
      if (fueraDeUniverso > fueraDeFecha) {
        L.push(`> **El cuello de botella es NUESTRO universo, no Polymarket.** ${fueraDeUniverso} mercados quedaron fuera porque su símbolo no está en \`pead_earnings\` (universo v0 = 99 símbolos). Ampliar la cosecha del PEAD sube el cruce; pelearse con Gamma no.`);
      } else if (fueraDeFecha > 0) {
        L.push(`> El grueso (${fueraDeFecha}) cruza de símbolo pero **no de fecha**: revisar la tolerancia de ±${(c.criterios_congelados && c.criterios_congelados.tolerancia_dias_cruce) ?? 1} día antes de tocar el universo.`);
      }
    }
    L.push('');
    const cand = c.criterios_congelados ? c.criterios_congelados.min_mercados_cruzados : 100;
    const validos = ((c.t24h || {}).conteo || {}).valido;
    L.push(`**Candado de la Fase 2:** se exigen ≥ ${cand} mercados cruzados **con precio válido a T-24h**. El cruce da ${x.cruzados}; el conteo que manda es el del §4: **${validos ?? '—'} válidos**.`);
  }
  L.push('');

  const emp = (c.cruce || {}).emparejamiento;
  if (emp) {
    L.push('### Emparejamiento corregido: el reporte tiene que ser POSTERIOR a la creación del mercado');
    L.push('');
    L.push(emp.regla);
    L.push('');
    L.push(`Cruzados con la regla vieja: **${emp.cruzados_con_regla_vieja}** → con la nueva: **${emp.cruzados_ahora}**.`);
    L.push('');
    const d = emp.destino_de_esos_casos || {};
    L.push(`De los **${emp.casos_que_antes_caian_fuera_de_tolerancia}** que antes caían en "fecha fuera de tolerancia":`);
    L.push('');
    L.push('| Destino | Casos | Qué significa |');
    L.push('|---|---|---|');
    L.push(`| **recuperados** (ahora cruzan) | ${d.recuperados ?? 0} | el reporte correcto sí estaba cosechado |`);
    L.push(`| esperan cosecha | ${d.sin_reporte_posterior ?? 0} | el reporte del trimestre que el mercado pregunta **todavía no está en \`pead_earnings\`** — se arregla cosechando, no moviendo umbrales |`);
    L.push(`| **ruido de verdad** | ${d.sigue_fuera_de_tolerancia ?? 0} | cruzan de símbolo, hay reporte posterior, y aun así no cuadran |`);
    L.push(`| otro | ${d.otro ?? 0} | — |`);
    L.push('');
    L.push(`Dejaron de casar con la regla nueva: **${emp.dejaron_de_casar_con_la_regla_nueva}** — normalmente son **falsos emparejamientos contra el trimestre anterior**, o sea una corrección, no una pérdida.`);
    if (emp.nota_sin_creacion) {
      L.push('');
      L.push(`> ⚠ ${emp.nota_sin_creacion}`);
    }
    L.push('');
  }

  const des = (c.cruce || {}).desfases;
  if (des && des.casos) {
    L.push('### Los que cruzan de símbolo pero no de fecha');
    L.push('');
    L.push(`**${des.casos}** casos. Desfase entre la resolución de Polymarket y el \`reportedDate\` del PEAD:`);
    L.push('');
    L.push('| Días | Casos |');
    L.push('|---|---|');
    for (const [dias, n] of Object.entries(des.histograma).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      L.push(`| ${dias > 0 ? '+' + dias : dias} | ${n} |`);
    }
    L.push('');
    if (des.veredicto === 'sistematico' && des.propuesta) {
      L.push(`> **Desfase SISTEMÁTICO.** ${des.propuesta.por_que}`);
      L.push('>');
      L.push(`> **PROPUESTA (no aplicada):** tolerancia ${des.propuesta.tolerancia_actual} → **${des.propuesta.tolerancia_propuesta}** día(s), recuperaría **${des.propuesta.recuperaria}** mercados. ${des.nota}`);
    } else {
      L.push(`> **Ruido, no patrón.** ${des.nota}`);
    }
    L.push('');
    if ((des.muestra || []).length) {
      L.push('Muestra:');
      for (const m of des.muestra) L.push(`- ${m.symbol}: resolvió ${m.resolucion}, reportó ${m.reported_date} → ${m.dias > 0 ? '+' : ''}${m.dias} día(s)`);
      L.push('');
    }
  }

  L.push('## 6. Revisiones de estimados — **CERRADO: fuera de v1**');
  L.push('');
  L.push('Resuelto con la fila cruda a la vista: lo que publica Alpha Vantage son **conteos de revisiones y promedios ancla** (7/30 días), **sin valores fechados**. No es point-in-time y no se va a fingir que lo es. La sonda se sigue corriendo por si alguna fuente cambia, pero **el feature no entra a v1**.');
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

// ═══════════════════════════════════════════════════════════════════
// DESACUERDO: el precio del mercado contra la tasa histórica
//
// Qué pregunta contesta: "de los mercados abiertos, ¿en cuál el precio está
// LEJOS de lo que hizo la empresa históricamente?" Y sobre todo: dónde mirar.
//
// ── LA TRAMPA QUE ESTA FUNCIÓN EXISTE PARA NO CAER ─────────────────
// Un hueco enorme (−70 puntos) tiene DOS explicaciones, y la intuitiva es la
// menos probable:
//
//   (a) el mercado sabe algo que el historial no contiene;
//   (b) los dos números NO son sobre la misma pregunta.
//
// La Fase 0 de este experimento se corrigió CUATRO veces por (b): mercados de
// menciones, emparejamiento con el trimestre siguiente, ruido por substring.
// Un mercado puede cotizar 8% con toda la razón si pregunta "¿EPS por encima
// de $3.20?" y el consenso es $2.75 — ahí el 8% y la tasa de beats son
// respuestas a preguntas distintas, y restarlas no significa nada.
//
// Por eso: cuanto MÁS grande el hueco, MÁS arriba va la revisión del
// instrumento en "dónde mirar". Y la tasa histórica NUNCA se presenta como
// pronóstico de este trimestre — es la misma regla que la tarjeta en vivo.
//
// Los umbrales están congelados acá y pineados por test.
// ═══════════════════════════════════════════════════════════════════

const CRITERIOS_DESACUERDO = {
  // La MISMA ventana del titular de la tarjeta. Si el conteo que se compara
  // saliera de otra ventana, la brecha no sería la de lo que se muestra.
  ventana_trimestres: VENTANA_TRIMESTRES,   // 20
  // Con menos historia que esto no se dictamina nada: una tasa de 6 trimestres
  // se mueve 17 puntos con un solo trimestre.
  min_trimestres: 12,
  // Por debajo: coincide, no hay nada que mirar.
  gap_min_puntos: 25,
  // Por encima: el instrumento se revisa PRIMERO. Un hueco así es más fácil de
  // producir con un mercado mal emparejado que con información real.
  gap_instrumento_primero_puntos: 50,
  // El umbral que el mercado declara contra el nivel reciente de EPS. Si se
  // separan más que esto, la pregunta puede no ser "beat vs consenso".
  tolerancia_umbral_pct: 20,
  trimestres_para_nivel: 4,
};

// `hoy` entra por parámetro (nunca `new Date()` acá dentro): así el test fija
// el día y la función queda pura.
function evaluaDesacuerdo({
  historico = null,       // salida de estadisticasHistoricas()
  precio_mercado = null,  // 0..1, el Yes de Polymarket
  consenso_declarado = null,
  fecha_reporte = null,   // o la de resolución, lo que se tenga
  hoy = null,
  criterios = CRITERIOS_DESACUERDO,
} = {}) {
  const v = historico && historico.ventana ? historico.ventana : null;
  const base = {
    comparable: false, clasificacion: 'no_comparable', motivo: null,
    gap_puntos: null, tasa_historica_pct: null, precio_pct: null,
    // Va SIEMPRE, en todos los caminos: es la frase que impide que la tasa
    // histórica se lea como el pronóstico de este trimestre.
    la_tasa_no_es_pronostico: 'La tasa histórica es un CONTEO de trimestres pasados, no un pronóstico de este trimestre. QuantDesk no tiene pronóstico validado (Fase 2: NO-GO).',
    donde_mirar: [],
  };

  if (precio_mercado === null || precio_mercado === undefined || !Number.isFinite(Number(precio_mercado))) {
    return { ...base, motivo: 'sin_precio' };
  }
  const precioPct = Math.round(Number(precio_mercado) * 100);

  if (!v || !Number.isFinite(v.total) || !v.total) {
    return { ...base, precio_pct: precioPct, motivo: 'sin_historial' };
  }
  if (v.total < criterios.min_trimestres) {
    return { ...base, precio_pct: precioPct, motivo: 'muestra_corta',
      trimestres: v.total, min_trimestres: criterios.min_trimestres };
  }

  // Fecha ya pasada: una tarjeta que dice "reporta el 22-jul" cuando el 22 de
  // julio ya pasó no es una advertencia, es una fila rancia.
  const diaHoy = hoy ? isoDia(hoy) : null;
  const diaRep = fecha_reporte ? isoDia(fecha_reporte) : null;
  if (diaHoy && diaRep && diaRep < diaHoy) {
    return { ...base, precio_pct: precioPct, motivo: 'fecha_pasada',
      fecha_reporte: diaRep, hoy: diaHoy };
  }

  const tasaPct = Math.round((v.beats / v.total) * 100);
  const gap = precioPct - tasaPct;   // con signo: negativo = el mercado por DEBAJO
  const abs = Math.abs(gap);

  // ── El instrumento: ¿los dos números son sobre la misma pregunta? ──
  const nivel = mediana((historico.ultimos || [])
    .slice(0, criterios.trimestres_para_nivel)
    .map((u) => (u && Number.isFinite(u.estimado) ? Math.abs(u.estimado) : null))
    .filter((x) => x !== null));
  // OJO: `Number(null)` es 0, no NaN. Sin este chequeo explícito un mercado que
  // NO declara consenso pasaba como si declarara $0.00, y el camino de
  // "no se sabe contra qué resuelve" no se disparaba nunca.
  const umbral = (consenso_declarado === null || consenso_declarado === undefined
    || consenso_declarado === '' || !Number.isFinite(Number(consenso_declarado)))
    ? null : Math.abs(Number(consenso_declarado));
  const desvioUmbral = (umbral !== null && nivel) ? Math.abs(umbral - nivel) / nivel * 100 : null;
  const instrumento = {
    // Sin consenso declarado no se puede saber contra qué resuelve el mercado.
    sin_consenso_declarado: umbral === null,
    umbral_declarado: umbral,
    nivel_eps_reciente: nivel === null ? null : +nivel.toFixed(2),
    desvio_umbral_pct: desvioUmbral === null ? null : +desvioUmbral.toFixed(1),
    umbral_lejos_del_nivel: desvioUmbral !== null && desvioUmbral > criterios.tolerancia_umbral_pct,
  };

  if (instrumento.sin_consenso_declarado) {
    return { ...base, precio_pct: precioPct, tasa_historica_pct: tasaPct, gap_puntos: gap,
      motivo: 'sin_consenso_declarado', instrumento,
      donde_mirar: [dondeMirarInstrumento(true)] };
  }

  if (abs < criterios.gap_min_puntos) {
    return { ...base, comparable: true, clasificacion: 'coincide', motivo: null,
      precio_pct: precioPct, tasa_historica_pct: tasaPct, gap_puntos: gap,
      trimestres: v.total, beats: v.beats, instrumento, donde_mirar: [] };
  }

  // ── Desacuerdo. El orden de "dónde mirar" lo decide el tamaño del hueco. ──
  const instrumentoPrimero = abs >= criterios.gap_instrumento_primero_puntos
    || instrumento.umbral_lejos_del_nivel;
  // Cada pista viaja como CÓDIGO además del texto. La pantalla es bilingüe y
  // tiene que poder escribir la frase en inglés SIN decidir la causa: esa
  // decisión es de acá. Es la misma lección que la nota de sorpresa de BA, que
  // afirmó "estimado cerca de cero" porque el texto se armaba en el front.
  const pistas = [
    { codigo: 'revisiones', texto: 'revisiones del estimado, últimos 30 días' },
    { codigo: 'ocho_k', texto: 'últimos 8-K de la empresa (EDGAR)' },
    { codigo: 'pares', texto: 'qué reportaron sus pares del sector este trimestre' },
  ];
  const donde = instrumentoPrimero
    ? [dondeMirarInstrumento(false), ...pistas]
    : [...pistas, dondeMirarInstrumento(false)];

  return {
    ...base,
    comparable: true, clasificacion: 'desacuerdo', motivo: null,
    precio_pct: precioPct, tasa_historica_pct: tasaPct, gap_puntos: gap,
    trimestres: v.total, beats: v.beats, instrumento,
    instrumento_primero: instrumentoPrimero,
    // La lectura del hueco, SIN asegurar cuál de las dos causas es. Decir "algo
    // que el historial no contiene está moviendo el precio" es afirmar que el
    // mercado está informado, que es justo lo que no se sabe todavía.
    // El código dice CUÁL de las dos lecturas es; el texto es la de acá. La
    // pantalla traduce por código, no re-decide.
    lectura_codigo: instrumentoPrimero ? 'instrumento_primero' : 'ambas_causas',
    lectura: instrumentoPrimero
      ? `Hueco de ${abs} puntos. Un hueco así se produce más fácil con un mercado que pregunta OTRA cosa que con información nueva: revisá el instrumento antes que la noticia.`
      : `Hueco de ${abs} puntos entre el precio y la tasa histórica. Puede ser información que el historial no contiene, o que las dos cifras no midan lo mismo. Sin abrir el mercado no se sabe cuál.`,
    donde_mirar: donde,
    no_es_senal: 'No es señal de compra ni de venta. Es dónde mirar.',
  };
}

function dondeMirarInstrumento(sinConsenso) {
  return sinConsenso
    ? { codigo: 'instrumento_sin_consenso',
        texto: 'PRIMERO: el mercado no declara un consenso, así que no se sabe contra qué resuelve. Abrí el mercado en Polymarket y leé la pregunta.' }
    : { codigo: 'instrumento',
        texto: 'PRIMERO: ¿el mercado pregunta lo mismo? Comparar su umbral y su trimestre con el consenso — un umbral por encima del consenso cotiza bajo con toda la razón.' };
}

export {
  CRITERIOS, ALIAS_EMPRESAS, SENALES_EARNINGS, PATRONES_CONSENSO, FORMAS_EXCLUIDAS, SENALES_EPS,
  clasificaParaV1,
  num, jsonArray, isoDia, ts, diasEntre, normalizaTexto,
  normalizaMercado, indiceYes, tokenYes, outcomeResuelto, pareceEarnings,
  construyeIndiceNombres, tickerExplicito, resuelveSimbolo,
  extraeConsensoEps, precioEnT24h, cruzaConPead, evaluaFuentePIT, resumenMarkdown,
  esFecha, recortaFila, extraeTags, extraeCluster, FRASES_BUSQUEDA, detectaTopeUniforme,
  analizaDesfases, clasificaT24h, MAX_TOLERANCIA_PROPONIBLE, comparaEmparejamiento,
  estadisticasHistoricas, mediana, sorpresaPct, VENTANA_TRIMESTRES, PISO_ESTIMADO,
  escalaDelEstimado, PISO_ESCALA,
  evaluaDesacuerdo, CRITERIOS_DESACUERDO,
};
