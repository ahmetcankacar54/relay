import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProcessListing,
  ClaudeLiveness,
  macDesktopPids,
  pidAlive,
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

function liveness() {
  const state = {
    clock: 0,
    listings: 0,
    pids: [] as number[],
    main: undefined as number | undefined,
    alive: new Set<number>(),
    fail: false,
  };
  const probe = new ClaudeLiveness({
    list: async () => {
      state.listings++;
      // An empty or cut-short listing throws, as macListing does.
      if (state.fail) assertProcessListing("");
      return { pids: [...state.pids], main: state.main };
    },
    alive: (pid) => state.alive.has(pid),
    now: () => state.clock,
  });
  return { state, probe };
}

test("a known Claude pid that is alive answers without listing every process, for a minute", async () => {
  const { state, probe } = liveness();
  state.pids = [300, 301, 302];
  state.main = 301;
  state.alive = new Set([300, 301, 302]);
  assert.equal(await probe.seemsRunning(), true);
  assert.equal(state.listings, 1);
  state.clock += 30_000;
  assert.equal(await probe.seemsRunning(), true);
  assert.equal(state.listings, 1);
  // A minute after the last listing, list again.
  state.clock += 30_000;
  assert.equal(await probe.seemsRunning(), true);
  assert.equal(state.listings, 2);
});

test("a dead pid, no known pid or a fresh read lists every process", async () => {
  const { state, probe } = liveness();
  state.pids = [300, 301];
  state.main = 301;
  state.alive = new Set([300, 301]);
  assert.equal(await probe.seemsRunning(), true);
  // The main process went away: a full listing tells.
  state.alive.delete(301);
  state.pids = [];
  assert.equal(await probe.seemsRunning(), false);
  assert.equal(state.listings, 2);
  // Closed: no pid is known, so each read lists.
  assert.equal(await probe.seemsRunning(), false);
  assert.equal(state.listings, 3);
  // Without a main pid, the first pid of the listing is the one watched.
  state.pids = [400, 401];
  state.main = undefined;
  state.alive = new Set([400]);
  assert.equal(await probe.seemsRunning(), true);
  assert.equal(await probe.seemsRunning(), true);
  assert.equal(state.listings, 4);
  // Decisions never trust the pid: running() and pids() always list.
  assert.equal(await probe.running(), true);
  assert.deepEqual(await probe.pids(), [400, 401]);
  assert.equal(state.listings, 6);
});

test("an empty listing still throws through the pid shortcut, never 'Claude is closed'", async () => {
  const { state, probe } = liveness();
  state.fail = true;
  await assert.rejects(probe.seemsRunning(), /process list/);
  await assert.rejects(probe.running(), /process list/);
  // A known pid that died does not turn a failed listing into "closed".
  state.fail = false;
  state.pids = [300];
  state.alive = new Set([300]);
  assert.equal(await probe.seemsRunning(), true);
  state.alive.clear();
  state.fail = true;
  await assert.rejects(probe.seemsRunning(), /process list/);
});

test("a pid is alive while its process exists", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
});
