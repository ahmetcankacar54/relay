import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MenuBarTitle } from "../electron/core/menu-bar-title";
import { menuBarPreview } from "../shared/tray";

function file(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-menu-bar-title-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "Relay", "menu-bar.json");
}

test("the menu bar title starts as the five-hour percent, keeps a change, and outlives Relay", (t) => {
  const at = file(t);
  const first = new MenuBarTitle(at);
  assert.deepEqual(first.current, { items: ["five-hour"] });
  assert.equal(fs.existsSync(at), false);
  assert.deepEqual(first.set({ items: ["tokens", "five-hour", "cost"] }), { items: ["tokens", "five-hour", "cost"] });
  // Read again as Relay reads it at its next start; only the owner may read it.
  assert.deepEqual(new MenuBarTitle(at).current, { items: ["tokens", "five-hour", "cost"] });
  if (process.platform !== "win32") assert.equal(fs.statSync(at).mode & 0o777, 0o600);
  // The panda alone is a choice too.
  first.set({ items: [] });
  assert.deepEqual(new MenuBarTitle(at).current, { items: [] });
});

test("a menu bar title file that cannot be read is the default, and one too long is cut", (t) => {
  const at = file(t);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, "{not json");
  assert.deepEqual(new MenuBarTitle(at).current, { items: ["five-hour"] });
  fs.writeFileSync(at, JSON.stringify({ items: "tokens" }));
  assert.deepEqual(new MenuBarTitle(at).current, { items: ["five-hour"] });
  fs.writeFileSync(at, JSON.stringify({ items: ["week", "nope", "week", "reset", "tokens", "cost", "account"] }));
  assert.deepEqual(new MenuBarTitle(at).current, { items: ["week", "reset", "tokens", "cost"] });
  // What is kept is what `set` saves, whatever it was given.
  const title = new MenuBarTitle(at);
  assert.deepEqual(
    title.set({ items: ["account", "account", "cost"] as never }),
    { items: ["account", "cost"] },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(at, "utf8")), { items: ["account", "cost"] });
  // The copy handed out is not the one kept.
  title.current.items.push("week");
  assert.deepEqual(title.current, { items: ["account", "cost"] });
});

test("Settings previews the title with sample figures", () => {
  const now = Date.parse("2026-10-26T09:00:00Z");
  assert.equal(menuBarPreview(["five-hour"], "tr", "Max", now), "%40");
  assert.equal(menuBarPreview(["five-hour", "reset", "cost"], "tr", "Max", now), "%40 · 1:50 · $18,20");
  assert.equal(menuBarPreview(["tokens", "week", "account"], "en", "Work", now), "12.4M · 35% · Work");
  assert.equal(
    menuBarPreview(["five-hour", "week", "tokens", "cost"], "en", "Max", now),
    "40% · 35% · 12.4M · $18.20",
  );
  assert.equal(menuBarPreview([], "tr", "Max", now), "");
});
