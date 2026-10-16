import type { ReactNode } from "react";
import { useRelay } from "@/data/relay-context";
import { PrankStage } from "./PrankStage";

/** The prank stage fed by the app: the pranks setting, and what keeps a prank from playing. */
export function RelayPrankStage({ children }: { children: ReactNode }) {
  const relay = useRelay();
  return (
    <PrankStage
      level={relay.settings.pranks ?? "sometimes"}
      desktopBusy={relay.desktopBusy}
      errorShown={!!relay.error || !!relay.desktop?.error}
      dialogOpen={!!relay.desktopRequest}
    >
      {children}
    </PrankStage>
  );
}
