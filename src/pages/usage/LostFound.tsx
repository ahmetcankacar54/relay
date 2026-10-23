import { useRef, useState } from "react";
import {
  addDays,
  COMPASS_MIN_HOURS,
  HAMMOCK_MIN_DAYS,
  LANTERN_MIN_HOURS,
  SCALES_MAX_SPREAD,
  SCALES_MIN_HOURS,
  TIGHTROPE_MIN_PERCENT,
  nextTier,
  SCROLL_MIN_HOURS,
  SECRET_LOST_KINDS,
  tierOf,
  TROPHY_DAYS,
  LOST_ITEM_KINDS,
  LOST_TIERS,
  type LostItem,
  type LostItemKind,
  type LostTier,
} from "../../../shared/lost-found";
import type { Account } from "../../../shared/types";
import { Panda, PandaRig } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useCollection,
  type CollectionFinds,
  type KeptFind,
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
import { METALS, PLATINUM } from "./lost-pin-palette";
import { formatCount } from "./panda-facts";
import { formatCost, formatTokens } from "../../../shared/number-format";

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
    case "tightrope":
      return t("İp cambazı", "Tightrope");
    case "lantern":
      return t("Hafta sonu nöbeti", "Weekend watch");
    case "hammock":
      return t("Hamak molası", "Hammock break");
    case "scales":
      return t("Terazi", "Scales");
    case "chest":
      return t("Hazine sandığı", "Treasure chest");
    case "piggy":
      return t("Kumbara", "Piggy bank");
    case "fan":
      return t("Model yelpazesi", "Model fan");
  }
}

/** How a kind not found yet is earned, as the collection tells it; secret kinds keep it to themselves. */
export function hintOf(kind: LostItemKind, t: T): string {
  if (SECRET_LOST_KINDS.includes(kind))
    return t(
      "Gizli rozet. Panda ipucu vermiyor.",
      "A secret pin. The panda isn’t telling.",
    );
  return howToEarn(kind, t);
}

/** How a kind is earned, secret or not: what a found pin's details say. */
export function howToEarn(kind: LostItemKind, t: T): string {
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
    case "boomerang":
      return t(
        "Başka bir hesaba geç ve 15 dakika içinde ilk hesaba dön.",
        "Switch to another account and come back within 15 minutes.",
      );
    case "clocks":
      return t(
        "İki hesabın 5 saatlik dönemi en fazla 10 dakika arayla yenilensin.",
        "Have two accounts’ five-hour windows reset within 10 minutes of each other.",
      );
    case "tightrope":
      return t(
        `Bir 5 saatlik dönemi limite takılmadan en az %${TIGHTROPE_MIN_PERCENT} doldur.`,
        `Fill a five-hour window to ${TIGHTROPE_MIN_PERCENT}% or more without hitting its limit.`,
      );
    case "lantern":
      return t(
        `Bir hafta sonunun iki gününde de çalış, toplam en az ${LANTERN_MIN_HOURS} saat.`,
        `Work on both days of a weekend, ${LANTERN_MIN_HOURS} hours or more in all.`,
      );
    case "hammock":
      return t(
        `En az ${HAMMOCK_MIN_DAYS} gün çalıştığın bir haftada, iki iş gününün arasındaki bir günü tamamen boş bırak.`,
        `In a week of ${HAMMOCK_MIN_DAYS} or more working days, take a weekday fully off between two busy ones.`,
      );
    case "scales":
      return t(
        `En az ${SCALES_MIN_HOURS} saatlik bir haftada hesapların paylarını birbirine yakın tut: aralarında en fazla ${SCALES_MAX_SPREAD} puan.`,
        `In a week of ${SCALES_MIN_HOURS} hours or more, keep the accounts’ shares within ${SCALES_MAX_SPREAD} points of each other.`,
      );
    case "chest":
      return t(
        "Bir haftanın API karşılığı, önceki haftaların hepsini açık ara geçsin.",
        "Have a week whose API value clearly beats every week before it.",
      );
    case "piggy":
      return t(
        "Bir hesabın tek haftalık API karşılığı, planının aylık ücretini geçsin (Pro, Max 5x ya da Max 20x).",
        "Have one account’s API value in a week pass its plan’s monthly price (Pro, Max 5x or Max 20x).",
      );
    case "fan":
      return t(
        "Aynı hafta en az 3 model ailesiyle çalış (Opus, Sonnet, Haiku, Fable).",
        "Work with 3 or more model families in one week (Opus, Sonnet, Haiku, Fable).",
      );
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
  /** What the moment used, when the token ledger can tell. */
  spend?: string;
}

/** Every item's words, in the page's language; every Turkish line keeps suffixes off numbers, names and times. */
export function describe(
  item: LostItem,
  week: { start: string; end: string },
  zone: string,
  t: T,
  language: Language,
): Described {
  const told = describeMoment(item, week, zone, t, language);
  const spend = spendLine(item, language);
  return spend ? { ...told, spend } : told;
}

