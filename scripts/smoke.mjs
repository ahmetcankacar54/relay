import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import electron from "electron";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-test-"));
const packagedMain = process.argv.includes("--packaged")
  ? path.resolve(
      process.env.RELAY_PACKAGED_MAIN ||
        "release/mac-arm64/Relay.app/Contents/Resources/app.asar/dist-electron/main.cjs",
    )
  : "";
const child = spawn(electron, ["scripts/smoke.cjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    RELAY_SMOKE_ROOT: root,
    RELAY_SMOKE_MAIN: packagedMain,
  },
});
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
// Chromium may write storage during shutdown. Clean up only after Electron has fully exited.
if (code === 0)
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
else console.error(`Test fixture retained at ${root}`);
process.exitCode = code;
