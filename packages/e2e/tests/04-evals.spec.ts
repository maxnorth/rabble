/**
 * Evals: live criteria judged against real sessions (the emulator's judge
 * convention answers PASS), session eval chips, suites with frozen cases,
 * and a suite run. Also proves the Anthropic-protocol path end to end by
 * running a second agent against the emulated Anthropic API.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
import { dbQuery } from "./db";

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

test("add a live criterion to the agent", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();

  await page
    .getByPlaceholder("Criterion, e.g. Cites a runbook link")
    .fill("Stays on topic");
  await page
    .getByPlaceholder("What the judge should check (optional)")
    .fill("The reply addresses the user's question directly");
  await page.getByRole("button", { name: "+ Add", exact: true }).first().click();
  await expect(page.locator(".row", { hasText: "Stays on topic" })).toBeVisible();
});

test("a session gets judged and shows eval chips", async () => {
  await page.locator("nav a[title='Sessions']").click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Is prod healthy?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: Is prod healthy?",
    { timeout: 15_000 },
  );

  // Judging runs in the background after the turn; results land in the DB
  await expect
    .poll(
      async () => {
        const results = await dbQuery<{ passed: boolean }>(
          "SELECT passed FROM eval_results",
        );
        return results.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Reload the session — the header shows the criteria verdict chip
  await page.reload();
  const criteriaChip = page.locator("button.chip", { hasText: "criteria" });
  await expect(criteriaChip).toContainText("✓ 1/1 criteria");

  // Chip opens the eval drawer with the judge's verdict and reasoning
  await criteriaChip.click();
  await expect(page.locator(".drawer")).toContainText("Stays on topic");
  await expect(page.locator(".drawer")).toContainText("PASS");
});

test("suites: create, add a case, run it", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();

  await page.getByPlaceholder("New suite name").fill("Smoke");
  await page.getByRole("button", { name: "+ Add suite" }).click();
  const suiteRow = page.locator(".row", { hasText: "Smoke" });
  await expect(suiteRow).toBeVisible();

  // Add a case through the API surface (case-editor UI is the freeze flow)
  const suites = await dbQuery<{ id: string }>("SELECT id FROM eval_suites");
  const addCase = await page.request.post(`/api/suites/${suites[0]!.id}/cases`, {
    data: {
      name: "Deploy question",
      input: "What is our deploy process?",
      rubric: "The reply is relevant to deployments",
    },
  });
  expect(addCase.ok()).toBe(true);

  await page.reload();
  await page.getByRole("button", { name: "evals" }).click();
  await page.getByRole("button", { name: "Run suite" }).click();
  await expect(page.locator(".row", { hasText: "last run 1/1 passed" })).toBeVisible({
    timeout: 30_000,
  });

  const results = await dbQuery<{ passed: boolean; output: string }>(
    "SELECT passed, output FROM case_results",
  );
  expect(results).toHaveLength(1);
  expect(results[0]!.passed).toBe(true);
  expect(results[0]!.output).toContain("Mock reply to:");
});

test("suites: marking a suite as gating persists and shows the chip", async () => {
  // Still on the agent's evals tab from the previous test
  const suiteRow = page.locator(".row", { hasText: "Smoke" });
  // Controlled checkbox: state flips after the PATCH + refetch, so click()
  // (check() insists on an immediate state change).
  await suiteRow.locator("input[type=checkbox]").click();
  await expect(suiteRow.locator(".chip", { hasText: "gating" })).toBeVisible();

  await expect
    .poll(async () => {
      const suites = await dbQuery<{ gating: boolean }>(
        "SELECT gating FROM eval_suites WHERE name = 'Smoke'",
      );
      return suites[0]?.gating;
    })
    .toBe(true);

  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'eval.suite.update'",
  );
  expect(audit).toHaveLength(1);
});

test("freeze: a judged session becomes a suite case from the eval drawer", async () => {
  // Back to the judged session; the criteria chip opens the eval drawer
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".sidebar-item", { hasText: "Is prod healthy?" }).click();
  await page.locator("button.chip", { hasText: "criteria" }).click();

  const freeze = page.locator("div", { hasText: "Freeze as test case" }).last();
  await freeze.locator("select").selectOption({ label: "Smoke" });
  await freeze.getByRole("button", { name: "+ Add to suite" }).click();
  await expect(page.locator(".chip", { hasText: "Added to suite ✓" })).toBeVisible();

  const cases = await dbQuery<{ input: string; source_session_id: string | null }>(
    "SELECT input, source_session_id FROM eval_cases ORDER BY created_at",
  );
  expect(cases).toHaveLength(2);
  expect(cases[1]!.input).toContain("Is prod healthy?");
  expect(cases[1]!.source_session_id).not.toBeNull();
});

test("anthropic protocol: agent on the emulated Anthropic API works", async () => {
  // Register an Anthropic-protocol custom model pointing at the emulator
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Models" }).click();
  await page.getByRole("button", { name: "+ Add custom model" }).click();
  await page.getByPlaceholder("My gateway Sonnet").fill("Emulated Claude");
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  await page
    .getByPlaceholder("https://my-gateway.example.com")
    .fill(`${EMULATOR}/mock/api.anthropic.com`);
  await page.getByPlaceholder("claude-sonnet-5").fill("claude-emu");
  await page.locator(".modal input[type=password]").fill("emu-key");
  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.locator(".row", { hasText: "Emulated Claude" })).toBeVisible();

  // New agent on that model
  await page.locator("nav a[title='Agents']").click();
  await page.getByRole("button", { name: "+ New agent" }).click();
  await page.getByPlaceholder("Eng On-Call").fill("Claude Agent");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.locator("select").first().selectOption({ label: "Emulated Claude" });
  await page.locator(".segmented button", { hasText: "active" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  // Chat with it, targeted
  await page.locator("nav a[title='Sessions']").click();
  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Claude Agent" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Hello Anthropic path");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: Hello Anthropic path",
    { timeout: 15_000 },
  );

  // The emulator's Anthropic fake actually served it
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=api.anthropic.com`)
  ).json()) as { requests: unknown[] };
  expect(log.requests.length).toBeGreaterThan(0);
});

test("auto routes by intent across usable agents", async () => {
  // Two active agents exist now (Eng On-Call, Claude Agent). Script the
  // router verdict, then the routed agent's actual reply.
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { type: "text", text: "eng-on-call" },
      { type: "text", text: "Routed correctly: checking the failing pipeline now." },
    ]),
  });

  await page.getByRole("link", { name: "+ New session" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();
  // Leave the target on "Auto"
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("The CI pipeline is failing on main, please triage");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Routed correctly",
    { timeout: 15_000 },
  );
  // The thread is pinned to the routed agent
  await expect(page.locator(".thread-composer .chip")).toHaveText("Eng On-Call");

  const routed = await dbQuery<{ slug: string }>(
    `SELECT a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.title LIKE 'The CI pipeline is failing%'`,
  );
  expect(routed).toEqual([{ slug: "eng-on-call" }]);
});
