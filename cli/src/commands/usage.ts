import { diagnoseCli } from "../../../electron/core/cli-diagnostics";
import { profileLockHolders } from "../../../electron/core/profile-lock";
import { UsageManager } from "../../../electron/core/usage";
import { UsageError, readCredential } from "../../../electron/core/usage-credentials";
import { UsageCredentialRefresher, anthropicUnreachable } from "../../../electron/core/usage-refresh";
import { readCodexCredential } from "../../../electron/core/provider-credentials";
import { readCodexUsage } from "../../../electron/core/provider-usage";
import { acquireProfileLock } from "../../../electron/core/profile-lock";
import { readsUsage } from "../../../shared/cli-version";
import { formatUsed, percentUsed } from "../../../shared/percent";
import type { Account, AccountUsage, UsageIssue, UsageWindow } from "../../../shared/types";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { openContext, type CliContext } from "../context";
import { EXIT } from "../io";
import { printJson, table } from "../output";
import { untilText } from "../time";

/** Where a Codex or Antigravity account is signed in again: the app; `relay connect` is Claude's. */
const inApp = (t: CliContext["t"]) => t("Relay uygulamasından yeniden giriş yap", "sign in again in the Relay app");

function issueText(ctx: CliContext, account: Account, issue: UsageIssue | undefined): string {
  const { t } = ctx;
  const provider = account.provider ?? "claude";
  if (provider === "antigravity" && (issue === "unsupported" || issue === undefined))
    return t(
      "Antigravity limitleri yalnızca Relay uygulamasında okunur",
      "Antigravity limits are read in the Relay app only",
    );
  if (provider === "codex" && issue === "unsupported")
    return t("Codex bu giriş için plan limiti bildirmiyor (API anahtarı)", "Codex reports no plan limits for this sign-in (an API key)");
  if (provider !== "claude" && ["credentials-missing", "connect-cli", "expired", "renewal-required", "scope", "identity-mismatch"].includes(issue ?? ""))
    return t(`giriş kullanılamıyor: ${inApp(t)}`, `the sign-in cannot be used: ${inApp(t)}`);
  const reconnect = `relay connect "${account.name}"`;
  switch (issue) {
    case "unavailable":
      return profileLockHolders(ctx.paths.locks, account.id, ctx.io.pid).length
        ? t("başka bir süreç yeniliyor", "another process is renewing it")
        : t("Claude Code CLI 2.1.296 veya üstü gerekiyor", "needs the Claude Code CLI 2.1.296 or newer");
    case "credentials-missing":
    case "connect-cli":
      return t(`limit okuma girişi yok: ${reconnect}`, `no usage sign-in: ${reconnect}`);
    case "expired":
    case "renewal-required":
    case "scope":
      return t(`bağlantı yenilenmeli: ${reconnect}`, `the connection needs renewing: ${reconnect}`);
    case "identity-mismatch":
      return t(`başka bir hesapla bağlı: ${reconnect}`, `connected to another account: ${reconnect}`);
    case "keychain-locked":
      return t("Anahtarlık kilitli; Mac’in kilidini açıp yeniden dene", "the Keychain is locked; unlock the Mac and try again");
    case "rate-limited":
      return t("çok sık istek gönderildi; biraz sonra yeniden dene", "too many requests; try again shortly");
    default:
      return t("okunamadı", "could not be read");
  }
}

const window = (w: UsageWindow | undefined) =>
  w ? { usedPercent: percentUsed(w.usedPercent), ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) } : undefined;

