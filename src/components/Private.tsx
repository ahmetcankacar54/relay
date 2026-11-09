import { useContext, useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { I18nContext, type T } from "@/data/i18n";
import { cn } from "@/lib/utils";

/** Where the choice is kept: a per-viewer convenience, so window storage, not the registry. */
const STORAGE_KEY = "relay.privacy.blur";
const EVENT = "relay:privacy-blur";

function readBlur(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    // No window (a static render) or no storage: hidden, the safer default.
    return true;
  }
}

/** Whether account details (e-mails, workspaces) start blurred; on unless turned off. */
export function usePrivacyBlur(): [boolean, (on: boolean) => void] {
  const [blur, setBlur] = useState(readBlur);
  useEffect(() => {
    const sync = () => setBlur(readBlur());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const choose = (on: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      // Without storage the choice lasts until the window closes.
    }
    setBlur(on);
    window.dispatchEvent(new Event(EVENT));
  };
  return [blur, choose];
}

/**
 * The blur spills past the text, and a row that truncates its text cuts the spill off in a hard
 * rectangle. A mask, applied after the filter, fades the blurred text out inside its own box
 * instead, so no edge is ever sharp.
 */
const FADE = "linear-gradient(90deg, transparent, black 0.5rem, black calc(100% - 0.5rem), transparent), linear-gradient(transparent, black 0.2rem, black calc(100% - 0.2rem), transparent)";
const SOFT_EDGES: CSSProperties = {
  maskImage: FADE,
  maskComposite: "intersect",
  WebkitMaskImage: FADE,
  WebkitMaskComposite: "source-in",
};

/**
 * An account detail (an e-mail, a workspace) shown blurred until clicked, so a screen share or a
 * screenshot does not give it away. A click or Enter shows it; another hides it again. The click
 * stays here: a row that opens on click does not open with it.
 */
export function Private({ children, className }: { children: ReactNode; className?: string }) {
  // Also used in parts rendered without the language provider: Turkish, Relay's first language.
  const t: T = useContext(I18nContext)?.t ?? ((tr) => tr);
  const [blur] = usePrivacyBlur();
  const [shown, setShown] = useState(false);
  if (!blur || children === undefined || children === null || children === "") return <>{children}</>;
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setShown((s) => !s);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      data-private={shown ? "shown" : "hidden"}
      title={shown ? t("Gizlemek için tıkla", "Click to hide") : t("Göstermek için tıkla", "Click to show")}
      onClick={toggle}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      className={cn(
        "cursor-pointer rounded-sm outline-none transition-[filter] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        !shown && "blur-[4px] select-none hover:blur-[3px]",
        className,
      )}
      style={shown ? undefined : SOFT_EDGES}
    >
      {!shown && <span className="sr-only">{t("Gizli bilgi, göstermek için tıkla", "Hidden, click to show")}</span>}
      <span aria-hidden={!shown || undefined}>{children}</span>
    </span>
  );
}
