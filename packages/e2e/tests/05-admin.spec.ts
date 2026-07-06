/**
 * Remaining admin + profile + stats surfaces: Slack connection verified via
 * the emulator, API keys (created through the UI, exercised over HTTP with
 * scope enforcement), the audit log viewer, stats dashboards, and the
 * profile page. Ends with the server-log cleanliness check for the entire
 * suite run.
 */
import { readFileSync } from "node:fs";
import { expect, request, test, type Page } from "@playwright/test";
import { EMULATOR, serverLogPath } from "../global-setup";
import { dbQuery, pollFirstToolCall } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;

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
  await page.locator(".modal input[type=password]").fill("xoxb-emulated");
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

test("api keys: read scope is enforced over HTTP", async () => {
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
