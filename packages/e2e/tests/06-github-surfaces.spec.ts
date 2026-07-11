/**
 * GitHub as a surface: signed issue-comment webhooks become governed
 * sessions, PR conversation comments ride the same path, and background
 * replies ping the user over Slack DM when opted in.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
import { dbQuery } from "./db";
import { SERVER, signedGithubPost } from "./helpers";

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

test("github surface delivery: issue comments become governed sessions", async () => {
  // A GitHub connection with a webhook secret, pointed at the emulator
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.locator(".modal select").first().selectOption("github");
  await page.getByPlaceholder("Acme GitHub").fill("Acme GitHub");
  await page
    .getByPlaceholder("https://slack.com")
    .fill(`${EMULATOR}/mock/api.github.com`);
  await page.locator(".modal input[type=password]").first().fill("ghs-emulated");
  await page.getByPlaceholder("GitHub webhook secret").fill("gh-webhook-secret");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(page.locator(".row", { hasText: "Acme GitHub" })).toBeVisible();

  // Alex bridges his GitHub identity via Profile › Connected accounts
  await page.locator("nav a[title*='profile']").click();
  const githubRow = page.locator('.row[data-vendor="github"]');
  await githubRow.getByRole("button", { name: "Connect" }).click();
  await page.getByPlaceholder("Username (for surface identity)").fill("alexcodes");
  await page.getByPlaceholder("Token").fill("gho-alex");
  await githubRow.getByRole("button", { name: "Save" }).click();
  await expect(githubRow.getByText("Connected ✓")).toBeVisible();

  // Map the repo onto the agent as a surface
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).first().click();
  await page.getByRole("button", { name: "surfaces" }).click();
  // Wait for the tab to replace the identity tab (which has its own selects)
  await expect(page.locator(".row", { hasText: "Web sessions" })).toBeVisible();
  await page.getByRole("button", { name: "+ Link a connection" }).click();
  await page
    .locator(".row", { hasText: "Acme GitHub" })
    .getByRole("button", { name: "Link", exact: true })
    .click();
  const ghCard = page.locator(".card", { hasText: "Acme GitHub" });
  await expect(ghCard).toBeVisible();
  await ghCard.getByRole("button", { name: "+ Add a repository" }).click();
  await page.getByPlaceholder("acme/api").fill("acme/api");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(ghCard.locator(".row", { hasText: "acme/api" })).toBeVisible();

  // A forged signature is rejected
  const forged = await fetch(`${SERVER}/api/inbound/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=deadbeef",
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-000",
    },
    body: JSON.stringify({ action: "created" }),
  });
  expect(forged.status).toBe(401);

  // alexcodes comments on an issue in the mapped repo
  const payload = {
    action: "created",
    repository: { full_name: "acme/api" },
    issue: { number: 7, title: "Deploys are flaky on Fridays" },
    comment: {
      body: "What changed in the deploy pipeline this week?",
      user: { login: "alexcodes", type: "User" },
    },
  };
  const delivery = await signedGithubPost(payload, "d-001");
  expect(delivery.status).toBe(200);
  expect(((await delivery.json()) as { sessionId?: string }).sessionId).toBeTruthy();

  const [session] = await dbQuery<{ id: string; surface: string; title: string }>(
    "SELECT id, surface, title FROM sessions WHERE surface_key = 'github:acme/api#7'",
  );
  expect(session!.surface).toBe("GitHub acme/api#7");
  expect(session!.title).toBe("Deploys are flaky on Fridays");

  // The reply went back as an issue comment
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=api.github.com`)
  ).json()) as { requests: Array<{ path: string; body: { body?: string } }> };
  expect(
    log.requests.some(
      (r) =>
        r.path === "/repos/acme/api/issues/7/comments" &&
        r.body.body?.includes("Mock reply to: What changed in the deploy pipeline"),
    ),
  ).toBe(true);

  // Same issue, second comment -> same session; duplicate delivery -> ignored
  await signedGithubPost(
    { ...payload, comment: { ...payload.comment, body: "And who approved it?" } },
    "d-002",
  );
  const dupe = await signedGithubPost(
    { ...payload, comment: { ...payload.comment, body: "And who approved it?" } },
    "d-002",
  );
  expect(((await dupe.json()) as { ignored?: string }).ignored).toBe("duplicate delivery");
  const transcript = await dbQuery<{ role: string }>(
    "SELECT role FROM messages WHERE session_id = $1 ORDER BY created_at",
    [session!.id],
  );
  expect(transcript.map((m) => m.role)).toEqual(["user", "agent", "user", "agent"]);

  // A stranger gets pointed at connected accounts, and no session
  await signedGithubPost(
    {
      ...payload,
      issue: { number: 99, title: "Who are you?" },
      comment: { body: "hello?", user: { login: "ghost", type: "User" } },
    },
    "d-003",
  );
  const ghost = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE surface_key = 'github:acme/api#99'",
  );
  expect(ghost).toHaveLength(0);
  const refusal = (await (
    await fetch(`${EMULATOR}/admin/requests?host=api.github.com`)
  ).json()) as { requests: Array<{ body: { body?: string } }> };
  expect(
    refusal.requests.some((r) =>
      r.body.body?.includes("Connect your GitHub account under Profile"),
    ),
  ).toBe(true);

  // Visible in the web app with its surface chip
  await page.locator("nav a[title='Sessions']").click();
  await page
    .locator(".sidebar-item", { hasText: "Deploys are flaky on Fridays" })
    .click();
  await expect(
    page.locator(".thread-surface", { hasText: "GitHub acme/api#7" }),
  ).toBeVisible();
});

test("PR conversation comments ride the same surface (PRs are issues)", async () => {
  // GitHub fires issue_comment for PR conversations too — the payload's
  // issue carries a pull_request marker but the flow is identical.
  const delivery = await signedGithubPost(
    {
      action: "created",
      repository: { full_name: "acme/api" },
      issue: {
        number: 42,
        title: "Add rate limiting to the API gateway",
        pull_request: { url: "https://api.github.com/repos/acme/api/pulls/42" },
      },
      comment: {
        body: "Does this change our p99 target?",
        user: { login: "alexcodes", type: "User" },
      },
    },
    "d-pr-001",
  );
  expect(delivery.status).toBe(200);
  const [session] = await dbQuery<{ id: string; surface: string }>(
    "SELECT id, surface FROM sessions WHERE surface_key = 'github:acme/api#42'",
  );
  expect(session).toBeDefined();
  expect(session!.surface).toBe("GitHub acme/api#42");

  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=api.github.com`)
  ).json()) as { requests: Array<{ path: string; body: { body?: string } }> };
  expect(
    log.requests.some(
      (r) =>
        r.path === "/repos/acme/api/issues/42/comments" &&
        r.body.body?.includes("Mock reply to: Does this change our p99 target?"),
    ),
  ).toBe(true);
});

test("PR review-comment threads become their own governed session", async () => {
  // Inline code-review comments arrive as pull_request_review_comment — a
  // distinct thread surface with a threaded reply, not the PR conversation.
  const delivery = await signedGithubPost(
    {
      action: "created",
      repository: { full_name: "acme/api" },
      pull_request: {
        number: 42,
        title: "Add rate limiting to the API gateway",
      },
      comment: {
        id: 555,
        path: "src/gateway/limits.ts",
        line: 88,
        body: "Should this be behind a feature flag?",
        user: { login: "alexcodes", type: "User" },
      },
    },
    "d-review-001",
    "pull_request_review_comment",
  );
  expect(delivery.status).toBe(200);

  // A review thread is its own session, keyed on the thread's root comment —
  // separate from the PR conversation session (github:acme/api#42).
  const [session] = await dbQuery<{ id: string; surface: string }>(
    "SELECT id, surface FROM sessions WHERE surface_key = 'github-review:acme/api#42#555'",
  );
  expect(session).toBeDefined();
  expect(session!.surface).toBe("GitHub acme/api#42 (review)");

  // The agent replied into the review thread, not the conversation list.
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=api.github.com`)
  ).json()) as { requests: Array<{ path: string; body: { body?: string } }> };
  // The agent's turn carried the code location (file + line), so it comes
  // back in the reply — the review agent knows which code it's discussing.
  expect(
    log.requests.some(
      (r) =>
        r.path === "/repos/acme/api/pulls/42/comments/555/replies" &&
        r.body.body?.includes("On `src/gateway/limits.ts` line 88") &&
        r.body.body?.includes("Should this be behind a feature flag?"),
    ),
  ).toBe(true);
});

test("background replies ping the user's Slack DM when opted in", async () => {
  // Alex opts in (the Slack workspace already knows alex@acme.com = U777)
  await page.locator("nav a[title*='profile']").click();
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page
    .locator(".row", { hasText: "Notify me when a background task finishes" })
    .locator(".toggle")
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  // Another comment lands on the mapped repo while Alex is "away"
  await signedGithubPost(
    {
      action: "created",
      repository: { full_name: "acme/api" },
      issue: { number: 7, title: "Deploys are flaky on Fridays" },
      comment: {
        body: "Any update on the cache region fix?",
        user: { login: "alexcodes", type: "User" },
      },
    },
    "d-005",
  );

  // The agent's reply is DM'd to Alex through the org's Slack connection
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { channel?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.channel === "U777" &&
          r.body.text?.includes("replied on GitHub acme/api#7") &&
          r.body.text?.includes("Open the session in Rabble"),
      );
    })
    .toBe(true);

  // Opt back out so later flows stay quiet
  await page.locator("nav a[title*='profile']").click();
  await page.locator(".sidebar-item", { hasText: "Agent preferences" }).click();
  await page
    .locator(".row", { hasText: "Notify me when a background task finishes" })
    .locator(".toggle")
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
});
