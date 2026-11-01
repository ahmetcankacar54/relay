import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  FileContinuationJournal,
  readPrivateJson,
} from "../electron/core/continuation-journal";
import {
  CONTINUATION_TEXT,
  type ContinuationJournalRecord,
} from "../electron/core/continuation";

const NOW = Date.parse("2026-10-13T14:00:00Z");
function record(
  continuationText = CONTINUATION_TEXT,
): ContinuationJournalRecord {
  const id = randomUUID();
  const boundRequest = JSON.stringify({
    id,
    source: {
      profileId: randomUUID(),
      accountUuid: randomUUID(),
      orgId: randomUUID(),
    },
    target: {
      profileId: randomUUID(),
      accountUuid: randomUUID(),
      orgId: randomUUID(),
    },
    sessionId: randomUUID(),
    projectKey: "synthetic-project",
    transcriptRevision: "revision-1",
    permissionMode: "Auto",
    expectedContextRevision: 1,
    continuationText,
  });
  return {
    version: 1,
    id,
    fingerprint: createHash("sha256").update(boundRequest).digest("hex"),
    boundRequest,
    stage: "prepared",
    updatedAt: NOW,
    sendRecorded: false,
  };
}
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-continuation-journal-"));
}

test("journal writes reload unchanged and unfinished intents survive new instances", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory, () => NOW);
    const intent = record();
    await journal.withLock(intent.id, () => journal.write(intent));
    const reloaded = new FileContinuationJournal(directory, () => NOW);
    assert.deepEqual(await reloaded.read(intent.id), intent);
    assert.deepEqual(await reloaded.listPending(), [intent]);
    assert.equal(fs.existsSync(path.join(directory, "host.lock")), false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(
        fs.statSync(path.join(directory, `${intent.id}.journal.json`)).mode &
          0o777,
        0o600,
      );
    }
    assert.equal(await reloaded.read(randomUUID()), undefined);
    await assert.rejects(reloaded.read("../escape"), /request-id-invalid/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("completed valid terminal records cease blocking; damaged terminal claims still block", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory, () => NOW);
    const terminal = { ...record(), stage: "blocked" as const };
    await journal.write(terminal);
    assert.deepEqual(await journal.listPending(), []);
    terminal.sendRecorded = true;
    await journal.write(terminal);
    assert.equal((await journal.listPending()).length, 1);
    fs.writeFileSync(path.join(directory, "damaged.journal.json"), "{");
    const pending = await journal.listPending();
    assert.equal(pending.length, 2);
    assert.ok(
      pending.some((value) => value.id === "unreadable:damaged.journal.json"),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal records bound to an older Relay's continuation text stop blocking; unknown text still blocks", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory, () => NOW);
    const legacy = {
      ...record(
        "Continue this same conversation from the saved checkpoint. First inspect " +
          "the existing transcript and verify whether interrupted actions already took " +
          "effect. Do not replay the last prompt or duplicate completed work. Preserve " +
          "the existing permission mode, ask for any outstanding user decision, and do " +
          "not claim that stopped subagents or shell processes are still running.",
      ),
      stage: "blocked" as const,
    };
    await journal.write(legacy);
    assert.deepEqual(await journal.listPending(), []);
    const unknown = { ...record("Something else"), stage: "blocked" as const };
    await journal.write(unknown);
    assert.deepEqual(
      (await journal.listPending()).map((value) => value.id),
      [unknown.id],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("all instances serialize the whole host across different request IDs", async () => {
  const directory = temporary();
  try {
    const first = new FileContinuationJournal(directory);
    const second = new FileContinuationJournal(directory);
    const actions: string[] = [];
    let release!: () => void, begun!: () => void;
    const entered = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = first.withLock("first", async () => {
      actions.push("first-enter");
      begun();
      await wait;
      actions.push("first-leave");
    });
    await entered;
    const b = second.withLock("second", async () => {
      actions.push("second-enter");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(actions, ["first-enter"]);
    release();
    await Promise.all([a, b]);
    assert.deepEqual(actions, ["first-enter", "first-leave", "second-enter"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an alive cross-process owner blocks actions; a provably exited owner permits recovery", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory);
    const lock = path.join(directory, "host.lock");
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token: "existing-owner" }),
    );
    let invoked = false;
    await assert.rejects(
      journal.withLock("new", async () => {
        invoked = true;
      }),
      /host-locked/,
    );
    assert.equal(invoked, false);
    const exitedPid = Number(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        { encoding: "utf8" },
      ),
    );
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: exitedPid, token: "exited-owner" }),
    );
    await journal.withLock("new", async () => {
      invoked = true;
    });
    assert.equal(invoked, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("exceptions release owned host lock, but corrupted lock metadata remains a barrier", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory);
    await assert.rejects(
      journal.withLock("test", async () => {
        throw new Error("synthetic-failure");
      }),
      /synthetic-failure/,
    );
    assert.equal(fs.existsSync(path.join(directory, "host.lock")), false);
    fs.writeFileSync(path.join(directory, "host.lock"), "{");
    await assert.rejects(
      journal.withLock("new", async () => {}),
      /host-lock-unreadable/,
    );
    assert.equal(fs.existsSync(path.join(directory, "host.lock")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("symlinked journal entries are unreadable barriers and never write through their targets", async () => {
  const directory = temporary();
  try {
    const journal = new FileContinuationJournal(directory);
    const intent = record();
    const target = path.join(directory, "synthetic-target");
    fs.writeFileSync(target, "unchanged");
    fs.symlinkSync(target, path.join(directory, `${intent.id}.journal.json`));
    await assert.rejects(journal.read(intent.id), /journal-unreadable/);
    assert.equal((await journal.listPending()).length, 1);
    await assert.rejects(journal.write(intent), /file-invalid/);
    assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded parser refuses directories, oversized files and invalid UTF-8", () => {
  const directory = temporary();
  try {
    assert.throws(() => readPrivateJson(directory), /file-invalid/);
    const file = path.join(directory, "input");
    fs.writeFileSync(file, Buffer.alloc(1_048_577));
    assert.throws(() => readPrivateJson(file), /file-invalid/);
    fs.writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => readPrivateJson(file));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
