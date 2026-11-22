import { useEffect, useState } from "react";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import type { ProxyStatus } from "../../../shared/types";

export type ProxyTab = "canli" | "araclar" | "kurallar";

/** How often the live counters and quotas are read while the page is open. */
const POLL_MS = 3_000;
/** Reads that fail in a row before the page stops showing the last state it read. */
const UNREADABLE_AFTER = 3;
const COPIED_MS = 1_500;
const TAB_KEY = "relay.proxy.tab";

/**
 * The gateway's state, read on mount and every few seconds; an action's answer replaces it at once.
 * `unreadable` turns on after a few failed reads in a row, so the page stops showing a stale state.
 */
export function useProxyStatus() {
  const { api, desktop } = useRelay();
  const [status, setStatus] = useState<ProxyStatus | undefined>(desktop?.proxyStatus);
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    let live = true;
    // A failed read keeps the last state on screen until it fails UNREADABLE_AFTER times in a row.
    const load = () =>
      void api.proxyStatus().then(
        (next) => {
          if (!live) return;
          setStatus(next);
          setFailures(0);
        },
        () => live && setFailures((n) => n + 1),
      );
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  const update = (next: ProxyStatus) => {
    setStatus(next);
    setFailures(0);
  };
  return { status, setStatus: update, unreadable: failures >= UNREADABLE_AFTER };
}

/** The tab last open, remembered per viewer where storage allows. */
export function useTab(): [ProxyTab, (tab: ProxyTab) => void] {
  const [tab, setTab] = useState<ProxyTab>(() => {
    try {
      const saved = window.localStorage.getItem(TAB_KEY);
      if (saved === "canli" || saved === "araclar" || saved === "kurallar") return saved;
    } catch {
      // No storage (a static render): the live tab.
    }
    return "canli";
  });
  const choose = (next: ProxyTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // The choice lasts until the window closes.
    }
  };
  return [tab, choose];
}

/** What `useCopy` hands to the chips and blocks: the id copied last, and the copy action. */
export interface Copy {
  copied?: string;
  copy: (id: string, text: string) => void;
}

/** Copy a value with a short "Copied" acknowledgement; main writes the clipboard. */
export function useCopy(): Copy {
  const { api, setNotice } = useRelay();
  const { t } = useI18n();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (id: string, text: string) =>
    void api.copyText(text).then(
      () => setCopied(id),
      // Said, never swallowed: a Copy that does nothing looks like a broken button.
      () => setNotice(t("hooks.couldNotCopyToTheClipboard")),
    );
  return { copied, copy };
}
