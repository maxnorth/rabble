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
  /** Invited with a temp password — must set their own before continuing. */
  mustChangePassword: z.boolean().default(false),
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
  /** USD per 1M tokens — powers the spend dashboards. */
  priceInputPerMtok: z.number().nullable().default(null),
  priceOutputPerMtok: z.number().nullable().default(null),
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
  /** USD per 1M tokens; null = unpriced (excluded from spend figures). */
  priceInputPerMtok: z.number().nullable().default(null),
  priceOutputPerMtok: z.number().nullable().default(null),
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
  priceInputPerMtok: z.number().min(0).nullable().optional(),
  priceOutputPerMtok: z.number().min(0).nullable().optional(),
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
  updatedBy: z.string().uuid().nullable(),
  capabilities: z.record(z.unknown()),
  /** Avatar glyph (e.g. "◈") and accent color name from the design palette. */
  icon: z.string(),
  color: z.string(),
  /** Tone & style guidance, folded into the system prompt. */
  tone: z.string(),
  status: agentStatusSchema,
  /** Reachable from web sessions (the in-app composer). */
  webEnabled: z.boolean().default(true),
  /** First-party agents ("builder"); null for everything user-made. */
  builtin: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

// ---------------------------------------------------------------------------
// Access requests (the Builder's request → notify → approve loop)
// ---------------------------------------------------------------------------

