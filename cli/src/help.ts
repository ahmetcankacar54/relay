import type { Translate } from "./i18n";

const LINES: [string, string, string][] = [
  ["relay status", "Claude Desktop, etkin hesap ve Relay'in durumu", "Claude Desktop, the active account and Relay's state"],
  ["relay list", "Kayıtlı hesaplar", "Saved accounts"],
  ["relay add <name>", "Claude Desktop'taki girişi kaydet ya da yeni bir hesapla giriş yap", "Save the Claude Desktop sign-in, or sign a new account in"],
  ["relay switch <name>", "Claude Desktop'u kapatıp <name> hesabıyla yeniden aç", "Quit Claude Desktop and reopen it signed in as <name>"],
  ["relay remove <name>", "Kayıtlı bir hesabı unut", "Forget a saved account"],
  ["relay rename <name> <new>", "Bir hesabın adını değiştir", "Rename an account"],
  ["relay recover", "Yarıda kalan bir geçişi geri al", "Restore an interrupted switch"],
  ["relay history [<name>]", "Code geçmişi paylaşımı; history mode …, history sync", "Code history sharing; history mode …, history sync"],
  ["relay connect <name>", "Limitler için hesabın Claude Code profilini bağla", "Sign the account's Claude Code profile in, for limits"],
  ["relay usage [<name>]", "Kalan 5 saatlik ve haftalık limitler", "Remaining 5-hour and weekly limits"],
  ["relay run <name> [-- …]", "Claude Code'u <name> hesabıyla çalıştır", "Run Claude Code as <name>"],
  ["relay tokens", "Relay.app'in tuttuğu günlük token kullanımı", "Daily token usage recorded by Relay.app"],
  ["relay doctor", "Kurulumu denetle", "Check the setup"],
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
      "Not: Claude Desktop'u kapatan komutlar (switch, add, recover, history sync) Desktop'taki Code oturumlarını da durdurur.",
      "Note: commands that quit Claude Desktop (switch, add, recover, history sync) also stop its Code sessions.",
    ),
  ].join("\n");
}
