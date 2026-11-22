// Renders Relay's real switch window (switch.html → src/switch/SwitchStage.tsx) frame by frame.
// The Electron bridge is stood in by a scene feed; the CSS animations are stepped with the Web
// Animations API, 30 frames a second, so every frame is the app's own drawing at that instant.
// Usage: node capture/switch.mjs <outDir> [dpr]
import { mkdirSync } from "node:fs";
import puppeteer from "/Users/ahmetcan/.npm/_npx/059f4a4c7b2129c7/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const outDir = process.argv[2];
const dpr = Number(process.argv[3] ?? 4);
mkdirSync(outDir, { recursive: true });
const FPS = 30;
const accounts = { from: { name: "Personal · Max", percent: 100 }, to: { name: "Personal · Backup", percent: 22 } };
const base = { visible: true, story: 1, locale: "en", accounts, motion: true };
// Stage, view, frames: leaving plays its 1.2 s walk, waiting holds the closed door, returning
// plays the 2.5 s return with a disguise (src/styles/switch-stage.css).
const stages = [
  ["leaving", { ...base, stage: "leaving", line: "Relay switches to Personal · Backup" }, 36],
  ["waiting", { ...base, stage: "waiting", line: "Relay switches to Personal · Backup" }, 15],
  ["returning", { ...base, stage: "returning", outcome: "switched", disguise: "fedora", line: "You are on Personal · Backup" }, 75],
];

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--lang=en-US", "--hide-scrollbars", "--disable-gpu", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.emulateMediaFeatures([
  { name: "prefers-color-scheme", value: "light" },
  { name: "prefers-reduced-motion", value: "no-preference" },
]);
await page.setViewport({ width: 240, height: 150, deviceScaleFactor: dpr });
await page.evaluateOnNewDocument(() => {
  window.relaySwitch = {
    onScene(callback) {
      window.__scene = callback;
      return () => {};
    },
    ready() {},
  };
});
await page.goto("http://127.0.0.1:5173/switch.html", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));
let n = 0;
for (const [name, view, frames] of stages) {
  await page.evaluate((v) => window.__scene(v), view);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  for (let i = 0; i < frames; i++) {
    await page.evaluate((ms) => document.getAnimations().forEach((a) => (a.currentTime = ms)), (i * 1000) / FPS);
    const file = `${outDir}/f${String(n).padStart(4, "0")}.png`;
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: 240, height: 150 } });
    n++;
  }
  console.log(name, "→", frames, "frames");
}
await browser.close();
console.log("total", n);
