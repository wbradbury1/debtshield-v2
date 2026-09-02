import math
from dataclasses import dataclass
import numpy as np


def _simulate_defaults(
    mu_I: float,
    mu_E: float,
    var_I: float,
    var_E: float,
    d: list[float],
    p: list[float],
    t: list[float],
    r: list[float],
    B0: float = 0.0,
    N: int = 200_000,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> np.ndarray:
    """
    Runs the Monte Carlo simulation and returns the raw per-path default
    indicator, shape (N,), dtype bool. Split out from prob_default_12m so
    the confidence interval can use the correct antithetic-pair variance
    (see _score_margin_antithetic) instead of wrongly treating all N paths
    as independent trials.

    Default = 3 consecutive negative-cash-balance months, not just one bad
    month (matches the README - used to be single-breach, fixed while
    rewriting this function anyway).

    No Python loop over the 200k paths or over debts - only real loop here
    is the 12-month one, everything else is numpy doing all paths at once.

    Parameters
    ----------
    mu_I    : Mean monthly income.
    mu_E    : Mean monthly expenses (excluding debt payments).
    var_I   : Variance of monthly income.
    var_E   : Variance of monthly expenses.
    d       : List of current debt balances.
    p       : List of fixed monthly payments, one per debt.
    t       : List of payment durations (in months). Use math.inf for
              indefinite / interest-only loans.
    r       : List of monthly interest rates, one per debt.
    B0      : Starting cash balance (default 0).
    N       : Number of Monte Carlo trials (default 200,000).
    rho_IE  : Pearson correlation between income and expense shocks.
    seed    : Random seed for reproducibility.

    Returns
    -------
    np.ndarray : Boolean array, shape (N,), True where that path defaulted.
    """

    k = len(d)
    if not (len(p) == len(t) == len(r) == k):
        raise ValueError("d, p, t, and r must all have the same length.")
    if var_I < 0 or var_E < 0:
        raise ValueError("Variances must be non-negative.")
    if not (-1.0 <= rho_IE <= 1.0):
        raise ValueError("rho_IE must be in [-1, 1].")
    if N <= 0:
        raise ValueError("N must be a positive integer.")

    d = np.array(d, dtype=float)
    p = np.array(p, dtype=float)
    t = np.array(t, dtype=float)
    r = np.array(r, dtype=float)

    sigma_I = math.sqrt(var_I)
    sigma_E = math.sqrt(var_E)

    rng = np.random.default_rng(seed)

    # Antithetic sampling: draw N//2 shocks, mirror each one (negate it) for
    # the other N//2. A path and its mirror move opposite ways, so averaging
    # them cancels out some of each one's noise - default only ever gets
    # worse with a bad shock, never better, which is what makes this work.
    #
    # Paths [0, half) are the draws, [half, 2*half) are their mirrors in
    # the same order (path i <-> path half+i). _score_margin_antithetic
    # needs that exact layout to pair them back up. Odd N just tacks on
    # one extra unmirrored path at the end.
    #
    # shape (*, 12, 2): a pair of normals per path per month - need 2
    # because income/expenses come out correlated, not independent (below).
    half = N // 2
    Z_half = rng.standard_normal((half, 12, 2))
    Z = np.concatenate([Z_half, -Z_half], axis=0)
    if N % 2 == 1:
        Z_extra = rng.standard_normal((1, 12, 2))
        Z = np.concatenate([Z, Z_extra], axis=0)

    income   = mu_I + sigma_I * Z[..., 0]   # X = mu + sigma*Z

    # income and expenses shouldn't be independent - a bad income month
    # (lost hours, job loss) usually drags expenses into a bad month too
    # (or vice versa). so expenses' random part = rho_IE * income's shock +
    # its own independent noise, weighted so the result is still a proper
    # standard normal. rho_IE=1 -> expenses tracks income's shock exactly,
    # rho_IE=0 -> fully independent, same as the old behaviour.
    expenses = mu_E + sigma_E * (rho_IE * Z[..., 0]
                                 + math.sqrt(max(0.0, 1.0 - rho_IE**2)) * Z[..., 1])

    net_cash_flow = income - expenses

    B   = np.full(N, B0, dtype=float)
    bal = np.tile(d, (N, 1))

    defaulted = np.zeros(N, dtype=bool)

    # streak of consecutive bad months per path - resets to 0 the second a
    # path goes solvent again, default fires once it hits 3
    consecutive_shortfall_months = np.zeros(N, dtype=int)

    for m in range(1, 13):
        active = ~defaulted

        positive = bal > 0
        bal[active] += (bal * r)[active] * positive[active]

        within_term = (m <= t)
        has_balance = bal > 1e-9

        scheduled = np.minimum(p, bal)
        scheduled = np.where(within_term & has_balance, scheduled, 0.0)

        is_last_month = (m == t)
        residual = np.where(is_last_month & has_balance, bal - scheduled, 0.0)

        total_required = scheduled.sum(axis=1) + residual.sum(axis=1)

        B[active] += net_cash_flow[active, m - 1]
        B[active] -= total_required[active]

        # used to be `defaulted |= (B < 0)` - single bad month = default,
        # didn't match README's 3-consecutive-months rule. bump the streak
        # on a short month, reset on a solvent one, default at 3 in a row
        short_this_month = active & (B < 0)
        consecutive_shortfall_months[short_this_month] += 1
        consecutive_shortfall_months[active & ~short_this_month] = 0

        defaulted |= (consecutive_shortfall_months >= 3)

        payments_made = scheduled + residual
        bal -= payments_made
        bal = np.maximum(bal, 0.0)

    return defaulted


def prob_default_12m(
    mu_I: float,
    mu_E: float,
    var_I: float,
    var_E: float,
    d: list[float],
    p: list[float],
    t: list[float],
    r: list[float],
    B0: float = 0.0,
    N: int = 200_000,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> float:
    """
    Estimate the probability of defaulting within the next 12 months via
    Monte Carlo simulation. Thin wrapper around _simulate_defaults for
    callers that just want the point estimate - see that function for the
    actual simulation and parameter docs.
    """
    defaulted = _simulate_defaults(
        mu_I=mu_I, mu_E=mu_E, var_I=var_I, var_E=var_E,
        d=d, p=p, t=t, r=r, B0=B0, N=N, rho_IE=rho_IE, seed=seed,
    )
    return float(defaulted.mean())


@dataclass
class ScoreResult:
    score: float
    ci_low: float
    ci_high: float


def _score_margin_antithetic(defaulted: np.ndarray, N: int, z: float = 1.96) -> float:
    """
    95% margin on the score - correct for antithetic pairing.

    Path i and half+i are mirrors, so they're correlated, not independent
    trials - can't just plug all N into sqrt(p(1-p)/N). Pairs ARE
    independent of each other though, so average each pair's outcome
    (0, 0.5, or 1), treat those `half` pair-averages as the iid sample,
    and take the usual standard error on that.

    Odd N's leftover unpaired path gets dropped here (still counted in the
    point estimate, just has no partner) - negligible either way.
    """
    half = N // 2
    pair_avg = (defaulted[:half].astype(float) + defaulted[half:2 * half].astype(float)) / 2.0
    se = pair_avg.std(ddof=1) / math.sqrt(half)
    return z * se * 100.0


def shield_score(
    mu_I: float,
    mu_E: float,
    var_I: float,
    var_E: float,
    d: list[float],
    p: list[float],
    t: list[float],
    r: list[float],
    B0: float = 0.0,
    N: int = 200_000,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> ScoreResult:
    """
    Returns the Shield Score: (1 - prob_default_12m) * 100, plus a 95%
    confidence interval around it. The interval reflects Monte Carlo
    sampling noise only - "if we reran this with a different seed, how
    much could the score plausibly move" - not real-world uncertainty
    about the household itself.
    """
    defaulted = _simulate_defaults(
        mu_I=mu_I, mu_E=mu_E, var_I=var_I, var_E=var_E,
        d=d, p=p, t=t, r=r, B0=B0, N=N, rho_IE=rho_IE, seed=seed,
    )
    prob      = float(defaulted.mean())
    raw_score = (1.0 - prob) * 100
    margin    = _score_margin_antithetic(defaulted, N)

    return ScoreResult(
        score   = round(max(0.0, min(100.0, raw_score)), 1),
        ci_low  = round(max(0.0, min(100.0, raw_score - margin)), 1),
        ci_high = round(max(0.0, min(100.0, raw_score + margin)), 1),
    )
