import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@rabblehq/core";

// The pending path records the ask durably; give it an in-memory stand-in
// so these stay unit tests.
const inserted: Array<Record<string, unknown>> = [];
vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [{ id: "00000000-0000-4000-8000-000000000001" }];
        },
      }),
    }),
  },
}));

const { gateUserAuth } = await import("./userAuthGate.js");
type GateContext = import("./userAuthGate.js").GateContext;

const call: ToolCall = {
  id: "t1",
  name: "create_issue",
  serverName: "github",
  input: { title: "x" },
  output: null,
  authType: "user",
  approval: null,
};

const meta = { kind: "mcp" as const, serverId: "srv1" };

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    sessionId: "s1",
    orgId: "o1",
    agentId: "a1",
    userId: "u1",
    userName: "Alex Lin",
    requireApproval: false,
    sessionApproved: false,
    interactive: true,
    approvalPosture: "session",
    emit: () => {},
    ...overrides,
  };
}

describe("gateUserAuth (async approvals)", () => {
  it("auto-approves under trust posture", async () => {
    const result = await gateUserAuth(ctx({ approvalPosture: "trust" }), call, meta);
    expect(result).toEqual({
      outcome: "proceed",
      approval: { status: "auto-approved", decidedByName: "Alex Lin" },
    });
  });

  it("auto-approves the rest of a session once one call was approved", async () => {
    const result = await gateUserAuth(ctx({ sessionApproved: true }), call, meta);
    expect(result.outcome).toBe("proceed");
    expect(
      result.outcome === "proceed" ? result.approval?.status : null,
    ).toBe("auto-approved");
  });

  it("refuses on a surface that can't host a prompt", async () => {
    const result = await gateUserAuth(
      ctx({ interactive: false, approvalPosture: "trust" }),
      call,
      meta,
    );
    expect(result.outcome).toBe("refused");
  });

  it("goes PENDING instead of blocking: records the ask, emits, returns immediately", async () => {
    inserted.length = 0;
    const emitted: Array<{ approvalId: string }> = [];
    const result = await gateUserAuth(
      ctx({ emit: (e) => emitted.push(e) }),
      call,
      meta,
    );
    // No decision happened, yet the gate already resolved — the turn moves on.
    expect(result.outcome).toBe("pending");
    if (result.outcome !== "pending") throw new Error("unreachable");
    expect(result.approval.status).toBe("pending");
    expect(result.approval.approvalId).toBeTruthy();
    expect(result.modelText).toContain("Do NOT retry");
    expect(emitted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      sessionId: "s1",
      userId: "u1",
      kind: "mcp",
      toolName: "create_issue",
      serverId: "srv1",
    });
  });

  it("the org floor overrides trust posture (still pending, not auto)", async () => {
    const result = await gateUserAuth(
      ctx({ approvalPosture: "trust", requireApproval: true }),
      call,
      meta,
    );
    expect(result.outcome).toBe("pending");
  });

  it("delivers the ask out-of-band when a prompt hook is supplied", async () => {
    const prompts: Array<{ toolName: string }> = [];
    const result = await gateUserAuth(
      ctx({
        interactive: false,
        approvalPrompt: async (r) => {
          prompts.push(r);
        },
      }),
      call,
      meta,
    );
    expect(result.outcome).toBe("pending");
    await new Promise((r) => setTimeout(r, 5));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.toolName).toBe("create_issue");
  });
});
