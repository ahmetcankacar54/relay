import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProcessListing,
  macDesktopPids,
  macMainPid,
  parseEtime,
  retryOnce,
} from "../electron/core/desktop-processes";

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

test("an empty or unreadable process list is an error, never 'Claude is not running'", () => {
  assert.throws(() => assertProcessListing(""), /process list/);
  assert.throws(() => assertProcessListing("\n  \n"), /process list/);
  assert.throws(() => assertProcessListing("garbage without pids"), /process list/);
  // A real listing always holds launchd.
  assert.doesNotThrow(() =>
    assertProcessListing("    1 /sbin/launchd\n  100 /usr/libexec/logd\n"),
  );
});

test("a failed process lookup is retried once, then reported", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("Command failed: /bin/ps -axo pid=,comm=");
    return 7;
  };
  assert.equal(await retryOnce(flaky, 250, sleep), 7);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
  calls = 0;
  const broken = async () => {
    calls++;
    throw new Error(`attempt ${calls}`);
  };
  await assert.rejects(retryOnce(broken, 250, sleep), /attempt 2/);
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(await retryOnce(async () => ++calls, 250, sleep), 1);
  assert.equal(calls, 1);
});

test("Claude's main pid is the one running the app's executable itself", () => {
  const executable = "/Applications/Claude.app/Contents/MacOS/Claude";
  const listing = [
    "    1 /sbin/launchd",
    `  100 ${executable}`,
    "  101 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
    "  102 /Applications/Claude.app/Contents/Resources/claude-code/claude",
    "  104 /Applications/Claude.app.backup/Contents/MacOS/Claude",
  ].join("\n");
  assert.equal(macMainPid(listing, executable), 100);
  // Only helpers left, or two main processes at once: there is no single main process.
  const helpersOnly = listing.replace(`100 ${executable}`, "100 /bin/zsh");
  assert.equal(macMainPid(helpersOnly, executable), undefined);
  const twoMains = `${listing}\n  105 ${executable}`;
  assert.equal(macMainPid(twoMains, executable), undefined);
});

test("ps elapsed time [[dd-]hh:]mm:ss is read as milliseconds", () => {
  assert.equal(parseEtime("01:02"), 62_000);
  assert.equal(parseEtime("   00:15\n"), 15_000);
  assert.equal(parseEtime("02:03:04"), (2 * 3600 + 3 * 60 + 4) * 1000);
  assert.equal(parseEtime("1-02:03:04"), ((24 + 2) * 3600 + 3 * 60 + 4) * 1000);
  assert.equal(parseEtime("12-00:00:00"), 12 * 86_400_000);
  for (const bad of [
    "",
    "15",
    "1:2",
    "01:60",
    "60:00",
    "24:00:00",
    "1-03:04",
    "-01:02",
    "01:02:03:04",
    "aa:bb",
  ])
    assert.equal(parseEtime(bad), undefined, bad);
});
