# debtshield-v2
Monte Carlo credit risk model with statistical validation and extensions. Starts from debtshield-v1 and builds upon it. Technical derivations and the convergence study are in `METHODS.md`; this covers the project itself and how to run it.

## Bug fixes

v1 had three real bugs, and none of them were caught because v1 never checked variance against its mean in the first place. It stored raw variance and fed it straight into the simulation, with no concept of coefficient of variation (standard deviation divided by mean, denoted CV) to sanity-check the pair. That's how editing a household's average income or expense could leave the old CSV-derived variance attached to a mean it no longer matched: nothing flagged the mismatch. In one test profile this pushed implied income volatility to 412% of the mean: roughly 40% of simulated income draws came out negative, and a near-riskless profile scored only 67.7. The CSV parser also classified every positive transaction as income and every negative transaction as an expense, so a single large transfer or refund could make a month look far more volatile than the household's actual spending pattern. A date sort bug could also pull the starting cash balance from the wrong row, which matters because that single number anchors every simulated path for the full year.

v2 fixes each of these three at the source. Editing income or expenses by hand now invalidates the paired variance instead of keeping it, so the score falls back to the ±20% heuristic and stays there until a re-uploaded CSV recomputes both mean and variance together as there's no way to recompute a variance for a hand-typed mean. The parser flags a transaction as a one-off only if it exceeds 3x the median transaction size for its sign and no similarly sized transaction (within 20%) shows up in at least two other months. A real one-off transfer gets excluded this way, while a quarterly bonus or a variable salary survives, as long as similar-sized payments show up in other months. The date sort now reads the correct row. 
On top of these three, v2 introduces CV as an explicit check for the first time: the scoring endpoint caps it at 78%, derived from a 10% tail-probability tolerance (P(negative draw) = Φ(−1/CV), so CV ≤ 1/Φ⁻¹(0.90) ≈ 0.78), loose by design so it catches genuinely broken values like the 412% case without constraining normal variation. Negative income or expenses is impossible, but a normal model has tails on both sides, so some simulated draws land below zero. The most volatile reference account measures 0.72 and passes untouched.

## Test data

`data/` holds three example transaction sets, sourced via the Open Banking Project sandbox and cleaned into CSV files. Account 1 is distressed, with payday loans, subprime credit, and frequent negative balances. Account 2 stays healthy, with stable income and balance never negative. Account 3 sits in between, with modest income and risk from expense timing rather than debt.

## Onboarding debts

Declared debts must already appear in the uploaded statement. The backend subtracts each declared monthly payment from average expenses before simulating, then charges the debt on its own schedule with interest and payoff, so each payment is counted exactly once. Declaring a debt the statement never saw subtracts it from expenses it was never part of, and the score comes out too optimistic by that payment. The reverse holds too. An undeclared debt stays inside expenses as a flat monthly outflow, skipping the simulator's amortisation schedule entirely. Its interest never accrues and its balance never drops.

## Default definiton

v1 models default as a first-passage barrier crossing. A household's monthly cash balance (income minus expenses minus debt payments) follows a random walk, and default triggers the first month that balance drops below zero. The mechanism matches a Black-Cox model, the first-passage structural credit framework used for corporate default risk, with a household's cash balance standing in for a firm's asset value.

v2 replaces the single-month trigger with a continuous Parisian barrier condition. Default now requires the balance to stay negative for three consecutive months, and the count resets to zero the moment the balance recovers. This fixes a real issue in v1: a single noisy month could flag default even when a household's average cash flow stayed positive. Three months matches the 90-days-past-due default standard set by Basel II.

A negative balance also isn't free: it compounds monthly at a flat rate (40% EAR, matching what most major UK banks charge on arranged overdrafts) rather than sitting as an untouched number a household could recover from at no cost. This is a deliberately harsh stand-in for the reality that an uncovered shortfall usually gets funded somehow - overdraft, credit card, payday loan - not a fitted estimate of any specific household's actual borrowing cost.

