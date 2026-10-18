import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenLedger, type TokenCounts } from "../electron/core/token-ledger";
import {
  attribute,
  type Attribution,
} from "../electron/core/token-attribution";
import type { Account } from "../shared/types";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
const ZONE = "Europe/Istanbul";
const MODEL = "claude-opus-4-1";
const CHUNK = 1024 * 1024;
/** Appears in every fixture row's text and must never reach the ledger file. */
const PHRASE = "periwinkle-anchovy-telescope-4417";

type Usage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-token-ledger-"));
}

function assistant(input: {
  id: string;
  req?: string;
  at?: string;
  entrypoint?: string;
  model?: string;
  usage?: Usage;
  pad?: number;
}): string {
  return (
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: "/tmp/fixture-project",
      sessionId: "fixture-session",
      entrypoint: input.entrypoint ?? "claude-desktop",
      type: "assistant",
      timestamp: input.at ?? "2026-10-18T09:00:00.000Z",
      requestId: input.req ?? `req_${input.id}`,
      message: {
        id: input.id,
        type: "message",
        role: "assistant",
        model: input.model ?? MODEL,
        content: [
          { type: "text", text: `${PHRASE} ${"x".repeat(input.pad ?? 0)}` },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          service_tier: "standard",
          ...input.usage,
        },
      },
      uuid: `${input.id}-row`,
    }) + "\n"
  );
}

function user(): string {
  return (
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-18T08:59:00.000Z",
      message: { role: "user", content: `${PHRASE} tell me about "usage"` },
      // Passes the substring prefilter but is not an assistant row.
      toolUseResult: {
        agentType: "assistant",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    }) + "\n"
  );
}

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const desktopAccount =
  (accountId = "a1") =>
  (row: { entrypoint?: string; profileAccountId?: string }): Attribution => {
    if (row.profileAccountId)
      return {
        kind: "account",
        accountId: row.profileAccountId,
        estimated: false,
      };
    if (row.entrypoint && row.entrypoint !== "claude-desktop")
      return { kind: "terminal" };
    return { kind: "account", accountId, estimated: false };
  };

function ledgerFor(
  dir: string,
  roots: { dir: string; profileAccountId?: string }[],
  options: Partial<ConstructorParameters<typeof TokenLedger>[0]> = {},
) {
  return new TokenLedger({
    file: path.join(dir, "token-ledger.json"),
    roots,
    attribute: desktopAccount(),
    zone: () => ZONE,
    now: () => NOW,
    ...options,
  });
}

function totals(ledger: TokenLedger, who?: string): TokenCounts {
  const sum: TokenCounts = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    responses: 0,
  };
  for (const byWho of Object.values(ledger.snapshot().days))
    for (const [key, byModel] of Object.entries(byWho)) {
      if (who !== undefined && key !== who) continue;
      for (const counts of Object.values(byModel))
        for (const field of Object.keys(sum) as (keyof TokenCounts)[])
          sum[field] += counts[field];
    }
  return sum;
}

test("counts a streamed response once, each response once, subagents, and never tool-results", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const session = path.join(root, "-tmp-fixture-project", "s1.jsonl");
  const streamed = { id: "msg_A", usage: { input_tokens: 100 } };
  write(
    session,
    user() +
      assistant(streamed) +
      assistant(streamed) +
      assistant(streamed) +
      assistant(streamed) +
      assistant({ id: "msg_B", usage: { input_tokens: 200 } }) +
      // An assistant row without usage does not count.
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-18T09:00:00.000Z",
        message: { id: "msg_C", usage: "none", content: PHRASE },
      }) +
      "\n",
  );
  write(
    path.join(root, "-tmp-fixture-project", "s1", "subagents", "agent-1.jsonl"),
    assistant({ id: "msg_D", usage: { input_tokens: 300 } }),
  );
  write(
    path.join(root, "-tmp-fixture-project", "s1", "tool-results", "t.jsonl"),
    assistant({ id: "msg_E", usage: { input_tokens: 4000 } }),
  );
  write(
    path.join(root, "a", "b", "c", "d", "too-deep.jsonl"),
    assistant({ id: "msg_F", usage: { input_tokens: 50_000 } }),
  );
  const outside = path.join(dir, "outside.jsonl");
  write(outside, assistant({ id: "msg_G", usage: { input_tokens: 600_000 } }));
  fs.symlinkSync(
    outside,
    path.join(root, "-tmp-fixture-project", "link.jsonl"),
  );

  const ledger = ledgerFor(dir, [{ dir: root }]);
  assert.deepEqual(await ledger.tick(), { complete: true });
  assert.deepEqual(totals(ledger), {
    input: 600,
    output: 6,
    cacheWrite: 9,
    cacheRead: 12,
    responses: 3,
  });
  const { progress } = ledger.snapshot();
  const sizes =
    fs.statSync(session).size +
    fs.statSync(
      path.join(
        root,
        "-tmp-fixture-project",
        "s1",
        "subagents",
        "agent-1.jsonl",
      ),
    ).size;
  assert.deepEqual(progress, {
    scannedBytes: sizes,
    totalBytes: sizes,
    complete: true,
  });
});

