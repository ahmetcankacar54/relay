import type { ExtensionOutcome } from "./browser-extension";

type T = (tr: string, en: string) => string;

/**
 * What an extension step says, Turkish first; undefined when there is nothing to say (the
 * feature is off, no extension is installed, or the extension is already on the account).
 */
export function extensionLine(outcome: ExtensionOutcome, t: T): string | undefined {
  const reopened =
    outcome.restarted && outcome.reopened === false
      ? t(
          " Tarayıcı yeniden açılamadı; elle aç.",
          " Could not open the browser again; open it yourself.",
        )
      : "";
  const first = (() => {
    switch (outcome.result) {
      case "switched":
        return t("Eklenti girişi değişti.", "The extension's sign-in was switched.");
      case "saved":
        return t(
          "Eklenti girişi kaydedildi; bu hesap için kayıtlı giriş yok. Eklentiye bu hesapla bir kez giriş yap, Relay sonraki geçişte kaydeder.",
          "The extension's sign-in was saved; this account has none saved. Sign in to the extension once with this account and Relay saves it at the next switch.",
        );
      case "unchanged":
        return outcome.reason === "no-saved-login"
          ? t(
              "Bu hesap için kayıtlı eklenti girişi yok. Eklentiye bu hesapla bir kez giriş yap, Relay sonraki geçişte kaydeder.",
              "This account has no saved extension sign-in. Sign in to the extension once with this account and Relay saves it at the next switch.",
            )
          : undefined;
      case "skipped":
        switch (outcome.reason) {
          case "choose-instance":
            return t(
              "Claude eklentisi birden çok tarayıcı profilinde var; Geçiş sayfasından birini seç.",
              "The Claude extension is in several browser profiles; choose one on the Switching page.",
            );
          case "unavailable":
            return t(
              "Bu araç Claude eklentisinin girişini değiştiremez; Relay.app'te Geçiş → Claude tarayıcı eklentisi → Şimdi eşitle.",
              "This tool cannot change the Claude extension's sign-in; use Relay.app: Switching → Claude browser extension → Sync now.",
            );
          case "browser-running":
            return t(
              "Tarayıcı açık olduğu için eklentiye dokunulmadı.",
              "The browser is open, so the extension was left alone.",
            );
          case "browser-did-not-quit":
            return t(
              "Tarayıcı kapanmadı, eklentiye dokunulmadı.",
              "The browser did not quit; the extension was left alone.",
            );
          case "unknown-account":
            return t(
              "Eklenti Relay'de olmayan bir hesaba girişli; dokunulmadı.",
              "The extension is signed in to an account Relay does not have; it was left alone.",
            );
          default:
            return undefined;
        }
      case "failed":
        switch (outcome.reason) {
          case "locked":
            return t(
              "Eklentinin deposu başka bir süreçte açık; dokunulmadı.",
              "The extension's storage is open in another process; it was left alone.",
            );
          case "write-failed":
          case "verify-failed":
            return t(
              "Eklenti girişi yazılamadı; eski hâli geri konuldu.",
              "Could not write the extension's sign-in; it was put back.",
            );
          case "restore-failed":
            return t(
              "Eklenti girişi yazılamadı ve eski hâli geri konulamadı. Yedeği Relay'in veri klasöründeki extension-scratch içinde.",
              "Could not write the extension's sign-in or put it back. The backup is in extension-scratch in Relay's data folder.",
            );
          default:
            return t(
              "Eklentinin girişi okunamadı; dokunulmadı.",
              "Could not read the extension's sign-in; it was left alone.",
            );
        }
    }
  })();
  if (first === undefined) return reopened.trim() || undefined;
  return first + reopened;
}
