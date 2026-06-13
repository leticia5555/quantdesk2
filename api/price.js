export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const t = ticker.toUpperCase().trim();
  const finnhubKey = process.env.FINNHUB_API_KEY;

  // ── Crypto map for CoinGecko ──────────────────────────
  const cryptoMap = {
    'BTC/USD': 'bitcoin', 'BTC': 'bitcoin',
    'ETH/USD': 'ethereum', 'ETH': 'ethereum',
    'SOL/USD': 'solana', 'SOL': 'solana',
    'BNB/USD': 'binancecoin', 'BNB': 'binancecoin',
    'XRP/USD': 'ripple', 'XRP': 'ripple',
    'ADA/USD': 'cardano', 'ADA': 'cardano',
    'DOGE/USD': 'dogecoin', 'DOGE': 'dogecoin',
    'AVAX/USD': 'avalanche-2', 'AVAX': 'avalanche-2',
    'DOT/USD': 'polkadot', 'DOT': 'polkadot',
    'MATIC/USD': 'matic-network', 'MATIC': 'matic-network',
    'LINK/USD': 'chainlink', 'LINK': 'chainlink',
    'LTC/USD': 'litecoin', 'LTC': 'litecoin',
  };

  const coinGeckoId = cryptoMap[t];

  // ── CRYPTO via CoinGecko ──────────────────────────────
  if (coinGeckoId) {
    try {
      const [priceRes, histRes] = await Promise.all([
        fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd&include_24hr_change=true`),
        fetch(`https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart?vs_currency=usd&days=365&interval=daily`)
      ]);
      const [priceData, histData] = await Promise.all([priceRes.json(), histRes.json()]);
      const coinInfo = priceData[coinGeckoId];
      if (!coinInfo) return res.status(404).json({ error: `Crypto not found: ${t}` });

      const currentPrice = coinInfo.usd;
      const closes = (histData.prices || []).map(p => p[1]).filter(v => v > 0);

      let mu = 0.5, sigma = 0.8;
      let high52w = currentPrice * 1.5, low52w = currentPrice * 0.5;
      let return30d = coinInfo.usd_24h_change / 100 * 30;

      if (closes.length >= 30) {
        const dailyReturns = [];
        for (let i = 1; i < closes.length; i++) {
          dailyReturns.push(Math.log(closes[i] / closes[i-1]));
        }
        const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const varDaily = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;
        const sigmaDaily = Math.sqrt(varDaily);

        const lambda = 0.94;
        let ewmaVar = varDaily;
        for (let i = dailyReturns.length - 30; i < dailyReturns.length; i++) {
          ewmaVar = lambda * ewmaVar + (1 - lambda) * dailyReturns[i] ** 2;
        }
        const ewmaSigma = Math.sqrt(ewmaVar);

        sigma = Math.min(Math.max((ewmaSigma * 0.6 + sigmaDaily * 0.4) * Math.sqrt(252), 0.20), 2.0);

        // ── CRYPTO MU: Pure CAPM (institutional standard) ──
        // rf = 4.5% (US 10y Treasury), ERP = 5.5% (historical equity risk premium)
        // β_crypto = 1.8 (midpoint between BTC ~1.5 and altcoins ~2.5)
        // Rationale: Merton (1980) showed realized-return estimation has enormous standard
        // error — using CAPM avoids the momentum/CAGR trap that biases mu upward in bulls.
        // Standard error on this estimate: ~±15% annualized. Treat as "centered guess" not truth.
        const rf = 0.045;
        const erp = 0.055;
        const betaCrypto = 1.8;
        mu = rf + betaCrypto * erp;  // = 14.4%, stable across reruns
        const muSE = 0.15;  // standard error ±15pp — reported for honesty

        high52w = Math.max(...closes);
        low52w = Math.min(...closes);
        const idx30 = Math.max(0, closes.length - 31);
        return30d = (currentPrice - closes[idx30]) / closes[idx30];
      }

      const dayChange = coinInfo.usd_24h_change != null ? coinInfo.usd_24h_change / 100 : 0;

      return res.status(200).json({
        ticker: t,
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        mu: parseFloat(mu.toFixed(4)),
        muSE: 0.15,  // ±15pp standard error on mu estimate
        sigma: parseFloat(sigma.toFixed(4)),
        high52w: parseFloat(high52w.toFixed(2)),
        low52w: parseFloat(low52w.toFixed(2)),
        return30d: parseFloat(return30d.toFixed(4)),
        dayChange: parseFloat(dayChange.toFixed(4)),
        dataPoints: closes.length,
        asset_type: 'crypto',
        currency: 'USD',
        longName: t.replace('/USD', ''),
        recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
      });
    } catch (err) {
      return res.status(500).json({ error: `Crypto fetch failed: ${err.message}` });
    }
  }

  // ── Detect LATAM exchanges (Finnhub doesn't cover these) ──
  const isBMV  = t.endsWith('.MX');      // Bolsa Mexicana de Valores
  const isB3   = t.endsWith('.SA');      // B3 / Bovespa Brasil
  const isBCBA = t.endsWith('.BA');      // Buenos Aires (Argentina)
  const isBVS  = t.endsWith('.SN');      // Bolsa de Santiago (Chile)
  const isYahooOnly = isBMV || isB3 || isBCBA || isBVS;

  // Nice display names for common LATAM tickers (no Finnhub profile available)
  const bmvNames = {
    // ══════ BMV México ══════
    'FEMSAUBD.MX':  'Fomento Económico Mexicano (FEMSA)',
    'KOFUBL.MX':    'Coca-Cola FEMSA',
    'CEMEXCPO.MX':  'CEMEX',
    'GAPB.MX':      'Grupo Aeroportuario del Pacífico',
    'ASURB.MX':     'Grupo Aeroportuario del Sureste (ASUR)',
    'OMAB.MX':      'Grupo Aeroportuario Centro Norte (OMA)',
    'ALFAA.MX':     'Alfa SAB',
    'AMXB.MX':      'América Móvil (Serie B)',
    'WALMEX.MX':    'Walmart de México',
    'BIMBOA.MX':    'Grupo Bimbo',
    'GFNORTEO.MX':  'Grupo Financiero Banorte',
    'CUERVO.MX':    'Becle (Jose Cuervo)',
    'TLEVISACPO.MX':'Grupo Televisa',
    'GCARSOA1.MX':  'Grupo Carso',
    'PINFRA.MX':    'Promotora y Operadora de Infraestructura',
    'LIVEPOLC-1.MX':'El Puerto de Liverpool',
    'GMEXICOB.MX':  'Grupo México',
    'AC.MX':        'Arca Continental',
    'ORBIA.MX':     'Orbia Advance Corporation',
    'MEGACPO.MX':   'Megacable Holdings',
    'VOLARA.MX':    'Controladora Volaris',
    'LABB.MX':      'Genomma Lab Internacional',
    'KIMBERA.MX':   'Kimberly-Clark de México',
    'GRUMAB.MX':    'Gruma',
    'PE&OLES.MX':   'Industrias Peñoles',
    'GMXT.MX':      'GMéxico Transportes',
    'ELEKTRA.MX':   'Grupo Elektra',
    'LACOMUBC.MX':  'La Comer',
    'CHDRAUIB.MX':  'Grupo Comercial Chedraui',
    'SORIANAB.MX':  'Organización Soriana',
    // ══════ B3 Brasil ══════
    'GOLL4.SA':     'Gol Linhas Aéreas',
    'PETR4.SA':     'Petrobras (PN)',
    'VALE3.SA':     'Vale S.A.',
    'ITUB4.SA':     'Itaú Unibanco',
    'BBAS3.SA':     'Banco do Brasil',
    'ABEV3.SA':     'Ambev',
    'B3SA3.SA':     'B3 (Bolsa de Brasil)',
    'LREN3.SA':     'Lojas Renner',
    'MGLU3.SA':     'Magazine Luiza',
    'WEGE3.SA':     'WEG',
    'SUZB3.SA':     'Suzano',
    'JBSS3.SA':     'JBS',
    'BRFS3.SA':     'BRF · Brasil Foods',
    'RENT3.SA':     'Localiza Rent a Car',
    'CCRO3.SA':     'CCR',
    'RADL3.SA':     'Raia Drogasil',
    'ELET3.SA':     'Eletrobras (ON)',
    'ELET6.SA':     'Eletrobras (PNB)',
    'RAIZ4.SA':     'Raízen',
    'EQTL3.SA':     'Equatorial Energia',
    'UGPA3.SA':     'Ultrapar Participações',
    'VIVT3.SA':     'Telefônica Brasil (Vivo)',
    'HAPV3.SA':     'Hapvida Participações',
    // ══════ Chile (Bolsa de Santiago .SN) ══════
    'SQM-B.SN':     'Sociedad Química y Minera (SQM)',
    'CHILE.SN':     'Banco de Chile',
    'FALABELLA.SN': 'Falabella',
    'COPEC.SN':     'Empresas Copec',
    'ENELCHILE.SN': 'Enel Chile',
    'CENCOSUD.SN':  'Cencosud',
    'LTM.SN':       'LATAM Airlines Group',
    'ANDINA-B.SN':  'Embotelladora Andina',
    'CMPC.SN':      'Empresas CMPC',
    'PARAUCO.SN':   'Parque Arauco',
    'BSANTANDER.SN':'Banco Santander Chile',
    'VAPORES.SN':   'Compañía Sud Americana de Vapores (CSAV)',
    // ══════ Argentina (Bolsa de Buenos Aires .BA) ══════
    'YPFD.BA':      'YPF',
    'GGAL.BA':      'Grupo Financiero Galicia',
    'PAMP.BA':      'Pampa Energía',
    'ALUA.BA':      'Aluar Aluminio Argentino',
    'TXAR.BA':      'Ternium Argentina',
    'MIRG.BA':      'Mirgor',
    'LOMA.BA':      'Loma Negra',
    'CRES.BA':      'Cresud',
    'BMA.BA':       'Banco Macro',
    'TRAN.BA':      'Transener',
  };

  // ── YAHOO-FIRST ROUTE (for BMV/B3/BCBA — Finnhub doesn't cover these) ──
  if (isYahooOnly) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const oneYearAgo = now - 365 * 24 * 3600;
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?period1=${oneYearAgo}&period2=${now}&interval=1d&range=1y`;

      const yahooRes = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      if (!yahooRes.ok) {
        return res.status(404).json({ error: `Yahoo returned ${yahooRes.status} for ${t}` });
      }
      const yahoo = await yahooRes.json();
      const chart = yahoo?.chart?.result?.[0];
      if (!chart) return res.status(404).json({ error: `No Yahoo data for ${t}` });

      const meta = chart.meta || {};
      const currentPrice = meta.regularMarketPrice || meta.previousClose;
      if (!currentPrice) return res.status(404).json({ error: `No price in Yahoo response for ${t}` });

      const closes = (chart.indicators?.quote?.[0]?.close || []).filter(v => v != null && v > 0);

      const currency = meta.currency || (isBMV ? 'MXN' : isB3 ? 'BRL' : isBVS ? 'CLP' : 'ARS');
      const exchange = meta.exchangeName || (isBMV ? 'MEX' : isB3 ? 'SAO' : isBVS ? 'SGO' : 'BUE');

      // Better name lookup: our map → Yahoo meta → raw ticker
      const longName = bmvNames[t] || meta.longName || meta.shortName || t;

      // Day change from Yahoo meta
      const prevClose = meta.chartPreviousClose || meta.previousClose || currentPrice;
      const dayChange = prevClose && prevClose > 0 ? (currentPrice - prevClose) / prevClose : 0;

      let mu, sigma, return30d, high52w, low52w;

      if (closes.length >= 30) {
        // Same EWMA + CAPM math as the US path
        const dailyReturns = [];
        for (let i = 1; i < closes.length; i++) {
          if (closes[i] > 0 && closes[i-1] > 0) {
            dailyReturns.push(Math.log(closes[i] / closes[i-1]));
          }
        }
        const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const varDaily  = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;

        const lambda = 0.94;
        let ewmaVar = varDaily;
        dailyReturns.slice(-60).forEach(r => { ewmaVar = lambda * ewmaVar + (1 - lambda) * r * r; });
        const ewmaSigma = Math.sqrt(ewmaVar);

        const historicalSigma = Math.sqrt(varDaily * 252);
        const currentSigma    = ewmaSigma * Math.sqrt(252);
        sigma = Math.min(Math.max(historicalSigma * 0.40 + currentSigma * 0.60, 0.10), 1.50);

        // ── LATAM CAPM: Country-specific rf (local sovereign yields, Apr 2026) ──
        // Mexico: CETES 28d ~9.5% · Brazil: Selic ~11% · Chile: TPM ~5.5% · Argentina: BADLAR ~30%
        // ERP: Damodaran EM Country Risk Premium (Mex 6.5%, Bra 7%, Chile 6%, Arg 10%)
        // Beta for LATAM blue chips typically 0.9-1.2 vs local benchmark
        // Stocks quote in local currency (MXN/BRL/CLP/ARS) so mu is in local terms
        const rf  = isBMV ? 0.095 : isB3 ? 0.110 : isBVS ? 0.055 : 0.300;
        const erp = isBMV ? 0.065 : isB3 ? 0.070 : isBVS ? 0.060 : 0.100;
        const beta = 1.0;  // default LATAM blue-chip beta; upgrade to Yahoo beta if available
        mu = Math.min(Math.max(rf + beta * erp, 0.02), 0.50);

        high52w = meta.fiftyTwoWeekHigh || Math.max(...closes);
        low52w  = meta.fiftyTwoWeekLow  || Math.min(...closes);
        // IPO/stale sanity check: precio fuera de rango → reconstruir desde historia real
        if (currentPrice > high52w * 1.02 || currentPrice < low52w * 0.98) {
          high52w = Math.max(...closes, currentPrice);
          low52w  = Math.min(...closes, currentPrice);
        }
        const idx30 = Math.max(0, closes.length - 31);
        return30d = (closes[closes.length - 1] - closes[idx30]) / closes[idx30];
      } else {
        // Fallback when Yahoo history is thin (posible IPO reciente en BMV/B3)
        high52w = meta.fiftyTwoWeekHigh || currentPrice * 1.3;
        low52w  = meta.fiftyTwoWeekLow  || currentPrice * 0.7;
        if (currentPrice > high52w * 1.02 || currentPrice < low52w * 0.98) {
          high52w = currentPrice * 1.1;
          low52w  = currentPrice * 0.9;
        }
        const parkinson = Math.log(high52w / low52w) / Math.sqrt(4 * Math.log(2));
        sigma = Math.min(Math.max(parkinson, 0.15), 1.20);
        mu = 0.12;  // conservative LATAM default
        return30d = 0;
      }
      const recentIPO = closes.length > 0 && closes.length < 60;

      return res.status(200).json({
        ticker: t,
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        mu: parseFloat(mu.toFixed(4)),
        muSE: 0.10,  // ±10pp standard error (EM has wider confidence interval than DM)
        sigma: parseFloat(sigma.toFixed(4)),
        high52w: parseFloat(high52w.toFixed(2)),
        low52w: parseFloat(low52w.toFixed(2)),
        recentIPO,
        return30d: parseFloat(return30d.toFixed(4)),
        dayChange: parseFloat(dayChange.toFixed(4)),
        dataPoints: closes.length,
        asset_type: 'stock',
        currency,
        exchange,
        longName,
        recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
      });
    } catch (err) {
      return res.status(500).json({ error: `LATAM fetch failed for ${t}: ${err.message}` });
    }
  }

  // ── US STOCKS via Finnhub + Yahoo Finance historical ──
  if (!finnhubKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set' });

  try {
    const symbol = t.replace('/USD', '');

    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 24 * 3600;

    // Insider window: last 90 days
    const insiderFromTs = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const [quoteRes, metricRes, profileRes, yahooRes, recRes, insiderRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${oneYearAgo}&period2=${now}&interval=1d&range=1y`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(r => r.json())
        .catch(() => null),
      // Best-effort: don't fail the whole call if these 429 or error
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${finnhubKey}`)
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&from=${insiderFromTs}&token=${finnhubKey}`)
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const [quote, metric, profile] = await Promise.all([
      quoteRes.json(), metricRes.json(), profileRes.json()
    ]);

    // ── Finnhub failed? Try Yahoo as last-ditch fallback ──
    if (!quote.c || quote.c === 0) {
      // Some tickers (GOL, small-cap ADRs) Finnhub doesn't cover but Yahoo does
      const chart = yahooRes?.chart?.result?.[0];
      if (chart?.meta?.regularMarketPrice) {
        const meta = chart.meta;
        const closes = (chart.indicators?.quote?.[0]?.close || []).filter(v => v != null && v > 0);
        const cp = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose || cp;
        const dayChange = prevClose && prevClose > 0 ? (cp - prevClose) / prevClose : 0;

        let mu = 0.10, sigma = 0.30, return30d = 0;
        let yHigh = meta.fiftyTwoWeekHigh || cp * 1.3;
        let yLow  = meta.fiftyTwoWeekLow  || cp * 0.7;
        const recentIPO = closes.length > 0 && closes.length < 60;
        let rangeUnreliable = false;
        if (cp > yHigh * 1.02 || cp < yLow * 0.98) {
          rangeUnreliable = true;
          if (closes.length >= 2) { yHigh = Math.max(...closes, cp); yLow = Math.min(...closes, cp); }
          else { yHigh = cp * 1.1; yLow = cp * 0.9; }
        }
        if (closes.length >= 30) {
          const dailyReturns = [];
          for (let i = 1; i < closes.length; i++) {
            if (closes[i] > 0 && closes[i-1] > 0) dailyReturns.push(Math.log(closes[i] / closes[i-1]));
          }
          const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
          const varDaily  = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;
          sigma = Math.min(Math.max(Math.sqrt(varDaily * 252), 0.10), 1.50);
          mu = Math.min(Math.max(0.045 + 1.1 * 0.055, 0.02), 0.30);
          const idx30 = Math.max(0, closes.length - 31);
          return30d = (closes[closes.length - 1] - closes[idx30]) / closes[idx30];
        } else if (recentIPO || rangeUnreliable) {
          sigma = 0.70; // IPO reciente: vol alta por defecto
          mu = 0.10;
        }

        return res.status(200).json({
          ticker: symbol,
          currentPrice: parseFloat(cp.toFixed(2)),
          mu: parseFloat(mu.toFixed(4)),
          sigma: parseFloat(sigma.toFixed(4)),
          high52w: parseFloat(yHigh.toFixed(2)),
          low52w:  parseFloat(yLow.toFixed(2)),
          recentIPO,
          rangeUnreliable,
          return30d: parseFloat(return30d.toFixed(4)),
          dayChange: parseFloat(dayChange.toFixed(4)),
          dataPoints: closes.length,
          asset_type: 'stock',
          currency: meta.currency || 'USD',
          exchange: meta.exchangeName || '',
          longName: meta.longName || meta.shortName || symbol,
          recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2)))
        });
      }
      return res.status(404).json({ error: `No price data for ${symbol}` });
    }

    const currentPrice = quote.c;
    const m = metric.metric || {};
    const beta = Math.min(Math.max(m.beta || 1.0, 0.3), 3.0);

    let closes = [];
    try {
      const chart = yahooRes?.chart?.result?.[0];
      if (chart?.indicators?.quote?.[0]?.close) {
        closes = chart.indicators.quote[0].close.filter(v => v != null && v > 0);
      }
    } catch (e) {}

    let high52w = m['52WeekHigh'] || quote.h || currentPrice * 1.3;
    let low52w  = m['52WeekLow']  || quote.l || currentPrice * 0.7;

    // ── IPO/stale-data sanity check (bug: SPCX showed 52w $21-$27 vs price $169) ──
    // If the live price sits OUTSIDE the reported 52w range, that range is impossible:
    // Finnhub is returning stale or pre-IPO secondary-market data. Rebuild from real history.
    const recentIPO = closes.length > 0 && closes.length < 60;
    let rangeUnreliable = false;
    if (currentPrice > high52w * 1.02 || currentPrice < low52w * 0.98) {
      rangeUnreliable = true;
      if (closes.length >= 2) {
        high52w = Math.max(...closes, currentPrice);
        low52w  = Math.min(...closes, currentPrice);
      } else {
        high52w = Math.max(quote.h || currentPrice, currentPrice);
        low52w  = Math.min(quote.l || currentPrice, currentPrice) * 0.95;
      }
    }

    let mu, sigma, return30d;

    if (closes.length >= 30) {
      const dailyReturns = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i-1] > 0) {
          dailyReturns.push(Math.log(closes[i] / closes[i-1]));
        }
      }

      const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const varDaily  = dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / dailyReturns.length;

      const lambda = 0.94;
      let ewmaVar = varDaily;
      const recentReturns = dailyReturns.slice(-60);
      recentReturns.forEach(r => {
        ewmaVar = lambda * ewmaVar + (1 - lambda) * r * r;
      });
      const ewmaSigma = Math.sqrt(ewmaVar);

      const historicalSigma = Math.sqrt(varDaily * 252);
      const currentSigma    = ewmaSigma * Math.sqrt(252);
      sigma = historicalSigma * 0.40 + currentSigma * 0.60;
      sigma = Math.min(Math.max(sigma, 0.10), 1.50);

      const rf = 0.045;
      const erp = 0.055;
      const capmMu = rf + beta * erp;
      mu = Math.min(Math.max(capmMu, 0.02), 0.30);

      const idx30 = Math.max(0, closes.length - 31);
      return30d = (closes[closes.length - 1] - closes[idx30]) / closes[idx30];
    } else if (recentIPO || rangeUnreliable) {
      // Recent IPO with thin history (e.g. SPCX days after listing): Parkinson on a
      // stale/tiny range grossly understates vol. Fresh listings trade at 60-90% annualized.
      if (closes.length >= 5) {
        const rets = [];
        for (let i = 1; i < closes.length; i++) {
          if (closes[i] > 0 && closes[i-1] > 0) rets.push(Math.log(closes[i] / closes[i-1]));
        }
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
        sigma = Math.min(Math.max(Math.sqrt(v * 252), 0.60), 1.50);
      } else {
        sigma = 0.70; // IPO default until real history accumulates
      }
      mu = Math.min(Math.max(0.045 + beta * 0.055, 0.04), 0.30);
      return30d = quote.dp ? quote.dp / 100 : 0; // no meaningful 30d return for a days-old listing
    } else {
      const parkinson = Math.log(high52w / low52w) / Math.sqrt(4 * Math.log(2));
      sigma = Math.min(Math.max(parkinson * (1 + (beta - 1) * 0.25), 0.15), 1.20);
      mu = Math.min(Math.max(0.045 + beta * 0.055, 0.04), 0.30);
      return30d = m['1MonthPriceReturnDaily'] ? m['1MonthPriceReturnDaily'] / 100 :
                  m['13WeekPriceReturnDaily'] ? m['13WeekPriceReturnDaily'] / 100 / 13 * 4 :
                  quote.dp ? quote.dp / 100 * 21 :
                  (currentPrice - (quote.pc || currentPrice)) / (quote.pc || currentPrice);
    }

    const dayChange = quote.dp != null ? quote.dp / 100 :
                      quote.pc ? (currentPrice - quote.pc) / quote.pc : 0;

    // Best-available longName: Finnhub profile → Yahoo meta → symbol
    let yahooLongName = null;
    try {
      const yMeta = yahooRes?.chart?.result?.[0]?.meta;
      yahooLongName = yMeta?.longName || yMeta?.shortName || null;
    } catch (e) {}

    // ── Short interest, ownership (from Finnhub metric — already fetched) ──
    const pickNum = (...vals) => {
      for (const v of vals) if (Number.isFinite(v)) return v;
      return null;
    };
    const shortPct    = pickNum(m.shortInterestSharesPercent, m.shortPercentOfFloat, m.shortPercentageOfSharesOutstanding);
    const shortRatio  = pickNum(m.shortRatio);
    const instPct     = pickNum(m.institutionalOwnership, m.institutionalOwnershipPercent, m.percentInstitutions);
    const insiderPct  = pickNum(m.insiderOwnership, m.insiderOwnershipPercent, m.percentInsiders);

    // ── Analyst consensus → label + numeric score 1..5 ──
    let analystSignal = null, analystScore = null, analystCount = null;
    if (Array.isArray(recRes) && recRes.length > 0) {
      const r = recRes[0]; // most recent period
      const total = (r.strongBuy||0) + (r.buy||0) + (r.hold||0) + (r.sell||0) + (r.strongSell||0);
      if (total > 0) {
        const w = ((r.strongBuy||0)*5 + (r.buy||0)*4 + (r.hold||0)*3 + (r.sell||0)*2 + (r.strongSell||0)*1) / total;
        analystScore = parseFloat(w.toFixed(2));
        analystCount = total;
        analystSignal = w >= 4.5 ? 'STRONG BUY' : w >= 3.5 ? 'BUY' : w >= 2.5 ? 'HOLD' : w >= 1.5 ? 'SELL' : 'STRONG SELL';
      }
    }

    // ── Insider activity over last 90 days: net dollar value of transactions ──
    let insiderActivity = null, insiderNetValue = null, insiderTxnCount = null;
    if (insiderRes && Array.isArray(insiderRes.data)) {
      const txns = insiderRes.data;
      insiderTxnCount = txns.length;
      // change > 0 = buy, change < 0 = sell; use price-weighted dollar value
      let net = 0;
      for (const tx of txns) {
        const change = Number(tx.change) || 0;
        const txPrice = Number(tx.transactionPrice) || currentPrice;
        net += change * txPrice;
      }
      insiderNetValue = Math.round(net);
      if (insiderTxnCount === 0) insiderActivity = 'NONE';
      else if (insiderNetValue > 100000) insiderActivity = 'BUYING';
      else if (insiderNetValue < -100000) insiderActivity = 'SELLING';
      else insiderActivity = 'MIXED';
    }

    return res.status(200).json({
      ticker: symbol,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      mu: parseFloat(mu.toFixed(4)),
      muSE: 0.08,  // ±8pp standard error (DM equities have tighter CI than EM or crypto)
      sigma: parseFloat(sigma.toFixed(4)),
      beta: parseFloat(beta.toFixed(2)),
      high52w: parseFloat(high52w.toFixed(2)),
      low52w: parseFloat(low52w.toFixed(2)),
      recentIPO,
      rangeUnreliable,
      return30d: parseFloat(return30d.toFixed(4)),
      dayChange: parseFloat(dayChange.toFixed(4)),
      dataPoints: closes.length || 252,
      asset_type: 'stock',
      currency: profile.currency || 'USD',
      exchange: profile.exchange || '',
      longName: profile.name || yahooLongName || symbol,
      recentPrices: closes.slice(-30).map(p => parseFloat(p.toFixed(2))),
      // Real fundamentals for screener
      shortPct, shortRatio, instPct, insiderPct,
      analystSignal, analystScore, analystCount,
      insiderActivity, insiderNetValue, insiderTxnCount
    });

  } catch (err) {
    return res.status(500).json({ error: `Stock fetch failed: ${err.message}` });
  }
}
