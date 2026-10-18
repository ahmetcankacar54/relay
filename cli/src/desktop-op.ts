import { readObject } from "../../electron/core/desktop-files";
import { anyExclusiveProfileLock } from "../../electron/core/profile-lock";
import { redact } from "../../electron/core/redact";
import type { CliContext } from "./context";
import { guiSessionGuard } from "./guards";
import { CliError, EXIT } from "./io";
import { shielded } from "./shield";

/** What the user is told before any command that quits Claude Desktop. */
export function quitLines(ctx: CliContext): string[] {
  const { t } = ctx;
  return [
    t("Claude Desktop'taki Code oturumları duracak.", "Claude Desktop's running Code sessions will stop."),
    t(
      "Gönderilmemiş taslaklar CLI ile taşınmaz; Claude yeniden açılınca silinebilir.",
      "Unsent drafts are not carried by the CLI; Claude may clear them when it reopens.",
    ),
  ];
}

/**
 * Refuses a Claude-quitting command before it asks anything: a pending sign-in, an
 * interrupted switch, an account connection being renewed, or no desktop session.
 */
export async function assertCanQuitClaude(ctx: CliContext, options: { allowPending?: boolean } = {}) {
  const { t } = ctx;
  const state = await ctx.desktop.snapshot();
  if (state.pendingProfileId && !options.allowPending)
    throw new CliError(
      t(
        "Yarım kalan bir giriş var: relay add --resume ile bitirin ya da relay add --cancel ile iptal edin.",
        "A sign-in is pending: finish it with relay add --resume or cancel it with relay add --cancel.",
      ),
      EXIT.busy,
    );
  if (state.recoveryRequired)
    throw new CliError(
      t("Yarıda kalan bir geçiş var: önce relay recover çalıştırın.", "A switch was interrupted: run relay recover first."),
      EXIT.busy,
    );
  if (anyExclusiveProfileLock(ctx.paths.locks))
    throw new CliError(
      t(
        "Bir hesabın bağlantısı şu an yenileniyor ya da giriş yapılıyor. Bitince yeniden deneyin.",
        "An account's connection is being renewed or signed in right now. Try again when it ends.",
      ),
      EXIT.busy,
    );
  guiSessionGuard(ctx.deps, t);
  return state;
}

const AUTOMATION = /-1743|Not authorized to send Apple events|not allowed to send Apple events/i;

/**
 * Runs a Desktop operation that quits Claude, held against signals. A failure says what to do
 * next: grant the Automation permission, or run `relay recover` when a journal was left.
 */
export async function runDesktopOperation<T>(ctx: CliContext, fn: () => Promise<T>): Promise<T> {
  const { t } = ctx;
  try {
    return await shielded(ctx.io, t, fn);
  } catch (error) {
    const full = error instanceof Error ? error.message : String(error);
    if (AUTOMATION.test(full))
      throw new CliError(
        t(
          "macOS bu terminalin Claude'u kapatmasına izin vermedi. Sistem Ayarları → Gizlilik ve Güvenlik → Otomasyon'da terminal uygulamanız için Claude'u açın, sonra yeniden deneyin. Hiçbir dosya değişmedi.",
          "macOS did not let this terminal quit Claude. In System Settings → Privacy & Security → Automation, turn on Claude for your terminal app, then try again. No files changed.",
        ),
        EXIT.environment,
      );
    if (await readObject(ctx.paths.vault, "journal.json").catch(() => null))
      throw new CliError(
        `${redact(full)} ${t("Claude'u kapatıp relay recover çalıştırın.", "Quit Claude and run relay recover.")}`,
        EXIT.failed,
      );
    throw error;
  }
}
