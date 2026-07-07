# Technical decisions

Running log of locked technical decisions. Product/naming decisions live in
[PRODUCT_CONTEXT.md](PRODUCT_CONTEXT.md) §4.

## Stack

- **TypeScript everywhere**, pnpm workspaces + Turborepo monorepo.
- **Postgres only** (no SQLite tier). Self-hosters run it via docker-compose.
- **Fastify + Drizzle** on the server; **React + Vite** on the web.
- **Email/password auth with first-boot owner setup** for the open-source
  version; SSO/OIDC arrives later as an additional login method.
- **Multi-tenant-ready schema**: every table carries `org_id` from day one.
  The OSS build runs a single org; the SaaS version reuses the same schema.

## Models

Two kinds of registered models:

- **Built-in**: curated catalog shipped with the platform; authenticated by a
  single org-level provider key (or server env var). Enabling one never asks
  for credentials.
- **Custom**: user-registered — protocol (Anthropic or OpenAI-compatible),
  optional base URL (direct provider or any gateway), model id, own API key.
  Unlimited registrations.

## Agent runtime

The agent loop runs on the **LangChain Deep Agents SDK** (`deepagents`,
LangGraph-based). It provides planning (todos), a virtual filesystem,
sub-agents, and per-tool human-in-the-loop interrupts (`interruptOn`) out of
the box — accelerants for the roadmap. This is an explicitly **replaceable
abstraction layer**: Rabble owns the seams around it (model registry and
credential resolution, transcript persistence, the `AgentTurnEvent` stream
contract in `runtime/agentTurn.ts`, and eventually grant-gated tool
injection), so the SDK can be swapped for something custom later without
touching routes, schema, or UI. Keep SDK types out of `@rabblehq/core` and out
of API contracts.

## Scheduling & background work

**Hatchet** (hatchet.dev) is the designated engine for all scheduling and
background work — automations, scheduled agent runs, eval suite executions,
digests/alerts, and any queue-shaped workload. Rationale: Postgres-backed (no
new datastore for self-hosters), self-hostable to match the open-source
story, TypeScript SDK, and durable workflows fit the eval/automation roadmap.

The worker is wired in `src/scheduling/hatchet.ts`, started at boot but
**off unless `HATCHET_CLIENT_TOKEN` is set** — so a plain deploy and the e2e
suite are unaffected (retention still sweeps once at boot). When a token is
present it registers cron workflows that call the same job functions the app
already runs on demand (retention today; automation schedules next, keyed on
the tested `cronMatches`). Bring the engine up with `docker compose --profile
hatchet up`. Do not reach for node-cron/BullMQ/ad-hoc setIntervals.

## Testing

End-to-end coverage is mandatory for the core journey. `packages/e2e` runs
Playwright against a fresh database, the production server build, and a mock
OpenAI-compatible streaming endpoint (no external API keys needed). Tests
assert three layers: what the UI shows, what rows landed in the database, and
that the server log is error-free. CI runs the suite on every push/PR.

## Gating semantics

Gating suites run at write time: a behavior-affecting change to an agent
(name, description, instructions, tone, model) executes every gating
suite's cases against the *candidate* configuration before anything
persists. Any failing case blocks the save with the failure details and an
`eval.gate.block` audit row; a pass is audited too. If gating suites with
cases exist but the agent has no runnable model, the save is refused
rather than silently ungated. Gate runs execute inline in the PATCH for
now — moving them to Hatchet jobs (with re-check-then-commit) is the
planned follow-up when the scheduler lands.

## Surfaces (Slack v1)

Inbound delivery uses Slack's Events API with the standard v0 HMAC signing
scheme; the signing secret lives encrypted on the connection. One Slack
thread maps to one session (`sessions.surface_key`); the platform user is
resolved by the Slack profile email, and strangers get a refusal instead
of a session. Unattended surfaces cannot host approval prompts, so
user-auth tools auto-deny with a pointer to the web app (the org approval
floor is honored). Redeliveries are deduped by event id and retry header.

## Sub-agent delegation

Agents linked on the "Agents" tab (`agent_links`, gated on `use` of the
target) are exposed to the model as governed tools (`ask_<slug>`). A call
runs the child as a **real, persisted, judged session** (surface
`Delegated by <parent>`) via the same `executeTurnAndPersist` used by every
surface — under the SAME user, so the child's model, MCP tools, and auth
gates apply and governance composes. Delegated work therefore lands on the
child's own track record and stays auditable; the tool call carries
`childSessionId` for click-through, and each call audits `agent.delegate`.
Depth and cycles are bounded by a `delegationChain` threaded through
`executeTurn` (a child already on the stack is never offered, so A→B→A
can't loop). Nested turns are non-interactive — a delegated child has no
surface to host an approval, so user-auth tools there auto-deny, same as
any unattended surface.

## Cost accounting

Models carry optional USD prices per million tokens (catalog defaults for
built-ins, user-entered for custom). Agent messages snapshot the model
that produced them, so spend is priced at the model used at the time, not
the agent's current model; unpriced models contribute $0 and the UI says
so. Spend is derived at query time — no materialized ledger yet.

## Retention

`retentionDays` is enforced by deleting sessions whose last activity is
older than the window: once at server boot and on demand from Settings
(audited with the removed count). The recurring sweep becomes a Hatchet
job when the scheduler lands — per the scheduling decision, no interim
cron.
