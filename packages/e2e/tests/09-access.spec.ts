/**
 * Access as one verb: sharing with an audience at a plain-language right
 * (with pause/unshare), web-native access requests from the agent page, and
 * limit-hits that become requests an admin approves.
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

  // Share reports reachability but never configures it (that's Surfaces):
  // this draft has no Slack identity, and the modal says so.
  await expect(modal).toContainText("Web sessions only");

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

test("share evidence surfaces the safety half — recent scope violations", async () => {
  // Eng On-Call recorded an out-of-scope tool attempt in the tools journey.
  // The Share chip must show that safety signal (not just the eval score) and
  // flag amber, the same evidence an approver sees in the access queue.
  await page.goto("/agents");
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const chip = page.locator(".modal h2 .chip");
  await expect(chip).toContainText("scope violation");
  await expect(chip).toHaveClass(/amber/);
  await page.locator(".modal").getByRole("button", { name: "Done" }).click();
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
  // Scope to THIS request's decided row — an earlier test already produced an
  // "Approved by Alex Lin" row, which must not satisfy this wait.
  await expect(
    page.locator(".row", { hasText: "Bea Ortiz · edit on agent" }),
  ).toContainText("Approved by Alex Lin");

  // The grant materialized and Bea's effective right actually changed.
  // Poll the DB: the grant row lands just after the "Approved" text renders
  // (writes trail the UI — same reason the earlier assertions poll).
  const [engOnCall] = await dbQuery<{ id: string }>(
    "SELECT id FROM agents WHERE name = 'Eng On-Call'",
  );
  await expect
    .poll(async () =>
      dbQuery<{ access_right: string; subject_type: string }>(
        `SELECT g.access_right, g.subject_type FROM grants g
         JOIN users u ON u.id = g.subject_id
         WHERE u.email = 'bea@acme.com' AND g.target_type = 'agent' AND g.target_id = $1`,
        [engOnCall!.id],
      ),
    )
    .toEqual([{ access_right: "edit", subject_type: "user" }]);
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
