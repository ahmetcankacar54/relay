import { useEffect, useMemo, useRef, useState } from "react";
import { Panda } from "@/components/Panda";
import { PANDA_SCENES, type PandaScene } from "@/mascot/scenes";
import { SwitchStage } from "@/switch/SwitchStage";
import { BLINK_FRAME, POSE_FRAME, type MascotFrame } from "../../shared/mascot-frames";
import {
  DISGUISES,
  SwitchStory,
  WAITING_LIMIT_MS,
  sceneView,
  type Disguise,
  type SwitchSceneView,
} from "../../shared/switch-scene";

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

/** Every in-app scene on a light and a dark ground; heads also at their real 18 px. */
function SceneSheet() {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-bold">Uygulama içi sahneler</h2>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {(Object.keys(PANDA_SCENES) as PandaScene[]).map((scene) => (
          <div key={scene} className="grid gap-1.5">
            <div className="text-sm font-semibold">{scene}</div>
            <div className="flex gap-2">
              {(["light", "dark"] as const).map((tone) => (
                <div
                  key={tone}
                  data-tone={tone}
                  className={
                    tone === "light"
                      ? "flex items-center gap-2 rounded-lg bg-neutral-100 p-2"
                      : "flex items-center gap-2 rounded-lg bg-neutral-900 p-2"
                  }
                >
                  <Panda scene={scene} size={scene.startsWith("head-") ? 48 : 96} />
                  {scene.startsWith("head-") && <Panda scene={scene} size={18} />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type Demo = { label: string; outcome: "switched" | "back" | "failed" | "stalled"; disguise?: Disguise };
const DEMOS: Demo[] = [
  ...(Object.keys(DISGUISES) as Disguise[]).map((disguise): Demo => ({ label: `Geçiş · ${disguise}`, outcome: "switched", disguise })),
  { label: "Yeniden açıldı", outcome: "back" },
  { label: "Başarısız", outcome: "failed" },
  { label: "60 sn sınırı", outcome: "stalled" },
];
/** How long a demo operation runs before it ends. */
const DEMO_OPERATION_MS = 2_000;

/** Plays the switch window story at real size; the limit demo moves the story's clock instead of waiting a minute. */
function SwitchDemo() {
  const [view, setView] = useState<SwitchSceneView>();
  const [motion, setMotion] = useState(true);
  const skipped = useRef(0);
  const disguise = useRef<Disguise>("fedora");
  const story = useMemo(
    () =>
      new SwitchStory({
        now: () => Date.now() + skipped.current,
        pick: () => disguise.current,
        show: (state) => setView(sceneView(state, { language: "tr", name: () => "Vertex", motion: true })),
      }),
    [],
  );
  /** The pending end of the demo that is playing; a new demo cancels it so it cannot end the new story. */
  const ending = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(ending.current);
      story.destroy();
    },
    [story],
  );
  const play = (demo: Demo) => {
    window.clearTimeout(ending.current);
    disguise.current = demo.disguise ?? "fedora";
    const kind = demo.outcome === "back" ? "merge" : "switch";
    story.report({ phase: "start", kind, profileId: "demo" });
    ending.current = window.setTimeout(() => {
      if (demo.outcome === "stalled") {
        skipped.current += WAITING_LIMIT_MS;
        story.tick();
      } else story.report({ phase: "end", kind, profileId: "demo", ok: demo.outcome !== "failed" });
    }, DEMO_OPERATION_MS);
  };
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-bold">Geçiş penceresi</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {DEMOS.map((demo) => (
          <button key={demo.label} type="button" className="rounded-md border px-2.5 py-1 text-sm" onClick={() => play(demo)}>{demo.label}</button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
          Hareket
        </label>
      </div>
      <div data-switch-preview="" className="mt-3 grid h-[190px] w-[280px] place-items-center rounded-xl bg-neutral-300">
        {view?.visible ? (
          <SwitchStage view={{ ...view, motion }} />
        ) : (
          <span className="text-xs text-neutral-700">{view?.stage === "stalled" ? "Pencere gizlendi (60 sn)" : "Pencere kapalı"}</span>
        )}
      </div>
    </section>
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
        Menü çubuğu kareleri gerçek boyutta (açık ve koyu) ve 1x pikselleri 4 kat büyütülmüş; altında uygulama içi sahneler ve geçiş penceresi.
        macOS gibi yalnızca saydamlık çizilir; renkli ya da beyaz dolgular siluetin içinde kaybolur.
      </p>
      <section className="divide-y">
        {strips.map((s) => (
          <Strip key={s.label} spec={s} frames={frames} />
        ))}
      </section>
      <SceneSheet />
      <SwitchDemo />
    </div>
  );
}
