"""
Convergence study for the Monte Carlo default-probability estimator.

Reruns the simulation at increasing N on a fixed representative account,
using several independent seeds per N. Checks two things:

1. Does the estimate's actual spread across repeated runs (the "empirical
   SE") shrink at the theoretical O(1/sqrt(N)) rate for Monte Carlo? Fitting
   log(empirical SE) against log(N) should give a slope near -0.5.
2. Does antithetic sampling reduce variance, not just in theory? Empirical
   SE sitting below the naive iid formula sqrt(p(1-p)/N) shows that
   directly; empirical SE sitting close to the antithetic-pair SE (the
   same formula _prob_margin_antithetic uses) validates that formula
   against real repeated-run behaviour, not just its own derivation.

Run from debt-shield-extension/:
    python convergence_study.py
Writes docs/convergence_study.csv at the repo root.
"""
import math
from pathlib import Path

import numpy as np

from scoring import _simulate_defaults

# Account 3 from data/. Chosen because its default probability sits in the
# middle rather than pinned to 0 or 1 like Accounts 1/2 - a Monte Carlo
# estimator has nothing to converge to if the answer is already 0% or 100%.
ACCOUNT = dict(
    mu_I=670.89, mu_E=627.24, var_I=232069.5475384616, var_E=1830.378938461537,
    d=[0.0], p=[0.0], t=[math.inf], r=[0.0], B0=1161.18, rho_IE=-0.5800690718917769,
)

N_GRID = [1_000, 5_000, 20_000, 50_000, 100_000, 200_000, 400_000]
REPS = 30  # independent seeds per N, used to measure the estimate's real spread


def _analytic_pair_se(defaulted: np.ndarray, N: int) -> float:
    # Same formula as _prob_margin_antithetic in scoring.py, minus the z
    # scaling - kept in raw probability units (0-1) here so it's directly
    # comparable to empirical_se below.
    half = N // 2
    pair_avg = (defaulted[:half].astype(float) + defaulted[half:2 * half].astype(float)) / 2.0
    return pair_avg.std(ddof=1) / math.sqrt(half)


def run():
    rows = []
    for N in N_GRID:
        probs = np.empty(REPS)
        for seed in range(REPS):
            defaulted = _simulate_defaults(**ACCOUNT, N=N, seed=seed)
            probs[seed] = defaulted.mean()
            if seed == 0:
                analytic_se = _analytic_pair_se(defaulted, N)

        empirical_se = probs.std(ddof=1)
        p_bar = probs.mean()
        naive_se = math.sqrt(p_bar * (1 - p_bar) / N)

        rows.append((N, p_bar, empirical_se, naive_se, analytic_se))
        print(f"N={N:>7,}  mean_prob={p_bar:.5f}  empirical_se={empirical_se:.5f}  "
              f"iid_formula_se={naive_se:.5f}  antithetic_formula_se={analytic_se:.5f}")

    Ns = np.array([row[0] for row in rows], dtype=float)
    empirical_ses = np.array([row[2] for row in rows], dtype=float)

    # fit log(se) = slope*log(N) + intercept - theory predicts slope = -0.5
    slope, _ = np.polyfit(np.log(Ns), np.log(empirical_ses), 1)
    print(f"\nfitted slope: {slope:.3f} (theory: -0.5)")

    write_outputs(rows)


def write_outputs(rows):
    repo_root = Path(__file__).resolve().parent.parent
    docs_dir = repo_root / "docs"
    docs_dir.mkdir(exist_ok=True)

    csv_path = docs_dir / "convergence_study.csv"
    with open(csv_path, "w") as f:
        f.write("N,mean_prob,empirical_se,iid_formula_se,antithetic_formula_se\n")
        for N, p_bar, emp_se, naive_se, an_se in rows:
            f.write(f"{N},{p_bar:.6f},{emp_se:.6f},{naive_se:.6f},{an_se:.6f}\n")

    print(f"\nwrote {csv_path}")


if __name__ == "__main__":
    run()
