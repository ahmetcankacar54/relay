import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TERMINAL_MODE,
  sameIdentity,
  terminalIdentities,
  terminalLine,
  type TerminalMode,
  type TerminalStatus,
} from "../../shared/terminal-identity";
import { Button } from "@/components/ui/button";
import {
  Note,
  OptionSelect,
  SectionHeading,
  SettingRow,
} from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";

/**
 * What Relay does with the terminal's Claude Code sign-in at a switch: the mode, who the terminal
 * is on, which accounts have a terminal sign-in saved, Check and Sync now. Hidden outside macOS.
 */
export function TerminalPreference({
  initialStatus,
}: {
  initialStatus?: TerminalStatus;
}) {
  const { api, settings, busy, desktop, action, accounts } = useRelay();
  const { t } = useI18n();
  // undefined: not read yet. null: this Mac does not run the step.
  const [status, setStatus] = useState<TerminalStatus | null | undefined>(
    initialStatus,
  );
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>();
  const check = useCallback(() => {
    setChecking(true);
    return api
      .checkTerminal()
      .then(
        (s) => setStatus(s ?? null),
        () => {},
      )
      .finally(() => setChecking(false));
  }, [api]);
  const mode = settings.terminalCli ?? DEFAULT_TERMINAL_MODE;
  // Opening the card is a check: signing the terminal in and coming here links the account.
  useEffect(() => {
    if (!initialStatus) void check();
  }, [check, mode]);
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
  const other = [current?.email, current?.orgName].filter(Boolean).join(" · ");
  const currentLine = !current
    ? t("Terminal kontrol ediliyor…", "Checking the terminal…")
    : current.state === "signed-in"
      ? current.mismatch
        ? t(
            "Terminaldeki giriş, ~/.claude.json’un söylediğinden başka bir hesaba ait. Relay kaydetmez; terminalde “claude auth login” ile yeniden gir.",
            "The terminal’s sign-in belongs to another account than ~/.claude.json names. Relay does not save it; sign in again with “claude auth login”.",
          )
        : on
          ? t(
              `Terminaldeki Claude Code şu an ${on.name} hesabında · bağlı`,
              `The terminal’s Claude Code is on ${on.name} now · linked`,
            )
          : t(
              `Terminaldeki Claude Code, Relay’de olmayan bir hesapta${other ? ` (${other})` : ""}. Relay bu girişe dokunmaz.`,
              `The terminal’s Claude Code is on an account Relay does not have${other ? ` (${other})` : ""}. Relay leaves that sign-in alone.`,
            )
      : current.state === "signed-out"
        ? t(
            "Terminaldeki Claude Code’da giriş yok.",
            "The terminal’s Claude Code is signed out.",
          )
        : t(
            "Terminaldeki Claude Code girişi okunamadı.",
            "Could not read the terminal’s Claude Code sign-in.",
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
          `${unsure.map((a) => a.name).join(", ")}: saved while in use; a switch may ask for “claude auth login” once.`,
        )
      : "",
    missing.length
      ? t(
          `Eksik: ${missing.map((a) => a.name).join(", ")}. Her biri için terminalde “claude auth login” ile o hesaba gir, sonra “Kontrol et”e bas.`,
          `Missing: ${missing.map((a) => a.name).join(", ")}. For each, sign in with “claude auth login” in a terminal, then press Check.`,
        )
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const update = (next: TerminalMode) =>
    void action("settings", () => api.updateSettings({ terminalCli: next }));
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t("Terminaldeki Claude Code", "Claude Code in the terminal")}
        description={t(
          "Terminalde çalıştırdığın “claude” komutunun girişi. Relay her hesabın terminal girişini kasada saklar ve geçişte yenisini yerine koyar; tanımadığı bir girişe dokunmaz.",
          "The sign-in of the “claude” you run in a terminal. Relay keeps each account’s terminal sign-in in the vault and puts the new one in place at a switch; it never touches a sign-in it does not know.",
        )}
      />
      <SettingRow
        label={t(
          "Hesap değişince terminale ne yapılsın?",
          "What to do with the terminal when the account changes",
        )}
        htmlFor="terminal-mode"
        description={
          mode === "off"
            ? t(
                "Relay terminaldeki girişe hiç dokunmaz.",
                "Relay never touches the terminal’s sign-in.",
              )
            : t(
                "Yeni açılan terminal oturumları yeni hesapla başlar. Açık olanlar, erişim anahtarları yenilenince yeni hesaba geçer ama eski hesabın kurum bilgisini taşır: geçişten sonra onları yeniden başlat.",
                "New terminal sessions start on the new account. Open ones move to it when their access token renews but keep the old account’s organization details: restart them after a switch.",
              )
        }
      >
        <OptionSelect<TerminalMode>
          id="terminal-mode"
          value={mode}
          options={[
            {
              value: "follow",
              label: t(
                "Terminal de hesapla değişsin",
                "The terminal follows the account",
              ),
            },
            {
              value: "off",
              label: t("Terminale dokunma", "Leave the terminal alone"),
            },
          ]}
          className="w-64"
          disabled={disabled}
          onChange={update}
        />
      </SettingRow>
      {mode !== "off" && (
        <>
          <SettingRow
            label={currentLine}
            description={t(
              "Terminalde bir hesapla giriş yaptıktan sonra “Kontrol et”e bas; o hesap bağlanır.",
              "After signing the terminal in with an account, press Check and that account is linked.",
            )}
          >
            <span className="flex gap-1">
              <Button
                variant="outline"
                disabled={checking}
                onClick={() => void check()}
              >
                {t("Kontrol et", "Check")}
              </Button>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void action("terminal-sync", async () => {
                    const outcome = await api.syncTerminal();
                    const name = accounts.find(
                      (a) => a.id === desktop?.activeProfileId,
                    )?.name;
                    setResult(
                      terminalLine(outcome, t, name) ??
                        t(
                          "Terminalde değiştirilecek bir şey yok.",
                          "Nothing to change in the terminal.",
                        ),
                    );
                    void check();
                  })
                }
              >
                {t("Şimdi eşitle", "Sync now")}
              </Button>
            </span>
          </SettingRow>
          <SettingRow
            label={t("Kayıtlı hesaplar", "Saved accounts")}
            description={savedLine}
          >
            <span />
          </SettingRow>
        </>
      )}
      {result && (
        <p role="status" className="text-[13px]">
          {result}
        </p>
      )}
      {status.last && !result && (
        <Note>{terminalLine(status.last, t) ?? ""}</Note>
      )}
    </div>
  );
}
