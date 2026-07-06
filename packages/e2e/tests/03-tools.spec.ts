/**
 * MCP tools and the approval flow: register an emulated MCP server, attach
 * it to the agent, flip a tool to user auth, then drive scripted tool calls
 * through the thread — service call inline, user call via the approval card,
 * and a denial. Asserts UI, database transcript, and emulator request log.
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

test("admin: register the emulated GitHub MCP server (tools discovered)", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.getByRole("button", { name: "+ Add server" }).click();
  await page.getByPlaceholder("GitHub").fill("GitHub");
  await page
    .getByPlaceholder("https://mcp.example.com/mcp")
    .fill(`${EMULATOR}/mock/mcp/github`);
  await page.locator(".modal select").selectOption("Code");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "GitHub" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "tools" })).toHaveText("2 tools");

  const servers = await dbQuery<{ slug: string; tools: unknown[] }>(
    "SELECT slug, tools FROM mcp_servers",
  );
  expect(servers).toHaveLength(1);
  expect(servers[0]!.slug).toBe("github");
  expect(servers[0]!.tools.map((t) => (t as { name: string }).name).sort()).toEqual([
    "create_issue",
    "search_repos",
  ]);

  // Server detail: connection card, live re-test, and (empty) used-by list
  await row.click();
  await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible();
  await expect(page.getByText("Not attached to any agent yet.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator(".chip", { hasText: "2 tools" })).toBeVisible();
  await page.getByRole("button", { name: "‹ MCP servers" }).click();
});

test("agent config: attach server, set create_issue to user auth", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "mcp" }).click();
  await page.getByRole("button", { name: "Attach" }).click();

  const issueRow = page.locator(".row", { hasText: "create_issue" });
  await expect(issueRow).toBeVisible();
  await issueRow.locator(".segmented button", { hasText: "user" }).click();

  await expect
    .poll(async () => {
      const configs = await dbQuery<{ tool_name: string; auth_type: string }>(
        "SELECT tool_name, auth_type FROM agent_tool_configs",
      );
      return configs.find((c) => c.tool_name === "create_issue")?.auth_type;
    })
    .toBe("user");

  // The server header summarizes enablement and the auth split
  await expect(page.getByText("2 of 2 enabled")).toBeVisible();
  await expect(page.locator(".chip", { hasText: "1 service" })).toBeVisible();
  await expect(page.locator(".chip", { hasText: "1 user" })).toBeVisible();

  // The MCP server's detail now lists this agent under "Used by"
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.locator(".row", { hasText: "GitHub" }).click();
  await expect(page.locator(".chip", { hasText: "Eng On-Call" })).toContainText(
    "configure →",
  );
});

test("service-auth tool runs inline with no approval", async () => {
  await enqueueToolCall("search_repos", { query: "deploy scripts" });

  await page.locator("nav a[title='Sessions']").click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Find our deploy repos");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.locator(".tool-call", { hasText: "search_repos" }).first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: Find our deploy repos",
    { timeout: 15_000 },
  );
  await expect(page.locator(".approval-card")).toHaveCount(0);

  // Click the chip -> right drawer with input/output and auth chip
  await chip.click();
  await expect(page.locator(".drawer")).toContainText("service auth");
  await expect(page.locator(".drawer")).toContainText("deploy scripts");
  await expect(page.locator(".drawer")).toContainText("acme/api");
  await page.locator(".drawer-close").click();

  // Emulator saw the tools/call
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=mcp/github`)
  ).json()) as { requests: Array<{ path: string }> };
  expect(log.requests.some((r) => r.path === "tools/call")).toBe(true);

  // Transcript recorded the call with service auth
  expect(await pollFirstToolCall("%Find our deploy repos%")).toMatchObject({
    name: "search_repos",
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
  await expect(card).toContainText("scope violations · 30d");
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
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();
  await expect(
    page.locator("div", { hasText: /^1scope violations · 30d$/ }),
  ).toBeVisible();
});

test("audit trail covers the tool governance actions", async () => {
  const audit = await dbQuery<{ action: string }>(
    `SELECT action FROM audit_events
     WHERE action IN ('mcp.register', 'agent.mcp.attach', 'agent.tool.configure')
     ORDER BY action`,
  );
  expect(audit.map((a) => a.action)).toEqual([
    "agent.mcp.attach",
    "agent.tool.configure",
    "mcp.register",
  ]);
});
