import math
from dataclasses import dataclass
import numpy as np

# Cash shortfalls aren't declared debt but still get funded somehow
# (overdraft, credit card, payday loan) - shouldn't be free in the sim.
# 40% EAR, the top end of UK arranged-overdraft rates in 2026 (Lloyds,
# Halifax, HSBC, Nationwide, Santander, First Direct at 39.9%). Harsh on
# purpose.
#
# EAR is annual, so convert to monthly with (1+EAR)^(1/12)-1, not
# 0.40/12 (that overshoots to ~48% effective annual). Different
# convention to main.py's APRs (apr/100/12) - those are headline
# figures, not effective ones.
NEGATIVE_BALANCE_RATE = 1.40 ** (1 / 12) - 1

# 200,000 paths - convergence_study.md suggests past this point, added
# computation buys diminishing precision (SE only shrinks as 1/sqrt(N)).
N_PATHS = 200_000


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
    N: int = N_PATHS,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> np.ndarray:
    """
    Runs the sim, returns the per-path default flag (shape (N,), bool).
    Split from prob_default_12m so the CI can use antithetic-pair variance
    (_prob_margin_antithetic) instead of treating all N paths as
    independent.

    Default = 3 consecutive negative-balance months, not one bad month
    (matches the README).

    Everything's vectorised except the 12-month loop - no Python loop over
    paths or debts.
    """

    k = len(d)
    if not (len(p) == len(t) == len(r) == k):
        raise ValueError("d, p, t and r must all be the same length")
    if var_I < 0 or var_E < 0:
        raise ValueError("variances can't be negative")
    if not (-1.0 <= rho_IE <= 1.0):
        raise ValueError("rho_IE must be in [-1, 1]")
    if N <= 0:
        raise ValueError("N must be a positive integer")

    d = np.array(d, dtype=float)
    p = np.array(p, dtype=float)
    t = np.array(t, dtype=float)
    r = np.array(r, dtype=float)

    sigma_I = math.sqrt(var_I)
    sigma_E = math.sqrt(var_E)

    rng = np.random.default_rng(seed)

    # Antithetic sampling: draw N//2 shocks, mirror (negate) each for the
    # other half. A path and its mirror move opposite ways, so averaging
    # cancels some noise - default only gets worse with a bad shock, never
    # better, so this works.
    #
    # Paths [0,half) are the draws, [half,2*half) their mirrors in the
    # same order (i <-> half+i) - _prob_margin_antithetic depends on that
    # layout. Odd N tacks on one extra unmirrored path.
    #
    # shape (*, 12, 2): two normals per path per month, since income and
    # expenses come out correlated below, not independent.
    half = N // 2
    Z_half = rng.standard_normal((half, 12, 2))
    Z = np.concatenate([Z_half, -Z_half], axis=0)
    if N % 2 == 1:
        Z_extra = rng.standard_normal((1, 12, 2))
        Z = np.concatenate([Z, Z_extra], axis=0)

    income   = mu_I + sigma_I * Z[..., 0]   # X = mu + sigma*Z

    # Bad income months (lost hours, job loss) tend to drag expenses down
    # too, so these shouldn't be independent. Expenses' random part =
    # rho_IE * income's shock + its own noise, weighted to stay a proper
    # standard normal. rho_IE=1 -> tracks income exactly, rho_IE=0 -> old
    # independent behaviour.
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

        # used to be `defaulted |= (B < 0)` - single bad month = default
        short_this_month = active & (B < 0)
        consecutive_shortfall_months[short_this_month] += 1
        consecutive_shortfall_months[active & ~short_this_month] = 0

        defaulted |= (consecutive_shortfall_months >= 3)  # Basel II 90-days-past-due -> 3 months

        # Shortfall compounds at NEGATIVE_BALANCE_RATE next month - same
        # mechanic as the declared-debt interest above, just applied to
        # the implicit debt of being cash-negative.
        in_shortfall = active & (B < 0)
        B[in_shortfall] *= (1.0 + NEGATIVE_BALANCE_RATE)

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
    N: int = N_PATHS,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> float:
    """Point estimate only - thin wrapper around _simulate_defaults, see that for the actual sim."""
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


