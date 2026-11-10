/**
 * Backend errors in the reader's language, for the app (src/messages.ts re-exports this) and the
 * relay CLI.
 *
 * [tr, en, enDisplay?]. `en` is the backend error, word for word (see electron/core and
 * electron/main.ts), and is the lookup key together with `tr`: never reword it without changing the
 * thrower too. When the English shown to the user should differ from the backend text, `enDisplay`
 * carries it. An error the backend throws in Turkish is looked up by `tr`, with its English in `en`.
 */
type Pair = [tr: string, en: string, enDisplay?: string];
const pairs: Pair[] = [
  [
    "Claude bu girişi henüz kaydetmedi. Relay birazdan yeniden dener.",
    "Claude has not finished saving this sign-in yet. Relay tries again in a moment.",
  ],
  [
    "Bu Claude girişinde oturum yok, bu yüzden kaydedilmedi. Claude uygulamasında yeniden giriş yap, yarım dakika bekle, sonra kaydet.",
    "This Claude sign-in holds no session, so it was not saved. Sign in to the Claude app again, wait half a minute, then save.",
  ],
  [
    "Claude uygulamasında oturum kapalı. Önce giriş yap, sonra kaydet.",
    "The Claude app is signed out. Sign in to it first, then save.",
  ],
  [
    "Bu hesabın kayıtlı Claude girişi sona ermiş. Relay’de hesaba yeniden giriş yap.",
    "This account’s saved Claude sign-in has ended. Sign in to it again in Relay.",
  ],
  [
    "Relay.app şu an Claude uygulamasında bir işlem yapıyor. Bitince yeniden dene.",
    "Relay.app is using Claude Desktop. Try again when it ends.",
    "A Relay action is running in the Claude app. Try again when it ends.",
  ],
  [
    "Terminaldeki bir relay komutu şu an Claude uygulamasında bir işlem yapıyor. Bitince yeniden dene.",
    "A relay command in a terminal is using Claude Desktop. Try again when it ends.",
    "A relay command in a terminal uses the Claude app. Try again when it ends.",
  ],
  [
    "Başka bir Relay işlemi şu an Claude uygulamasında çalışıyor. Bitince yeniden dene.",
    "Another Relay process is using Claude Desktop. Try again when it ends.",
    "Another Relay process uses the Claude app. Try again when it ends.",
  ],
  [
    "Tercihleri değiştirmeden önce Claude uygulamasındaki işlemi tamamla.",
    "Finish the Desktop operation before changing preferences.",
    "Finish the Claude app action before you change preferences.",
  ],
  ["Claude’u başlatma seçimi geçersiz.", "Invalid Claude launch choice."],
  [
    "Relay Claude uygulamasında bir işlem yapıyor. Bitince güncelle.",
    "Relay is busy with the Claude app. Update when it is done.",
  ],
  ["Kurulmaya hazır bir güncelleme yok.", "No update is ready to install."],
  [
    "İndirilen güncelleme sağlama toplamıyla eşleşmiyor.",
    "The downloaded update does not match its checksum.",
  ],
  [
    "İndirilen güncelleme bu Relay gibi imzalanmamış, bu yüzden kurulmadı.",
    "The downloaded update is not signed like this Relay, so it was not installed.",
    "The downloaded update has a different signature. Relay did not install it.",
  ],
  ["Sürüm, güncelleme için sağlama toplamı listelemiyor.", "The release lists no checksum for the update."],
  [
    "Relay disk görüntüsünden çalışıyor. Uygulamalar klasörüne taşı, sonra güncelle.",
    "Relay runs from the disk image. Move it to Applications, then update.",
  ],
  [
    "Relay kendi klasöründe kendini değiştiremiyor. Güncellemeyi sürüm sayfasından indir.",
    "Relay cannot replace itself in its folder. Download the update from the release page.",
  ],
  [
    "Relay’in bu kopyası kendini güncelleyemez.",
    "Updates are not available in this copy of Relay.",
  ],
  ["Güncelleme kaynağında kullanılabilir bir sürüm yok.", "The update feed has no usable release."],
  ["Güncelleme çok büyük.", "The update is too large."],
  ["Güncelleme sunucusu çok fazla veri gönderdi.", "The update server sent too much data."],
  [
    "Bu hesap ayrı bir Claude penceresinde açık. Önce o pencereyi kapat.",
    "This account is open in a separate Claude window. Close that window first.",
  ],
  [
    "Ayrı bir Claude penceresi açık, bu yüzden Relay kendiliğinden geçiş yapmaz.",
    "A separate Claude window is open, so Relay does not switch by itself.",
  ],
  [
    "Ayrı Claude pencereleri Ayarlar’da kapalı.",
    "Separate Claude windows are turned off in Settings.",
  ],
  ["Ayrı Claude pencereleri macOS gerektirir.", "Separate Claude windows need macOS."],
  [
    "Bu hesap zaten Claude uygulamasında açık. Önce Claude uygulamasını başka bir hesaba geçir.",
    "This account is already open in the Claude app. Switch the Claude app to another account first.",
  ],
  [
    "Claude ayrı pencereyi açmadı. Yeniden dene.",
    "Claude did not open the separate window. Try again.",
  ],
  [
    "Ayrı pencere hâlâ açık. Claude orada çalışan işler için soru soruyor olabilir.",
    "The separate window is still open. Claude may be asking about work left running there.",
    "The separate window is still open. Check it for a question from Claude.",
  ],
  ["Menü çubuğu seçimi geçersiz.", "Invalid menu bar title."],
  [
    "Yalnızca var olan Relay hesaplarını seç; her birini bir kez.",
    "Select existing Relay accounts once each.",
  ],
  [
    "Geçmişini birleştirmeden önce Claude uygulamasında bu hesaba geç.",
    "Switch to this Desktop account before syncing its history.",
    "Switch the Claude app to this account before you sync its history.",
  ],
  [
    "Claude uygulamasının geçmiş takip verisi geçersiz.",
    "Invalid Desktop history tracking data.",
    "The history data of the Claude app is not valid.",
  ],
  [
    "Koşullar değiştiği için otomatik geçiş iptal edildi.",
    "Automatic Desktop switch was cancelled because its conditions changed.",
    "Relay stopped the automatic switch because the conditions changed.",
  ],
  [
    "Geçiş sırasında Claude uygulaması açıldı. Uygulamayı kapattıktan sonra yedeği geri yükle.",
    "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
    "The Claude app opened during the switch. Quit it, then restore the backup.",
  ],
  [
    "Bu profil farklı bir Claude hesabına bağlı. Claude uygulamasında eşleşen hesabı seç.",
    "This profile is connected to a different Claude account. Choose the matching Desktop account.",
    "This profile is connected to a different Claude account. Select the matching account in the Claude app.",
  ],
  [
    "Bu profil farklı bir Claude kuruluşuna bağlı. Eşleşen Code çalışma alanını seç.",
    "This profile is connected to a different Claude organization. Choose its matching Code workspace.",
    "This profile is connected to a different Claude organization. Select the matching Code workspace.",
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
    "The saved Claude app sign-in is missing. Connect this account again.",
  ],
  [
    "Kayıtlı Claude uygulaması girişi geçersiz.",
    "Invalid saved Desktop sign-in.",
    "The saved Claude app sign-in is not valid.",
  ],
  [
    "Claude uygulaması hâlâ açık. Dosyalar değiştirilmedi.",
    "Claude is still running. No files were changed.",
    "The Claude app is still running. Relay did not change any files.",
  ],
  [
    "Kurtarma yedeği bulunamadı.",
    "Desktop recovery backup is missing.",
    "The recovery backup is missing.",
  ],
  [
    "Claude uygulaması yedeği geçersiz.",
    "Invalid Desktop backup.",
    "The Claude app backup is not valid.",
  ],
  ["Kurtarma dosya yolu geçersiz.", "Invalid recovery path."],
  ["Kurtarma verisi geçersiz.", "Invalid recovery data."],
  [
    "Claude uygulamasındaki bir dosya yolu geçersiz.",
    "Invalid Desktop path.",
    "Invalid Claude app path.",
  ],
  [
    "Claude uygulaması verisinde sembolik bağlantı kullanılamaz.",
    "Desktop data cannot contain symbolic links.",
    "Claude app data cannot contain symbolic links.",
  ],
  [
    "Claude uygulamasındaki bir dosyanın boyutu ya da türü desteklenmiyor.",
    "Unsupported Desktop file size or type.",
    "Unsupported Claude app file size or type.",
  ],
  [
    "Claude uygulamasının veri biçimi desteklenmiyor.",
    "Unsupported Desktop data format.",
    "Unsupported Claude app data format.",
  ],
  [
    "Code oturum biçimi tanınmadı. Claude uygulaması dosyaları değiştirilmedi.",
    "Unrecognized Code session format. No Desktop files changed.",
    "Unknown Code session format. Relay did not change any Claude app files.",
  ],
  [
    "Proje biçimi tanınmadı.",
    "Unrecognized project format.",
    "Unknown project format.",
  ],
  [
    "Proje kaydı tanınmadı.",
    "Unrecognized project record.",
    "Unknown project record.",
  ],
  [
    "Geçişten önce yedeğin geri yüklenmesi gerekiyor.",
    "Desktop recovery is required before switching.",
    "Restore the backup before you switch.",
  ],
  [
    "Claude uygulaması verisi okunamadı. Dosyalar değiştirilmedi.",
    "Claude Desktop data could not be read. No files were changed.",
    "Relay cannot read the Claude app data. It did not change any files.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor.",
    "System encryption is unavailable.",
  ],
  [
    // Thrown in Turkish by electron/core/service.ts; this text is the key there too.
    "Claude Code bulunamadı. Claude uygulamasında Code’u bir kez aç (Claude Code’u kendisi indirir) veya Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
    "Claude Code was not found. Open Code once in the Claude app (it downloads Claude Code itself) or pick it in Settings → Advanced → Claude Code CLI → Choose file.",
    "Relay cannot find Claude Code. Open Code once in the Claude app, or select the file in Settings → Advanced → Claude Code CLI.",
  ],
  [
    "Bu bir arayüz önizlemesi. Gerçek hesap ve terminal işlemleri için Relay masaüstü uygulamasını aç.",
    "This is a UI preview. Open the Relay desktop application to manage real accounts.",
    "This is a preview. Open the Relay app to manage real accounts.",
  ],
  ["En fazla 50 hesap eklenebilir.", "You can add up to 50 accounts."],

  [
    "Önce yarım kalan limit okuma girişlerinden birini tamamla.",
    "Finish one of the pending usage sign-ins first.",
  ],
  [
    "Bu hesapta çalışan oturumu önce durdur.",
    "Stop the running session for this account first.",
  ],
  [
    "Limit okuma girişi tamamlanmadı. Yeniden dene ve tarayıcıda onayla.",
    "The usage sign-in did not finish. Try again and approve it in the browser.",
  ],
  [
    "Tarayıcıda başka bir Claude hesabıyla giriş yapıldı; bu profil Claude uygulamasındaki hesabına ait. claude.ai’da doğru hesaba geç ya da “Relay penceresinde aç”ı kullan, sonra girişi yenile.",
    "The browser signed in with another Claude account; this profile belongs to its Claude app account. Switch to the right account on claude.ai or use “Open in Relay window”, then renew the sign-in.",
  ],
  [
    "Bu giriş, hesabın Claude uygulamasında henüz açılmamış bir çalışma alanına ait. Claude uygulamasında o çalışma alanında Code’u aç, sonra girişi yenile.",
    "This sign-in belongs to a workspace of the account that the Claude app has not opened yet. Open Code in that workspace in the Claude app, then renew the sign-in.",
  ],
  [
    "Giriş süresi doldu. Girişi yeniden başlat.",
    "The sign-in timed out. Start it again.",
  ],
  [
    "Limit okuma girişi doğrulanamadı. Limit okuma girişini yenile.",
    "The usage sign-in could not be verified. Renew the usage sign-in.",
    "Relay cannot verify the usage sign-in. Renew the usage sign-in.",
  ],
  [
    "Limit okuma girişi başlatılamadı. Ayarlar’daki Claude Code CLI bölümünü kontrol et.",
    "Could not start the usage sign-in. Check Claude Code CLI in Settings.",
    "The usage sign-in did not start. Check Claude Code CLI in Settings.",
  ],
  [
    "Tarayıcı onayı alındı ama hesap doğrulanamadı. Limitleri yenile; sorun sürerse limit okuma girişini yenile.",
    "The browser approval came through, but the account could not be verified. Refresh limits; if it persists, renew the usage sign-in.",
    "The browser approval is done, but Relay cannot verify the account. Refresh limits. If the problem continues, renew the usage sign-in.",
  ],
  [
    "Hesap doğrulanamadı. Limitleri yenile; sorun sürerse limit okuma girişini yenile.",
    "The account could not be verified. Refresh limits; if it persists, renew the usage sign-in.",
    "Relay cannot verify the account. Refresh limits. If the problem continues, renew the usage sign-in.",
  ],
  [
    "Giriş sayfası henüz hazır değil ya da süresi doldu. Girişi yeniden başlat.",
    "The sign-in page isn’t ready yet or has expired. Start the sign-in again.",
    "The sign-in page is not ready or has expired. Start the sign-in again.",
  ],
  [
    "Bu giriş denemesi artık geçerli değil.",
    "This sign-in attempt is no longer valid.",
  ],
  [
    "Bu giriş işlemi kod beklemiyor.",
    "This sign-in attempt is not waiting for a code.",
    "This sign-in attempt does not need a code.",
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
    "Save the account open in the Claude app before you add another account.",
  ],
  [
    "Geçişten önce Claude uygulamasında açık hesabı kaydet.",
    "Save the current Desktop account before switching.",
    "Save the account open in the Claude app before you switch.",
  ],
  [
    "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
    "Finish or cancel the current Desktop sign-in first.",
    "Finish or cancel the current Claude app sign-in first.",
  ],
  [
    "Claude uygulamasında bir işlem sürüyor.",
    "A Desktop operation is already in progress.",
    "A Claude app action is already in progress.",
  ],
  [
    "Bu platformda Claude uygulaması bulunamadı.",
    "Claude Desktop was not found on this platform.",
    "Relay cannot find the Claude app on this computer.",
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
    "The Claude app did not close. Finish the work in progress and quit the Claude app. Then try again. Relay did not change any files.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor. Claude uygulaması girişi kaydedilmedi.",
    "System encryption is unavailable. Desktop sign-in was not saved.",
    "System encryption is not available. Relay did not save the Claude app sign-in.",
  ],
  // electron/main.ts and the Desktop lock.
  [
    "Limit okuma girişinin yenilenmesi bitene kadar bekle.",
    "Wait for the account connection refresh to finish.",
    "Wait for the usage sign-in renewal to finish.",
  ],
  [
    "Giriş yapmadan önce Claude uygulamasındaki işlemin bitmesini bekle.",
    "Finish the Desktop handoff before signing in.",
    "Wait for the Claude app action to finish. Then sign in.",
  ],
  [
    "Claude uygulamasındaki işlemin bitmesini bekle, sonra yenisini başlat.",
    "Finish the Desktop handoff before starting another Desktop operation.",
    "Wait for the Claude app action to finish. Then start the next one.",
  ],
  ["Geçersiz IPC kaynağı.", "Invalid IPC source."],
  // electron/core/desktop.ts: automatic preparation refused.
  [
    "Otomatik hazırlıktan önce Claude uygulamasında açık hesap bilinmeli.",
    "The active Desktop account must be known before automatic preparation.",
    "Relay must know the account open in the Claude app before automatic preparation.",
  ],
  [
    "Otomatik hazırlıktan önce Claude uygulamasındaki hesap değişti.",
    "Desktop account changed before automatic preparation.",
    "The account in the Claude app changed before automatic preparation.",
  ],
  [
    "Otomatik hazırlığa artık izin yok.",
    "Automatic preparation is no longer authorized.",
    "Automatic preparation is no longer allowed.",
  ],
  [
    "Otomatik hazırlıktan önce seçilen hesap değişti.",
    "The selected Desktop account changed before automatic preparation.",
    "The selected account changed before automatic preparation.",
  ],
  [
    "Otomatik geçiş, yeniden başlatmadan önce iptal edildi.",
    "Automatic Desktop switch was cancelled before restart.",
    "Relay stopped the automatic switch before the restart.",
  ],
  ["Code kaydı bulunamadı.", "Missing Code record."],
  [
    "İşlem listesi okunamadı.",
    "The process list could not be read.",
    "Relay cannot read the process list.",
  ],
  [
    "Claude CLI giriş durumu geçersiz.",
    "Invalid CLI authentication status.",
    "The CLI sign-in status is not valid.",
  ],
  // Thrown in Turkish by electron/core/service.ts and runner.ts; their English follows.
  [
    "Claude uygulamasında doğru hesabın açık olduğunu doğrula.",
    "Check that the right account is open in the Claude app.",
    "Make sure that the correct account is open in the Claude app.",
  ],
  [
    "Claude uygulamasına aktarım bu platformda veya CLI sürümünde desteklenmiyor.",
    "Sending to the Claude app is not supported on this platform or CLI version.",
    "This platform or CLI version cannot send sessions to the Claude app.",
  ],
  [
    "Önce Relay içinde seçilen hesapla devam et; ardından o oturumu Claude uygulamasına gönder.",
    "Continue with the chosen account in Relay first, then send that session to the Claude app.",
    "Continue with the selected account in Relay first. Then send that session to the Claude app.",
  ],
  [
    "Önce bu hesabın limit okuma girişini tamamla ya da iptal et.",
    "Finish or cancel this account’s usage sign-in first.",
  ],
  [
    "Bu hesap beklemede. Hesaplar ekranından beklemeyi kaldır veya başka hesap seç.",
    "Bu hesap beklemede. Hesaplar ekranından beklemeyi kaldır veya başka hesap seç.",
    "This account is on hold. Remove the hold on Accounts, or select another account.",
  ],
  [
    "Proje klasörü bulunamadı. Klasörü yeniden seç.",
    "Proje klasörü bulunamadı. Klasörü yeniden seç.",
    "Relay cannot find the project folder. Select it again.",
  ],
  [
    "Bu projede çalışan oturumu önce Canlı çalışma sekmesinden durdur.",
    "Bu projede çalışan oturumu önce Canlı çalışma sekmesinden durdur.",
    "Stop this project’s running session on the Live tab first.",
  ],
  [
    "Claude uygulamasını önce kayıtlı bir hesaba geçir.",
    "Switch Claude Desktop to a saved account first.",
    "Switch the Claude app to a saved account first.",
  ],
  [
    "Claude tarayıcı eklentisi burada desteklenmiyor.",
    "The Claude browser extension is not supported here.",
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
  // electron/core/account-removal.ts and profile-lock.ts: removing an account.
  [
    "Bu hesabı kaldırmadan önce Claude uygulamasında başka bir hesaba geç.",
    "Switch the Claude app to another account before removing this one.",
    "Switch the Claude app to another account before you remove this one.",
  ],
  [
    "Bu hesabı kaldırmadan önce Claude uygulaması girişini tamamla ya da iptal et.",
    "Finish or cancel this account’s Claude app sign-in before removing it.",
    "Finish or cancel this account’s Claude app sign-in before you remove it.",
  ],
  [
    "Claude Code bu hesapla çalışıyor.",
    "Claude Code is running with this account.",
  ],
  [
    "Başka bir işlem bu hesabın girişini yapıyor ya da bağlantısını yeniliyor.",
    "Another process is signing this account in or renewing its connection.",
    "Another process signs this account in or renews its connection.",
  ],
  // electron/core/desktop.ts: the extension check.
  [
    "Önce bu hesabın Claude uygulaması girişini kaydet.",
    "Save this account’s Claude app sign-in first.",
  ],
  // electron/core/cli-diagnostics.ts, thrown in Turkish.
  [
    "Claude Code sürümü okunamadı. Çalıştırılabilir dosyayı kontrol et.",
    "The Claude Code version could not be read. Check the executable.",
    "Relay cannot read the Claude Code version. Check the Claude Code CLI file.",
  ],
  // electron/main.ts: where saved Claude app sign-ins cannot be sealed (Linux, Windows).
  [
    "Sistem anahtarlığı bulunamadı (Secret Service ya da KWallet), bu yüzden Claude uygulaması girişleri kaydedilemiyor. gnome-keyring ya da KWallet’i kurup kilidini aç, sonra Relay’i yeniden başlat.",
    "No system keyring was found (Secret Service or KWallet), so Claude app sign-ins cannot be saved. Install and unlock gnome-keyring or KWallet, then restart Relay.",
    "Relay cannot find a system keyring (Secret Service or KWallet), so it cannot save Claude app sign-ins. Install and unlock gnome-keyring or KWallet. Then restart Relay.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor, bu yüzden Claude uygulaması girişleri kaydedilemiyor.",
    "System encryption is unavailable, so Claude app sign-ins cannot be saved.",
    "System encryption is not available, so Relay cannot save Claude app sign-ins.",
  ],
  // electron/core/store.ts (StoreWriteRefused).
  [
    "Relay’in hesap listesini daha yeni bir sürüm yazmış. Değiştirmeden önce bu Relay kopyasını güncelle.",
    "Relay’s account list was written by a newer version. Update this copy of Relay before changing it.",
    "A newer Relay version wrote the account list. Update this copy of Relay before you change it.",
  ],
  [
    "Relay’in hesap listesini Relay 0.11 ya da daha eski bir sürüm yazmış. Relay.app’i 0.12 veya üstüne güncelleyip bir kez aç.",
    "Relay’s account list was written by Relay 0.11 or older. Update Relay.app to 0.12 or later and open it once.",
    "Relay 0.11 or older wrote the account list. Update Relay.app to 0.12 or later and open it once.",
  ],
  // electron/core/vault-migration.ts: moving the saved sign-ins to the Keychain-keyed format.
  [
    "Eski kayıtlı giriş dosyalarının hiçbiri açılamadı, bu yüzden hiçbir şey taşınmadı. Relay bir sonraki açılışta yeniden dener.",
    "None of the old saved sign-in files could be opened, so nothing was moved. Relay tries again at its next start.",
    "Relay cannot open any of the old saved sign-in files, so it did not move them. Relay tries again at its next start.",
  ],
  [
    "journal.json’daki kurtarma yedeği açılamadı, bu yüzden kayıtlı girişler yeni biçime taşınmadı.",
    "The recovery backup named in journal.json could not be opened, so the saved sign-ins were not moved to the new format.",
    "Relay cannot open the recovery backup named in journal.json, so it did not move the saved sign-ins to the new format.",
  ],
  [
    "Relay eski kayıtlı girişleri bu sefer açamadı (macOS anahtarlarına erişim izni vermedi). Hiçbir şey taşınmadı; Relay bir sonraki açılışta yeniden dener.",
    "Relay could not open its old saved sign-ins this time (macOS did not allow access to their key). Nothing was moved; Relay tries again at its next start.",
    "Relay cannot open its old saved sign-ins: macOS did not allow access to their key. Relay did not move them and tries again at its next start.",
  ],
];

/** A backend error with a variable part: the English the backend builds, and its Turkish. */
interface Pattern {
  en: RegExp;
  tr: (match: RegExpExecArray) => string;
}
const patterns: Pattern[] = [
  // electron/core/vault-key.ts (VaultKeyError) and vault-migration.ts, around the Keychain item.
  {
    en: /^The Keychain item "([^"]+)" was not found\.$/,
    tr: (m) => `Anahtarlık’ta "${m[1]}" öğesi bulunamadı.`,
  },
  {
    en: /^The Keychain item "([^"]+)" could not be read\. Unlock the login keychain and try again\.$/,
    tr: (m) => `Anahtarlık’taki "${m[1]}" öğesi okunamadı. Giriş anahtarlığının kilidini açıp yeniden dene.`,
  },
  {
    en: /^The Keychain item "([^"]+)" does not hold a vault key\.$/,
    tr: (m) => `Anahtarlık’taki "${m[1]}" öğesi bir kasa anahtarı içermiyor.`,
  },
  {
    en: /^The Keychain item "([^"]+)" could not be read, so saved Claude app sign-ins cannot be opened\.(?: (.*?))?( To start over, run relay reset-vault \(npm i -g @ahmetcankacar\/relay\) and save each account again\.)?$/s,
    tr: (m) =>
      `Anahtarlık’taki "${m[1]}" öğesi okunamadı, bu yüzden kayıtlı Claude uygulaması girişleri açılamıyor.${m[2] ? ` ${localizeError(m[2], "tr")}` : ""}${m[3] ? " Baştan başlamak için relay reset-vault komutunu çalıştır (npm i -g @ahmetcankacar/relay) ve her hesabı yeniden kaydet." : ""}`,
  },
  {
    en: /^The Keychain item "([^"]+)" could not be read\. (.+)$/s,
    tr: (m) => `Anahtarlık’taki "${m[1]}" öğesi okunamadı. ${localizeError(m[2], "tr")}`,
  },
  {
    en: /^Relay’s saved sign-ins could not be read: (.*)$/s,
    tr: (m) => `Relay’in kayıtlı girişleri okunamadı: ${localizeError(m[1], "tr")}`,
  },
  {
    en: /^Relay’s saved sign-ins were written by a newer version \(format (\d+)\)\. Update Relay\.$/,
    tr: (m) => `Relay’in kayıtlı girişlerini daha yeni bir sürüm yazmış (biçim ${m[1]}). Relay’i güncelle.`,
  },
  {
    en: /^(\d+) saved sign-in files? could not be opened and (?:was|were) set aside in desktop-vault\/unreadable\. Save the affected accounts’ Claude app sign-ins again\.$/,
    tr: (m) =>
      `${m[1]} kayıtlı giriş dosyası açılamadı ve desktop-vault/unreadable klasörüne ayrıldı. Bu hesapların Claude uygulaması girişini yeniden kaydet.`,
  },
];

/** `message` in `language`: a known backend error is translated, anything else is left as it is. */
export function localizeError(message: string, language: "tr" | "en"): string {
  const pair = pairs.find((p) => p[0] === message || p[1] === message);
  if (pair) return language === "tr" ? pair[0] : (pair[2] ?? pair[1]);
  if (language === "tr")
    for (const pattern of patterns) {
      const match = pattern.en.exec(message);
      if (match) return pattern.tr(match);
    }
  return message;
}
