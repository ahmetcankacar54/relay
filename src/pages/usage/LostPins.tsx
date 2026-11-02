import { useId, useMemo, type ReactNode } from "react";
import type { LostItemKind, LostTier } from "../../../shared/lost-found";
import {
  RIG_ID_TOKEN,
  type PandaExpression,
  type PandaPose,
  type PandaProp,
} from "../../../shared/panda-poses";
import { PANDA_RIG } from "@/mascot/panda-rig";
import { cn } from "@/lib/utils";
import {
  FIELDS,
  METALS,
  PIN,
  RIBBONS,
  TINT_FALLBACKS,
} from "./lost-pin-palette";

// The bureau's pins: one badge per kind of find, each a small scene in which the panda lives that moment,
// drawn in a 100-unit box. The badges come in four shapes, like a courier's luggage labels; the metal of the
// frame is the finish the kind has earned. Silver adds beads and ribbon tails, gold a star, a laurel and a
// foil shine, so the finish never rests on colour alone.

type Tints = [string, string, string];
type Shape = "circle" | "shield" | "hexagon" | "stamp";

/** Each kind's frame, spread so a shelf of pins mixes shapes. */
const SHAPES: Record<LostItemKind, Shape> = {
  hourglass: "circle",
  baton: "shield",
  boomerang: "hexagon",
  trophy: "stamp",
  scroll: "circle",
  tally: "hexagon",
  compass: "shield",
  scarf: "circle",
  clocks: "stamp",
  spare: "hexagon",
  feather: "shield",
  teaglass: "stamp",
  tightrope: "circle",
  lantern: "stamp",
  hammock: "hexagon",
  scales: "shield",
  chest: "circle",
  piggy: "hexagon",
  fan: "stamp",
};

/** The frames' centre; the space under it holds the ribbon tails. */
const CX = 50;
const CY = 48;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A polygon whose corners are rounded with radius `r`. */
function roundedPolygon(points: [number, number][], r: number) {
  const parts: string[] = [];
  points.forEach((point, i) => {
    const prev = points[(i + points.length - 1) % points.length];
    const next = points[(i + 1) % points.length];
    const toward = (from: [number, number], to: [number, number]) => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      return [
        round1(from[0] + (dx / length) * r),
        round1(from[1] + (dy / length) * r),
      ];
    };
    const [ax, ay] = toward(point, prev);
    const [bx, by] = toward(point, next);
    parts.push(
      `${i === 0 ? "M" : "L"}${ax} ${ay}Q${point[0]} ${point[1]} ${bx} ${by}`,
    );
  });
  return `${parts.join("")}Z`;
}

/** A postage stamp's scalloped circle. */
function scallops(count: number, radius: number) {
  const step = (Math.PI * 2) / count;
  const bump = round1(radius * Math.sin(step / 2) * 1.05);
  const at = (i: number) => [
    round1(CX + radius * Math.cos(i * step - Math.PI / 2)),
    round1(CY + radius * Math.sin(i * step - Math.PI / 2)),
  ];
  const [sx, sy] = at(0);
  let d = `M${sx} ${sy}`;
  for (let i = 1; i <= count; i++) {
    const [x, y] = at(i);
    d += `A${bump} ${bump} 0 0 1 ${x} ${y}`;
  }
  return `${d}Z`;
}

const hexagon = roundedPolygon(
  Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return [
      round1(CX + 44 * Math.cos(angle)),
      round1(CY + 44 * Math.sin(angle)),
    ];
  }),
  6,
);

/** Each frame's outline at full size, around (CX, CY). */
const OUTLINES: Record<Shape, string> = {
  circle: `M${CX} ${CY - 42}A42 42 0 1 1 ${CX} ${CY + 42}A42 42 0 1 1 ${CX} ${CY - 42}Z`,
  shield:
    "M50 5C61 11 75 12.5 88 12V44C88 67 72 82 50 91C28 82 12 67 12 44V12C25 12.5 39 11 50 5Z",
  hexagon,
  stamp: scallops(18, 38),
};

/** The outline scaled about the frame's centre. */
const scaled = (s: number) =>
  `translate(${CX} ${CY}) scale(${s}) translate(${-CX} ${-CY})`;

/** A five-point star centred on (x, y). */
function star(x: number, y: number, r: number, inner = 0.45) {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? r * inner : r;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(
      `${round1(x + radius * Math.cos(angle))},${round1(y + radius * Math.sin(angle))}`,
    );
  }
  return points.join(" ");
}

/** A four-point sparkle centred on (x, y). */
const sparkle = (x: number, y: number, r: number) => {
  const k = r * 0.22;
  return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
};

