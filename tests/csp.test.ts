import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  contentSecurityPolicy,
  withContentSecurityPolicy,
} from "../scripts/csp";

const entries = ["index.html", "panel.html", "switch.html"];
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the built app's policy names no dev server; development keeps its hot-reload socket", () => {
  const built = contentSecurityPolicy("build");
  const dev = contentSecurityPolicy("serve");
  for (const origin of ["ws:", "5173", "127.0.0.1", "localhost", "http:"])
    assert.ok(!built.includes(origin), `${origin} in ${built}`);
  assert.match(built, /(^|; )connect-src 'self'(;|$)/);
  assert.match(dev, /(^|; )connect-src 'self' ws:\/\/127\.0\.0\.1:5173(;|$)/);
  // Apart from the socket, both modes are the same strict policy.
  assert.equal(dev.replace(" ws://127.0.0.1:5173", ""), built);
  for (const policy of [built, dev]) {
    assert.match(policy, /(^|; )script-src 'self'(;|$)/);
    assert.match(policy, /(^|; )object-src 'none'(;|$)/);
    assert.match(policy, /(^|; )base-uri 'none'(;|$)/);
    assert.match(policy, /(^|; )frame-src 'none'(;|$)/);
  }
});

test("every HTML entry gets the policy for the command", () => {
  for (const entry of entries) {
    const html = read(entry);
    const built = withContentSecurityPolicy(html, "build");
    assert.ok(
      built.includes(`content="${contentSecurityPolicy("build")}"`),
      entry,
    );
    assert.ok(!built.includes("5173"), entry);
    assert.equal(built.match(/Content-Security-Policy/g)?.length, 1, entry);
    const dev = withContentSecurityPolicy(html, "serve");
    assert.ok(
      dev.includes(`content="${contentSecurityPolicy("serve")}"`),
      entry,
    );
    // Only the policy changes.
    assert.equal(
      built.replace(/content="[^"]*default-src[^"]*"/, ""),
      html.replace(/content="[^"]*default-src[^"]*"/, ""),
      entry,
    );
  }
});

test("an entry without a policy fails the build instead of shipping without one", () => {
  assert.throws(
    () => withContentSecurityPolicy("<html><head></head></html>", "build"),
    /Content-Security-Policy/,
  );
});

test("vite applies the policy plugin to the three entries", () => {
  const config = read("vite.config.ts");
  assert.match(config, /contentSecurityPolicyPlugin\(\)/);
  for (const entry of entries) assert.ok(config.includes(`./${entry}`), entry);
});
