"""
Sensitivity analysis for the two scoring-engine assumptions that have no
external anchor: the score-transform anchor points, and MAX_CV's underlying
tail-tolerance. z=1.96, N, the 3-month default threshold, and
NEGATIVE_BALANCE_RATE were excluded: each traces to an external anchor (a
mathematical definition, the convergence study itself, Basel II, or real
surveyed bank rates respectively), so sweeping them would just re-derive an
already-fixed fact rather than test our own judgement - see the
final-stretch plan for the full reasoning.

Both sweeps use Account 3, at a fixed seed (42), so any movement in the
results is attributable only to the swept parameter, never a different
Monte Carlo draw.

Run from debt-shield-extension/:
    python sensitivity_analysis.py
Writes docs/sensitivity_analysis.csv at the repo root.
"""
import math
from pathlib import Path

import scoring
from scoring import shield_score

# Account 3 (BASELINE.md's "in-between" case) - not degenerate at 0 or 100
# like Accounts 1 and 2, so there's actually room for a swept parameter to
# move the score.
ACCOUNT = dict(
    mu_I=670.89, mu_E=627.24, var_I=232069.5475384616, var_E=1830.378938461537,
    d=[0.0], p=[0.0], t=[math.inf], r=[0.0], B0=1161.18, rho_IE=-0.5800690718917769,
)

# (label, p1, s1, p2, s2) - p1/p2 (1% / 50% PD) held fixed since those are
# reasonable reference points on their own; it's the score values assigned
# to them that were the arbitrary, un-anchored choice being tested here.
ANCHOR_SETS = [
    ("current", 0.01, 90.0, 0.50, 10.0),
    ("gentler", 0.01, 95.0, 0.50, 20.0),
    ("harsher", 0.01, 85.0, 0.50, 5.0),
]

# Standard normal quantiles, plain textbook values - no scipy dependency for
# one lookup, same manual approach MAX_CV's own derivation comment in
# main.py already uses. (tail tolerance, z = Phi^-1(1 - tolerance))
TOLERANCES = [
    (0.20, 0.8416),
    (0.10, 1.2816),   # current production value: MAX_CV = 1/1.2816 = 0.780
    (0.05, 1.6449),
    (0.025, 1.9600),
]


def run_anchor_sweep():
    orig = (scoring.ANCHOR_P1, scoring.ANCHOR_S1, scoring.ANCHOR_P2, scoring.ANCHOR_S2)
    rows = []
    try:
        for label, p1, s1, p2, s2 in ANCHOR_SETS:
            scoring.ANCHOR_P1, scoring.ANCHOR_S1 = p1, s1
            scoring.ANCHOR_P2, scoring.ANCHOR_S2 = p2, s2
            result = shield_score(**ACCOUNT)
            rows.append((label, s1, s2, result.score, result.ci_low, result.ci_high))
            print(f"anchors={label:>8}  (1%->{s1:.0f}, 50%->{s2:.0f})  "
                  f"score={result.score:.1f}  ci=[{result.ci_low:.1f}, {result.ci_high:.1f}]")
    finally:
        # Restore production anchors either way - this module gets imported,
        # not re-run fresh, by anything that runs after it in the same process
        scoring.ANCHOR_P1, scoring.ANCHOR_S1, scoring.ANCHOR_P2, scoring.ANCHOR_S2 = orig
    return rows


def run_max_cv_sweep():
    mu_I, var_I = ACCOUNT["mu_I"], ACCOUNT["var_I"]
    rows = []
    for tolerance, z in TOLERANCES:
        max_cv = 1.0 / z
        cap_I = (mu_I * max_cv) ** 2
        var_I_used = min(var_I, cap_I)
        clamped = var_I_used < var_I
        account_adj = dict(ACCOUNT, var_I=var_I_used)
        result = shield_score(**account_adj)
        used_cv = math.sqrt(var_I_used) / mu_I
        rows.append((tolerance, max_cv, clamped, used_cv, result.score, result.ci_low, result.ci_high))
        print(f"tail_tolerance={tolerance:>6.1%}  MAX_CV={max_cv:.3f}  clamped={clamped!s:5}  "
              f"used_cv={used_cv:.3f}  score={result.score:.1f}  "
              f"ci=[{result.ci_low:.1f}, {result.ci_high:.1f}]")
    return rows


def write_outputs(anchor_rows, cv_rows):
    repo_root = Path(__file__).resolve().parent.parent
    docs_dir = repo_root / "docs"
    docs_dir.mkdir(exist_ok=True)

    csv_path = docs_dir / "sensitivity_analysis.csv"
    with open(csv_path, "w") as f:
        f.write("# anchor point sweep (Account 3)\n")
        f.write("label,score_at_1pct_pd,score_at_50pct_pd,shield_score,ci_low,ci_high\n")
        for label, s1, s2, score, ci_low, ci_high in anchor_rows:
            f.write(f"{label},{s1},{s2},{score},{ci_low},{ci_high}\n")
        f.write("\n# MAX_CV tail-tolerance sweep (Account 3 income variance)\n")
        f.write("tail_tolerance,max_cv,clamped,used_income_cv,shield_score,ci_low,ci_high\n")
        for tolerance, max_cv, clamped, used_cv, score, ci_low, ci_high in cv_rows:
            f.write(f"{tolerance},{max_cv:.3f},{clamped},{used_cv:.3f},{score},{ci_low},{ci_high}\n")

    print(f"\nwrote {csv_path}")


if __name__ == "__main__":
    print("=== Anchor point sweep ===")
    anchor_rows = run_anchor_sweep()
    print("\n=== MAX_CV tail-tolerance sweep ===")
    cv_rows = run_max_cv_sweep()
    write_outputs(anchor_rows, cv_rows)