export const accessRequestSchema = z.object({
  id: z.string().uuid(),
  requesterUserId: z.string().uuid(),
  requesterName: z.string(),
  targetType: z.enum(["agent", "domain", "model", "mcp-server"]),
  targetId: z.string().uuid(),
  targetName: z.string(),
  accessRight: z.enum(["use", "edit", "admin"]),
  reason: z.string(),
  via: z.string(),
  status: z.enum(["open", "approved", "denied"]),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  /** Track record of the target agent — evidence for the access decision. */
  evidence: z
    .object({
      passRate30d: z.number().nullable(),
      graded30d: z.number(),
      scopeViolations30d: z.number(),
    })
    .optional(),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export const createAccessRequestSchema = z.object({
  targetType: z.enum(["agent", "domain", "model", "mcp-server"]),
  targetId: z.string().uuid(),
  accessRight: z.enum(["use", "edit", "admin"]),
  reason: z.string().max(1000).optional(),
});
export type CreateAccessRequestRequest = z.infer<typeof createAccessRequestSchema>;

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
  icon: z.string().max(8).optional(),
  color: z.string().max(20).optional(),
  tone: z.string().max(2000).optional(),
  status: agentStatusSchema.optional(),
  webEnabled: z.boolean().optional(),
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
    // Async approvals: the ask is recorded and the turn moves on; the
    // persisted tool call is updated in place when the decision lands.
    "pending",
    "expired",
  ]),
  decidedByName: z.string().nullable(),
  /** Durable ask id — set while pending so the decision can update the
   * persisted call in place. */
  approvalId: z.string().uuid().optional(),
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
  durationMs: z.number().int().nullable().optional(),
  /**
   * For a sub-agent delegation, the id of the child's session — lets the UI
   * link straight from the delegation call to the delegated turn's transcript.
   */
  childSessionId: z.string().uuid().nullable().optional(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: messageRoleSchema,
  /** Display name of the human who wrote a user message (null = unknown/agent). */
  authorName: z.string().nullable().default(null),
  /** The agent that authored this message (multi-party sessions render
   * per-bubble identity from these; null on user rows). */
  agentId: z.string().uuid().nullable().optional(),
  agentName: z.string().nullable().optional(),
  agentIcon: z.string().nullable().optional(),
  agentColor: z.string().nullable().optional(),
  content: z.string(),
  toolCalls: z.array(toolCallSchema),
  /** Set when this agent turn failed; the failure is kept as part of the record. */
  error: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const sessionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  /** NULL = a multi-party "Auto" session: the invisible orchestrator picks
   * who responds to each message (DECISIONS.md). */
  agentId: z.string().uuid().nullable(),
  title: z.string(),
  /** Where the session originates: "Web" or e.g. "Slack #eng-oncall". */
  surface: z.string().default("Web"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionWithAgentSchema = sessionSchema.extend({
  /** Null for Auto sessions — the UI shows "Auto". */
  agentName: z.string().nullable(),
  agentSlug: z.string().nullable(),
  agentIcon: z.string().nullable().default(""),
  agentColor: z.string().nullable().default(""),
});
export type SessionWithAgent = z.infer<typeof sessionWithAgentSchema>;

export const createSessionSchema = z.object({
  /** Omit (or null) for "Auto" — the server resolves to an active agent. */
  agentId: z.string().uuid().nullable().optional(),
  /**
   * The user's first message, used to route "Auto" sessions by intent
   * across the agents the caller can use.
   */
  intent: z.string().max(100000).optional(),
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
  /** A responder begins its turn — multi-party sessions stream several
   * agents' replies to one message; this stamps who is speaking next. */
  z.object({
    type: z.literal("turn-start"),
    agentId: z.string().uuid(),
    agentName: z.string(),
    agentIcon: z.string().default(""),
    agentColor: z.string().default(""),
  }),
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
  /** A personal-credential MCP server needs the user to connect an account. */
  z.object({
    type: z.literal("connect-request"),
    connectId: z.string(),
    serverId: z.string(),
    serverName: z.string(),
    requiresOAuth: z.boolean(),
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
  /** Grants this team holds, by target kind (0 when listing nested shapes). */
  domainGrantCount: z.number().int().default(0),
  agentGrantCount: z.number().int().default(0),
  createdAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamMemberSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
  /** Team-scoped label (lead/member) — descriptive; access comes from grants. */
  teamRole: z.enum(["lead", "member"]).default("member"),
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
  targetType: z.enum(["agent", "domain", "model", "mcp-server"]),
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
  targetType: z.enum(["agent", "domain", "model", "mcp-server"]),
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
  credentialMode: z.enum(["shared", "personal"]),
  requiresOAuth: z.boolean(),
  hasToken: z.boolean(),
  donatedByName: z.string().nullable(),
  tools: z.array(mcpToolInfoSchema),
  /** Tool names switched off at the definition level (org admin). */
  disabledTools: z.array(z.string()).default([]),
  /** Curated library entry this server came from (null = custom). */
  libraryKey: z.string().nullable().default(null),
  /** Whether the caller may attach this server (grants; admins always). */
  canUse: z.boolean().default(true),
  /** How many grants scope this server (0 = org-wide). */
  grantCount: z.number().int().default(0),
  status: z.enum(["connected", "error"]),
  usedByCount: z.number().int(),
  createdAt: z.string(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** A curated, preconfigured MCP server the org can add in one click. */
export const mcpLibraryEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  category: z.string(),
  credentialMode: z.enum(["shared", "personal"]),
  glyph: z.string(),
  brandColor: z.string(),
});
export type McpLibraryEntry = z.infer<typeof mcpLibraryEntrySchema>;

export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  category: z.string().min(1).max(40).default("Tools"),
  credentialMode: z.enum(["shared", "personal"]).default("shared"),
  libraryKey: z.string().max(60).optional(),
  token: z.string().max(500).optional(),
});
export type CreateMcpServerRequest = z.infer<typeof createMcpServerSchema>;

export const agentToolConfigSchema = z.object({
  serverId: z.string().uuid(),
  serverName: z.string(),
  toolName: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  /** Derived from the server's credential mode; kept on the wire for chips. */
  authType: z.enum(["service", "user"]),
});
export type AgentToolConfig = z.infer<typeof agentToolConfigSchema>;

export const updateToolConfigSchema = z.object({
  serverId: z.string().uuid(),
  toolName: z.string(),
  enabled: z.boolean().optional(),
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
  lastRunAt: z.string().nullable().default(null),
  lastSessionId: z.string().uuid().nullable().default(null),
  createdAt: z.string(),
});
export type Automation = z.infer<typeof automationSchema>;

// Standard 5-field cron ranges: minute, hour, day-of-month, month, weekday
// (0 and 7 both mean Sunday). Validated at creation so a typo can't sit
// silently until the scheduler tries to run it.
const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function validCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => {
    const slash = part.indexOf("/");
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const stepPart = slash === -1 ? undefined : part.slice(slash + 1);
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) {
      return false;
    }
    if (rangePart === "*") return true;
    const dash = rangePart.indexOf("-");
    const a = dash === -1 ? rangePart : rangePart.slice(0, dash);
    const b = dash === -1 ? undefined : rangePart.slice(dash + 1);
    if (!/^\d+$/.test(a)) return false;
    const lo = Number(a);
    if (lo < min || lo > max) return false;
    if (b !== undefined) {
      if (!/^\d+$/.test(b)) return false;
      const hi = Number(b);
      if (hi < min || hi > max || hi < lo) return false;
    }
    return true;
  });
}

