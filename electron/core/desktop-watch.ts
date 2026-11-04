import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  isLocalSessionId,
  type DesktopAutomationIssue,
  type DesktopTarget,
} from "./desktop-continuation-host";

/**
 * Where the user is in Claude, as the helper's long-lived `watch` reports it: read cheaply in
 * its own process, so Relay need not run a whole `inspect` to learn it while drafts wait.
 */
export interface DesktopWatchState {
  pid: number;
  /**
   * The conversation on screen as its `local_` id, or `new-session` for Code's new-session
   * screen; undefined while it is unknown or Claude is not in front.
   */
  place?: string;
  frontmost: boolean;
  /** No key has been pressed for the watch's quiet time. */
  quiet: boolean;
  /** No input of any kind for the watch's idle time. */
  idle: boolean;
}

/** Why a watch ended: Claude quit, its 10 minutes ran out, the helper's issue, or it exited. */
export type DesktopWatchEnd =
  "gone" | "expired" | "exited" | DesktopAutomationIssue;

export interface DesktopWatchHandlers {
  state(state: DesktopWatchState): void;
  /** Called once, when the watch ends for any reason but `stop`. */
  end(reason: DesktopWatchEnd): void;
}

export interface DesktopWatch {
  /** Ends the watch; `end` is not called for it. */
  stop(): void;
}

export type DesktopWatcher = (handlers: DesktopWatchHandlers) => DesktopWatch;

const ISSUES = new Set<DesktopAutomationIssue>([
  "accessibility-permission-required",
  "claude-not-running",
  "desktop-ui-unsupported",
]);
/** A line longer than this is not one the helper writes. */
const MAX_LINE = 4096;

/** One line of the helper's watch: a state, how it ended, or undefined when it is neither. */
export function parseWatchLine(
  line: string,
): { state: DesktopWatchState } | { end: DesktopWatchEnd } | undefined {
  if (line.length > MAX_LINE) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.gone === true) return { end: "gone" };
  if (v.expired === true) return { end: "expired" };
  if (typeof v.issue === "string")
    return {
      end: ISSUES.has(v.issue as DesktopAutomationIssue)
        ? (v.issue as DesktopAutomationIssue)
        : "desktop-ui-unsupported",
    };
  const place = v.place;
  if (
    !Number.isSafeInteger(v.pid) ||
    (v.pid as number) <= 0 ||
    typeof v.frontmost !== "boolean" ||
    typeof v.quiet !== "boolean" ||
    typeof v.idle !== "boolean" ||
    !(
      place === null ||
      place === "new-session" ||
      (typeof place === "string" && isLocalSessionId(place))
    )
  )
    return undefined;
  return {
    state: {
      pid: v.pid as number,
      ...(typeof place === "string" ? { place } : {}),
      frontmost: v.frontmost,
      quiet: v.quiet,
      idle: v.idle,
    },
  };
}

/**
 * Where a file Relay ships inside `app.asar` really is. Electron reads `app.asar` paths for
 * `execFile`, but not for `spawn`: there `app.asar` is a file, and a path through it fails at
 * once with ENOTDIR. The build unpacks the helper next to it, into `app.asar.unpacked`. A path
 * outside an archive, or already unpacked, is returned as it is.
 */
export function unpackedPath(file: string): string {
  return file.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
}

/**
 * The helper's `watch <quietMs> <idleMs> [pid]`, as a watcher. Its stdin stays open while it runs:
 * Relay ending closes it, and the helper ends with it. Lines that do not parse are skipped. With
 * `target`, the helper watches the Claude it names (the main one while windows run beside it).
 */
export function nativeDesktopWatch(
  helper: string,
  quietMs: number,
  idleMs: number,
  target?: DesktopTarget,
): DesktopWatcher {
  return (handlers) => {
    let ended = false;
    let stopChild: (() => void) | undefined;
    const finish = (reason: DesktopWatchEnd) => {
      if (ended) return;
      ended = true;
      try {
        handlers.end(reason);
      } catch {
        // A listener that throws changes nothing about the watch.
      }
    };
    const start = (pid?: number) => {
      const args = ["watch", String(quietMs), String(idleMs), ...(pid === undefined ? [] : [String(pid)])];
      const child = spawn(unpackedPath(helper), args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      child.stdin?.on("error", () => {});
      child.once("error", () => finish("desktop-ui-unsupported"));
      // After its output: a last line, such as `gone`, says why first.
      child.once("close", () => finish("exited"));
      const lines = readline.createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        if (ended) return;
        const parsed = parseWatchLine(line);
        if (!parsed) return;
        if ("end" in parsed) return finish(parsed.end);
        try {
          handlers.state(parsed.state);
        } catch {
          // As above.
        }
      });
      stopChild = () => {
        lines.close();
        child.stdin?.end();
        child.kill();
      };
    };
    if (!target) start();
    else
      target().then(
        (pid) => {
          if (ended) return;
          if (pid === null) finish("claude-not-running");
          else start(pid);
        },
        () => finish("desktop-ui-unsupported"),
      );
    return {
      stop() {
        ended = true;
        stopChild?.();
      },
    };
  };
}
