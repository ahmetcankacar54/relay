/**
 * The only web pages Relay opens in the browser. The main window opens a link (an
 * `<a target="_blank">`) with `shell.openExternal` only when it is one of these, word for word.
 */
export const EXTERNAL_LINKS = {
  claudeDownload: "https://claude.ai/download",
  cliSetup: "https://docs.anthropic.com/en/docs/claude-code/setup",
} as const;

const allowed: readonly string[] = Object.values(EXTERNAL_LINKS);

export const isExternalLink = (url: string) => allowed.includes(url);
