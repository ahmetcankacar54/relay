import type { ReactNode } from "react";
/**
 * The page toolbar: title and actions in one 52 px row beside the traffic lights, as in a macOS
 * window. It stays at the top while the page scrolls and drags the window from its empty space.
 * It sits inside the page panel, which starts after the sidebar, so the traffic lights stay clear of it.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  leading,
  badge,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** A way back to the page this one was opened from, before the title. */
  back?: ReactNode;
  /** Beside the title, before it (an avatar). */
  leading?: ReactNode;
  /** Beside the title, after it (a plan). */
  badge?: ReactNode;
}) {
  return (
    <header
      data-slot="toolbar"
      // The window drags from the whole header but its controls.
      data-tauri-drag-region="deep"
      className="sticky top-0 z-20 flex min-h-13 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-transparent bg-background/85 px-5 py-2 backdrop-blur-xl transition-colors select-none group-data-scrolled/main:border-border"
    >
      {/* A long description truncates (basis 16rem) instead of pushing the actions onto a row of their own. */}
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-2.5">
        {back && <div data-tauri-drag-region="false" className="-ml-2 shrink-0">{back}</div>}
        {leading}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{title}</h1>
            {/* Out of the drag region, so a badge's tooltip shows. */}
            {badge && (
              <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-2">{badge}</div>
            )}
          </div>
          {description && (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div data-tauri-drag-region="false" className="flex flex-wrap items-center gap-1.5">
          {actions}
        </div>
      )}
    </header>
  );
}
