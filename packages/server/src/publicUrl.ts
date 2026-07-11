import type { FastifyRequest } from "fastify";
import { env } from "./env.js";

/** Rabble's public base URL — configured (PUBLIC_URL), or derived from the
 * request's forwarded host. The stable address OAuth callbacks and Slack
 * request URLs must point at. */
export function publicBaseUrl(req: FastifyRequest): string {
  if (env.publicUrl) return env.publicUrl;
  const proto = String(req.headers["x-forwarded-proto"] ?? "http");
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return `${proto}://${host}`;
}
