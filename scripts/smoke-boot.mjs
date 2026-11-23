// Boot smoke for every platform: starts Relay in Electron with a fresh profile in a temp
// folder, waits until its window answers over IPC, quits it the normal way and checks that the
// process ended by itself, with exit code 0, no main-process error log and no crash dump.
// It needs no Claude install, account or network, so it runs on Windows and Linux CI too;
// scripts/smoke.mjs (npm run test:desktop) is the deep macOS integration test.
//
//   node scripts/smoke-boot.mjs              the build in dist-electron (npm run build first)
//   node scripts/smoke-boot.mjs --packaged   the app.asar electron-builder --dir made in release/
//
// RELAY_PACKAGED_MAIN overrides where --packaged looks. Linux needs a display (xvfb-run on CI).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where electron-builder --dir leaves the packaged main script on this platform. */
const PACKAGED_MAIN = {
  darwin: `release/mac-${process.arch}/Relay.app/Contents/Resources/app.asar/dist-electron/main.cjs`,
  win32: "release/win-unpacked/resources/app.asar/dist-electron/main.cjs",
  linux: "release/linux-unpacked/resources/app.asar/dist-electron/main.cjs",
};
/** Long enough for a cold Windows runner; a hang past it is the failure this test is for. */
const TIMEOUT_MS = 120_000;

const packaged = process.argv.includes("--packaged");
const main = packaged
  ? path.resolve(
      process.env.RELAY_PACKAGED_MAIN || PACKAGED_MAIN[process.platform] || "",
    )
  : path.join(here, "../dist-electron/main.cjs");
if (!existsSync(main.replace(/app\.asar[\\/].*$/, "app.asar"))) {
  console.error(
    `${main} is missing: run ${packaged ? "npx electron-builder --dir" : "npm run build"} first.`,
  );
  process.exit(1);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-boot-smoke-"));
const env = {
  ...process.env,
  RELAY_SMOKE_ROOT: root,
  RELAY_SMOKE_MAIN: packaged ? main : "",
};
// Left over from a parent, it would make Electron a plain Node with no `app`.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(here, "smoke-boot.cjs")], {
  stdio: "inherit",
  env,
});
const timer = setTimeout(() => {
  console.error(
    `Relay did not quit within ${TIMEOUT_MS / 1000} s; killing it.`,
  );
  child.kill("SIGKILL");
}, TIMEOUT_MS);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

/** Every file under `dir`, or none when it does not exist. */
async function files(dir) {
  const entries = await fs
    .readdir(dir, { recursive: true, withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}
const problems = [];
if (exit.code !== 0)
  problems.push(`Electron exited with ${exit.code ?? exit.signal}.`);
const result = await fs
  .readFile(path.join(root, "boot-result.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({ booted: false, error: "no boot-result.json" }));
if (!result.booted) problems.push(`Relay did not boot: ${result.error}`);
const errorLog = path.join(root, "logs", "main-errors.log");
if (existsSync(errorLog))
  problems.push(
    `The main process logged errors:\n${await fs.readFile(errorLog, "utf8")}`,
  );
const dumps = (await files(path.join(root, "crashDumps"))).filter((f) =>
  /\.dmp$/i.test(f),
);
if (dumps.length)
  problems.push(`Crash dumps were written:\n${dumps.join("\n")}`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`Test folder kept at ${root}`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS: Relay booted in ${result.bootMs} ms (${packaged ? "packaged" : "dist-electron"}, ` +
      `${process.platform}, Electron ${result.electron}), answered over IPC and quit cleanly.`,
  );
  // Chromium's helper processes can hold files a moment after the exit, Windows longest.
  await fs
    .rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .catch((error) =>
      console.warn(`Could not remove ${root}: ${error.message}`),
    );
}
