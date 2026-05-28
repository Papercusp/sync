# TESTING — @restart/sync

## What this project's tests cover

- (none yet) — drop `*.test.ts` files alongside source and they'll be picked up by `npm test`.

## What they don't cover (yet)

- No tests exist yet — see "Run after editing" below for how to add them.

## Run after editing

| Edit touches                        | Run                                                       |
| ----------------------------------- | --------------------------------------------------------- |
| Anything in this workspace          | `npm test --workspace @restart/sync`                   |
| Code that other workspaces depend on| `npm run test:affected` from repo root             |

See repo-root `CLAUDE.md` (`Tests after editing` block) and the unified
testing spec at `http://localhost:3055/docs/testing` for the full
strategy.

---
*Scaffolded 2026-05-07 by `scripts/gen-testing-md.mjs`. Replace this footer when you've filled in real coverage notes.*
