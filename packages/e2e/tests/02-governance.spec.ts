/**
 * Governance: teams, domains, grants — and their enforcement. Runs after the
 * journey spec, which leaves an org (Acme Corp), an owner (alex@acme.com),
 * an active agent (Eng On-Call), and a Mock Model.
 */
import { expect, test, type Page } from "@playwright/test";
import { dbQuery } from "./db";

test.describe.configure({ mode: "serial" });

let page: Page;
let memberEmail = "";
let memberPassword = "";

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

test("settings: invite a member (Everyone membership is automatic)", async () => {
  await page.locator("nav a[title='Admin']").click();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByPlaceholder("Name").fill("Bea Ortiz");
  await page.getByPlaceholder("Email").fill("bea@acme.com");
  await page.getByRole("button", { name: "+ Invite" }).click();

  const card = page.locator(".card", { hasText: "temporary password" });
  await expect(card).toBeVisible();
  const credentials = await card.locator("code").innerText();
  memberEmail = credentials.split(" / ")[0]!.trim();
  memberPassword = credentials.split(" / ")[1]!.trim();
  expect(memberEmail).toBe("bea@acme.com");

  const everyone = await dbQuery<{ count: string }>(
    `SELECT count(*) FROM team_members tm
     JOIN teams t ON t.id = tm.team_id WHERE t.is_everyone`,
  );
  expect(Number(everyone[0]!.count)).toBe(2);
});

test("teams: create hierarchy and add the member", async () => {
  await page.locator("nav a[title='Teams']").click();
  await page.getByRole("button", { name: "+ New team" }).click();
  await page.getByPlaceholder("Platform").fill("Engineering");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.locator(".sidebar-item", { hasText: "Engineering" })).toBeVisible();

  // Sub-team under Engineering
  await page.getByRole("button", { name: "+ New team" }).click();
  await page.getByPlaceholder("Platform").fill("Platform");
  await page.locator(".modal select").selectOption({ label: "Engineering" });
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.locator(".sidebar-item", { hasText: "› Platform" })).toBeVisible();

  // Add Bea to Platform
  await page.locator(".sidebar-item", { hasText: "› Platform" }).click();
  await page.locator("select").selectOption({ label: "Bea Ortiz (bea@acme.com)" });
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(page.locator(".row", { hasText: "Bea Ortiz" })).toBeVisible();

  const teams = await dbQuery<{ slug: string; parent: string | null }>(
    `SELECT t.slug, p.slug AS parent FROM teams t
     LEFT JOIN teams p ON p.id = t.parent_team_id
     WHERE NOT t.is_everyone ORDER BY t.slug`,
  );
  expect(teams).toEqual([
    { slug: "engineering", parent: null },
    { slug: "platform", parent: "engineering" },
  ]);
});

test("domains: create Engineering domain and assign the agent", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.getByTitle("Add domain").click();
  await page.getByPlaceholder("Engineering").fill("Engineering");
  await page.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(page.locator(".sidebar-item", { hasText: "Engineering" })).toBeVisible();

  // Assign Eng On-Call to the domain from its identity tab
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.locator("select").nth(1).selectOption({ label: "Engineering" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

  const agents = await dbQuery<{ slug: string; domain: string }>(
    `SELECT a.slug, d.slug AS domain FROM agents a JOIN domains d ON d.id = a.domain_id`,
  );
  expect(agents).toEqual([{ slug: "eng-on-call", domain: "engineering" }]);
});

test("grants: domain grant to Engineering team cascades to Platform member", async () => {
  // Grant use on the Engineering DOMAIN to the Engineering TEAM
  await page.locator(".sidebar-item", { hasText: "Engineering" }).first().click();
  const accessRow = page.locator(".row", { has: page.locator("select") });
  await accessRow.locator("select").selectOption({ label: "Engineering" });
  await accessRow.getByRole("button", { name: "+ Add", exact: true }).click();
  await expect(
    page.locator(".row", { hasText: "use · can talk to it" }),
  ).toBeVisible();

  const grants = await dbQuery<{
    subject_type: string;
    access_right: string;
    target_type: string;
  }>("SELECT subject_type, access_right, target_type FROM grants");
  expect(grants).toEqual([
    { subject_type: "team", access_right: "use", target_type: "domain" },
  ]);

  // Audit picked it up
  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'grant.set'",
  );
  expect(audit.length).toBe(1);
});

test("enforcement: the member can use the agent but not configure it", async ({
  browser,
}) => {
  const memberPage = await browser.newPage();
  await memberPage.goto("/");
  await memberPage.locator("input[type=email]").fill(memberEmail);
  await memberPage.locator("input[type=password]").fill(memberPassword);
  await memberPage.getByRole("button", { name: "Sign in" }).click();
  await expect(memberPage.locator(".session-greeting")).toBeVisible();

  // Bea is in Platform ⊂ Engineering; the domain grant reaches her.
  await memberPage.getByPlaceholder("Message an agent…").fill("Hello from Bea");
  await memberPage.getByRole("button", { name: "Send" }).click();
  await expect(memberPage.locator(".msg-agent .bubble")).toContainText(
    "Mock reply to: Hello from Bea",
    { timeout: 15_000 },
  );

  // Config is read-only for use-level access
  await memberPage.locator("nav a[title='Agents']").click();
  await memberPage.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await expect(memberPage.getByText("read-only")).toBeVisible();

  // And the API refuses writes outright
  const res = await memberPage.request.patch(
    `/api/agents/${(await dbQuery<{ id: string }>("SELECT id FROM agents LIMIT 1"))[0]!.id}`,
    { data: { description: "hacked" } },
  );
  expect(res.status()).toBe(403);
  await memberPage.close();
});

test("drafts are invisible to non-editors", async ({ browser }) => {
  // Owner creates a draft
  await page.locator("nav a[title='Agents']").click();
  await page.getByRole("button", { name: "+ New agent" }).click();
  await page.getByPlaceholder("Eng On-Call").fill("Secret Draft");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { name: "Secret Draft" })).toBeVisible();

  const memberPage = await browser.newPage();
  await memberPage.goto("/");
  await memberPage.locator("input[type=email]").fill(memberEmail);
  await memberPage.locator("input[type=password]").fill(memberPassword);
  await memberPage.getByRole("button", { name: "Sign in" }).click();
  await memberPage.locator("nav a[title='Agents']").click();
  await expect(memberPage.locator(".dir-table tbody tr", { hasText: "Eng On-Call" })).toBeVisible();
  await expect(
    memberPage.locator(".dir-table tbody tr", { hasText: "Secret Draft" }),
  ).toHaveCount(0);
  await memberPage.close();
});
