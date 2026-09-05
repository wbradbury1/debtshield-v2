# Sensitivity analysis

Tests the two scoring-engine assumptions with no external anchor: the score-transform anchor points, and MAX_CV's underlying tail-tolerance. `z=1.96`, `N`, the 3-month default threshold, and `NEGATIVE_BALANCE_RATE` were excluded: each traces to an external anchor (a mathematical definition, the convergence study itself, Basel II, or real surveyed bank rates), so sweeping them would just re-derive an already-fixed external fact rather than test our own judgement. Both sweeps run on Account 3 (BASELINE.md's "in-between" case, not degenerate at 0 or 100, so there's room to see movement) at a fixed seed (42) throughout, so any movement below is attributable only to the swept parameter, never a different Monte Carlo draw.

## Anchor points

| anchors | 1% PD -> | 50% PD -> | Shield Score | 95% CI |
|---|---|---|---|---|
| current | 90 | 10 | 36.2 | [36.0, 36.3] |
| gentler | 95 | 20 | 44.5 | [44.4, 44.7] |
| harsher | 85 | 5 | 31.2 | [31.0, 31.3] |

## MAX_CV tail tolerance

Account 3's actual income CV is 0.718 (`BASELINE.md`) - below today's 0.78 cap (never clamped in production), but above the stricter caps implied by lower tail-tolerance choices.

| tail tolerance | implied MAX_CV | clamp fires? | income CV used | Shield Score | 95% CI |
|---|---|---|---|---|---|
| 20.0% | 1.188 | False | 0.718 | 36.2 | [36.0, 36.3] |
| 10.0% | 0.780 | False | 0.718 | 36.2 | [36.0, 36.3] |
| 5.0% | 0.608 | True | 0.608 | 42.4 | [42.2, 42.6] |
| 2.5% | 0.510 | True | 0.510 | 50.0 | [49.8, 50.3] |
