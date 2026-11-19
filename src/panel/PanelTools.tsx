import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { ToolList, otherToolRows } from "../features/ToolList";
import { panelEyebrow } from "./PanelActiveCard";

/**
 * The menu bar panel's other tools (variant B): Claude Code and the Codex CLI on the gateway, and
 * Antigravity, each with its account and the limit that stops it first. Nothing when there are none.
 */
export function PanelTools({ now }: { now: number }) {
  const relay = useRelay();
  const { t } = useI18n();
  if (!otherToolRows(relay, now).length) return null;
  return (
    <section data-slot="panel-tools" className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Diğer araçlar", "Other tools")}</span>
      </div>
      <ToolList
        compact
        now={now}
        onGateway={() => void relay.api.openPage("proxy")}
        onAdd={() => void relay.api.openPage("hesaplar", "ekle")}
      />
    </section>
  );
}
