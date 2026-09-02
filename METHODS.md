# Methods

The technical write-up. README covers what the project does and how to run it; this covers how the statistics actually work, with the derivations and the reasoning behind each choice. Written from what's genuinely built, not aspirational - if it's not in `scoring.py`, it's not in here either.

## Shock model

Each path simulates 12 months of income and expenses as correlated normal draws. Income is straightforward: `income = mu_I + sigma_I * Z0`, one standard normal per path per month.

Expenses need to come out correlated with income (a bad income month usually drags expenses into a bad month too - lost hours, job loss), but both still need to look like a proper Normal(mu, sigma^2) on their own. The construction:

```
expenses = mu_E + sigma_E * (rho_IE * Z0 + sqrt(1 - rho_IE^2) * Z1)
```

where `Z0` is income's own shock and `Z1` is an independent second draw. This is the standard two-variable correlated-normal construction: `rho_IE * Z0 + sqrt(1-rho_IE^2) * Z1` is itself a standard normal (weights are chosen so the variance works out to exactly 1), and its correlation with `Z0` is exactly `rho_IE`, since `Cov(Z0, rho_IE*Z0 + sqrt(1-rho_IE^2)*Z1) = rho_IE * Var(Z0) = rho_IE`. At `rho_IE = 1`, expenses track income's shock exactly; at `rho_IE = 0`, they're independent.

`rho_IE` itself is the Pearson correlation estimated directly from the household's own uploaded CSV, not a fitted or assumed constant (see README's Monte Carlo section for when it falls back to independent shocks instead).

## Default rule

Rationale for the 3-consecutive-month rule (Black-Cox vs Parisian, the Basel II citation) is in README's **Default definiton** section - not repeating it here. One implementation detail worth being explicit about, since it's easy to get subtly wrong: the streak counter (`consecutive_shortfall_months`) *resets to 0* on any solvent month, it doesn't decrement. That's "3 in a row," not "3 bad months somewhere in the last N." A path with months `[-50, +10, -50, -50, -50]` defaults (three genuine in-a-row at the end); one with `[-50, -50, +10, -50, -50]` does not, despite having the same total count of bad months. That distinction - sustained distress versus a rough patch with the same bad-month count - is the entire point of moving off the single-breach rule, so it has to be reset-to-zero, not a decrementing counter.

## Antithetic sampling

**The mechanism.** Rather than drawing N fully independent shocks, the engine draws N/2 and mirrors each one (negates it) to get the other N/2. Path `i` (for `i` in `[0, half)`) pairs with path `half + i`, using `Z` and `-Z` respectively.

**Why it reduces variance.** For a pair `(Z, -Z)`, consider the average of the two outcomes, `(f(Z) + f(-Z)) / 2`, where `f` is "did this path default." Its variance is:

```
Var[(f(Z) + f(-Z)) / 2] = [Var(f(Z)) + Var(f(-Z)) + 2*Cov(f(Z), f(-Z))] / 4
```

If `Z` and `-Z` gave independent draws, the covariance term would vanish and this would just be the usual "averaging halves variance" result. But they're not independent - they're mirror images - so if `f` responds to the shock in opposite directions for `Z` versus `-Z`, `Cov(f(Z), f(-Z))` is negative, and the pair-average has *less* variance than plain averaging predicts.

**Why that covariance is actually negative here.** Default probability responds monotonically to the shocks: an unusually bad income draw (`Z` very negative) pushes a path toward default; the mirrored path gets an unusually good income draw (`-Z` very positive), pushing it away from default. So across a pair, one path being more likely to default comes with its mirror being less likely to default - exactly the negative correlation the variance-reduction argument needs. This monotonicity is the condition antithetic sampling requires to actually help; it wouldn't do anything for a non-monotonic function of the shocks.

## Confidence interval

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

so `p_hat` is literally the sample mean of the `half` pair-averages, and since those pair-averages *are* iid, the ordinary sample-mean standard error applies directly to them: `se = std(pair_avg) / sqrt(half)`. This is what `_score_margin_antithetic` computes - same CLT logic as the base derivation, just applied to the unit that's actually independent (the pair, not the path).

**Caveats, stated plainly.** The interval is approximate (asymptotic), not exact - fine at N in the hundreds of thousands. Bounds clamp to [0, 100] like the score itself, so a score sitting right at the boundary shows a narrower interval than the true one. If N is odd, one leftover unpaired path is folded into the point estimate but dropped from the pair-average SE calculation - negligible for any N in practical use.

The engine runs on a fixed seed by default (identical inputs always reproduce the identical score), so the CI describes how much the score would move across different seeds, not run-to-run wobble on a fixed one. `/score/` accepts an optional `seed` parameter for inspecting that directly.

## Convergence study

`debt-shield-extension/convergence_study.py` checks the CI and the variance-reduction claim against actual repeated runs, not just the maths.

**Setup.** Account 3's profile (the "in-between" case in `BASELINE.md` - not degenerate at 0 or 100, so the estimate has room to actually move). N from 1,000 to 400,000, 30 independent seeds per N. Three quantities per N:

- **empirical SE** - the standard deviation of the point estimate across the 30 seeds. The actual measured spread, not a formula.
- **naive iid SE** - `sqrt(p_bar(1-p_bar)/N)`, what the plain independent-trials formula would predict if antithetic pairing weren't happening.
- **analytic pair SE** - the actual formula `_score_margin_antithetic` uses, from a single run per N.

**Results.**

| N | mean prob | empirical SE | naive iid SE | analytic pair SE |
|---|---|---|---|---|
| 1,000 | 0.18380 | 0.00911 | 0.01225 | 0.01083 |
| 5,000 | 0.17807 | 0.00425 | 0.00541 | 0.00480 |
| 20,000 | 0.17847 | 0.00238 | 0.00271 | 0.00239 |
| 50,000 | 0.17875 | 0.00174 | 0.00171 | 0.00152 |
| 100,000 | 0.17911 | 0.00118 | 0.00121 | 0.00107 |
| 200,000 | 0.17887 | 0.00062 | 0.00086 | 0.00076 |
| 400,000 | 0.17868 | 0.00042 | 0.00061 | 0.00054 |

Fitted slope of `log(empirical SE)` against `log(N)`: **-0.500**, matching the O(1/√N) rate Monte Carlo theory predicts almost exactly.

**Interpretation.** `analytic pair SE` sits below `naive iid SE` at every N - the variance reduction from antithetic pairing is showing up empirically, not just asserted. `empirical SE` and `analytic pair SE` track each other closely, sitting slightly above or below one another at different N (e.g. `empirical` a touch above `analytic` at N=50,000/100,000, a touch below elsewhere) - expected noise from estimating a standard deviation off only 30 reps (relative uncertainty on a std-of-30 estimate is roughly ±13%), not a discrepancy worth chasing further. Raw numbers in `docs/convergence_study.csv` / `docs/convergence_study.md`; rerun with `python convergence_study.py` from `debt-shield-extension/`.

## Scoped out

See README's "Potential Extensions" section for what was deliberately left out (AR(1)/fat-tailed shocks, importance sampling) and why.
