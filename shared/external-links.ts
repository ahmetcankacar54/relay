/**
 * The only web pages Relay opens in the browser. The main window opens a link (an
 * `<a target="_blank">`) with `shell.openExternal` only when it is one of these, word for word.
 */
export const EXTERNAL_LINKS = {
  claudeDownload: "https://claude.ai/download",
  cliSetup: "https://docs.anthropic.com/en/docs/claude-code/setup",
  /** Anthropic's rules for Claude sign-ins in other tools, linked from the gateway's note. */
  claudeTerms: "https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use",
  /** Google's FAQ on Antigravity sign-ins in other software, linked from the pool's Antigravity note. */
  antigravityTerms: "https://antigravity.google/docs/faq",
  /** Anthropic's Usage Policy (in force from 12 November 2026), cited by the risk notes. */
  anthropicAup: "https://www.anthropic.com/legal/aup",
  /** Google Antigravity's terms of service, cited by the Antigravity risk notes. */
  antigravityServiceTerms: "https://antigravity.google/terms",
  /** OpenAI's page on signing in to other apps with ChatGPT, cited by the Codex risk notes. */
  openaiSignIn: "https://help.openai.com/en/articles/20001542",
  /** System Settings › Privacy & Security › Full Disk Access, on macOS. */
  fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
} as const;

const allowed: readonly string[] = Object.values(EXTERNAL_LINKS);

export const isExternalLink = (url: string) => allowed.includes(url);
