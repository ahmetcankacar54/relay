import { build } from "esbuild";
import { buildNativeHelpers } from "./build-native.mjs";
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

await buildNativeHelpers();
