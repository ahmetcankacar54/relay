import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

type SelectorNode = {
  role: string;
  path: string;
  title?: string;
  description?: string;
  value?: string;
};

const sidebar = (): SelectorNode => ({
  role: "AXGroup",
  path: "root/1/2",
  description: "Sidebar",
});
const popup = (name: string, location: string): SelectorNode => ({
  role: "AXPopUpButton",
  path: location,
  description: name,
});
const accountPath = "root/1/2/8/0";
const liveShape = (): SelectorNode[] => [
  sidebar(),
  popup("Create project", "root/1/2/1/0"),
  popup("New from a template", "root/1/2/1/1"),
  popup("More options for Auction catalog management refactor", "root/1/2/2/0"),
  popup("More options for Another session", "root/1/2/2/1"),
  popup("Filter", "root/1/2/3"),
  popup("Ahmet Max", accountPath),
  { role: "AXButton", description: "Send feedback", path: "root/1/2/8/1" },
  popup("Remote Control", "root/1/3/0"),
  popup("More options for selected session", "root/1/3/1"),
  popup("bidsorted", "root/1/3/2"),
  popup("View options", "root/1/3/3"),
  popup("Add", "root/1/3/4"),
  popup("Dictation settings", "root/1/3/5"),
  popup("Auto", "root/1/3/6"),
  popup("Model: Sonnet 5.5", "root/1/3/7"),
  popup("Effort: Extra", "root/1/3/8"),
  popup("Usage", "root/1/3/9"),
];

/**
 * The helper built in fixture mode, which has no live AX dispatcher: it only runs the pure
 * selectors on the JSON it is given. Built once, for every test here.
 */
let fixture: Promise<string> | undefined;
let directory: string | undefined;
function fixtureBinary(): Promise<string> {
  fixture ??= (async () => {
    directory = await mkdtemp(path.join(tmpdir(), "relay-ax-selector-"));
    const binary = path.join(directory, "selector-fixture");
    execFileSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "electron/native/desktop-automation.swift",
        "-D",
        "RELAY_AX_SELECTOR_FIXTURE",
        "-o",
        binary,
        "-module-cache-path",
        path.join(directory, "module-cache"),
      ],
      { timeout: 60_000, stdio: "pipe" },
    );
    return binary;
  })();
  return fixture;
}
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
const runFixture = (binary: string, input: unknown): unknown =>
  JSON.parse(
    execFileSync(binary, [], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5_000,
    }),
  );

test(
  "native account selector isolates the Sidebar and blocks ambiguous AX fixtures",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = await fixtureBinary();
    {
      const select = (nodes: SelectorNode[]): string | null => {
        const parsed = runFixture(binary, nodes) as {
          accountPath: string | null;
        };
        assert.equal(Object.hasOwn(parsed, "accountPath"), true);
        return parsed.accountPath;
      };

      assert.equal(
        select(liveShape()),
        accountPath,
        "real observed menu shape",
      );
      assert.equal(
        select(liveShape().reverse()),
        accountPath,
        "account location does not depend on popup order",
      );
      assert.equal(
        select([
          sidebar(),
          popup("An arbitrary company account", accountPath),
          popup("Ahmet Max", "root/1/3/9"),
        ]),
        accountPath,
        "account selection does not depend on a user/company name",
      );
      assert.equal(
        select([...liveShape(), popup("Unknown action", "root/1/2/9")]),
        null,
        "an unknown extra sidebar popup blocks instead of guessing",
      );
      assert.equal(
        select([...liveShape(), popup("Second account", "root/1/2/10")]),
        null,
        "two account candidates block",
      );
      assert.equal(
        select([
          ...liveShape(),
          { ...sidebar(), path: "root/1/4" },
          popup("Other window account", "root/1/4/0"),
        ]),
        null,
        "two Sidebar containers block",
      );
      assert.equal(
        select(liveShape().filter((node) => node.path !== sidebar().path)),
        null,
        "an unscoped account popup is not evidence",
      );
      assert.equal(
        select([
          { ...sidebar(), role: "AXButton" },
          popup("Ahmet Max", accountPath),
        ]),
        null,
        "a button with a Sidebar label is not a Sidebar container",
      );
      assert.equal(
        select([
          sidebar(),
          popup("Create project", "root/1/2/0"),
          popup("External account", "root/1/20/0"),
        ]),
        null,
        "path ancestry requires the segment boundary",
      );
      assert.equal(
        select(liveShape().filter((node) => node.path !== accountPath)),
        null,
        "main-pane popups cannot substitute for a missing sidebar account",
      );
      assert.equal(
        select([
          sidebar(),
          popup("", "root/1/2/0"),
          popup("Ahmet Max", accountPath),
        ]),
        accountPath,
        "an unlabeled control is not account identity evidence",
      );
      assert.equal(
        select([
          sidebar(),
          popup("New from template", "root/1/2/0"),
          popup("More options", "root/1/2/1"),
          popup("Auto", "root/1/2/2"),
          popup("Claude Sonnet 5.5", "root/1/2/3"),
          popup("Effort: Extra", "root/1/2/4"),
          popup("Ahmet Max", accountPath),
        ]),
        accountPath,
        "known controls remain excluded inside the Sidebar",
      );
    }
  },
);

