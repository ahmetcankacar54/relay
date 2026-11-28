import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "../shared/types";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { ConfigSyncPreference } from "../src/features/ConfigSyncPreference";
import { testT } from "./i18n";

test("Settings → Switching shows the four choices, off by default", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ConfigSyncPreference, {
        settings: { ...DEFAULT_SETTINGS, configSync: undefined },
        update: () => {},
        disabled: false,
        t: testT("en"),
      }),
    ),
  );
  assert.match(html, /Same setup in every account/);
  for (const key of ["mcpServers", "skills", "settings", "claudeMd"])
    assert.match(
      html,
      new RegExp(
        `id="config-sync-${key}"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="config-sync-${key}"`,
      ),
    );
  assert.match(
    html,
    /MCP servers[\s\S]*Skills and agents[\s\S]*Claude Code settings[\s\S]*CLAUDE\.md/,
  );
  const source = fs.readFileSync(
    new URL("../src/pages/settings/SwitchingTabs.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<ConfigSyncPreference settings=\{settings\} update=\{update\}/,
  );
});
