import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LostFoundWeek, LostItem } from "../../../shared/lost-found";
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

/** "Çarşamba 09:56" / "Wednesday 09:56" in the planning zone. */
function formatWhen(iso: string, zone: string, language: Language) {
  return new Intl.DateTimeFormat(locale(language), {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(new Date(iso));
}

/** "12–18 Eki" within a month, "29 Eyl – 5 Eki" across two. */
export function weekLabel(start: string, end: string, language: Language) {
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${Number(start.slice(8))}–${formatDay(end, language)}`
    : `${formatDay(start, language)} – ${formatDay(end, language)}`;
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

/** Every item's words, in the page's language; every Turkish line keeps suffixes off numbers and names. */
export function describe(
  item: LostItem,
  week: { start: string; end: string },
  zone: string,
  t: T,
  language: Language,
): Described {
  const pick = (c: Copy) => (language === "tr" ? c[0] : c[1]);
  switch (item.kind) {
    case "hourglass": {
      const took = formatDuration(item.minutes * 60_000, language);
      return {
        emoji: "⏳",
        title: t("Kum saati", "Hourglass"),
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
        emoji: "🪃",
        title: t("Bumerang", "Boomerang"),
        story: t(
          `Başladığın hesaba ${item.minutes} dakika içinde geri döndün.`,
          `You were back on the account you started with within ${item.minutes} minutes.`,
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
        emoji: "🏆",
        title: t("Rekor kupası", "Trophy"),
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
        emoji: "📜",
        title: t("Uzun parşömen", "Long scroll"),
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
        emoji: "🧣",
        title: t(`${word[0]} renkli atkı`, `${word[1]}-colour scarf`),
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
      const together: Copy =
        item.gapMinutes === 0
          ? [
              "İki hesabın 5 saatlik dönemi aynı anda yenilendi.",
              "Two accounts’ five-hour windows reset at the same moment.",
            ]
          : [
              `İki hesabın 5 saatlik dönemi ${item.gapMinutes} dakika arayla yenilendi.`,
              `Two accounts’ five-hour windows reset ${item.gapMinutes} minutes apart.`,
            ];
      const again: Copy =
        item.count > 1
          ? [
              ` Bu hafta ${item.count} kez oldu.`,
              ` It happened ${item.count} times that week.`,
            ]
          : ["", ""];
      return {
        emoji: "⏰",
        title: t("Çift çalar saat", "Twin alarm clocks"),
        story: pick([together[0] + again[0], together[1] + again[1]]),
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
        emoji: "🛞",
        title: t("Yedek lastik", "Spare tyre"),
        story: t(
          `${many ? "Bazı hesaplar" : "Bir hesap"} bütün hafta kenarda bekledi; bu arada ${item.hits} kez limite takıldın.`,
          `${many ? "Some accounts" : "An account"} sat out the whole week while you hit a limit ${item.hits} ${item.hits === 1 ? "time" : "times"}.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: item.accountIds,
        quip: t("Bagajdaydı, kimse bakmadı.", "It was in the boot all along."),
      };
    }
    case "feather": {
      const from = formatWhen(item.at, zone, language);
      const to = new Intl.DateTimeFormat(locale(language), {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      }).format(new Date(Date.parse(item.at) + 3_600_000));
      return {
        emoji: "🪶",
        title: t("Gece kuşu tüyü", "Night owl feather"),
        story: t(
          `Gece yarısından sonra ${item.hours} saat çalıştın.`,
          `You worked ${item.hours} ${item.hours === 1 ? "hour" : "hours"} after midnight.`,
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

/** The item on show: its picture in the drawer with the panda behind it, its story and the shelf button. */
function Showcase({
  described,
  accounts,
  names,
  label,
  kept,
  onKeep,
  onRemove,
  arrows,
}: {
  described: Described;
  accounts: Account[];
  names?: Record<string, string>;
  /** Where the item comes from, when it is not the open week: "Raftan · 12–18 Eki". */
  label?: string;
  kept: boolean;
  onKeep?: () => void;
  onRemove?: () => void;
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
        <span role="img" aria-label={described.title}>
          {described.emoji}
        </span>
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
        <div className="mt-3 flex gap-2">
          {kept
            ? onRemove && (
                <Button size="xs" variant="ghost" onClick={onRemove}>
                  {t("Raftan kaldır", "Take off the shelf")}
                </Button>
              )
            : onKeep && (
                <Button size="xs" variant="outline" onClick={onKeep}>
                  {t("Rafa koy", "Keep on the shelf")}
                </Button>
              )}
          {kept && !onRemove && (
            <span className="text-xs text-muted-foreground">
              {t("Rafta", "On the shelf")}
            </span>
          )}
        </div>
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
  /** What is on show: one of the open week's finds, or a kept one. */
  const [chosen, setChosen] = useState<
    { kind: LostItem["kind"] } | { shelf: string }
  >();

  const fromShelf =
    chosen && "shelf" in chosen
      ? shelf.find((kept) => kept.id === chosen.shelf)
      : undefined;
  const weekItem =
    week &&
    (week.items.find(
      (item) => chosen && "kind" in chosen && item.kind === chosen.kind,
    ) ??
      week.items[0]);
  const keepCurrent = (item: LostItem) => {
    if (!week) return;
    const ids = describe(item, week, zone, t, language).accounts;
    keepOnShelf({
      id: shelfId(week.start, item.kind),
      start: week.start,
      end: week.end,
      item,
      names: Object.fromEntries(
        ids.flatMap((id) => {
          const account = accounts.find((a) => a.id === id);
          return account ? [[id, account.name]] : [];
        }),
      ),
    });
  };
  const open = (start: string) => {
    setChosen(undefined);
    setWeekStart(start);
  };
  const step = (days: number) => {
    if (!week) return;
    const next = new Date(
      Date.parse(`${week.start}T12:00:00Z`) + days * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    open(next);
  };
  const isLatest = week ? week.start === week.latest : true;

  return (
    <Card className="min-w-0 gap-3 px-5 py-4" aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-[15px] font-semibold">
            {t("Kayıp Eşya Bürosu", "Lost and found")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {isLatest
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
              disabled={week.start <= week.oldest}
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

      {error && !week ? (
        <p className="text-sm text-muted-foreground">
          <b>{t("Eşyalar alınamadı.", "Could not open the lost and found.")}</b>{" "}
          {error}
        </p>
      ) : !week ? (
        <p className="text-sm text-muted-foreground">
          {t("Çekmece açılıyor", "Opening the drawer")}
        </p>
      ) : fromShelf ? (
        <Showcase
          described={describe(fromShelf.item, fromShelf, zone, t, language)}
          accounts={accounts}
          names={fromShelf.names}
          label={t(
            `Raftan · ${weekLabel(fromShelf.start, fromShelf.end, "tr")}`,
            `From the shelf · ${weekLabel(fromShelf.start, fromShelf.end, "en")}`,
          )}
          kept
          onRemove={() => {
            removeFromShelf(fromShelf.id);
            setChosen(undefined);
          }}
          arrows={fromShelf.item.kind === "boomerang"}
        />
      ) : weekItem ? (
        <>
          <Showcase
            described={describe(weekItem, week, zone, t, language)}
            accounts={accounts}
            kept={shelf.some(
              (kept) => kept.id === shelfId(week.start, weekItem.kind),
            )}
            onKeep={() => keepCurrent(weekItem)}
            arrows={weekItem.kind === "boomerang"}
          />
          {week.items.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
              <span className="mr-1 text-xs text-muted-foreground">
                {t("Aynı haftadan:", "Same week:")}
              </span>
              {week.items.map((item) => {
                const d = describe(item, week, zone, t, language);
                const on = item.kind === weekItem.kind;
                return (
                  <Button
                    key={item.kind}
                    size="xs"
                    variant={on ? "secondary" : "ghost"}
                    aria-pressed={on}
                    onClick={() => setChosen({ kind: item.kind })}
                  >
                    <span aria-hidden="true">{d.emoji}</span>
                    {d.title}
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
              const d = describe(kept.item, kept, zone, t, language);
              const on = fromShelf?.id === kept.id;
              return (
                <button
                  key={kept.id}
                  type="button"
                  aria-pressed={on}
                  title={`${d.title} · ${weekLabel(kept.start, kept.end, language)}`}
                  onClick={() => setChosen(on ? undefined : { shelf: kept.id })}
                  className={cn(
                    "grid w-16 justify-items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[10px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    on ? "border-primary bg-muted" : "hover:bg-muted",
                  )}
                >
                  <span aria-hidden="true" className="text-xl leading-none">
                    {d.emoji}
                  </span>
                  <span className="sr-only">{d.title}, </span>
                  <span className="tabular-nums">
                    {weekLabel(kept.start, kept.end, language)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
