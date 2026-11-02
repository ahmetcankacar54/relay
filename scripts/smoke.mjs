import { execFileSync, spawn } from "node:child_process";
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
let code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
/**
 * The packaged widget: in PlugIns, validly signed, sandboxed with read access
 * to Relay's widget folder only, and linked to _NSExtensionMain (without it
 * chronod starts the extension and it exits).
 */
function checkWidget(bundle) {
  const appex = path.join(bundle, "Contents/PlugIns/RelayWidget.appex");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", appex]);
  const entitlements = execFileSync(
    "/usr/bin/codesign",
    ["--display", "--entitlements", "-", "--xml", appex],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  if (
    keys.sort().join() !==
      "com.apple.security.app-sandbox,com.apple.security.temporary-exception.files.home-relative-path.read-only" ||
    !entitlements.includes("/Library/Application Support/Relay/widget/")
  )
    throw new Error(`The widget's entitlements are not its sandbox: ${keys}`);
  const undefinedSymbols = execFileSync(
    "/usr/bin/nm",
    ["-u", path.join(appex, "Contents/MacOS/RelayWidget")],
    { encoding: "utf8" },
  );
  if (!/\b_NSExtensionMain\b/.test(undefinedSymbols))
    throw new Error("The widget is not linked to _NSExtensionMain.");
  const addon = path.join(
    bundle,
    "Contents/Resources/app.asar.unpacked/dist-electron/widget-center.node",
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", addon]);
  console.log("Widget extension and reload addon: signed and in place.");
}
if (code === 0 && packagedMain && process.platform === "darwin") {
  const bundle = packagedMain.slice(0, packagedMain.indexOf(".app/") + 4);
  try {
    checkWidget(bundle);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
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
