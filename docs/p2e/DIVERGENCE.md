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
| `server/http/registry.ts` | p2e routes import + spread (scaffolder anchors) |
| `server/db.ts` | `P2E_SCHEMA` import + `ensureSchema` apply line |
| `server/http/error_codes.ts` | `p2e.invalid_input`, `p2e.insufficient_funds` (append-only) |
| `src/ui/api_error_i18n.ts` + `src/ui/i18n.catalog/api_error.ts` | apiError.p2e.* mappings + English |
| `src/ui/i18n.locales/{zh_CN,zh_TW,ja_JP,ko_KR,ru_RU}.ts` | M16 fills for apiError.p2e.* |
| `tests/server/http/surface_inventory.ts` | two /api/p2e rows |
| `tests/server/http/completeness.test.ts` | REGISTRY_ONLY_PATHS + migrated list rows |
| `tests/server/http/content_type_classification.ts` | /api/p2e rows (problem-json) |
| `tests/server/http/error_codes.test.ts` + `tests/api_error_code_parity.test.ts` | code snapshots |

## Upstream merge log

| Date | Upstream tag merged | Conflicts | Notes |
|---|---|---|---|
| (baseline) | main @ fb5d898b9 (v0.32.1 era) | n/a | Fork point |
