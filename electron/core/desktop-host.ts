import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopHost } from "./desktop";
import { macDesktopPids } from "./desktop-processes";
import { draftsBlockedReason, runHelper } from "./draft-transfer";
const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function desktopHost(): DesktopHost {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Claude.app/Contents/MacOS/Claude",
          path.join(
            os.homedir(),
            "Applications/Claude.app/Contents/MacOS/Claude",
          ),
        ]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "AnthropicClaude/claude.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "Programs/Claude/Claude.exe",
            ),
          ]
        : [];
  const executable = candidates.find(
    (p) => path.isAbsolute(p) && fs.existsSync(p),
  );
  const pids = async (): Promise<number[]> => {
    if (!executable) return [];
    if (process.platform === "darwin") {
      const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="], {
        timeout: 5000,
      });
      return macDesktopPids(stdout, executable);
    }
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name Claude -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress",
      ],
      { timeout: 5000, windowsHide: true },
    );
    if (!stdout.trim()) return [];
    const result = JSON.parse(stdout);
    return (Array.isArray(result) ? result : [result])
      .filter(
        (p) =>
          typeof p.Path === "string" &&
          p.Path.toLowerCase() === executable.toLowerCase(),
      )
      .map((p) => Number(p.Id))
      .filter(Number.isSafeInteger);
  };
  /** The Electron version inside Claude.app, or undefined when it cannot be read. macOS only. */
  const readClaudeElectron = async (): Promise<string | undefined> => {
    if (!executable) return undefined;
    const bundle = executable.slice(0, executable.indexOf(".app/") + 4);
    try {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        [
          "-extract",
          "CFBundleVersion",
          "raw",
          path.join(
            bundle,
            "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist",
          ),
        ],
        { timeout: 5000 },
      );
      return stdout.trim();
    } catch {
      return undefined;
    }
  };
  return {
    available: async () => !!executable,
    running: async () => (await pids()).length > 0,
    quit: async () => {
      const active = await pids();
      if (!active.length) return;
      if (process.platform === "darwin")
        await exec(
          "/usr/bin/osascript",
          [
            "-e",
            'tell application id "com.anthropic.claudefordesktop" to quit',
          ],
          { timeout: 20_000 },
        );
      else {
        try {
          await exec(
            "taskkill.exe",
            active.flatMap((pid) => ["/PID", String(pid)]),
            { timeout: 20_000, windowsHide: true },
          );
        } catch (error) {
          if ((await pids()).length) throw error;
        }
      }
      for (let i = 0; i < 40; i++) {
        if (!(await pids()).length) return;
        await delay(250);
      }
      throw new Error(
        "Claude Desktop did not close. Finish running work and quit Claude, then try again. No files changed.",
      );
    },
    launch: async () => {
      if (!executable) throw new Error("Claude Desktop is not installed.");
      if (process.platform === "darwin")
        await exec(
          "/usr/bin/open",
          ["-a", executable.slice(0, executable.indexOf(".app/") + 4)],
          { timeout: 10_000 },
        );
      else
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, [], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
    },
    seal: (text) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error(
          "System encryption is unavailable. Desktop sign-in was not saved.",
        );
      return safeStorage.encryptString(text);
    },
    unseal: (data) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("System encryption is unavailable.");
      return safeStorage.decryptString(data);
    },
    draftsBlocked: async () =>
      draftsBlockedReason(
        process.platform,
        process.platform === "darwin" ? await readClaudeElectron() : undefined,
        process.versions.electron,
      ),
    claudeElectron: async () =>
      process.platform === "darwin" ? readClaudeElectron() : undefined,
    moveDrafts: (job) =>
      runHelper(job, {
        execPath: process.execPath,
        packaged: app.isPackaged,
        // dist-electron, beside main.cjs, once bundled.
        dir: __dirname,
        env: process.env,
        spawn,
        writeFile: fs.promises.writeFile,
        readFile: fs.promises.readFile,
      }),
  };
}
