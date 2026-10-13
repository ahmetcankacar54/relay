import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform === "darwin") {
  // Normal local releases always use the pinned certificate; an unavailable
  // identity is an error, never a new ad-hoc permission identity.
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/stable-signing.mjs"), ...process.argv.slice(2)],
    { cwd: root, stdio: "inherit" },
  );
} else {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/electron-builder/cli.js"),
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" },
  );
}
