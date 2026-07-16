# Regression baseline

Reference scores for the three test accounts in `data/`, recorded after fixing
the `parseDate` bug and adding
clamp logging (`variance_clamped` field + `WARNING` log line in `main.py`'s
`get_score`, which fires when a variance exceeds `MAX_CV = 0.78`).

Recorded: 2026-07-16.

| Account | File | Income CV | Expense CV | `variance_clamped` | Shield Score |
|---|---|---|---|---|---|
| 1 (distressed) | `Bank Account 1.csv` | 0.304 | 0.075 | false | 0.1 |
| 2 (healthy) | `Bank Account 2.csv` | 0.050 | 0.050 | false | 100 |
| 3 (in-between) | `Bank Account 3.csv` | 0.718 | 0.068 | false | 70.6 |

CVs computed as `sqrt(var_income or var_expenses) / mean`, from the stored
profile after onboarding (`GET /user/{name}`). None of the three clamp - the
most volatile (Account 3's income) sits just under the 0.78 cap, as predicted.

## How to use this

Re-onboard all three accounts and rerun `GET /score/{name}` in `http://localhost:8000/docs` for each. Compare
against the scores above:

- `variance_clamped` is expected to stay `false` for these three CSVs under
  any future edit - their CVs come from the raw data, not the MC engine, so
  future changes to the simulation shouldn't affect them.
- If `variance_clamped` flips to `true` on any account, something upstream may have
  broke (input path, parsing, variance calc) or volatility may genuinely be high if testing a new CSV - investigate before trusting
  the new score.
