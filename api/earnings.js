import { EXCLUDED_SECURITY_TYPES, NON_EQUITY_TYPES } from './_lib/arena-guard.js';
import { leeHistoricoPead, leeHorasPead, historiaDesdePead, historiaDesdeFinnhub, revenueTrimestral } from './_lib/historial-pead.js';

// ── MEGA-CAPS: universo curado para el calendario de /hoy ────────
// El calendario de Finnhub trae TODOS los earnings del rango (cientos). Para
// la página pública /hoy solo interesan los reportes que mueven el mercado y
// que la audiencia reconoce. `?mega=1` intersecta el calendario con este set
// curado (incluye los ADR LATAM que son el corazón de la audiencia: NU/MELI/
// ITUB/VALE/PBR). Lista a mano, estable — NO scraping, misma filosofía que el
// calendario macro curado.
export const MEGA_CAPS = new Set([
  // Big tech / IA
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','AVGO','TSLA','ORCL',
  'AMD','CRM','ADBE','NFLX','QCOM','TXN','INTC','CSCO','IBM','NOW','INTU','PLTR',
  // Semis extranjeras de peso
  'TSM','ASML','MU',
  // Finanzas / pagos
  'JPM','BAC','GS','MS','WFC','V','MA','BRK-B','BX',
  // Consumo / salud / industriales
  'WMT','COST','HD','LLY','UNH','JNJ','PG','KO','PEP','MCD','DIS','NKE','BA','CAT',
  // Energía
  'XOM','CVX',
  // Cripto-adyacentes / retail favorites
  'COIN','MSTR',
  // IPOs recientes de peso: SpaceX (SPCX), la IPO más grande de la historia.
  // Reporta su primer trimestre como pública y /hoy debe mostrarlo aunque no
  // tenga historial previo (la ficha ?ticker= resuelve el próximo por calendario).
  'SPCX',
  // ADR LATAM (corazón de la audiencia)
  'NU','MELI','ITUB','VALE','PBR','BBD','ABEV','GGB',
]);

// ── SYMBOL MAP US: nombre de empresa por ticker ──────────────────
// /stock/symbol?exchange=US es free tier y trae `description` (el nombre,
// en MAYÚSCULAS) para el universo US completo (~25-30k símbolos, OTC
// incluido) — cubre casi todo lo que devuelve el calendario. Cache en
// memoria por instancia con TTL 24h (el equivalente server-side del
// s-maxage=86400 de ticker-search): 1 request a Finnhub por instancia
// caliente al día, 0 por render. Si Finnhub falla se sirve el mapa
// stale (o null la primera vez) — el fallo no se cachea y el calendario
// nunca se bloquea por el nombre.
const SYMBOL_MAP_TTL_MS = 86400 * 1000;
// Un solo fetch al universo US puebla nombre (map) Y tipo (types) + el total,
// todo con el mismo TTL. `type` de Finnhub: 'Common Stock' | 'ETP' (ETF/ETN) |
// 'ADR' | 'REIT' | 'Closed-End Fund' | … — puede venir vacío en el free tier
// (cobertura a verificar en prod vía ?diag=symboltypes).
let symbolMapCache = { at: 0, map: null, types: null, total: 0 };

// Siglas societarias/financieras que se conservan en mayúsculas al pasar
// el description de Finnhub a title-case ("APPLE INC" → "Apple Inc").
const NAME_KEEP_UPPER = new Set(['LLC', 'PLC', 'LP', 'ETF', 'REIT', 'ADR', 'USA', 'SE', 'NV', 'AG', 'SA', 'AB', 'ASA', 'II', 'III', 'IV']);

