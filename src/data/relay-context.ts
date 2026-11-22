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
import type { DesktopActionRequest } from "../features/DesktopActionReview";

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
  /** One action at a time: true once `fn` resolved, false when it did not run or failed. */
  action(key: string, fn: () => Promise<unknown>): Promise<boolean>;
  /** A call that changes no Relay state, outside the action lock; a failure is shown. */
  report(fn: () => Promise<unknown>): Promise<void>;
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
  /** The usage sign-in through `action`: true once it started. */
  startCli(account: Account): Promise<boolean>;
  dismissFlow(): void;
  submitCode(code: string): void;
  historyRevision: number;
  suggestion?: Account;
  /** Escape hatch: replaces the snapshot with a locally derived one. */
  setData: Dispatch<SetStateAction<Snapshot | undefined>>;
}

export const RelayContext = createContext<Relay | null>(null);

export function useRelay(): Relay {
  const value = useContext(RelayContext);
  if (!value) throw new Error("useRelay outside RelayProvider");
  return value;
}
