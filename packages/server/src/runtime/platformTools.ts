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
  orgSettingsSchema,
  slugify,
  userPreferencesSchema,
  type ToolCall,
} from "@rabblehq/core";
import { db } from "../db/client.js";
import {
  accessRequests,
  agentMcpServers,
  agents,
  domains,
  evalCriteria,
  mcpServers,
  models,
  orgs,
  users,
} from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { rightForAgent, hasRight } from "../rights.js";
import { gateUserAuth } from "./userAuthGate.js";
import {
  gateContextFor,
  type AgentTurnEvent,
  type AgentTurnInput,
} from "./agentTurn.js";

const PLATFORM_SERVER_NAME = "Rabble platform";

async function uniqueAgentSlug(orgId: string, name: string): Promise<string> {
  const base = slugify(name) || "agent";
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.slug, candidate)))
      .limit(1);
    if (clash.length === 0) return candidate;
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
      name: "list_mcp_servers",
      description:
        "List the org's registered MCP servers and their tools — what an " +
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
          return `No MCP server named "${serverName}" is registered — use list_mcp_servers to see what exists.`;
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
            description: "Why the user needs this — shown to the approving admin",
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
