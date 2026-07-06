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

  // The connections list now attributes the agent to the connection
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(
    page.locator(".row", { hasText: "Acme Slack" }).locator(".chip", { hasText: "1 agent" }),
  ).toBeVisible();

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

  // Bea joins the same thread: same session, message attributed to her
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ users: { U999: "bea@acme.com" } }),
  });
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U999",
      text: "Adding context: it started after the cache migration",
      ts: "1712.003",
      thread_ts: "1712.001",
    },
  });
  const authored = await dbQuery<{ content: string; author: string | null }>(
    `SELECT m.content, u.name AS author FROM messages m
     LEFT JOIN users u ON u.id = m.author_user_id
     WHERE m.session_id = $1 AND m.role = 'user' ORDER BY m.created_at`,
    [session!.id],
  );
  expect(authored.map((m) => m.author)).toEqual(["Alex Lin", "Alex Lin", "Bea Ortiz"]);

  // Alex opens the shared thread: Bea's message carries her name
  await page.locator("nav a[title='Sessions']").click();
  await page
    .locator(".sidebar-item", { hasText: "Deploy status from Slack?" })
    .click();
  await expect(
    page.locator(".msg-user", { hasText: "Adding context" }),
  ).toContainText("Bea Ortiz");
  await expect(page.locator(".chip", { hasText: "+1 teammate" })).toBeVisible();

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
    "Mock reply to: Adding context: it started after the cache migration",
  );
});

test("participants can view and continue a shared thread — not manage it", async ({
  browser,
}) => {
  const beaPage = await browser.newPage();
  await beaPage.goto("/");
  await beaPage.locator("input[type=email]").fill("bea@acme.com");
  await beaPage.locator("input[type=password]").fill("bea-real-password-1");
  await beaPage.getByRole("button", { name: "Sign in" }).click();
  await expect(beaPage.locator(".session-greeting")).toBeVisible();

  // The Slack thread Bea joined shows in her sidebar
  await beaPage
    .locator(".sidebar-item", { hasText: "Deploy status from Slack?" })
    .click();
  // Alex's messages carry his name from her point of view
  await expect(
    beaPage.locator(".msg-user", { hasText: "Deploy status from Slack?" }),
  ).toContainText("Alex Lin");

  // She can continue the conversation from the web
  await beaPage
    .locator(".thread-composer textarea")
    .fill("From the web: I'm rolling back the cache change");
  await beaPage.locator(".thread-composer button", { hasText: "Send" }).click();
  await expect(beaPage.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: From the web: I'm rolling back the cache change",
    { timeout: 15_000 },
  );

  const [session] = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE surface_key = 'slack:C777:1712.001'",
  );
  const authored = await dbQuery<{ author: string | null }>(
    `SELECT u.name AS author FROM messages m
     LEFT JOIN users u ON u.id = m.author_user_id
     WHERE m.session_id = $1 AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1`,
    [session!.id],
  );
  expect(authored[0]!.author).toBe("Bea Ortiz");

  // Rename/delete stay with the session's user
  const del = await beaPage.request.delete(`/api/sessions/${session!.id}`);
  expect(del.status()).toBe(404);
  const rename = await beaPage.request.patch(`/api/sessions/${session!.id}`, {
    data: { title: "Bea's now" },
  });
  expect(rename.status()).toBe(404);
  await beaPage.close();
});

