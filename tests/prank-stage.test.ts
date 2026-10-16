import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PRANK_HISTORY_KEY, type PrankKind } from "../src/pranks/budget";
import type { PrankGate } from "../src/pranks/gate";
import { PrankStage, decideOffer, offerAfter, playFor, usePrank, type PrankApi } from "../src/pranks/PrankStage";
import { RelayPrankStage } from "../src/pranks/RelayPrankStage";
import { PRANK_LAYERS } from "../src/pranks/registry";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { DEFAULT_SETTINGS } from "../shared/types";
import { mediaBlock } from "./css";

/** Local noon, so the daily limit sees the same day on every time zone. */
const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const MIN = 60_000;
const never = () => {
  throw new Error("the random draw must not happen");
};

const idle = { level: "sometimes", desktopBusy: false, errorShown: false, dialogOpen: false } as const;

const open: PrankGate = {
  reducedMotion: false,
  level: "sometimes",
  desktopBusy: false,
  errorShown: false,
  windowVisible: true,
  keyboard: false,
  dialogOpen: false,
};

/** The plain { getItem, setItem } object a window's localStorage stands in for, counting its calls. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0 };
  return {
    calls,
    map,
    getItem: (key: string) => {
      calls.get++;
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      calls.set++;
      map.set(key, value);
    },
  };
}
const throwingStorage = {
  getItem: () => {
    throw new Error("storage is blocked");
  },
  setItem: () => {
    throw new Error("storage is blocked");
  },
};

function offer(overrides: Partial<Parameters<typeof decideOffer>[0]> & { storage: Parameters<typeof decideOffer>[0]["storage"] }) {
  return decideOffer({
    kind: "nibble-cursor",
    gate: open,
    level: "sometimes",
    now: NOW,
    random: () => 0,
    playing: false,
    ...overrides,
  });
}

test("usePrank outside a stage offers nothing and allows no trick", () => {
  let api: PrankApi | undefined;
  const Probe = () => {
    api = usePrank();
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  assert.ok(api);
  assert.doesNotThrow(() => api!.offer("wheel", null));
  assert.equal(api!.allowsTrick({ detail: 1 }), false);
});

test("an idle stage is a click-through overlay with no layer, after its children", () => {
  const html = renderToStaticMarkup(createElement(PrankStage, { ...idle, children: createElement("p", null, "içerik") }));
  assert.equal(html, '<p>içerik</p><div data-prank-stage="true" class="pointer-events-none fixed inset-0 z-[100] overflow-hidden"></div>');
});

test("decideOffer refuses while another prank plays, even with ignoreLimits", () => {
  const storage = memoryStorage();
  assert.equal(offer({ storage, random: never, playing: true }), false);
  assert.equal(offer({ storage, random: never, playing: true, ignoreLimits: true }), false);
  assert.deepEqual(storage.calls, { get: 0, set: 0 });
});

test("decideOffer refuses when any gate blocks, without reading or drawing", () => {
  const blocked: Partial<PrankGate>[] = [
    { reducedMotion: true },
    { level: "off" },
    { desktopBusy: true },
    { errorShown: true },
    { windowVisible: false },
    { keyboard: true },
    { dialogOpen: true },
  ];
  for (const change of blocked) {
    const storage = memoryStorage();
    assert.equal(offer({ storage, random: never, gate: { ...open, ...change } }), false, JSON.stringify(change));
    assert.deepEqual(storage.calls, { get: 0, set: 0 }, JSON.stringify(change));
  }
});

test("decideOffer refuses when storage throws, on the read or on the write", () => {
  assert.equal(offer({ storage: throwingStorage, random: never }), false);
  const writeFails = { getItem: () => null, setItem: throwingStorage.setItem };
  assert.equal(offer({ storage: writeFails, random: () => 0 }), false);
});

test("decideOffer records the prank right after deciding, so a second offer sees it", () => {
  const storage = memoryStorage();
  assert.equal(offer({ storage }), true);
  assert.equal(storage.calls.set, 1);
  assert.deepEqual(JSON.parse(storage.map.get(PRANK_HISTORY_KEY) ?? "null"), [NOW]);
  // The panel and the main window share this record: the second prank waits out the gap.
  assert.equal(offer({ storage, now: NOW + 5 * MIN, random: never }), false);
  assert.equal(storage.calls.set, 1);
});

test("decideOffer records nothing when the draw or the budget says no", () => {
  const unlucky = memoryStorage();
  assert.equal(offer({ storage: unlucky, random: () => 0.99 }), false);
  assert.equal(unlucky.calls.set, 0);
  const recent = memoryStorage({ [PRANK_HISTORY_KEY]: JSON.stringify([NOW - 5 * MIN]) });
  assert.equal(offer({ storage: recent, random: never }), false);
  assert.equal(recent.calls.set, 0);
});

test("decideOffer draws for the clicks and the hover, and not for the doze", () => {
  for (const kind of ["nibble-cursor", "wheel", "nibble-bar"] as const satisfies readonly PrankKind[]) {
    const storage = memoryStorage();
    let draws = 0;
    const random = () => (draws++, 0);
    assert.equal(offer({ storage, kind, random }), true, kind);
    assert.equal(draws, 1, kind);
    assert.equal(offer({ storage: memoryStorage(), kind, random: () => 0.99 }), false, kind);
  }
  const doze = memoryStorage();
  assert.equal(offer({ storage: doze, kind: "doze", random: never }), true);
  assert.equal(doze.calls.set, 1);
  // The gap still applies to the doze.
  const lately = memoryStorage({ [PRANK_HISTORY_KEY]: JSON.stringify([NOW - 5 * MIN]) });
  assert.equal(offer({ storage: lately, kind: "doze", random: never }), false);
});

test("decideOffer lets confetti through without a budget, but not past reduced motion or off", () => {
  assert.equal(offer({ storage: throwingStorage, kind: "confetti", random: never }), true);
  const storage = memoryStorage();
  const busy = { ...open, desktopBusy: true, errorShown: true, windowVisible: false, keyboard: true, dialogOpen: true };
  assert.equal(offer({ storage, kind: "confetti", random: never, gate: busy }), true);
  assert.deepEqual(storage.calls, { get: 0, set: 0 });
  assert.equal(offer({ storage, kind: "confetti", random: never, gate: { ...open, reducedMotion: true } }), false);
  assert.equal(offer({ storage, kind: "confetti", random: never, level: "off", gate: { ...open, level: "off" } }), false);
});

test("decideOffer with ignoreLimits is true past gates and budget, and records nothing", () => {
  const storage = memoryStorage({ [PRANK_HISTORY_KEY]: JSON.stringify([NOW - MIN]) });
  const blocked = { ...open, reducedMotion: true, level: "off" as const, desktopBusy: true, keyboard: true };
  assert.equal(offer({ storage, gate: blocked, level: "off", random: never, ignoreLimits: true }), true);
  assert.equal(offer({ storage: throwingStorage, gate: blocked, random: never, ignoreLimits: true }), true);
  assert.deepEqual(storage.calls, { get: 0, set: 0 });
});

test("offerAfter runs the action first, then offers with the event's currentTarget and the event", () => {
  const order: string[] = [];
  const target = { tagName: "BUTTON" } as unknown as Element;
  const event = { currentTarget: target, clientX: 12, clientY: 34, detail: 1 } as unknown as MouseEvent<Element>;
  const prank: PrankApi = {
    offer: (kind, anchor, passed) => {
      order.push("offer");
      assert.equal(kind, "wheel");
      assert.equal(anchor, target);
      assert.equal(passed, event);
    },
    allowsTrick: () => true,
  };
  offerAfter(prank, "wheel", event, () => order.push("action"));
  assert.deepEqual(order, ["action", "offer"]);
});

test("a play reads the anchor's box and the event's point when it starts", () => {
  const anchor = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40, right: 40, bottom: 60, x: 10, y: 20 }) } as Element;
  assert.deepEqual(playFor(3, "wheel", anchor, { clientX: 5, clientY: 6, detail: 1 }), {
    id: 3,
    kind: "wheel",
    rect: { left: 10, top: 20, width: 30, height: 40 },
    point: { x: 5, y: 6 },
  });
  assert.deepEqual(playFor(4, "doze", null), { id: 4, kind: "doze" });
});

/** The window and document the stage reads when a prank is offered, for a test that has no browser. */
function inBrowser<T>(
  browser: { reduced?: boolean; visible?: boolean; localStorage?: () => unknown },
  run: () => T,
): T {
  const stubs = {
    window: {
      matchMedia: (query: string) => ({ matches: query.includes("reduce") && browser.reduced === true }),
      get localStorage() {
        return browser.localStorage?.();
      },
    },
    document: { visibilityState: browser.visible === false ? "hidden" : "visible", documentElement: { classList: { remove() {} } } },
  };
  Object.assign(globalThis, stubs);
  try {
    return run();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
}

const stageApi = (props: { level?: "sometimes" | "rarely" | "off"; desktopBusy?: boolean; errorShown?: boolean; dialogOpen?: boolean; ignoreLimits?: boolean; storage?: ReturnType<typeof memoryStorage> }) => {
  let api: PrankApi | undefined;
  const Probe = () => {
    api = usePrank();
    return null;
  };
  renderToStaticMarkup(createElement(PrankStage, { ...idle, now: () => NOW, random: () => 0, ...props, children: createElement(Probe) }));
  assert.ok(api);
  return api;
};

test("the stage's offer reads the live gate: a keyboard click, a hidden window or Reduce motion spend nothing", () => {
  const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) } as Element;
  const click = { clientX: 1, clientY: 2, detail: 1 };
  const run = (browser: { reduced?: boolean; visible?: boolean }, event: typeof click | undefined) => {
    const storage = memoryStorage();
    inBrowser(browser, () => stageApi({ storage }).offer("nibble-cursor", anchor, event));
    return storage.calls.set;
  };
  assert.equal(run({}, click), 1);
  assert.equal(run({}, { ...click, detail: 0 }), 0);
  assert.equal(run({ visible: false }, click), 0);
  assert.equal(run({ reduced: true }, click), 0);
});

