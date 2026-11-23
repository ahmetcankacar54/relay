import { useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingGroup, SettingRow } from "@/components/SettingRow";
import { errorMessage } from "@/data/error-message";
import { useI18n } from "@/data/i18n";
import { macWording } from "@/data/platform";
import { useRelay } from "@/data/relay-context";
import { useRiskConsent } from "@/components/RiskConsent";
import { antigravityAccountRisks } from "../../../shared/feature-risk";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import type { T } from "../../../shared/i18n/translate";
import {
  MIN_BACKUP_PASSPHRASE,
  type BackupFileChoice,
  type BackupImportMode,
  type BackupSummary,
} from "../../../shared/backup";

/** An error shown inside a dialog, where the user is looking. */
function DialogError({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  );
}

/** The steps for moving Relay to another computer, shown beside both export and import. */
export function MoveSteps({ t, mac }: { t: T; mac: boolean }) {
  return (
    <section className="grid gap-1 rounded-md border bg-muted/40 p-3 text-xs">
      <h4 className="font-semibold">{mac ? t("dataBackup.moveTitleMac") : t("dataBackup.moveTitle")}</h4>
      <ol className="list-decimal space-y-0.5 ps-4 text-muted-foreground">
        <li>{t("dataBackup.moveStepExport")}</li>
        <li>{t("dataBackup.moveStepInstall")}</li>
        <li>{t("dataBackup.moveStepImport")}</li>
        <li>{t("dataBackup.moveStepOldComputer")}</li>
      </ol>
    </section>
  );
}

