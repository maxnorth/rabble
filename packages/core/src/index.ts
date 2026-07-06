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
  domainId: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(),
  capabilities: z.record(z.unknown()),
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
  domainId: z.string().uuid().nullable().optional(),
  capabilities: z.record(z.unknown()).optional(),
  status: agentStatusSchema.optional(),
});
export type UpdateAgentRequest = z.infer<typeof updateAgentSchema>;

// ---------------------------------------------------------------------------
// Sessions & messages
// ---------------------------------------------------------------------------

export const messageRoleSchema = z.enum(["user", "agent"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/** How a user-auth tool call was resolved. */
export const approvalOutcomeSchema = z.object({
  status: z.enum([
    "approved",
    "denied",
    "ran-as-service",
    "auto-approved",
    "timed-out",
  ]),
  decidedByName: z.string().nullable(),
});
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;

/** A tool invocation recorded on an agent message. */
export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Which MCP server (or built-in surface) served the call. */
  serverName: z.string().nullable().optional(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  /** "service" or "user" — which credential the call ran under. */
  authType: z.enum(["service", "user"]).nullable(),
  approval: approvalOutcomeSchema.nullable().optional(),
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
  /** A tool call started (input known, output pending). */
  z.object({ type: z.literal("tool-start"), toolCall: toolCallSchema }),
  /** A tool call finished (output + approval outcome present). */
  z.object({ type: z.literal("tool-end"), toolCall: toolCallSchema }),
  /** A user-auth tool needs an in-thread decision before it can run. */
  z.object({
    type: z.literal("approval-request"),
    approvalId: z.string(),
    toolName: z.string(),
    serverName: z.string().nullable(),
    input: z.unknown(),
  }),
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

// ---------------------------------------------------------------------------
// Governance: teams, domains, grants
// ---------------------------------------------------------------------------

export const accessRightSchema = z.enum(["use", "edit", "admin"]);
export type AccessRight = z.infer<typeof accessRightSchema>;

export const RIGHT_ORDER: Record<AccessRight, number> = {
  use: 1,
  edit: 2,
  admin: 3,
};

export const teamSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  parentTeamId: z.string().uuid().nullable(),
  slug: z.string(),
  name: z.string(),
  isEveryone: z.boolean(),
  memberCount: z.number().int(),
  createdAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamMemberSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const createTeamSchema = z.object({
  name: z.string().min(1).max(120),
  parentTeamId: z.string().uuid().nullable().optional(),
});
export type CreateTeamRequest = z.infer<typeof createTeamSchema>;

export const domainSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  agentCount: z.number().int(),
  createdAt: z.string(),
});
export type Domain = z.infer<typeof domainSchema>;

export const createDomainSchema = z.object({
  name: z.string().min(1).max(60),
});
export type CreateDomainRequest = z.infer<typeof createDomainSchema>;

export const grantSchema = z.object({
  id: z.string().uuid(),
  subjectType: z.enum(["user", "team"]),
  subjectId: z.string().uuid(),
  subjectName: z.string(),
  accessRight: accessRightSchema,
  targetType: z.enum(["agent", "domain"]),
  targetId: z.string().uuid(),
  targetName: z.string(),
  /** Present when the grant reaches an agent through its domain. */
  viaDomain: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;

export const createGrantSchema = z.object({
  subjectType: z.enum(["user", "team"]),
  subjectId: z.string().uuid(),
  accessRight: accessRightSchema,
  targetType: z.enum(["agent", "domain"]),
  targetId: z.string().uuid(),
});
export type CreateGrantRequest = z.infer<typeof createGrantSchema>;

// ---------------------------------------------------------------------------
// MCP servers & per-agent tools
// ---------------------------------------------------------------------------

export const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()).optional(),
});
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

export const mcpServerSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  category: z.string(),
  hasToken: z.boolean(),
  tools: z.array(mcpToolInfoSchema),
  status: z.enum(["connected", "error"]),
  usedByCount: z.number().int(),
  createdAt: z.string(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  category: z.string().min(1).max(40).default("Tools"),
  token: z.string().max(500).optional(),
});
export type CreateMcpServerRequest = z.infer<typeof createMcpServerSchema>;

export const agentToolConfigSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  toolName: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  authType: z.enum(["service", "user"]),
});
export type AgentToolConfig = z.infer<typeof agentToolConfigSchema>;