test("missing or non-finite usage counts as zero and a missing model is unknown", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const row = JSON.parse(
    assistant({
      id: "msg_A",
      usage: {
        input_tokens: "12",
        output_tokens: null,
        cache_read_input_tokens: 7,
      },
    }),
  );
  delete row.message.model;
  delete row.message.usage.cache_creation_input_tokens;
  write(path.join(root, "p", "s.jsonl"), JSON.stringify(row) + "\n");
  const ledger = ledgerFor(dir, [{ dir: root }]);
  await ledger.tick();
  assert.deepEqual(ledger.snapshot().days["2026-10-18"]["acct:a1"].unknown, {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 7,
    responses: 1,
  });
});

test("appended and completed lines count on a later tick, and a restart does not re-count", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const file = path.join(root, "p", "s.jsonl");
  write(file, assistant({ id: "msg_A" }));
  const ledger = ledgerFor(dir, [{ dir: root }]);
  await ledger.tick();
  assert.equal(totals(ledger).responses, 1);

  fs.appendFileSync(file, assistant({ id: "msg_B" }));
  assert.deepEqual(await ledger.tick(), { complete: true });
  assert.equal(totals(ledger).responses, 2);

  const line = assistant({ id: "msg_C", usage: { output_tokens: 1000 } });
  const half = Math.floor(line.length / 2);
  fs.appendFileSync(file, line.slice(0, half));
  await ledger.tick();
  assert.equal(totals(ledger).responses, 2);
  assert.ok(
    ledger.snapshot().progress.scannedBytes <
      ledger.snapshot().progress.totalBytes,
  );
  await ledger.tick();
  assert.equal(totals(ledger).responses, 2);
  fs.appendFileSync(file, line.slice(half));
  await ledger.tick();
  assert.equal(totals(ledger).responses, 3);
  assert.equal(totals(ledger).output, 1004);

  // The first row of a streamed response, then a restart, then its next row.
  fs.appendFileSync(file, assistant({ id: "msg_D" }));
  await ledger.tick();
  assert.equal(totals(ledger).responses, 4);

  const restarted = ledgerFor(dir, [{ dir: root }]);
  assert.equal(totals(restarted).responses, 4);
  assert.deepEqual(await restarted.tick(), { complete: true });
  assert.equal(totals(restarted).responses, 4);
  fs.appendFileSync(file, assistant({ id: "msg_D" }));
  await restarted.tick();
  assert.equal(totals(restarted).responses, 4);
  fs.appendFileSync(file, assistant({ id: "msg_E" }));
  await restarted.tick();
  assert.equal(totals(restarted).responses, 5);
  assert.deepEqual(restarted.snapshot().progress, {
    scannedBytes: fs.statSync(file).size,
    totalBytes: fs.statSync(file).size,
    complete: true,
  });
});

