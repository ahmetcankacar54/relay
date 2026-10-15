/**
 * Writes simple placeholder head silhouettes so the code and the gallery work
 * before the Codex artwork arrives. Never overwrites: delivered files stay.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MASCOT_FRAMES, type MascotFrame } from "../shared/mascot-frames";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" width="24" height="20">${body}</svg>\n`;

/** Black shapes with cut-out holes; the holes follow the same transform. */
function masked(shapes: string, holes: string, transform = "") {
  return (
    '<defs><mask id="p" maskUnits="userSpaceOnUse" x="-10" y="-10" width="44" height="40">' +
    `<rect x="-10" y="-10" width="44" height="40" fill="#fff"/>${holes}</mask></defs>` +
    `<g fill="#000" transform="${transform}" mask="url(#p)">${shapes}</g>`
  );
}

/** A broad red panda head: rounded ears, cheek tufts, short muzzle. */
const HEAD =
  '<ellipse cx="12" cy="12.2" rx="8.6" ry="6.6"/>' +
  '<path d="M4.4 9.4 5 3.2Q5.3 2 6.5 2.6L10.2 6.4Z"/><path d="M19.6 9.4 19 3.2Q18.7 2 17.5 2.6L13.8 6.4Z"/>' +
  '<path d="M3.8 12.6 1.6 15.6 4.8 15.4Z"/><path d="M20.2 12.6 22.4 15.6 19.2 15.4Z"/>';
const OPEN = '<circle cx="8.8" cy="11.4" r="1.2" fill="#000"/><circle cx="15.2" cy="11.4" r="1.2" fill="#000"/>';
const WIDE = '<circle cx="8.8" cy="11.2" r="1.6" fill="#000"/><circle cx="15.2" cy="11.2" r="1.6" fill="#000"/>';
const CLOSED =
  '<rect x="7.4" y="11.2" width="2.8" height="0.8" rx="0.4" fill="#000"/>' +
  '<rect x="13.8" y="11.2" width="2.8" height="0.8" rx="0.4" fill="#000"/>';
const MOUTH = '<ellipse cx="12" cy="14.8" rx="1" ry="0.7" fill="#000"/>';
const OPEN_MOUTH = '<ellipse cx="12" cy="15.2" rx="1.6" ry="1.3" fill="#000"/>';
const TONGUE = '<ellipse fill="#000" cx="12" cy="15.9" rx="0.9" ry="0.65"/>';
const Z = '<path fill="#000" d="M19.6 1h3.6v0.9l-2.2 2.1h2.2v0.9h-3.6v-0.9l2.2-2.1h-2.2Z"/>';
const BANG = '<rect fill="#000" x="21.4" y="1" width="1.6" height="4.4" rx="0.7"/><circle fill="#000" cx="22.2" cy="7" r="0.9"/>';
/** The sleeping and alert heads move left to make room for the "z" and the "!". */
const LEFT = "translate(-1.2 0)";

const tray: Record<MascotFrame, string> = {
  idle: svg(masked(HEAD, OPEN + MOUTH)),
  blink: svg(masked(HEAD, CLOSED + MOUTH)),
  hungry: svg(masked(HEAD, OPEN + OPEN_MOUTH) + TONGUE),
  sleep: svg(masked(HEAD, CLOSED + MOUTH, LEFT) + Z),
  alert: svg(masked(HEAD, WIDE + MOUTH, LEFT) + BANG),
  away: svg(
    '<path fill="#000" fill-rule="evenodd" d="M8 1.4h8V19H8Z M9.2 2.6v15.2h5.6V2.6Z"/>' +
      '<path fill="#000" fill-rule="evenodd" d="M9.8 3.2h4.4v14h-4.4Z M12.8 10h1v1h-1Z"/>',
  ),
};

async function exists(file: string) {
  return access(file).then(() => true, () => false);
}

async function main() {
  const dir = path.resolve(import.meta.dirname, "../assets/mascot/source/tray");
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const frame of MASCOT_FRAMES) {
    const base = path.join(dir, frame);
    if ((await exists(`${base}.svg`)) || (await exists(`${base}.png`))) continue;
    await writeFile(`${base}.svg`, tray[frame], { flag: "wx" });
    written++;
  }
  console.log(`Wrote ${written} placeholder frame(s); existing files were kept.`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
