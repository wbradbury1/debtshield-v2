# Features

This is a full technical reference beyond the README. 

## Bug fixes

v1 had four bugs. Three trace back to one gap: it never checked variance against its mean, or validated it at the point it was computed. It stored raw variance with no coefficient of variation (CV, standard deviation divided by mean) to check whether that variance was too large for its mean. A high CV means the formula P(negative) = Φ(-1/CV) predicts a meaningful share of simulated income or expenses landing below zero (due to the unbounded nature of the normal distribution and the monotonicity of its CDF), which is impossible for real income and expenses. Editing a household's income or expense by hand left the old CSV-derived variance attached to a mean it no longer matched - exactly the mismatch a CV check would have caught. One test profile hit 412% implied income volatility this way, resulting in 40% of simulated income draws coming out negative, and in turn a near-riskless profile scored 67.7. The CSV parser also classified every positive transaction as income and every negative one as an expense, so a single large transfer or refund inflated a month's apparent volatility - another way an unvalidated variance figure reached the simulator untouched. The fourth bug was unrelated to variance entirely. It was a date sort bug which could pull the starting cash balance from the wrong row, which matters since that number is the anchor for every simulated path for the year.

v2 fixes each at the source. Editing income or expenses by hand now invalidates the paired variance rather than keeping it stale, so the score falls back to CV heuristics of 0.38 (income) and 0.32 (expenses), backed by JPMorgan Chase Institute, until a re-uploaded CSV recomputes it - there's no way to derive a variance from a hand-typed mean. A transaction now counts as a one-off if it exceeds 3x the median transaction size for its sign and no similarly sized transaction (within 20%) appears in at least two other months. That excludes a real one-off transfer while keeping a quarterly bonus or variable salary, as long as similar payments recur elsewhere. The date sort now reads the correct row. CV is also now an explicit check, capped at 0.78 - loose by design, catching values like the 412% case without constraining normal variation. The most volatile reference account measures 0.72 and passes untouched.

## Variance cap (MAX_CV)

At CV=0.78, a monthly draw has at most a 10% chance of landing negative. Real income and expenses can't actually go negative, but a normal distribution is unbounded and symmetric around the mean, so some simulated draws will regardless - the cap keeps that at an acceptable level, not zero. The cap isn't set any stricter than this, to avoid suppressing genuine volatility in the CSV data more than necessary.

`P(X<0) = Φ(-1/CV)`, so solving for the cap: `CV ≤ 1/Φ⁻¹(1-p)`. At our chosen `p=0.10`, `Φ⁻¹(0.90) ≈ 1.2816`, giving `CV ≤ 0.78`. Retuning means picking a new `p` and looking up `Φ⁻¹(1-p)`, not just choosing a new CV directly.

The expense cap checks against `adjusted_expenses` (debt-stripped), not raw `average_expenses` - that's the mean the simulator actually draws around, since debt payments run through `p[]` separately. This is stricter for debtors than the raw-mean version.

## Default definition

v1 models default as a first-passage barrier crossing. A household's monthly cash balance (income minus expenses minus debt payments) follows a random walk, and default triggers the first month that balance drops below zero. The mechanism matches a Black-Cox model, the first-passage structural credit framework used for corporate default risk, with a household's cash balance standing in for a firm's asset value.

v2 replaces the single-month trigger with a continuous Parisian barrier condition. Default now requires the balance to stay negative for three consecutive months, and the count resets to zero the moment the balance recovers. This fixes a real modelling issue in v1: in reality, a household can delay a payment or take on short-term debt to cover a temporary rough patch. One bad month alone doesn't mean default. The new three-month requirement is much more appropriate and matches the 90-days-past-due default standard set by Basel II.

## Negative balance interest

A negative cash balance during the 3 month period isn't left as a free, untouched number - it compounds monthly, due to the fact it must be covered by taking on debt. This is modelled by the following:

