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
  await expect(page.locator(".row .title", { hasText: "Stays on topic" })).toBeVisible();

  // "Born measured": a starter template fills the form for review (not a silent
  // add) — the manual path toward measuring an agent. Adding is the same
  // (already-tested) path, so just prove the starter populates both fields; we
  // don't persist a second criterion onto the shared agent here.
  await page.getByRole("button", { name: "+ Cites its source" }).click();
  await expect(
    page.getByPlaceholder("Criterion, e.g. Cites a runbook link"),
  ).toHaveValue("Cites its source");
  await expect(
    page.getByPlaceholder("What the judge should check (optional)"),
  ).toHaveValue(/points to where/);
});

test("a session gets judged and shows eval chips", async () => {
  await page.locator("nav a[title='Sessions']").click();
  await page.getByPlaceholder("Describe what you need help with…").fill("Is prod healthy?");
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

  // Reload the session — the header shows the criteria verdict chip
  await page.reload();
  const criteriaChip = page.locator("button.chip", { hasText: "criteria" });
  await expect(criteriaChip).toContainText("✓ 1/1 criteria");

  // Chip opens the eval drawer with the judge's verdict and reasoning
  await criteriaChip.click();
  await expect(page.locator(".drawer")).toContainText("Stays on topic");
  await expect(page.locator(".drawer")).toContainText("PASS");

  // Exporting the transcript includes the eval verdicts — the record of how
  // the session graded, not just what was said.
  const downloadPromise = page.waitForEvent("download");
  await page.locator("button[title='Export transcript (Markdown)']").click();
  const download = await downloadPromise;
  const { readFileSync } = await import("node:fs");
  const exported = readFileSync((await download.path())!, "utf8");
  expect(exported).toContain("## Evals · 1/1 criteria passed");
  expect(exported).toMatch(/\*\*PASS\*\* Stays on topic/);

  // The directory eval-score chip carries the trust denominator (how many
  // results back the score) in its tooltip — 100% from one result reads
  // very differently from 100% from fifty.
  await page.locator("nav a[title='Agents']").click();
  const score = page
    .locator(".dir-table tbody tr", { hasText: "Eng On-Call" })
    .locator("span[title*='eval result']");
  await expect(score).toHaveAttribute("title", /across \d+ eval result/);
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

  // One run shows no trajectory yet.
  await expect(suiteRow.locator(".suite-trend")).toHaveCount(0);

  // A second run builds the pass-rate trend — the regression signal.
  await page.getByRole("button", { name: "Run suite" }).click();
  await expect(suiteRow.locator(".suite-trend > div")).toHaveCount(2, {
    timeout: 30_000,
  });
});

test("suites: marking a suite as gating persists and shows the chip", async () => {
  // Still on the agent's evals tab from the previous test
  const suiteRow = page.locator(".row", { hasText: "Smoke" });
  // Controlled checkbox: state flips after the PATCH + refetch, so click()
  // (check() insists on an immediate state change).
  await suiteRow.locator("input[type=checkbox]").click();
  await expect(suiteRow.locator(".chip", { hasText: "gating" })).toBeVisible();

  await expect
    .poll(async () => {
      const suites = await dbQuery<{ gating: boolean }>(
        "SELECT gating FROM eval_suites WHERE name = 'Smoke'",
      );
      return suites[0]?.gating;
    })
    .toBe(true);

  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'eval.suite.update'",
  );
  expect(audit).toHaveLength(1);
});

test("freeze: a judged session becomes a suite case from the eval drawer", async () => {
  // Back to the judged session; the criteria chip opens the eval drawer
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".sidebar-item", { hasText: "Is prod healthy?" }).click();
  await page.locator("button.chip", { hasText: "criteria" }).click();

  const freeze = page.locator("div", { hasText: "Freeze as test case" }).last();
  await freeze.locator("select").selectOption({ label: "Smoke" });
  await freeze.getByRole("button", { name: "+ Add to suite" }).click();
  await expect(page.getByText("Added to suite ✓")).toBeVisible();

  const cases = await dbQuery<{ input: string; source_session_id: string | null }>(
    "SELECT input, source_session_id FROM eval_cases ORDER BY created_at",
  );
  expect(cases).toHaveLength(2);
  expect(cases[1]!.input).toContain("Is prod healthy?");
  expect(cases[1]!.source_session_id).not.toBeNull();
});

