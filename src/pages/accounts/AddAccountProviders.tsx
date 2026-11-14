import { useEffect, useRef, useState, type ReactNode } from "react";
import { Private } from "@/components/Private";
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
import { providerPlan } from "./accountLabels";

/** The providers an account can be added for, in the order the cards show them. */
export const ONBOARDING_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type OnboardingProvider = (typeof ONBOARDING_PROVIDERS)[number];


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

/**
 * Where an added account works, in plain words: only the places that apply to its provider
 * (Codex and Antigravity only serve the gateway), each with its state.
 */
export function CascadeResult({ result }: { result: OneClickCascadeResult }) {
  const { t } = useI18n();
  const rows: [string, CascadeLayerStatus][] = [
    [t("Claude uygulaması", "Claude app"), result.layers.desktop],
    [t("Limitler", "Limits"), result.layers.usage],
    [t("Terminal", "Terminal"), result.layers.terminal],
    [t("Eklenti ve ağ geçidi", "Extension and gateway"), result.layers.extensionAndProxy],
  ];
  const shown = rows.filter(([, status]) => status !== "skipped");
  return (
    <ul data-slot="cascade-result" className="flex flex-wrap gap-x-4 gap-y-1">
      {shown.map(([label, status]) => (
        <li key={label} data-state={status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={status === "done" || status === "ready" ? "ok" : "warn"} />
          <span>{label}</span>
          <span className="sr-only">{t(...LAYER_WORDS[status])}</span>
        </li>
      ))}
    </ul>
  );
}

/** A session found on this Mac that is not an account yet: what the import list offers. */
export const importable = (detected: Partial<Record<AccountProvider, DetectedProviderSession>>) =>
  ONBOARDING_PROVIDERS.map((p) => detected[p]).filter(
    (s): s is DetectedProviderSession => !!s?.detected && !s.alreadyLinkedAccountId,
  );

/** What happened to one import: the account added, or why it was not. */
export type ImportOutcome =
  | { provider: AccountProvider; result: OneClickCascadeResult }
  | { provider: AccountProvider; error: string };

/**
 * Adds the chosen sessions one after the other with suggested names; the Claude one goes last
 * because it may still wait for the Claude app. A failure is kept and the rest go on.
 */
export async function importSessions(
  sessions: readonly DetectedProviderSession[],
  connect: (input: { provider: AccountProvider; name: string; kind: AccountKind }) => Promise<OneClickCascadeResult>,
  taken: readonly string[],
  t: T,
): Promise<ImportOutcome[]> {
  const names = [...taken];
  const ordered = [...sessions].sort((a, b) => Number(a.provider === "claude") - Number(b.provider === "claude"));
  const out: ImportOutcome[] = [];
  for (const session of ordered) {
    const name = suggestAccountName(session.provider, names, t);
    names.push(name);
    try {
      out.push({ provider: session.provider, result: await connect({ provider: session.provider, name, kind: "personal" }) });
    } catch (error) {
      out.push({ provider: session.provider, error: errorMessage(error) });
    }
  }
  return out;
}

/**
 * "We found N accounts on this Mac": every session not yet added, ticked, and one button that
 * adds them all. Names are suggested; they can be changed later on the account.
 */
export function DetectedImport({
  sessions,
  onDone,
}: {
  sessions: readonly DetectedProviderSession[];
  onDone: (outcomes: ImportOutcome[]) => void;
}) {
  const { t } = useI18n();
  const { api, accounts, action, busy } = useRelay();
  const [skipped, setSkipped] = useState<ReadonlySet<AccountProvider>>(new Set());
  const chosen = sessions.filter((s) => !skipped.has(s.provider));
  const toggle = (provider: AccountProvider) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  const run = () =>
    void action("import", async () => {
      onDone(await importSessions(chosen, (input) => api.oneClickConnect(input), accounts.map((a) => a.name), t));
    });
  const where: Record<string, [string, string]> = {
    claude: ["Claude uygulaması", "Claude app"],
    codex: ["Codex CLI", "Codex CLI"],
    antigravity: ["Google oturumu", "Google sign-in"],
  };
  return (
    <section data-slot="detected-import" aria-labelledby="detected-import-title" className="grid gap-3 rounded-lg border bg-card px-3.5 py-3">
      <div className="grid gap-0.5">
        <h3 id="detected-import-title" className="text-base font-semibold">
          {sessions.length === 1
            ? t("Bu Mac’te 1 hesap bulduk", "We found 1 account on this Mac")
            : t(`Bu Mac’te ${sessions.length} hesap bulduk`, `We found ${sessions.length} accounts on this Mac`)}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "İşaretli olanlar tek seferde eklenir. İsimleri sonra değiştirebilirsin.",
            "The ticked ones are added in one go. You can rename them later.",
          )}
        </p>
      </div>
      <ul className="grid">
        {sessions.map((session) => {
          const on = !skipped.has(session.provider);
          return (
            <li key={session.provider} className="border-t first:border-t-0">
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                data-provider={session.provider}
                disabled={!!busy}
                onClick={() => toggle(session.provider)}
                className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                  )}
                >
                  {on && <Check className="size-3" />}
                </span>
                <ProviderBadge provider={session.provider} />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm">
                    {session.email || session.name ? <Private>{session.email ?? session.name}</Private> : session.source}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {[t(...(where[session.provider] ?? [session.source ?? "", session.source ?? ""])), providerPlan(session.provider, session.plan)?.label, session.orgName]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!busy || chosen.length === 0} onClick={run}>
          {busy === "import" ? <LoaderCircle className="animate-spin" /> : <Zap />}
          {chosen.length === 1 ? t("Hesabı ekle", "Add account") : t(`${chosen.length} hesabı ekle`, `Add ${chosen.length} accounts`)}
        </Button>
        {chosen.some((s) => s.provider === "claude") && (
          <span className="text-xs text-muted-foreground">
            {t(
              "Claude hesabı, Claude uygulamasında Code bir kez açıldığında kaydedilir.",
              "The Claude account is saved once Code has been opened in the Claude app.",
            )}
          </span>
        )}
      </div>
    </section>
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
            <b className="font-semibold">{session?.email ? <Private>{session.email}</Private> : session?.source}</b>
          </span>
          <span className="text-xs text-muted-foreground">
            {[providerPlan(provider, session?.plan)?.label, session?.source].filter(Boolean).join(" · ")}
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
  // Where the browser ended up, pasted when it could not reach Relay by itself.
  const [pasted, setPasted] = useState("");
  const [finishing, setFinishing] = useState(false);
  const finish = () => {
    if (!pending || !pasted.trim()) return;
    setOauthError(undefined);
    setFinishing(true);
    void api
      .submitAntigravityCallback({ ...pending, url: pasted.trim() })
      .then(
        () => setPasted(""),
        (error) => setOauthError(errorMessage(error)),
      )
      .finally(() => setFinishing(false));
  };
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
      {pending && (
        <form
          data-slot="antigravity-paste"
          className="grid gap-1.5 rounded-lg border border-dashed px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            finish();
          }}
        >
          <Label htmlFor="antigravity-callback" className="text-xs">
            {t(
              "Tarayıcı “localhost:51121” ile başlayan bir sayfada kaldıysa adresini buraya yapıştır",
              "If the browser stopped on a page starting with “localhost:51121”, paste its address here",
            )}
          </Label>
          <div className="flex gap-2">
            <Input
              id="antigravity-callback"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              placeholder="http://localhost:51121/oauth-callback?state=…"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={finishing || !pasted.trim()}>
              {finishing && <LoaderCircle className="animate-spin" />}
              {t("Tamamla", "Finish")}
            </Button>
          </div>
        </form>
      )}
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
        {result.account.auth?.email ? <> · <Private>{result.account.auth.email}</Private></> : ""}
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