test("a stage's tricks follow the gate, are free of the budget, and ignore it with ignoreLimits", () => {
  const storage = memoryStorage();
  const trick = (props: Parameters<typeof stageApi>[0], detail = 1, browser: { reduced?: boolean; visible?: boolean } = {}) =>
    inBrowser(browser, () => stageApi({ storage, ...props }).allowsTrick({ detail }));
  assert.equal(trick({}), true);
  assert.equal(trick({}, 0), false);
  assert.equal(trick({}, 1, { reduced: true }), false);
  assert.equal(trick({}, 1, { visible: false }), false);
  assert.equal(trick({ level: "off" }), false);
  assert.equal(trick({ desktopBusy: true }), false);
  assert.equal(trick({ errorShown: true }), false);
  assert.equal(trick({ dialogOpen: true }), false);
  assert.equal(trick({ level: "off", desktopBusy: true, ignoreLimits: true }, 0, { reduced: true }), true);
  assert.deepEqual(storage.calls, { get: 0, set: 0 });
});

test("a stage without a storage prop reads window.localStorage only when a prank is offered", () => {
  const storage = memoryStorage();
  let reads = 0;
  const localStorage = () => (reads++, storage);
  const html = inBrowser({ localStorage }, () => renderToStaticMarkup(createElement(PrankStage, { ...idle, now: () => NOW, random: () => 0, children: null })));
  assert.match(html, /data-prank-stage/);
  assert.equal(reads, 0);
  const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) } as Element;
  const api = stageApi({});
  inBrowser({ localStorage }, () => api.offer("nibble-cursor", anchor, { clientX: 1, clientY: 2, detail: 1 }));
  assert.equal(reads, 1);
  assert.equal(storage.calls.set, 1);
  // A window whose storage cannot even be reached spends nothing.
  const blocked = stageApi({});
  assert.doesNotThrow(() =>
    inBrowser({ localStorage: () => { throw new Error("SecurityError"); } }, () => blocked.offer("nibble-cursor", anchor, { clientX: 1, clientY: 2, detail: 1 })),
  );
});

