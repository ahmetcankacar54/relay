import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexCredential, writeCodexCredential } from "../electron/core/provider-credentials";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const ID = "33333333-3333-4333-8333-333333333333";

function dirs(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-cred-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile");
  const cli = path.join(root, "codex-auth.json");
  return { profile, cli };
}

test("a Codex sign-in follows the Codex CLI's fresh token while it is the same ChatGPT account", async (t) => {
  const { profile, cli } = dirs(t);
  const now = Date.now();
  const old = jwt({ exp: Math.floor(now / 1000) + 60 });
  await writeCodexCredential(profile, { kind: "chatgpt", accessToken: old, expiresAt: now + 60_000, accountId: ID });
  const fresh = jwt({ exp: Math.floor(now / 1000) + 86_400 });
  fs.writeFileSync(cli, JSON.stringify({ tokens: { access_token: fresh, account_id: ID } }));
  const read = await readCodexCredential(profile, { now, cliFiles: [cli] });
  assert.equal(read?.accessToken, fresh);
  // The CLI signed in to another ChatGPT account: the saved copy is used, never the other one.
  fs.writeFileSync(cli, JSON.stringify({ tokens: { access_token: fresh, account_id: "other" } }));
  assert.equal((await readCodexCredential(profile, { now, cliFiles: [cli] }))?.accessToken, old);
  // And once the saved copy expires there is no credential at all.
  assert.equal(await readCodexCredential(profile, { now: now + 120_000, cliFiles: [cli] }), undefined);
});

test("an API key never expires, and a 0.18 account's .credentials.json is still read with the access token's expiry", async (t) => {
  const { profile, cli } = dirs(t);
  await writeCodexCredential(profile, { kind: "api-key", accessToken: "sk-x" });
  assert.deepEqual(await readCodexCredential(profile, { cliFiles: [cli] }), { kind: "api-key", accessToken: "sk-x" });

  const legacy = path.join(path.dirname(profile), "legacy");
  fs.mkdirSync(legacy);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(
    path.join(legacy, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: jwt({ exp }), expiresAt: Date.now() - 1 } }),
  );
  const read = await readCodexCredential(legacy, { cliFiles: [cli] });
  assert.equal(read?.kind, "chatgpt");
  assert.equal(read?.expiresAt, exp * 1000, "the id token's earlier expiry no longer counts");
});
