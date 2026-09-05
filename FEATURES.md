# Features

What the engine does, and the math and reasoning behind each piece. README covers the pitch and how to run it; this is the full technical reference. Written from what's built, not aspirational: if it's not in `scoring.py`, it's not in here either.

## Bug fixes

v1 had three bugs, all traceable to one gap: it never checked variance against its mean. It stored raw variance and fed it straight into the simulation, with no coefficient of variation (CV, standard deviation divided by mean) to catch a mismatch. Editing a household's income or expense by hand could leave the old CSV-derived variance attached to a mean it no longer matched, and nothing flagged it. One test profile hit 412% implied income volatility this way: 40% of simulated income draws came out negative, and a near-riskless profile scored 67.7. The CSV parser also classified every positive transaction as income and every negative one as an expense, so a single large transfer or refund inflated a month's apparent volatility. A date sort bug could pull the starting cash balance from the wrong row, which matters since that number anchors every simulated path for the year.

v2 fixes each at the source. Editing income or expenses by hand now invalidates the paired variance rather than keeping it stale, so the score falls back to the ±20% heuristic until a re-uploaded CSV recomputes both together: there's no way to derive a variance from a hand-typed mean. A transaction only counts as a one-off if it exceeds 3x the median transaction size for its sign and no similarly sized transaction (within 20%) appears in at least two other months. That excludes a real one-off transfer while keeping a quarterly bonus or variable salary, as long as similar payments recur elsewhere. The date sort now reads the correct row.

v2 also adds CV as an explicit check for the first time, capping it at 78% - see Variance cap below for where that number comes from. That's loose by design, catching values like the 412% case without constraining normal variation. The most volatile reference account measures 0.72 and passes untouched.

## Variance cap (MAX_CV)

Caps CV so a monthly draw has at most a 10% chance of landing negative. Real income and expenses can't actually go negative, but a normal distribution has two tails, so some simulated draws will regardless - the cap keeps that acceptable rather than eliminating it.

`P(X<0) = Φ(-1/CV)`, so solving for the cap: `CV ≤ 1/Φ⁻¹(1-p)`. At `p=0.10`, `Φ⁻¹(0.90) ≈ 1.2816`, giving `CV ≤ 0.78`. The old value was a flat 1.0 guess (~16% chance of a negative draw). Retuning means picking a new `p` and looking up `Φ⁻¹(1-p)`, not just choosing a new CV directly.

The expense cap checks against `adjusted_expenses` (debt-stripped), not raw `average_expenses` - that's the mean the simulator actually draws around, since debt payments run through `p[]` separately. Stricter for debtors than the raw-mean version.

## Test data

`data/` holds three example transaction sets, sourced via the Open Banking Project sandbox and cleaned into CSV files. Account 1 is distressed, with payday loans, subprime credit, and frequent negative balances. Account 2 stays healthy, with stable income and balance never negative. Account 3 sits in between, with modest income and risk from expense timing rather than debt.

## Onboarding debts

Declared debts must already appear in the uploaded statement. The backend subtracts each declared monthly payment from average expenses before simulating, then charges the debt on its own schedule with interest and payoff, so each payment is counted exactly once. Declaring a debt the statement never saw subtracts it from expenses it was never part of, and the score comes out too optimistic by that payment. The reverse holds too. An undeclared debt stays inside expenses as a flat monthly outflow, skipping the simulator's amortisation schedule. Its interest never accrues and its balance never drops.

## Default definition

v1 models default as a first-passage barrier crossing. A household's monthly cash balance (income minus expenses minus debt payments) follows a random walk, and default triggers the first month that balance drops below zero. The mechanism matches a Black-Cox model, the first-passage structural credit framework used for corporate default risk, with a household's cash balance standing in for a firm's asset value.

v2 replaces the single-month trigger with a continuous Parisian barrier condition. Default now requires the balance to stay negative for three consecutive months, and the count resets to zero the moment the balance recovers. This fixes a real issue in v1: a single noisy month could flag default even when a household's average cash flow stayed positive. Three months matches the 90-days-past-due default standard set by Basel II.

One implementation detail worth being explicit about, since it's easy to get subtly wrong: the streak counter (`consecutive_shortfall_months`) *resets to 0* on any solvent month, it doesn't decrement. That's "3 in a row," not "3 bad months somewhere in the last N." A path with months `[-50, +10, -50, -50, -50]` defaults (three genuine in-a-row at the end); one with `[-50, -50, +10, -50, -50]` does not, despite the same total count of bad months. That distinction - sustained distress versus a rough patch with the same bad-month count - is the entire point of moving off the single-breach rule, so it has to reset to zero, not decrement.

