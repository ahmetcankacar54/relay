import path from "node:path";
import type { Diagnostics } from "../../shared/types";
import {
  command,
  profileEnvironment,
  resolveExecutable,
  supportsDesktop,
} from "./environment";

/**
 * Finds the official Claude Code CLI (`explicit` first, then the usual places) and reads its
 * version, in a throwaway profile under `dataDir` so no account is involved.
 */
export async function diagnoseCli(
  explicit: string | undefined,
  dataDir: string,
): Promise<Diagnostics> {
  const executable = resolveExecutable(explicit);
  const base = {
    executable,
    platform: process.platform,
    dataDir,
    desktopSupported: false,
  };
  if (!executable)
    return {
      ...base,
      error:
        "Claude Code bulunamadı. Resmi CLI’yi kur veya Ayarlar → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
    };
  try {
    const { stdout } = await command(
      executable,
      ["--version"],
      profileEnvironment(path.join(dataDir, "diagnostic")),
      dataDir,
    );
    const version = stdout.trim().slice(0, 150);
    return { ...base, version, desktopSupported: supportsDesktop(version) };
  } catch {
    return {
      ...base,
      error:
        "Claude Code sürümü okunamadı. Çalıştırılabilir dosyayı kontrol et.",
    };
  }
}
