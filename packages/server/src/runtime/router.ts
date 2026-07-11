/**
 * Intent routing for "Auto" sessions: given the user's first message and the
 * agents they can use, ask the org's default model which agent fits best.
 * Falls back to the first candidate (stable name order) when there's no
 * intent, no usable model, or an unparseable verdict — Auto must never fail
 * where a direct pick would have worked.
 */
import { and, eq } from "drizzle-orm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../db/client.js";
import { agents, domains, models } from "../db/schema.js";
import { chatModelFor } from "../models/chat.js";

export interface RouteCandidate {
  id: string;
  slug: string;
  name: string;
  description: string;
  domainName?: string | null;
}

/**
 * Find which candidate a router reply refers to. Matches slugs first (as
 * standalone tokens), then display names; null when nothing matches.
 */
export function matchAgentReply(
  reply: string,
  candidates: RouteCandidate[],
): RouteCandidate | null {
  const normalized = reply.toLowerCase();
  for (const candidate of candidates) {
    const slugPattern = new RegExp(
      `(^|[^a-z0-9-])${candidate.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`,
    );
    if (slugPattern.test(normalized)) return candidate;
  }
  for (const candidate of candidates) {
    if (normalized.includes(candidate.name.toLowerCase())) return candidate;
  }
  return null;
}

const ROUTER_SYSTEM =
  "You route incoming requests to the best-suited agent on an agent platform. " +
  "Weigh each agent's description against what the user actually wants — " +
  "never pick an agent whose job doesn't cover the request just because " +
  "nothing fits perfectly. Requests to create, configure, edit, or improve " +
  "AGENTS THEMSELVES (\"build me an agent\", \"change how X responds\") " +
  "belong to the platform's builder when it is on the roster. " +
  "Reply with exactly one agent slug from the roster — nothing else.";

export function buildRouterPrompt(
  intent: string,
  candidates: RouteCandidate[],
): string {
  const roster = candidates
    .map(
      (c) =>
        `- ${c.slug} — ${c.name}${c.domainName ? ` (domain: ${c.domainName})` : ""}: ${c.description || "no description"}`,
    )
    .join("\n");
  return `The user's request:\n${intent.slice(0, 2000)}\n\nAgent roster:\n${roster}\n\nReply with exactly one agent slug from the roster.`;
}

/** Pick an agent for an Auto session. Never throws; always returns a candidate. */
export async function routeByIntent(
  orgId: string,
  intent: string | undefined,
  candidateRows: Array<typeof agents.$inferSelect>,
): Promise<string> {
  const candidates: RouteCandidate[] = [];
  const domainRows = await db.select().from(domains).where(eq(domains.orgId, orgId));
  const domainName = new Map(domainRows.map((d) => [d.id, d.name]));
  for (const row of candidateRows) {
    candidates.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      domainName: row.domainId ? (domainName.get(row.domainId) ?? null) : null,
    });
  }

  const fallback = candidates[0]!;
  if (candidates.length === 1 || !intent?.trim()) return fallback.id;

  const [routerModel] = await db
    .select()
    .from(models)
    .where(and(eq(models.orgId, orgId), eq(models.enabled, true)))
    .orderBy(models.createdAt)
    .limit(1);
  if (!routerModel) return fallback.id;

  try {
    const chat = await chatModelFor(routerModel);
    const reply = await chat.invoke([
      new SystemMessage(ROUTER_SYSTEM),
      new HumanMessage(buildRouterPrompt(intent, candidates)),
    ]);
    const text =
      typeof reply.content === "string"
        ? reply.content
        : reply.content
            .map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? "")))
            .join("");
    return matchAgentReply(text, candidates)?.id ?? fallback.id;
  } catch {
    return fallback.id;
  }
}

/**
 * The Auto roster, shared by web Auto sessions and the primary Slack
 * connection: the usable regular agents in stable name order, plus the
 * Builder LAST — "build me an agent that…" must be intent-routable, while
 * Builder-last keeps the no-intent fallback on a working agent (and makes
 * the Builder the answer of last resort when nothing else exists).
 */
export function orderAutoRoster<T extends { builtin: string | null }>(
  usable: T[],
): T[] {
  return [
    ...usable.filter((r) => !r.builtin),
    ...usable.filter((r) => r.builtin === "builder"),
  ];
}

/**
 * Route a message arriving on the org's PRIMARY connection — Rabble's own
 * front door, not any single agent's identity. Same roster policy as web
 * Auto (orderAutoRoster), minus the web-enabled filter: Slack reachability
 * doesn't depend on an agent being offered in web sessions.
 */
export async function routePrimaryInterface(
  platformUser: { id: string; orgId: string; role: string },
  intent: string,
): Promise<typeof agents.$inferSelect | null> {
  const { rightsForAllAgents, hasRight } = await import("../rights.js");
  const rights = await rightsForAllAgents(platformUser as never);
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.orgId, platformUser.orgId), eq(agents.status, "active")),
    )
    .orderBy(agents.name);
  const usable = rows.filter((r) => hasRight(rights.get(r.id) ?? null, "use"));
  const candidates = orderAutoRoster(usable);
  if (candidates.length === 0) return null;
  const chosenId = await routeByIntent(platformUser.orgId, intent, candidates);
  return candidates.find((c) => c.id === chosenId) ?? candidates[0]!;
}
