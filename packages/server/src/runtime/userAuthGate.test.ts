import { describe, expect, it } from "vitest";
import type { ToolCall } from "@rabblehq/core";
import { decideApproval } from "./approvals.js";
import { gateUserAuth, type GateContext } from "./userAuthGate.js";

const call: ToolCall = {
  id: "t1",
  name: "create_issue",
  serverName: "github",
  input: { title: "x" },
  output: null,
  authType: "user",
  approval: null,
};

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    sessionId: "s1",
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

describe("gateUserAuth", () => {
  it("auto-approves under trust posture", async () => {
    const result = await gateUserAuth(ctx({ approvalPosture: "trust" }), call);
    expect(result).toEqual({
      outcome: "proceed",
      approval: { status: "auto-approved", decidedByName: "Alex Lin" },
    });
  });

  it("auto-approves the rest of a session once one call was approved", async () => {
    const result = await gateUserAuth(ctx({ sessionApproved: true }), call);
    expect(result.outcome).toBe("proceed");
    expect(
      result.outcome === "proceed" ? result.approval?.status : null,
    ).toBe("auto-approved");
  });

  it("the org floor overrides trust posture", async () => {
    // With requireApproval on, even trust posture must prompt — resolve it
    // via the broker so the test doesn't wait for the timeout.
    const emitted: Array<{ approvalId: string }> = [];
    const pending = gateUserAuth(
      ctx({
        approvalPosture: "trust",
        requireApproval: true,
        emit: (e) => emitted.push(e),
      }),
      call,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(1);
    decideApproval(emitted[0]!.approvalId, "s1", "u1", "approve");
    const result = await pending;
    expect(result).toEqual({
      outcome: "proceed",
      approval: { status: "approved", decidedByName: "Alex Lin" },
    });
  });

  it("refuses outright when the surface can't host a prompt", async () => {
    const result = await gateUserAuth(
      ctx({ interactive: false, approvalPrompt: undefined }),
      call,
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.approval.status).toBe("denied");
      expect(result.modelText).toContain("web app");
    }
  });

  it("trust posture does not auto-approve where the user can't see it", async () => {
    // A delegated sub-agent / automation turn is non-interactive with no
    // out-of-band prompt. Even under trust, the write must be refused, not
    // run silently as the user in a turn they never saw.
    const result = await gateUserAuth(
      ctx({ approvalPosture: "trust", interactive: false, approvalPrompt: undefined }),
      call,
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.approval.status).toBe("denied");
    }
  });

  it("a denial resolves as refused with the decider's name", async () => {
    const emitted: Array<{ approvalId: string }> = [];
    const pending = gateUserAuth(ctx({ emit: (e) => emitted.push(e) }), call);
    await new Promise((r) => setTimeout(r, 10));
    decideApproval(emitted[0]!.approvalId, "s1", "u1", "deny");
    const result = await pending;
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.approval).toEqual({ status: "denied", decidedByName: "Alex Lin" });
      expect(result.modelText).toContain("declined");
    }
  });

  it("only the owning user's decision counts", async () => {
    const emitted: Array<{ approvalId: string }> = [];
    const pending = gateUserAuth(ctx({ emit: (e) => emitted.push(e) }), call);
    await new Promise((r) => setTimeout(r, 10));
    expect(decideApproval(emitted[0]!.approvalId, "s1", "someone-else", "approve")).toBe(
      false,
    );
    expect(decideApproval(emitted[0]!.approvalId, "s1", "u1", "run-as-service")).toBe(
      true,
    );
    const result = await pending;
    expect(result).toEqual({
      outcome: "proceed",
      approval: { status: "ran-as-service", decidedByName: "Alex Lin" },
    });
  });

  it("delivers the ask out-of-band when a prompt hook is supplied", async () => {
    const prompts: Array<{ approvalId: string; toolName: string }> = [];
    const emitted: Array<{ approvalId: string }> = [];
    const pending = gateUserAuth(
      ctx({
        interactive: false,
        approvalPrompt: async (p) => {
          prompts.push(p);
        },
        emit: (e) => emitted.push(e),
      }),
      call,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.toolName).toBe("create_issue");
    decideApproval(emitted[0]!.approvalId, "s1", "u1", "approve");
    const result = await pending;
    expect(result.outcome).toBe("proceed");
  });
});
