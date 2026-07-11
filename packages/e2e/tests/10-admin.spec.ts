/**
 * Remaining admin + profile + stats surfaces: session search, automations,
 * API keys (created through the UI, exercised over HTTP with scope
 * enforcement), the audit log viewer, stats dashboards, the profile page,
 * org policies, model grants, member lifecycle, and retention. Ends with
 * the server-log cleanliness check for the entire suite run.
 */
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

test("session search filters the sidebar", async () => {
  // Hard navigation: /sessions/:id -> /sessions remounts the section, and a
  // fill during that remount lands on the discarded input.
  await page.goto("/sessions");
  await expect(page.locator(".sidebar-item").nth(2)).toBeVisible();
  const search = page.getByPlaceholder("Search sessions…");
  await search.fill("Slack");
  await expect(search).toHaveValue("Slack");
  await expect(
    page.locator(".sidebar-item", { hasText: "Deploy status from Slack?" }),
  ).toBeVisible();
  await expect(
    page.locator(".sidebar-item", { hasText: "Find our deploy repos" }),
  ).toHaveCount(0);
  await page.getByPlaceholder("Search sessions…").fill("zzz-no-match");
  await expect(page.getByText("No sessions match")).toBeVisible();
  await page.getByPlaceholder("Search sessions…").fill("");
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
  // The cron is rendered in plain language, not a bare "0 9 * * 1-5".
  await expect(row).toContainText("at 9:00 UTC on weekdays");
  // A new automation is disabled by default, so no next-run is projected,
  // and the scheduler-off notice stays hidden (nothing is scheduled yet).
  await expect(row).not.toContainText("next");
  await expect(page.getByText("The platform scheduler")).toBeHidden();
  // Enabling it surfaces the projected next run. Since e2e runs without a
  // configured scheduler, the honest "won't fire on schedule yet" notice
  // now appears.
  await row.locator(".toggle").click();
  await expect(row).toContainText("next");
  await expect(page.getByText("The platform scheduler")).toBeVisible();

  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.getByRole("link", { name: "view session →" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(row).toContainText("last ran");

  // Editing an automation in place: retune the schedule and the plain-language
  // summary updates without a delete-and-recreate. Once in edit mode the name
  // lives in an input value, so drive the form with page-level locators.
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Automation schedule").fill("0 * * * *");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("at :00 past every hour");
  const [edited] = await dbQuery<{ schedule: string }>(
    "SELECT schedule FROM automations WHERE name = 'Morning digest'",
  );
  expect(edited!.schedule).toBe("0 * * * *");
  const editAudit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'automation.update'",
  );
  expect(editAudit).toHaveLength(1);

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

  // The automation records its creator — the identity a scheduled (Hatchet)
  // run acts as, since a cron tick has no request user.
  const [owner] = await dbQuery<{ email: string }>(
    `SELECT u.email FROM automations a JOIN users u ON u.id = a.created_by
     WHERE a.name = 'Morning digest'`,
  );
  expect(owner!.email).toBe("alex@acme.com");

  // The run's session opens like any other, on its surface
  await row.getByRole("link", { name: "view session →" }).click();
  await expect(
    page.locator(".thread-surface", { hasText: "Automation · Morning digest" }),
  ).toBeVisible();
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
  // The unfiltered page shows the newest 100 events, and the suite has
  // accumulated more history than that — find the early MCP registration
  // the way a person would, through the action filter.
  await page.locator("select").selectOption("mcp");
  await expect(
    page.locator(".row", { hasText: 'Registered MCP server "GitHub"' }),
  ).toBeVisible();
  await page.locator("select").selectOption("api-key");
  await expect(page.locator(".row", { hasText: "Created API key" }).first()).toBeVisible();
  await page.locator("select").selectOption("");

  // Rows with metadata expand to reveal the detail behind the summary — the
  // gating block from 04 shows which case regressed and the judge's reasoning.
  await page.locator("select").selectOption("eval");
  // Journey 08's Builder block also lands here — pin to the one from 04.
  const gateRow = page
    .locator(".row", { hasText: 'blocked a change to "Eng On-Call"' })
    .first();
  await expect(gateRow).toBeVisible();
  await gateRow.click();
  await expect(
    page.getByText("The reply ignores the deployment question."),
  ).toBeVisible();
  await page.locator("select").selectOption("");

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

  // Sessions-per-day is a dense, zero-filled timeline — most days in the
  // window have no sessions, so a gap bar (title "…: 0") must be present.
  // (Without zero-fill the chart collapses to one equal bar per active day.)
  const perDayCard = page.locator(".chart-card", { hasText: "Sessions per day" });
  await expect(perDayCard.locator('[title$=": 0"]').first()).toBeAttached();

  // Skill use tab: auth-type split from the MCP calls in 03-tools
  await page.locator(".sidebar-item", { hasText: "Skill use" }).click();
  await expect(
    page.locator(".chart-card", { hasText: "Tool calls by auth type" }),
  ).toContainText("service");
  await expect(page.locator(".chart-card", { hasText: "Calls by tool" })).toContainText(
    "query_metrics",
  );

  // Eval performance tab: the judged session from 04-evals shows up per agent
  await page.locator(".sidebar-item", { hasText: "Eval performance" }).click();
  await expect(
    page.locator(".chart-card", { hasText: "Pass rate by agent" }),
  ).toContainText("Eng On-Call");

  // Drill down: clicking the agent's bar lists its failing cases. Plant a
  // recent failure — earlier flows re-judged their sessions green.
  await dbQuery(
    `INSERT INTO eval_results (criterion_id, session_id, passed, reasoning, created_at)
     SELECT ec.id, s.id, false, 'Missed the runbook link', now() - interval '2 days'
     FROM eval_criteria ec, sessions s
     WHERE s.title = 'Find our deploy repos' LIMIT 1`,
  );
  await page.locator(".sidebar-item", { hasText: "Overview" }).click();
  await page.locator(".sidebar-item", { hasText: "Eval performance" }).click();
  await page.locator(".bar-row", { hasText: "Eng On-Call" }).first().click();
  const failCard = page.locator(".chart-card", {
    has: page.getByRole("heading", { name: "Failing cases" }),
  });
  await expect(failCard).toContainText("Missed the runbook link");
  await expect(failCard.locator("a", { hasText: "open session →" }).first()).toBeVisible();

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

  // Spend is priced at use time: each agent message snapshots its model's rate
  // so deleting or re-pricing the model later can't rewrite history. Every
  // priced agent message carries a snapshot equal to its model's live rate.
  const snapshotMismatch = await dbQuery<{ n: string }>(
    `SELECT count(*) AS n FROM messages m
     JOIN models mo ON mo.id = m.model_id
     WHERE m.role = 'agent' AND mo.price_input_per_mtok IS NOT NULL
       AND (m.price_input_per_mtok IS DISTINCT FROM mo.price_input_per_mtok
         OR m.price_output_per_mtok IS DISTINCT FROM mo.price_output_per_mtok)`,
  );
  expect(Number(snapshotMismatch[0]!.n)).toBe(0);
  const snapshotCount = await dbQuery<{ n: string }>(
    "SELECT count(*) AS n FROM messages WHERE role = 'agent' AND price_input_per_mtok IS NOT NULL",
  );
  expect(Number(snapshotCount[0]!.n)).toBeGreaterThan(0);
  await expect(
    page.locator(".chart-card", { hasText: "Turns per session" }).locator(".bar-row").first(),
  ).toBeVisible();

  // Filtering by user: Bea drove one session in 02-governance and one
  // Builder session earlier in this journey
  await page.locator("select[title='Filter by user']").selectOption({ label: "Bea Ortiz" });
  const beaSessions = page.locator(".kpi", { hasText: "Sessions" }).first();
  await expect
    .poll(async () => Number(await beaSessions.locator(".value").innerText()))
    .toBe(2);
  await page.locator("select[title='Filter by user']").selectOption("");

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

  // Connect a personal Linear token inline on the vendor row (GitHub is
  // already connected by the github-surface test)
  const linearRow = page.locator(".row", { hasText: "Linear" });
  await linearRow.getByRole("button", { name: "Connect" }).click();
  await linearRow.getByPlaceholder("Token").fill("lin_personal");
  await linearRow.getByRole("button", { name: "Save" }).click();
  await expect(linearRow.getByText("Connected ✓")).toBeVisible();

  const accounts = await dbQuery<{ vendor: string; encrypted_token: string }>(
    "SELECT vendor, encrypted_token FROM user_connected_accounts WHERE vendor = 'linear'",
  );
  expect(accounts[0]!.vendor).toBe("linear");
  expect(accounts[0]!.encrypted_token).toMatch(/^v1:/);
  expect(accounts[0]!.encrypted_token).not.toContain("lin_personal");

  // Trust posture saves and persists (stored as "trust")
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page.getByRole("button", { name: "Trust me" }).click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  const prefs = await dbQuery<{ preferences: { approvalPosture: string } }>(
    "SELECT preferences FROM users WHERE email = 'alex@acme.com'",
  );
  expect(prefs[0]!.preferences.approvalPosture).toBe("trust");

  // Approval posture is a governance control, so the change is on the record.
  const postureAudit = await dbQuery<{ summary: string }>(
    "SELECT summary FROM audit_events WHERE action = 'profile.posture'",
  );
  expect(postureAudit.some((a) => a.summary.includes("trust"))).toBe(true);
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
  await expect(page.locator(".tool-call", { hasText: "query_metrics" })).toBeVisible();

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

  // The member cannot create agents while creation is designated-only
  const memberPage = await browser.newPage();
  await memberPage.goto("/");
  await memberPage.locator("input[type=email]").fill(email!);
  await memberPage.locator("input[type=password]").fill(tempPassword!);
  await memberPage.getByRole("button", { name: "Sign in" }).click();

  // Temp passwords force rotation before anything else works
  await expect(memberPage.getByText("Set your password")).toBeVisible();
  await memberPage.getByPlaceholder("Temporary password").fill(tempPassword!);
  await memberPage.getByPlaceholder("At least 8 characters").fill("casey-first-pass-1");
  await memberPage.getByRole("button", { name: "Save and continue" }).click();
  caseyPassword = "casey-first-pass-1";
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

  await expect
    .poll(async () => {
      const after = (await (await caseyPage.request.get("/api/models")).json()) as {
        models: Array<{ displayName: string; canUse: boolean }>;
      };
      return after.models.find((m) => m.displayName === "Mock Model")?.canUse;
    })
    .toBe(true);
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

test("retention removes expired sessions on demand", async () => {
  // Plant a session last touched a year ago
  const [ids] = await dbQuery<{ org_id: string; user_id: string; agent_id: string }>(
    "SELECT org_id, user_id, agent_id FROM sessions LIMIT 1",
  );
  await dbQuery(
    `INSERT INTO sessions (org_id, user_id, agent_id, title, created_at, updated_at)
     VALUES ($1, $2, $3, 'Ancient history', now() - interval '365 days', now() - interval '365 days')`,
    [ids!.org_id, ids!.user_id, ids!.agent_id],
  );

  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Apply now" }).click();
  await expect(page.getByRole("button", { name: "Removed 1" })).toBeVisible();

  const remains = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE title = 'Ancient history'",
  );
  expect(remains).toHaveLength(0);
  const audit = await dbQuery<{ summary: string }>(
    "SELECT summary FROM audit_events WHERE action = 'org.retention'",
  );
  expect(audit[0]!.summary).toContain("removed 1 expired session");
});

test("audit log exports as CSV", async () => {
  const res = await page.request.get("/api/audit?format=csv");
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const body = await res.text();
  expect(body).toContain("agent.surface.add");
  // The export carries the metadata column so a records copy is as complete
  // as the viewer — the gating block's failing case travels with it.
  expect(body.split("\n")[0]).toContain("metadata");
  expect(body).toContain("ignores the deployment question");
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