# Log-odds (scorecard-style) mapping from PD to a 0-100 score, same shape
# real scorecards (FICO etc.) use. Replaces the old linear score =
# (1-p)*100, which understated risk mid-range (30% PD read as a "decent"
# 70/100). Anchors are a modelling choice, not a fit - no real
# default-outcome data to calibrate against. See FEATURES.md for the full
# derivation and alternatives considered.
#
# Not underscore-prefixed like the private helpers below: sensitivity_analysis.py
# monkeypatches these from outside the module.
ANCHOR_P1, ANCHOR_S1 = 0.01, 90.0   # 1% PD -> 90
ANCHOR_P2, ANCHOR_S2 = 0.50, 10.0   # 50% PD (coin-flip) -> 10


def _score_transform(p: float) -> float:
    """
    score = offset + factor * ln((1-p)/p). (1-p)/p is the odds of NOT
    defaulting, so score falls as p rises without a negative factor.
    offset/factor come from the two anchors above - re-calibrating means
    changing a constant, not this function.

    p=0/p=1 clamp to 100/0 directly (ln((1-p)/p) is +/-infinity there).
    """
    if p <= 0.0:
        return 100.0
    if p >= 1.0:
        return 0.0

    log_odds_1 = math.log((1 - ANCHOR_P1) / ANCHOR_P1)
    log_odds_2 = math.log((1 - ANCHOR_P2) / ANCHOR_P2)

    factor = (ANCHOR_S1 - ANCHOR_S2) / (log_odds_1 - log_odds_2)
    offset = ANCHOR_S2 - factor * log_odds_2

    raw = offset + factor * math.log((1 - p) / p)
    return max(0.0, min(100.0, raw))


def _prob_margin_antithetic(
    defaulted: np.ndarray,
    N: int,
    z: float = 1.96,   # Phi^-1(0.975): 95% two-sided normal critical value
) -> float:
    """
    95% margin on the probability estimate (0-1, not score points),
    correct for antithetic pairing. Renamed from _score_margin_antithetic
    now the transform is non-linear - the margin has to go through
    _score_transform at each endpoint, not get rescaled by x100 (see
    shield_score).

    i and half+i are mirrors (see _simulate_defaults) - correlated, not
    independent, so plugging all N into sqrt(p(1-p)/N) is wrong. Pairs
    ARE independent of each other, so average each pair (0, 0.5 or 1) and
    take the SE on those `half` averages instead.

    Odd N's leftover unpaired path gets dropped here, still counted in
    the point estimate.
    """
    half = N // 2
    pair_avg = (defaulted[:half].astype(float) + defaulted[half:2 * half].astype(float)) / 2.0
    se = pair_avg.std(ddof=1) / math.sqrt(half)
    return z * se


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
    N: int = N_PATHS,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> ScoreResult:
    """
    Log-odds transform of prob_default_12m onto 0-100 (_score_transform),
    plus a 95% CI from Monte Carlo sampling noise - how much the score
    could move on a different seed, not real-world uncertainty about the
    household.

    ci_low/ci_high aren't symmetric around score (non-linear transform).
    Margin is computed in probability space, then each endpoint goes
    through the same transform as the point estimate - can't just rescale
    a single +/- margin like the old linear version did.
    """
    defaulted = _simulate_defaults(
        mu_I=mu_I, mu_E=mu_E, var_I=var_I, var_E=var_E,
        d=d, p=p, t=t, r=r, B0=B0, N=N, rho_IE=rho_IE, seed=seed,
    )
    prob        = float(defaulted.mean())
    prob_margin = _prob_margin_antithetic(defaulted, N)

    prob_low  = max(0.0, prob - prob_margin)   # lower PD  -> higher score
    prob_high = min(1.0, prob + prob_margin)   # higher PD -> lower score

    return ScoreResult(
        score   = round(_score_transform(prob), 1),
        ci_low  = round(_score_transform(prob_high), 1),
        ci_high = round(_score_transform(prob_low), 1),
    )
