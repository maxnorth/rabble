/**
 * Slack Socket Mode: events stream over the emulated WebSocket instead of
 * webhooks, 1:1 DMs talk to the connection-linked agent, DM approval
 * buttons resolve over the socket interactivity path, connections edit in
 * place (Socket Mode on/off, token rotation), and multiple workspaces'
 * sockets stay isolated.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
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

test("slack socket mode: events stream over the WebSocket instead of webhooks", async () => {
  // A second Slack connection carrying an app-level token — the server
  // should dial apps.connections.open and hold a socket to the emulator.
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.getByPlaceholder("Acme Slack").fill("Acme Slack (socket)");
  await page
    .getByRole("button", { name: "Connect with existing tokens instead" })
    .click();
  await page.getByPlaceholder("https://slack.com").fill(`${EMULATOR}/mock/slack.com`);
  await page.locator(".modal input[type=password]").first().fill("xoxb-emulated");
  await page.getByPlaceholder("xapp-…").fill("xapp-emulated");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "Acme Slack (socket)" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Socket Mode");

  // The socket actually connects (apps.connections.open -> ws upgrade).
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { connections: number };
      return status.connections;
    })
    .toBeGreaterThan(0);

  // Until an agent links to this connection there's no one to answer as: a
  // DM gets a pointer to the fix, but no session and no agent turn.
  const preLink = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          type: "message",
          channel: "D9001",
          channel_type: "im",
          user: "U777",
          text: "Anyone home?",
          ts: "1798.900",
        },
      }),
    })
  ).json()) as { delivered: number };
  expect(preLink.delivered).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.thread_ts === "1798.900" &&
          r.body.text?.includes("isn't linked to an agent yet"),
      );
    })
    .toBe(true);
  expect(
    await dbQuery("SELECT id FROM sessions WHERE surface_key = 'slack:D9001:1798.900'"),
  ).toHaveLength(0);

  // Link the on-call agent to the socket connection (its second workspace),
  // with #eng-socket answering every message.
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channels: { C888: "eng-socket" } }),
  });
  await dbQuery(
    `INSERT INTO agent_surfaces (agent_id, connection_id, label, response_mode)
     SELECT a.id, c.id, '#eng-socket', 'all' FROM agents a, connections c
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

  // The reply is posted to Slack AFTER the turn persists, so poll the emulator
  // log rather than reading it once — the DB poll above can win the race.
  await expect
    .poll(
      async () => {
        const log = (await (
          await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
        ).json()) as {
          requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
        };
        return log.requests.some(
          (r) =>
            r.path === "/api/chat.postMessage" &&
            r.body.thread_ts === "1799.001" &&
            r.body.text?.includes("Mock reply to: Deploy status over the socket?"),
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // A redelivery of the same message (same channel+ts) never runs a second
  // turn — even under a fresh event_id. This covers Slack sending one @-mention
  // as both app_mention and message.channels: message identity, not event_id,
  // is what dedupes.
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
      eventId: "EvSockDup2",
      event: {
        type: "message",
        channel: "C888",
        user: "U777",
        text: "Deploy status over the socket?",
        ts: "1799.001",
      },
    }),
  });
  // Give the redeliveries time to be processed (and deduped), then confirm the
  // single original turn is all that ran: still just user + agent.
  await page.waitForTimeout(1500);
  const finalCount = await dbQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM messages WHERE session_id = $1",
    [session!.id],
  );
  expect(Number(finalCount[0]!.n)).toBe(2);
});

test("a 1:1 DM talks to the connection's linked agent", async () => {
  // The socket connection is Eng On-Call's identity — a DM answers as that
  // agent directly, no routing involved.
  const push = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          type: "message",
          channel: "D9001",
          channel_type: "im",
          user: "U777",
          text: "Deploy status by DM?",
          ts: "1800.001",
        },
      }),
    })
  ).json()) as { delivered: number };
  expect(push.delivered).toBeGreaterThan(0);

  await expect
    .poll(async () => {
      const rows = await dbQuery<{ surface: string; slug: string }>(
        `SELECT s.surface, a.slug FROM sessions s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.surface_key = 'slack:D9001:1800.001'`,
      );
      return rows[0] ?? null;
    })
    .toEqual({ surface: "Slack DM", slug: "eng-on-call" });

  // The reply lands back in the DM thread.
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { channel?: string; thread_ts?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.channel === "D9001" &&
          r.body.thread_ts === "1800.001" &&
          r.body.text?.includes("Mock reply to: Deploy status by DM?"),
      );
    })
    .toBe(true);

  // Strangers get the polite refusal, never a session.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "D9002",
        channel_type: "im",
        user: "U888",
        text: "Hello, who are you?",
        ts: "1800.050",
      },
    }),
  });
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
          r.body.channel === "D9002" &&
          r.body.text?.includes("I can only act for Rabble users"),
      );
    })
    .toBe(true);
  const strangerSessions = await dbQuery(
    "SELECT id FROM sessions WHERE surface_key = 'slack:D9002:1800.050'",
  );
  expect(strangerSessions).toHaveLength(0);

  // The identity holds: even a Builder-shaped ask answers as the linked
  // agent — one Slack face never switches agents behind the scenes.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "D9001",
        channel_type: "im",
        user: "U777",
        text: "Can you build me an agent for onboarding docs?",
        ts: "1800.200",
      },
    }),
  });
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ slug: string; surface: string }>(
        `SELECT a.slug, s.surface FROM sessions s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.surface_key = 'slack:D9001:1800.200'`,
      );
      return rows[0] ?? null;
    })
    .toEqual({ slug: "eng-on-call", surface: "Slack DM" });
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.thread_ts === "1800.200" &&
          r.body.text?.includes("Mock reply to: Can you build me an agent"),
      );
    })
    .toBe(true);

  // DMs are a surface setting: turn them off on the workspace row and a DM
  // gets a short pointer instead of a session.
  await dbQuery(
    `INSERT INTO agent_surfaces (agent_id, connection_id, label, response_mode, dm_enabled)
     SELECT a.id, c.id, '', 'thread', false FROM agents a, connections c
     WHERE a.name = 'Eng On-Call' AND c.name = 'Acme Slack (socket)'`,
  );
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "D9001",
        channel_type: "im",
        user: "U777",
        text: "Still there?",
        ts: "1800.300",
      },
    }),
  });
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.thread_ts === "1800.300" &&
          r.body.text?.includes("doesn't take direct messages"),
      );
    })
    .toBe(true);
  expect(
    await dbQuery("SELECT id FROM sessions WHERE surface_key = 'slack:D9001:1800.300'"),
  ).toHaveLength(0);
  // Restore: later tests expect the socket connection's default behavior.
  await dbQuery(
    `DELETE FROM agent_surfaces
     WHERE label = '' AND connection_id =
       (SELECT id FROM connections WHERE name = 'Acme Slack (socket)')`,
  );
});

test("a threaded DM follow-up continues the same session and agent", async () => {
  // First message opens a DM thread — it answers as the connection's linked
  // agent (Eng On-Call), the only identity this Slack face has.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "D9003",
        channel_type: "im",
        user: "U777",
        text: "What's our deploy status?",
        ts: "1810.001",
      },
    }),
  });
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ slug: string }>(
        `SELECT a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
         WHERE s.surface_key = 'slack:D9003:1810.001'`,
      );
      return rows[0]?.slug ?? null;
    })
    .toBe("eng-on-call");

  // A follow-up IN THAT THREAD runs a second turn in the SAME session — a
  // continuing thread never opens a new session or switches agents, even
  // when the text is Builder-shaped.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        type: "message",
        channel: "D9003",
        channel_type: "im",
        user: "U777",
        text: "Actually, can you build me an agent for onboarding docs?",
        thread_ts: "1810.001",
        ts: "1810.002",
      },
    }),
  });

  // The follow-up ran (a second user+agent pair) and the session is STILL
  // Eng On-Call's.
  const [session] = await dbQuery<{ id: string; slug: string }>(
    `SELECT s.id, a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.surface_key = 'slack:D9003:1810.001'`,
  );
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ n: string }>(
        "SELECT count(*)::text AS n FROM messages WHERE session_id = $1",
        [session!.id],
      );
      return Number(rows[0]!.n);
    })
    .toBe(4);
  const [after] = await dbQuery<{ slug: string }>(
    `SELECT a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.surface_key = 'slack:D9003:1810.001'`,
  );
  expect(after!.slug).toBe("eng-on-call");

  // And the follow-up reply threaded back under the same root.
  await expect
    .poll(async () => {
      const log = (await (
        await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
      ).json()) as {
        requests: Array<{ path: string; body: { thread_ts?: string; text?: string } }>;
      };
      return log.requests.some(
        (r) =>
          r.path === "/api/chat.postMessage" &&
          r.body.thread_ts === "1810.001" &&
          r.body.text?.includes("Mock reply to: Actually, can you build me an agent"),
      );
    })
    .toBe(true);
});

test("editing a connection adds Socket Mode in place — surfaces survive", async () => {
  // The original webhook Slack connection carries the workspace-default and
  // #eng-oncall surfaces. Enabling Socket Mode must NOT mean delete +
  // recreate (which would cascade those mappings away) — an in-place edit
  // keeps them.
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();

  const webhookRow = page.locator(".row", {
    has: page.getByText("Acme Slack", { exact: true }),
  });
  await expect(webhookRow).toBeVisible();
  await expect(webhookRow).toContainText("answers as Eng On-Call");
  await expect(webhookRow.getByText("Socket Mode")).toHaveCount(0);

  const surfacesBefore = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_surfaces
     WHERE connection_id = (SELECT id FROM connections WHERE name = 'Acme Slack')`,
  );
  expect(Number(surfacesBefore[0]!.n)).toBe(2);

  const socketsBefore = (await (
    await fetch(`${EMULATOR}/admin/slack/socket`)
  ).json()) as { connections: number };

  // --- Add Socket Mode in place ---
  await webhookRow.getByRole("button", { name: "Edit" }).click();
  await page
    .getByPlaceholder("xapp-… (leave blank to keep)")
    .fill("xapp-emulated-edit");
  await page.getByRole("button", { name: "Save changes" }).click();

  // Socket Mode chip now shows, and the agent identity is intact.
  await expect(webhookRow).toContainText("Socket Mode");
  await expect(webhookRow).toContainText("answers as Eng On-Call");

  const surfacesAfter = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_surfaces
     WHERE connection_id = (SELECT id FROM connections WHERE name = 'Acme Slack')`,
  );
  expect(Number(surfacesAfter[0]!.n)).toBe(2);
  const [conn] = await dbQuery<{ has_app: boolean }>(
    `SELECT (encrypted_app_token IS NOT NULL) AS has_app
     FROM connections WHERE name = 'Acme Slack'`,
  );
  expect(conn!.has_app).toBe(true);

  // The server actually dialed out and a new socket came up.
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { connections: number };
      return status.connections;
    })
    .toBe(socketsBefore.connections + 1);

  // Audit recorded the edit (not an add/remove).
  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'connection.edit'",
  );
  expect(audit.length).toBeGreaterThan(0);

  // --- Turn Socket Mode back off — the mapping still survives, and the
  // socket is reclaimed (keeping the one-socket invariant for later tests). ---
  await webhookRow.getByRole("button", { name: "Edit" }).click();
  await page.getByText("Turn off Socket Mode (remove app token)").click();
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(webhookRow.getByText("Socket Mode")).toHaveCount(0);
  await expect(webhookRow).toContainText("answers as Eng On-Call");
  const [conn2] = await dbQuery<{ has_app: boolean }>(
    `SELECT (encrypted_app_token IS NOT NULL) AS has_app
     FROM connections WHERE name = 'Acme Slack'`,
  );
  expect(conn2!.has_app).toBe(false);
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { connections: number };
      return status.connections;
    })
    .toBe(socketsBefore.connections);
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
    }, { timeout: 15000 })
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
          r.body.text?.includes("Approved"),
      );
    })
    .toBe(true);
});

test("two Socket Mode workspaces stay isolated — events reach only their app", async () => {
  // A second workspace's app, alongside the existing Acme socket. Each app
  // gets its own socket; an event in one must not leak into (or be swallowed
  // by) the other — which is exactly what shared event-id dedupe would do if
  // the emulator broadcast to every socket.
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.getByPlaceholder("Acme Slack").fill("Beta Slack (socket)");
  await page
    .getByRole("button", { name: "Connect with existing tokens instead" })
    .click();
  await page.getByPlaceholder("https://slack.com").fill(`${EMULATOR}/mock/slack.com`);
  await page.locator(".modal input[type=password]").first().fill("xoxb-beta");
  await page.getByPlaceholder("xapp-…").fill("xapp-beta");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  await expect(
    page.locator(".row", { hasText: "Beta Slack (socket)" }),
  ).toBeVisible();

  // Both apps hold their own tagged socket.
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { apps: string[] };
      return status.apps.includes("xapp-emulated") && status.apps.includes("xapp-beta");
    })
    .toBe(true);

  // Beta maps its own channel to the on-call agent.
  await fetch(`${EMULATOR}/admin/slack`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channels: { C999: "beta-ops" } }),
  });
  await dbQuery(
    `INSERT INTO agent_surfaces (agent_id, connection_id, label, response_mode)
     SELECT a.id, c.id, '#beta-ops', 'all' FROM agents a, connections c
     WHERE a.name = 'Eng On-Call' AND c.name = 'Beta Slack (socket)'`,
  );

  // An event in Beta's channel, delivered only to Beta's socket. Under the
  // old broadcast behavior Acme's socket would have seen this event_id first
  // and (no #beta-ops mapping there) marked it delivered, starving Beta —
  // so a session appearing at all is the isolation proof.
  const push = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appToken: "xapp-beta",
        eventId: "EvBetaIso1",
        event: {
          type: "message",
          channel: "C999",
          user: "U777",
          text: "Beta workspace deploy status?",
          ts: "1850.001",
        },
      }),
    })
  ).json()) as { delivered: number };
  expect(push.delivered).toBe(1); // exactly one socket, not both

  await expect
    .poll(async () => {
      const rows = await dbQuery<{ surface: string }>(
        "SELECT surface FROM sessions WHERE surface_key = 'slack:C999:1850.001'",
      );
      return rows[0]?.surface ?? "";
    })
    .toBe("Slack #beta-ops");

  // Cross-check: the same channel event delivered to the WRONG app (Acme,
  // which has no #beta-ops mapping) never becomes a session.
  const wrong = (await (
    await fetch(`${EMULATOR}/admin/slack/socket-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appToken: "xapp-emulated",
        eventId: "EvBetaIso2",
        event: {
          type: "message",
          channel: "C999",
          user: "U777",
          text: "Wrong workspace, should be ignored",
          ts: "1850.002",
        },
      }),
    })
  ).json()) as { delivered: number };
  expect(wrong.delivered).toBe(1); // Acme's socket got it…
  // …but Acme has no agent on C999, so no session is ever created.
  await page.waitForTimeout(1500);
  const leaked = await dbQuery(
    "SELECT id FROM sessions WHERE surface_key = 'slack:C999:1850.002'",
  );
  expect(leaked).toHaveLength(0);
});

test("rotating an app token reconnects the socket with the new one", async () => {
  const opensBefore = await (async () => {
    const log = (await (
      await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
    ).json()) as { requests: Array<{ path: string }> };
    return log.requests.filter((r) => r.path === "/api/apps.connections.open").length;
  })();

  // Edit the Beta socket connection to a fresh app-level token.
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Connections" }).click();
  const betaRow = page.locator(".row", {
    has: page.getByText("Beta Slack (socket)", { exact: true }),
  });
  await betaRow.getByRole("button", { name: "Edit" }).click();
  await page
    .getByPlaceholder("xapp-… (leave blank to keep)")
    .fill("xapp-beta-rotated");
  await page.getByRole("button", { name: "Save changes" }).click();

  // The manager tears the old socket down and redials with the new token —
  // the emulator sees another apps.connections.open and re-tags the socket.
  await expect
    .poll(async () => {
      const status = (await (
        await fetch(`${EMULATOR}/admin/slack/socket`)
      ).json()) as { apps: string[] };
      return status.apps.includes("xapp-beta-rotated") && !status.apps.includes("xapp-beta");
    })
    .toBe(true);
  const opensAfter = (await (
    await fetch(`${EMULATOR}/admin/requests?host=slack.com`)
  ).json()) as { requests: Array<{ path: string }> };
  expect(
    opensAfter.requests.filter((r) => r.path === "/api/apps.connections.open").length,
  ).toBeGreaterThan(opensBefore);

  // The rotated socket still delivers: an event on Beta's channel lands.
  await fetch(`${EMULATOR}/admin/slack/socket-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appToken: "xapp-beta-rotated",
      eventId: "EvBetaRot1",
      event: {
        type: "message",
        channel: "C999",
        user: "U777",
        text: "Still listening after rotation?",
        ts: "1860.001",
      },
    }),
  });
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ surface: string }>(
        "SELECT surface FROM sessions WHERE surface_key = 'slack:C999:1860.001'",
      );
      return rows[0]?.surface ?? "";
    })
    .toBe("Slack #beta-ops");
});