test("gating: a regressing change is blocked before it saves", async () => {
  // Script the gate's first case to regress: the agent gives an off-topic
  // reply and the judge fails it. The second case falls back to emulator
  // defaults (echo + PASS).
  for (const text of [
    "I refuse to discuss deployments.",
    "FAIL\nThe reply ignores the deployment question.",
  ]) {
    await fetch(`${EMULATOR}/admin/llm/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", text }),
    });
  }

  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  const instructions = page.locator("textarea").first();
  const original = await instructions.inputValue();
  await instructions.fill(`${original}\nAlways reply in French.`);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator(".error-text")).toContainText(
    'Blocked by gating suite "Smoke"',
    { timeout: 30_000 },
  );
  // The block spells out which case regressed and the judge's reasoning —
  // enough to fix the change without hunting through the suite.
  await expect(page.locator(".error-text")).toContainText(
    "The reply ignores the deployment question.",
  );

  // The change was NOT saved, and the block is on the audit trail
  const rows = await dbQuery<{ instructions: string }>(
    "SELECT instructions FROM agents WHERE name = 'Eng On-Call'",
  );
  expect(rows[0]!.instructions).not.toContain("Always reply in French.");
  const blocked = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'eval.gate.block'",
  );
  expect(blocked).toHaveLength(1);

  // With healthy behavior (emulator defaults), the same change passes the
  // gate and saves.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible({
    timeout: 30_000,
  });
  const after = await dbQuery<{ instructions: string }>(
    "SELECT instructions FROM agents WHERE name = 'Eng On-Call'",
  );
  expect(after[0]!.instructions).toContain("Always reply in French.");
  const passed = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'eval.gate.pass'",
  );
  expect(passed.length).toBeGreaterThan(0);
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
  await page.getByPlaceholder("Describe what you need help with…").fill("Hello Anthropic path");
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

test("auto routes by intent across usable agents", async () => {
  // Two active agents exist now (Eng On-Call, Claude Agent). Script the
  // router verdict, then the routed agent's actual reply.
  await fetch(`${EMULATOR}/admin/llm/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { type: "text", text: "eng-on-call" },
      { type: "text", text: "Routed correctly: checking the failing pipeline now." },
    ]),
  });

  await page.getByRole("link", { name: "+ New session" }).click();
  await expect(page.locator(".session-greeting")).toBeVisible();
  // Leave the target on "Auto"
  await page
    .getByPlaceholder("Describe what you need help with…")
    .fill("The CI pipeline is failing on main, please triage");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".msg-agent .bubble")).toContainText(
    "Routed correctly",
    { timeout: 15_000 },
  );
  // The thread is pinned to the routed agent
  await expect(page.locator(".thread-composer .composer-agent")).toHaveText(
    "Eng On-Call",
  );

  const routed = await dbQuery<{ slug: string }>(
    `SELECT a.slug FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.title LIKE 'The CI pipeline is failing%'`,
  );
  expect(routed).toEqual([{ slug: "eng-on-call" }]);
});

test("spot-check: a disputed verdict queues for review; overturn flips it", async () => {
  // Disagree with the judge from the session's eval drawer
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".sidebar-item", { hasText: "Is prod healthy?" }).click();
  await page.locator("button.chip", { hasText: "criteria" }).click();
  await page.getByRole("button", { name: "Disagree →" }).click();
  await expect(page.locator(".drawer .chip", { hasText: "in review" })).toBeVisible();

  const open = await dbQuery<{ review_status: string }>(
    "SELECT review_status FROM eval_results WHERE review_status IS NOT NULL",
  );
  expect(open).toEqual([{ review_status: "open" }]);

  // The agent's evals tab shows the queue; a human overturns the judge
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();
  await expect(page.getByText("1 in spot-check queue")).toBeVisible();
  await page.getByRole("button", { name: "Overturn" }).click();
  await expect(page.getByText("0 in spot-check queue")).toBeVisible();

  const resolved = await dbQuery<{ review_status: string; passed: boolean }>(
    "SELECT review_status, passed FROM eval_results WHERE review_status IS NOT NULL",
  );
  expect(resolved).toEqual([{ review_status: "overturned", passed: false }]);

  const audit = await dbQuery<{ action: string }>(
    `SELECT action FROM audit_events
     WHERE action IN ('eval.result.dispute', 'eval.review.resolve')
     ORDER BY action`,
  );
  expect(audit.map((a) => a.action)).toEqual([
    "eval.result.dispute",
    "eval.review.resolve",
  ]);
});

