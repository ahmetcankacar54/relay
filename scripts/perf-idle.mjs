// Relay's idle cost: starts the built app (dist-electron, `npm run build` first) with a fresh
// profile and a temp HOME through scripts/perf-idle.cjs, lets it settle, then samples every
// Relay process (main, renderers, GPU and utility helpers, anything they started) with `ps`:
// CPU from the CPU time each used over the window, memory as the sum of their RSS. It also counts
// the programs Relay started meanwhile, and the Keychain tool among them, which must be zero.
//
//   node scripts/perf-idle.mjs                       window closed to the menu bar (Relay's idle)
//   node scripts/perf-idle.mjs --window open         the main window open on the Overview
//   options: --settle <s> --duration <s> --interval <s> --budget-cpu <%> --budget-rss-mb <MB> --keep
//
// Exits 1 when the average CPU or the peak RSS is over its budget, or a Keychain call happened
// while idle; 2 when it could not measure. macOS and Linux (with a display); Windows has no `ps`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, "../dist-electron/main.cjs");

/**
 * The budget published in README.md (Resource use): idle in the menu bar on an Apple silicon Mac
 * Relay measured 0.1 % CPU and a 435 MB RSS peak (2026-11-23); the RSS budget leaves ~25 % margin.
 * With the window open and focused it measured 2.3 % CPU (the panda's occasional motions), so the
 * CPU budget holds for the menu bar only; `--window open` runs want `--budget-cpu 3`.
 */
const DEFAULT_BUDGET = { cpu: 1, rssMb: 550 };

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`--${name} needs a value.`);
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

const windowMode = option("window", "closed");
if (!["open", "closed"].includes(windowMode))
  fail("--window is open or closed.");
// A window closed to the menu bar keeps its renderer a minute before freeing it: settle past that.
const settle = number("settle", windowMode === "closed" ? 75 : 20);
const duration = number("duration", 60);
const interval = number("interval", 1);
const budget = {
  cpu: number("budget-cpu", DEFAULT_BUDGET.cpu),
  rssMb: number("budget-rss-mb", DEFAULT_BUDGET.rssMb),
};
const keep = process.argv.includes("--keep");

if (process.platform === "win32")
  fail("perf-idle samples processes with `ps`: macOS and Linux only.");
