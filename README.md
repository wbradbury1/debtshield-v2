# debtshield-v2
Monte Carlo credit risk model with statistical validation and extensions. Starts from debtshield-v1 and builds upon it.

## Bug fixes

v1 had three real bugs, and none of them were caught because v1 never checked variance against its mean in the first place. It stored raw variance and fed it straight into the simulation, with no concept of coefficient of variation (standard deviation divided by mean, denoted CV) to sanity-check the pair. That's how editing a household's average income or expense could leave the old CSV-derived variance attached to a mean it no longer matched: nothing flagged the mismatch. In one test profile this pushed implied income volatility to 412% of the mean: roughly 40% of simulated income draws came out negative, and a near-riskless profile scored only 67.7. The CSV parser also classified every positive transaction as income and every negative transaction as an expense, so a single large transfer or refund could make a month look far more volatile than the household's actual spending pattern. A date sort bug could also pull the starting cash balance from the wrong row, which matters because that single number anchors every simulated path for the full year.

v2 fixes each of these three at the source. Editing income or expenses by hand now invalidates the paired variance instead of keeping it, so the score falls back to the ±20% heuristic and stays there until a re-uploaded CSV recomputes both mean and variance together as there's no way to recompute a variance for a hand-typed mean. The parser flags a transaction as a one-off only if it exceeds 3x the median transaction size for its sign and no similarly sized transaction (within 20%) shows up in at least two other months. A real one-off transfer gets excluded this way, while a quarterly bonus or a variable salary survives, as long as similar-sized payments show up in other months. The date sort now reads the correct row. On top of these three, v2 introduces CV as an explicit check for the first time: the scoring endpoint caps it at 78%, derived from a 10% tail-probability tolerance (P(negative draw) = Φ(−1/CV), so CV ≤ 1/Φ⁻¹(0.90) ≈ 0.78), loose by design so it catches genuinely broken values like the 412% case without constraining normal variation. The most volatile reference account measures 0.72 and passes untouched.

## Test data

`data/` holds three example transaction sets, sourced via the Open Banking Project sandbox and cleaned into CSV files. Account 1 is distressed, with payday loans, subprime credit, and frequent negative balances. Account 2 stays healthy, with stable income and balance never negative. Account 3 sits in between, with modest income and risk from expense timing rather than debt.

## Default definiton

v1 models default as a first-passage barrier crossing. A household's monthly cash balance (income minus expenses minus debt payments) follows a random walk, and default triggers the first month that balance drops below zero. The mechanism matches a Black-Cox model, the first-passage structural credit framework used for corporate default risk, with a household's cash balance standing in for a firm's asset value.

v2 replaces the single-month trigger with a continuous Parisian barrier condition. Default now requires the balance to stay negative for three consecutive months, and the count resets to zero the moment the balance recovers. This fixes a real issue in v1: a single noisy month could flag default even when a household's average cash flow stayed positive. Three months matches the 90-days-past-due default standard set by Basel II.

## Monte Carlo

Monte Carlo simulation estimates probability of default, run over 200,000 independent paths. Each path simulates 12 months of income and expenses as correlated random shocks. Each month the balance moves by income minus living expenses minus scheduled debt payments, and any remaining debt balance accrues interest at its own rate, until the barrier condition triggers or the year ends. Expenses as entered include debt payments. The backend strips these out before simulating: the simulator charges each debt on its own schedule, and leaving them in would count the same payment twice. Probability of default is the fraction of paths that trigger it.

## Shield Score

Shield Score is a linear transform of that probability: score = (1 - P(default)) * 100. The transform holds up across the range this model produces. It only loses resolution well beyond what 200,000 paths can reliably estimate in the first place. Sampling error is the real limit on precision here. A confidence interval on the estimate is a planned addition.




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