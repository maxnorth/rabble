/**
 * Profile: personal connected accounts (credentials used when an agent acts
 * "as you") and agent preferences (approval posture, response style).
 */
import type { FastifyInstance } from "fastify";
import { userPreferencesSchema } from "@rabblehq/core";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userConnectedAccounts, users } from "../db/schema.js";
import { requireUser } from "../auth.js";
import { encryptSecret } from "../crypto.js";
import { recordAudit } from "../audit.js";

export async function profileRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/profile/accounts", async (req) => {
    const rows = await db
      .select()
      .from(userConnectedAccounts)
      .where(eq(userConnectedAccounts.userId, req.user!.id))
      .orderBy(userConnectedAccounts.vendor);
    return {
      accounts: rows.map((a) => ({
        id: a.id,
        vendor: a.vendor,
        label: a.label,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  app.put("/api/profile/accounts", async (req, reply) => {
    const { vendor, label, token } = req.body as {
      vendor: string;
      label?: string;
      token: string;
    };
    if (!vendor?.trim() || !token?.trim()) {
      return reply.code(400).send({ error: "Vendor and token are required" });
    }
    await db
      .insert(userConnectedAccounts)
      .values({
        userId: req.user!.id,
        vendor: vendor.trim().toLowerCase(),
        label: label?.trim() ?? "",
        encryptedToken: encryptSecret(token),
      })
      .onConflictDoUpdate({
        target: [userConnectedAccounts.userId, userConnectedAccounts.vendor],
        set: {
          label: label?.trim() ?? "",
          encryptedToken: encryptSecret(token),
        },
      });
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "profile.account.connect",
      targetType: "user",
      targetId: req.user!.id,
      summary: `Connected personal ${vendor.trim()} account`,
    });
    return { ok: true };
  });

  app.delete("/api/profile/accounts/:vendor", async (req) => {
    const { vendor } = req.params as { vendor: string };
    const removed = await db
      .delete(userConnectedAccounts)
      .where(
        and(
          eq(userConnectedAccounts.userId, req.user!.id),
          eq(userConnectedAccounts.vendor, vendor),
        ),
      )
      .returning({ id: userConnectedAccounts.id });
    // Symmetric with connect: removing a credential that let an agent act as
    // this user is a governance event, so it belongs in the record too.
    if (removed.length > 0) {
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "profile.account.disconnect",
        targetType: "user",
        targetId: req.user!.id,
        summary: `Disconnected personal ${vendor} account`,
      });
    }
    return { ok: true };
  });

  app.get("/api/profile/preferences", async (req) => {
    return {
      preferences: userPreferencesSchema.parse({
        ...(req.user!.preferences as Record<string, unknown>),
      }),
    };
  });

  app.put("/api/profile/preferences", async (req) => {
    const preferences = userPreferencesSchema.parse(req.body);
    const prior = userPreferencesSchema.parse({
      ...(req.user!.preferences as Record<string, unknown>),
    });
    await db
      .update(users)
      .set({ preferences })
      .where(eq(users.id, req.user!.id));
    // Approval posture is a governance control (it decides when user-auth
    // tools auto-approve), so a change to it is audited — response-style tweaks
    // are not, to keep the log signal-dense.
    if (preferences.approvalPosture !== prior.approvalPosture) {
      await recordAudit({
        orgId: req.user!.orgId,
        actorUserId: req.user!.id,
        action: "profile.posture",
        targetType: "user",
        targetId: req.user!.id,
        summary: `Set approval posture to "${preferences.approvalPosture}"`,
        metadata: { from: prior.approvalPosture, to: preferences.approvalPosture },
      });
    }
    return { preferences };
  });
}
