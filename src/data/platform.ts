import { useContext } from "react";
import { RelayContext } from "./relay-context";

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
export function keychainWords(platform: string | undefined, t: (tr: string, en: string) => string) {
  return macWording(platform)
    ? {
        allow: t("Anahtarlık erişimine izin ver", "Allow Keychain access"),
        needed: t("Limitleri okumak için Anahtarlık erişimi gerekiyor.", "Relay needs Keychain access to read limits."),
        neededFor: (name: string) =>
          t(
            `${name} · limitleri okumak için Anahtarlık erişimi gerekiyor.`,
            `${name} · Relay needs Keychain access to read the limits.`,
          ),
      }
    : {
        allow: t("Anahtar deposu erişimine izin ver", "Allow keyring access"),
        needed: t(
          "Limitleri okumak için anahtar deposu (KWallet ya da Secret Service) erişimi gerekiyor.",
          "Relay needs keyring access (KWallet or Secret Service) to read limits.",
        ),
        neededFor: (name: string) =>
          t(
            `${name} · limitleri okumak için anahtar deposu (KWallet ya da Secret Service) erişimi gerekiyor.`,
            `${name} · Relay needs keyring access (KWallet or Secret Service) to read the limits.`,
          ),
      };
}