```
NEGATIVE_BALANCE_RATE = (1 + 0.40) ** (1/12) - 1   # ≈ 0.02844 (2.844%/month)
B[in_shortfall] *= (1 + NEGATIVE_BALANCE_RATE)
```

40% EAR is what most major UK banks charge on arranged overdrafts as of 2026 - Lloyds, Halifax, HSBC, Nationwide, Santander and First Direct all sit at 39.9% EAR, rounded up; Barclays is lower at 35%. It's the top of *ordinary* (non-payday) borrowing cost, chosen to lean harsh rather than underestimate what an uncovered shortfall costs a household.


## Monte Carlo simulation

Estimates probability of default over 200,000 independent paths. Each path simulates 12 months of income and expenses as random shocks, correlated using a Pearson correlation estimated directly from the user's own monthly CSV data. Accounts with fewer than 3 months of data, or a flat (zero-variance) income or expense series, fall back to independent shocks because we deem that there isn't enough signal to estimate a correlation. Each month the balance moves by income minus living expenses minus scheduled debt payments, and any remaining debt balance accrues interest at its own rate, until the barrier condition triggers or the year ends. The CSV itself includes debt payments; the backend strips these out before simulating, based upon the user inputting them at onboarding. The simulator charges each debt on its own schedule, and leaving them in would double-count the payment. Probability of default is the fraction of paths that trigger it.

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

Maps default probability onto 0-100 through a log-odds transform, the same family of mapping real credit scorecards (Experian and similar) use - not a straight percentage-to-score conversion. A linear version undersold risk in the middle of the range: a 30% chance of default read as a "decent" 70/100. This version falls off faster as default risk rises, so the middle of the scale reflects real risk instead of masking it.

**Formula.** `score = offset + factor * ln((1-p)/p)`, where `p` is the Monte Carlo default probability. Replaces the old `score = (1-p)*100`.

**Why `ln((1-p)/p)` specifically.** `(1-p)/p` is the odds of the household *not* defaulting. As `p` falls, that ratio grows and its log grows with it, so a positive `factor` gives a score that rises as risk falls - no sign flip needed. This is the same convention real credit scorecards use internally.

**Anchor points.** `p=0.01 -> 90`, `p=0.50 -> 10`. Chosen, not fitted, based on what I thought was appropriate. 1% PD reads as "good, not excellent" (90, leaving room above it); 50% PD (coin-flip) reads as "terrible" (10), not "50/100 average". Picking `p=0.50` as the second anchor also makes the algebra land cleanly: `ln((1-0.5)/0.5) = ln(1) = 0`, so `offset` is just the score at `p=0.5` by construction (10), and `factor` is solved from the other anchor: `factor = (90 - 10) / ln(99) ≈ 17.41`.

Under this, `p=0.30` (the case that initially motivated me to drop the linear transform) now scores **~24.7** instead of 70 - squarely "risky", not "decent" like it was before.

The anchors make the curve steep near low `p`: `p=0.01` scores 90 but `p=0.02` already scores ~78 - a 12-point drop for one percentage point of PD. That's an intrinsic feature of log-odds scaling concentrating resolution where the anchors are, not a bug, but it's exactly the kind of thing the Sensitivity analysis section below quantifies properly rather than eyeballing here.

**Edge cases.** `p=0` and `p=1` are handled explicitly (`_score_transform` returns 100 / 0 directly) since `ln((1-p)/p)` is undefined at the boundaries.

## Confidence interval

`/score/` reports a 95% confidence interval (`shield_score_ci_low`/`shield_score_ci_high`) alongside the score, since the score is itself a Monte Carlo estimate with a sampling error - rerun with a different seed and it moves a little. `/score/` accepts an optional `seed` parameter for inspecting that directly.

**Base derivation.** The score comes from a Monte Carlo estimate of a probability (the fraction of paths that defaulted), so it carries sampling error. The standard approximate CI for this follows directly from the Central Limit Theorem: for a sample proportion `p_hat` from `n` Bernoulli trials,

