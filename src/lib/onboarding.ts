import type { Account, DesktopState, Diagnostics } from "../../shared/types";
import { MIN_CLI_VERSION, meetsCliMinimum } from "../../shared/cli-version";

type T = (tr: string, en: string) => string;

/** What Relay knows of the Claude Code CLI; "unknown" until the first snapshot. */
export type CliState = "unknown" | "ok" | "missing" | "unreadable" | "outdated";

export function cliState(diagnostics?: Diagnostics): CliState {
  if (!diagnostics) return "unknown";
  if (!diagnostics.executable) return "missing";
  if (diagnostics.error || !diagnostics.version) return "unreadable";
  // The same version gate as `supportsDesktop`, without its platform part.
  return meetsCliMinimum(diagnostics.version) ? "ok" : "outdated";
}

/** The CLI cannot sign in or read limits: say so instead of starting a sign-in. */
export const cliBlocked = (state: CliState) =>
  state !== "ok" && state !== "unknown";

/** The short status next to "Claude Code CLI": the version found, or what is wrong. */
export function cliDetail(state: CliState, version: string | undefined, t: T) {
  switch (state) {
    case "missing":
      return t("Bulunamadı", "Not found");
    case "unreadable":
      return t("Sürümü okunamadı", "Its version couldn’t be read");
    case "outdated":
      return t(
        `${version} · ${MIN_CLI_VERSION} veya üstü gerekir`,
        `${version} · needs ${MIN_CLI_VERSION} or later`,
      );
    default:
      return version ?? "";
  }
}

/**
 * Whether Code has been opened in the Claude app: the current sign-in has a workspace folder.
 * With no account signed in (a sign-in in progress), a saved Claude app sign-in shows one
 * existed, since saving it needs one.
 */
export function codeTabOpened(
  desktop: DesktopState,
  accounts: readonly Account[],
) {
  return (
    desktop.organizations.length > 0 ||
    (!desktop.currentAccountUuid && accounts.some((a) => !!a.desktop))
  );
}

export type PrerequisiteKey = "desktop" | "cli" | "code";

export interface Prerequisites {
  items: { key: PrerequisiteKey; met: boolean }[];
  cli: CliState;
  complete: boolean;
}

/** The Overview checklist; undefined until both snapshots have arrived. */
export function prerequisites(input: {
  desktop?: DesktopState;
  diagnostics?: Diagnostics;
  accounts: readonly Account[];
}): Prerequisites | undefined {
  const { desktop, diagnostics, accounts } = input;
  if (!desktop || !diagnostics) return;
  const cli = cliState(diagnostics);
  const items: Prerequisites["items"] = [
    { key: "desktop", met: desktop.available },
    { key: "cli", met: cli === "ok" },
    { key: "code", met: codeTabOpened(desktop, accounts) },
  ];
  return { items, cli, complete: items.every((i) => i.met) };
}

/** Why an onboarding button is disabled; "loading" lasts one snapshot and has no words. */
export type Block =
  | "loading"
  | "no-desktop"
  | "recovery"
  | "pending"
  | "busy"
  | "limit"
  | "all-linked";

/** The Claude app lock shared by every button that starts a Claude app sign-in. */
export function desktopBlock(state: {
  desktop?: DesktopState;
  desktopBusy: boolean;
  pendingDesktop?: unknown;
}): Block | undefined {
  if (!state.desktop) return "loading";
  if (!state.desktop.available) return "no-desktop";
  if (state.desktop.recoveryRequired) return "recovery";
  if (state.pendingDesktop) return "pending";
  if (state.desktopBusy) return "busy";
}

export function blockReason(block: Block | undefined, t: T) {
  switch (block) {
    case "no-desktop":
      return t(
        "Claude uygulaması bulunamadı; önce onu kur.",
        "The Claude app wasn’t found; install it first.",
      );
    case "recovery":
      return t(
        "Önce Claude uygulaması yedeğini geri yükle.",
        "Restore the Claude app backup first.",
      );
    case "pending":
      return t(
        "Önce devam eden Claude uygulaması girişini tamamla veya iptal et.",
        "Finish or cancel the current Claude app sign-in first.",
      );
    case "busy":
      return t(
        "Claude uygulamasında bir işlem sürüyor.",
        "A Claude app operation is in progress.",
      );
    case "limit":
      return t("En fazla 50 hesap eklenebilir.", "You can add up to 50 accounts.");
    case "all-linked":
      return t(
        "Her profilin Claude uygulaması girişi kayıtlı.",
        "Every profile already has a Claude app sign-in.",
      );
  }
}

/** The Code-tab step, where a workspace folder is needed and none exists yet. */
export const codeTabStep = (t: T) =>
  t(
    "Claude’da sol menüden Code’u bir kez aç; liste kendiliğinden dolar.",
    "Open Code once from the sidebar in Claude; the list fills in on its own.",
  );

/**
 * Overview cards that need connected accounts (a saved Claude app sign-in): Today plans one,
 * automatic switching needs two.
 */
export function overviewCards(accounts: readonly Account[]) {
  const connected = accounts.filter((a) => !!a.desktop).length;
  return { today: connected >= 1, automation: connected >= 2 };
}
