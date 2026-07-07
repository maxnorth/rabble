/**
 * Recurring background work runs on Hatchet (docs/DECISIONS.md — never
 * node-cron/BullMQ). This is OFF unless HATCHET_CLIENT_TOKEN is configured,
 * so a plain boot (and the e2e suite) is unaffected: without a scheduler the
 * retention sweep still runs once at startup, exactly as before. When a token
 * is present, we register cron workflows that call the same job functions the
 * app already runs on demand — so the scheduled path reuses tested code, and
 * only the Hatchet binding is new.
 *
 * The engine image isn't reachable from every build environment, so the SDK
 * is imported lazily: nothing about Hatchet loads unless the token is set.
 */
import type { FastifyBaseLogger } from "fastify";
import { applyRetentionForAllOrgs } from "../retention.js";

export async function startScheduler(log: FastifyBaseLogger): Promise<void> {
  if (!process.env.HATCHET_CLIENT_TOKEN) {
    log.info(
      "scheduler: HATCHET_CLIENT_TOKEN unset — recurring jobs off (retention still sweeps once at boot)",
    );
    return;
  }
  try {
    const { Hatchet } = await import("@hatchet-dev/typescript-sdk");
    const hatchet = Hatchet.init();

    // Nightly retention sweep — org-wide, no per-user context, wraps the
    // same function the boot-time sweep and Settings "Apply now" call.
    const retentionSweep = hatchet.task({
      name: "rabble-retention-sweep",
      on: { cron: process.env.RETENTION_CRON ?? "0 3 * * *" },
      fn: async () => {
        await applyRetentionForAllOrgs();
      },
    });

    const worker = await hatchet.worker("rabble-scheduler");
    await worker.registerWorkflows([retentionSweep]);
    void worker.start();
    log.info("scheduler: Hatchet worker started (retention sweep)");
  } catch (err) {
    // A scheduler that can't reach its engine must never take the API down.
    log.warn({ err }, "scheduler: Hatchet worker failed to start — recurring jobs off");
  }
}
