import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  checkMascotSources, checkTraySources, renderMascot, renderTrayFrame, traySourcesHash, writeMascot,
} from "../scripts/mascot-assets";
import { mascotTrayFrames } from "../electron/mascot-tray-frames";
import { MASCOT_FRAMES } from "../shared/mascot-frames";

const root = path.resolve(import.meta.dirname, "..");
const svg = (attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" ${attrs}><rect x="2" y="2" width="20" height="16"/></svg>`;
/** A black silhouette with a transparent border, like a valid template frame. */
const png = (width: number, height: number, fill = { r: 0, g: 0, b: 0, alpha: 1 }) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: width - 4, height: height - 4, channels: 4, background: fill } }, left: 2, top: 2 }])
    .png()
    .toBuffer();

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
    await writeFile(path.join(tray, "hungry.png"), await png(72, 60));
    await writeFile(path.join(tray, "away.png"), await png(60, 60));
    await rm(path.join(tray, "away.svg"));
    await writeFile(path.join(tray, "run-0.svg"), svg());
    await writeFile(path.join(tray, ".DS_Store"), "");
    assert.deepEqual((await checkTraySources(tray)).sort(), [
      'tray/idle.svg: viewBox must be "0 0 24 20"',
      "tray/blink: missing (.svg or .png)",
      "tray/blink0.svg: not a mascot frame",
      "tray/hungry: both .svg and .png; keep one",
      "tray/away.png: must be 72×60, is 60×60",
      "tray/run-0.svg: not a mascot frame",
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
      path.join(tray, "blink.svg"),
      `<!-- <svg viewBox="0 0 24 20"> -->${wrong}<rect width="4" height="4"/></svg>`,
    );
    assert.deepEqual((await checkTraySources(tray)).sort(), [
      'tray/blink.svg: viewBox must be "0 0 24 20"',
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
    await writeFile(path.join(tray, "blink.svg"), "<html></html>");
    const problems = await checkTraySources(tray);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems.find((p) => p.startsWith("tray/idle.svg"))!, /^tray\/idle\.svg: cannot be rendered \(.+\)$/);
    assert.match(problems.find((p) => p.startsWith("tray/blink.svg"))!, /^tray\/blink\.svg: cannot be rendered \(.+\)$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frames are checked the way macOS draws template images, from alpha only", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  const root = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20">';
  try {
    for (const frame of MASCOT_FRAMES.slice(5)) await writeFile(path.join(tray, `${frame}.svg`), svg());
    // A design-tool export with a white background behind the panda.
    await writeFile(path.join(tray, "idle.svg"), `${root}<rect width="24" height="20" fill="#fff"/><rect x="2" y="2" width="20" height="16"/></svg>`);
    // White eyes painted on a black body instead of cut out.
    await writeFile(path.join(tray, "blink.svg"), `${root}<rect x="2" y="2" width="20" height="16"/><circle cx="16" cy="8" r="2" fill="white"/></svg>`);
    // An RGB export without an alpha channel.
    await writeFile(
      path.join(tray, "hungry.png"),
      await sharp({ create: { width: 72, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(),
    );
    // An opaque PNG with an alpha channel, and one with a light fill.
    await writeFile(
      path.join(tray, "sleep.png"),
      await sharp({ create: { width: 72, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(),
    );
    await writeFile(path.join(tray, "alert.png"), await png(72, 60, { r: 200, g: 120, b: 60, alpha: 1 }));
    assert.deepEqual((await checkTraySources(tray)).sort(), [
      "tray/blink.svg: opaque light pixels; cut holes instead of light fills",
      "tray/hungry.png: needs an alpha channel",
      "tray/sleep.png: no transparent pixels; the background must be transparent",
      "tray/alert.png: opaque light pixels; cut holes instead of light fills",
      "tray/idle.svg: no transparent pixels; the background must be transparent",
      "tray/idle.svg: opaque light pixels; cut holes instead of light fills",
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dark anti-aliased edges and faint light pixels are not light fills", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  const root = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20">';
  try {
    for (const frame of MASCOT_FRAMES.slice(1)) await writeFile(path.join(tray, `${frame}.svg`), svg());
    await writeFile(
      path.join(tray, "idle.svg"),
      `${root}<circle cx="12" cy="10" r="7.3" fill="#222"/><rect x="1" y="1" width="3" height="3" fill="#fff" opacity="0.1"/></svg>`,
    );
    assert.deepEqual(await checkTraySources(tray), []);
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

const SOURCES_HEADER = /^\/\/ Sources: (sha256-[0-9a-f]{64})$/m;

test("the generated tray module was rendered from the committed sources", async () => {
  const module = await readFile(path.join(root, "electron/mascot-tray-frames.ts"), "utf8");
  const header = SOURCES_HEADER.exec(module.slice(0, module.indexOf("export ")));
  assert.ok(header, "the generated module must name its sources' hash; run npm run mascot");
  assert.equal(
    header[1],
    await traySourcesHash(path.join(root, "assets/mascot/source/tray")),
    "assets/mascot/source/tray changed since the module was generated; run npm run mascot",
  );
});

test("the sources hash follows file names and contents and ignores hidden files", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    await writeFile(path.join(tray, "idle.svg"), svg());
    await writeFile(path.join(tray, "blink.svg"), svg());
    const first = await traySourcesHash(tray);
    assert.match(first, /^sha256-[0-9a-f]{64}$/);
    await writeFile(path.join(tray, ".DS_Store"), "finder");
    assert.equal(await traySourcesHash(tray), first);
    await writeFile(path.join(tray, "blink.svg"), svg('opacity="0.5"'));
    const changed = await traySourcesHash(tray);
    assert.notEqual(changed, first);
    await rm(path.join(tray, "blink.svg"));
    await writeFile(path.join(tray, "hungry.svg"), svg('opacity="0.5"'));
    assert.notEqual(await traySourcesHash(tray), changed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generator writes the sources hash into the module header", async () => {
  const dir = await trayDir();
  try {
    for (const frame of MASCOT_FRAMES) await writeFile(path.join(dir, "tray", `${frame}.svg`), svg());
    await mkdir(path.join(dir, "electron"));
    await writeMascot(await renderMascot(dir), dir);
    const module = await readFile(path.join(dir, "electron/mascot-tray-frames.ts"), "utf8");
    assert.equal(SOURCES_HEADER.exec(module)?.[1], await traySourcesHash(path.join(dir, "tray")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
