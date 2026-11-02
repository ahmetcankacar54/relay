import type { RelaySettings } from "../../shared/types";
/** Electron's nativeTheme.themeSource for the saved appearance. */
export function themeSource(settings: Pick<RelaySettings, "appearance">) {
  return settings.appearance;
}
