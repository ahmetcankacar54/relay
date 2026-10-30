import { useCallback, useEffect, useState } from "react";
import type { ExtensionStatus } from "../../shared/types";
import { useRelay } from "./relay-context";

/**
 * The Claude browser extension's status. With `check`, Relay also looks at who the extension is
 * signed in to when the view opens (from a copy; no browser is quit) and links that account, so
 * opening an account after signing in to the extension is all it takes. `undefined` while
 * loading, `null` where the extension is not handled (outside macOS).
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
  useEffect(() => {
    if (!initial) void run(check);
  }, [run, check, setting]);
  return {
    status,
    checking,
    check: () => run(true),
    /** Links the extension's sign-in as this account's, for data that names no account. */
    link: (accountId: string) => run(true, accountId),
    reload: () => run(false),
  };
}
