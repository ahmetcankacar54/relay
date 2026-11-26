// Writes a golden blob of Electron's safeStorage, Relay's vault seal before format 2, so the
// Rust legacy unseal can be checked against real bytes on each OS.
//
//   npx electron scripts/parity/safe-storage-golden.cjs <tmp dir> [app name]
//
// The app name defaults to "Relay Golden", so no run reads or creates the real Relay's secret.
// On macOS the Safe Storage password comes from Chromium's mock keychain ("mock_password");
// on Windows the key is in <tmp dir>/Local State; on Linux it is the keyring secret whose
// application is <name> (or "peanuts" with no keyring). CI passes "Relay", the name the Rust
// unseal looks up, on throwaway runners (crates/relay-core/tests/legacy_unseal.rs).
// RELAY_GOLDEN_PASSWORD_STORE sets Chromium's --password-store on Linux ("basic" for `v10`).
// Writes <tmp dir>/golden.bin and <tmp dir>/golden.json, then quits.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PLAIN = "relay-golden";
const MOCK_PASSWORD = "mock_password";
const dir = process.argv[2] || process.env.RELAY_GOLDEN_DIR;
const appName =
  process.argv[3] || process.env.RELAY_GOLDEN_APP_NAME || "Relay Golden";
if (!dir || !path.isAbsolute(dir)) {
  console.error("safe-storage-golden: pass an absolute temp folder.");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
// macOS: Chromium's mock keychain answers every Safe Storage read with a fixed password, so
// the run never touches (or prompts for) a real Keychain item. The bytes are still Electron's.
if (process.platform === "darwin")
  app.commandLine.appendSwitch("use-mock-keychain");
app.setName(appName);
const passwordStore = process.env.RELAY_GOLDEN_PASSWORD_STORE;
if (process.platform === "linux" && passwordStore)
  app.commandLine.appendSwitch("password-store", passwordStore);
app.setPath("userData", dir);

app.whenReady().then(() => {
  app.dock?.hide();
  // With no keyring (basic_text) Electron seals only after this opt-in, with "peanuts".
  if (
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  )
    safeStorage.setUsePlainTextEncryption(true);
  if (!safeStorage.isEncryptionAvailable()) {
    console.error("safe-storage-golden: safeStorage is unavailable.");
    app.exit(1);
    return;
  }
  const sealed = safeStorage.encryptString(PLAIN);
  fs.writeFileSync(path.join(dir, "golden.bin"), sealed);
  fs.writeFileSync(
    path.join(dir, "golden.json"),
    JSON.stringify(
      {
        plain: PLAIN,
        appName,
        platform: process.platform,
        electron: process.versions.electron,
        // The mock keychain's fixed Safe Storage password; the real one is never read.
        password: process.platform === "darwin" ? MOCK_PASSWORD : undefined,
        backend:
          process.platform === "linux"
            ? safeStorage.getSelectedStorageBackend()
            : undefined,
      },
      null,
      2,
    ),
  );
  app.quit();
});
