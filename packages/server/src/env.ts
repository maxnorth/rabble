import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://rabble:rabble@localhost:5432/rabble",
  ),
  port: Number(process.env.PORT ?? 3080),
  cookieSecret: required("COOKIE_SECRET", "dev-only-insecure-secret"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  nodeEnv: process.env.NODE_ENV ?? "development",
};
