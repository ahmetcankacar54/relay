/**
 * Writes simple placeholder red panda silhouettes so the code and the gallery
 * work before the Codex artwork arrives. Never overwrites: delivered files stay.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DISGUISES, MASCOT_FRAMES, type Disguise, type MascotFrame } from "../shared/mascot-frames";

const n = (v: number) => +v.toFixed(2);
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

interface Panda {
  dx?: number; dy?: number; eye?: number; ear?: number; tail?: number; legs?: number; head?: number;
  tilt?: number; squash?: number; arm?: number; baton?: boolean; held?: string; wear?: string; coat?: boolean;
}
/** A sitting red panda facing right: big striped tail, bamboo baton in a paw. */
function panda(o: Panda = {}) {
  const {
    dx = 0, dy = 0, eye = 0.75, ear = 0, tail = 0, legs = 0, head = 0, tilt = 0, squash = 1,
    arm = 0, baton = true, held = "", wear = "", coat = false,
  } = o;
  const shapes =
    `<path transform="rotate(${tail} 7.5 15)" d="M8 16.4C3.5 17.6.6 13.4 2 9.4c.9 2.9 3 4.4 6.2 4.6Z"/>` +
    '<ellipse cx="11" cy="14" rx="5" ry="4.6"/>' +
    (coat ? '<rect x="6.6" y="10.4" width="9" height="8.8" rx="1.6"/>' : "") +
    `<rect x="${n(12.5 + legs)}" y="15.5" width="1.8" height="4" rx="0.6"/>` +
    `<rect x="${n(9 - legs)}" y="15.8" width="1.8" height="3.7" rx="0.6"/>` +
    `<g transform="translate(0 ${head})">` +
    '<circle cx="16" cy="8" r="3.8"/><ellipse cx="19.4" cy="9" rx="1.8" ry="1.3"/>' +
    '<path d="M13 5.6 13.6 2 15.6 4.3Z"/>' +
    `<path transform="rotate(${ear} 17.8 4.6)" d="M16.6 4.2 18.6 2 19 5.6Z"/>` +
    wear +
    "</g>" +
    `<g transform="rotate(${arm} 15 12)"><rect x="15" y="11.6" width="4" height="1.6" rx="0.8"/>` +
    (baton ? '<rect x="18.6" y="9.6" width="1.5" height="6.4" rx="0.5"/>' : "") +
    `${held}</g>`;
  const holes =
    (eye > 0 ? `<circle cx="17.1" cy="${n(7.6 + head)}" r="${eye}" fill="#000"/>` : "") +
    `<rect transform="rotate(${tail} 7.5 15)" x="2.8" y="13.8" width="2.4" height="0.9" rx="0.4" fill="#000"/>`;
  return masked(shapes, holes,
    `translate(${dx} ${dy}) rotate(${tilt} 12 19) translate(0 19) scale(1 ${squash}) translate(0 -19)`);
}
/** Standing up on its hind legs, arms spread (the startled red panda). */
function standing(arms = 70) {
  const shapes =
    '<path d="M9 17.5C5 18.5 2.5 15 3.6 12c.8 2.2 2.6 3.4 5.2 3.6Z"/>' +
    '<ellipse cx="12" cy="12.4" rx="3.4" ry="5.4"/>' +
    '<rect x="10" y="16.5" width="1.7" height="3" rx="0.6"/><rect x="12.6" y="16.5" width="1.7" height="3" rx="0.6"/>' +
    '<circle cx="12.4" cy="4.8" r="3.3"/><path d="M9.6 3 10 0.6 11.6 2.2Z"/><path d="M13.4 2.2 15 0.6 15.2 3Z"/>' +
    `<rect transform="rotate(${arms} 10 9.5)" x="5.5" y="8.8" width="4.6" height="1.5" rx="0.7"/>` +
    `<rect transform="rotate(${-arms} 14.6 9.5)" x="14.5" y="8.8" width="4.6" height="1.5" rx="0.7"/>`;
  return masked(shapes, '<circle cx="11.3" cy="4.6" r="0.6" fill="#000"/><circle cx="13.6" cy="4.6" r="0.6" fill="#000"/>');
}
/** Curled up asleep, the tail over its face. */
const sleeping = (extra = "") =>
  masked(
    '<ellipse cx="11.5" cy="15.8" rx="8.5" ry="3.6"/><circle cx="17" cy="14" r="3.2"/>' +
      '<path d="M15 12 15.8 8.8 17.4 11.6Z"/><path d="M17.6 11.4 19.4 8.6 19.8 12.2Z"/>' +
      '<path d="M2.6 17C1 14.2 3 11 7.5 11.8 13 12.8 17 13 20.6 15.4 16 14.6 12 14.8 9 15.6Z"/>',
    '<rect x="5" y="13" width="2.4" height="0.8" rx="0.4" fill="#000"/>',
  ) + extra;

