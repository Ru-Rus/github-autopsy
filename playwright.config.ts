import { defineConfig, devices } from "@playwright/test";

// Keep inherited terminal settings consistent for browser/server workers.
if (process.env.FORCE_COLOR !== undefined) delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    extraHTTPHeaders: {
      "x-autopsy-proxy-secret": process.env.TRUSTED_PROXY_SECRET ?? "",
      "x-autopsy-client-ip": "192.0.2.1",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command:
      "node --require ./tests/server-fixtures.cjs .next/standalone/server.js",
    env: {
      PORT: "3100",
      HOSTNAME: "127.0.0.1",
      AUTOPSY_BROWSER_FIXTURES: "1",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
      REPORT_STORAGE_DIR: "",
    },
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
  },
});
