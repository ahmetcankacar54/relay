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
        return t("Eklenti girişi değişti.", "The extension’s sign-in was switched.");
      case "saved":
        return t(
          "Eklentinin önceki girişi kaydedildi, ama bu hesabın kayıtlı eklenti girişi yok. Eklentiye bu hesapla bir kez giriş yap; Relay sonraki geçişte kaydeder.",
          "The extension’s previous sign-in was saved, but this account has no saved extension sign-in yet. Sign in to the extension once with this account; Relay saves it at the next switch.",
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
              "Bu araç Claude eklentisinin girişini değiştiremez; Relay.app’te Geçiş → Claude tarayıcı eklentisi → Şimdi eşitle’yi kullan.",
              "This tool cannot change the Claude extension’s sign-in; use Relay.app: Switching → Claude browser extension → Sync now.",
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
              "Eklenti ya da tarayıcıdaki claude.ai oturumu Relay’de olmayan bir hesaba ait; dokunulmadı.",
              "The extension or the browser’s claude.ai login belongs to an account Relay does not have; it was left alone.",
            );
          case "not-opened":
            return t(
              "Claude eklentisi tarayıcıda hiç açılmamış; dokunulmadı. Eklentiyi bir kez açıp giriş yap, sonra “Kontrol et”e bas.",
              "The Claude extension was never opened in the browser; it was left alone. Open it once and sign in, then press Check.",
            );
          case "guide-mismatch":
            return t(
              "Eklenti bu hesapta değil. Bu hesabın eklenti girişi kayıtlıysa “Şimdi eşitle” ya da menü çubuğu panelindeki “Geçir” onu yerine koyar. Değilse tarayıcıda claude.ai’ye bu hesapla gir, eklentiye giriş yap, sonra “Kontrol et”e bas.",
              "The extension isn’t on this account. If this account’s extension sign-in is saved, Sync now or Switch in the menu bar panel puts it in place. If not, sign in to claude.ai in the browser with it, sign in to the extension, then press Check.",
            );
          case "ambiguous-owner":
            return t(
              "Tarayıcıdaki claude.ai oturumunun hangi hesaba ait olduğu belli değil; dokunulmadı. Eklentiyi açıp “Kontrol et”e bas.",
              "It is unclear which account the browser’s claude.ai login belongs to; it was left alone. Open the extension, then press Check.",
            );
          case "schema-changed":
            return t(
              "Tarayıcının çerez düzeni Relay’in beklediğinden farklı; dokunulmadı.",
              "The browser’s cookie layout is not what Relay expects; it was left alone.",
            );
          case "journal-pending":
            return t(
              "Tarayıcının çerez dosyası temiz kapanmamış; dokunulmadı. Tarayıcıyı bir kez açıp kapat.",
              "The browser’s cookie file was not closed cleanly; it was left alone. Open and quit the browser once.",
            );
          default:
            return undefined;
        }
      case "failed":
        switch (outcome.reason) {
          case "locked":
            return t(
              "Eklentinin deposu ya da tarayıcının çerez dosyası başka bir süreçte açık; dokunulmadı.",
              "The extension’s storage or the browser’s cookie file is open in another process; it was left alone.",
            );
          case "schema-changed":
            return t(
              "Tarayıcının çerez düzeni Relay’in beklediğinden farklı; dokunulmadı.",
              "The browser’s cookie layout is not what Relay expects; it was left alone.",
            );
          case "journal-pending":
            return t(
              "Tarayıcının çerez dosyası temiz kapanmamış; dokunulmadı. Tarayıcıyı bir kez açıp kapat.",
              "The browser’s cookie file was not closed cleanly; it was left alone. Open and quit the browser once.",
            );
          case "write-failed":
          case "verify-failed":
            return t(
              "Eklenti girişi ya da claude.ai oturumu yazılamadı; eski hâli geri konuldu.",
              "Could not write the extension’s sign-in or the claude.ai login; it was put back.",
            );
          case "restore-failed":
            return t(
              "Eklenti girişi ya da claude.ai oturumu yazılamadı ve eski hâli geri konulamadı. Yedekler Relay’in veri klasöründeki extension-scratch ve extension-scratch-cookies içinde.",
              "Could not write the extension’s sign-in or the claude.ai login, or put them back. The backups are in extension-scratch and extension-scratch-cookies in Relay’s data folder.",
            );
          default:
            return t(
              "Eklentinin girişi okunamadı; dokunulmadı.",
              "Could not read the extension’s sign-in; it was left alone.",
            );
        }
    }
  })();
  if (first === undefined) return reopened.trim() || undefined;
  return first + reopened;
}