test("a shrunk file and a replaced file are never read again, and keep their counted tokens", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const shrunk = path.join(root, "p", "shrunk.jsonl");
  const replaced = path.join(root, "p", "replaced.jsonl");
  const kept = path.join(root, "p", "kept.jsonl");
  write(shrunk, assistant({ id: "msg_A" }) + assistant({ id: "msg_B" }));
  write(replaced, assistant({ id: "msg_C" }));
  write(kept, assistant({ id: "msg_D" }));
  const ledger = ledgerFor(dir, [{ dir: root }]);
  await ledger.tick();
  assert.equal(totals(ledger).responses, 4);

  // Same inode, truncated and rewritten shorter.
  fs.writeFileSync(shrunk, assistant({ id: "msg_A" }));
  // A new inode with the old content and more.
  const temporary = path.join(dir, "replacement.jsonl");
  fs.writeFileSync(
    temporary,
    assistant({ id: "msg_C" }) + assistant({ id: "msg_X" }),
  );
  const before = fs.statSync(replaced).ino;
  fs.renameSync(temporary, replaced);
  assert.notEqual(fs.statSync(replaced).ino, before);

  assert.deepEqual(await ledger.tick(), { complete: true });
  assert.equal(totals(ledger).responses, 4);

  fs.appendFileSync(shrunk, assistant({ id: "msg_Y" }).repeat(3));
  fs.appendFileSync(replaced, assistant({ id: "msg_Z" }));
  await ledger.tick();
  assert.equal(totals(ledger).responses, 4);

  const restarted = ledgerFor(dir, [{ dir: root }]);
  await restarted.tick();
  assert.equal(totals(restarted).responses, 4);
  // Only the healthy file is in the progress totals.
  assert.deepEqual(restarted.snapshot().progress, {
    scannedBytes: fs.statSync(kept).size,
    totalBytes: fs.statSync(kept).size,
    complete: true,
  });
});

test("a large first scan spreads over budgeted ticks, survives a restart and counts each response once", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const files = [
    path.join(root, "p", "one.jsonl"),
    path.join(root, "p", "two.jsonl"),
  ];
  let expected = 0;
  let longest = 0;
  let shortest = Infinity;
  for (const [index, file] of files.entries()) {
    const rows: string[] = [];
    for (let size = 0; size < 1.6 * CHUNK;) {
      const row = assistant({ id: `msg_${index}_${rows.length}`, pad: 1500 });
      rows.push(row, row);
      size += row.length * 2;
      longest = Math.max(longest, Buffer.byteLength(row));
      shortest = Math.min(shortest, Buffer.byteLength(row));
    }
    expected += rows.length / 2;
    write(file, rows.join(""));
  }

  // Fake clock: each counted response costs 0.05 ms, so a 1 ms budget runs
  // out within the first chunk of every tick.
  let clock = NOW;
  const options = {
    budgetMs: 1,
    now: () => clock,
    attribute: (): Attribution => {
      clock += 0.05;
      return { kind: "account", accountId: "a1", estimated: false };
    },
  };
  let ledger = ledgerFor(dir, [{ dir: root }], options);
  const first = await ledger.tick();
  assert.equal(first.complete, false);
  let scanned = ledger.snapshot().progress.scannedBytes;
  assert.ok(scanned > 0 && scanned <= CHUNK, `first tick read ${scanned}`);

  let ticks = 1;
  let complete = false;
  while (!complete) {
    if (ticks === 2) ledger = ledgerFor(dir, [{ dir: root }], options);
    const started = clock;
    complete = (await ledger.tick()).complete;
    ticks++;
    const now = ledger.snapshot().progress.scannedBytes;
    assert.ok(
      now - scanned <= CHUNK + longest,
      `tick ${ticks} read ${now - scanned} bytes`,
    );
    // At most one chunk's responses (each written twice) past the budget.
    const perChunk = Math.ceil(CHUNK / (2 * shortest)) + 1;
    assert.ok(
      clock - started <= 1 + perChunk * 0.05,
      `tick ${ticks} took ${clock - started} ms`,
    );
    scanned = now;
    assert.ok(ticks < 20, "the scan never completed");
  }
  assert.ok(ticks >= 4, `only ${ticks} ticks`);
  assert.equal(totals(ledger).responses, expected);
  assert.equal(totals(ledger).input, expected);
  const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.deepEqual(ledger.snapshot().progress, {
    scannedBytes: total,
    totalBytes: total,
    complete: true,
  });
});

