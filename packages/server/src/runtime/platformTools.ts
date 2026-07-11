/**
 * The Builder's platform tools (PRODUCT_CONTEXT §5): the built-in Builder
 * agent creates and configures agents by operating the platform through
 * its own governed tools — rendered in the standard inline tool-call UI,
 * gated by the same user-auth consent flow as any MCP tool, and
 * audit-attributed "via Builder".
 *
 * Rights are enforced inside each tool exactly like the HTTP API: the org
 * creation policy for drafts, edit rights for configuration, and access
 * requests for anything the user can't do — putting the request → notify →
 * approve loop on J1's critical path (§6).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import {
  agentCapabilitiesSchema,
  createAutomationSchema,
  orgSettingsSchema,
  slugify,
  userPreferencesSchema,
  type ToolCall,
} from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  accessRequests,
  agentLinks,
  agentMcpServers,
  agentToolConfigs,
  agents,
  automations,
  domains,
  evalCriteria,
  grants,
  mcpServers,
  models,
  orgs,
  users,
} from "../db/schema.js";
import { recordAudit } from "../audit.js";
import {
  rightForAgent,
  rightsForAllAgents,
  hasRight,
  canUseMcpServer,
} from "../rights.js";
import { gateUserAuth } from "./userAuthGate.js";
import {
  gateContextFor,
  type AgentTurnEvent,
  type AgentTurnInput,
} from "./agentTurn.js";

const PLATFORM_SERVER_NAME = "Rabble platform";

async function uniqueAgentSlug(
  orgId: string,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name) || "agent";
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.slug, candidate)))
      .limit(1);
    if (clash.length === 0 || clash[0]!.id === excludeId) return candidate;
  }
}

interface PlatformToolDef {
  name: string;
  description: string;
  authType: "user" | "service";
  schema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export function buildPlatformTools(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void,
) {
  const user = input.user;
  const preferences = userPreferencesSchema.parse({
    ...(user.preferences as Record<string, unknown>),
  });

  const loadAgent = async (agentId: string) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId)))
      .limit(1);
    return row ?? null;
  };

  const requireEdit = async (agentId: string): Promise<string | null> => {
    const right = await rightForAgent(
      { id: user.id, orgId: user.orgId, role: user.role } as Parameters<
        typeof rightForAgent
      >[0],
      agentId,
    );
    if (!hasRight(right, "edit")) {
      return (
        "The user doesn't have edit rights on that agent. Offer to request " +
        "access on their behalf with the request_access tool."
      );
    }
    return null;
  };

  const defs: PlatformToolDef[] = [
    {
      name: "create_agent_draft",
      description:
        "Create a new draft agent in Rabble. Drafts run only for their maker " +
        "until shared. Extract conservatively from what the user actually said; " +
        "confirm what you inferred so they can correct it.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Natural-cased display name, e.g. \"Release Notes Bot\"" },
          description: { type: "string", description: "One-line role description" },
          instructions: { type: "string", description: "System instructions for the agent" },
          tone: { type: "string", description: "Tone & style guidance" },
        },
        required: ["name"],
      },
      run: async (args) => {
        const name = String(args.name ?? "").trim();
        if (!name) return "Error: a name is required.";
        const [org] = await db
          .select({ settings: orgs.settings })
          .from(orgs)
          .where(eq(orgs.id, user.orgId))
          .limit(1);
        const settings = orgSettingsSchema.parse({ ...(org?.settings as object) });
        if (settings.whoCanCreateAgents === "designated" && user.role === "member") {
          return (
            "Agent creation is limited to designated members in this org, and " +
            "the user is not one of them. Suggest they ask an org admin to " +
            "create the agent or to designate them."
          );
        }
        const [row] = await db
          .insert(agents)
          .values({
            orgId: user.orgId,
            slug: await uniqueAgentSlug(user.orgId, name),
            name,
            description: String(args.description ?? ""),
            instructions: String(args.instructions ?? ""),
            tone: String(args.tone ?? ""),
            createdBy: user.id,
            status: "draft",
          })
          .returning();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.create",
          targetType: "agent",
          targetId: row!.id,
          summary: `Created agent "${name}" (draft) via Builder`,
        });
        return JSON.stringify({
          agentId: row!.id,
          slug: row!.slug,
          status: "draft",
          configUrl: `/agents/${row!.id}`,
          note: "Draft created. It runs only for its maker until shared.",
        });
      },
    },
    {
      name: "update_agent",
      description:
        "Update an agent's identity or behavior: name, description, " +
        "instructions, tone, icon, or color. Works on drafts AND active " +
        "agents — a behavior change to an active agent first runs its " +
        "gating suites against the new config, and a failing case blocks " +
        "the save (report the failure and iterate with the user).",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The agent's id (see list_editable_agents)" },
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
          tone: { type: "string" },
          icon: { type: "string", description: "A single glyph, e.g. \"◈\"" },
          color: { type: "string", enum: ["blue", "green", "purple", "amber"] },
        },
        required: ["agentId"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const existing = await loadAgent(agentId);
        if (!existing) return "Error: agent not found.";
        if (existing.builtin) return "Error: built-in agents can't be reconfigured.";

        const updates: Record<string, unknown> = {};
        for (const key of ["name", "description", "instructions", "tone", "icon", "color"] as const) {
          if (typeof args[key] === "string" && args[key] !== "") {
            updates[key] = String(args[key]);
          }
        }
        if (Object.keys(updates).length === 0) {
          return "Nothing to update — pass at least one field.";
        }
        if (updates.name) {
          updates.slug = await uniqueAgentSlug(user.orgId, updates.name as string, agentId);
        }

        // Behavior changes face the same gate as the config tabs.
        const candidate = {
          name: (updates.name as string | undefined) ?? existing.name,
          description: (updates.description as string | undefined) ?? existing.description,
          instructions: (updates.instructions as string | undefined) ?? existing.instructions,
          tone: (updates.tone as string | undefined) ?? existing.tone,
          modelId: existing.modelId,
        };
        const { behaviorChanged, runAgentGate } = await import("../evals/gate.js");
        if (behaviorChanged(existing, candidate)) {
          const gate = await runAgentGate({
            orgId: user.orgId,
            actorUserId: user.id,
            agent: existing,
            candidate,
          });
          if (!gate.ok) {
            return JSON.stringify({
              blocked: true,
              reason: gate.error,
              failures: gate.block?.failures ?? [],
              note: "Nothing was saved. Adjust the change (or the failing case) and try again.",
            });
          }
        }

        await db
          .update(agents)
          .set({ ...updates, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.update",
          targetType: "agent",
          targetId: agentId,
          summary: `Updated ${Object.keys(updates).filter((k) => k !== "slug").join(", ")} on "${
            (updates.name as string | undefined) ?? existing.name
          }" via Builder`,
        });
        return JSON.stringify({
          updated: Object.keys(updates).filter((k) => k !== "slug"),
          gated: existing.status === "active",
        });
      },
    },
    {
      name: "list_editable_agents",
      description:
        "List the agents the user can configure (edit or admin right), with " +
        "ids for the other tools. Use this to resolve which agent the user " +
        "means before changing anything.",
      authType: "service",
      schema: { type: "object", properties: {} },
      run: async () => {
        const rights = await rightsForAllAgents({
          id: user.id,
          orgId: user.orgId,
          role: user.role,
        } as never);
        const rows = await db
          .select()
          .from(agents)
          .where(eq(agents.orgId, user.orgId));
        return JSON.stringify(
          rows
            .filter((a) => {
              const r = rights.get(a.id) ?? null;
              return !a.builtin && hasRight(r, "edit");
            })
            .map((a) => ({ id: a.id, name: a.name, slug: a.slug, status: a.status })),
        );
      },
    },
    {
      name: "get_agent_config",
      description:
        "Read an agent's full current configuration: identity, model, " +
        "domain, status, capabilities, attached MCP servers with per-tool " +
        "enablement, eval criteria, suites, automations, and sub-agents. " +
        "ALWAYS read this before updating an agent, so edits build on what " +
        "is actually there.",
      authType: "service",
      schema: {
        type: "object",
        properties: { agentId: { type: "string" } },
        required: ["agentId"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const agent = await loadAgent(agentId);
        if (!agent) return "Error: agent not found.";
        const [model] = agent.modelId
          ? await db.select().from(models).where(eq(models.id, agent.modelId)).limit(1)
          : [];
        const [domain] = agent.domainId
          ? await db.select().from(domains).where(eq(domains.id, agent.domainId)).limit(1)
          : [];
        const attached = await db
          .select({ server: mcpServers })
          .from(agentMcpServers)
          .innerJoin(mcpServers, eq(agentMcpServers.serverId, mcpServers.id))
          .where(eq(agentMcpServers.agentId, agentId));
        const toolConfigs = await db
          .select()
          .from(agentToolConfigs)
          .where(eq(agentToolConfigs.agentId, agentId));
        const configFor = new Map(
          toolConfigs.map((c) => [`${c.serverId}:${c.toolName}`, c.enabled]),
        );
        const criteria = await db
          .select({ name: evalCriteria.name, description: evalCriteria.description })
          .from(evalCriteria)
          .where(eq(evalCriteria.agentId, agentId));
        const { evalSuites, evalCases } = await import("../db/schema.js");
        const suites = await db
          .select()
          .from(evalSuites)
          .where(eq(evalSuites.agentId, agentId));
        const suiteSummaries = [];
        for (const suite of suites) {
          const cases = await db
            .select({ id: evalCases.id })
            .from(evalCases)
            .where(eq(evalCases.suiteId, suite.id));
          suiteSummaries.push({ name: suite.name, gating: suite.gating, cases: cases.length });
        }
        const autoRows = await db
          .select()
          .from(automations)
          .where(eq(automations.agentId, agentId));
        const links = await db
          .select({ link: agentLinks, child: agents })
          .from(agentLinks)
          .innerJoin(agents, eq(agentLinks.subAgentId, agents.id))
          .where(eq(agentLinks.agentId, agentId));
        return JSON.stringify({
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
          status: agent.status,
          description: agent.description,
          instructions: agent.instructions,
          tone: agent.tone,
          icon: agent.icon,
          color: agent.color,
          model: model ? { name: model.displayName, enabled: model.enabled } : null,
          domain: domain?.name ?? null,
          capabilities: agentCapabilitiesSchema.parse(
            (agent.capabilities ?? {}) as Record<string, unknown>,
          ),
          mcpServers: attached.map(({ server }) => ({
            name: server.name,
            credentialMode: server.credentialMode,
            tools: ((server.tools ?? []) as Array<{ name: string }>)
              .filter(
                (t) => !((server.disabledTools ?? []) as string[]).includes(t.name),
              )
              .map((t) => ({
                name: t.name,
                enabled: configFor.get(`${server.id}:${t.name}`) ?? true,
              })),
          })),
          criteria,
          suites: suiteSummaries,
          automations: autoRows.map((a) => ({
            name: a.name,
            schedule: a.schedule,
            enabled: a.enabled,
          })),
          subAgents: links.map(({ link, child }) => ({
            name: child.name,
            note: link.note,
          })),
        });
      },
    },
    {
      name: "set_agent_model",
      description:
        "Point an agent at a different model by its display name. A model " +
        "change on an active agent runs the gating suites first. Model " +
        "grants apply — a restricted model needs access.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          modelName: { type: "string", description: "The model's display name, e.g. \"Claude Sonnet 5\"" },
        },
        required: ["agentId", "modelName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const modelName = String(args.modelName ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const existing = await loadAgent(agentId);
        if (!existing) return "Error: agent not found.";
        const [model] = await db
          .select()
          .from(models)
          .where(
            and(
              eq(models.orgId, user.orgId),
              sql`lower(${models.displayName}) = ${modelName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!model) {
          const all = await db
            .select({ name: models.displayName })
            .from(models)
            .where(eq(models.orgId, user.orgId));
          return `No model named "${modelName}". Registered models: ${all.map((m) => m.name).join(", ") || "(none)"}.`;
        }
        if (!model.enabled) return `The model "${model.displayName}" is disabled.`;
        // Model grants: with grants present, only grantees (and admins) may
        // put agents on it — the same rule the identity tab enforces.
        const isAdmin = user.role === "owner" || user.role === "admin";
        if (!isAdmin) {
          const modelGrants = await db
            .select()
            .from(grants)
            .where(
              and(
                eq(grants.orgId, user.orgId),
                eq(grants.targetType, "model"),
                eq(grants.targetId, model.id),
              ),
            );
          if (modelGrants.length > 0) {
            const { grantSubjectsFor } = await import("../rights.js");
            const { userIds, teamIds } = await grantSubjectsFor(user.id, user.orgId);
            const reachable = modelGrants.some(
              (g) =>
                (g.subjectType === "user" && userIds.includes(g.subjectId)) ||
                (g.subjectType === "team" && teamIds.includes(g.subjectId)),
            );
            if (!reachable) {
              return (
                `The model "${model.displayName}" is restricted and the user doesn't have access. ` +
                "Offer to request it with request_access."
              );
            }
          }
        }
        const candidate = {
          name: existing.name,
          description: existing.description,
          instructions: existing.instructions,
          tone: existing.tone,
          modelId: model.id,
        };
        const { behaviorChanged, runAgentGate } = await import("../evals/gate.js");
        if (behaviorChanged(existing, candidate)) {
          const gate = await runAgentGate({
            orgId: user.orgId,
            actorUserId: user.id,
            agent: existing,
            candidate,
          });
          if (!gate.ok) {
            return JSON.stringify({
              blocked: true,
              reason: gate.error,
              failures: gate.block?.failures ?? [],
            });
          }
        }
        await db
          .update(agents)
          .set({ modelId: model.id, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.update",
          targetType: "agent",
          targetId: agentId,
          summary: `Set model to "${model.displayName}" on "${existing.name}" via Builder`,
        });
        return JSON.stringify({ model: model.displayName });
      },
    },
    {
      name: "set_agent_status",
      description:
        "Activate an agent (it goes live for everyone with access) or set " +
        "it back to draft (runs only for its maker).",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          status: { type: "string", enum: ["draft", "active"] },
        },
        required: ["agentId", "status"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const status = String(args.status ?? "");
        if (status !== "draft" && status !== "active") {
          return "Error: status must be draft or active.";
        }
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const existing = await loadAgent(agentId);
        if (!existing) return "Error: agent not found.";
        if (existing.builtin) return "Error: built-in agents can't change status.";
        if (status === "active" && !existing.modelId) {
          return "The agent has no model yet — set one with set_agent_model before activating.";
        }
        await db
          .update(agents)
          .set({ status, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.update",
          targetType: "agent",
          targetId: agentId,
          summary: `Set "${existing.name}" to ${status} via Builder`,
        });
        return JSON.stringify({ status });
      },
    },
    {
      name: "set_agent_domain",
      description:
        "File an agent in a domain (grants on the domain then apply to it), " +
        "or clear it with domainName: null.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          domainName: { type: ["string", "null"] },
        },
        required: ["agentId", "domainName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const existing = await loadAgent(agentId);
        if (!existing) return "Error: agent not found.";
        let domainId: string | null = null;
        let label = "no domain";
        if (args.domainName != null && args.domainName !== "") {
          const name = String(args.domainName);
          const [domain] = await db
            .select()
            .from(domains)
            .where(
              and(
                eq(domains.orgId, user.orgId),
                sql`lower(${domains.name}) = ${name.toLowerCase()}`,
              ),
            )
            .limit(1);
          if (!domain) {
            const all = await db
              .select({ name: domains.name })
              .from(domains)
              .where(eq(domains.orgId, user.orgId));
            return `No domain named "${name}". Domains: ${all.map((d) => d.name).join(", ") || "(none)"}.`;
          }
          domainId = domain.id;
          label = `domain "${domain.name}"`;
        }
        await db
          .update(agents)
          .set({ domainId, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.update",
          targetType: "agent",
          targetId: agentId,
          summary: `Filed "${existing.name}" under ${label} via Builder`,
        });
        return JSON.stringify({ domain: args.domainName ?? null });
      },
    },
    {
      name: "set_agent_capabilities",
      description:
        "Set the agent's Advanced-tab capabilities. Outbound web access " +
        "gives a governed fetch_url tool bound to the network allowlist " +
        "(comma-separated hosts, *.wildcards allowed; empty = no egress).",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          outboundWebAccess: { type: "boolean" },
          networkAllowlist: { type: "string" },
          codeExecution: { type: "boolean" },
          codeSandbox: { type: "boolean" },
          pullRequestAccess: { type: "boolean" },
        },
        required: ["agentId"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const existing = await loadAgent(agentId);
        if (!existing) return "Error: agent not found.";
        const current = agentCapabilitiesSchema.parse(
          (existing.capabilities ?? {}) as Record<string, unknown>,
        );
        const next = { ...current } as Record<string, unknown>;
        for (const key of [
          "outboundWebAccess",
          "codeExecution",
          "codeSandbox",
          "pullRequestAccess",
        ] as const) {
          if (typeof args[key] === "boolean") next[key] = args[key];
        }
        if (typeof args.networkAllowlist === "string") {
          next.networkAllowlist = args.networkAllowlist;
        }
        await db
          .update(agents)
          .set({ capabilities: next, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.update",
          targetType: "agent",
          targetId: agentId,
          summary: `Updated capabilities on "${existing.name}" via Builder`,
          metadata: { capabilities: next },
        });
        return JSON.stringify({ capabilities: next });
      },
    },
    {
      name: "detach_mcp_server",
      description: "Detach an MCP server from an agent (its tools go away).",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          serverName: { type: "string" },
        },
        required: ["agentId", "serverName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const serverName = String(args.serverName ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.orgId, user.orgId),
              sql`lower(${mcpServers.name}) = ${serverName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!server) return `No MCP server named "${serverName}".`;
        await db
          .delete(agentMcpServers)
          .where(
            and(
              eq(agentMcpServers.agentId, agentId),
              eq(agentMcpServers.serverId, server.id),
            ),
          );
        await db
          .delete(agentToolConfigs)
          .where(
            and(
              eq(agentToolConfigs.agentId, agentId),
              eq(agentToolConfigs.serverId, server.id),
            ),
          );
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.mcp.detach",
          targetType: "agent",
          targetId: agentId,
          summary: `Detached MCP server "${server.name}" via Builder`,
        });
        return JSON.stringify({ detached: server.name });
      },
    },
    {
      name: "set_tool_enabled",
      description:
        "Enable or disable one tool from an attached MCP server for this " +
        "agent. Narrow the set to what the job needs.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          serverName: { type: "string" },
          toolName: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["agentId", "serverName", "toolName", "enabled"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const serverName = String(args.serverName ?? "");
        const toolName = String(args.toolName ?? "");
        const enabled = Boolean(args.enabled);
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.orgId, user.orgId),
              sql`lower(${mcpServers.name}) = ${serverName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!server) return `No MCP server named "${serverName}".`;
        const tools = (server.tools ?? []) as Array<{ name: string }>;
        if (!tools.some((t) => t.name === toolName)) {
          return `"${serverName}" has no tool named "${toolName}". Its tools: ${tools.map((t) => t.name).join(", ")}.`;
        }
        if (((server.disabledTools ?? []) as string[]).includes(toolName)) {
          return `"${toolName}" is switched off at the server definition by an org admin — it can't be enabled per agent.`;
        }
        await db
          .insert(agentToolConfigs)
          .values({ agentId, serverId: server.id, toolName, enabled })
          .onConflictDoUpdate({
            target: [
              agentToolConfigs.agentId,
              agentToolConfigs.serverId,
              agentToolConfigs.toolName,
            ],
            set: { enabled },
          });
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.tool.configure",
          targetType: "agent",
          targetId: agentId,
          summary: `${enabled ? "Enabled" : "Disabled"} tool "${toolName}" via Builder`,
        });
        return JSON.stringify({ tool: toolName, enabled });
      },
    },
    {
      name: "link_sub_agent",
      description:
        "Wire another agent in as a callable sub-agent (bounded delegation). " +
        "Needs use access on the agent being attached. Optionally note when " +
        "to call it.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The parent agent's id" },
          subAgentName: { type: "string" },
          note: { type: "string", description: "When should the parent call it?" },
        },
        required: ["agentId", "subAgentName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const subAgentName = String(args.subAgentName ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [child] = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.orgId, user.orgId),
              sql`lower(${agents.name}) = ${subAgentName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!child) return `No agent named "${subAgentName}".`;
        if (child.id === agentId) return "An agent can't call itself.";
        const right = await rightForAgent(
          { id: user.id, orgId: user.orgId, role: user.role } as Parameters<
            typeof rightForAgent
          >[0],
          child.id,
        );
        if (!hasRight(right, "use")) {
          return (
            `The user doesn't have use access on "${child.name}", which is required to wire it in. ` +
            "Offer to request it with request_access."
          );
        }
        await db
          .insert(agentLinks)
          .values({
            agentId,
            subAgentId: child.id,
            note: String(args.note ?? "").slice(0, 300),
          })
          .onConflictDoNothing();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.link",
          targetType: "agent",
          targetId: agentId,
          summary: `Linked "${child.name}" as a sub-agent via Builder`,
        });
        return JSON.stringify({ linked: child.name });
      },
    },
    {
      name: "unlink_sub_agent",
      description: "Remove a sub-agent link from an agent.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          subAgentName: { type: "string" },
        },
        required: ["agentId", "subAgentName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const subAgentName = String(args.subAgentName ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [child] = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(
            and(
              eq(agents.orgId, user.orgId),
              sql`lower(${agents.name}) = ${subAgentName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!child) return `No agent named "${subAgentName}".`;
        await db
          .delete(agentLinks)
          .where(
            and(eq(agentLinks.agentId, agentId), eq(agentLinks.subAgentId, child.id)),
          );
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.unlink",
          targetType: "agent",
          targetId: agentId,
          summary: `Unlinked sub-agent "${child.name}" via Builder`,
        });
        return JSON.stringify({ unlinked: child.name });
      },
    },
    {
      name: "create_automation",
      description:
        "Schedule the agent to run a prompt on a cron schedule (5 fields, " +
        "hourly at most, e.g. \"0 9 * * 1\" = Mondays 9:00). The run lands " +
        "as a real, judged session on the Automation surface.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          name: { type: "string" },
          schedule: { type: "string", description: "5-field cron" },
          prompt: { type: "string", description: "What the agent should do each run" },
        },
        required: ["agentId", "name", "schedule", "prompt"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const parsed = createAutomationSchema.safeParse({
          name: String(args.name ?? ""),
          schedule: String(args.schedule ?? ""),
          prompt: String(args.prompt ?? ""),
        });
        if (!parsed.success) {
          return `Invalid automation: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
        }
        const [row] = await db
          .insert(automations)
          .values({ agentId, ...parsed.data, createdBy: user.id })
          .returning();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "automation.create",
          targetType: "agent",
          targetId: agentId,
          summary: `Created automation "${parsed.data.name}" (${parsed.data.schedule}) via Builder`,
        });
        return JSON.stringify({
          automationId: row!.id,
          schedule: parsed.data.schedule,
          note: "It runs on schedule once the scheduler is up; Run now is on the agent's Automations tab.",
        });
      },
    },
    {
      name: "add_eval_criterion",
      description:
        "Add a live eval criterion to an agent (evaluated against its real " +
        "sessions). Agents are born measured: draft criteria from the stated " +
        "job, and critique criteria that won't discriminate.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The agent's id (from create_agent_draft)" },
          name: { type: "string", description: "Short criterion name" },
          description: {
            type: "string",
            description: "What the judge should check on every session",
          },
        },
        required: ["agentId", "name", "description"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [row] = await db
          .insert(evalCriteria)
          .values({
            agentId,
            name: String(args.name ?? ""),
            description: String(args.description ?? ""),
          })
          .returning();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "eval.criterion.add",
          targetType: "agent",
          targetId: agentId,
          summary: `Added eval criterion "${row!.name}" via Builder`,
        });
        return JSON.stringify({ criterionId: row!.id, name: row!.name });
      },
    },
    {
      name: "add_test_case",
      description:
        "Add an offline test case to one of the agent's eval suites (created " +
        "if missing). Use it to mine cases from trial sessions (a user " +
        "correction is a labeled example) and to propose adversarial cases " +
        "(\"what's the worst thing this agent could do?\").",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The agent's id" },
          suiteName: {
            type: "string",
            description: "Suite to add the case to (created if it doesn't exist)",
          },
          caseName: { type: "string", description: "Short case name" },
          input: { type: "string", description: "The user message the case replays" },
          rubric: {
            type: "string",
            description: "What a good reply must do. The judge grades against this",
          },
        },
        required: ["agentId", "suiteName", "caseName", "input", "rubric"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const suiteName = String(args.suiteName ?? "").trim() || "Builder cases";
        const { evalSuites, evalCases } = await import("../db/schema.js");
        let [suite] = await db
          .select()
          .from(evalSuites)
          .where(
            and(
              eq(evalSuites.agentId, agentId),
              sql`lower(${evalSuites.name}) = ${suiteName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!suite) {
          [suite] = await db
            .insert(evalSuites)
            .values({ agentId, name: suiteName })
            .returning();
        }
        const [row] = await db
          .insert(evalCases)
          .values({
            suiteId: suite!.id,
            name: String(args.caseName ?? ""),
            input: String(args.input ?? ""),
            rubric: String(args.rubric ?? ""),
          })
          .returning();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "eval.case.add",
          targetType: "agent",
          targetId: agentId,
          summary: `Added test case "${row!.name}" to suite "${suite!.name}" via Builder`,
        });
        return JSON.stringify({
          caseId: row!.id,
          suite: suite!.name,
          note: "Run the suite from the agent's Evals tab; mark it gating to block regressions.",
        });
      },
    },
    {
      name: "list_mcp_servers",
      description:
        "List the org's registered MCP servers and their tools: what an " +
        "agent could be given access to.",
      authType: "service",
      schema: { type: "object", properties: {} },
      run: async () => {
        const rows = await db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.orgId, user.orgId));
        return JSON.stringify(
          rows.map((s) => ({
            name: s.name,
            category: s.category,
            tools: ((s.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
          })),
        );
      },
    },
    {
      name: "attach_mcp_server",
      description:
        "Attach one of the org's MCP servers to an agent so its tools become " +
        "available. Use list_mcp_servers first to see what exists.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The agent's id" },
          serverName: { type: "string", description: "The MCP server's name, e.g. \"github\"" },
        },
        required: ["agentId", "serverName"],
      },
      run: async (args) => {
        const agentId = String(args.agentId ?? "");
        const serverName = String(args.serverName ?? "");
        const denied = await requireEdit(agentId);
        if (denied) return denied;
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(
            and(
              eq(mcpServers.orgId, user.orgId),
              sql`lower(${mcpServers.name}) = ${serverName.toLowerCase()}`,
            ),
          )
          .limit(1);
        if (!server) {
          return `No MCP server named "${serverName}" is registered. Use list_mcp_servers to see what exists.`;
        }
        // The same access scope the HTTP attach route enforces — the
        // conversational path is not a side door.
        if (!(await canUseMcpServer(user, server.id))) {
          return (
            `"${server.name}" is restricted to specific teams or people. ` +
            "Offer to request access on the user's behalf with the request_access tool."
          );
        }
        await db
          .insert(agentMcpServers)
          .values({ agentId, serverId: server.id })
          .onConflictDoNothing();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "agent.mcp.attach",
          targetType: "agent",
          targetId: agentId,
          summary: `Attached MCP server "${server.name}" via Builder`,
        });
        return JSON.stringify({
          attached: server.name,
          tools: ((server.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
        });
      },
    },
    {
      name: "request_access",
      description:
        "Request access on the user's behalf when they hit a permission " +
        "limit. An org admin reviews it under Admin › Access requests with " +
        "your context attached.",
      authType: "user",
      schema: {
        type: "object",
        properties: {
          targetType: { type: "string", enum: ["agent", "domain", "model"] },
          targetName: {
            type: "string",
            description: "Display name of the agent/domain/model",
          },
          right: { type: "string", enum: ["use", "edit", "admin"] },
          reason: {
            type: "string",
            description: "Why the user needs this, shown to the approving admin",
          },
        },
        required: ["targetType", "targetName", "right", "reason"],
      },
      run: async (args) => {
        const targetType = String(args.targetType ?? "");
        const targetName = String(args.targetName ?? "");
        const right = String(args.right ?? "");
        if (!["agent", "domain", "model"].includes(targetType)) {
          return "Error: targetType must be agent, domain, or model.";
        }
        if (!["use", "edit", "admin"].includes(right)) {
          return "Error: right must be use, edit, or admin.";
        }
        let targetId: string | undefined;
        let targetLabel = targetName;
        if (targetType === "agent") {
          const [row] = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.orgId, user.orgId),
                sql`lower(${agents.name}) = ${targetName.toLowerCase()}`,
              ),
            )
            .limit(1);
          targetId = row?.id;
          targetLabel = row?.name ?? targetName;
        } else if (targetType === "domain") {
          const [row] = await db
            .select({ id: domains.id, name: domains.name })
            .from(domains)
            .where(
              and(
                eq(domains.orgId, user.orgId),
                sql`lower(${domains.name}) = ${targetName.toLowerCase()}`,
              ),
            )
            .limit(1);
          targetId = row?.id;
          targetLabel = row?.name ?? targetName;
        } else {
          const [row] = await db
            .select({ id: models.id, name: models.displayName })
            .from(models)
            .where(
              and(
                eq(models.orgId, user.orgId),
                sql`lower(${models.displayName}) = ${targetName.toLowerCase()}`,
              ),
            )
            .limit(1);
          targetId = row?.id;
          targetLabel = row?.name ?? targetName;
        }
        if (!targetId) {
          return `No ${targetType} named "${targetName}" exists in this org.`;
        }
        const reason = String(args.reason ?? "");
        const [row] = await db
          .insert(accessRequests)
          .values({
            orgId: user.orgId,
            requesterUserId: user.id,
            targetType: targetType as "agent" | "domain" | "model",
            targetId,
            accessRight: right as "use" | "edit" | "admin",
            reason,
            via: "builder",
          })
          .returning();
        await recordAudit({
          orgId: user.orgId,
          actorUserId: user.id,
          action: "access.request",
          targetType,
          targetId,
          summary: `Requested ${right} on ${targetType} "${targetLabel}" via Builder`,
        });
        const { notifyAdminsOfAccessRequest } = await import(
          "../notifications/accessRequests.js"
        );
        void notifyAdminsOfAccessRequest({
          orgId: user.orgId,
          requesterName: user.name,
          accessRight: right,
          targetLabel: `${targetType} "${targetLabel}"`,
          reason,
          via: "builder",
        });
        return JSON.stringify({
          requestId: row!.id,
          status: "open",
          note: "An org admin has been notified and can approve it under Admin › Access requests.",
        });
      },
    },
  ];

  return defs.map((def) =>
    tool(
      async (args: Record<string, unknown>) => {
        const callId = randomUUID();
        const startedAt = Date.now();
        const call: ToolCall = {
          id: callId,
          name: def.name,
          serverName: PLATFORM_SERVER_NAME,
          input: args,
          output: null,
          authType: def.authType,
          approval: null,
        };
        emit({ type: "tool-start", toolCall: call });

        let approval: ToolCall["approval"] = null;
        if (def.authType === "user") {
          const gate = await gateUserAuth(gateContextFor(input, preferences, emit), call);
          if (gate.outcome === "refused") {
            const denied: ToolCall = {
              ...call,
              output: gate.toolOutput,
              approval: gate.approval,
              durationMs: Date.now() - startedAt,
            };
            emit({ type: "tool-end", toolCall: denied });
            return gate.modelText;
          }
          approval = gate.approval;
        }

        try {
          const output = await def.run(args);
          const finished: ToolCall = {
            ...call,
            output,
            approval,
            durationMs: Date.now() - startedAt,
          };
          emit({ type: "tool-end", toolCall: finished });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Tool call failed";
          const failed: ToolCall = {
            ...call,
            output: `Error: ${message}`,
            approval,
            durationMs: Date.now() - startedAt,
          };
          emit({ type: "tool-end", toolCall: failed });
          return `Error: ${message}`;
        }
      },
      {
        name: def.name,
        description:
          `${def.description} (via ${PLATFORM_SERVER_NAME}; runs as ` +
          `${def.authType === "service" ? "the org service account" : "the requesting user"})`,
        schema: def.schema,
      },
    ),
  );
}
