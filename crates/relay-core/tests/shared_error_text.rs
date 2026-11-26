//! Port of tests/messages.test.ts (`src/messages` re-exports `shared/error-text`'s localizeError)
//! and of the localizeError assertions in tests/account-removal.test.ts and
//! tests/app-update.test.ts. Skipped: "every error main.ts throws with a fixed message has both
//! languages" (reads electron/main source text).

use relay_core::shared::error_text::{BACKEND_ERRORS, localize_error};
use relay_i18n::Locale::{En, Tr};

const MISSING: &str = "Saved Desktop sign-in is missing. Connect this account again.";
const INVALID: &str = "Invalid saved Desktop sign-in.";
const PENDING: &str = "Finish or cancel the current Desktop sign-in first.";
const ENCRYPTION: &str = "System encryption is unavailable. Desktop sign-in was not saved.";

#[test]
fn saved_sign_in_errors_name_the_claude_app_sign_in_in_both_languages() {
    assert_eq!(
        localize_error(MISSING, Tr),
        "Kayıtlı Claude uygulaması girişi eksik. Hesabı yeniden bağla."
    );
    assert_eq!(
        localize_error(MISSING, En),
        "The saved Claude app sign-in is missing. Connect this account again."
    );
    assert_eq!(
        localize_error(INVALID, Tr),
        "Kayıtlı Claude uygulaması girişi geçersiz."
    );
    assert_eq!(
        localize_error(INVALID, En),
        "The saved Claude app sign-in is not valid."
    );
    assert_eq!(
        localize_error(PENDING, Tr),
        "Önce devam eden Claude uygulaması girişini tamamla veya iptal et."
    );
    assert_eq!(
        localize_error(PENDING, En),
        "Finish or cancel the current Claude app sign-in first."
    );
    assert_eq!(
        localize_error(ENCRYPTION, Tr),
        "İşletim sistemi şifrelemesi kullanılamıyor. Claude uygulaması girişi kaydedilmedi."
    );
    assert_eq!(
        localize_error(ENCRYPTION, En),
        "System encryption is not available. Relay did not save the Claude app sign-in."
    );
}

#[test]
fn the_errors_main_s_ipc_handlers_throw_read_in_both_languages() {
    let cases = [
        (
            "Wait for the account connection refresh to finish.",
            "Limit okuma girişinin yenilenmesi bitene kadar bekle.",
            "Wait for the usage sign-in renewal to finish.",
        ),
        (
            "Finish the Desktop handoff before signing in.",
            "Giriş yapmadan önce Claude uygulamasındaki işlemin bitmesini bekle.",
            "Wait for the Claude app action to finish. Then sign in.",
        ),
        (
            "Finish the Desktop handoff before starting another Desktop operation.",
            "Claude uygulamasındaki işlemin bitmesini bekle, sonra yenisini başlat.",
            "Wait for the Claude app action to finish. Then start the next one.",
        ),
        (
            "Finish the Desktop operation before changing preferences.",
            "Tercihleri değiştirmeden önce Claude uygulamasındaki işlemi tamamla.",
            "Finish the Claude app action before you change preferences.",
        ),
        (
            "Geçersiz IPC kaynağı.",
            "Geçersiz IPC kaynağı.",
            "Invalid IPC source.",
        ),
        // Thrown in Turkish by the service.
        (
            "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
            "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
            "Make sure that the correct account is open in the Claude app.",
        ),
    ];
    for (backend, tr, en) in cases {
        assert_eq!(localize_error(backend, Tr), tr, "{backend}");
        assert_eq!(localize_error(backend, En), en, "{backend}");
    }
}

#[test]
fn an_error_relay_does_not_know_is_shown_as_it_came() {
    assert_eq!(
        localize_error("Something else broke.", Tr),
        "Something else broke."
    );
    assert_eq!(
        localize_error("Something else broke.", En),
        "Something else broke."
    );
}

#[test]
fn the_saved_sign_in_vault_errors_read_in_turkish_inner_reason_included() {
    let missing = r#"The Keychain item "Relay Vault Key" was not found."#;
    assert_eq!(
        localize_error(missing, Tr),
        "Anahtarlık’ta \"Relay Vault Key\" öğesi bulunamadı."
    );
    assert_eq!(
        localize_error(
            &format!(
                r#"The Keychain item "Relay Vault Key" could not be read, so saved Claude app sign-ins cannot be opened. {missing} To start over, run relay reset-vault (npm i -g @ahmetcankacar/relay) and save each account again."#
            ),
            Tr
        ),
        "Anahtarlık’taki \"Relay Vault Key\" öğesi okunamadı, bu yüzden kayıtlı Claude uygulaması girişleri açılamıyor. Anahtarlık’ta \"Relay Vault Key\" öğesi bulunamadı. Baştan başlamak için relay reset-vault komutunu çalıştır (npm i -g @ahmetcankacar/relay) ve her hesabı yeniden kaydet."
    );
    assert_eq!(
        localize_error(
            "2 saved sign-in files could not be opened and were set aside in desktop-vault/unreadable. Save the affected accounts’ Claude app sign-ins again.",
            Tr
        ),
        "2 kayıtlı giriş dosyası açılamadı ve desktop-vault/unreadable klasörüne ayrıldı. Bu hesapların Claude uygulaması girişini yeniden kaydet."
    );
    // English keeps the backend text, which never says "Desktop".
    assert_eq!(localize_error(missing, En), missing);
    for message in [
        "No system keyring was found (Secret Service or KWallet), so Claude app sign-ins cannot be saved. Install and unlock gnome-keyring or KWallet, then restart Relay.",
        "System encryption is unavailable, so Claude app sign-ins cannot be saved.",
        "Relay could not open its old saved sign-ins this time (macOS did not allow access to their key). Nothing was moved; Relay tries again at its next start.",
        "Save this account’s Claude app sign-in first.",
    ] {
        assert_ne!(localize_error(message, Tr), message, "{message}");
    }
}

#[test]
fn removal_and_update_refusals_read_in_turkish() {
    // tests/account-removal.test.ts: AccountRemovalRefused("active" | "pending") and the service's refusals.
    for message in [
        "Switch the Claude app to another account before removing this one.",
        "Finish or cancel this account’s Claude app sign-in before removing it.",
    ] {
        assert_ne!(localize_error(message, Tr), message);
        assert!(!localize_error(message, Tr).contains("Desktop"));
    }
    assert_ne!(
        localize_error("Claude Code is running with this account.", Tr),
        "Claude Code is running with this account."
    );
    assert_eq!(
        localize_error("Stop the running session for this account first.", Tr),
        "Bu hesapta çalışan oturumu önce durdur."
    );
    assert!(
        localize_error("Finish or cancel this account’s usage sign-in first.", Tr)
            .contains("limit okuma girişini tamamla ya da iptal et")
    );
    // tests/app-update.test.ts: UPDATE_BUSY.
    assert!(
        localize_error(
            "Relay is busy with the Claude app. Update when it is done.",
            Tr
        )
        .contains("Bitince güncelle")
    );
}

#[test]
fn every_backend_row_names_a_catalog_message() {
    // Not in the TS file: the table is typed `MessageId` there; here each id is checked to exist.
    let en = relay_i18n::catalog(En);
    for (text, id) in BACKEND_ERRORS {
        assert!(en.contains_key(*id), "{text} → {id}");
    }
}
