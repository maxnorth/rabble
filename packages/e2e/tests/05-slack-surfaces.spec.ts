/**
 * Slack as a surface: the connection (manual tokens + managed setup), agent
 * surface linking, signed webhook delivery into governed sessions, thread
 * auto-reply, shared-thread participation, and approvals decided from Slack
 * DMs or from the web session.
 */
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
import { dbQuery, pollFirstToolCall } from "./db";
import { SERVER, signedSlackPost } from "./helpers";

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
  // The managed flow (config token) is the default; this suite connects with
  // explicit emulator tokens instead.
  await page
    .getByRole("button", { name: "Connect with existing tokens instead" })
    .click();
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

test("slack managed setup: create → configure → install captures the bot token", async () => {
  // A Slack connection holding only a config token, pointed at the emulator.
  const created = await page.request.post(`${SERVER}/api/connections`, {
    data: {
      vendor: "slack",
      name: "Managed Slack",
      roles: ["Interface"],
      baseUrl: `${EMULATOR}/mock/slack.com`,
      configToken: "xoxe.xoxp-emulated",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { connection } = (await created.json()) as { connection: { id: string } };

  // Provision: Rabble creates + configures the app and returns an install URL.
  const provisioned = await page.request.post(
    `${SERVER}/api/connections/${connection.id}/slack/provision`,
    { data: { botName: "Rabble" } },
  );
  expect(provisioned.ok()).toBeTruthy();
  const prov = (await provisioned.json()) as { appId: string; installUrl: string };
  expect(prov.appId).toBeTruthy();
  expect(prov.installUrl).toContain("client_id=");

  // The app was created + configured against the (emulated) manifest API.
  const before = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as { requests: Array<{ path: string }> };
  expect(before.requests.some((r) => r.path === "/api/apps.manifest.create")).toBe(true);
  expect(before.requests.some((r) => r.path === "/api/apps.manifest.update")).toBe(true);

  // Credentials stored; the connection awaits install (no bot token yet).
  const [pending] = await dbQuery<{
    status: string;
    slack_app_id: string;
    has_bot: boolean;
    oauth_state: string;
  }>(
    "SELECT status, slack_app_id, (encrypted_token IS NOT NULL) AS has_bot, oauth_state FROM connections WHERE id = $1",
    [connection.id],
  );
  expect(pending!.status).toBe("needs-auth");
  expect(pending!.has_bot).toBe(false);
  expect(pending!.slack_app_id).toBeTruthy();

  // Slack redirects to the OAuth callback with the code + our state nonce.
  const callback = await fetch(
    `${SERVER}/api/connections/slack/oauth/callback?code=emu-code&state=${pending!.oauth_state}`,
    { redirect: "manual" },
  );
  expect([302, 303]).toContain(callback.status);

  // The code was exchanged and the bot token is now stored — connection live.
  const after = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as { requests: Array<{ path: string }> };
  expect(after.requests.some((r) => r.path === "/api/oauth.v2.access")).toBe(true);
  const [live] = await dbQuery<{
    status: string;
    has_bot: boolean;
    oauth_state: string | null;
  }>(
    "SELECT status, (encrypted_token IS NOT NULL) AS has_bot, oauth_state FROM connections WHERE id = $1",
    [connection.id],
  );
  expect(live!.status).toBe("connected");
  expect(live!.has_bot).toBe(true);
  expect(live!.oauth_state).toBeNull();

  // Clean up so later tests see only the Acme Slack connection.
  await page.request.delete(`${SERVER}/api/connections/${connection.id}`);
});

test("surfaces: linking a connection makes the agent its identity", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "surfaces" }).click();

  // Web sessions is always on; linking claims the Slack identity with
  // workspace defaults (mention + auto-reply in thread, DMs on).
  await expect(page.locator(".row", { hasText: "Web sessions" })).toBeVisible();
  await page.getByRole("button", { name: "+ Link a connection" }).click();
  await page
    .locator(".row", { hasText: "Acme Slack" })
    .getByRole("button", { name: "Link", exact: true })
    .click();
  const card = page.locator(".card", { hasText: "Acme Slack" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("In channels");
  await expect(card).toContainText("Direct messages");

  // A channel exception: #eng-oncall answers every message.
  await card.getByRole("button", { name: "+ Add a channel exception" }).click();
  const form = page.locator(".row", {
    has: page.getByPlaceholder("#eng-oncall"),
  });
  await form.getByPlaceholder("#eng-oncall").fill("#eng-oncall");
  await form
    .getByTitle("When this agent replies in the channel")
    .selectOption({ label: "Every message in channel" });
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.locator(".row", { hasText: "#eng-oncall" })).toBeVisible();

  const surfaces = await dbQuery<{ label: string; response_mode: string }>(
    "SELECT label, response_mode FROM agent_surfaces ORDER BY label",
  );
  expect(surfaces).toEqual([
    { label: "", response_mode: "thread" },
    { label: "#eng-oncall", response_mode: "all" },
  ]);

  // Web access is a surface setting too: off blocks composer sessions and
  // Auto routing; back on restores them.
  const [engOnCall] = await dbQuery<{ id: string }>(
    "SELECT id FROM agents WHERE name = 'Eng On-Call'",
  );
  await page.getByRole("switch", { name: "Web sessions" }).click();
  await expect
    .poll(async () =>
      (
        await dbQuery<{ web_enabled: boolean }>(
          "SELECT web_enabled FROM agents WHERE name = 'Eng On-Call'",
        )
      )[0]!.web_enabled,
    )
    .toBe(false);
  const blocked = await page.request.post("/api/sessions", {
    data: { agentId: engOnCall!.id },
  });
  expect(blocked.status()).toBe(403);
  await page.getByRole("switch", { name: "Web sessions" }).click();
  await expect
    .poll(async () =>
      (
        await dbQuery<{ web_enabled: boolean }>(
          "SELECT web_enabled FROM agents WHERE name = 'Eng On-Call'",
        )
      )[0]!.web_enabled,
    )
    .toBe(true);

  // The connections list shows whose identity this connection now is
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(
    page.locator(".row", { hasText: "Acme Slack" }).locator(".chip", { hasText: "Eng On-Call" }),
  ).toBeVisible();

  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'agent.surface.add'",
  );
  expect(audit).toHaveLength(2);
});

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

