import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Link2 } from "lucide-react";
import { PlusIcon, SearchIcon } from "@/components/icons";
import { Panda } from "@/components/Panda";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { macWording, usePlatform } from "@/data/platform";
import { ListSkeleton } from "@/components/ListCard";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { parseIntent, routeHash, routeQuery, type AddProvider } from "@/app/routes";
import { AccountsTable } from "./accounts/AccountsTable";
import {
  AccountDetail,
  accountFromHash,
  accountHash,
} from "./accounts/AccountDetail";
import { AddAccountDialog } from "./accounts/AddAccountDialog";
import { LinkDesktopDialog } from "./accounts/LinkDesktopDialog";
import { RemoveAccountDialog } from "./accounts/RemoveAccountDialog";
import { EditAccountDialog } from "./accounts/EditAccountDialog";
import {
  filterAccounts,
  providerCounts,
  providerShortLabel,
  type AccountFilter,
  type ProviderFilter,
} from "./accounts/accountLabels";
import {
  ACCOUNTS_VIEW_KEYS,
  readAccountsView,
  type AccountGroupBy,
  type AccountsView,
  type AccountSort,
} from "./accounts/accountGroups";
import { blockReason, type Block } from "@/lib/onboarding";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type IntentGuards = {
  busy: boolean;
  pending: boolean;
  recovery: boolean;
  count: number;
  unclaimed: boolean;
  unlinked: boolean;
};
/** Why the add / link header button is disabled; undefined while it is enabled. */
export function intentBlock(
  intent: "ekle" | "eslestir",
  g: IntentGuards,
): Block | undefined {
  if (g.recovery) return "recovery";
  if (g.pending) return "pending";
  if (g.busy) return "busy";
  if (intent === "ekle") return g.count < 50 ? undefined : "limit";
  return g.unlinked ? undefined : "all-linked";
}

/** Whether a `?ekle` / `?eslestir` intent may open its dialog; mirrors the header buttons. */
export function intentAllowed(intent: string, g: IntentGuards): boolean {
  if (intent === "ekle") return !intentBlock(intent, g);
  if (intent === "eslestir") return g.unclaimed && !intentBlock(intent, g);
  return false;
}

/**
 * Effect that forgets the global setup target when the Accounts page closes, so a
 * stale setup can’t reopen the sheet on a later visit. `get` returns the current
 * setter. The clear is deferred so StrictMode’s immediate re-mount keeps it.
 */
export function forgetSetupOnLeave(
  get: () => (id: string | undefined) => void,
  defer: (fn: () => void) => void = queueMicrotask,
) {
  let mounted = 0;
  return () => {
    mounted++;
    return () => {
      mounted--;
      defer(() => {
        if (!mounted) get()(undefined);
      });
    };
  };
}

