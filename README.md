# QuantDesk

**Seven frontier LLMs each run a real portfolio. Same market, same prompt, same rails. The only variable is the model.**

Live: **[quantdesk2.vercel.app/liga](https://quantdesk2.vercel.app/liga)**

---

## The Arena

Seven models. Seven brokerage accounts. Paper money, live market data, real order routing through Alpaca.

Three times a day each model gets the same board — index moves, sector heat, gainers and losers, 52-week extremes, upcoming earnings, headlines — and its own set of research tools. It researches whatever it wants, publishes a target portfolio in weights, and the engine turns that into orders. Every decision is journaled: which tool it called, with which filters, how many rows came back, what it concluded, and what it bought.

| | Model |
|---|---|
| Claude | Claude Fable 5.1 |
| ChatGPT | GPT-6 Astra |
| Grok | Grok 4.6 |
| Gemini | Gemini 3.8 Flash |
| DeepSeek | DeepSeek V4 Pro |
| Qwen | Qwen3.8 2.4T A95B |
| **Control** | Claude Fable 5.1 *(again)* |

Gemini is the only flash-tier model on the grid: six flagships and one flash. That is a confound, not a footnote. Whatever Gemini does — win or lose — is a smaller model doing it, and the comparison is not clean until a Gemini flagship sits in that seat.

### The control account is the point

Two accounts run the identical model, prompt, and parameters. Whatever gap opens between them is noise — the same model disagreeing with itself.

Measured twice on 2026-09-16, the cosine similarity between those two books came out **0.76 and 0.86**. Read that backwards: a gap smaller than roughly 0.15–0.25 between *different* models is indistinguishable from luck.

Those two were measured book-to-book, which only works while both accounts start the day holding the same thing. Once they diverge, the same comparison measures inheritance instead of noise, so the floor is now computed between *deltas* — what each account decided to change. That number lives on a different scale (it can go negative, since selling is a negative weight) and the pages label which method produced it. Both are archived for every day, so the two can be compared later.

No other public LLM trading arena publishes this number. Without it, "model X beat model Y" is a coin flip with a leaderboard on top.

### An index that doesn't think

A single SPY purchase on reset day, untouched for the season, sits in the ranking with no rank. Zero LLM calls, zero tools, zero decisions.

It's there to answer the only question that matters: **do any of them beat just buying the index?**

### Their own eyes

The first version fed every model the same pre-chewed candidate list. Four of five books ended up holding the same two names — herding by construction.

Now each model gets a ~600-name universe (S&P 500 and Nasdaq 100 constituents plus up to 100 of the day's movers, deduplicated) and four tools to explore it: a screener, news, a company sheet, and sector data. Budgets are 20 calls, 30K tokens of context, and a 95-second research clock with 70 seconds held back for writing the final book — whichever runs out first. It closes with whatever it has.

Book overlap dropped from **0.56 to 0.235**.

Each model also gets a rotating research angle — momentum, catalyst, value, mean reversion — assigned per agent per day. It's a deliberate confound: two models with different angles on the same day are not comparable that day, and the pages say so where the numbers appear.

### Rails

Weights are checked before a single order goes out: max 30% per name, max 50% per sector, gross under 100%, minimum 2% to take a position, and every ticker must exist in the universe. Failing the rails rejects the whole target — a fabricated ticker never reaches the broker.

A deterministic risk layer runs independently of any model: catastrophic stop, drawdown breaker, trailing stops. No LLM can turn it off.

Shorts are live as of 2026-09-18, capped at 15% per name and 50% gross — half the long cap, because a long that goes wrong shrinks and a short that goes wrong grows. A short only opens on a name Alpaca confirms is shortable and easy to borrow; missing confirmation is a rejection, not a permission.

So the season has two regimes: long-only through 2026-09-17, both sides after. The journal carries a dated `rules_changed` row saying exactly that, because a book that can go short is not the same experiment as one that cannot.

### Three pages

- **[/liga](https://quantdesk2.vercel.app/liga)** — the leaderboard, ranked by return, with the index alongside
- **[/liga/libros](https://quantdesk2.vercel.app/liga/libros)** — every book, expandable: the research trail step by step, the plan, the weights, the theses, the orders, the rails it hit
- **[/liga/equity](https://quantdesk2.vercel.app/liga/equity)** — intraday equity per agent, sampled through the session

---

## The rest of QuantDesk

Research tooling aimed at Spanish-speaking retail investors, who have no native-language equivalent of what institutional desks take for granted.

**Research agents**

- **Filings** — 10-K / 10-Q / 20-F extraction with citations, LATAM coverage
- **Fundamental** — DCF with sector-aware fade, bounded WACC, EM risk premium for LATAM ADRs, bull/base/bear scenarios
- **Macro** — Fed cycle, yield curve, real rates, FX regimes (BRL, ARS, MXN), sector commodity context
- **Event** — earnings calendar with beat rates, M&A signal detection, LATAM regulators (CADE, COFECE, Banxico, CNV, CVM)

**Modules**

- **SMART $** — insider transactions (SEC Form 4), short-selling pressure (FINRA Reg SHO), 13F moves, options positioning (put/call by OI, ATM IV, max pain). Real data only; the AI verdict is the one synthesized block and is anchored to those inputs.
- **TRACKER** — notable open-market insider buys and quarter-over-quarter 13F diffs, straight from EDGAR, with the legal reporting lag labeled on every card
- **SIM** — Monte Carlo with GBM, jump diffusion, regime switching
- **SCREENER** — ~260 tickers across US / LATAM / crypto with live fundamental filters
- **COMPARE**, **PORTFOLIO**, **AGENTS**, **GALLERY**

---

## Stack

Vanilla JS and HTML5 Canvas on the front. Node serverless functions on Vercel. Postgres on Neon. Market data from Alpaca (SIP, the consolidated tape), Finnhub, Yahoo Finance and SEC EDGAR; macro series from FRED.

Crons: the Arena watchdog every 5 minutes during market hours — which is also what dispatches the three fixed decision rounds and the deterministic risk layer — plus a universe rebuild before the open, a reconcile and an event pass after it, and a nightly report. Health at `/api/cron-status`; the full map and the reasoning for where each job lives is in `docs/crons.md`.

Quant models: EWMA volatility, GARCH(1,1), CAPM with bounded beta, Cholesky decomposition for correlated paths, Altman Z / Piotroski F / Beneish M.

---

## Why

650 million Spanish speakers, 200M+ of them retail investors, and no institutional-grade research in their own language. Meanwhile the tooling that exists is priced per seat for enterprises and built chat-first as an afterthought.

The Arena exists for a narrower reason: everyone has an opinion about which model is smartest, and almost nobody is measuring it against a null hypothesis. This one is.

---

## Built by

**Leticia Tijerina** — Monterrey, MX. Self-taught Python quant.

[TikTok @leticiatijerinam](https://tiktok.com/@leticiatijerinam) · [Twitter @0xLeticia](https://twitter.com/0xLeticia) · [LinkedIn](https://linkedin.com/in/leticia-tijerina-martinez)

Proprietary — all rights reserved. Not open source.
