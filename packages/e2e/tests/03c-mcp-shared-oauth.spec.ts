/**
 * Shared MCP OAuth donation (slice c). A shared-credential MCP server whose
 * endpoint 401s at registration is auto-detected as OAuth (auth-server
 * discovery + dynamic client registration, tools left empty until a grant
 * exists). Rather than each user connecting, ONE admin DONATES their account
 * as the org credential: the donation authorize/callback dance stores the
 * grant ORG-LEVEL on the mcp_servers row (access + refresh + expiry + who
 * donated) and discovers the tool catalog. A shared/service tool then runs on
 * that org-donated token for the acting user — no per-user connect — and the
 * org token is refreshed in place when it expires.
 *
 * This registers a SEPARATE server ("Ops Incidents", slug ops-incidents)
 * pointing at the SAME emulator OAuth endpoint the personal slice (03-tools)
 * used; the emulator mints fresh tokens per authorize, so the two are
 * independent. It attaches to Eng On-Call and detaches in afterAll so the
 * later Slack/socket/admin suites see the agent's original tool set.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMULATOR } from "../global-setup";
import { dbQuery, pollFirstToolCall } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;
let serverId = "";

async function enqueueToolCall(name: string, args: Record<string, unknown>) {
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tool_call", toolName: name, toolArgs: args }),
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/");
  await page.locator("input[type=email]").fill("alex@acme.com");
  await page.locator("input[type=password]").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();
});

test.afterAll(async () => {
  // Detach Ops Incidents from Eng On-Call so its live tool set returns to what
  // the Slack/socket/admin suites expect. The registration + org grant persist
  // — no later suite pins the exact server list.
  if (serverId) {
    const [eng] = await dbQuery<{ id: string }>(
      "SELECT id FROM agents WHERE name = 'Eng On-Call'",
    );
    if (eng) {
      await page.request
        .delete(`/api/agents/${eng.id}/mcp-servers/${serverId}`)
        .catch(() => {});
    }
  }
  await page.close();
});

test("register a shared OAuth MCP server (auto-detected, awaiting donation)", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.getByRole("button", { name: "+ Add server" }).click();
  await page.getByRole("button", { name: "Custom server" }).click();
  await page.getByPlaceholder("GitHub").fill("Ops Incidents");
  await page
    .getByPlaceholder("https://mcp.example.com/mcp")
    .fill(`${EMULATOR}/mock/oauthmcp/mcp`);
  // Shared mode + an endpoint that 401s → Rabble discovers the auth server and
  // dynamically registers a client. Leave the token BLANK: the org credential
  // arrives later, by donation.
  await page
    .locator(".modal .field", { hasText: "Credential" })
    .locator("select")
    .selectOption("shared");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();

  const row = page.locator(".row", { hasText: "Ops Incidents" });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "shared" })).toBeVisible();
  // Tools stay empty until the first donation discovers the catalog.
  await expect(row.locator(".chip.blue")).toHaveText("0 tools");

  const [server] = await dbQuery<{
    credential_mode: string;
    has_oauth: boolean;
    has_token: boolean;
    n: number;
  }>(
    `SELECT credential_mode,
            oauth_config IS NOT NULL AS has_oauth,
            encrypted_token IS NOT NULL AS has_token,
            jsonb_array_length(tools) AS n
       FROM mcp_servers WHERE slug = 'ops-incidents'`,
  );
  expect(server).toMatchObject({
    credential_mode: "shared",
    has_oauth: true,
    has_token: false, // no donation yet
    n: 0,
  });

  // The detail view offers the org-account connect (no donor yet).
  await row.click();
  await expect(page.getByRole("heading", { name: "Ops Incidents" })).toBeVisible();
  await expect(
    page.getByText("This server authenticates with OAuth", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect org account" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "‹ MCP servers" }).click();
});

test("an admin donates their account as the org credential", async () => {
  const [s] = await dbQuery<{ id: string }>(
    "SELECT id FROM mcp_servers WHERE slug = 'ops-incidents'",
  );
  serverId = s!.id;

  // Drive the donation hop deterministically (same shape as the personal
  // slice, but via the admin donate endpoint): (1) start — the server mints
  // PKCE + state and returns the emulator authorize URL; (2) hit authorize
  // with redirects OFF and read the Location it 302s to (Rabble's callback
  // carrying code&state); (3) GET that callback through page.request so the
  // session cookie rides — the shared branch exchanges the code, stores the
  // grant ORG-LEVEL, and discovers the tool catalog.
  const start = await page.request.post(
    `/api/mcp-servers/${serverId}/oauth/donate`,
  );
  expect(start.ok()).toBe(true);
  const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };

  const authRes = await page.request.get(authorizeUrl, { maxRedirects: 0 });
  expect(authRes.status()).toBe(302);
  const callbackUrl = authRes.headers()["location"]!;
  expect(callbackUrl).toContain("/api/mcp/oauth/callback");
  const cbRes = await page.request.get(callbackUrl);
  expect(cbRes.ok()).toBe(true);
  expect(cbRes.url()).toContain("mcp=connected");

  // The grant landed org-level on the mcp_servers row, stamped with the donor.
  const [donated] = await dbQuery<{
    has_token: boolean;
    has_refresh: boolean;
    has_exp: boolean;
    by_alex: boolean;
  }>(
    `SELECT encrypted_token IS NOT NULL AS has_token,
            encrypted_org_refresh_token IS NOT NULL AS has_refresh,
            org_token_expires_at IS NOT NULL AS has_exp,
            donated_by_user_id = (SELECT id FROM users WHERE email = 'alex@acme.com') AS by_alex
       FROM mcp_servers WHERE slug = 'ops-incidents'`,
  );
  expect(donated).toMatchObject({
    has_token: true,
    has_refresh: true,
    has_exp: true,
    by_alex: true,
  });

  // First donation discovered the catalog (both tools).
  const [toolCount] = await dbQuery<{ n: number }>(
    "SELECT jsonb_array_length(tools) AS n FROM mcp_servers WHERE slug = 'ops-incidents'",
  );
  expect(toolCount!.n).toBe(2);

  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'mcp.credential.donate' AND target_id = $1",
    [serverId],
  );
  expect(audit.length).toBeGreaterThanOrEqual(1);

  // The detail now names the donor and offers a Reconnect instead of Connect.
  // (Scoped to the banner's <strong> — the Access section's audience picker
  // also lists members by name.)
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "MCP servers" }).click();
  await page.locator(".row", { hasText: "Ops Incidents" }).click();
  await expect(
    page.locator("strong", { hasText: "Alex Lin" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await page.getByRole("button", { name: "‹ MCP servers" }).click();
});

test("a shared OAuth tool runs on the org-donated token", async () => {
  // Attach Ops Incidents to Eng On-Call via the governed MCP tab. Its tools
  // derive service (green) identity from the shared credential mode — so any
  // caller runs on the org's donated grant, not their own account.
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "mcp" }).click();
  await page
    .locator(".row", { hasText: "Ops Incidents" })
    .getByRole("button", { name: "Attach" })
    .click();

  const listRow = page.locator(".row", { hasText: "list_incidents" });
  await expect(listRow).toBeVisible();
  await expect(
    listRow.locator(".chip.green", { hasText: "service" }),
  ).toBeVisible();

  // A shared/service call runs INLINE — no approval card — for the acting
  // user (Alex, who happens to be the donor here; because the credential is
  // org-level, no per-user connect is involved either way).
  await enqueueToolCall("list_incidents", {});

  await page.locator("nav a[title='Sessions']").click();
  await page.getByRole("link", { name: "+ New session" }).click();
  await page.locator(".target-pill").click();
  await page.locator(".target-menu button", { hasText: "Eng On-Call" }).click();
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("List the open incidents");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.locator(".tool-call", { hasText: "list_incidents" }).first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: List the open incidents",
    { timeout: 15_000 },
  );
  await expect(page.locator(".approval-card")).toHaveCount(0);

  const call = await pollFirstToolCall("%List the open incidents%");
  expect(call).toMatchObject({ name: "list_incidents", authType: "service" });

  // The emulator saw tools/call carrying the org-donated OAuth ACCESS token —
  // the emulator-minted "at_…" shape, proving a real OAuth grant (not a
  // pasted org token) rode the wire.
  const log = (await (
    await fetch(`${EMULATOR}/admin/requests?host=mcp/oauthmcp`)
  ).json()) as {
    requests: Array<{ path: string; body: { name?: string; auth?: string | null } }>;
  };
  const calls = log.requests.filter(
    (r) => r.path === "tools/call" && r.body?.name === "list_incidents",
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1]!.body.auth).toMatch(/^at_/);
});

test("an expired org token refreshes transparently", async () => {
  // Capture the stored org token, then force it to look expired. The next
  // shared call must refresh (org refresh_token grant) before hitting the MCP
  // endpoint, rotating the token in place at the org level.
  const [before] = await dbQuery<{ encrypted_token: string }>(
    "SELECT encrypted_token FROM mcp_servers WHERE slug = 'ops-incidents'",
  );
  await dbQuery(
    "UPDATE mcp_servers SET org_token_expires_at = now() - interval '1 hour' WHERE slug = 'ops-incidents'",
  );

  await enqueueToolCall("list_incidents", {});
  // Continue the SAME session — service calls never gate, so just send again.
  await page.locator(".thread-composer textarea").fill("List the incidents again");
  await page.locator(".thread-composer button", { hasText: "Send" }).click();

  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: List the incidents again",
    { timeout: 15_000 },
  );
  const call = await pollFirstToolCall("%List the incidents again%");
  expect(call).toMatchObject({ name: "list_incidents", authType: "service" });

  // The transparent refresh rotated the stored org access token and pushed the
  // org expiry back into the future.
  const [after] = await dbQuery<{ encrypted_token: string; expired: boolean }>(
    "SELECT encrypted_token, org_token_expires_at <= now() AS expired FROM mcp_servers WHERE slug = 'ops-incidents'",
  );
  expect(after!.encrypted_token).not.toBe(before!.encrypted_token);
  expect(after!.expired).toBe(false);
});
