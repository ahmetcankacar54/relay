import { LOCALES } from "../../shared/i18n/locales";
import type { MessageId, T } from "../../shared/i18n/translate";

const LINES: [string, MessageId][] = [
  ["relay status", "help.theClaudeAppTheOpenAccount"],
  ["relay list", "extensionPreference.savedAccounts"],
  ["relay add <name>", "help.saveTheClaudeAppSignIn"],
  ["relay switch <name>", "help.quitTheClaudeAppAndReopen"],
  ["relay remove <name>", "help.forgetASavedAccount"],
  ["relay rename <name> <new>", "help.renameAnAccount"],
  ["relay recover", "help.restoreTheBackupOfAnInterrupted"],
  ["relay history [<name>]", "help.codeHistorySharingHistoryMode"],
  ["relay connect <name>", "help.signInToReadTheAccount"],
  ["relay usage [<name>]", "help.howMuchOfThe5Hour"],
  ["relay run <name> [-- …]", "help.runClaudeCodeAs"],
  ["relay tokens", "help.dailyTokenUsageRecordedByRelay"],
  ["relay proxy [start|status|env]", "help.localGatewayThatSpreadsRequestsOver"],
  ["relay doctor", "help.checkTheSetup"],
  ["relay reset-vault", "help.startTheSignInVaultOver"],
];

export function helpText(t: T): string {
  const width = Math.max(...LINES.map(([command]) => command.length));
  return [
    t("help.usageRelayCommandOptions"),
    "",
    t("help.commands"),
    ...LINES.map(([command, id]) => `  ${command.padEnd(width)}  ${t(id)}`),
    "",
    t("help.options"),
    `  --yes, -y        ${t("help.goAheadWithoutAsking")}`,
    `  --json           ${t("help.jsonOutputForReadCommands")}`,
    `  --lang <code>    ${t("help.language", { locales: LOCALES.join(", ") })}`,
    `  --no-color       ${t("help.noColors")}`,
    `  --version, -v    ${t("help.version")}`,
    "",
    t("help.noteCommandsThatQuitTheClaude"),
  ].join("\n");
}
