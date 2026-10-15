import { useEffect, useState } from "react";
import { BLINK_FRAME, POSE_FRAME, type MascotFrame } from "../../shared/mascot-frames";

type Frames = Record<MascotFrame, readonly { scaleFactor: number; png: string }[]>;
interface StripSpec {
  label: string;
  frames: readonly MascotFrame[];
  fps: number;
}
const PAUSE = 6;
const src = (frames: Frames, frame: MascotFrame, scale: number) =>
  `data:image/png;base64,${frames[frame].find((r) => r.scaleFactor === scale)?.png ?? ""}`;

/**
 * One sequence, repeated with a short pause, on a light and a dark menu bar.
 * Frames are drawn from their alpha only, as macOS draws template images:
 * light fills disappear into the silhouette here just as in the menu bar.
 */
function Strip({ spec, frames }: { spec: StripSpec; frames: Frames }) {
  const [tick, setTick] = useState(0);
  const length = spec.frames.length;
  useEffect(() => {
    if (length < 2) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000 / spec.fps);
    return () => clearInterval(id);
  }, [length, spec.fps]);
  const frame = spec.frames[Math.min(tick % (length + PAUSE), length - 1)];
  return (
    <div className="grid grid-cols-[200px_auto_auto_auto] items-center gap-3 py-1.5">
      <div>
        <div className="font-semibold">{spec.label}</div>
        <div className="text-xs text-muted-foreground">{spec.frames.join(" · ")}</div>
      </div>
      {(["light", "dark"] as const).map((bar) => (
        <div
          key={bar}
          data-bar={bar}
          className={
            bar === "light"
              ? "flex items-center gap-1 rounded-md bg-neutral-200 px-2 py-0.5 text-neutral-950"
              : "flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-0.5 text-neutral-50"
          }
        >
          <img
            src={src(frames, frame, 2)}
            alt=""
            width={24}
            height={20}
            className={bar === "dark" ? "brightness-0 invert" : "brightness-0"}
          />
          <span className="text-[13px]">38%</span>
        </div>
      ))}
      <img
        src={src(frames, frame, 1)}
        alt=""
        width={96}
        height={80}
        style={{ imageRendering: "pixelated" }}
        className="rounded border brightness-0 dark:invert"
      />
    </div>
  );
}

/** Development-only review sheet for the mascot artwork (?scenario=mascot). */
export function MascotGallery({ frames }: { frames: Frames }) {
  const strips: StripSpec[] = [
    ...Object.entries(POSE_FRAME).map(([pose, frame]) => ({ label: `${pose} (duruş)`, frames: [frame], fps: 1 })),
    { label: "göz kırpma", frames: [POSE_FRAME.idle, BLINK_FRAME, POSE_FRAME.idle], fps: 6 },
  ];
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="font-display text-xl font-bold">Relay maskot galerisi</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Menü çubuğu kareleri gerçek boyutta (açık ve koyu) ve 1x pikselleri 4 kat büyütülmüş.
        macOS gibi yalnızca saydamlık çizilir; renkli ya da beyaz dolgular siluetin içinde kaybolur.
      </p>
      <section className="divide-y">
        {strips.map((s) => (
          <Strip key={s.label} spec={s} frames={frames} />
        ))}
      </section>
    </div>
  );
}