export const updateToolConfigSchema = z.object({
  serverId: z.string().uuid(),
  toolName: z.string(),
  enabled: z.boolean().optional(),
  authType: z.enum(["service", "user"]).optional(),
});
export type UpdateToolConfigRequest = z.infer<typeof updateToolConfigSchema>;

// ---------------------------------------------------------------------------
// Agent capabilities & automations
// ---------------------------------------------------------------------------

export const agentCapabilitiesSchema = z.object({
  codeSandbox: z.boolean().default(false),
  codeExecution: z.boolean().default(false),
  pullRequestAccess: z.boolean().default(false),
  outboundWebAccess: z.boolean().default(false),
  networkAllowlist: z.string().default(""),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const automationSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type Automation = z.infer<typeof automationSchema>;

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(120),
  schedule: z.string().min(1).max(100),
  prompt: z.string().max(10000).default(""),
});
export type CreateAutomationRequest = z.infer<typeof createAutomationSchema>;

// ---------------------------------------------------------------------------
// Admin: connections, API keys, audit
// ---------------------------------------------------------------------------

export const connectionRoleSchema = z.enum(["Interface", "Automation", "Tools"]);
export type ConnectionRole = z.infer<typeof connectionRoleSchema>;

export const connectionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  vendor: z.string(),
  name: z.string(),
  roles: z.array(connectionRoleSchema),
  baseUrl: z.string().nullable(),
  hasToken: z.boolean(),
  status: z.enum(["connected", "needs-auth", "error"]),
  createdAt: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const createConnectionSchema = z.object({
  vendor: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  roles: z.array(connectionRoleSchema).min(1),
  baseUrl: z.string().url().nullable().optional(),
  token: z.string().max(500).optional(),
});
export type CreateConnectionRequest = z.infer<typeof createConnectionSchema>;

export const apiKeyScopeSchema = z.enum(["read", "write", "admin"]);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scope: apiKeyScopeSchema,
  prefix: z.string(),
  createdByName: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  scope: apiKeyScopeSchema,
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeySchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export const evalCriterionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  passRate: z.number().nullable(),
  sessionCount: z.number().int(),
  createdAt: z.string(),
});
export type EvalCriterion = z.infer<typeof evalCriterionSchema>;

export const createEvalCriterionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
});
export type CreateEvalCriterionRequest = z.infer<typeof createEvalCriterionSchema>;

export const sessionEvalResultSchema = z.object({
  criterionId: z.string().uuid(),
  criterionName: z.string(),
  passed: z.boolean(),
  reasoning: z.string(),
});
export type SessionEvalResult = z.infer<typeof sessionEvalResultSchema>;

export const evalSuiteSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string(),
  gating: z.boolean(),
  caseCount: z.number().int(),
  lastRun: z
    .object({
      id: z.string().uuid(),
      status: z.enum(["running", "completed", "failed"]),
      passed: z.number().int(),
      total: z.number().int(),
      startedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export const evalCaseSchema = z.object({
  id: z.string().uuid(),
  suiteId: z.string().uuid(),
  name: z.string(),
  input: z.string(),
  rubric: z.string(),
  sourceSessionId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const createEvalCaseSchema = z.object({
  name: z.string().min(1).max(200),
  input: z.string().min(1).max(20000),
  rubric: z.string().min(1).max(5000),
});
export type CreateEvalCaseRequest = z.infer<typeof createEvalCaseSchema>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const userPreferencesSchema = z.object({
  /** "ask" surfaces the approval card; "auto" approves user-auth tools. */
  approvalPosture: z.enum(["ask", "auto"]).default("ask"),
  responseStyle: z.enum(["concise", "balanced", "detailed"]).default("balanced"),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const connectedAccountSchema = z.object({
  id: z.string().uuid(),
  vendor: z.string(),
  label: z.string(),
  createdAt: z.string(),
});
export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;

// ---------------------------------------------------------------------------
// Composed views (declared last: they reference schemas defined above)
// ---------------------------------------------------------------------------

/** Directory listing row: agent plus the trust-surface columns. */
export const agentDirectoryRowSchema = agentSchema.extend({
  domainName: z.string().nullable(),
  evalScore: z.number().nullable(),
  toolCount: z.number().int(),
  starred: z.boolean(),
  /** The caller's effective right on this agent (null = none). */
  myRight: accessRightSchema.nullable(),
});
export type AgentDirectoryRow = z.infer<typeof agentDirectoryRowSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny", "run-as-service"]),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionSchema>;
