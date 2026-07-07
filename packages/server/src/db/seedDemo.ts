/**
 * Demo seed: fills the database with a lived-in org — agents with identity
 * and history, teams/domains/grants, eval results spread over 60 days (so
 * trends render), suites with runs, sessions with tool calls across days,
 * connections, an API key, and an audit trail. No LLM calls: transcripts
 * are fabricated rows, so it works with zero keys configured.
 *
 * Usage: pnpm --filter @rabblehq/server seed:demo   (or: mise run seed-demo)
 * Idempotent-ish: refuses to run if a "Deploy Gate" agent already exists.
 */
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "./client.js";
import { hashPassword, encryptSecret, hashAuthToken } from "../crypto.js";
import {
  agents,
  agentLinks,
  agentMcpServers,
  agentSurfaces,
  agentToolConfigs,
  apiKeys,
  auditEvents,
  connections,
  domains,
  mcpServers,
  evalCriteria,
  evalResults,
  evalSuites,
  evalCases,
  caseResults,
  suiteRuns,
  userFavorites,
  grants,
  messages,
  models,
  orgs,
  sessions,
  teamMembers,
  teams,
  users,
} from "./schema.js";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number, jitterHours = 0) =>
  new Date(Date.now() - n * DAY + (jitterHours ? Math.floor(Math.random() * jitterHours * 3600 * 1000) : 0));

