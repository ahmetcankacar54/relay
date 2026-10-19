import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  addDays,
  type LostFoundWeek,
  type LostItem,
} from "../../../shared/lost-found";
import type { Account } from "../../../shared/types";
import { PandaRig } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  keepOnShelf,
  removeFromShelf,
  shelfId,
  useShelf,
} from "@/data/lost-found-shelf";
import { useI18n, type Language, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { cn } from "@/lib/utils";
import { Swatch } from "./DayHover";
import {
  formatDay,
  formatDayLong,
  formatDuration,
  locale,
  toneIndex,
} from "./format";
import { formatCount } from "./panda-facts";
import {
  StatisticsRequests,
  statisticsFailed,
  statisticsLoading,
  type UsageStatisticsState,
} from "./useUsageStatistics";

type Copy = [tr: string, en: string];

const COUNT_WORDS: Record<number, Copy> = {
  2: ["İki", "Two"],
  3: ["Üç", "Three"],
  4: ["Dört", "Four"],
  5: ["Beş", "Five"],
  6: ["Altı", "Six"],
  7: ["Yedi", "Seven"],
};

// Building an Intl formatter costs more than formatting with it, and a shelf tells up to 40 items.
const timeFormats = new Map<string, Intl.DateTimeFormat>();
function timeFormat(language: Language, zone: string, weekday: boolean) {
  const key = `${language}|${zone}|${weekday}`;
  let format = timeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale(language), {
      ...(weekday ? { weekday: "long" as const } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
    timeFormats.set(key, format);
  }
  return format;
}

/** "Çarşamba 09:56" / "Wednesday 09:56" in the planning zone. */
const formatWhen = (iso: string, zone: string, language: Language) =>
  timeFormat(language, zone, true).format(new Date(iso));

/** "12–18 Eki" within a month, "29 Eyl – 5 Eki" across two. */
export function weekLabel(start: string, end: string, language: Language) {
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${Number(start.slice(8))}–${formatDay(end, language)}`
    : `${formatDay(start, language)} – ${formatDay(end, language)}`;
}

/** "1 minute" / "8 minutes". */
const minutesEn = (n: number) => `${n} ${n === 1 ? "minute" : "minutes"}`;
/** "once", "twice", "3 times". */
const timesEn = (n: number) =>
  n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;

/** An item's picture and name: all a shelf tile needs. */
export function lookOf(item: LostItem, t: T): { emoji: string; title: string } {
  switch (item.kind) {
    case "hourglass":
      return { emoji: "⏳", title: t("Kum saati", "Hourglass") };
    case "boomerang":
      return { emoji: "🪃", title: t("Bumerang", "Boomerang") };
    case "trophy":
      return { emoji: "🏆", title: t("Rekor kupası", "Trophy") };
    case "scroll":
      return { emoji: "📜", title: t("Uzun parşömen", "Long scroll") };
    case "scarf": {
      const n = item.accountIds.length;
      const word = COUNT_WORDS[n] ?? [String(n), String(n)];
      return {
        emoji: "🧣",
        title: t(`${word[0]} renkli atkı`, `${word[1]}-colour scarf`),
      };
    }
    case "clocks":
      return { emoji: "⏰", title: t("Çift çalar saat", "Twin alarm clocks") };
    case "spare":
      return { emoji: "🛞", title: t("Yedek lastik", "Spare tyre") };
    case "feather":
      return { emoji: "🪶", title: t("Gece kuşu tüyü", "Night owl feather") };
  }
}

/** How an item reads: its picture, name, what happened, when and to whom, and what the panda thinks. */
export interface Described {
  emoji: string;
  title: string;
  story: string;
  when: string;
  /** Account ids in the order the story names them; a boomerang repeats the first. */
  accounts: string[];
  quip: string;
}

/** Every item's words, in the page's language; every Turkish line keeps suffixes off numbers, names and times. */
export function describe(
  item: LostItem,
  week: { start: string; end: string },
  zone: string,
  t: T,
  language: Language,
): Described {
  const look = lookOf(item, t);
  switch (item.kind) {
    case "hourglass": {
      const took = formatDuration(item.minutes * 60_000, language);
      return {
        ...look,
        story: t(
          `Bir 5 saatlik dönem, başlamasından yalnızca ${took} sonra doldu.`,
          `A five-hour window ran out just ${took} after it began.`,
        ),
        when: formatWhen(item.at, zone, language),
        accounts: item.accountId ? [item.accountId] : [],
        quip: t(
          "Kumu bu kadar hızlı akan bir saat görmedim.",
          "I have never seen sand run that fast.",
        ),
      };
    }
    case "boomerang":
      return {
        ...look,
        story: t(
          `Başladığın hesaba ${item.minutes} dakika içinde geri döndün.`,
          `You were back on the account you started with within ${minutesEn(item.minutes)}.`,
        ),
        when: formatWhen(item.at, zone, language),
        accounts: [item.accountIds[0], item.accountIds[1], item.accountIds[0]],
        quip: t("Geri geleceğini biliyordum.", "I had a feeling we’d be back."),
      };
    case "trophy": {
      const count = formatCount(item.tokens, language);
      const times = new Intl.NumberFormat(locale(language), {
        maximumFractionDigits: 1,
      }).format(item.times);
      return {
        ...look,
        story: t(
          `Son 30 günün en yoğun günü: sıradan bir günün ${times} katı, ${count} token.`,
          `The busiest of the last 30 days: ${times}× an ordinary day, ${count} tokens.`,
        ),
        when: formatDayLong(item.date, language),
        accounts: [],
        quip: t("Rafın en üstüne koydum.", "It goes on the top shelf."),
      };
    }
    case "scroll": {
      const until = new Date(
        Date.parse(item.at) + item.hours * 3_600_000,
      ).toISOString();
      return {
        ...look,
        story: t(
          `${item.hours} saat aralıksız çalıştın.`,
          `You worked ${item.hours} hours without a break.`,
        ),
        when: `${formatWhen(item.at, zone, language)} → ${formatWhen(until, zone, language)}`,
        accounts: [],
        quip: t(
          "Ucunu bulana kadar açtım.",
          "I kept unrolling until I found the end.",
        ),
      };
    }
    case "scarf": {
      const n = item.accountIds.length;
      const word = COUNT_WORDS[n] ?? [String(n), String(n)];
      return {
        ...look,
        story: t(
          `Aynı gün ${n} hesabın her biri iş başındaydı.`,
          `${word[1]} accounts all took a turn on the same day.`,
        ),
        when: formatDayLong(item.date, language),
        accounts: item.accountIds,
        quip: t("Her hesaptan bir ilmek.", "One stitch from every account."),
      };
    }
    case "clocks": {
      const together =
        item.gapMinutes === 0
          ? t(
              "İki hesabın 5 saatlik dönemi aynı anda yenilendi.",
              "Two accounts’ five-hour windows reset at the same moment.",
            )
          : t(
              `İki hesabın 5 saatlik dönemi ${item.gapMinutes} dakika arayla yenilendi.`,
              `Two accounts’ five-hour windows reset ${minutesEn(item.gapMinutes)} apart.`,
            );
      const again =
        item.count > 1
          ? t(
              ` O hafta ${item.count} kez oldu.`,
              ` It happened ${timesEn(item.count)} that week.`,
            )
          : "";
      return {
        ...look,
        story: together + again,
        when: formatWhen(item.at, zone, language),
        accounts: item.accountIds,
        quip: t(
          "İkisi birden çaldı; hangisine koşacağımı şaşırdım.",
          "Both rang at once; I didn’t know which to run to.",
        ),
      };
    }
    case "spare": {
      const many = item.accountIds.length > 1;
      return {
        ...look,
        story: t(
          `${many ? "Bazı hesaplar" : "Bir hesap"} bütün hafta kenarda bekledi; bu arada ${item.hits} kez limite takıldın.`,
          `${many ? "Some accounts" : "An account"} sat out the whole week while you hit a limit ${timesEn(item.hits)}.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: item.accountIds,
        quip: t("Bagajdaydı, kimse bakmadı.", "It was in the boot all along."),
      };
    }
    case "feather": {
      const from = formatWhen(item.at, zone, language);
      const to = timeFormat(language, zone, false).format(
        new Date(Date.parse(item.at) + 3_600_000),
      );
      return {
        ...look,
        story: t(
          `O hafta gece yarısından sonra toplam ${item.hours} saat çalıştın.`,
          `That week you worked ${item.hours} ${item.hours === 1 ? "hour" : "hours"} after midnight in all.`,
        ),
        when: t(`En geç: ${from}–${to}`, `Latest: ${from}–${to}`),
        accounts: [],
        quip: t(
          "Ben uyuyordum; tüyü sabah buldum.",
          "I was asleep; I found the feather in the morning.",
        ),
      };
    }
  }
}