if (!existsSync(main)) fail(`${main} is missing: run npm run build first.`);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-perf-idle-"));
const home = path.join(root, "home");
await fs.mkdir(home);
const env = {
  ...process.env,
  RELAY_PERF_ROOT: root,
  RELAY_PERF_WINDOW: windowMode,
  // Relay finds ~/.claude, the Claude app's data and its own CLI folders under HOME: a temp one
  // shows it a machine with no Claude install and no accounts, so nothing real is read or changed.
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
};
// Left over from a parent, it would make Electron a plain Node with no `app`.
delete env.ELECTRON_RUN_AS_NODE;
const output = await fs.open(path.join(root, "relay.log"), "w");
const child = spawn(electron, [path.join(here, "perf-idle.cjs")], {
  env,
  stdio: ["ignore", output.fd, output.fd],
});
let exited = false;
child.once("exit", () => {
  exited = true;
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CPU seconds from `ps -o time`: [[dd-]hh:]mm:ss[.ss]. */
function cpuSeconds(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  return clock
    .split(":")
    .reverse()
    .reduce(
      (sum, part, i) => sum + Number(part) * 60 ** i,
      Number(days) * 86_400,
    );
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

/** The process `pid` and everything below it. */
function tree(all, pid) {
  const children = new Map();
  for (const p of all)
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out = [];
  const stack = all.filter((p) => p.pid === pid);
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

const kinds = new Map();
/** A process's role: Electron's `--type` (renderer, gpu-process, utility), "main", or its name. */
function kind(p) {
  if (p.pid === child.pid) return "main";
  if (!kinds.has(p.pid)) {
    let args = "";
    try {
      args = execFileSync("ps", ["-o", "args=", "-p", String(p.pid)], {
        encoding: "utf8",
      });
    } catch {}
    const type = /--type=(\S+)/.exec(args)?.[1];
    const subtype = /--utility-sub-type=(\S+)/
      .exec(args)?.[1]
      ?.split(".")
      .pop();
    kinds.set(
      p.pid,
      type ? (subtype ? `${type} (${subtype})` : type) : path.basename(p.comm),
    );
  }
  return kinds.get(p.pid);
}

async function stop() {
  if (!exited) {
    child.kill("SIGTERM");
    for (let i = 0; i < 100 && !exited; i++) await delay(100);
    if (!exited) child.kill("SIGKILL");
  }
  await output.close();
  if (!keep)
    await fs
      .rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
      .catch(() => {});
  else console.error(`Kept ${root}`);
}

try {
  const ready = path.join(root, "ready.json");
  for (let i = 0; i < 1200 && !existsSync(ready); i++) {
    if (exited)
      throw new Error(
        `Relay exited before it was ready; see ${path.join(root, "relay.log")}`,
      );
    await delay(100);
  }
  if (!existsSync(ready))
    throw new Error("Relay did not become ready within 120 s.");
  console.error(
    `Relay is up (window ${windowMode}); settling ${settle} s, then sampling ${duration} s…`,
  );
  await delay(settle * 1000);

  const start = Date.now();
  const first = new Map();
  const last = new Map();
  const totals = [];
  while (Date.now() - start < duration * 1000) {
    if (exited) throw new Error("Relay exited while it was being measured.");
    const mine = tree(processes(), child.pid);
    for (const p of mine) {
      // A process started mid-window used all of its CPU time inside it.
      if (!first.has(p.pid))
        first.set(p.pid, totals.length ? { ...p, cpu: 0 } : p);
      last.set(p.pid, { ...p, kind: kind(p) });
    }
    totals.push(mine.reduce((sum, p) => sum + p.rssKb, 0));
    await delay(interval * 1000);
  }
  const wall = (Date.now() - start) / 1000;
  const end = Date.now();

  const byKind = new Map();
  for (const [pid, p] of last) {
    const row = byKind.get(p.kind) ?? {
      kind: p.kind,
      count: 0,
      cpuSeconds: 0,
      rssMb: 0,
    };
    row.count++;
    row.cpuSeconds += Math.max(0, p.cpu - first.get(pid).cpu);
    row.rssMb += p.rssKb / 1024;
    byKind.set(p.kind, row);
  }
  const rows = [...byKind.values()].sort((a, b) => b.rssMb - a.rssMb);
  const cpuPercent =
    (rows.reduce((sum, r) => sum + r.cpuSeconds, 0) / wall) * 100;
  const rssMb = {
    mean: totals.reduce((a, b) => a + b, 0) / totals.length / 1024,
    max: Math.max(...totals) / 1024,
  };

  const started = readFileSync(path.join(root, "spawns.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const during = started.filter((s) => s.at >= start && s.at <= end);
  const count = (list) =>
    Object.fromEntries([
      ...list.reduce(
        (m, s) => m.set(s.name, (m.get(s.name) ?? 0) + 1),
        new Map(),
      ),
    ]);
  const keychain = {
    idle: during.filter((s) => s.name === "security").length,
    sinceLaunch: started.filter((s) => s.name === "security").length,
  };
  // How much of the sample the open window had focus: out of focus it holds the panda still and costs less.
  const focusLog = path.join(root, "focus.jsonl");
  let focusedShare;
  if (windowMode === "open" && existsSync(focusLog)) {
    const changes = readFileSync(focusLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    let focused = changes.filter((c) => c.at <= start).at(-1)?.focused ?? false;
    let since = start;
    let total = 0;
    for (const change of changes.filter((c) => c.at > start && c.at < end)) {
      if (focused) total += change.at - since;
      focused = change.focused;
      since = change.at;
    }
    if (focused) total += end - since;
    focusedShare = Math.round((total / (end - start)) * 100);
  }

  const fixed = (n, digits = 1) => n.toFixed(digits);
  console.log(
    `\nRelay idle, window ${windowMode}: ${fixed(wall, 0)} s sampled every ${interval} s after ${settle} s\n`,
  );
  console.log(
    `${"process".padEnd(28)}${"count".padStart(6)}${"CPU %".padStart(9)}${"RSS MB".padStart(10)}`,
  );
  for (const r of rows)
    console.log(
      `${r.kind.padEnd(28)}${String(r.count).padStart(6)}${fixed((r.cpuSeconds / wall) * 100, 2).padStart(9)}${fixed(r.rssMb).padStart(10)}`,
    );
  console.log(
    `${"total".padEnd(28)}${String(last.size).padStart(6)}${fixed(cpuPercent, 2).padStart(9)}${fixed(rssMb.max).padStart(10)}  (RSS peak; mean ${fixed(rssMb.mean)})`,
  );
  console.log(
    `\nPrograms started while idle: ${JSON.stringify(count(during))}; Keychain tool: ${keychain.idle} (since launch: ${keychain.sinceLaunch})`,
  );
  if (focusedShare !== undefined)
    console.log(`The window had focus for ${focusedShare} % of the sample.`);

  const result = {
    platform: `${process.platform}-${process.arch}`,
    window: windowMode,
    ...(focusedShare !== undefined ? { focusedPercent: focusedShare } : {}),
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
    programsStartedWhileIdle: count(during),
    keychainCalls: keychain,
    budget,
  };
  console.log(`\n${JSON.stringify(result)}`);

  const over = [
    cpuPercent > budget.cpu &&
      `CPU ${fixed(cpuPercent, 2)} % is over the ${budget.cpu} % budget`,
    rssMb.max > budget.rssMb &&
      `RSS ${fixed(rssMb.max)} MB is over the ${budget.rssMb} MB budget`,
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
