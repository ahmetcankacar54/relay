import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link2, Plus, Search } from "lucide-react";
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
import { PageFrame } from "@/app/PageFrame";
import { routeHash, routeQuery } from "@/app/routes";
import { AccountsTable } from "./accounts/AccountsTable";
import {
  AccountDetail,
  accountFromHash,
  accountHash,
} from "./accounts/AccountDetail";
import { AddAccountDialog } from "./accounts/AddAccountDialog";
import { LinkDesktopDialog } from "./accounts/LinkDesktopDialog";
import { filterAccounts, type AccountFilter } from "./accounts/accountLabels";
import { blockReason, type Block } from "@/lib/onboarding";

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
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
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
      const intent = routeQuery(window.location.hash);
      if (!intent) return;
      if (intentAllowed(intent, guardsRef.current)) {
        if (intent === "ekle") setAdding(true);
        else setLinking(true);
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
  };
  const visible = filterAccounts(accounts, query, filter, language);
  const linked = accounts.filter((a) => a.desktop).length;
  const account = accounts.find((a) => a.id === selected);
  const dialogs = (
    <>
      <AddAccountDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
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
    </>
  );
  if (account)
    return (
      <>
        <AccountDetail
          key={account.id}
          account={account}
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
      description={t(
        `${accounts.length} hesap · ${linked} hesapta Claude uygulaması girişi kayıtlı`,
        `${accounts.length} accounts · ${linked} with a saved Claude app sign-in`,
      )}
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
            <Plus />
            {t("Hesap ekle", "Add account")}
          </Button>
          {addBlock && <Reason>{blockReason(addBlock, t)}</Reason>}
        </>
      }
    >
      <div className="grid gap-3 px-6 pb-6">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={search}
              aria-label={t("Hesap ara", "Search accounts")}
              placeholder={t(
                "Hesap, e-posta veya grup ara…",
                "Search accounts, email or group…",
              )}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pr-12 pl-8"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
              ⌘K
            </kbd>
          </div>
          <Select
            value={filter}
            onValueChange={(v) => setFilter(v as AccountFilter)}
          >
            <SelectTrigger
              aria-label={t("Hesap filtresi", "Filter accounts")}
              className="w-40"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Tümü", "All accounts")}</SelectItem>
              <SelectItem value="connected">
                {t("Claude uygulaması kayıtlı", "Claude app saved")}
              </SelectItem>
              <SelectItem value="personal">
                {t("Kişisel", "Personal")}
              </SelectItem>
              <SelectItem value="work">{t("Şirket", "Work")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {visible.length ? (
          <AccountsTable
            accounts={visible}
            open={setSelected}
            link={(id) => {
              setSetupId(id);
              relay.cancelDesktopRequest();
              setSelected(id);
            }}
          />
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
      </div>
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
    <div className="grid justify-items-center gap-1.5 rounded-xl border border-dashed px-6 py-10 text-center">
      <Panda scene={hasAccounts ? "lookout" : "welcome"} size={72} playful />
      <h3 className="font-semibold break-words">
        {searched
          ? t(`“${searched}” ile eşleşen hesap yok`, `No accounts match “${searched}”`)
          : hasAccounts
            ? t("Eşleşen hesap yok", "No matching accounts")
            : t("Tek panel. Tüm hesapların.", "One panel. All your accounts.")}
      </h3>
      {searched && clearQuery ? (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={clearQuery}>
          {t("Aramayı temizle", "Clear search")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {hasAccounts
            ? t("Aramayı veya filtreyi değiştir.", "Try a different search or filter.")
            : t(
                "Önce Claude uygulamasında açık hesabını kaydet; ardından diğerlerini ekle.",
                "Save the account open in the Claude app, then add your other accounts.",
              )}
        </p>
      )}
    </div>
  );
}
