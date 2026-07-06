# Rabble — agent platform monorepo

"GitHub for agents": an org-wide platform where agents are governed citizens
with identities, scoped access (grants), measured track records (evals), and
full auditability. Product spine and locked naming decisions:
`docs/PRODUCT_CONTEXT.md` (§4 is non-negotiable). Technical decisions:
`docs/DECISIONS.md`. Design tokens & fidelity contract: `docs/DESIGN_HANDOFF.md`.

## Layout

- `packages/core` — shared Zod schemas/types; the API contract. No SDK types
  may leak in here.
- `packages/server` — Fastify + Drizzle (Postgres). Routes in `src/routes/`,
  grants engine in `src/rights.ts`, audit in `src/audit.ts`, agent runtime
  (deepagents + governed MCP tools + approval broker) in `src/runtime/`,
  LLM judge in `src/evals/`, migrations in `src/db/migrations/*.sql`
  (forward-only, hand-written, applied by `src/db/migrate.ts`).
- `packages/web` — React + Vite. Design tokens in `src/styles.css` (from the
  handoff — do not invent colors). Sections in `src/pages/`.
- `packages/emulator` — scriptable fakes of external services (Anthropic,
  OpenAI, MCP, Slack) mounted under `/mock/<host>/...` with `/admin/*`
  endpoints. The app never knows it's fake; only base URLs differ. No
  `if test_mode` branches in app code — keep it that way.
- `packages/e2e` — Playwright suite (5 ordered journey files). Asserts UI
  state, database rows, emulator traffic, and clean server logs.

## Commands

```bash
pg_ctlcluster 16 main start        # (sandbox) or: docker compose up -d postgres
pnpm install && pnpm db:migrate
pnpm dev                           # server :3080 + web :5173 (proxied)
pnpm typecheck && pnpm test        # unit (vitest)
pnpm test:e2e                      # full build + e2e (needs Postgres)
cd packages/e2e && pnpm exec playwright test 01-journey   # one journey file
```

E2E must run from `packages/e2e` (not `tests/`). The suite drops/recreates
`rabble_e2e`, boots the emulator (:4100) and the production server (:3178).

## Conventions & gotchas

- Rights: `use < edit < admin`. Org owners/admins have admin everywhere;
  creators have admin on their agents; team grants cascade to sub-teams;
  domain grants apply to member agents. Enforce via `rightsForAllAgents` /
  `hasRight`; never invent an "owner" concept.
- Every control-plane mutation calls `recordAudit(...)`.
- Secrets (API keys, tokens) are AES-GCM encrypted via `crypto.ts`; never
  store or log plaintext, never return them from the API.
- Session SSE contract in core (`streamEventSchema`): user-message, delta,
  tool-start/tool-end, approval-request, done, error.
- The deepagents SDK is a replaceable layer — keep its types out of core,
  routes, and UI (`docs/DECISIONS.md`).
- Scheduling/background work must use Hatchet when introduced — no
  node-cron/BullMQ (`docs/DECISIONS.md`).
- Playwright: role-name matching is substring — use `exact: true` for short
  labels like "+ Add". After asserting streamed UI text, poll the DB
  (`pollFirstToolCall`) — inserts land just after the last delta renders.
- Emulator scripting: `POST /admin/llm/enqueue` `{type:"tool_call",
  toolName, toolArgs}` makes the next model call request that tool; default
  reply echoes the last user message ("Mock reply to: ..."); judge prompts
  (containing "Respond with exactly PASS or FAIL") get "PASS". Slack
  directory (user id → email, channel id → name) via `PUT /admin/slack`.
- Gating: PATCH /api/agents/:id runs the agent's gating suites against the
  CANDIDATE config for behavior changes (name/description/instructions/
  tone/model) and 409s on a failing case — remember this when e2e edits a
  gated agent (each gate run consumes emulator LLM calls).
- Sessions carry `surface`/`surface_key`; inbound Slack events land at
  POST /api/inbound/slack (Slack v0 HMAC signing over the RAW body — the
  route scope has its own string content-type parser; don't move it under
  the JSON-parsed tree).
- Trust data (spot-check queue, scope violations 30d, graded count, judge
  model) comes from GET /api/agents/:id/trust; scope violations are
  recorded by the runtime when the model calls a tool outside its governed
  set + runtime built-ins (see RUNTIME_BUILTINS in agentTurn.ts).
- e2e global-setup refuses to start if :4100/:3178 are already bound —
  kill stale processes (`fuser -k 4100/tcp 3178/tcp`) instead of letting
  tests hit an old build.
