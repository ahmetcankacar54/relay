// Captures states of the Relay browser preview (http://127.0.0.1:5173) for the film.
// Usage: node capture/shoot.mjs <jobs.json>
// A job: {url, out, width, height, dpr, dark, wait, eval, after, hover, boxes, selector, pad, clip, transparent, init, clock}
// `hover`, `selector` and each value of `boxes` name an element: a CSS selector, or "text:Label" for the
// innermost element whose text is exactly Label ("text:Label@2" for the third). Boxes go to <out>.json in CSS px.
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "/Users/ahmetcan/.npm/_npx/059f4a4c7b2129c7/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

// Every state is shot at Monday 23 November 2026, 16:47 local time (the film's "4:47 PM").
const CLOCK = `(() => {
  const Real = Date;
  const offset = new Real(2026, 10, 23, 16, 47, 0).getTime() - Real.now();
  class Shifted extends Real {
    constructor(...args) { if (args.length === 0) super(Real.now() + offset); else super(...args); }
    static now() { return Real.now() + offset; }
  }
  globalThis.Date = Shifted;
})();`;
const FIND = `window.__find = (query) => {
  if (!query.startsWith("text:")) return document.querySelector(query);
  const [label, nth] = query.slice(5).split("@");
  const all = [...document.querySelectorAll("body *")].filter(
    (el) => el.textContent.trim() === label && ![...el.children].some((c) => c.textContent.trim() === label),
  );
  return all[Number(nth ?? 0)] ?? null;
};`;

const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--lang=en-US", "--accept-lang=en-US", "--hide-scrollbars", "--disable-gpu", "--font-render-hinting=none"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (page, query) =>
  page.evaluate((q) => {
    const el = window.__find(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }, query);

for (const job of jobs) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: job.dark ? "dark" : "light" },
    { name: "prefers-reduced-motion", value: job.reducedMotion ? "reduce" : "no-preference" },
  ]);
  await page.setViewport({ width: job.width ?? 1280, height: job.height ?? 800, deviceScaleFactor: job.dpr ?? 2 });
  if (job.clock !== false) await page.evaluateOnNewDocument(CLOCK);
  if (job.init) await page.evaluateOnNewDocument(job.init);
  await page.goto(job.url, { waitUntil: "networkidle0" });
  await sleep(job.wait ?? 1500);
  await page.evaluate(FIND);
  if (job.eval) {
    const result = await page.evaluate(job.eval);
    if (result !== undefined) console.log(job.out, "eval →", JSON.stringify(result));
    await sleep(job.after ?? 400);
  }
  if (job.hover) {
    const r = await rect(page, job.hover);
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
    await sleep(400);
  }
  if (job.boxes) {
    const boxes = {};
    for (const [name, q] of Object.entries(job.boxes)) boxes[name] = await rect(page, q);
    writeFileSync(`${job.out}.json`, JSON.stringify(boxes, null, 1));
    console.log(job.out, "boxes", JSON.stringify(boxes));
  }
  let clip = job.clip;
  if (job.selector) {
    const r = await rect(page, job.selector);
    const pad = job.pad ?? 0;
    clip = { x: r.x - pad, y: r.y - pad, width: r.w + 2 * pad, height: r.h + 2 * pad };
    console.log(job.out, "clip", JSON.stringify(clip));
  }
  await page.screenshot({ path: job.out, clip, omitBackground: Boolean(job.transparent), fullPage: Boolean(job.fullPage) });
  console.log("wrote", job.out);
  await page.close();
}
await browser.close();
