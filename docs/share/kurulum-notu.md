Relay 0.12.0 — Claude uygulaması (Claude Desktop) için hesap değiştirici
Gayriresmî, kişisel bir araç; Anthropic ürünü değil.

KURULUM
1) Apple menüsü → Bu Mac Hakkında’ya bak:
   • "Çip: Apple M…" yazıyorsa (M1–M4, Apple silicon): Relay-0.12.0-arm64.dmg
   • "İşlemci: Intel" yazıyorsa: Relay-0.12.0-x64.dmg
   macOS 13 veya üstü gerekir.
2) DMG’yi aç, Relay’i Uygulamalar klasörüne sürükle. DMG’nin içinden çalıştırma.
3) Relay’i aç. "Apple doğrulayamadı" uyarısında "Bitti"ye bas.
4) Sistem Ayarları → Gizlilik ve Güvenlik → aşağıda "Relay engellendi"
   → "Yine de Aç" → Mac parolanı gir. Her yeni sürümde tekrar gerekebilir.
   Olmazsa Terminal’de şunu çalıştırıp Relay’i yeniden aç:
   xattr -dr com.apple.quarantine /Applications/Relay.app
5) Relay menü çubuğunda panda simgesiyle çalışır; panel oradan açılır.
   Paneldeki "Relay’i aç" ana pencereyi açar.

ÖNCE GENEL BAKIŞ
Genel bakış sayfasındaki "Başlamadan önce" listesi eksikleri gösterir:
• Claude uygulaması: kurulu olmalı.
• Claude Code CLI: limitleri okumak için gerekir. Terminal’de
  claude --version 2.1.296 veya üstünü göstermeli.
• Code sekmesi açıldı: Claude uygulamasında ilk hesabınla giriş yap ve sol
  menüden Code’u bir kez aç.
Üçü de tamamlanınca liste kaybolur.

HESAP EKLEME
1) Relay → Hesaplar → "Hesap ekle": ad ve tür (Kişisel / Şirket) seç,
   "Profil oluştur".
2) "Claude uygulaması girişi": ilk hesapta "Bu hesabı eşleştir…" Claude
   uygulamasında açık olan hesabı kaydeder. Sonraki hesaplarda "Claude
   uygulaması girişini başlat…" giriş ekranını açar; o hesapla giriş yap,
   Relay’e dönüp bağlantıyı kaydet. İkisi de Claude uygulamasını yeniden başlatır.
3) "Limit okuma girişi": "Limit okuma girişi yap" ile tarayıcıda aynı hesapla
   giriş yap (Claude Code CLI 2.1.296 veya üstü gerekir). Bu adımı atlayıp
   sonra da yapabilirsin.

ÇIKABİLECEK İSTEMLER
• Anahtar Zinciri: Relay kayıtlı girişlerini "Relay Vault Key" adlı bir
  anahtarla şifreler ve ilk açılışta kendisi oluşturur; genelde soru sormaz.
  Önceki bir Relay sürümünden güncelliyorsan bir kez "Relay Safe Storage" için
  Mac parolanı isteyebilir. Parolanı gir, "Her Zaman İzin Ver"i seç.
• Otomasyon: ilk hesap geçişinde macOS "Relay, Claude'u denetlemek istiyor"
  diye sorabilir. "İzin Ver"i seç; Relay bunu Claude'u kapatıp açmak için kullanır.
• Erişilebilirlik: varsayılan ayarlarla gerekmez. Yalnızca Geçiş sayfasında
  deneysel "Taslakları Claude uygulamasına yeniden yaz" ayarını ya da Otomatik
  geçiş → "Kota dolunca" seçeneğini açarsan Relay bir düğmeyle ister.
  Bunları kullanmayacaksan izin verme.

CODE GEÇMİŞİ VE TASLAKLAR
• Code geçmişi varsayılan olarak paylaşım grubunda kalır: kişisel hesaplar
  kendi aralarında paylaşır, bir şirket hesabı yalnızca eklerken aynı paylaşım
  grubunu seçtiğin hesaplarla. İş ve kişisel konuşmalar karışmaz. Tüm
  hesaplarda görmek istersen: Geçiş → Ortak Code geçmişi → "Geçmişi paylaş"
  → "Tüm hesaplar arasında".
• Geçişte Claude uygulamasında gönderilmemiş taslakların kurtarılır ve panelde
  "Kopyala" ile sunulur. Onları Claude uygulamasına geri yazan ayar deneyseldir
  ve kapalıdır.

BİLMEN GEREKENLER
• Hesap değiştirmek Claude uygulamasını kapatıp yeniden açar. Çalışan bir
  yanıt bitmeden geçme.
• ⌘Q yalnızca Relay penceresini kapatır. Tamamen çıkmak için ⌥⌘Q ya da
  panelde "Çık".

SORUN OLURSA
Relay → Ayarlar → Teknik bilgiler → "Tanılama dosyalarını göster".
Açılan klasörden yalnızca draft-events.json ve usage-issues.json dosyalarını
gönder. Bunlarda yazı, e-posta ya da parola yok; yalnızca kısa hesap
kimlikleri var. Klasörün geri kalanını gönderme; orada kayıtlı girişlerin var.
