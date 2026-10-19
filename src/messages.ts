/**
 * [tr, en, enDisplay?]. `en` is the backend error, word for word (see electron/core and
 * electron/main.ts), and is the lookup key together with `tr`: never reword it. When the English
 * shown to the user should differ from the backend text, `enDisplay` carries it. A backend error
 * thrown in Turkish whose wording changed sits in `en` too, with its English in `enDisplay`.
 */
type Pair = [tr: string, en: string, enDisplay?: string];
const pairs: Pair[] = [
  [
    "Relay.app şu an Claude Desktop'u kullanıyor. Bitince yeniden dene.",
    "Relay.app is using Claude Desktop. Try again when it ends.",
  ],
  [
    "Terminaldeki bir relay komutu şu an Claude Desktop'u kullanıyor. Bitince yeniden dene.",
    "A relay command in a terminal is using Claude Desktop. Try again when it ends.",
  ],
  [
    "Başka bir Relay işlemi şu an Claude Desktop'u kullanıyor. Bitince yeniden dene.",
    "Another Relay process is using Claude Desktop. Try again when it ends.",
  ],
  [
    "Tercihleri değiştirmeden önce Claude uygulamasındaki işlemi tamamla.",
    "Finish the Desktop operation before changing preferences.",
    "Finish the Claude app operation before changing preferences.",
  ],
  [
    "Seçimi, var olan Relay hesaplarını birer kez kullanarak yap.",
    "Select existing Relay accounts once each.",
  ],
  [
    "Geçmişini birleştirmeden önce Claude uygulamasında bu hesaba geç.",
    "Switch to this Desktop account before syncing its history.",
    "Switch the Claude app to this account before syncing its history.",
  ],
  [
    "Claude uygulaması geçmiş takip verisi geçersiz.",
    "Invalid Desktop history tracking data.",
    "Invalid Claude app history tracking data.",
  ],
  [
    "Koşullar değiştiği için otomatik geçiş iptal edildi.",
    "Automatic Desktop switch was cancelled because its conditions changed.",
    "The automatic switch was cancelled because its conditions changed.",
  ],
  [
    "Geçiş sırasında Claude uygulaması açıldı. Uygulamayı kapattıktan sonra yedeği geri yükle.",
    "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
    "The Claude app opened during the switch. Restore its backup after quitting the Claude app.",
  ],
  [
    "Bu profil farklı bir Claude hesabına bağlı. Claude uygulamasında eşleşen hesabı seç.",
    "This profile is connected to a different Claude account. Choose the matching Desktop account.",
    "This profile is connected to a different Claude account. Choose the matching account in the Claude app.",
  ],
  [
    "Bu profil farklı bir Claude kuruluşuna bağlı. Eşleşen Code çalışma alanını seç.",
    "This profile is connected to a different Claude organization. Choose its matching Code workspace.",
  ],
  [
    "Kurulum sırasında Claude uygulamasındaki hesap değişti. Tekrar dene.",
    "Desktop account changed during setup. Try again.",
    "The account in the Claude app changed during setup. Try again.",
  ],
  [
    "Claude uygulamasındaki bu hesap zaten bağlı.",
    "This Desktop profile is already connected.",
    "This Claude app account is already connected.",
  ],
  [
    "Kayıtlı Claude uygulaması girişi eksik. Hesabı yeniden bağla.",
    "Saved Desktop sign-in is missing. Connect this account again.",
    "Saved Claude app sign-in is missing. Connect this account again.",
  ],
  [
    "Kayıtlı Claude uygulaması girişi geçersiz.",
    "Invalid saved Desktop sign-in.",
    "Invalid saved Claude app sign-in.",
  ],
  [
    "Claude uygulaması hâlâ açık. Dosyalar değiştirilmedi.",
    "Claude is still running. No files were changed.",
    "The Claude app is still running. No files were changed.",
  ],
  [
    "Kurtarma yedeği bulunamadı.",
    "Desktop recovery backup is missing.",
    "The recovery backup is missing.",
  ],
  [
    "Claude uygulaması yedeği geçersiz.",
    "Invalid Desktop backup.",
    "Invalid Claude app backup.",
  ],
  ["Kurtarma dosya yolu geçersiz.", "Invalid recovery path."],
  ["Kurtarma verisi geçersiz.", "Invalid recovery data."],
  [
    "Claude uygulaması dosya yolu geçersiz.",
    "Invalid Desktop path.",
    "Invalid Claude app path.",
  ],
  [
    "Claude uygulaması verisinde sembolik bağlantı kullanılamaz.",
    "Desktop data cannot contain symbolic links.",
    "Claude app data cannot contain symbolic links.",
  ],
  [
    "Claude uygulaması dosya boyutu veya türü desteklenmiyor.",
    "Unsupported Desktop file size or type.",
    "Unsupported Claude app file size or type.",
  ],
  [
    "Claude uygulaması veri biçimi desteklenmiyor.",
    "Unsupported Desktop data format.",
    "Unsupported Claude app data format.",
  ],
  [
    "Code oturum biçimi tanınmadı. Claude uygulaması dosyaları değiştirilmedi.",
    "Unrecognized Code session format. No Desktop files changed.",
    "Unrecognized Code session format. No Claude app files changed.",
  ],
  ["Proje biçimi tanınmadı.", "Unrecognized project format."],
  ["Proje kaydı tanınmadı.", "Unrecognized project record."],
  [
    "Geçişten önce yedeğin geri yüklenmesi gerekiyor.",
    "Desktop recovery is required before switching.",
    "Restore the backup before switching.",
  ],
  [
    "Claude uygulaması verisi okunamadı. Dosyalar değiştirilmedi.",
    "Claude Desktop data could not be read. No files were changed.",
    "The Claude app’s data could not be read. No files were changed.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor.",
    "System encryption is unavailable.",
  ],
  [
    // Thrown in Turkish by electron/core/service.ts; this text is the key there too.
    "Claude Code bulunamadı. Resmi CLI’yi kur veya Ayarlar → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
    "Claude Code was not found. Install the official CLI or pick it in Settings → Claude Code CLI → Choose file.",
  ],
  [
    "Bu bir arayüz önizlemesi. Gerçek hesap ve terminal işlemleri için Relay masaüstü uygulamasını aç.",
    "This is a UI preview. Open the Relay desktop application to manage real accounts.",
  ],
  ["En fazla 50 hesap eklenebilir.", "You can add up to 50 accounts."],

  [
    "Önce açık hesap bağlantılarından birini tamamla.",
    "Complete one of your pending account connections first.",
  ],
  [
    "Bu hesapta çalışan oturumu önce durdur.",
    "Stop the running session for this account first.",
  ],
  [
    "Giriş tamamlanmadı. Yeniden bağlanarak tarayıcıda onayla.",
    "Sign-in did not complete. Reconnect and authorize in the browser.",
  ],
  [
    "Giriş süresi doldu. Yeniden bağlanarak devam et.",
    "Sign-in timed out. Reconnect to continue.",
  ],
  [
    "Giriş durumu doğrulanamadı. Hesabı yeniden bağla.",
    "Sign-in could not be verified. Reconnect the account.",
  ],
  [
    "Claude giriş işlemi başlatılamadı. Ayarlardan Claude bağlantısını kontrol et.",
    "Could not start Claude sign-in. Check the Claude connection in Settings.",
  ],
  [
    "Tarayıcı onayı alındı ancak hesap doğrulanamadı. Durumu doğrula veya yeniden bağlan.",
    "Browser authorization received, but verification failed. Verify the account or reconnect.",
  ],
  [
    "Hesap doğrulanamadı. Durumu doğrula veya yeniden bağlan.",
    "Account verification failed. Verify the account or reconnect.",
  ],
  [
    "Bağlantı henüz hazır değil veya süresi doldu. Yeniden bağlan.",
    "The connection is not ready or has expired. Reconnect.",
  ],
  [
    "Bu giriş denemesi artık geçerli değil.",
    "This sign-in attempt is no longer valid.",
  ],
  [
    "Bu giriş işlemi kod beklemiyor.",
    "This sign-in attempt is not waiting for a code.",
  ],
  [
    "Tarayıcının verdiği tek satırlık kodu yapıştır.",
    "Paste the single-line code from the browser.",
  ],
  [
    "Claude uygulamasındaki bu hesap başka bir profilde kayıtlı.",
    "This Desktop account is already saved in another profile.",
    "This Claude app account is already saved in another profile.",
  ],
  [
    "Önce Claude uygulamasında giriş yap ve Code sekmesini aç.",
    "Open Claude Desktop, sign in and open the Code tab first.",
    "Open the Claude app, sign in and open the Code tab first.",
  ],
  [
    "Önce Claude uygulamasında açık hesabı bir profile kaydet.",
    "Save the current Desktop account into a profile before adding another account.",
    "Save the account open in the Claude app into a profile before adding another account.",
  ],
  [
    "Geçişten önce Claude uygulamasında açık hesabı kaydet.",
    "Save the current Desktop account before switching.",
    "Save the account open in the Claude app before switching.",
  ],
  [
    "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
    "Finish or cancel the current Desktop sign-in first.",
    "Finish or cancel the current Claude app sign-in first.",
  ],
  [
    "Claude uygulamasında bir işlem sürüyor.",
    "A Desktop operation is already in progress.",
    "A Claude app operation is already in progress.",
  ],
  [
    "Bu platformda Claude uygulaması bulunamadı.",
    "Claude Desktop was not found on this platform.",
    "The Claude app was not found on this platform.",
  ],
  [
    "Önce yarım kalan geçişi geri yükle.",
    "Restore the interrupted Desktop switch first.",
    "Restore the interrupted switch first.",
  ],
  [
    "Önce bu hesabı Claude uygulamasında bağla.",
    "Connect this account in Claude Desktop first.",
    "Connect this account in the Claude app first.",
  ],
  [
    "Claude uygulaması kurulu değil.",
    "Claude Desktop is not installed.",
    "The Claude app is not installed.",
  ],
  [
    "Bu profil Claude uygulamasındaki başka bir hesaba ait. Yeni bir profil oluştur.",
    "This profile belongs to another Desktop account. Create a new profile.",
    "This profile belongs to another Claude app account. Create a new profile.",
  ],
  [
    "Claude uygulaması kapanmadı. Açık çalışmanı bitirip uygulamayı kapattıktan sonra tekrar dene. Dosyalar değiştirilmedi.",
    "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.",
    "The Claude app did not close. Finish running work and quit the Claude app, then try again. No files changed.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor. Claude uygulaması girişi kaydedilmedi.",
    "System encryption is unavailable. Desktop sign-in was not saved.",
    "System encryption is unavailable. Claude app sign-in was not saved.",
  ],
  // electron/main.ts and the Desktop lock.
  [
    "Hesap bağlantısının yenilenmesi bitene kadar bekle.",
    "Wait for the account connection refresh to finish.",
  ],
  [
    "Giriş yapmadan önce Claude uygulamasındaki işlemin bitmesini bekle.",
    "Finish the Desktop handoff before signing in.",
    "Wait for the Claude app operation to finish before signing in.",
  ],
  [
    "Claude uygulamasındaki işlemin bitmesini bekle, sonra yenisini başlat.",
    "Finish the Desktop handoff before starting another Desktop operation.",
    "Wait for the Claude app operation to finish before starting another.",
  ],
  ["Geçersiz IPC kaynağı.", "Invalid IPC source."],
  // electron/core/desktop.ts: automatic preparation refused.
  [
    "Otomatik hazırlıktan önce Claude uygulamasında açık hesap bilinmeli.",
    "The active Desktop account must be known before automatic preparation.",
    "The account open in the Claude app must be known before automatic preparation.",
  ],
  [
    "Otomatik hazırlıktan önce Claude uygulamasındaki hesap değişti.",
    "Desktop account changed before automatic preparation.",
    "The account in the Claude app changed before automatic preparation.",
  ],
  [
    "Otomatik hazırlığa artık izin yok.",
    "Automatic preparation is no longer authorized.",
  ],
  [
    "Otomatik hazırlıktan önce seçilen hesap değişti.",
    "The selected Desktop account changed before automatic preparation.",
    "The selected account changed before automatic preparation.",
  ],
  [
    "Otomatik geçiş, yeniden başlatmadan önce iptal edildi.",
    "Automatic Desktop switch was cancelled before restart.",
    "The automatic switch was cancelled before the restart.",
  ],
  ["Code kaydı bulunamadı.", "Missing Code record."],
  ["İşlem listesi okunamadı.", "The process list could not be read."],
  ["Claude CLI giriş durumu geçersiz.", "Invalid CLI authentication status."],
  // Thrown in Turkish by electron/core/service.ts and runner.ts; their English follows.
  [
    "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
    "Desktop’ta doğru hesabın açık olduğunu doğrula.",
    "Check that the right account is open in the Claude app.",
  ],
  [
    "Claude uygulamasına aktarım bu platformda veya CLI sürümünde desteklenmiyor.",
    "Desktop aktarımı bu platform veya CLI sürümünde desteklenmiyor.",
    "Sending to the Claude app is not supported on this platform or CLI version.",
  ],
  [
    "Önce Relay içinde seçilen hesapla devam et; ardından o oturumu Claude uygulamasına gönder.",
    "Önce Relay içinde seçilen hesapla devam et; ardından o oturumu Desktop’a gönder.",
    "Continue with the chosen account in Relay first, then send that session to the Claude app.",
  ],
  [
    "Önce bu hesabın giriş işlemini tamamla veya iptal et.",
    "Önce bu hesabın giriş işlemini tamamla veya iptal et.",
    "Finish or cancel this account’s sign-in first.",
  ],
  [
    "Bu hesap beklemede. Hesaplar ekranından beklemeyi kaldır veya başka hesap seç.",
    "Bu hesap beklemede. Hesaplar ekranından beklemeyi kaldır veya başka hesap seç.",
    "This account is on hold. Lift the hold on Accounts or choose another account.",
  ],
  [
    "Proje klasörü bulunamadı. Klasörü yeniden seç.",
    "Proje klasörü bulunamadı. Klasörü yeniden seç.",
    "The project folder was not found. Choose it again.",
  ],
  [
    "Bu projede çalışan oturumu önce Canlı çalışma sekmesinden durdur.",
    "Bu projede çalışan oturumu önce Canlı çalışma sekmesinden durdur.",
    "Stop this project’s running session on the Live tab first.",
  ],
  [
    "Bu tarayıcı profilini başka bir hesap kullanıyor. Bir eklenti tek hesaba bağlanır.",
    "Another account already uses this browser profile.",
    "Another account already uses this browser profile. An extension signs in to one account.",
  ],
  [
    "Bu tarayıcı profili bulunamadı. Listeyi yenileyip yeniden seç.",
    "This browser profile was not found.",
    "This browser profile was not found. Refresh the list and choose again.",
  ],
  [
    "Hesap bulunamadı.",
    "Hesap bulunamadı.",
    "Account not found.",
  ],
  [
    "Terminal bulunamadı.",
    "Terminal bulunamadı.",
    "Terminal not found.",
  ],
  [
    "Önce çalışan oturumu durdur.",
    "Önce çalışan oturumu durdur.",
    "Stop the running session first.",
  ],
  [
    "En fazla 20 canlı terminal açılabilir.",
    "En fazla 20 canlı terminal açılabilir.",
    "You can open up to 20 live terminals.",
  ],
];
export function localizeError(message: string, language: "tr" | "en") {
  const pair = pairs.find((p) => p[0] === message || p[1] === message);
  if (!pair) return message;
  return language === "tr" ? pair[0] : (pair[2] ?? pair[1]);
}