const z = (x: number, y: number, s: number) =>
  `<path fill="#000" d="M${x} ${y}h${n(s)}v${n(s * 0.25)}l${n(-s * 0.6)} ${n(s * 0.5)}h${n(s * 0.6)}v${n(s * 0.25)}h${n(-s)}v${n(-s * 0.25)}l${n(s * 0.6)} ${n(-s * 0.5)}h${n(-s * 0.6)}Z"/>`;
const bang = '<rect fill="#000" x="21.6" y="0.6" width="1.5" height="3.8" rx="0.6"/><circle fill="#000" cx="22.35" cy="5.8" r="0.8"/>';
/** A door at x; open shows only its edge. The knob is a hole, turned when asked. */
const door = (x: number, open = false, turned = false) =>
  open
    ? `<rect fill="#000" x="${x}" y="2" width="1.2" height="17"/>`
    : `<path fill="#000" fill-rule="evenodd" d="M${x} 2h5v17h-5Z ${turned ? `M${n(x + 0.6)} 10.4h2v0.7h-2Z` : `M${n(x + 0.8)} 10.2h1.2v1.2h-1.2Z`}"/>`;
const dumbbell = (y: number) =>
  `<g fill="#000"><rect x="14" y="${y}" width="8" height="0.8"/><rect x="13.4" y="${n(y - 0.8)}" width="1.2" height="2.4"/><rect x="21.4" y="${n(y - 0.8)}" width="1.2" height="2.4"/></g>`;
const bowl = '<path fill="#000" d="M19.5 16h4.2c0 1.6-1 2.6-2.1 2.6s-2.1-1-2.1-2.6Z"/>';
const rumble = (ys: number[]) => ys.map((y) => `<rect fill="#000" x="16.6" y="${y}" width="1.6" height="0.6"/>`).join("");

const WEAR: Record<Disguise, { head: string; coat?: boolean; eye?: number }> = {
  fedora: {
    head: '<rect x="12.4" y="3.6" width="7.4" height="1" rx="0.4"/><rect x="13.8" y="1" width="4.6" height="3" rx="0.8"/><ellipse cx="19.6" cy="10.4" rx="2" ry="0.6"/>',
  },
  shades: {
    head: '<rect x="15.6" y="6.6" width="5" height="1.8" rx="0.6"/><rect x="12" y="7" width="4" height="0.7"/><rect x="13" y="10.6" width="5.6" height="1.6" rx="0.6"/>',
    eye: 0,
  },
  detective: {
    head: '<ellipse cx="16" cy="4.2" rx="4.8" ry="1.2"/><path d="M12.6 4.4C12.6 1 19.4 1 19.4 4.4Z"/>',
    coat: true,
  },
};
/** The disguise flying off, up and to the right. */
const flung = (d: Disguise, x: number, y: number, angle: number) =>
  `<g fill="#000" transform="translate(${x} ${y}) rotate(${angle} 16 4)">${WEAR[d].head}</g>`;

