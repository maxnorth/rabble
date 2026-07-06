/**
 * Boots the full stack for the e2e suite:
 *   1. recreates a dedicated rabble_e2e database and migrates it
 *   2. starts the emulator (fakes of Anthropic, OpenAI, MCP servers, Slack —
 *      the real app talks to them via configured base URLs)
 *   3. starts the production server build, serving the built web app
 *
 * The server's log is captured to .artifacts/server.log so tests can assert
 * that the run produced no server-side errors.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
export const artifactsDir = join(here, ".artifacts");
export const serverLogPath = join(artifactsDir, "server.log");

export const E2E_DB = "rabble_e2e";
export const E2E_PORT = 3178;
export const EMULATOR_PORT = 4100;
export const EMULATOR = `http://localhost:${EMULATOR_PORT}`;

const adminUrl =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgres://rabble:rabble@localhost:5432/rabble";
export const e2eDatabaseUrl = adminUrl.replace(/\/[^/]*$/, `/${E2E_DB}`);

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

export default async function globalSetup() {
  // 1. Fresh database
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();

  await run("pnpm", ["--filter", "@rabble/server", "db:migrate"], {
    DATABASE_URL: e2eDatabaseUrl,
  });

  // 2. Emulator
  const children: ChildProcess[] = [];
  const emulator = spawn(
    "node",
    [join(repoRoot, "packages/emulator/dist/index.js")],
    {
      env: { ...process.env, EMULATOR_PORT: String(EMULATOR_PORT) },
      stdio: "ignore",
    },
  );
  children.push(emulator);

  // 3. Server (production build), log captured for assertions
  mkdirSync(artifactsDir, { recursive: true });
  const logStream = createWriteStream(serverLogPath);
  const server = spawn("node", [join(repoRoot, "packages/server/dist/index.js")], {
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      DATABASE_URL: e2eDatabaseUrl,
      COOKIE_SECRET: "e2e-test-secret-0123456789abcdef0123456789abcdef",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(logStream);
  server.stderr.pipe(logStream);
  children.push(server);

  await waitFor(`http://localhost:${E2E_PORT}/api/health`);

  return async () => {
    for (const child of children) child.kill("SIGTERM");
  };
}
