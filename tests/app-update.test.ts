import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  AppUpdates,
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  RETRY_CHECK_MS,
  UPDATE_BUSY,
  compareVersions,
  parseChecksums,
  releaseFrom,
  type UpdateDriver,
} from "../electron/core/app-update";
import {
  INSTALL_SCRIPT,
  MacUpdateDriver,
  UPDATE_CHECKSUM_MISMATCH,
  UPDATE_NO_CHECKSUM,
  UPDATE_SIGNATURE_MISMATCH,
  designatedRequirement,
  dmgFor,
} from "../electron/core/mac-update";
import { ElectronUpdateDriver, installerName, type ElectronUpdater } from "../electron/core/win-linux-update";
import type { UpdateState } from "../shared/types";
import { localizeError } from "../shared/error-text";
import "./i18n";

const temp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("versions compare by number, and a pre-release is older than its release", () => {
  assert.ok(compareVersions("0.16.0", "0.15.9") > 0);
  assert.ok(compareVersions("v0.15.10", "0.15.9") > 0);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.ok(compareVersions("0.16.0-test", "0.16.0") < 0);
  assert.ok(compareVersions("0.15.0", "0.16.0") < 0);
  assert.throws(() => compareVersions("latest", "0.1.0"));
});

test("a release comes from the feed only when published and stable, with its https assets", () => {
  const asset = { name: "Relay-0.16.0-arm64.dmg", browser_download_url: "https://example.test/a.dmg", size: 10 };
  const release = releaseFrom({
    tag_name: "v0.16.0",
    assets: [
      asset,
      { name: "x", browser_download_url: "http://bad.example/x", size: 1 },
      { name: "y", browser_download_url: "http://localhost.evil.test/y", size: 1 },
    ],
  });
  // A local test feed may serve over plain http from this computer.
  assert.equal(
    releaseFrom({ tag_name: "v0.16.0", assets: [{ name: "z", browser_download_url: "http://127.0.0.1:8765/z", size: 1 }] })?.assets.length,
    1,
  );
  assert.deepEqual(release, {
    version: "0.16.0",
    notesUrl: "https://github.com/ahmetcankacar54/relay/releases/tag/v0.16.0",
    assets: [{ name: asset.name, url: asset.browser_download_url, size: 10 }],
  });
  assert.equal(releaseFrom({ tag_name: "v0.16.0", draft: true }), undefined);
  assert.equal(releaseFrom({ tag_name: "v0.16.0", prerelease: true }), undefined);
  assert.equal(releaseFrom({ tag_name: "v0.16.0-beta" }), undefined);
  assert.equal(releaseFrom({ tag_name: "nightly" }), undefined);
  assert.equal(releaseFrom(null), undefined);
});

test("checksums, the Mac's DMG and the designated requirement are read strictly", () => {
  const sums = parseChecksums(`${"A".repeat(64)}  Relay-0.16.0-arm64.dmg\n${"b".repeat(64)} *INSTALL.txt\nnot a line\n`);
  assert.equal(sums.get("Relay-0.16.0-arm64.dmg"), "a".repeat(64));
  assert.equal(sums.get("INSTALL.txt"), "b".repeat(64));
  assert.equal(sums.size, 2);
  const assets = [
    { name: "Relay-0.16.0-arm64.dmg", url: "https://x/1", size: 1 },
    { name: "Relay-0.16.0-x64.dmg", url: "https://x/2", size: 1 },
  ];
  assert.equal(dmgFor(assets, "0.16.0", "arm64")?.url, "https://x/1");
  assert.equal(dmgFor(assets, "0.16.0", "x64")?.url, "https://x/2");
  assert.equal(dmgFor(assets, "0.16.0", "ia32"), undefined);
  const display = `Executable=/Applications/Relay.app/Contents/MacOS/Relay\ndesignated => identifier "dev.relay.workspace" and certificate leaf = H"32508c2b"\n`;
  assert.equal(designatedRequirement(display), `identifier "dev.relay.workspace" and certificate leaf = H"32508c2b"`);
  // An ad-hoc signature has only a cdhash requirement: nothing could be checked against it.
  assert.throws(() => designatedRequirement(`designated => cdhash H"abc"`), new RegExp(UPDATE_SIGNATURE_MISMATCH));
});

