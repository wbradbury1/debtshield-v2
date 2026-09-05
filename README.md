# debtshield-v2

Monte Carlo household credit-risk scoring engine. v1 started as a hackathon build and won; v2 rebuilds it closer to production-grade: real statistical validation in place of asserted claims, a scoring engine that reflects genuine credit risk instead of a hackathon shortcut, and every hardcoded number tied to a citation, a derivation, or a documented modelling choice.

What changed from v1: fixed a variance bug that let one test profile hit 412% implied income volatility and still score as safe; replaced the single-bad-month default trigger with a Basel II-aligned three-consecutive-month rule; replaced a linear score that undersold mid-range risk with a log-odds transform in the same family real credit scorecards use; priced negative cash balances at a real UK overdraft rate instead of letting them sit free; and backed the statistics with a sensitivity analysis and a convergence study rather than asserting they hold.

See `FEATURES.md` for what it does and the math behind it.

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
