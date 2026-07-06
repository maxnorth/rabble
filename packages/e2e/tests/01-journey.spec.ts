/**
 * Full click-through of the vertical slice against a fresh install:
 * owner setup → auth → model registry → agent creation → streamed sessions.
 * Each stage asserts both what the UI shows and what actually landed in the
 * database; the final tests check persistence, API auth guards, and that the
 * server log contains no errors.
 */
import { readFileSync } from "node:fs";
import {
  expect,
  request,
  test,
  type Browser,
  type Page,
} from "@playwright/test";
import { serverLogPath } from "../global-setup";
import { dbQuery } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("first boot walks through owner setup", async () => {
  await page.goto("/");
  await expect(page.getByText("Welcome to Rabble")).toBeVisible();

  await page.getByPlaceholder("Acme Corp").fill("Acme Corp");
  await page.getByPlaceholder("Alex Lin").fill("Alex Lin");
  await page.getByPlaceholder("alex@acme.com").fill("Alex@Acme.com");
  await page.getByPlaceholder("At least 8 characters").fill("password123");
  await page.getByRole("button", { name: "Create owner account" }).click();

  await expect(page.locator(".session-greeting")).toBeVisible();

  const orgs = await dbQuery<{ name: string }>("SELECT name FROM orgs");
  expect(orgs).toEqual([{ name: "Acme Corp" }]);
  const users = await dbQuery<{ email: string; role: string }>(
    "SELECT email, role FROM users",
  );
  expect(users).toEqual([{ email: "alex@acme.com", role: "owner" }]);
  const hashes = await dbQuery<{ password_hash: string }>(
    "SELECT password_hash FROM users",
  );
  expect(hashes[0]!.password_hash).toMatch(/^scrypt:/);
  expect(hashes[0]!.password_hash).not.toContain("password123");
});

test("sign out and sign back in", async () => {
  await page.locator("[title*='sign out']").click();
  await expect(page.getByText("Sign in to Rabble")).toBeVisible();

  await page.locator("input[type=email]").fill("alex@acme.com");
  await page.locator("input[type=password]").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();

  const sessions = await dbQuery<{ count: string }>(
    "SELECT count(*) FROM auth_sessions",
  );
  // setup + login each minted a token; logout revoked the first
  expect(Number(sessions[0]!.count)).toBe(1);
});

test("admin: register a custom model pointing at the mock endpoint", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Models" }).click();
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

  // Built-in catalog is visible with no provider key configured
  await expect(page.getByText("Claude Sonnet 5")).toBeVisible();

  await page.getByRole("button", { name: "+ Add custom model" }).click();
  await page.getByPlaceholder("My gateway Sonnet").fill("Mock Model");
  await page.getByRole("button", { name: "OpenAI-compatible" }).click();
  await page
    .getByPlaceholder("https://my-gateway.example.com")
    .fill("http://localhost:4100/mock/api.openai.com/v1");
  await page.getByPlaceholder("claude-sonnet-5").fill("mock-1");
  await page.locator(".modal input[type=password]").fill("test-key-secret");
  await page.getByRole("button", { name: "Add model" }).click();

  await expect(page.locator(".row", { hasText: "Mock Model" })).toBeVisible();

  const models = await dbQuery<{
    kind: string;
    model_id: string;
    base_url: string;
    encrypted_key: string;
  }>("SELECT kind, model_id, base_url, encrypted_key FROM models");
  expect(models).toHaveLength(1);
  expect(models[0]!.kind).toBe("custom");
  expect(models[0]!.model_id).toBe("mock-1");
  expect(models[0]!.base_url).toBe("http://localhost:4100/mock/api.openai.com/v1");
  // API keys are stored encrypted, never in plaintext
  expect(models[0]!.encrypted_key).toMatch(/^v1:/);
  expect(models[0]!.encrypted_key).not.toContain("test-key-secret");
});

