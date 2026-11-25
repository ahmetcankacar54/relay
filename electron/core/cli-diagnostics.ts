import path from "node:path";
import type { Diagnostics } from "../../shared/types";
import {
  command,
  executableSource,
  profileEnvironment,
  resolveExecutable,
  supportsDesktop,
} from "./environment";
import { desktopUsageReadable } from "./desktop-usage";

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
    desktopUsage: await desktopUsageReadable(dataDir),
  };
  if (!executable)
    return {
      ...base,
      error:
        "Claude Code was not found. Open Code once in the Claude app (it downloads Claude Code itself) or pick it in Settings → Advanced → Claude Code CLI → Choose file.",
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
        "The Claude Code version could not be read. Check the executable.",
    };
  }
}
