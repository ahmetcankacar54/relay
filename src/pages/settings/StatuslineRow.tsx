import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/SettingRow";
import type { useI18n } from "@/data/i18n";
import type { useRelay } from "@/data/relay-context";
import { useCopy } from "../proxy/hooks";
import { RELAY_CLI_INSTALL } from "../../../shared/cli-package";

type Setup = Awaited<ReturnType<ReturnType<typeof useRelay>["api"]["claudeStatusline"]>>;

/**
 * Relay in Claude Code's status line: the switch writes `statusLine` in `~/.claude/settings.json`
 * through main, with the installed relay CLI's absolute path. The state lives in that file, not in
 * Relay's settings, so the row reads it itself; a bridge without it (an older window) leaves the
 * row out. Without the CLI the switch stays off and the row offers its install command instead.
 */
export function ClaudeStatuslineRow({
  api,
  action,
  t,
}: Pick<ReturnType<typeof useRelay>, "api" | "action"> & { t: ReturnType<typeof useI18n>["t"] }) {
  const [setup, setSetup] = useState<Setup>();
  const { copied, copy } = useCopy();
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => api.claudeStatusline())
      .then((state) => live && setSetup(state))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  if (!setup) return null;
  const missing = !setup.cli;
  return (
    <SettingRow
      label={t("statusline.settingLabel")}
      htmlFor="claude-statusline"
      description={
        <>
          {t("statusline.settingDescription")}
          {missing && (
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <span>{t("statusline.installCliFirst")}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" translate="no">
                {RELAY_CLI_INSTALL}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy("relay-cli-install", RELAY_CLI_INSTALL)}>
                {copied === "relay-cli-install" ? t("toolsTab.copied") : t("common.copy")}
              </Button>
            </span>
          )}
        </>
      }
    >
      <Switch
        id="claude-statusline"
        checked={setup.installed}
        // Turned off it can always be; turned on only with a relay Claude Code can run.
        disabled={missing && !setup.installed}
        onCheckedChange={(enable) =>
          void action("claude-statusline", async () => setSetup(await api.claudeStatusline(enable)))
        }
      />
    </SettingRow>
  );
}