function relayFor(extra: Partial<Relay> = {}): Relay {
  return { settings: DEFAULT_SETTINGS, error: "", desktopBusy: false, desktop: undefined, desktopRequest: undefined, ...extra } as unknown as Relay;
}
function trickAllowedFor(relay: Relay): boolean {
  let api: PrankApi | undefined;
  const Probe = () => {
    api = usePrank();
    return null;
  };
  renderToStaticMarkup(createElement(RelayContext.Provider, { value: relay }, createElement(RelayPrankStage, null, createElement(Probe))));
  assert.ok(api);
  return inBrowser({}, () => api!.allowsTrick({ detail: 1 }));
}

test("RelayPrankStage reads the level, busy, error and dialog from the relay", () => {
  assert.equal(trickAllowedFor(relayFor()), true);
  assert.equal(trickAllowedFor(relayFor({ settings: { ...DEFAULT_SETTINGS, pranks: "rarely" } })), true);
  assert.equal(trickAllowedFor(relayFor({ settings: { ...DEFAULT_SETTINGS, pranks: "off" } })), false);
  assert.equal(trickAllowedFor(relayFor({ desktopBusy: true })), false);
  assert.equal(trickAllowedFor(relayFor({ error: "Bağlantı koptu" })), false);
  assert.equal(trickAllowedFor(relayFor({ desktop: { error: "Desktop açılamadı" } as Relay["desktop"] })), false);
  assert.equal(trickAllowedFor(relayFor({ desktopRequest: { kind: "switch" } as Relay["desktopRequest"] })), false);
});

