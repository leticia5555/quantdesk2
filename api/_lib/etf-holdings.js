// ═══════════════════════════════════════════════════════════════
// api/_lib/etf-holdings.js — los CONSTITUYENTES, desde las tenencias
// públicas de dos ETFs. Sin key, sin plan de pago, actualizadas a diario.
//
// POR QUÉ SE CAMBIÓ LA FUENTE: FMP cobra por los endpoints de constituyentes.
// `/stable` devuelve 402 "Restricted Endpoint" y `/api/v3` un 403 "Legacy" —
// o sea que la lista del S&P 500 estaba detrás de una suscripción.
//
// Los ETFs que replican esos índices publican sus tenencias COMPLETAS todos los
// días, gratis y sin registro, porque están obligados a hacerlo:
//
//   IVV — iShares Core S&P 500 ETF        → S&P 500
//   QQQ — Invesco QQQ Trust               → Nasdaq 100
//
// Es la misma información con un día de latencia como mucho, y con una ventaja
// sobre FMP: es el REPLICANTE diciendo qué tiene, no un tercero diciendo qué
// cree que tiene el índice.
//
// ── LO QUE NO PUDE VERIFICAR, Y CÓMO SE COMPENSA ─────────────────────
// El entorno donde se escribió esto NO tiene salida a ishares.com ni a
// invesco.com (la política de red responde 403 al CONNECT), así que NO pude
// mirar un CSV real. Los nombres exactos de las columnas y el número de líneas
// de preámbulo son lo único que no está confirmado.
//
// El diseño se apoya en eso en vez de ignorarlo, de tres maneras:
//
//   1. EL PARSER NO EXIGE UN FORMATO. Busca la fila de encabezado escaneando
//      hasta encontrar una que tenga una columna de ticker, y mapea nombres de
//      columna por alternativas ('Ticker', 'Holding Ticker', 'Symbol'...).
//   2. NO DEPENDE DE LA COLUMNA DE TIPO. El filtro que de verdad decide qué es
//      una acción es el CATÁLOGO DE ALPACA (_lib/arena-instrumento.js), que es
//      autoritativo y que ya hace falta para el canal del día. El CSV solo
//      tiene que aportar TICKERS; si su columna de clase existe se usa como
//      primera pasada barata, y si no existe no pasa nada.
//   3. LAS URLs SON ENV VARS. Si iShares o Invesco mueven el archivo, se
//      arregla sin un deploy (ARENA_HOLDINGS_URL_SP500 / _NASDAQ100).
//
// Y cada intento deja un diagnóstico con status, bytes, encabezado detectado y
// filas parseadas — la misma lección que dejó FMP: un fallo que no se puede
// distinguir de otros cinco no es un fallo, es un agujero.
// ═══════════════════════════════════════════════════════════════

// Cada índice puede tener VARIAS URLs candidatas: se prueban en orden y gana la
// primera que devuelva un CSV parseable. Existe porque los proveedores mueven
// estos archivos sin avisar, y porque una URL que YO no pude verificar no tiene
// por qué costar un deploy cuando falle.
//
// El override por env var va SIEMPRE primero: es la forma de corregir esto sin
// tocar el código.
const urls = (envVar, ...candidatas) => [process.env[envVar], ...candidatas].filter(Boolean);

export const HOLDINGS_SOURCES = {
  sp500: {
    etf: 'IVV',
    proveedor: 'iShares',
    // VERIFICADA por Lety el 2026-09-15: ~9 líneas de metadatos y después el
    // encabezado `Ticker,Name,Sector,Asset Class,...`.
    urls: urls('ARENA_HOLDINGS_URL_SP500',
      'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/latest-holdings.csv',
      // La forma vieja del mismo archivo, por si la nueva se mueve.
      'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund'),
  },
  nasdaq100: {
    etf: 'QQQ',
    proveedor: 'Invesco',
    // ── OPCIONAL, Y ESO ES UNA DECISIÓN, NO UNA FALLA ─────────────────
    // NO hay URL verificada. La de abajo devolvió HTML, y desde este entorno no
    // puedo probar otra: `invesco.com` está bloqueado por el proxy de egress,
    // igual que ishares.com. Inventar variantes de la que ya falló sería
    // cargo-cult.
    //
    // Así que el Nasdaq 100 arranca como OPCIONAL: si no contesta, el universo
    // sale con el S&P 500 y punto — no bloquea, no cuenta como error y no
    // degrada la fuente a `partial`. La mayoría de los miembros del Nasdaq 100
    // también están en el S&P 500, así que lo que se pierde son los nombres que
    // SOLO están en el 100 — y el journal mide exactamente cuántos son
    // (`indices.solo_en`), para que la decisión de buscar la URL se tome con un
    // número en vez de con una intuición.
    opcional: true,
    urls: urls('ARENA_HOLDINGS_URL_NASDAQ100',
      'https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0?audienceType=Investor&action=download&ticker=QQQ'),
  },
};

