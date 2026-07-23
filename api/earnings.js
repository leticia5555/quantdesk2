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
let symbolMapCache = { at: 0, map: null };

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

export async function getSymbolMap(finnhubKey) {
  if (symbolMapCache.map && Date.now() - symbolMapCache.at < SYMBOL_MAP_TTL_MS) return symbolMapCache.map;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${finnhubKey}`);
    const ct = (r.headers && r.headers.get('content-type')) || '';
    if (!r.ok || !ct.includes('application/json')) return symbolMapCache.map;
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) return symbolMapCache.map;
    const map = {};
    for (const s of list) {
      if (s && s.symbol && s.description) map[s.symbol] = titleCaseName(s.description);
    }
    symbolMapCache = { at: Date.now(), map };
    return map;
  } catch (e) {
    return symbolMapCache.map;
  }
}

// Hook de tests: vacía el cache del symbol map (nunca se usa en producción).
export function _resetSymbolMapCache() { symbolMapCache = { at: 0, map: null }; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const finnhubKey = process.env.FINNHUB_API_KEY;
  const { from, to, ticker } = req.query;

  // ═══════════════════════════════════════════════════════════════
  // MODE 2: HISTORY — /api/earnings?ticker=NVDA
  // ═══════════════════════════════════════════════════════════════
  if (ticker) {
    const sym = String(ticker).toUpperCase().trim();

    // Top-level guard: if ANYTHING throws, return a clean JSON error
    try {
      if (!finnhubKey) {
        return res.status(200).json({ ticker: sym, history: [], error: 'FINNHUB_API_KEY not configured' });
      }

      const now = Math.floor(Date.now() / 1000);
      const twoYearsAgo = now - 730 * 24 * 3600;

      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const futureStr = new Date(today.getTime() + 120 * 24 * 3600 * 1000).toISOString().split('T')[0];

      // All fetches have .catch fallback to null so Promise.all never rejects
      const [epsRes, yahooRes, calRes, finRes] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${finnhubKey}`)
          .catch(() => null),
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${twoYearsAgo}&period2=${now}&interval=1d&range=2y`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        ).catch(() => null),
        fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${todayStr}&to=${futureStr}&symbol=${sym}&token=${finnhubKey}`)
          .catch(() => null),
        fetch(`https://finnhub.io/api/v1/stock/financials-reported?symbol=${sym}&freq=quarterly&token=${finnhubKey}`)
          .catch(() => null)
      ]);

      // ── EPS HISTORY (Finnhub) ──
      let epsData = null;
      try {
        if (epsRes && epsRes.ok) {
          const ct = epsRes.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            epsData = await epsRes.json();
          }
        }
      } catch (e) { epsData = null; }

      if (!Array.isArray(epsData) || epsData.length === 0) {
        return res.status(200).json({
          ticker: sym,
          history: [],
          error: 'No EPS history returned from Finnhub (may be plan restriction or unsupported ticker)'
        });
      }

      const quarters = epsData.slice(0, 8);

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

      // ── REVENUE LOOKUP from financials-reported ──
      // Build map: "YYYY-QN" → {revenue, period} for quick cross-reference with earnings
      let revenueByPeriod = {};
      try {
        if (finRes && finRes.ok) {
          const ct = finRes.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const finJson = await finRes.json();
            const reports = (finJson && finJson.data) || [];
            reports.forEach(r => {
              const ic = r.report && r.report.ic ? r.report.ic : [];
              // Revenue is concept 'us-gaap_Revenues' or 'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax'
              const revItem = ic.find(item =>
                item.concept && (
                  item.concept.toLowerCase().includes('revenue') ||
                  item.concept.toLowerCase().includes('sales')
                )
              );
              if (revItem && typeof revItem.value === 'number' && r.quarter && r.year) {
                const key = `${r.year}-Q${r.quarter}`;
                // Keep first found (usually the most authoritative revenue line)
                if (!revenueByPeriod[key]) {
                  revenueByPeriod[key] = {
                    revenue: revItem.value,
                    period: r.endDate || null,
                    filed: r.filedDate || null
                  };
                }
              }
            });
          }
        }
      } catch (e) { revenueByPeriod = {}; }

      // ── BUILD HISTORY ARRAY with revenue + YoY ──
      const history = quarters.map(q => {
        const epsEst = (q && typeof q.estimate === 'number') ? q.estimate : null;
        const epsAct = (q && typeof q.actual === 'number') ? q.actual : null;
        const surprisePct = (epsEst != null && epsEst !== 0 && epsAct != null)
          ? ((epsAct - epsEst) / Math.abs(epsEst)) * 100
          : null;

        let stockReaction = null;
        try {
          if (priceLookup && q.period) {
            const reportDate = q.period;
            const reportIdx = priceLookup.findIndex(p => p.date >= reportDate);
            if (reportIdx >= 0 && reportIdx + 1 < priceLookup.length) {
              const before = priceLookup[reportIdx].close;
              const after = priceLookup[reportIdx + 1].close;
              if (before > 0) {
                stockReaction = ((after - before) / before) * 100;
              }
            }
          }
        } catch (e) { stockReaction = null; }

        // Revenue lookup (actual reported)
        let revenue = null;
        let revenueYoyPct = null;
        if (q.year && q.quarter) {
          const key = `${q.year}-Q${q.quarter}`;
          if (revenueByPeriod[key] && typeof revenueByPeriod[key].revenue === 'number') {
            revenue = revenueByPeriod[key].revenue;
          }
          // YoY: same quarter one year earlier
          const yoyKey = `${q.year - 1}-Q${q.quarter}`;
          if (revenue != null && revenueByPeriod[yoyKey] && revenueByPeriod[yoyKey].revenue > 0) {
            const prevRev = revenueByPeriod[yoyKey].revenue;
            revenueYoyPct = ((revenue - prevRev) / prevRev) * 100;
          }
        }

        return {
          period: q.period || null,
          quarter: q.quarter || null,
          year: q.year || null,
          eps_estimate: epsEst,
          eps_actual: epsAct,
          surprise_pct: surprisePct != null ? +surprisePct.toFixed(2) : null,
          beat: surprisePct != null ? (surprisePct > 0) : null,
          stock_reaction_pct: stockReaction != null ? +stockReaction.toFixed(2) : null,
          revenue_actual: revenue,
          revenue_yoy_pct: revenueYoyPct != null ? +revenueYoyPct.toFixed(1) : null
        };
      });

      // ── AGGREGATES ──
      const validQuarters = history.filter(h => h.surprise_pct != null);
      const beats = validQuarters.filter(h => h.beat).length;
      const total = validQuarters.length;
      const beatRate = total > 0 ? (beats / total) * 100 : 0;
      const avgSurprise = total > 0
        ? validQuarters.reduce((sum, h) => sum + h.surprise_pct, 0) / total
        : 0;
      const validReactions = history.filter(h => h.stock_reaction_pct != null);
      const avgReaction = validReactions.length > 0
        ? validReactions.reduce((sum, h) => sum + h.stock_reaction_pct, 0) / validReactions.length
        : null;

      // ── UPCOMING EARNINGS (Finnhub calendar) ──
      let nextEarnings = null;
      try {
        if (calRes && calRes.ok) {
          const ct = calRes.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const calData = await calRes.json();
            const list = (calData && calData.earningsCalendar) || [];
            const upcoming = list
              .filter(e => e && e.symbol === sym && e.epsEstimate != null)
              .sort((a, b) => new Date(a.date) - new Date(b.date));
            if (upcoming.length > 0) {
              const next = upcoming[0];
              const daysAway = Math.max(0, Math.ceil((new Date(next.date) - new Date()) / (1000 * 60 * 60 * 24)));
              nextEarnings = {
                date: next.date,
                days_away: daysAway,
                eps_estimate: next.epsEstimate,
                revenue_estimate: next.revenueEstimate || null,
                quarter: next.quarter || null,
                year: next.year || null,
                time: next.hour === 'bmo' ? 'Before market open' : next.hour === 'amc' ? 'After market close' : 'TBD'
              };
            }
          }
        }
      } catch (e) { nextEarnings = null; }

      return res.status(200).json({
        ticker: sym,
        history,
        beat_rate_pct: +beatRate.toFixed(1),
        beats,
        total,
        avg_surprise_pct: +avgSurprise.toFixed(2),
        avg_stock_reaction_pct: avgReaction != null ? +avgReaction.toFixed(2) : null,
        next_earnings: nextEarnings
      });

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
  // ═══════════════════════════════════════════════════════════════
  if (!finnhubKey) return res.status(200).json({ earnings: [] });

  const nowDate = new Date();
  // Default de `from` con 1 día de gracia hacia atrás: un AMC se reporta tras
  // el cierre y su reacción vive la mañana siguiente, así que el reporte del
  // día previo sigue siendo relevante. El frontend pasa siempre from/to
  // explícitos; esto cubre llamadas directas al endpoint.
  const fromDate = from || new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const toDate = to || new Date(nowDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    // El symbol map corre en paralelo al calendario: con cache caliente son
    // 0 requests extra; frío, 1 request que no suma latencia secuencial.
    const [r, symMap] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${finnhubKey}`),
      getSymbolMap(finnhubKey)
    ]);
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return res.status(200).json({ earnings: [] });
    }
    const data = await r.json();
    if (!data.earningsCalendar) {
      return res.status(200).json({ earnings: [] });
    }
    // No se filtra por epsEstimate: en el free tier muchos earnings
    // CONFIRMADOS de corto plazo vienen sin estimate y el filtro los
    // borraba — el panel "this week" quedaba mostrando solo fechas
    // lejanas que sí traían estimate (Aug 7/10 bajo "this week" en jul).
    const earnings = data.earningsCalendar
      .filter(e => e.symbol && e.date)
      .map(e => ({
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
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return res.status(200).json({ earnings, count: earnings.length });
  } catch (err) {
    return res.status(200).json({ earnings: [] });
  }
}
