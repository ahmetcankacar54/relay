// Summarizes a net log the switch diagnosis wrote: `npm run netlog [file]`. Without a file it
// reads the newest one in Relay's switch-diagnostics folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatNetLogSummary, summarizeNetLog } from "../electron/core/netlog-summary";

const folder = path.join(os.homedir(), "Library", "Application Support", "Relay", "switch-diagnostics");
const file =
  process.argv[2] ??
  fs
    .readdirSync(folder)
    .filter((name) => /^claude-net-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(folder, name))
    .at(-1);
if (!file) {
  console.error(`No net log in ${folder}. Turn on Settings → Geçiş tanı kaydı and switch once.`);
  process.exit(1);
}
console.log(file);
console.log(formatNetLogSummary(summarizeNetLog(fs.readFileSync(file, "utf8"))));
