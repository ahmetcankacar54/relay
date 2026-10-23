# Relay copy glossary

One name for each thing and one verb for each action, in Turkish and English. Turkish copy always
uses "sen". English uses curly apostrophes (’).

## Things

| Thing | Türkçe | English | Notes |
| --- | --- | --- | --- |
| Claude Desktop | Claude uygulaması | the Claude app | Never "Desktop" or "Claude Desktop" on screen. The only exception is the technical details row in Settings, which names the product as "Claude Desktop". |
| The Claude app’s saved sign-in | Claude uygulaması girişi | Claude app sign-in | What a switch puts back into the Claude app. |
| The CLI sign-in Relay reads limits with | Limit okuma girişi | usage sign-in | Approved once in the browser. |
| A Relay account | hesap | account | "Profil" only where the Claude app account and the Relay profile must be told apart. |
| A switch backup | yedek | backup | |
| What a limit is called | limit | limit, quota | Never "kota" in Turkish. A window that is used up is "limit dolu" / "Limit doldu"; never "kotasız" (it reads as "unlimited"). |
| A 5-hour or weekly window | dönem | period | "5 saatlik dönem". |
| Claude Code tokens priced at API list prices | API karşılığı | API value | One name on every usage card, chart and tooltip; never "API değeri" or "Ücret karşılığı". |
| The prompt Relay copies to rebuild Code sidebar sections | talimat | recipe | "Talimatı kopyala"; never "tarif". |
| Starting a limit period ahead of work | önceden başlatma | early start | Never "ısıtma" / "warm-up" on screen. |
| A label Claude itself shows | Claude’s own words | Claude’s own words | Quoted exactly as Claude shows it, in both languages: “Auto-continue when limits reset”, “Auto”, “Manual”. |

## Actions

Each action keeps one name everywhere it appears: banners, the Accounts table and its ⋯ menu, the
account sheet, the panel and the usage card.

| Action | What it does | Türkçe | English |
| --- | --- | --- | --- |
| Switch | Restarts the Claude app on another account | Geç | Switch |
| Switch and continue | When the limit is reached, switches and continues the stopped Code conversations | Limit dolunca geç ve devam et (mode card: Limit dolunca) | Switch and continue when the limit is reached (mode card: When the limit is reached) |
| Add an account | Opens the add-account dialog | Hesap ekle | Add account |
| Open the Claude app | Brings the Claude app forward, or opens it | Claude uygulamasını aç | Open the Claude app |
| Renew the usage sign-in | Opens the browser sign-in for the CLI that reads limits | Limit okuma girişini yenile | Renew usage sign-in |
| First usage sign-in | The same, when the account has none yet | Limit okuma girişi yap | Sign in to read usage |
| Allow a renewal | Re-reads the saved usage sign-in and lets macOS ask for permission (no browser) | Yenilemeye izin ver | Allow renewal |
| Allow the Keychain | The same, when the Keychain is locked | Anahtarlık erişimine izin ver | Allow Keychain access |
| Refresh limits | Reads the limits again, never prompts | Limitleri yenile | Refresh limits |
| Save the Claude app sign-in | Saves the account open in the Claude app into a profile | Claude uygulaması girişini kaydet | Save Claude app sign-in |
| Renew the Claude app sign-in | Signs the Claude app in again and saves the new sign-in | Claude uygulaması girişini yenile… | Renew Claude app sign-in… |
| Restore the backup | Puts an interrupted switch back | Yedeği geri yükle | Restore backup |

## Statuses

The Accounts table, the Overview, the panel and the account sheet read one status per account
(`accountHealth`), so the same account never reads "Hazır" in one place and "Limit verisi eski" in
another.

| Status | Türkçe | English |
| --- | --- | --- |
| Limits read and current | Hazır | Ready |
| The last read failed or is old | Limit verisi eski | Usage data is out of date |
| The saved usage sign-in needs a renewal | Bağlantı yenilenmeli | Connection needs renewing |

## Phrases

| Avoid | Use |
| --- | --- |
| ilgi bekliyor | dikkat istiyor |
| en uygun önce | en uygunu üstte |
| Açılış 14:00 | 14:00’te açılır (a full window that opens again) |
| Sıfırlanma 14:00, 14:00’te sıfırlanır | 14:00’te yenilenir (a period that resets) |
| güncellendi 5 dk önce | 5 dk önce güncellendi |
| kota, kotasız | limit, limit dolu |
| ısıtma, ısıtır | önceden başlatma, önceden başlatır |
| tarif | talimat |
| API değeri, Ücret karşılığı | API karşılığı |
| Eski veri, Veri eski | Limit verisi eski |
| Claude’u aç, Claude’u öne getir | Claude uygulamasını aç |
| bağlantıyı kaydet (Claude app sign-in) | girişi kaydet, Claude uygulaması girişini kaydet |
| hf (week) | hafta |
