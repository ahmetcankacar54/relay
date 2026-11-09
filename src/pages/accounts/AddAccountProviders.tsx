import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Zap } from "lucide-react";
import type {
  AccountKind,
  AccountProvider,
  CascadeLayerStatus,
  DetectedProviderSession,
  OneClickCascadeResult,
  AntigravityOAuthStart,
} from "../../../shared/types";
import { ProviderBadge } from "@/components/ProviderBadge";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { errorMessage } from "@/data/error-message";
import { cn } from "@/lib/utils";

/** The providers an account can be added for, in the order the cards show them. */
export const ONBOARDING_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type OnboardingProvider = (typeof ONBOARDING_PROVIDERS)[number];

/** What each provider card says it connects, in the words of the onboarding cascade. */
const PROVIDER_CARDS: Record<OnboardingProvider, { title: string; sub: [string, string] }> = {
  claude: { title: "Anthropic Claude", sub: ["Claude uygulaması, terminal, eklenti ve proxy", "Claude app, terminal, extension and gateway"] },
  codex: { title: "OpenAI / Codex", sub: ["Codex CLI girişi ya da OpenAI API anahtarı · proxy", "Codex CLI sign-in or an OpenAI API key · gateway"] },
  antigravity: { title: "Google Antigravity", sub: ["Google ile giriş · proxy", "Google sign-in · gateway"] },
};

