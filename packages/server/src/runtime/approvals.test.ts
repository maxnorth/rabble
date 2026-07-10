import { describe, expect, it } from "vitest";
import {
  requestApproval,
  decideApproval,
  pendingApprovalsFor,
} from "./approvals.js";

// Each requestApproval arms a real timeout; every test below resolves the
// approval it creates (via decideApproval) so no timer is left dangling.

describe("approval broker", () => {
  it("resolves the waiting turn with the owner's decision", async () => {
    const { approvalId, decision } = requestApproval({
      sessionId: "s-owner",
      userId: "u-owner",
      toolName: "create_issue",
    });
    expect(decideApproval(approvalId, "s-owner", "u-owner", "approve")).toBe(true);
    await expect(decision).resolves.toBe("approve");
  });

  it("only the owning user on the owning session can decide", async () => {
    const { approvalId, decision } = requestApproval({
      sessionId: "s1",
      userId: "u1",
      toolName: "t",
    });
    // Wrong user, wrong session, unknown id — all refused, ask stays open.
    expect(decideApproval(approvalId, "s1", "someone-else", "approve")).toBe(false);
    expect(decideApproval(approvalId, "other-session", "u1", "approve")).toBe(false);
    expect(decideApproval("no-such-id", "s1", "u1", "approve")).toBe(false);
    // The real owner still can, and only once.
    expect(decideApproval(approvalId, "s1", "u1", "deny")).toBe(true);
    expect(decideApproval(approvalId, "s1", "u1", "approve")).toBe(false);
    await expect(decision).resolves.toBe("deny");
  });

  it("lists pending asks only for their owner, then clears on decide", () => {
    const { approvalId } = requestApproval({
      sessionId: "s-list",
      userId: "u-list",
      toolName: "query_metrics",
      serverName: "Datadog",
      input: { metric: "cpu" },
    });
    expect(pendingApprovalsFor("s-list", "u-list")).toContainEqual({
      approvalId,
      toolName: "query_metrics",
      serverName: "Datadog",
      input: { metric: "cpu" },
    });
    // A different user on the same session sees nothing.
    expect(pendingApprovalsFor("s-list", "intruder")).toHaveLength(0);
    // Deciding removes it from the pending list (and clears its timer).
    expect(decideApproval(approvalId, "s-list", "u-list", "approve")).toBe(true);
    expect(pendingApprovalsFor("s-list", "u-list")).toHaveLength(0);
  });
});