```
(p_hat - p) / sqrt(p(1-p)/n) -> N(0,1)  as n -> infinity
```

`p` is unknown, so `p_hat` is plugged into the variance term too (valid since `p_hat` is a consistent estimator of `p`), giving the usable asymptotic pivot `(p_hat - p) / sqrt(p_hat(1-p_hat)/n)`, and the interval `p_hat ± z * sqrt(p_hat(1-p_hat)/n)`. It is approximate, exact only as `n -> infinity`, but N=200,000 is sufficient for accuracy.

**The antithetic correction.** That formula assumes `n` independent trials. With antithetic pairing, path `i` and path `half+i` are correlated, so plugging all N paths into it directly overstates the true standard error. The fix: different *pairs* are independent of each other (each pair comes from its own independent draw), so treat each pair's own average outcome (0, 0.5, or 1) as one independent sample. There are `N/2` of these, and the point estimate is exactly their mean:

```
p_hat = (1/N) * sum(defaulted_i)
      = (1/N) * sum_k(defaulted_k + defaulted_{k+half})     [grouping by pair k]
      = (1/half) * sum_k(pair_avg_k)
```

so `p_hat` is the sample mean of the `half` pair-averages, and since those pair-averages *are* iid, the ordinary sample-mean standard error applies directly to them: `se = std(pair_avg) / sqrt(half)`. This is what `_prob_margin_antithetic` computes (in probability units, `z * se`), same CLT logic as the base derivation, just applied to the unit that's independent (the pair, not the path).

**Mapping through the score transform.** The margin above lives in probability space. `shield_score` builds `[prob - margin, prob + margin]` (clamped to `[0,1]`) and pushes *each endpoint* through `_score_transform` separately. Because the transform is monotonically decreasing in `p`, the lower probability bound maps to the *higher* score bound and vice versa. It also means `ci_low`/`ci_high` are generally not equidistant from `score` - expected under a non-linear map, not a bug.

The engine runs on a fixed seed by default (identical inputs always reproduce the identical score), so the CI describes how much the score would move across different seeds, not run-to-run wobble on a fixed one.

## Convergence study

`debt-shield-extension/convergence_study.py` checks the CI and variance-reduction claims above against actual repeated runs, not just the maths behind them - rerunning the sim at increasing path counts and confirming the score's precision improves at the rate Monte Carlo theory predicts.

**Setup.** Account 3's profile (the "in-between" case in `BASELINE.md`, not degenerate at 0 or 100, so the estimate has room to move). N from 1,000 to 400,000, 30 independent seeds per N. Three quantities per N:

- **empirical SE** - the standard deviation of the point estimate across the 30 seeds. The actual measured spread, not a formula.
- **iid formula SE** - `sqrt(p_bar(1-p_bar)/N)`, what the plain independent-trials formula would predict if antithetic pairing weren't happening.
- **antithetic formula SE** - the actual formula `_prob_margin_antithetic` uses, from a single run per N.

**Results.**

| N | mean prob | empirical SE | iid formula SE | antithetic formula SE |
|---|---|---|---|---|
| 1,000 | 0.18610 | 0.00905 | 0.01231 | 0.01088 |
| 5,000 | 0.18036 | 0.00423 | 0.00544 | 0.00482 |
| 20,000 | 0.18069 | 0.00234 | 0.00272 | 0.00240 |
| 50,000 | 0.18088 | 0.00177 | 0.00172 | 0.00152 |
| 100,000 | 0.18126 | 0.00118 | 0.00122 | 0.00107 |
| 200,000 | 0.18103 | 0.00063 | 0.00086 | 0.00076 |
| 400,000 | 0.18085 | 0.00043 | 0.00061 | 0.00054 |

Fitted slope of `log(empirical SE)` against `log(N)`: **-0.495**, matching the O(1/√N) rate Monte Carlo theory predicts almost exactly (0.005 off). 

