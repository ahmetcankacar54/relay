// Builds the relay CLI for npm: one ESM bundle (Relay's Electron-free core, zod inlined) and a
// plain-syntax launcher that checks macOS and the Node version before loading it.
import { build } from "esbuild";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";

const out = new URL("../cli/dist/", import.meta.url);
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [new URL("../cli/src/bin.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: new URL("relay-cli.js", out).pathname,
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
await copyFile(new URL("../cli/launcher.js", import.meta.url), new URL("relay.js", out));
await chmod(new URL("relay.js", out), 0o755);
