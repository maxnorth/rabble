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
import { domains, models, type agents } from "../db/schema.js";
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
