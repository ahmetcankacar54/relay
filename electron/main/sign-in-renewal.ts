import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import { desktopCliMismatch } from "../../shared/account-state";
import type { Account } from "../../shared/types";
import { SignInBusyError } from "../core/auth";
import type { PlainCookie } from "../core/desktop-usage";
import { FRESH_SIGN_IN_MS, type RenewalResult } from "../core/sign-in-renewal";
import { approveQuietly } from "../quiet-sign-in";
import { desktopLock } from "./desktop-lock";
import { desktopUsageReader } from "./desktop-usage";
import { desktop, service } from "./state";
/**
 * Renews an account's Claude Code sign-in with no one at the screen: the CLI's own sign-in, its
 * page approved in a hidden window holding the account's claude.ai session from the Claude app.
 */
export async function renewSignInQuietly(account: Account): Promise<RenewalResult> {
  if (process.platform !== "darwin" || !desktopUsageReader)
    return { result: "unavailable", detail: "no Claude app sign-in reader" };
  if (desktopLock.active || desktop.isBusy) return { result: "busy", detail: "Claude app busy" };
  // Renewing from the Claude app's session would give this profile the app's identity.
  if (desktopCliMismatch(account))
    return { result: "unavailable", detail: "Claude Code sign-in is for another account or workspace than the Claude app's" };
  let cookies: PlainCookie[] | undefined;
  try {
    cookies = await desktopUsageReader.cookies(account);
  } catch (error) {
    const issue = (error as { issue?: string })?.issue;
    return { result: "unavailable", detail: `claude.ai session not readable${issue ? `: ${issue}` : ""}` };
  }
  if (!cookies) return { result: "unavailable", detail: "no claude.ai session" };
  // claude.ai approves a new Claude Code sign-in only from a recent claude.ai sign-in
  // (`session_stale_relogin` otherwise): an older one is not tried, and the next pass looks again.
  const created = cookies.find((c) => c.name === "sessionKey")?.created;
  if (created !== undefined && Date.now() - created * 1000 > FRESH_SIGN_IN_MS)
    return {
      result: "waiting",
      detail: `claude.ai sign-in is ${Math.round((Date.now() - created * 1000) / 3_600_000)} h old`,
    };
  let quiet: Promise<Awaited<ReturnType<typeof approveQuietly>>> | undefined;
  let flow;
  try {
    flow = await service.loginInBackground(account.id, {
      present: (url) => {
        quiet ??= approveQuietly(url, cookies!);
      },
    });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 160);
    return error instanceof SignInBusyError ? { result: "busy", detail } : { result: "unavailable", detail };
  }
  const ended = service.auth.settled(account.id, flow.id);
  if (!ended) return { result: "failed", detail: "sign-in attempt lost" };
  // The page must be approved within the window's own time; otherwise the attempt is stopped.
  const watch = (async () => {
    for (let i = 0; i < 60 && !quiet; i++) await new Promise((r) => setTimeout(r, 500));
    const outcome = quiet ? await quiet : { result: "failed" as const, detail: "no sign-in page" };
    if (outcome.result !== "approved")
      await service.auth.cancel(account.id, flow.id).catch(() => {});
    // Approved: the CLI saves the sign-in within seconds; one that does not is stopped.
    else
      setTimeout(() => void service.auth.cancel(account.id, flow.id).catch(() => {}), 2 * 60_000).unref();
    return outcome;
  })();
  const [end, outcome] = await Promise.all([ended, watch]);
  // Where the hidden window went and what it last saw (hosts, paths, button labels only).
  void (async () => {
    const file = path.join(app.getPath("userData"), "diagnostics", "quiet-sign-in.json");
    let entries: unknown[] = [];
    try {
      entries = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {}
    entries = [
      ...(Array.isArray(entries) ? entries : []).slice(-9),
      {
        at: new Date().toISOString(),
        accountId: account.id.slice(0, 8),
        flow: end.status,
        window: outcome.result,
        // Names only: which of the Claude app's cookies the window carried.
        cookies: cookies!.map((c) => c.name).sort(),
        ...("detail" in outcome ? { detail: outcome.detail } : {}),
        ...("trail" in outcome
          ? { trail: outcome.trail, last: outcome.last, refused: outcome.refused, requests: outcome.requests }
          : {}),
      },
    ];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(entries, null, 2), { mode: 0o600 });
  })().catch(() => {});
  if (end.status === "connected") return { result: "connected" };
  const detail =
    outcome.result === "approved" ? (end.error ?? end.status) : `${outcome.result}: ${"detail" in outcome ? outcome.detail : ""}`;
  return { result: "failed", detail: detail.slice(0, 200) };
}
