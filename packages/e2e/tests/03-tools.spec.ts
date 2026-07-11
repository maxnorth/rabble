/**
 * MCP tools and the approval flow under per-server credential modes. A server
 * is registered as either 'personal' (no org credential; each caller connects
 * their own token and calls act as them, gated by an in-thread approval) or
 * 'shared' (one org bearer token; calls run on the org service account). A
 * tool's identity is DERIVED from its server's mode, not flipped per tool.
 * We register a personal GitHub and a shared Datadog, attach both, connect a
 * personal credential from Profile, then drive scripted tool calls: the
 * shared/service call runs inline, the personal/user call pauses on the
 * approval card (approve / deny / run-as-service / timeout / once-per-session),
 * and a personal server with no connected credential prompts an in-thread
 * "Connect your account" card. Asserts UI, the database transcript, and the
 * emulator request log — including which bearer token rode the wire.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
import { dbQuery, pollFirstToolCall } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;

async function enqueueToolCall(name: string, args: Record<string, unknown>) {
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tool_call", toolName: name, toolArgs: args }),
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/");
  await page.locator("input[type=email]").fill("alex@acme.com");
  await page.locator("input[type=password]").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();
});

test.afterAll(async () => {
  await page.close();
});

test("admin: register the emulated GitHub MCP server (personal credential)", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.getByRole("button", { name: "+ Add server" }).click();
  await page.getByPlaceholder("GitHub").fill("GitHub");
  await page
    .getByPlaceholder("https://mcp.example.com/mcp")
    .fill(`${EMULATOR}/mock/mcp/github`);
  await page.locator(".modal .field", { hasText: "Category" }).locator("select").selectOption("Code");
  // Credential mode: Personal — each user connects their own token.
  await page
    .locator(".modal .field", { hasText: "Credential" })
    .locator("select")
    .selectOption("personal");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "GitHub" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "tools" })).toHaveText("2 tools");
  await expect(row.locator(".chip", { hasText: "personal" })).toBeVisible();

  const servers = await dbQuery<{ slug: string; credential_mode: string; tools: unknown[] }>(
    "SELECT slug, credential_mode, tools FROM mcp_servers",
  );
  expect(servers).toHaveLength(1);
  expect(servers[0]!.slug).toBe("github");
  expect(servers[0]!.credential_mode).toBe("personal");
  expect(servers[0]!.tools.map((t) => (t as { name: string }).name).sort()).toEqual([
    "create_issue",
    "search_repos",
  ]);

  // Server detail: credential chip, live re-test, and (empty) used-by list
  await row.click();
  await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible();
  await expect(page.getByText("Not attached to any agent yet.")).toBeVisible();
  await expect(page.locator(".chip", { hasText: "personal credential" })).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator(".chip", { hasText: "2 tools" })).toBeVisible();
  await page.getByRole("button", { name: "‹ MCP servers" }).click();
});

test("admin: register a shared-credential server (Datadog)", async () => {
  await page.getByRole("button", { name: "+ Add server" }).click();
  await page.getByPlaceholder("GitHub").fill("Datadog");
  await page
    .getByPlaceholder("https://mcp.example.com/mcp")
    .fill(`${EMULATOR}/mock/mcp/datadog`);
  await page.locator(".modal .field", { hasText: "Category" }).locator("select").selectOption("Ops");
  // Shared: one org bearer token; calls run as the org service account.
  await page
    .locator(".modal .field", { hasText: "Credential" })
    .locator("select")
    .selectOption("shared");
  await page.locator(".modal input[type=password]").fill("ddog-service-token");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "Datadog" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "shared" })).toBeVisible();
  await expect(row.locator(".chip.blue")).toHaveText("1 tool");

  const [ddog] = await dbQuery<{ credential_mode: string }>(
    "SELECT credential_mode FROM mcp_servers WHERE slug = 'datadog'",
  );
  expect(ddog!.credential_mode).toBe("shared");
});

test("agent config: attach both servers; tools show derived identity", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "mcp" }).click();

  // Attach both servers from the library — no per-tool auth control anymore.
  await page.locator(".row", { hasText: "GitHub" }).getByRole("button", { name: "Attach" }).click();
  await page
    .locator(".row", { hasText: "Datadog" })
    .getByRole("button", { name: "Attach" })
    .click();

  // Each tool's identity is DERIVED from its server's credential mode: a
  // personal server's tools are user-auth (amber), a shared server's are
  // service-auth (green).
  const issueRow = page.locator(".row", { hasText: "create_issue" });
  await expect(issueRow).toBeVisible();
  await expect(issueRow.locator(".chip.amber", { hasText: "personal" })).toBeVisible();
  const metricRow = page.locator(".row", { hasText: "query_metrics" });
  await expect(metricRow).toBeVisible();
  await expect(metricRow.locator(".chip.green", { hasText: "service" })).toBeVisible();

  // Per-server header summaries reflect the split.
  await expect(page.locator(".chip", { hasText: "2 personal" })).toBeVisible();
  await expect(page.locator(".chip", { hasText: "1 service" })).toBeVisible();

  // The MCP server's detail now lists this agent under "Used by"
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.locator(".row", { hasText: "GitHub" }).click();
  await expect(page.locator(".chip", { hasText: "Eng On-Call" })).toContainText(
    "configure →",
  );
});

test("profile: connect a personal GitHub credential", async () => {
  // Alex connects his own GitHub token so downstream create_issue calls act
  // as him (rather than prompting a connect card). Runs before the approval
  // tests below; the credential persists for the whole serial run.
  await page.locator("nav a[title*='profile']").click();
  const mcpAccounts = page.locator(
    '.sidebar-title:has-text("MCP tool accounts") + .row-group',
  );
  const ghRow = mcpAccounts.locator(".row", { hasText: "GitHub" });
  await ghRow.getByRole("button", { name: "Connect" }).click();
  await ghRow.getByPlaceholder("Your token").fill("alex-github-token");
  await ghRow.getByRole("button", { name: "Save" }).click();
  await expect(ghRow.locator(".chip", { hasText: "connected" })).toBeVisible();

  const creds = await dbQuery<{ email: string }>(
    `SELECT u.email FROM user_mcp_credentials c
       JOIN users u ON u.id = c.user_id
       JOIN mcp_servers s ON s.id = c.server_id
      WHERE u.email = 'alex@acme.com' AND s.slug = 'github'`,
  );
  expect(creds).toHaveLength(1);
});

test("service-auth tool runs inline with no approval", async () => {
  await enqueueToolCall("query_metrics", { metric: "deploys" });

  await page.locator("nav a[title='Sessions']").click();
  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Find our deploy repos");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.locator(".tool-call", { hasText: "query_metrics" }).first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: Find our deploy repos",
    { timeout: 15_000 },
  );
  await expect(page.locator(".approval-card")).toHaveCount(0);

  // Click the chip -> right drawer with input/output and auth chip
  await chip.click();
  await expect(page.locator(".drawer")).toContainText("service auth");
  await expect(page.locator(".drawer")).toContainText("deploys");
  await page.locator(".drawer-close").click();

  // Emulator saw the tools/call at the Datadog host, carrying the shared
  // org token on the wire.
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=mcp/datadog`)
  ).json()) as {
    requests: Array<{ path: string; body: { name?: string; auth?: string | null } }>;
  };
  expect(log.requests.some((r) => r.path === "tools/call")).toBe(true);
  const metricCall = log.requests.find(
    (r) => r.path === "tools/call" && r.body?.name === "query_metrics",
  );
  expect(metricCall).toBeDefined();
  expect(metricCall!.body.auth).toBe("ddog-service-token");

  // Transcript recorded the call with service auth
  expect(await pollFirstToolCall("%Find our deploy repos%")).toMatchObject({
    name: "query_metrics",
    authType: "service",
  });
});

test("user-auth tool pauses on the approval card; approve runs it", async () => {
  await enqueueToolCall("create_issue", { title: "Fix flaky deploy" });

  await page.locator(".thread-composer textarea").fill("File an issue about the flaky deploy");
  await page.locator(".thread-composer button", { hasText: "Send" }).click();

  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("create_issue");
  await expect(card).toContainText("acting as you");
  // Evidence strip: track record + the safety half
  await expect(card).toContainText("scope violation");
  await expect(card).toContainText("· 30d");
  await card.getByRole("button", { name: "Approve as me" }).click();

  // Wait for THIS turn's reply (the echo includes this turn's user text)
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File an issue about the flaky deploy",
    { timeout: 15_000 },
  );

  expect(await pollFirstToolCall("%File an issue about the flaky deploy%")).toMatchObject({
    name: "create_issue",
    authType: "user",
    approval: { status: "approved", decidedByName: "Alex Lin" },
  });

  // The user's OWN connected credential rode the wire — not the org's.
  const ghLog = (await (
    await fetch(`${EMULATOR}/admin/requests?host=mcp/github`)
  ).json()) as {
    requests: Array<{ path: string; body: { name?: string; auth?: string | null } }>;
  };
  const issueCalls = ghLog.requests.filter(
    (r) => r.path === "tools/call" && r.body?.name === "create_issue",
  );
  expect(issueCalls.length).toBeGreaterThan(0);
  expect(issueCalls[issueCalls.length - 1]!.body.auth).toBe("alex-github-token");
});

test("once-per-session posture: the next user-auth call auto-approves", async () => {
  // Alex's default posture is "Once per session" — the approval above
  // covers the rest of this session, so this call runs without a card.
  await enqueueToolCall("create_issue", { title: "Follow-up issue" });

  await page.locator(".thread-composer textarea").fill("File a follow-up issue too");
  await page.locator(".thread-composer button", { hasText: "Send" }).click();

  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File a follow-up issue too",
    { timeout: 15_000 },
  );
  await expect(page.locator(".approval-card")).toHaveCount(0);

  expect(await pollFirstToolCall("%File a follow-up issue too%")).toMatchObject({
    name: "create_issue",
    authType: "user",
    approval: { status: "auto-approved", decidedByName: "Alex Lin" },
  });
});

test("denying the approval blocks the tool and records the denial", async () => {
  await enqueueToolCall("create_issue", { title: "Should not exist" });

  // A fresh session: once-per-session approval doesn't carry over, so the
  // approval card comes back.
  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("File another issue");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Deny" }).click();

  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File another issue",
    { timeout: 15_000 },
  );

  expect(await pollFirstToolCall("%File another issue%")).toMatchObject({
    name: "create_issue",
    approval: { status: "denied" },
    output: "The user declined this action.",
  });
});

test("run-as-service keeps the action off the user's identity", async () => {
  await enqueueToolCall("create_issue", { title: "Service-run issue" });

  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("File it under the service account");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Run as service account" }).click();

  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File it under the service account",
    { timeout: 15_000 },
  );
  expect(
    await pollFirstToolCall("%File it under the service account%"),
  ).toMatchObject({
    name: "create_issue",
    approval: { status: "ran-as-service", decidedByName: "Alex Lin" },
  });
});

test("an unanswered approval times out and the tool is not run", async () => {
  test.setTimeout(90_000); // spans the full 15s broker window; needs headroom
  await enqueueToolCall("create_issue", { title: "Never approved" });

  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("File the ignored issue");
  await page.getByRole("button", { name: "Send" }).click();

  // Nobody clicks. The broker times out (15s in e2e) and the turn completes.
  // This test inherently spans the full broker window, so give the waits
  // generous headroom — under CI/host load the card + post-timeout reply can
  // run long, and a premature assertion failure here would cascade (serial
  // mode) into the scope-violation setup below.
  await expect(page.locator(".approval-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File the ignored issue",
    { timeout: 40_000 },
  );
  expect(await pollFirstToolCall("%File the ignored issue%")).toMatchObject({
    name: "create_issue",
    approval: { status: "timed-out", decidedByName: null },
    output: "The user declined this action.",
  });
});

test("sub-agent delegation: a linked agent runs as a governed tool", async () => {
  // A child agent with a model — created via API for brevity.
  const modelsRes = (await (await page.request.get("/api/models")).json()) as {
    models: Array<{ id: string; enabled: boolean }>;
  };
  const modelId = (modelsRes.models.find((m) => m.enabled) ?? modelsRes.models[0]!).id;
  const created = (await (
    await page.request.post("/api/agents", {
      data: {
        name: "Docs Helper",
        description: "Answers questions about the docs",
        instructions: "Help with documentation.",
        modelId,
        status: "active",
      },
    })
  ).json()) as { agent: { id: string; slug: string } };
  const childId = created.agent.id;

  try {
    // Wire it under Eng On-Call through the governed attach UI, note the edge.
    await page.locator("nav a[title='Agents']").click();
    await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
    await page.locator(".tabs button", { hasText: "Agents" }).click();
    await page
      .locator(".row", { hasText: "Docs Helper" })
      .getByRole("button", { name: "Attach" })
      .click();
    const linkedRow = page
      .locator(".row", { hasText: "Docs Helper" })
      .filter({ has: page.locator(".chip.purple") });
    await expect(linkedRow).toBeVisible();
    const note = page.locator("input[placeholder*='When is it called']");
    await note.fill("For anything about the docs");
    await note.blur();

    // The parent's model delegates on its next call.
    await enqueueToolCall("ask_docs_helper", { task: "Summarize the deploy runbook" });

    // Start a session targeted at Eng On-Call.
    await page.locator("nav a[title='Sessions']").click();
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("Ask docs helper about the runbook");
    await page.getByRole("button", { name: "Send" }).click();

    // The delegation surfaces as an inline call, rendered as an agent
    // hand-off ("Delegated to Docs Helper") rather than a raw tool name.
    const chip = page
      .locator(".tool-call", { hasText: "Delegated to Docs Helper" })
      .first();
    await expect(chip).toBeVisible({ timeout: 15_000 });

    // The transcript is the source of truth (the tool-call chip's output can
    // still be catching up in the SSE stream): the persisted call carries the
    // child's reply, folded back as the delegation tool's output.
    const toolCall = await pollFirstToolCall("%Ask docs helper about the runbook%");
    expect(toolCall).toMatchObject({ name: "ask_docs_helper" });
    expect(String(toolCall.output)).toContain(
      "Mock reply to: Summarize the deploy runbook",
    );
    // …the edge is audited…
    const audit = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_events WHERE action = 'agent.delegate'",
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // …and a legitimate delegation is NOT logged as a scope violation.
    const violations = await dbQuery<{ tool_name: string }>(
      "SELECT tool_name FROM scope_violations WHERE tool_name = 'ask_docs_helper'",
    );
    expect(violations).toHaveLength(0);

    // The delegated turn is a real, auditable session of the child agent —
    // delegated work lands on the sub-agent's own record, not just an
    // ephemeral tool call.
    const [childSession] = await dbQuery<{ id: string; surface: string; content: string }>(
      `SELECT s.id, s.surface, m.content
         FROM sessions s
         JOIN messages m ON m.session_id = s.id AND m.role = 'agent'
        WHERE s.agent_id = $1 AND s.surface = 'Delegated by Eng On-Call'`,
      [childId],
    );
    expect(childSession).toBeDefined();
    expect(childSession!.content).toContain(
      "Mock reply to: Summarize the deploy runbook",
    );
    // The delegation call links to that session for click-through tracing.
    expect(toolCall.childSessionId).toBe(childSession!.id);
    await chip.click();
    await expect(
      page.locator(".drawer").getByRole("link", { name: "view delegated session →" }),
    ).toBeVisible();
    await page.locator(".drawer-close").click();
  } finally {
    // Tidy up so a lingering agent can't skew later specs' routing. The child
    // now owns a delegated session, so clear those first (the delete route
    // refuses an agent with sessions).
    await dbQuery("DELETE FROM sessions WHERE agent_id = $1", [childId]);
    await page.request.delete(`/api/agents/${childId}`);
  }
});

test("an out-of-scope tool attempt is recorded as a violation", async () => {
  // The model goes rogue: it calls a tool the agent was never given.
  await enqueueToolCall("drop_database", { reason: "cleanup" });

  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Tidy things up");
  await page.getByRole("button", { name: "Send" }).click();

  // The turn still completes (the runtime refuses the unknown tool and the
  // model recovers), but the attempt lands on the record.
  await expect(page.locator(".msg-agent .bubble").last()).toContainText("Mock reply", {
    timeout: 15_000,
  });

  await expect
    .poll(async () => {
      const rows = await dbQuery<{ tool_name: string }>(
        "SELECT tool_name FROM scope_violations",
      );
      return rows.map((r) => r.tool_name);
    })
    .toEqual(["drop_database"]);

  // Surfaced on the agent's evals tab as the safety half of the track record
  await page.locator("nav a[title='Agents']").click();
  // ...and flagged right in the directory where people pick agents
  await expect(
    page
      .locator(".dir-table tbody tr", { hasText: "Eng On-Call" })
      .locator(".chip", { hasText: "needs attention" }),
  ).toBeVisible();

  // The governance champion can filter the directory down to flagged agents.
  await page.getByRole("button", { name: "+ Filter" }).click();
  await page.getByRole("button", { name: "Needs attention" }).click();
  await expect(
    page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }),
  ).toBeVisible();
  await expect(
    page.locator(".dir-table tbody tr", { hasText: "Builder" }),
  ).toHaveCount(0);

  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();
  await expect(
    page.locator("div", { hasText: /^1scope violation · 30d$/ }),
  ).toBeVisible();
});

test("outbound web access: fetch obeys the network allowlist", async () => {
  // A dedicated agent whose Advanced tab turns on outbound web access and
  // allowlists only the emulator host.
  const modelsRes = (await (await page.request.get("/api/models")).json()) as {
    models: Array<{ id: string; enabled: boolean }>;
  };
  const modelId = (modelsRes.models.find((m) => m.enabled) ?? modelsRes.models[0]!).id;
  const created = (await (
    await page.request.post("/api/agents", {
      data: {
        name: "Web Fetcher",
        description: "Fetches allowlisted URLs",
        instructions: "Fetch pages when asked.",
        modelId,
        status: "active",
      },
    })
  ).json()) as { agent: { id: string; slug: string } };
  const agentId = created.agent.id;

  try {
    await page.request.patch(`/api/agents/${agentId}`, {
      data: { capabilities: { outboundWebAccess: true, networkAllowlist: "localhost" } },
    });

    // 1) An allowlisted host is fetched and its body folds back as tool output.
    await enqueueToolCall("fetch_url", { url: `${EMULATOR}/mock/web/runbook` });
    await page.locator("nav a[title='Sessions']").click();
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Web Fetcher" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("Fetch the runbook page");
    await page.getByRole("button", { name: "Send" }).click();

    const chip = page.locator(".tool-call", { hasText: "fetch_url" }).first();
    await expect(chip).toBeVisible({ timeout: 15_000 });

    const ok = await pollFirstToolCall("%Fetch the runbook page%");
    expect(ok).toMatchObject({ name: "fetch_url", authType: "service" });
    expect(String(ok.output)).toContain("Hello from the emulated web");
    expect(String(ok.output)).toContain("path: runbook");
    // The emulator actually received the GET.
    const webLog = (await (
      await fetch(`${EMULATOR}/admin/requests?host=web`)
    ).json()) as { requests: Array<{ path: string }> };
    expect(webLog.requests.some((r) => r.path === "/runbook")).toBe(true);

    // 2) A host outside the allowlist is refused before any network call.
    await enqueueToolCall("fetch_url", { url: "https://evil.example.com/steal" });
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Web Fetcher" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("Fetch the evil page");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator(".msg-agent .bubble").last()).toContainText("Mock reply", {
      timeout: 15_000,
    });
    const refused = await pollFirstToolCall("%Fetch the evil page%");
    expect(String(refused.output)).toContain("Refused:");
    expect(String(refused.output)).toContain("not in this agent's network allowlist");
    // Nothing left the box: the emulator never saw evil.example.com.
    const evilLog = (await (
      await fetch(`${EMULATOR}/admin/requests?host=evil.example.com`)
    ).json()) as { requests: unknown[] };
    expect(evilLog.requests).toHaveLength(0);

    // 3) A redirect within the allowlist is followed (localhost -> localhost).
    await enqueueToolCall("fetch_url", {
      url: `${EMULATOR}/mock/web/redirect?to=/mock/web/landed`,
    });
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Web Fetcher" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("Follow the good redirect");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-agent .bubble").last()).toContainText("Mock reply", {
      timeout: 15_000,
    });
    const followed = await pollFirstToolCall("%Follow the good redirect%");
    expect(String(followed.output)).toContain("path: landed");

    // 4) The security-critical case: a redirect that tries to escape the
    // allowlist is re-checked per hop and refused at the second hop, even
    // though the first hop (localhost) is allowed.
    await enqueueToolCall("fetch_url", {
      url: `${EMULATOR}/mock/web/redirect?to=https://evil.example.com/pwn`,
    });
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Web Fetcher" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("Follow the escaping redirect");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-agent .bubble").last()).toContainText("Mock reply", {
      timeout: 15_000,
    });
    const escaped = await pollFirstToolCall("%Follow the escaping redirect%");
    expect(String(escaped.output)).toContain("Refused:");
    expect(String(escaped.output)).toContain("not in this agent's network allowlist");
    // The redirect target was never actually fetched.
    const evilAfter = (await (
      await fetch(`${EMULATOR}/admin/requests?host=evil.example.com`)
    ).json()) as { requests: unknown[] };
    expect(evilAfter.requests).toHaveLength(0);
  } finally {
    await dbQuery("DELETE FROM sessions WHERE agent_id = $1", [agentId]);
    await page.request.delete(`/api/agents/${agentId}`);
  }
});

test("audit trail covers the tool governance actions", async () => {
  // Governance actions in the credential-mode model: registering servers and
  // attaching them to agents (there is no per-tool auth flip to audit).
  const audit = await dbQuery<{ action: string }>(
    `SELECT DISTINCT action FROM audit_events
     WHERE action IN ('mcp.register', 'agent.mcp.attach')
     ORDER BY action`,
  );
  expect(audit.map((a) => a.action)).toEqual([
    "agent.mcp.attach",
    "mcp.register",
  ]);
});

test("mcp servers are editable in place — category changes, tools survive", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.locator(".row", { hasText: "GitHub" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  // Same URL (re-verified against the emulator on save), new category.
  await page.locator(".modal select").selectOption("Ops");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".chip", { hasText: "Ops" })).toBeVisible();

  const [server] = await dbQuery<{ category: string; tools: unknown[] }>(
    "SELECT category, tools FROM mcp_servers WHERE slug = 'github'",
  );
  expect(server!.category).toBe("Ops");
  expect(server!.tools).toHaveLength(2); // tool list re-discovered, intact
  const audit = await dbQuery<{ summary: string }>(
    "SELECT summary FROM audit_events WHERE action = 'mcp.update'",
  );
  expect(audit.length).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "‹ MCP servers" }).click();
});

test("personal server with no credential prompts a connect card, then resumes", async () => {
  // A fresh personal-mode server Alex has NOT connected, attached to a
  // throwaway agent so its tool names don't collide with Eng On-Call's.
  const modelsRes = (await (await page.request.get("/api/models")).json()) as {
    models: Array<{ id: string; enabled: boolean }>;
  };
  const modelId = (modelsRes.models.find((m) => m.enabled) ?? modelsRes.models[0]!).id;
  const created = (await (
    await page.request.post("/api/agents", {
      data: {
        name: "Scratch Agent",
        description: "Throwaway agent for the connect-card flow",
        instructions: "Help.",
        modelId,
        status: "active",
      },
    })
  ).json()) as { agent: { id: string } };
  const agentId = created.agent.id;
  const server = (await (
    await page.request.post("/api/mcp-servers", {
      data: {
        name: "Scratch MCP",
        url: `${EMULATOR}/mock/mcp/github`,
        category: "Tools",
        credentialMode: "personal",
      },
    })
  ).json()) as { server: { id: string } };
  const serverId = server.server.id;

  try {
    await page.request.put(`/api/agents/${agentId}/mcp-servers/${serverId}`);

    await enqueueToolCall("create_issue", { title: "From an unconnected server" });

    await page.locator("nav a[title='Sessions']").click();
    await page.getByRole("link", { name: "+ New session" }).click();
    await page.locator(".target-pill").click();
    await page.locator(".target-menu button", { hasText: "Scratch Agent" }).click();
    await page
      .getByPlaceholder("Describe what you need help with…")
      .fill("File an issue via the unconnected server");
    await page.getByRole("button", { name: "Send" }).click();

    // No connected credential on an interactive web surface -> connect card.
    const connectCard = page.locator(".approval-card", { hasText: "Connect your account" });
    await expect(connectCard).toBeVisible({ timeout: 15_000 });
    await connectCard.locator("input[type=password]").fill("scratch-token");
    await connectCard.getByRole("button", { name: "Connect" }).click();

    // Resuming, the personal call still faces the approval gate (Alex's
    // default posture asks once per session).
    const approveBtn = page.getByRole("button", { name: "Approve as me" });
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });
    await approveBtn.click();

    await expect(page.locator(".msg-agent .bubble").last()).toContainText(
      "Mock reply to: File an issue via the unconnected server",
      { timeout: 15_000 },
    );
    const call = await pollFirstToolCall("%File an issue via the unconnected server%");
    expect(call).toMatchObject({
      name: "create_issue",
      authType: "user",
      approval: { status: "approved", decidedByName: "Alex Lin" },
    });
  } finally {
    // Tidy up so the throwaway server/agent don't perturb later suites.
    await dbQuery("DELETE FROM sessions WHERE agent_id = $1", [agentId]);
    await page.request.delete(`/api/agents/${agentId}`);
    await page.request.delete(`/api/mcp-servers/${serverId}`);
  }
});
