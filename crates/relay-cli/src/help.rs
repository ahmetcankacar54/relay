//! Port of `cli/src/help.ts`.

use relay_i18n::{Args, Locale};

use crate::i18n::T;
use crate::output::{js_len, pad_end};

const LINES: &[(&str, &str)] = &[
    ("relay status", "help.theClaudeAppTheOpenAccount"),
    ("relay list", "extensionPreference.savedAccounts"),
    ("relay add <name>", "help.saveTheClaudeAppSignIn"),
    ("relay switch <name>", "help.quitTheClaudeAppAndReopen"),
    ("relay remove <name>", "help.forgetASavedAccount"),
    ("relay rename <name> <new>", "help.renameAnAccount"),
    ("relay recover", "help.restoreTheBackupOfAnInterrupted"),
    (
        "relay history [<name>]",
        "help.codeHistorySharingHistoryMode",
    ),
    ("relay connect <name>", "help.signInToReadTheAccount"),
    ("relay usage [<name>]", "help.howMuchOfThe5Hour"),
    ("relay run <name> [-- …]", "help.runClaudeCodeAs"),
    ("relay tokens", "help.dailyTokenUsageRecordedByRelay"),
    (
        "relay proxy [start|status|env]",
        "help.localGatewayThatSpreadsRequestsOver",
    ),
    (
        "relay statusline [install|uninstall]",
        "help.accountAndLimitsInClaudeCode",
    ),
    ("relay doctor", "help.checkTheSetup"),
    ("relay reset-vault", "help.startTheSignInVaultOver"),
];

pub fn help_text(t: T) -> String {
    let width = LINES.iter().map(|(c, _)| js_len(c)).max().unwrap_or(0);
    let locales = Locale::ALL
        .iter()
        .map(|l| l.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let mut lines = vec![
        t.t("help.usageRelayCommandOptions"),
        String::new(),
        t.t("help.commands"),
    ];
    for (command, id) in LINES {
        lines.push(format!("  {}  {}", pad_end(command, width), t.t(id)));
    }
    lines.extend([
        String::new(),
        t.t("help.options"),
        format!("  --yes, -y        {}", t.t("help.goAheadWithoutAsking")),
        format!(
            "  --json           {}",
            t.t("help.jsonOutputForReadCommands")
        ),
        format!(
            "  --lang <code>    {}",
            t.f("help.language", Args::new().set("locales", locales))
        ),
        format!("  --no-color       {}", t.t("help.noColors")),
        format!("  --version, -v    {}", t.t("help.version")),
        String::new(),
        t.t("help.noteCommandsThatQuitTheClaude"),
    ]);
    lines.join("\n")
}
