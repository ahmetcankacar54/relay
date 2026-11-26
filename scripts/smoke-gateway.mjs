// Gateway smoke: the `relay` binary the app runs its Proxy Gateway with (`relay __gateway`,
// electron/main/gateway-sidecar.ts) starts from where the package put it, listens on a free
// port, answers /status with its client key and stops when asked. No account, no upstream and
// no network beyond this computer's loopback.
//
//   node scripts/smoke-gateway.mjs            the binary electron-builder --dir put in release/
//   node scripts/smoke-gateway.mjs <binary>   another one (target/debug/relay, say)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Where electron-builder --dir leaves the app's resources on this platform. */
const PACKAGED_RESOURCES = {
  darwin: `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Relay.app/Contents/Resources`,
  win32: "release/win-unpacked/resources",
  linux: "release/linux-unpacked/resources",
};
const KEY = "relay-sec-smoke-test-key";
const TIMEOUT_MS = 20_000;

const binary = path.resolve(
  process.argv[2] ||
    path.join(
      root,
      PACKAGED_RESOURCES[process.platform] ?? "",
      "bin",
      process.platform === "win32" ? "relay.exe" : "relay",
    ),
);
if (!existsSync(binary)) {
  console.error(`${binary} is missing: run npx electron-builder --dir first.`);
  process.exit(1);
}

const within = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${what}.`)),
        TIMEOUT_MS,
      ).unref(),
    ),
  ]);

const child = spawn(binary, ["__gateway"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? signal));
});
const lines = readline.createInterface({ input: child.stdout });
const next = () =>
  new Promise((resolve, reject) => {
    lines.once("line", (line) => resolve(JSON.parse(line)));
    exited.then(
      (code) => reject(new Error(`relay __gateway exited with ${code}.`)),
      reject,
    );
  });
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

try {
  const first = next();
  send({
    t: "config",
    config: { enabled: true, host: "127.0.0.1", port: 0, apiKey: KEY },
  });
  const ready = await within(first, "the gateway to listen");
  if (ready.t !== "ready" || !Number.isInteger(ready.port) || ready.port <= 0)
    throw new Error(`The gateway did not start: ${JSON.stringify(ready)}`);
  const url = `http://127.0.0.1:${ready.port}/status`;
  const refused = await fetch(url);
  if (refused.status !== 401)
    throw new Error(
      `/status without the key answered ${refused.status}, not 401.`,
    );
  const answer = await fetch(url, { headers: { "x-relay-key": KEY } });
  const status = await answer.json();
  if (
    answer.status !== 200 ||
    status.ok !== true ||
    status.state?.status !== "running"
  )
    throw new Error(
      `/status answered ${answer.status}: ${JSON.stringify(status)}`,
    );
  send({ t: "stop" });
  child.stdin.end();
  const code = await within(exited, "the gateway to stop");
  if (code !== 0)
    throw new Error(`relay __gateway exited with ${code} after stop.`);
  console.log(
    `PASS: ${path.relative(root, binary) || binary} ran the gateway on port ${ready.port}, answered /status and stopped.`,
  );
} catch (error) {
  console.error(error);
  child.kill("SIGKILL");
  process.exitCode = 1;
}