test("auto-reply in thread: a mention starts it, untagged follow-ups answer", async () => {
  // The workspace-level surface (created by the link flow, default 'thread')
  // carries the response mode for every channel without its own row: a
  // mention opens the thread, then follow-ups inside it answer untagged.
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channels: { C780: "random" } }),
  });

  // The mention engages (channel has no row of its own) and opens a thread.
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "app_mention",
      channel: "C780",
      user: "U777",
      text: "<@U0EMU> what broke overnight?",
      ts: "1713.001",
    },
  });
  const [threadSession] = await dbQuery<{ id: string }>(
    "SELECT id FROM sessions WHERE surface_key = 'slack:C780:1713.001'",
  );
  expect(threadSession).toBeDefined();

  // The untagged follow-up inside the thread runs a second turn in the same
  // session. This is the auto-reply-in-thread regression check: mode must
  // come from the workspace surface, not fall back to mention-only.
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C780",
      user: "U777",
      text: "Anything in the deploy logs?",
      ts: "1713.002",
      thread_ts: "1713.001",
    },
  });
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ role: string }>(
        "SELECT role FROM messages WHERE session_id = $1 ORDER BY created_at",
        [threadSession!.id],
      );
      return rows.map((m) => m.role);
    })
    .toEqual(["user", "agent", "user", "agent"]);

  // An untagged message OUTSIDE the thread stays ignored in 'thread' mode.
  await signedSlackPost({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C780",
      user: "U777",
      text: "Nobody asked you here",
      ts: "1713.100",
    },
  });
  await page.waitForTimeout(1000);
  expect(
    await dbQuery("SELECT id FROM sessions WHERE surface_key = 'slack:C780:1713.100'"),
  ).toHaveLength(0);
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
    }, { timeout: 15000 })
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
