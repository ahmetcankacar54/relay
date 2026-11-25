import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  buildDiagnosticsBundle,
  newestCrashDumps,
  redactDiagnostics,
  settingsSummary,
  zipArchive,
} from "../electron/core/diagnostics-bundle";
import { DEFAULT_SETTINGS, type Account } from "../shared/types";

/** Every file in a zip, read through its central directory as an unzip tool does. */
function unzip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + packedSize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(data.length, size, name);
    assert.equal(zlib.crc32(data), crc, name);
    files.set(name, data.toString("utf8"));
    at += 46 + nameLength + skip;
  }
  return files;
}

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("the zip writer round-trips names, bytes and an empty file", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello\n".repeat(200)) },
    { name: "notlar/ğüş.json", data: Buffer.from('{"ok":true}') },
    { name: "empty.log", data: Buffer.alloc(0) },
  ];
  const files = unzip(zipArchive(entries, new Date(2026, 10, 23, 9, 30)));
  assert.deepEqual(
    [...files.keys()],
    entries.map((e) => e.name),
  );
  for (const entry of entries)
    assert.equal(files.get(entry.name), entry.data.toString("utf8"));
});

test(
  "a system unzip reads the archive",
  { skip: !hasUnzip && "no unzip on this machine" },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-zip-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "bundle.zip");
    await fs.writeFile(
      file,
      zipArchive([{ name: "summary.json", data: Buffer.from("{}\n") }]),
    );
    execFileSync("unzip", ["-t", file], { stdio: "ignore" });
    assert.equal(
      execFileSync("unzip", ["-p", file, "summary.json"], { encoding: "utf8" }),
      "{}\n",
    );
  },
);

const EMAIL = "vertex.alto@example.com";
const NAME = "Alto Vertex";
const ORG = "Kestrel Labs";
const SK = "sk-ant-oat01-Abc123Def456Ghi789Jkl012Mno345";
// Short and plain: only the field name gives it away.
const REFRESH = "rt-plain-secret-42";
const BEARER = "short.bearer";

test("redaction masks emails, account names, keys, token fields and the home folder", () => {
  const text = [
    `2026-11-23T09:00:00.000Z uncaughtException ${NAME} (${EMAIL}) failed with ${SK}`,
    `  at /Users/alto/Library/Application Support/Relay/vault.ts:1:1`,
    `{"accessToken": "at-plain", "refreshToken": "${REFRESH}", "account": "alto vertex"}`,
    `Authorization: Bearer ${BEARER}`,
    `https://example.com/cb?code=abc123&state=ok`,
    `Altogether fine; ${ORG} org.`,
  ].join("\n");
  const out = redactDiagnostics(text, [NAME, ORG, ""], "/Users/alto");
  for (const secret of [
    EMAIL,
    "Alto Vertex",
    "alto vertex",
    SK,
    REFRESH,
    "at-plain",
    BEARER,
    "abc123",
    ORG,
    "/Users/alto",
  ])
    assert.ok(!out.includes(secret), secret);
  assert.match(out, /\[account\] \(\[email\]\) failed with \[redacted\]/);
  assert.match(out, /~\/Library\/Application Support\/Relay/);
  // A name is masked as a word, not inside another one.
  assert.match(out, /Altogether fine; \[account\] org\./);
  // Lines and indents stay.
  assert.equal(out.split("\n").length, 6);
  assert.match(out.split("\n")[1], /^  at /);
});

test("the bundle holds redacted logs and a summary, skips missing files and carries no secret", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-diag-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const errors = path.join(dir, "main-errors.log");
  const issues = path.join(dir, "usage-issues.json");
  await fs.writeFile(
    errors,
    `2026-11-23T09:00:00.000Z unhandledRejection ${NAME} ${EMAIL} ${SK}\n`,
  );
  await fs.writeFile(
    issues,
    JSON.stringify({
      version: 1,
      entries: [
        {
          accountId: "a",
          detail: `${EMAIL} refreshToken`,
          refreshToken: REFRESH,
        },
      ],
    }),
  );
  const accounts = [
    {
      id: "a",
      name: NAME,
      kind: "personal",
      group: "personal",
      color: "#000",
      createdAt: "",
      desktop: { accountUuid: "u", orgId: "o", savedAt: "", email: EMAIL },
    },
    {
      id: "b",
      name: "Alto",
      kind: "personal",
      group: "personal",
      color: "#000",
      createdAt: "",
      provider: "codex",
    },
  ] as Account[];
  const zip = await buildDiagnosticsBundle({
    files: [errors, issues, path.join(dir, "fleet-events.json")],
    names: accounts.map((a) => a.name),
    home: dir,
    summary: {
      relay: "0.28.0",
      settings: settingsSummary(
        { ...DEFAULT_SETTINGS, launchAtLogin: true },
        accounts,
      ),
      crashDumps: ["completed/x.dmp"],
    },
  });
  const files = unzip(zip);
  assert.deepEqual(
    [...files.keys()],
    ["main-errors.log", "usage-issues.json", "summary.json"],
  );
  const all = [...files.values()].join("\n");
  for (const secret of [EMAIL, NAME, "Alto", SK, REFRESH])
    assert.ok(!all.includes(secret), secret);
  const summary = JSON.parse(files.get("summary.json")!);
  assert.equal(summary.relay, "0.28.0");
  assert.deepEqual(summary.settings.providers, { claude: 1, codex: 1 });
  assert.equal(summary.settings.accounts, 2);
  assert.equal(summary.settings.desktopConnected, 1);
  assert.equal(summary.settings.launchAtLogin, true);
  assert.deepEqual(summary.crashDumps, ["completed/x.dmp"]);
  // The issues log is still JSON after redaction.
  assert.equal(
    JSON.parse(files.get("usage-issues.json")!).entries[0].refreshToken,
    "[redacted]",
  );
});

test("the newest crash dump names are listed, newest first, without their contents", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-dumps-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "completed"));
  const names = ["one", "two", "three"];
  for (const [i, name] of names.entries()) {
    const file = path.join(dir, "completed", `${name}.dmp`);
    await fs.writeFile(file, "memory");
    await fs.utimes(file, 1_000 + i, 1_000 + i);
  }
  await fs.writeFile(path.join(dir, "settings.dat"), "");
  assert.deepEqual(await newestCrashDumps(dir, 2), [
    "completed/three.dmp",
    "completed/two.dmp",
  ]);
  assert.deepEqual(await newestCrashDumps(path.join(dir, "missing")), []);
});
