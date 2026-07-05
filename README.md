# Rabble

An open-source platform where a whole organization uses AI agents — and a
flexible subset of people create, configure, and govern them. Think "GitHub
for agents": agents as governed org citizens with identities, scoped access,
measured track records, and full auditability.

> Early development. The current milestone is a vertical slice: set up an
> owner account, register a model, create an agent, and chat with it in a
> streaming session UI.

## Architecture

TypeScript monorepo (pnpm workspaces + Turborepo):

| Package | What it is |
|---|---|
| `packages/core` | Shared domain types and Zod schemas (the API contract between server and web) |
| `packages/server` | Fastify API + agent runtime: auth, agents, model registry, sessions with SSE streaming, Drizzle ORM on Postgres |
| `packages/web` | React (Vite) app: session experience + management surface |

Everything is keyed by `org_id` from day one. The open-source version runs a
single default org; the same schema supports multi-tenant hosting later.

## Getting started

Prereqs: Node 20+, pnpm, and Postgres (or Docker).

```bash
# 1. Start Postgres
docker compose up -d postgres

# 2. Configure
cp .env.example .env   # edit COOKIE_SECRET (and optionally ANTHROPIC_API_KEY)

# 3. Install, migrate, run
pnpm install
pnpm db:migrate
pnpm dev
```

The web app runs at http://localhost:5173 (dev) and proxies API calls to the
server at http://localhost:3080. On first boot you'll be walked through
creating the owner account.

## Models

Rabble's model registry distinguishes two kinds of models:

- **Built-in** — a curated catalog (Claude models today). Configure a
  provider API key once in Admin → Models and every built-in model works.
- **Custom** — bring your own: pick the protocol (Anthropic- or
  OpenAI-compatible), a base URL (direct provider or any gateway), a model
  id, and a key. Register as many as you like.

## Development

```bash
pnpm dev        # server (tsx watch) + web (vite) in parallel
pnpm build      # build all packages
pnpm typecheck  # typecheck all packages
```

Product context and design decisions live in [`docs/`](docs/).
