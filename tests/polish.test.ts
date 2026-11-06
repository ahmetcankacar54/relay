import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "../src/app/Sidebar";
import { switched } from "../src/pranks/RelayPrankStage";
import { mediaBlock } from "./css";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("panel and meter text is 11 px or more; text-xs is 12 px and text-2xs 11 px", () => {
  const theme = read("../src/styles/theme.css");
  assert.match(theme, /--text-xs: 0\.75rem;/);
  assert.match(theme, /--text-2xs: 0\.6875rem;/);
  for (const file of [
    "../src/panel/Panel.tsx",
    "../src/panel/PanelAccounts.tsx",
    "../src/panel/PanelActiveCard.tsx",
    "../src/panel/PanelDrafts.tsx",
    "../src/panel/PanelAutomation.tsx",
    "../src/components/LimitMeter.tsx",
    "../src/components/Disclosure.tsx",
    "../src/app/Sidebar.tsx",
  ])
    // The compact panel rows and eyebrows go down to 11.5 px and the "önerilen" mark to 11 px; nothing smaller.
    assert.doesNotMatch(read(file), /text-\[(?:\d|10)(?:\.\d+)?px\]/, file);
});

test("reduce motion stops animations and transitions, but spinners keep turning", () => {
  const block = mediaBlock(read("../src/styles/theme.css"), "(prefers-reduced-motion: reduce)");
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /animation-iteration-count: 1 !important/);
  assert.match(block, /transition-duration: 0\.01ms !important/);
  assert.match(block, /\.animate-spin,\s*\[data-spinner\] \{\s*animation-duration: 1s !important;\s*animation-iteration-count: infinite !important;/);
});

test("dialogs and sheets scroll instead of running off a short window; status cells wrap", () => {
  assert.match(read("../src/components/ui/dialog.tsx"), /max-h-\[calc\(100dvh-2rem\)\][^"]*overflow-y-auto/);
  assert.match(read("../src/components/ui/sheet.tsx"), /max-h-dvh[^"]*overflow-y-auto/);
  assert.match(read("../src/pages/accounts/AccountsTable.tsx"), /<TableCell className="whitespace-normal">/);
});

test("brand-coloured text uses the primary colour, which reads at 4.5:1", () => {
  for (const file of ["../src/features/ConnectionProgress.tsx", "../src/pages/accounts/AddAccountDialog.tsx"])
    assert.doesNotMatch(read(file), /text-brand/, file);
});

test("the sidebar's automation dot says what it means to a screen reader", () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      page: "genel",
      go() {},
      t: (tr: string) => tr,
      compact: false,
      status: { accounts: 2, planning: true, switching: true },
    }),
  );
  assert.match(html, /<span class="sr-only">Otomatik geçiş ve önceden başlatma açık<\/span>/);
});

test("the panel's gear opens Settings", () => {
  const panel = read("../src/panel/Panel.tsx");
  assert.match(panel, /aria-label=\{t\("Ayarlar", "Settings"\)\}[\s\S]{0,120}openPage\("ayarlar"\)/);
});

test("a switch is the Claude app moving from one saved account to another", () => {
  assert.equal(switched("a", "b"), true);
  assert.equal(switched("a", "a"), false);
  assert.equal(switched(undefined, "a"), false);
  assert.equal(switched("a", undefined), false);
  const stage = read("../src/pranks/RelayPrankStage.tsx");
  assert.match(stage, /dayOneQuiet=\{quietOnDayOne\}/);
  assert.match(stage, /markFirstSwitch\(windowStorage\(\)\)/);
});
