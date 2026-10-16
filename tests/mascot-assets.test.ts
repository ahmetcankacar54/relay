import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  checkMascotSources, checkRigSources, checkTraySources, renderMascot, renderTrayFrame, rigMarkup, sourcesHash, writeMascot,
} from "../scripts/mascot-assets";
import { mascotTrayFrames } from "../electron/mascot-tray-frames";
import { MASCOT_FRAMES } from "../shared/mascot-frames";
import { PANDA_RIG } from "../src/mascot/panda-rig";
import { PANDA_POSES, RIG_ID_TOKEN, type PandaPose } from "../shared/panda-poses";

const root = path.resolve(import.meta.dirname, "..");
const RIG = path.join(root, "assets/mascot/source/rig");
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
    await sourcesHash(path.join(root, "assets/mascot/source/tray")),
    "assets/mascot/source/tray changed since the module was generated; run npm run mascot",
  );
});

test("the sources hash follows file names and contents and ignores hidden files", async () => {
  const dir = await trayDir();
  const tray = path.join(dir, "tray");
  try {
    await writeFile(path.join(tray, "idle.svg"), svg());
    await writeFile(path.join(tray, "blink.svg"), svg());
    const first = await sourcesHash(tray);
    assert.match(first, /^sha256-[0-9a-f]{64}$/);
    await writeFile(path.join(tray, ".DS_Store"), "finder");
    assert.equal(await sourcesHash(tray), first);
    await writeFile(path.join(tray, "blink.svg"), svg('opacity="0.5"'));
    const changed = await sourcesHash(tray);
    assert.notEqual(changed, first);
    await rm(path.join(tray, "blink.svg"));
    await writeFile(path.join(tray, "hungry.svg"), svg('opacity="0.5"'));
    assert.notEqual(await sourcesHash(tray), changed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generator writes the sources hash into the module header", async () => {
  const dir = await trayDir();
  try {
    for (const frame of MASCOT_FRAMES) await writeFile(path.join(dir, "tray", `${frame}.svg`), svg());
    await cp(RIG, path.join(dir, "rig"), { recursive: true });
    await writeMascot(await renderMascot(dir), dir);
    const tray = await readFile(path.join(dir, "electron/mascot-tray-frames.ts"), "utf8");
    assert.equal(SOURCES_HEADER.exec(tray)?.[1], await sourcesHash(path.join(dir, "tray")));
    const rig = await readFile(path.join(dir, "src/mascot/panda-rig.ts"), "utf8");
    assert.equal(SOURCES_HEADER.exec(rig)?.[1], await sourcesHash(path.join(dir, "rig")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the sources hash ignores SVG line endings, as a Windows checkout writes them", async () => {
  const lf = await trayDir();
  const crlf = await trayDir();
  try {
    const multiline = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20">\n  <rect x="2" y="2" width="20" height="16"/>\n</svg>\n';
    await writeFile(path.join(lf, "tray", "idle.svg"), multiline);
    await writeFile(path.join(crlf, "tray", "idle.svg"), multiline.replaceAll("\n", "\r\n"));
    assert.equal(await sourcesHash(path.join(crlf, "tray")), await sourcesHash(path.join(lf, "tray")));
  } finally {
    await rm(lf, { recursive: true, force: true });
    await rm(crlf, { recursive: true, force: true });
  }
});

/** A temporary copy of the committed rig, each file changed by its mutator. */
async function rigDir(mutate: Partial<Record<PandaPose, (svg: string) => string>> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-rig-"));
  for (const pose of PANDA_POSES) {
    const svg = await readFile(path.join(RIG, `${pose}.svg`), "utf8");
    await writeFile(path.join(dir, `${pose}.svg`), mutate[pose]?.(svg) ?? svg);
  }
  return dir;
}
/** Markup added right after the root start tag. */
const inject = (svg: string, markup: string) => svg.replace(/(<svg[^>]*>)/, `$1${markup}`);

test("the committed rig is complete and valid", async () => {
  assert.deepEqual(await checkRigSources(RIG), []);
});

test("a rig delivery with missing or extra files lists each, ignoring hidden files", async () => {
  const dir = await rigDir();
  try {
    await rm(path.join(dir, "door.svg"));
    await writeFile(path.join(dir, "dance.svg"), "<svg/>");
    await writeFile(path.join(dir, "sit.png"), "");
    await writeFile(path.join(dir, ".DS_Store"), "");
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      "rig/dance.svg: not a puppet pose",
      "rig/door.svg: missing",
      "rig/sit.png: not a puppet pose",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsafe rig content is refused by name", async () => {
  const dir = await rigDir({
    sit: (s) => inject(s, "<script>alert(1)</script>"),
    stand: (s) => inject(s, '<image href="https://example.com/panda.png" width="10" height="10"/>'),
    walk: (s) => s.replace('data-part="tail"', 'onclick="steal()" data-part="tail"'),
    curl: (s) => inject(s, '<rect width="4" height="4" fill="url(https://example.com/x.svg#p)"/>'),
    head: (s) => inject(s, '<linearGradient id="panda-g" href="javascript:alert(1)"/>'),
    peek: (s) => inject(s, "<style>*{}</style>"),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      "rig/curl.svg: url(https://example.com/x.svg#p) must point to an #id in the same file",
      'rig/head.svg: href="javascript:alert(1)" must point to an #id in the same file',
      "rig/head.svg: javascript: is not allowed",
      "rig/peek.svg: <style> is not allowed",
      "rig/sit.svg: <script> is not allowed",
      "rig/stand.svg: <image> is not allowed",
      'rig/stand.svg: href="https://example.com/panda.png" must point to an #id in the same file',
      "rig/walk.svg: event attribute onclick is not allowed",
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rig pose missing a part, expression, prop or nesting lists each", async () => {
  const dir = await rigDir({
    sit: (s) => s.replace('data-part="tail"', 'data-part="tale"').replace('data-expression="happy"', 'data-expression="glad"'),
    stand: (s) => s.replace('data-prop="coat"', 'data-prop="cape"'),
    chew: (s) => s.replace('data-part="held"', 'data-part="hold"'),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      'rig/chew.svg: missing part "held"',
      'rig/chew.svg: prop "bamboo" must be inside part "held"',
      'rig/chew.svg: prop "cursor" must be inside part "held"',
      'rig/chew.svg: prop "cursor-bitten" must be inside part "held"',
      'rig/sit.svg: missing expression "happy" inside part "eyes"',
      'rig/sit.svg: missing part "tail"',
      'rig/stand.svg: missing prop "coat"',
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rig pivots must sit inside the canvas, and parts carry no transform of their own", async () => {
  const dir = await rigDir({
    walk: (s) => s.replace('data-part="tail" data-pivot="218 300"', 'data-part="tail"'),
    stand: (s) => s.replace('data-pivot="256 91"', 'data-pivot="256 600"'),
    door: (s) => s.replace('data-part="leaf"', 'data-part="leaf" transform="translate(4 0)"'),
    sit: (s) => s.replace('data-pivot="405 454"', 'data-pivot="bowl"'),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      'rig/door.svg: part "leaf" has its own transform; move it to an inner group',
      'rig/sit.svg: prop "bowl" needs data-pivot="x y" inside the 512×512 canvas',
      'rig/stand.svg: prop "fedora" needs data-pivot="x y" inside the 512×512 canvas',
      'rig/walk.svg: part "tail" needs data-pivot="x y" inside the 512×512 canvas',
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the rig viewBox counts on the root element, and a file needs one", async () => {
  const dir = await rigDir({
    stand: (s) => s.replace('viewBox="0 0 512 512"', 'viewBox="0 0 256 256"'),
    head: () => "<html></html>",
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      "rig/head.svg: no <svg> root element",
      'rig/stand.svg: viewBox must be "0 0 512 512"',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rig markup the browser would read differently is refused: tokens, end tags and attribute text", async () => {
  const NOT_ALLOWED = "comments, processing instructions, CDATA and DOCTYPE are not allowed";
  const dir = await rigDir({
    sit: (s) => inject(s, '<!-- hi --><g id="a"onclick="x"></g>'),
    stand: (s) => inject(s, '<?pi x="1"?><g/onclick="x"></g>'),
    walk: (s) => inject(s.replace('viewBox="0 0 512 512"', 'viewBox="0 0 512 512"x="1"'), "<!DOCTYPE svg>"),
    curl: (s) => inject(s, "<![CDATA[x]]>").replace(/<\/svg>\s*$/, "</svg></g>"),
    // Before the root all of these are fine, as an artist's editor writes them.
    peek: (s) => `<?xml version="1.0" encoding="UTF-8"?><!-- before --><!DOCTYPE svg>${s}`,
    head: (s) => s.replace(/<\/svg>\s*$/, "</svg junk>"),
    chew: (s) => inject(s, "<g></rect>"),
    door: (s) => s.replace(/<\/svg>\s*$/, "<g>"),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      "rig/chew.svg: </rect> does not close <g>",
      `rig/curl.svg: ${NOT_ALLOWED}`,
      "rig/curl.svg: </g> has no open element to close",
      "rig/door.svg: <g> is never closed",
      "rig/door.svg: <svg> is never closed",
      "rig/head.svg: malformed end tag </svg>",
      `rig/sit.svg: ${NOT_ALLOWED}`,
      "rig/sit.svg: malformed attributes in <g>",
      `rig/stand.svg: ${NOT_ALLOWED}`,
      "rig/stand.svg: malformed attributes in <g>",
      `rig/walk.svg: ${NOT_ALLOWED}`,
      "rig/walk.svg: malformed attributes in <svg>",
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rig attribute names the browser lower-cases and values it decodes are refused", async () => {
  const dir = await rigDir({
    sit: (s) => inject(s, '<linearGradient id="panda-g" HREF="#x"/>'),
    stand: (s) => s.replace('data-part="head"', 'data-part="head" TRANSFORM="translate(1 1)"'),
    walk: (s) => inject(s, '<rect width="4" height="4" fill="url&#40;https://example.com/x.svg#p)"/>'),
    curl: (s) => inject(s, '<rect width="4" height="4" style="fill:\\75rl(https://example.com/x.svg#p)"/>'),
    head: (s) => inject(s, '<g ID="h" DATA-extra="1"/>'),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      "rig/curl.svg: style uses a character reference or escape; write the value plainly",
      "rig/head.svg: attribute DATA-extra must be written in lower case",
      "rig/head.svg: attribute ID must be written in lower case",
      "rig/sit.svg: attribute HREF must be written in lower case",
      "rig/stand.svg: attribute TRANSFORM must be written in lower case",
      "rig/walk.svg: fill uses a character reference or escape; write the value plainly",
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rig pivots are two plain numbers, an inline style counts as a transform, and names are unique", async () => {
  const dir = await rigDir({
    sit: (s) => s.replace('data-pivot="405 454"', 'data-pivot=",5"'),
    stand: (s) => s.replace('data-pivot="256 91"', 'data-pivot="0x10 20"'),
    walk: (s) => s.replace('data-part="tail"', 'data-part="tail" style="fill:red; transform : rotate(3deg)"'),
    curl: (s) => inject(s, '<g data-part="tail" data-pivot="1 1"/>'),
    head: (s) => inject(s, '<g data-prop="z" data-pivot="1 1"/>'),
    // Attribute and style together are one problem.
    chew: (s) => s.replace('data-part="head"', 'data-part="head" transform="scale(1)" style="TRANSFORM:none"'),
    // A comma pivot and a style without a transform declaration are fine.
    door: (s) => s.replace('data-part="knob"', 'data-part="knob" data-pivot="1,2" style="transform-origin:1px 1px"'),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      'rig/chew.svg: part "head" has its own transform; move it to an inner group',
      'rig/curl.svg: part "tail" appears more than once',
      'rig/head.svg: prop "z" appears more than once',
      'rig/sit.svg: prop "bowl" needs data-pivot="x y" inside the 512×512 canvas',
      'rig/stand.svg: prop "fedora" needs data-pivot="x y" inside the 512×512 canvas',
      'rig/walk.svg: part "tail" has its own transform; move it to an inner group',
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a prop that may sit in either of two parts names both when it sits in neither", async () => {
  const dir = await rigDir({
    sit: (s) => s.replace('data-part="arm-left"', 'data-part="arm-lft"').replace('data-part="arm-right"', 'data-part="arm-rgt"'),
  });
  try {
    assert.deepEqual((await checkRigSources(dir)).sort(), [
      'rig/sit.svg: missing part "arm-left"',
      'rig/sit.svg: missing part "arm-right"',
      'rig/sit.svg: prop "bamboo" must be inside part "arm-left" or "arm-right"',
    ].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an xlink:href that leaves the file is refused", async () => {
  const dir = await rigDir({
    head: (s) => inject(s, '<linearGradient id="panda-x" xlink:href="https://example.com/x"/>'),
  });
  try {
    assert.deepEqual(await checkRigSources(dir), [
      'rig/head.svg: xlink:href="https://example.com/x" must point to an #id in the same file',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const T = RIG_ID_TOKEN;

test("rig markup turns pivots into transform origins, drops default hiding and marks every id", () => {
  const text =
    '<?xml version="1.0"?><!-- <svg viewBox="0 0 1 1"> --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<defs><clipPath id="panda-clip"><rect width="5" height="5"/></clipPath>' +
    '<linearGradient id="panda-fade" href="#panda-base"/></defs>' +
    '<g data-part="tail" data-pivot="100 200" clip-path="url(#panda-clip)"><path d="M0 0" style="fill:url(\'#panda-fade\')"/></g>' +
    '<g data-prop="bang" style="opacity:0.5;display:none" data-pivot="10.5 20"/>' +
    '<g data-expression="wide" style="display: none"><circle r="2"/></g>' +
    '<g style="display:none"><circle r="1"/></g></svg>\n';
  assert.equal(
    rigMarkup(text),
    `<defs><clipPath id="${T}panda-clip"><rect width="5" height="5"/></clipPath>` +
      `<linearGradient id="${T}panda-fade" href="#${T}panda-base"/></defs>` +
      `<g data-part="tail" data-pivot="100 200" clip-path="url(#${T}panda-clip)" style="transform-origin:100px 200px;transform-box:view-box">` +
      `<path d="M0 0" style="fill:url('#${T}panda-fade')"/></g>` +
      `<g data-prop="bang" style="opacity:0.5;transform-origin:10.5px 20px;transform-box:view-box" data-pivot="10.5 20"/>` +
      `<g data-expression="wide"><circle r="2"/></g>` +
      // Only expression and prop groups lose their hiding.
      `<g style="display:none"><circle r="1"/></g>`,
  );
});

test("the generated rig module holds every pose, ready to draw", () => {
  assert.deepEqual(Object.keys(PANDA_RIG).sort(), [...PANDA_POSES].sort());
  for (const pose of PANDA_POSES) {
    const markup = PANDA_RIG[pose];
    assert.doesNotMatch(markup, /<svg[\s>]/, pose);
    assert.match(markup, /transform-box:view-box/, pose);
    assert.doesNotMatch(markup, /<g[^>]*data-(?:expression|prop)="[^"]*"[^>]*display:\s*none/, pose);
    for (const [, id] of markup.matchAll(/\sid="([^"]*)"/g)) assert.ok(id.startsWith(T), `${pose}: ${id}`);
  }
});

test("the generated rig module was rendered from the committed sources", async () => {
  const module = await readFile(path.join(root, "src/mascot/panda-rig.ts"), "utf8");
  const header = SOURCES_HEADER.exec(module.slice(0, module.indexOf("export ")));
  assert.ok(header, "the generated module must name its sources' hash; run npm run mascot");
  assert.equal(header[1], await sourcesHash(RIG), "assets/mascot/source/rig changed since the module was generated; run npm run mascot");
});
