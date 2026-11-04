import test from "node:test";
import assert from "node:assert/strict";
import { macInstances, processRows, userDataDir } from "../electron/core/desktop-instances";
import { appScript, openArgs } from "../electron/core/desktop-host-node";

const EXE = "/Applications/Claude.app/Contents/MacOS/Claude";
const HELPER = "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper";
const RENDERER =
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)";
const DISCLAIMER = "/Applications/Claude.app/Contents/Helpers/disclaimer";
const BROWSER_HOST = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
const DEFAULT_DIR = "/Users/me/Library/Application Support/Claude";
const WINDOW_DIR = "/Users/me/Library/Application Support/Relay/claude-windows/3c9e1f20-4b7a-4d1e-9f2a-6d5b8c0e7a14/data";

/** One `ps` census, as the two listings the host reads. */
function census(rows: [pid: number, ppid: number, executable: string, args: string][]) {
  const commands = rows.map(([pid, ppid, exe]) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${exe}`);
  const args = rows.map(([pid, , , line]) => `${String(pid).padStart(6)} ${line}`);
  return processRows(["     1      0 /sbin/launchd", ...commands].join("\n"), ["     1 /sbin/launchd", ...args].join("\n"));
}

test("the data folder comes from the switch, up to the next one, with spaces kept", () => {
  assert.equal(userDataDir(`${EXE} --disable-quic`), undefined);
  assert.equal(userDataDir(EXE), undefined);
  assert.equal(userDataDir(`${EXE} --user-data-dir=${WINDOW_DIR}`), WINDOW_DIR);
  assert.equal(userDataDir(`${EXE} --user-data-dir=${WINDOW_DIR} --disable-quic`), WINDOW_DIR);
  assert.equal(userDataDir(`${HELPER} --type=gpu-process --user-data-dir=${DEFAULT_DIR} --gpu-preferences=x`), DEFAULT_DIR);
  assert.equal(userDataDir(`${EXE} --user-data-dir=`), undefined);
});

test("a window and its helpers are apart from the main Claude, whose helpers name the default folder", () => {
  const rows = census([
    [100, 1, EXE, `${EXE} --disable-quic`],
    [101, 100, HELPER, `${HELPER} --type=gpu-process --user-data-dir=${DEFAULT_DIR}`],
    [102, 100, RENDERER, `${RENDERER} --type=renderer --user-data-dir=${DEFAULT_DIR}`],
    [103, 100, DISCLAIMER, `${DISCLAIMER} --pgroup -- claude`],
    [200, 1, EXE, `${EXE} --user-data-dir=${WINDOW_DIR}`],
    [201, 200, HELPER, `${HELPER} --type=gpu-process --user-data-dir=${WINDOW_DIR}`],
    [202, 200, RENDERER, `${RENDERER} --type=renderer --user-data-dir=${WINDOW_DIR}`],
    [300, 1, BROWSER_HOST, BROWSER_HOST],
    [400, 1, "/usr/bin/grep", `/usr/bin/grep ${EXE}`],
  ]);
  const claude = macInstances(rows, EXE);
  assert.deepEqual(claude.main.sort(), [100, 101, 102, 103]);
  assert.equal(claude.mainPid, 100);
  assert.deepEqual(claude.windows, [{ dir: WINDOW_DIR, pid: 200, pids: [200, 201, 202] }]);
});

test("a helper left without its app goes by its own switch, else to the main Claude", () => {
  const rows = census([
    [200, 1, EXE, `${EXE} --user-data-dir=${WINDOW_DIR}`],
    // Reparented to launchd: one still names the window's folder, one names none.
    [205, 1, HELPER, `${HELPER} --type=utility --user-data-dir=${WINDOW_DIR}`],
    [206, 1, DISCLAIMER, `${DISCLAIMER} --pgroup -- claude`],
  ]);
  const claude = macInstances(rows, EXE);
  assert.deepEqual(claude.main, [206]);
  assert.equal(claude.mainPid, undefined);
  assert.deepEqual(claude.windows, [{ dir: WINDOW_DIR, pid: 200, pids: [200, 205] }]);
});

test("only the window running: nothing is the main Claude", () => {
  const claude = macInstances(census([[200, 1, EXE, `${EXE} --user-data-dir=${WINDOW_DIR}`]]), EXE);
  assert.deepEqual(claude.main, []);
  assert.equal(claude.mainPid, undefined);
  assert.equal(claude.windows.length, 1);
});

test("two main Claudes: both counted, neither is the main pid", () => {
  const claude = macInstances(
    census([
      [100, 1, EXE, EXE],
      [110, 1, EXE, `${EXE} --disable-quic`],
    ]),
    EXE,
  );
  assert.deepEqual(claude.main, [100, 110]);
  assert.equal(claude.mainPid, undefined);
  // A quit with a window open asks each of them by pid.
  assert.deepEqual(claude.mainApps, [100, 110]);
});

test("an app is asked by pid, which must be a real one", () => {
  assert.match(appScript("terminate", 4242), /runningApplicationWithProcessIdentifier\(4242\).*app\.terminate/);
  assert.match(appScript("activate", 4242), /activateWithOptions/);
  for (const pid of [0, 1, -5, 1.5, Number.NaN]) assert.throws(() => appScript("terminate", pid));
});

test("a window starts as a new app on its folder; the main Claude as before", () => {
  assert.deepEqual(openArgs("/Applications/Claude.app", [], false), ["-a", "/Applications/Claude.app"]);
  assert.deepEqual(openArgs("/Applications/Claude.app", ["--disable-quic"], true), [
    "-n",
    "-a",
    "/Applications/Claude.app",
    "--args",
    "--disable-quic",
  ]);
  assert.deepEqual(openArgs("/Applications/Claude.app", [`--user-data-dir=${WINDOW_DIR}`], true).slice(-1), [
    `--user-data-dir=${WINDOW_DIR}`,
  ]);
});
