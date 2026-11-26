#!/usr/bin/env node
// Starts the gateway for its parity recording (rust/README.md): a fresh fixture with the `gateway`
// scenario (risks accepted, the client key saved, a credential for every account), the fake
// provider APIs (fake-upstreams.ts), then `<relay> proxy start --yes --port $PORT` in the sandbox
// with loopback open and RELAY_PROXY_UPSTREAMS pointing at the fakes:
//   node scripts/parity/gateway-run.mjs <relay.js or binary>
// It runs until stopped (SIGTERM or SIGINT), then stops the fakes and deletes the fixture.
import fs from "node:fs";
import { fixtureEnvironment, run, targetCommand } from "./fixture-run.mjs";
import { sandboxed } from "./sandbox.mjs";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: node scripts/parity/gateway-run.mjs <relay>\n");
  process.exit(2);
}
const extra = process.env.RELAY_PARITY_SCENARIO;
const { root, env } = await fixtureEnvironment(
  extra ? `gateway,${extra}` : "gateway",
);
const { FAKE_UPSTREAMS, startFakeUpstreams } =
  await import("./fake-upstreams.ts");
const upstreams = await startFakeUpstreams();
let code;
try {
  code = await run(
    sandboxed(
      [
        ...targetCommand(target),
        "proxy",
        "start",
        "--yes",
        "--port",
        process.env.PORT || "18317",
      ],
      { localhost: true },
    ),
    { ...env, RELAY_PROXY_UPSTREAMS: JSON.stringify(FAKE_UPSTREAMS) },
  );
} finally {
  await upstreams.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(code);
