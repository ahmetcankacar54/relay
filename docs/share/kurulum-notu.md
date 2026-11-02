Relay 0.14.0 — Claude uygulaması (Claude Desktop) için hesap değiştirici
Gayriresmî, kişisel bir araç; Anthropic ürünü değil.

KURULUM
1) Relay-0.14.0-arm64.dmg, Apple silicon (M1 ve sonrası) Mac’ler içindir.
   Apple menüsü → Bu Mac Hakkında’da "Çip: Apple M…" yazmalı. Intel Mac’in
   varsa söyle, ayrıca hazırlanır. macOS 13 veya üstü gerekir.
2) DMG’yi aç, Relay’i Uygulamalar klasörüne sürükle. DMG’nin içinden çalıştırma.
3) Relay’i aç. "Apple doğrulayamadı" uyarısında "Bitti"ye bas.
4) Sistem Ayarları → Gizlilik ve Güvenlik → aşağıda "Relay engellendi"
   → "Yine de Aç" → Mac parolanı gir. Bu izin her sürüm için bir kez gerekir.
   Her açılışta yeniden soruyorsa Relay DMG’nin içinden ya da İndirilenler’den
   açılıyordur: DMG’yi çıkar (Finder’da ⏏), DMG dosyasını çöpe at ve Relay’i
   yalnızca Uygulamalar klasöründen aç. Relay DMG’den açıldığını fark ederse
   kendini Uygulamalar’a taşımayı önerir. Olmazsa Terminal’de şunu çalıştır:
   xattr -dr com.apple.quarantine /Applications/Relay.app
5) Relay menü çubuğunda panda simgesiyle çalışır; panel oradan açılır.
   Paneldeki "Relay’i aç" ana pencereyi açar.

ÖNCE GENEL BAKIŞ
Genel bakış sayfasındaki "Başlamadan önce" listesi eksikleri gösterir:
• Claude uygulaması: kurulu olmalı.
• Code sekmesi açıldı: "Code’u aç" düğmesi Claude’u Code’da açar. Claude
  uygulaması bu sırada limitleri okumak için gereken Claude Code’u da kendisi
  indirir; ayrıca CLI kurman gerekmez.

HESAP EKLEME
Hesaplar → "Hesap ekle". Üç adım, başta tek onay:
1) Claude girişi: Claude’da açık hesap varsa "Bu hesabı ekle…", yoksa
   "Claude’u giriş ekranıyla aç…". Claude’da o hesapla giriş yap ve Code’u bir
   kez aç; Relay girişi kendisi kaydeder. Claude bu sırada bir ya da iki kez
   yeniden başlar.
2) Limit izni: kendiliğinden başlar ve Relay’in kendi penceresinde açılır.
   O hesapla Claude’a gir ve izin ver. Google ile giriş açılmazsa e-postayla gir
   ya da "Tarayıcıda aç". İstersen "Sonra yap".
3) Hazır: ad, tür ve grup önerilir; değiştirip "Kaydet ve bitir".
Adı ve türü sonra hesabın "…" menüsünden değiştirebilirsin.

ÇIKABİLECEK İSTEMLER
• Anahtar Zinciri: Relay kayıtlı girişlerini "Relay Vault Key" adlı bir
  anahtarla şifreler ve ilk açılışta kendisi oluşturur; genelde soru sormaz.
  Önceki bir Relay sürümünden güncelliyorsan bir kez Mac parolanı isteyebilir.
  Parolanı gir, "Her Zaman İzin Ver"i seç.
• Otomasyon: ilk hesap geçişinde macOS "Relay, Claude'u denetlemek istiyor"
  diye sorabilir. "İzin Ver"i seç; Relay bunu Claude'u kapatıp açmak için kullanır.
• Erişilebilirlik: varsayılan ayarlarla gerekmez. Yalnızca Ayarlar → Otomasyon’da
  "Limit dolunca" ya da Ayarlar → Geçişte taşınanlar’da deneysel taslak yazma
  açılırsa Relay bir düğmeyle ister.

AYARLAR
Bütün ayarlar tek yerde: Ayarlar → Otomasyon, Geçişte taşınanlar (Code
geçmişi, tarayıcı eklentisi, terminal, taslaklar), Planlama, Bildirimler,
Görünüm, Gelişmiş.

BİLMEN GEREKENLER
• Hesap değiştirmek Claude uygulamasını kapatıp yeniden açar. Çalışan bir
  yanıt bitmeden geçme.
• ⌘Q yalnızca Relay penceresini kapatır. Tamamen çıkmak için ⌥⌘Q ya da
  panelde "Çık".

SORUN OLURSA
Relay → Ayarlar → Gelişmiş → Tanılama dosyaları → "Finder’da göster".
Açılan klasörden yalnızca draft-events.json ve usage-issues.json dosyalarını
gönder. Bunlarda yazı, e-posta ya da parola yok; yalnızca kısa hesap
kimlikleri var. Klasörün geri kalanını gönderme; orada kayıtlı girişlerin var.
