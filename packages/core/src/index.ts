import { z } from "zod";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const userRoleSchema = z.enum(["owner", "admin", "member"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  role: userRoleSchema,
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const orgSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  createdAt: z.string(),
});
export type Org = z.infer<typeof orgSchema>;

// ---------------------------------------------------------------------------
// Setup & auth
// ---------------------------------------------------------------------------

export const setupStatusSchema = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupRequestSchema = z.object({
  orgName: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Wire protocol used to talk to the model endpoint. */
export const modelProtocolSchema = z.enum(["anthropic", "openai"]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

export const modelKindSchema = z.enum(["built-in", "custom"]);
export type ModelKind = z.infer<typeof modelKindSchema>;

/** An entry in the curated built-in model catalog (ships with the platform). */
export const catalogModelSchema = z.object({
  catalogId: z.string(),
  displayName: z.string(),
  protocol: modelProtocolSchema,
  provider: z.string(),
  modelId: z.string(),
  description: z.string(),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

/** A model registered in an org (built-in catalog entry enabled, or custom). */
export const modelSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: modelKindSchema,
  /** Set when kind = "built-in": which catalog entry this is. */
  catalogId: z.string().nullable(),
  displayName: z.string(),
  protocol: modelProtocolSchema,
  /** Custom models may point at any Anthropic/OpenAI-compatible endpoint or gateway. */
  baseUrl: z.string().nullable(),
  modelId: z.string(),
  /** Whether a usable API key is configured (the key itself is never returned). */
  hasKey: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type Model = z.infer<typeof modelSchema>;

export const createCustomModelSchema = z.object({
  displayName: z.string().min(1).max(120),
  protocol: modelProtocolSchema,
  baseUrl: z.string().url().nullable().optional(),
  modelId: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(500),
});
export type CreateCustomModelRequest = z.infer<typeof createCustomModelSchema>;

export const enableBuiltInModelSchema = z.object({
  catalogId: z.string().min(1),
});
export type EnableBuiltInModelRequest = z.infer<typeof enableBuiltInModelSchema>;

export const setProviderKeySchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).max(500),
});
export type SetProviderKeyRequest = z.infer<typeof setProviderKeySchema>;

export const providerKeyStatusSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  /** True when the key comes from a server environment variable rather than the DB. */
  fromEnv: z.boolean(),
});
export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const agentStatusSchema = z.enum(["active", "draft"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  /** Internal identifier, e.g. "eng-oncall". Display always uses `name`. */
  slug: z.string(),
  /** Natural-cased display name, e.g. "Eng On-Call". */
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  modelId: z.string().uuid().nullable(),
  status: agentStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  instructions: z.string().max(20000).default(""),
  modelId: z.string().uuid().nullable().optional(),
  status: agentStatusSchema.default("draft"),
});
export type CreateAgentRequest = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(20000).optional(),
  modelId: z.string().uuid().nullable().optional(),
  status: agentStatusSchema.optional(),
});
export type UpdateAgentRequest = z.infer<typeof updateAgentSchema>;

// ---------------------------------------------------------------------------
// Sessions & messages
// ---------------------------------------------------------------------------

export const messageRoleSchema = z.enum(["user", "agent"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * A tool invocation recorded on an agent message. No tools ship in the
 * current slice; the shape exists so transcripts are forward-compatible.
 */
export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  /** "service" or "user" — which credential the call ran under. */
  authType: z.enum(["service", "user"]).nullable(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: messageRoleSchema,
  content: z.string(),
  toolCalls: z.array(toolCallSchema),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const sessionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionWithAgentSchema = sessionSchema.extend({
  agentName: z.string(),
  agentSlug: z.string(),
});
export type SessionWithAgent = z.infer<typeof sessionWithAgentSchema>;

export const createSessionSchema = z.object({
  /** Omit (or null) for "Auto" — the server resolves to an active agent. */
  agentId: z.string().uuid().nullable().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionSchema>;

export const postMessageSchema = z.object({
  content: z.string().min(1).max(100000),
});
export type PostMessageRequest = z.infer<typeof postMessageSchema>;

// ---------------------------------------------------------------------------
// Streaming (SSE events emitted while an agent turn runs)
// ---------------------------------------------------------------------------

export const streamEventSchema = z.discriminatedUnion("type", [
  /** The persisted user message, echoed back first. */
  z.object({ type: z.literal("user-message"), message: messageSchema }),
  /** Incremental agent text. */
  z.object({ type: z.literal("delta"), text: z.string() }),
  /** The completed, persisted agent message. */
  z.object({ type: z.literal("done"), message: messageSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive an internal slug from a natural-cased display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