/** True for a well-formed standard 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => validCronField(f, CRON_RANGES[i]![0], CRON_RANGES[i]![1]));
}

/** Does one already-validated cron field match a numeric time component? */
function cronFieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const slash = part.indexOf("/");
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : Number(part.slice(slash + 1));
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      // Any value; only the step constrains it (relative to 0).
      return step === 1 || value % step === 0;
    }
    const dash = rangePart.indexOf("-");
    lo = Number(dash === -1 ? rangePart : rangePart.slice(0, dash));
    hi = dash === -1 ? lo : Number(rangePart.slice(dash + 1));
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

/**
 * Whether a cron's date fields (month + the day-of-month/day-of-week pair)
 * match `date`. Standard Vixie semantics: when BOTH day fields are
 * restricted, the day matches if EITHER does; if either is `*`, it's a plain
 * AND. Split out so nextCronRun can skip whole non-matching days cheaply.
 */
function cronDayMatches(mon: string, dom: string, dow: string, date: Date): boolean {
  if (!cronFieldMatches(mon, date.getUTCMonth() + 1)) return false;
  const jsDow = date.getUTCDay(); // 0=Sun..6=Sat
  const domMatch = cronFieldMatches(dom, date.getUTCDate());
  const dowMatch =
    cronFieldMatches(dow, jsDow) || (jsDow === 0 && cronFieldMatches(dow, 7));
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * Whether a 5-field cron expression fires at the given instant (minute
 * granularity, UTC). Standard Vixie semantics: when BOTH day-of-month and
 * day-of-week are restricted, the schedule matches if EITHER does; if either
 * is `*`, day matching is a plain AND. Returns false for an invalid cron.
 */
export function cronMatches(expr: string, date: Date): boolean {
  if (!isValidCron(expr)) return false;
  const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!cronFieldMatches(min, date.getUTCMinutes())) return false;
  if (!cronFieldMatches(hr, date.getUTCHours())) return false;
  return cronDayMatches(mon, dom, dow, date);
}

/**
 * The next UTC instant strictly after `after` at which the cron fires, or
 * null for an invalid cron or one that never runs within a ~4-year horizon
 * (e.g. a Feb-30 schedule). Walks day-by-day using cronDayMatches — cheap
 * enough to call from the UI to show "next run in …".
 */
