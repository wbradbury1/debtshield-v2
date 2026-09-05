from pydantic import BaseModel, Field
from typing import List, Optional

class SavingsGoal(BaseModel):
    name: str
    target_amount: float = Field(ge=0)
    priority: int = 1           # 1 = highest priority; lower number = more weight

class Debt(BaseModel):
    category: str
    label: str
    total_amount: float = Field(ge=0)
    monthly_payment: float = Field(ge=0)
    apr: float = Field(ge=0, le=100)
    months_remaining: Optional[float] = Field(default=None, gt=0)

class UserOnboarding(BaseModel):
    name: str
    current_savings: float   # NOT bounded: overdrafts are legitimately negative
    average_income: float = Field(ge=0)
    average_expenses: float = Field(ge=0)
    var_income: Optional[float] = None
    var_expenses: Optional[float] = None
    rho_ie: Optional[float] = None   # Pearson correlation between monthly income/expense shocks, estimated from CSV
    savings_allocation_pct: float = Field(default=50.0, ge=0, le=100)   # % of monthly surplus allocated to savings goals
    savings_goals: List[SavingsGoal]
    debts: List[Debt] = []