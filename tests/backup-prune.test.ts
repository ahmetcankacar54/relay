import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SWITCH_BACKUP_LIMIT,
  pruneSwitchBackups,
} from "../electron/core/backup-prune";

const START = Date.parse("2026-10-13T09:00:00Z") / 1000;

function vault(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-backups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "backups"));
  return root;
}
/** Writes `count` backups, oldest first, a minute apart; returns their ids in that order. */
function backups(root: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const file = path.join(root, "backups", `${id}.bin`);
    fs.writeFileSync(file, "sealed");
    fs.utimesSync(file, START + i * 60, START + i * 60);
    ids.push(id);
  }
  return ids;
}
const left = (root: string) =>
  fs.readdirSync(path.join(root, "backups")).sort();

test("the newest 20 switch backups stay and older ones go", async (t) => {
  assert.equal(SWITCH_BACKUP_LIMIT, 20);
  const root = vault(t);
  const ids = backups(root, 25);
  assert.equal(await pruneSwitchBackups(root), 5);
  assert.deepEqual(left(root), ids.slice(5).map((id) => `${id}.bin`).sort());
  // Nothing more to remove the next time.
  assert.equal(await pruneSwitchBackups(root), 0);
});

test("the backup the recovery journal names is never removed, however old", async (t) => {
  const root = vault(t);
  const ids = backups(root, 23);
  fs.writeFileSync(path.join(root, "journal.json"), JSON.stringify({ backup: ids[0] }));
  assert.equal(await pruneSwitchBackups(root), 2);
  assert.deepEqual(
    left(root),
    [ids[0], ...ids.slice(3)].map((id) => `${id}.bin`).sort(),
  );
});

test("a journal that cannot be read removes nothing, and pruning never throws", async (t) => {
  const root = vault(t);
  backups(root, 22);
  fs.writeFileSync(path.join(root, "journal.json"), "{not json");
  assert.equal(await pruneSwitchBackups(root), 0);
  assert.equal(left(root).length, 22);
  // No backups folder at all.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "relay-backups-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(await pruneSwitchBackups(empty), 0);
});

test("only backup files are considered; other files stay", async (t) => {
  const root = vault(t);
  backups(root, 21);
  fs.writeFileSync(path.join(root, "backups", "notes.txt"), "keep");
  fs.mkdirSync(path.join(root, "backups", `${randomUUID()}.bin`));
  assert.equal(await pruneSwitchBackups(root), 1);
  assert.ok(left(root).includes("notes.txt"));
  assert.equal(left(root).length, 22);
});

test("a switch prunes once its backup and journal are written", () => {
  const desktop = fs.readFileSync(new URL("../electron/core/desktop.ts", import.meta.url), "utf8");
  const apply = desktop.slice(desktop.indexOf("private async apply("));
  const journal = apply.indexOf('jsonBytes({ backup: id })');
  const prune = apply.indexOf("pruneSwitchBackups(this.vault)");
  assert.ok(journal > 0 && prune > journal, "prune after the journal names the new backup");
  assert.ok(prune < apply.indexOf("for (const [relative, data] of changes)"));
});