## Negative balance interest

A negative cash balance isn't left as a free, untouched number - it compounds monthly, the same mechanic as declared-debt interest (`bal[active] += (bal*r)[active]`), applied to the implicit "debt" of being cash-negative:

```
NEGATIVE_BALANCE_RATE = (1 + 0.40) ** (1/12) - 1   # ≈ 0.02844 (2.844%/month)
B[in_shortfall] *= (1 + NEGATIVE_BALANCE_RATE)
```

**Where 40% comes from.** Deliberately harsh, not fitted: 40% EAR is what most major UK banks charge on arranged overdrafts as of 2026 - Lloyds, Halifax, HSBC, Nationwide, Santander and First Direct all sit at 39.9% EAR, rounded up; Barclays is lower at 35%. It's the top of *ordinary* (non-payday) borrowing cost, chosen to err harsh rather than underestimate what an uncovered shortfall costs a household.

**Why the conversion isn't simple division.** "EAR" means the stated 40% is already the effective *annual* figure. Compounding monthly at `0.40/12` and running that for 12 months lands at `(1 + 0.40/12)**12 - 1 ≈ 48.2%` effective annual, a different, uncited number. The correct inverse is `(1 + EAR)^(1/12) - 1`: compounding this monthly rate for 12 months reproduces exactly 40% annual, by construction. Not the same convention as declared-debt APRs elsewhere (`main.py`, `apr/100/12`) - those are user-supplied headline APR figures with no claim to being an *effective* rate, so simple division is a reasonable simplification there. Here, "EAR" is doing real work in the citation, so the conversion has to preserve it rather than turning a precise 40% into an unlabelled ~48%.

## Monte Carlo

Estimates probability of default over 200,000 independent paths. Each path simulates 12 months of income and expenses as random shocks, correlated using a Pearson correlation estimated directly from the user's own monthly CSV data. Accounts with fewer than 3 months of data, or a flat (zero-variance) income or expense series, fall back to independent shocks - there isn't enough signal to estimate a correlation. Each month the balance moves by income minus living expenses minus scheduled debt payments, and any remaining debt balance accrues interest at its own rate, until the barrier condition triggers or the year ends. Expenses as entered include debt payments; the backend strips these out before simulating, since the simulator charges each debt on its own schedule and leaving them in would double-count the payment. Probability of default is the fraction of paths that trigger it.

**Shock construction.** Income is straightforward: `income = mu_I + sigma_I * Z0`, one standard normal per path per month.

Expenses need to come out correlated with income (a bad income month usually drags expenses into a bad month too - lost hours, job loss), but both still need to look like a proper Normal(mu, sigma^2) on their own:

```
expenses = mu_E + sigma_E * (rho_IE * Z0 + sqrt(1 - rho_IE^2) * Z1)
```

where `Z0` is income's own shock and `Z1` is an independent second draw. This is the standard two-variable correlated-normal construction: `rho_IE * Z0 + sqrt(1-rho_IE^2) * Z1` is itself a standard normal (weights are chosen so the variance works out to exactly 1), and its correlation with `Z0` is exactly `rho_IE`, since `Cov(Z0, rho_IE*Z0 + sqrt(1-rho_IE^2)*Z1) = rho_IE * Var(Z0) = rho_IE`. At `rho_IE = 1`, expenses track income's shock exactly; at `rho_IE = 0`, they're independent.

`rho_IE` itself is the Pearson correlation estimated directly from the household's own uploaded CSV, not a fitted or assumed constant.

## Antithetic sampling

Cuts estimator variance for close to free by drawing N/2 shocks and mirroring each (negating it) for the other N/2, rather than drawing N fully independent shocks. Path `i` (for `i` in `[0, half)`) pairs with path `half + i`, using `Z` and `-Z` respectively.

**Why it reduces variance.** For a pair `(Z, -Z)`, consider the average of the two outcomes, `(f(Z) + f(-Z)) / 2`, where `f` is "did this path default." Its variance is:

```
Var[(f(Z) + f(-Z)) / 2] = [Var(f(Z)) + Var(f(-Z)) + 2*Cov(f(Z), f(-Z))] / 4
```

