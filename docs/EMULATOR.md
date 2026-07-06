# The emulator

`packages/emulator` is a single Fastify app (`:4100`) that fakes every
external service Rabble talks to, speaking each service's **real wire
protocol**. The app under test never knows it's fake — only base URLs
differ (an agent's model points at
`http://localhost:4100/mock/api.openai.com/v1` instead of the real host).
No `if test_mode` branches exist in app code; keep it that way.

## Mounted fakes

| Path | Protocol |
|---|---|
| `/mock/api.anthropic.com/v1/messages` | Anthropic Messages API incl. SSE event framing (`message_start` → `content_block_delta` → `message_delta` with usage) |
| `/mock/api.openai.com/v1/chat/completions` | OpenAI chat completions incl. streamed chunks, tool_calls deltas, and the `stream_options.include_usage` final usage chunk |
| `/mock/mcp/:serverKey` | MCP JSON-RPC (`tools/list`, `tools/call`) |
| `/mock/slack.com/api/*` | `auth.test`, `chat.postMessage`, `users.info`, `conversations.info`, `apps.connections.open` (hands out the ws URL below) |
| `/mock/slack.com/socket` | Socket Mode WebSocket — sends `hello` on connect, records acks by `envelope_id` |

## Scripting (admin endpoints)

| Endpoint | Effect |
|---|---|
| `POST /admin/reset` | wipe state, re-seed default MCP tools |
| `GET /admin/requests?host=…` | every request a fake received (assert outbound traffic) |
| `POST /admin/llm/enqueue` | queue the next LLM reply: `{type:"text", text}` or `{type:"tool_call", toolName, toolArgs}`; accepts an array |
| `PUT /admin/mcp/:serverKey` | replace an MCP server's tool catalog |
| `PUT /admin/slack` | teach the workspace directory: `{users:{U1:"a@b.c"}, channels:{C1:"eng-oncall"}}` |
| `POST /admin/slack/socket-event` | push a Socket Mode event to connected sockets: `{event:{type:"message",channel,user,text,ts}, eventId?}` (wrapped in an `events_api` envelope; returns `delivered` + `envelopeId`) |
| `POST /admin/slack/socket-interaction` | push an interactivity payload as an `interactive` envelope: `{payload:{…block_actions…}}` |
| `GET /admin/slack/socket` | live socket count + the sent/ack envelope log |

## Default conventions (unscripted behavior)

- Any model call echoes the last user message: `Mock reply to: <text>` —
  so tests assert turn-specific replies without scripting.
- A prompt containing "Respond with exactly PASS or FAIL" gets `PASS` —
  live judging and suite runs go green by default; enqueue a `FAIL`
  reply to script a regression (each gate/judge call consumes one
  queued item, so count your calls: one per case execution, one per
  judge verdict).

## Writing a test against it

1. Script what the next model call should do (`/admin/llm/enqueue`).
2. Drive the UI (or POST a signed Slack event) — the app calls the fakes.
3. Assert three layers: the UI, the database rows, and
   `/admin/requests` for what actually left the app.

The e2e suite boots the emulator from `dist/` — rebuild
(`pnpm build`) after emulator changes, and never leave a stale process
on `:4100` (global-setup refuses to run if the port is taken).
