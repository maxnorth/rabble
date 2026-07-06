/**
 * Remaining admin + profile + stats surfaces: Slack connection verified via
 * the emulator, API keys (created through the UI, exercised over HTTP with
 * scope enforcement), the audit log viewer, stats dashboards, and the
 * profile page. Ends with the server-log cleanliness check for the entire
 * suite run.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, request, test, type Page } from "@playwright/test";
import { EMULATOR, serverLogPath } from "../global-setup";
import { dbQuery, pollFirstToolCall } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;
let caseyPassword = "";

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

test("connections: add Slack, verified against the emulator", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.getByPlaceholder("Acme Slack").fill("Acme Slack");
  await page.getByPlaceholder("https://slack.com").fill(`${EMULATOR}/mock/slack.com`);
  await page.locator(".modal input[type=password]").first().fill("xoxb-emulated");
  await page
    .getByPlaceholder("Slack app signing secret")
    .fill("emu-signing-secret");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "Acme Slack" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "connected" })).toBeVisible();

  // The emulator's auth.test endpoint was actually called
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as { requests: Array<{ path: string }> };
  expect(log.requests.some((r) => r.path === "/api/auth.test")).toBe(true);

  const rows = await dbQuery<{ vendor: string; status: string }>(
    "SELECT vendor, status FROM connections",
  );
  expect(rows).toEqual([{ vendor: "slack", status: "connected" }]);
});

test("surfaces: the Slack connection attaches to an agent as a delivery point", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "surfaces" }).click();

  // Web sessions is always on; the Slack interface connection is attachable
  await expect(page.locator(".row", { hasText: "Web sessions" })).toBeVisible();
  await page.locator("select").selectOption({ label: "Acme Slack (slack)" });
  await page.getByPlaceholder("#eng-oncall").fill("#eng-oncall");
  await page.getByRole("button", { name: "Attach surface" }).click();

  const row = page.locator(".row", { hasText: "#eng-oncall" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Acme Slack");

  const surfaces = await dbQuery<{ label: string }>("SELECT label FROM agent_surfaces");
  expect(surfaces).toEqual([{ label: "#eng-oncall" }]);

  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'agent.surface.add'",
  );
  expect(audit).toHaveLength(1);
});

const SERVER = "http://localhost:3178";

function signedSlackPost(body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", "emu-signing-secret")
    .update(`v0:${ts}:${raw}`)
    .digest("hex")}`;
  return fetch(`${SERVER}/api/inbound/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

test("slack surface delivery: a channel message becomes a governed session", async () => {
  // Teach the emulated workspace who's who
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: { U777: "alex@acme.com", U888: "stranger@elsewhere.io" },
      channels: { C777: "eng-oncall" },
    }),
  });

  // Slack's URL handshake
  const verification = await signedSlackPost({
    type: "url_verification",
    challenge: "chz-123",
  });
  expect(((await verification.json()) as { challenge: string }).challenge).toBe(
    "chz-123",
  );

  // A bad signature is rejected outright
  const forged = await fetch(`${SERVER}/api/inbound/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=deadbeef",
    },
    body: JSON.stringify({ type: "event_callback" }),
  });
  expect(forged.status).toBe(401);

  // Alex posts in #eng-oncall — the channel the agent surface maps
  const delivery = await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U777",
      text: "Deploy status from Slack?",
      ts: "1712.001",
    },
  });
  expect(delivery.status).toBe(200);
  const deliveryBody = (await delivery.json()) as Record<string, unknown>;
  expect(deliveryBody).toEqual({ ok: true, sessionId: expect.any(String) });

  const [session] = await dbQuery<{
    id: string;
    surface: string;
    title: string;
  }>(
    "SELECT id, surface, title FROM sessions WHERE surface_key = 'slack:C777:1712.001'",
  );
  expect(session).toBeDefined();
  expect(session!.surface).toBe("Slack #eng-oncall");
  expect(session!.title).toBe("Deploy status from Slack?");

  const rows = await dbQuery<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at",
    [session!.id],
  );
  expect(rows.map((m) => m.role)).toEqual(["user", "agent"]);
  expect(rows[1]!.content).toBe("Mock reply to: Deploy status from Slack?");

  // The reply threaded back into Slack
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as {
    requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
  };
  const posted = log.requests.filter((r) => r.path === "/api/chat.postMessage");
  expect(
    posted.some(
      (r) =>
        r.body.thread_ts === "1712.001" &&
        r.body.text?.includes("Mock reply to: Deploy status from Slack?"),
    ),
  ).toBe(true);

  // A follow-up in the same thread lands in the SAME session
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U777",
      text: "And staging?",
      ts: "1712.002",
      thread_ts: "1712.001",
    },
  });
  const followUp = await dbQuery<{ role: string }>(
    "SELECT role FROM messages WHERE session_id = $1 ORDER BY created_at",
    [session!.id],
  );
  expect(followUp.map((m) => m.role)).toEqual(["user", "agent", "user", "agent"]);

  // Someone without a Rabble account gets a polite refusal, not a session
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U888",
      text: "Let me in",
      ts: "1712.099",
    },
  });
  const ghost = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE surface_key = 'slack:C777:1712.099'",
  );
  expect(ghost).toHaveLength(0);
  const refusals = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as { requests: Array<{ path: string; body: { text?: string } }> };
  expect(
    refusals.requests.some((r) =>
      r.body?.text?.includes("I can only act for Rabble users"),
    ),
  ).toBe(true);

  // The session shows up in Alex's web app with its surface chip
  await page.locator("nav a[title='Sessions']").click();
  await page
    .locator(".sidebar-item", { hasText: "Deploy status from Slack?" })
    .click();
  await expect(page.locator(".chip", { hasText: "Slack #eng-oncall" })).toBeVisible();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: And staging?",
  );
});

test("automations: Run now executes a governed session on the Automation surface", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "automations" }).click();

  await page.getByPlaceholder("Morning digest").fill("Morning digest");
  await page
    .getByPlaceholder("What the agent should do on each run")
    .fill("Summarize overnight incidents");
  await page.getByRole("button", { name: "+ Add automation" }).click();
  const row = page.locator(".row", { hasText: "Morning digest" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.getByRole("link", { name: "view session →" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(row).toContainText("last ran");

  const [session] = await dbQuery<{ id: string; surface: string }>(
    "SELECT id, surface FROM sessions WHERE surface LIKE 'Automation%'",
  );
  expect(session!.surface).toBe("Automation · Morning digest");
  const transcript = await dbQuery<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at",
    [session!.id],
  );
  expect(transcript.map((m) => m.role)).toEqual(["user", "agent"]);
  expect(transcript[0]!.content).toBe("Summarize overnight incidents");
  expect(transcript[1]!.content).toBe("Mock reply to: Summarize overnight incidents");
  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'automation.run'",
  );
  expect(audit).toHaveLength(1);

  // The run's session opens like any other, on its surface
  await row.getByRole("link", { name: "view session →" }).click();
  await expect(page.locator(".chip", { hasText: "Automation · Morning digest" })).toBeVisible();
  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: Summarize overnight incidents",
  );
});

test("api keys: read scope is enforced over HTTP", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "API keys" }).click();
  await page.getByPlaceholder("Key name, e.g. CI pipeline").fill("CI pipeline");
  await page.getByRole("button", { name: "+ Create key" }).click();

  const tokenCard = page.locator(".card", { hasText: "Copy this key now" });
  await expect(tokenCard).toBeVisible();
  const token = (await tokenCard.locator("code").innerText()).trim();
  expect(token).toMatch(/^rbl_/);

  const anon = await request.newContext({ baseURL: "http://localhost:3178" });
  const authed = { Authorization: `Bearer ${token}` };

  const list = await anon.get("/api/agents", { headers: authed });
  expect(list.status()).toBe(200);

  const write = await anon.post("/api/agents", {
    headers: authed,
    data: { name: "Should Fail" },
  });
  expect(write.status()).toBe(403);

  const admin = await anon.get("/api/audit", { headers: authed });
  expect(admin.status()).toBe(403);

  // Revoke, then the key stops working entirely
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator(".chip", { hasText: "revoked" })).toBeVisible();
  const afterRevoke = await anon.get("/api/agents", { headers: authed });
  expect(afterRevoke.status()).toBe(401);
  await anon.dispose();
});

test("audit log viewer shows the accumulated control-plane history", async () => {
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.locator(".row", { hasText: "Created agent" }).first()).toBeVisible();
  await expect(page.locator(".row", { hasText: "Registered MCP server" })).toBeVisible();
  await expect(page.locator(".row", { hasText: "Created API key" })).toBeVisible();

  // Filter by action prefix
  await page.locator("select").selectOption("grant");
  await expect(page.locator(".row", { hasText: "Granted" }).first()).toBeVisible();
  await expect(page.locator(".row", { hasText: "Created API key" })).toHaveCount(0);
});

test("stats dashboards reflect real usage", async () => {
  await page.locator("nav a[title='Stats']").click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  // KPIs are populated from the sessions the suite created
  const sessionsKpi = page.locator(".kpi", { hasText: "Sessions" }).first();
  await expect
    .poll(async () => Number(await sessionsKpi.locator(".value").innerText()))
    .toBeGreaterThan(2);

  await expect(page.locator(".chart-card", { hasText: "Sessions per agent" })).toContainText(
    "Eng On-Call",
  );

  // Skill use tab: auth-type split from the MCP calls in 03-tools
  await page.locator(".sidebar-item", { hasText: "Skill use" }).click();
  await expect(
    page.locator(".chart-card", { hasText: "Tool calls by auth type" }),
  ).toContainText("service");
  await expect(page.locator(".chart-card", { hasText: "Calls by tool" })).toContainText(
    "search_repos",
  );

  // Eval performance tab: the judged session from 04-evals shows up per agent
  await page.locator(".sidebar-item", { hasText: "Eval performance" }).click();
  await expect(
    page.locator(".chart-card", { hasText: "Pass rate by agent" }),
  ).toContainText("Eng On-Call");

  // Usage & spend tab: token usage recorded from the emulator's usage blocks
  await page.locator(".sidebar-item", { hasText: "Usage & spend" }).click();
  await expect(page.locator(".kpi", { hasText: "Output tokens" })).toBeVisible();

  // Spend: the Mock Model is priced ($3/$15 per MTok), so the emulator's
  // usage blocks produce a real (tiny) dollar figure.
  const spendKpi = page.locator(".kpi", { hasText: "Spend" }).first();
  await expect(spendKpi.locator(".value")).toContainText("$");
  await expect(
    page.locator(".chart-card", { hasText: "Spend by agent" }),
  ).toContainText("Eng On-Call");
  await expect(
    page.locator(".chart-card", { hasText: "Token use by model" }),
  ).toContainText("Mock Model");
  await expect(
    page.locator(".chart-card", { hasText: "Turns per session" }).locator(".bar-row").first(),
  ).toBeVisible();

  // Filtering to one agent narrows the numbers without erroring
  await page.locator("select[title='Filter by agent']").selectOption({ label: "Eng On-Call" });
  const filteredSessions = page.locator(".kpi", { hasText: "Sessions" }).first();
  await expect
    .poll(async () => Number(await filteredSessions.locator(".value").innerText()))
    .toBeGreaterThan(0);
  await page.locator("select[title='Filter by agent']").selectOption("");
});

test("profile: connected account and approval posture persist", async () => {
  await page.locator("nav a[title*='profile']").click();

  // Connect a personal GitHub token inline on the vendor row
  const githubRow = page.locator(".row", { hasText: "GitHub" });
  await githubRow.getByRole("button", { name: "Connect" }).click();
  await githubRow.getByPlaceholder("Token").fill("gho_personal");
  await githubRow.getByRole("button", { name: "Save" }).click();
  await expect(githubRow.locator(".chip", { hasText: "connected" })).toBeVisible();

  const accounts = await dbQuery<{ vendor: string; encrypted_token: string }>(
    "SELECT vendor, encrypted_token FROM user_connected_accounts",
  );
  expect(accounts[0]!.vendor).toBe("github");
  expect(accounts[0]!.encrypted_token).toMatch(/^v1:/);
  expect(accounts[0]!.encrypted_token).not.toContain("gho_personal");

  // Trust posture saves and persists (stored as "trust")
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page.getByRole("button", { name: "Trust me" }).click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  const prefs = await dbQuery<{ preferences: { approvalPosture: string } }>(
    "SELECT preferences FROM users WHERE email = 'alex@acme.com'",
  );
  expect(prefs[0]!.preferences.approvalPosture).toBe("trust");
});

test("preferences: collapsed tool calls hide chips until expanded", async () => {
  // Turn "Show tool calls inline" off
  await page.locator("nav a[title*='profile']").click();
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page
    .locator(".row", { hasText: "Show tool calls inline" })
    .locator(".toggle")
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  // The MCP session from the tools journey now collapses its call
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".sidebar-item", { hasText: "Find our deploy repos" }).click();
  await expect(page.locator(".tool-call")).toHaveCount(0);
  await page.getByRole("button", { name: "1 tool call · show" }).first().click();
  await expect(page.locator(".tool-call", { hasText: "search_repos" })).toBeVisible();

  // Restore the default so later flows see inline chips
  await page.locator("nav a[title*='profile']").click();
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page
    .locator(".row", { hasText: "Show tool calls inline" })
    .locator(".toggle")
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
});

test("with trust posture, user-auth tools skip the card", async () => {
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "Auto-approved issue" },
    }),
  });

  // Target Eng On-Call explicitly — Auto resolves alphabetically and would
  // pick Claude Agent, which has no tools attached.
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("File the auto issue");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File the auto issue",
    { timeout: 15_000 },
  );
  await expect(page.locator(".approval-card")).toHaveCount(0);

  expect(await pollFirstToolCall("%File the auto issue%")).toMatchObject({
    name: "create_issue",
    approval: { status: "auto-approved" },
  });
});

test("org policies: designated creators and the approval floor are enforced", async ({
  browser,
}) => {
  // Flip both policies through the Settings UI
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Designated" }).click();
  await page
    .locator(".row", { hasText: "Always require approval" })
    .locator(".toggle")
    .click();
  await page.getByRole("button", { name: "Save policies" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  const orgs = await dbQuery<{ settings: Record<string, unknown> }>(
    "SELECT settings FROM orgs",
  );
  expect(orgs[0]!.settings).toMatchObject({
    whoCanCreateAgents: "designated",
    requireApprovalForUserTools: true,
  });

  // Invite a plain member and read the temp password off the card
  await page.locator(".row input[placeholder='Name']").fill("Casey Kim");
  await page.locator(".row input[placeholder='Email']").fill("casey@acme.com");
  await page.getByRole("button", { name: "Invite" }).click();
  const credentials = await page.locator("code.mono").innerText();
  const [email, tempPassword] = credentials.split(" / ");
  caseyPassword = tempPassword!;

  // The member cannot create agents while creation is designated-only
  const memberPage = await browser.newPage();
  await memberPage.goto("/");
  await memberPage.locator("input[type=email]").fill(email!);
  await memberPage.locator("input[type=password]").fill(tempPassword!);
  await memberPage.getByRole("button", { name: "Sign in" }).click();
  await expect(memberPage.locator(".session-greeting")).toBeVisible();
  const res = await memberPage.request.post("/api/agents", {
    data: { name: "Casey agent" },
  });
  expect(res.status()).toBe(403);
  await memberPage.close();

  // The approval floor overrides Alex's trust posture: the card comes back
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "Floor-gated issue" },
    }),
  });
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("File the floor-gated issue");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Approve as me" }).click();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: File the floor-gated issue",
    { timeout: 15_000 },
  );
  expect(await pollFirstToolCall("%File the floor-gated issue%")).toMatchObject({
    name: "create_issue",
    approval: { status: "approved" },
  });
});

test("model grants: restricting a model cascades through teams", async ({
  browser,
}) => {
  // Alex restricts "Mock Model" to the Engineering team via the model detail
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Models" }).click();
  await page.locator(".row", { hasText: "Mock Model" }).click();
  const detail = page.locator(".card", { hasText: "Used by" });
  await expect(detail).toBeVisible();
  await detail.locator("select").selectOption({ label: "Engineering" });
  await detail.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(
    detail.locator(".row", { hasText: "can talk to it" }),
  ).toContainText("Engineering");

  await expect
    .poll(async () => {
      const grants = await dbQuery<{ target_type: string }>(
        "SELECT target_type FROM grants WHERE target_type = 'model'",
      );
      return grants.length;
    })
    .toBe(1);

  // Casey is in no team — the restricted model is off limits
  const caseyPage = await browser.newPage();
  await caseyPage.goto("/");
  await caseyPage.locator("input[type=email]").fill("casey@acme.com");
  await caseyPage.locator("input[type=password]").fill(caseyPassword);
  await caseyPage.getByRole("button", { name: "Sign in" }).click();
  await expect(caseyPage.locator(".session-greeting")).toBeVisible();
  const before = (await (await caseyPage.request.get("/api/models")).json()) as {
    models: Array<{ displayName: string; canUse: boolean }>;
  };
  expect(before.models.find((m) => m.displayName === "Mock Model")?.canUse).toBe(false);

  // Alex adds Casey to Platform (a sub-team of Engineering) — the team
  // grant cascades down and the model opens up for Casey.
  await page.locator("nav a[title='Teams']").click();
  await page.locator(".sidebar-item", { hasText: "› Platform" }).click();
  await page.locator("select").selectOption({ label: "Casey Kim (casey@acme.com)" });
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(page.locator(".row", { hasText: "Casey Kim" })).toBeVisible();

  const after = (await (await caseyPage.request.get("/api/models")).json()) as {
    models: Array<{ displayName: string; canUse: boolean }>;
  };
  expect(after.models.find((m) => m.displayName === "Mock Model")?.canUse).toBe(true);
  await caseyPage.close();

  // Clean up the restriction so later model use stays unaffected
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Models" }).click();
  await page.locator(".row", { hasText: "Mock Model" }).click();
  await page
    .locator(".card", { hasText: "Used by" })
    .locator(".row", { hasText: "Engineering" })
    .getByRole("button", { name: "Revoke" })
    .click();
});

test("member lifecycle: password change, deactivate, reactivate", async ({
  browser,
}) => {
  // Casey changes their temp password from the profile page
  const caseyPage = await browser.newPage();
  await caseyPage.goto("/");
  await caseyPage.locator("input[type=email]").fill("casey@acme.com");
  await caseyPage.locator("input[type=password]").fill(caseyPassword);
  await caseyPage.getByRole("button", { name: "Sign in" }).click();
  await expect(caseyPage.locator(".session-greeting")).toBeVisible();

  await caseyPage.locator("nav a[title*='profile']").click();
  await caseyPage.getByPlaceholder("Current password").fill(caseyPassword);
  await caseyPage.getByPlaceholder("New password").fill("casey-new-pass-1");
  await caseyPage.getByRole("button", { name: "Change", exact: true }).click();
  await expect(caseyPage.getByRole("button", { name: "Changed ✓" })).toBeVisible();
  const oldPassword = caseyPassword;
  caseyPassword = "casey-new-pass-1";

  // The old password no longer signs in; the new one does
  const probe = await browser.newPage();
  await probe.goto("/");
  await probe.locator("input[type=email]").fill("casey@acme.com");
  await probe.locator("input[type=password]").fill(oldPassword);
  await probe.getByRole("button", { name: "Sign in" }).click();
  await expect(probe.getByText("Invalid email or password")).toBeVisible();
  await probe.locator("input[type=password]").fill(caseyPassword);
  await probe.getByRole("button", { name: "Sign in" }).click();
  await expect(probe.locator(".session-greeting")).toBeVisible();
  await probe.close();

  // Alex deactivates Casey: sign-in blocked AND live cookies die
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Settings" }).click();
  const caseyRow = page.locator(".row", { hasText: "Casey Kim" });
  page.once("dialog", (dialog) => void dialog.accept());
  await caseyRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(caseyRow.locator(".chip", { hasText: "deactivated" })).toBeVisible();

  const dead = await caseyPage.request.get("/api/auth/me");
  expect(dead.status()).toBe(401);
  const blocked = await browser.newPage();
  await blocked.goto("/");
  await blocked.locator("input[type=email]").fill("casey@acme.com");
  await blocked.locator("input[type=password]").fill(caseyPassword);
  await blocked.getByRole("button", { name: "Sign in" }).click();
  await expect(blocked.getByText("This account has been deactivated")).toBeVisible();
  await blocked.close();
  await caseyPage.close();

  // Reactivation restores access; the lifecycle is on the audit trail
  await caseyRow.getByRole("button", { name: "Reactivate" }).click();
  await expect(caseyRow.locator(".chip", { hasText: "deactivated" })).toHaveCount(0);
  const audit = await dbQuery<{ summary: string }>(
    "SELECT summary FROM audit_events WHERE action = 'member.update' ORDER BY created_at",
  );
  expect(audit.map((a) => a.summary)).toEqual([
    "Deactivated Casey Kim",
    "Reactivated Casey Kim",
  ]);
});

test("audit log exports as CSV", async () => {
  const res = await page.request.get("/api/audit?format=csv");
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const body = await res.text();
  expect(body).toContain("agent.surface.add");
});

test("server log contains no errors across the whole suite", async () => {
  const log = readFileSync(serverLogPath, "utf8");
  const errors = log
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      try {
        // Fastify/pino levels: 50 = error, 60 = fatal
        return (JSON.parse(line) as { level?: number }).level! >= 50;
      } catch {
        // Non-JSON output on stderr is unexpected — surface it
        return true;
      }
    });
  expect(errors, `server log should be clean:\n${errors.join("\n")}`).toEqual([]);
});
