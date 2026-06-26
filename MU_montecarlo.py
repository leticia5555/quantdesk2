#!/usr/bin/env python3
"""
MU Monte Carlo — replicates the QuantDesk app.html GBM/Kelly engine methodology.
All inputs derived from REAL, cited MU market data (as-of 2026-06-26). No fabricated inputs.

Drift (mu) per QuantDesk price.js US-stock path:  mu = clamp(rf + beta*erp, 0.02, 0.30)
  rf  = 0.045  (module constant; 10Y actual 4.4% -> negligible diff)
  erp = 0.055  (module constant equity risk premium)  [SUPUESTO: module default]
  beta = 2.08  (CNBC; TradingView reports 3.05 -> sensitivity run included)
Vol (sigma) per price.js:  sigma = 0.4*historical + 0.6*EWMA, clamp [0.10, 1.50]
  historical 120d realized vol = 0.9278 (alphaquery), recent/EWMA proxy = 1.08 (30d IV mean)
  -> 0.4*0.9278 + 0.6*1.08 = 1.019  (under 1.50 clamp)
Per-trade horizon h = 21 trading days (~1 month hold)  [SUPUESTO: documented]
Paths = 2000 (module SIMS); Trades sequence = 50 (risk-of-ruin horizon)
"""
import numpy as np

np.random.seed(42)  # reproducible

# ---- REAL inputs ----
S0        = 1162.20      # current price (multi-source consistent, as-of 2026-06-26)
beta      = 2.08         # CNBC
rf        = 0.045        # module rf
erp       = 0.055        # module erp
sigma_ann = 0.4*0.9278 + 0.6*1.08   # = 1.019 annualized
mu_ann    = min(max(rf + beta*erp, 0.02), 0.30)   # CAPM clamped -> 0.1594

h_days    = 21
H         = h_days/252.0
N         = 2000
TRADES    = 50

def run(mu_ann, sigma_ann, label):
    # Per-trade GBM terminal simple return over horizon H
    Z = np.random.standard_normal((N, TRADES))
    drift = (mu_ann - 0.5*sigma_ann**2)*H
    diff  = sigma_ann*np.sqrt(H)
    log_r = drift + diff*Z
    r = np.exp(log_r) - 1.0            # simple return per trade

    # Single-trade distribution (first column as representative draw set across all paths*trades)
    all_r = r.flatten()
    win_rate = (all_r > 0).mean()
    exp_pnl  = all_r.mean()
    wins = all_r[all_r > 0]
    losses = all_r[all_r <= 0]
    avg_win = wins.mean() if len(wins) else 0.0
    avg_loss = -losses.mean() if len(losses) else 0.0   # positive magnitude
    b = avg_win/avg_loss if avg_loss > 0 else np.inf

    # Kelly (per-trade payoff odds)
    p = win_rate
    kelly = (p*b - (1-p))/b if b not in (0, np.inf) else 0.0
    kelly = max(0.0, kelly)
    quarter_kelly = 0.25*kelly

    # Sharpe (annualized, analytic GBM): (mu - rf)/sigma
    sharpe_ann = (mu_ann - rf)/sigma_ann
    # Trade-level Sharpe annualized from sim
    sharpe_trade = (all_r.mean()/all_r.std())*np.sqrt(252/h_days)

    # Equity-curve sim: bet a FRACTION f of bankroll each trade, 50 trades, N paths
    def equity_stats(f):
        bankroll = np.ones(N)
        peak = np.ones(N)
        maxdd = np.zeros(N)
        ruined = np.zeros(N, dtype=bool)
        ruin_threshold = 0.20   # bankroll falling to <=20% of start = ruin
        for t in range(TRADES):
            bankroll = bankroll*(1.0 + f*r[:, t])
            bankroll = np.maximum(bankroll, 0.0)
            peak = np.maximum(peak, bankroll)
            dd = (peak - bankroll)/peak
            maxdd = np.maximum(maxdd, dd)
            ruined |= (bankroll <= ruin_threshold)
        return bankroll, maxdd, ruined

    out = {}
    for name, f in [("full_kelly", kelly), ("quarter_kelly", quarter_kelly), ("fixed_5pct", 0.05)]:
        final, maxdd, ruined = equity_stats(f)
        out[name] = dict(
            f=f,
            median_final=np.median(final),
            mean_final=final.mean(),
            worst_final=final.min(),
            median_maxdd=np.median(maxdd),
            worst_maxdd=maxdd.max(),
            risk_of_ruin=ruined.mean(),
        )

    print(f"\n===== {label} =====")
    print(f"Inputs: mu_ann={mu_ann:.4f} ({mu_ann*100:.1f}%), sigma_ann={sigma_ann:.4f} ({sigma_ann*100:.1f}%), "
          f"beta={beta}, horizon={h_days}d, paths={N}, trades={TRADES}")
    print(f"Per-trade ({h_days}d): win_rate={win_rate*100:.1f}%  exp_PnL={exp_pnl*100:.2f}%  "
          f"avg_win={avg_win*100:.2f}%  avg_loss={avg_loss*100:.2f}%  payoff_b={b:.2f}")
    print(f"Sharpe (annualized, analytic)={sharpe_ann:.3f}   Sharpe (trade-level annualized)={sharpe_trade:.3f}")
    print(f"Kelly fraction={kelly*100:.1f}%   Quarter-Kelly={quarter_kelly*100:.1f}%")
    for name in ("full_kelly","quarter_kelly","fixed_5pct"):
        o = out[name]
        print(f"  [{name:13s} f={o['f']*100:5.1f}%]  median_final={o['median_final']:.2f}x  "
              f"mean_final={o['mean_final']:.2f}x  worst_path={o['worst_final']:.3f}x  "
              f"median_maxDD={o['median_maxdd']*100:.1f}%  worst_maxDD={o['worst_maxdd']*100:.1f}%  "
              f"risk_of_ruin(<=20%)={o['risk_of_ruin']*100:.1f}%")

run(mu_ann, sigma_ann, "BASE CASE (beta=2.08, sigma=1.02)")
# Sensitivity: higher beta (TradingView 3.05) -> higher CAPM mu
run(min(max(rf + 3.05*erp,0.02),0.30), sigma_ann, "SENSITIVITY (beta=3.05 -> mu capped)")
# Sensitivity: lower vol (use 120d realized 0.9278 only)
run(mu_ann, 0.9278, "SENSITIVITY (sigma=0.93, 120d realized only)")
