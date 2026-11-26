// Boot smoke for every platform: starts Relay's Tauri binary with a fresh profile in a temp
// folder and waits for its smoke report. Built with the cargo feature `smoke`, Relay asks its
// main page to call `snapshot` through the window bridge, writes {ok, accounts, rendererIsolated}
// to RELAY_SMOKE_RESULT and exits 0 (crates/relay-app/src/smoke.rs). It needs no Claude install,
// account or network, so it runs on Windows and Linux CI too.
//
//   cargo build -p relay-app --features smoke && node scripts/smoke-boot.mjs
//   node scripts/smoke-boot.mjs --app <binary>    another build of relay-app (with `smoke`)
//
// Fails on a non-zero exit, a missing or failed report, or no exit within 120 s. Linux needs a
// display (xvfb-run on CI).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Long enough for a cold Windows runner; a hang past it is the failure this test is for. */
const TIMEOUT_MS = 120_000;

/** Where `cargo build -p relay-app --features smoke` leaves the app. */
export const DEFAULT_APP = path.join(
  root,
  "target/debug",
  process.platform === "win32" ? "relay-app.exe" : "relay-app",
);

/**
 * A stand-in for /usr/bin/security (macOS) and the keyring (Linux) that keeps the vault key in
 * `dir`; `log` records each call with its time in seconds. Windows keeps the key in the
 * Credential Manager under the user's own account and needs none.
 */
export async function fakeSecurity(dir, log = path.join(dir, "security.log")) {
  const tool = path.join(dir, "fake-security");
  await fs.writeFile(
    tool,
    `#!/bin/sh
dir="${dir}"
echo "$(date +%s) $1" >> "${log}"
if [ "$1" = "-i" ]; then
  value="$(cat | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\\1/' | head -1)"
  [ -f "$dir/vault-key" ] || printf '%s' "$value" > "$dir/vault-key"
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/vault-key" ] || exit 44
  cat "$dir/vault-key"; echo
  exit 0
fi
exit 9
`,
    { mode: 0o700 },
  );
  return tool;
}

/**
 * The environment of a Relay that sees a machine with no Claude install and no accounts: its
 * data, HOME, the Claude folders and (Windows) the WebView2 profile all live under `dir`.
 */
export async function isolatedEnv(dir) {
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    RELAY_HOME: path.join(dir, "relay"),
    RELAY_CLAUDE_DIR: path.join(dir, "claude"),
    RELAY_CLAUDE_APP: path.join(dir, "no-claude.app"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
  };
  if (process.platform === "win32") {
    // The WebView2 profile goes under LOCALAPPDATA. The vault key stays in the Credential
    // Manager: the empty test vault is sealed with whatever key is stored there.
    Object.assign(env, {
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData/Roaming"),
      LOCALAPPDATA: path.join(home, "AppData/Local"),
    });
    await fs.mkdir(env.APPDATA, { recursive: true });
    await fs.mkdir(env.LOCALAPPDATA, { recursive: true });
  } else env.RELAY_SECURITY_TOOL = await fakeSecurity(dir);
  return env;
}

/** `--name value` from argv, else `fallback`. */
export function option(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`--${name} needs a value.`);
  return value;
}

async function main() {
  const app = path.resolve(option(process.argv, "app", DEFAULT_APP));
  if (!existsSync(app)) {
    console.error(
      `${app} is missing: run cargo build -p relay-app --features smoke first.`,
    );
    process.exit(1);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-boot-smoke-"));
  const resultFile = path.join(dir, "smoke-result.json");
  const env = { ...(await isolatedEnv(dir)), RELAY_SMOKE_RESULT: resultFile };
  const started = Date.now();
  const child = spawn(app, [], { stdio: "inherit", env });
  const timer = setTimeout(() => {
    console.error(`Relay did not exit within ${TIMEOUT_MS / 1000} s; killing it.`);
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const problems = [];
  if (exit.code !== 0) problems.push(`Relay exited with ${exit.code ?? exit.signal}.`);
  const result = await fs
    .readFile(resultFile, "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (!result)
    problems.push(
      "Relay wrote no smoke result: was it built with --features smoke, and is another Relay running?",
    );
  else if (result.ok !== true || result.rendererIsolated !== true)
    problems.push(`The smoke result is not a pass: ${JSON.stringify(result)}`);

  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`Test folder kept at ${dir}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS: Relay booted, its page answered snapshot through the bridge (${result.accounts} accounts) ` +
      `and it exited cleanly in ${seconds} s (${process.platform}-${process.arch}).`,
  );
  // WebView helper processes can hold files a moment after the exit, Windows longest.
  await fs
    .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .catch((error) => console.warn(`Could not remove ${dir}: ${error.message}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
