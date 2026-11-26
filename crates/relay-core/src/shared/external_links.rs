//! Port of `shared/external-links.ts`: the only web pages Relay opens in the browser. The main
//! window opens a link only when it is one of these, word for word.

pub const CLAUDE_DOWNLOAD: &str = "https://claude.ai/download";
pub const CLI_SETUP: &str = "https://docs.anthropic.com/en/docs/claude-code/setup";
/// Anthropic's rules for Claude sign-ins in other tools, linked from the gateway's note.
pub const CLAUDE_TERMS: &str =
    "https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use";
/// Google's FAQ on Antigravity sign-ins in other software.
pub const ANTIGRAVITY_TERMS: &str = "https://antigravity.google/docs/faq";
/// Anthropic's Usage Policy (in force from 12 November 2026), cited by the risk notes.
pub const ANTHROPIC_AUP: &str = "https://www.anthropic.com/legal/aup";
/// Google Antigravity's terms of service, cited by the Antigravity risk notes.
pub const ANTIGRAVITY_SERVICE_TERMS: &str = "https://antigravity.google/terms";
/// OpenAI's page on signing in to other apps with ChatGPT, cited by the Codex risk notes.
pub const OPENAI_SIGN_IN: &str = "https://help.openai.com/en/articles/20001542";
/// GitHub's terms of service (section J covers Copilot).
pub const GITHUB_TERMS: &str =
    "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service";
/// Gemini CLI's FAQ on third-party software using its sign-in.
pub const GEMINI_CLI_FAQ: &str = "https://geminicli.com/docs/resources/faq/";
/// Cursor's terms of service (§1.5 on extracting data from the service).
pub const CURSOR_TERMS: &str = "https://cursor.com/terms-of-service";
/// System Settings › Privacy & Security › Full Disk Access, on macOS.
pub const FULL_DISK_ACCESS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/// `EXTERNAL_LINKS`, by its TS key, in declaration order.
pub const EXTERNAL_LINKS: [(&str, &str); 11] = [
    ("claudeDownload", CLAUDE_DOWNLOAD),
    ("cliSetup", CLI_SETUP),
    ("claudeTerms", CLAUDE_TERMS),
    ("antigravityTerms", ANTIGRAVITY_TERMS),
    ("anthropicAup", ANTHROPIC_AUP),
    ("antigravityServiceTerms", ANTIGRAVITY_SERVICE_TERMS),
    ("openaiSignIn", OPENAI_SIGN_IN),
    ("githubTerms", GITHUB_TERMS),
    ("geminiCliFaq", GEMINI_CLI_FAQ),
    ("cursorTerms", CURSOR_TERMS),
    ("fullDiskAccess", FULL_DISK_ACCESS),
];

/// Whether `url` is one of `EXTERNAL_LINKS`, word for word.
pub fn is_external_link(url: &str) -> bool {
    EXTERNAL_LINKS.iter().any(|(_, link)| *link == url)
}
