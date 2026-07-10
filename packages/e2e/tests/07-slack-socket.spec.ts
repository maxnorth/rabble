/**
 * Slack Socket Mode: events stream over the emulated WebSocket instead of
 * webhooks, 1:1 DMs talk to the connection-linked agent, and DM approval
 * buttons resolve over the socket interactivity path.
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
          r.body.text?.includes("Approved. The agent is continuing"),
      );
    })
    .toBe(true);
});
