/** relay:// links from the widgets, and the switch review they ask the main window for. */
import { parseRelayLink } from "../../shared/relay-link";
import { initialized, service, trayPanel } from "./state";
import { showWindow, window } from "./windows";
/** How long a widget's switch link waits for the main window to take it. */
const LINKED_SWITCH_MS = 2 * 60_000;
/** A widget's Geç: the account whose switch review the main window opens next. */
let linkedSwitch: { accountId: string; at: number } | undefined;
/** A link that came before Relay was ready. */
let pendingRelayLink: string | undefined;
/**
 * A relay:// link from a widget. `relay://switch?account=<id>` shows the main
 * window and asks it for its usual switch review of that account, the one its
 * own Switch buttons open; nothing here switches. Anything else, or an id that
 * is not one of Relay's accounts, only shows Relay or is ignored.
 */
export function openRelayLink(url: string) {
  if (!initialized) {
    pendingRelayLink = url;
    return;
  }
  const link = parseRelayLink(url, service.store.state.accounts);
  if (!link) return;
  if (link.kind === "switch")
    linkedSwitch = { accountId: link.accountId, at: Date.now() };
  showWindow();
  trayPanel?.hide();
  // A window still loading takes the request when its page starts.
  const contents = window?.webContents;
  if (link.kind === "switch" && contents && !contents.isLoading())
    contents.send("relay:switch-request");
}
/** The main window takes the widget's switch request once; an old one is dropped. */
export function takeLinkedSwitch() {
  const request = linkedSwitch;
  linkedSwitch = undefined;
  if (!request || Date.now() - request.at > LINKED_SWITCH_MS) return undefined;
  return service.store.state.accounts.some((a) => a.id === request.accountId)
    ? request.accountId
    : undefined;
}
/** The link Relay was opened with before it was ready, taken once at startup. */
export function takePendingRelayLink() {
  const link = pendingRelayLink;
  pendingRelayLink = undefined;
  return link;
}
