#!/usr/bin/env node
// Starts the gateway for its parity recording (rust/README.md): a fresh fixture with the `gateway`
// scenario (risks accepted, the client key saved, a credential for every account), the fake
// provider APIs (fake-upstreams.mts), then `<relay> proxy start --yes --port $PORT` in the sandbox
// with loopback open and RELAY_PROXY_UPSTREAMS pointing at the fakes:
//   node scripts/parity/gateway-run.mjs <relay binary>
// It runs until stopped (SIGTERM or SIGINT), then stops the fakes and deletes the fixture.
import fs from "node:fs";
import path from "node:path";
import { FAKE_UPSTREAMS, startFakeUpstreams } from "./fake-upstreams.mts";
import { fixtureEnvironment, run } from "./fixture-run.mjs";
import { sandboxed } from "./sandbox.mjs";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: node scripts/parity/gateway-run.mjs <relay>\n");
  process.exit(2);
}
const extra = process.env.RELAY_PARITY_SCENARIO;
const { root, env } = fixtureEnvironment(extra ? `gateway,${extra}` : "gateway");
const upstreams = await startFakeUpstreams();
let code;
try {
  code = await run(
    sandboxed(
      [
        path.resolve(target),
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
