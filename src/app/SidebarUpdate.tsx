import { useContext, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { I18nContext, type T } from "@/data/i18n";
import { RelayContext } from "@/data/relay-context";
import { UPDATE_INSTALL_KEY, updateHint, updateShown, updateTitle } from "@/lib/update-text";

/** The version the user put off with "Later"; its row stays hidden until a newer one. */
const LATER_KEY = "relay.update.later";
function readLater(): string | undefined {
  try {
    return localStorage.getItem(LATER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeLater(version: string) {
  try {
    localStorage.setItem(LATER_KEY, version);
  } catch {
    // Without storage the row only stays hidden until the window reloads.
  }
}

/** A small circular progress: the arc fills with `percent`, or turns while the amount is unknown. */
function ProgressRing({ percent }: { percent?: number }) {
  const r = 6.5;
  const length = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className={percent === undefined ? "size-4 animate-spin" : "size-4"} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-primary/20" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${((percent ?? 30) / 100) * length} ${length}`}
        transform="rotate(-90 8 8)"
        className="stroke-primary transition-[stroke-dasharray] duration-300"
      />
    </svg>
  );
}

/**
 * A newer Relay, as one row at the foot of the sidebar between the account card and Settings, as
 * tall as the Settings row: "Update" installs it, "Download update" opens the download page. While
 * it downloads or installs, a ring on the right shows the progress, and its tooltip the percent.
 * The version and what Update does are in the tooltip. The rail shows the download icon alone.
 */
export function SidebarUpdate({ compact = false, t: given }: { compact?: boolean; t?: T }) {
  // Read the contexts directly: the sidebar renders without providers in tests.
  const relay = useContext(RelayContext);
  const i18n = useContext(I18nContext);
  const t: T = given ?? i18n?.t ?? ((tr) => tr);
  const [later, setLater] = useState(readLater);
  const update = relay?.data?.update;
  if (!relay || !updateShown(update)) return null;
  const { version, status } = update;
  // Put off for later until a newer version, except while it installs.
  if (later === version && status !== "installing") return null;
  const busy = !!relay.busy || !!relay.desktop?.busy;
  const install = () => void relay.action(UPDATE_INSTALL_KEY, () => relay.api.installUpdate());
  const notes = () => void relay.api.openUpdateNotes();
  const hint = updateHint(update, t);
  const full = hint ? `${updateTitle(update, t)} ${hint}` : updateTitle(update, t);
  const percent = Math.round((update.progress ?? 0) * 100);
  // A word for what the row does, not the version: the version is in the tooltip.
  const label =
    status === "manual" ? t("Güncellemeyi indir", "Download update") : t("Güncelle", "Update");
  const working = status === "downloading" || status === "installing";
  const run = status === "ready" ? install : status === "manual" ? notes : undefined;

  if (compact)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="update-card"
            aria-label={full}
            disabled={!run || (status === "ready" && busy)}
            onClick={run}
            className="relative mb-1 grid size-10 place-items-center rounded-md text-sidebar-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 [-webkit-app-region:no-drag]"
          >
            <Download className="size-5" aria-hidden />
            <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-primary" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{full}</TooltipContent>
      </Tooltip>
    );

  return (
    <div data-slot="update-card" className="group/update relative mb-1 w-full [-webkit-app-region:no-drag]">
      <button
        type="button"
        aria-label={full}
        // Not disabled while it works: a disabled button takes no hover, and the ring's tooltip needs one.
        title={working ? undefined : full}
        aria-disabled={working || undefined}
        disabled={status === "ready" && busy}
        onClick={run}
        className="flex h-8 w-full items-center gap-2.5 rounded-md border border-primary/25 bg-primary/10 px-2.5 text-left text-sm font-medium text-sidebar-foreground outline-none hover:bg-primary/15 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <Download className="size-4.5 shrink-0 text-primary" aria-hidden />
        <span className="truncate">{label}</span>
        {working && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-slot="update-progress"
                role="progressbar"
                aria-label={t("Güncelleme ilerlemesi", "Update progress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status === "installing" ? undefined : percent}
                className="ml-auto grid size-5 shrink-0 place-items-center"
              >
                <ProgressRing percent={status === "installing" ? undefined : percent} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {status === "installing" ? t("Kuruluyor", "Installing") : t(`%${percent}`, `${percent}%`)}
            </TooltipContent>
          </Tooltip>
        )}
      </button>
      {!working && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("Sonra hatırlat", "Remind me later")}
          title={t("Sonra hatırlat", "Remind me later")}
          className="absolute top-1 right-1 opacity-0 group-hover/update:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            writeLater(version);
            setLater(version);
          }}
        >
          <X aria-hidden />
        </Button>
      )}
    </div>
  );
}
