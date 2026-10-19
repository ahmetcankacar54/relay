/**
 * Just enough of a browser for react-dom/client to mount components under node (the repo has no jsdom).
 * `window` and `document` are real EventTargets, so a test can dispatch pointer, key and visibility events.
 */
const HTML = "http://www.w3.org/1999/xhtml";

type Listener = (event: Event) => void;

const isCapture = (options?: AddEventListenerOptions | EventListenerOptions | boolean) =>
  typeof options === "object" ? options.capture === true : options === true;

/**
 * An EventTarget that knows which listeners are attached, so a test can check an unmount let go of them all.
 * As in a browser, a listener is told apart by its type, its function and its capture flag: removing one with
 * the wrong flag leaves it attached.
 */
function eventTarget() {
  const target = new EventTarget();
  const attached: { type: string; listener: Listener; capture: boolean }[] = [];
  return {
    attached,
    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean) {
      const capture = isCapture(options);
      if (!attached.some((a) => a.type === type && a.listener === listener && a.capture === capture))
        attached.push({ type, listener, capture });
      target.addEventListener(type, listener, options);
    },
    removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean) {
      const capture = isCapture(options);
      const at = attached.findIndex((a) => a.type === type && a.listener === listener && a.capture === capture);
      if (at >= 0) attached.splice(at, 1);
      target.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
  };
}

export function fakeDom(options: { localStorage?: () => unknown; reducedMotion?: boolean } = {}) {
  /** The classes on <html>, as far as the prank stage cares. */
  const hidden = new Set<string>();
  const documentEvents = eventTarget();
  const windowEvents = eventTarget();
  const doc: Record<string, unknown> = {
    visibilityState: "visible",
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
    dispatchEvent: documentEvents.dispatchEvent,
  };

  class FakeElement {
    readonly nodeType: number = 1;
    readonly ownerDocument = doc;
    readonly childNodes: FakeElement[] = [];
    readonly attributes = new Map<string, string>();
    /** Inline styles. React sets custom properties (`--name`) through setProperty. */
    readonly style: Record<string, unknown> = {
      setProperty(this: Record<string, unknown>, name: string, value: unknown) {
        this[name] = value;
      },
    };
    innerHTML = "";
    parentNode: FakeElement | null = null;
    /** What getBoundingClientRect answers; a test sets it on the element it wants to tell apart. */
    box = { left: 0, top: 0, width: 0, height: 0 };
    /** The listeners React puts on its root container. */
    readonly listeners: { type: string; listener: Listener; capture: boolean }[] = [];
    constructor(
      readonly tagName: string,
      readonly namespaceURI: string = HTML,
    ) {}
    get nodeName() {
      return this.tagName.toUpperCase();
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] ?? null;
    }
    get nextSibling(): FakeElement | null {
      return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null;
    }
    /** The nearest element, this one included, with a tag name: all the selector Radix asks for ("form"). */
    closest(tag: string): FakeElement | null {
      for (let node: FakeElement | null = this; node; node = node.parentNode) if (node.tagName === tag) return node;
      return null;
    }
    /** A <select>'s options, which React walks to mark the chosen one (Radix Select draws a native one). */
    get options(): FakeElement[] {
      return this.childNodes.filter((child) => child.tagName === "option");
    }
    set textContent(_: string) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes.length = 0;
    }
    appendChild(child: FakeElement) {
      return this.insertBefore(child, null);
    }
    insertBefore(child: FakeElement, before: FakeElement | null) {
      child.parentNode?.removeChild(child);
      this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child: FakeElement) {
      this.childNodes.splice(this.childNodes.indexOf(child), 1);
      child.parentNode = null;
      return child;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, String(value));
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    getBoundingClientRect() {
      return { ...this.box };
    }
    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean) {
      const capture = typeof options === "object" ? options.capture === true : options === true;
      this.listeners.push({ type, listener, capture });
    }
    removeEventListener(type: string, listener: Listener) {
      const at = this.listeners.findIndex((l) => l.type === type && l.listener === listener);
      if (at >= 0) this.listeners.splice(at, 1);
    }
  }

  const documentElement = Object.assign(new FakeElement("html"), {
    classList: { add: (name: string) => void hidden.add(name), remove: (name: string) => void hidden.delete(name) },
  });
  Object.assign(doc, {
    documentElement,
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (namespace: string, tag: string) => new FakeElement(tag, namespace),
    createTextNode: (text: string) => Object.assign(new FakeElement("#text"), { nodeType: 3, data: text }),
  });
  const window = {
    document: doc,
    event: undefined,
    innerWidth: 1_000,
    innerHeight: 800,
    HTMLIFrameElement: class {},
    // Radix Select draws a native <select>: it reads the native value setter, looks for a form to reset
    // with, and times its typeahead. A stand-in for each is enough.
    HTMLSelectElement: class {
      get value() {
        return "";
      }
      set value(_: string) {}
    },
    HTMLFormElement: class {},
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    matchMedia: (query: string) => ({ matches: options.reducedMotion === true && query.includes("reduce") }),
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    get localStorage() {
      return options.localStorage?.();
    },
  };

  doc.defaultView = window;
  const container = new FakeElement("div");

  return {
    container,
    /** Whether the stage's cursor-hiding class is on <html>. */
    cursorHidden: () => hidden.has("prank-cursor-hidden"),
    /** The window's listeners of one type, and the document's of one type. */
    windowListeners: (type: string) => windowEvents.attached.filter((a) => a.type === type).length,
    /** How many of the window's listeners of one type listen on the capture phase. */
    windowCaptureListeners: (type: string) => windowEvents.attached.filter((a) => a.type === type && a.capture).length,
    documentListeners: (type: string) => documentEvents.attached.filter((a) => a.type === type).length,
    /** Sends an event to the window, as the browser does for pointer and key activity. */
    emit: (type: string) => windowEvents.dispatchEvent(new Event(type)),
    /**
     * Sends a native event for `target` to the root container, as the browser does: React's own
     * listeners there turn it into synthetic events (`pointerover` makes `onPointerEnter`, `pointerout` with
     * no `relatedTarget` makes `onPointerLeave`). Capture listeners run first.
     */
    dispatch: (target: object, type: string, init: Record<string, unknown> = {}) => {
      const event = { type, target, relatedTarget: null, timeStamp: 0, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...init };
      const heard = container.listeners.filter((l) => l.type === type);
      for (const l of [...heard.filter((h) => h.capture), ...heard.filter((h) => !h.capture)]) l.listener(event as unknown as Event);
    },
    /** Changes the document's visibility and tells its listeners. */
    setVisibility: (state: "visible" | "hidden") => {
      doc.visibilityState = state;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    install: () =>
      Object.assign(globalThis, {
        window,
        document: doc,
        IS_REACT_ACT_ENVIRONMENT: true,
        HTMLFormElement: window.HTMLFormElement,
        // Radix's presence (tabs, dialogs) reads an element's animation and waits a frame; nothing animates here.
        getComputedStyle: () => ({ animationName: "none", display: "block", getPropertyValue: () => "" }),
        requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
        cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      }),
    uninstall: () => {
      for (const name of [
        "window",
        "document",
        "IS_REACT_ACT_ENVIRONMENT",
        "HTMLFormElement",
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ])
        Reflect.deleteProperty(globalThis, name);
    },
  };
}