/** A driver that answers with fixed steps. */
function fakeDriver(steps: Partial<UpdateState>[], fail?: Error): UpdateDriver & { installs: number } {
  const driver = {
    installs: 0,
    async check(report: (patch: Partial<UpdateState>) => void) {
      for (const step of steps) report(step);
      if (fail) throw fail;
    },
    async install() {
      driver.installs++;
    },
  };
  return driver;
}

function updates(t: any, driver: UpdateDriver, extra: Partial<ConstructorParameters<typeof AppUpdates>[0]> = {}) {
  const folder = temp(t);
  const notified: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let quits = 0;
  let busy: string | undefined;
  const app = new AppUpdates({
    folder,
    current: "0.15.0",
    driver,
    now: () => Date.parse("2026-11-05T09:00:00Z"),
    notify: (v) => notified.push(v),
    changed: () => {},
    busy: () => busy,
    quit: () => quits++,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
    clearTimeout: () => {},
    ...extra,
  });
  return { app, folder, notified, timers, quits: () => quits, setBusy: (v?: string) => (busy = v) };
}

test("a ready update is told once per version, installs only when nothing else runs, then Relay quits", async (t) => {
  const driver = fakeDriver([
    { status: "available", version: "0.16.0" },
    { status: "downloading", progress: 0.5 },
    { status: "ready" },
  ]);
  const f = updates(t, driver);
  const state = await f.app.check();
  assert.equal(state.status, "ready");
  assert.equal(state.version, "0.16.0");
  assert.equal(state.checkedAt, "2026-11-05T09:00:00.000Z");
  assert.deepEqual(f.notified, ["0.16.0"]);
  // A second look keeps it ready and says nothing again.
  await f.app.check();
  assert.deepEqual(f.notified, ["0.16.0"]);
  f.setBusy(UPDATE_BUSY);
  await assert.rejects(f.app.install(), new RegExp(UPDATE_BUSY));
  assert.equal(driver.installs, 0);
  f.setBusy(undefined);
  await f.app.install();
  assert.equal(driver.installs, 1);
  assert.equal(f.quits(), 1);
  assert.equal(f.app.state().status, "installing");
  // The quit was cancelled: it is ready again.
  f.app.quitCancelled();
  assert.equal(f.app.state().status, "ready");
  // A new start remembers it was already told.
  const again = new AppUpdates({ ...(f.app as any).deps, notify: (v: string) => f.notified.push(`again:${v}`) });
  (again as any).current = { ...f.app.state() };
  (again as any).set({ status: "ready", version: "0.16.0" });
  assert.deepEqual(f.notified, ["0.16.0"]);
  assert.match(localizeError(UPDATE_BUSY, "tr"), /Bitince güncelle/);
});

test("a failed check says why; nothing newer reads as up to date", async (t) => {
  const failed = updates(t, fakeDriver([{ status: "available", version: "0.16.0" }], new Error(UPDATE_CHECKSUM_MISMATCH)));
  const state = await failed.app.check();
  assert.deepEqual([state.status, state.error], ["error", UPDATE_CHECKSUM_MISMATCH]);
  await assert.rejects(failed.app.install(), /No update is ready/);
  const quiet = updates(t, fakeDriver([]));
  assert.equal((await quiet.app.check()).status, "up-to-date");
});

