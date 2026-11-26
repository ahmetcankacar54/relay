#!/usr/bin/env node
// Runs one relay command against a fresh parity fixture (scripts/parity/fixture-home.ts), so every
// recorded case starts from the same world however the cases before it changed theirs:
//   node scripts/parity/fixture-run.mjs <relay.js or binary> [args...]
// The fixture is built in a new temp folder, the command runs in the sandbox (sandbox.mjs) with
// stdin, stdout and stderr passed through, and the folder is deleted after; the exit code is the
// command's. The command gets a clean environment: the fixture's, TZ=UTC, a system PATH, the
// parity clock (RELAY_PARITY_NOW, clock.mjs), and
// - RELAY_PARITY_SCENARIO: the fixture's variations (fixture-home.ts SCENARIOS);
// - RELAY_PARITY_ENV_<NAME>=<value>: <NAME> set to <value> ("" unsets it), where `{root}`,
//   `{home}` and `{relay}` are the fixture's folder, home folder and Relay data folder.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { sandboxed } from "./sandbox.mjs";

/** The instant every recorded run starts at, unless RELAY_PARITY_NOW names another. */
export const PARITY_NOW = "2026-11-26T09:41:15.000Z";
const CLOCK = new URL("./clock.mjs", import.meta.url).href;
const PASS = "RELAY_PARITY_ENV_";

/** The command line that runs `target`: a script through this Node with the parity clock, anything else as it is. */
export function targetCommand(target) {
  const resolved = path.resolve(target);
  return /\.[cm]?js$/.test(resolved)
    ? [process.execPath, "--import", CLOCK, resolved]
    : [resolved];
}

/**
 * A fresh fixture under the temp folder and the clean environment that points relay at it. This
 * process takes the parity clock first; the fixture's times are relative to the parity instant
 * itself, the one the command's clock starts at, so the command never sees them shifted by how
 * long the fixture took to build.
 */
export async function fixtureEnvironment(scenario, options = {}) {
  process.env.RELAY_PARITY_NOW ??= PARITY_NOW;
  await import(CLOCK);
  register();
  const { buildFixtureHome, parseScenarios } =
    await import("./fixture-home.ts");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "relay-parity-")),
  );
  const fixture = await buildFixtureHome(root, {
    ...options,
    scenarios: parseScenarios(scenario),
    now: Date.parse(process.env.RELAY_PARITY_NOW),
  });
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TZ: "UTC",
    TMPDIR: tmp,
    RELAY_PARITY_NOW: process.env.RELAY_PARITY_NOW,
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
  const { root, env } = await fixtureEnvironment(
    process.env.RELAY_PARITY_SCENARIO,
  );
  let code;
  try {
    code = await run(sandboxed([...targetCommand(target), ...args]), env);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(code);
}
