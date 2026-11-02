import { useEffect, useRef } from "react";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { PandaRig } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { cn } from "@/lib/utils";
import { formatDayLong, formatTokens } from "./format";
import {
  dayParts,
  formatShare,
  type DayKinds,
  type PandaLine,
} from "./panda-facts";

/** The parts a bar is taken apart into, largest kind first as they usually come. */
const PARTS: { kind: keyof DayKinds; tr: string; en: string; fill: string }[] =
  [
    {
      kind: "cacheRead",
      tr: "Önbellek okuma",
      en: "Cache read",
      fill: "bg-muted-foreground/40",
    },
    {
      kind: "cacheWrite",
      tr: "Önbellek yazma",
      en: "Cache write",
      fill: "bg-muted-foreground/75",
    },
    { kind: "input", tr: "Girdi", en: "Input", fill: "bg-foreground/70" },
    { kind: "output", tr: "Çıktı", en: "Output", fill: "bg-primary" },
  ];

/**
 * The panda's workbench beside a bar it took out of the chart: the day, what the bar is made of and the line the
 * panda says about it. "Bir daha" asks for the next line; closing it, or Escape nobody else handled, puts the bar
 * back. Where the chart is narrow the bench sits under it instead of over it. The card announces the lines, so the
 * bench itself has no live region.
 */
export function PandaBench({
  view,
  date,
  line,
  more,
  at,
  onNext,
  onClose,
  returnFocus,
}: {
  view: TokenUsageView;
  date: string;
  line: PandaLine;
  /** The day has other lines, so "Bir daha" shows. */
  more: boolean;
  /** The bar's centre as a share of the chart's width. */
  at: number;
  onNext: () => void;
  onClose: () => void;
  /** Where focus goes when the bench closes with focus inside it: what opened it. */
  returnFocus: () => void;
}) {
  const { t, language } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const { kinds, total, estimated } = dayParts({ view, date });
  const close = () => {
    const inside = root.current?.contains?.(document.activeElement) ?? false;
    onClose();
    if (inside) returnFocus();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    // A menu or the chart that took the Escape for itself marks it handled.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      ref={root}
      role="group"
      aria-label={t("Pandanın anlattığı gün", "The day the panda explains")}
      data-slot="panda-bench"
      className="token-bench absolute top-10 z-20 w-80 rounded-xl border bg-popover px-3 pt-3 pb-2.5 text-xs text-popover-foreground shadow-lg @max-[38rem]:relative @max-[38rem]:top-auto @max-[38rem]:right-auto! @max-[38rem]:left-auto! @max-[38rem]:mt-12 @max-[38rem]:w-full"
      style={
        at > 0.5
          ? { right: `calc(${(1 - at) * 100}% + 14px)` }
          : { left: `calc(${at * 100}% + 14px)` }
      }
    >
      <span className="token-bench-panda pointer-events-none absolute -top-[46px] left-1">
        {total > 0 ? (
          <PandaRig
            pose="peek"
            expression="happy"
            motion={["blink"]}
            size={64}
          />
        ) : (
          <PandaRig pose="curl" expression="closed" props={["z"]} size={56} />
        )}
      </span>
      <div className="flex items-baseline justify-between gap-3 pl-16">
        <b className="font-semibold whitespace-nowrap">
          {formatDayLong(date, language)}
        </b>
        <span className="whitespace-nowrap tabular-nums">
          <span className="text-muted-foreground">{t("Toplam", "Total")} </span>
          <b>
            {estimated && (
              <>
                <span aria-hidden="true">≈</span>
                <span className="sr-only">{t("tahmini", "estimated")} </span>
              </>
            )}
            {formatTokens(total, language)}
          </b>
        </span>
      </div>
      <p
        data-slot="panda-line"
        className="mt-2 rounded-lg bg-muted px-2.5 py-2 text-[13px] leading-snug"
      >
        {t(line.tr, line.en)}
      </p>
      {total > 0 && (
        <ul className="mt-2 grid gap-1.5">
          {PARTS.map((part, i) => {
            const value = kinds[part.kind];
            const share = value / total;
            return (
              <li
                key={part.kind}
                className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2"
              >
                <span className="text-muted-foreground">
                  {t(part.tr, part.en)}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-track">
                  <span
                    className={cn(
                      "token-part block h-full rounded-full",
                      part.fill,
                    )}
                    style={{
                      width: `${value > 0 ? Math.max(2, share * 100) : 0}%`,
                      animationDelay: `${150 + i * 90}ms`,
                    }}
                  />
                </span>
                <span className="text-right tabular-nums">
                  {formatTokens(value, language)}{" "}
                  <span className="text-muted-foreground">
                    {formatShare(share, language)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2.5 flex justify-end gap-1.5">
        {more && (
          <Button size="xs" variant="outline" onClick={onNext}>
            {t("Bir daha", "One more")}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={close}>
          {t("Kapat", "Close")}
        </Button>
      </div>
    </div>
  );
}
