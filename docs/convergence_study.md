# Convergence study

Account 3 profile, 30 independent seeds per N. `empirical_se` is the standard deviation of the point estimate across those seeds - the measured spread, not a formula. `naive_iid_se` is what sqrt(p(1-p)/N) predicts if all N paths were independent (they're not, because of antithetic sampling). `analytic_pair_se` is the pair-based formula `_prob_margin_antithetic` uses (from a single run per N), included to check it against the real repeated-run spread rather than just trusting its own derivation.

| N | mean prob | empirical SE | naive iid SE | analytic pair SE |
|---|---|---|---|---|
| 1,000 | 0.18610 | 0.00905 | 0.01231 | 0.01088 |
| 5,000 | 0.18036 | 0.00423 | 0.00544 | 0.00482 |
| 20,000 | 0.18069 | 0.00234 | 0.00272 | 0.00240 |
| 50,000 | 0.18088 | 0.00177 | 0.00172 | 0.00152 |
| 100,000 | 0.18126 | 0.00118 | 0.00122 | 0.00107 |
| 200,000 | 0.18103 | 0.00063 | 0.00086 | 0.00076 |
| 400,000 | 0.18085 | 0.00043 | 0.00061 | 0.00054 |

Fitted slope of log(empirical_se) vs log(N): **-0.495** (Monte Carlo theory predicts -0.5, i.e. error shrinks as 1/sqrt(N)).
