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
touching routes, schema, or UI. Keep SDK types out of `@rabble/core` and out
of API contracts.

## Scheduling & background work

**Hatchet** (hatchet.dev) is the designated engine for all scheduling and
background work — automations, scheduled agent runs, eval suite executions,
digests/alerts, and any queue-shaped workload. Rationale: Postgres-backed (no
new datastore for self-hosters), self-hostable to match the open-source
story, TypeScript SDK, and durable workflows fit the eval/automation roadmap.

Nothing in the current slice schedules work yet; the first feature that does
(automations or eval runs) introduces the Hatchet worker alongside the API
server. Do not reach for node-cron/BullMQ/ad-hoc setIntervals.

## Testing

End-to-end coverage is mandatory for the core journey. `packages/e2e` runs
Playwright against a fresh database, the production server build, and a mock
OpenAI-compatible streaming endpoint (no external API keys needed). Tests
assert three layers: what the UI shows, what rows landed in the database, and
that the server log is error-free. CI runs the suite on every push/PR.
