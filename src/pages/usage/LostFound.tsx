import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  addDays,
  COMPASS_MIN_HOURS,
  nextTier,
  SCROLL_MIN_HOURS,
  SECRET_LOST_KINDS,
  tierOf,
  TROPHY_DAYS,
  LOST_ITEM_KINDS,
  LOST_TIERS,
  type LostFoundWeek,
  type LostItem,
  type LostItemKind,
  type LostTier,
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
import {
  recordFinds,
  useCollection,
  type CollectionWeeks,
} from "@/data/lost-found-collection";
import { useI18n, type Language, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { cn } from "@/lib/utils";
import { Swatch } from "./DayHover";
import {
  formatDay,
  formatDayLong,
  formatDuration,
  locale,
  toneFill,
  toneIndex,
} from "./format";
import { LostPin } from "./LostPins";
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

/** An item's name: all a shelf tile needs besides its pin. */
export function lookOf(item: LostItem, t: T): { title: string } {
  if (item.kind === "scarf") {
    const n = item.accountIds.length;
    const word = COUNT_WORDS[n] ?? [String(n), String(n)];
    return { title: t(`${word[0]} renkli atkı`, `${word[1]}-colour scarf`) };
  }
  return { title: kindTitle(item.kind, t) };
}

/** A kind's name in the collection, where a scarf has no count yet. */
export function kindTitle(kind: LostItemKind, t: T): string {
  switch (kind) {
    case "hourglass":
      return t("Kum saati", "Hourglass");
    case "baton":
      return t("Bayrak sopası", "Relay baton");
    case "boomerang":
      return t("Bumerang", "Boomerang");
    case "trophy":
      return t("Rekor kupası", "Trophy");
    case "scroll":
      return t("Uzun parşömen", "Long scroll");
    case "tally":
      return t("Yedi çentikli bambu", "Seven-notch bamboo");
    case "compass":
      return t("Pusula", "Compass");
    case "scarf":
      return t("Renkli atkı", "Striped scarf");
    case "clocks":
      return t("Çift çalar saat", "Twin alarm clocks");
    case "spare":
      return t("Yedek lastik", "Spare tyre");
    case "feather":
      return t("Gece kuşu tüyü", "Night owl feather");
    case "teaglass":
      return t("Sabah çayı", "Morning tea");
  }
}

/** How a kind not found yet is earned, as the collection tells it; secret kinds keep it to themselves. */
export function hintOf(kind: LostItemKind, t: T): string {
  if (SECRET_LOST_KINDS.includes(kind))
    return t(
      "Gizli rozet. Panda ipucu vermiyor.",
      "A secret pin. The panda isn’t telling.",
    );
  switch (kind) {
    case "hourglass":
      return t(
        "Bir 5 saatlik dönem, başlamasından en geç 2,5 saat sonra dolsun.",
        "Fill a five-hour window within 2.5 hours of its start.",
      );
    case "baton":
      return t(
        "Bir hesap limite takılınca yarım saat içinde başka hesapla devam et.",
        "When an account hits its limit, carry on with another within half an hour.",
      );
    case "trophy":
      return t(
        `Son ${TROPHY_DAYS} günün açık ara en yoğun gününü yaşa.`,
        `Have the busiest of the last ${TROPHY_DAYS} days, by a clear margin.`,
      );
    case "scroll":
      return t(
        `En az ${SCROLL_MIN_HOURS} saat aralıksız çalış.`,
        `Work ${SCROLL_MIN_HOURS} hours or more without a break.`,
      );
    case "tally":
      return t(
        "Bir haftanın yedi gününde de çalış.",
        "Work on all seven days of one week.",
      );
    case "compass":
      return t(
        `Bir haftada en az ${COMPASS_MIN_HOURS} saat çalış ve hiç limite takılma.`,
        `Work ${COMPASS_MIN_HOURS} hours or more in a week without hitting a limit.`,
      );
    case "scarf":
      return t(
        "Aynı gün en az 3 hesap kullan.",
        "Use three or more accounts on the same day.",
      );
    case "spare":
      return t(
        "Diğer hesaplar limite takılırken bir hesap bütün hafta kenarda kalsın.",
        "Leave an account unused all week while the others hit limits.",
      );
    case "feather":
      return t("Gece yarısından sonra çalış.", "Work after midnight.");
    case "teaglass":
      return t(
        "Sabah 05:00 ile 08:00 arasında çalış.",
        "Work between 05:00 and 08:00.",
      );
    default:
      return "";
  }
}

/** A finish's name. */
export const tierName = (tier: LostTier, t: T) =>
  tier === "gold"
    ? t("Altın", "Gold")
    : tier === "silver"
      ? t("Gümüş", "Silver")
      : t("Bronz", "Bronze");

/** How an item reads: its picture, name, what happened, when and to whom, and what the panda thinks. */
export interface Described {
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
    case "baton": {
      const took =
        item.minutes === 0
          ? t(
              "Bir hesap limite takılınca öbür hesap hemen devraldı.",
              "An account hit its limit and another took over at once.",
            )
          : t(
              `Bir hesap limite takılınca öbür hesap ${item.minutes} dakika içinde devraldı.`,
              `An account hit its limit and another took over within ${minutesEn(item.minutes)}.`,
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
        story: took + again,
        when: formatWhen(item.at, zone, language),
        accounts: item.accountIds,
        quip: t(
          "Bayrağı düşürmeden koşmaya devam ettik.",
          "We ran on without dropping the baton.",
        ),
      };
    }
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
    case "tally":
      return {
        ...look,
        story: t(
          `Haftanın yedi gününün her birinde çalıştın; toplam ${item.hours} saat.`,
          `You worked on all seven days of the week, ${item.hours} hours in all.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: [],
        quip: t("Her gün bir çentik attım.", "I cut a notch for every day."),
      };
    case "compass":
      return {
        ...look,
        story: t(
          `O hafta ${item.hours} saat çalıştın ve hiç limite takılmadın.`,
          `That week you worked ${item.hours} hours and never hit a limit.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: [],
        quip: t("Rotadan hiç çıkmadık.", "We never went off course."),
      };
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
    case "teaglass": {
      const from = formatWhen(item.at, zone, language);
      const to = timeFormat(language, zone, false).format(
        new Date(Date.parse(item.at) + 3_600_000),
      );
      return {
        ...look,
        story: t(
          `O hafta sabah 05:00 ile 08:00 arasında toplam ${item.hours} saat çalıştın.`,
          `That week you worked ${item.hours} ${item.hours === 1 ? "hour" : "hours"} between 05:00 and 08:00 in all.`,
        ),
        when: t(`En erken: ${from}–${to}`, `Earliest: ${from}–${to}`),
        accounts: [],
        quip: t(
          "Çay demlenmeden işe koyulmuşsun.",
          "You were at it before the tea had brewed.",
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

/** The account colours an item's pin shows, in its story's order; a removed account keeps the pin's own. */
function pinTints(item: LostItem, accounts: Account[]) {
  const ids = "accountIds" in item ? item.accountIds : [];
  return ids.map((id) =>
    accounts.some((a) => a.id === id)
      ? toneFill(toneIndex({ accountId: id }, accounts))
      : undefined,
  );
}

/** What the collection knows of a kind: how often it was found, its finish and the first week. */
export interface Finish {
  weeks: number;
  tier?: LostTier;
  /** The earliest week it was found in. */
  first?: string;
}

export function finishOf(weeks: string[] | undefined): Finish {
  const n = weeks?.length ?? 0;
  return { weeks: n, tier: tierOf(n), first: weeks?.[n - 1] };
}

/** "Gümüş · 4 hafta" / "Silver · 4 weeks". */
function finishLabel(finish: Finish, t: T) {
  if (!finish.tier) return "";
  return t(
    `${tierName(finish.tier, t)} · ${finish.weeks} hafta`,
    `${tierName(finish.tier, t)} · ${finish.weeks} ${finish.weeks === 1 ? "week" : "weeks"}`,
  );
}

/** The way to the next finish: "Gümüş için 1 hafta daha", or that gold is the last. */
function nextLabel(finish: Finish, t: T) {
  const next = nextTier(finish.weeks);
  if (!next) return t("En üst seviye", "Top finish");
  const left = next.weeks - finish.weeks;
  return t(
    `${tierName(next.tier, t)} için ${left} hafta daha`,
    `${left} more ${left === 1 ? "week" : "weeks"} to ${tierName(next.tier, t).toLowerCase()}`,
  );
}

/** A thin bar of `value` out of `max`. */
function Meter({
  value,
  max,
  label,
  className,
}: {
  value: number;
  max: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
        style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }}
      />
    </div>
  );
}

/**
 * The item on show: its pin in the drawer, the panda living that moment in it, its story, its finish and the shelf
 * toggle. The toggle stays one button whether the item is kept or not, so keyboard focus stays on it.
 */
function Showcase({
  item,
  described,
  accounts,
  names,
  label,
  finish,
  firstFind,
  kept,
  onToggle,
  arrows,
}: {
  item: LostItem;
  described: Described;
  accounts: Account[];
  names?: Record<string, string>;
  /** Where the item comes from, when it is not the open week: "Raftan · 12–18 Eki". */
  label?: string;
  finish: Finish;
  /** This was the first week the kind was ever found. */
  firstFind?: boolean;
  kept: boolean;
  onToggle: () => void;
  arrows?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start gap-4" data-slot="lost-item">
      <div className="grid size-32 shrink-0 place-items-center rounded-2xl border bg-muted">
        <LostPin
          kind={item.kind}
          tier={finish.tier}
          tints={pinTints(item, accounts)}
          size={116}
          shine
        />
      </div>
      <div className="min-w-0 flex-1 basis-60">
        {label && <div className="text-xs text-muted-foreground">{label}</div>}
        <h4 className="font-display text-lg font-semibold">
          {described.title}
        </h4>
        {(finish.tier || firstFind) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
            {finish.tier && (
              <span
                className="rounded-full border px-2 py-0.5 text-muted-foreground"
                data-slot="lost-finish"
              >
                {finishLabel(finish, t)}
              </span>
            )}
            {firstFind && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                {t("İlk kez bulundu", "First find")}
              </span>
            )}
          </p>
        )}
        <p className="mt-1.5 text-sm">{described.story}</p>
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
 * Every pin there is, in a fixed album order: found ones in the finish they earned, the rest greyed with
 * how to find them, and secret ones sealed until their first find. A found pin opens its newest week in reach.
 */
function Collection({
  weeks,
  reach,
  loading,
  onOpen,
}: {
  weeks: CollectionWeeks;
  reach?: { latest: string; oldest: string };
  loading: boolean;
  onOpen: (start: string, kind: LostItemKind) => void;
}) {
  const { t } = useI18n();
  const finishes = LOST_ITEM_KINDS.map((kind) => ({
    kind,
    finish: finishOf(weeks[kind]),
  }));
  const found = finishes.filter(({ finish }) => finish.tier).length;
  const count = (tier: LostTier) =>
    finishes.filter(({ finish }) => finish.tier === tier).length;
  return (
    <div className="grid gap-3" data-slot="lost-collection">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <div className="font-display text-2xl font-semibold tabular-nums">
            {found}
            <span className="text-base text-muted-foreground">
              {" "}
              / {LOST_ITEM_KINDS.length}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {t("rozet bulundu", "pins found")}
          </div>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {(["gold", "silver", "bronze"] as const)
            .map((tier) => `${tierName(tier, t)} ${count(tier)}`)
            .join(" · ")}
        </div>
      </div>
      <Meter
        value={found}
        max={LOST_ITEM_KINDS.length}
        label={t("Koleksiyon", "Collection")}
      />
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
        {finishes.map(({ kind, finish }) => {
          const sealed = !finish.tier && SECRET_LOST_KINDS.includes(kind);
          const title = sealed
            ? t("Gizli rozet", "Secret pin")
            : kindTitle(kind, t);
          const open = reach
            ? weeks[kind]?.find(
                (start) => start >= reach.oldest && start <= reach.latest,
              )
            : undefined;
          const body = (
            <>
              <LostPin
                kind={kind}
                tier={finish.tier}
                locked={!finish.tier}
                sealed={sealed}
                size={76}
              />
              <span className="mt-2 block text-[13px] leading-tight font-semibold">
                {title}
              </span>
              {finish.tier ? (
                <>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {finishLabel(finish, t)}
                  </span>
                  <Meter
                    value={finish.weeks}
                    max={nextTier(finish.weeks)?.weeks ?? finish.weeks}
                    label={nextLabel(finish, t)}
                    className="mt-2 h-1 w-full"
                  />
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    {nextLabel(finish, t)}
                  </span>
                </>
              ) : (
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {hintOf(kind, t)}
                </span>
              )}
            </>
          );
          const tile =
            "flex h-full w-full flex-col items-center rounded-xl border px-2.5 pt-3 pb-2.5 text-center";
          return (
            <li key={kind} data-kind={kind} data-found={!!finish.tier}>
              {open ? (
                <button
                  type="button"
                  className={cn(
                    tile,
                    "outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  )}
                  title={t(
                    `${weekLabel(open, addDays(open, 6), "tr")} haftasını aç`,
                    `Open the week of ${weekLabel(open, addDays(open, 6), "en")}`,
                  )}
                  onClick={() => onOpen(open, kind)}
                >
                  {body}
                </button>
              ) : (
                <div
                  className={cn(
                    tile,
                    !finish.tier && "border-dashed bg-muted/40",
                  )}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {loading
          ? t(
              "Panda haftaları tarıyor…",
              "The panda is going through the weeks…",
            )
          : t(
              `Bir rozet bulunduğu ilk hafta bronz, ${LOST_TIERS[1].weeks} haftada gümüş, ${LOST_TIERS[2].weeks} haftada altın olur. Rozetler bu Mac’te kalır.`,
              `A pin is bronze the first week it is found, silver after ${LOST_TIERS[1].weeks} weeks and gold after ${LOST_TIERS[2].weeks}. Pins stay on this Mac.`,
            )}
      </p>
    </div>
  );
}

/**
 * The panda's lost-and-found: each week it finds what the week left behind, real moments of it
 * (docs/superpowers/specs/2026-10-19-lost-found-design.md). One item is on show; the week's other finds
 * sit beside it, and the user can keep any on the shelf. The collection shows every pin there is.
 */
export function LostFound() {
  const { accounts, settings, api } = useRelay();
  const { t, language } = useI18n();
  const zone = settings.planning.timeZone;
  const [view, setView] = useState<"week" | "collection">("week");
  const [weekStart, setWeekStart] = useState<string>();
  const { view: week, loading, error } = useLostFound(weekStart);
  const shelf = useShelf();
  const collection = useCollection(api, shelf);
  /** What is on show: one of a week's finds (for that week only), or a kept one. */
  const [chosen, setChosen] = useState<
    { start: string; kind: LostItem["kind"] } | { shelf: string }
  >();
  // A week's finds join the collection as soon as it is opened.
  useEffect(() => {
    if (!week) return;
    recordFinds(
      Object.fromEntries(week.items.map((item) => [item.kind, [week.start]])),
    );
  }, [week]);
  const finish = (kind: LostItemKind) => finishOf(collection.weeks[kind]);

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
        item: fromShelf.item,
        described: describe(fromShelf.item, fromShelf, zone, t, language),
        names: fromShelf.names,
        label: t(
          `Raftan · ${weekLabel(fromShelf.start, fromShelf.end, "tr")}`,
          `From the shelf · ${weekLabel(fromShelf.start, fromShelf.end, "en")}`,
        ),
        finish: finish(fromShelf.item.kind),
        firstFind: finish(fromShelf.item.kind).first === fromShelf.start,
        kept: true,
        onToggle: () => removeFromShelf(fromShelf.id),
        arrows: fromShelf.item.kind === "boomerang",
      }
    : week && weekItem
      ? {
          item: weekItem,
          described: describe(weekItem, week, zone, t, language),
          finish: finish(weekItem.kind),
          firstFind: finish(weekItem.kind).first === week.start,
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
  const found = LOST_ITEM_KINDS.filter((kind) => finish(kind).tier).length;
  /** A collection pin opens its week with that pin on show. */
  const openFind = (start: string, kind: LostItemKind) => {
    setWeekStart(start);
    setChosen({ start, kind });
    setView("week");
  };

  return (
    <Card className="min-w-0 gap-3 px-5 py-4" aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-[15px] font-semibold">
            {t("Kayıp Eşya Bürosu", "Lost and found")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {view === "collection"
              ? t(
                  "Panda’nın bulduğu her rozet; eksikler gri.",
                  "Every pin the panda has found; the missing ones are grey.",
                )
              : week?.start === week?.latest
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
        <div className="flex flex-wrap items-center gap-2">
          {view === "week" && week && (
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
          <div
            className="flex rounded-lg border p-0.5"
            role="group"
            aria-label={t("Görünüm", "View")}
          >
            <Button
              size="xs"
              variant={view === "week" ? "secondary" : "ghost"}
              aria-pressed={view === "week"}
              onClick={() => setView("week")}
            >
              {t("Hafta", "Week")}
            </Button>
            <Button
              size="xs"
              variant={view === "collection" ? "secondary" : "ghost"}
              aria-pressed={view === "collection"}
              onClick={() => setView("collection")}
            >
              {t("Koleksiyon", "Collection")}
              <span className="text-muted-foreground tabular-nums">
                {found}/{LOST_ITEM_KINDS.length}
              </span>
            </Button>
          </div>
        </div>
      </div>

      {view === "collection" ? (
        <Collection
          weeks={collection.weeks}
          reach={collection.reach}
          loading={collection.loading}
          onOpen={openFind}
        />
      ) : (
        <>
          {error && (
            <p role="alert" className="text-sm text-muted-foreground">
              <b>
                {t("Eşyalar alınamadı.", "Could not open the lost and found.")}
              </b>{" "}
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
                        <LostPin
                          kind={item.kind}
                          tier={finish(item.kind).tier}
                          tints={pinTints(item, accounts)}
                          size={22}
                        />
                        {look.title}
                      </Button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3 py-2">
              <PandaRig
                pose="curl"
                expression="closed"
                props={["z"]}
                size={48}
              />
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
                      onClick={() =>
                        setChosen(on ? undefined : { shelf: kept.id })
                      }
                      className={cn(
                        "grid w-16 justify-items-center gap-1 rounded-lg border px-1 py-1.5 text-[10px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        on ? "border-primary bg-muted" : "hover:bg-muted",
                      )}
                    >
                      <LostPin
                        kind={kept.item.kind}
                        tier={finish(kept.item.kind).tier}
                        tints={pinTints(kept.item, accounts)}
                        size={34}
                      />
                      <span className="sr-only">{look.title}, </span>
                      <span className="tabular-nums">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
