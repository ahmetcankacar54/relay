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
          " Relay cannot open the browser again. Open it manually.",
        )
      : "";
  const first = (() => {
    switch (outcome.result) {
      case "switched":
        return t("Eklenti girişi değişti.", "The extension sign-in changed.");
      case "saved":
        return t(
          "Eklentinin önceki girişi kaydedildi, ama bu hesabın kayıtlı eklenti girişi yok. Eklentiye bu hesapla bir kez giriş yap; Relay sonraki geçişte kaydeder.",
          "Relay saved the previous extension sign-in. This account has no saved extension sign-in yet. Sign in to the extension once with this account. Relay saves it at the next switch.",
        );
      case "unchanged":
        if (outcome.cleared)
          return t(
            "Eklenti zaten bu hesaptaydı ama girişi düşmüştü. Eklenti tarayıcıdaki claude.ai oturumuyla kendisi yeniden giriş yapar. Claude’un tarayıcı araçları yine çalışmazsa eklentinin yan panelinden giriş yap.",
            "The extension was on this account, but its sign-in expired. The extension signs in again with the claude.ai login in the browser. If Claude’s browser tools still do not work, sign in from the extension side panel.",
          );
        return outcome.reason === "no-saved-login"
          ? t(
              "Bu hesap için kayıtlı eklenti girişi yok. Eklentiye bu hesapla bir kez giriş yap; Relay sonraki geçişte kaydeder.",
              "This account has no saved extension sign-in. Sign in to the extension once with this account. Relay saves it at the next switch.",
            )
          : undefined;
      case "skipped":
        switch (outcome.reason) {
          case "choose-instance":
            return t(
              "Claude eklentisi birden çok tarayıcı profilinde var. Ayarlar → Geçişte taşınanlar’dan birini seç.",
              "The Claude extension is in several browser profiles. Select one in Settings → What comes along.",
            );
          case "unavailable":
            return t(
              "Bu araç Claude eklentisinin girişini değiştiremez. Relay.app’te Ayarlar → Geçişte taşınanlar → Claude tarayıcı eklentisi → Şimdi eşitle’yi kullan.",
              "This tool cannot change the Claude extension sign-in. In Relay.app, use Settings → What comes along → Claude browser extension → Sync now.",
            );
          case "browser-running":
            return t(
              "Tarayıcı açık olduğu için eklentiye dokunulmadı.",
              "The browser is open, so Relay did not change the extension.",
            );
          case "browser-did-not-quit":
            return t(
              "Tarayıcı kapanmadı; eklentiye dokunulmadı.",
              "The browser did not quit, so Relay did not change the extension.",
            );
          case "unknown-account":
            return t(
              "Eklenti ya da tarayıcıdaki claude.ai oturumu Relay’de olmayan bir hesaba ait; dokunulmadı.",
              "The extension or the claude.ai login in the browser belongs to an account that is not in Relay. Relay did not change it.",
            );
          case "not-opened":
            return t(
              "Claude eklentisi tarayıcıda hiç açılmamış; dokunulmadı. Eklentiyi bir kez açıp giriş yap, sonra “Kontrol et”e bas.",
              "The Claude extension was never opened in the browser, so Relay did not change it. Open it once and sign in. Then select “Check”.",
            );
          case "guide-mismatch":
            return t(
              "Eklenti bu hesapta değil. Bu hesabın eklenti girişi kayıtlıysa “Şimdi eşitle”yi ya da menü çubuğu panelindeki “Geçir”i kullan. Değilse claude.ai’ye ve eklentiye bu hesapla gir, sonra “Kontrol et”e bas.",
              "The extension is not on this account. If its extension sign-in is saved, use “Sync now” or “Switch” in the menu bar panel. If not, sign in to claude.ai and to the extension with this account. Then select “Check”.",
            );
          case "ambiguous-owner":
            return t(
              "Tarayıcıdaki claude.ai oturumunun hangi hesaba ait olduğu belli değil; dokunulmadı. Eklentiyi açıp “Kontrol et”e bas.",
              "Relay cannot tell which account the claude.ai login in the browser belongs to, so it did not change it. Open the extension, then select “Check”.",
            );
          case "schema-changed":
            return t(
              "Tarayıcının çerez düzeni Relay’in beklediğinden farklı; dokunulmadı.",
              "The browser cookie format is not what Relay expects. Relay did not change it.",
            );
          case "journal-pending":
            return t(
              "Tarayıcının çerez dosyası temiz kapanmamış; dokunulmadı. Tarayıcıyı bir kez açıp kapat.",
              "The browser cookie file did not close correctly, so Relay did not change it. Open and quit the browser once.",
            );
          default:
            return undefined;
        }
      case "failed":
        switch (outcome.reason) {
          case "locked":
            return t(
              "Eklentinin deposu ya da tarayıcının çerez dosyası başka bir süreçte açık; dokunulmadı.",
              "The extension storage or the browser cookie file is open in another process. Relay did not change it.",
            );
          case "schema-changed":
            return t(
              "Tarayıcının çerez düzeni Relay’in beklediğinden farklı; dokunulmadı.",
              "The browser cookie format is not what Relay expects. Relay did not change it.",
            );
          case "journal-pending":
            return t(
              "Tarayıcının çerez dosyası temiz kapanmamış; dokunulmadı. Tarayıcıyı bir kez açıp kapat.",
              "The browser cookie file did not close correctly, so Relay did not change it. Open and quit the browser once.",
            );
          case "write-failed":
          case "verify-failed":
            return t(
              "Eklenti girişi ya da claude.ai oturumu yazılamadı; eski hâli geri konuldu.",
              "Relay cannot write the extension sign-in or the claude.ai login. Relay put back the previous state.",
            );
          case "restore-failed":
            return t(
              "Eklenti girişi ya da claude.ai oturumu yazılamadı ve eski hâli geri konulamadı. Yedekler Relay’in veri klasöründeki extension-scratch ve extension-scratch-cookies içinde.",
              "Relay cannot write the extension sign-in or the claude.ai login, and cannot put back the previous state. The backups are in extension-scratch and extension-scratch-cookies in the Relay data folder.",
            );
          default:
            return t(
              "Eklentinin girişi okunamadı; dokunulmadı.",
              "Relay cannot read the extension sign-in. Relay did not change it.",
            );
        }
    }
  })();
  if (first === undefined) return reopened.trim() || undefined;
  return first + reopened;
}