test("approvals resolve from Slack: DM buttons drive the pending decision", async () => {
  // The next model call asks for the user-auth tool
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "From Slack with approval" },
    }),
  });

  // Fire the delivery WITHOUT awaiting — it blocks on the approval
  const deliveryPromise = signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U777",
      text: "File the issue we discussed",
      ts: "1712.010",
      thread_ts: "1712.001",
    },
  });

  // The approval ask lands as DM buttons; grab the broker reference
  let value = "";
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{
          path: string;
          body: {
            channel?: string;
            blocks?: Array<{ elements?: Array<{ action_id?: string; value?: string }> }>;
          };
        }>;
      };
      const dm = log.requests.find(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.channel === "U777" &&
          r.body.blocks?.some((b) =>
            b.elements?.some((el) => el.action_id === "rabble_approve"),
          ),
      );
      if (dm) {
        value =
          dm.body.blocks!
            .flatMap((b) => b.elements ?? [])
            .find((el) => el.action_id === "rabble_approve")!.value ?? "";
      }
      return Boolean(dm);
    })
    .toBe(true);

  // Click "Approve as me": Slack posts a signed, form-encoded interaction
  const payload = JSON.stringify({
    type: "block_actions",
    user: { id: "U777" },
    response_url: `${EMULATOR}/mock/slack.com/response/appr-1`,
    actions: [{ action_id: "rabble_approve", value }],
  });
  const rawForm = `payload=${encodeURIComponent(payload)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", "emu-signing-secret")
    .update(`v0:${ts}:${rawForm}`)
    .digest("hex")}`;
  const interaction = await fetch(`${SERVER}/api/inbound/slack-interactive`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: rawForm,
  });
  expect(((await interaction.json()) as { resolved: boolean }).resolved).toBe(true);

  // The blocked delivery completes: tool ran as Alex, approved from Slack
  const delivery = await deliveryPromise;
  expect(delivery.status).toBe(200);
  expect(await pollFirstToolCall("%File the issue we discussed%")).toMatchObject({
    name: "create_issue",
    authType: "user",
    approval: { status: "approved", decidedByName: "Alex Lin" },
  });

  // The DM's buttons were replaced with the outcome
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { replace_original?: boolean; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/response/appr-1" &&
          r.body.replace_original === true &&
          r.body.text?.includes("Approved"),
      );
    })
    .toBe(true);
});

test("a Slack-raised approval can be decided from the web session", async () => {
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "Approved from the web" },
    }),
  });

  // A fresh thread: the earlier once-per-session approval doesn't carry
  // over, so this ask must pause again
  const deliveryPromise = signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C777",
      user: "U777",
      text: "File one more issue please",
      ts: "1712.020",
    },
  });

  // Wait until the ask is actually pending (its DM went out), then open
  // the web session: the same approval card appears on load.
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as { requests: Array<{ body: { text?: string } }> };
      // The previous test sent an identical DM — this one is the second
      return log.requests.filter((r) =>
        r.body?.text?.includes("wants to run create_issue"),
      ).length;
    })
    .toBeGreaterThanOrEqual(2);
  await page.goto("/sessions");
  await page
    .locator(".sidebar-item", { hasText: "File one more issue please" })
    .click();
  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText("create_issue");
  await card.getByRole("button", { name: "Approve as me" }).click();

  const delivery = await deliveryPromise;
  expect(delivery.status).toBe(200);
  expect(await pollFirstToolCall("%File one more issue please%")).toMatchObject({
    name: "create_issue",
    authType: "user",
    approval: { status: "approved", decidedByName: "Alex Lin" },
  });
});

