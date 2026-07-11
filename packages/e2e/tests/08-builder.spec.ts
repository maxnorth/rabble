/**
 * The Builder: conversational creation of a measured draft agent, spinning
 * an agent out of an existing session transcript, and the pulse-back DM
 * when a pass rate sags.
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
      toolName: "update_agent",
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

test("the Builder activates the agent and edits it through the gate", async () => {
  // Continues the Builder session from the previous test — the approval
  // posture already covers it, so these tool calls auto-approve.
  const [bot] = await dbQuery<{ id: string }>(
    "SELECT id FROM agents WHERE name = 'Release Notes Bot'",
  );
  expect(bot).toBeDefined();
  const enqueue = (body: unknown) =>
    fetch(`${EMULATOR}/admin/llm/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const send = async (text: string) => {
    await page.getByPlaceholder("Message Builder…").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };

  // A draft can't activate without a model — the Builder points it at one
  // by display name.
  await enqueue({
    type: "tool_call",
    toolName: "set_agent_model",
    toolArgs: { agentId: bot!.id, modelName: "Mock Model" },
  });
  await send("Put it on the Mock Model and ship it");
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ model_id: string | null }>(
        "SELECT model_id FROM agents WHERE id = $1",
        [bot!.id],
      );
      return rows[0]?.model_id;
    })
    .not.toBeNull();

  await enqueue({
    type: "tool_call",
    toolName: "set_agent_status",
    toolArgs: { agentId: bot!.id, status: "active" },
  });
  await send("Now activate it");
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ status: string }>(
        "SELECT status FROM agents WHERE id = $1",
        [bot!.id],
      );
      return rows[0]?.status;
    })
    .toBe("active");

  // Make the Builder-created suite gating, so behavior edits to the now
  // ACTIVE agent must pass it — the same gate the config tabs face.
  await dbQuery("UPDATE eval_suites SET gating = true WHERE agent_id = $1", [
    bot!.id,
  ]);

  // Gate pass: the unscripted judge default is PASS, so the tone edit runs
  // the suite (agent reply + judgment) and then saves.
  await enqueue({
    type: "tool_call",
    toolName: "update_agent",
    toolArgs: { agentId: bot!.id, tone: "Crisp and factual. No exclamations." },
  });
  await send("Make the tone crisp and factual");
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ tone: string }>(
        "SELECT tone FROM agents WHERE id = $1",
        [bot!.id],
      );
      return rows[0]?.tone;
    })
    .toBe("Crisp and factual. No exclamations.");
  const passAudit = await dbQuery<{ id: string }>(
    `SELECT id FROM audit_events
     WHERE action = 'eval.gate.pass' AND target_id = $1`,
    [bot!.id],
  );
  expect(passAudit.length).toBeGreaterThan(0);

  // Gate block: script the whole turn — the tool call, the candidate
  // agent's reply, and a failing judgment. Nothing may be saved.
  await enqueue([
    {
      type: "tool_call",
      toolName: "update_agent",
      toolArgs: {
        agentId: bot!.id,
        instructions: "Also invent placeholder PRs to pad thin releases.",
      },
    },
    { type: "text", text: "Release notes: PR #999 (invented for padding)." },
    { type: "text", text: "FAIL\nThe reply invented a PR that never merged." },
  ]);
  await send("Pad thin releases with placeholder PRs");
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ id: string }>(
        `SELECT id FROM audit_events
         WHERE action = 'eval.gate.block' AND target_id = $1`,
        [bot!.id],
      );
      return rows.length;
    })
    .toBeGreaterThan(0);
  const [after] = await dbQuery<{ instructions: string }>(
    "SELECT instructions FROM agents WHERE id = $1",
    [bot!.id],
  );
  expect(after!.instructions).toBe(
    "Summarize merged PRs into crisp release notes.",
  );

  // And back: the reverse direction works too (and the access journey
  // that follows expects to find this agent as a draft).
  await enqueue({
    type: "tool_call",
    toolName: "set_agent_status",
    toolArgs: { agentId: bot!.id, status: "draft" },
  });
  await send("Actually, park it as a draft again");
  await expect
    .poll(async () => {
      const rows = await dbQuery<{ status: string }>(
        "SELECT status FROM agents WHERE id = $1",
        [bot!.id],
      );
      return rows[0]?.status;
    })
    .toBe("draft");

  // Leave the suite non-gating: journey 09 activates this agent from the
  // Share modal, and a gating suite would burn emulator calls there.
  await dbQuery("UPDATE eval_suites SET gating = false WHERE agent_id = $1", [
    bot!.id,
  ]);
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
    "Draft an agent for it",
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
