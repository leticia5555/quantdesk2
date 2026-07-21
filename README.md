
# QuantDesk

> AI-native hedge fund research engine for 650M Spanish-speaking retail traders.
> Bloomberg-grade analysis. In Spanish. 

**Live:** [quantdesk2.vercel.app](https://quantdesk2.vercel.app)

---

## What it does

QuantDesk gives retail investors in LATAM the same class of quantitative research that hedge funds and Bloomberg subscribers pay $24K-$77K/year for — accessible, in Spanish, and AI-native from the ground up.

The core product is a suite of **specialized research agents** that each tackle one dimension of institutional research, ship outputs in seconds, and integrate into a unified ticker analysis workflow.

---

## Specialized Research Agents

Four agents in production. Six planned. (AI-Native Hedge Funds).

### 📑 Filings Agent
SEC 10-K / 10-Q + 20-F LATAM coverage. Surfaces inventory commitments, FX exposure, capital controls, regulatory risks. Citation-backed extraction from filings.

### 💰 Fundamental Agent
Quant-grade DCF with sector-aware calibration:
- Bull / Base / Bear scenarios
- Stage-based revenue fade (no naive linear projection)
- Trimmed-mean FCF margin with sector caps
- Bounded WACC with EM risk premium for LATAM ADRs
- Margin of Safety badges (6 categories)
- Confidence indicator (HIGH / MEDIUM / LOW)
- Wall Street consensus comparison

### 🌍 Macro Agent
Macroeconomic context for any ticker:
- US rate environment (Fed cycle, yield curve regime, real rates, VIX)
- Local FX analysis (USD/BRL, USD/ARS, USD/MXN) with regime detection
- Sector-specific commodity context (mining, energy, agriculture)
- LATAM ADR aware — operational country override for tickers domiciled in Cayman / Luxembourg / Uruguay

### 📅 Event Agent
Upcoming catalysts and corporate events:
- Earnings calendar with beat-rate analytics
- M&A signal detection (16 deal keywords)
- LATAM-aware regulatory detection (CADE, COFECE, Banxico, CNV, CVM + US agencies)
- Insider activity with founder-CEO weighting
- Dividend frequency inference
- Primary catalyst thesis + positioning considerations

### Coming next
- Sentiment Agent (NLP on news + social)
- Risk Anomaly Agent (volatility, correlation breakdown, regime shifts)
- Investor Council 2.0 — 10 personalities citing the research agents

---

## Other modules

- **SIM** — Monte Carlo with GBM, jump diffusion, regime switching. Ruin simulator with 100-account animation.
- **COMPARE** — Side-by-side ticker analysis with correlation matrices.
- **PORTFOLIO** — Construction + risk metrics (VaR, Sharpe, max drawdown).
- **SMART $** — Insider transaction tracker via Form 4 filings.
- **TRACKER** — Stock Tracker: notable insider buys (SEC Form 4, open-market P-code buys by officers/directors ≥ $100k) and quarter-over-quarter 13F diffs of famous funds, straight from EDGAR with the legal reporting lag labeled on every card.
- **SCREENER** — ~260 tickers across US / LATAM / crypto with live-data fundamental filters.
- **AGENTS** — Investor personality agents (Buffett, Burry, Wood, Munger, Dalio + LATAM personas in development).
- **GALLERY** — Public simulation history.

---

## Technical architecture

**Frontend**
- Vanilla JS + HTML5 Canvas for custom charts
- Deployed on Vercel (auto-deploy from `main`)

**Backend**
- Node.js serverless functions on Vercel
- Direct integration with Finnhub, Yahoo Finance, CoinGecko, SEC EDGAR
- FRED API for macro time series
- Anthropic Claude API for synthesis and institutional insight generation

**Quant models**
- DCF with sector-aware fade and bounded WACC
- EWMA volatility, GARCH(1,1) forecasting
- CAPM with bounded beta (0.7–2.0) and EM risk premium adjustment
- Cholesky decomposition for correlated Monte Carlo paths
- Altman Z, Piotroski F, Beneish M scoring

---

## Thesis

**LATAM is institutionally underserved.** AlphaSense ($4B valuation, $500M ARR, 6,500 enterprise clients) charges $77K/client/year and ignores Spanish-speaking retail entirely. Bloomberg ($73B) costs $24K/year and is unusable for retail. Boosted.ai ($71M raised) is B2B asset managers only.

**650 million Spanish speakers** — 200M+ retail investors and growing — have no native-language institutional research option.

**AI-native means built differently.** Every research agent ships with quantified insights, scenario analysis, and contrarian institutional reads — not as a chatbot bolted on, but as the default output layer. Conservative bias by design protects retail from sell-side bullish bias.

**Distribution channel exists.** Creator brand [@leticiatijerinam](https://tiktok.com/@leticiatijerinam) (43K, 38.7% Search traffic) provides organic acquisition for LATAM Spanish-speaking retail traders.

---

## Status

Active development. 4 specialized research agents shipped in production over the last 30 days. Solo technical founder.


---

## Founder

**Leticia Tijerina** — Monterrey, MX

Self-taught Python quant. Built a 70+ iteration trading bot for Polymarket BTC prediction markets (67% accuracy on spot momentum signals, proprietary Kappa metric for order book manipulation detection). 14+ years in fashion (Derek Lam NYC, ICONY co-founder, 500K monthly Pinterest views). MBA Esden, BA Tecnológico de Monterrey.

- Twitter: [@0xLeticia](https://x.com/0xLeticia)
- TikTok: [@leticiatijerinam](https://tiktok.com/@leticiatijerinam) (43K, LATAM tech/finance creator)
- LinkedIn: [leticia-tijerina-martinez](https://www.linkedin.com/in/leticia-tijerina-martinez-46999757/)

---

## License

Proprietary — all rights reserved. Not open source.
