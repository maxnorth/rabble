import { describe, expect, it } from "vitest";
import { dueAutomations } from "./automations.js";

// 2021-01-04 09:00 UTC is a Monday.
const monday9 = new Date(Date.UTC(2021, 0, 4, 9, 0));

const auto = (o: Partial<Parameters<typeof dueAutomations>[0][number]>) => ({
  schedule: "0 9 * * 1-5",
  enabled: true,
  lastRunAt: null,
  createdBy: "user-1",
  ...o,
});

describe("dueAutomations", () => {
  it("fires an enabled, owned automation whose cron matches now", () => {
    expect(dueAutomations([auto({})], monday9)).toHaveLength(1);
  });

  it("skips disabled, unowned, or non-matching automations", () => {
    expect(dueAutomations([auto({ enabled: false })], monday9)).toHaveLength(0);
    expect(dueAutomations([auto({ createdBy: null })], monday9)).toHaveLength(0);
    // A Sunday (Jan 3) doesn't match the weekday-only schedule.
    expect(dueAutomations([auto({})], new Date(Date.UTC(2021, 0, 3, 9, 0)))).toHaveLength(0);
    // Wrong minute.
    expect(dueAutomations([auto({})], new Date(Date.UTC(2021, 0, 4, 9, 1)))).toHaveLength(0);
  });

  it("does not re-fire within the same minute (idempotent tick)", () => {
    expect(dueAutomations([auto({ lastRunAt: monday9 })], monday9)).toHaveLength(0);
    // A run in the previous minute doesn't block this one.
    const prevMinute = new Date(Date.UTC(2021, 0, 4, 8, 59));
    expect(dueAutomations([auto({ lastRunAt: prevMinute })], monday9)).toHaveLength(1);
  });
});