// The fake browser keeps no text of its own: a lone string child goes through `textContent`, and a text
// node's update through `nodeValue`. `readableText` (after `install`) makes both readable to `textOf`.
export type Fake = Record<string, unknown> & { childNodes: Fake[]; tagName: string };
export function readableText() {
  const doc = globalThis.document as unknown as Record<string, (...args: unknown[]) => Fake>;
  const element = doc.createElement;
  const textNode = doc.createTextNode;
  doc.createElement = (tag) => {
    const el = element.call(doc, tag);
    let text = "";
    Object.defineProperty(el, "textContent", {
      get: () => text,
      set(value: string) {
        text = value;
        el.childNodes.length = 0;
      },
    });
    return el;
  };
  doc.createTextNode = (value) => {
    const node = textNode.call(doc, value);
    Object.defineProperty(node, "nodeValue", { get: () => node.data, set: (v: string) => void (node.data = v) });
    return node;
  };
}
/** A node's text, its children's included; no-break spaces read as plain ones. */
export const textOf = (node: unknown): string => {
  const n = node as { data?: string; childNodes?: unknown[]; textContent?: string };
  return ((n.data ?? "") + (typeof n.textContent === "string" ? n.textContent : "") + (n.childNodes ?? []).map(textOf).join("")).replace(/\u00a0/g, " ");
};
/** The first node, depth first, that `match` accepts. */
export const find = (node: Fake, match: (node: Fake) => boolean): Fake | undefined =>
  match(node) ? node : node.childNodes.map((child) => find(child, match)).find(Boolean);
/** The detail box a day chart shows beside its active bar, as text; undefined while none is shown. */
export const dayTip = (container: Fake) => {
  const node = find(container, (n) => (n as { attributes?: Map<string, string> }).attributes?.get?.("data-slot") === "day-tooltip");
  return node ? textOf(node) : undefined;
};
