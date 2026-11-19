import type { ReactNode } from "react";
import { useRelay } from "@/data/relay-context";
import { ProviderPane, ProviderTabs, relayProviders, useProviderTab } from "../features/Providers";

/**
 * The tray's providers (variant A): a tab per provider with accounts, Claude's own content (the
 * Claude app's account, drafts, the other Claude accounts) under its tab, and each other provider's
 * pane under its own. With one provider there are no tabs.
 */
export function PanelProviders({ now, claude }: { now: number; claude: ReactNode }) {
  const relay = useRelay();
  const views = relayProviders(relay, now);
  const [value, setValue] = useProviderTab(views, "relay.panel.provider");
  if (views.length === 0) return <>{claude}</>;
  const view = views.find((v) => v.id === value) ?? views[0];
  const body = view.id === "claude" ? claude : (
    <div className="px-3 py-1.5">
      <ProviderPane view={view} now={now} size="sm" />
    </div>
  );
  if (views.length === 1) return <>{body}</>;
  return (
    <>
      <div className="px-3 pt-0.5 pb-1">
        <ProviderTabs views={views} value={view.id} onChange={setValue} size="sm" />
      </div>
      <div role="tabpanel" aria-label={view.id}>
        {body}
      </div>
    </>
  );
}
