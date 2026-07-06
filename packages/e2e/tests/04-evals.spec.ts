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
  await page.getByPlaceholder("Message an agent…").fill("Is prod healthy?");
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

  // Reload the session — the eval strip appears
  await page.reload();
  await expect(page.locator(".eval-strip .chip", { hasText: "Stays on topic" })).toBeVisible();
  await expect(page.locator(".eval-strip .chip").first()).toContainText("✓");

  // Chip opens the drawer with the judge's reasoning
  await page.locator(".eval-strip .chip").first().click();
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
  await page.getByPlaceholder("Message an agent…").fill("Hello Anthropic path");
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
