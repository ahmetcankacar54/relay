import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// One fixed moment: the sample data (src/preview.ts) is laid out around Date.now, and every page
// prints relative times ("updated 1 min ago", "resets in 2 h").
const NOW = new Date("2026-11-18T09:30:00Z");

const PAGES = [
  { name: "overview", hash: "#/genel", title: "Overview" },
  { name: "accounts", hash: "#/hesaplar", title: "Accounts" },
  { name: "planning", hash: "#/planlama", title: "Planning" },
  { name: "usage", hash: "#/kullanim", title: "Limit history" },
  { name: "gateway", hash: "#/proxy", title: "Proxy & Gateway" },
  { name: "settings-general", hash: "#/ayarlar/genel", title: "Settings" },
] as const;

/** Loads a page of the preview with its 50 sample accounts. */
async function load(page: Page, hash: string) {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/?demo=50${hash}`);
}

/** Opens a page settled for a screenshot or a scan. */
async function open(page: Page, hash: string, title: string) {
  await load(page, hash);
  // The sample settings have risky features on from before the consent existed, so once the first
  // snapshot is in, the shell asks about all of them in one dialog (src/components/RiskConsent.tsx).
  // Waiting for it is also waiting for the data. Accept, as a user keeping them would.
  const accept = page.locator('[data-slot="risk-accept"]');
  await expect(accept).toBeVisible({ timeout: 15_000 });
  await accept.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: title, exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** Serious and critical WCAG 2.1 A/AA violations, summarised for the failure message. */
async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Limits read long ago, or of an account out of the gateway's pool, are faded on purpose
    // (opacity-60 in src/components/LimitLine.tsx and AccountCard.tsx): not the figures to act on.
    .exclude('[data-slot="limit-line"].opacity-60')
    .exclude('[data-slot="row-limits"].opacity-60')
    .exclude('[data-slot="cost-line"].opacity-60')
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
}

for (const { name, hash, title } of PAGES) {
  test.describe(name, () => {
    test("looks as before", async ({ page }) => {
      // The baselines are macOS renders: other systems draw text with other fonts.
      test.skip(
        process.platform !== "darwin",
        "screenshots are compared on macOS only",
      );
      await open(page, hash, title);
      await expect(page).toHaveScreenshot(`${name}.png`);
    });

    test("has no serious accessibility violations", async ({ page }) => {
      await open(page, hash, title);
      const serious = await seriousViolations(page);
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });
  });
}

test("the risk consent dialog has no serious accessibility violations", async ({
  page,
}) => {
  await load(page, "#/genel");
  await expect(page.locator('[data-slot="risk-accept"]')).toBeVisible({
    timeout: 15_000,
  });
  const serious = await seriousViolations(page);
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