## Monte Carlo

Monte Carlo simulation estimates probability of default, run over 200,000 independent paths. Each path simulates 12 months of income and expenses as random shocks, correlated using a Pearson correlation estimated directly from the user's own monthly CSV data. Accounts with fewer than 3 months of data, or a flat (zero-variance) income or expense series, default to independent shocks instead — there isn't enough signal to estimate a correlation from. Each month the balance moves by income minus living expenses minus scheduled debt payments, and any remaining debt balance accrues interest at its own rate, until the barrier condition triggers or the year ends. Expenses as entered include debt payments. The backend strips these out before simulating: the simulator charges each debt on its own schedule, and leaving them in would count the same payment twice. Probability of default is the fraction of paths that trigger it. Exact correlation construction is in `METHODS.md`.



## Variance reduction

The engine uses antithetic sampling to cut estimator variance for close to free - mechanism and why it works here are in `METHODS.md`.

## Shield Score

Shield Score maps that probability onto 0-100 through a log-odds transform - the same family of mapping real credit scorecards (FICO and similar) use, not a straight percentage-to-score conversion. A straight-line version undersold risk in the middle of the range (a 30% chance of default read as a "decent" 70/100); this version falls off faster as default risk rises, so the middle of the scale actually means something. Anchor points, the exact formula, and alternatives considered are in `METHODS.md`.

## Confidence interval

`/score/` reports a 95% confidence interval (`shield_score_ci_low`/`shield_score_ci_high`) alongside the score, since the score is itself a Monte Carlo estimate with sampling error - rerun with a different seed and it moves a little. Because the score transform above is non-linear, the two bounds generally sit at different distances from the score itself - expected, not a bug. Full derivation, the antithetic-pair correction, and the course citation it's built on are in `METHODS.md`. `/score/` accepts an optional `seed` parameter for inspecting seed-to-seed movement directly.

## Convergence study

`debt-shield-extension/convergence_study.py` checks the CI and variance-reduction claims above against actual repeated runs rather than just the maths behind them - rerunning the sim at increasing path counts and confirming the score's precision improves at the rate Monte Carlo theory predicts. Full methodology, the fitted result, and the results table are in `METHODS.md`; raw numbers in `docs/convergence_study.md` / `docs/convergence_study.csv`.

## Sensitivity analysis

`debt-shield-extension/sensitivity_analysis.py` checks how much the score actually depends on the two judgement calls with no external anchor to justify them: the score-transform anchor points, and the tail-risk tolerance behind the variance cap. Both move the score by a real, non-trivial amount under a plausible re-pick - confirmation that these choices matter, not just cosmetic detail. Full results and reasoning for what was (and wasn't) tested are in `METHODS.md`.

## Potential extensions

**AR(1)/fat-tailed shocks.** Income and expense shocks are iid normal draws month to month. An AR(1) structure would capture that bad months tend to cluster (a job loss doesn't un-happen after one month), and fatter tails would capture extreme events better than a normal distribution does. Not implemented - reworking antithetic pairing for autocorrelated paths is real effort for a refinement, not a correctness fix. The reasoning above is most of the actual value either way: recognizing that iid-Normal understates clustering and tail risk carries most of the signal that building it would.

**Importance sampling.** Considered for rare-event estimation - useful when the event you're trying to measure almost never happens in a plain simulation, so you bias the sampling toward it and correct for the bias afterward. Not pursued here, since default isn't consistently rare across the current test population (Account 1 defaults on the large majority of paths) - the technique's use case doesn't clearly apply, and recognizing that is closer to the point than implementing a variance-reduction method without first checking it fits the problem.




## Setup

```bash
cd debt-shield-extension
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload
```

Backend runs at `http://127.0.0.1:8000`. Then load `debt-shield-extension/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

**Note:** regenerating `requirements.txt` from PowerShell with `>` writes UTF-16 and breaks pip. Use `pip freeze | Out-File -Encoding utf8 requirements.txt`, or run it from cmd.