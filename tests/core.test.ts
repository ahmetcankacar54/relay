import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/core/store";
import {
  profileEnvironment,
  supportsDesktop,
} from "../electron/core/environment";
import {
  scanSessions,
  copyTranscript,
  readTranscript,
} from "../electron/core/sessions";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const a = store.create({ name: "Personal A", kind: "personal" });
  const b = store.create({ name: "Personal B", kind: "personal" });
  const id = randomUUID();
  const projectFolder = "-test-project";
  const dir = path.join(store.profile(a.id), "projects", projectFolder);
  await fs.mkdir(dir, { recursive: true });
  const messageId = randomUUID();
  const text =
    [
      {
        type: "user",
        uuid: messageId,
        sessionId: id,
        cwd: root,
        message: { role: "user", content: "Continue this task" },
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: messageId,
        sessionId: id,
        cwd: root,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Progress is saved." },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "should not be displayed as text" },
            },
          ],
        },
      },
      { type: "custom-title", customTitle: "Reliable handoff", sessionId: id },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, text);
  const source = (await scanSessions(store.profile(a.id), a.id, [], {}))
    .sessions[0];
  return { root, store, a, b, id, source, file, text, messageId, dir };
}

test("accounts persist separate profiles and selected company sharing groups", async (t) => {
  const { store, root, a, b } = await fixture(t);
  const companyA = store.create({ name: "Company A", kind: "work" });
  const companyB = store.create({ name: "Company B", kind: "work" });
  assert.notEqual(companyA.group, companyB.group);
  const sharedA = store.create({
    name: "Shared A",
    kind: "work",
    group: "client",
  });
  const sharedB = store.create({
    name: "Shared B",
    kind: "work",
    group: "client",
  });
  assert.equal(sharedA.group, sharedB.group);
  assert.equal(a.group, b.group);
  assert.notEqual(store.profile(a.id), store.profile(b.id));
  const reopened = new Store(root);
  assert.equal(reopened.state.accounts.length, 6);
  assert.equal(reopened.account(a.id).name, "Personal A");
  if (process.platform !== "win32")
    assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  assert.throws(() => store.create({ name: "", kind: "personal" }));
  assert.throws(() => store.profile("../../elsewhere"));
});
test("corrupt state fails closed instead of erasing profiles", async (t) => {
  const { store, root } = await fixture(t);
  await fs.writeFile(store.file, "{broken");
  assert.throws(() => new Store(root));
  assert.equal(await fs.readFile(store.file, "utf8"), "{broken");
});
test("history parser extracts actual messages, custom title and partial tails safely", async (t) => {
  const { store, a, file, source } = await fixture(t);
  assert.equal(source.title, "Reliable handoff");
  assert.equal(source.messages, 2);
  await fs.appendFile(file, '{"partial":');
  const found = await scanSessions(store.profile(a.id), a.id, [source.key], {});
  assert.equal(found.sessions.length, 1);
  assert.equal(found.sessions[0].pinned, true);
  const preview = await readTranscript(found.sessions[0]);
  assert.equal(preview.length, 2);
  assert.equal(preview[1].text, "Progress is saved.");
  assert(!JSON.stringify(preview).includes("should not be displayed"));
});
test("A → B → A handoff creates independent branches and preserves both histories", async (t) => {
  const { store, a, b, source, text, messageId, file } = await fixture(t);
  const copyId = await copyTranscript(source, store.profile(b.id));
  assert.notEqual(copyId, source.id);
  const target = (await scanSessions(store.profile(b.id), b.id, [], {}))
    .sessions[0];
  assert.equal(target.id, copyId);
  assert.equal(target.messages, 2);
  const rows = (await fs.readFile(target.file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert(rows.every((r) => r.sessionId === copyId));
  assert.equal(rows[1].parentUuid, messageId);
  await fs.appendFile(
    target.file,
    JSON.stringify({
      type: "user",
      sessionId: copyId,
      cwd: source.projectDir,
      message: { content: "New work on B" },
    }) + "\n",
  );
  const returnId = await copyTranscript(target, store.profile(a.id));
  assert.notEqual(returnId, copyId);
  assert.notEqual(returnId, source.id);
  const restored = await scanSessions(store.profile(a.id), a.id, [], {});
  assert.equal(restored.sessions.length, 2);
  assert.equal(restored.sessions.find((s) => s.id === returnId)?.messages, 3);
  assert.equal(await fs.readFile(file, "utf8"), text);
});
test("history transfer never copies credentials, settings or other sessions", async (t) => {
  const { store, a, b, source } = await fixture(t);
  await fs.writeFile(
    path.join(store.profile(a.id), ".credentials.json"),
    "secret fixture",
  );
  await fs.writeFile(
    path.join(store.profile(a.id), "settings.json"),
    '{"hooks":"never copy"}',
  );
  await copyTranscript(source, store.profile(b.id));
  await assert.rejects(
    fs.access(path.join(store.profile(b.id), ".credentials.json")),
  );
  await assert.rejects(
    fs.access(path.join(store.profile(b.id), "settings.json")),
  );
  assert.equal(
    (await scanSessions(store.profile(b.id), b.id, [], {})).sessions.length,
    1,
  );
});
test("incomplete transcripts refuse transfer without creating a target", async (t) => {
  const { store, b, source, file } = await fixture(t);
  await fs.appendFile(file, '{"incomplete":');
  await assert.rejects(
    copyTranscript(source, store.profile(b.id)),
    /eksik veya bozuk/,
  );
  assert.equal(
    (await scanSessions(store.profile(b.id), b.id, [], {})).sessions.length,
    0,
  );
});
test("source and target symlinks cannot escape profile boundaries", async (t) => {
  if (process.platform === "win32")
    return t.skip("Symlink creation requires Windows developer privileges.");
  const { store, a, b, source, root, file } = await fixture(t);
  await fs.symlink(root, path.join(store.profile(b.id), "projects"));
  await assert.rejects(copyTranscript(source, store.profile(b.id)), /geçersiz/);
  const outside = path.join(root, "outside.jsonl");
  await fs.copyFile(file, outside);
  await fs.rm(file);
  await fs.symlink(outside, file);
  assert.equal(
    (await scanSessions(store.profile(a.id), a.id, [], {})).sessions.length,
    0,
  );
  await assert.rejects(
    copyTranscript(source, store.profile(b.id)),
    /dışında|bağlantı/,
  );
});
test("foreign session identities are not silently cloned", async (t) => {
  const { store, b, source, file } = await fixture(t);
  await fs.appendFile(
    file,
    JSON.stringify({ sessionId: randomUUID(), type: "user" }) + "\n",
  );
  await assert.rejects(
    copyTranscript(source, store.profile(b.id)),
    /farklı bir oturum/,
  );
});
test("ambient credentials and alternate routing cannot leak into another account", () => {
  const env = profileEnvironment("/test/profile", {
    PATH: "/bin",
    HOME: "/home/you",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    ANTHROPIC_BASE_URL: "https://wrong.example",
    ANTHROPIC_PROFILE: "work",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDECODE: "1",
    NODE_OPTIONS: "--require evil.js",
    RELAY_DEV_URL: "http://dev",
    ELECTRON_RUN_AS_NODE: "1",
    CLAUDE_CODE_GIT_BASH_PATH: "C:/Git/bash.exe",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/test/profile");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "C:/Git/bash.exe");
  assert(!Object.values(env).includes("secret"));
  assert(!("ANTHROPIC_BASE_URL" in env));
  assert(!("NODE_OPTIONS" in env));
});
test("Desktop requires a supported version and platform", () => {
  assert.equal(
    supportsDesktop("2.1.284 (Claude Code)", "darwin", "arm64"),
    false,
  );
  assert.equal(
    supportsDesktop("2.1.296 (Claude Code)", "darwin", "arm64"),
    true,
  );
  assert.equal(supportsDesktop("2.1.296", "win32", "x64"), true);
  assert.equal(supportsDesktop("2.1.296", "win32", "arm64"), false);
  assert.equal(supportsDesktop("2.1.296", "linux", "x64"), false);
  assert.equal(supportsDesktop("unknown", "darwin", "arm64"), false);
});
