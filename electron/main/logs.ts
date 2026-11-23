/** The short private logs main keeps for finding what broke, and the switches they follow. */
import { app } from "electron";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeLog, pageBooted } from "../core/desktop-launch";
import { appendDraftEvent, draftEventFilter } from "../core/draft-diagnostics";
import { draftRetypeEnabled } from "../core/draft-main";
import { continuation, fleet, service } from "./state";
/** Whether rescued drafts are re-typed into Claude; elsewhere than macOS, never: left for Copy. */
export const draftRetype = () => draftRetypeEnabled(service.store.state.settings);
/**
 * A feature that needs Accessibility is on: re-typing drafts, or continuing conversations at
 * the limit. Only then does Relay ask for it.
 */
export function accessibilityWanted() {
  return draftRetype() || fleet.enabled || continuation.snapshot().enabled;
}
/** Whether a draft event is worth logging: a run that does nothing says so once. */
const draftEventAllowed = draftEventFilter();
/**
 * One event of the draft restore, for `draft-events.json` in the user data folder, a short
 * private log that finds where a restore broke. Fields are ids, states, reasons and counts,
 * never a draft's text. Never throws: a log must not disturb a restore.
 */
export function logDraftEvent(event: string, fields?: Record<string, unknown>) {
  try {
    if (!draftEventAllowed(event, fields)) return;
    appendDraftEvent(
      path.join(app.getPath("userData"), "draft-events.json"),
      { ...fields, event },
      Date.now(),
    );
  } catch {
    // The log is an aid, never a part of a restore.
  }
}
/**
 * One event of the fleet ("Kota dolunca devam"), for `fleet-events.json` in the user data
 * folder: each change of its state with what it waited on, and how each conversation's
 * continuation ended. Fields are short ids, states, reasons, counts and process names, never
 * a conversation's text. Never throws.
 */
export function logFleetEvent(event: string, fields?: Record<string, unknown>) {
  try {
    appendDraftEvent(
      path.join(app.getPath("userData"), "fleet-events.json"),
      { ...fields, event },
      Date.now(),
    );
  } catch {
    // The log is an aid, never a part of a switch.
  }
}
/** Whether the running Claude's page has booted, from its own log; undefined when it cannot tell. */
export const claudePageBooted = () => {
  const log = claudeLog(os.homedir());
  return log ? pageBooted(log) : Promise.resolve(undefined);
};
/**
 * Claude's controls, as roles and labels, written once to `file` for a developer whose Claude
 * no longer matches what the helper looks for (Relay started with RELAY_UI_OUTLINE=1). It waits
 * up to two minutes for Claude to run; the helper's issue, if any, is written instead.
 */
export async function writeUiOutline(helper: string, file: string, running: () => Promise<boolean>) {
  for (let tries = 0; tries < 24 && !(await running().catch(() => false)); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  const ask = (command: string) =>
    new Promise<unknown>((resolve) => {
      const child = execFile(
        helper,
        [],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          try {
            resolve(error ? { ok: false, error: error.message } : JSON.parse(stdout));
          } catch {
            resolve({ ok: false, error: "unreadable" });
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ command }));
    });
  const result = { at: new Date().toISOString(), inspect: await ask("inspect"), outline: await ask("outline") };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(result, null, 1), { mode: 0o600 });
}
