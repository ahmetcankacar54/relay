import path from "node:path";
import type { Diagnostics } from "../../shared/types";
import {
  command,
  executableSource,
  profileEnvironment,
  resolveExecutable,
  supportsDesktop,
} from "./environment";

/**
 * Finds the official Claude Code CLI (`explicit` first, then the usual places, then the one the
 * Claude app downloaded) and reads its version, in a throwaway profile under `dataDir` so no
 * account is involved.
 */
export async function diagnoseCli(
  explicit: string | undefined,
  dataDir: string,
): Promise<Diagnostics> {
  const executable = resolveExecutable(explicit);
  const base = {
    executable,
    ...(executable ? { source: executableSource(executable, explicit) } : {}),
    platform: process.platform,
    dataDir,
    desktopSupported: false,
  };
  if (!executable)
    return {
      ...base,
      error:
        "Claude Code bulunamadı. Claude uygulamasında Code’u bir kez aç (Claude Code’u kendisi indirir) veya Ayarlar → Gelişmiş → Claude Code CLI → Dosyayı seç ile dosyasını göster.",
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