// ── CSV de verdad, no `split(',')` ───────────────────────────────────
// Los nombres de empresas llevan comas ("Alphabet Inc., Class A") y vienen
// entrecomillados. Partir por coma a secas corre las columnas justo en las
// filas que más importan.
export function parseCsv(texto) {
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  const s = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (enComillas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; }   // "" escapada
        else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

// Alternativas de nombre por columna. Que la lista sea larga es a propósito:
// no sé cuál usa cada proveedor y no puedo mirarlo.
const COLUMNAS = {
  ticker: ['ticker', 'holdingticker', 'symbol', 'securityidentifier', 'stockticker'],
  nombre: ['name', 'securityname', 'description', 'holdingname', 'company'],
  clase: ['assetclass', 'securitytype', 'classofshares', 'type', 'assettype'],
  // El SECTOR, que venía en el CSV y se estaba tirando. iShares lo trae con la
  // taxonomía GICS por nombre ("Information Technology"), que es la misma que
  // usa el tablero.
  sector: ['sector', 'gicssector', 'sectorname', 'industry'],
};

// Columnas que no se usan para extraer nada, pero que sirven para CONFIRMAR que
// una fila es el encabezado y no una fila de datos que casualmente dice
// "ticker".
const COLUMNAS_AUXILIARES = ['weight', 'weightpercent', 'shares', 'sharespar', 'sharesparvalue', 'marketvalue', 'quantity', 'price', 'sector', 'percentageoffund', 'notionalvalue'];

// Encuentra la fila de encabezado SIN asumir cuántas líneas de preámbulo hay
// (iShares mete el nombre del fondo, la fecha y varias líneas sueltas antes).
//
// PIDE DOS COLUMNAS RECONOCIBLES, NO UNA. Con una sola alcanzaba para que una
// fila de DATOS que contuviera la palabra "ticker" se tomara por encabezado, y
// a partir de ahí todo el parseo quedaba corrido un renglón — devolviendo cero
// símbolos con cara de "el CSV vino vacío". Un encabezado de verdad siempre
// trae ticker + algo más (nombre, clase, peso, cantidad); una fila de datos casi
// nunca. Lo agarró el test, no yo.
export function ubicarEncabezado(filas, maxScan = 30) {
  for (let i = 0; i < Math.min(filas.length, maxScan); i++) {
    const cols = (filas[i] || []).map(norm);
    const idxTicker = cols.findIndex((c) => COLUMNAS.ticker.includes(c));
    if (idxTicker === -1) continue;
    const mapa = {};
    for (const [campo, alts] of Object.entries(COLUMNAS)) {
      const j = cols.findIndex((c) => alts.includes(c));
      if (j !== -1) mapa[campo] = j;
    }
    const auxiliares = cols.filter((c) => COLUMNAS_AUXILIARES.includes(c)).length;
    const reconocidas = Object.keys(mapa).length + auxiliares;
    if (reconocidas < 2) continue;   // ticker suelto: es dato, no encabezado
    return { fila: i, mapa, encabezado: filas[i] };
  }
  return null;
}

// Marcadores de lo que NO es una acción, en la columna de clase del CSV.
// Es una PRIMERA PASADA barata: el que de verdad decide es el catálogo de
// Alpaca. Que esto se quede corto no rompe nada.
const CLASE_NO_ACCION = /cash|derivative|futur|money\s*market|currency|fx|swap|repo|deposit|bond|treasur/i;
const TICKER_VALIDO = /^[A-Z][A-Z0-9.]{0,6}$/;

// ── BAJAR Y PARSEAR UNAS TENENCIAS ───────────────────────────────────
// Nunca lanza. Devuelve { symbols, diagnostics }: `symbols` vacío significa que
// no sirvió, y el diagnóstico dice POR QUÉ.
export async function fetchHoldings(index, { timeoutMs = 25000, fetchImpl = fetch, source = null } = {}) {
  const src = source || HOLDINGS_SOURCES[index];
  const base = { index, etf: src && src.etf, proveedor: src && src.proveedor, opcional: !!(src && src.opcional) };
  if (!src) return { symbols: [], diagnostics: { ...base, ok: false, reason: 'index_desconocido' } };

  const candidatas = src.urls || (src.url ? [src.url] : []);
  if (!candidatas.length) return { symbols: [], diagnostics: { ...base, ok: false, reason: 'sin_url' } };

  const intentos = [];
  for (const url of candidatas) {
    const r = await intentarUrl(url, { timeoutMs, fetchImpl });
    intentos.push({ url_host: hostDe(url), ...r.diagnostics });
    if (r.symbols.length) {
      return { symbols: r.symbols, sectores: r.sectores || {}, diagnostics: { ...base, ok: true, url_host: hostDe(url), ...r.diagnostics, intentos } };
    }
  }
  // Ninguna sirvió: se devuelve el diagnóstico del ÚLTIMO intento arriba y la
  // lista completa abajo, para no tener que elegir cuál de los fallos contar.
  return { symbols: [], diagnostics: { ...base, ok: false, ...(intentos[intentos.length - 1] || {}), intentos } };
}

const hostDe = (u) => { try { return new URL(u).host; } catch { return null; } };

async function intentarUrl(url, { timeoutMs, fetchImpl }) {
  let texto = '';
  try {
    const r = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // Sin User-Agent, los dos proveedores contestan 403 desde un datacenter.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantDeskArena/1.0)', Accept: 'text/csv,*/*' },
    });
    texto = await r.text().catch(() => '');
    if (!r.ok) {
      return { symbols: [], diagnostics: { ok: false, reason: 'http_error', status: r.status, bytes: texto.length, body_sample: texto.slice(0, 200) } };
    }
  } catch (e) {
    const m = String((e && e.message) || e);
    return { symbols: [], diagnostics: { ok: false, reason: /abort|timeout/i.test(m) ? 'timeout' : 'red', detail: m } };
  }

  if (!texto.trim()) return { symbols: [], diagnostics: { ok: false, reason: 'cuerpo_vacio', bytes: 0 } };
  // Si contestaron HTML, decirlo con esas palabras: "0 filas" mandaría a
  // revisar el parser cuando el problema es que la URL dejó de servir el CSV.
  if (/^\s*<(!doctype|html)/i.test(texto)) {
    return { symbols: [], diagnostics: { ok: false, reason: 'html_no_csv', bytes: texto.length, body_sample: texto.slice(0, 200), detail: 'la URL devolvió una página, no el CSV: probablemente se movió el archivo. Se corrige SIN deploy con la env var ARENA_HOLDINGS_URL_<INDICE>.' } };
  }

  const filas = parseCsv(texto);
  const cab = ubicarEncabezado(filas);
  if (!cab) {
    return { symbols: [], diagnostics: { ok: false, reason: 'sin_encabezado', bytes: texto.length, filas_totales: filas.length, primeras_lineas: filas.slice(0, 10).map((f) => f.slice(0, 6).join(',')) } };
  }

  const simbolos = [];
  // ── EL SECTOR VIENE GRATIS EN EL MISMO CSV ─────────────────────────
  // El CSV de IVV trae una columna `Sector` para los 502 nombres, y se estaba
  // tirando. Por eso R6 rechazaba carteras por concentración sectorial
  // calculada sobre un bucket UNKNOWN que la ausencia de datos había inventado.
  // Es el dato más barato del sistema: ya está en el archivo que igual se baja.
  const sectores = {};
  let saltadasPorClase = 0;
  let saltadasPorTicker = 0;
  for (let i = cab.fila + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const t = String(f[cab.mapa.ticker] || '').trim().toUpperCase();
    if (!t) continue;
    if (cab.mapa.clase != null && CLASE_NO_ACCION.test(String(f[cab.mapa.clase] || ''))) { saltadasPorClase++; continue; }
    if (!TICKER_VALIDO.test(t)) { saltadasPorTicker++; continue; }
    simbolos.push(t);
    if (cab.mapa.sector != null) {
      const sec = String(f[cab.mapa.sector] || '').trim();
      if (sec && sec !== '-') sectores[t] = sec;
    }
  }
  const symbols = [...new Set(simbolos)].sort();

  return {
    symbols,
    sectores,
    diagnostics: {
      ok: symbols.length > 0,
      sectores: Object.keys(sectores).length,
      bytes: texto.length, filas_totales: filas.length,
      encabezado_en_linea: cab.fila, columnas_detectadas: Object.keys(cab.mapa),
      tenia_columna_de_clase: cab.mapa.clase != null,
      filas_leidas: filas.length - cab.fila - 1,
      symbols: symbols.length, saltadas_por_clase: saltadasPorClase, saltadas_por_ticker: saltadasPorTicker,
      note: cab.mapa.clase == null
        ? 'El CSV no traía columna de clase; el filtro de instrumento lo resuelve después contra el catálogo de Alpaca, que es el autoritativo.'
        : null,
    },
  };
}
