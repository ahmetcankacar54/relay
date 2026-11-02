import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TERMINAL_MODE, type TerminalStatus } from "../../shared/terminal-identity";
import { useRelay } from "./relay-context";

/**
 * The terminal's Claude Code sign-in: who it is on and which accounts have one saved. Opening a
 * view that uses it is a check, so signing the terminal in and coming back links the account.
 * `undefined` while loading, `null` where the step does not run (outside macOS).
 */
export function useTerminalStatus({
  check = true,
  initial,
}: { check?: boolean; initial?: TerminalStatus } = {}) {
  const { api, settings } = useRelay();
  const [status, setStatus] = useState<TerminalStatus | null | undefined>(initial);
  const [checking, setChecking] = useState(false);
  const run = useCallback(
    (look: boolean) => {
      if (look) setChecking(true);
      return (look ? api.checkTerminal() : api.terminalStatus())
        .then(
          (s) => setStatus(s ?? null),
          () => {},
        )
        .finally(() => look && setChecking(false));
    },
    [api],
  );
  const mode = settings.terminalCli ?? DEFAULT_TERMINAL_MODE;
  useEffect(() => {
    if (!initial) void run(check);
  }, [run, check, mode]);
  return { status, setStatus, checking, check: () => run(true) };
}