test("checks start after a short wait, repeat every six hours, and stop when turned off", async (t) => {
  const f = updates(t, fakeDriver([]));
  f.app.start();
  assert.deepEqual(f.timers.map((x) => x.ms), [FIRST_CHECK_MS]);
  f.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.timers.at(-1)?.ms, CHECK_EVERY_MS);
  const before = f.timers.length;
  f.app.setAuto(false);
  assert.equal(f.app.state().autoCheck, false);
  assert.equal(f.timers.length, before);
  // Kept outside the registry, and a new start honours it.
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder, "state.json"), "utf8")).autoCheck, false);
  const next = updates(t, fakeDriver([]), { folder: f.folder });
  next.app.start();
  assert.deepEqual(next.timers, []);
});

test("a check finding no-asset or an error retries in two minutes, not six hours", async (t) => {
  const noAsset = updates(t, fakeDriver([{ status: "manual", manualReason: "no-asset" }]));
  noAsset.app.start();
  assert.equal(noAsset.timers.at(0)?.ms, FIRST_CHECK_MS);
  noAsset.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(noAsset.timers.at(-1)?.ms, RETRY_CHECK_MS);

  const errorCheck = updates(t, fakeDriver([], new Error("network down")));
  errorCheck.app.start();
  errorCheck.timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errorCheck.timers.at(-1)?.ms, RETRY_CHECK_MS);
});

const REQUIREMENT = `identifier "dev.relay.workspace" and certificate leaf = H"32508c2b9b3423e1f36cb671c5f8285bb33f5e0a"`;