/** The suggested account name: `Kişisel · Claude`, `OpenAI · Codex`, `Google · Antigravity`. */
export function suggestAccountName(
  provider: AccountProvider,
  taken: readonly string[],
  t: T,
): string {
  const base =
    provider === "claude"
      ? t("Kişisel · Claude", "Personal · Claude")
      : provider === "codex"
        ? "OpenAI · Codex"
        : provider === "antigravity"
          ? "Google · Antigravity"
          : "Google · Gemini";
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** The local sessions found on this Mac, by provider; empty while they are read or in a build without discovery. */
export function useDetectedProviders(): Partial<Record<AccountProvider, DetectedProviderSession>> {
  const { api } = useRelay();
  const [found, setFound] = useState<Partial<Record<AccountProvider, DetectedProviderSession>>>({});
  useEffect(() => {
    let live = true;
    // A failed read only leaves the cards without a "Detected" badge.
    void api.detectProviders().then(
      (sessions) => {
        if (live) setFound(Object.fromEntries(sessions.map((s) => [s.provider, s])));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);
  return found;
}

/** Three cards, one per provider, each with a green “Detected” badge when a local session was found. */
export function ProviderCards({
  value,
  onChange,
  detected,
  disabled,
}: {
  value: AccountProvider;
  onChange: (provider: OnboardingProvider) => void;
  detected: Partial<Record<AccountProvider, DetectedProviderSession>>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      role="radiogroup"
      aria-label={t("Sağlayıcı", "Provider")}
      data-slot="provider-cards"
      className="grid gap-2 sm:grid-cols-3"
    >
      {ONBOARDING_PROVIDERS.map((provider) => {
        const session = detected[provider];
        const card = PROVIDER_CARDS[provider];
        const selected = value === provider;
        return (
          <button
            key={provider}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            data-provider={provider}
            onClick={() => onChange(provider)}
            className={cn(
              "grid content-start gap-1 rounded-lg border bg-card px-3 py-2.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60",
              selected && "border-primary bg-primary/5",
            )}
          >
            <span className="flex items-center justify-between gap-1.5">
              <span className="text-sm font-semibold">{card.title}</span>
              {selected && <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />}
            </span>
            <span className="text-2xs text-muted-foreground">{t(...card.sub)}</span>
            {session?.detected ? (
              <span data-slot="detected" className="mt-0.5 grid gap-0.5">
                <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-ok/15 px-1.5 py-px text-2xs font-semibold text-ok-foreground">
                  <StatusDot tone="ok" />
                  {t("Algılandı", "Detected")}
                </span>
                <span className="truncate text-2xs text-muted-foreground">
                  {session.email ?? session.source}
                </span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The four layers one click feeds, with what the click does, as a quiet banner. */
export function CascadeBanner() {
  const { t } = useI18n();
  const layers = [
    t("Desktop & İstemci", "Desktop & Client"),
    t("Limit & OAuth", "Usage & OAuth"),
    t("Terminal & CLI", "Terminal & CLI"),
    t("Chrome & Proxy", "Chrome & Proxy"),
  ];
  return (
    <div data-slot="cascade-banner" className="grid gap-2 rounded-lg border bg-muted/40 px-3 py-2.5">
      <ol aria-label={t("Bağlantı katmanları", "Connection layers")} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {layers.map((layer, i) => (
          <li key={layer} className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <span
              aria-hidden="true"
              className="grid size-4 shrink-0 place-items-center rounded-full bg-primary/15 text-2xs font-semibold tabular-nums text-primary"
            >
              {i + 1}
            </span>
            <span className="truncate">{layer}</span>
          </li>
        ))}
      </ol>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Zap aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-primary" />
        {t(
          "Relay kullanılabilir yerel kimlik bilgilerini içe aktarır; her katmanın gerçek durumunu bağlantıdan sonra gösterir.",
          "Relay imports usable local credentials and shows each layer’s actual state after setup.",
        )}
      </p>
    </div>
  );
}

export interface ConnectForm {
  name: string;
  kind: AccountKind;
  group: string;
  /** Codex only: an OpenAI API key. */
  apiKey: string;
}

/**
 * The fields every provider shares, and the ones Codex and Antigravity add. The name follows the
 * provider while it is empty or still the last suggestion; once the user types, it stays.
 */
export function useConnectForm(provider: AccountProvider, taken: readonly string[]) {
  const { t } = useI18n();
  const suggestion = suggestAccountName(provider, taken, t);
  const lastSuggestion = useRef(suggestion);
  const [form, setForm] = useState<ConnectForm>({
    name: suggestion,
    kind: "personal",
    group: "",
    apiKey: "",
  });
  useEffect(() => {
    // Read before the updater runs: it runs later, once `lastSuggestion` already holds the new one.
    const previous = lastSuggestion.current;
    lastSuggestion.current = suggestion;
    setForm((f) => (!f.name.trim() || f.name === previous ? { ...f, name: suggestion } : f));
  }, [suggestion]);
  return [form, setForm] as const;
}

/** Account name and type (and, for work, the sharing group). */
export function CommonFields({
  form,
  onChange,
  idPrefix,
}: {
  form: ConnectForm;
  onChange: (form: ConnectForm) => void;
  idPrefix: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{t("Hesap adı", "Account name")}</Label>
        <Input
          id={`${idPrefix}-name`}
          maxLength={64}
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label id={`${idPrefix}-kind`}>{t("Hesap türü", "Account type")}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-labelledby={`${idPrefix}-kind`}
          value={form.kind}
          onValueChange={(v) => v && onChange({ ...form, kind: v as AccountKind })}
          className="w-full"
        >
          <ToggleGroupItem value="personal" className="flex-1">
            {t("Kişisel", "Personal")}
          </ToggleGroupItem>
          <ToggleGroupItem value="work" className="flex-1">
            {t("İş", "Work")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {form.kind === "work" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-group`}>{t("Paylaşım grubu · isteğe bağlı", "Sharing group · optional")}</Label>
          <Input
            id={`${idPrefix}-group`}
            maxLength={64}
            value={form.group}
            placeholder={t("Örn. İş", "e.g. Work")}
            onChange={(e) => onChange({ ...form, group: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

const LAYER_WORDS: Record<CascadeLayerStatus, [string, string]> = {
  done: ["Tamam", "Done"],
  ready: ["Hazır", "Ready"],
  skipped: ["Atlandı", "Skipped"],
  pending: ["Bekliyor", "Waiting"],
};

/** What the click did to each of the four layers. */
export function CascadeResult({ result }: { result: OneClickCascadeResult }) {
  const { t } = useI18n();
  const rows: [string, CascadeLayerStatus][] = [
    [t("Desktop & İstemci", "Desktop & Client"), result.layers.desktop],
    [t("Limit & OAuth", "Usage & OAuth"), result.layers.usage],
    [t("Terminal & CLI", "Terminal & CLI"), result.layers.terminal],
    [t("Chrome & Proxy", "Chrome & Proxy"), result.layers.extensionAndProxy],
  ];
  return (
    <ul data-slot="cascade-result" className="grid gap-1.5">
      {rows.map(([label, status]) => (
        <li key={label} className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
          <StatusDot tone={status === "done" ? "ok" : status === "pending" ? "warn" : "off"} />
          <span className="min-w-0 flex-1">{label}</span>
          <span className="text-xs text-muted-foreground">{t(...LAYER_WORDS[status])}</span>
        </li>
      ))}
    </ul>
  );
}

/** Runs the one-click connection and reports its result; failures show through the relay's error. */
export function useOneClickConnect(onResult: (result: OneClickCascadeResult) => void) {
  const { api, action, busy } = useRelay();
  const connect = (provider: AccountProvider, form: ConnectForm) =>
    void action("one-click", async () => {
      const result = await api.oneClickConnect({
        provider,
        name: form.name.trim(),
        kind: form.kind,
        ...(form.kind === "work" && form.group.trim() ? { group: form.group.trim() } : {}),
        ...(provider === "codex" && form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      onResult(result);
    });
  return { connect, connecting: busy === "one-click", disabled: !!busy };
}

/** Claude's one-click panel, shown at the first step above the step-by-step button. */
export function ClaudeOneClick({
  form,
  onChange,
  session,
  onResult,
}: {
  form: ConnectForm;
  onChange: (form: ConnectForm) => void;
  session?: DetectedProviderSession;
  onResult: (result: OneClickCascadeResult) => void;
}) {
  const { t } = useI18n();
  const { connect, connecting, disabled } = useOneClickConnect(onResult);
  return (
    <div data-slot="claude-one-click" className="grid gap-3">
      {session?.detected && (
        <p
          data-slot="detected-session"
          className="rounded-lg border border-ok/40 bg-ok/5 px-3 py-2 text-sm"
        >
          {t("Yerel oturum algılandı", "Local session detected")}:{" "}
          <b className="font-semibold">{session.email ?? session.source}</b>
          {session.orgName ? ` · ${session.orgName}` : ""}
        </p>
      )}
      <CommonFields form={form} onChange={onChange} idPrefix="add-claude" />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled || !form.name.trim()} onClick={() => connect("claude", form)}>
          {connecting ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {t("Tek tıkla bağla", "Connect in one click")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("veya aşağıdan adım adım ekle", "or add it step by step below")}
        </span>
      </div>
    </div>
  );
}

/** Codex: the Codex CLI's sign-in, or an OpenAI API key that OpenAI accepts. */
export function ProviderForm({
  provider,
  form,
  onChange,
  session,
  onResult,
  close,
}: {
  provider: "codex";
  form: ConnectForm;
  onChange: (form: ConnectForm) => void;
  session?: DetectedProviderSession;
  onResult: (result: OneClickCascadeResult) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const { connect, connecting, disabled } = useOneClickConnect(onResult);
  const detected = !!session?.detected;
  const typed = !!form.apiKey.trim();
  // A detected sign-in that is already an account would only be refused; a typed key still works.
  const usable = typed || (detected && !session?.alreadyLinkedAccountName);
  const canConnect = !!form.name.trim() && usable;
  return (
    <form
      className="grid gap-3"
      data-provider={provider}
      onSubmit={(e) => {
        e.preventDefault();
        if (canConnect) connect(provider, form);
      }}
    >
      <RelayErrorAlert />
      {detected ? (
        <div data-slot="detected-session" className="grid gap-0.5 rounded-lg border border-ok/40 bg-ok/5 px-3 py-2 text-sm">
          <span>
            {t("Yerel oturum algılandı", "Local session detected")}:{" "}
            <b className="font-semibold">{session?.email ?? session?.source}</b>
          </span>
          <span className="text-xs text-muted-foreground">
            {[session?.plan, session?.source].filter(Boolean).join(" · ")}
          </span>
          {session?.alreadyLinkedAccountName && (
            <span className="text-xs text-warn-foreground">
              {t(
                `Bu oturum zaten “${session.alreadyLinkedAccountName}” olarak bağlı.`,
                `This session is already connected as “${session.alreadyLinkedAccountName}”.`,
              )}
            </span>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {t(
            "Bu Mac'te Codex CLI girişi bulunamadı. `codex login` ile giriş yap ya da bir OpenAI API anahtarı gir.",
            "No Codex CLI sign-in on this Mac. Sign in with `codex login`, or enter an OpenAI API key.",
          )}
        </p>
      )}
      <CommonFields form={form} onChange={onChange} idPrefix={`add-${provider}`} />
      <div className="grid gap-1.5">
          <Label htmlFor={`add-${provider}-key`}>
            {detected
              ? t("OpenAI API anahtarı · isteğe bağlı", "OpenAI API key · optional")
              : t("OpenAI API anahtarı", "OpenAI API key")}
          </Label>
          <Input
            id={`add-${provider}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            placeholder="sk-…"
            value={form.apiKey}
            onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {detected
              ? t(
                  "Boş bırakırsan algılanan giriş kullanılır. Anahtar kaydedilmeden önce OpenAI'ye sorulur.",
                  "Leave it empty to use the detected sign-in. A key is checked with OpenAI before it is saved.",
                )
              : t("Anahtar kaydedilmeden önce OpenAI'ye sorulur.", "The key is checked with OpenAI before it is saved.")}
          </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          {t("Vazgeç", "Cancel")}
        </Button>
        <Button type="submit" disabled={disabled || !canConnect}>
          {connecting ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {t("Bağla", "Connect")}
        </Button>
      </div>
    </form>
  );
}

/** Antigravity uses the actual Google OAuth flow owned by the local CLIProxyAPI bridge. */
export function AntigravityOAuthForm({
  form, onChange, onResult, close,
}: {
  form: ConnectForm;
  onChange: (form: ConnectForm) => void;
  onResult: (result: OneClickCascadeResult) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const { api, action, busy } = useRelay();
  const [pending, setPending] = useState<AntigravityOAuthStart>();
  const [oauthError, setOauthError] = useState<string>();
  // Escape, a click outside or another provider card unmounts the form: a sign-in still
  // waiting then is cancelled, so no half-made account blocks the next one. Main ignores a
  // sign-in that already finished.
  const pendingRef = useRef<AntigravityOAuthStart>(undefined);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      if (pendingRef.current) void api.cancelAntigravityOAuth(pendingRef.current).catch(() => {});
    },
    [api],
  );
  useEffect(() => {
    if (!pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // Main polls the helper itself; this only reads where the sign-in stands.
    const poll = async () => {
      try {
        const result = await api.pollAntigravityOAuth(pending);
        if (!live) return;
        if (result.status === "ok") onResult(result.result);
        else if (result.status === "error") {
          setPending(undefined);
          setOauthError(result.error);
        } else timer = setTimeout(poll, 1500);
      } catch (error) {
        // The sign-in is gone (cancelled, timed out): say why once and stop asking.
        if (!live) return;
        setPending(undefined);
        setOauthError(errorMessage(error));
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { live = false; clearTimeout(timer); };
  }, [pending, api, onResult]);
  const start = () => {
    setOauthError(undefined);
    void action("antigravity-oauth", async () => {
      const started = await api.startAntigravityOAuth({
        name: form.name.trim(), kind: form.kind,
        ...(form.kind === "work" && form.group.trim() ? { group: form.group.trim() } : {}),
      });
      setPending(started);
    });
  };
  return (
    <div data-slot="antigravity-oauth" className="grid gap-3">
      <RelayErrorAlert />
      {oauthError && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{oauthError}</p>}
      <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        {t("Google hesabında bir kez oturum aç. Relay, Antigravity OAuth oturumunu yerel olarak saklar ve proxy için kullanır. API anahtarı gerekmez.",
          "Sign in to your Google account once. Relay stores the Antigravity OAuth session locally for the gateway. No API key is needed.")}
      </p>
      <CommonFields form={form} onChange={onChange} idPrefix="add-antigravity" />
      {pending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        {t("Tarayıcıda Google girişini tamamla…", "Finish Google sign-in in your browser…")}
      </p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            // A sign-in left open would keep a half-made account until it times out.
            if (pending) void api.cancelAntigravityOAuth(pending).catch(() => {});
            close();
          }}
        >
          {pending ? t("İptal et", "Cancel") : t("Kapat", "Close")}
        </Button>
        <Button type="button" disabled={!!busy || !!pending || !form.name.trim()} onClick={start}>
          {busy === "antigravity-oauth" ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {t("Google ile bağlan", "Connect with Google")}
        </Button>
      </div>
    </div>
  );
}

/** What the one-click connection did: its four layers, then done or another account. */
export function ConnectionDone({
  result,
  provider,
  onAnother,
  close,
  children,
}: {
  result: OneClickCascadeResult;
  provider: AccountProvider;
  onAnother: () => void;
  close: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3" data-slot="connection-done">
      <h3 className="flex flex-wrap items-center gap-2 text-lg leading-snug font-semibold">
        {t("Hesap eklendi", "Account added")}
        <ProviderBadge provider={provider} full />
      </h3>
      <p className="text-sm text-muted-foreground">
        {result.account.name}
        {result.account.auth?.email ? ` · ${result.account.auth.email}` : ""}
      </p>
      <CascadeResult result={result} />
      {children}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onAnother}>
          {t("Başka hesap ekle", "Add another account")}
        </Button>
        <Button type="button" onClick={close}>
          {t("Bitti", "Done")}
        </Button>
      </div>
    </div>
  );
}
