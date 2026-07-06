import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    passwordHash: text("password_hash").notNull(),
    preferences: jsonb("preferences").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("auth_sessions_token_idx").on(t.tokenHash)],
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    provider: text("provider").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("provider_keys_org_provider_idx").on(t.orgId, t.provider)],
);

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    kind: text("kind", { enum: ["built-in", "custom"] }).notNull(),
    catalogId: text("catalog_id"),
    displayName: text("display_name").notNull(),
    protocol: text("protocol", { enum: ["anthropic", "openai"] }).notNull(),
    baseUrl: text("base_url"),
    modelId: text("model_id").notNull(),
    encryptedKey: text("encrypted_key"),
    // USD per 1M tokens; null = unpriced (excluded from spend figures)
    priceInputPerMtok: numeric("price_input_per_mtok", { precision: 10, scale: 4 }),
    priceOutputPerMtok: numeric("price_output_per_mtok", { precision: 10, scale: 4 }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("models_org_catalog_idx").on(t.orgId, t.catalogId)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    modelId: uuid("model_id").references(() => models.id, {
      onDelete: "set null",
    }),
    domainId: uuid("domain_id").references(() => domains.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    capabilities: jsonb("capabilities").notNull().default({}),
    icon: text("icon").notNull().default(""),
    color: text("color").notNull().default("blue"),
    tone: text("tone").notNull().default(""),
    status: text("status", { enum: ["active", "draft"] })
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("agents_org_slug_idx").on(t.orgId, t.slug)],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  title: text("title").notNull().default(""),
  // Where the session originates: "Web" or a delivery point like "Slack #eng-oncall"
  surface: text("surface").notNull().default("Web"),
  // Correlation key for surface threads, e.g. "slack:C042:1712.34"
  surfaceKey: text("surface_key"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "agent"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls").notNull().default([]),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Governance: teams, domains, grants
// ---------------------------------------------------------------------------

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    parentTeamId: uuid("parent_team_id").references(
      (): AnyPgColumn => teams.id,
      { onDelete: "cascade" },
    ),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    isEveryone: boolean("is_everyone").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("teams_org_slug_idx").on(t.orgId, t.slug)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("domains_org_slug_idx").on(t.orgId, t.slug)],
);

export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    subjectType: text("subject_type", { enum: ["user", "team"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    accessRight: text("access_right", {
      enum: ["use", "edit", "admin"],
    }).notNull(),
    targetType: text("target_type", {
      enum: ["agent", "domain", "model"],
    }).notNull(),
    targetId: uuid("target_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("grants_unique_idx").on(
      t.orgId,
      t.subjectType,
      t.subjectId,
      t.targetType,
      t.targetId,
    ),
    index("grants_target_idx").on(t.targetType, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// MCP servers and per-agent tool configuration
// ---------------------------------------------------------------------------

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    category: text("category").notNull().default("Tools"),
    encryptedToken: text("encrypted_token"),
    tools: jsonb("tools").notNull().default([]),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("mcp_servers_org_slug_idx").on(t.orgId, t.slug)],
);

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.serverId] })],
);

export const agentToolConfigs = pgTable(
  "agent_tool_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    authType: text("auth_type", { enum: ["service", "user"] })
      .notNull()
      .default("service"),
  },
  (t) => [
    uniqueIndex("agent_tool_configs_idx").on(t.agentId, t.serverId, t.toolName),
  ],
);

export const agentLinks = pgTable(
  "agent_links",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    subAgentId: uuid("sub_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.subAgentId] })],
);

export const automations = pgTable("automations", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  schedule: text("schedule").notNull(),
  prompt: text("prompt").notNull().default(""),
  enabled: boolean("enabled").notNull().default(false),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSessionId: uuid("last_session_id").references((): AnyPgColumn => sessions.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Admin: connections, API keys, audit log
// ---------------------------------------------------------------------------

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  vendor: text("vendor").notNull(),
  name: text("name").notNull(),
  roles: jsonb("roles").notNull().default([]),
  baseUrl: text("base_url"),
  encryptedToken: text("encrypted_token"),
  encryptedSigningSecret: text("encrypted_signing_secret"),
  status: text("status", { enum: ["connected", "needs-auth", "error"] })
    .notNull()
    .default("connected"),
  tunnel: boolean("tunnel").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentSurfaces = pgTable(
  "agent_surfaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agent_surfaces_agent_idx").on(t.agentId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    scope: text("scope", { enum: ["read", "write", "admin"] }).notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_events_org_time_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export const evalCriteria = pgTable("eval_criteria", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    criterionId: uuid("criterion_id")
      .notNull()
      .references(() => evalCriteria.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    passed: boolean("passed").notNull(),
    reasoning: text("reasoning").notNull().default(""),
    reviewStatus: text("review_status", {
      enum: ["open", "upheld", "overturned"],
    }),
    disputedBy: uuid("disputed_by").references(() => users.id),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("eval_results_session_idx").on(t.sessionId),
    index("eval_results_criterion_idx").on(t.criterionId, t.createdAt),
  ],
);

export const evalSuites = pgTable("eval_suites", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  gating: boolean("gating").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalCases = pgTable("eval_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  suiteId: uuid("suite_id")
    .notNull()
    .references(() => evalSuites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  input: text("input").notNull(),
  rubric: text("rubric").notNull(),
  sourceSessionId: uuid("source_session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const suiteRuns = pgTable("suite_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  suiteId: uuid("suite_id")
    .notNull()
    .references(() => evalSuites.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["running", "completed", "failed"] })
    .notNull()
    .default("running"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const caseResults = pgTable("case_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => suiteRuns.id, { onDelete: "cascade" }),
  caseId: uuid("case_id")
    .notNull()
    .references(() => evalCases.id, { onDelete: "cascade" }),
  passed: boolean("passed").notNull(),
  output: text("output").notNull().default(""),
  reasoning: text("reasoning").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Per-user: favorites, connected accounts
// ---------------------------------------------------------------------------

export const userFavorites = pgTable(
  "user_favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agentId] })],
);

export const userConnectedAccounts = pgTable(
  "user_connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(),
    label: text("label").notNull().default(""),
    encryptedToken: text("encrypted_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("user_connected_accounts_idx").on(t.userId, t.vendor)],
);

export const scopeViolations = pgTable(
  "scope_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    toolName: text("tool_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("scope_violations_agent_idx").on(t.agentId, t.createdAt)],
);
