import { headFor, mascotPose } from "../../shared/mascot";
import type { Account, AccountUsage, DesktopState, WindowAttempt } from "../../shared/types";
import type { PandaScene } from "@/mascot/scenes";

/** The panel header's panda: the menu bar pose's head, idle until data loads. */
export function panelHead(
  data:
    | {
        accounts: Account[];
        usage: Record<string, AccountUsage>;
        planning?: { attempts?: WindowAttempt[] };
      }
    | undefined,
  desktop: DesktopState | undefined,
  now: number,
): PandaScene {
  if (!data) return "head-idle";
  return `head-${headFor(
    mascotPose(
      { accounts: data.accounts, usage: data.usage, desktop, attempts: data.planning?.attempts },
      now,
    ),
  )}` as const;
}
