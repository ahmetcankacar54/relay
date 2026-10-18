# Relay CLI

[English](README.md)

Relay, resmî Claude masaüstü uygulamasını terminalden kayıtlı hesaplar arasında geçirir. Menü
çubuğundaki Relay uygulamasıyla aynı geçişi yapar:
1. Claude Desktop'u kapatır;
2. Claude'un giriş dosyalarını değiştirir;
3. Code sekmesinin geçmişini hesaplar arasında taşır;
4. Claude'u yeniden açar.

Ayrıca her hesabın kalan limitlerini gösterebilir ve Claude Code'u istediğiniz hesapla
çalıştırabilir.

Relay resmî değildir; Anthropic ile bağlantılı değildir ve Anthropic tarafından onaylanmamıştır.
Claude Desktop'un yerel dosyalarını değiştirdiği için bir Claude Desktop güncellemesi onu
bozabilir.

> **Uyarı:** bazı komutlar Claude Desktop'u kapatır:
> - `relay switch`
> - `relay add`
> - `relay recover`
> - `relay history sync`
>
> Claude kapanınca içinde çalışan tüm Code oturumları durur. Terminal Claude Desktop'un içindeyse
> bu terminal de kapanır. Relay önce sorar; betiklerde `--yes` ekleyin.

## Gerekenler

- macOS
- Node.js 22.12 veya üstü
- Claude Desktop (`/Applications/Claude.app` ya da `~/Applications/Claude.app`)
- Limitler ve `relay run` için Claude Code CLI 2.1.296 veya üstü

## Kurulum

```bash
npm i -g @ahmetcankacar/relay
```

## İlk hesap

Claude Desktop'u açın, giriş yapın ve Code sekmesini bir kez açın. Sonra o hesabı kaydedin:

```bash
relay add Kişisel
```

Claude kısa bir süre kapanıp açılır. Hesabın birden çok Code çalışma alanı varsa Relay hangisinin
kaydedileceğini sorar; isterseniz `--org <kimlik>` ile de verebilirsiniz. İş hesabı için `--work`
ekleyin. Aynı şirketin diğer iş hesaplarıyla Code geçmişini paylaşmak için `--group <ad>` ekleyin.

## Başka hesaplar

```bash
relay add İş --new --work --group Acme
```

Relay, Claude'u giriş ekranında açıp bekler:
1. Diğer hesapla giriş yapın.
2. Code sekmesini bir kez açın.
3. Relay hesabı kaydeder.

Ctrl+C beklemeyi bırakır ama giriş yarım kalır. Sonra:
- `relay add --resume` ile bitirebilirsiniz;
- `relay add --cancel` ile önceki hesaba dönebilirsiniz.

## Geçiş

```bash
relay switch İş
```

Code geçmişi, geçmiş moduna göre taşınır:
- `same-group` (varsayılan): her grubun içinde paylaşılır; kişisel hesaplar da kendi aralarında
  paylaşır.
- `all`: tüm hesaplar arasında paylaşılır.
- `selected`: seçtiğiniz hesaplar arasında paylaşılır.
- `off`: hiç paylaşılmaz.

Claude'daki gönderilmemiş taslakları CLI taşımaz; Claude yeniden açılınca silinebilirler.

## Limitler

Her hesabın kendi Claude Code girişi bir kez gerekir:

```bash
relay connect İş        # Claude Code girişini tarayıcıda açar
relay usage             # kalan 5 saatlik ve haftalık limitler
```

Yüzdeler kalanı gösterir: `%6 kaldı · 2 sa 10 dk sonra yenilenir`. Haftalık limit bildirmeyen
Team koltukları "limit bildirilmedi" diye görünür.

## Claude Code'u bir hesapla çalıştırmak

```bash
relay run İş -- --resume
```

Bu komut `claude`'u hesabın kendi profiliyle (`CLAUDE_CONFIG_DIR`) bulunduğunuz klasörde
başlatır. Claude Desktop'a dokunulmaz. `--` sonrasındaki her şey `claude`'a gider.

## Token kullanımı

```bash
relay tokens --days 30
```

Hesap başına günlük token kullanımını gösterir. Bu kaydı Relay.app, uygulama açıkken tutar; CLI
yalnız okur. `≈` işaretli değerler limit ölçümlerinden tahmin edilmiştir.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `relay status [--json]` | Claude Desktop, etkin hesap, yarım işler, Relay.app ve kilit. |
| `relay list [--json]` (`ls`) | Kayıtlı hesaplar; `*` etkin olanı gösterir. |
| `relay add <ad> [--work [--group <g>]] [--org <kimlik>] [--new] [--yes]` | Açık girişi kaydet ya da yeni bir hesapla giriş yap. |
| `relay add --resume` / `--cancel` | Yarım kalan girişi bitir ya da iptal et. |
| `relay switch <ad> [--yes]` | Claude Desktop'u kapatıp `<ad>` hesabıyla yeniden aç. |
| `relay remove <ad> [--yes]` | Bir hesabı unut; Claude Desktop'un kendi verisine dokunulmaz. |
| `relay rename <ad> <yeni-ad>` | Hesabın adını değiştir. |
| `relay recover [--yes]` | Yarıda kalan bir geçişi yedeğinden geri al. |
| `relay history [<ad>] [--json]` | Bir hesabın hangi hesaplardan Code geçmişi aldığı. |
| `relay history mode <all\|same-group\|selected\|off> [--accounts a,b]` | Code geçmişinin nasıl paylaşılacağı. |
| `relay history sync [<ad>] [--yes]` | Code geçmişini etkin hesaba şimdi taşı. |
| `relay connect <ad>` | Limitler ve `run` için hesabın Claude Code profilini bağla. |
| `relay usage [<ad>] [--json]` | Kalan limitler. |
| `relay run <ad> [-- <claude seçenekleri>]` | Claude Code'u `<ad>` hesabıyla çalıştır. |
| `relay tokens [--days 7\|30\|90] [--account <ad>] [--json]` | Relay.app'in tuttuğu günlük token kullanımı. |
| `relay doctor [--json]` | Kurulumu denetle. |
| `relay reset-vault [--yes]` | Keychain anahtarı kaybolduysa kasayı baştan başlat. |

