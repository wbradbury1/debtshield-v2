# Regression baseline

Reference scores for the three test accounts in `data/`, recorded after fixing
the `parseDate` bug and adding
clamp logging (`variance_clamped` field + `WARNING` log line in `main.py`'s
`get_score`, which fires when a variance exceeds `MAX_CV = 0.78`).


| Account | File | Income CV | Expense CV | `rho_ie` | `variance_clamped` | Shield Score (pre item-4 fix) | Shield Score (post item-4 fix) |
|---|---|---|---|---|---|---|---|
| 1 (distressed) | `Bank Account 1.csv` | 0.304 | 0.075 | 0.078 | false | 0.1 | 2 |
| 2 (healthy) | `Bank Account 2.csv` | 0.050 | 0.050 | 0.122 | false | 100 | 100 |
| 3 (in-between) | `Bank Account 3.csv` | 0.718 | 0.068 | -0.580 | false | 68.5 | 82.1 |

CVs computed as `sqrt(var_income or var_expenses) / mean`, from the stored
profile after onboarding (`GET /user/{name}`). None of the three clamp - the
most volatile (Account 3's income) sits just under the 0.78 cap, as predicted.

## Item 4 fix (default rule: 1 bad month -> 3 consecutive bad months)

Post-fix scores recorded after `scoring.py`'s default condition changed from
single-breach (`defaulted |= (B < 0)`) to a 3-consecutive-month streak. All
three moved in the expected direction, and by the expected relative amount:

- Account 2 (never goes negative) is unchanged - "1 bad month" vs "3 in a
  row" makes no difference to an account that never breaches at all.
- Account 1 (chronically distressed, negative almost every month) barely
  moved - if you're breaching constantly, hitting 3-in-a-row happens almost
  as often as hitting it once.
- Account 3 (dips negative occasionally, recovers) moved the most (+13.6) -
  this is the account type the fix actually targets: rough patches that
  used to get flagged as default under the old single-breach rule no longer
  do, unless they're a genuine sustained 3-month streak.

This shape (biggest move in the middle account, near-zero move at both
extremes) is itself evidence the fix is doing the right thing, not just "a
different number."

## How to use this

Re-onboard all three accounts and rerun `GET /score/{name}` in `http://localhost:8000/docs` for each. Compare
against the scores above:

- `variance_clamped` is expected to stay `false` for these three CSVs under
  any future edit - their CVs come from the raw data, not the MC engine, so
  future changes to the simulation shouldn't affect them.
- If `variance_clamped` flips to `true` on any account, something upstream may have
  broke (input path, parsing, variance calc) or volatility may genuinely be high if testing a new CSV - investigate before trusting
  the new score.
