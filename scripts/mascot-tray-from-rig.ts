/**
 * Builds the menu bar frames (assets/mascot/source/tray/*.png) from the puppet rig's head
 * (assets/mascot/source/rig/head.svg), so the menu bar shows the same red panda as the app
 * instead of a hand-drawn stand-in. A template image has alpha only, so the mascot's colours
 * become three tones: the dark brown (eyes, nose, mouth, inner ears) is solid, the orange fur is
 * half-transparent, and the cream (cheek mask, brow spots, muzzle, ear rims, eye glints) is cut
 * out. Each frame picks one of the rig's expressions; "!" and "z" sit beside the head as before.
 *
 *   node --import tsx scripts/mascot-tray-from-rig.ts && npm run mascot
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { MASCOT_FRAME_SIZE, type MascotFrame } from "../shared/mascot-frames";

const root = path.resolve(import.meta.dirname, "..");
const RIG_HEAD = path.join(root, "assets/mascot/source/rig/head.svg");
const TRAY = path.join(root, "assets/mascot/source/tray");

type Expression = "open" | "closed" | "happy" | "worried" | "wide";

/** The rig expression each frame shows, and the mark beside it. */
const FRAMES: Record<MascotFrame, { expression: Expression; mark?: "bang" | "z" }> = {
  idle: { expression: "open" },
  blink: { expression: "closed" },
  // The limit is close or reached: big, startled eyes.
  hungry: { expression: "wide" },
  sleep: { expression: "closed", mark: "z" },
  alert: { expression: "open", mark: "bang" },
  // A Desktop operation (a switch) runs: a happy panda.
  away: { expression: "happy" },
};

/**
 * The marks, in frame points (24 × 20), as in the frames they replace; the "z" half a point further left, so
 * its edge does not end on the 23 pt line, where scaling to 1x would smear it into a 24th point.
 */
const MARKS = {
  bang: "M 20.75 2 H 22.25 V 7 H 20.75 Z M 20.75 9.25 A 0.75 0.75 0 1 0 22.25 9.25 A 0.75 0.75 0 1 0 20.75 9.25 Z",
  z: "M 19.5 2 H 22.5 V 3.5 H 19.5 Z M 21.107 2.614 L 22.393 3.386 L 20.893 5.886 L 19.607 5.114 Z M 19.5 5 H 22.5 V 6.5 H 19.5 Z",
};

/** The head's extent in the rig's 512 canvas: ear tips to chin, cheek tuft to cheek tuft. */
const HEAD_BOX = { x: 22, y: 36, width: 468, height: 420 };
/** The head in the frame, in points: 19 pt wide from the left edge, centred on the 20 pt height. */
const HEAD_WIDTH = 19;

const SCALE = 3;
/** Rendered this much larger than the 3x frame, then reduced, for clean edges. */
const SUPERSAMPLE = 8;

/** The rig's head with one expression shown and every other expression and prop hidden. */
function withExpression(svg: string, expression: Expression) {
  return svg
    .replace(/(<g data-expression="(\w+)")(?: style="display:none")?/g, (_, open: string, name: string) =>
      name === expression ? open : `${open} style="display:none"`,
    )
    .replace(/(<g data-prop="\w+")(?: style="display:none")?/g, '$1 style="display:none"');
}

/** CIE L* (0–100) of an sRGB colour. */
function lightness(r: number, g: number, b: number) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/**
 * The template tone of a mascot colour by its lightness: cream (L* ≈ 94) is a hole, the fur's
 * orange and its darker shade (L* ≈ 47–62) half, the dark brown (L* ≈ 20) solid. Edges between
 * them fall in between.
 */
function tone(l: number) {
  if (l >= 88) return 0;
  if (l >= 66) return ((88 - l) / 22) * 0.5;
  if (l >= 40) return 0.5;
  if (l >= 26) return 0.5 + ((40 - l) / 14) * 0.5;
  return 1;
}

async function headLayer(expression: Expression) {
  const svg = withExpression(await readFile(RIG_HEAD, "utf8"), expression);
  const px = HEAD_WIDTH * SCALE * SUPERSAMPLE;
  const height = Math.round((px * HEAD_BOX.height) / HEAD_BOX.width);
  const cropped = svg.replace(
    /viewBox="[^"]*"/,
    `viewBox="${HEAD_BOX.x} ${HEAD_BOX.y} ${HEAD_BOX.width} ${HEAD_BOX.height}" width="${px}" height="${height}"`,
  );
  const { data, info } = await sharp(Buffer.from(cropped), { density: 72 * 4 })
    .resize(px, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, o = 0; i < data.length; i += info.channels, o += 4) {
    const alpha = data[i + 3] / 255;
    out[o + 3] = Math.round(255 * alpha * tone(lightness(data[i], data[i + 1], data[i + 2])));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(HEAD_WIDTH * SCALE, Math.round((HEAD_WIDTH * SCALE * HEAD_BOX.height) / HEAD_BOX.width), {
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
}

async function frame(name: MascotFrame) {
  const { expression, mark } = FRAMES[name];
  const width = MASCOT_FRAME_SIZE.width * SCALE;
  const height = MASCOT_FRAME_SIZE.height * SCALE;
  const head = await headLayer(expression);
  const headHeight = (await sharp(head).metadata()).height ?? height;
  const layers: OverlayOptions[] = [
    { input: head, left: 0, top: Math.round((height - headHeight) / 2) },
  ];
  if (mark)
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" width="${width}" height="${height}"><path fill="#000" d="${MARKS[mark]}"/></svg>`,
      ),
      left: 0,
      top: 0,
    });
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
  await rm(path.join(TRAY, `${name}.svg`), { force: true });
  await writeFile(path.join(TRAY, `${name}.png`), png);
}

async function main() {
  for (const name of Object.keys(FRAMES) as MascotFrame[]) await frame(name);
  console.log("Built the menu bar frames from the rig's head. Run npm run mascot next.");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
