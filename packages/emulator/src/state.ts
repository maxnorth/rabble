/**
 * In-memory emulator state: scriptable behaviors set through the admin API,
 * plus a log of every request the fakes receive so tests can assert on
 * outbound traffic.
 */

export interface ScriptedReply {
  /** "text" answers with content; "tool_call" asks the caller to run a tool. */
  type: "text" | "tool_call";
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
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

interface EmulatorState {
  llmQueue: ScriptedReply[];
  mcpServers: Map<string, McpToolDef[]>;
  requests: LoggedRequest[];
}

export const state: EmulatorState = {
  llmQueue: [],
  mcpServers: new Map(),
  requests: [],
};

export function reset(): void {
  state.llmQueue = [];
  state.mcpServers = new Map();
  state.requests = [];
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