function signedGithubPost(body: unknown, deliveryId: string, event = "issue_comment") {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", "gh-webhook-secret").update(raw).digest("hex")}`;
  return fetch(`${SERVER}/api/inbound/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
    body: raw,
  });
}

test("github surface delivery: issue comments become governed sessions", async () => {
  // A GitHub connection with a webhook secret, pointed at the emulator
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.locator(".modal select").first().selectOption("github");
  await page.getByPlaceholder("Acme Slack").fill("Acme GitHub");
  await page
    .getByPlaceholder("https://slack.com")
    .fill(`${EMULATOR}/mock/api.github.com`);
  await page.locator(".modal input[type=password]").first().fill("ghs-emulated");
  await page.getByPlaceholder("GitHub webhook secret").fill("gh-webhook-secret");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(page.locator(".row", { hasText: "Acme GitHub" })).toBeVisible();

  // Alex bridges his GitHub identity via Profile › Connected accounts
  await page.locator("nav a[title*='profile']").click();
  const githubRow = page.locator(".row", { hasText: "Github" });
  await githubRow.getByRole("button", { name: "Connect" }).click();
  await page.getByPlaceholder("Username (for surface identity)").fill("alexcodes");
  await page.getByPlaceholder("Token").fill("gho-alex");
  await githubRow.getByRole("button", { name: "Save" }).click();
  await expect(githubRow.locator(".chip", { hasText: "connected" })).toBeVisible();

  // Map the repo onto the agent as a surface
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).first().click();
  await page.getByRole("button", { name: "surfaces" }).click();
  // Wait for the tab to replace the identity tab (which has its own selects)
  await expect(page.locator(".row", { hasText: "Web sessions" })).toBeVisible();
  await page.locator("select").selectOption({ label: "Acme GitHub (github)" });
  // The label placeholder is vendor-aware (repo path for GitHub)
  await page.getByPlaceholder("acme/api").fill("acme/api");
  await page.getByRole("button", { name: "Attach surface" }).click();
  await expect(page.locator(".row", { hasText: "acme/api" })).toBeVisible();

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
      r.body.body?.includes("connect your GitHub account under Profile"),
    ),
  ).toBe(true);

  // Visible in the web app with its surface chip
  await page.locator("nav a[title='Sessions']").click();
  await page
    .locator(".sidebar-item", { hasText: "Deploys are flaky on Fridays" })
    .click();
  await expect(page.locator(".chip", { hasText: "GitHub acme/api#7" })).toBeVisible();
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
          r.body.text?.includes("open the session in Rabble"),
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

test("slack socket mode: events stream over the WebSocket instead of webhooks", async () => {
  // A second Slack connection carrying an app-level token — the server
  // should dial apps.connections.open and hold a socket to the emulator.
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.getByPlaceholder("Acme Slack").fill("Acme Slack (socket)");
  await page.getByPlaceholder("https://slack.com").fill(`${EMULATOR}/mock/slack.com`);
  await page.locator(".modal input[type=password]").first().fill("xoxb-emulated");
  await page.getByPlaceholder("xapp-…").fill("xapp-emulated");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "Acme Slack (socket)" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "Socket Mode" })).toBeVisible();

  // The socket actually connects (apps.connections.open -> ws upgrade).
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { connections: number };
      return status.connections;
    })
    .toBeGreaterThan(0);

  // A channel on the socket connection, mapped to the same on-call agent.
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channels: { C888: "eng-socket" } }),
  });
  await dbQuery(
    `INSERT INTO agent_surfaces (agent_id, connection_id, label)
     SELECT a.id, c.id, '#eng-socket' FROM agents a, connections c
     WHERE a.name = 'Eng On-Call' AND c.name = 'Acme Slack (socket)'`,
  );

  // Alex posts in #eng-socket — delivered over the socket, not a webhook.
  const push = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          type: "message",
          channel: "C888",
          user: "U777",
          text: "Deploy status over the socket?",
          ts: "1799.001",
        },
      }),
    })
  ).json()) as { ok: boolean; delivered: number; envelopeId: string };
  expect(push.ok).toBe(true);
  expect(push.delivered).toBeGreaterThan(0);

  // The envelope was acked immediately by envelope_id.
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { log: Array<{ direction: string; envelopeId: string }> };
      return status.log.some(
        (l) => l.direction === "ack" && l.envelopeId === push.envelopeId,
      );
    })
    .toBe(true);

  // Same governed pipeline as the webhook path: session + threaded reply.
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ surface: string }>(
        "SELECT surface FROM sessions WHERE surface_key = 'slack:C888:1799.001'",
      );
      return rows[0]?.surface ?? "";
    })
    .toBe("Slack #eng-socket");
  const [session] = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE surface_key = 'slack:C888:1799.001'",
  );
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ role: string; content: string }>(
        "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at",
        [session!.id],
      );
      return rows.map((m) => `${m.role}:${m.content}`);
    })
    .toEqual([
      "user:Deploy status over the socket?",
      "agent:Mock reply to: Deploy status over the socket?",
    ]);

  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as {
    requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
  };
  expect(
    log.requests.some(
      (r) =>
        r.path === "/api/chat.postMessage" &&
        r.body.thread_ts === "1799.001" &&
        r.body.text?.includes("Mock reply to: Deploy status over the socket?"),
    ),
  ).toBe(true);

  // A redelivered envelope (same event_id) never runs a second turn.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "EvSockDup1",
      event: {
        type: "message",
        channel: "C888",
        user: "U777",
        text: "Deploy status over the socket?",
        ts: "1799.001",
      },
    }),
  });
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "EvSockDup1",
      event: {
        type: "message",
        channel: "C888",
        user: "U777",
        text: "Deploy status over the socket?",
        ts: "1799.001",
      },
    }),
  });
  // Let the first redelivery finish its turn, then confirm exactly one ran.
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE session_id = $1",
        [session!.id],
      );
      return Number(rows[0]!.n);
    })
    .toBe(4);
  await page.waitForTimeout(1500);
  const finalCount = await dbQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM messages WHERE session_id = $1",
    [session!.id],
  );
  expect(Number(finalCount[0]!.n)).toBe(4);
});

test("socket mode interactivity: DM buttons resolve approvals over the WebSocket", async () => {
  // A user-auth tool raised from the socket channel pends on a DM ask…
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_issue",
      toolArgs: { title: "Filed over the socket" },
    }),
  });
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "C888",
        user: "U777",
        text: "File an issue about socket approvals",
        ts: "1799.100",
      },
    }),
  });

  // …grab the ask's approvalId from the DM the emulator received…
  let value = "";
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{
          path: string;
          body: {
            channel?: string;
            blocks?: Array<{ elements?: Array<{ action_id?: string; value?: string }> }>;
          };
        }>;
      };
      const dm = [...log.requests]
        .reverse()
        .find(
          (r) =>
            r.path === "/api/chat.postMessage" &&
            r.body.channel === "U777" &&
            // Only THIS test's ask — earlier webhook tests DM'd the same
            // buttons; the socket surface name disambiguates.
            (r.body as { text?: string }).text?.includes("Slack #eng-socket") &&
            r.body.blocks?.some((b) =>
              b.elements?.some((el) => el.action_id === "rabble_approve"),
            ),
        );
      value =
        dm?.body.blocks
          ?.flatMap((b) => b.elements ?? [])
          .find((el) => el.action_id === "rabble_approve")?.value ?? "";
      return value.length > 0;
    })
    .toBe(true);

  // …and answer it as an interactivity envelope pushed down the socket.
  const push = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-interaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          type: "block_actions",
          user: { id: "U777" },
          response_url: `${EMULATOR}/mock/slack.com/response/socket-appr-1`,
          actions: [{ action_id: "rabble_approve", value }],
        },
      }),
    })
  ).json()) as { delivered: number };
  expect(push.delivered).toBeGreaterThan(0);

  // The turn resumes, the tool runs approved, and the DM's buttons get
  // swapped for the outcome via response_url.
  expect(
    await pollFirstToolCall("%File an issue about socket approvals%", 20000),
  ).toMatchObject({
    name: "create_issue",
    authType: "user",
    approval: { status: "approved", decidedByName: "Alex Lin" },
  });
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/response/socket-appr-1" &&
          r.body.text?.includes("Approved — the agent is continuing"),
      );
    })
    .toBe(true);
});

test("the Builder creates a measured draft agent conversationally", async () => {
  // The quiet affordance on the Sessions landing targets the Builder.
  await page.goto("/sessions");
  await page
    .getByRole("button", { name: "Have the Builder create one with you →" })
    .click();
  await expect(page.locator(".target-pill")).toContainText("Builder");

  // Script the model: it asks to create the draft (a platform tool).
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "create_agent_draft",
      toolArgs: {
        name: "Release Notes Bot",
        description: "Drafts release notes from merged PRs",
        instructions: "Summarize merged PRs into crisp release notes.",
      },
    }),
  });
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("I want an agent that drafts release notes");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Platform tools act as the user — the standard approval card pauses it.
  const card = page.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText("create_agent_draft");
  await card.getByRole("button", { name: "Approve as me" }).click();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to:",
    { timeout: 15000 },
  );

  // The draft exists, belongs to its maker, and the audit says via Builder.
  const [draft] = await dbQuery<{ id: string; status: string; created_by: string }>(
    "SELECT id, status, created_by FROM agents WHERE name = 'Release Notes Bot'",
  );
  expect(draft).toBeDefined();
  expect(draft!.status).toBe("draft");
  const [alex] = await dbQuery<{ id: string }>(
    "SELECT id FROM users WHERE email = 'alex@acme.com'",
  );
  expect(draft!.created_by).toBe(alex!.id);
  expect(
    await pollFirstToolCall("%I want an agent that drafts release notes%"),
  ).toMatchObject({
    name: "create_agent_draft",
    serverName: "Rabble platform",
    authType: "user",
    approval: { status: "approved", decidedByName: "Alex Lin" },
  });
  const createAudit = await dbQuery<{ summary: string }>(
    `SELECT summary FROM audit_events
     WHERE action = 'agent.create' AND summary LIKE '%via Builder%'`,
  );
  expect(createAudit).toHaveLength(1);

  // Born measured: a second turn adds an eval criterion to the new draft.
  // (Now the id is known, the scripted tool args can reference it.)
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "add_eval_criterion",
      toolArgs: {
        agentId: draft!.id,
        name: "Accurate notes",
        description: "Notes only mention PRs that actually merged.",
      },
    }),
  });
  await page.getByPlaceholder("Message Builder…").fill("Add a quality bar for it");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Session posture: the first approval covers the rest of this session.
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ name: string }>(
        "SELECT name FROM eval_criteria WHERE agent_id = $1",
        [draft!.id],
      );
      return rows.map((r) => r.name);
    })
    .toEqual(["Accurate notes"]);
  expect(await pollFirstToolCall("%Add a quality bar for it%")).toMatchObject({
    name: "add_eval_criterion",
    authType: "user",
    approval: { status: "auto-approved" },
  });
  const criterionAudit = await dbQuery<{ summary: string }>(
    `SELECT summary FROM audit_events
     WHERE action = 'eval.criterion.add' AND summary LIKE '%via Builder%'`,
  );
  expect(criterionAudit).toHaveLength(1);

  // Third turn: an adversarial test case lands in a suite it creates.
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "add_test_case",
      toolArgs: {
        agentId: draft!.id,
        suiteName: "Launch checks",
        caseName: "No invented PRs",
        input: "Write release notes for v2.0",
        rubric: "Notes must not mention any PR that isn't in the provided list.",
      },
    }),
  });
  await page
    .getByPlaceholder("Message Builder…")
    .fill("What's the worst thing it could do? Guard against that.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ name: string; suite: string }>(
        `SELECT c.name, s.name AS suite FROM eval_cases c
         JOIN eval_suites s ON s.id = c.suite_id
         WHERE s.agent_id = $1`,
        [draft!.id],
      );
      return rows;
    })
    .toEqual([{ name: "No invented PRs", suite: "Launch checks" }]);
  const caseAudit = await dbQuery<{ summary: string }>(
    `SELECT summary FROM audit_events
     WHERE action = 'eval.case.add' AND summary LIKE '%via Builder%'`,
  );
  expect(caseAudit).toHaveLength(1);

  // Fourth turn: correctability — the user fixes what the Builder inferred.
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "update_agent_draft",
      toolArgs: {
        agentId: draft!.id,
        description: "Drafts release notes from merged PRs, grouped by area",
      },
    }),
  });
  await page
    .getByPlaceholder("Message Builder…")
    .fill("Actually, group the notes by product area");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ description: string }>(
        "SELECT description FROM agents WHERE id = $1",
        [draft!.id],
      );
      return rows[0]?.description;
    })
    .toBe("Drafts release notes from merged PRs, grouped by area");
  const updateAudit = await dbQuery<{ summary: string }>(
    `SELECT summary FROM audit_events
     WHERE action = 'agent.update' AND summary LIKE '%via Builder%'`,
  );
  expect(updateAudit).toHaveLength(1);
});

test("'agent from this session' hands the transcript to the Builder", async () => {
  // From a normal work session, the affordance spins up a Builder session
  // seeded with what the user kept asking for.
  await page.goto("/sessions");
  // Renamed from "What is the deploy status?" in journey 01.
  await page.locator(".sidebar-item", { hasText: "Deploy status check" }).click();
  await page.getByRole("button", { name: "✦ agent from this" }).click();

  await expect(page.locator(".thread-composer textarea")).toHaveAttribute(
    "placeholder",
    "Message Builder…",
  );
  await expect(page.locator(".msg-user").first()).toContainText(
    "draft an agent for it",
    { timeout: 15000 },
  );
  await expect(page.locator(".msg-user").first()).toContainText(
    "What is the deploy status?",
  );
  // The scripted queue is empty, so the Builder just echoes — the point is
  // the session exists, targets the Builder, and carries the context.
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to:",
    { timeout: 15000 },
  );
});

test("pulse-back: a sagging pass rate DMs the agent's owner", async () => {
  // Plant enough recent failures that after today's failing judgment the
  // 7-day pass rate is guaranteed at or under the 60% alert floor — the
  // suite's earlier (passing) judgments count toward the same window.
  const [criteria] = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM eval_criteria ec
     JOIN agents a ON a.id = ec.agent_id
     WHERE a.name = 'Eng On-Call' AND ec.enabled`,
  );
  expect(criteria!.n).toBeGreaterThan(0);
  const [window] = await dbQuery<{ graded: number; passed: number }>(
    `SELECT count(*)::int AS graded, count(*) FILTER (WHERE er.passed)::int AS passed
     FROM eval_results er
     JOIN eval_criteria ec ON ec.id = er.criterion_id
     JOIN agents a ON a.id = ec.agent_id AND a.name = 'Eng On-Call'
     WHERE er.created_at > now() - interval '7 days'`,
  );
  // rate = passed / (graded + planted + N_new_fails) <= 0.6, min 3 planted
  const planted = Math.max(
    3,
    Math.ceil(window!.passed / 0.6) - window!.graded - criteria!.n,
  );
  await dbQuery(
    `INSERT INTO eval_results (criterion_id, session_id, passed, reasoning, created_at)
     SELECT ec.id, s.id, false, 'planted for alert', now() - ((n % 48) || ' hours')::interval
     FROM (SELECT ec.id FROM eval_criteria ec
           JOIN agents a ON a.id = ec.agent_id AND a.name = 'Eng On-Call'
           WHERE ec.enabled LIMIT 1) ec
     CROSS JOIN (SELECT id FROM sessions ORDER BY created_at LIMIT 1) s
     CROSS JOIN generate_series(1, $1::int) n`,
    [planted],
  );
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { type: "text", text: "Deploys are on fire, sorry." },
      ...Array.from({ length: criteria!.n }, () => ({
        type: "text",
        text: "FAIL\nThe reply did not help.",
      })),
    ]),
  });

  await page.goto("/sessions");
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("How are deploys looking today?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Deploys are on fire",
    { timeout: 15000 },
  );

  // The judgment lands, the floor is crossed, the owner gets pinged.
  await expect
    .poll(
      async () => {
        const rows = await dbQuery<{ summary: string }>(
          "SELECT summary FROM audit_events WHERE action = 'eval.alert'",
        );
        return rows[0]?.summary ?? "";
      },
      { timeout: 15000 },
    )
    .toMatch(/Pass rate dropped to \d+% \(\d+ graded, 7d\) for "Eng On-Call"/);
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
          r.body.text?.includes("pass rate dropped") &&
          r.body.text?.includes("Eng On-Call"),
      );
    })
    .toBe(true);

  // Clean the planted rows so later stats stay grounded in real judgments.
  await dbQuery("DELETE FROM eval_results WHERE reasoning = 'planted for alert'");
});

