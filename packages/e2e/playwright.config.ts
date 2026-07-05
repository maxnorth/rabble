import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// In environments with a system Chromium (e.g. sandboxed CI images), point
// at it directly instead of downloading a browser.
const systemChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./tests",
  // The suite is one stateful journey through a fresh install — run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  globalSetup: "./global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3178",
    launchOptions: existsSync(systemChromium)
      ? { executablePath: systemChromium }
      : undefined,
  },
});
