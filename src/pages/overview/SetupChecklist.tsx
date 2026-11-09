import { useState, type ReactNode } from "react";
import { Check, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  cliDetail,
  cliState,
  setupState,
  type SetupKey,
} from "@/lib/onboarding";
import { automationMode } from "../../../shared/automation-mode";
import { MODE_TITLE } from "../../features/AutomationControl";
import { intentHash, type Destination } from "@/app/routes";
import { cn } from "@/lib/utils";
import { CliSetupActions } from "../../features/CliSetup";
import { ClaudeAppActions } from "../../features/ClaudeAppSetup";

/** The rows the list shows: the two account steps read as one. */
type RowKey = Exclude<SetupKey, "first" | "second"> | "accounts";

interface Row {
  title: string;
  status: string;
  reason: string;
  action?: ReactNode;
}

/** Where the steps the user settled by hand are kept: "mode", "extension", "hidden". */
const STORAGE_KEY = "relay.setup.v1";

function loadSeen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    // No window (a static render) or unreadable storage: nothing settled yet.
  }
  return new Set();
}

/** The settled steps, kept across windows and restarts where storage allows. */
function useSeen(): [ReadonlySet<string>, (key: string) => void] {
  const [seen, setSeen] = useState(loadSeen);
  const add = (key: string) =>
    setSeen((current) => {
      const next = new Set(current).add(key);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Without storage the choice lasts until the window closes.
      }
      return next;
    });
  return [seen, add];
}

/**
 * "Set up Relay" on the Overview: what Relay needs before it can switch (the Claude app, Code,
 * the CLI when missing), then a first and a second account, when to switch, and on macOS the
 * optional browser extension. The prerequisites show their reasons at once; the later steps
 * open one at a time, after every required step before them. Gone once everything is settled,
 * or when hidden.
 */
