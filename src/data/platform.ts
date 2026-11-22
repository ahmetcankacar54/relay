import { useContext } from "react";
import { RelayContext } from "./relay-context";
import type { T } from "../../shared/i18n/translate";

/**
 * Relay's platform (`diagnostics.platform`), or undefined before the first snapshot and outside a
 * RelayProvider (components rendered alone keep their macOS wording).
 */
export function usePlatform(): string | undefined {
  return useContext(RelayContext)?.data?.diagnostics?.platform;
}

/**
 * Whether copy says "Mac" and "Keychain": on macOS, in the UI preview, and until the platform is
 * known, so macOS never shows another wording first.
 */
export const macWording = (platform?: string) =>
  !platform || platform === "darwin" || platform === "preview";

/**
 * The store that keeps Claude's and Relay's secrets, as a button and a sentence say it: the
 * Keychain on macOS, the desktop's keyring (KWallet or the Secret Service) on Linux.
 */
export function keychainWords(platform: string | undefined, t: T) {
  return macWording(platform)
    ? {
        allow: t("platform.allowKeychainAccess"),
        needed: t("platform.relayNeedsKeychainAccessToRead"),
        neededFor: (name: string) =>
          t("platform.relayNeedsKeychainAccessToRead2", { name }),
      }
    : {
        allow: t("platform.allowKeyringAccess"),
        needed: t("platform.relayNeedsKeyringAccessKwalletOr"),
        neededFor: (name: string) =>
          t("platform.relayNeedsKeyringAccessKwalletOr2", { name }),
      };
}
