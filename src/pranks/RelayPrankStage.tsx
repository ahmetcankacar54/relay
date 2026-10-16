import type { ReactNode } from "react";
import { useRelay, type Relay } from "@/data/relay-context";
import { PrankStage, type PrankStageProps } from "./PrankStage";

/** What the app tells the stage: the pranks setting (missing means "sometimes"), and what keeps a prank from playing. */
export function stagePropsFrom(relay: Relay): Omit<PrankStageProps, "children"> {
  return {
    level: relay.settings.pranks ?? "sometimes",
    desktopBusy: relay.desktopBusy,
    errorShown: !!relay.error || !!relay.desktop?.error,
    dialogOpen: !!relay.desktopRequest,
  };
}

/** The prank stage fed by the app's relay. */
export function RelayPrankStage({ children }: { children: ReactNode }) {
  return <PrankStage {...stagePropsFrom(useRelay())}>{children}</PrankStage>;
}