Hesap adlarında büyük/küçük harf fark etmez. `İ`, `I` ve `ı` aynı harf sayılır. Adın ya da hesap
kimliğinin tek bir hesaba uyan başı da yeterlidir.

Bu seçenekler her komutta çalışır:
- `--yes` (`-y`)
- `--lang tr|en`. Verilmezse Relay önce `RELAY_LANG`'e, sonra sistem diline bakar.
- `--no-color`
- `--version`
- `--help`

## Çıkış kodları

| Kod | Anlamı |
|---|---|
| 0 | Tamamlandı ya da yapılacak bir şey yok |
| 1 | İşlem başarısız oldu |
| 2 | Yanlış kullanım, ya da bilinmeyen veya belirsiz bir hesap adı |
| 3 | Meşgul ya da engelli: başka bir Relay geçiş yapıyor, yarım bir giriş var, ya da bir geçiş geri alınmalı |
| 4 | Onay gerekiyor: terminal yok ve `--yes` verilmedi |
| 5 | Ortam sorunu: macOS değil, eski bir Relay.app, okunamayan Keychain öğesi, sandbox ya da Otomasyon izni yok |

## Relay.app ile birlikte

CLI ve Relay.app aynı veri klasörünü (`~/Library/Application Support/Relay`) ve aynı hesap
listesini kullanır.

- Relay.app 0.12 veya üstü olmalıdır. Güncelledikten sonra uygulamayı bir kez açın; kasasını CLI'nin
  okuduğu biçime taşır.
- Daha eski bir Relay.app varken CLI yalnız okur.
- İkisi aynı kilidi alır, bu yüzden Claude'u hiçbir zaman aynı anda kapatmazlar. Biri meşgulken
  diğeri bunu söyler ve 3 koduyla çıkar.

## Claude Desktop'un içinden çalıştırmak

`relay switch`'i Claude Desktop'taki bir Code oturumunun terminalinde çalıştırabilir ya da Claude'a
çalıştırtabilirsiniz. Relay bunu fark eder ve oturumun da kapanacağını söyleyip önce sorar. Sonra
geçişi, Claude kapanınca ölmeyecek ayrı bir sürece devreder. Claude yeniden açılınca sonucu
`relay status` gösterir.

Korumalı alanda (sandbox) çalışan bir oturumda bunu yapamaz; normal bir terminal kullanmanızı
ister.

## Otomasyon izni

Bir terminal uygulaması Claude'u ilk kez kapatırken macOS, o uygulamanın Claude'u kontrol edip
edemeyeceğini sorar. Reddettiyseniz buradan izin verin: Sistem Ayarları → Gizlilik ve Güvenlik →
Otomasyon → terminal uygulamanız → Claude.

SSH oturumunda masaüstü olmadığı için Relay oradan Claude'u kapatıp açamaz.

## Güvenlik

**Kayıtlı Claude Desktop girişleri ve geçiş yedekleri**
`~/Library/Application Support/Relay/desktop-vault` içinde durur.
- AES-256-GCM ile şifrelenirler.
- Anahtar, oturum anahtar zincirinizde (Keychain) "Relay Vault Key" adlı öğededir.
- Relay anahtarı `/usr/bin/security` ile okur. Claude Code CLI kendi girişini de böyle korur: Mac'teki
  diğer kullanıcılar ve çalınmış, kapalı bir disk okuyamaz, ama sizin hesabınızda çalışan her
  program okuyabilir.

**Klasörler ve dosyalar** yalnız size açıktır (0700 ve 0600); sembolik bağlantılar reddedilir.

**Asla yazdırılmayan ya da kaydedilmeyenler:** tokenlar, çerezler, giriş anahtarı değerleri ve
Keychain çıktısı. Bu `--json`'da da geçerlidir.

**Ağ:** Relay yalnız limitleri okumak için `api.anthropic.com`'a bağlanır. Telemetri göndermez,
güncelleme denetimi yapmaz.

## Keychain anahtarı kaybolursa

"Relay Vault Key" öğesi anahtar zincirinizden silinirse kayıtlı girişler artık açılamaz. Bu, örneğin
macOS yeni bir oturum anahtar zinciri oluşturduğunda olabilir. Relay bu durumda geçiş yapmayı
reddeder ve nedenini söyler.

`relay reset-vault` baştan başlatır:
1. Eski dosyaları `desktop-vault/lost-key-…` klasörüne ayırır; hiçbir şey silinmez.
2. Yeni bir anahtar oluşturur.
3. Hesapların Claude Desktop bağlantılarını temizler.

Sonra her hesabı, Claude Desktop'ta o hesap açıkken `relay add <ad>` ile yeniden kaydedin.

## Kaldırma

```bash
npm rm -g @ahmetcankacar/relay
```

Relay.app da kurulu değilse veriyi de silebilirsiniz. Bu, kayıtlı tüm girişleri siler:

```bash
security delete-generic-password -s "Relay Vault Key"
```

```bash
rm -rf ~/Library/Application\ Support/Relay
```

## Lisans

MIT