test("23:59:59 and 00:00:01 land on different dates, and attribution maps to who-keys", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const profiles = path.join(dir, "profiles", "a2", "projects");
  write(
    path.join(root, "p", "s.jsonl"),
    assistant({ id: "msg_A", at: "2026-10-17T23:59:59+03:00" }) +
      assistant({ id: "msg_B", at: "2026-10-18T00:00:01+03:00" }) +
      assistant({ id: "msg_C", entrypoint: "cli", model: "claude-sonnet-4-5" }),
  );
  write(
    path.join(profiles, "p", "s.jsonl"),
    assistant({ id: "msg_D", entrypoint: "cli" }),
  );
  const uuid = "11111111-1111-4111-8111-111111111111";
  const accounts: Account[] = [
    {
      id: "a1",
      name: "a1",
      kind: "personal",
      group: "",
      color: "",
      createdAt: new Date(NOW).toISOString(),
      desktop: {
        accountUuid: uuid,
        orgId: "",
        savedAt: new Date(NOW).toISOString(),
      },
    },
  ];
  const ledger = ledgerFor(
    dir,
    [{ dir: root }, { dir: profiles, profileAccountId: "a2" }],
    {
      attribute: (row) =>
        attribute(row, {
          timeline: { accountAt: () => ({ accountUuid: uuid }) },
          samples: [],
          accounts,
        }),
    },
  );
  await ledger.tick();
  const { days } = ledger.snapshot();
  const one = (counts?: TokenCounts) => counts?.responses;
  assert.equal(one(days["2026-10-17"]?.["acct:a1"]?.[MODEL]), 1);
  assert.equal(one(days["2026-10-18"]?.["acct:a1"]?.[MODEL]), 1);
  assert.equal(one(days["2026-10-18"]?.terminal?.["claude-sonnet-4-5"]), 1);
  assert.equal(one(days["2026-10-18"]?.["acct:a2"]?.[MODEL]), 1);
  assert.deepEqual(Object.keys(days).sort(), ["2026-10-17", "2026-10-18"]);
  assert.deepEqual(Object.keys(days["2026-10-17"]), ["acct:a1"]);

  const dir2 = tempDir();
  const root2 = path.join(dir2, "projects");
  write(
    path.join(root2, "p", "s.jsonl"),
    assistant({ id: "msg_E", entrypoint: "estimated" }) +
      assistant({ id: "msg_F", entrypoint: "unknown" }),
  );
  const mapped = ledgerFor(dir2, [{ dir: root2 }], {
    attribute: (row) =>
      row.entrypoint === "estimated"
        ? { kind: "account", accountId: "a3", estimated: true }
        : { kind: "unknown" },
  });
  await mapped.tick();
  assert.deepEqual(Object.keys(mapped.snapshot().days["2026-10-18"]).sort(), [
    "est:a3",
    "unknown",
  ]);
});

test("files untouched for 90 days are skipped on first sight, and days older than 120 days are dropped", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  const old = path.join(root, "p", "old.jsonl");
  const recent = path.join(root, "p", "recent.jsonl");
  write(old, assistant({ id: "msg_A" }));
  write(
    recent,
    assistant({ id: "msg_B", at: new Date(NOW - 130 * DAY).toISOString() }) +
      assistant({ id: "msg_C", at: new Date(NOW - 100 * DAY).toISOString() }),
  );
  fs.utimesSync(old, new Date(NOW - 91 * DAY), new Date(NOW - 91 * DAY));
  fs.utimesSync(recent, new Date(NOW - 89 * DAY), new Date(NOW - 89 * DAY));
  const ledger = ledgerFor(dir, [{ dir: root }]);
  await ledger.tick();
  const { days, progress } = ledger.snapshot();
  assert.deepEqual(Object.keys(days), ["2026-07-10"]);
  assert.equal(totals(ledger).responses, 1);
  assert.equal(progress.totalBytes, fs.statSync(recent).size);
});

test("the ledger file holds no transcript text and is private", async () => {
  const dir = tempDir();
  const root = path.join(dir, "projects");
  write(
    path.join(root, "p", "s.jsonl"),
    user() + assistant({ id: "msg_A" }) + assistant({ id: "msg_A" }),
  );
  write(
    path.join(root, "p", "s", "subagents", "agent.jsonl"),
    user() + assistant({ id: "msg_B" }),
  );
  write(path.join(root, "p", "s", "tool-results", "r.jsonl"), `${PHRASE}\n`);
  const ledger = ledgerFor(dir, [{ dir: root }]);
  await ledger.tick();
  const file = path.join(dir, "token-ledger.json");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(MODEL));
  assert.ok(!text.includes(PHRASE));
  assert.ok(!text.includes("fixture-project"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
