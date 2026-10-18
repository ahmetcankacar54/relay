import { useEffect, useRef, type ReactNode } from "react";
import { useRelay, type Relay } from "@/data/relay-context";
import { PrankStage, windowStorage, type PrankStageProps } from "./PrankStage";
import { markFirstSwitch, quietOnDayOne } from "./budget";

/** What the app tells the stage: the pranks setting (missing means "sometimes"), and what keeps a prank from playing. */
export function stagePropsFrom(relay: Relay): Omit<PrankStageProps, "children"> {
  return {
    level: relay.settings.pranks ?? "sometimes",
    desktopBusy: relay.desktopBusy,
    errorShown: !!relay.error || !!relay.desktop?.error,
    dialogOpen: !!relay.desktopRequest,
  };
}

/**
 * Whether the Claude app moved from one saved account to another between two readings: a switch
 * succeeded. Saving the open account (none → one) is not a switch.
 */
export const switched = (before: string | undefined, after: string | undefined) =>
  !!before && !!after && before !== after;

/** The prank stage fed by the app's relay, quiet on day one. */
export function RelayPrankStage({ children }: { children: ReactNode }) {
  const relay = useRelay();
  const active = relay.desktop?.activeProfileId;
  const last = useRef(active);
  // The first run starts the quiet day as the window opens, not at the first click.
  useEffect(() => void quietOnDayOne(windowStorage(), Date.now()), []);
  useEffect(() => {
    if (switched(last.current, active)) markFirstSwitch(windowStorage());
    if (active) last.current = active;
  }, [active]);
  return (
    <PrankStage {...stagePropsFrom(relay)} dayOneQuiet={quietOnDayOne}>
      {children}
    </PrankStage>
  );
}