/** A bamboo leaf whose base sits at (x, y), turned `angle` degrees. */
function Leaf({
  x,
  y,
  angle = 0,
  s = 1,
}: {
  x: number;
  y: number;
  angle?: number;
  s?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle}) scale(${s})`}>
      <path
        d="M0 0C3 -4.5 10 -6 14 -4.6C10.5 -1 4.5 1.2 0 0Z"
        fill={PIN.bamboo}
      />
      <path
        d="M0 0C4.5 -1.4 9 -3 14 -4.6C10.5 -1 4.5 1.2 0 0Z"
        fill={PIN.bambooShade}
      />
    </g>
  );
}

/**
 * The app's own panda, one of its rig poses, drawn into the pin at (x, y) and `size` units wide. The same
 * puppet as everywhere else in Relay, so the pins and the mascot are one character.
 */
function RigPanda({
  pose,
  expression = "open",
  props = [],
  x,
  y,
  size,
}: {
  pose: PandaPose;
  expression?: PandaExpression;
  props?: readonly PandaProp[];
  x: number;
  y: number;
  size: number;
}) {
  const prefix = `lfpanda${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const markup = useMemo(
    () => PANDA_RIG[pose]?.replaceAll(RIG_ID_TOKEN, prefix) ?? "",
    [pose, prefix],
  );
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className="panda"
      data-pose={pose}
      data-expression={expression}
      data-props={props.join(" ")}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** A ringing alarm clock in an account's colour, centred on (cx, cy) and tilted `tilt` degrees. */
function AlarmClock({
  cx,
  cy,
  tint,
  tilt,
}: {
  cx: number;
  cy: number;
  tint: string;
  tilt: number;
}) {
  return (
    <g transform={`rotate(${tilt} ${cx} ${cy})`}>
      <g stroke={PIN.ink} strokeWidth="2.4" strokeLinecap="round">
        <path d={`M${cx - 6} ${cy + 8}L${cx - 8.5} ${cy + 12.5}`} />
        <path d={`M${cx + 6} ${cy + 8}L${cx + 8.5} ${cy + 12.5}`} />
      </g>
      <rect x={cx - 0.8} y={cy - 15} width="1.6" height="5" fill={PIN.ink} />
      <circle cx={cx - 7} cy={cy - 8.5} r="4" fill={PIN.brass} />
      <circle cx={cx + 7} cy={cy - 8.5} r="4" fill={PIN.brass} />
      <circle cx={cx} cy={cy} r="10" fill={tint} />
      <circle cx={cx} cy={cy} r="10" fill={PIN.black} opacity="0.12" />
      <circle cx={cx - 0.6} cy={cy - 0.6} r="9.5" fill={tint} />
      <circle cx={cx} cy={cy} r="7" fill={PIN.cream} />
      <g stroke={PIN.ink} strokeWidth="1.5" strokeLinecap="round">
        <path d={`M${cx} ${cy}V${cy - 5}`} />
        <path d={`M${cx} ${cy}L${cx + 3.4} ${cy + 1.6}`} />
      </g>
    </g>
  );
}

interface SceneContext {
  tints: Tints;
  field: string;
  /** A prefix for ids the scene defines, unique to this pin. */
  id: string;
}

/** A scene: what is clipped to the badge's window, and what breaks out over its frame. */
interface Scene {
  back: ReactNode;
  front?: ReactNode;
}

const SCENES: Record<LostItemKind, (context: SceneContext) => Scene> = {
  // The panda peeks over an hourglass whose sand is nearly all fallen, a drop of sweat on its brow.
  hourglass: () => ({
    back: (
      <>
        <circle cx="50" cy="60" r="27" fill={PIN.tealLight} opacity="0.55" />
        <circle cx="50" cy="60" r="18" fill={PIN.tealDeep} opacity="0.35" />
        <g fill={PIN.brassLight}>
          <path d={sparkle(22, 34, 2.4)} />
          <path d={sparkle(79, 52, 2)} />
          <path d={sparkle(24, 64, 1.6)} />
        </g>
        <rect x="34" y="46" width="3" height="27" fill={PIN.woodDark} />
        <rect x="63" y="46" width="3" height="27" fill={PIN.woodDark} />
        <path
          d="M37 47.5H63C63 56 55 59 53 61C55 63 63 66 63 73H37C37 66 45 63 47 61C45 59 37 56 37 47.5Z"
          fill={PIN.glass}
        />
        <path
          d="M45.5 51.5H54.5C53 54 51.5 56 50 58C48.5 56 47 54 45.5 51.5Z"
          fill={PIN.sand}
        />
        <rect x="49.3" y="58" width="1.4" height="8" fill={PIN.sand} />
        <circle cx="47.4" cy="64.5" r="0.9" fill={PIN.sand} />
        <circle cx="52.8" cy="66.5" r="0.9" fill={PIN.sand} />
        <path
          d="M38.5 73C40.5 67 45.5 65 50 65C54.5 65 59.5 67 61.5 73Z"
          fill={PIN.sand}
        />
        <path d="M50 65C54.5 65 59.5 67 61.5 73H50Z" fill={PIN.sandShade} />
        <rect
          x="31"
          y="72.5"
          width="38"
          height="5.5"
          rx="2.75"
          fill={PIN.wood}
        />
        <rect x="31" y="42" width="38" height="5.5" rx="2.75" fill={PIN.wood} />
        <rect
          x="33"
          y="42.8"
          width="34"
          height="1.8"
          rx="0.9"
          fill={PIN.woodLight}
        />
      </>
    ),
    front: (
      <>
        <RigPanda pose="peek" expression="wide" x={22} y={-1.8} size={56} />
        <path
          d="M74 22C72 26 71.2 28 72.6 29.4C74 30.8 76.2 30 76.4 28C76.6 26 75 24 74 22Z"
          fill={PIN.sweat}
        />
      </>
    ),
  }),
  // The panda runs its lap with the bamboo baton, two streamers in the accounts' colours behind it.
  baton: ({ tints }) => ({
    back: (
      <>
        <rect x="0" y="66" width="100" height="40" fill={PIN.trackDeep} />
        <g
          fill="none"
          stroke={PIN.cream}
          strokeWidth="1.5"
          strokeDasharray="5 4"
          opacity="0.75"
        >
          <path d="M10 74Q50 68 90 74" />
          <path d="M10 84Q50 78 90 84" />
        </g>
        <g
          stroke={PIN.cream}
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.8"
        >
          <path d="M15 32H25" />
          <path d="M13 40H21" />
          <path d="M16 48H23" />
        </g>
        <ellipse
          cx="47"
          cy="77"
          rx="23"
          ry="3"
          fill={PIN.black}
          opacity="0.18"
        />
        <RigPanda pose="walk" props={["bamboo"]} x={14} y={15} size={66} />
      </>
    ),
    front: (
      <g fill="none" strokeLinecap="round" strokeWidth="2.8">
        <path
          d="M66 58C59 53 54 60 47 55.5C41 51.5 36 57 29 53.5"
          stroke={tints[0]}
        />
        <path
          d="M66.5 61C60 58 55 65 48 61C42 57.5 37 63 31 60.5"
          stroke={tints[1]}
        />
      </g>
    ),
  }),
  // A boomerang in the accounts' colours swings round the panda's head; it can hardly believe it came back.
  boomerang: ({ tints }) => ({
    back: (
      <>
        <ellipse cx="50" cy="96" rx="58" ry="24" fill={PIN.bambooPale} />
        <g fill={PIN.white} opacity="0.85">
          <ellipse cx="24" cy="26" rx="8" ry="3.4" />
          <ellipse cx="30" cy="23.5" rx="5" ry="3" />
          <ellipse cx="77" cy="34" rx="7" ry="3" />
        </g>
        <ellipse
          cx="50"
          cy="52"
          rx="39"
          ry="13"
          transform="rotate(-14 50 52)"
          fill="none"
          stroke={PIN.russet}
          strokeWidth="1.8"
          strokeDasharray="3.2 3.2"
          strokeLinecap="round"
        />
        <RigPanda pose="head" expression="wide" x={20} y={21} size={60} />
      </>
    ),
    front: (
      <g transform="translate(68 14) rotate(36) scale(0.9)">
        <g fill="none" strokeLinecap="round" strokeWidth="6">
          <path d="M0 15Q2 4 10 0" stroke={tints[0]} />
          <path d="M10 0Q16 5 19 14" stroke={tints[1]} />
        </g>
        <circle cx="10" cy="0" r="3.2" fill={PIN.wood} />
        <path
          d="M-4 19Q-10 14 -9 6"
          fill="none"
          stroke={PIN.russet}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </g>
    ),
  }),
  // The panda pops out of a record cup under a burst of rays and confetti; its ears break out of the frame.
  trophy: () => ({
    back: (
      <>
        <g fill={PIN.chocolateRay}>
          {Array.from({ length: 12 }, (_, i) => {
            const a = (Math.PI / 6) * i;
            const b = a + Math.PI / 14;
            return (
              <polygon
                key={i}
                points={`50,48 ${round1(50 + 60 * Math.cos(a))},${round1(48 + 60 * Math.sin(a))} ${round1(50 + 60 * Math.cos(b))},${round1(48 + 60 * Math.sin(b))}`}
              />
            );
          })}
        </g>
        {(
          [
            [22, 30, 20, PIN.brass],
            [30, 20, -30, PIN.cream],
            [74, 22, 40, PIN.orange],
            [80, 36, -15, PIN.bamboo],
            [18, 46, 60, PIN.orange],
            [83, 54, 25, PIN.brass],
          ] as const
        ).map(([x, y, angle, color]) => (
          <rect
            key={`${x}-${y}`}
            x={x - 1.6}
            y={y - 0.9}
            width="3.2"
            height="1.8"
            rx="0.4"
            fill={color}
            transform={`rotate(${angle} ${x} ${y})`}
          />
        ))}
      </>
    ),
    front: (
      <>
        <RigPanda pose="head" expression="happy" x={25} y={6} size={50} />
        <g
          fill="none"
          stroke={PIN.brass}
          strokeWidth="3.4"
          strokeLinecap="round"
        >
          <path d="M31 52C22 52 22 65 32 65" />
          <path d="M69 52C78 52 78 65 68 65" />
        </g>
        <path
          d="M30 49H70V53C70 65 61 72 50 72C39 72 30 65 30 53Z"
          fill={PIN.brass}
        />
        <path d="M50 49H70V53C70 65 61 72 50 72Z" fill={PIN.brassShade} />
        <rect
          x="28"
          y="46.5"
          width="44"
          height="5"
          rx="2.5"
          fill={PIN.brassLight}
        />
        <polygon points={star(50, 60, 5.4)} fill={PIN.cream} />
        <rect x="46.5" y="71" width="7" height="5" fill={PIN.brassShade} />
        <rect x="38" y="75.5" width="24" height="5" rx="1.8" fill={PIN.brass} />
        <rect x="40" y="80" width="20" height="5.5" rx="1.2" fill={PIN.wood} />
        <Leaf x={36} y={83} angle={-160} s={0.8} />
        <Leaf x={64} y={83} angle={-20} s={0.8} />
      </>
    ),
  }),
  // The panda reads a scroll so long that it unrolls past the bottom of the badge.
  scroll: () => ({
    back: (
      <g opacity="0.45">
        <Leaf x={18} y={34} angle={-30} s={1.1} />
        <Leaf x={22} y={62} angle={10} s={0.9} />
        <Leaf x={76} y={28} angle={-150} s={1} />
        <Leaf x={82} y={58} angle={170} s={1.1} />
      </g>
    ),
    front: (
      <>
        <RigPanda pose="sit" props={["notebook"]} x={21} y={4} size={58} />
        <path
          d="M43.5 47H56.5C57.5 57 62 63 60 71C58.5 78 62 84 66 88.5H47.5C44 84 41 78 42.5 71C44 63 42.5 57 43.5 47Z"
          fill={PIN.cream}
        />
        <path
          d="M50 47H56.5C57.5 57 62 63 60 71C58.5 78 62 84 66 88.5H56.5C53 84 51 78 52 71C53 63 51 57 50 47Z"
          fill={PIN.creamShade}
        />
        <g
          stroke={PIN.woodLight}
          strokeWidth="1.3"
          strokeLinecap="round"
          opacity="0.8"
        >
          <path d="M46 55H54" />
          <path d="M46 60H53" />
          <path d="M45.5 66H56" />
          <path d="M45 72H55" />
          <path d="M46.5 78H57" />
        </g>
        <rect
          x="45"
          y="86.5"
          width="25"
          height="6.5"
          rx="3.25"
          fill={PIN.creamShade}
        />
        <ellipse cx="45.5" cy="89.75" rx="2" ry="3.25" fill={PIN.wood} />
        <ellipse cx="69.5" cy="89.75" rx="2" ry="3.25" fill={PIN.wood} />
      </>
    ),
  }),
  // In a bamboo grove the panda chews happily over a stick with a notch cut for every day of the week.
  tally: () => ({
    back: (
      <>
        {[17, 27, 73, 83].map((x) => (
          <g key={x}>
            <rect
              x={x - 2.5}
              y="0"
              width="5"
              height="100"
              fill={PIN.forestStalk}
            />
            {[24, 46, 68].map((y) => (
              <rect
                key={y}
                x={x - 3}
                y={y + (x % 3)}
                width="6"
                height="1.4"
                rx="0.7"
                fill={PIN.bambooPale}
              />
            ))}
          </g>
        ))}
        <Leaf x={27} y={30} angle={-40} s={0.8} />
        <Leaf x={73} y={40} angle={-140} s={0.8} />
      </>
    ),
    front: (
      <>
        <RigPanda
          pose="chew"
          expression="happy"
          props={["bamboo", "crumbs"]}
          x={19}
          y={1}
          size={62}
        />
        <g transform="rotate(-6 50 71)">
          <rect x="13" y="66" width="74" height="10" rx="5" fill={PIN.bamboo} />
          <rect
            x="13"
            y="71"
            width="74"
            height="5"
            rx="2.5"
            fill={PIN.bambooShade}
          />
          <rect
            x="17"
            y="65.5"
            width="2.4"
            height="11"
            rx="1"
            fill={PIN.bambooDark}
          />
          <rect
            x="80.6"
            y="65.5"
            width="2.4"
            height="11"
            rx="1"
            fill={PIN.bambooDark}
          />
          {[27, 34, 41, 48, 55, 62, 69].map((x) => (
            <rect
              key={x}
              x={x - 1.1}
              y="67.8"
              width="2.2"
              height="6.4"
              rx="1.1"
              fill={PIN.ink}
            />
          ))}
          <rect
            x="22"
            y="67.4"
            width="56"
            height="1.5"
            rx="0.75"
            fill={PIN.white}
            opacity="0.35"
          />
        </g>
        <Leaf x={84} y={64} angle={-70} s={0.9} />
        <Leaf x={86} y={66} angle={-20} s={0.75} />
      </>
    ),
  }),
  // The panda in an explorer's hat stands on a compass rose; a dotted route crosses the map behind it.
  compass: () => ({
    back: (
      <>
        <g stroke={PIN.slateLine} strokeWidth="0.6">
          {[20, 32, 44, 56, 68, 80].map((x) => (
            <path key={`v${x}`} d={`M${x} 0V100`} />
          ))}
          {[18, 30, 42, 54, 66, 78].map((y) => (
            <path key={`h${y}`} d={`M0 ${y}H100`} />
          ))}
        </g>
        <path
          d="M14 38C24 30 30 44 40 36S58 22 70 28S82 40 88 30"
          fill="none"
          stroke={PIN.cream}
          strokeWidth="1.5"
          strokeDasharray="2 2.6"
          strokeLinecap="round"
          opacity="0.8"
        />
        <path
          d="M84 26l4 4M88 26l-4 4"
          stroke={PIN.orange}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <g transform="translate(50 72) scale(1 0.42)">
          <circle r="26" fill={PIN.slateDeep} />
          <circle r="19" fill="none" stroke={PIN.cream} strokeWidth="1.6" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (Math.PI / 4) * i - Math.PI / 2;
            const long = i % 2 === 0;
            const r = long ? 25 : 15;
            const side = a + Math.PI / 2;
            const w = long ? 4.2 : 3;
            return (
              <polygon
                key={i}
                points={`${round1(r * Math.cos(a))},${round1(r * Math.sin(a))} ${round1(w * Math.cos(side))},${round1(w * Math.sin(side))} ${round1(-w * Math.cos(side))},${round1(-w * Math.sin(side))}`}
                fill={i === 0 ? PIN.orange : long ? PIN.cream : PIN.creamShade}
              />
            );
          })}
        </g>
        <ellipse
          cx="50"
          cy="70.5"
          rx="12"
          ry="2.4"
          fill={PIN.black}
          opacity="0.25"
        />
      </>
    ),
    front: (
      <RigPanda pose="stand" props={["deerstalker"]} x={21} y={13} size={58} />
    ),
  }),
  // Snow falls on the panda, wrapped in a scarf knitted in the colours of the accounts used that day.
  scarf: ({ tints, id }) => {
    const band = "M23 57Q50 70 77 57L78 65.5Q50 79 22 65.5Z";
    return {
      back: (
        <g fill={PIN.white} opacity="0.8">
          {(
            [
              [22, 26, 1.4],
              [30, 40, 1],
              [78, 24, 1.2],
              [72, 44, 0.9],
              [17, 56, 1.1],
              [84, 62, 1.3],
              [26, 76, 1],
              [78, 80, 0.9],
              [58, 18, 0.8],
            ] as const
          ).map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />
          ))}
        </g>
      ),
      front: (
        <>
          <defs>
            <clipPath id={`${id}scarf`}>
              <path d={band} />
            </clipPath>
          </defs>
          <RigPanda pose="head" expression="happy" x={19} y={6} size={62} />
          <g transform="rotate(-8 65 63)">
            <rect x="59" y="62" width="11" height="22" fill={tints[0]} />
            <rect x="59" y="67" width="11" height="4.5" fill={tints[1]} />
            <rect x="59" y="76" width="11" height="4.5" fill={tints[2]} />
            <rect
              x="59"
              y="62"
              width="11"
              height="22"
              fill={PIN.black}
              opacity="0.12"
            />
            <g stroke={tints[0]} strokeWidth="1.5" strokeLinecap="round">
              {[60.5, 63.2, 65.9, 68.6].map((x) => (
                <path key={x} d={`M${x} 84V89`} />
              ))}
            </g>
          </g>
          <path d={band} fill={tints[0]} />
          <g clipPath={`url(#${id}scarf)`}>
            {[31, 43, 55, 67].map((x, i) => (
              <rect
                key={x}
                x={x}
                y="50"
                width="5.5"
                height="35"
                fill={i % 2 ? tints[2] : tints[1]}
              />
            ))}
            <path
              d="M22 63Q50 77 78 63V80H22Z"
              fill={PIN.black}
              opacity="0.13"
            />
          </g>
          <ellipse cx="65" cy="65" rx="5.5" ry="4.6" fill={tints[2]} />
          <ellipse
            cx="65"
            cy="66.6"
            rx="5.5"
            ry="3"
            fill={PIN.black}
            opacity="0.12"
          />
        </>
      ),
    };
  },
  // Two alarm clocks in the accounts' colours ring at once on either side of a startled panda.
  clocks: ({ tints }) => ({
    back: (
      <>
        <g
          fill="none"
          stroke={PIN.peachDeep}
          strokeWidth="2.4"
          strokeLinecap="round"
        >
          <path d="M50 20V12" />
          <path d="M34 24L30 17" />
          <path d="M66 24L70 17" />
        </g>
        <circle cx="50" cy="58" r="22" fill={PIN.peachDeep} opacity="0.5" />
      </>
    ),
    front: (
      <>
        <RigPanda
          pose="head"
          expression="wide"
          props={["bang"]}
          x={24}
          y={9}
          size={52}
        />
        <g
          fill="none"
          stroke={PIN.russet}
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M11 58Q8.5 63 11 68" />
          <path d="M89 58Q91.5 63 89 68" />
          <path d="M15 52L13 49" />
          <path d="M85 52L87 49" />
        </g>
        <AlarmClock cx={26} cy={64} tint={tints[0]} tilt={-12} />
        <AlarmClock cx={74} cy={64} tint={tints[1]} tilt={12} />
      </>
    ),
  }),
  // The idle account: the panda sleeps curled up inside a dusty spare tyre, a cobweb in the corner.
  spare: () => ({
    back: (
      <>
        <rect x="0" y="72" width="100" height="30" fill={PIN.roadDeep} />
        <path
          d="M8 86H92"
          stroke={PIN.cream}
          strokeWidth="1.6"
          strokeDasharray="6 5"
          opacity="0.7"
        />
        <g fill="none" stroke={PIN.web} strokeWidth="0.7" opacity="0.9">
          <path d="M18 20L34 22M18 20L30 32M18 20L22 36" />
          <path d="M26 21Q25 26 28 29Q22 29 20 28" />
          <path d="M31 22Q29 29 33 31Q24 34 21 33" />
        </g>
        <circle cx="50" cy="55" r="27" fill={PIN.tyre} />
        <circle
          cx="50"
          cy="55"
          r="25"
          fill="none"
          stroke={PIN.tread}
          strokeWidth="3.6"
          strokeDasharray="4 3"
        />
        <circle cx="50" cy="55" r="16.5" fill={PIN.hub} />
        <circle
          cx="50"
          cy="55"
          r="16.5"
          fill="none"
          stroke={PIN.hubEdge}
          strokeWidth="1.4"
        />
        <RigPanda
          pose="curl"
          expression="closed"
          props={["z"]}
          x={28.1}
          y={27.8}
          size={44}
        />
        <path
          d="M50 28.5C42 20.5 35 26 39.5 30.5C43 34 47.5 31 50 28.5Z"
          fill={PIN.orange}
        />
        <path
          d="M50 28.5C58 20.5 65 26 60.5 30.5C57 34 52.5 31 50 28.5Z"
          fill={PIN.orange}
        />
        <circle cx="50" cy="28.5" r="3" fill={PIN.russet} />
        <g fill={PIN.cream} opacity="0.85">
          <circle cx="22" cy="80" r="4.5" />
          <circle cx="28" cy="83" r="3.4" />
          <circle cx="78" cy="80" r="4.6" />
          <circle cx="72.5" cy="83.5" r="3.2" />
        </g>
      </>
    ),
  }),
  // Past midnight, by a candle under the moon, the panda keeps writing with a long quill.
  feather: ({ field }) => ({
    back: (
      <>
        <circle cx="27" cy="25" r="7.5" fill={PIN.moonlight} />
        <circle cx="30.5" cy="22.5" r="6.6" fill={field} />
        <g fill={PIN.moonlight}>
          <path d={sparkle(70, 22, 3)} />
          <path d={sparkle(80, 36, 2)} />
          <path d={sparkle(43, 18, 1.8)} />
          <path d={sparkle(20, 44, 1.6)} />
        </g>
        <circle cx="25" cy="54" r="13" fill={PIN.brass} opacity="0.16" />
        <circle cx="25" cy="54" r="8" fill={PIN.brass} opacity="0.2" />
        <RigPanda pose="sit" props={["notebook"]} x={24} y={12} size={56} />
        <rect x="0" y="64" width="100" height="40" fill={PIN.woodDark} />
        <rect x="0" y="64" width="100" height="2.4" fill={PIN.woodLight} />
      </>
    ),
    front: (
      <>
        <rect x="22.5" y="52" width="5" height="12" rx="1" fill={PIN.cream} />
        <path
          d="M25 44C22.5 47.5 22.6 50.5 25 51.5C27.4 50.5 27.5 47.5 25 44Z"
          fill={PIN.brass}
        />
        <path
          d="M25 47C24 48.8 24.2 50.3 25 50.8C25.8 50.3 26 48.8 25 47Z"
          fill={PIN.orange}
        />
        <path
          d="M84 16C90 28 80 46 63 54C61 47 64 36 70 28C74 22 79 18 84 16Z"
          fill={PIN.cream}
        />
        <path
          d="M84 16C86 30 78 44 63 54C70 42 76 30 84 16Z"
          fill={PIN.creamShade}
        />
        <path
          d="M85 14C77 28 69 42 59 57"
          fill="none"
          stroke={PIN.orange}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    ),
  }),
  // At dawn the sun rises behind the panda while its tea steams in a tulip glass.
  teaglass: () => ({
    back: (
      <>
        <circle cx="50" cy="54" r="28" fill={PIN.sunGlow} />
        <circle cx="50" cy="54" r="20" fill={PIN.sun} />
        <ellipse cx="50" cy="98" rx="60" ry="26" fill={PIN.dawnDeep} />
        <g fill={PIN.white} opacity="0.7">
          <ellipse cx="20" cy="34" rx="7" ry="2.6" />
          <ellipse cx="82" cy="28" rx="6" ry="2.4" />
        </g>
      </>
    ),
    front: (
      <>
        <RigPanda pose="head" expression="happy" x={20} y={10} size={56} />
        <g
          fill="none"
          stroke={PIN.white}
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity="0.9"
        >
          <path d="M60 52C58 49 62 47 60 43" />
          <path d="M65 52C63 49 67 47 65 43" />
        </g>
        <ellipse cx="62.5" cy="82.5" rx="13" ry="3.6" fill={PIN.saucerShade} />
        <ellipse cx="62.5" cy="81" rx="13" ry="3.6" fill={PIN.cream} />
        <path
          d="M55 56H70C70 61 66 63.5 66 68C66 72.5 70 75 69 80H56C55 75 59 72.5 59 68C59 63.5 55 61 55 56Z"
          fill={PIN.white}
          opacity="0.7"
        />
        <path
          d="M56.4 59.5H68.6C68.2 62.6 65 65 65 68C65 71.5 68.4 74.5 68 79H57C56.6 74.5 60 71.5 60 68C60 65 56.8 62.6 56.4 59.5Z"
          fill={PIN.tea}
        />
        <path
          d="M62.5 59.5H68.6C68.2 62.6 65 65 65 68C65 71.5 68.4 74.5 68 79H62.5Z"
          fill={PIN.teaShade}
        />
        <rect
          x="54.5"
          y="55"
          width="16"
          height="2"
          rx="1"
          fill={PIN.white}
          opacity="0.9"
        />
      </>
    ),
  }),
  // High above, the panda walks the rope with a bamboo pole; the gauge in the corner sits in the red.
  tightrope: () => ({
    back: (
      <>
        <g fill={PIN.plumDeep}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={i * 18 - 4} y="0" width="9" height="100" />
          ))}
        </g>
        <g fill={PIN.brassLight}>
          <path d={sparkle(22, 30, 2.2)} />
          <path d={sparkle(30, 72, 1.6)} />
          <path d={sparkle(78, 66, 1.8)} />
        </g>
        <g fill="none" strokeWidth="3.4" strokeLinecap="round">
          <path d="M53 77A7 7 0 0 1 56.5 70.9" stroke={PIN.gaugeGreen} />
          <path d="M56.5 70.9A7 7 0 0 1 63.5 70.9" stroke={PIN.gaugeYellow} />
          <path d="M63.5 70.9A7 7 0 0 1 67 77" stroke={PIN.gaugeRed} />
        </g>
        <path
          d="M60 77L66 76.6"
          stroke={PIN.cream}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="60" cy="77" r="1.5" fill={PIN.cream} />
        <path
          d="M6 61Q50 66 94 61"
          fill="none"
          stroke={PIN.creamShade}
          strokeWidth="1.6"
        />
        <RigPanda pose="stand" expression="happy" x={31.5} y={22.5} size={40} />
        <g transform="rotate(-6 50 46)">
          <rect
            x="18"
            y="44.6"
            width="64"
            height="2.6"
            rx="1.3"
            fill={PIN.bamboo}
          />
          <rect x="35" y="44.4" width="1.4" height="3" fill={PIN.bambooDark} />
          <rect
            x="63.6"
            y="44.4"
            width="1.4"
            height="3"
            fill={PIN.bambooDark}
          />
          <circle cx="18" cy="45.9" r="2.6" fill={PIN.orange} />
          <circle cx="82" cy="45.9" r="2.6" fill={PIN.orange} />
        </g>
      </>
    ),
  }),
  // At dusk the panda keeps watch over the weekend, a paper lantern glowing on a bamboo pole beside it.
  lantern: () => ({
    back: (
      <>
        <ellipse cx="50" cy="96" rx="62" ry="34" fill={PIN.duskDeep} />
        <ellipse cx="50" cy="104" rx="60" ry="26" fill={PIN.duskGround} />
        <circle cx="30" cy="30" r="6" fill={PIN.sun} opacity="0.8" />
        <g fill={PIN.sun}>
          <path d={sparkle(52, 20, 1.8)} />
          <path d={sparkle(80, 34, 1.4)} />
        </g>
        <RigPanda pose="sit" expression="happy" x={14} y={22} size={54} />
        <rect
          x="79"
          y="26"
          width="2.4"
          height="64"
          rx="1"
          fill={PIN.bambooShade}
        />
        <path
          d="M80 28H70V33"
          fill="none"
          stroke={PIN.bambooShade}
          strokeWidth="2"
        />
        <circle cx="70" cy="44" r="13" fill={PIN.brassLight} opacity="0.3" />
        <rect x="66.5" y="33" width="7" height="2.4" rx="0.8" fill={PIN.wood} />
        <ellipse cx="70" cy="44" rx="7" ry="8.6" fill={PIN.lanternRed} />
        <g fill="none" stroke={PIN.russetDark} strokeWidth="0.8">
          <path d="M66 37.5Q63.5 44 66 50.5" />
          <path d="M74 37.5Q76.5 44 74 50.5" />
          <path d="M70 35.6V52.4" />
        </g>
        <ellipse
          cx="68"
          cy="41"
          rx="2"
          ry="3.4"
          fill={PIN.brassLight}
          opacity="0.55"
        />
        <rect x="66.5" y="52" width="7" height="2.4" rx="0.8" fill={PIN.wood} />
        <path d="M70 54.4V59" stroke={PIN.brass} strokeWidth="1.2" />
      </>
    ),
  }),
  // The panda sleeps curled up in a striped hammock strung between two bamboo stalks.
  hammock: () => ({
    back: (
      <>
        <circle cx="30" cy="26" r="7" fill={PIN.sun} />
        <g fill={PIN.white} opacity="0.8">
          <ellipse cx="66" cy="22" rx="8" ry="3" />
          <ellipse cx="72" cy="19.5" rx="5" ry="2.6" />
        </g>
        <ellipse cx="50" cy="100" rx="60" ry="22" fill={PIN.bambooPale} />
        {[19, 81].map((x) => (
          <g key={x}>
            <rect
              x={x - 2.4}
              y="18"
              width="4.8"
              height="82"
              rx="1.6"
              fill={PIN.bamboo}
            />
            {[34, 56, 78].map((y) => (
              <rect
                key={y}
                x={x - 2.8}
                y={y}
                width="5.6"
                height="1.4"
                rx="0.7"
                fill={PIN.bambooDark}
              />
            ))}
          </g>
        ))}
        <Leaf x={21} y={22} angle={-40} s={0.8} />
        <Leaf x={79} y={22} angle={-140} s={0.8} />
        <g stroke={PIN.woodLight} strokeWidth="0.9">
          <path d="M21 44L26 50" />
          <path d="M79 44L74 50" />
        </g>
        <path
          d="M24 48Q50 76 76 48"
          fill="none"
          stroke={PIN.creamShade}
          strokeWidth="1.2"
        />
        <RigPanda
          pose="curl"
          expression="closed"
          props={["z"]}
          x={30.2}
          y={24.4}
          size={40}
        />
        <path d="M24 49Q50 72 76 49Q50 84 24 49Z" fill={PIN.cream} />
        <g fill="none" stroke={PIN.orange} strokeWidth="1.4">
          <path d="M28 53.5Q50 74.5 72 53.5" />
          <path d="M32 58Q50 76 68 58" />
        </g>
      </>
    ),
  }),
  // Under a scale held level, its pans in the accounts' colours, the panda peeks over the base.
  scales: ({ tints }) => ({
    back: (
      <>
        <rect x="48.6" y="22" width="2.8" height="54" fill={PIN.woodDark} />
        <rect x="19" y="21" width="62" height="3" rx="1.5" fill={PIN.wood} />
        <circle cx="50" cy="22.5" r="3.2" fill={PIN.brass} />
        <g stroke={PIN.woodLight} strokeWidth="0.8">
          <path d="M22 23L15 44M22 23L29 44" />
          <path d="M78 23L71 44M78 23L85 44" />
        </g>
        <path d="M13 44H31Q29 51 22 51Q15 51 13 44Z" fill={tints[0]} />
        <path d="M69 44H87Q85 51 78 51Q71 51 69 44Z" fill={tints[1]} />
        <g fill={PIN.brass}>
          <ellipse cx="20" cy="43" rx="3.4" ry="1.4" />
          <ellipse cx="24" cy="42" rx="3.4" ry="1.4" />
          <ellipse cx="76" cy="43" rx="3.4" ry="1.4" />
          <ellipse cx="80" cy="42" rx="3.4" ry="1.4" />
        </g>
        <rect x="29" y="74" width="42" height="9" rx="2" fill={PIN.wood} />
        <rect
          x="29"
          y="74"
          width="42"
          height="2.2"
          rx="1"
          fill={PIN.woodLight}
        />
        <RigPanda pose="peek" expression="happy" x={30} y={42.8} size={40} />
      </>
    ),
  }),
  // The panda pops up from a treasure chest overflowing with coins; one rolls out of the frame.
  chest: () => ({
    back: (
      <>
        <g fill={PIN.treasureRay}>
          {Array.from({ length: 10 }, (_, i) => {
            const a = (Math.PI / 5) * i;
            const b = a + Math.PI / 12;
            return (
              <polygon
                key={i}
                points={`50,52 ${round1(50 + 60 * Math.cos(a))},${round1(52 + 60 * Math.sin(a))} ${round1(50 + 60 * Math.cos(b))},${round1(52 + 60 * Math.sin(b))}`}
              />
            );
          })}
        </g>
        <path d="M27 54L31 36H69L73 54Z" fill={PIN.woodDark} />
        <rect x="31" y="36" width="38" height="2.4" fill={PIN.brass} />
        <RigPanda pose="head" expression="happy" x={28} y={13} size={44} />
        <g fill={PIN.brass} stroke={PIN.brassShade} strokeWidth="0.8">
          {(
            [
              [33, 53],
              [40, 51],
              [47, 52.5],
              [54, 51],
              [61, 52],
              [67, 53.5],
              [37, 48.5],
              [58, 48],
            ] as const
          ).map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.6" />
          ))}
        </g>
        <rect x="26" y="54" width="48" height="26" rx="3" fill={PIN.wood} />
        <rect x="26" y="54" width="48" height="4" rx="2" fill={PIN.woodLight} />
        <rect x="33" y="54" width="3.4" height="26" fill={PIN.brass} />
        <rect x="63.6" y="54" width="3.4" height="26" fill={PIN.brass} />
        <rect
          x="45.5"
          y="61"
          width="9"
          height="9"
          rx="1.6"
          fill={PIN.brassLight}
        />
        <circle cx="50" cy="65" r="1.4" fill={PIN.woodDark} />
        <g fill={PIN.brassLight}>
          <path d={sparkle(24, 30, 2.4)} />
          <path d={sparkle(78, 26, 2)} />
        </g>
      </>
    ),
    front: (
      <g fill={PIN.brass} stroke={PIN.brassShade} strokeWidth="0.8">
        <circle cx="74" cy="84" r="3.6" />
        <circle cx="81" cy="80" r="3" />
      </g>
    ),
  }),
  // The panda hugs a jar of coins labelled in the account's colour; one more coin drops into the slot.
  piggy: ({ tints }) => ({
    back: (
      <>
        <g fill={PIN.piggyDeep}>
          <circle cx="22" cy="30" r="5" />
          <circle cx="80" cy="64" r="6" />
          <circle cx="24" cy="72" r="3.5" />
        </g>
      </>
    ),
    front: (
      <>
        <RigPanda pose="sit" expression="happy" x={20} y={4} size={60} />
        <rect
          x="33"
          y="44"
          width="34"
          height="36"
          rx="8"
          fill={PIN.white}
          opacity="0.6"
        />
        <g fill={PIN.brass} stroke={PIN.brassShade} strokeWidth="0.7">
          {(
            [
              [40, 74],
              [47, 75],
              [54, 74],
              [61, 75],
              [43, 69],
              [50, 70],
              [58, 69],
              [46, 64],
              [54, 64.5],
            ] as const
          ).map(([cx, cy]) => (
            <ellipse key={`${cx}-${cy}`} cx={cx} cy={cy} rx="4" ry="2" />
          ))}
        </g>
        <rect x="33" y="52" width="34" height="7" fill={tints[0]} />
        <rect x="35" y="40" width="30" height="5.5" rx="1.6" fill={PIN.wood} />
        <rect
          x="45"
          y="41.6"
          width="10"
          height="1.6"
          rx="0.8"
          fill={PIN.woodDark}
        />
        <rect
          x="37"
          y="46"
          width="2.6"
          height="24"
          rx="1.3"
          fill={PIN.white}
          opacity="0.5"
        />
        <circle
          cx="61"
          cy="33"
          r="3.6"
          fill={PIN.brass}
          stroke={PIN.brassShade}
          strokeWidth="0.7"
        />
        <g stroke={PIN.white} strokeWidth="1.2" strokeLinecap="round">
          <path d="M56 28L58 30" />
          <path d="M66 28L64 30" />
        </g>
      </>
    ),
  }),
  // The panda peeks over a folding fan whose folds are the model families it worked with.
  fan: () => ({
    back: (
      <>
        <g fill={PIN.mintDeep}>
          <circle cx="22" cy="30" r="4" />
          <circle cx="80" cy="28" r="3" />
        </g>
        <RigPanda pose="head" expression="happy" x={23} y={6} size={54} />
        {Array.from({ length: 6 }, (_, i) => {
          const from = Math.PI + (Math.PI / 6) * i;
          const to = from + Math.PI / 6;
          const r = 32;
          const point = (a: number) =>
            `${round1(50 + r * Math.cos(a))} ${round1(82 + r * Math.sin(a))}`;
          const fills = [PIN.foldOpus, PIN.foldSonnet, PIN.foldHaiku];
          return (
            <path
              key={i}
              d={`M50 82L${point(from)}A${r} ${r} 0 0 1 ${point(to)}Z`}
              fill={fills[i % 3]}
              stroke={PIN.cream}
              strokeWidth="0.8"
            />
          );
        })}
        <circle cx="50" cy="82" r="3.2" fill={PIN.wood} />
      </>
    ),
    front: (
      <path
        d="M50 85V93"
        stroke={PIN.orange}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    ),
  }),
};

