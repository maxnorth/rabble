import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { env } from "./env.js";
import { resolveUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { modelRoutes } from "./routes/models.js";
import { agentRoutes } from "./routes/agents.js";
import { sessionRoutes } from "./routes/sessions.js";

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
  app.addHook("preHandler", async (req) => {
    req.user = await resolveUser(req);
  });

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(modelRoutes);
  await app.register(agentRoutes);
  await app.register(sessionRoutes);

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
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