export function nextCronRun(expr: string, after: Date = new Date()): Date | null {
  if (!isValidCron(expr)) return null;
  const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];
  // First whole minute strictly after `after`.
  const startMs = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  let day = new Date(
    Date.UTC(
      new Date(startMs).getUTCFullYear(),
      new Date(startMs).getUTCMonth(),
      new Date(startMs).getUTCDate(),
    ),
  );
  // 1500 days covers a full leap cycle, so Feb-29 schedules resolve.
  for (let d = 0; d < 1500; d++) {
    if (cronDayMatches(mon, dom, dow, day)) {
      for (let h = 0; h < 24; h++) {
        if (!cronFieldMatches(hr, h)) continue;
        for (let m = 0; m < 60; m++) {
          if (!cronFieldMatches(min, m)) continue;
          const cand = Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            h,
            m,
          );
          if (cand >= startMs) return new Date(cand);
        }
      }
    }
    day = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1),
    );
  }
  return null;
}

const CRON_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Join a list the way prose does: "a", "a and b", "a, b and c". */
function joinProse(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A plain-language summary of a cron expression for common patterns
 * (fixed daily time, weekday windows, hourly/every-N-minutes). Falls back to
 * the raw expression for anything it doesn't confidently recognize — better a
 * literal cron than a wrong English gloss. UTC, since the scheduler is UTC.
 */
export function describeCron(expr: string): string {
  if (!isValidCron(expr)) return expr;
  const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Only month="*" is described; specific months fall back to raw.
  if (mon !== "*") return expr;

  const pad = (s: string) => s.padStart(2, "0");
  const stepMin = /^\*\/(\d+)$/.exec(min);
  const stepHr = /^\*\/(\d+)$/.exec(hr);
  // A comma-list of whole hours, e.g. "9,17" (twice-daily). Single-minute only.
  const hourList = /^\d+(,\d+)+$/.test(hr) ? hr.split(",") : null;

  let time: string | null = null;
  if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
    time = `at ${hr}:${pad(min)} UTC`;
  } else if (/^\d+$/.test(min) && hourList) {
    time = `at ${joinProse(hourList.map((h) => `${h}:${pad(min)}`))} UTC`;
  } else if (/^\d+$/.test(min) && hr === "*") {
    time = `at :${pad(min)} past every hour`;
  } else if (min === "*" && hr === "*") {
    time = "every minute";
  } else if (stepMin && hr === "*") {
    time = `every ${stepMin[1]} minutes`;
  } else if (/^\d+$/.test(min) && stepHr) {
    time = `at :${pad(min)} every ${stepHr[1]} hours`;
  }
  if (time === null) return expr;

  // Day window: only describe when day-of-month is unrestricted.
  if (dom !== "*") return expr;
  let days: string | null = null;
  if (dow === "*") {
    days = ""; // every day
  } else if (dow === "1-5") {
    days = " on weekdays";
  } else if (dow === "0,6" || dow === "6,0" || dow === "0,7" || dow === "7,0") {
    days = " on weekends";
  } else if (/^\d$/.test(dow)) {
    days = ` on ${CRON_DAY_NAMES[Number(dow) % 7]}`;
  } else if (/^\d(,\d)+$/.test(dow)) {
    days = ` on ${joinProse(dow.split(",").map((d) => CRON_DAY_NAMES[Number(d) % 7]!))}`;
  }
  if (days === null) return expr;

  return time + days;
}

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(120),
  schedule: z
    .string()
    .min(1)
    .max(100)
    .refine(isValidCron, {
      message:
        "Schedule must be a valid 5-field cron expression (minute hour day-of-month month weekday).",
    }),
  prompt: z.string().max(10000).default(""),
});
export type CreateAutomationRequest = z.infer<typeof createAutomationSchema>;

/**
 * Editing an existing automation. Every field is optional (a PATCH may just
 * flip `enabled`, or just retune the schedule), but a provided schedule must
 * still be a valid cron and a provided name non-empty.
 */
export const updateAutomationSchema = z
  .object({
    name: z.string().min(1).max(120),
    schedule: z.string().min(1).max(100).refine(isValidCron, {
      message:
        "Schedule must be a valid 5-field cron expression (minute hour day-of-month month weekday).",
    }),
    prompt: z.string().max(10000),
    enabled: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: "Provide at least one field to update.",
  });
