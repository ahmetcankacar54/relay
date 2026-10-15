import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { checkMascotSources, checkTraySources, renderTrayFrame } from "../scripts/mascot-assets";
import { mascotTrayFrames } from "../electron/mascot-tray-frames";
import { MASCOT_FRAMES } from "../shared/mascot-frames";

const root = path.resolve(import.meta.dirname, "..");
const svg = (attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" ${attrs}><rect x="2" y="2" width="20" height="16"/></svg>`;
const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();

async function trayDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-mascot-"));
  await mkdir(path.join(dir, "tray"));
  return dir;
}

test("the committed mascot sources are complete and valid", async () => {
  assert.deepEqual(await checkMascotSources(path.join(root, "assets/mascot/source")), []);
});

test("a delivery with missing, misnamed or misshapen frames lists every problem", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    for (const frame of MASCOT_FRAMES.slice(2)) await writeFile(path.join(tray, `${frame}.svg`), svg());
    await writeFile(path.join(tray, "idle.svg"), svg().replace("0 0 24 20", "0 0 32 32"));
    await writeFile(path.join(tray, "blink0.svg"), svg());
    await writeFile(path.join(tray, "exit-0.png"), await png(72, 60));
    await writeFile(path.join(tray, "away-1.png"), await png(60, 60));
    await rm(path.join(tray, "away-1.svg"));
    await writeFile(path.join(tray, ".DS_Store"), "");
    assert.deepEqual((await checkTraySources(tray)).sort(), [
      'tray/idle.svg: viewBox must be "0 0 24 20"',
      "tray/blink-0: missing (.svg or .png)",
      "tray/blink0.svg: not a mascot frame",
      "tray/exit-0: both .svg and .png; keep one",
      "tray/away-1.png: must be 72×60, is 60×60",
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frames render at exactly 24×20, 48×40 and 72×60 from an SVG with its own size or a PNG", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    await writeFile(path.join(tray, "idle.svg"), svg('width="240" height="200"'));
    await writeFile(path.join(tray, "hungry.png"), await png(72, 60));
    for (const frame of ["idle", "hungry"] as const) {
      const reps = await renderTrayFrame(tray, frame);
      const sizes = await Promise.all(reps.map(async (r) => {
        const meta = await sharp(Buffer.from(r.png, "base64")).metadata();
        return [r.scaleFactor, meta.width, meta.height];
      }));
      assert.deepEqual(sizes, [[1, 24, 20], [2, 48, 40], [3, 72, 60]], frame);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const cover = (attrs: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" ${attrs}><rect width="24" height="20"/></svg>`;

test("an SVG with its own square size is not letterboxed or stretched", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    await writeFile(path.join(tray, "idle.svg"), cover('width="48" height="48"'));
    for (const rep of await renderTrayFrame(tray, "idle")) {
      const stats = await sharp(Buffer.from(rep.png, "base64")).ensureAlpha().stats();
      assert.equal(stats.channels[3].min, 255, `${rep.scaleFactor}x has transparent pixels`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an SVG with a huge own size still renders at the exact sizes", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    await writeFile(path.join(tray, "idle.svg"), svg('width="2400" height="2000"'));
    const reps = await renderTrayFrame(tray, "idle");
    const sizes = await Promise.all(reps.map(async (r) => {
      const meta = await sharp(Buffer.from(r.png, "base64")).metadata();
      return [r.scaleFactor, meta.width, meta.height];
    }));
    assert.deepEqual(sizes, [[1, 24, 20], [2, 48, 40], [3, 72, 60]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the viewBox counts only on the root element", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    for (const frame of MASCOT_FRAMES.slice(2)) await writeFile(path.join(tray, `${frame}.svg`), svg());
    const wrong = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">';
    await writeFile(
      path.join(tray, "idle.svg"),
      `${wrong}<symbol viewBox="0 0 24 20"/><rect width="4" height="4"/></svg>`,
    );
    await writeFile(
      path.join(tray, "blink-0.svg"),
      `<!-- <svg viewBox="0 0 24 20"> -->${wrong}<rect width="4" height="4"/></svg>`,
    );
    assert.deepEqual((await checkTraySources(tray)).sort(), [
      'tray/blink-0.svg: viewBox must be "0 0 24 20"',
      'tray/idle.svg: viewBox must be "0 0 24 20"',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an SVG that cannot be rendered is reported by name instead of failing at render time", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    for (const frame of MASCOT_FRAMES.slice(2)) await writeFile(path.join(tray, `${frame}.svg`), svg());
    await writeFile(path.join(tray, "idle.svg"), svg().slice(0, 60));
    await writeFile(path.join(tray, "blink-0.svg"), "<html></html>");
    const problems = await checkTraySources(tray);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems.find((p) => p.startsWith("tray/idle.svg"))!, /^tray\/idle\.svg: cannot be rendered \(.+\)$/);
    assert.match(problems.find((p) => p.startsWith("tray/blink-0.svg"))!, /^tray\/blink-0\.svg: cannot be rendered \(.+\)$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generated tray module holds every frame at three scales", async () => {
  assert.deepEqual(Object.keys(mascotTrayFrames).sort(), [...MASCOT_FRAMES].sort());
  for (const frame of MASCOT_FRAMES) {
    const reps = mascotTrayFrames[frame];
    assert.deepEqual(reps.map((r) => r.scaleFactor), [1, 2, 3], frame);
    const meta = await sharp(Buffer.from(reps[2].png, "base64")).metadata();
    assert.deepEqual([meta.width, meta.height], [72, 60], frame);
  }
});
