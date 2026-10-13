import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test(
  "native account selector isolates the Sidebar and blocks ambiguous AX fixtures",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "relay-ax-selector-"));
    const binary = path.join(directory, "selector-fixture");
    try {
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
      const select = (nodes: SelectorNode[]): string | null => {
        const result = execFileSync(binary, [], {
          input: JSON.stringify(nodes),
          encoding: "utf8",
          timeout: 5_000,
        });
        const parsed = JSON.parse(result) as { accountPath: string | null };
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
