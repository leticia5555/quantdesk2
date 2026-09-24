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

Both of those are cosine similarities — they answer "do two identical runs *decide* alike?". They do not answer the question anyone actually asks of a leaderboard: did 2nd place really beat 6th? That one is measured in points of return, and a cosine does not convert into percentage points. So the ranking declares a third number, in its own units: **the gap between the two identical accounts' returns**. On 2026-09-21 that was **0.99 points**, against a **1.35-point** spread from 2nd place to 7th — 73% of the visible spread between models is one configuration disagreeing with itself, and no two consecutive places were separated by more than the floor.

That number sits above the table, not under it, and any place whose gap to its neighbour is smaller than the floor is labelled a technical tie on its own row. The count of models losing to the index is stated there too, rather than left for the reader to work out row by row.

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

## The BMV dataset

A point-in-time database of the Mexican stock exchange, 2016–2026. It is the part of this repo that exists nowhere else.

| | |
|---|---:|
| Unique ICS issuers | **137** |
| Series in the census, with status | **185** (109 active / 76 suspended) |
| Quarters of financials | **4,174** |
| Daily price rows, with traded amount | **569,589** |
| Distributions, classified by type and currency | **1,641** |
| Benchmark days (NAFTRAC ISHRS) | **4,207** |

Each quarter carries seven normalized fields — revenue, profit attributable to owners, basic EPS, assets, liabilities, equity, cash — plus the comparative period the source ships alongside it, and the full raw JSON. The raw is kept on purpose: when the normalization turned out to be wrong, 4,174 rows were repaired from storage for **zero** API credits.

### Why point-in-time

Two things, and both are the difference between a backtest and a story.

**The 76 suspended series are in.** They stay in the universe for as long as they had prices. A dataset built from today's listing would have quietly dropped every issuer that was delisted, acquired or suspended — and those are exactly the ones that did badly. Survivorship bias inflates every number downstream of it.

**The universe at each date is derived, not assumed.** Membership comes from the range of financials actually available on that date, not from a list read backwards. An issuer enters when its first quarter becomes available and leaves when it stops trading.

### The piece that isn't available anywhere else

A weekly capture of BMV's XBRL filings that records **the real publication date** of each report — 30 issuers, 30 captured, 0 skipped, 9 of 9 fields each.

No public Mexican source exposes it. DataBursatil, the best available, indexes by *period close*: it tells you the quarter ended March 31, not the day the market could first read it. The gap between those two dates ranged from **23 to 59 days** across the issuers measured — in that same single quarter, so it is a floor on the dispersion, not a distribution.

Without the real date, any backtest over fundamentals has look-ahead — it trades on numbers nobody had yet. The workaround here is to lag everything by **65 days**, past the worst observed delay, which removes the bias at the cost of trading on stale information.

**The captured series is one quarter old.** It holds 2Q2026 and nothing before it: the capture accumulates forward from September 2026, because BMV's pages serve what is published now, not an archive. One date per issuer does not replace a lag across ten years of backtest — that takes years of accumulation. In some years this series will be long enough to date fundamentals by real publication instead of by an estimated wait. Not today.

### What it was used for

A pre-registered backtest of a value + momentum rotation, with every GO/NO-GO criterion frozen in the document before a single number was seen.

**Verdict: NO-GO.** Excess 0.0%/year, t = −0.007, Sharpe 0.35 against NAFTRAC's 0.32 where +0.15 was required. 111 rebalances, 44 median eligible names. Not inconclusive — there was sample and there was universe, and the strategy does not beat the index. No criterion moved after the fact; the diff of [`docs/bmv-rotation.md`](docs/bmv-rotation.md) is the proof.

Three findings outlived the verdict:

- **Value was a drag in two independent markets** — US in August 2026 and Mexico in September, different windows, universes and data sources, same sign. No longer a quirk of one window.
- **The momentum that showed t = 1.87 in the US gives t = 0.08 here.** That 1.87 never passed the threshold of 2, but it invited the reading that it was close. It wasn't a weak effect; it was a regime.
- **Median age of the trailing-twelve-month fundamentals: 397 days.** Any strategy on quarterly fundamentals with an honest lag is trading on information more than a year old. Cutting the lag doesn't fix it — the 65 days are ~16% of the 397, the rest is the TTM window itself.

### What it is not

Research infrastructure, not a product. What makes it worth anything is that it is verified, not that it is large.

The limits, stated rather than discovered later:

- **The financials come from DataBursatil**, a third party with no SLA. The series is reproducible for as long as that service exists — which is part of why the raw is stored.
- **The ex-dividend date is approximated in ~91% of the history.** The API only ships `fechaexcupon` in its recent block; the rest is payment date minus three days. It is applied identically to the basket and the benchmark, so it cancels to first order in the excess — but it is an estimate, not a fact.
- **Foreign-currency distributions are excluded** from total return in v1, with the uncounted basis points reported per series. `/v2/divisas` turned out to be a spot endpoint with no history; the right source is Banxico SIE, which is a different integration.
- **Banks, FIBRAs and insurers are out of v1.** They file under different taxonomies than ICS, and mixing them would mean one series with two definitions.

Full design, frozen criteria and post-mortem in [`docs/bmv-rotation.md`](docs/bmv-rotation.md); the XBRL capture in [`docs/xbrl-capture.md`](docs/xbrl-capture.md).

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

**Leticia Tijerina** — Monterrey, MX. 

[TikTok @leticiatijerinam](https://tiktok.com/@leticiatijerinam) · [Twitter @0xLeticia](https://twitter.com/0xLeticia) · [LinkedIn](https://linkedin.com/in/leticia-tijerina-martinez)

Proprietary — all rights reserved. Not open source.
