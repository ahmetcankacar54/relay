// Relay's idle cost: starts the built Tauri app (`npm run build:ui` and
// `cargo build -p relay-app --release --features smoke` first: the feature makes it honor the
// test folders below; without RELAY_SMOKE_RESULT it runs as usual) with
// a fresh profile and a temp HOME, lets it settle, then samples every Relay process with `ps`:
// CPU from the CPU time each used over the window, memory as the sum of their RSS. That is the
// app and everything it started, plus on macOS the WebKit processes (WebContent, Networking,
// GPU) launchd started for it: they are not its children, so they are the new ones macOS holds
// the same process responsible for as Relay (responsibility_get_pid_responsible_for_pid, through
// osascript). It also counts the Keychain tool calls while idle, which must be zero.
//
//   node scripts/perf-idle.mjs                       window closed: started with --hidden
//   node scripts/perf-idle.mjs --window open         the main window open on the Overview
//   options: --app <binary> --settle <s> --duration <s> --interval <s> --budget-cpu <%>
//            --budget-rss-mb <MB> --keep
//
// Exits 1 when the average CPU or the peak RSS is over its budget, or a Keychain call happened
// while idle; 2 when it could not measure. macOS and Linux (with a display); Windows has no `ps`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "./smoke-boot.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The budget published in README.md (Resource use): idle in the menu bar, Relay 1.0 must stay
 * under 250 MB RSS and 1 % CPU. With the window open the panda's occasional motions cost more:
 * `--window open` runs want `--budget-cpu 3`.
 */
const DEFAULT_BUDGET = { cpu: 1, rssMb: 250 };

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value.`);
  return value;
}
function number(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a number.`);
  return value;
}
function fail(message) {
  console.error(message);
  process.exit(2);
}

const app = path.resolve(option("app", path.join(root, "target/release/relay-app")));
const windowMode = option("window", "closed");
if (!["open", "closed"].includes(windowMode)) fail("--window is open or closed.");
const settle = number("settle", 20);
const duration = number("duration", 60);
const interval = number("interval", 1);
const budget = {
  cpu: number("budget-cpu", DEFAULT_BUDGET.cpu),
  rssMb: number("budget-rss-mb", DEFAULT_BUDGET.rssMb),
};
const keep = process.argv.includes("--keep");

if (process.platform === "win32") fail("perf-idle samples processes with `ps`: macOS and Linux only.");
if (!existsSync(app))
  fail(
    `${app} is missing: run cargo build -p relay-app --release --features smoke first (or pass --app).`,
  );

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CPU seconds from `ps -o time`: [[dd-]hh:]mm:ss[.ss]. */
function cpuSeconds(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  return clock
    .split(":")
    .reverse()
    .reduce((sum, part, i) => sum + Number(part) * 60 ** i, Number(days) * 86_400);
}

/** Every process on the system as pid, parent, RSS in KiB, CPU seconds and executable. */
function processes() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], {
    encoding: "utf8",
  });
  return text
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, rss, time, comm]) => ({
      pid: +pid,
      ppid: +ppid,
      rssKb: +rss,
      cpu: cpuSeconds(time),
      comm,
    }));
}

/** macOS's WebKit helpers: XPC services launchd starts on a WKWebView's behalf. */
const isWebKit = (p) => process.platform === "darwin" && /com\.apple\.WebKit\./.test(p.comm);

/** The pid macOS holds responsible for each of `pids` (TCC's attribution), -1 when unknown. */
function responsiblePids(pids) {
  if (!pids.length) return [];
  const script =
    'ObjC.bindFunction("responsibility_get_pid_responsible_for_pid", ["int", ["int"]]);' +
    `${JSON.stringify(pids)}.map(function (p) { return $.responsibility_get_pid_responsible_for_pid(p); }).join(",")`;
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" })
      .trim()
      .split(",")
      .map(Number);
  } catch {
    return pids.map(() => -1);
  }
}

const ownWebKit = new Map();
/**
 * The process `pid` and everything below it, plus the WebKit helpers that were not there before
 * Relay started and share its responsible process (another app's helpers have their own).
 */
function relayProcesses(all, pid, webKitBefore) {
  const children = new Map();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out = [];
  const stack = all.filter((p) => p.pid === pid);
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  const seen = new Set(out.map((p) => p.pid));
  const candidates = all.filter((p) => isWebKit(p) && !webKitBefore.has(p.pid) && !seen.has(p.pid));
  const unknown = candidates.filter((p) => !ownWebKit.has(p.pid)).map((p) => p.pid);
  if (unknown.length) {
    const [relay, ...others] = responsiblePids([pid, ...unknown]);
    unknown.forEach((p, i) => ownWebKit.set(p, relay > 0 && others[i] === relay));
  }
  out.push(...candidates.filter((p) => ownWebKit.get(p.pid)));
  return out;
}

