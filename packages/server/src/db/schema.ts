import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
