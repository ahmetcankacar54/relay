import { defineConfig, devices } from "@playwright/test";

// The browser preview (`npm run dev:ui`) with its sample data (src/preview.ts): screenshots of the
// main pages and an axe scan of each. `npm run test:e2e`; `-- --update-snapshots` after a UI change.
const PORT = 5173;

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  snapshotPathTemplate:
    "{testDir}/__snapshots__/{testFilePath}/{arg}-{platform}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "report" }]]
    : "list",
  expect: {
    toHaveScreenshot: {
      // Font hinting and GPU rasterisation differ between runner images; a real layout change
      // moves far more than 2 % of the pixels.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "npm run dev:ui",
    cwd: "..",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