test("criteria trends: pass rate vs the prior 30-day window", async () => {
  // Backdate a failing result into the prior window; the recent window is
  // the (overturned-to-fail plus original) recent results.
  const criteria = await dbQuery<{ id: string }>("SELECT id FROM eval_criteria LIMIT 1");
  const anySession = await dbQuery<{ id: string }>("SELECT id FROM sessions LIMIT 1");
  await dbQuery(
    `INSERT INTO eval_results (criterion_id, session_id, passed, reasoning, created_at)
     VALUES ($1, $2, false, 'backdated seed', now() - interval '45 days')`,
    [criteria[0]!.id, anySession[0]!.id],
  );

  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();
  // Prior window: 0% (the seed). Recent: 50% (one pass, one overturned fail).
  await expect(
    page.locator(".row", { hasText: "Stays on topic" }).getByText("vs prior"),
  ).toContainText("+50% vs prior");
});

test("sub-agents: link an agent and annotate the edge", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  const linkable = page.locator(".row", { hasText: "Claude Agent" });
  await linkable.getByRole("button", { name: "Attach" }).click();
  const linked = page.locator(".row", { hasText: "claude-agent" });
  // The callee's track record shows on the wiring — evidence for the edge.
  // Claude Agent hasn't been judged yet, so it reads "no track record".
  await expect(linked.getByText("no track record")).toBeVisible();

  await linked
    .getByPlaceholder("When is it called? e.g. Before any deploy action")
    .fill("Called for anything requiring long-form writing");
  await page.locator("h1").click(); // blur commits the note

  await expect
    .poll(async () => {
      const links = await dbQuery<{ note: string }>("SELECT note FROM agent_links");
      return links[0]?.note;
    })
    .toBe("Called for anything requiring long-form writing");

  // Survives a reload
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByPlaceholder("When is it called? e.g. Before any deploy action"),
  ).toHaveValue("Called for anything requiring long-form writing");
});

test("duplicate: the copy carries config and wiring, never history", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).first().click();
  await page.getByRole("button", { name: "Duplicate" }).click();

  // Lands on the new draft's config
  await expect(
    page.getByRole("heading", { name: "Eng On-Call (copy)" }),
  ).toBeVisible();
  await expect(page.locator("h1 .chip", { hasText: "draft" })).toBeVisible();

  const rows = await dbQuery<{
    status: string;
    instructions: string;
    icon: string;
  }>("SELECT status, instructions, icon FROM agents WHERE name = 'Eng On-Call (copy)'");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("draft");
  expect(rows[0]!.instructions).toContain("Always reply in French.");

  // MCP wiring came along: the server attachment was copied. Tool identity
  // now derives from the server's credential mode, so there's no per-tool
  // auth row to copy — the attachment is the wiring.
  const wiring = await dbQuery<{ slug: string }>(
    `SELECT s.slug FROM agent_mcp_servers ams
     JOIN agents a ON a.id = ams.agent_id
     JOIN mcp_servers s ON s.id = ams.server_id
     WHERE a.name = 'Eng On-Call (copy)'
     ORDER BY s.slug`,
  );
  expect(wiring.map((w) => w.slug)).toContain("github");

  // No sessions or eval history followed the copy
  const history = await dbQuery<{ count: string }>(
    `SELECT count(*) FROM sessions s JOIN agents a ON a.id = s.agent_id
     WHERE a.name = 'Eng On-Call (copy)'`,
  );
  expect(Number(history[0]!.count)).toBe(0);
  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'agent.duplicate'",
  );
  expect(audit).toHaveLength(1);

  // Tidy up so the directory stays predictable for later specs
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete agent" }).click();
  await expect(page.getByRole("heading", { name: "All agents" })).toBeVisible();
});

test("a fresh judgment updates the open session without a reload", async () => {
  // The spot-check overturn left this session's verdict at FAIL
  await page.locator("nav a[title='Sessions']").click();
  await page.locator(".sidebar-item", { hasText: "Is prod healthy?" }).click();
  const chip = page.locator("button.chip", { hasText: "criteria" });
  // Fail state: zero passing. The denominator is how many criteria were live
  // at judge time; a stale pre-settle render can briefly show a higher count,
  // so match the "0 passing" fail state without pinning it (the DB assertion
  // below verifies the settled single-result state).
  await expect(chip).toContainText(/! 0\/\d+ criteria/);

  // A new turn triggers re-judging (emulator default: PASS). The chip must
  // flip in place — no reload — once the background verdict lands.
  await page.locator(".thread-composer textarea").fill("Checking prod again");
  await page.locator(".thread-composer button", { hasText: "Send" }).click();
  await expect(page.locator(".msg-agent .bubble").last()).toContainText(
    "Mock reply to: Checking prod again",
    { timeout: 15_000 },
  );
  await expect(chip).toContainText("✓ 1/1 criteria", { timeout: 12_000 });

  // Stats reads the same rows — the session view and Stats now agree
  const results = await dbQuery<{ passed: boolean; review_status: string | null }>(
    `SELECT er.passed, er.review_status FROM eval_results er
     JOIN sessions s ON s.id = er.session_id WHERE s.title = 'Is prod healthy?'`,
  );
  expect(results).toEqual([{ passed: true, review_status: null }]);
});

