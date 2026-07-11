import { describe, expect, it } from "vitest";
import {
  sessionApprovedForUser,
  type ApprovalHistoryMessage,
} from "./sessionApproval.js";

const at = (s: number) => new Date(2026, 0, 1, 0, 0, s);
const userMsg = (author: string, s: number): ApprovalHistoryMessage => ({
  role: "user",
  authorUserId: author,
  toolCalls: [],
  createdAt: at(s),
});
const agentMsg = (
  approvalStatus: string | null,
  s: number,
): ApprovalHistoryMessage => ({
  role: "agent",
  authorUserId: null,
  toolCalls: approvalStatus
    ? [{ approval: { status: approvalStatus } }]
    : [],
  createdAt: at(s),
});

describe("sessionApprovedForUser", () => {
  it("latches for the user who approved earlier in the session", () => {
    const history = [userMsg("alex", 1), agentMsg("approved", 2)];
    expect(sessionApprovedForUser(history, "alex")).toBe(true);
  });

  it("does NOT latch across users — one participant's approval isn't another's consent", () => {
    // Alex approved a user-auth tool; Bea then joins the shared thread.
    const history = [
      userMsg("alex", 1),
      agentMsg("approved", 2),
      userMsg("bea", 3),
    ];
    expect(sessionApprovedForUser(history, "alex")).toBe(true);
    expect(sessionApprovedForUser(history, "bea")).toBe(false);
  });

  it("counts auto-approved turns too (trust/session posture)", () => {
    const history = [userMsg("alex", 1), agentMsg("auto-approved", 2)];
    expect(sessionApprovedForUser(history, "alex")).toBe(true);
  });

  it("ignores denied / unresolved tool calls", () => {
    const history = [
      userMsg("alex", 1),
      agentMsg("denied", 2),
      userMsg("alex", 3),
      agentMsg(null, 4),
    ];
    expect(sessionApprovedForUser(history, "alex")).toBe(false);
  });

  it("attributes by chronology even when rows arrive unordered", () => {
    const history = [
      agentMsg("approved", 2),
      userMsg("bea", 3),
      userMsg("alex", 1),
    ];
    // The approved agent turn at t=2 follows alex's t=1 message, not bea's t=3.
    expect(sessionApprovedForUser(history, "alex")).toBe(true);
    expect(sessionApprovedForUser(history, "bea")).toBe(false);
  });
});

describe("agent scoping (multi-party sessions)", () => {
  const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
  const approvedCall = {
    approval: { status: "approved", decidedByName: "Alex Lin" },
  };

  it("consent given to agent A never unlocks agent B", () => {
    const history = [
      { role: "user" as const, authorUserId: "alex", toolCalls: [], createdAt: at(1) },
      {
        role: "agent" as const,
        authorUserId: null,
        agentId: "agent-a",
        toolCalls: [approvedCall],
        createdAt: at(2),
      },
    ];
    expect(sessionApprovedForUser(history, "alex", "agent-a")).toBe(true);
    expect(sessionApprovedForUser(history, "alex", "agent-b")).toBe(false);
  });

  it("unscoped calls keep the old single-agent behavior", () => {
    const history = [
      { role: "user" as const, authorUserId: "alex", toolCalls: [], createdAt: at(1) },
      {
        role: "agent" as const,
        authorUserId: null,
        agentId: "agent-a",
        toolCalls: [approvedCall],
        createdAt: at(2),
      },
    ];
    expect(sessionApprovedForUser(history, "alex")).toBe(true);
  });

  it("stays user-scoped inside the agent scope", () => {
    const history = [
      { role: "user" as const, authorUserId: "bea", toolCalls: [], createdAt: at(1) },
      {
        role: "agent" as const,
        authorUserId: null,
        agentId: "agent-a",
        toolCalls: [approvedCall],
        createdAt: at(2),
      },
    ];
    expect(sessionApprovedForUser(history, "alex", "agent-a")).toBe(false);
    expect(sessionApprovedForUser(history, "bea", "agent-a")).toBe(true);
  });
});