**Interpretation.** `antithetic formula SE` sits below `iid formula SE` at every N, highlighting the variance reduction in practice. `empirical SE` and `antithetic formula SE` track each other closely, sitting slightly above or below one another at different N, which is expected noise from estimating a standard deviation from 30 reps.

## Sensitivity analysis

`debt-shield-extension/sensitivity_analysis.py` tests the two scoring-engine assumptions that have no external anchor: the score-transform anchor points, and `MAX_CV`'s underlying tail-tolerance. Both sweeps run on Account 3 at a fixed seed throughout, so any change in score is attributable only to the swept parameter.

**Anchor points.** Held the 1%/50% PD reference points fixed, varied only the score assigned to each:

| anchors | 1% PD -> | 50% PD -> | Shield Score |
|---|---|---|---|
| current | 90 | 10 | 36.2 |
| gentler | 95 | 20 | 44.5 |
| harsher | 85 | 5 | 31.2 |

A plausible re-pick of the anchors moves Account 3's score by roughly 5-8 points either way - confirmation that the anchor choice is doing real work, not a cosmetic detail. That sensitivity means my own judgement genuinely shapes the score, but I still think the anchor points I chose are a defensible choice.

**`MAX_CV` tail tolerance.** Account 3's actual income CV is 0.718, sitting just under today's production cap (`MAX_CV=0.78`, from a 10% tail-tolerance assumption), so it's never clamped in practice. Tightening the tolerance assumption changes that:

| tail tolerance | implied MAX_CV | clamp fires? | income CV used | Shield Score |
|---|---|---|---|---|
| 20% | 1.188 | No | 0.718 | 36.2 |
| 10% (current) | 0.780 | No | 0.718 | 36.2 |
| 5% | 0.608 | Yes | 0.608 | 42.4 |
| 2.5% | 0.510 | Yes | 0.510 | 50.0 |

A stricter tail-tolerance choice increases Shield Score. The first rows don't change, because of the CSV accounts we happened to choose - a genuinely volatile account would have some of its variance suppressed too, and its score would rise in the same way. The 3rd and 4th rows show this in action: they suppress some of Account 3's real, CSV-derived income volatility, making it look artificially safer, since the clamp caps the *input* variance the simulation sees, not just the output score. Hence, the 10% tolerance carries real downstream consequences - but it's a deliberate middle ground.


## Potential extensions

**AR(1) shocks.** Income and expense shocks are iid normal draws month to month, with no link between one month and the next. An AR(1) structure would capture that bad months cluster in reality (a job loss doesn't un-happen after one month) by making each month's shock partly depend on the last: `Z_t = phi*Z_{t-1} + sqrt(1-phi^2)*epsilon_t`. Not implemented, because it's a structural change which breaks the current per-month-independent-shock setup that both antithetic pairing and the `rho_IE` income/expense correlation construction depend on.

**Bounded distribution for shocks.** As stated, normal shocks can produce a negative income or expense draw, which is impossible for either in reality - `MAX_CV` (above) limits how often this happens but doesn't eliminate it. Two natural fixes exist, each with a real cost. A lognormal distribution rules out negative draws entirely, but correlating two lognormals doesn't preserve a target correlation the way two normals do, so it breaks the closed-form `rho_IE` construction used in the Monte Carlo section above. A truncated normal (floored at zero) is a smaller change, but breaks the clean antithetic-pairing variance-reduction proof in the Antithetic sampling section, since `f(Z)` and `f(-Z)` no longer cancel as neatly once floored pairs are involved. Normal was kept because both of those proofs depend on its symmetry - switching distributions means re-deriving both from scratch, not a drop-in swap. The choice trades some modelling realism for keeping two pieces of machinery that are actually proven to work, rather than swapping in a distribution and hoping the same guarantees still hold.

**Importance sampling.** Useful when the event you're measuring almost never happens in a plain simulation: bias the sampling toward it, then correct for the bias afterward. Not pursued here, since default isn't rare across the test population (Account 1 defaults on almost all paths) - the technique's use case doesn't apply.