export type UpdateAutomationRequest = z.infer<typeof updateAutomationSchema>;

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
  hasAppToken: z.boolean().optional(),
  hasSigningSecret: z.boolean().optional(),
  hasConfigToken: z.boolean().optional(),
  status: z.enum(["connected", "needs-auth", "error"]),
  /** The identity link — the one agent this connection answers as. */
  linkedAgentId: z.string().uuid().nullable().optional(),
  linkedAgentName: z.string().nullable().optional(),
  /** The org's primary connection: Rabble's own presence on this surface —
   * notifications route through it, and on Slack it answers as a
   * general-purpose intent-routed interface (Builder included). */
  isPrimary: z.boolean().optional(),
  createdAt: z.string(),
});
export type Connection = z.infer<typeof connectionSchema>;

/** Tokens go into HTTP auth headers, which reject non-ASCII — and pastes
 * through rich-text surfaces can smuggle in em-dashes or smart quotes. */
const tokenString = z
  .string()
  .max(500)
  .regex(/^[!-~]+$/, "Token contains non-ASCII characters — re-copy it exactly as shown");

export const createConnectionSchema = z.object({
  vendor: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  roles: z.array(connectionRoleSchema).min(1),
  baseUrl: z.string().url().nullable().optional(),
  token: tokenString.optional(),
  /** Slack app-level token (xapp-…) — presence enables Socket Mode. */
  appToken: tokenString.optional(),
  /** Slack app configuration token (xoxe.xoxp-…) + its refresh token —
   * lets Rabble sync the app manifest. */
  configToken: tokenString.optional(),
  configRefreshToken: tokenString.optional(),
  /** Register as the org's primary connection (clears any previous one). */
  isPrimary: z.boolean().optional(),
});
export type CreateConnectionRequest = z.infer<typeof createConnectionSchema>;

// Editing an existing connection. Secrets follow tri-state semantics so an
// admin can add Socket Mode (or rotate a key) without deleting the
// connection and cascade-losing its channel/repo surface mappings:
//   - omitted (undefined) → keep the stored secret
//   - a non-empty string   → replace it
//   - null                 → clear it (e.g. turn Socket Mode back off)
export const updateConnectionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  roles: z.array(connectionRoleSchema).min(1).optional(),
  baseUrl: z.string().url().nullable().optional(),
  tunnel: z.boolean().optional(),
  token: z.string().max(500).nullable().optional(),
  signingSecret: z.string().max(500).nullable().optional(),
  appToken: z.string().max(500).nullable().optional(),
  /** true → becomes the org's primary connection (clears any previous one);
   * false → steps down. Editable any time, like everything else. */
  isPrimary: z.boolean().optional(),
});
export type UpdateConnectionRequest = z.infer<typeof updateConnectionSchema>;

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
  /** Pass-rate delta: last 30 days vs the 30 before (null = not enough data). */
  trendDelta: z.number().nullable().default(null),
  createdAt: z.string(),
});
export type EvalCriterion = z.infer<typeof evalCriterionSchema>;

export const createEvalCriterionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
});
export type CreateEvalCriterionRequest = z.infer<typeof createEvalCriterionSchema>;

export const sessionEvalResultSchema = z.object({
  id: z.string().uuid(),
  criterionId: z.string().uuid(),
  criterionName: z.string(),
  passed: z.boolean(),
  reasoning: z.string(),
  /** Spot-check state: null = trusted, open = queued for human review. */
  reviewStatus: z.enum(["open", "upheld", "overturned"]).nullable().default(null),
});
export type SessionEvalResult = z.infer<typeof sessionEvalResultSchema>;

const suiteRunSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["running", "completed", "failed"]),
  passed: z.number().int(),
  total: z.number().int(),
  startedAt: z.string(),
});

