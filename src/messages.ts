/**
 * [tr, en, enDisplay?]. `en` is the backend error, word for word (see electron/core), and is the
 * lookup key together with `tr`: never reword it. When the English shown to the user should differ
 * from the backend text, `enDisplay` carries it.
 */
type Pair = [tr: string, en: string, enDisplay?: string];
const pairs: Pair[] = [
  [
    "Tercihleri değiştirmeden önce Desktop işlemini tamamla.",
    "Finish the Desktop operation before changing preferences.",
  ],
  [
    "Seçimi, var olan Relay hesaplarını birer kez kullanarak yap.",
    "Select existing Relay accounts once each.",
  ],
  [
    "Geçmişini birleştirmeden önce bu Desktop hesabına geç.",
    "Switch to this Desktop account before syncing its history.",
  ],
  [
    "Desktop geçmişi takip verisi geçersiz.",
    "Invalid Desktop history tracking data.",
  ],
  [
    "Koşullar değiştiği için otomatik Desktop geçişi iptal edildi.",
    "Automatic Desktop switch was cancelled because its conditions changed.",
  ],
  [
    "Geçiş sırasında Claude açıldı. Claude’u kapattıktan sonra yedeği geri yükle.",
    "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
  ],
  [
    "Bu profil farklı bir Claude hesabına bağlı. Eşleşen Desktop hesabını seç.",
    "This profile is connected to a different Claude account. Choose the matching Desktop account.",
  ],
  [
    "Bu profil farklı bir Claude kuruluşuna bağlı. Eşleşen Code çalışma alanını seç.",
    "This profile is connected to a different Claude organization. Choose its matching Code workspace.",
  ],
  [
    "Kurulum sırasında Desktop hesabı değişti. Tekrar dene.",
    "Desktop account changed during setup. Try again.",
  ],
  [
    "Bu Desktop profili zaten bağlı.",
    "This Desktop profile is already connected.",
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
    "Claude hâlâ açık. Dosyalar değiştirilmedi.",
    "Claude is still running. No files were changed.",
  ],
  [
    "Desktop kurtarma yedeği bulunamadı.",
    "Desktop recovery backup is missing.",
  ],
  ["Desktop yedeği geçersiz.", "Invalid Desktop backup."],
  ["Kurtarma dosya yolu geçersiz.", "Invalid recovery path."],
  ["Kurtarma verisi geçersiz.", "Invalid recovery data."],
  ["Desktop dosya yolu geçersiz.", "Invalid Desktop path."],
  [
    "Desktop verisinde sembolik bağlantı kullanılamaz.",
    "Desktop data cannot contain symbolic links.",
  ],
  [
    "Desktop dosya boyutu veya türü desteklenmiyor.",
    "Unsupported Desktop file size or type.",
  ],
  ["Desktop veri biçimi desteklenmiyor.", "Unsupported Desktop data format."],
  [
    "Code oturum biçimi tanınmadı. Desktop dosyaları değiştirilmedi.",
    "Unrecognized Code session format. No Desktop files changed.",
  ],
  ["Proje biçimi tanınmadı.", "Unrecognized project format."],
  ["Proje kaydı tanınmadı.", "Unrecognized project record."],
  [
    "Geçişten önce Desktop yedeğinin geri yüklenmesi gerekiyor.",
    "Desktop recovery is required before switching.",
  ],
  [
    "Claude Desktop verisi okunamadı. Dosyalar değiştirilmedi.",
    "Claude Desktop data could not be read. No files were changed.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor.",
    "System encryption is unavailable.",
  ],
  [
    "Claude Code bulunamadı. Resmi native CLI kurulumunu yap veya çalıştırılabilir dosyayı seç.",
    "Claude Code was not found. Install the official native CLI or choose its executable in Settings.",
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
    "Bu Desktop hesabı başka bir profilde kayıtlı.",
    "This Desktop account is already saved in another profile.",
  ],
  [
    "Önce Claude Desktop’ta giriş yap ve Code sekmesini aç.",
    "Open Claude Desktop, sign in and open the Code tab first.",
  ],
  [
    "Önce açık Desktop hesabını bir profile kaydet.",
    "Save the current Desktop account into a profile before adding another account.",
  ],
  [
    "Geçişten önce açık Desktop hesabını kaydet.",
    "Save the current Desktop account before switching.",
  ],
  [
    "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
    "Finish or cancel the current Desktop sign-in first.",
    "Finish or cancel the current Claude app sign-in first.",
  ],
  [
    "Desktop’ta bir işlem devam ediyor.",
    "A Desktop operation is already in progress.",
  ],
  [
    "Bu platformda Claude Desktop bulunamadı.",
    "Claude Desktop was not found on this platform.",
  ],
  [
    "Önce yarım kalan Desktop geçişini geri yükle.",
    "Restore the interrupted Desktop switch first.",
  ],
  [
    "Önce bu hesabı Claude Desktop’ta bağla.",
    "Connect this account in Claude Desktop first.",
  ],
  ["Claude Desktop kurulu değil.", "Claude Desktop is not installed."],
  [
    "Bu profil başka bir Desktop hesabına ait. Yeni bir profil oluştur.",
    "This profile belongs to another Desktop account. Create a new profile.",
  ],
  [
    "Claude kapanmadı. Açık çalışmanı bitirip Claude’u kapattıktan sonra tekrar dene. Dosyalar değiştirilmedi.",
    "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.",
  ],
  [
    "İşletim sistemi şifrelemesi kullanılamıyor. Claude uygulaması girişi kaydedilmedi.",
    "System encryption is unavailable. Desktop sign-in was not saved.",
    "System encryption is unavailable. Claude app sign-in was not saved.",
  ],
];
export function localizeError(message: string, language: "tr" | "en") {
  const pair = pairs.find((p) => p[0] === message || p[1] === message);
  if (!pair) return message;
  return language === "tr" ? pair[0] : (pair[2] ?? pair[1]);
}
