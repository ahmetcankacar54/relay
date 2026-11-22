import { useEffect, useState } from "react";
import type { Account, DesktopHistorySummary, RelayAPI } from "../../shared/types";
import { Button } from "@/components/ui/button";
import type { T } from "../../shared/i18n/translate";

export function HistorySummary({
  account,
  sources,
  api,
  t,
}: {
  account: Account;
  sources: Account[];
  api: RelayAPI;
  t: T;
}) {
  const [value, setValue] = useState<DesktopHistorySummary>();
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void api
      .desktopHistorySummary(account.id)
      .then(setValue, () => setFailed(true));
  };
  useEffect(() => {
    let current = true;
    setValue(undefined);
    setFailed(false);
    void api.desktopHistorySummary(account.id).then(
      (v) => {
        if (current) setValue(v);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [account.id, api]);
  return (
    <div className="grid gap-1 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong className="font-semibold">
          {t("historySummary.localCodeHistory")}
        </strong>
        <Button
          size="sm"
          variant="link"
          className="h-auto px-0"
          onClick={load}
        >
          {t("common.check")}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {failed
          ? t("historySummary.cannotReadTheHistoryCheckAgain")
          : value
            ? t("historySummary.sessionsLocalProjectsArchived", { valueIndexed: value.indexed, valueProjects: value.projects, valueArchived: value.archived })
            : t("historySummary.readInProgress")}
      </p>
      {value && (
        <p className="text-muted-foreground">
          {t("historySummary.conversationFilesMissingUnverified", { valueTranscriptsFound: value.transcriptsFound, valueMissingTranscripts: value.missingTranscripts, valueUnknownTranscripts: value.unknownTranscripts })}
        </p>
      )}
      {value && value.duplicates > 0 && (
        <p className="text-muted-foreground">
          {t("historySummary.relayRemovesDuplicateCardsAtThe", { valueDuplicates: value.duplicates })}
        </p>
      )}
      <small className="text-xs text-muted-foreground">
        {sources.length
          ? t("historySummary.historySourcesForTheNextMerge", { join: sources.map((a) => a.name).join(", ") })
          : t("historySummary.noHistorySources")}
      </small>
    </div>
  );
}
