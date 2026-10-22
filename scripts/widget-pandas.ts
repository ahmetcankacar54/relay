/**
 * Builds the widget's panda heads (electron/native/widget/pandas/*.png) from the puppet rig's head
 * (assets/mascot/source/rig/head.svg), one per mood the widget shows (shared/widget-snapshot.ts
 * `WidgetMood`): happy while all is well, wide eyes when the open account's five-hour window is
 * nearly used, worried once a limit is full, and asleep (closed eyes) while there is nothing
 * current to watch.
 *
 * Each mood comes three ways. `panda-<mood>.png` is the full-colour head for a focused desktop.
 * When the desktop is not focused macOS draws widgets vibrant: desaturated, lightness turned into
 * opacity, so the colour head would lose its dark eyes into its own mask. The two masks are alpha
 * only, for a template image tinted with the primary colour, as the menu bar does
 * (scripts/mascot-tray-from-rig.ts): `-mask.png` for dark ink (the dark brown solid, the fur half,
 * the cream cut out) and `-mask-dark.png` for light ink (the cream solid, the fur three quarters,
 * the dark brown cut out).
 *
 *   node --import tsx scripts/widget-pandas.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const RIG_HEAD = path.join(root, "assets", "mascot", "source", "rig", "head.svg");
export const WIDGET_PANDAS = path.join(root, "electron/native/widget/pandas");

type Expression = "open" | "closed" | "happy" | "worried" | "wide";

/** Each mood's rig expression, and whether the "z" prop floats beside it. */
export const PANDA_MOODS = {
  happy: { expression: "happy", z: false },
  alert: { expression: "wide", z: false },
  worried: { expression: "worried", z: false },
  // The rig's "z" would be a speck at the widget's 18–28 pt; closed eyes say it alone.
  sleeping: { expression: "closed", z: false },
} satisfies Record<string, { expression: Expression; z: boolean }>;
export type PandaMood = keyof typeof PANDA_MOODS;

/** The head's extent in the rig's 512 canvas: ear tips to chin, cheek tuft to cheek tuft. */
const HEAD_BOX = { x: 22, y: 36, width: 468, height: 420 };
/** 28 pt, the largest the widget draws a head, at 3x. */
const WIDTH = 84;
const HEIGHT = Math.round((WIDTH * HEAD_BOX.height) / HEAD_BOX.width);
/** Rendered this much larger, then reduced, for clean edges. */
const SUPERSAMPLE = 8;

function withExpression(svg: string, expression: Expression, z: boolean) {
  return svg
    .replace(/(<g data-expression="(\w+)")(?: style="display:none")?/g, (_, open: string, name: string) =>
      name === expression ? open : `${open} style="display:none"`,
    )
    .replace(/(<g data-prop="(\w+)")(?: style="display:none")?/g, (_, open: string, name: string) =>
      z && name === "z" ? open : `${open} style="display:none"`,
    );
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

/** Dark ink: cream (L* ≈ 94) a hole, the fur (L* ≈ 47–62) half, the dark brown (L* ≈ 20) solid. */
function darkInk(l: number) {
  if (l >= 88) return 0;
  if (l >= 66) return ((88 - l) / 22) * 0.5;
  if (l >= 40) return 0.5;
  if (l >= 26) return 0.5 + ((40 - l) / 14) * 0.5;
  return 1;
}

/** Light ink: the cream solid, the fur three quarters, the dark brown cut out. */
function lightInk(l: number) {
  const fur = 0.75;
  if (l >= 88) return 1;
  if (l >= 66) return fur + ((l - 66) / 22) * (1 - fur);
  if (l >= 40) return fur;
  if (l >= 26) return (fur * (l - 26)) / 14;
  return 0;
}

async function head(mood: PandaMood) {
  const { expression, z } = PANDA_MOODS[mood];
  const svg = withExpression(await readFile(RIG_HEAD, "utf8"), expression, z);
  const px = WIDTH * SUPERSAMPLE;
  const height = HEIGHT * SUPERSAMPLE;
  const cropped = svg.replace(
    /viewBox="[^"]*"/,
    `viewBox="${HEAD_BOX.x} ${HEAD_BOX.y} ${HEAD_BOX.width} ${HEAD_BOX.height}" width="${px}" height="${height}"`,
  );
  return sharp(Buffer.from(cropped), { density: 72 * 4 })
    .resize(px, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

const reduce = (data: Buffer, width: number, height: number) =>
  sharp(data, { raw: { width, height, channels: 4 } })
    .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

async function main() {
  await mkdir(WIDGET_PANDAS, { recursive: true });
  for (const mood of Object.keys(PANDA_MOODS) as PandaMood[]) {
    const { data, info } = await head(mood);
    const colour = Buffer.alloc(info.width * info.height * 4);
    const dark = Buffer.alloc(colour.length);
    const light = Buffer.alloc(colour.length);
    for (let i = 0, o = 0; i < data.length; i += info.channels, o += 4) {
      colour[o] = data[i];
      colour[o + 1] = data[i + 1];
      colour[o + 2] = data[i + 2];
      colour[o + 3] = data[i + 3];
      const alpha = data[i + 3] / 255;
      const l = lightness(data[i], data[i + 1], data[i + 2]);
      dark[o + 3] = Math.round(255 * alpha * darkInk(l));
      light[o + 3] = Math.round(255 * alpha * lightInk(l));
    }
    const out = (suffix: string, bytes: Buffer) =>
      reduce(bytes, info.width, info.height).then((png) =>
        writeFile(path.join(WIDGET_PANDAS, `panda-${mood}${suffix}.png`), png),
      );
    await out("", colour);
    await out("-mask", dark);
    await out("-mask-dark", light);
  }
  console.log(`Built the widget's panda heads in ${path.relative(root, WIDGET_PANDAS)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
