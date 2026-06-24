// ═══════════════════════════════════════════════════════════════
// /api/connections — "Buscador de Conexiones"
//
// Given ONE subject ticker, compute its correlation against a
// curated universe and return a ranked list (strongest first),
// in a shape ready for plain-Spanish display.
//
// Reuses the exact fetch + log-return + Pearson logic from
// /api/correlations.js, restructured for "one vs universe".
//
// Input:   ?ticker=AMXL.MX            (the subject)
//          &universe=FEMSAUBD.MX,WALMEX.MX,...  (optional override)
// Output:  {
//            subject: "AMXL.MX",
//            n_days: 124,
//            results: [
//              { ticker, r, strength, direction, hedge },
//              ...sorted by |r| desc
//            ],
//            failed: [...]
//          }
// ═══════════════════════════════════════════════════════════════

// Curated LATAM-relevant universe. Yahoo symbols.
// Keep this ~30-40 names: fast, reliable, and more useful than 260.
// (BMV tickers use the .MX suffix on Yahoo; ADRs use US symbols.)
const DEFAULT_UNIVERSE = [
  // Mexican large caps (BMV)
  'AMXB.MX','FEMSAUBD.MX','WALMEX.MX','GFNORTEO.MX','CEMEXCPO.MX',
  'GMEXICOB.MX','BIMBOA.MX','KIMBERA.MX','ELEKTRA*.MX','ALSEA.MX',
  'ORBIA.MX','PINFRA.MX','GAPB.MX','ASURB.MX','OMAB.MX','LIVEPOLC-1.MX',
  // LATAM ADRs / regional
  'MELI','VALE','ITUB','BBD','PBR','NU','GGB','SID',
  // Macro anchors
  'MXN=X',        // USD/MXN (peso)
  'BTC-USD','ETH-USD',
  'CL=F',         // WTI crude
  'GC=F',         // gold
  '^GSPC',        // S&P 500
  '^MXX',         // IPC Mexico index
  'DX-Y.NYB'      // US dollar index
];

// Friendly names + one-line descriptions for display (extend as needed).
const META = {
  'AMXB.MX':{name:'AMXB', desc:'América Móvil (Serie B) — telecom'},
  'FEMSAUBD.MX':{name:'FEMSA', desc:'FEMSA — bebidas / retail'},
  'WALMEX.MX':{name:'WALMEX', desc:'Walmart de México'},
  'GFNORTEO.MX':{name:'GFNORTE', desc:'Banorte — banca'},
  'CEMEXCPO.MX':{name:'CEMEX', desc:'Cemex — cemento'},
  'GMEXICOB.MX':{name:'GMÉXICO', desc:'Grupo México — minería'},
  'BIMBOA.MX':{name:'BIMBO', desc:'Grupo Bimbo — alimentos'},
  'KIMBERA.MX':{name:'KIMBER', desc:'Kimberly-Clark México'},
  'ELEKTRA*.MX':{name:'ELEKTRA', desc:'Grupo Elektra — retail / crédito'},
  'ALSEA.MX':{name:'ALSEA', desc:'Alsea — restaurantes'},
  'ORBIA.MX':{name:'ORBIA', desc:'Orbia — químicos'},
  'PINFRA.MX':{name:'PINFRA', desc:'Pinfra — infraestructura'},
  'GAPB.MX':{name:'GAP', desc:'Grupo Aeroportuario Pacífico'},
  'ASURB.MX':{name:'ASUR', desc:'Aeropuertos del Sureste'},
  'OMAB.MX':{name:'OMA', desc:'Aeropuertos Centro-Norte'},
  'LIVEPOLC-1.MX':{name:'LIVEPOL', desc:'Liverpool — retail'},
  'MELI':{name:'MELI', desc:'MercadoLibre — e-commerce'},
  'VALE':{name:'VALE', desc:'Vale — minería Brasil'},
  'ITUB':{name:'ITAÚ', desc:'Itaú Unibanco — banca Brasil'},
  'BBD':{name:'BRADESCO', desc:'Banco Bradesco'},
  'PBR':{name:'PETROBRAS', desc:'Petrobras — petróleo Brasil'},
  'NU':{name:'NU', desc:'Nubank — fintech'},
  'GGB':{name:'GERDAU', desc:'Gerdau — acero'},
  'SID':{name:'CSN', desc:'Siderúrgica Nacional'},
  'MXN=X':{name:'USD/MXN', desc:'Peso mexicano vs dólar'},
  'BTC-USD':{name:'BTC', desc:'Bitcoin'},
  'ETH-USD':{name:'ETH', desc:'Ethereum'},
  'CL=F':{name:'WTI', desc:'Petróleo crudo WTI'},
  'GC=F':{name:'Oro', desc:'Oro spot'},
  '^GSPC':{name:'S&P 500', desc:'Índice EE.UU.'},
  '^MXX':{name:'IPC', desc:'Índice de la BMV'},
  'DX-Y.NYB':{name:'DXY', desc:'Índice del dólar'}
};

