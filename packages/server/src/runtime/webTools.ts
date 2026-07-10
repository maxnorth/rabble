/**
 * The governed web-fetch tool. Outbound HTTP is a capability, not a given:
 * an agent may reach the network only when an admin turns on
 * `outboundWebAccess` AND names the hosts it may touch in `networkAllowlist`
 * (the Advanced tab). This is the "bound the risk so forbidden work becomes
 * allowable" thesis made real — the same allowlist the UI edits is the
 * authorization boundary the runtime enforces.
 *
 * Security posture:
 * - Fail closed. No capability, or an empty allowlist, means the tool
 *   refuses every fetch. An agent can never reach a host an admin did not
 *   explicitly name.
 * - The allowlist is the boundary. An exact host (`api.example.com`) or a
 *   subdomain wildcard (`*.example.com`, which does NOT match the apex) is
 *   matched against the URL host — never as a substring, so `evil-example.com`
 *   can't ride in on `example.com`.
 * - Redirects are followed but every hop is re-checked against the allowlist,
 *   so an allowed host can't 302 the agent onto a forbidden one.
 * - Only http/https, a request timeout, and a response-size cap.
 */
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { agentCapabilitiesSchema, type ToolCall } from "@rabblehq/core";
import type { agents } from "../db/schema.js";
import type { AgentTurnEvent } from "./agentTurn.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Split a comma/whitespace-separated allowlist into normalized host patterns.
 * Exported so the parsing is unit-tested independent of a live fetch.
 */
export function parseAllowlist(allowlist: string): string[] {
  return allowlist
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does `host` match one of the allowlist `patterns`? Exact match, or a
 * `*.suffix` wildcard that matches proper subdomains only (never the apex,
 * never a substring). Case-insensitive; `host` is expected pre-lowercased by
 * the URL parser but we lower it again to be safe.
 */
export function hostMatchesAllowlist(host: string, patterns: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === p;
  });
}

/** Reason a URL is not fetchable, or null when it passes the gate. */
export function refusalFor(rawUrl: string, patterns: string[]): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `"${rawUrl}" is not a valid URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http and https URLs may be fetched (got ${url.protocol}).`;
  }
  if (patterns.length === 0) {
    return "This agent has no network allowlist configured, so outbound web access is refused. An admin can add allowed hosts on the agent's Advanced tab.";
  }
  if (!hostMatchesAllowlist(url.hostname, patterns)) {
    return `Host "${url.hostname}" is not in this agent's network allowlist (${patterns.join(", ")}).`;
  }
  return null;
}

/**
 * Build the web tools for an agent: a single `fetch_url` tool when
 * `outboundWebAccess` is on, or nothing at all. When the capability is off
 * the tool is absent entirely, so a model that reaches for it trips the
 * normal scope-violation path.
 */
export function buildWebTools(
  agent: typeof agents.$inferSelect,
  emit: (event: AgentTurnEvent) => void,
) {
  const capabilities = agentCapabilitiesSchema.parse(
    (agent.capabilities ?? {}) as Record<string, unknown>,
  );
  if (!capabilities.outboundWebAccess) return [];
  const patterns = parseAllowlist(capabilities.networkAllowlist);

  const fetchTool = tool(
    async (args: Record<string, unknown>) => {
      const rawUrl = String(args.url ?? "");
      const callId = randomUUID();
      const startedAt = Date.now();
      const call: ToolCall = {
        id: callId,
        name: "fetch_url",
        serverName: "web",
        input: args,
        output: null,
        authType: "service",
        approval: null,
      };
      emit({ type: "tool-start", toolCall: call });

      const finish = (output: string): string => {
        emit({
          type: "tool-end",
          toolCall: { ...call, output, durationMs: Date.now() - startedAt },
        });
        return output;
      };

      // Every hop, including the initial URL, is re-validated against the
      // allowlist so a redirect can't escape it.
      let current = rawUrl;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const refusal = refusalFor(current, patterns);
        if (refusal) return finish(`Refused: ${refusal}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(current, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { "user-agent": "Rabble-Agent/1.0" },
          });
        } catch (err) {
          clearTimeout(timer);
          const message =
            err instanceof Error && err.name === "AbortError"
              ? `Request to ${current} timed out after ${FETCH_TIMEOUT_MS}ms.`
              : `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
          return finish(`Error: ${message}`);
        }
        clearTimeout(timer);

        // Follow a redirect only after its target clears the allowlist on the
        // next loop iteration.
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return finish(`Error: ${res.status} redirect with no Location header.`);
          try {
            current = new URL(location, current).toString();
          } catch {
            return finish(`Error: redirect to invalid URL "${location}".`);
          }
          continue;
        }

        const body = await readCapped(res);
        const status = `${res.status} ${res.statusText}`.trim();
        return finish(`HTTP ${status}\n\n${body}`);
      }
      return finish(`Error: too many redirects (>${MAX_REDIRECTS}).`);
    },
    {
      name: "fetch_url",
      description:
        "Fetch the contents of an http(s) URL over the network. Only hosts in " +
        `this agent's network allowlist (${patterns.length ? patterns.join(", ") : "none configured"}) ` +
        "may be reached; anything else is refused. Runs as the org service account.",
      schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The absolute http(s) URL to fetch." },
        },
        required: ["url"],
      },
    },
  );

  return [fetchTool];
}

/** Read a response body up to the size cap, noting when it was truncated. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) {
        chunks.push(value.slice(0, value.length - (total - MAX_RESPONSE_BYTES)));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${text}\n\n[truncated at ${MAX_RESPONSE_BYTES} bytes]` : text;
}
