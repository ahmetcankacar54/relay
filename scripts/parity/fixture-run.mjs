#!/usr/bin/env node
// Runs one relay command against a fresh parity fixture, so every recorded case starts from the
// same world however the cases before it changed theirs:
//   node scripts/parity/fixture-run.mjs <relay binary> [args...]
// The fixture is a frozen snapshot (rust/fixtures/<scenario>/, see rust/README.md) copied into a
// new temp folder; the command runs in the sandbox (sandbox.mjs) with stdin, stdout and stderr
// passed through, and the folder is deleted after; the exit code is the command's. The command
// gets a clean environment: the fixture's, TZ=UTC, a system PATH, the parity clock
// (RELAY_PARITY_NOW, read by the `parity` cargo feature), and
// - RELAY_PARITY_SCENARIO: the fixture's variation, one of rust/fixtures/<scenario>.json;
// - RELAY_PARITY_ENV_<NAME>=<value>: <NAME> set to <value> ("" unsets it), where `{root}`,
//   `{home}` and `{relay}` are the fixture's folder, home folder and Relay data folder.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxed } from "./sandbox.mjs";

/** The instant every recorded run starts at: the one the snapshots were frozen at. */
export const PARITY_NOW = "2026-11-26T09:41:15.000Z";
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "rust", "fixtures");
const PASS = "RELAY_PARITY_ENV_";

/**
 * The snapshot of `scenario` (a comma-separated list, as the recordings name it): `default` for
 * none, else the names sorted and joined with `+`.
 */
function snapshotName(scenario) {
  const names = [
    ...new Set(
      (scenario ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort();
  return names.length ? names.join("+") : "default";
}

/**
 * Copies the frozen snapshot `name` into `root`. The snapshots hold three placeholders for what
 * only a live fixture knows: `@ROOT@` (the fixture folder) in the files the manifest marks
 * `substitute`, `"@PID@"` (the live holder of a busy lock: this process) in those files and in
 * file names, and `@CRED-<account id>@` in the fake keychain's item names (Claude Code's
 * credential service, named after the profile folder's path).
 */
function thaw(name, root) {
  const manifestFile = path.join(FIXTURES, `${name}.json`);
  if (!fs.existsSync(manifestFile))
    throw new Error(`No frozen parity fixture "${name}" in rust/fixtures.`);
  const { env, entries } = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const pid = String(process.pid);
  const credential = (id) => {
    const profile = path.resolve(root, "relay", "profiles", id).normalize("NFC");
    const hash = crypto.createHash("sha256").update(profile).digest("hex");
    return `Claude Code-credentials-${hash.slice(0, 8)}`.replace(/[^A-Za-z0-9]/g, "_");
  };
  const live = (stored) =>
    stored
      .replaceAll("@PID@", pid)
      .replace(/@CRED-([^@/]+)@/g, (_, id) => credential(id));
  for (const entry of entries) {
    const target = path.join(root, live(entry.path));
    if (entry.dir) {
      fs.mkdirSync(target, { mode: 0o700 });
      continue;
    }
    let bytes = fs.readFileSync(path.join(FIXTURES, name, entry.path));
    if (entry.substitute)
      bytes = Buffer.from(
        bytes
          .toString("utf8")
          .replaceAll("@ROOT@", root)
          .replaceAll('"@PID@"', pid),
      );
    fs.writeFileSync(target, bytes, { mode: entry.mode });
  }
  // Modes last: the umask narrowed them on creation, and a folder must stay writable until full.
  for (const entry of entries.toReversed())
    fs.chmodSync(path.join(root, live(entry.path)), entry.mode);
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value.replaceAll("@ROOT@", root)]),
  );
}

/** A fresh fixture under the temp folder and the clean environment that points relay at it. */
export function fixtureEnvironment(scenario) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "relay-parity-")),
  );
  const fixture = thaw(snapshotName(scenario), root);
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TZ: "UTC",
    TMPDIR: tmp,
    RELAY_PARITY_NOW: PARITY_NOW,
    ...fixture,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(PASS) || name.length === PASS.length) continue;
    const own = name.slice(PASS.length);
    if (!value) delete env[own];
    else
      env[own] = value
        .replaceAll("{root}", root)
        .replaceAll("{home}", fixture.HOME)
        .replaceAll("{relay}", fixture.RELAY_HOME);
  }
  return { root, env };
}

/** Runs `command` and resolves with its exit code, passing on the signals this process gets. */
export function run(command, env) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env,
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(signal, () => child.kill(signal));
    child.once("error", (error) => {
      process.stderr.write(`fixture-run: ${error.message}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) =>
      resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 1) : 1)),
    );
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
  const [target, ...args] = process.argv.slice(2);
  if (!target) {
    process.stderr.write(
      "usage: node scripts/parity/fixture-run.mjs <relay> [args...]\n",
    );
    process.exit(2);
  }
  const { root, env } = fixtureEnvironment(process.env.RELAY_PARITY_SCENARIO);
  let code;
  try {
    code = await run(sandboxed([path.resolve(target), ...args]), env);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(code);
}