test("share is one verb: audience, plain-language right, pause/unshare", async () => {
  // The Builder-made draft is shared from a single Share button.
  await page.goto("/agents");
  await page.locator(".dir-table tbody tr", { hasText: "Release Notes Bot" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const modal = page.locator(".modal");
  await expect(modal).toBeVisible();

  // Track record is the evidence chip — a fresh draft has none yet.
  await expect(modal).toContainText("no track record yet");

  // Audience (teams first) + plain-language rights sentence
  await modal.locator("select").selectOption({ label: "Platform" });
  await expect(modal).toContainText("Platform can talk to this agent in sessions.");
  await modal.getByRole("button", { name: "Share", exact: true }).click();
  await expect(modal.locator(".row", { hasText: "Platform" })).toBeVisible();
  const granted = await dbQuery<{ access_right: string }>(
    `SELECT g.access_right FROM grants g
     JOIN teams t ON t.id = g.subject_id AND t.slug = 'platform'
     JOIN agents a ON a.id = g.target_id AND a.name = 'Release Notes Bot'
     WHERE g.subject_type = 'team' AND g.target_type = 'agent'`,
  );
  expect(granted).toEqual([{ access_right: "use" }]);

  // Optional deploy-to-Slack, right in the share flow
  await modal.getByPlaceholder("#channel").fill("#relnotes");
  await modal.getByRole("button", { name: "Attach" }).click();
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ label: string }>(
        "SELECT label FROM agent_surfaces WHERE label = '#relnotes'",
      );
      return rows.length;
    })
    .toBe(1);

  // Visible pause/unshare: activate the draft, then pause it back
  await modal.getByRole("button", { name: "Activate" }).click();
  await expect(modal.getByRole("button", { name: "Pause sharing" })).toBeVisible();
  expect(
    (
      await dbQuery<{ status: string }>(
        "SELECT status FROM agents WHERE name = 'Release Notes Bot'",
      )
    )[0]!.status,
  ).toBe("active");
  await modal.getByRole("button", { name: "Pause sharing" }).click();
  await expect(modal.getByRole("button", { name: "Activate" })).toBeVisible();
  expect(
    (
      await dbQuery<{ status: string }>(
        "SELECT status FROM agents WHERE name = 'Release Notes Bot'",
      )
    )[0]!.status,
  ).toBe("draft");

  await modal.locator(".row", { hasText: "Platform" }).getByRole("button", { name: "Unshare" }).click();
  await expect(modal.locator(".row", { hasText: "Platform" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const rows = await dbQuery(
        `SELECT g.id FROM grants g
         JOIN agents a ON a.id = g.target_id AND a.name = 'Release Notes Bot'
         WHERE g.target_type = 'agent'`,
      );
      return rows.length;
    })
    .toBe(0);
  // Leave it active (and unshared) — the next test requests access to it.
  await modal.getByRole("button", { name: "Activate" }).click();
  await expect(modal.getByRole("button", { name: "Pause sharing" })).toBeVisible();
  await modal.getByRole("button", { name: "Done" }).click();
});

