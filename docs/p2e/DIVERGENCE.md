# Divergence ledger

Every upstream file this fork has MODIFIED, with the reason. New files in new
directories (for example everything under `docs/p2e/` and, later, `server/p2e/`
and `src/sim/content/p2e_*`) do not belong here: they cannot conflict. Keep this
list short by keeping the modified-file set short (see PLAN.md section 4,
"Additive-first rule").

At every upstream release merge, walk this table top to bottom: it is the
conflict checklist.

## Modified upstream files

| File | Why it was modified | Since |
|---|---|---|
| (none yet) | | |

## Registration-point edits (expected, low-risk)

These are the sanctioned one-line touch points where fork modules register into
upstream tables. Conflicts here are trivial to re-apply.

| File | Registration |
|---|---|
| (none yet) | |

## Upstream merge log

| Date | Upstream tag merged | Conflicts | Notes |
|---|---|---|---|
| (baseline) | main @ fb5d898b9 (v0.32.1 era) | n/a | Fork point |
