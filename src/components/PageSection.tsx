import { useContext, useId, type ReactNode } from "react";
import { I18nContext } from "@/data/i18n";
import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A page's section: its title above the card (never inside it), controls on the right, and the
 * explanation behind an ⓘ instead of a sentence on the page. Every page stacks these with one gap,
 * so the rhythm is the same everywhere.
 */
export function PageSection({
  title,
  aside,
  info,
  children,
  slot,
}: {
  title: ReactNode;
  aside?: ReactNode;
  /** How the section works, on hover or focus of the ⓘ. */
  info?: ReactNode;
  children: ReactNode;
  slot?: string;
}) {
  const id = useId();
  return (
    <section data-slot={slot ?? "page-section"} aria-labelledby={id} className="grid gap-2">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {info && <InfoTip>{info}</InfoTip>}
        {aside && <div className="ml-auto flex flex-wrap items-center gap-1.5">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** An ⓘ that explains on hover or focus: the place for "how it works" text. */
export function InfoTip({ children }: { children: ReactNode }) {
  const tr = (useContext(I18nContext)?.language ?? "tr") === "tr";
  // Its own provider, so a section explains itself wherever it is drawn (the tray, a test, a page).
  return (
    <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={tr ? "Nasıl çalışır" : "How it works"} className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs">{children}</TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}
