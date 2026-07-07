import type { FastifyInstance } from "fastify";
import {
  createCustomModelSchema,
  enableBuiltInModelSchema,
  setProviderKeySchema,
} from "@rabblehq/core";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { models, providerKeys } from "../db/schema.js";
import { encryptSecret } from "../crypto.js";
import { recordAudit } from "../audit.js";
import { requireUser, isOrgAdmin } from "../auth.js";
import { serializeModel } from "../serialize.js";
import { MODEL_CATALOG, getCatalogModel } from "../models/catalog.js";
import { env } from "../env.js";

export async function modelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);
  // The model registry and provider keys are org-shared and secret-bearing:
  // registering/deleting models and writing provider keys is org-admin
  // territory. Reads (catalog, list, provider status) stay open so members
  // can see what's available.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "GET" && !isOrgAdmin(req.user)) {
      return reply.code(403).send({ error: "Org admin access required" });
    }
  });

  app.get("/api/models/catalog", async () => ({ catalog: MODEL_CATALOG }));

  app.get("/api/models", async (req) => {
    const rows = await db
      .select({
        model: models,
        usedBy: sql<string[]>`coalesce(
          (SELECT array_agg(a.name ORDER BY a.name) FROM agents a WHERE a.model_id = models.id),
          '{}'
        )`,
        grantCount: sql<number>`(
          SELECT count(*)::int FROM grants g
          WHERE g.target_type = 'model' AND g.target_id = models.id
        )`,
      })
      .from(models)
      .where(eq(models.orgId, req.user!.orgId))
      .orderBy(models.createdAt);

    // A model is selectable when ungoverned (no grants) or reachable via a
    // model grant; org admins can always select.
    const isAdmin = req.user!.role === "owner" || req.user!.role === "admin";
    let reachable = new Set<string>();
    if (!isAdmin) {
      const { grantSubjectsFor } = await import("../rights.js");
      const { userIds, teamIds } = await grantSubjectsFor(
        req.user!.id,
        req.user!.orgId,
      );
      const { grants: grantsTable } = await import("../db/schema.js");
      const { inArray, or } = await import("drizzle-orm");
      const subjectFilter = [];
      if (userIds.length) {
        subjectFilter.push(
          and(eq(grantsTable.subjectType, "user"), inArray(grantsTable.subjectId, userIds)),
        );
      }
      if (teamIds.length) {
        subjectFilter.push(
          and(eq(grantsTable.subjectType, "team"), inArray(grantsTable.subjectId, teamIds)),
        );
      }
      if (subjectFilter.length) {
        const found = await db
          .select({ targetId: grantsTable.targetId })
          .from(grantsTable)
          .where(
            and(
              eq(grantsTable.orgId, req.user!.orgId),
              eq(grantsTable.targetType, "model"),
              or(...subjectFilter),
            ),
          );
        reachable = new Set(found.map((f) => f.targetId));
      }
    }

    return {
      models: rows.map((r) => ({
        ...serializeModel(r.model),
        usedBy: r.usedBy,
        canUse: isAdmin || r.grantCount === 0 || reachable.has(r.model.id),
      })),
    };
  });

  app.get("/api/models/providers", async (req) => {
    const rows = await db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.orgId, req.user!.orgId));
    const configured = new Set(rows.map((r) => r.provider));
    const providers = [...new Set(MODEL_CATALOG.map((m) => m.provider))].map(
      (provider) => ({
        provider,
        configured:
          configured.has(provider) ||
          (provider === "anthropic" && Boolean(env.anthropicApiKey)),
        fromEnv:
          !configured.has(provider) &&
          provider === "anthropic" &&
          Boolean(env.anthropicApiKey),
      }),
    );
    return { providers };
  });

  app.put("/api/models/providers", async (req) => {
    const body = setProviderKeySchema.parse(req.body);
    const [existing] = await db
      .select({ id: providerKeys.id })
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.orgId, req.user!.orgId),
          eq(providerKeys.provider, body.provider),
        ),
      )
      .limit(1);
    await db
      .insert(providerKeys)
      .values({
        orgId: req.user!.orgId,
        provider: body.provider,
        encryptedKey: encryptSecret(body.apiKey),
      })
      .onConflictDoUpdate({
        target: [providerKeys.orgId, providerKeys.provider],
        set: { encryptedKey: encryptSecret(body.apiKey) },
      });
    // Audit the rotation, never the key itself — provider keys are org secrets
    // and this is a control-plane change that redirects real spend.
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "model.provider.set",
      targetType: "provider-key",
      targetId: body.provider,
      summary: `${existing ? "Rotated" : "Set"} the ${body.provider} provider API key`,
      metadata: { provider: body.provider },
    });
    return { ok: true };
  });

  // Enable a built-in catalog model for this org.
  app.post("/api/models/built-in", async (req, reply) => {
    const body = enableBuiltInModelSchema.parse(req.body);
    const entry = getCatalogModel(body.catalogId);
    if (!entry) {
      return reply.code(404).send({ error: "Unknown catalog model" });
    }
    const [existing] = await db
      .select()
      .from(models)
      .where(
        and(
          eq(models.orgId, req.user!.orgId),
          eq(models.catalogId, entry.catalogId),
        ),
      )
      .limit(1);
    if (existing) return { model: serializeModel(existing) };

    const [row] = await db
      .insert(models)
      .values({
        orgId: req.user!.orgId,
        kind: "built-in",
        catalogId: entry.catalogId,
        displayName: entry.displayName,
        protocol: entry.protocol,
        modelId: entry.modelId,
        priceInputPerMtok:
          entry.priceInputPerMtok !== null ? String(entry.priceInputPerMtok) : null,
        priceOutputPerMtok:
          entry.priceOutputPerMtok !== null ? String(entry.priceOutputPerMtok) : null,
      })
      .returning();
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "model.enable",
      targetType: "model",
      targetId: row!.id,
      summary: `Enabled the built-in model "${entry.displayName}"`,
      metadata: { catalogId: entry.catalogId, modelId: entry.modelId },
    });
    return { model: serializeModel(row!) };
  });

  // Register a custom model (own key, own endpoint or gateway).
  app.post("/api/models/custom", async (req) => {
    const body = createCustomModelSchema.parse(req.body);
    const [row] = await db
      .insert(models)
      .values({
        orgId: req.user!.orgId,
        kind: "custom",
        displayName: body.displayName,
        protocol: body.protocol,
        baseUrl: body.baseUrl ?? null,
        modelId: body.modelId,
        encryptedKey: encryptSecret(body.apiKey),
        priceInputPerMtok:
          body.priceInputPerMtok != null ? String(body.priceInputPerMtok) : null,
        priceOutputPerMtok:
          body.priceOutputPerMtok != null ? String(body.priceOutputPerMtok) : null,
      })
      .returning();
    // Record the endpoint (where org traffic now flows) but never the key.
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "model.register",
      targetType: "model",
      targetId: row!.id,
      summary: `Registered the custom model "${body.displayName}"`,
      metadata: {
        protocol: body.protocol,
        modelId: body.modelId,
        baseUrl: body.baseUrl ?? null,
      },
    });
    return { model: serializeModel(row!) };
  });

  app.delete("/api/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(models)
      .where(and(eq(models.id, id), eq(models.orgId, req.user!.orgId)))
      .returning({ id: models.id, displayName: models.displayName });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: "Model not found" });
    }
    await recordAudit({
      orgId: req.user!.orgId,
      actorUserId: req.user!.id,
      action: "model.remove",
      targetType: "model",
      targetId: id,
      summary: `Removed the model "${deleted[0]!.displayName}"`,
    });
    return { ok: true };
  });
}