/** A secret kind: a parcel tied with twine, a question on its tag and two ears behind it. */
const SEALED: Scene = {
  back: (
    <>
      <g fill={PIN.russet}>
        <path d="M33 42L37 24L46 38Z" />
        <path d="M67 42L63 24L54 38Z" />
      </g>
      <g fill={PIN.cream}>
        <path d="M36 39L38 29L43 37Z" />
        <path d="M64 39L62 29L57 37Z" />
      </g>
      <rect x="25" y="38" width="50" height="38" rx="3" fill={PIN.parcel} />
      <rect x="25" y="38" width="50" height="8" rx="3" fill={PIN.parcelShade} />
      <g fill={PIN.twine}>
        <rect x="47.8" y="38" width="4.4" height="38" />
        <rect x="25" y="55" width="50" height="4" />
      </g>
      <path
        d="M50 55C44 49 41 52 44 55.5M50 55C56 49 59 52 56 55.5"
        fill="none"
        stroke={PIN.twine}
        strokeWidth="2"
      />
      <path d="M58 58L66 68" stroke={PIN.twine} strokeWidth="1.2" />
      <g transform="rotate(14 70 72)">
        <rect x="62" y="64" width="16" height="13" rx="2" fill={PIN.cream} />
        <circle cx="65" cy="67" r="1.1" fill={PIN.twine} />
        <path
          d="M68 69C68 66.5 73 66.5 73 69C73 71 70.5 71 70.5 73"
          fill="none"
          stroke={PIN.sealInk}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="70.5" cy="75" r="0.9" fill={PIN.sealInk} />
      </g>
    </>
  ),
};

