import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linuxDesktopPids } from "../electron/core/desktop-processes";
import { claudeCandidates, resolveClaudeExecutable } from "../electron/core/desktop-host-node";

test("Linux looks in the community packages' places and a Claude AppImage", () => {
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

test("Linux finds Claude's processes through its launcher, install folder or AppImage, never the Code CLI or Relay", () => {
  const listing = [
    "  101 /bin/bash /usr/bin/claude-desktop",
    "  102 /usr/lib/claude-desktop/node_modules/electron/dist/electron /usr/lib/claude-desktop/app.asar",
    "  103 /tmp/.mount_ClaudeAbc/claude --type=renderer",
    "  104 /home/me/.local/bin/claude --resume",
    "  105 node /home/me/.local/bin/claude",
    "  106 /opt/Relay/relay /usr/bin/claude-desktop",
    "  107 /usr/bin/vim notes.txt",
  ].join("\n");
  assert.deepEqual(linuxDesktopPids(listing, "/usr/bin/claude-desktop", 106), [101, 102, 103]);
  // A chosen binary is matched by its own name too, unless that name is the CLI's.
  assert.deepEqual(linuxDesktopPids("  201 /opt/x/Claude-Desktop\n  202 /usr/bin/Claude-Desktop --x", "/opt/x/Claude-Desktop", 1), [201, 202]);
  assert.deepEqual(linuxDesktopPids("  301 /usr/local/bin/claude", "/opt/odd/claude", 1), []);
  // A process that only names a file in the install folder or the launcher is not Claude.
  const unrelated = [
    "  401 /usr/bin/vim /usr/lib/claude-desktop/resources/notes.txt",
    "  402 grep -r token /opt/claude-desktop/",
    "  404 tail -f /usr/lib/claude-desktop/app.log",
  ].join("\n");
  assert.deepEqual(linuxDesktopPids(unrelated, "/usr/bin/claude-desktop", 1), []);
});

test("Settings and the setup checklist offer Choose location, and main keeps the choice", () => {
  const settings = readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /chooseClaudeApp\(\{ api, action \}\)/);
  const checklist = readFileSync(new URL("../src/pages/overview/SetupChecklist.tsx", import.meta.url), "utf8");
  assert.match(checklist, /action: <ClaudeAppActions \/>/);
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /handle\("pick-claude-app"/);
  assert.match(main, /s\.claudeApp = result\.filePaths\[0\]/);
  assert.match(main, /desktopHost\(vault\.sealer, \(\) => service\.store\.state\.claudeApp\)/);
  // Off macOS the vault seals through the system's own store, not the macOS Keychain.
  assert.match(main, /process\.platform === "darwin"\s*\? await prepareVault/);
});