type LostFoundState = UsageStatisticsState<LostFoundWeek>;

/** The week the bureau shows: fetched on mount and when another week is opened; the last one stays while loading. */
function useLostFound(weekStart?: string): LostFoundState {
  const { api } = useRelay();
  const [state, setState] = useState<LostFoundState>({ loading: true });
  const [requests] = useState(() => new StatisticsRequests());
  useEffect(() => {
    const id = requests.start(Date.now());
    setState(statisticsLoading);
    api.lostFound(weekStart ? { weekStart } : {}).then(
      (view) => {
        if (requests.current(id)) setState({ view, loading: false });
      },
      (error: unknown) => {
        if (requests.current(id)) setState((s) => statisticsFailed(s, error));
      },
    );
  }, [api, weekStart, requests]);
  return state;
}

/** Account chips: colour and name; a name the shelf kept wins over a removed account. */
function AccountChips({
  ids,
  accounts,
  names,
  arrows,
}: {
  ids: string[];
  accounts: Account[];
  names?: Record<string, string>;
  /** Join with arrows, for a boomerang's way out and back. */
  arrows?: boolean;
}) {
  const { t } = useI18n();
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {ids.map((id, i) => {
        const account = accounts.find((a) => a.id === id);
        const name =
          account?.name ?? names?.[id] ?? t("Eski hesap", "Former account");
        return (
          <span key={`${id}-${i}`} className="inline-flex items-center gap-1">
            {arrows && i > 0 && (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            )}
            {account && (
              <Swatch tone={toneIndex({ accountId: id }, accounts)} />
            )}
            <span>{name}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The item on show: its picture in the drawer with the panda behind it, its story and the shelf toggle. The
 * toggle stays one button whether the item is kept or not, so keyboard focus stays on it.
 */
function Showcase({
  described,
  accounts,
  names,
  label,
  kept,
  onToggle,
  arrows,
}: {
  described: Described;
  accounts: Account[];
  names?: Record<string, string>;
  /** Where the item comes from, when it is not the open week: "Raftan · 12–18 Eki". */
  label?: string;
  kept: boolean;
  onToggle: () => void;
  arrows?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start gap-4" data-slot="lost-item">
      <div className="relative mt-6 grid size-24 shrink-0 place-items-center rounded-2xl border bg-muted text-5xl">
        <span className="pointer-events-none absolute -top-[42px] right-1">
          <PandaRig
            pose="peek"
            expression="happy"
            motion={["blink"]}
            size={56}
          />
        </span>
        <span aria-hidden="true">{described.emoji}</span>
      </div>
      <div className="min-w-0 flex-1 basis-60">
        {label && <div className="text-xs text-muted-foreground">{label}</div>}
        <h4 className="font-display text-lg font-semibold">
          {described.title}
        </h4>
        <p className="mt-1 text-sm">{described.story}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{described.when}</span>
          {described.accounts.length > 0 && <span aria-hidden="true">·</span>}
          <AccountChips
            ids={described.accounts}
            accounts={accounts}
            names={names}
            arrows={arrows}
          />
        </p>
        <p className="mt-2 text-xs text-muted-foreground italic">
          <span className="sr-only">
            {t("Panda diyor ki: ", "The panda says: ")}
          </span>
          “{described.quip}”
        </p>
        <Button
          size="xs"
          variant={kept ? "secondary" : "outline"}
          className="mt-3"
          aria-pressed={kept}
          onClick={onToggle}
        >
          {kept
            ? t("Rafta ✓", "On the shelf ✓")
            : t("Rafa koy", "Keep on the shelf")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The panda's lost-and-found: each week it finds what the week left behind, real moments of it
 * (docs/superpowers/specs/2026-10-19-lost-found-design.md). One item is on show; the week's other finds
 * sit beside it, and the user can keep any on the shelf.
 */
export function LostFound() {
  const { accounts, settings } = useRelay();
  const { t, language } = useI18n();
  const zone = settings.planning.timeZone;
  const [weekStart, setWeekStart] = useState<string>();
  const { view: week, loading, error } = useLostFound(weekStart);
  const shelf = useShelf();
  /** What is on show: one of a week's finds (for that week only), or a kept one. */
  const [chosen, setChosen] = useState<
    { start: string; kind: LostItem["kind"] } | { shelf: string }
  >();

  const fromShelf =
    chosen && "shelf" in chosen
      ? shelf.find((kept) => kept.id === chosen.shelf)
      : undefined;
  const weekItem =
    week &&
    (week.items.find(
      (item) =>
        chosen &&
        "kind" in chosen &&
        chosen.start === week.start &&
        item.kind === chosen.kind,
    ) ??
      week.items[0]);
  const toggleWeekItem = (item: LostItem) => {
    if (!week) return;
    const id = shelfId(week.start, item.kind);
    if (shelf.some((kept) => kept.id === id)) return removeFromShelf(id);
    const ids = describe(item, week, zone, t, language).accounts;
    keepOnShelf({
      id,
      start: week.start,
      end: week.end,
      item,
      names: Object.fromEntries(
        ids.flatMap((accountId) => {
          const account = accounts.find((a) => a.id === accountId);
          return account ? [[accountId, account.name]] : [];
        }),
      ),
    });
  };
  /** What the showcase tells: a kept item (taking it off the shelf ends its showing), else the week's. */
  const shownItem = fromShelf
    ? {
        described: describe(fromShelf.item, fromShelf, zone, t, language),
        names: fromShelf.names,
        label: t(
          `Raftan · ${weekLabel(fromShelf.start, fromShelf.end, "tr")}`,
          `From the shelf · ${weekLabel(fromShelf.start, fromShelf.end, "en")}`,
        ),
        kept: true,
        onToggle: () => removeFromShelf(fromShelf.id),
        arrows: fromShelf.item.kind === "boomerang",
      }
    : week && weekItem
      ? {
          described: describe(weekItem, week, zone, t, language),
          kept: shelf.some(
            (kept) => kept.id === shelfId(week.start, weekItem.kind),
          ),
          onToggle: () => toggleWeekItem(weekItem),
          arrows: weekItem.kind === "boomerang",
        }
      : undefined;
  // Steps count from the week asked for, so a second click while the first loads still moves on.
  const shownStart = weekStart ?? week?.start;
  const step = (days: number) => {
    if (!shownStart) return;
    setChosen(undefined);
    setWeekStart((asked) => {
      const next = addDays(asked ?? shownStart, days);
      // Never past the reach: the main process would answer that with the newest week.
      if (!week) return next;
      return next < week.oldest
        ? week.oldest
        : next > week.latest
          ? week.latest
          : next;
    });
  };
  const isLatest = week ? (shownStart ?? week.start) >= week.latest : true;
  const isOldest = week ? (shownStart ?? week.start) <= week.oldest : true;

  return (
    <Card className="min-w-0 gap-3 px-5 py-4" aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-[15px] font-semibold">
            {t("Kayıp Eşya Bürosu", "Lost and found")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {week?.start === week?.latest
              ? t(
                  "Panda geçen haftanın ardından kalanları topladı.",
                  "What last week left behind, collected by the panda.",
                )
              : t(
                  "O haftanın ardından kalanlar.",
                  "What that week left behind.",
                )}
          </p>
        </div>
        {week && (
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("Önceki hafta", "Previous week")}
              disabled={isOldest}
              onClick={() => step(-7)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-24 text-center text-xs tabular-nums">
              {weekLabel(week.start, week.end, language)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("Sonraki hafta", "Next week")}
              disabled={isLatest}
              onClick={() => step(7)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-muted-foreground">
          <b>{t("Eşyalar alınamadı.", "Could not open the lost and found.")}</b>{" "}
          {error}
        </p>
      )}
      {!week ? (
        !error && (
          <p className="text-sm text-muted-foreground">
            {t("Çekmece açılıyor", "Opening the drawer")}
          </p>
        )
      ) : shownItem ? (
        // One tree for a kept item and a week's item, so the shelf toggle keeps its focus across both.
        <>
          <Showcase {...shownItem} accounts={accounts} />
          {!fromShelf && weekItem && week.items.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
              <span className="mr-1 text-xs text-muted-foreground">
                {t("Aynı haftadan:", "Same week:")}
              </span>
              {week.items.map((item) => {
                const look = lookOf(item, t);
                const on = item.kind === weekItem.kind;
                return (
                  <Button
                    key={item.kind}
                    size="xs"
                    variant={on ? "secondary" : "ghost"}
                    aria-pressed={on}
                    onClick={() =>
                      setChosen({ start: week.start, kind: item.kind })
                    }
                  >
                    <span aria-hidden="true">{look.emoji}</span>
                    {look.title}
                  </Button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3 py-2">
          <PandaRig pose="curl" expression="closed" props={["z"]} size={48} />
          <p className="text-sm text-muted-foreground">
            {t(
              "Bu hafta çekmece boş: kimse bir şey unutmamış.",
              "The drawer is empty this week: nobody left anything behind.",
            )}
          </p>
        </div>
      )}

      {shelf.length > 0 && (
        <div className="border-t pt-3" data-slot="lost-shelf">
          <div className="mb-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t("Raf", "Shelf")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shelf.map((kept) => {
              const look = lookOf(kept.item, t);
              const on = fromShelf?.id === kept.id;
              const label = weekLabel(kept.start, kept.end, language);
              return (
                <button
                  key={kept.id}
                  type="button"
                  aria-pressed={on}
                  title={`${look.title} · ${label}`}
                  onClick={() => setChosen(on ? undefined : { shelf: kept.id })}
                  className={cn(
                    "grid w-16 justify-items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[10px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    on ? "border-primary bg-muted" : "hover:bg-muted",
                  )}
                >
                  <span aria-hidden="true" className="text-xl leading-none">
                    {look.emoji}
                  </span>
                  <span className="sr-only">{look.title}, </span>
                  <span className="tabular-nums">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
