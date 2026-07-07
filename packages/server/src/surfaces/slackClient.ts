/**
 * Slack Web API client factory. Pointing slackApiUrl at the connection's base
 * URL preserves the emulator swap (only the base URL differs; app code never
 * knows it's fake). The SDK form-encodes every request — which real Slack
 * requires for read methods like users.info/conversations.info, where a
 * hand-rolled JSON body is silently ignored and the call fails.
 */
import { WebClient, LogLevel } from "@slack/web-api";

export function slackClient(
  baseUrl: string | null | undefined,
  token: string,
): WebClient {
  const root = (baseUrl ?? "https://slack.com").replace(/\/+$/, "");
  return new WebClient(token, {
    slackApiUrl: `${root}/api/`,
    logLevel: LogLevel.WARN,
  });
}
