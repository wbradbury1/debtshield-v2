"""
Plots the convergence study output (data/convergence_study.csv) on log-log
axes. Two things are meant to be readable off the chart at a glance:

1. Empirical SE falls in a straight line against N on log-log axes, at the
   fitted slope printed in the legend - the O(1/sqrt(N)) rate Monte Carlo
   theory predicts is slope -0.5.
2. The antithetic formula SE sits below the iid formula SE at every N, which
   is the variance reduction actually showing up rather than being asserted.

Run convergence_study.py first to regenerate the CSV, then from
debt-shield-extension/:
    python convergence_plot.py
Writes data/convergence.png at the repo root.
"""
import csv
import math
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")   # no display in a headless run; write straight to file
import matplotlib.pyplot as plt


def load(csv_path):
    Ns, empirical, iid, antithetic = [], [], [], []
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            Ns.append(float(row["N"]))
            empirical.append(float(row["empirical_se"]))
            iid.append(float(row["iid_formula_se"]))
            antithetic.append(float(row["antithetic_formula_se"]))
    return (np.array(Ns), np.array(empirical), np.array(iid), np.array(antithetic))


def main():
    repo_root = Path(__file__).resolve().parent.parent
    csv_path = repo_root / "data" / "convergence_study.csv"
    if not csv_path.exists():
        raise SystemExit(f"{csv_path} not found - run convergence_study.py first")

    Ns, empirical, iid, antithetic = load(csv_path)

    # Same fit as convergence_study.py prints, recomputed here so the number
    # on the chart can't drift from the number in the CSV it was drawn from.
    slope, intercept = np.polyfit(np.log(Ns), np.log(empirical), 1)
    fit_line = np.exp(intercept) * Ns ** slope

    fig, ax = plt.subplots(figsize=(7.5, 5))

    ax.plot(Ns, empirical, "o", color="#1f4e79", markersize=7,
            label="empirical SE (30 seeds per N)", zorder=3)
    ax.plot(Ns, fit_line, "-", color="#1f4e79", linewidth=1.5, alpha=0.8,
            label=f"fitted slope {slope:.3f} (theory -0.5)", zorder=2)
    ax.plot(Ns, iid, "^--", color="#c0392b", markersize=6, linewidth=1.2,
            alpha=0.85, label="iid formula SE (no antithetic pairing)", zorder=2)
    ax.plot(Ns, antithetic, "s--", color="#27ae60", markersize=6, linewidth=1.2,
            alpha=0.85, label="antithetic formula SE (what the CI uses)", zorder=2)

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("simulated paths, N")
    ax.set_ylabel("standard error of the default-probability estimate")
    ax.set_title("Monte Carlo convergence and antithetic variance reduction\n"
                 "(Account 3, 30 independent seeds per N)", fontsize=11)

    ax.grid(True, which="both", linestyle=":", linewidth=0.6, alpha=0.6)
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout()

    data_dir = repo_root / "data"
    data_dir.mkdir(exist_ok=True)
    out_path = data_dir / "convergence.png"
    fig.savefig(out_path, dpi=200)
    print(f"fitted slope: {slope:.3f} (theory: -0.5)")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