/** The ribbon tails under a silver or gold pin. */
function RibbonTails({ colors }: { colors: [string, string] }) {
  return (
    <g>
      <path d="M33 74L23 97L30 93L34 99L42 78Z" fill={colors[1]} />
      <path d="M67 74L77 97L70 93L66 99L58 78Z" fill={colors[1]} />
      <path d="M34.5 76L26 95L31 92.5L34.5 97L40.5 79Z" fill={colors[0]} />
      <path d="M65.5 76L74 95L69 92.5L65.5 97L59.5 79Z" fill={colors[0]} />
    </g>
  );
}

/** The gold pin's laurel, behind the frame on both sides. */
function Laurel() {
  const side = (mirror: boolean) => (
    <g transform={mirror ? "translate(100 0) scale(-1 1)" : undefined}>
      {(
        [
          [26, 84, -128],
          [17, 74, -146],
          [11, 62, -162],
          [9, 49, -178],
          [11, 36, 166],
        ] as const
      ).map(([x, y, angle]) => (
        <Leaf key={`${x}-${y}`} x={x} y={y} angle={angle} s={0.95} />
      ))}
    </g>
  );
  return (
    <g>
      {side(false)}
      {side(true)}
    </g>
  );
}

/**
 * One pin. `tier` sets the frame's metal (bronze when unset), `locked` greys the pin out for a kind not
 * found yet, `sealed` hides a secret kind's scene behind a parcel and `shine` runs the gold foil's sweep.
 */
