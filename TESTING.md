# TESTING — @restart/sync

## What this project's tests cover

- (none yet) — drop `*.test.ts` files alongside source and they'll be
  picked up by `npm test`.

This is a thin wrapper around Zero sync providers (`SyncContext.ts` +
`fallback/`). Most coverage lives in the consuming apps' integration
tests — `apps/operator/test/` exercises the live Zero schema against
`harness_zero` + `zero_harness` publication.

## What they don't cover

- Zero schema versioning — verified by the operator's `zero-cache`
  smoke test on every change.
- Network-layer reconnection — not yet covered; would require a
  testcontainers Postgres + zero-cache spinup (Phase 3 follow-up).

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `SyncContext.ts` types              | `npm run test:affected` from repo root                |
| `fallback/` provider                | `npm test --workspace @restart/sync` + manual operator smoke |
| Zero schema (in consumers)          | `npm run test:all:integration`                        |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
