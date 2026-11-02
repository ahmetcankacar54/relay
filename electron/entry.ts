import path from "node:path";
import { draftJobPath } from "./draft-job";

// The packaged app starts through package.json's "main". Relay's own Electron doubles as the
// draft helper, so this one entry decides which of the two bundles this process runs. The names
// are joined at runtime so the build leaves both bundles as they are.
require(
  path.join(
    __dirname,
    draftJobPath(process.argv) ? "draft-worker.cjs" : "main.cjs",
  ),
);
