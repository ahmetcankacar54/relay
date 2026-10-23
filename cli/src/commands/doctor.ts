import fs from "node:fs";
import { diagnoseCli } from "../../../electron/core/cli-diagnostics";
import { claudeExecutable } from "../../../electron/core/desktop-host-node";
import { VaultKeyError, readVaultKey } from "../../../electron/core/vault-key";
import { readsUsage } from "../../../shared/cli-version";
import { localizeError } from "../../../shared/error-text";
import type { Command } from "../command";
import { openContext } from "../context";
import { relayAppRunning } from "../describe";
import { olderThan } from "../guards";
import { EXIT } from "../io";
import { paint, printJson } from "../output";

type Status = "ok" | "warn" | "fail";
interface Check {
  check: string;
  status: Status;
  detail: string;
}

export const doctor: Command = async ({ io, deps, parsed, t }) => {
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const checks: Check[] = [];
  const add = (check: string, status: Status, detail: string) => checks.push({ check, status, detail });
  add("platform", ctx.deps.platform === "darwin" ? "ok" : "fail", `${ctx.deps.platform} ${process.arch}`);
  add(
    "node",
    olderThan(process.versions.node, "22.12.0") ? "fail" : "ok",
    t(`Node ${process.versions.node} (22.12 veya üstü gerekir)`, `Node ${process.versions.node} (22.12 or newer needed)`),
  );
  const app = claudeExecutable(ctx.paths.claudeApps);
  add("claude-app", app ? "ok" : "fail", app ?? t("Claude uygulaması bulunamadı", "The Claude app was not found"));
  const cli = await diagnoseCli(ctx.deps.claude(ctx.store.state.executable), ctx.paths.data);
  add(
    "claude-cli",
    !cli.executable || cli.error || !readsUsage(cli.version ?? "") ? "warn" : "ok",
    !cli.executable
      ? t("Claude Code CLI yok (yalnız limitler ve run için gerekir)", "No Claude Code CLI (only needed for limits and run)")
      : cli.error
        ? localizeError(cli.error, ctx.lang)
        : readsUsage(cli.version ?? "")
          ? `${cli.executable} · ${cli.version}`
          : t(`${cli.version}: limitler için 2.1.296 veya üstü gerekir`, `${cli.version}: limits need 2.1.296 or newer`),
  );
  let folder: Check["status"] = "ok";
  let folderDetail = ctx.paths.data;
  try {
    const stat = fs.lstatSync(ctx.paths.data);
    if (stat.isSymbolicLink()) [folder, folderDetail] = ["fail", t(`${ctx.paths.data} sembolik bağlantı`, `${ctx.paths.data} is a symbolic link`)];
    else if (stat.mode & 0o077) [folder, folderDetail] = ["warn", t(`${ctx.paths.data} yalnızca sana açık (0700) olmalı`, `${ctx.paths.data} should be private (0700)`)];
  } catch {
    [folder, folderDetail] = ["warn", t(`${ctx.paths.data} yok`, `${ctx.paths.data} does not exist`)];
  }
  add("data-folder", folder, folderDetail);
  const vault = ctx.vault;
  add(
    "vault",
    vault.kind === "legacy" || vault.kind === "newer" ? "fail" : "ok",
    vault.kind === "legacy"
      ? ctx.appVersion && !olderThan(ctx.appVersion, "0.12.0")
        ? t("eski biçim: Relay.app’i açıp Anahtarlık sorusuna izin ver", "old format: open Relay.app and allow its Keychain prompt")
        : t("eski biçim: Relay.app’i 0.12 veya üstüne güncelleyip bir kez aç", "old format: update Relay.app to 0.12 or later and open it once")
      : vault.kind === "newer"
        ? t("daha yeni bir Relay yazmış: relay’i güncelle", "written by a newer Relay: update relay")
        : vault.kind === "empty"
          ? t("boş (ilk hesapla oluşur)", "empty (made with the first account)")
          : t("hazır", "ready"),
  );
  if (vault.kind === "ready" || vault.kind === "newer") {
    try {
      await readVaultKey(ctx.deps.securityTool);
      add("key", "ok", t("Anahtarlık’ta \"Relay Vault Key\" okunabiliyor", "\"Relay Vault Key\" is readable in the Keychain"));
    } catch (error) {
      add(
        "key",
        "fail",
        error instanceof VaultKeyError && error.reason !== "locked"
          ? `${localizeError(error.message, ctx.lang)} ${t("Baştan başlamak için: relay reset-vault", "To start over: relay reset-vault")}`
          : error instanceof VaultKeyError
            ? localizeError(error.message, ctx.lang)
            : String(error),
      );
    }
  } else add("key", "ok", t("ilk hesapla oluşturulur", "made with the first account"));
  let appRunning = false;
  try {
    appRunning = relayAppRunning(await ctx.deps.processList());
  } catch {
    // Unknown.
  }
  add(
    "relay-app",
    ctx.appVersion && olderThan(ctx.appVersion, "0.12.0") ? "fail" : "ok",
    ctx.appVersion
      ? `${ctx.appVersion}${appRunning ? t(", açık", ", running") : t(", kapalı", ", not running")}${olderThan(ctx.appVersion, "0.12.0") ? t(" — 0.12 veya üstüne güncelle", " — update to 0.12 or later") : ""}`
      : t("kurulu değil (gerekmez)", "not installed (not needed)"),
  );
  const holder = ctx.lock.holder();
  add("lock", holder ? "warn" : "ok", holder ? `${holder.by} · ${holder.kind} · ${holder.startedAt}` : t("serbest", "free"));
  const state = await ctx.desktop.snapshot();
  add(
    "desktop",
    state.pendingProfileId || state.recoveryRequired ? "warn" : "ok",
    state.recoveryRequired
      ? t("yarıda kalan geçiş: relay recover", "interrupted switch: relay recover")
      : state.pendingProfileId
        ? t("yarım giriş: relay add --resume / --cancel", "pending sign-in: relay add --resume / --cancel")
        : t("geçişe hazır", "ready to switch"),
  );
  add(
    "gui-session",
    ctx.deps.guiSession() ? "ok" : "warn",
    ctx.deps.guiSession()
      ? t("macOS masaüstü oturumu", "macOS desktop session")
      : t("masaüstü oturumu yok (SSH?): Claude buradan kapatılıp açılamaz", "no desktop session (SSH?): Claude cannot be quit or opened from here"),
  );
  add(
    "automation",
    "ok",
    t(
      "macOS, terminalin Claude’u ilk kapatışında Otomasyon izni sorar. Reddedildiyse: Sistem Ayarları → Gizlilik ve Güvenlik → Otomasyon → terminal uygulaması → Claude.",
      "macOS asks for the Automation permission the first time a terminal quits Claude. If it was refused: System Settings → Privacy & Security → Automation → your terminal app → Claude.",
    ),
  );
  const failed = checks.some((c) => c.status === "fail");
  if (ctx.json) printJson(io, checks);
  else
    for (const c of checks) {
      const mark = c.status === "ok" ? paint(ctx.color, "green", "✓") : c.status === "warn" ? paint(ctx.color, "yellow", "!") : paint(ctx.color, "red", "✗");
      io.stdout(`${mark} ${c.check.padEnd(12)} ${c.detail}`);
    }
  return failed ? EXIT.environment : EXIT.ok;
};
