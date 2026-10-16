import { app, BrowserWindow, session, type Session } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  assertLocalStorage,
  draftJobPath,
  errorMessage,
  parseDraftJob,
  runDraftJob,
  type DraftJob,
  type DraftPage,
  type DraftResult,
} from "./draft-job";

// Relay's Electron, started by `entry.ts` as `--relay-draft-worker=<job.json>` while Claude is
// closed. It opens Claude's Chromium Local Storage through a scratch session root, so Chromium
// itself reads and writes its own LevelDB, and moves drafts with the real `localStorage` API.
// It never imports `main.ts`: nothing here may start the tray, a window or the network.

/** Every draft Claude keeps in Local Storage starts with this. */
const DRAFT_KEY_PREFIX = "composer-draft:";
/** The origin Claude's Local Storage belongs to. */
const ORIGIN = "https://claude.ai/";
/** Below the caller's 10 000 ms kill, so the helper can report why it stopped and exit itself. */
const DEADLINE_MS = 8_000;

/** The page's side of a call: a script that gets JSON in as text and gives JSON back as text. */
function pageFor(win: BrowserWindow, ses: Session): DraftPage {
  const run = (script: string): Promise<unknown> =>
    win.webContents.executeJavaScript(script);
  return {
    async size() {
      return Number(await run("localStorage.length"));
    },
    async read() {
      const json = await run(`(() => {
        const drafts = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key !== null && key.startsWith(${JSON.stringify(DRAFT_KEY_PREFIX)}))
            drafts[key] = localStorage.getItem(key);
        }
        return JSON.stringify(drafts);
      })()`);
      return JSON.parse(String(json)) as Record<string, string>;
    },
    async apply(ops) {
      const json = JSON.stringify({ set: ops.set, remove: ops.remove });
      await run(`(() => {
        const ops = JSON.parse(${JSON.stringify(json)});
        for (const [key, value] of Object.entries(ops.set)) localStorage.setItem(key, value);
        for (const key of ops.remove) localStorage.removeItem(key);
      })()`);
    },
    async flush() {
      ses.flushStorageData();
    },
  };
}

/** Makes `<scratch>/root` hold a `Local Storage` link to Claude's, and returns the root. */
function linkLocalStorage(job: DraftJob): string {
  // Chromium would create a missing `leveldb` inside Claude's directory.
  assertLocalStorage(job.storage);
  const root = path.join(job.scratch, "root");
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(
    job.storage,
    path.join(root, "Local Storage"),
    process.platform === "win32" ? "junction" : undefined,
  );
  return root;
}

function readJob(): DraftJob {
  const file = draftJobPath(process.argv);
  if (!file) throw new Error("No job file was given.");
  return parseDraftJob(JSON.parse(fs.readFileSync(file, "utf8")));
}

function main(): void {
  let job: DraftJob;
  try {
    job = readJob();
  } catch (error) {
    // Without a valid job there is nowhere to report to.
    console.error(`Relay draft helper: ${errorMessage(error)}`);
    app.exit(1);
    return;
  }

  let finished = false;
  /** Writes the result, then exits. The first call wins. A failure exits non-zero. */
  const finish = (result: DraftResult): void => {
    if (finished) return;
    finished = true;
    let code = result.ok ? 0 : 1;
    try {
      fs.writeFileSync(job.result, JSON.stringify(result));
    } catch (error) {
      console.error(`Relay draft helper: ${errorMessage(error)}`);
      code = 1;
    }
    app.exit(code);
  };
  const fail = (error: unknown): void =>
    finish({ ok: false, error: errorMessage(error) });
  // Otherwise Electron would show an error dialog and wait for it.
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  setTimeout(() => fail(new Error("helper timed out")), DEADLINE_MS);

  app.setPath("userData", path.join(job.scratch, "userData"));
  app.disableHardwareAcceleration();
  app.dock?.hide();
  // Destroying the hidden window must not quit the app before the result is written.
  app.on("window-all-closed", () => {});

  app
    .whenReady()
    .then(async () => {
      let win: BrowserWindow | undefined;
      let result: DraftResult;
      try {
        const ses = session.fromPath(linkLocalStorage(job));
        // Every https request, even claude.ai itself, gets a blank page: no network is used.
        ses.protocol.handle(
          "https",
          () =>
            new Response("<!doctype html>", {
              headers: { "content-type": "text/html" },
            }),
        );
        win = new BrowserWindow({
          show: false,
          // No dictionary download is ever attempted.
          webPreferences: { session: ses, spellcheck: false },
        });
        win.webContents.on("render-process-gone", () =>
          fail(new Error("renderer gone")),
        );
        await win.loadURL(ORIGIN);
        result = await runDraftJob(job, pageFor(win, ses));
      } catch (error) {
        result = { ok: false, error: errorMessage(error) };
      } finally {
        try {
          win?.destroy();
        } catch {
          // The result is what counts; the process exits next.
        }
      }
      finish(result);
    })
    .catch(fail);
}

main();
