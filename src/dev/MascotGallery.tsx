import { useEffect, useState } from "react";
import {
  CUE_SEQUENCE,
  DISGUISES,
  POSE_FIDGETS,
  POSE_FRAME,
  POSE_LOOP,
  returnSequence,
  type MascotFrame,
  type MascotSequence,
} from "../../shared/mascot-frames";

type Frames = Record<MascotFrame, readonly { scaleFactor: number; png: string }[]>;
const PAUSE = 6;
const src = (frames: Frames, frame: MascotFrame, scale: number) =>
  `data:image/png;base64,${frames[frame].find((r) => r.scaleFactor === scale)?.png ?? ""}`;

/**
 * One sequence, repeated with a short pause, on a light and a dark menu bar.
 * Frames are drawn from their alpha only, as macOS draws template images:
 * light fills disappear into the silhouette here just as in the menu bar.
 */
function Strip({ label, sequence, frames }: { label: string; sequence: MascotSequence; frames: Frames }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (sequence.frames.length < 2) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000 / sequence.fps);
    return () => clearInterval(id);
  }, [sequence]);
  const cycle = sequence.frames.length + PAUSE;
  const frame = sequence.frames[Math.min(tick % cycle, sequence.frames.length - 1)];
  return (
    <div className="grid grid-cols-[200px_auto_auto_auto] items-center gap-3 py-1.5">
      <div>
        <div className="font-semibold">{label}</div>
        <div className="text-xs text-muted-foreground">{sequence.frames.join(" · ")}</div>
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
  const strips: { label: string; sequence: MascotSequence }[] = [
    ...Object.entries(POSE_FRAME).map(([pose, frame]) => ({
      label: `${pose} (duruş)`,
      sequence: { frames: [frame], fps: 1 },
    })),
    ...Object.entries(POSE_LOOP).map(([pose, sequence]) => ({ label: `${pose} döngüsü`, sequence: sequence! })),
    ...Object.entries(CUE_SEQUENCE).map(([cue, sequence]) => ({ label: cue, sequence })),
    ...DISGUISES.map((disguise) => ({ label: `dönüş (${disguise})`, sequence: returnSequence(disguise) })),
    ...Object.entries(POSE_FIDGETS).flatMap(([pose, list]) =>
      (list ?? []).map((sequence, i) => ({ label: `${pose} kıpırtısı ${i + 1}`, sequence })),
    ),
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
          <Strip key={s.label} label={s.label} sequence={s.sequence} frames={frames} />
        ))}
      </section>
    </div>
  );
}
