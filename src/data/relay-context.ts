// Kept free of browser-only imports (no preview.ts) so components can be
// statically rendered under Node with an injected Relay.
import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  Account,
  AuthFlow,
  DesktopState,
  RelayAPI,
  RelaySettings,
  Snapshot,
} from "../../shared/types";
import type { DesktopActionRequest } from "../DesktopActionReview";

export interface Relay {
  api: RelayAPI;
  preview: boolean;
  version: string;
  data?: Snapshot;
  desktop?: DesktopState;
  accounts: Account[];
  active?: Account;
  settings: RelaySettings;
  busy: string;
  error: string;
  notice: string;
  usageBusy: Set<string>;
  desktopBusy: boolean;
  pendingDesktop?: Account;
  hasUnclaimedDesktop: boolean;
  targetOrg: string;
  setOrg(id: string): void;
  refresh(): Promise<unknown>;
  action(key: string, fn: () => Promise<unknown>): Promise<void>;
  setNotice(text: string): void;
  dismissError(): Promise<void>;
  refreshUsage(account: Account, allowPrompt?: boolean): Promise<void>;
  desktopRequest?: DesktopActionRequest;
  requestDesktop(
    account: Account | undefined,
    kind: DesktopActionRequest["kind"],
  ): void;
  cancelDesktopRequest(): void;
  confirmDesktopAction(): void;
  setupId?: string;
  setSetupId(id: string | undefined): void;
  flow?: AuthFlow;
  flowAccount?: Account;
  startCli(account: Account): Promise<void>;
  dismissFlow(): void;
  submitCode(code: string): void;
  historyRevision: number;
  suggestion?: Account;
  /** Legacy-only escape hatch: replaces the snapshot with a locally derived one. */
  setData: Dispatch<SetStateAction<Snapshot | undefined>>;
}

export const RelayContext = createContext<Relay | null>(null);

export function useRelay(): Relay {
  const value = useContext(RelayContext);
  if (!value) throw new Error("useRelay outside RelayProvider");
  return value;
}
