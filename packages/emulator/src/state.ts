/**
 * In-memory emulator state: scriptable behaviors set through the admin API,
 * plus a log of every request the fakes receive so tests can assert on
 * outbound traffic.
 */

export interface ScriptedReply {
  /**
   * "text" answers with content; "tool_call" asks the caller to run a
   * tool; "error" fails the API call (status + message) to script outages.
   */
  type: "text" | "tool_call" | "error";
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status?: number;
  message?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** Canned result text; defaults to echoing the arguments as JSON. */
  result?: string;
}

export interface LoggedRequest {
  ts: string;
  host: string;
  method: string;
  path: string;
  body: unknown;
}

/** A connected Socket Mode client (the ws socket, structurally typed). */
export interface SlackSocketClient {
  send: (data: string) => void;
}

export interface SlackSocketLogEntry {
  ts: string;
  direction: "sent" | "ack";
  envelopeId: string;
  type?: string;
}

interface EmulatorState {
  llmQueue: ScriptedReply[];
  mcpServers: Map<string, McpToolDef[]>;
  requests: LoggedRequest[];
  /** Slack workspace directory: user id -> email, channel id -> name. */
  slackUsers: Map<string, string>;
  slackChannels: Map<string, string>;
  /** Live Socket Mode connections + a log of envelopes sent and acks seen. */
  slackSockets: Set<SlackSocketClient>;
  slackSocketLog: SlackSocketLogEntry[];
}

export const state: EmulatorState = {
  llmQueue: [],
  mcpServers: new Map(),
  requests: [],
  slackUsers: new Map(),
  slackChannels: new Map(),
  slackSockets: new Set(),
  slackSocketLog: [],
};

export function reset(): void {
  state.llmQueue = [];
  state.mcpServers = new Map();
  state.requests = [];
  state.slackUsers = new Map();
  state.slackChannels = new Map();
  // Live sockets survive a reset — the server under test stays connected;
  // only the envelope/ack history is wiped.
  state.slackSocketLog = [];
  seedDefaults();
}

/** Sensible defaults so flows work without per-test setup. */
export function seedDefaults(): void {
  state.mcpServers.set("github", [
    {
      name: "search_repos",
      description: "Search repositories in the org",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      result: JSON.stringify({
        repos: [{ name: "acme/api", stars: 42 }, { name: "acme/web", stars: 17 }],
      }),
    },
    {
      name: "create_issue",
      description: "Create an issue (acts as the calling user)",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"],
      },
      result: JSON.stringify({ issue: { number: 101, url: "https://github.acme/issues/101" } }),
    },
  ]);
  state.mcpServers.set("datadog", [
    {
      name: "query_metrics",
      description: "Query a metric timeseries",
      inputSchema: {
        type: "object",
        properties: { metric: { type: "string" } },
        required: ["metric"],
      },
      result: JSON.stringify({ series: [1, 2, 3] }),
    },
  ]);
}

export function logRequest(host: string, method: string, path: string, body: unknown): void {
  state.requests.push({
    ts: new Date().toISOString(),
    host,
    method,
    path,
    body,
  });
  if (state.requests.length > 2000) state.requests.shift();
}

/**
 * Pop the next scripted LLM reply, or synthesize a default: echo the last
 * user message, with a couple of content-aware conventions that keep
 * higher-level flows (eval judging) deterministic without scripting.
 */
export function nextLlmReply(lastUserText: string, fullPromptText: string): ScriptedReply {
  const scripted = state.llmQueue.shift();
  if (scripted) return scripted;
  if (/respond with exactly PASS or FAIL/i.test(fullPromptText)) {
    return { type: "text", text: "PASS" };
  }
  return { type: "text", text: `Mock reply to: ${lastUserText}` };
}

seedDefaults();
