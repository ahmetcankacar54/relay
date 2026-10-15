import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MASCOT_FRAME_SIZE, MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";

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
        await rasterize(prepared.svg, 1).catch((error) =>
          problems.push(`tray/${frame}.svg: cannot be rendered (${reason(error)})`),
        );
      }
    } else if (png) {
      const meta = await sharp(path.join(trayDir, `${frame}.png`)).metadata().catch(() => undefined);
      if (!meta) problems.push(`tray/${frame}.png: not a readable PNG`);
      else if (meta.width !== width * 3 || meta.height !== height * 3)
        problems.push(`tray/${frame}.png: must be ${width * 3}×${height * 3}, is ${meta.width}×${meta.height}`);
    } else problems.push(`tray/${frame}: missing (.svg or .png)`);
  }
  return problems;
}

/** Every problem with a delivery in `source` (tray/ now; phase 2 adds rig/). */
export async function checkMascotSources(source: string): Promise<string[]> {
  return checkTraySources(path.join(source, "tray"));
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

export async function renderMascot(source: string) {
  const tray = {} as Record<MascotFrame, TrayRepresentation[]>;
  for (const frame of MASCOT_FRAMES) tray[frame] = await renderTrayFrame(path.join(source, "tray"), frame);
  return { tray };
}

export async function writeMascot(rendered: Awaited<ReturnType<typeof renderMascot>>, root: string) {
  await writeFile(
    path.join(root, "electron/mascot-tray-frames.ts"),
    "// Generated by scripts/mascot.ts from assets/mascot/source/tray.\n" +
      "// Regenerate with npm run mascot; replace the sources instead.\n" +
      'import type { MascotFrame } from "../shared/mascot-frames";\n' +
      "export const mascotTrayFrames: Record<\n  MascotFrame,\n  readonly { scaleFactor: number; png: string }[]\n> = " +
      `${JSON.stringify(rendered.tray, null, 2)};\n`,
  );
}
