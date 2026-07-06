# Contributing to Rabble

## Getting set up

```bash
mise install          # node + pnpm at pinned versions (mise.toml)
mise run setup        # install deps, start Postgres (docker), migrate
mise run dev          # server :3080 + web :5173, hot reload
mise run seed-demo    # optional: a lived-in demo org
```

No mise? The underlying pnpm scripts work directly (`pnpm install`,
`pnpm db:migrate`, `pnpm dev`).

## The rules that keep the codebase coherent

Read `CLAUDE.md` (conventions & gotchas) and `docs/DECISIONS.md` before
anything structural. The short version:

- **Grants, not owners.** Rights are `use < edit < admin`, resolved by
  `rightsForAllAgents`/`hasRight`. Never invent an owner concept or a
  parallel permission path.
- **Audit everything on the control plane** — every mutation calls
  `recordAudit(...)`.
- **Secrets are always encrypted** (`crypto.ts`), never logged, never
  returned by the API.
- **`packages/core` is the contract.** SDK types (deepagents/LangChain)
  must not leak into core, routes, or the UI.
- **Scheduling means Hatchet.** No node-cron/BullMQ/setInterval loops.
- **Migrations are forward-only, hand-written SQL** in
  `packages/server/src/db/migrations/`, numbered, applied by
  `src/db/migrate.ts`. Update `db/schema.ts` in the same change.

## Testing (not optional)

Every behavior change ships with tests. Three layers:

```bash
pnpm typecheck        # tsc across the workspace
pnpm test             # vitest (core, server, web)
pnpm test:e2e         # full build + Playwright (needs Postgres)
```

The e2e suite runs from `packages/e2e`, drops/recreates `rabble_e2e`,
boots the emulator (`:4100`) and the production server build (`:3178`),
and asserts UI state, database rows, emulator traffic, and a clean server
log. If your feature talks to an external service, extend the emulator
(`docs/EMULATOR.md`) instead of mocking inside the app — app code never
knows it's under test.

Playwright gotchas that will bite you are listed in `CLAUDE.md`
(substring role matching, stream-vs-insert races, stale-port guard).

## Style

Match the file you're in. UI copy follows the locked naming in
`docs/PRODUCT_CONTEXT.md` §4 — "Sessions", "MCP", "Everyone", natural
casing, and never "owner" for access.