function classify(r){
  const a = Math.abs(r);
  if (a >= 0.5) return 'fuerte';
  if (a >= 0.3) return 'moderada';
  if (a >= 0.15) return 'debil';
  return 'ninguna';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const subject = (req.query.ticker || '').trim().toUpperCase();
  if (!subject) return res.status(400).json({ error: 'Need ?ticker=SYMBOL' });

  // Universe = override or default, minus the subject itself.
  const universeParam = (req.query.universe || '').trim();
  const universe = (universeParam
      ? universeParam.split(',').map(t => t.trim()).filter(Boolean)
      : DEFAULT_UNIVERSE)
    .filter(t => t.toUpperCase() !== subject);

  // All symbols to fetch (subject first).
  const symbols = [subject, ...universe];

  // --- same fetch logic as /api/correlations.js ---
  const fetchHistorical = async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return null;
      const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0);
      if (closes.length < 30) return null;
      return closes;
    } catch { return null; }
  };

  try {
    const allCloses = await Promise.all(symbols.map(fetchHistorical));

    // Subject must have data.
    if (!allCloses[0]) {
      return res.status(200).json({
        subject, n_days: 0, results: [],
        error: `No hay datos suficientes para ${subject}.`
      });
    }

    // Keep only symbols that loaded.
    const valid = [];
    for (let i = 0; i < symbols.length; i++) {
      if (allCloses[i] && allCloses[i].length >= 30) {
        valid.push({ sym: symbols[i], closes: allCloses[i] });
      }
    }

    // Align everything to the shortest series so days line up.
    const minLen = Math.min(...valid.map(v => v.closes.length));
    valid.forEach(v => { v.closes = v.closes.slice(v.closes.length - minLen); });

    const toReturns = (closes) => {
      const r = [];
      for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
      return r;
    };
    valid.forEach(v => { v.rets = toReturns(v.closes); });

    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const std  = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));

    const subj = valid.find(v => v.sym === subject);
    const subjMean = mean(subj.rets);
    const subjStd  = std(subj.rets, subjMean);
    const T = subj.rets.length;

    const results = [];
    for (const v of valid) {
      if (v.sym === subject) continue;
      const m = mean(v.rets);
      const s = std(v.rets, m);
      let cov = 0;
      for (let t = 0; t < T; t++) cov += (subj.rets[t] - subjMean) * (v.rets[t] - m);
      cov /= (T - 1);
      let r = cov / (subjStd * s);
      r = Math.max(-0.999, Math.min(0.999, r));
      r = +r.toFixed(3);

      const meta = META[v.sym] || { name: v.sym, desc: '' };
      results.push({
        ticker: v.sym,
        name: meta.name,
        desc: meta.desc,
        r,
        strength: classify(r),
        direction: r >= 0 ? 'misma' : 'opuesta',
        hedge: r <= -0.3            // strong-ish negative = natural hedge
      });
    }

    results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

    const subjMeta = META[subject] || { name: subject, desc: '' };
    return res.status(200).json({
      subject,
      subjectName: subjMeta.name,
      n_days: T,
      results,
      failed: symbols.filter(s => !valid.find(v => v.sym === s)),
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server exception: ' + (err?.message || 'unknown') });
  }
}