/** A Mac with one release on its feed; the commands Relay runs are acted out in the temp folder. */
function macWorld(t: any, options: { sums?: (dmg: string) => string; signedLikeUs?: boolean; plistVersion?: string; arch?: string; place?: "applications" | "disk-image"; writable?: boolean } = {}) {
  const root = temp(t);
  const dmgBytes = Buffer.from("fake disk image");
  const sha = createHash("sha256").update(dmgBytes).digest("hex");
  const release = {
    tag_name: "v0.16.0",
    assets: [
      { name: "Relay-0.16.0-arm64.dmg", browser_download_url: "https://example.test/Relay-0.16.0-arm64.dmg", size: dmgBytes.length },
      { name: "SHA256SUMS.txt", browser_download_url: "https://example.test/SHA256SUMS.txt", size: 100 },
    ],
  };
  const request = (async (url: string) => {
    const body =
      url === "https://feed.test/latest"
        ? JSON.stringify(release)
        : url.endsWith("SHA256SUMS.txt")
          ? (options.sums ?? ((s) => `${s}  Relay-0.16.0-arm64.dmg\n`))(sha)
          : dmgBytes;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const runs: string[][] = [];
  const spawned: string[][] = [];
  const run = async (file: string, args: string[]) => {
    runs.push([path.basename(file), ...args]);
    if (file.endsWith("hdiutil") && args[0] === "attach") {
      const mount = args[args.indexOf("-mountpoint") + 1];
      fs.mkdirSync(path.join(mount, "Relay.app", "Contents"), { recursive: true });
      fs.writeFileSync(path.join(mount, "Relay.app", "Contents", "Info.plist"), "new");
    }
    if (file.endsWith("ditto")) fs.cpSync(args[0], args[1], { recursive: true });
    if (file.endsWith("codesign") && args[0] === "--display")
      return { stdout: `designated => ${REQUIREMENT}\n`, stderr: "" };
    if (file.endsWith("codesign") && args.includes("--test-requirement") && options.signedLikeUs === false)
      throw new Error("failed to satisfy requirement");
    if (file.endsWith("plutil")) return { stdout: `${options.plistVersion ?? "0.16.0"}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const bundle = path.join(root, "Applications", "Relay.app");
  fs.mkdirSync(bundle, { recursive: true });
  const driver = new MacUpdateDriver({
    feed: "https://feed.test/latest",
    folder: path.join(root, "updates"),
    current: "0.15.0",
    arch: options.arch ?? "arm64",
    bundle,
    place: () => options.place ?? "applications",
    pid: 4242,
    request,
    run,
    spawnDetached: (file, args) => spawned.push([file, ...args]),
    writable: () => options.writable ?? true,
  });
  const reports: Partial<UpdateState>[] = [];
  return { driver, root, runs, spawned, reports, report: (p: Partial<UpdateState>) => reports.push(p), bundle };
}

test("macOS: the DMG is downloaded, checked, unpacked and accepted when signed like this Relay", async (t) => {
  const w = macWorld(t);
  await w.driver.check(w.report);
  const statuses = w.reports.map((r) => r.status);
  assert.deepEqual([statuses[0], statuses.at(-1)], ["available", "ready"]);
  assert.ok(statuses.includes("downloading"));
  const dir = path.join(w.root, "updates", "0.16.0");
  assert.ok(fs.existsSync(path.join(dir, "Relay.app", "Contents", "Info.plist")));
  assert.ok(!fs.existsSync(path.join(dir, "Relay-0.16.0-arm64.dmg")), "the DMG is removed once unpacked");
  assert.ok(!fs.existsSync(path.join(dir, "mount")));
  // The running app's own requirement is applied to the new one.
  assert.ok(w.runs.some((r) => r[0] === "codesign" && r.includes(`=${REQUIREMENT}`)));
  // Installing hands the swap to the script, which waits for Relay's pid.
  await w.driver.install();
  assert.equal(w.spawned.length, 1);
  assert.deepEqual(w.spawned[0].slice(0, 1), ["/bin/bash"]);
  assert.deepEqual(w.spawned[0].slice(2, 5), ["4242", path.join(dir, "Relay.app"), w.bundle]);
  assert.equal(fs.readFileSync(w.spawned[0][1], "utf8"), INSTALL_SCRIPT);
  // A second check finds the verified copy without downloading again.
  const before = w.runs.filter((r) => r[0] === "hdiutil").length;
  const again = macWorld(t);
  (again.driver as any).deps.folder = path.join(w.root, "updates");
  await again.driver.check(again.report);
  assert.equal(again.reports.at(-1)?.status, "ready");
  assert.equal(again.runs.filter((r) => r[0] === "hdiutil").length, 0);
  assert.ok(before > 0);
});

test("macOS: once a version runs, its download and older ones are removed, newer ones kept", async (t) => {
  const w = macWorld(t);
  const folder = path.join(w.root, "updates");
  for (const v of ["0.14.1", "0.15.0", "0.16.0"]) fs.mkdirSync(path.join(folder, v), { recursive: true });
  fs.writeFileSync(path.join(folder, "state.json"), "{}");
  w.driver.prune();
  assert.deepEqual(fs.readdirSync(folder).sort(), ["0.16.0", "state.json"]);
});

test("macOS: a wrong checksum, another signature or another version is never accepted", async (t) => {
  const tampered = macWorld(t, { sums: () => `${"0".repeat(64)}  Relay-0.16.0-arm64.dmg\n` });
  await assert.rejects(tampered.driver.check(tampered.report), new RegExp(UPDATE_CHECKSUM_MISMATCH));
  assert.ok(!fs.existsSync(path.join(tampered.root, "updates", "0.16.0")));
  const stranger = macWorld(t, { signedLikeUs: false });
  await assert.rejects(stranger.driver.check(stranger.report), new RegExp(UPDATE_SIGNATURE_MISMATCH));
  const mislabelled = macWorld(t, { plistVersion: "0.15.0" });
  await assert.rejects(mislabelled.driver.check(mislabelled.report), new RegExp(UPDATE_SIGNATURE_MISMATCH));
  for (const w of [stranger, mislabelled]) await assert.rejects(w.driver.install(), /No update is ready/);
});

test("macOS: without a DMG for this Mac, from a disk image or an unwritable folder, it is offered by hand", async (t) => {
  const intel = macWorld(t, { arch: "ia32" });
  await intel.driver.check(intel.report);
  assert.deepEqual(intel.reports.at(-1), { status: "manual", manualReason: "no-asset" });
  const fromDmg = macWorld(t, { place: "disk-image" });
  await fromDmg.driver.check(fromDmg.report);
  assert.equal(fromDmg.reports.at(-1)?.manualReason, "location");
  await assert.rejects(fromDmg.driver.install(), /Move it to Applications/);
  const locked = macWorld(t, { writable: false });
  await locked.driver.check(locked.report);
  assert.equal(locked.reports.at(-1)?.manualReason, "not-writable");
});

/** Runs INSTALL_SCRIPT for real against fake apps; the tools that touch the system are stand-ins. */
function runScript(t: any, ditto = "/usr/bin/ditto", rsync = "/usr/bin/rsync") {
  const root = temp(t);
  const target = path.join(root, "Applications", "Relay.app");
  const next = path.join(root, "updates", "Relay.app");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "version"), "old");
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, "version"), "new");
  // A file the new version no longer ships: an in-place copy must remove it.
  fs.writeFileSync(path.join(target, "dropped"), "old only");
  const script = path.join(root, "install.sh");
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
  const log = path.join(root, "install.log");
  // A pid that is gone: Relay has quit.
  const gone = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const opened = path.join(root, "opened");
  const result = spawnSync("/bin/bash", [script, gone, next, target, log], {
    env: {
      PATH: "/usr/bin:/bin",
      RELAY_UPDATE_OPEN: "/usr/bin/touch",
      RELAY_UPDATE_DITTO: ditto,
      RELAY_UPDATE_RSYNC: rsync,
      RELAY_UPDATE_LSREGISTER: "/usr/bin/true",
      RELAY_UPDATE_PLUGINKIT: "/usr/bin/true",
    },
    encoding: "utf8",
  });
  return { root, target, log: fs.readFileSync(log, "utf8"), status: result.status, opened, gone };
}

test("the install script updates the app in place once Relay has quit, and reopens it", (t) => {
  if (process.platform !== "darwin") return t.skip("macOS script");
  const r = runScript(t);
  assert.equal(r.status, 0, r.log);
  assert.equal(fs.readFileSync(path.join(r.target, "version"), "utf8"), "new");
  assert.ok(!fs.existsSync(path.join(r.target, "dropped")));
  // The old app never leaves for a sibling path in Applications, and its copy is gone.
  assert.deepEqual(fs.readdirSync(path.dirname(r.target)), ["Relay.app"]);
  assert.ok(!fs.existsSync(path.join(r.root, "previous")));
  assert.match(r.log, /installed/);
});

test("the install script keeps the old app when it cannot copy it first", (t) => {
  if (process.platform !== "darwin") return t.skip("macOS script");
  const r = runScript(t, "/usr/bin/false");
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(r.target, "version"), "utf8"), "old");
  assert.match(r.log, /nothing changed/);
});

test("the install script puts the old app back when the copy fails", (t) => {
  if (process.platform !== "darwin") return t.skip("macOS script");
  const r = runScript(t, "/usr/bin/ditto", "/usr/bin/false");
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(r.target, "version"), "utf8"), "old");
  assert.ok(fs.existsSync(path.join(r.target, "dropped")));
  assert.match(r.log, /old app put back/);
});

function fakeUpdater(version: string | undefined, file?: string): ElectronUpdater & { installs: unknown[][] } {
  const listeners: ((info: { percent: number }) => void)[] = [];
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: {} as unknown,
    installs: [] as unknown[][],
    async checkForUpdates() {
      if (!version) return null;
      return {
        isUpdateAvailable: true,
        updateInfo: { version },
        downloadPromise: (async () => {
          for (const l of listeners) l({ percent: 50 });
          return file ? [file] : [];
        })(),
      };
    },
    on(_e: "download-progress", l: (info: { percent: number }) => void) {
      listeners.push(l);
      return updater;
    },
    off() {
      listeners.length = 0;
      return updater;
    },
    quitAndInstall(...args: unknown[]) {
      updater.installs.push(args);
    },
  };
  return updater;
}

interface SignedRelease {
  file: string;
  digest: string;
  fetched: string[];
  driver(updater: ElectronUpdater, env?: NodeJS.ProcessEnv): ElectronUpdateDriver;
}

/**
 * A release on a fake host: an installer downloaded to a temporary folder, and its
 * SHA256SUMS.txt signed with a throwaway key the driver is given instead of the embedded one.
 * `signer` signs instead of that key; `tamper` rewrites the sums after they were signed.
 */
function signedRelease(
  t: any,
  {
    version = "0.16.0",
    platform = "win32" as NodeJS.Platform,
    sums = undefined as string | undefined,
    signature = undefined as string | undefined,
    signer = undefined as KeyObject | undefined,
    tamper = (text: string) => text,
    missing = [] as string[],
  } = {},
): SignedRelease {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const file = path.join(temp(t), installerName(platform, version));
  fs.writeFileSync(file, "installer bytes");
  const digest = createHash("sha256").update("installer bytes").digest("hex");
  const text = sums ?? `${"0".repeat(64)}  INSTALL.txt\n${digest}  ${installerName(platform, version)}\n`;
  const files: Record<string, string> = {
    "SHA256SUMS.txt": tamper(text),
    "SHA256SUMS.txt.sig": signature ?? sign(null, Buffer.from(text), signer ?? privateKey).toString("base64") + "\n",
  };
  const fetched: string[] = [];
  const request = (async (url: string) => {
    fetched.push(url);
    const name = String(url).split("/").pop()!;
    const body = missing.includes(name) ? undefined : files[name];
    return new Response(body ?? "not found", { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const driver = (updater: ElectronUpdater, env: NodeJS.ProcessEnv = {}) =>
    new ElectronUpdateDriver({ updater: async () => updater, current: "0.15.0", platform, env, request, publicKey: key });
  return { file, digest, driver, fetched };
}

test("Windows and Linux: electron-updater downloads by itself, never installs on quit, and installs on Update", async (t) => {
  const release = signedRelease(t);
  const updater = fakeUpdater("0.16.0", release.file);
  const driver = release.driver(updater);
  const reports: Partial<UpdateState>[] = [];
  await driver.check((p) => reports.push(p));
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  // Progress that came before the version was known is shown once it is.
  assert.deepEqual(reports.map((r) => r.status), ["available", "downloading", "ready"]);
  assert.equal(reports[1].progress, 0.5);
  // The sums come from the release of the version electron-updater found.
  assert.deepEqual(release.fetched, [
    "https://github.com/ahmetcankacar54/relay/releases/download/v0.16.0/SHA256SUMS.txt",
    "https://github.com/ahmetcankacar54/relay/releases/download/v0.16.0/SHA256SUMS.txt.sig",
  ]);
  await driver.install();
  assert.deepEqual(updater.installs, [[false, true]]);
  // An AppImage running as one is checked the same way.
  const appImage = signedRelease(t, { platform: "linux" });
  const linuxReports: Partial<UpdateState>[] = [];
  await appImage.driver(fakeUpdater("0.16.0", appImage.file), { APPIMAGE: appImage.file }).check((p) => linuxReports.push(p));
  assert.equal(linuxReports.at(-1)?.status, "ready");
  // Linux outside an AppImage cannot replace itself.
  const linux = new ElectronUpdateDriver({ updater: async () => fakeUpdater("0.16.0"), current: "0.15.0", platform: "linux", env: {} });
  const seen: Partial<UpdateState>[] = [];
  await linux.check((p) => seen.push(p));
  assert.equal(seen.at(-1)?.manualReason, "not-appimage");
  await assert.rejects(linux.install(), /No update is ready/);
  // Nothing newer.
  const none: Partial<UpdateState>[] = [];
  await new ElectronUpdateDriver({ updater: async () => fakeUpdater(undefined), current: "0.15.0", platform: "win32", env: {} }).check((p) => none.push(p));
  assert.deepEqual(none, [{ status: "up-to-date" }]);
});

test("Windows and Linux: an installer the signed sums do not vouch for is deleted, never installed", async (t) => {
  const rejected = async (release: SignedRelease, error: string, file = release.file) => {
    const updater = fakeUpdater("0.16.0", file);
    const driver = release.driver(updater);
    await assert.rejects(driver.check(() => {}), new RegExp(error));
    assert.equal(fs.existsSync(file), false, "the rejected download is removed");
    await assert.rejects(driver.install(), /No update is ready/);
    assert.deepEqual(updater.installs, []);
  };
  // A tampered installer: latest.yml (served with it) matched, the signed sums do not.
  const tampered = signedRelease(t);
  fs.writeFileSync(tampered.file, "something else");
  await rejected(tampered, UPDATE_CHECKSUM_MISMATCH);
  // The tampered installer again, now with the sums edited to its digest; the signature is the
  // original one, over the original sums.
  const edited = signedRelease(t, {
    tamper: (text) => text.replace(/^[0-9a-f]{64}(?=  Relay-Setup)/m, createHash("sha256").update("something else").digest("hex")),
  });
  fs.writeFileSync(edited.file, "something else");
  await rejected(edited, UPDATE_SIGNATURE_MISMATCH);
  // Sums signed by another key (the release host's own, say).
  await rejected(signedRelease(t, { signer: generateKeyPairSync("ed25519").privateKey }), UPDATE_SIGNATURE_MISMATCH);
  // A garbled signature, and none at all.
  await rejected(signedRelease(t, { signature: "not base64 at all" }), UPDATE_SIGNATURE_MISMATCH);
  await rejected(signedRelease(t, { missing: ["SHA256SUMS.txt.sig"] }), UPDATE_SIGNATURE_MISMATCH);
  await rejected(signedRelease(t, { missing: ["SHA256SUMS.txt"] }), UPDATE_NO_CHECKSUM);
  // Signed sums that do not list this installer.
  await rejected(signedRelease(t, { sums: `${"a".repeat(64)}  INSTALL.txt\n` }), UPDATE_NO_CHECKSUM);
  // A tampered latest.yml naming another (older, validly listed) file: refused by name.
  const renamed = signedRelease(t);
  const older = path.join(path.dirname(renamed.file), "Relay-Setup-0.14.0-x64.exe");
  fs.copyFileSync(renamed.file, older);
  await rejected(renamed, UPDATE_CHECKSUM_MISMATCH, older);
  // No downloaded file reported at all.
  const empty = signedRelease(t);
  await assert.rejects(empty.driver(fakeUpdater("0.16.0")).check(() => {}), new RegExp(UPDATE_CHECKSUM_MISMATCH));
});

test("the installer names the updater expects are package.json's artifact names", () => {
  const build = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")).build;
  const name = (template: string, ext: string) => template.replace("${version}", "1.2.3").replace("${ext}", ext);
  assert.equal(installerName("win32", "1.2.3"), name(build.win.artifactName, "exe"));
  assert.equal(installerName("linux", "1.2.3"), name(build.linux.artifactName, "AppImage"));
  // The macOS updater picks the DMG for the running architecture: Apple silicon and Intel.
  const assets = ["arm64", "x64"].map((arch) => ({ name: `Relay-1.2.3-${arch}.dmg`, url: `https://x/${arch}`, size: 1 }));
  assert.equal(dmgFor(assets, "1.2.3", "arm64")?.url, "https://x/arm64");
  assert.equal(dmgFor(assets, "1.2.3", "x64")?.url, "https://x/x64");
  assert.equal(dmgFor(assets.slice(0, 1), "1.2.3", "x64"), undefined);
});