export function Accounts() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    accounts,
    desktop,
    desktopBusy,
    pendingDesktop,
    setupId,
    setSetupId,
  } = relay;
  const unlinked = accounts.some((a) => !a.desktop);
  const guards: IntentGuards = {
    busy: desktopBusy,
    pending: !!pendingDesktop,
    recovery: !!desktop?.recoveryRequired,
    count: accounts.length,
    unclaimed: relay.hasUnclaimedDesktop,
    unlinked,
  };
  const addBlock = intentBlock("ekle", guards);
  const linkBlock = intentBlock("eslestir", guards);
  const guardsRef = useRef(guards);
  guardsRef.current = guards;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [view, setViewState] = useState<AccountsView>(() => readAccountsView((key) => window.localStorage.getItem(key)));
  const setView = <K extends keyof AccountsView>(key: K, value: AccountsView[K]) => {
    setViewState((current) => ({ ...current, [key]: value }));
    try {
      window.localStorage.setItem(ACCOUNTS_VIEW_KEYS[key], typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      // Without storage the choice lasts until the window closes.
    }
  };
  const toggleSection = (key: string) =>
    setView("collapsed", view.collapsed.includes(key) ? view.collapsed.filter((k) => k !== key) : [...view.collapsed, key]);
  const mac = macWording(usePlatform());
  const [adding, setAdding] = useState(false);
  const [addProvider, setAddProvider] = useState<AddProvider>();
  const [linking, setLinking] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [editing, setEditing] = useState<string>();
  // The open account lives in the hash (`#/hesaplar/<id>`), so Back and the panel can reach it.
  const [selected, setSelectedState] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : accountFromHash(window.location.hash),
  );
  useEffect(() => {
    const read = () => setSelectedState(accountFromHash(window.location.hash));
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const setSelected = (id: string | undefined) => {
    const hash = id ? accountHash(id) : routeHash("hesaplar");
    if (window.location.hash !== hash) window.location.hash = hash;
    setSelectedState(id);
  };
  // An account removed elsewhere (the CLI, the panel) takes its open page with it.
  const known = relay.data?.accounts;
  useEffect(() => {
    if (selected && known && !known.some((a) => a.id === selected)) setSelected(undefined);
  }, [selected, known]);
  // A new page opens at its top; <main> is the scroller and outlives this one.
  useEffect(() => {
    document.querySelector("main")?.scrollTo?.(0, 0);
  }, [selected]);
  const search = useRef<HTMLInputElement>(null);
  const setSetupIdRef = useRef(setSetupId);
  setSetupIdRef.current = setSetupId;
  const [forgetSetup] = useState(() =>
    forgetSetupOnLeave(() => setSetupIdRef.current),
  );
  useEffect(forgetSetup, [forgetSetup]);
  // ⌘K focuses the account search while this page is open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // `#/hesaplar?ekle` and `#/hesaplar?eslestir` (Overview onboarding) open a dialog.
  useEffect(() => {
    const read = () => {
      const [intent, provider] = parseIntent(routeQuery(window.location.hash));
      if (!intent) return;
      if (intentAllowed(intent, guardsRef.current)) {
        if (intent === "ekle") {
          // `?ekle=codex` opens the dialog on Codex, never on another provider's sign-in.
          setAddProvider(provider);
          setAdding(true);
        } else setLinking(true);
      }
      history.replaceState(null, "", routeHash("hesaplar"));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  // Arriving with a setup target (e.g. "Claude uygulaması girişini kaydet" on Overview) opens that
  // account; the add dialog sets one too but keeps the setup inside the dialog.
  useEffect(() => {
    if (setupId && !adding) setSelected(setupId);
  }, [setupId]);
  const show = (id: string) => {
    setSelected(id);
    setQuery("");
    setFilter("all");
    setProvider("all");
  };
  const visible = filterAccounts(accounts, query, filter, language, provider);
  const counts = providerCounts(accounts);
  // A provider filter whose last account went away would leave an empty list with no way back.
  const providerGone = provider !== "all" && counts[provider] === 0;
  useEffect(() => {
    if (providerGone) setProvider("all");
  }, [providerGone]);
  const account = accounts.find((a) => a.id === selected);
  const dialogs = (
    <>
      <AddAccountDialog
        open={adding}
        provider={addProvider}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setAddProvider(undefined);
          // The dialog owns the new profile’s setup; don’t reopen it on the account page.
          if (!open) setSetupId(undefined);
        }}
      />
      <LinkDesktopDialog
        open={linking}
        onOpenChange={setLinking}
        picked={(id) => {
          setLinking(false);
          setSetupId(id);
          show(id);
        }}
      />
      <EditAccountDialog
        account={accounts.find((a) => a.id === editing)}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />
      <RemoveAccountDialog
        account={accounts.find((a) => a.id === removing)}
        close={() => setRemoving(undefined)}
        removed={(id) => {
          setRemoving(undefined);
          if (setupId === id) setSetupId(undefined);
          // Its page is gone with it: back to the list.
          if (selected === id) setSelected(undefined);
        }}
      />
    </>
  );
  if (account)
    return (
      <>
        <AccountDetail
          key={account.id}
          account={account}
          remove={setRemoving}
          edit={setEditing}
          back={() => {
            if (setupId && setupId === selected) setSetupId(undefined);
            setSelected(undefined);
          }}
        />
        {dialogs}
      </>
    );
  return (
    <PageFrame
      title={t("Hesaplar", "Accounts")}
      description={t(`${accounts.length} hesap`, `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`)}
      actions={
        <>
          {/* Linking needs a profile; with none, adding one links it in the dialog. */}
          {relay.hasUnclaimedDesktop && accounts.length > 0 && (
            <>
              <Button
                variant="outline"
                disabled={!!linkBlock}
                onClick={() => setLinking(true)}
              >
                <Link2 />
                {t("Claude uygulaması hesabını eşleştir", "Link Claude app account")}
              </Button>
              {/* A lock both buttons share is said once, after the second. */}
              {linkBlock && linkBlock !== addBlock && (
                <Reason>{blockReason(linkBlock, t)}</Reason>
              )}
            </>
          )}
          <Button
            disabled={!!addBlock}
            onClick={() => {
              setSetupId(undefined);
              setAdding(true);
            }}
          >
            <PlusIcon />
            {t("Hesap ekle", "Add account")}
          </Button>
          {addBlock && <Reason>{blockReason(addBlock, t)}</Reason>}
        </>
      }
    >
      <PageBody>
        {/* One toolbar: the provider filter on the left, search and the group filter on the right. */}
        <div className="flex flex-wrap items-center gap-2">
        {/* Only once accounts of more than one provider exist: a Claude-only list needs no filter. */}
          {Object.values(counts).filter(Boolean).length > 1 && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label={t("Sağlayıcıya göre filtrele", "Filter by provider")}
              data-slot="provider-filter"
              className="flex-wrap"
              value={provider}
              onValueChange={(v) => v && setProvider(v as ProviderFilter)}
            >
              {(
                [
                  ["all", t("Tümü", "All"), accounts.length],
                  ["claude", providerShortLabel("claude"), counts.claude],
                  ["codex", providerShortLabel("codex"), counts.codex],
                  ["antigravity", providerShortLabel("antigravity"), counts.antigravity],
                ] as const
              )
                .filter(([id, , count]) => id === "all" || count > 0)
                .map(([id, label, count]) => (
                  <ToggleGroupItem key={id} value={id}>
                    {id !== "all" && <ProviderLogo provider={id} size="sm" />}
                    {label}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </ToggleGroupItem>
                ))}
            </ToggleGroup>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-40 max-w-full">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={search}
                aria-label={t("Hesap ara", "Search accounts")}
                placeholder={t(
                  "Ara…",
                  "Search…",
                )}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={mac ? "pr-12 pl-8" : "pr-16 pl-8"}
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
                {mac ? "⌘K" : "Ctrl+K"}
              </kbd>
            </div>
          <Select
              value={filter}
              onValueChange={(v) => setFilter(v as AccountFilter)}
            >
              <SelectTrigger
                aria-label={t("Hesap filtresi", "Filter accounts")}
                className="w-28"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Tümü", "All accounts")}</SelectItem>
                <SelectItem value="connected">
                  {t("Claude uygulaması girişi kayıtlı", "Claude app sign-in saved")}
                </SelectItem>
                <SelectItem value="personal">
                  {t("Kişisel", "Personal")}
                </SelectItem>
                <SelectItem value="work">{t("Şirket", "Work")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={view.groupBy} onValueChange={(v) => setView("groupBy", v as AccountGroupBy)}>
              <SelectTrigger aria-label={t("Grupla", "Group by")} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="provider">{t("Sağlayıcı", "Provider")}</SelectItem>
                <SelectItem value="workGroup">{t("Çalışma grubu", "Work group")}</SelectItem>
                <SelectItem value="none">{t("Yok", "None")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={view.sort} onValueChange={(v) => setView("sort", v as AccountSort)}>
              <SelectTrigger aria-label={t("Sırala", "Sort")} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("Varsayılan", "Default")}</SelectItem>
                <SelectItem value="name">{t("Ad", "Name")}</SelectItem>
                <SelectItem value="usage">{t("5 saat kullanımı", "5-hour use")}</SelectItem>
                <SelectItem value="reset">{t("Sonraki yenileme", "Next reset")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {visible.length ? (
          <AccountsTable
            accounts={visible}
            groupBy={view.groupBy}
            sort={view.sort}
            // A search shows every match, closed sections included, without forgetting which were closed.
            collapsed={query.trim() ? [] : view.collapsed}
            toggle={toggleSection}
            open={setSelected}
            remove={setRemoving}
            edit={setEditing}
            link={(id) => {
              setSetupId(id);
              relay.cancelDesktopRequest();
              setSelected(id);
            }}
          />
        ) : relay.data === undefined ? (
          <ListSkeleton />
        ) : (
          <AccountsEmpty
            hasAccounts={accounts.length > 0}
            query={query}
            clearQuery={() => {
              setQuery("");
              search.current?.focus();
            }}
          />
        )}
      </PageBody>
      {dialogs}
    </PageFrame>
  );
}

/** Why the header button before it is disabled, next to it. */
function Reason({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-56 self-center text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The empty table: a greeting before any account, a lookout when a search or a filter hides them all.
 * A search that matches nothing is named, with a link that clears it.
 */
export function AccountsEmpty({
  hasAccounts,
  query = "",
  clearQuery,
}: {
  hasAccounts: boolean;
  query?: string;
  clearQuery?: () => void;
}) {
  const { t } = useI18n();
  const searched = hasAccounts ? query.trim() : "";
  return (
    <div className="grid justify-items-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center">
      <Panda scene={hasAccounts ? "lookout" : "welcome"} size={72} playful />
      <h3 className="font-semibold break-words">
        {searched
          ? t(`“${searched}” ile eşleşen hesap yok`, `No accounts match “${searched}”`)
          : hasAccounts
            ? t("Eşleşen hesap yok", "No accounts match the filter")
            : t("Henüz hesap yok", "No accounts yet")}
      </h3>
      {searched && clearQuery ? (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={clearQuery}>
          {t("Aramayı temizle", "Clear search")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {hasAccounts
            ? t("Aramayı veya filtreyi değiştir.", "Change the search or the filter.")
            : t(
                "Önce Claude uygulamasında açık hesabı ekle.",
                "Add the account open in the Claude app first.",
              )}
        </p>
      )}
    </div>
  );
}