If `Z` and `-Z` gave independent draws, the covariance term would vanish and this would just be the usual "averaging halves variance" result. But they're not independent - they're mirror images - so if `f` responds to the shock in opposite directions for `Z` versus `-Z`, `Cov(f(Z), f(-Z))` is negative, and the pair-average has less variance than plain averaging predicts.

**Why that covariance is negative here.** Default probability responds monotonically to the shocks: an unusually bad income draw (`Z` very negative) pushes a path toward default; the mirrored path gets an unusually good income draw (`-Z` very positive), pushing it away from default. Across a pair, one path being more likely to default comes with its mirror being less likely to default - exactly the negative correlation the variance-reduction argument needs. This monotonicity is the condition antithetic sampling requires to help; it wouldn't do anything for a non-monotonic function of the shocks.

## Shield Score

Maps default probability onto 0-100 through a log-odds transform, the same family of mapping real credit scorecards (FICO and similar) use - not a straight percentage-to-score conversion. A linear version undersold risk in the middle of the range: a 30% chance of default read as a "decent" 70/100. This version falls off faster as default risk rises, so the middle of the scale reflects real risk instead of masking it.

**Formula.** `score = offset + factor * ln((1-p)/p)`, where `p` is the Monte Carlo default probability. Replaces the old `score = (1-p)*100`.

**Why `ln((1-p)/p)` specifically.** `(1-p)/p` is the odds of the household *not* defaulting. As `p` falls, that ratio grows and its log grows with it, so a positive `factor` gives a score that rises as risk falls - no sign flip needed. This is the same convention real credit scorecards (FICO, VantageScore) use internally - "good:bad odds" - which is also why this shape was picked over the alternatives below: it's a named, standard technique, not a bespoke curve.

**Alternatives considered.** A power-law transform (`score = A*(1-p)^k`) would also compress the top of the range and punish high `p` harder than linear, but it isn't a named industry-standard technique the way log-odds scorecard scaling is - harder to defend in an interview. A categorical PD-to-rating-band mapping (S&P/Moody's-style letter grades from PD thresholds) is arguably more honest about the model's real precision: given the sampling noise a Monte Carlo estimate carries, a score of "82.3" implies more resolution than the estimate supports, and letter grades sidestep that. Not adopted here because it's a different output shape (discrete bands, not a continuous 0-100 score), and would mean redesigning the frontend gauge and every downstream table that assumes a numeric score - the more rigorous real-world alternative, just out of scope for a transform swap.

**Anchor points.** `p=0.01 -> 90`, `p=0.50 -> 10`. Chosen, not fitted - there's still no real default-outcome data to calibrate against (same situation as `NEGATIVE_BALANCE_RATE`). 1% PD reads as "good, not excellent" (90, leaving room above it); 50% PD (coin-flip) reads as "terrible" (10), not "50/100 average". Picking `p=0.50` as the second anchor makes the algebra land cleanly: `ln((1-0.5)/0.5) = ln(1) = 0`, so `offset` is just the score at `p=0.5` by construction (10), and `factor` is solved from the other anchor: `factor = (90 - 10) / ln(99) ≈ 17.41`.

Under this, `p=0.30` (the case that motivated dropping the linear transform) now scores **~24.7** instead of 70 - squarely "risky", not "decent".

**Edge cases.** `p=0` and `p=1` are handled explicitly (`_score_transform` returns 100 / 0 directly) since `ln((1-p)/p)` is undefined at the boundaries - same clamping spirit as the old transform's `max(0, min(100, ...))`.

**A property worth flagging, not fixing.** The anchors make the curve steep near low `p`: `p=0.01` scores 90 but `p=0.02` already scores ~78 - a 12-point drop for one percentage point of PD. That's an intrinsic feature of log-odds scaling concentrating resolution where the anchors are (real FICO scorecards show the same behaviour near their own anchor points), not a bug, but it's exactly the kind of thing the Sensitivity analysis section below quantifies properly rather than eyeballing here.

## Confidence interval

`/score/` reports a 95% confidence interval (`shield_score_ci_low`/`shield_score_ci_high`) alongside the score, since the score is itself a Monte Carlo estimate with sampling error - rerun with a different seed and it moves a little. `/score/` accepts an optional `seed` parameter for inspecting that directly.

**Base derivation.** The score comes from a Monte Carlo estimate of a probability (the fraction of paths that defaulted), so it carries sampling error. The standard approximate CI for this follows directly from the CLT: for a sample proportion `p_hat` from `n` Bernoulli trials,

