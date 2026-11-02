import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionStatus } from "../../shared/types";
import { useRelay } from "./relay-context";

/** A check on focus at most this often: coming back from the browser is one look, not many. */
export const FOCUS_CHECK_MS = 5000;

/**
 * Whether a focus should check again: the window is shown and the last check is old enough.
 * `last` is when the previous one started (ms), undefined before any.
 */
export function focusChecks(now: number, last: number | undefined, visible: boolean): boolean {
  return visible && (last === undefined || now - last >= FOCUS_CHECK_MS);
}

/**
 * The Claude browser extension's status. With `check`, Relay also looks at who the extension is
 * signed in to when the view opens and again when its window gets focus (from a copy; no browser
 * is quit) and links that account, so coming back after signing in to the extension is all it
 * takes. `undefined` while loading, `null` where the extension is not handled (outside macOS).
 */
export function useExtensionStatus({
  check = false,
  initial,
}: { check?: boolean; initial?: ExtensionStatus } = {}) {
  const { api, settings } = useRelay();
  const [status, setStatus] = useState<ExtensionStatus | null | undefined>(initial);
  const [checking, setChecking] = useState(false);
  const run = useCallback(
    (look: boolean, claimFor?: string) => {
      if (look) setChecking(true);
      return (
        claimFor
          ? api.linkExtension(claimFor)
          : look
            ? api.checkExtension()
            : api.extensionStatus()
      )
        .then(
          (s) => setStatus(s ?? null),
          () => {},
        )
        .finally(() => look && setChecking(false));
    },
    [api],
  );
  // Each snapshot carries a fresh copy of the settings, every few seconds: a check follows a
  // change of the setting's content, never a new copy of the same one.
  const setting = JSON.stringify(settings.claudeExtension ?? null);
  const lastCheck = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (initial) return;
    if (check) lastCheck.current = Date.now();
    void run(check);
  }, [run, check, setting]);
  useEffect(() => {
    if (!check) return;
    const focus = () => {
      const now = Date.now();
      if (!focusChecks(now, lastCheck.current, document.visibilityState === "visible")) return;
      lastCheck.current = now;
      void run(true);
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [run, check]);
  return {
    status,
    checking,
    check: () => run(true),
    /** Links the extension's sign-in as this account's, for data that names no account. */
    link: (accountId: string) => run(true, accountId),
    reload: () => run(false),
  };
}
