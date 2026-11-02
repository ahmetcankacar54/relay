import type { ReactNode } from "react";
export function PageHeader({
  title,
  description,
  actions,
  back,
  leading,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** A way back to the page this one was opened from, above the title. */
  back?: ReactNode;
  /** Beside the title, before it (an avatar). */
  leading?: ReactNode;
  /** Beside the title, after it (a plan). */
  badge?: ReactNode;
}) {
  return (
    <header className="px-6 pt-6 pb-3">
      {back && <div className="mb-2">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
              {badge}
            </div>
            {description && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}
