// Test-only Electron script for scripts/smoke.cjs. It puts fixture data into a brand-new Chromium
// Local Storage and reads every key back, with the same technique as the draft helper
// (electron/draft-worker.ts): session.fromPath, a blank https page and a hidden window.
// It opens <root> directly, so it only ever runs on a fixture directory made for the test.
//
//   electron local-storage.cjs seed <root> <seed.json> <userData>
//     <seed.json> is { "<key>": "<value>", ... }, every value a string. <root> must not hold a
//     Local Storage yet: this creates <root>/Local Storage/leveldb.
//   electron local-storage.cjs dump <root> <out.json> <userData>
//     Writes every key and value of <root>'s Local Storage to <out.json> in the same shape. It
//     refuses a <root> without Local Storage/leveldb, so it never creates one.
//
// <userData> is a scratch directory for this process only. The data reaches disk when this
// process quits, so a fixture is complete once its seed process has exited.
const { app, session, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/** The origin Claude's Local Storage belongs to. */
const ORIGIN = "https://claude.ai/";

const [mode, root, file, userData] = process.argv.slice(-4);

function fail(error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  // Otherwise Electron would show an error dialog and wait for it.
  app.exit(1);
}

function isDirectory(dir) {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
}

function readSeed() {
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries) ||
    Object.values(entries).some((value) => typeof value !== "string")
  )
    throw new Error("The seed file must hold an object of string values.");
  return entries;
}

if (
  !["seed", "dump"].includes(mode) ||
  ![root, file, userData].every((value) => path.isAbsolute(value ?? ""))
) {
  console.error(
    "usage: local-storage.cjs seed|dump <absolute root> <absolute json file> <absolute userData>",
  );
  app.exit(2);
} else {
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  app.disableHardwareAcceleration();
  app.dock?.hide();
  // Destroying the hidden window must not quit the app: only app.quit() below ends it.
  app.on("window-all-closed", () => {});
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);

  app
    .whenReady()
    .then(async () => {
      const storage = path.join(root, "Local Storage");
      let entries;
      if (mode === "seed") {
        entries = readSeed();
        if (fs.existsSync(storage))
          throw new Error(`${storage} exists: a seed needs a fresh root.`);
        fs.mkdirSync(root, { recursive: true });
      } else if (!isDirectory(path.join(storage, "leveldb"))) {
        throw new Error(`${storage}/leveldb is missing: nothing to dump.`);
      }

      const ses = session.fromPath(root);
      // Every https request, even claude.ai itself, gets a blank page: no network is used.
      ses.protocol.handle(
        "https",
        () =>
          new Response("<!doctype html>", {
            headers: { "content-type": "text/html" },
          }),
      );
      const win = new BrowserWindow({
        show: false,
        webPreferences: { session: ses, spellcheck: false },
      });
      await win.loadURL(ORIGIN);
      const run = (script) => win.webContents.executeJavaScript(script);

      if (mode === "seed") {
        const length = await run(`(() => {
          const entries = JSON.parse(${JSON.stringify(JSON.stringify(entries))});
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
          return localStorage.length;
        })()`);
        if (length !== Object.keys(entries).length)
          throw new Error(
            `Seeded ${Object.keys(entries).length} keys but Local Storage holds ${length}.`,
          );
        // Schedules the commit; the graceful quit below is what makes it reach the disk.
        ses.flushStorageData();
      } else {
        const json = await run(`(() => {
          const all = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            all[key] = localStorage.getItem(key);
          }
          return JSON.stringify(all);
        })()`);
        fs.writeFileSync(file, String(json));
      }
      win.destroy();
      app.quit();
    })
    .catch(fail);
}