```
(p_hat - p) / sqrt(p(1-p)/n) -> N(0,1)  as n -> infinity
```

`p` is unknown, so `p_hat` is plugged into the variance term too (valid since `p_hat` is a consistent estimator of `p`), giving the usable asymptotic pivot `(p_hat - p) / sqrt(p_hat(1-p_hat)/n)`, and the interval `p_hat ± z * sqrt(p_hat(1-p_hat)/n)`. This is the same derivation as ST232/ST233 (Tamborrino, University of Warwick), Section 7.4, Example 7.10, "Confidence intervals for the binomial distribution." It's flagged there as approximate, exact only as `n -> infinity` - not a concern at N=200,000.

**The antithetic correction.** That formula assumes `n` independent trials. With antithetic pairing, path `i` and path `half+i` are correlated, so plugging all N paths into it directly overstates the true standard error. The fix: different *pairs* are independent of each other (each pair comes from its own independent draw), so treat each pair's own average outcome (0, 0.5, or 1) as one independent sample. There are `N/2` of these, and the point estimate is exactly their mean:

```
p_hat = (1/N) * sum(defaulted_i)
      = (1/N) * sum_k(defaulted_k + defaulted_{k+half})     [grouping by pair k]
      = (1/half) * sum_k(pair_avg_k)
```

so `p_hat` is the sample mean of the `half` pair-averages, and since those pair-averages *are* iid, the ordinary sample-mean standard error applies directly to them: `se = std(pair_avg) / sqrt(half)`. This is what `_prob_margin_antithetic` computes (in probability units, `z * se`), same CLT logic as the base derivation, just applied to the unit that's independent (the pair, not the path).

**Mapping through the score transform.** The margin above lives in probability space. `shield_score` builds `[prob - margin, prob + margin]` (clamped to `[0,1]`) and pushes *each endpoint* through `_score_transform` separately, rather than computing one score and rescaling a margin onto it - that rescaling only worked when the transform was linear. Because the transform is monotonically decreasing in `p`, the lower probability bound maps to the *higher* score bound and vice versa. It also means `ci_low`/`ci_high` are generally not equidistant from `score` - expected under a non-linear map, not a bug.

**Caveats, stated plainly.** The interval is approximate (asymptotic), not exact - fine at N in the hundreds of thousands. Bounds clamp to [0, 100] like the score itself, so a score sitting right at the boundary shows a narrower interval than the true one. If N is odd, one leftover unpaired path is folded into the point estimate but dropped from the pair-average SE calculation - negligible for any N in practical use.

The engine runs on a fixed seed by default (identical inputs always reproduce the identical score), so the CI describes how much the score would move across different seeds, not run-to-run wobble on a fixed one.

## Convergence study

`debt-shield-extension/convergence_study.py` checks the CI and variance-reduction claims above against actual repeated runs, not just the maths behind them - rerunning the sim at increasing path counts and confirming the score's precision improves at the rate Monte Carlo theory predicts.

**Setup.** Account 3's profile (the "in-between" case in `BASELINE.md`, not degenerate at 0 or 100, so the estimate has room to move). N from 1,000 to 400,000, 30 independent seeds per N. Three quantities per N:

- **empirical SE** - the standard deviation of the point estimate across the 30 seeds. The actual measured spread, not a formula.
- **naive iid SE** - `sqrt(p_bar(1-p_bar)/N)`, what the plain independent-trials formula would predict if antithetic pairing weren't happening.
- **analytic pair SE** - the actual formula `_prob_margin_antithetic` uses, from a single run per N.

**Results.**

| N | mean prob | empirical SE | naive iid SE | analytic pair SE |
|---|---|---|---|---|
| 1,000 | 0.18610 | 0.00905 | 0.01231 | 0.01088 |
| 5,000 | 0.18036 | 0.00423 | 0.00544 | 0.00482 |
| 20,000 | 0.18069 | 0.00234 | 0.00272 | 0.00240 |
| 50,000 | 0.18088 | 0.00177 | 0.00172 | 0.00152 |
| 100,000 | 0.18126 | 0.00118 | 0.00122 | 0.00107 |
| 200,000 | 0.18103 | 0.00063 | 0.00086 | 0.00076 |
| 400,000 | 0.18085 | 0.00043 | 0.00061 | 0.00054 |