function describeMoment(
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
    case "tightrope":
      return {
        ...look,
        story: t(
          `Bir 5 saatlik dönem limite takılmadan %${item.percent} doluluğa ulaştı.`,
          `A five-hour window came ${item.percent}% full and never hit its limit.`,
        ),
        when: t(
          `Yenilendi: ${formatWhen(item.at, zone, language)}`,
          `Reset: ${formatWhen(item.at, zone, language)}`,
        ),
        accounts: item.accountId ? [item.accountId] : [],
        quip: t("Aşağı hiç bakmadım.", "I never looked down."),
      };
    case "lantern":
      return {
        ...look,
        story: t(
          `Cumartesi ve pazar toplam ${item.hours} saat çalıştın.`,
          `You worked ${item.hours} hours over Saturday and Sunday.`,
        ),
        when: weekLabel(addDays(week.start, 5), week.end, language),
        accounts: [],
        quip: t("Feneri ben tuttum.", "I held the lantern."),
      };
    case "hammock":
      return {
        ...look,
        story: t(
          `Haftanın ${item.activeDays} günü çalıştın; arada bir günü tamamen dinlenerek geçirdin.`,
          `You worked ${item.activeDays} days that week and took one whole day off in between.`,
        ),
        when: formatDayLong(item.date, language),
        accounts: [],
        quip: t("Ben de yanına uzandım.", "I lay down next to you."),
      };
    case "scales": {
      const n = item.accountIds.length;
      const word = COUNT_WORDS[n] ?? [String(n), String(n)];
      return {
        ...look,
        story: t(
          `Hafta boyunca ${n} hesap işi neredeyse eşit paylaştı: her biri %${item.low} ile %${item.high} arasında.`,
          `${word[1]} accounts shared the week almost evenly: each did ${item.low}–${item.high}%.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: item.accountIds,
        quip: t("Kefeler hiç sallanmadı.", "The pans never tipped."),
      };
    }
    case "chest": {
      const times = new Intl.NumberFormat(locale(language), {
        maximumFractionDigits: 1,
      }).format(item.times);
      return {
        ...look,
        story: t(
          `Haftanın API karşılığı ${formatCost(item.cost, language)}: önceki haftaların hepsinden yüksek, sıradan bir haftanın ${times} katı, ${formatCount(item.tokens, language)} token.`,
          `The week’s API value was ${formatCost(item.cost, language)}: higher than every week before it, ${times}× an ordinary one, ${formatCount(item.tokens, language)} tokens.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: [],
        quip: t("Sandığın kapağı zor kapandı.", "The lid barely closed."),
      };
    }
    case "piggy":
      return {
        ...look,
        story: t(
          `Bir hesabın o haftaki API karşılığı ${formatCost(item.cost, language)} oldu; planının aylık ücreti ${formatCost(item.price, language)}. Abonelik bedelini tek haftada çıkardı.`,
          `An account’s API value that week was ${formatCost(item.cost, language)}, against its plan’s ${formatCost(item.price, language)} a month: it paid for itself in a week.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: [item.accountId],
        quip: t("Kumbara ağırlaştı.", "The piggy bank got heavy."),
      };
    case "fan":
      return {
        ...look,
        story: t(
          `O hafta ${item.families.length} model ailesiyle çalıştın: ${item.families.join(", ")}.`,
          `That week you worked with ${item.families.length} model families: ${item.families.join(", ")}.`,
        ),
        when: weekLabel(week.start, week.end, language),
        accounts: [],
        quip: t("Her birine bir yaprak açtım.", "One fold for each."),
      };
  }
}

/** What a moment used, "12,4 Mn token · $38,20 API karşılığı"; undefined when the ledger cannot tell. */
export function spendLine(item: LostItem, language: Language) {
  if (!item.spend || item.kind === "chest" || item.kind === "piggy")
    return undefined;
  const tokens = formatTokens(item.spend.tokens, language);
  const cost = formatCost(item.spend.cost, language);
  return language === "tr"
    ? `${tokens} token · ${cost} API karşılığı`
    : `${tokens} tokens · ${cost} API value`;
}

/** Account chips: colour and name; a name the collection kept wins over a removed account. */
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
function pinTints(item: LostItem | undefined, accounts: Account[]) {
  const ids = item && "accountIds" in item ? item.accountIds : [];
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
  /** The newest. */
  last?: string;
}

export function finishOf(finds: KeptFind[] | undefined): Finish {
  const n = finds?.length ?? 0;
  return {
    weeks: n,
    tier: tierOf(n),
    first: finds?.[n - 1]?.start,
    last: finds?.[0]?.start,
  };
}

/** "4 hafta" / "4 weeks". */
const weeksLabel = (n: number, t: T) =>
  t(`${n} hafta`, `${n} ${n === 1 ? "week" : "weeks"}`);

/** "Gümüş · 4 hafta" / "Silver · 4 weeks". */
function finishLabel(finish: Finish, t: T) {
  if (!finish.tier) return "";
  return `${tierName(finish.tier, t)} · ${weeksLabel(finish.weeks, t)}`;
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

/** What a find did for its pin: earned it, raised its finish, or found it once more. */
function stepLabel(count: number, t: T) {
  if (count === 1) return t("Yeni rozet", "New pin");
  const raised = LOST_TIERS.find((step) => step.weeks === count);
  if (raised)
    return t(
      `${tierName(raised.tier, t)} seviyeye çıktı`,
      `Reached ${tierName(raised.tier, t).toLowerCase()}`,
    );
  return t(`${count}. kez bulundu`, `Found ${timesEn(count)}`);
}

/** The pins, grouped like an awards library. */
const CATEGORIES: { id: string; title: Copy; kinds: LostItemKind[] }[] = [
  {
    id: "pace",
    title: ["Tempo ve rekorlar", "Pace and records"],
    kinds: ["hourglass", "tightrope", "scroll", "compass"],
  },
  {
    id: "time",
    title: ["Gün ve saat", "Days and hours"],
    kinds: ["tally", "lantern", "hammock", "feather", "teaglass"],
  },
  {
    id: "accounts",
    title: ["Hesaplar arasında", "Across accounts"],
    kinds: ["baton", "boomerang", "scales", "scarf", "clocks", "spare"],
  },
  {
    id: "tokens",
    title: ["Token ve maliyet", "Tokens and cost"],
    kinds: ["trophy", "chest", "piggy", "fan"],
  },
];

/** A find's best-of value and its words; `lower` when less is better (a faster window, a shorter gap). */
export function recordOf(
  item: LostItem,
  t: T,
  language: Language,
): { value: number; lower?: boolean; label: string } {
  const hoursLabel = (n: number) =>
    t(`${n} saat`, `${n} ${n === 1 ? "hour" : "hours"}`);
  const minutesLabel = (n: number) =>
    n === 0 ? t("hemen", "at once") : t(`${n} dk`, `${n} min`);
  switch (item.kind) {
    case "hourglass":
      return {
        value: item.minutes,
        lower: true,
        label: formatDuration(item.minutes * 60_000, language),
      };
    case "baton":
    case "boomerang":
      return {
        value: item.minutes,
        lower: true,
        label: minutesLabel(item.minutes),
      };
    case "clocks":
      return {
        value: item.gapMinutes,
        lower: true,
        label:
          item.gapMinutes === 0
            ? t("aynı anda", "at the same moment")
            : t(`${item.gapMinutes} dk arayla`, `${item.gapMinutes} min apart`),
      };
    case "trophy":
      return {
        value: item.tokens,
        label: `${formatCount(item.tokens, language)} token`,
      };
    case "chest":
      return { value: item.cost, label: formatCost(item.cost, language) };
    case "piggy":
      return {
        value: item.cost / item.price,
        label: t(
          `${formatCost(item.cost, language)} / ${formatCost(item.price, language)}`,
          `${formatCost(item.cost, language)} of ${formatCost(item.price, language)}`,
        ),
      };
    case "tightrope":
      return { value: item.percent, label: `%${item.percent}` };
    case "scales":
      return {
        value: item.high - item.low,
        lower: true,
        label: t(
          `${item.high - item.low} puan fark`,
          `${item.high - item.low} points apart`,
        ),
      };
    case "scarf":
      return {
        value: item.accountIds.length,
        label: t(
          `${item.accountIds.length} hesap`,
          `${item.accountIds.length} accounts`,
        ),
      };
    case "fan":
      return {
        value: item.families.length,
        label: t(
          `${item.families.length} model ailesi`,
          `${item.families.length} model families`,
        ),
      };
    case "spare":
      return {
        value: item.hits,
        label: t(`${item.hits} limit`, `${item.hits} limits`),
      };
    case "hammock":
      return {
        value: item.activeDays,
        label: t(
          `${item.activeDays} aktif gün`,
          `${item.activeDays} active days`,
        ),
      };
    case "scroll":
    case "tally":
    case "compass":
    case "lantern":
    case "feather":
    case "teaglass":
      return { value: item.hours, label: hoursLabel(item.hours) };
  }
}

/** The find that holds a kind's record, among those that tell a story. */
export function recordFind(finds: KeptFind[], t: T, language: Language) {
  let best: { find: KeptFind; record: ReturnType<typeof recordOf> } | undefined;
  for (const find of finds) {
    if (!find.item) continue;
    const record = recordOf(find.item, t, language);
    if (
      !best ||
      (record.lower
        ? record.value < best.record.value
        : record.value > best.record.value)
    )
      best = { find, record };
  }
  return best;
}

/** How often a kind turns up in the weeks the panda can still see: "Nadir" below one week in five. */
export function rarityOf(
  finds: KeptFind[],
  reach: { latest: string; oldest: string } | undefined,
  t: T,
) {
  if (!reach || !finds.length) return undefined;
  const weeks =
    Math.round(
      (Date.parse(`${reach.latest}T12:00:00Z`) -
        Date.parse(`${reach.oldest}T12:00:00Z`)) /
        (7 * 86_400_000),
    ) + 1;
  const seen = finds.filter(
    (find) => find.start >= reach.oldest && find.start <= reach.latest,
  ).length;
  const share = seen / weeks;
  return {
    seen,
    weeks,
    label:
      share >= 0.5
        ? t("Sık", "Common")
        : share >= 0.2
          ? t("Ara sıra", "Now and then")
          : t("Nadir", "Rare"),
  };
}

/** The collection's milestones, the last of them platinum: every pin found. */
function milestones(finishes: { kind: LostItemKind; finish: Finish }[], t: T) {
  const found = (kind: LostItemKind) =>
    !!finishes.find((f) => f.kind === kind)?.finish.tier;
  return [
    {
      id: "first",
      label: t("İlk rozet", "First pin"),
      done: finishes.some(({ finish }) => finish.tier),
    },
    {
      id: "every-category",
      label: t("Her kategoriden bir rozet", "A pin in every category"),
      done: CATEGORIES.every((c) => c.kinds.some(found)),
    },
    {
      id: "first-gold",
      label: t("İlk altın", "First gold"),
      done: finishes.some(({ finish }) => finish.tier === "gold"),
    },
    {
      id: "category",
      label: t("Bir kategoriyi tamamla", "Complete a category"),
      done: CATEGORIES.some((c) => c.kinds.every(found)),
    },
    {
      id: "platinum",
      label: t("Platin: tüm rozetler", "Platinum: every pin"),
      done: finishes.every(({ finish }) => finish.tier),
    },
  ];
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

/** The collection's completion as a ring, the count inside it. */
function ProgressRing({ found, total }: { found: number; total: number }) {
  const { t } = useI18n();
  const r = 42;
  const length = 2 * Math.PI * r;
  const share = total ? found / total : 0;
  return (
    <div className="relative grid size-28 shrink-0 place-items-center">
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="9"
          className="stroke-muted"
        />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          className="stroke-primary transition-[stroke-dashoffset] motion-reduce:transition-none"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - share)}
        />
      </svg>
      <div
        className="text-center"
        role="img"
        aria-label={t(
          `${total} rozetten ${found} tanesi bulundu`,
          `${found} of ${total} pins found`,
        )}
      >
        <div className="font-display text-2xl leading-none font-semibold tabular-nums">
          {found}
          <span className="text-sm text-muted-foreground">/{total}</span>
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
          %{Math.round(share * 100)}
        </div>
      </div>
    </div>
  );
}

/** A small medal in a finish's metal, for counts and the tier ladder. */
function Medal({ tier, dim }: { tier: LostTier | "platinum"; dim?: boolean }) {
  const metal = tier === "platinum" ? PLATINUM : METALS[tier];
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("size-5 shrink-0", dim && "opacity-35 grayscale")}
      aria-hidden="true"
    >
      <circle cx="10" cy="10.6" r="8.6" fill={metal.edge} />
      <circle cx="10" cy="10" r="8.6" fill={metal.face} />
      <circle cx="10" cy="10" r="5.6" fill={metal.edge} opacity="0.35" />
      <path
        d="M10 5.6L11.3 8.5L14.4 8.8L12 10.8L12.8 13.9L10 12.3L7.2 13.9L8 10.8L5.6 8.8L8.7 8.5Z"
        fill={metal.light}
      />
    </svg>
  );
}

/** The top of the page: how much of the collection is found, by finish, with the panda collecting. */
function Overview({
  finishes,
}: {
  finishes: { kind: LostItemKind; finish: Finish }[];
}) {
  const { t } = useI18n();
  const found = finishes.filter(({ finish }) => finish.tier).length;
  const count = (tier: LostTier) =>
    finishes.filter(({ finish }) => finish.tier === tier).length;
  const steps = milestones(finishes, t);
  return (
    <Card
      className="min-w-0 flex-row flex-wrap items-center gap-5 px-5 py-4"
      data-slot="lost-overview"
    >
      <ProgressRing found={found} total={finishes.length} />
      <div className="min-w-0 flex-1 basis-56">
        <h3 className="font-display text-lg font-semibold">
          {t("Rozet koleksiyonu", "Pin collection")}
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t(
            "Panda her hafta kullanımından geriye kalan anları topluyor. Her an bir rozet; aynı rozeti tekrar buldukça seviyesi yükseliyor.",
            "Every week the panda collects the moments your use left behind. Each is a pin, and finding it again raises its finish.",
          )}
        </p>
        <ul
          className="mt-3 flex flex-wrap gap-2"
          aria-label={t("Seviyeler", "Finishes")}
        >
          {(["gold", "silver", "bronze"] as const).map((tier) => (
            <li
              key={tier}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            >
              <Medal tier={tier} />
              <span className="font-semibold tabular-nums">{count(tier)}</span>
              <span className="text-muted-foreground">{tierName(tier, t)}</span>
            </li>
          ))}
        </ul>
      </div>
      <Panda scene="collecting" size={96} playful className="hidden sm:block" />
      <div className="basis-full border-t pt-3" data-slot="lost-milestones">
        <div className="mb-2 flex items-baseline justify-between text-xs">
          <span className="font-semibold tracking-wider text-muted-foreground uppercase">
            {t("Kilometre taşları", "Milestones")}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {steps.filter((step) => step.done).length}/{steps.length}
          </span>
        </div>
        <ol className="flex flex-wrap gap-1.5">
          {steps.map((step) => (
            <li
              key={step.id}
              data-done={step.done}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                step.done
                  ? "bg-muted font-medium"
                  : "border-dashed text-muted-foreground",
              )}
            >
              {step.id === "platinum" ? (
                <Medal tier="platinum" dim={!step.done} />
              ) : (
                <span aria-hidden="true">{step.done ? "✓" : "○"}</span>
              )}
              {step.label}
              <span className="sr-only">
                {step.done
                  ? t(" (tamam)", " (done)")
                  : t(" (henüz değil)", " (not yet)")}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

/** A find as a row of the recent list or a pin's history: its pin, name, week and what it did for the pin. */
interface Recent {
  kind: LostItemKind;
  find: KeptFind;
  /** Its place among the kind's finds, oldest first. */
  count: number;
}

/** The newest finds, newest first; within a week the most striking first. */
function recentFinds(finds: CollectionFinds, limit: number): Recent[] {
  const all = LOST_ITEM_KINDS.flatMap((kind) => {
    const list = finds[kind] ?? [];
    return list.map((find, i) => ({ kind, find, count: list.length - i }));
  });
  const rank = (kind: LostItemKind) => LOST_ITEM_KINDS.indexOf(kind);
  return all
    .sort(
      (a, b) =>
        b.find.start.localeCompare(a.find.start) || rank(a.kind) - rank(b.kind),
    )
    .slice(0, limit);
}

/** The latest finds as a strip of cards, like a game's recently unlocked. */
function RecentStrip({
  recent,
  latest,
  accounts,
  onSelect,
}: {
  recent: Recent[];
  latest?: string;
  accounts: Account[];
  onSelect: (kind: LostItemKind) => void;
}) {
  const { t, language } = useI18n();
  return (
    <section
      aria-labelledby="lost-recent"
      className="grid gap-2"
      data-slot="lost-recent"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4
          id="lost-recent"
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {t("Son kazanılanlar", "Recently earned")}
        </h4>
        {recent.some(({ find }) => find.start === latest) && (
          <span className="text-[11px] text-muted-foreground">
            {t(
              "Vurgulananlar geçen haftadan",
              "Highlighted ones are from last week",
            )}
          </span>
        )}
      </div>
      {recent.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-2">
          {recent.map(({ kind, find, count }) => {
            const tier = tierOf(count);
            return (
              <li key={`${kind}-${find.start}`}>
                <button
                  type="button"
                  onClick={() => onSelect(kind)}
                  data-latest={find.start === latest || undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border bg-card p-2.5 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    find.start === latest && "border-primary/40 bg-primary/5",
                  )}
                >
                  <LostPin
                    kind={kind}
                    tier={tier}
                    tints={pinTints(find.item, accounts)}
                    size={52}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">
                      {kindTitle(kind, t)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {stepLabel(count, t)}
                    </span>
                    <span className="mt-0.5 block text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                      {weekLabel(find.start, find.end, language)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-dashed p-3">
          <PandaRig pose="curl" expression="closed" props={["z"]} size={44} />
          <p className="text-sm text-muted-foreground">
            {t(
              "Henüz rozet yok. Panda her pazartesi geçen haftaya bakar; ilk rozetin orada çıkacak.",
              "No pins yet. The panda looks back every Monday; your first pin will turn up there.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}

/** The pins nearest their next finish, so the page says what to aim for. */
function NextGoals({
  finishes,
  onSelect,
}: {
  finishes: { kind: LostItemKind; finish: Finish }[];
  onSelect: (kind: LostItemKind) => void;
}) {
  const { t } = useI18n();
  const goals = finishes
    .filter(({ finish }) => finish.tier && nextTier(finish.weeks))
    .sort(
      (a, b) =>
        nextTier(a.finish.weeks)!.weeks -
        a.finish.weeks -
        (nextTier(b.finish.weeks)!.weeks - b.finish.weeks),
    )
    .slice(0, 3);
  if (!goals.length) return null;
  return (
    <section
      aria-labelledby="lost-next"
      className="grid gap-2"
      data-slot="lost-next"
    >
      <h4
        id="lost-next"
        className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
      >
        {t("Sıradaki hedefler", "Up next")}
      </h4>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
        {goals.map(({ kind, finish }) => {
          const next = nextTier(finish.weeks)!;
          return (
            <li key={kind}>
              <button
                type="button"
                onClick={() => onSelect(kind)}
                className="grid w-full gap-1.5 rounded-xl border p-2.5 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="flex items-center gap-2">
                  <Medal tier={next.tier} />
                  <span className="truncate text-[13px] font-semibold">
                    {kindTitle(kind, t)}
                  </span>
                </span>
                <Meter
                  value={finish.weeks}
                  max={next.weeks}
                  label={nextLabel(finish, t)}
                  className="h-1"
                />
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {nextLabel(finish, t)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Filter = "all" | "earned" | "locked";

/** Every pin there is, by category, in a fixed album order; the filter narrows it to earned or locked ones. */
function Library({
  finishes,
  selected,
  onSelect,
}: {
  finishes: { kind: LostItemKind; finish: Finish }[];
  selected?: LostItemKind;
  onSelect: (kind: LostItemKind) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const byKind = new Map(finishes.map(({ kind, finish }) => [kind, finish]));
  const earned = finishes.filter(({ finish }) => finish.tier).length;
  const shows = (kind: LostItemKind) => {
    const found = !!byKind.get(kind)?.tier;
    return filter === "all" || (filter === "earned") === found;
  };
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: t("Tümü", "All"), count: finishes.length },
    { id: "earned", label: t("Kazanılan", "Earned"), count: earned },
    {
      id: "locked",
      label: t("Kilitli", "Locked"),
      count: finishes.length - earned,
    },
  ];
  return (
    <section
      aria-labelledby="lost-library"
      className="grid gap-3"
      data-slot="lost-library"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4
          id="lost-library"
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {t("Tüm rozetler", "All pins")}
        </h4>
        <div
          className="flex rounded-lg border p-0.5"
          role="group"
          aria-label={t("Göster", "Show")}
        >
          {filters.map(({ id, label, count }) => (
            <Button
              key={id}
              size="xs"
              variant={filter === id ? "secondary" : "ghost"}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
              <span className="text-muted-foreground tabular-nums">
                {count}
              </span>
            </Button>
          ))}
        </div>
      </div>
      {CATEGORIES.map((category) => {
        const kinds = category.kinds.filter(shows);
        if (!kinds.length) return null;
        const done = category.kinds.filter(
          (kind) => byKind.get(kind)?.tier,
        ).length;
        return (
          <div
            key={category.id}
            className="grid gap-2"
            data-category={category.id}
          >
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="font-semibold">{t(...category.title)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {done}/{category.kinds.length}
              </span>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
              {kinds.map((kind) => {
                const finish = byKind.get(kind)!;
                const sealed = !finish.tier && SECRET_LOST_KINDS.includes(kind);
                const on = kind === selected;
                return (
                  <li key={kind} data-kind={kind} data-found={!!finish.tier}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onSelect(kind)}
                      className={cn(
                        "flex h-full w-full flex-col items-center rounded-xl border px-2 pt-3 pb-2.5 text-center outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        !finish.tier && "border-dashed bg-muted/40",
                        on && "border-primary ring-1 ring-primary",
                      )}
                    >
                      <LostPin
                        kind={kind}
                        tier={finish.tier}
                        locked={!finish.tier}
                        sealed={sealed}
                        size={68}
                      />
                      <span className="mt-2 block text-[12.5px] leading-tight font-semibold">
                        {sealed
                          ? t("Gizli rozet", "Secret pin")
                          : kindTitle(kind, t)}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {finish.tier
                          ? finishLabel(finish, t)
                          : t("Kilitli", "Locked")}
                      </span>
                      {finish.tier && (
                        <Meter
                          value={finish.weeks}
                          max={nextTier(finish.weeks)?.weeks ?? finish.weeks}
                          label={nextLabel(finish, t)}
                          className="mt-2 h-1 w-full"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** The ladder of finishes, each with the weeks it takes and whether it is reached. */
function TierLadder({ finish }: { finish: Finish }) {
  const { t } = useI18n();
  return (
    <ol
      className="grid grid-cols-3 gap-1.5"
      aria-label={t("Seviyeler", "Finishes")}
    >
      {LOST_TIERS.map((step) => {
        const reached = finish.weeks >= step.weeks;
        return (
          <li
            key={step.tier}
            data-reached={reached}
            className={cn(
              "grid justify-items-center gap-1 rounded-lg border px-1.5 py-2 text-center",
              reached ? "bg-muted" : "border-dashed",
            )}
          >
            <Medal tier={step.tier} dim={!reached} />
            <span className="text-[11px] font-semibold">
              {tierName(step.tier, t)}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {reached
                ? `✓ ${weeksLabel(step.weeks, t)}`
                : weeksLabel(step.weeks, t)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** How many history rows show before "Tümünü göster". */
const HISTORY_ROWS = 4;

/**
 * The chosen pin in full, like a game's achievement page: its pin large, how it is earned, its finishes and every
 * week it was found in with what happened. A secret pin not found yet tells nothing.
 */
function Details({
  kind,
  finds,
  accounts,
  reach,
}: {
  kind: LostItemKind;
  finds: KeptFind[];
  accounts: Account[];
  reach?: { latest: string; oldest: string };
}) {
  const { t, language } = useI18n();
  const { settings } = useRelay();
  const zone = settings.planning.timeZone;
  const [all, setAll] = useState(false);
  const finish = finishOf(finds);
  const found = !!finish.tier;
  const sealed = !found && SECRET_LOST_KINDS.includes(kind);
  const latest = finds.find((find) => find.item);
  const latestStory = latest?.item
    ? describe(latest.item, latest, zone, t, language)
    : undefined;
  const rows = all ? finds : finds.slice(0, HISTORY_ROWS);
  const best = recordFind(finds, t, language);
  const rarity = rarityOf(finds, reach, t);
  return (
    <div className="grid gap-4" data-slot="lost-details" data-kind={kind}>
      <div className="grid justify-items-center gap-2 rounded-xl bg-muted/60 px-4 pt-5 pb-4 text-center">
        <LostPin
          kind={kind}
          tier={finish.tier}
          locked={!found}
          sealed={sealed}
          tints={pinTints(latest?.item, accounts)}
          size={148}
          shine
        />
        <h4 className="mt-1 font-display text-lg font-semibold">
          {sealed ? t("Gizli rozet", "Secret pin") : kindTitle(kind, t)}
        </h4>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs",
            found ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {found
            ? finishLabel(finish, t)
            : t("Henüz bulunmadı", "Not found yet")}
        </span>
      </div>
      <div className="grid gap-1">
        <div className="text-xs font-semibold text-muted-foreground">
          {t("Nasıl kazanılır", "How to earn it")}
        </div>
        <p className="text-sm">
          {found ? howToEarn(kind, t) : hintOf(kind, t)}
        </p>
      </div>
      {!sealed && (
        <div className="grid gap-2">
          <TierLadder finish={finish} />
          {found && (
            <p className="text-xs text-muted-foreground">
              {nextLabel(finish, t)}
            </p>
          )}
        </div>
      )}
      {found && (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border px-2.5 py-2">
            <dt className="text-muted-foreground">
              {t("İlk bulunduğu hafta", "First found")}
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {weekLabel(finish.first!, addDays(finish.first!, 6), language)}
            </dd>
          </div>
          <div className="rounded-lg border px-2.5 py-2">
            <dt className="text-muted-foreground">
              {t("Son bulunduğu hafta", "Last found")}
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {weekLabel(finish.last!, addDays(finish.last!, 6), language)}
            </dd>
          </div>
          {best && (
            <div
              className="rounded-lg border px-2.5 py-2"
              data-slot="lost-record"
            >
              <dt className="text-muted-foreground">
                {t("Kişisel rekor", "Personal best")}
              </dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {best.record.label}
              </dd>
              <dd className="text-[10px] text-muted-foreground tabular-nums">
                {weekLabel(best.find.start, best.find.end, language)}
              </dd>
            </div>
          )}
          {rarity && (
            <div
              className="rounded-lg border px-2.5 py-2"
              data-slot="lost-rarity"
            >
              <dt className="text-muted-foreground">
                {t("Sıklık", "How often")}
              </dt>
              <dd className="mt-0.5 font-semibold">{rarity.label}</dd>
              <dd className="text-[10px] text-muted-foreground tabular-nums">
                {t(
                  `Son ${rarity.weeks} haftada ${rarity.seen} kez`,
                  `${rarity.seen} of the last ${rarity.weeks} weeks`,
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {latestStory && (
        <p className="text-xs text-muted-foreground italic">
          <span className="sr-only">
            {t("Panda diyor ki: ", "The panda says: ")}
          </span>
          “{latestStory.quip}”
        </p>
      )}
      {found && (
        <section aria-labelledby="lost-history" className="grid gap-2">
          <h5
            id="lost-history"
            className="text-xs font-semibold text-muted-foreground"
          >
            {t("Geçmiş", "History")}
          </h5>
          <ol className="grid gap-2">
            {rows.map((find) => {
              const story = find.item
                ? describe(find.item, find, zone, t, language)
                : undefined;
              return (
                <li
                  key={find.start}
                  className="rounded-lg border px-3 py-2"
                  data-slot="lost-find"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-muted-foreground tabular-nums">
                    {weekLabel(find.start, find.end, language)}
                    {best &&
                      finds.length > 1 &&
                      best.find.start === find.start && (
                        <span className="rounded-full bg-primary/10 px-1.5 font-medium text-primary">
                          {t("Rekor", "Best")}
                        </span>
                      )}
                  </div>
                  {story ? (
                    <>
                      <p className="mt-0.5 text-[13px]">{story.story}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        {/* A week-long find's "when" is the row's own week. */}
                        {story.when !==
                          weekLabel(find.start, find.end, language) && (
                          <span>{story.when}</span>
                        )}
                        {story.when !==
                          weekLabel(find.start, find.end, language) &&
                          story.accounts.length > 0 && (
                            <span aria-hidden="true">·</span>
                          )}
                        <AccountChips
                          ids={story.accounts}
                          accounts={accounts}
                          names={find.names}
                          arrows={kind === "boomerang"}
                        />
                      </p>
                      {story.spend && (
                        <p
                          className="mt-1 text-[11px] text-muted-foreground tabular-nums"
                          data-slot="lost-spend"
                        >
                          {story.spend}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {t(
                        "Bu hafta bulundu; ayrıntısı eski bir sürümden kaldığı için yalnızca haftası biliniyor.",
                        "Found this week; it was kept by an older version, so only the week is known.",
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {finds.length > HISTORY_ROWS && (
            <Button
              size="xs"
              variant="ghost"
              className="justify-self-start"
              onClick={() => setAll(!all)}
            >
              {all
                ? t("Daha az göster", "Show fewer")
                : t(
                    `Tümünü göster (${finds.length})`,
                    `Show all (${finds.length})`,
                  )}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The panda's pin collection, laid out like a game's achievements page
 * (docs/superpowers/specs/2026-10-23-lost-found-collection-design.md): the overall progress, the latest finds, the
 * pins nearest their next finish, every pin by category, and the chosen pin's details with its whole history.
 */
export function LostFound() {
  const { accounts, api } = useRelay();
  const { t } = useI18n();
  const collection = useCollection(api, accounts);
  const finishes = LOST_ITEM_KINDS.map((kind) => ({
    kind,
    finish: finishOf(collection.finds[kind]),
  }));
  const recent = recentFinds(collection.finds, 4);
  const [chosen, setChosen] = useState<LostItemKind>();
  const selected = chosen ?? recent[0]?.kind ?? LOST_ITEM_KINDS[0];
  const details = useRef<HTMLDivElement>(null);
  const select = (kind: LostItemKind) => {
    setChosen(kind);
    // In a narrow window the details sit above the pins; bring them into view.
    details.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  };
  return (
    <div
      className="grid min-w-0 gap-4"
      aria-busy={collection.loading || undefined}
    >
      <Overview finishes={finishes} />
      <div className="@container min-w-0">
        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:items-start">
          <Card className="order-2 min-w-0 gap-5 px-5 py-4 @3xl:order-1">
            <RecentStrip
              recent={recent}
              latest={collection.reach?.latest}
              accounts={accounts}
              onSelect={select}
            />
            <NextGoals finishes={finishes} onSelect={select} />
            <Library
              finishes={finishes}
              selected={selected}
              onSelect={select}
            />
            <p className="text-[11px] text-muted-foreground">
              {collection.loading
                ? t(
                    "Panda haftaları tarıyor…",
                    "The panda is going through the weeks…",
                  )
                : t(
                    `Bir rozet bulunduğu ilk hafta bronz, ${LOST_TIERS[1].weeks} haftada gümüş, ${LOST_TIERS[2].weeks} haftada altın olur. Panda son 12 haftaya bakabilir; bulunan rozetler bu Mac’te kalır.`,
                    `A pin is bronze the first week it is found, silver after ${LOST_TIERS[1].weeks} weeks and gold after ${LOST_TIERS[2].weeks}. The panda can look back 12 weeks; found pins stay on this Mac.`,
                  )}
            </p>
          </Card>
          <Card
            ref={details}
            className="order-1 min-w-0 px-5 py-4 @3xl:sticky @3xl:top-4 @3xl:order-2"
          >
            <Details
              key={selected}
              kind={selected}
              finds={collection.finds[selected] ?? []}
              accounts={accounts}
              reach={collection.reach}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
