import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  CONTINUATION_TEXT,
  ContinuationEngine,
  isTerminalContinuationRecord,
  type ContinuationHost,
  type ContinuationJournalRecord,
} from "../electron/core/continuation";
import { FileContinuationJournal } from "../electron/core/continuation-journal";

const NOW = Date.parse("2026-10-13T14:00:00Z");
function intent(stage: ContinuationJournalRecord["stage"] = "checkpointed") {
  const id = randomUUID(),
    sessionId = randomUUID();
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
    sessionId,
    projectKey: "synthetic-project",
    transcriptRevision: "before",
    permissionMode: "Auto",
    expectedContextRevision: 7,
    executionPolicy: "guarded-native-at-most-once",
    continuationText: CONTINUATION_TEXT,
  });
  const record: ContinuationJournalRecord = {
    version: 1,
    id,
    boundRequest,
    fingerprint: createHash("sha256").update(boundRequest).digest("hex"),
    stage,
    updatedAt: NOW,
    sendRecorded: false,
    ...(stage === "prepared"
      ? {}
      : {
          checkpoint: {
            id,
            session: {
              id: sessionId,
              projectKey: "synthetic-project",
              transcriptRevision: "before",
              permissionMode: "Auto",
              status: "stopped" as const,
            },
          },
        }),
  };
  return record;
}
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-abandon-test-"),
  );
  const journal = new FileContinuationJournal(directory, () => NOW);
  // Cancelling a proven unsent intent must not depend on current account access,
  // transcript availability, changed permissions, or a quota that has reset.
  const unavailableHost = {} as ContinuationHost;
  const engine = new ContinuationEngine(unavailableHost, journal, () => NOW);
  return {
    directory,
    journal,
    engine,
    remove: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("proven unsent handoffs may be durably abandoned even when the previous account or transcript is inaccessible", async () => {
  for (const stage of [
    "prepared",
    "checkpointed",
    "switch-intent",
    "account-verified",
    "open-intent",
    "session-verified",
    "reconciliation-required",
  ] as const) {
    const f = fixture();
    try {
      const original = intent(stage);
      await f.journal.write(original);
      const abandoned = await f.engine.abandonUnsent(original.id);
      assert.equal(abandoned.status, "abandoned");
      const terminal = (await f.journal.read(original.id))!;
      assert.equal(terminal.reason, "user-cancelled-unsent");
      assert.equal(terminal.sendRecorded, false);
      assert.equal(terminal.fingerprint, original.fingerprint);
      assert.equal(isTerminalContinuationRecord(terminal, NOW), true);
      assert.deepEqual(await f.journal.listPending(), []);
    } finally {
      f.remove();
    }
  }
});

test("send-intent, accepted, confirmed or ambiguous possible submissions cannot be abandoned", async () => {
  for (const stage of [
    "send-intent",
    "delivery-accepted",
    "delivery-confirmed",
    "reconciliation-required",
  ] as const) {
    const f = fixture();
    try {
      const original = intent(stage);
      original.sendRecorded = true;
      await f.journal.write(original);
      await assert.rejects(
        f.engine.abandonUnsent(original.id),
        /cannot-cancel-possible-send/,
      );
      assert.deepEqual(await f.journal.read(original.id), original);
    } finally {
      f.remove();
    }
  }
});

test("corrupt bindings, impossible stages and malformed checkpoints remain untouched barriers", async () => {
  const changes = [
    (r: ContinuationJournalRecord) => {
      r.fingerprint = "bad";
    },
    (r: ContinuationJournalRecord) => {
      r.boundRequest = "{}";
    },
    (r: ContinuationJournalRecord) => {
      r.stage = "send-intent";
    },
    (r: ContinuationJournalRecord) => {
      r.updatedAt = NOW + 1;
    },
    (r: ContinuationJournalRecord) => {
      r.checkpoint!.session.permissionMode = "changed";
    },
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      const original = intent();
      change(original);
      await f.journal.write(original);
      await assert.rejects(
        f.engine.abandonUnsent(original.id),
        /journal-record-invalid/,
      );
      assert.deepEqual(await f.journal.read(original.id), original);
    } finally {
      f.remove();
    }
  }
});

test("absent pre-intent record is cancellable only while no other unresolved host intent exists", async () => {
  const f = fixture();
  try {
    const absentId = randomUUID();
    assert.equal((await f.engine.abandonUnsent(absentId)).status, "abandoned");
    await f.journal.write(intent());
    await assert.rejects(
      f.engine.abandonUnsent(absentId),
      /unresolved-host-intent/,
    );
    await assert.rejects(
      f.engine.abandonUnsent("../invalid"),
      /invalid-request/,
    );
  } finally {
    f.remove();
  }
});
