
# QuantDesk

> Bloomberg Terminal for 650M Spanish speakers. Quant-grade financial intelligence combining institutional analytics, TradingView-style social layer, and AI-native workflows.

**Live:** [quantdesk2.vercel.app](https://quantdesk2.vercel.app)

---

## What it does

QuantDesk gives retail and institutional investors in LATAM the same class of quantitative tooling that Bloomberg Terminal subscribers pay $24,000/year for — accessible, in Spanish, and AI-native from the ground up.

**Core modules**

- **SIM** — Monte Carlo simulations with GBM, jump diffusion, and fat-tail models. Backtesting engine against historical data.
- **COMPARE** — Side-by-side asset comparison with correlation analysis.
- **PORTFOLIO** — Portfolio construction with risk metrics (VaR, Sharpe, max drawdown).
- **MACRO** — Cross-market macro signals across rates, FX, commodities, and equities.
- **SMART $** — Smart money tracker aggregating institutional flows and positioning data.
- **EARNINGS** — Earnings intelligence with post-earnings drift analysis and beat/miss prediction.
- **SCREENER** — Multi-universe screener (US / LATAM / crypto) with fundamental and technical filters.
- **AGENTS** — AI investor agents (Buffett, Burry, Wood, Munger, Dalio) voting on simulations.
- **GALLERY** — Public simulation history and community insights.

---

## Technical architecture

**Frontend**
- Vanilla JS + HTML5 Canvas for custom charts
- Deployed on Vercel

**Backend / Data**
- Python FastAPI microservice on Railway ([`quantdesk-data`](https://github.com/leticia5555/quantdesk-data))
- Finnhub, Yahoo Finance, CoinGecko for market data
- Anthropic Claude API for AI verdicts and natural language synthesis

**Quant models**
- EWMA (Exponentially Weighted Moving Average) volatility
- CAPM with shrinkage estimator
- GARCH(1,1) for volatility forecasting
- Cholesky decomposition for correlated Monte Carlo paths
- Implied volatility integration with fat-tail corrections

---

## Thesis

**LATAM is Bloomberg-underserved.** $250B+ sits in Mexican AFOREs (pension funds) alone. Mexican brokerages (GBM, Actinver, Vector), fintechs (Bitso, Nubank MX, Flink), and an emerging generation of retail quants all need institutional-grade tooling in their language.

**AI-native means built differently.** Every module ships with AI synthesis — not as a chatbot bolted on, but as the default output layer. Users get the quant output AND the plain-Spanish interpretation of what it means.

**Distribution is already solved.** Creator channel [@leticiatijerinam](https://tiktok.com/@leticiatijerinam) (43K, 38.7% Search traffic) provide organic acquisition.

---

## Status

Active development. Shipping 5+ major product tabs in parallel. Solo technical founder.

**YC W26 applicant.**

---

## Founder

**Leticia Tijerina** — Monterrey, MX
Self-taught Python quant. Previously built a 70+ iteration trading bot for Polymarket BTC prediction markets (67% accuracy on spot momentum signals, proprietary Kappa metric for order book manipulation detection). 14+ years in fashion (Derek Lam NYC, ICONY co-founder). MBA Esden, BA Tecnológico de Monterrey.

- Twitter: [@leticiatijerinam](https://tiktok.com/@leticiatijerinam)
- LinkedIn: [leticia-tijerina-martinez](https://www.linkedin.com/in/leticia-tijerina-martinez-46999757/)

---

## License

Proprietary — all rights reserved. Not open source.