export const evalSuiteSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string(),
  gating: z.boolean(),
  caseCount: z.number().int(),
  lastRun: suiteRunSummarySchema.nullable(),
  /** Recent runs oldest→newest — the suite's pass-rate trajectory. */
  runHistory: z.array(suiteRunSummarySchema).default([]),
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
  /**
   * "ask" prompts every time an agent acts as you; "session" asks once per
   * session then trusts subsequent calls in it; "trust" never prompts.
   */
  approvalPosture: z.preprocess(
    (v) => (v === "auto" ? "trust" : v),
    z.enum(["ask", "session", "trust"]).default("session"),
  ),
  responseStyle: z.preprocess(
    (v) => (v === "balanced" ? "concise" : v),
    z.enum(["concise", "detailed"]).default("concise"),
  ),
  /** Agents can propose follow-up actions without being asked. */
  suggestNextSteps: z.boolean().default(true),
  /** Expand each tool call & result in the thread. */
  inlineToolCalls: z.boolean().default(true),
  /** Ping when an async run completes (delivery lands with surfaces). */
  notifyOnBackground: z.boolean().default(false),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export const orgSettingsSchema = z.object({
  /** Who may create agents: everyone, or only org admins/owners. */
  whoCanCreateAgents: z.enum(["everyone", "designated"]).default("everyone"),
  /**
   * Org-wide floor for write actions: when true, user-auth tools always
   * prompt, overriding personal "trust"/"session" postures.
   */
  requireApprovalForUserTools: z.boolean().default(false),
  /** Session transcript retention window (days) — informational for now. */
  retentionDays: z.number().int().min(7).max(3650).default(90),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * How a Slack surface reacts to messages in its channel:
 *   all     – respond to every message (whole-channel monitoring)
 *   thread  – tag to engage, then auto-respond to follow-ups in that thread
 *   mention – tag-only; require a fresh @-mention for every reply
 */
export const surfaceResponseModeSchema = z.enum(["all", "thread", "mention"]);
export type SurfaceResponseMode = z.infer<typeof surfaceResponseModeSchema>;

export const agentSurfaceSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  connectionId: z.string().uuid(),
  connectionName: z.string(),
  vendor: z.string(),
  label: z.string(),
  responseMode: surfaceResponseModeSchema,
  dmEnabled: z.boolean(),
  status: z.enum(["connected", "needs-auth", "error"]),
  createdAt: z.string(),
});
export type AgentSurface = z.infer<typeof agentSurfaceSchema>;

export const createAgentSurfaceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string().max(120).default(""),
  responseMode: surfaceResponseModeSchema.default("thread"),
  dmEnabled: z.boolean().default(true),
});
export type CreateAgentSurfaceRequest = z.infer<typeof createAgentSurfaceSchema>;

export const updateAgentSurfaceSchema = z.object({
  responseMode: surfaceResponseModeSchema.optional(),
  dmEnabled: z.boolean().optional(),
});
export type UpdateAgentSurfaceRequest = z.infer<typeof updateAgentSurfaceSchema>;

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
  /** Number of eval results behind evalScore (the trust denominator). */
  evalCount: z.number().int().default(0),
  toolCount: z.number().int(),
  starred: z.boolean(),
  /** The caller's effective right on this agent (null = none). */
  myRight: accessRightSchema.nullable(),
  /** Sharing shape: personal (grants to people only), team, or org-wide. */
  scope: z.enum(["personal", "team", "org-wide"]),
  /** When the caller last talked to this agent (null = never). */
  lastUsedAt: z.string().nullable(),
  updatedByEmail: z.string().nullable(),
  /** Open spot-check reviews or scope violations in the last 30 days. */
  needsAttention: z.boolean().default(false),
});
export type AgentDirectoryRow = z.infer<typeof agentDirectoryRowSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny", "run-as-service"]),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionSchema>;