export function SetupChecklist({ go }: { go?: (to: Destination) => void }) {
  const relay = useRelay();
  const { t } = useI18n();
  const [seen, settle] = useSeen();
  const { desktop, accounts, settings } = relay;
  const diagnostics = relay.data?.diagnostics;
  const fleet = relay.data?.fleet;
  const state = setupState({
    desktop,
    diagnostics,
    accounts,
    settings,
    quota: automationMode(settings, fleet) === "quota",
    seen,
  });
  if (!state || state.complete || seen.has("hidden")) return null;
  const open = (to: Destination) => (go ? go(to) : (window.location.hash = `#/${to}`));
  const add = () => {
    window.location.hash = intentHash("hesaplar", "ekle");
  };
  const met = (key: SetupKey) => !!state.steps.find((s) => s.key === key)?.met;
  const connected = accounts.filter((a) => !!a.desktop).length;
  const mode = automationMode(settings, fleet);
  const title = t("Relay’i kur", "Set up Relay");
  const rows: Record<RowKey, Row> = {
    desktop: {
      title: t("Claude uygulaması", "Claude app"),
      status: met("desktop") ? t("Bulundu", "Found") : t("Bulunamadı", "Not found"),
      reason: t(
        "Relay için Claude uygulaması gerekir.",
        "Relay needs the Claude app.",
      ),
      action: <ClaudeAppActions />,
    },
    cli: {
      title: "Claude Code CLI",
      status: cliDetail(cliState(diagnostics), diagnostics?.version, t),
      reason: t(
        "Limitleri okumak için gerekir. Claude uygulamasında Code’u açınca iner; inmezse resmi CLI’yi kur.",
        "Relay uses it to read the limits. Open Code in the Claude app to get it, or install the official CLI.",
      ),
      action: <CliSetupActions />,
    },
    code: {
      title: t("Code sekmesi açıldı", "Code tab opened"),
      status: met("code")
        ? t("Çalışma alanı bulundu", "Workspace found")
        : t("Henüz açılmadı", "Not opened yet"),
      reason: t(
        "Claude uygulamasında sol menüden Code’u bir kez aç.",
        "Open Code one time from the Claude app sidebar.",
      ),
      // Without the Claude app the first row already names the step.
      action: desktop?.available && (
        <Button
          variant="outline"
          size="sm"
          disabled={relay.desktopBusy}
          onClick={() =>
            void relay.action("open", () => relay.api.openCodeTab())
          }
        >
          {t("Code’u aç", "Open Code")}
        </Button>
      ),
    },
    accounts: {
      title: t("Hesaplarını ekle", "Add your accounts"),
      status: `${connected} / 2`,
      reason:
        connected === 0
          ? t(
              "Relay hesaplar arasında geçer, bu yüzden en az iki hesap gerekir. Yukarıdaki “Hesap ekle” bu Mac’te bulunan hesapları tek seferde ekler.",
              "Relay switches between accounts, so it needs at least two. “Add account” above adds the ones found on this Mac in one go.",
            )
          : t(
              "Bir hesap daha gerekiyor. Diğer Claude hesabınla giriş yap; Relay girişi kendisi kaydeder.",
              "One more account is needed. Sign in with your other Claude account; Relay saves it by itself.",
            ),
      // With no account yet the welcome card above holds the button; one offer is enough.
      action: connected > 0 && (
        <Button variant="outline" size="sm" onClick={add}>
          {t("Hesap ekle", "Add account")}
        </Button>
      ),
    },
    mode: {
      title: t("Ne zaman geçileceğini seç", "Choose when to switch"),
      status: met("mode") ? t(...MODE_TITLE[mode]) : t("Seçilmedi", "Not chosen"),
      reason: t(
        "Kendin mi geçeceksin, yoksa limit dolunca Relay mi geçsin?",
        "Do you switch yourself, or does Relay switch when the limit is reached?",
      ),
      action: (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            settle("mode");
            open("ayarlar/gecis");
          }}
        >
          {t("Seç", "Choose")}
        </Button>
      ),
    },
    extension: {
      title: t("Tarayıcı eklentisi de geçsin", "Let the browser extension switch too"),
      status: met("extension")
        ? t("Açık", "On")
        : seen.has("extension")
          ? t("Atlandı", "Skipped")
          : t("İsteğe bağlı", "Optional"),
      reason: t(
        "Claude in Chrome kullanıyorsan eklenti Claude uygulamasıyla aynı hesapta olmalı.",
        "If you use Claude in Chrome, the extension must be on the same account as the Claude app.",
      ),
      action: (
        <span className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => open("ayarlar/gecis")}>
            {t("Ayarla", "Set up")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => settle("extension")}>
            {t("Atla", "Skip")}
          </Button>
        </span>
      ),
    },
  };
  // The two account steps are one row: met once the second account is there.
  type Step = { key: RowKey; met: boolean; optional: boolean };
  const steps: Step[] = state.steps.flatMap((step): Step[] =>
    step.key === "first" ? [] : [{ ...step, key: step.key === "second" ? "accounts" : step.key }],
  );
  const settled = (s: (typeof steps)[number]) => s.met || (s.optional && seen.has(s.key));
  const finished = steps.filter(settled);
  const pending = steps.filter((s) => !settled(s));
  const prerequisite = (key: RowKey) => key === "desktop" || key === "code" || key === "cli";
  // Prerequisites show their reasons at once; the later steps open one at a time, in order.
  const current = pending.find((s) => !prerequisite(s.key))?.key;
  const blocked = pending.some((s) => prerequisite(s.key) && !s.optional);
  return (
    <Card className="gap-0 px-4 py-3" role="region" aria-label={title}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {`${finished.length} / ${steps.length}`}
          {state.ready && (
            <Button variant="ghost" size="xs" onClick={() => settle("hidden")}>
              {t("Gizle", "Hide")}
            </Button>
          )}
        </span>
      </div>
      <ul>
        {finished.length > 0 && (
          <li data-step="done" className="flex items-start gap-2.5 py-2 text-sm text-muted-foreground">
            <Check aria-hidden="true" className="mt-px size-4 shrink-0 text-ok-foreground" />
            <span className="min-w-0">
              <span className="sr-only">{t("Tamam: ", "Done: ")}</span>
              {finished.map((s) => rows[s.key].title).join(" · ")}
            </span>
          </li>
        )}
        {pending.map(({ key, optional }) => {
          const row = rows[key];
          const expanded = prerequisite(key) || (key === current && !blocked);
          return (
            <li
              key={key}
              data-step={key}
              data-met="false"
              className="flex items-start gap-2.5 border-t py-2 first:border-0"
            >
              {prerequisite(key) ? (
                <X aria-hidden="true" className="mt-px size-4 shrink-0 text-crit" />
              ) : (
                <Circle
                  aria-hidden="true"
                  className={cn("mt-px size-4 shrink-0", expanded ? "text-foreground" : "text-muted-foreground/50")}
                />
              )}
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className={cn("font-semibold", !expanded && "font-normal text-muted-foreground")}>
                    {row.title}
                  </span>
                  <span className="sr-only">{optional ? t("İsteğe bağlı", "Optional") : t("Eksik", "Missing")}</span>
                  <span className="text-xs text-muted-foreground">{row.status}</span>
                </div>
                {expanded && (
                  <>
                    <p className="text-xs text-muted-foreground">{row.reason}</p>
                    {row.action && <div>{row.action}</div>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
