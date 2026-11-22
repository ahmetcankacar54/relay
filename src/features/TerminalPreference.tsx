import { useState } from "react";
import {
  DEFAULT_TERMINAL_MODE,
  sameIdentity,
  terminalIdentities,
  terminalLine,
  type TerminalMode,
  type TerminalStatus,
} from "../../shared/terminal-identity";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/Disclosure";
import {
  Note,
  OptionSelect,
  SettingRow,
} from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { useTerminalStatus } from "@/data/useTerminal";

/**
 * What Relay does with the terminal's Claude Code sign-in at a switch: on top the mode, who the
 * terminal is on and Check; under Ayrıntılar the saved accounts and Sync now. Hidden outside macOS and Linux.
 */
export function TerminalPreference({
  initialStatus,
  openDetails,
}: {
  initialStatus?: TerminalStatus;
  /** For static rendering: Ayrıntılar drawn open. */
  openDetails?: boolean;
}) {
  const { api, settings, busy, desktop, action, accounts } = useRelay();
  const { t } = useI18n();
  const [result, setResult] = useState<string>();
  const { status, checking, check } = useTerminalStatus({ initial: initialStatus });
  const mode = settings.terminalCli ?? DEFAULT_TERMINAL_MODE;
  if (!status) return null;
  const disabled = !!busy || !!desktop?.busy;
  const owner = (id: { accountUuid: string; orgId: string }) =>
    accounts.find((a) =>
      terminalIdentities(a).some((x) => sameIdentity(x, id)),
    );
  const current = status.current;
  const on =
    current?.state === "signed-in" && current.accountUuid && current.orgId
      ? owner({ accountUuid: current.accountUuid, orgId: current.orgId })
      : undefined;
  const other = [current?.email, current?.orgName].filter(Boolean).join(", ");
  const currentLine = !current
    ? t("terminalPreference.terminalCheckInProgress")
    : current.state === "signed-in"
      ? current.mismatch
        ? t("terminalPreference.theTerminalSignInBelongsTo")
        : on
          ? t("terminalPreference.theTerminalIsOnNow", { onName: on.name })
          : other
            ? t("terminalPreference.theTerminalIsOnAnAccount2", { owner: other })
            : t("terminalPreference.theTerminalIsOnAnAccount")
      : current.state === "signed-out"
        ? t("terminalPreference.claudeCodeInTheTerminalIs")
        : t("terminalPreference.relayCannotReadTheClaudeCode");
  const linked = accounts.filter((a) =>
    status.saved.some((s) =>
      terminalIdentities(a).some((x) => sameIdentity(x, s)),
    ),
  );
  const missing = accounts.filter((a) => a.desktop && !linked.includes(a));
  // Saved while in use and left by a sign-in by hand: Claude Code may have renewed it away.
  const unsure = linked.filter(
    (a) =>
      a !== on &&
      status.saved.some(
        (s) =>
          !s.parked && terminalIdentities(a).some((x) => sameIdentity(x, s)),
      ),
  );
  const savedLine = [
    linked.length
      ? t("terminalPreference.terminalSignInSaved", { join: linked.map((a) => a.name).join(", ") })
      : t("terminalPreference.noAccountHasATerminalSign"),
    unsure.length
      ? t("terminalPreference.savedWhileInUseASwitch", { join: unsure.map((a) => a.name).join(", ") })
      : "",
    missing.length
      ? t("terminalPreference.missingOnEachOneSAccount", { join: missing.map((a) => a.name).join(", ") })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const update = (next: TerminalMode) =>
    void action("settings", () => api.updateSettings({ terminalCli: next }));
  const sync = () =>
    void action("terminal-sync", async () => {
      const outcome = await api.syncTerminal();
      const name = accounts.find((a) => a.id === desktop?.activeProfileId)?.name;
      setResult(
        terminalLine(outcome, t, name) ??
          t("terminalPreference.nothingToChangeInTheTerminal"),
      );
      void check();
    });
  return (
    <div className="grid gap-1">
      <SettingRow
        label={<span className="font-medium">{t("terminalPreference.claudeCodeInTheTerminal")}</span>}
        htmlFor="terminal-mode"
        description={
          mode === "off"
            ? t("terminalPreference.relayDoesNotChangeTheTerminal")
            : currentLine
        }
      >
        <span className="flex gap-1">
          <OptionSelect<TerminalMode>
            id="terminal-mode"
            value={mode}
            options={[
              { value: "follow", label: t("terminalPreference.followTheAccount") },
              { value: "off", label: t("terminalPreference.doNotChange") },
            ]}
            className="w-52"
            disabled={disabled}
            onChange={update}
          />
          {mode !== "off" && (
            <Button variant="outline" disabled={checking} onClick={() => void check()}>
              {t("common.check")}
            </Button>
          )}
        </span>
      </SettingRow>
      <Disclosure title={t("terminalPreference.details")} defaultOpen={openDetails}>
        {status.viaGateway && (
          <Note>
            {t("terminalPreference.claudeCodeIsConnectedToThe")}
          </Note>
        )}
        <Note>
          {t("terminalPreference.atASwitchRelayPutsIn")}
        </Note>
        {mode !== "off" && (
          <>
            <Note>
              {t("terminalPreference.newTerminalSessionsStartOnThe")}
            </Note>
            <SettingRow
              label={t("terminalPreference.savedAccounts")}
              description={savedLine}
            >
              <Button variant="outline" disabled={disabled} onClick={sync}>
                {t("terminalPreference.syncNow")}
              </Button>
            </SettingRow>
            <Note>
              {t("terminalPreference.afterYouSignInToThe")}
            </Note>
          </>
        )}
        {status.last && <Note>{terminalLine(status.last, t) ?? ""}</Note>}
      </Disclosure>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
    </div>
  );
}
