import { useEffect, useRef, useState } from "react";
import { Link2, Monitor, Plus, Search } from "lucide-react";
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
import { AccountSheet } from "./accounts/AccountSheet";
import { AddAccountDialog } from "./accounts/AddAccountDialog";
import { LinkDesktopDialog } from "./accounts/LinkDesktopDialog";
import { filterAccounts, type AccountFilter } from "./accounts/accountLabels";

export function Accounts() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { accounts, desktop, desktopBusy, pendingDesktop, setupId, setSetupId } =
    relay;
  const unlinked = accounts.some((a) => !a.desktop);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [selected, setSelected] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
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
      if (intent === "ekle") setAdding(true);
      else if (intent === "eslestir") setLinking(true);
      history.replaceState(null, "", routeHash("hesaplar"));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  // Arriving with a setup target (e.g. "Desktop’a bağla" on Overview) opens that
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
  return (
    <PageFrame
      title={t("Hesaplar", "Accounts")}
      description={t(
        `${accounts.length} hesap · ${linked}’i Desktop’a bağlı`,
        `${accounts.length} accounts · ${linked} linked to Desktop`,
      )}
      actions={
        <>
          {relay.hasUnclaimedDesktop && (
            <Button
              variant="outline"
              disabled={
                desktopBusy ||
                !!pendingDesktop ||
                !!desktop?.recoveryRequired ||
                !unlinked
              }
              onClick={() => setLinking(true)}
            >
              <Link2 />
              {t("Desktop hesabını eşleştir", "Link Desktop account")}
            </Button>
          )}
          <Button
            disabled={desktopBusy || !!pendingDesktop || accounts.length >= 50}
            onClick={() => {
              setSetupId(undefined);
              setAdding(true);
            }}
          >
            <Plus />
            {t("Hesap ekle", "Add account")}
          </Button>
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
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-muted-foreground">
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
                {t("Desktop bağlı", "Desktop connected")}
              </SelectItem>
              <SelectItem value="personal">{t("Kişisel", "Personal")}</SelectItem>
              <SelectItem value="work">{t("Şirket", "Work")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {visible.length ? (
          <AccountsTable
            accounts={visible}
            selected={account?.id}
            open={setSelected}
            link={(id) => {
              setSetupId(id);
              relay.cancelDesktopRequest();
              setSelected(id);
            }}
          />
        ) : (
          <div className="grid justify-items-center gap-1.5 rounded-xl border border-dashed px-6 py-10 text-center">
            <Monitor className="size-6 text-muted-foreground" />
            <h3 className="font-semibold">
              {accounts.length
                ? t("Eşleşen hesap yok", "No matching accounts")
                : t("Tek panel. Tüm hesapların.", "One panel. All your accounts.")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {accounts.length
                ? t(
                    "Aramayı veya filtreyi değiştir.",
                    "Try a different search or filter.",
                  )
                : t(
                    "Önce Claude’da açık hesabını kaydet; ardından diğerlerini ekle.",
                    "Save the account open in Claude, then add your other accounts.",
                  )}
            </p>
          </div>
        )}
      </div>
      <AddAccountDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          // The dialog owns the new profile’s setup; don’t reopen it in the sheet.
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
      <AccountSheet
        account={account}
        close={() => {
          if (setupId && setupId === selected) setSetupId(undefined);
          setSelected(undefined);
        }}
      />
    </PageFrame>
  );
}
