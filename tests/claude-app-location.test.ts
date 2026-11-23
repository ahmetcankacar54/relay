import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { readFileSync } from "node:fs";
import { claudeCandidates, resolveClaudeExecutable } from "../electron/core/desktop-host-node";

test("Linux looks in the official and community packages' places and a Claude AppImage", () => {
  const candidates = claudeCandidates("linux", { home: "/home/me" });
  assert.ok(candidates.includes("/usr/bin/claude-desktop"));
  assert.ok(candidates.includes("/home/me/.local/bin/claude-desktop"));
  assert.ok(candidates.includes("/opt/Claude/claude-desktop"));
  // macOS and Windows keep their own places.
  assert.deepEqual(claudeCandidates("darwin", { apps: ["/Applications/Claude.app"] }), [
    "/Applications/Claude.app/Contents/MacOS/Claude",
  ]);
  assert.equal(claudeCandidates("win32", { env: { LOCALAPPDATA: "C:\\L" } }).length, 2);
});

test("a chosen location wins when it exists; a chosen Claude.app opens to its executable", () => {
  const files = new Set(["/opt/x/claude-desktop", "/usr/bin/claude-desktop", "/Apps/Claude.app/Contents/MacOS/Claude"]);
  const exists = (p: string) => files.has(p);
  assert.equal(resolveClaudeExecutable("/opt/x/claude-desktop", ["/usr/bin/claude-desktop"], exists), "/opt/x/claude-desktop");
  assert.equal(resolveClaudeExecutable("/Apps/Claude.app", [], exists), "/Apps/Claude.app/Contents/MacOS/Claude");
  // A chosen file that is gone, or a relative one, falls back to the usual places.
  assert.equal(resolveClaudeExecutable("/gone/claude", ["/usr/bin/claude-desktop"], exists), "/usr/bin/claude-desktop");
  assert.equal(resolveClaudeExecutable("claude-desktop", ["/usr/bin/claude-desktop"], exists), "/usr/bin/claude-desktop");
  assert.equal(resolveClaudeExecutable(undefined, [], exists), undefined);
});

test("Settings and the setup checklist offer Choose location, and main keeps the choice", () => {
  const settings = readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /chooseClaudeApp\(\{ api, action \}\)/);
  const checklist = readFileSync(new URL("../src/pages/overview/SetupChecklist.tsx", import.meta.url), "utf8");
  assert.match(checklist, /action: <ClaudeAppActions \/>/);
  const main = mainSource();
  assert.match(main, /handle\("pick-claude-app"/);
  assert.match(main, /s\.claudeApp = result\.filePaths\[0\]/);
  assert.match(main, /desktopHost\(vault\.sealer, \(\) => service\.store\.state\.claudeApp\)/);
  // Off macOS the vault seals through the system's own store, not the macOS Keychain.
  assert.match(main, /process\.platform === "darwin"\s*\? await prepareVault/);
});
