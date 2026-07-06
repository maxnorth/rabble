/**
 * Shared construction of LangChain chat models from Rabble's model registry:
 * credential resolution (custom key -> org provider key -> server env) and
 * protocol/base-URL wiring.
 */
import { and, eq } from "drizzle-orm";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { db } from "../db/client.js";
import { providerKeys, type models } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { env } from "../env.js";
import { getCatalogModel } from "./catalog.js";

export async function resolveApiKey(
  model: typeof models.$inferSelect,
): Promise<string> {
  if (model.encryptedKey) return decryptSecret(model.encryptedKey);
  const provider = model.catalogId
    ? (getCatalogModel(model.catalogId)?.provider ?? "anthropic")
    : "anthropic";
  const [row] = await db
    .select()
    .from(providerKeys)
    .where(
      and(eq(providerKeys.orgId, model.orgId), eq(providerKeys.provider, provider)),
    )
    .limit(1);
  if (row) return decryptSecret(row.encryptedKey);
  if (provider === "anthropic" && env.anthropicApiKey) return env.anthropicApiKey;
  throw new Error(
    `No API key configured for provider "${provider}". Add one in Admin > Models.`,
  );
}

export function buildChatModel(
  model: typeof models.$inferSelect,
  apiKey: string,
): BaseChatModel {
  if (model.protocol === "anthropic") {
    return new ChatAnthropic({
      model: model.modelId,
      apiKey,
      maxTokens: 4096,
      ...(model.baseUrl ? { anthropicApiUrl: model.baseUrl } : {}),
    });
  }
  return new ChatOpenAI({
    model: model.modelId,
    apiKey,
    configuration: model.baseUrl ? { baseURL: model.baseUrl } : undefined,
  });
}

export async function chatModelFor(
  model: typeof models.$inferSelect,
): Promise<BaseChatModel> {
  return buildChatModel(model, await resolveApiKey(model));
}