test("the layer table is an object literal the later tasks fill in", () => {
  assert.equal(Object.getPrototypeOf(PRANK_LAYERS), Object.prototype);
});

test("both windows mount the stage: the shell around its page and dialog, the panel inside RelayProvider", () => {
  const shell = readFileSync(new URL("../src/app/Shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<RelayPrankStage>[\s\S]*<DesktopActionDialog \/>\s*<\/RelayPrankStage>/);
  assert.match(shell, /<TooltipProvider[^>]*>\s*<RelayPrankStage>/);
  const entry = readFileSync(new URL("../src/panel/main.tsx", import.meta.url), "utf8");
  assert.match(entry, /<RelayProvider[^>]*>\s*<RelayPrankStage>\s*<Panel \/>\s*<\/RelayPrankStage>\s*<\/RelayProvider>/);
});

test("the stylesheet hides the cursor on request, and animates only with motion on", () => {
  const css = readFileSync("src/styles/pranks.css", "utf8");
  assert.match(css, /\.prank-cursor-hidden,\s*\.prank-cursor-hidden \* \{\s*cursor: none !important;\s*\}/);
  const motion = mediaBlock(css, "(prefers-reduced-motion: no-preference)");
  assert.doesNotMatch(css.replace(motion, ""), /animation\s*:/);
  const theme = readFileSync("src/styles/theme.css", "utf8");
  assert.ok(theme.indexOf('@import "./switch-stage.css";') >= 0);
  assert.ok(theme.indexOf('@import "./pranks.css";') > theme.indexOf('@import "./switch-stage.css";'));
});