export async function seedDemo(): Promise<void> {
  // Org + owner (created if the instance is fresh)
  let [org] = await db.select().from(orgs).limit(1);
  let [owner] = org
    ? await db.select().from(users).where(eq(users.role, "owner")).limit(1)
    : [];
  if (!org) {
    [org] = await db.insert(orgs).values({ name: "Acme Corp" }).returning();
    [owner] = await db
      .insert(users)
      .values({
        orgId: org!.id,
        email: "demo@acme.dev",
        name: "Dana Demo",
        role: "owner",
        passwordHash: hashPassword("demo-password-1"),
      })
      .returning();
    console.log("created owner demo@acme.dev / demo-password-1");
  }
  const orgId = org!.id;

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, "deploy-gate"))
    .limit(1);
  if (existing) {
    console.log("demo data already present — nothing to do");
    return;
  }

  // People
  const teammates = await db
    .insert(users)
    .values(
      [
        { name: "Priya Patel", email: "priya@acme.dev", role: "admin" as const },
        { name: "Marco Silva", email: "marco@acme.dev", role: "member" as const },
        { name: "Yuki Tanaka", email: "yuki@acme.dev", role: "member" as const },
      ].map((u) => ({
        orgId,
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash: hashPassword("demo-password-1"),
      })),
    )
    .returning();
  const everyone = (
    await db.select().from(teams).where(eq(teams.isEveryone, true)).limit(1)
  )[0] ??
    (await db
      .insert(teams)
      .values({ orgId, name: "Everyone", slug: "everyone", isEveryone: true })
      .returning())[0]!;

  const [engineering] = await db
    .insert(teams)
    .values({ orgId, name: "Engineering", slug: "engineering" })
    .returning();
  const [platform] = await db
    .insert(teams)
    .values({ orgId, name: "Platform", slug: "platform", parentTeamId: engineering!.id })
    .returning();
  const [support] = await db
    .insert(teams)
    .values({ orgId, name: "Support", slug: "support" })
    .returning();
  await db.insert(teamMembers).values([
    { teamId: engineering!.id, userId: teammates[0]!.id, teamRole: "lead" as const },
    { teamId: platform!.id, userId: teammates[1]!.id },
    { teamId: support!.id, userId: teammates[2]!.id, teamRole: "lead" as const },
  ]);

  const { ensureBuilderAgent } = await import("./builder.js");
  await ensureBuilderAgent(orgId);

  // Domains
  const [engDomain] = await db
    .insert(domains)
    .values({ orgId, name: "Engineering", slug: "eng-domain" })
    .returning();
  const [supportDomain] = await db
    .insert(domains)
    .values({ orgId, name: "Customer Support", slug: "support-domain" })
    .returning();

  // Models (built-in catalog entries; keys are configured separately)
  const [sonnet] = await db
    .insert(models)
    .values({
      orgId,
      kind: "built-in",
      catalogId: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      protocol: "anthropic",
      modelId: "claude-sonnet-5",
      priceInputPerMtok: "3",
      priceOutputPerMtok: "15",
    })
    .onConflictDoNothing()
    .returning();
  const [haiku] = await db
    .insert(models)
    .values({
      orgId,
      kind: "built-in",
      catalogId: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      protocol: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      priceInputPerMtok: "1",
      priceOutputPerMtok: "5",
    })
    .onConflictDoNothing()
    .returning();
  const sonnetId = sonnet?.id ?? null;
  const haikuId = haiku?.id ?? sonnetId;

  // Agents with identity
  const agentSpecs = [
    {
      name: "Deploy Gate",
      slug: "deploy-gate",
      description: "Owns the deploy checklist and blocks risky releases",
      instructions:
        "You gate production deploys. Check CI status, open incidents, and the release checklist before approving anything. Be strict; a blocked deploy is cheaper than an outage.",
      tone: "Terse and decisive. State the blocking reason first.",
      icon: "⬢",
      color: "amber",
      domainId: engDomain!.id,
      modelId: sonnetId,
    },
    {
      name: "Eng On-Call",
      slug: "eng-on-call",
      description: "CI triage and deploy questions",
      instructions:
        "You help engineers triage CI failures and answer deploy questions. Prefer runbook links over speculation.",
      tone: "Concise. Surface options before any write action.",
      icon: "◈",
      color: "blue",
      domainId: engDomain!.id,
      modelId: sonnetId,
    },
    {
      name: "PR Summarizer",
      slug: "pr-summarizer",
      description: "Digests pull requests into reviewer-ready summaries",
      instructions:
        "Summarize pull requests: intent, risk areas, test coverage, and a suggested review order.",
      tone: "Neutral and structured.",
      icon: "◇",
      color: "purple",
      domainId: engDomain!.id,
      modelId: haikuId,
    },
    {
      name: "Support Triage",
      slug: "support-triage",
      description: "Routes and drafts first responses for support tickets",
      instructions:
        "Classify inbound tickets, draft a first response, and escalate anything mentioning data loss or billing.",
      tone: "Warm, plain language, no jargon.",
      icon: "◉",
      color: "green",
      domainId: supportDomain!.id,
      modelId: haikuId,
    },
    {
      name: "Docs Writer",
      slug: "docs-writer",
      description: "Drafts and refreshes internal documentation",
      instructions: "Write clear internal docs. Prefer examples over abstractions.",
      tone: "Friendly, active voice.",
      icon: "✦",
      color: "blue",
      domainId: null,
      modelId: haikuId,
    },
  ];
  const seededAgents = await db
    .insert(agents)
    .values(
      agentSpecs.map((a) => ({
        orgId,
        slug: a.slug,
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        tone: a.tone,
        icon: a.icon,
        color: a.color,
        domainId: a.domainId,
        modelId: a.modelId,
        status: "active" as const,
        createdBy: owner!.id,
        createdAt: daysAgo(70),
        updatedAt: daysAgo(3),
      })),
    )
    .returning();
  const byName = new Map(seededAgents.map((a) => [a.name, a]));

  // Bounded delegation: Eng On-Call is wired to call two specialists as tools
  // (the "Agents" tab). The edge notes tell the model when to hand off.
  await db.insert(agentLinks).values([
    {
      agentId: byName.get("Eng On-Call")!.id,
      subAgentId: byName.get("PR Summarizer")!.id,
      note: "When a change needs its PR summarized before triage",
    },
    {
      agentId: byName.get("Eng On-Call")!.id,
      subAgentId: byName.get("Docs Writer")!.id,
      note: "For runbook and documentation lookups",
    },
  ]);

  // Grants: domains to teams, one org-wide agent, one personal draft feel
  await db.insert(grants).values([
    {
      orgId,
      subjectType: "team" as const,
      subjectId: engineering!.id,
      accessRight: "use" as const,
      targetType: "domain" as const,
      targetId: engDomain!.id,
      createdBy: owner!.id,
    },
    {
      orgId,
      subjectType: "team" as const,
      subjectId: support!.id,
      accessRight: "use" as const,
      targetType: "domain" as const,
      targetId: supportDomain!.id,
      createdBy: owner!.id,
    },
    {
      orgId,
      subjectType: "team" as const,
      subjectId: everyone.id,
      accessRight: "use" as const,
      targetType: "agent" as const,
      targetId: byName.get("Docs Writer")!.id,
      createdBy: owner!.id,
    },
    {
      orgId,
      subjectType: "team" as const,
      subjectId: platform!.id,
      accessRight: "edit" as const,
      targetType: "agent" as const,
      targetId: byName.get("Deploy Gate")!.id,
      createdBy: owner!.id,
    },
  ]);

  await db.insert(userFavorites).values([
    { userId: owner!.id, agentId: byName.get("Eng On-Call")!.id },
    { userId: owner!.id, agentId: byName.get("Deploy Gate")!.id },
  ]);

  // Sessions with transcripts spread across ~30 days
  const sessionSpecs: Array<{
    agent: string;
    user: typeof owner;
    title: string;
    ask: string;
    reply: string;
    day: number;
    surface?: string;
    tool?: { name: string; server: string; auth: "service" | "user" };
  }> = [
    {
      agent: "Eng On-Call",
      user: owner,
      title: "Why is the api-gateway build red?",
      ask: "Why is the api-gateway build red?",
      reply:
        "The build is failing in the integration stage: `test_rate_limiter` times out against the shared Redis. It started with #4821 which lowered the connection pool. Recommend reverting the pool change or bumping the test timeout — runbook: go/redis-pools.",
      day: 1,
      tool: { name: "search_ci_runs", server: "GitHub", auth: "service" },
    },
    {
      agent: "Deploy Gate",
      user: teammates[1],
      title: "Clear to ship payments v2?",
      ask: "Clear to ship payments v2?",
      reply:
        "Blocked. Two gating items: SEV-2 #339 (checkout latency) is still open, and the migration dry-run hasn't been attached to the release. Ship after both close — everything else on the checklist is green.",
      day: 2,
    },
    {
      agent: "PR Summarizer",
      user: teammates[0],
      title: "Summarize #4830",
      ask: "Summarize #4830",
      reply:
        "#4830 swaps the retry queue to exponential backoff (risk: duplicate delivery on crash between ack and commit — see queue.ts:88). Tests cover the happy path only. Suggested review order: queue.ts, worker.ts, then the config plumbing.",
      day: 4,
      tool: { name: "read_pull_request", server: "GitHub", auth: "service" },
    },
    {
      agent: "Support Triage",
      user: teammates[2],
      title: "Ticket 8841: exports failing",
      ask: "Ticket 8841: exports failing",
      reply:
        "Classified as data-export / P2. Drafted a first response confirming the CSV export bug for workspaces over 10k rows and linking the status page. Escalating to Platform since 3 similar tickets landed this week.",
      day: 6,
      tool: { name: "create_ticket_note", server: "Zendesk", auth: "user" },
    },
    {
      agent: "Docs Writer",
      user: owner,
      title: "Draft the incident review template",
      ask: "Draft the incident review template",
      reply:
        "Drafted `incident-review.md` with sections for timeline, contributing factors, and follow-ups with owners and dates. Kept it to one page — long templates don't get filled in.",
      day: 9,
    },
    {
      agent: "Eng On-Call",
      user: teammates[1],
      title: "Staging deploy stuck at 60%",
      ask: "Staging deploy stuck at 60%",
      reply:
        "The rollout paused on a failing readiness probe in pod api-7f9: the new config expects SESSION_STORE but staging still has the legacy var. Update the staging config map and resume — no code change needed.",
      day: 12,
      surface: "Slack #eng-oncall",
    },
    {
      agent: "Support Triage",
      user: teammates[2],
      title: "Angry ticket from Beacon Ltd",
      ask: "Angry ticket from Beacon Ltd",
      reply:
        "P1 by sentiment and contract size. Drafted an apology + concrete next step (export re-run tonight), and flagged the account team. Do not send the draft without the re-run confirmed.",
      day: 15,
    },
    {
      agent: "PR Summarizer",
      user: owner,
      title: "Weekly review digest",
      ask: "Weekly review digest",
      reply:
        "12 PRs merged, 3 waiting on review over 48h (top: #4844 auth refactor). Riskiest merge: #4839 — it touches the billing webhook path with no new tests.",
      day: 20,
      surface: "Automation · Weekly review digest",
    },
    {
      agent: "Eng On-Call",
      user: teammates[0],
      title: "Deploys are flaky on Fridays",
      ask: "What changed in the deploy pipeline this week?",
      reply:
        "Two changes landed: the artifact cache moved regions (#4808) and the canary window shrank to 10 minutes (#4815). The Friday flakes correlate with the cache move — regional cold starts. Suggest pinning the cache region for the deploy job.",
      day: 5,
      surface: "GitHub acme/api#412",
    },
    {
      agent: "Deploy Gate",
      user: teammates[0],
      title: "Hotfix for the checkout latency",
      ask: "Hotfix for the checkout latency",
      reply:
        "Approved with conditions: single-commit hotfix, feature-flagged, and a rollback owner named in the deploy channel. CI green, no open SEVs against checkout after #339 closed this morning.",
      day: 25,
    },
  ];

  for (const spec of sessionSpecs) {
    const agent = byName.get(spec.agent)!;
    const created = daysAgo(spec.day, 8);
    const [session] = await db
      .insert(sessions)
      .values({
        orgId,
        userId: spec.user!.id,
        agentId: agent.id,
        title: spec.title,
        surface: spec.surface ?? "Web",
        createdAt: created,
        updatedAt: created,
      })
      .returning();
    const toolCalls = spec.tool
      ? [
          {
            id: `demo-${session!.id.slice(0, 8)}`,
            name: spec.tool.name,
            serverName: spec.tool.server,
            input: { ref: spec.title },
            output: "ok",
            authType: spec.tool.auth,
            approval:
              spec.tool.auth === "user"
                ? { status: "approved", decidedByName: spec.user!.name }
                : null,
            durationMs: 740,
          },
        ]
      : [];
    await db.insert(messages).values([
      {
        sessionId: session!.id,
        role: "user",
        content: spec.ask,
        createdAt: created,
      },
      {
        sessionId: session!.id,
        role: "agent",
        content: spec.reply,
        toolCalls,
        inputTokens: 900 + spec.day * 40,
        outputTokens: 350 + spec.day * 25,
        modelId: agent.modelId,
        createdAt: new Date(created.getTime() + 45_000),
      },
    ]);

    // Live-judged criteria results, older ones in the prior window
    const [criterion] = await db
      .select()
      .from(evalCriteria)
      .where(eq(evalCriteria.agentId, agent.id))
      .limit(1);
    const criterionId =
      criterion?.id ??
      (
        await db
          .insert(evalCriteria)
          .values({
            agentId: agent.id,
            name:
              spec.agent === "Support Triage"
                ? "Empathetic and concrete"
                : "Cites a source or runbook",
            description: "The reply grounds its answer instead of speculating",
            createdAt: daysAgo(65),
          })
          .returning()
      )[0]!.id;
    await db.insert(evalResults).values({
      criterionId,
      sessionId: session!.id,
      passed: spec.day % 7 !== 0, // a couple of failures for realism
      reasoning:
        spec.day % 7 !== 0
          ? "Names the failing job and links the runbook."
          : "Asserts a cause without evidence from the logs.",
      createdAt: new Date(created.getTime() + 90_000),
    });
  }

  // Older results (prior 30d window) so trends have a baseline
  for (const agent of seededAgents.slice(0, 3)) {
    const [criterion] = await db
      .select()
      .from(evalCriteria)
      .where(eq(evalCriteria.agentId, agent.id))
      .limit(1);
    if (!criterion) continue;
    const [oldSession] = await db
      .insert(sessions)
      .values({
        orgId,
        userId: owner!.id,
        agentId: agent.id,
        title: "Archive: earlier evaluation window",
        createdAt: daysAgo(45),
        updatedAt: daysAgo(45),
      })
      .returning();
    for (let i = 0; i < 4; i++) {
      await db.insert(evalResults).values({
        criterionId: criterion.id,
        sessionId: oldSession!.id,
        passed: i % 2 === 0, // 50% baseline; recent window trends up
        reasoning: "Prior-window sample",
        createdAt: daysAgo(40 + i),
      });
    }
  }

  // A suite with a run for Deploy Gate
  const [suite] = await db
    .insert(evalSuites)
    .values({
      agentId: byName.get("Deploy Gate")!.id,
      name: "Release checklist",
      gating: true,
      createdAt: daysAgo(50),
    })
    .returning();
  const caseRows = await db
    .insert(evalCases)
    .values([
      {
        suiteId: suite!.id,
        name: "Blocks on open SEV",
        input: "Clear to deploy with SEV-1 #100 open?",
        rubric: "The reply refuses and cites the open incident",
      },
      {
        suiteId: suite!.id,
        name: "Approves a clean release",
        input: "Checklist green, no incidents — ship v3.2?",
        rubric: "The reply approves and restates the conditions",
      },
    ])
    .returning();
  const [run] = await db
    .insert(suiteRuns)
    .values({ suiteId: suite!.id, status: "completed", completedAt: daysAgo(2) })
    .returning();
  for (const c of caseRows) {
    await db.insert(caseResults).values({
      runId: run!.id,
      caseId: c.id,
      passed: true,
      output: "Deterministic checklist behavior verified.",
      reasoning: "Matches the rubric.",
    });
  }

  // Trust-loop flavor: one recorded scope violation and one verdict in review
  const { scopeViolations } = await import("./schema.js");
  const docsWriter = byName.get("Docs Writer")!;
  await db.insert(scopeViolations).values({
    orgId,
    agentId: docsWriter.id,
    toolName: "delete_wiki_space",
    createdAt: daysAgo(8),
  });
  const [disputable] = await db
    .select()
    .from(evalResults)
    .limit(1);
  if (disputable) {
    await db
      .update(evalResults)
      .set({ reviewStatus: "open", disputedBy: owner!.id, disputedAt: daysAgo(1) })
      .where(eq(evalResults.id, disputable.id));
  }

  // Audit trail flavor
  await db.insert(auditEvents).values(
    [
      ["agent.create", 'Created agent "Deploy Gate"', 70],
      ["grant.set", "Granted Engineering use on domain Engineering", 69],
      ["eval.suite.create", 'Created eval suite "Release checklist"', 50],
      ["eval.gate.pass", 'Gating suite "Release checklist" passed (2/2) for a change to "Deploy Gate"', 2],
      ["member.update", "Set Priya Patel's role to admin", 30],
    ].map(([action, summary, day]) => ({
      orgId,
      actorUserId: owner!.id,
      action: action as string,
      targetType: "org",
      targetId: orgId,
      summary: summary as string,
      createdAt: daysAgo(day as number),
    })),
  );
  // A blocked change carries structured detail (the failing case + the
  // judge's reasoning) — expandable in the Audit log viewer.
  await db.insert(auditEvents).values({
    orgId,
    actorUserId: teammates[0]!.id, // Priya tried to loosen the checklist
    action: "eval.gate.block",
    targetType: "agent",
    targetId: byName.get("Deploy Gate")!.id,
    summary:
      'Gating suite "Release checklist" blocked a change to "Deploy Gate" (1/2 cases failed)',
    metadata: {
      suiteName: "Release checklist",
      failures: [
        {
          case: "Blocks a deploy with an open Sev-1",
          reasoning:
            "The revised checklist approved the deploy despite an open Sev-1 incident.",
        },
      ],
    },
    createdAt: daysAgo(6),
  });

  // Connections + surfaces: the delivery story. A Slack workspace on Socket
  // Mode and a GitHub app, each mapped to an agent, so Admin › Connections
  // and the agent Surfaces tab aren't empty in the demo. Secrets are
  // encrypted like production; they're throwaway placeholders here.
  const [slackConn] = await db
    .insert(connections)
    .values({
      orgId,
      vendor: "slack",
      name: "Acme Slack",
      roles: ["Interface"],
      baseUrl: null,
      encryptedToken: encryptSecret("xoxb-demo-placeholder"),
      encryptedSigningSecret: encryptSecret("demo-signing-secret"),
      encryptedAppToken: encryptSecret("xapp-demo-placeholder"),
      status: "connected" as const,
      createdAt: daysAgo(58),
    })
    .returning();
  const [githubConn] = await db
    .insert(connections)
    .values({
      orgId,
      vendor: "github",
      name: "Acme GitHub",
      roles: ["Interface", "Tools"],
      baseUrl: null,
      encryptedToken: encryptSecret("ghp-demo-placeholder"),
      encryptedSigningSecret: encryptSecret("demo-webhook-secret"),
      status: "connected" as const,
      createdAt: daysAgo(52),
    })
    .returning();
  await db.insert(agentSurfaces).values([
    {
      agentId: byName.get("Eng On-Call")!.id,
      connectionId: slackConn!.id,
      label: "#eng-oncall",
      createdAt: daysAgo(58),
    },
    {
      agentId: byName.get("PR Summarizer")!.id,
      connectionId: githubConn!.id,
      label: "acme/api",
      createdAt: daysAgo(52),
    },
  ]);
  await db.insert(auditEvents).values([
    {
      orgId,
      actorUserId: owner!.id,
      action: "connection.add",
      targetType: "connection",
      targetId: slackConn!.id,
      summary: 'Added slack connection "Acme Slack"',
      createdAt: daysAgo(58),
    },
    {
      orgId,
      actorUserId: owner!.id,
      action: "connection.add",
      targetType: "connection",
      targetId: githubConn!.id,
      summary: 'Added github connection "Acme GitHub"',
      createdAt: daysAgo(52),
    },
  ]);

  // A read-scoped API key (hash only — the plaintext was shown once at
  // creation, exactly like production) so Admin › API keys isn't empty.
  await db.insert(apiKeys).values({
    orgId,
    name: "CI dashboard (read-only)",
    scope: "read" as const,
    prefix: "rbl_ci",
    keyHash: hashAuthToken(`rbl_ci_${"demo".repeat(8)}`),
    createdBy: owner!.id,
    createdAt: daysAgo(40),
    lastUsedAt: daysAgo(0, 6),
  });

  // MCP servers + per-agent tool grants: the tool-governance story. Without
  // these the directory shows every agent at "0 tools" and Admin › MCP is
  // empty, even though sessions reference tool calls. One tool is user-auth
  // so the approval/scope story has something to point at.
  const [githubMcp] = await db
    .insert(mcpServers)
    .values({
      orgId,
      slug: "github",
      name: "GitHub",
      url: "https://mcp.acme.dev/github",
      category: "Tools",
      tools: [
        { name: "search_repos", description: "Search repositories in the org" },
        { name: "search_ci_runs", description: "Look up recent CI runs for a repo" },
        { name: "create_issue", description: "Open an issue (acts as the calling user)" },
      ],
      status: "connected" as const,
      createdAt: daysAgo(55),
    })
    .returning();
  const [datadogMcp] = await db
    .insert(mcpServers)
    .values({
      orgId,
      slug: "datadog",
      name: "Datadog",
      url: "https://mcp.acme.dev/datadog",
      category: "Tools",
      tools: [{ name: "query_metrics", description: "Query a metric timeseries" }],
      status: "connected" as const,
      createdAt: daysAgo(48),
    })
    .returning();
  // Server-level attachment (what "used by" counts) mirrors the per-tool
  // grants below — an agent attaches a server, then enables tools on it.
  await db.insert(agentMcpServers).values([
    { agentId: byName.get("Eng On-Call")!.id, serverId: githubMcp!.id },
    { agentId: byName.get("Eng On-Call")!.id, serverId: datadogMcp!.id },
    { agentId: byName.get("Deploy Gate")!.id, serverId: githubMcp!.id },
    { agentId: byName.get("PR Summarizer")!.id, serverId: githubMcp!.id },
  ]);
  await db.insert(agentToolConfigs).values([
    // Eng On-Call reads CI as the service account, but opening an issue
    // acts as the user — so it needs an approval each time.
    {
      agentId: byName.get("Eng On-Call")!.id,
      serverId: githubMcp!.id,
      toolName: "search_ci_runs",
      authType: "service" as const,
    },
    {
      agentId: byName.get("Eng On-Call")!.id,
      serverId: githubMcp!.id,
      toolName: "create_issue",
      authType: "user" as const,
    },
    {
      agentId: byName.get("Eng On-Call")!.id,
      serverId: datadogMcp!.id,
      toolName: "query_metrics",
      authType: "service" as const,
    },
    {
      agentId: byName.get("Deploy Gate")!.id,
      serverId: githubMcp!.id,
      toolName: "search_ci_runs",
      authType: "service" as const,
    },
    {
      agentId: byName.get("PR Summarizer")!.id,
      serverId: githubMcp!.id,
      toolName: "search_repos",
      authType: "service" as const,
    },
  ]);
  await db.insert(auditEvents).values([
    {
      orgId,
      actorUserId: owner!.id,
      action: "mcp.add",
      targetType: "mcp_server",
      targetId: githubMcp!.id,
      summary: 'Registered MCP server "GitHub"',
      createdAt: daysAgo(55),
    },
    {
      orgId,
      actorUserId: owner!.id,
      action: "mcp.add",
      targetType: "mcp_server",
      targetId: datadogMcp!.id,
      summary: 'Registered MCP server "Datadog"',
      createdAt: daysAgo(48),
    },
  ]);

  // An open access request (filed via the Builder) so Admin › Access
  // requests demos with real track-record evidence behind the decision.
  const { accessRequests } = await import("./schema.js");
  await db.insert(accessRequests).values({
    orgId,
    requesterUserId: teammates[1]!.id, // Marco (member)
    targetType: "agent",
    targetId: byName.get("Deploy Gate")!.id,
    accessRight: "edit",
    reason: "Deploy Gate keeps missing our staging freeze window — I want to tune its checklist.",
    via: "builder",
    createdAt: daysAgo(0, 4),
  });
  await db.insert(auditEvents).values({
    orgId,
    actorUserId: teammates[1]!.id,
    action: "access.request",
    targetType: "agent",
    targetId: byName.get("Deploy Gate")!.id,
    summary: 'Requested edit on agent "Deploy Gate" via Builder',
    createdAt: daysAgo(0, 4),
  });

  console.log(
    `seeded: ${seededAgents.length} agents, ${sessionSpecs.length} sessions, teams/domains/grants, evals with trends, suite + run, 2 connections with surfaces, 2 MCP servers with tool grants, an API key, an open access request, audit trail`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDemo()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("seed failed:", err);
      await pool.end();
      process.exit(1);
    });
}
