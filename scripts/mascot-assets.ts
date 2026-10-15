import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MASCOT_FRAME_SIZE, MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";
import {
  DISGUISE_PROPS, PANDA_CANVAS, PANDA_EXPRESSIONS, PANDA_POSES, POSE_NESTING, POSE_PARTS, POSE_PROPS,
  type PandaPose,
} from "../shared/panda-poses";

const SCALES = [1, 2, 3] as const;
const VIEWBOX = /^\s*0[\s,]+0[\s,]+24[\s,]+20\s*$/;
/** Markup before the root skipped over, then the root start tag with its attributes captured. */
const ROOT_TAG =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<svg(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
/** One attribute at a time, so a quoted value is never mistaken for an attribute. */
const ATTRIBUTE = /\s+([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

export interface TrayRepresentation {
  scaleFactor: number;
  png: string;
}

async function list(dir: string) {
  try {
    return (await readdir(dir)).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * The SVG with its root element sized to the frame. A delivered file's own width
 * and height are dropped so the viewBox alone decides the aspect and the render
 * density; `viewBoxOk` is read from that root element only.
 */
function prepareSvg(text: string): { svg: string; viewBoxOk: boolean } | undefined {
  for (const tag of text.matchAll(ROOT_TAG)) {
    const attributes = tag[1];
    if (attributes === undefined) continue; // a comment, declaration or CDATA before the root
    let viewBox: string | undefined;
    const rest = attributes.replace(ATTRIBUTE, (all, name: string, double?: string, single?: string) => {
      const value = double ?? single;
      if (name === "viewBox") viewBox = value;
      return name === "width" || name === "height" ? "" : all;
    });
    const { width, height } = MASCOT_FRAME_SIZE;
    const root = `<svg width="${width}" height="${height}"${rest}>`;
    return {
      svg: text.slice(0, tag.index) + root + text.slice(tag.index + tag[0].length),
      viewBoxOk: viewBox !== undefined && VIEWBOX.test(viewBox),
    };
  }
  return undefined;
}

const NO_ROOT = "no <svg> root element";

function reason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].replace(/^Input buffer has corrupt header: /, "").trim().slice(0, 200) || "unknown error";
}

/** A prepared SVG as a PNG of the frame at `scale`, rasterized at 4× first. */
function rasterize(svg: string, scale: number) {
  return sharp(Buffer.from(svg), { density: 72 * scale * 4 })
    .resize(MASCOT_FRAME_SIZE.width * scale, MASCOT_FRAME_SIZE.height * scale, { fit: "fill" })
    .png()
    .toBuffer();
}

/** Above this alpha a pixel shows in the menu bar. */
const VISIBLE_ALPHA = 32;
/** A visible pixel with any channel above this is a light fill, not black. */
const DARK_CHANNEL = 64;

/**
 * macOS draws a template image from its alpha only, so a light fill becomes part
 * of the silhouette and an opaque background a solid block. `file` names the
 * frame in each problem.
 */
async function templateProblems(image: ReturnType<typeof sharp>, file: string): Promise<string[]> {
  // PNG pixels come out straight (not premultiplied), so colours need no correction.
  const { data, info } = await image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let light = false;
  let transparent = false;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = data[i + info.channels - 1];
    if (alpha === 0) transparent = true;
    else if (alpha > VISIBLE_ALPHA && Math.max(data[i], data[i + 1], data[i + 2]) > DARK_CHANNEL) light = true;
  }
  return [
    ...(light ? [`tray/${file}: opaque light pixels; cut holes instead of light fills`] : []),
    ...(transparent ? [] : [`tray/${file}: no transparent pixels; the background must be transparent`]),
  ];
}

/** Every problem with the delivered menu bar frames; empty when they can be rendered. */
export async function checkTraySources(trayDir: string): Promise<string[]> {
  const problems: string[] = [];
  const files = await list(trayDir);
  const frames = new Set<string>(MASCOT_FRAMES);
  for (const file of files) {
    const { name, ext } = path.parse(file);
    if (!frames.has(name) || (ext !== ".svg" && ext !== ".png"))
      problems.push(`tray/${file}: not a mascot frame`);
  }
  const { width, height } = MASCOT_FRAME_SIZE;
  for (const frame of MASCOT_FRAMES) {
    const svg = files.includes(`${frame}.svg`);
    const png = files.includes(`${frame}.png`);
    if (svg && png) problems.push(`tray/${frame}: both .svg and .png; keep one`);
    else if (svg) {
      const text = await readFile(path.join(trayDir, `${frame}.svg`), "utf8");
      const prepared = prepareSvg(text);
      if (!prepared) problems.push(`tray/${frame}.svg: cannot be rendered (${NO_ROOT})`);
      else {
        if (!prepared.viewBoxOk) problems.push(`tray/${frame}.svg: viewBox must be "0 0 24 20"`);
        // At 3x so thin light details such as eyes are not averaged away.
        const rendered = await rasterize(prepared.svg, 3).catch((error) => {
          problems.push(`tray/${frame}.svg: cannot be rendered (${reason(error)})`);
          return undefined;
        });
        if (rendered) problems.push(...(await templateProblems(sharp(rendered), `${frame}.svg`)));
      }
    } else if (png) {
      const file = path.join(trayDir, `${frame}.png`);
      const meta = await sharp(file).metadata().catch(() => undefined);
      if (!meta) problems.push(`tray/${frame}.png: not a readable PNG`);
      else {
        if (meta.width !== width * 3 || meta.height !== height * 3)
          problems.push(`tray/${frame}.png: must be ${width * 3}×${height * 3}, is ${meta.width}×${meta.height}`);
        if (!meta.hasAlpha) problems.push(`tray/${frame}.png: needs an alpha channel`);
        else problems.push(...(await templateProblems(sharp(file), `${frame}.png`)));
      }
    } else problems.push(`tray/${frame}: missing (.svg or .png)`);
  }
  return problems;
}

const RIG_VIEWBOX = /^\s*0[\s,]+0[\s,]+512[\s,]+512\s*$/;
/** The shapes the Codex brief allows; anything else (script, style, image, use…) is refused. */
const RIG_ELEMENTS = new Set([
  "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line",
  "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop", "title", "desc",
]);
/** Markup that is not an element skipped; a start or end tag with its slash, name and attributes captured. */
const TAG =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
/** The start of each url(…) target, quotes skipped. */
const URL_TARGET = /url\(\s*['"]?([^'")\s]*)/gi;

interface RigNode {
  name: string;
  attributes: Map<string, string>;
  /** Labels of the groups around it (`part:head`, `prop:bamboo`, `expression:open`), outermost first. */
  within: string[];
}

function attributesOf(source: string) {
  const attributes = new Map<string, string>();
  for (const [, name, double, single] of source.matchAll(ATTRIBUTE)) attributes.set(name, double ?? single ?? "");
  return attributes;
}

function labelOf(attributes: Map<string, string>) {
  for (const key of ["part", "prop", "expression"] as const) {
    const value = attributes.get(`data-${key}`);
    if (value !== undefined) return `${key}:${value}`;
  }
  return undefined;
}

/** The root's attributes and every element inside it, with the labelled groups around each. */
function readRig(text: string): { root?: Map<string, string>; nodes: RigNode[] } {
  const nodes: RigNode[] = [];
  const stack: (string | undefined)[] = [];
  let root: Map<string, string> | undefined;
  for (const [, slash, name, rest] of text.matchAll(TAG)) {
    if (name === undefined) continue; // a comment, declaration or CDATA
    if (slash) {
      stack.pop();
      continue;
    }
    const attributes = attributesOf(rest);
    if (!root) {
      if (name !== "svg") return { nodes };
      root = attributes;
      continue;
    }
    nodes.push({ name, attributes, within: stack.filter((label): label is string => !!label) });
    if (!/\/\s*$/.test(rest)) stack.push(labelOf(attributes));
  }
  return { root, nodes };
}

function pivotInside(value: string) {
  const numbers = value.trim().split(/[\s,]+/).map(Number);
  return numbers.length === 2 && numbers.every((n) => Number.isFinite(n) && n >= 0 && n <= PANDA_CANVAS);
}

/** Every problem with one rig file; each distinct problem once. */
function rigProblems(pose: PandaPose, text: string): string[] {
  const file = `rig/${pose}.svg`;
  const { root, nodes } = readRig(text);
  if (!root) return [`${file}: no <svg> root element`];
  const problems = new Set<string>();
  if (!RIG_VIEWBOX.test(root.get("viewBox") ?? "")) problems.add(`${file}: viewBox must be "0 0 512 512"`);
  if (/javascript:/i.test(text)) problems.add(`${file}: javascript: is not allowed`);
  const parts = new Map<string, RigNode>();
  const props = new Map<string, RigNode>();
  for (const node of [{ name: "svg", attributes: root, within: [] } as RigNode, ...nodes]) {
    if (node.attributes !== root && !RIG_ELEMENTS.has(node.name)) problems.add(`${file}: <${node.name}> is not allowed`);
    for (const [name, value] of node.attributes) {
      if (/^on/i.test(name)) problems.add(`${file}: event attribute ${name} is not allowed`);
      if ((name === "href" || name === "xlink:href") && !value.startsWith("#"))
        problems.add(`${file}: ${name}="${value}" must point to an #id in the same file`);
      for (const [, target] of value.matchAll(URL_TARGET))
        if (!target.startsWith("#")) problems.add(`${file}: url(${target}) must point to an #id in the same file`);
    }
    const part = node.attributes.get("data-part");
    const prop = node.attributes.get("data-prop");
    if (part === undefined && prop === undefined) continue;
    const label = part !== undefined ? `part "${part}"` : `prop "${prop}"`;
    if (part !== undefined) parts.set(part, node);
    else props.set(prop!, node);
    // A CSS transform replaces the element's own transform attribute while it animates.
    if (node.attributes.has("transform"))
      problems.add(`${file}: ${label} has its own transform; move it to an inner group`);
    const pivot = node.attributes.get("data-pivot");
    const needsPivot = part !== undefined || (DISGUISE_PROPS as readonly string[]).includes(prop!);
    if (pivot === undefined ? needsPivot : !pivotInside(pivot))
      problems.add(`${file}: ${label} needs data-pivot="x y" inside the 512×512 canvas`);
  }
  for (const name of POSE_PARTS[pose]) if (!parts.has(name)) problems.add(`${file}: missing part "${name}"`);
  for (const name of POSE_PROPS[pose]) if (!props.has(name)) problems.add(`${file}: missing prop "${name}"`);
  if (parts.has("eyes"))
    for (const expression of PANDA_EXPRESSIONS)
      if (!nodes.some((n) => n.attributes.get("data-expression") === expression && n.within.includes("part:eyes")))
        problems.add(`${file}: missing expression "${expression}" inside part "eyes"`);
  for (const [name, holders] of Object.entries(POSE_NESTING[pose] ?? {})) {
    const node = props.get(name) ?? parts.get(name);
    if (node && !holders.some((holder) => node.within.includes(`part:${holder}`)))
      problems.add(
        `${file}: ${props.has(name) ? "prop" : "part"} "${name}" must be inside part ${holders.map((h) => `"${h}"`).join(" or ")}`,
      );
  }
  return [...problems];
}

/** Every problem with the delivered puppet rig; empty when it can be generated. */
export async function checkRigSources(rigDir: string): Promise<string[]> {
  const problems: string[] = [];
  const files = await list(rigDir);
  const poses = new Set<string>(PANDA_POSES);
  for (const file of files)
    if (!file.endsWith(".svg") || !poses.has(file.slice(0, -4))) problems.push(`rig/${file}: not a puppet pose`);
  for (const pose of PANDA_POSES) {
    if (!files.includes(`${pose}.svg`)) problems.push(`rig/${pose}.svg: missing`);
    else problems.push(...rigProblems(pose, await readFile(path.join(rigDir, `${pose}.svg`), "utf8")));
  }
  return problems;
}

/** Every problem with a delivery in `source`: the menu bar frames and the puppet rig. */
export async function checkMascotSources(source: string): Promise<string[]> {
  return [
    ...(await checkTraySources(path.join(source, "tray"))),
    ...(await checkRigSources(path.join(source, "rig"))),
  ];
}

/** One frame as 1x/2x/3x PNGs; an SVG's own width/height never changes the result. */
export async function renderTrayFrame(trayDir: string, frame: MascotFrame): Promise<TrayRepresentation[]> {
  const text = await readFile(path.join(trayDir, `${frame}.svg`), "utf8").catch(() => undefined);
  const prepared = text === undefined ? undefined : prepareSvg(text);
  if (text !== undefined && !prepared) throw new Error(`tray/${frame}.svg: cannot be rendered (${NO_ROOT})`);
  const reps: TrayRepresentation[] = [];
  for (const scale of SCALES) {
    let png: Buffer;
    if (prepared) {
      png = await rasterize(prepared.svg, scale).catch((error) => {
        throw new Error(`tray/${frame}.svg: cannot be rendered (${reason(error)})`);
      });
    } else {
      png = await sharp(path.join(trayDir, `${frame}.png`))
        .resize(MASCOT_FRAME_SIZE.width * scale, MASCOT_FRAME_SIZE.height * scale, { fit: "fill" })
        .png()
        .toBuffer();
    }
    reps.push({ scaleFactor: scale, png: png.toString("base64") });
  }
  return reps;
}

/**
 * A hash of the delivered tray files (sorted names and contents, hidden files
 * skipped); the generated module records it so a test can catch stale output.
 */
export async function traySourcesHash(trayDir: string) {
  const hash = createHash("sha256");
  for (const file of (await list(trayDir)).sort()) {
    const raw = await readFile(path.join(trayDir, file));
    // Git on Windows checks text out with CRLF; the artwork is the same.
    const content = file.endsWith(".svg") ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n")) : raw;
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
  }
  return `sha256-${hash.digest("hex")}`;
}

export async function renderMascot(source: string) {
  const trayDir = path.join(source, "tray");
  const sources = await traySourcesHash(trayDir);
  const tray = {} as Record<MascotFrame, TrayRepresentation[]>;
  for (const frame of MASCOT_FRAMES) tray[frame] = await renderTrayFrame(trayDir, frame);
  return { tray, sources };
}

export async function writeMascot(rendered: Awaited<ReturnType<typeof renderMascot>>, root: string) {
  await writeFile(
    path.join(root, "electron/mascot-tray-frames.ts"),
    "// Generated by scripts/mascot.ts from assets/mascot/source/tray.\n" +
      "// Regenerate with npm run mascot; replace the sources instead.\n" +
      `// Sources: ${rendered.sources}\n` +
      'import type { MascotFrame } from "../shared/mascot-frames";\n' +
      "export const mascotTrayFrames: Record<\n  MascotFrame,\n  readonly { scaleFactor: number; png: string }[]\n> = " +
      `${JSON.stringify(rendered.tray, null, 2)};\n`,
  );
}
