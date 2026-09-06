# Regression baseline

Reference scores for the three test accounts in `data/`.

| Account | File | Income CV | Expense CV | `rho_ie` | `variance_clamped` | Shield Score | 95% CI |
|---|---|---|---|---|---|---|---|
| 1 (distressed) | `Bank Account 1.csv` | 0.304 | 0.075 | 0.078 | false | 0 | [0, 0] |
| 2 (healthy) | `Bank Account 2.csv` | 0.050 | 0.050 | 0.122 | false | 100 | [100, 100] |
| 3 (in-between) | `Bank Account 3.csv` | 0.718 | 0.068 | -0.580 | false | 36.2 | [36.0, 36.3] |

CVs computed as `sqrt(var_income or var_expenses) / mean`. None of the three reference accounts hit the 0.78 coefficient-of-variation cap, so each one's simulated variance is its real CSV-derived variance, untouched. Account 3's income sits closest to the 0.78 cap, at 0.718.

**Two changes moved these scores during development.** The default rule went from single-breach to 3-consecutive-months, which mattered most for Account 3 (a rough patch no longer counts as default on its own). The score transform went from linear to log-odds, which dropped Account 1 from 2 to 0 and Account 3 from 82 to 36.2, we have the same underlying risk but now an honest scale instead of a potentially misleading one. 