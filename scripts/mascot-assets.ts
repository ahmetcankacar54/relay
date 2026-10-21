import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MASCOT_FRAME_SIZE, MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";
import {
  DISGUISE_PROPS, PANDA_CANVAS, PANDA_EXPRESSIONS, PANDA_POSES, POSE_NESTING, POSE_PARTS, POSE_PROPS, RIG_ID_TOKEN,
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

/** Whether the attribute text holds nothing but attributes the reader understood. */
function attributesReadable(source: string) {
  return source.replace(ATTRIBUTE, "").replace(/\s*\/?\s*$/, "") === "";
}

/**
 * The root's attributes and every element inside it, with the labelled groups
 * around each, and the structural problems (without the file name) along the way.
 */
function readRig(text: string): { root?: Map<string, string>; nodes: RigNode[]; issues: string[] } {
  const nodes: RigNode[] = [];
  const issues = new Set<string>();
  /** The open elements, root included; `label` is the part, prop or expression group an element is. */
  const stack: { name: string; label?: string }[] = [];
  let root: Map<string, string> | undefined;
  for (const [, slash, name, rest] of text.matchAll(TAG)) {
    if (name === undefined) {
      // A comment, declaration or CDATA; the browser's parser reads these differently from this one.
      if (root) issues.add("comments, processing instructions, CDATA and DOCTYPE are not allowed");
      continue;
    }
    if (slash) {
      if (!/^[ \t\n\f\r]*$/.test(rest)) issues.add(`malformed end tag </${name}>`);
      const open = stack.pop();
      if (!open) issues.add(`</${name}> has no open element to close`);
      else if (open.name !== name) issues.add(`</${name}> does not close <${open.name}>`);
      continue;
    }
    const attributes = attributesOf(rest);
    if (!attributesReadable(rest)) issues.add(`malformed attributes in <${name}>`);
    const selfClosing = /\/\s*$/.test(rest);
    if (!root) {
      if (name !== "svg") return { nodes, issues: [] };
      root = attributes;
      if (!selfClosing) stack.push({ name });
      continue;
    }
    nodes.push({ name, attributes, within: stack.flatMap((open) => (open.label ? [open.label] : [])) });
    if (!selfClosing) stack.push({ name, label: labelOf(attributes) });
  }
  for (const open of stack) issues.add(`<${open.name}> is never closed`);
  return { root, nodes, issues: [...issues] };
}

/** Exactly two plain decimal numbers, split by whitespace and/or one comma, each inside the canvas. */
function pivotInside(value: string) {
  const match = /^\s*(\d+(?:\.\d+)?)(?:\s*,\s*|\s+)(\d+(?:\.\d+)?)\s*$/.exec(value);
  return !!match && match.slice(1).every((n) => Number(n) <= PANDA_CANVAS);
}

/** Whether an inline style declares `property`, CSS comments ignored. */
function declares(style: string | undefined, property: string) {
  return (style ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .some((declaration) => declaration.split(":")[0].trim().toLowerCase() === property);
}

/** Attributes the browser's parser lower-cases, so a validator reading the written case could be fooled. */
const LOWER_CASE_ATTRIBUTE = /^(?:id|href|xlink:href|style|transform)$|^data-/i;

/** Every problem with one rig file; each distinct problem once. */
function rigProblems(pose: PandaPose, text: string): string[] {
  const file = `rig/${pose}.svg`;
  const { root, nodes, issues } = readRig(text);
  if (!root) return [`${file}: no <svg> root element`];
  const problems = new Set<string>(issues.map((issue) => `${file}: ${issue}`));
  if (!RIG_VIEWBOX.test(root.get("viewBox") ?? "")) problems.add(`${file}: viewBox must be "0 0 512 512"`);
  if (/javascript:/i.test(text)) problems.add(`${file}: javascript: is not allowed`);
  const parts = new Map<string, RigNode>();
  const props = new Map<string, RigNode>();
  for (const node of [{ name: "svg", attributes: root, within: [] } as RigNode, ...nodes]) {
    if (node.attributes !== root && !RIG_ELEMENTS.has(node.name)) problems.add(`${file}: <${node.name}> is not allowed`);
    for (const [name, value] of node.attributes) {
      if (/^on/i.test(name)) problems.add(`${file}: event attribute ${name} is not allowed`);
      if (name !== name.toLowerCase() && LOWER_CASE_ATTRIBUTE.test(name))
        problems.add(`${file}: attribute ${name} must be written in lower case`);
      if (/[&\\]/.test(value))
        problems.add(`${file}: ${name} uses a character reference or escape; write the value plainly`);
      if ((name === "href" || name === "xlink:href") && !value.startsWith("#"))
        problems.add(`${file}: ${name}="${value}" must point to an #id in the same file`);
      for (const [, target] of value.matchAll(URL_TARGET))
        if (!target.startsWith("#")) problems.add(`${file}: url(${target}) must point to an #id in the same file`);
    }
    const part = node.attributes.get("data-part");
    const prop = node.attributes.get("data-prop");
    if (part === undefined && prop === undefined) continue;
    const label = part !== undefined ? `part "${part}"` : `prop "${prop}"`;
    const named = part !== undefined ? parts : props;
    if (named.has(part ?? prop!)) problems.add(`${file}: ${label} appears more than once`);
    named.set(part ?? prop!, node);
    // A CSS transform replaces the element's own transform, attribute or inline style, while it animates.
    if (node.attributes.has("transform") || declares(node.attributes.get("style"), "transform"))
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

/** CSS function names are case-insensitive, so `URL(#id)` is marked too; the name stays as written. */
const urls = (value: string) => value.replace(/(url\(\s*['"]?)#/gi, `$1#${RIG_ID_TOKEN}`);
/** A style without `display:none`; empty when nothing else is left. */
const withoutHiding = (style: string) =>
  style.split(";").map((d) => d.trim()).filter((d) => d && !/^display\s*:\s*none$/i.test(d)).join(";");

/**
 * The inside of a rig file as Relay draws it: each pivot also becomes the CSS
 * transform origin, expression and prop groups lose their default hiding (the
 * component's CSS decides), and every id and id reference gets the instance token.
 */
export function rigMarkup(source: string): string {
  // The sources hash ignores SVG line endings, so the markup must too.
  const text = source.replace(/\r\n/g, "\n");
  let inner = "";
  for (const tag of text.matchAll(ROOT_TAG)) {
    if (tag[1] === undefined) continue; // a comment or declaration before the root
    // The root's own end tag is the last one, spaced as the validator allows.
    const end = [...text.matchAll(/<\/svg[ \t\n\f\r]*>/g)].pop()?.index ?? text.length;
    inner = text.slice(tag.index + tag[0].length, end);
    break;
  }
  return inner
    .replace(TAG, (tag, slash: string | undefined, name: string | undefined, rest: string | undefined) => {
      if (name === undefined || slash) return tag;
      const attributes = [...attributesOf(rest!)];
      const pivot = attributes.find(([n]) => n === "data-pivot")?.[1];
      const grouped = attributes.some(([n]) => n === "data-expression" || n === "data-prop");
      let style = attributes.find(([n]) => n === "style")?.[1]?.replace(/;\s*$/, "");
      if (style !== undefined && grouped) style = withoutHiding(style);
      if (pivot !== undefined) {
        const [x, y] = pivot.trim().split(/[\s,]+/);
        style = [style, `transform-origin:${x}px ${y}px;transform-box:view-box`].filter(Boolean).join(";");
      }
      const out: [string, string][] = attributes.flatMap(([n, v]): [string, string][] => {
        if (n === "style") return style ? [[n, urls(style)]] : [];
        if (n === "id") return [[n, RIG_ID_TOKEN + v]];
        if ((n === "href" || n === "xlink:href") && v.startsWith("#")) return [[n, `#${RIG_ID_TOKEN}${v.slice(1)}`]];
        return [[n, urls(v)]];
      });
      if (style && !attributes.some(([n]) => n === "style")) out.push(["style", urls(style)]);
      const source = out.map(([n, v]) => ` ${n}="${v.replaceAll('"', "&quot;")}"`).join("");
      return `<${name}${source}${/\/\s*$/.test(rest!) ? "/" : ""}>`;
    })
    .trim();
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

/** How far right a representation has any ink, in points. */
async function inkRight(rep: TrayRepresentation) {
  const { data, info } = await sharp(Buffer.from(rep.png, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let right = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = info.width - 1; x >= right; x--)
      if (data[(y * info.width + x) * info.channels + info.channels - 1] > 0) {
        right = x + 1;
        break;
      }
  return right / rep.scaleFactor;
}

/**
 * Each frame without the transparent columns on its right, so the menu bar title sits right next to the
 * panda: AppKit already leaves 2 pt between the image and the title. A frame is never narrower than the idle
 * head, so the title stays put when the panda blinks or walks off; a mark beside the head (the "!" or the
 * "z") widens its own frame. Widths are whole points, the same at every scale, and no ink is cut.
 */
export async function trimTrayFrames(
  frames: Record<MascotFrame, TrayRepresentation[]>,
): Promise<Record<MascotFrame, TrayRepresentation[]>> {
  const right = async (frame: MascotFrame) => Math.max(0, ...(await Promise.all(frames[frame].map(inkRight))));
  const head = await right("idle");
  const trimmed = {} as Record<MascotFrame, TrayRepresentation[]>;
  for (const frame of MASCOT_FRAMES) {
    const width = Math.min(MASCOT_FRAME_SIZE.width, Math.max(1, Math.ceil(Math.max(head, await right(frame)))));
    trimmed[frame] = await Promise.all(
      frames[frame].map(async (rep) => {
        const png = await sharp(Buffer.from(rep.png, "base64"))
          .extract({ left: 0, top: 0, width: width * rep.scaleFactor, height: MASCOT_FRAME_SIZE.height * rep.scaleFactor })
          .png()
          .toBuffer();
        return { scaleFactor: rep.scaleFactor, png: png.toString("base64") };
      }),
    );
  }
  return trimmed;
}

/**
 * A hash of the delivered files in one folder (sorted names and contents, hidden
 * files skipped); a generated module records it so a test can catch stale output.
 */
export async function sourcesHash(dir: string) {
  const hash = createHash("sha256");
  for (const file of (await list(dir)).sort()) {
    const raw = await readFile(path.join(dir, file));
    // Git on Windows checks text out with CRLF; the artwork is the same.
    const content = file.endsWith(".svg") ? Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n")) : raw;
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
  }
  return `sha256-${hash.digest("hex")}`;
}

export async function renderMascot(source: string) {
  const trayDir = path.join(source, "tray");
  const rigDir = path.join(source, "rig");
  const tray = {} as Record<MascotFrame, TrayRepresentation[]>;
  for (const frame of MASCOT_FRAMES) tray[frame] = await renderTrayFrame(trayDir, frame);
  const rig = {} as Record<PandaPose, string>;
  for (const pose of PANDA_POSES) rig[pose] = rigMarkup(await readFile(path.join(rigDir, `${pose}.svg`), "utf8"));
  return { tray: await trimTrayFrames(tray), sources: await sourcesHash(trayDir), rig, rigSources: await sourcesHash(rigDir) };
}

export async function writeMascot(rendered: Awaited<ReturnType<typeof renderMascot>>, root: string) {
  await mkdir(path.join(root, "electron"), { recursive: true });
  await writeFile(
    path.join(root, "electron/mascot-tray-frames.ts"),
    "// Generated by scripts/mascot.ts from assets/mascot/source/tray.\n" +
      "// Regenerate with npm run mascot; replace the sources instead.\n" +
      `// Sources: ${rendered.sources}\n` +
      'import type { MascotFrame } from "../shared/mascot-frames";\n' +
      "export const mascotTrayFrames: Record<\n  MascotFrame,\n  readonly { scaleFactor: number; png: string }[]\n> = " +
      `${JSON.stringify(rendered.tray, null, 2)};\n`,
  );
  await mkdir(path.join(root, "src/mascot"), { recursive: true });
  await writeFile(
    path.join(root, "src/mascot/panda-rig.ts"),
    "// Generated by scripts/mascot.ts from assets/mascot/source/rig.\n" +
      "// Regenerate with npm run mascot; replace the sources instead.\n" +
      `// Sources: ${rendered.rigSources}\n` +
      'import type { PandaPose } from "../../shared/panda-poses";\n' +
      `export const PANDA_RIG: Record<PandaPose, string> = ${JSON.stringify(rendered.rig, null, 2)};\n`,
  );
}