export function LostPin({
  kind,
  tier = "bronze",
  locked,
  sealed,
  shine,
  tints = [],
  size = 48,
  className,
}: {
  kind: LostItemKind;
  tier?: LostTier;
  locked?: boolean;
  sealed?: boolean;
  shine?: boolean;
  /** Account colours for the pin's tint slots, in the story's order. */
  tints?: (string | undefined)[];
  size?: number;
  className?: string;
}) {
  const id = `lfpin${useId().replace(/[^A-Za-z0-9_-]/g, "")}-`;
  const metal = METALS[tier];
  const shape = sealed ? "stamp" : SHAPES[kind];
  const outline = OUTLINES[shape];
  const field = sealed ? PIN.sealField : FIELDS[kind];
  const slots = TINT_FALLBACKS.map(
    (fallback, i) => tints[i] ?? fallback,
  ) as Tints;
  const scene = sealed ? SEALED : SCENES[kind]({ tints: slots, field, id });
  const gold = tier === "gold" && !locked;
  const ribbon = tier !== "bronze" && !locked ? RIBBONS[tier] : undefined;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      data-slot="lost-pin"
      data-kind={kind}
      data-tier={tier}
      data-shape={shape}
      data-shine={shine && gold ? "" : undefined}
      className={cn(
        "shrink-0 overflow-visible",
        locked && "opacity-50 grayscale dark:opacity-60 dark:brightness-125",
        className,
      )}
    >
      <defs>
        <clipPath id={`${id}window`}>
          <path d={outline} transform={scaled(0.85)} />
        </clipPath>
        {gold && (
          <linearGradient id={`${id}foil`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={PIN.white} stopOpacity="0" />
            <stop offset="0.35" stopColor={PIN.sun} stopOpacity="0.35" />
            <stop offset="0.5" stopColor={PIN.white} stopOpacity="0.7" />
            <stop offset="0.65" stopColor={PIN.sweat} stopOpacity="0.35" />
            <stop offset="1" stopColor={PIN.white} stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      <ellipse cx="50" cy="94" rx="24" ry="3" fill={PIN.black} opacity="0.12" />
      {ribbon && <RibbonTails colors={ribbon} />}
      {gold && <Laurel />}
      <path d={outline} transform="translate(0 1.6)" fill={metal.edge} />
      <path d={outline} fill={metal.face} />
      <path
        d={outline}
        transform={scaled(0.93)}
        fill="none"
        stroke={metal.light}
        strokeWidth="1.2"
        opacity="0.7"
      />
      {tier !== "bronze" && !locked && (
        <path
          d={outline}
          transform={scaled(0.925)}
          fill="none"
          stroke={metal.edge}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray="0.1 4.2"
        />
      )}
      <path d={outline} transform={scaled(0.87)} fill={metal.edge} />
      <g clipPath={`url(#${id}window)`}>
        <rect x="0" y="0" width="100" height="100" fill={field} />
        {scene.back}
        <ellipse
          cx="34"
          cy="20"
          rx="22"
          ry="9"
          transform="rotate(-24 34 20)"
          fill={PIN.white}
          opacity="0.12"
        />
        {gold && (
          <g className="lost-pin-foil">
            <rect
              x="-20"
              y="-20"
              width="40"
              height="140"
              fill={`url(#${id}foil)`}
              transform="rotate(24 50 50)"
            />
          </g>
        )}
      </g>
      {scene.front}
      {gold && (
        <g>
          <polygon points={star(50, 6, 8.4)} fill={metal.edge} />
          <polygon points={star(50, 5.6, 7)} fill={metal.light} />
        </g>
      )}
    </svg>
  );
}