const tray: Partial<Record<MascotFrame, string>> = {
  idle: svg(panda()),
  "blink-0": svg(panda({ eye: 0.35 })),
  "blink-1": svg(panda({ eye: 0 })),
  "ear-0": svg(panda({ ear: -20 })),
  "ear-1": svg(panda({ ear: -8 })),
  "wash-0": svg(panda({ arm: -60, baton: false })),
  "wash-1": svg(panda({ arm: -75, baton: false })),
  "wash-2": svg(panda({ arm: -45, baton: false })),
  "tail-0": svg(panda({ tail: 15 })),
  "tail-1": svg(panda({ tail: -10 })),
  "exit-0": svg(panda({ dx: -4 }) + door(19)),
  "exit-1": svg(panda({ dx: -1, legs: 1 }) + door(23, true)),
  "exit-2": svg(panda({ dx: 2, legs: -1 }) + door(23, true)),
  "exit-3": svg(door(19)),
  "away-0": svg(door(9.5)),
  "away-1": svg(door(9.5, false, true)),
  "bow-0": svg(panda({ tilt: 12 })),
  "bow-1": svg(panda()),
  "stretch-0": svg(panda({ tilt: -8, baton: false }) + '<rect fill="#000" x="18" y="18.4" width="5" height="0.9"/>'),
  "stretch-1": svg(panda({ tilt: -14, baton: false })),
  "stretch-2": svg(panda({ tilt: -6, baton: false })),
  hungry: svg(panda({ head: 1, eye: 0.5, arm: 45, baton: false }) + bowl),
  sleep: svg(sleeping()),
  "curl-0": svg(panda({ squash: 0.85, baton: false })),
  "curl-1": svg(panda({ squash: 0.7, eye: 0.35, baton: false })),
  "curl-2": svg(sleeping()),
  "snore-0": svg(sleeping(z(20, 6, 2))),
  "snore-1": svg(sleeping(z(19.5, 3.8, 2.8))),
  "snore-2": svg(sleeping(z(19, 1.2, 3.6))),
  alert: svg(standing() + bang),
  "rise-0": svg(panda({ tilt: -10, dy: -0.6, baton: false })),
  "rise-1": svg(standing(40)),
};
[13, 10, 6, 10].forEach((y, i) => {
  tray[`warm-${i}` as MascotFrame] = svg(panda({ arm: [0, -30, -70, -30][i], baton: false }) + dumbbell(y));
});
[[], [13.8], [13.2, 15], [14.2]].forEach((ys, i) => {
  tray[`rumble-${i}` as MascotFrame] = svg(panda({ head: 1, eye: 0.5, arm: 45, baton: false }) + bowl + rumble(ys));
});
[6, 5, 5, 4].forEach((length, i) => {
  tray[`munch-${i}` as MascotFrame] = svg(panda({
    arm: -60, baton: false, head: i % 2 ? 0.5 : 0,
    held: `<rect x="18.4" y="${n(16 - length)}" width="1.4" height="${length}" rx="0.5"/>`,
  }));
});
for (const d of DISGUISES) {
  const wear = WEAR[d];
  tray[`enter-${d}-0`] = svg(door(1, true) + panda({ dx: 3, wear: wear.head, coat: wear.coat, eye: wear.eye }));
  tray[`enter-${d}-1`] = svg(panda({ dx: 2, ear: -15, wear: wear.head, coat: wear.coat, eye: wear.eye }));
  tray[`toss-${d}-0`] = svg(panda({ dx: 2, arm: -50 }) + flung(d, 3, -3, 25));
  tray[`toss-${d}-1`] = svg(panda({ dx: 2, arm: -30 }) + flung(d, 6, -7, 60));
}

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
    const content = tray[frame];
    if (!content) throw new Error(`No placeholder for ${frame}`);
    await writeFile(`${base}.svg`, content, { flag: "wx" });
    written++;
  }
  console.log(`Wrote ${written} placeholder frame(s); existing files were kept.`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