export function titleCaseName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s !== s.toUpperCase()) return s; // ya trae minúsculas: se respeta tal cual
  return s.toLowerCase()
    .replace(/[a-z][a-z0-9']*/g, (w) => {
      const up = w.toUpperCase();
      return NAME_KEEP_UPPER.has(up) ? up : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .replace(/\.Com\b/g, '.com'); // "AMAZON.COM" → "Amazon.com", no "Amazon.Com"
}

// Un solo fetch → ambos mapas + total. El fallo NO se cachea (se sirve stale).
async function refreshSymbolData(finnhubKey) {
  const r = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${finnhubKey}`);
  const ct = (r.headers && r.headers.get('content-type')) || '';
  if (!r.ok || !ct.includes('application/json')) return false;
  const list = await r.json();
  if (!Array.isArray(list) || list.length === 0) return false;
  const map = {};
  const types = {};
  for (const s of list) {
    if (!s || !s.symbol) continue;
    if (s.description) map[s.symbol] = titleCaseName(s.description);
    if (s.type) types[s.symbol] = s.type; // puede faltar en el free tier
  }
  symbolMapCache = { at: Date.now(), map, types, total: list.length };
  return true;
}

export async function getSymbolMap(finnhubKey) {
  if (symbolMapCache.map && Date.now() - symbolMapCache.at < SYMBOL_MAP_TTL_MS) return symbolMapCache.map;
  try { await refreshSymbolData(finnhubKey); } catch (e) { /* stale (o null la 1a vez) */ }
  return symbolMapCache.map;
}

// Símbolo → tipo de instrumento. Mismo fetch/cache que getSymbolMap (0 requests
// extra con cache caliente). Fuente del gate de universo del guard (equity común).
export async function getSymbolTypes(finnhubKey) {
  if (symbolMapCache.types && Date.now() - symbolMapCache.at < SYMBOL_MAP_TTL_MS) return symbolMapCache.types;
  try { await refreshSymbolData(finnhubKey); } catch (e) { /* stale */ }
  return symbolMapCache.types;
}

// Cobertura del campo `type` — para VERIFICAR en prod si el free tier lo puebla
// antes de confiar en el gate. Devuelve total, poblados, % y distribución.
export async function getSymbolTypeStats(finnhubKey, sampleSize = 30) {
  const types = await getSymbolTypes(finnhubKey);
  if (!types) return null;
  const map = symbolMapCache.map || {};
  const distribution = {};
  const samples = {}; // tipo → primeros N tickers (con nombre) para inspección
  for (const [sym, t] of Object.entries(types)) {
    distribution[t] = (distribution[t] || 0) + 1;
    if (!samples[t]) samples[t] = [];
    if (samples[t].length < sampleSize) samples[t].push({ symbol: sym, name: map[sym] || null });
  }
  const populated = Object.keys(types).length;
  const total = symbolMapCache.total || populated;
  // Cuántos excluiría la política REAL del guard (fondos + no-equity), sin drift.
  const excluded_types = [...EXCLUDED_SECURITY_TYPES, ...NON_EQUITY_TYPES];
  const would_exclude = excluded_types.reduce((n, t) => n + (distribution[t] || 0), 0);
  return {
    total,
    populated,
    populated_pct: total ? +(100 * populated / total).toFixed(1) : null,
    distribution,
    samples,
    excluded_types,
    would_exclude,
  };
}

// Hook de tests: vacía el cache del symbol map (nunca se usa en producción).
export function _resetSymbolMapCache() { symbolMapCache = { at: 0, map: null, types: null, total: 0 }; }

// Próximo earnings CONFIRMADO desde el calendario de Finnhub (calRes = Response
// de /calendar/earnings ya disparada). Se usa en ambos caminos de la rama
// ?ticker=: con historial Y —clave— cuando NO lo hay. Una IPO que aún no reporta
// su primer trimestre (p.ej. SPCX) no tiene stock/earnings, pero su próxima fecha
// SÍ vive en el calendario y debe salir igual. No se filtra por epsEstimate: el
// free tier deja muchos reportes confirmados sin estimate (misma decisión que el
// modo calendario) — basta con que traiga fecha. Consume calRes.json() una sola
// vez; el llamador no debe volver a leer el body.
async function nextEarningsFromCalendar(calRes, sym) {
  try {
    if (calRes && calRes.ok) {
      const ct = calRes.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const calData = await calRes.json();
        const list = (calData && calData.earningsCalendar) || [];
        const upcoming = list
          .filter(e => e && e.symbol === sym && e.date)
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        if (upcoming.length > 0) {
          const next = upcoming[0];
          const daysAway = Math.max(0, Math.ceil((new Date(next.date) - new Date()) / (1000 * 60 * 60 * 24)));
          return {
            date: next.date,
            days_away: daysAway,
            eps_estimate: next.epsEstimate != null ? next.epsEstimate : null,
            revenue_estimate: next.revenueEstimate || null,
            quarter: next.quarter || null,
            year: next.year || null,
            time: next.hour === 'bmo' ? 'Before market open' : next.hour === 'amc' ? 'After market close' : 'TBD',
            // El código crudo: el implied move elige la expiración con él
            // (un reporte AMC necesita la primera expiración DESPUÉS del día).
            hour: next.hour || null
          };
        }
      }
    }
  } catch (e) { /* cae a null */ }
  return null;
}

// Calendario de Finnhub SIN el corte silencioso.
//
// /calendar/earnings tiene tope de filas por respuesta y las devuelve en orden
// de fecha DESCENDENTE: en temporada de reportes una ventana de 30 días se
// trunca y lo que sobrevive son las fechas MÁS TARDÍAS. Por eso el 20-oct el
// calendario "empezaba" el 10-nov — no era el rango ni el sort ascendente de
// abajo, eran las 3 semanas tempranas (NFLX incluido) recortadas en origen.
//
// Si la fecha más temprana recibida es posterior a `from`, se vuelve a pedir
// [from, esa fecha] (inclusive: ese día pudo quedar a medias) hasta cubrir el
// rango, sin progreso, o MAX_TRAMOS. Fuera de temporada: 1 request, como antes.
// Devuelve el array de filas (dedupe symbol|date) o null si la 1a respuesta no
// es un calendario válido.
const MAX_TRAMOS = 8;
async function fetchCalendarCompleto(fromDate, toDate, finnhubKey, symbol) {
  const filas = new Map();
  let hasta = toDate;
  let minPrevio = null;
  for (let i = 0; i < MAX_TRAMOS; i++) {
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${hasta}`
      + (symbol ? `&symbol=${encodeURIComponent(symbol)}` : '') + `&token=${finnhubKey}`);
    const contentType = (r && r.headers && r.headers.get('content-type')) || '';
    const data = contentType.includes('application/json') ? await r.json() : null;
    if (!data || !Array.isArray(data.earningsCalendar)) return i === 0 ? null : [...filas.values()];
    let min = null;
    for (const e of data.earningsCalendar) {
      if (!e || !e.symbol || !e.date) continue;
      filas.set(`${e.symbol}|${e.date}`, e);
      if (min === null || e.date < min) min = e.date;
    }
    if (min === null || min <= fromDate || (minPrevio !== null && min >= minPrevio)) break;
    minPrevio = min;
    hasta = min;
  }
  return [...filas.values()];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const { from, to, ticker } = req.query;
  // ?mega=1 → solo earnings de mega-caps (calendario público de /hoy).
  const megaOnly = String((req.query && req.query.mega) || '') === '1';

  // ═══ DIAG: cobertura del campo `type` (para verificar el free tier) ═══
  //   GET /api/earnings?diag=symboltypes[&sample=N] → { total, populated,
  //   populated_pct, distribution, samples, would_exclude }. En vivo, sin cache.
  //   `sample` (default 30, cap 200) = cuántos tickers de ejemplo por tipo.
  if (req.query && req.query.diag === 'symboltypes') {
    res.setHeader('Cache-Control', 'no-store');
    if (!finnhubKey) return res.status(200).json({ error: 'FINNHUB_API_KEY not configured' });
    const sampleSize = Math.min(200, Math.max(1, parseInt(req.query.sample, 10) || 30));
    const stats = await getSymbolTypeStats(finnhubKey, sampleSize);
    return res.status(200).json(stats || { error: 'symbol types no disponibles' });
  }

  // ═══════════════════════════════════════════════════════════════
  // MODE 2: HISTORY — /api/earnings?ticker=NVDA
  // ═══════════════════════════════════════════════════════════════
  if (ticker) {
    const sym = String(ticker).toUpperCase().trim();

    // Top-level guard: if ANYTHING throws, return a clean JSON error
    try {
      const now = Math.floor(Date.now() / 1000);
      // 8 trimestres de reacción necesitan algo más de 2 años de precios: el
      // reporte más viejo de la lista cae ~24 meses atrás y le hace falta el
      // cierre previo.
      const desdePrecios = now - 900 * 24 * 3600;

      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const futureStr = new Date(today.getTime() + 120 * 24 * 3600 * 1000).toISOString().split('T')[0];
      const pastStr = new Date(today.getTime() - 900 * 24 * 3600 * 1000).toISOString().split('T')[0];

      // ── LA FUENTE DE VERDAD PRIMERO: pead_earnings ──
      // Es la base de la tarjeta de Polymarket de esta misma tab. Si el símbolo
      // está ahí, el panel cuenta beats sobre ESOS datos y con la MISMA función
      // (ver api/_lib/historial-pead.js). Neon caído o sin DATABASE_URL → se
      // sigue con Finnhub, etiquetado como respaldo, y se dice por qué.
      const peadP = leeHistoricoPead([sym])
        .then((m) => ({ filas: m.get(sym) || [], error: null }))
        .catch((e) => ({ filas: [], error: String((e && e.message) || e).slice(0, 160) }));
      const horasP = leeHorasPead(sym).catch(() => new Map());

      const fh = (url) => (finnhubKey ? fetch(url).catch(() => null) : Promise.resolve(null));
      // All fetches have .catch fallback to null so Promise.all never rejects
      const [epsRes, yahooRes, calRes, finRes, calPastRes, pead, horas] = await Promise.all([
        fh(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${finnhubKey}`),
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${desdePrecios}&period2=${now}&interval=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        ).catch(() => null),
        fh(`https://finnhub.io/api/v1/calendar/earnings?from=${todayStr}&to=${futureStr}&symbol=${sym}&token=${finnhubKey}`),
        fh(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${sym}&freq=quarterly&token=${finnhubKey}`),
        // El calendario PASADO es el único lugar de Finnhub con la FECHA DE
        // REPORTE (y el revenue del trimestre, no el acumulado fiscal).
        fh(`https://finnhub.io/api/v1/calendar/earnings?from=${pastStr}&to=${todayStr}&symbol=${sym}&token=${finnhubKey}`),
        peadP,
        horasP,
      ]);

      const leeJson = async (r) => {
        try {
          if (r && r.ok) {
            const ct = (r.headers && r.headers.get('content-type')) || '';
            if (ct.includes('application/json')) return await r.json();
          }
        } catch (e) { /* null */ }
        return null;
      };

      // ── EPS HISTORY (Finnhub) — respaldo, y contraste ──
      const epsJson = await leeJson(epsRes);
      const epsData = Array.isArray(epsJson) ? epsJson : null;

      // ── UPCOMING EARNINGS (Finnhub calendar) ──
      const nextEarnings = await nextEarningsFromCalendar(calRes, sym);

      const tienePead = pead.filas.length > 0;
      if (!tienePead && (!epsData || epsData.length === 0)) {
        // IPO sin historial de EPS (aún no reporta su 1er trimestre): NO cortamos
        // en seco. El próximo earnings vive en el calendario y debe salir igual —
        // es justo el caso de una IPO reciente (p.ej. SPCX) antes de su 1er reporte.
        // Con próximo confirmado, next_earnings alcanza y no marcamos error; sin él,
        // se conserva la nota informativa (plan restriction / ticker no soportado).
        return res.status(200).json({
          ticker: sym,
          history: [],
          beat_rate_pct: 0,
          beats: 0,
          total: 0,
          avg_surprise_pct: 0,
          avg_stock_reaction_pct: null,
          next_earnings: nextEarnings,
          ...(nextEarnings ? {} : { error: finnhubKey
            ? 'No EPS history returned from Finnhub (may be plan restriction or unsupported ticker)'
            : 'FINNHUB_API_KEY not configured' })
        });
      }

      // ── YAHOO PRICE LOOKUP ──
      let priceLookup = null;
      try {
        if (yahooRes && yahooRes.ok) {
          const yahoo = await yahooRes.json();
          const chart = yahoo && yahoo.chart && yahoo.chart.result && yahoo.chart.result[0];
          if (chart && chart.timestamp && chart.indicators && chart.indicators.quote && chart.indicators.quote[0]) {
            const ts = chart.timestamp;
            const closes = chart.indicators.quote[0].close || [];
            priceLookup = ts.map((t, i) => ({
              date: new Date(t * 1000).toISOString().split('T')[0],
              close: closes[i]
            })).filter(p => p.close != null && p.close > 0);
          }
        }
      } catch (e) { priceLookup = null; }

      // ── REVENUE: trimestre real, nunca el acumulado fiscal ──
      const finJson = await leeJson(finRes);
      const revenues = revenueTrimestral((finJson && finJson.data) || []);
      const calPast = await leeJson(calPastRes);
      const calendario = ((calPast && calPast.earningsCalendar) || []).filter((e) => e && e.symbol === sym);

      const payload = tienePead
        ? historiaDesdePead({ simbolo: sym, filas: pead.filas, horas, precios: priceLookup, calendario, revenues })
        : historiaDesdeFinnhub({ simbolo: sym, quarters: epsData.slice(0, 8), precios: priceLookup, calendario, revenues });

      // Por qué se usó el respaldo, cuando se usó.
      if (!tienePead) payload.fallback_reason = pead.error ? 'pead_earnings no disponible: ' + pead.error : 'el símbolo no está en pead_earnings';

      // CONTRASTE con Finnhub, a la vista: con dos proveedores de estimados los
      // beats PUEDEN diferir (NFLX: AV 0.79 vs Finnhub ~0.80 sobre un 0.80
      // reportado). No bloquea nada; impide que la diferencia vuelva a ser
      // invisible.
      if (tienePead && epsData && epsData.length) {
        const fq = epsData.slice(0, 4).filter((q) => q && typeof q.actual === 'number' && typeof q.estimate === 'number');
        payload.contraste_finnhub = {
          trimestres: fq.length,
          beats: fq.filter((q) => q.actual > q.estimate).length,
          nota: 'Finnhub usa otro estimado de consenso: no es la fuente del panel',
        };
      }

      return res.status(200).json({ ...payload, next_earnings: nextEarnings });
    } catch (err) {
      // Final safety net — always return JSON, never let Vercel return HTML 500
      return res.status(200).json({
        ticker: sym,
        history: [],
        error: 'Server exception: ' + (err && err.message ? err.message : 'unknown')
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MODE 1: CALENDAR — /api/earnings?from=...&to=... (existing behavior)
  //         /api/earnings?symbol=NFLX → solo ese ticker: próximo + últimos 4
  // ═══════════════════════════════════════════════════════════════
  if (!finnhubKey) return res.status(200).json({ earnings: [] });

  // `?symbol=` antes no se leía: el handler sólo desestructuraba `ticker`, así
  // que ?symbol=NFLX caía aquí sin filtro y devolvía el calendario entero.
  const symbol = req.query && req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : '';

  const nowDate = new Date();
  const todayStr = nowDate.toISOString().split('T')[0];
  const dayOffset = (d) => new Date(nowDate.getTime() + d * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  // Con symbol la ventana mira hacia atrás (últimos 4 trimestres ≈ 400 días)
  // y 120 días adelante, igual que el próximo earnings de la rama ?ticker=.
  const fromDate = from || (symbol ? dayOffset(-400) : todayStr);
  const toDate = to || (symbol ? dayOffset(120) : dayOffset(30));

  const toRow = (symMap) => (e) => ({
    ticker: e.symbol,
    // Nombre del symbol map (title-cased); null si el símbolo no está
    // (no-US raro) — el frontend omite, nunca inventa.
    company: (symMap && symMap[e.symbol]) || null,
    date: e.date,
    time: e.hour === 'bmo' ? 'BMO' : e.hour === 'amc' ? 'AMC' : 'TBD',
    eps_est: e.epsEstimate,
    eps_actual: e.epsActual,
    revenue_est: e.revenueEstimate,
    revenue_actual: e.revenueActual,
    quarter: e.quarter,
    year: e.year
  });

  try {
    // El symbol map corre en paralelo al calendario: con cache caliente son
    // 0 requests extra; frío, 1 request que no suma latencia secuencial.
    const [calendar, symMap] = await Promise.all([
      fetchCalendarCompleto(fromDate, toDate, finnhubKey, symbol),
      getSymbolMap(finnhubKey)
    ]);
    if (!calendar) {
      return res.status(200).json(symbol ? { symbol, earnings: [], count: 0, next: null } : { earnings: [] });
    }
    // No se filtra por epsEstimate: en el free tier muchos earnings
    // CONFIRMADOS de corto plazo vienen sin estimate y el filtro los
    // borraba — el panel "this week" quedaba mostrando solo fechas
    // lejanas que sí traían estimate (Aug 7/10 bajo "this week" en jul).
    const conFecha = calendar.filter(e => e.symbol && e.date);

    if (symbol) {
      // Filtro estricto aunque Finnhub ya reciba &symbol=: nunca devolver
      // filas de otro ticker. Próximo = primera fecha >= hoy; pasados = los 4
      // más recientes con fecha < hoy (si la fuente los trae).
      const propias = conFecha.filter(e => String(e.symbol).toUpperCase() === symbol);
      const asc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      const proximo = propias.filter(e => e.date >= todayStr).sort(asc)[0] || null;
      const pasados = propias.filter(e => e.date < todayStr).sort(asc).slice(-4);
      const earnings = [...pasados, ...(proximo ? [proximo] : [])].map(toRow(symMap));
      return res.status(200).json({
        symbol,
        earnings,
        count: earnings.length,
        next: proximo ? toRow(symMap)(proximo) : null,
      });
    }
    // LO QUE EL FILTRO DESCARTA, CONTADO Y CON NOMBRE.
    //
    // `?mega=1` se queda con ~55 nombres curados, y en plena temporada de
    // reportes eso puede dejar una semana VACÍA mientras el calendario trae
    // decenas: "sin reportes esta semana" era verdad sobre las mega-caps y
    // falso sobre el mercado, y desde afuera no había forma de distinguirlo
    // (Lety, 2026-10-20). Sin esto, la única manera de saber por qué la
    // sección está vacía es pedirle el calendario crudo a mano.
    //
    // La lista va acotada: una semana de octubre trae cientos y el consumidor
    // es una tarjeta, no un reporte. El CONTEO no se acota.
    const descartadosTodos = megaOnly ? conFecha.filter(e => !MEGA_CAPS.has(e.symbol)) : [];
    const earnings = conFecha
      // ?mega=1: intersecta con el set curado de mega-caps (calendario /hoy).
      .filter(e => !megaOnly || MEGA_CAPS.has(e.symbol))
      .map(toRow(symMap))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return res.status(200).json({
      earnings, count: earnings.length,
      // Qué había ANTES del filtro, para que "está vacío" se pueda distinguir
      // de "está filtrado". Sólo cuando se filtró: sin `?mega=1` no hay nada
      // que explicar y el payload no crece.
      ...(megaOnly ? {
        filtro: 'mega-caps',
        total_calendario: conFecha.length,
        descartados: descartadosTodos.length,
        descartados_muestra: descartadosTodos
          .map(e => ({ ticker: e.symbol, date: e.date }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
          .slice(0, 120),
      } : {}),
    });
  } catch (err) {
    return res.status(200).json({ earnings: [] });
  }
}