test("request access from the agent page (web-native loop)", async ({
  browser,
}) => {
  const beaPage = await browser.newPage();
  await beaPage.goto("/");
  await beaPage.locator("input[type=email]").fill("bea@acme.com");
  await beaPage.locator("input[type=password]").fill("bea-real-password-1");
  await beaPage.getByRole("button", { name: "Sign in" }).click();
  await expect(beaPage.locator(".session-greeting")).toBeVisible();

  // Bea can see the active agent (the directory is a trust surface) but
  // holds no right on it — the header offers Request access instead.
  const [bot] = await dbQuery<{ id: string }>(
    "SELECT id FROM agents WHERE name = 'Release Notes Bot'",
  );
  await beaPage.goto(`/agents/${bot!.id}`);
  await beaPage.getByRole("button", { name: "Request access" }).click();
  const modal = beaPage.locator(".modal");
  await expect(modal).toContainText("Talk to this agent in sessions.");
  await modal
    .getByPlaceholder("What are you trying to do?")
    .fill("Need release notes for my launches");
  await modal.getByRole("button", { name: "Send request" }).click();
  await expect(modal).toContainText("Request sent");

  // A second open request for the same target is refused politely.
  const dup = await beaPage.request.post("/api/access-requests", {
    data: { targetType: "agent", targetId: bot!.id, accessRight: "use" },
  });
  expect(dup.status()).toBe(409);

  const requestRows = await dbQuery<{ via: string; status: string }>(
    `SELECT via, status FROM access_requests
     WHERE target_id = $1 AND access_right = 'use'`,
    [bot!.id],
  );
  expect(requestRows).toEqual([{ via: "web", status: "open" }]);

  // Admin approves from the same screen; evidence shows the no-data case.
  await page.goto("/admin/access-requests");
  const row = page.locator(".row", { hasText: "Release Notes Bot" }).first();
  await expect(row).toContainText("Bea Ortiz");
  await expect(row.locator(".chip", { hasText: "no track record yet" })).toBeVisible();
  await expect(row.locator(".chip", { hasText: "via Builder" })).toHaveCount(0);
  await row.getByRole("button", { name: "Approve", exact: true }).click();

  await expect
    .poll(async () => {
      const res = await beaPage.request.get(`/api/agents/${bot!.id}`);
      return ((await res.json()) as { myRight: string | null }).myRight;
    })
    .toBe("use");
  await beaPage.close();
});