export const usage: Command = async ({ io, deps, parsed, t, lang }) => {
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const all = ctx.store.state.accounts;
  const accounts = parsed.positionals[0] ? [resolveAccount(all, parsed.positionals[0], t)] : all;
  const explicit = ctx.deps.claude(ctx.store.state.executable);
  const read = (profile: string, allowPrompt: boolean) => readCredential(profile, allowPrompt, ctx.deps.securityTool);
  const refresher = new UsageCredentialRefresher({
    executable: async () => {
      const d = await diagnoseCli(explicit, ctx.paths.data);
      if (!d.executable || d.error || !readsUsage(d.version ?? "")) throw new UsageError("unavailable");
      return d.executable;
    },
    read,
    request: ctx.deps.request,
    profileLock: (id) => acquireProfileLock(ctx.paths.locks, id, "exclusive"),
    unreachable: () => anthropicUnreachable(),
  });
  const manager = new UsageManager(
    ctx.store,
    read,
    ctx.deps.request,
    io.now,
    () => {},
    (account, credential, force, interaction) =>
      refresher.refresh(account, ctx.store.profile(account.id), credential, force, interaction),
    (account) => refresher.hasPending(ctx.store.profile(account.id)),
    undefined,
    undefined,
    // Codex as the app reads it, through its ChatGPT sign-in. The plan it reports is left for
    // the app to save. Antigravity needs the app's CLIProxyAPI sidecar, which relay never starts.
    async (account) => {
      if (account.provider === "codex") {
        const { plan: _plan, ...limits } = await readCodexUsage(await readCodexCredential(ctx.store.profile(account.id)));
        return limits;
      }
      throw new UsageError("unsupported", undefined, `${account.provider}: read in the app`);
    },
  );
  const results: { account: Account; usage?: AccountUsage }[] = [];
  for (const account of accounts)
    results.push({
      account,
      usage: account.auth?.loggedIn ? await manager.refresh(account.id, io.isTTY) : undefined,
    });
  if (ctx.json) {
    printJson(
      io,
      results.map(({ account, usage }) =>
        !usage
          ? { id: account.id, name: account.name, status: "not-connected" }
          : usage.status === "ready"
            ? {
                id: account.id,
                name: account.name,
                status: "ready",
                ...(usage.fiveHour ? { fiveHour: window(usage.fiveHour) } : {}),
                sevenDay: window(usage.sevenDay) ?? "not-reported",
                ...(usage.modelWindows?.length
                  ? { models: usage.modelWindows.map((w) => ({ key: w.key, label: w.label, ...window(w) })) }
                  : {}),
              }
            : { id: account.id, name: account.name, status: "error", ...(usage.issue ? { issue: usage.issue } : {}) },
      ),
    );
    return EXIT.ok;
  }
  if (!accounts.length) {
    io.stdout(t("Henüz kayıtlı hesap yok.", "No accounts are saved yet."));
    return EXIT.ok;
  }
  const cell = (w: UsageWindow | undefined, none: string) =>
    !w
      ? none
      : `${formatUsed(w.usedPercent, lang)}${
          w.resetsAt ? ` · ${t(`${untilText(w.resetsAt, io.now(), t)} sonra yenilenir`, `resets in ${untilText(w.resetsAt, io.now(), t)}`)}` : ""
        }`;
  const rows = results.map(({ account, usage }) => {
    if (!usage)
      return [
        account.name,
        (account.provider ?? "claude") === "claude"
          ? t(`limit okuma girişi yok: relay connect "${account.name}"`, `no usage sign-in: relay connect "${account.name}"`)
          : t(`giriş yok: ${inApp(t)}`, `not signed in: ${inApp(t)}`),
        "",
      ];
    if (usage.status !== "ready") return [account.name, issueText(ctx, account, usage.issue), "", ""];
    return [
      account.name,
      cell(usage.fiveHour, "—"),
      cell(usage.sevenDay, t("limit bildirilmedi", "no limit reported")),
      // A model's own weekly limit (Fable, Opus): spent, it stops that model on the account.
      (usage.modelWindows ?? []).map((w) => `${w.label} ${formatUsed(w.usedPercent, lang)}`).join(", ") || "—",
    ];
  });
  io.stdout(table([t("Hesap", "Account"), t("5 saat", "5 hours"), t("Haftalık", "Weekly"), t("Model limitleri", "Model limits")], rows));
  return EXIT.ok;
};