test("criteria are editable in place — the track record survives a rewording", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();

  const row = page.locator(".row", { hasText: "Stays on topic" }).first();
  const [before] = await dbQuery<{ id: string; n: number }>(
    `SELECT c.id, (SELECT count(*)::int FROM eval_results r WHERE r.criterion_id = c.id) AS n
       FROM eval_criteria c WHERE c.name = 'Stays on topic'`,
  );
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  // Scoped to the editing row — the add-criterion form below shares the
  // placeholder prefix.
  const editRow = page.locator(".row", { has: page.getByPlaceholder("Criterion name") });
  await editRow
    .getByPlaceholder("What the judge should check", { exact: true })
    .fill("The reply answers the question asked, without wandering.");
  await editRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.locator(".row", { hasText: "without wandering" }),
  ).toBeVisible();

  // Same criterion id, same results behind it — the record survived.
  const [after] = await dbQuery<{ id: string; description: string; n: number }>(
    `SELECT c.id, c.description,
            (SELECT count(*)::int FROM eval_results r WHERE r.criterion_id = c.id) AS n
       FROM eval_criteria c WHERE c.name = 'Stays on topic'`,
  );
  expect(after!.id).toBe(before!.id);
  expect(after!.n).toBe(before!.n);
  expect(after!.description).toContain("without wandering");
  const audit = await dbQuery<{ action: string }>(
    "SELECT action FROM audit_events WHERE action = 'eval.criterion.update'",
  );
  expect(audit.length).toBeGreaterThanOrEqual(1);
});

test("suites open up: cases are visible and editable, suites rename in place", async () => {
  await page.locator("nav a[title='Agents']").click();
  await page.locator(".dir-table tbody tr", { hasText: "Eng On-Call" }).click();
  await page.getByRole("button", { name: "evals" }).click();

  // Open the Smoke suite's cases — the frozen/added cases are no longer a
  // black box after creation.
  const suiteRow = page.locator(".row", { hasText: "Smoke" }).first();
  await suiteRow.getByRole("button", { name: "Cases", exact: true }).click();
  const caseLine = page.locator(".row div", { hasText: "→" }).first();
  await expect(caseLine).toBeVisible();

  // Edit the rubric in place. Several cases can share the default rubric
  // and created_at can tie, so no single-row lookup is reliable; assert the
  // invariants instead: the suite's id set is unchanged (edit-in-place,
  // nothing created) and exactly one case now carries the new rubric.
  const beforeIds = await dbQuery<{ id: string }>(
    `SELECT c.id FROM eval_cases c JOIN eval_suites s ON s.id = c.suite_id
     WHERE s.name = 'Smoke' ORDER BY c.id`,
  );
  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await page
    .getByPlaceholder("What a good reply must do")
    .fill("Mentions the runbook by name and links it.");
  await page.getByRole("button", { name: "Save case" }).click();
  await expect(page.getByText("Mentions the runbook by name")).toBeVisible();
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM eval_cases c
         JOIN eval_suites s ON s.id = c.suite_id
         WHERE s.name = 'Smoke' AND c.rubric LIKE 'Mentions the runbook%'`,
      );
      return rows[0]!.n;
    })
    .toBe(1);
  const afterIds = await dbQuery<{ id: string }>(
    `SELECT c.id FROM eval_cases c JOIN eval_suites s ON s.id = c.suite_id
     WHERE s.name = 'Smoke' ORDER BY c.id`,
  );
  expect(afterIds.map((c) => c.id)).toEqual(beforeIds.map((c) => c.id));

  // Rename the suite through the pencil. Once editing starts the row's
  // text lives in the input VALUE, so the text-filtered row locator no
  // longer matches — scope to the editing title instead.
  await suiteRow.locator(".editable-title .rename-btn").click();
  const editingTitle = page.locator(".editable-title.editing");
  await editingTitle.locator("input").fill("Smoke pack");
  await editingTitle.locator("button", { hasText: "Save" }).click();
  await expect(page.locator(".row", { hasText: "Smoke pack" }).first()).toBeVisible();
  const audit = await dbQuery<{ summary: string }>(
    "SELECT summary FROM audit_events WHERE action IN ('eval.suite.update','eval.case.update') ORDER BY created_at",
  );
  expect(audit.some((a) => a.summary.includes("Smoke pack"))).toBe(true);
  expect(audit.some((a) => a.summary.includes("Edited test case"))).toBe(true);
});
