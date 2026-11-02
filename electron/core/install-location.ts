import path from "node:path";

/**
 * Where the running Relay.app sits, as far as Gatekeeper cares. The share builds are not
 * notarized, so macOS asks once ("Open Anyway") and records the answer on the bundle. It cannot
 * record it on a disk image, which is read-only, or in App Translocation's randomized read-only
 * copy (a quarantined app opened where it was downloaded or unpacked): there it asks at every
 * launch. "applications": /Applications or ~/Applications. "elsewhere": a writable place.
 */
export type BundlePlace = "applications" | "disk-image" | "translocated" | "elsewhere";

/** The .app bundle around the running executable (Contents/MacOS/<name>); undefined outside one. */
export function bundlePath(executable: string): string | undefined {
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  return path.basename(macos) === "MacOS" &&
    path.basename(contents) === "Contents" &&
    bundle.endsWith(".app")
    ? bundle
    : undefined;
}

export function bundlePlace(bundle: string, inApplications: boolean): BundlePlace {
  if (bundle.includes("/AppTranslocation/")) return "translocated";
  if (bundle.startsWith("/Volumes/")) return "disk-image";
  return inApplications ? "applications" : "elsewhere";
}

/** Places where macOS cannot keep the user's approval, so Relay offers to move itself. */
export const forgetsApproval = (place: BundlePlace) =>
  place === "disk-image" || place === "translocated";

/**
 * Removes the download quarantine from Relay's own bundle once it runs from a writable place.
 * Gatekeeper has already let this copy start, and it only assesses quarantined apps, so this
 * changes nothing for this version; it keeps an approval that macOS failed to record, or the
 * widget extension launched by the system, from asking again. The quarantine is not part of the
 * code signature. Never throws.
 */
export async function clearOwnQuarantine(
  bundle: string,
  run: (file: string, args: string[]) => Promise<unknown>,
): Promise<boolean> {
  try {
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", bundle]);
    return true;
  } catch {
    return false;
  }
}
