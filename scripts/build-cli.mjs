// Builds the relay CLI for npm: one ESM bundle (Relay's Electron-free core, zod inlined), a small
// bundle for `relay statusline` alone (Claude Code runs it after every answer, so it must start
// fast), and a plain-syntax launcher that checks the Node version and picks one of them.
import { build } from "esbuild";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const out = new URL("../cli/dist/", import.meta.url);
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL("../cli/src/bin.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: fileURLToPath(new URL("relay-cli.js", out)),
  // Native, with an install script: the CLI package has no dependencies, so it is never installed
  // beside the CLI and the extension step reports itself unavailable there.
  external: ["classic-level"],
  // Readable on purpose: people can audit what they install.
  minify: false,
  metafile: true,
  // Bundled CommonJS dependencies may still call require.
  banner: {
    js: 'import { createRequire as __relayCreateRequire } from "node:module";\nconst require = __relayCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});
await writeFile(new URL("meta.json", out), JSON.stringify(result.metafile));
// No catalogs, no zod, no core: the statusline reads two small files and stdin.
await build({
  entryPoints: [fileURLToPath(new URL("../cli/src/statusline-bin.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: fileURLToPath(new URL("relay-statusline.js", out)),
  minify: false,
  logLevel: "warning",
});
await copyFile(new URL("../cli/launcher.js", import.meta.url), new URL("relay.js", out));
await chmod(new URL("relay.js", out), 0o755);
