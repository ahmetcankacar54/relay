import { useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Note, OptionSelect, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  REMOTE_NOTIFY_URL_MAX,
  remoteNotifySettings,
  remoteNotifyUrl,
} from "../../../shared/remote-notify";
import type {
  RemoteNotifyEvents,
  RemoteNotifyKind,
  RemoteNotifyResult,
} from "../../../shared/types";
import type { MessageId } from "../../../shared/i18n/translate";

/** The events a post can be about, in the order of the local notifications above them. */
const EVENTS: [keyof RemoteNotifyEvents, MessageId][] = [
  ["limit", "remoteNotifySettings.eventLimit"],
  ["reset", "remoteNotifySettings.eventReset"],
  ["autoSwitch", "remoteNotifySettings.eventAutoSwitch"],
  ["signIn", "remoteNotifySettings.eventSignIn"],
];

/**
 * The Notifications group's remote part: where the same events are posted (an ntfy topic or a
 * webhook), which of them, and a sample post to try the URL before or after saving it. The URL
 * saves when it is left, and only when the main process would accept it.
 */
export function RemoteNotifyRows() {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  const current = remoteNotifySettings(settings);
  const [url, setUrl] = useState(current.url ?? "");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RemoteNotifyResult>();
  const invalid = !!url.trim() && !remoteNotifyUrl(url);
  const save = (patch: Partial<typeof current>) => {
    const { url: savedUrl, ...rest } = { ...current, ...patch };
    void action("settings", () =>
      api.updateSettings({
        remoteNotify: savedUrl?.trim()
          ? { ...rest, url: savedUrl.trim() }
          : rest,
      }),
    );
  };
  const saveUrl = () => {
    if (invalid || url.trim() === (current.url ?? "")) return;
    save({ url: url.trim() || undefined });
  };
  const test = async () => {
    setTesting(true);
    setResult(undefined);
    try {
      setResult(
        await api.testRemoteNotify({ url: url.trim(), kind: current.kind }),
      );
    } catch {
      setResult({ ok: false, reason: "failed" });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <SettingRow
        label={t("remoteNotifySettings.remoteNotifications")}
        htmlFor="remote-notify-kind"
        description={t("remoteNotifySettings.remoteDescription")}
      >
        <OptionSelect<RemoteNotifyKind>
          id="remote-notify-kind"
          value={current.kind}
          disabled={disabled}
          onChange={(kind) => save({ kind })}
          options={[
            { value: "ntfy", label: t("remoteNotifySettings.ntfy") },
            { value: "webhook", label: t("remoteNotifySettings.webhook") },
          ]}
        />
      </SettingRow>
      <div className="grid gap-2 border-t py-2">
        <label htmlFor="remote-notify-url" className="text-sm">
          {t("remoteNotifySettings.url")}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="remote-notify-url"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            maxLength={REMOTE_NOTIFY_URL_MAX}
            className="min-w-0 flex-1 basis-64"
            placeholder={
              current.kind === "ntfy"
                ? "https://ntfy.sh/…"
                : "https://example.com/hooks/relay"
            }
            value={url}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby="remote-notify-result"
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(undefined);
            }}
            onBlur={saveUrl}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveUrl();
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || testing || !url.trim() || invalid}
            onClick={() => void test()}
          >
            {testing ? <LoaderCircle className="animate-spin" /> : <Send />}
            {t("remoteNotifySettings.sendTest")}
          </Button>
        </div>
        <p
          id="remote-notify-result"
          role="status"
          className="text-xs text-muted-foreground"
        >
          {invalid
            ? t("remoteNotifySettings.urlInvalid")
            : result?.ok
              ? t("remoteNotifySettings.testSent", { status: result.status })
              : result
                ? t("remoteNotifySettings.testFailed", {
                    error: result.error ?? t("remoteNotifySettings.noAnswer"),
                  })
                : t("remoteNotifySettings.neverSecrets")}
        </p>
      </div>
      <fieldset
        className="grid gap-2 border-t py-2"
        disabled={disabled || !current.url}
      >
        <legend className="sr-only">{t("remoteNotifySettings.events")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {EVENTS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                id={`remote-notify-${key}`}
                className="size-4 shrink-0 accent-primary"
                type="checkbox"
                checked={current.events[key]}
                onChange={(e) =>
                  save({
                    events: { ...current.events, [key]: e.target.checked },
                  })
                }
              />
              {t(label)}
            </label>
          ))}
        </div>
        <Note>{t("remoteNotifySettings.eventsFollowLocal")}</Note>
      </fieldset>
    </>
  );
}
