import math
import numpy as np


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
    Monte Carlo simulation.

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
    float : Estimated probability of default within 12 months.
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

    # shape (N, 12, 2): a pair of standard normals per path per month. need
    # 2 numbers per month because income/expenses have to come out
    # correlated, not independent - see below.
    Z = rng.standard_normal((N, 12, 2))

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

    return float(defaulted.sum()) / N


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
) -> float:
    """
    Returns the Shield Score: (1 - prob_default_12m) * 100.
    Rounded to one decimal place, clamped to [0, 100].
    """
    prob = prob_default_12m(
        mu_I=mu_I, mu_E=mu_E, var_I=var_I, var_E=var_E,
        d=d, p=p, t=t, r=r, B0=B0, N=N, rho_IE=rho_IE, seed=seed,
    )
    return round(max(0.0, min(100.0, (1.0 - prob) * 100)), 1)
