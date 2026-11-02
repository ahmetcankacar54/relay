import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { pickLang, translator } from "../cli/src/i18n";
import { foldName, resolveAccount } from "../cli/src/accounts";
import { parseCommand } from "../cli/src/args";
import { confirm } from "../cli/src/confirm";
import { paint, table } from "../cli/src/output";
import { openContext } from "../cli/src/context";
import { shielded } from "../cli/src/shield";
import { CliError, EXIT } from "../cli/src/io";
import { describeError } from "../cli/src/main";
import { writeBytes } from "../electron/core/desktop-files";
import { STATE_SCHEMA } from "../electron/core/store";
import type { Account } from "../shared/types";

const acct = (name: string, id = crypto.randomUUID()): Account => ({
  id,
  name,
  kind: "personal",
  group: "personal",
  color: "terra",
  createdAt: new Date().toISOString(),
});

test("--version, help and an unknown command", async (t) => {
  const f = await cliFixture(t);
  assert.equal(await f.run("--version"), 0);
  assert.match(f.out(), /^0\.1\.0/);
  f.clear();
  assert.equal(await f.run("help"), 0);
  assert.match(f.out(), /relay switch <name>/);
  f.clear();
  assert.equal(await f.run(), 0);
  assert.match(f.out(), /Usage/);
  assert.equal(await f.run("frobnicate"), 2);
  assert.match(f.err(), /frobnicate/);
  assert.equal(await f.run("--frob"), 2);
});

test("help follows the language", async (t) => {
  const f = await cliFixture(t, { env: { LANG: "tr_TR.UTF-8" } });
  await f.run("help");
  assert.match(f.out(), /Kullanım/);
});

test("language: --lang, then RELAY_LANG, then LC_ALL/LC_MESSAGES/LANG, else English", () => {
  assert.equal(pickLang(undefined, { LANG: "tr_TR.UTF-8" }), "tr");
  assert.equal(pickLang(undefined, { LC_ALL: "en_US.UTF-8", LANG: "tr_TR.UTF-8" }), "en");
  assert.equal(pickLang(undefined, { LC_MESSAGES: "tr_TR.UTF-8", LANG: "en_US.UTF-8" }), "tr");
  assert.equal(pickLang(undefined, { RELAY_LANG: "tr", LANG: "en_US.UTF-8" }), "tr");
  assert.equal(pickLang("en", { RELAY_LANG: "tr" }), "en");
  assert.equal(pickLang(undefined, {}), "en");
  assert.equal(translator("tr")("evet", "yes"), "evet");
});

test("arguments: global flags, command flags, positionals and -- passthrough", () => {
  const p = parseCommand(["--lang", "tr", "run", "Work", "--", "--resume", "x"]);
  assert.equal(p.command, "run");
  assert.deepEqual(p.positionals, ["Work"]);
  assert.deepEqual(p.rest, ["--resume", "x"]);
  assert.equal(p.flags.lang, "tr");
  assert.equal(parseCommand(["switch", "B", "-y"]).flags.yes, true);
  assert.throws(() => parseCommand(["switch", "--days", "7"]), (e: any) => e instanceof CliError && e.code === 2);
  assert.throws(() => parseCommand(["list", "--nope"]), (e: any) => e.code === 2);
});

test("Turkish names fold İ/I/ı to i and keep ş", () => {
  const accounts = [acct("İş"), acct("Kişisel")];
  for (const q of ["iş", "IŞ", "İŞ", "ış", "İş"]) assert.equal(resolveAccount(accounts, q).name, "İş");
  assert.throws(() => resolveAccount(accounts, "is"), (e: any) => e.code === 2);
  assert.equal(foldName("  İSTANBUL "), "istanbul");
  assert.throws(() => resolveAccount([acct("Work"), acct("Workshop")], "wor"), /Work, Workshop/);
  assert.equal(resolveAccount([acct("Work"), acct("Workshop")], "work").name, "Work");
  const byId = acct("Same", "abcdef12-0000-4000-8000-000000000000");
  assert.equal(resolveAccount([acct("Same"), byId], "abcdef12").id, byId.id);
});

test("a confirmation without a TTY and without --yes exits 4", async () => {
  const io = { isTTY: false, stdout: () => {}, prompt: async () => "y" } as any;
  await assert.rejects(confirm(io, translator("en"), ["Claude will quit."], false), (e: any) => e.code === EXIT.confirm);
  await confirm(io, translator("en"), [], true);
});

test("a TTY confirmation accepts y/yes (and e/evet in Turkish); anything else or Ctrl+C cancels", async () => {
  const ask = (answer: string | undefined) => ({ isTTY: true, stdout: () => {}, prompt: async () => answer }) as any;
  await confirm(ask("y"), translator("en"), [], false);
  await confirm(ask(" YES "), translator("en"), [], false);
  await confirm(ask("evet"), translator("tr"), [], false);
  await confirm(ask("e"), translator("tr"), [], false);
  await assert.rejects(confirm(ask("e"), translator("en"), [], false), (e: any) => e.code === EXIT.failed);
  await assert.rejects(confirm(ask("h"), translator("tr"), [], false), (e: any) => e.code === EXIT.failed);
  await assert.rejects(confirm(ask(undefined), translator("en"), [], false), /Cancelled/);
});

