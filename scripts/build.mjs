import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { buildNativeHelpers } from "./build-native.mjs";
await import("./icon.mjs");
await build({
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "node-pty"],
  sourcemap: true,
});

await copyFile(
  new URL("../assets/icon.png", import.meta.url),
  new URL("../dist-electron/icon.png", import.meta.url),
);

await buildNativeHelpers();
