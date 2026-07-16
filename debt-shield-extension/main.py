import logging
import math
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import UserOnboarding
from data_store import save_user, get_user
from simulation import simulate_purchase
from scoring import shield_score

logger = logging.getLogger(__name__)

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


@app.post("/simulate/{name}")
def simulate(name: str, purchase_amount: float):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    result = simulate_purchase(user, purchase_amount)
    return result


@app.get("/score/{name}")
def get_score(name: str):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # --- Build debt parameter lists ---
    # Use math.inf for indefinite debts; convert APR % to monthly rate
    d_list, p_list, t_list, r_list = [], [], [], []
    for debt in user.debts:
        d_list.append(debt.total_amount)
        p_list.append(debt.monthly_payment)
        t_list.append(math.inf if debt.months_remaining is None else float(debt.months_remaining))
        r_list.append(debt.apr / 100 / 12)   # APR % → monthly decimal rate

    # If the user has no debts, use a single dummy zero-balance entry
    if not d_list:
        d_list, p_list, t_list, r_list = [0.0], [0.0], [math.inf], [0.0]

    # --- Adjust expenses to exclude debt payments (avoid double-counting) ---
    # The user's average_expenses is INCLUSIVE of debt payments (as entered/derived
    # from their CSV). The simulation accounts for debt payments separately via p[],
    # so we strip them out of mu_E here.
    total_monthly_debt = sum(debt.monthly_payment for debt in user.debts)
    adjusted_expenses  = max(0.0, user.average_expenses - total_monthly_debt)

    # --- Variance: use CSV-derived values if available, else ±20% heuristic ---
    # 20% is a guess, unfitted. only hits accounts with no CSV stats (test
    # users, direct API calls) - normal onboarding always sends real variance
    if user.var_income is not None:
        var_I = user.var_income
    else:
        var_I = (user.average_income * 0.20) ** 2

    if user.var_expenses is not None:
        # Also need to adjust the expense variance: removing a fixed quantity
        # (total debt payments) from a random variable doesn't change its variance,
        # so we pass the raw CSV expense variance through unchanged.
        var_E = user.var_expenses
    else:
        var_E = (adjusted_expenses * 0.20) ** 2

    # cap CV so a monthly draw has ~10% chance of going negative (can't
    # actually happen for income/expenses). P(X<0) = Phi(-1/CV) for a
    # normal draw, so CV <= 1/Phi^-1(1-p). p=0.10 -> Phi^-1(0.90)=1.2816
    # -> CV <= 0.78. old value was a flat 1.0 guess (~16% chance). change
    # p and look up Phi^-1(1-p) to retune, don't just pick a new CV
    MAX_CV = 0.78
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

    if user.average_expenses > 0:
        cap_E = (user.average_expenses * MAX_CV) ** 2
        if var_E > cap_E:
            implied_cv = math.sqrt(var_E) / user.average_expenses
            logger.warning(
                "clamp fired for %s: expense CV was %.0f%%, capped at %.0f%%",
                user.name, implied_cv * 100, MAX_CV * 100,
            )
            variance_clamped = True
        var_E = min(var_E, cap_E)

    score = shield_score(
        mu_I  = user.average_income,
        mu_E  = adjusted_expenses,
        var_I = var_I,
        var_E = var_E,
        d     = d_list,
        p     = p_list,
        t     = t_list,
        r     = r_list,
        B0    = user.current_savings,
        N     = 200_000,
    )

    return {"name": user.name, "shield_score": score, "variance_clamped": variance_clamped}