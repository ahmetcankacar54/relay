import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A titled section that starts open or closed. The content is not rendered while it is closed.
 * `openKey` names what the section must show: each time it changes to a new, non-empty value, the
 * section opens. It never closes by itself, and the user can still close it.
 */
export function Disclosure({
  title,
  defaultOpen = false,
  openKey,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  openKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  useEffect(() => {
    if (openKey) setOpen(true);
  }, [openKey]);
  return (
    <section className="grid">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {title}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
      </h3>
      {open && (
        <div id={id} className="mt-2 grid gap-2">
          {children}
        </div>
      )}
    </section>
  );
}
