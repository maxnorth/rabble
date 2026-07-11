import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { env } from "./env.js";
import { enforceApiKeyScope, resolveUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { modelRoutes } from "./routes/models.js";
import { agentRoutes } from "./routes/agents.js";
import { sessionRoutes } from "./routes/sessions.js";
import { teamRoutes } from "./routes/teams.js";
import { domainRoutes } from "./routes/domains.js";
import { grantRoutes } from "./routes/grants.js";
import { mcpRoutes } from "./routes/mcp.js";
import { evalRoutes } from "./routes/evals.js";
import { adminRoutes } from "./routes/admin.js";
import { profileRoutes } from "./routes/profile.js";
import { automationRoutes } from "./routes/automations.js";
import { statsRoutes } from "./routes/stats.js";
import { inboundRoutes } from "./routes/inbound.js";
import { accessRequestRoutes } from "./routes/accessRequests.js";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cookie, { secret: env.cookieSecret });
  if (env.nodeEnv !== "production") {
    await app.register(cors, {
      origin: /^http:\/\/localhost:\d+$/,
      credentials: true,
    });
  }

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    req.log.error(err);
    const statusCode =
      err instanceof Error && "statusCode" in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
    if (statusCode && statusCode < 500 && err instanceof Error) {
      return reply.code(statusCode).send({ error: err.message });
    }
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req, reply) => {
    req.user = await resolveUser(req);
    enforceApiKeyScope(req, reply);
  });

  app.get("/api/health", async (_req, reply) => {
    // A healthy app is one that can reach its database.
    try {
      const { sql } = await import("drizzle-orm");
      const { db } = await import("./db/client.js");
      await db.execute(sql`SELECT 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: "database unreachable" });
    }
  });

  await app.register(inboundRoutes);
  await app.register(authRoutes);
  await app.register(modelRoutes);
  await app.register(agentRoutes);
  await app.register(sessionRoutes);
  await app.register(teamRoutes);
  await app.register(domainRoutes);
  await app.register(grantRoutes);
  await app.register(mcpRoutes);
  await app.register(evalRoutes);
  await app.register(adminRoutes);
  await app.register(profileRoutes);
  await app.register(automationRoutes);
  await app.register(statsRoutes);
  await app.register(accessRequestRoutes);

  // In production the server also serves the built web app.
  const webDist = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await buildServer();
  app
    .listen({ port: env.port, host: "0.0.0.0" })
    .then(async () => {
      // Keep every org's Builder on the current shipped instructions.
      const { syncBuilderInstructions } = await import("./db/builder.js");
      syncBuilderInstructions().catch((err) =>
        app.log.warn({ err }, "builder instructions sync failed"),
      );
      // Boot-time retention sweep (recurring sweeps land with Hatchet).
      const { applyRetentionForAllOrgs } = await import("./retention.js");
      applyRetentionForAllOrgs().catch((err) =>
        app.log.warn({ err }, "retention sweep failed"),
      );
      // Slack Socket Mode: dial out for any connection with an app token.
      const { startSlackSocketManager } = await import("./surfaces/slackSocket.js");
      startSlackSocketManager(app.log).catch((err) =>
        app.log.warn({ err }, "slack socket manager failed to start"),
      );
      // Recurring background work via Hatchet (off unless configured).
      const { startScheduler } = await import("./scheduling/hatchet.js");
      startScheduler(app.log).catch((err) =>
        app.log.warn({ err }, "scheduler failed to start"),
      );
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
