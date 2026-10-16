/**
 * Just enough of a browser for react-dom/client to mount components under node (the repo has no jsdom).
 * `window` and `document` are real EventTargets, so a test can dispatch pointer, key and visibility events.
 */
const HTML = "http://www.w3.org/1999/xhtml";

type Listener = (event: Event) => void;

/** An EventTarget that knows which listeners are attached, so a test can check an unmount let go of them all. */
function eventTarget() {
  const target = new EventTarget();
  const attached: { type: string; listener: Listener }[] = [];
  return {
    attached,
    addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean) {
      if (!attached.some((a) => a.type === type && a.listener === listener)) attached.push({ type, listener });
      target.addEventListener(type, listener, options);
    },
    removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean) {
      const at = attached.findIndex((a) => a.type === type && a.listener === listener);
      if (at >= 0) attached.splice(at, 1);
      target.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
  };
}

export function fakeDom(options: { localStorage?: () => unknown; reducedMotion?: boolean } = {}) {
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
    readonly style = {};
    innerHTML = "";
    parentNode: FakeElement | null = null;
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
    addEventListener() {}
    removeEventListener() {}
  }

  const documentElement = Object.assign(new FakeElement("html"), {
    // The stage takes its cursor-hiding class off <html> when a play ends.
    classList: { add() {}, remove() {} },
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
    HTMLIFrameElement: class {},
    matchMedia: (query: string) => ({ matches: options.reducedMotion === true && query.includes("reduce") }),
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    get localStorage() {
      return options.localStorage?.();
    },
  };

  return {
    container: new FakeElement("div"),
    /** The window's listeners of one type, and the document's of one type. */
    windowListeners: (type: string) => windowEvents.attached.filter((a) => a.type === type).length,
    documentListeners: (type: string) => documentEvents.attached.filter((a) => a.type === type).length,
    /** Sends an event to the window, as the browser does for pointer and key activity. */
    emit: (type: string) => windowEvents.dispatchEvent(new Event(type)),
    /** Changes the document's visibility and tells its listeners. */
    setVisibility: (state: "visible" | "hidden") => {
      doc.visibilityState = state;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    install: () => Object.assign(globalThis, { window, document: doc, IS_REACT_ACT_ENVIRONMENT: true }),
    uninstall: () => {
      for (const name of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) Reflect.deleteProperty(globalThis, name);
    },
  };
}
