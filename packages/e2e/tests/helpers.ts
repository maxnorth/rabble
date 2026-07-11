/**
 * Shared pieces for the surface-delivery specs: the production server's base
 * URL and the signed webhook POST helpers (Slack v0 HMAC, GitHub sha256).
 */
import { createHmac } from "node:crypto";

export const SERVER = "http://localhost:3178";

export function signedSlackPost(body: unknown, secret = "emu-signing-secret") {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", secret)
    .update(`v0:${ts}:${raw}`)
    .digest("hex")}`;
  return fetch(`${SERVER}/api/inbound/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

export function signedGithubPost(body: unknown, deliveryId: string, event = "issue_comment") {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", "gh-webhook-secret").update(raw).digest("hex")}`;
  return fetch(`${SERVER}/api/inbound/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
    body: raw,
  });
}
