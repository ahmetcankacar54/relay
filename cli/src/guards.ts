import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError, EXIT } from "./io";
import type { Translate } from "./i18n";
import type { CliDeps } from "./deps";

/** Whether dotted version `version` is below `floor`. */
export function olderThan(version: string, floor: string): boolean {
  const a = version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = floor.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

export const updateAppMessage = (t: Translate) =>
  t(
    "Relay.app’i 0.12 veya üstüne güncelleyip bir kez aç.",
    "Update Relay.app to 0.12 or later and open it once.",
  );

/** The installed Relay.app writes an older account list than this relay: not the "older than 0.12" case. */
export const appOlderMessage = (t: Translate) =>
  t(
    "Relay.app’in yazdığı hesap listesi bu relay’inkinden eski. Relay.app’i relay ile aynı sürüme güncelleyip bir kez aç ya da Relay.app’e uyan relay sürümünü kur.",
    "Relay.app writes an older account list than this relay. Update Relay.app to the same version as relay and open it once, or install the relay version that matches Relay.app.",
  );

/** Refuses to quit or open Claude without a macOS desktop session (over SSH, for example). */
export function guiSessionGuard(deps: CliDeps, t: Translate): void {
  if (!deps.guiSession())
    throw new CliError(
      t(
        "Bu oturumda macOS masaüstü yok (örneğin SSH): Claude uygulaması buradan kapatılıp açılamaz.",
        "This session has no macOS desktop (over SSH, for example): the Claude app cannot be quit or opened from here.",
      ),
      EXIT.environment,
    );
}

/** Whether this process may create and remove a file in `dir`; a sandbox may forbid it. */
export function probeWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `.probe-${randomUUID()}`);
    fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
