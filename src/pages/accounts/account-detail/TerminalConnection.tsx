import { useEffect } from "react";
import { Link2, LoaderCircle, SquareTerminal } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import type { useTerminalStatus } from "@/data/useTerminal";
import { terminalGuide } from "@/lib/terminal-ui";
import { routeHash } from "@/app/routes";
import { localizeError } from "@/messages";
import type { Account } from "../../../../shared/types";
import { ConnectionRow } from "./Connections";

/** The terminal's Claude Code sign-in for this account: linked, or how to link it. macOS and Linux. */
export function TerminalConnection({
  account: a,
  terminal: { status, checking, check },
}: {
  account: Account;
  terminal: ReturnType<typeof useTerminalStatus>;
}) {
  const { t, language } = useI18n();
  const relay = useRelay();
  const flow = relay.data?.terminalFlows?.find((f) => f.accountId === a.id);
  const linking = pendingFlow(flow);
  // The link saved a sign-in: read the terminal's status again, so the row turns to "Linked".
  const done = flow?.status === "connected" ? flow.id : undefined;
  useEffect(() => {
    if (done) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  if (status === null) return null;
  const guide = terminalGuide(a, status, t, language);
  const failed = guide.action === "link" && flow?.status === "failed" ? flow.error : undefined;
  return (
    <ConnectionRow
      icon={<SquareTerminal />}
      title={t("Terminal", "Terminal")}
      purpose={t("Bu hesaba o da geçer.", "Switches to this account too.")}
      optional
      tone={guide.tone}
      status={
        guide.action === "link" && linking
          ? t("Tarayıcıda onay bekleniyor…", "Waiting for approval in the browser…")
          : guide.label
      }
      steps={guide.steps}
      detail={failed ? localizeError(failed, language) : guide.detail}
      refresh={
        !guide.action && guide.tone === "ok" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Terminali yeniden kontrol et", "Check the terminal again")}
            title={t("Terminali yeniden kontrol et", "Check the terminal again")}
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
          </Button>
        ) : undefined
      }
      action={
        guide.action === "link" ? (
          linking && flow ? (
            <span className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void relay.action("terminal-link", () => relay.api.linkTerminal(a.id))}
              >
                {t("Sayfayı yeniden aç", "Reopen the page")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void relay.action("terminal-cancel", () => relay.api.cancelTerminalLink(a.id, flow.id))}
              >
                {t("Vazgeç", "Cancel")}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!!relay.busy}
              onClick={() => void relay.action("terminal-link", () => relay.api.linkTerminal(a.id))}
            >
              <Link2 />
              {t("Bağla", "Link")}
            </Button>
          )
        ) : guide.action === "settings" ? (
          <Button size="sm" variant="outline" asChild>
            <a href={routeHash("gecis")}>{t("Geçiş", "Switching")}</a>
          </Button>
        ) : undefined
      }
    />
  );
}
