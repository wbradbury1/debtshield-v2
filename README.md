# debtshield-v2

Monte Carlo household credit-risk scoring engine. v1 started as a hackathon build and won; v2 rebuilds it closer to production-grade: real statistical validation in place of asserted claims, a scoring engine that reflects genuine credit risk instead of a hackathon shortcut, and every hardcoded number tied to a citation, a derivation, or a documented modelling choice.

What changed from v1: fixed a variance bug that let one test profile hit 412% implied income volatility and still score as safe; replaced the single-bad-month default trigger with a Basel II-aligned three-consecutive-month rule; replaced a linear score that undersold mid-range risk with a log-odds transform in the same family real credit scorecards use; priced negative cash balances at a real UK overdraft rate instead of letting them sit free; and backed the statistics with a sensitivity analysis and a convergence study rather than asserting they hold.

See `FEATURES.md` for what it does and the math behind it.

## Test data

`data/` holds three example transaction sets, sourced via the Open Banking Project sandbox and cleaned into CSV files. Account 1 is distressed, with payday loans, subprime credit, and frequent negative balances. Account 2 stays healthy, with stable income and balance never negative. Account 3 sits in between, with modest income and risk from expense timing rather than debt.

## Onboarding debts

Declared debts must already appear in the uploaded statement. The backend subtracts each declared monthly payment from average expenses before simulating, then charges the debt on its own schedule with interest and payoff, so each payment is counted exactly once. Declaring a debt the statement never saw subtracts it from expenses it was never part of, and the score comes out too optimistic by that payment. The reverse holds too. An undeclared debt stays inside expenses as a flat monthly outflow, skipping the simulator's amortisation schedule. Its interest never accrues and its balance never drops.

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