test("hitting an access limit becomes a request an admin approves", async ({
  browser,
}) => {
  // Bea (member, use-only on Eng On-Call) asks the Builder for edit access.
  const beaPage = await browser.newPage();
  await beaPage.goto("/");
  await beaPage.locator("input[type=email]").fill("bea@acme.com");
  await beaPage.locator("input[type=password]").fill("bea-real-password-1");
  await beaPage.getByRole("button", { name: "Sign in" }).click();
  await expect(beaPage.locator(".session-greeting")).toBeVisible();

  await beaPage
    .getByRole("button", { name: "Have the Builder create one with you →" })
    .click();
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool_call",
      toolName: "request_access",
      toolArgs: {
        targetType: "agent",
        targetName: "Eng On-Call",
        right: "edit",
        reason: "Tune the CI triage instructions",
      },
    }),
  });
  await beaPage
    .getByPlaceholder("Describe what you need help with…")
    .fill("I need to edit Eng On-Call's instructions");
  await beaPage.getByRole("button", { name: "Send", exact: true }).click();

  const card = beaPage.locator(".approval-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText("request_access");
  await card.getByRole("button", { name: "Approve as me" }).click();

  // The request lands open, attributed via Builder…
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ status: string; via: string }>(
        "SELECT status, via FROM access_requests WHERE access_right = 'edit'",
      );
      return rows[0] ?? null;
    })
    .toEqual({ status: "open", via: "builder" });

  // …and the org admins get a Slack DM ping with the context attached.
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
          r.body.text?.includes("Bea Ortiz requests edit") &&
          r.body.text?.includes("via Builder"),
      );
    })
    .toBe(true);

  // Alex reviews it on the new Admin screen and approves.
  await page.goto("/admin/access-requests");
  const requestRow = page.locator(".row", { hasText: "Bea Ortiz requests" });
  await expect(requestRow).toBeVisible();
  await expect(requestRow).toContainText("edit");
  await expect(requestRow).toContainText("Eng On-Call");
  await expect(requestRow).toContainText("Tune the CI triage instructions");
  await expect(requestRow.locator(".chip", { hasText: "via Builder" })).toBeVisible();
  // Track record shown as evidence for the decision — the thesis in one chip
  // (Eng On-Call was judged in the evals journey, so a 30d pass rate exists).
  await expect(requestRow.locator(".chip", { hasText: "% pass" })).toBeVisible();
  await expect(requestRow.locator(".chip", { hasText: "graded" })).toContainText(
    /\d+% pass · \d+ graded/,
  );
  await requestRow.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".row", { hasText: "Approved by Alex Lin" })).toBeVisible();

  // The grant materialized and Bea's effective right actually changed.
  const [engOnCall] = await dbQuery<{ id: string }>(
    "SELECT id FROM agents WHERE name = 'Eng On-Call'",
  );
  const grantRows = await dbQuery<{ access_right: string; subject_type: string }>(
    `SELECT g.access_right, g.subject_type FROM grants g
     JOIN users u ON u.id = g.subject_id
     WHERE u.email = 'bea@acme.com' AND g.target_type = 'agent' AND g.target_id = $1`,
    [engOnCall!.id],
  );
  expect(grantRows).toEqual([{ access_right: "edit", subject_type: "user" }]);
  const me = await beaPage.request.get(`/api/agents/${engOnCall!.id}`);
  expect(((await me.json()) as { myRight: string }).myRight).toBe("edit");

  const grantAudit = await dbQuery<{ summary: string }>(
    `SELECT summary FROM audit_events
     WHERE action = 'grant.add'
       AND summary LIKE '%edit on agent "Eng On-Call"%approved access request%'`,
  );
  expect(grantAudit).toHaveLength(1);
  await beaPage.close();
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
  await expect(linearRow.locator(".chip", { hasText: "connected" })).toBeVisible();

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