/** Export: a passphrase typed twice, and whether the saved sign-ins go into the file (off at first). */
function ExportBackupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const { api, data, setNotice } = useRelay();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signIns, setSignIns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const short = [...passphrase].length < MIN_BACKUP_PASSPHRASE;
  const mismatch = confirm !== passphrase;
  const close = () => {
    setPassphrase("");
    setConfirm("");
    setSignIns(false);
    setError("");
    onOpenChange(false);
  };
  const submit = () => {
    setSaving(true);
    setError("");
    void api
      .exportBackup({ passphrase, includeSignIns: signIns })
      .then((result) => {
        if (!result) return;
        setNotice(t("dataBackup.exported", { accounts: result.accounts, signIns: result.signIns }));
        close();
      }, (failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dataBackup.exportTitle")}</DialogTitle>
          <DialogDescription>{t("dataBackup.exportDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!short && !mismatch && !saving) submit();
          }}
        >
          <label className="grid gap-1 text-sm" htmlFor="backup-passphrase">
            {t("dataBackup.passphrase")}
            <Input
              id="backup-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              aria-invalid={!!passphrase && short}
            />
            <span className="text-xs text-muted-foreground">
              {t("dataBackup.passphraseHint", { count: MIN_BACKUP_PASSPHRASE })}
            </span>
          </label>
          <label className="grid gap-1 text-sm" htmlFor="backup-confirm">
            {t("dataBackup.confirmPassphrase")}
            <Input
              id="backup-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              aria-invalid={!!confirm && mismatch}
            />
            {!!confirm && mismatch && (
              <span className="text-xs text-destructive">{t("dataBackup.passphrasesDiffer")}</span>
            )}
          </label>
          <div className="flex items-start justify-between gap-3">
            <label htmlFor="backup-sign-ins" className="grid gap-0.5 text-sm">
              {t("dataBackup.includeSignIns")}
              <span className="text-xs text-muted-foreground">{t("dataBackup.includeSignInsDescription")}</span>
            </label>
            <Switch id="backup-sign-ins" checked={signIns} onCheckedChange={setSignIns} />
          </div>
          {signIns && (
            <p role="note" data-slot="backup-sign-in-warning" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              {t("dataBackup.signInsWarning")}
            </p>
          )}
          <MoveSteps t={t} mac={macWording(data?.diagnostics.platform)} />
          <DialogError text={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={saving} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={saving || short || mismatch}>
              {saving && <LoaderCircle className="animate-spin" />}
              {t("dataBackup.exportButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The opened backup: when it was made, its accounts, and whether each is already here. */
function BackupContents({ summary, t, language }: { summary: BackupSummary; t: T; language: string }) {
  const made = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(summary.createdAt),
  );
  return (
    <section className="grid gap-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {t("dataBackup.madeOn", { date: made, version: summary.relayVersion })}
      </p>
      <ul className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2">
        {summary.accounts.map((account, index) => (
          <li key={index} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{account.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {[
                account.signIn ? t("dataBackup.withSignIn") : t("dataBackup.withoutSignIn"),
                ...(account.present ? [t("dataBackup.alreadyHere")] : []),
              ].join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {summary.signIns && <p className="text-xs text-muted-foreground">{t("dataBackup.importSignInsNote")}</p>}
    </section>
  );
}

/**
 * Import, once a file was picked: its passphrase, then what it holds and merge or replace. Closing
 * at any step makes main forget the file.
 */
function ImportBackupDialog({ file, onClose }: { file?: BackupFileChoice; onClose: () => void }) {
  const { t, language } = useI18n();
  const { api, data, settings, setNotice, refresh } = useRelay();
  const consent = useRiskConsent();
  const [passphrase, setPassphrase] = useState("");
  const [summary, setSummary] = useState<BackupSummary>();
  const [mode, setMode] = useState<BackupImportMode>("merge");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const close = (forget: boolean) => {
    if (forget) void api.cancelBackup();
    setPassphrase("");
    setSummary(undefined);
    setMode("merge");
    setError("");
    onClose();
  };
  const run = (step: () => Promise<void>) => {
    setWorking(true);
    setError("");
    void step()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setWorking(false));
  };
  const open = () =>
    run(async () => {
      setSummary(await api.openBackup(passphrase));
      setPassphrase("");
    });
  const bring = () =>
    run(async () => {
      // Antigravity accounts the import adds ask for their risk note first, as when added by hand.
      const antigravity = summary?.accounts.some(
        (account) => account.provider === "antigravity" && (mode === "replace" || !account.present),
      );
      if (antigravity && !(await consent.ask(antigravityAccountRisks(!!settings.proxy?.enabled)))) return;
      const result = await api.importBackup(mode);
      setNotice(
        [
          t("dataBackup.imported", { added: result.added, skipped: result.skipped, signIns: result.signIns }),
          ...(result.signInsFailed ? [t("dataBackup.signInsFailed", { count: result.signInsFailed })] : []),
          ...(result.before ? [t("dataBackup.savedBefore", { name: result.before })] : []),
        ].join(" "),
      );
      close(false);
      await refresh();
    });
  const locale = FORMAT_LOCALE[language];
  return (
    <Dialog open={!!file} onOpenChange={(next) => !next && !working && close(true)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dataBackup.importTitle")}</DialogTitle>
          <DialogDescription>{file?.name}</DialogDescription>
        </DialogHeader>
        {!summary ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (passphrase && !working) open();
            }}
          >
            <label className="grid gap-1 text-sm" htmlFor="backup-open-passphrase">
              {t("dataBackup.passphrase")}
              <Input
                id="backup-open-passphrase"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <MoveSteps t={t} mac={macWording(data?.diagnostics.platform)} />
            <DialogError text={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={working} onClick={() => close(true)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={working || !passphrase}>
                {working && <LoaderCircle className="animate-spin" />}
                {t("dataBackup.openButton")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-3">
            <BackupContents summary={summary} t={t} language={locale} />
            <fieldset className="grid gap-2" aria-label={t("dataBackup.howToImport")}>
              {(["merge", "replace"] as const).map((value) => (
                <label key={value} className="flex items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary">
                  <input
                    type="radio"
                    name="backup-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="mt-1"
                  />
                  <span className="grid gap-0.5">
                    {value === "merge" ? t("dataBackup.merge") : t("dataBackup.replace")}
                    <span className="text-xs text-muted-foreground">
                      {value === "merge"
                        ? t("dataBackup.mergeDescription")
                        : t("dataBackup.replaceDescription", { count: summary.currentAccounts })}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <DialogError text={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={working} onClick={() => close(true)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={working} onClick={bring}>
                {working && <LoaderCircle className="animate-spin" />}
                {t("dataBackup.importButton")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
      {consent.dialog}
    </Dialog>
  );
}

/**
 * The confirmation for removing Relay's data: what goes, what stays, and what Relay does first.
 * Main refuses while a Desktop operation, a terminal or a sign-in runs, and says so here.
 */
function ResetDataDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const { api, data } = useRelay();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const mac = macWording(data?.diagnostics.platform);
  const close = () => {
    setError("");
    onOpenChange(false);
  };
  const remove = () => {
    setWorking(true);
    setError("");
    // On success Relay quits and opens again; the dialog goes with the window.
    void api
      .resetData()
      .catch((failure: unknown) => {
        setError(errorMessage(failure));
        setWorking(false);
      });
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !working && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dataReset.title")}</DialogTitle>
          <DialogDescription>{t("dataReset.description")}</DialogDescription>
        </DialogHeader>
        <section className="grid gap-1 text-sm">
          <h4 className="font-semibold">{t("dataReset.removes")}</h4>
          <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
            <li>{t("dataReset.removesAccounts")}</li>
            <li>{mac ? t("dataReset.removesSignInsMac") : t("dataReset.removesSignIns")}</li>
            <li>{t("dataReset.removesProfiles")}</li>
            <li>{t("dataReset.removesHistory")}</li>
            <li>{t("dataReset.removesHelper")}</li>
            <li>{t("dataReset.removesCaches")}</li>
          </ul>
        </section>
        <section className="grid gap-1 text-sm">
          <h4 className="font-semibold">{t("dataReset.keeps")}</h4>
          <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
            <li>{t("dataReset.keepsClaudeApp")}</li>
            <li>{t("dataReset.keepsOwnFolders")}</li>
            <li>{t("dataReset.keepsExports")}</li>
          </ul>
        </section>
        <p className="text-xs text-muted-foreground">{t("dataReset.firstSteps")}</p>
        <DialogError text={error} />
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={working} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={working} onClick={remove} data-slot="reset-confirm">
            {working && <LoaderCircle className="animate-spin" />}
            {t("dataReset.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Advanced: back up and move, and remove Relay's data. */
export function DataGroups() {
  const { t } = useI18n();
  const { api, busy, report } = useRelay();
  const [exporting, setExporting] = useState(false);
  const [file, setFile] = useState<BackupFileChoice>();
  const [resetting, setResetting] = useState(false);
  return (
    <>
      <SettingGroup id="settings-backup" title={t("dataBackup.groupTitle")}>
        <SettingRow label={t("dataBackup.rowLabel")} description={t("dataBackup.rowDescription")}>
          <span className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setExporting(true)}>
              {t("settings.export")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void report(async () => {
                  const picked = await api.chooseBackup();
                  if (picked) setFile(picked);
                })
              }
            >
              {t("dataBackup.importEllipsis")}
            </Button>
          </span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup id="settings-reset" title={t("dataReset.groupTitle")}>
        <SettingRow label={t("dataReset.rowLabel")} description={t("dataReset.rowDescription")}>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setResetting(true)}>
            {t("dataReset.removeEllipsis")}
          </Button>
        </SettingRow>
      </SettingGroup>
      <ExportBackupDialog open={exporting} onOpenChange={setExporting} />
      <ImportBackupDialog file={file} onClose={() => setFile(undefined)} />
      <ResetDataDialog open={resetting} onOpenChange={setResetting} />
    </>
  );
}
