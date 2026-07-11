import { describe, expect, it } from "vitest";
import { pendingConnectsFor, requestConnect, resolveConnects } from "./approvals.js";

describe("connect-ask broker", () => {
  it("resolves every waiting turn when the credential lands", async () => {
    const a = requestConnect({
      sessionId: "s1",
      userId: "u1",
      serverId: "srv1",
      serverName: "GitHub",
      requiresOAuth: false,
    });
    const b = requestConnect({
      sessionId: "s2",
      userId: "u1",
      serverId: "srv1",
      serverName: "GitHub",
      requiresOAuth: false,
    });
    resolveConnects("u1", "srv1");
    expect(await a.decision).toBe("connected");
    expect(await b.decision).toBe("connected");
  });

  it("lists pending asks only for their owner, then clears on resolve", () => {
    requestConnect({
      sessionId: "s9",
      userId: "u9",
      serverId: "srv9",
      serverName: "Notion",
      requiresOAuth: true,
    });
    expect(pendingConnectsFor("s9", "u9")).toHaveLength(1);
    expect(pendingConnectsFor("s9", "someone-else")).toHaveLength(0);
    resolveConnects("u9", "srv9");
    expect(pendingConnectsFor("s9", "u9")).toHaveLength(0);
  });
});
