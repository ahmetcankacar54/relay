import test from "node:test";
import assert from "node:assert/strict";
import { macDesktopPids } from "../electron/core/desktop-processes";

test("Desktop shutdown ignores the independent Chrome host but waits for app workers", () => {
  const executable = "/Applications/Claude.app/Contents/MacOS/Claude";
  const browserHost =
    "64817 /Applications/Claude.app/Contents/Helpers/chrome-native-host";
  assert.deepEqual(macDesktopPids(browserHost, executable), []);
  assert.deepEqual(
    macDesktopPids(
      [
        `100 ${executable}`,
        browserHost,
        "101 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
        "102 /Applications/Claude.app/Contents/Resources/claude-code/claude",
        "103 /Users/test/.local/bin/claude",
        "104 /Applications/Claude.app.backup/Contents/MacOS/Claude",
        "invalid line",
      ].join("\n"),
      executable,
    ),
    [100, 101, 102],
  );
  const homeExecutable =
    "/Users/test/Applications/Claude.app/Contents/MacOS/Claude";
  assert.deepEqual(
    macDesktopPids(
      `105 ${homeExecutable}\n106 /Users/test/Applications/Claude.app/Contents/Helpers/chrome-native-host`,
      homeExecutable,
    ),
    [105],
  );
});