test("piped output has no ANSI codes", () => {
  assert.equal(paint(false, "green", "ok"), "ok");
  assert.match(paint(true, "green", "ok"), /\x1b\[/);
  const text = table(["Name", "Kind"], [["İş", "work"], ["Kişisel", "personal"]]);
  assert.ok(!text.includes("\x1b"));
  assert.equal(text.split("\n")[1].indexOf("work"), text.split("\n")[0].indexOf("Kind"));
});

test("a format-1 vault, a newer marker and an old Relay.app refuse writes with exit 5; reads still work", async (t) => {
  const f = await cliFixture(t);
  await writeBytes(path.join(f.home, "desktop-vault"), "accounts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin", Buffer.from("v10old"));
  const flags = { lang: "en" } as any;
  await assert.rejects(openContext(f.io, f.deps as any, flags, { write: true, desktop: true }), (e: any) => e.code === EXIT.environment && /0\.12/.test(e.message));
  const read = await openContext(f.io, f.deps as any, flags, { write: false, desktop: false });
  assert.equal(read.vault.kind, "legacy");
  const g = await cliFixture(t);
  await writeBytes(path.join(g.home, "desktop-vault"), "format.json", Buffer.from('{"version":3}'));
  await assert.rejects(openContext(g.io, g.deps as any, flags, { write: true, desktop: true }), (e: any) => e.code === EXIT.environment);
  const h = await cliFixture(t, { appVersion: "0.11.0" });
  await assert.rejects(openContext(h.io, h.deps as any, flags, { write: true, desktop: true }), (e: any) => e.code === EXIT.environment && /0\.12/.test(e.message));
  await openContext(h.io, h.deps as any, flags, { write: false, desktop: false });
});

test("a schema-less registry next to an installed Relay.app refuses writes; without an app it is adopted", async (t) => {
  const f = await cliFixture(t, { appVersion: "0.12.0" });
  await f.saved("A");
  const file = path.join(f.home, "state.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  delete raw.schema;
  fs.writeFileSync(file, JSON.stringify(raw));
  await assert.rejects(openContext(f.io, f.deps as any, { lang: "en" } as any, { write: true, desktop: true }), (e: any) => e.code === EXIT.environment);
  const g = await cliFixture(t);
  await g.saved("A");
  const graw = JSON.parse(fs.readFileSync(path.join(g.home, "state.json"), "utf8"));
  delete graw.schema;
  fs.writeFileSync(path.join(g.home, "state.json"), JSON.stringify(graw));
  const ctx = await openContext(g.io, g.deps as any, { lang: "en" } as any, { write: true, desktop: true });
  ctx.store.update(() => {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(g.home, "state.json"), "utf8")).schema, STATE_SCHEMA);
});

test("a missing key with format-2 files exits 5 and never creates a key", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  f.security.removeItem("Relay Vault Key");
  const stdinBefore = f.security.stdinLog();
  await assert.rejects(
    openContext(f.io, f.deps as any, { lang: "en" } as any, { write: true, desktop: true }),
    (e: any) => e.code === EXIT.environment && /Relay Vault Key/.test(e.message),
  );
  assert.equal(f.security.stdinLog(), stdinBefore);
});

test("an empty vault gets a key and the marker on the first writing command", async (t) => {
  const f = await cliFixture(t);
  await openContext(f.io, f.deps as any, { lang: "en" } as any, { write: true, desktop: true });
  assert.notEqual(f.security.stored(), "");
  assert.ok(fs.existsSync(path.join(f.home, "desktop-vault", "format.json")));
});

test("shielded ignores signals during the operation and prints one wait line", async (t) => {
  const f = await cliFixture(t);
  const result = await shielded(f.io, translator("en"), async () => {
    f.signal("SIGINT");
    f.signal("SIGTERM");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(f.err().split("\n").filter((l) => /wait/i.test(l)).length, 1);
  assert.equal(f.hasSignalHandler(), false);
});

test("a registry this relay cannot read names state.json instead of printing raw schema errors", async (t) => {
  const f = await cliFixture(t);
  await f.saved("A");
  const file = path.join(f.home, "state.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.settings.desktopHistoryTransfer = "sometimes";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(await f.run("list"), 1);
  assert.match(f.err(), /state\.json/);
  assert.doesNotMatch(f.err(), /relay: \[/);
});

test("a legacy vault next to Relay.app 0.12 points to the app's Keychain prompt, not to an update", async (t) => {
  const f = await cliFixture(t, { appVersion: "0.12.0" });
  await writeBytes(path.join(f.home, "desktop-vault"), "accounts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin", Buffer.from("v10old"));
  await assert.rejects(
    openContext(f.io, f.deps as any, { lang: "en" } as any, { write: true, desktop: true }),
    (e: any) => e.code === EXIT.environment && /Keychain prompt/.test(e.message) && !/Update Relay\.app/.test(e.message),
  );
});

test("a core error the app knows in both languages is shown in the CLI's language", () => {
  const core = new Error("Connect this account in Claude Desktop first.");
  assert.equal(describeError(core, translator("tr")).message, "Önce bu hesabı Claude uygulamasında bağla.");
  assert.equal(describeError(core, translator("en")).message, "Connect this account in the Claude app first.");
  // The blocked ones keep their own words, with the relay command that clears them.
  assert.match(
    describeError(new Error("Finish or cancel the current Desktop sign-in first."), translator("tr")).message,
    /relay add --resume ile bitir/,
  );
});
