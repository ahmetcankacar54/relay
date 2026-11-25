import type {
  RemoteNotifyEvents,
  RemoteNotifySettings,
  RelaySettings,
} from "./types";

/** Every event on and ntfy picked: what the group shows before a URL is saved. */
export const DEFAULT_REMOTE_NOTIFY: Required<
  Omit<RemoteNotifySettings, "url">
> = {
  kind: "ntfy",
  events: { limit: true, reset: true, autoSwitch: true, signIn: true },
};

/** The saved choices over the defaults; a missing group or event key reads as the default. */
export function remoteNotifySettings(
  settings: Pick<RelaySettings, "remoteNotify">,
): RemoteNotifySettings & { events: RemoteNotifyEvents } {
  const saved = settings.remoteNotify;
  return {
    ...DEFAULT_REMOTE_NOTIFY,
    ...saved,
    events: { ...DEFAULT_REMOTE_NOTIFY.events, ...saved?.events },
  };
}

/** Hosts plain http may reach: a self-hosted ntfy on this computer, never one across a network. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
export const REMOTE_NOTIFY_URL_MAX = 2_000;

/**
 * The URL Relay may post events to, or undefined: https anywhere, http only to this computer, so
 * an account name never crosses a network in the clear. A URL with a user name or password is
 * refused: fetch will not send one, and a secret there would sit in the settings in the open.
 */
export function remoteNotifyUrl(raw: string | undefined): URL | undefined {
  const text = raw?.trim();
  if (!text || text.length > REMOTE_NOTIFY_URL_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username || url.password || !url.hostname) return undefined;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)
    ? url
    : undefined;
}