const conversation = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test(
  "native screen names one conversation, or Code's bare new-session screen, from web area strings",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = await fixtureBinary();
    const screen = (webAreaStrings: string[]) => {
      const { localSessionId, newSession } = runFixture(binary, {
        webAreaStrings,
      }) as { localSessionId: string | null; newSession: boolean };
      return { localSessionId, newSession };
    };
    const none = { localSessionId: null, newSession: false };
    const newSession = { localSessionId: null, newSession: true };
    // The path Desktop's own claude://code/new opens, with a trailing slash or a query.
    for (const url of [
      "https://claude.ai/epitaxy",
      "https://claude.ai/epitaxy/",
      "https://claude.ai/epitaxy?folder=%2FUsers%2Fme%2Fproject",
    ])
      assert.deepEqual(screen([url]), newSession, url);
    // A page title beside it changes nothing.
    assert.deepEqual(
      screen(["Claude", "https://claude.ai/epitaxy"]),
      newSession,
      "title",
    );
    // A conversation is named by its id, and is not the new-session screen, even beside it:
    // one conversation among the web areas names the screen, as before.
    for (const strings of [
      [`https://claude.ai/epitaxy/${conversation}`],
      [
        "https://claude.ai/epitaxy",
        `https://claude.ai/epitaxy/${conversation}`,
      ],
    ])
      assert.deepEqual(
        screen(strings),
        { localSessionId: conversation, newSession: false },
        strings.join(" "),
      );
    for (const [name, strings] of [
      ["no web area", []],
      ["no epitaxy URL", ["Claude", "https://claude.ai/new"]],
      ["scheduled", ["https://claude.ai/epitaxy/scheduled"]],
      ["new", ["https://claude.ai/epitaxy/new"]],
      ["a draft route", ["https://claude.ai/epitaxy/draft_abc"]],
      ["a project", ["https://claude.ai/epitaxy/project/p1"]],
      [
        "beside another Code screen",
        ["https://claude.ai/epitaxy", "https://claude.ai/epitaxy/scheduled"],
      ],
      ["not a URL", ["claude.ai/epitaxy"]],
      ["plain http", ["http://claude.ai/epitaxy"]],
      ["another host", ["https://evil.example/claude.ai/epitaxy"]],
      ["a look-alike host", ["https://claude.ai.example/epitaxy"]],
      ["a longer path", ["https://claude.ai/epitaxyx"]],
      [
        "two conversations",
        [
          `https://claude.ai/epitaxy/${conversation}`,
          `https://claude.ai/epitaxy/${other}`,
        ],
      ],
    ] as const)
      assert.deepEqual(screen([...strings]), none, name);
  },
);

test(
  "the screen's shape for the diagnosis log keeps the path and drops every id and query",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = await fixtureBinary();
    const shape = (webAreaStrings: string[]) =>
      (runFixture(binary, { webAreaStrings }) as { screen: string }).screen;
    assert.equal(shape([`https://claude.ai/epitaxy/${conversation}`]), "/epitaxy/local");
    assert.equal(shape(["https://claude.ai/epitaxy?folder=%2FUsers%2Fme"]), "/epitaxy");
    assert.equal(shape(["Claude", "https://claude.ai/new"]), "/new");
    assert.equal(
      shape(["https://claude.ai/chat/0f6c1b2a-1111-4222-8333-944445555666"]),
      "/chat/:id",
    );
    assert.equal(shape(["https://claude.ai/project/p1"]), "/project/*");
    assert.equal(shape([]), "none");
    assert.equal(shape(["https://evil.example/claude.ai/new"]), "none");
    assert.equal(
      shape(["https://claude.ai/new", `https://claude.ai/epitaxy/${conversation}`]),
      "several",
    );
  },
);

test(
  "Claude's quit question is told apart: background commands alone, or Claude still working",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = await fixtureBinary();
    const kind = (quitGuardTexts: string[]) =>
      (runFixture(binary, { quitGuardTexts }) as { kind: string | null }).kind;
    assert.equal(
      kind([
        "Background commands are still running",
        "Background commands are running in 1 session. Quitting will stop them.",
      ]),
      "shells",
    );
    assert.equal(kind(["Arka plan komutları hâlâ çalışıyor"]), "shells");
    // Claude still working wins, though the same alert names background commands too.
    assert.equal(
      kind([
        "Claude is still working",
        "Background commands are running in 2 sessions. Quitting will stop them, even if you wait for Claude.",
      ]),
      "working",
    );
    assert.equal(kind(["Claude hâlâ çalışıyor"]), "working");
    assert.equal(kind(["Quit anyway", "Some other question"]), null);
  },
);

test(
  "an empty tiptap composer reads as empty, and one with the user's text never does",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = await fixtureBinary();
    const read = (value: string, emptyEditorMarked = false, placeholder = "") =>
      (
        runFixture(binary, {
          composer: { value, emptyEditorMarked, placeholder },
        }) as { emptyAs: string | null }
      ).emptyAs;
    // Empty, as Chromium may read it: nothing, the line break holding the paragraph open,
    // zero-width marks, the drawn placeholder with tiptap's class, or the placeholder alone.
    assert.equal(read(""), "empty");
    assert.equal(read("\n"), "blank");
    assert.equal(read(" ​\n﻿"), "blank");
    assert.equal(read("Reply to Claude…", true), "editor-empty");
    assert.equal(read("Reply to Claude…\n", false, "Reply to Claude…"), "placeholder");
    // Text, even with the class's node gone or a placeholder beside it, is never empty.
    assert.equal(read("fix the login bug"), null);
    assert.equal(read("fix the login bug", false, "Reply to Claude…"), null);
    assert.equal(read("￼"), null, "a mention or file chip is content");
    assert.equal(read("Reply to Claude…"), null, "without the class or placeholder, the text may be the user's");
    const visible = runFixture(binary, {
      composer: { value: "a b\n\nc​" },
    }) as { visible: string };
    assert.equal(visible.visible, "abc");
  },
);