test("agents: create, configure, and activate an agent", async () => {
  await page.locator("nav a[title='Agents']").click();
  await expect(page.getByText("No agents match")).toBeVisible();

  await page.getByRole("button", { name: "+ New agent" }).click();
  await page.getByPlaceholder("Eng On-Call").fill("Eng On-Call");
  await page.getByRole("button", { name: "Create draft" }).click();

  await expect(page.getByRole("heading", { name: "Eng On-Call" })).toBeVisible();
  await expect(page.getByText("eng-on-call")).toBeVisible();

  await page
    .getByPlaceholder("What this agent is responsible for")
    .fill("CI triage and deploy questions");
  await page
    .getByPlaceholder("System instructions that define how this agent behaves")
    .fill("You triage CI failures. Be concise.");
  await page.locator("select").first().selectOption({ label: "Mock Model" });
  await page.locator(".segmented button", { hasText: "active" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  await page.getByRole("button", { name: "‹ All agents" }).click();
  const row = page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" });
  await expect(row).toBeVisible();
  // Active agents carry no draft badge in the directory
  await expect(row.locator(".chip", { hasText: "draft" })).toHaveCount(0);

  const agents = await dbQuery<{
    slug: string;
    status: string;
    model_id: string | null;
    instructions: string;
  }>("SELECT slug, status, model_id, instructions FROM agents");
  expect(agents).toHaveLength(1);
  expect(agents[0]!.slug).toBe("eng-on-call");
  expect(agents[0]!.status).toBe("active");
  expect(agents[0]!.model_id).not.toBeNull();
  expect(agents[0]!.instructions).toContain("triage CI failures");
});

test("sessions: targeted chat streams a reply and persists the transcript", async () => {
  await page.locator("nav a[title='Sessions']").click();
  await expect(page.locator(".session-greeting")).toBeVisible();

  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page.getByPlaceholder("Describe what you need help with…").fill("What is the deploy status?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".msg-user")).toHaveText("What is the deploy status?");
  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: What is the deploy status?",
    { timeout: 15_000 },
  );

  // Follow-up turn in the same thread
  await page.locator(".thread-composer textarea").fill("And staging?");
  await page.locator(".thread-composer button", { hasText: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble").nth(1)).toContainText(
    "Mock reply to: And staging?",
    { timeout: 15_000 },
  );

  // Session appears in the sidebar, titled from the first message
  await expect(
    page.locator(".sidebar-item", { hasText: "What is the deploy status?" }),
  ).toBeVisible();

  const sessions = await dbQuery<{ id: string; title: string }>(
    "SELECT id, title FROM sessions",
  );
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.title).toBe("What is the deploy status?");

  const messages = await dbQuery<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at",
    [sessions[0]!.id],
  );
  expect(messages.map((m) => m.role)).toEqual(["user", "agent", "user", "agent"]);
  expect(messages[0]!.content).toBe("What is the deploy status?");
  expect(messages[1]!.content).toBe("Mock reply to: What is the deploy status?");
  expect(messages[3]!.content).toBe("Mock reply to: And staging?");
});

test("sessions: Auto target resolves to an active agent", async () => {
  await page.getByRole("link", { name: "+ New session" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();

  // Leave the target pill on "Auto"
  await page.getByPlaceholder("Describe what you need help with…").fill("Auto-routed question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: Auto-routed question",
    { timeout: 15_000 },
  );

  const rows = await dbQuery<{ slug: string }>(
    `SELECT a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.title = 'Auto-routed question'`,
  );
  expect(rows).toEqual([{ slug: "eng-on-call" }]);
});

test("transcripts survive a full page reload", async () => {
  await page.reload();
  await page
    .locator(".sidebar-item", { hasText: "What is the deploy status?" })
    .click();
  await expect(page.locator(".msg-user")).toHaveCount(2);
  await expect(page.locator(".msg-agent")).toHaveCount(2);
});

test("API rejects unauthenticated requests", async () => {
  const anon = await request.newContext({ baseURL: "http://localhost:3178" });
  for (const path of ["/api/agents", "/api/sessions", "/api/models", "/api/auth/me"]) {
    const res = await anon.get(path);
    expect(res.status(), `${path} should require auth`).toBe(401);
  }
  const health = await anon.get("/api/health");
  expect(health.status()).toBe(200);
  await anon.dispose();
});

test("server log contains no errors", async () => {
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
