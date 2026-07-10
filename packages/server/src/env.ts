import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const isProduction = (process.env.NODE_ENV ?? "development") === "production";

/**
 * A security-critical secret (cookie signing, credential encryption). In
 * production it MUST be set explicitly — refusing to boot beats silently
 * signing/encrypting under a public constant from this repo. Dev keeps a
 * throwaway fallback for zero-config local runs.
 */
function requiredSecret(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) {
    throw new Error(
      `${name} (or ENCRYPTION_SECRET) must be set in production — refusing ` +
        "to start with an insecure default key.",
    );
  }
  return "dev-only-insecure-secret";
}

export const env = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://rabble:rabble@localhost:55432/rabble",
  ),
  port: Number(process.env.PORT ?? 3080),
  cookieSecret: requiredSecret("COOKIE_SECRET"),
  /**
   * Root secret for AES-GCM encryption of stored credentials. Falls back
   * to COOKIE_SECRET for compatibility — set it explicitly on new installs
   * so cookie-signing and secret-encryption don't share one root. Changing
   * it after credentials exist orphans them (no re-encryption flow yet).
   */
  encryptionSecret:
    process.env.ENCRYPTION_SECRET ?? requiredSecret("COOKIE_SECRET"),
  /** Mark auth cookies Secure. Enable when serving behind HTTPS. */
  cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",
  /**
   * Enable TLS to Postgres (managed providers' external URLs). Internal /
   * same-network URLs generally don't need it.
   */
  databaseSsl: (process.env.DATABASE_SSL ?? "false") === "true",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  nodeEnv: process.env.NODE_ENV ?? "development",
  /**
   * Rabble's own public https base URL (no trailing slash). Slack must be
   * able to reach it for the OAuth callback + Events request URL during the
   * managed Slack setup. Falls back to the request host when unset.
   */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, ""),
};
