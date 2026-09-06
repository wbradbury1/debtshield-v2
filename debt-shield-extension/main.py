import logging
import math
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import UserOnboarding
from data_store import save_user, get_user
from scoring import shield_score

logger = logging.getLogger(__name__)

# Cap CV so a monthly draw has ~10% chance of going negative (can't happen
# for real income/expenses, but a normal draw has two tails so 10% is our upper threshold). P(X<0) =
# Phi(-1/CV), so CV <= 1/Phi^-1(1-p): p=0.10 -> Phi^-1(0.90) = 1.2816 ->
# CV <= 0.78 (old value was a flat 1.0 guess, ~16% chance). To retune:
# derive from a new p. Alternate distribution may be more appropriate.
MAX_CV = 0.78

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/onboard/")
def onboard_user(user: UserOnboarding):
    save_user(user)
    return {"message": f"Onboarding complete for {user.name}", "data": user}


@app.get("/user/{name}")
def get_user_data(name: str):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.get("/score/{name}")
def get_score(name: str, seed: int = 42):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Build debt parameter lists (math.inf for indefinite debts, APR % ->
    # monthly rate)
    d_list, p_list, t_list, r_list = [], [], [], []
    for debt in user.debts:
        d_list.append(debt.total_amount)
        p_list.append(debt.monthly_payment)
        t_list.append(math.inf if debt.months_remaining is None else float(debt.months_remaining))
        r_list.append(debt.apr / 100 / 12)   # APR % → monthly decimal rate

    # No debts -> a single dummy zero-balance entry so the arrays aren't empty
    if not d_list:
        d_list, p_list, t_list, r_list = [0.0], [0.0], [math.inf], [0.0]

    # average_expenses is INCLUSIVE of debt payments (as entered/derived from
    # the CSV); the sim accounts for those separately via p[], so strip them
    # out of mu_E here to avoid double-counting.
    total_monthly_debt = sum(debt.monthly_payment for debt in user.debts)
    adjusted_expenses  = max(0.0, user.average_expenses - total_monthly_debt)

    # Use CSV-derived variance where we have it; otherwise fall back to a
    # CV of 0.38, the median household income CV from JPMorgan Chase
    # Institute's "Weathering Volatility 2.0" (2019) - only hits test
    # users/direct API calls, normal onboarding always sends real variance
    if user.var_income is not None:
        var_I = user.var_income
    else:
        var_I = (user.average_income * 0.38) ** 2

    if user.var_expenses is not None:
        # Removing a fixed quantity (debt payments) from a random variable
        # doesn't change its variance, so pass the CSV value through as-is.
        var_E = user.var_expenses
    else:
        # Same source as the income fallback above, but spending volatility
        # runs ~15% lower than income volatility per that study's own
        # findings: 0.38 * 0.85 ≈ 0.32, not the same 0.38 used for income.
        var_E = (adjusted_expenses * 0.32) ** 2

    # MAX_CV is the module-level constant above. Expense cap uses
    # adjusted_expenses, not raw average_expenses - that's the mean the
    # simulator actually draws around, since debt payments go through p[]
    # separately. Stricter for debtors than the raw-mean version.
    variance_clamped = False

    if user.average_income > 0:
        cap_I = (user.average_income * MAX_CV) ** 2
        if var_I > cap_I:
            implied_cv = math.sqrt(var_I) / user.average_income
            logger.warning(
                "clamp fired for %s: income CV was %.0f%%, capped at %.0f%%",
                user.name, implied_cv * 100, MAX_CV * 100,
            )
            variance_clamped = True
        var_I = min(var_I, cap_I)

    if adjusted_expenses > 0:
        cap_E = (adjusted_expenses * MAX_CV) ** 2
        if var_E > cap_E:
            implied_cv = math.sqrt(var_E) / adjusted_expenses
            logger.warning(
                "clamp fired for %s: expense CV was %.0f%%, capped at %.0f%%",
                user.name, implied_cv * 100, MAX_CV * 100,
            )
            variance_clamped = True
        var_E = min(var_E, cap_E)

    # Income/expense shock correlation, from the user's own CSV. Clamped
    # to [-0.99, 0.99] as a backstop - pearsonCorrelation() on the
    # frontend can't exceed [-1, 1] mathematically, but prob_default_12m
    # rejects rho_IE outside that range outright.
    rho_IE = 0.0
    if user.rho_ie is not None:
        rho_IE = max(-0.99, min(0.99, user.rho_ie))

    result = shield_score(
        mu_I   = user.average_income,
        mu_E   = adjusted_expenses,
        var_I  = var_I,
        var_E  = var_E,
        d      = d_list,
        p      = p_list,
        t      = t_list,
        r      = r_list,
        B0     = user.current_savings,
        rho_IE = rho_IE,
        seed   = seed,
    )

    # ci_low/ci_high: 95% CI on the score, not symmetric under the
    # log-odds transform (see _prob_margin_antithetic, _score_transform).
    return {
        "name": user.name,
        "shield_score": result.score,
        "shield_score_ci_low": result.ci_low,
        "shield_score_ci_high": result.ci_high,
        "variance_clamped": variance_clamped,
    }