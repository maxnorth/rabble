/**
 * Executes one agent turn: resolves the agent's model and credentials, builds
 * the conversation, and streams text deltas from the provider. Tool calling,
 * approvals, and evals will attach here as the runtime grows.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providerKeys, type agents, type messages, type models } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { env } from "../env.js";
import { streamCompletion, type ChatTurn } from "../models/providers.js";
import { getCatalogModel } from "../models/catalog.js";

interface AgentTurnInput {
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect | undefined;
  history: Array<typeof messages.$inferSelect>;
  userContent: string;
}

async function resolveApiKey(
  model: typeof models.$inferSelect,
): Promise<string> {
  // Custom models carry their own key.
  if (model.encryptedKey) return decryptSecret(model.encryptedKey);

  // Built-in models use the org-level provider key, falling back to the
  // server environment.
  const provider = model.catalogId
    ? (getCatalogModel(model.catalogId)?.provider ?? "anthropic")
    : "anthropic";
  const [row] = await db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.orgId, model.orgId),
        eq(providerKeys.provider, provider),
      ),
    )
    .limit(1);
  if (row) return decryptSecret(row.encryptedKey);
  if (provider === "anthropic" && env.anthropicApiKey) return env.anthropicApiKey;
  throw new Error(
    `No API key configured for provider "${provider}". Add one in Admin > Models.`,
  );
}

function buildSystemPrompt(agent: typeof agents.$inferSelect): string {
  const parts = [
    `You are ${agent.name}, an agent operating inside Rabble, your organization's agent platform.`,
  ];
  if (agent.description) parts.push(`Your role: ${agent.description}`);
  if (agent.instructions) parts.push(agent.instructions);
  return parts.join("\n\n");
}

export async function* runAgentTurn(
  input: AgentTurnInput,
): AsyncGenerator<string> {
  if (!input.model) {
    throw new Error(
      `Agent "${input.agent.name}" has no model configured. Pick one on the agent's identity tab.`,
    );
  }
  if (!input.model.enabled) {
    throw new Error(`Model "${input.model.displayName}" is disabled.`);
  }

  const apiKey = await resolveApiKey(input.model);
  const turns: ChatTurn[] = [
    ...input.history.map(
      (m): ChatTurn => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }),
    ),
    { role: "user", content: input.userContent },
  ];

  yield* streamCompletion(input.model.protocol, {
    system: buildSystemPrompt(input.agent),
    turns,
    modelId: input.model.modelId,
    apiKey,
    baseUrl: input.model.baseUrl,
  });
}
