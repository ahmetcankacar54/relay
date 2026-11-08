import type { Translate } from "./i18n";

const LINES: [string, string, string][] = [
  ["relay status", "Claude uygulamasının, açık hesabın ve Relay’in durumu", "The Claude app, the open account and Relay’s state"],
  ["relay list", "Kayıtlı hesaplar", "Saved accounts"],
  ["relay add <name>", "Claude uygulamasındaki girişi kaydet ya da yeni bir hesapla giriş yap", "Save the Claude app sign-in, or sign in with a new account"],
  ["relay switch <name>", "Claude uygulamasını kapatıp <name> hesabıyla yeniden aç", "Quit the Claude app and reopen it signed in as <name>"],
  ["relay remove <name>", "Kayıtlı bir hesabı unut", "Forget a saved account"],
  ["relay rename <name> <new>", "Bir hesabın adını değiştir", "Rename an account"],
  ["relay recover", "Yarıda kalan geçişin yedeğini geri yükle", "Restore the backup of an interrupted switch"],
  ["relay history [<name>]", "Code geçmişi paylaşımı; history mode …, history sync", "Code history sharing; history mode …, history sync"],
  ["relay connect <name>", "Hesabın limit okuma girişini yap ya da yenile", "Sign in to read the account’s usage, or renew it"],
  ["relay usage [<name>]", "5 saatlik ve haftalık limitlerin ne kadarı kullanıldı", "How much of the 5-hour and weekly limits is used"],
  ["relay run <name> [-- …]", "Claude Code’u <name> hesabıyla çalıştır", "Run Claude Code as <name>"],
  ["relay tokens", "Relay.app’in tuttuğu günlük token kullanımı", "Daily token usage recorded by Relay.app"],
  ["relay proxy [start|status|env]", "Hesapları sırayla kullanan yerel ağ geçidi (--port, --host)", "Local gateway that spreads requests over the accounts (--port, --host)"],
  ["relay doctor", "Kurulumu denetle", "Check the setup"],
  ["relay reset-vault", "Anahtarlık’taki anahtar kaybolduysa kayıtlı girişlerin kasasını sıfırla", "Start the sign-in vault over when its Keychain key is lost"],
];

export function helpText(t: Translate): string {
  const width = Math.max(...LINES.map(([command]) => command.length));
  return [
    t("Kullanım: relay <komut> [seçenekler]", "Usage: relay <command> [options]"),
    "",
    t("Komutlar:", "Commands:"),
    ...LINES.map(([command, tr, en]) => `  ${command.padEnd(width)}  ${t(tr, en)}`),
    "",
    t("Seçenekler:", "Options:"),
    `  --yes, -y        ${t("Onay sormadan devam et", "Go ahead without asking")}`,
    `  --json           ${t("Okuma komutlarında JSON çıktı", "JSON output for read commands")}`,
    `  --lang tr|en     ${t("Dil", "Language")}`,
    `  --no-color       ${t("Renksiz çıktı", "No colors")}`,
    `  --version, -v    ${t("Sürüm", "Version")}`,
    "",
    t(
      "Not: Claude uygulamasını kapatan komutlar (switch, add, recover, history sync) uygulamadaki Code oturumlarını da durdurur.",
      "Note: commands that quit the Claude app (switch, add, recover, history sync) also stop its Code sessions.",
    ),
  ].join("\n");
}
