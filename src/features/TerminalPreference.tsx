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
  SectionHeading,
  SettingRow,
} from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { useTerminalStatus } from "@/data/useTerminal";

/**
 * What Relay does with the terminal's Claude Code sign-in at a switch: on top the mode, who the
 * terminal is on and Check; under Ayrıntılar the saved accounts and Sync now. Hidden outside macOS.
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
    ? t("Terminal kontrol ediliyor…", "Terminal check in progress…")
    : current.state === "signed-in"
      ? current.mismatch
        ? t(
            "Terminalin girişi başka bir hesaba ait. “claude auth login” ile yeniden gir.",
            "The terminal sign-in belongs to another account. Sign in again with “claude auth login”.",
          )
        : on
          ? t(
              `Terminal şu an ${on.name} hesabında.`,
              `The terminal is on ${on.name} now.`,
            )
          : t(
              `Terminal, Relay’de olmayan bir hesapta${other ? ` (${other})` : ""}.`,
              `The terminal is on an account that is not in Relay${other ? ` (${other})` : ""}.`,
            )
      : current.state === "signed-out"
        ? t(
            "Terminaldeki Claude Code’da giriş yok.",
            "Claude Code in the terminal is signed out.",
          )
        : t(
            "Terminaldeki Claude Code girişi okunamadı.",
            "Relay cannot read the Claude Code sign-in in the terminal.",
          );
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
      ? t(
          `Terminal girişi kayıtlı hesaplar: ${linked.map((a) => a.name).join(", ")}.`,
          `Terminal sign-in saved: ${linked.map((a) => a.name).join(", ")}.`,
        )
      : t(
          "Henüz terminal girişi kayıtlı bir hesap yok.",
          "No account has a terminal sign-in saved yet.",
        ),
    unsure.length
      ? t(
          `${unsure.map((a) => a.name).join(", ")}: giriş kullanımdayken kaydedildi; geçişte bir kez “claude auth login” isteyebilir.`,
          `${unsure.map((a) => a.name).join(", ")}: saved while in use. A switch can ask for “claude auth login” once.`,
        )
      : "",
    missing.length
      ? t(
          `Eksik: ${missing.map((a) => a.name).join(", ")}. Her biri için terminalde “claude auth login” ile o hesaba gir, sonra “Kontrol et”e bas.`,
          `Missing: ${missing.map((a) => a.name).join(", ")}. For each one, sign in with “claude auth login” in a terminal. Then select “Check”.`,
        )
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
          t("Terminalde değiştirilecek bir şey yok.", "Nothing to change in the terminal."),
      );
      void check();
    });
  return (
    <div className="grid gap-1">
      <SectionHeading title={t("Terminaldeki Claude Code", "Claude Code in the terminal")} />
      <SettingRow
        label={t("Geçişte", "At a switch")}
        htmlFor="terminal-mode"
        description={
          mode === "off"
            ? t("Relay terminaldeki girişe dokunmaz.", "Relay does not change the terminal sign-in.")
            : currentLine
        }
      >
        <span className="flex gap-1">
          <OptionSelect<TerminalMode>
            id="terminal-mode"
            value={mode}
            options={[
              { value: "follow", label: t("Hesapla değişsin", "Follow the account") },
              { value: "off", label: t("Dokunma", "Do not change") },
            ]}
            className="w-52"
            disabled={disabled}
            onChange={update}
          />
          {mode !== "off" && (
            <Button variant="outline" disabled={checking} onClick={() => void check()}>
              {t("Kontrol et", "Check")}
            </Button>
          )}
        </span>
      </SettingRow>
      <Disclosure title={t("Ayrıntılar", "Details")} defaultOpen={openDetails}>
        <Note>
          {t(
            "Relay geçişte yeni hesabın terminal girişini yerine koyar; tanımadığı bir girişe dokunmaz.",
            "At a switch, Relay puts in the terminal sign-in of the new account. Relay does not change a sign-in that it does not know.",
          )}
        </Note>
        {mode !== "off" && (
          <>
            <Note>
              {t(
                "Yeni terminal oturumları yeni hesapla başlar. Açık oturumları geçişten sonra yeniden başlat.",
                "New terminal sessions start on the new account. Restart open sessions after a switch.",
              )}
            </Note>
            <SettingRow
              label={t("Kayıtlı hesaplar", "Saved accounts")}
              description={savedLine}
            >
              <Button variant="outline" disabled={disabled} onClick={sync}>
                {t("Şimdi eşitle", "Sync now")}
              </Button>
            </SettingRow>
            <Note>
              {t(
                "Terminalde bir hesapla giriş yaptıktan sonra “Kontrol et”e bas; o hesap bağlanır.",
                "After you sign in to the terminal, select “Check” to link that account.",
              )}
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
