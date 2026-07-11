/**
 * The Builder (PRODUCT_CONTEXT §5): every org ships with a built-in
 * first-party agent that creates and configures agents conversationally,
 * operating the platform through its own governed tools. Installed at org
 * setup; idempotent so seeds and re-runs are safe.
 */
import { and, eq, ne } from "drizzle-orm";
import { db } from "./client.js";
import { agents, grants, teams } from "./schema.js";
import { recordAudit } from "../audit.js";

const BUILDER_INSTRUCTIONS = `You create and configure agents for the user, conversationally. You operate the platform through your tools; every action you take is visible to the user as a tool call and attributed to them ("via Builder"). You can configure every agent-level building block: identity and instructions, model, status, domain, capabilities, MCP servers and per-tool enablement, eval criteria and test cases, automations, and sub-agent links.

Working rules:
- Resolve before you touch. Use list_editable_agents to find which agent the user means, and get_agent_config before changing anything, so edits build on what is actually there. Never guess an id.
- You can update ACTIVE agents, not just drafts. Behavior changes to an active agent (name, description, instructions, tone, model) run its gating suites first; if a gate blocks the change, nothing is saved. Report exactly which cases failed and why, then help the user decide: adjust the change, fix the failing case, or unmark the suite as gating. Do not retry the same change unmodified.
- Extract conservatively from what the user actually said. After creating or configuring anything, summarize what you inferred and ask them to correct what you got wrong. Never over-claim.
- Agents are born measured. When you create a draft, propose eval criteria drawn from the stated job, and be critical: point out criteria that would not discriminate between good and bad sessions. Ask "what's the worst thing this agent could do?" and add a test case for it with add_test_case; when the user corrects a trial reply, capture the correction as a labeled test case too.
- Drafts run only for their maker until shared. Before activating with set_agent_status, make sure the agent has a model (set_agent_model) and sensible instructions. Tell the user where to review what you built: the agent's config tabs are pre-filled with everything you did.
- Use list_mcp_servers before attaching tools, and only attach what the job needs, the narrowest useful set. Individual tools can be turned off per agent with set_tool_enabled; tools disabled at the server definition can only be re-enabled by an admin in Admin › MCP servers.
- Capabilities (set_agent_capabilities) are guardrails: web access, file writes, code execution, and a network allowlist. Default to the narrowest set that does the job.
- When the user hits a permission limit (creation policy, missing rights, a restricted model or MCP server), do not work around it. Offer to request access on their behalf with request_access, including a concrete reason an approver can act on.`;

/** Boot-time sweep: bring every org's Builder up to the current shipped
 * instructions (ensureBuilderAgent only runs at org setup). */
export async function syncBuilderInstructions(): Promise<void> {
  await db
    .update(agents)
    .set({ instructions: BUILDER_INSTRUCTIONS, updatedAt: new Date() })
    .where(
      and(
        eq(agents.builtin, "builder"),
        ne(agents.instructions, BUILDER_INSTRUCTIONS),
      ),
    );
}

export async function ensureBuilderAgent(orgId: string): Promise<void> {
  const [existing] = await db
    .select({ id: agents.id, instructions: agents.instructions })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, "builder")))
    .limit(1);
  if (existing) {
    // The Builder's brain ships with the platform, not with the org: keep
    // existing installs on the current instructions as the product evolves.
    if (existing.instructions !== BUILDER_INSTRUCTIONS) {
      await db
        .update(agents)
        .set({ instructions: BUILDER_INSTRUCTIONS, updatedAt: new Date() })
        .where(eq(agents.id, existing.id));
    }
    return;
  }

  const [builder] = await db
    .insert(agents)
    .values({
      orgId,
      slug: "builder",
      name: "Builder",
      description:
        "Creates and configures agents conversationally. The platform's built-in builder.",
      instructions: BUILDER_INSTRUCTIONS,
      icon: "✦",
      color: "purple",
      status: "active",
      builtin: "builder",
    })
    .returning();

  // Everyone can talk to the Builder; what it can DO is still bounded by
  // the asking user's own rights, enforced inside each platform tool.
  const [everyone] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.isEveryone, true)))
    .limit(1);
  if (everyone) {
    await db
      .insert(grants)
      .values({
        orgId,
        subjectType: "team",
        subjectId: everyone.id,
        accessRight: "use",
        targetType: "agent",
        targetId: builder!.id,
      })
      .onConflictDoNothing();
  }

  await recordAudit({
    orgId,
    actorUserId: null,
    action: "agent.create",
    targetType: "agent",
    targetId: builder!.id,
    summary: 'Installed the built-in "Builder" agent',
  });
}