/** A process's role: "main", the WebKit service's name, or its executable's name. */
function kind(p, mainPid) {
  if (p.pid === mainPid) return "main";
  const name = path.basename(p.comm);
  return isWebKit(p) ? name.replace(/^com\.apple\.WebKit\./, "webkit ") : name;
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-perf-idle-"));
const securityLog = path.join(dir, "security.log");
const env = await isolatedEnv(dir);
const webKitBefore = new Set(processes().filter(isWebKit).map((p) => p.pid));
const output = await fs.open(path.join(dir, "relay.log"), "w");
const child = spawn(app, windowMode === "closed" ? ["--hidden"] : [], {
  env,
  stdio: ["ignore", output.fd, output.fd],
});
let exited = false;
child.once("exit", () => {
  exited = true;
});

async function stop() {
  if (!exited) {
    child.kill("SIGTERM");
    for (let i = 0; i < 100 && !exited; i++) await delay(100);
    if (!exited) child.kill("SIGKILL");
  }
  await output.close();
  if (!keep)
    await fs
      .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {});
  else console.error(`Kept ${dir}`);
}

/** Keychain tool calls logged at or after `since` (seconds). */
function keychainCalls(since = 0) {
  if (!existsSync(securityLog)) return 0;
  return readFileSync(securityLog, "utf8")
    .split("\n")
    .filter((line) => line && Number(line.split(" ")[0]) >= since).length;
}

try {
  console.error(`Relay started (window ${windowMode}); settling ${settle} s, then sampling ${duration} s…`);
  await delay(settle * 1000);
  if (exited) throw new Error(`Relay exited while it settled; see ${path.join(dir, "relay.log")}`);

  const start = Date.now();
  const first = new Map();
  const last = new Map();
  const totals = [];
  const startedWhileIdle = new Map();
  while (Date.now() - start < duration * 1000) {
    if (exited) throw new Error("Relay exited while it was being measured.");
    const mine = relayProcesses(processes(), child.pid, webKitBefore);
    for (const p of mine) {
      // A process started mid-window used all of its CPU time inside it.
      if (!first.has(p.pid)) {
        first.set(p.pid, totals.length ? { ...p, cpu: 0 } : p);
        if (totals.length) {
          const name = kind(p, child.pid);
          startedWhileIdle.set(name, (startedWhileIdle.get(name) ?? 0) + 1);
        }
      }
      last.set(p.pid, { ...p, kind: kind(p, child.pid) });
    }
    totals.push(mine.reduce((sum, p) => sum + p.rssKb, 0));
    await delay(interval * 1000);
  }
  const wall = (Date.now() - start) / 1000;

  const byKind = new Map();
  for (const [pid, p] of last) {
    const row = byKind.get(p.kind) ?? { kind: p.kind, count: 0, cpuSeconds: 0, rssMb: 0 };
    row.count++;
    row.cpuSeconds += Math.max(0, p.cpu - first.get(pid).cpu);
    row.rssMb += p.rssKb / 1024;
    byKind.set(p.kind, row);
  }
  const rows = [...byKind.values()].sort((a, b) => b.rssMb - a.rssMb);
  const cpuPercent = (rows.reduce((sum, r) => sum + r.cpuSeconds, 0) / wall) * 100;
  const rssMb = {
    mean: totals.reduce((a, b) => a + b, 0) / totals.length / 1024,
    max: Math.max(...totals) / 1024,
  };
  const keychain = {
    idle: keychainCalls(Math.floor(start / 1000)),
    sinceLaunch: keychainCalls(),
  };

  const fixed = (n, digits = 1) => n.toFixed(digits);
  console.log(
    `\nRelay idle, window ${windowMode}: ${fixed(wall, 0)} s sampled every ${interval} s after ${settle} s\n`,
  );
  console.log(`${"process".padEnd(28)}${"count".padStart(6)}${"CPU %".padStart(9)}${"RSS MB".padStart(10)}`);
  for (const r of rows)
    console.log(
      `${r.kind.padEnd(28)}${String(r.count).padStart(6)}${fixed((r.cpuSeconds / wall) * 100, 2).padStart(9)}${fixed(r.rssMb).padStart(10)}`,
    );
  console.log(
    `${"total".padEnd(28)}${String(last.size).padStart(6)}${fixed(cpuPercent, 2).padStart(9)}${fixed(rssMb.max).padStart(10)}  (RSS peak; mean ${fixed(rssMb.mean)})`,
  );
  const started = Object.fromEntries(startedWhileIdle);
  console.log(
    `\nProcesses started while idle: ${JSON.stringify(started)}; Keychain tool: ${keychain.idle} (since launch: ${keychain.sinceLaunch})`,
  );

  const result = {
    platform: `${process.platform}-${process.arch}`,
    window: windowMode,
    settleSeconds: settle,
    sampledSeconds: Math.round(wall),
    cpuPercent: +fixed(cpuPercent, 2),
    rssMb: { mean: +fixed(rssMb.mean), max: +fixed(rssMb.max) },
    processes: rows.map((r) => ({
      kind: r.kind,
      count: r.count,
      cpuPercent: +fixed((r.cpuSeconds / wall) * 100, 2),
      rssMb: +fixed(r.rssMb),
    })),
    processesStartedWhileIdle: started,
    keychainCalls: keychain,
    budget,
  };
  console.log(`\n${JSON.stringify(result)}`);

  const over = [
    cpuPercent > budget.cpu && `CPU ${fixed(cpuPercent, 2)} % is over the ${budget.cpu} % budget`,
    rssMb.max > budget.rssMb && `RSS ${fixed(rssMb.max)} MB is over the ${budget.rssMb} MB budget`,
    keychain.idle > 0 && `${keychain.idle} Keychain call(s) while idle`,
  ].filter(Boolean);
  if (over.length) {
    console.error(`\nOver budget: ${over.join("; ")}.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
} finally {
  await stop();
}
