import { useCallback, useState } from "react";

/**
 * The sidebar's sizes in px. Dragging its edge below `collapseBelow` folds it into the icon rail,
 * which is wide enough for the macOS traffic lights (16 px in, 52 px wide).
 */
export const SIDEBAR = {
  rail: 84,
  min: 200,
  max: 360,
  initial: 232,
  collapseBelow: 150,
} as const;

export interface SidebarSize {
  /** The expanded width, kept while the sidebar is folded. */
  width: number;
  collapsed: boolean;
}

const KEY = "relay-sidebar";

export const clampSidebarWidth = (width: number) =>
  Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width)));

/** Where a drag that started at `startWidth` px and moved `dx` px leaves the sidebar. */
export function dragSidebar(startWidth: number, dx: number, expanded: number): SidebarSize {
  const next = startWidth + dx;
  return next < SIDEBAR.collapseBelow
    ? { width: expanded, collapsed: true }
    : { width: clampSidebarWidth(next), collapsed: false };
}

/**
 * Where an arrow key on the focused edge leaves the sidebar: → unfolds the rail at the kept width,
 * ← at the narrowest width folds it, and otherwise each press moves the edge by `step` px.
 */
export function keySidebar(size: SidebarSize, direction: 1 | -1, step: number): SidebarSize {
  if (size.collapsed) return direction > 0 ? { ...size, collapsed: false } : size;
  if (direction < 0 && size.width <= SIDEBAR.min) return { ...size, collapsed: true };
  return { width: clampSidebarWidth(size.width + direction * step), collapsed: false };
}

/** The saved size; a missing, broken or blocked store gives the initial one. */
export function readSidebarSize(raw: string | null): SidebarSize {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<SidebarSize> | null;
    if (value && typeof value.width === "number" && Number.isFinite(value.width))
      return { width: clampSidebarWidth(value.width), collapsed: value.collapsed === true };
  } catch {
    // Fall through to the initial size.
  }
  return { width: SIDEBAR.initial, collapsed: false };
}

/** The sidebar's size, kept across launches. `set(size, false)` moves it without saving (a drag). */
export function useSidebarSize() {
  const [size, setSize] = useState<SidebarSize>(() => {
    try {
      return readSidebarSize(localStorage.getItem(KEY));
    } catch {
      return readSidebarSize(null);
    }
  });
  const set = useCallback((next: SidebarSize, save = true) => {
    setSize(next);
    if (!save) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // The size still applies for this session.
    }
  }, []);
  return [size, set] as const;
}
