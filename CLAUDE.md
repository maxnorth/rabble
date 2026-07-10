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
  handoff — do not invent colors). Sections in `src/pages/`. Two themes:
  dark (default) + `[data-theme="light"]` override the SAME semantic
  tokens — components must only reference tokens (or `color-mix` on them),
  never raw hex/rgba, or they'll break in one theme. Theme applied
  pre-paint by an inline script in index.html; switched via `lib/theme.ts`
  (System/Light/Dark on Profile, sun/moon on the rail).
- `packages/emulator` — scriptable fakes of external services (Anthropic,
  OpenAI, MCP, Slack) mounted under `/mock/<host>/...` with `/admin/*`
  endpoints. The app never knows it's fake; only base URLs differ. No
  `if test_mode` branches in app code — keep it that way.
- `packages/e2e` — Playwright suite (ordered journey files, run
  alphabetically: 01-journey … 10-admin). Asserts UI
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
- Slack has two transports sharing one pipeline (`surfaces/slack.ts`):
  Events webhooks and Socket Mode (connection stores an encrypted app
  token → `surfaces/slackSocket.ts` dials `apps.connections.open` and acks
  envelopes by id; rotating the app token via edit reconnects immediately).
  Routing follows the identity link (see the identity bullet below); a
  threaded reply always continues under its session's agent.
  Emulator: `POST /admin/slack/socket-event` (optional `appToken` targets
  one workspace's socket, else broadcasts); `GET /admin/slack/socket` shows
  socket count, connected `apps`, sent/ack log. Dedup (event ids AND
  message identity `msg:channel:ts`) is durable in `delivered_events` and
  spans both transports, processes, and restarts. Connections are editable
  in place (`PATCH /api/connections/:id`, tri-state secrets: omit=keep,
  string=set, null=clear) so enabling Socket Mode never deletes surface
  mappings.
- The Builder: agents with `builtin = 'builder'` (seeded per org at setup)
  get platform tools (runtime/platformTools.ts) — create_agent_draft,
  add_eval_criterion, attach_mcp_server, request_access — user-auth,
  rights-checked per tool, audited "via Builder". Builder has no pinned
  model; resolveAgentModel falls back to the org's first enabled model.
  request_access rows land in access_requests; approve (Admin › Access
  requests) materializes/upgrades a user grant.
- Gating: PATCH /api/agents/:id runs the agent's gating suites against the
  CANDIDATE config for behavior changes (name/description/instructions/
  tone/model) and 409s on a failing case — remember this when e2e edits a
  gated agent (each gate run consumes emulator LLM calls).
- Sessions carry `surface`/`surface_key`; inbound Slack events land at
  POST /api/inbound/slack (Slack v0 HMAC signing over the RAW body — the
  route scope has its own string content-type parser; don't move it under
  the JSON-parsed tree).
- A connection is one agent's identity: agent_surfaces links exactly one
  agent per connection (DB exclusion constraint, 0025); an agent may hold
  several connections. Everything answers as the linked agent; unlinked
  connections reply to DMs/mentions with a link-me hint (no session) and
  ignore ambient channel messages. No intent routing on Slack (web "Auto"
  sessions still route by intent).
- Approvals: the in-memory broker (runtime/approvals.ts) arbitrates all
  surfaces — web card, Slack DM buttons (interactivity endpoint), and
  pending asks returned on session GET. e2e runs with
  APPROVAL_TIMEOUT_MS=15000; UI-path approval tests must beat that window.
- Trust data (spot-check queue, scope violations 30d, graded count, judge
  model) comes from GET /api/agents/:id/trust; scope violations are
  recorded by the runtime when the model calls a tool outside its governed
  set + runtime built-ins (see RUNTIME_BUILTINS in agentTurn.ts).
- Outbound web access is a capability, not a default (`runtime/webTools.ts`,
  `buildWebTools`): the agent gets a governed `fetch_url` tool ONLY when its
  Advanced-tab `capabilities.outboundWebAccess` is on, and every fetch is
  bound to `capabilities.networkAllowlist`. Fail-closed — no capability or an
  empty allowlist refuses all fetches. Allowlist matching is exact-host or
  `*.suffix` (proper subdomains only, never the apex, never a substring, so
  `evil-example.com` can't ride in on `example.com`); redirects are followed
  but re-checked per hop; http/https only, with a timeout and size cap. The
  allowlist IS the authorization boundary (an admin naming a host authorizes
  egress there, localhost included — which is what lets e2e fetch the
  emulator). Runs as the org service account (no per-call approval); the tool
  name joins `allowedTools` so a legit fetch isn't a false scope violation.
- Sub-agent delegation (bounded delegation pillar): agents linked via the
  "Agents" tab (`agent_links`; attach needs `use` on the target) become
  callable tools (`ask_<slug>`) in `buildSubAgentTools`. Each call runs the
  child as a real, persisted, judged session (surface `Delegated by
  <parent>`) via `executeTurnAndPersist` under the SAME user — so delegated
  work lands on the child's own track record and stays fully auditable, and
  the child's model/MCP tools/auth gates apply so governance composes. The
  edge note is the tool description; the child's reply folds back as the tool
  output; each call audits `agent.delegate` (metadata carries the
  `childSessionId`). The child starts UN-approved (`sessionApproved:false`) —
  a parent-session consent never authorizes a different agent — so its
  user-auth tools face their own gate and, being non-interactive, auto-deny.
  Depth/cycles are bounded (MAX_DELEGATION_DEPTH threaded as `delegationChain`
  through executeTurn), breadth is capped per turn
  (MAX_DELEGATIONS_PER_TURN), links are same-org only, and delegation tool
  names join `allowedTools` so a legitimate call isn't a false scope
  violation.
- e2e global-setup refuses to start if :4100/:3178 are already bound —
  kill stale processes (`fuser -k 4100/tcp 3178/tcp`) instead of letting
  tests hit an old build.
