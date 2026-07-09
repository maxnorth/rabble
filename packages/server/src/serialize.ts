import type { Agent, Message, Model, Session, ToolCall, User } from "@rabblehq/core";
import type {
  agents,
  messages,
  models,
  sessions,
  users,
} from "./db/schema.js";

export function serializeUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeModel(row: typeof models.$inferSelect): Model {
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    catalogId: row.catalogId,
    displayName: row.displayName,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    hasKey: row.encryptedKey !== null,
    priceInputPerMtok: row.priceInputPerMtok !== null ? Number(row.priceInputPerMtok) : null,
    priceOutputPerMtok:
      row.priceOutputPerMtok !== null ? Number(row.priceOutputPerMtok) : null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    modelId: row.modelId,
    domainId: row.domainId,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
    icon: row.icon,
    color: row.color,
    tone: row.tone,
    status: row.status,
    webEnabled: row.webEnabled,
    builtin: row.builtin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    agentId: row.agentId,
    title: row.title,
    surface: row.surface,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeMessage(
  row: typeof messages.$inferSelect,
): Omit<Message, "authorName"> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    toolCalls: (row.toolCalls ?? []) as ToolCall[],
    createdAt: row.createdAt.toISOString(),
  };
}
