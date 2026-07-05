import type { FastifyInstance } from "fastify";
import {
  createCustomModelSchema,
  enableBuiltInModelSchema,
  setProviderKeySchema,
} from "@rabble/core";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { models, providerKeys } from "../db/schema.js";
import { encryptSecret } from "../crypto.js";
import { requireUser } from "../auth.js";
import { serializeModel } from "../serialize.js";
import { MODEL_CATALOG, getCatalogModel } from "../models/catalog.js";
import { env } from "../env.js";

export async function modelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get("/api/models/catalog", async () => ({ catalog: MODEL_CATALOG }));

  app.get("/api/models", async (req) => {
    const rows = await db
      .select()
      .from(models)
      .where(eq(models.orgId, req.user!.orgId))
      .orderBy(models.createdAt);
    return { models: rows.map(serializeModel) };
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
      })
      .returning();
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
      })
      .returning();
    return { model: serializeModel(row!) };
  });

  app.delete("/api/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await db
      .delete(models)
      .where(and(eq(models.id, id), eq(models.orgId, req.user!.orgId)))
      .returning({ id: models.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: "Model not found" });
    }
    return { ok: true };
  });
}
