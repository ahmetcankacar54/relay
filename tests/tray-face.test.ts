import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TrayFace } from "../electron/core/tray-face";

function fakeTray() {
  const calls: string[] = [];
  const fonts: (string | undefined)[] = [];
  let refuse = false;
  return {
    calls,
    fonts,
    refuse: (value: boolean) => void (refuse = value),
    tray: {
      setTitle: (title: string, options?: { fontType?: string }) => {
        if (refuse) throw new Error("refused");
        calls.push(`title:${title}`);
        fonts.push(options?.fontType);
      },
      setToolTip: (tooltip: string) => {
        if (refuse) throw new Error("refused");
        calls.push(`tooltip:${tooltip}`);
      },
      setImage: (image: string) => {
        if (refuse) throw new Error("refused");
        calls.push(`image:${image}`);
      },
    },
  };
}

test("the tray's title, tooltip and image are set only when they change", () => {
  const fake = fakeTray();
  const face = new TrayFace(fake.tray);
  let built = 0;
  const image = (name: string) => () => {
    built++;
    return `${name}.png`;
  };
  face.setTitle(" 40%");
  face.setToolTip("Relay · A");
  face.setImage("idle", image("idle"));
  face.setTitle(" 40%");
  face.setToolTip("Relay · A");
  face.setImage("idle", image("idle"));
  assert.deepEqual(fake.calls, [
    "title: 40%",
    "tooltip:Relay · A",
    "image:idle.png",
  ]);
  assert.equal(built, 1);
  face.setTitle(" 41%");
  face.setImage("blink", image("blink"));
  face.setToolTip("Relay · A");
  assert.deepEqual(fake.calls.slice(3), ["title: 41%", "image:blink.png"]);
  // Digits of one width, so a changing figure never moves the menu bar items beside it.
  assert.deepEqual(fake.fonts, ["monospacedDigit", "monospacedDigit"]);
});

test("a value the tray refused is set again next time", () => {
  const fake = fakeTray();
  const face = new TrayFace(fake.tray);
  fake.refuse(true);
  assert.throws(() => face.setTitle(" 40%"));
  assert.throws(() => face.setImage("idle", () => "idle.png"));
  fake.refuse(false);
  face.setTitle(" 40%");
  face.setImage("idle", () => "idle.png");
  assert.deepEqual(fake.calls, ["title: 40%", "image:idle.png"]);
});

test("the menu bar tray sets its title, tooltip and panda through the face", () => {
  const tray = readFileSync(
    new URL("../electron/tray.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(tray, /this\.tray\.set(Title|ToolTip|Image)\(/);
  assert.match(tray, /this\.face\.setTitle\(/);
  // AppKit already leaves 2 pt after the panda; a leading space only widened the gap.
  assert.doesNotMatch(tray, /setTitle\([^)]*" "/);
  assert.match(tray, /this\.face\.setToolTip\(/);
  // The image is keyed by the menu bar's tone and the frame, so an appearance change redraws it.
  assert.match(tray, /this\.face\.setImage\(`\$\{tone\}:\$\{frame\}`,/);
});
