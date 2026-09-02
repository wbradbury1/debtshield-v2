# Convergence study

Account 3 profile, 30 independent seeds per N. `empirical_se` is the standard deviation of the point estimate across those seeds - the actual measured spread, not a formula. `naive_iid_se` is what sqrt(p(1-p)/N) predicts if all N paths were independent (they're not, because of antithetic sampling). `analytic_pair_se` is the pair-based formula `_score_margin_antithetic` uses (from a single run per N), included to check it against the real repeated-run spread rather than just trusting its own derivation.

| N | mean prob | empirical SE | naive iid SE | analytic pair SE |
|---|---|---|---|---|
| 1,000 | 0.18380 | 0.00911 | 0.01225 | 0.01083 |
| 5,000 | 0.17807 | 0.00425 | 0.00541 | 0.00480 |
| 20,000 | 0.17847 | 0.00238 | 0.00271 | 0.00239 |
| 50,000 | 0.17875 | 0.00174 | 0.00171 | 0.00152 |
| 100,000 | 0.17911 | 0.00118 | 0.00121 | 0.00107 |
| 200,000 | 0.17887 | 0.00062 | 0.00086 | 0.00076 |
| 400,000 | 0.17868 | 0.00042 | 0.00061 | 0.00054 |

Fitted slope of log(empirical_se) vs log(N): **-0.500** (Monte Carlo theory predicts -0.5, i.e. error shrinks as 1/sqrt(N)).
