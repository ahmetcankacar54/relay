import { spawn, spawnSync } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
await import("./build.mjs");
// The gateway runs target/debug/relay outside a package (electron/main/gateway.ts, gatewayBinary),
// unless RELAY_GATEWAY_BIN names another build.
if (!process.env.RELAY_GATEWAY_BIN) {
  const cargo = spawnSync("cargo", ["build", "-p", "relay-cli"], {
    stdio: "inherit",
  });
  if (cargo.error?.code === "ENOENT")
    console.warn(
      "cargo not found: skipped building target/debug/relay; the Proxy Gateway will not start (install Rust, or set RELAY_GATEWAY_BIN).",
    );
  else if (cargo.status !== 0)
    console.warn(
      "cargo build -p relay-cli failed: the Proxy Gateway will not start until it builds.",
    );
}
const server = await createServer();
await server.listen();
server.printUrls();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, RELAY_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill());