Fitted slope of `log(empirical SE)` against `log(N)`: **-0.495**, matching the O(1/√N) rate Monte Carlo theory predicts almost exactly. (Rerun after negative-balance interest was added - `mean_prob` sits about 0.002 higher than the pre-negative-balance-interest table did, consistent with shortfalls now compounding instead of sitting free; the SE columns and the fitted slope are essentially unchanged, since neither antithetic sampling nor the convergence rate depend on the specific probability being estimated.)

**Interpretation.** `analytic pair SE` sits below `naive iid SE` at every N - the variance reduction from antithetic pairing is showing up empirically, not just asserted. `empirical SE` and `analytic pair SE` track each other closely, sitting slightly above or below one another at different N (e.g. `empirical` a touch above `analytic` at N=50,000/100,000, a touch below elsewhere) - expected noise from estimating a standard deviation off only 30 reps (relative uncertainty on a std-of-30 estimate is roughly ±13%), not a discrepancy worth chasing further. Raw numbers in `docs/convergence_study.csv` / `docs/convergence_study.md`; rerun with `python convergence_study.py` from `debt-shield-extension/`.

## Sensitivity analysis

`debt-shield-extension/sensitivity_analysis.py` tests the two scoring-engine assumptions that have no external anchor: the score-transform anchor points, and `MAX_CV`'s underlying tail-tolerance. `z=1.96`, `N`, the 3-month default threshold, and `NEGATIVE_BALANCE_RATE` were deliberately left out - each traces to an external anchor (a mathematical definition, the convergence study itself, Basel II, or real surveyed bank rates respectively), so sweeping them would just re-derive an already-fixed external fact, not test our own judgement. Both sweeps run on Account 3 (not degenerate at 0 or 100, so there's room to see movement) at a fixed seed throughout, so any change in score is attributable only to the swept parameter.

**Anchor points.** Held the 1%/50% PD reference points fixed, varied only the score assigned to each:

| anchors | 1% PD -> | 50% PD -> | Shield Score |
|---|---|---|---|
| current | 90 | 10 | 36.2 |
| gentler | 95 | 20 | 44.5 |
| harsher | 85 | 5 | 31.2 |

A plausible re-pick of the anchors moves Account 3's score by roughly 5-8 points either way - confirmation that the anchor choice is doing real work, not a cosmetic detail, and exactly why it was worth testing rather than asserting.

**`MAX_CV` tail tolerance.** Account 3's actual income CV is 0.718, sitting just under today's production cap (`MAX_CV=0.78`, from a 10% tail-tolerance assumption), so it's never clamped in practice. Tightening the tolerance assumption changes that:

| tail tolerance | implied MAX_CV | clamp fires? | income CV used | Shield Score |
|---|---|---|---|---|
| 20% | 1.188 | No | 0.718 | 36.2 |
| 10% (current) | 0.780 | No | 0.718 | 36.2 |
| 5% | 0.608 | Yes | 0.608 | 42.4 |
| 2.5% | 0.510 | Yes | 0.510 | 50.0 |

At the production tolerance nothing changes. The finding isn't "this is broken," it's a genuine limitation: a stricter tail-tolerance choice would suppress some of Account 3's real, CSV-derived income volatility and make it look artificially safer, since the clamp caps the *input* variance the simulation sees, not just the output score. The clamp exists to prevent implausible variance from breaking the model (see Bug fixes above) - but the 10% tolerance carries real downstream consequences, not an inert default.

Raw numbers in `docs/sensitivity_analysis.csv` / `docs/sensitivity_analysis.md`; rerun with `python sensitivity_analysis.py` from `debt-shield-extension/`.

## Potential extensions

**AR(1)/fat-tailed shocks.** Income and expense shocks are iid normal draws month to month. An AR(1) structure would capture that bad months cluster (a job loss doesn't un-happen after one month); fatter tails would capture extreme events better than a normal distribution does. Not implemented: reworking antithetic pairing for autocorrelated paths is real effort for a refinement, not a correctness fix. Recognizing that iid-Normal understates clustering and tail risk carries most of the value building it would.

**Importance sampling.** Useful when the event you're measuring almost never happens in a plain simulation: bias the sampling toward it, correct for the bias afterward. Not pursued here, since default isn't rare across the test population (Account 1 defaults on most paths). The technique's use case doesn't apply, and recognizing that matters more than implementing a variance-reduction method without checking it fits the problem first.

## Scoped out

See Potential extensions above for what was deliberately left out (AR(1)/fat-tailed shocks, importance sampling) and why. Auto-originated debt on negative balance, previously listed here too, is now built - see Negative balance interest above, not scoped out anymore.
