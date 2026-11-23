import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n, type T } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { errorMessage } from "@/data/error-message";
import { localizeError } from "../../messages";
import { usd } from "@/lib/proxy-ui";
import type { ProxyStatus } from "../../../shared/types";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import {
  DEFAULT_OVERFLOW_CAP_USD,
  OVERFLOW_PRESETS,
  OVERFLOW_PRESET_IDS,
  type ApiUpstreamPreset,
  type OverflowModelMap,
  type OverflowStatus,
  type OverflowTestResult,
  type OverflowUpstreamInput,
} from "../../../shared/overflow";

type Upstream = OverflowStatus["upstreams"][number];

/** Presets Relay has no price table for (or not for every model they map to): prices are asked for. */
const UNPRICED: readonly ApiUpstreamPreset[] = ["kimi", "kimi-cn", "glm", "glm-cn", "custom"];
/** Presets whose provider also sells coding plans limited to their own tools. */
const PLAN_KEYS: readonly ApiUpstreamPreset[] = ["kimi", "kimi-cn", "glm", "glm-cn"];
const FAMILIES = ["opus", "sonnet", "haiku", "default"] as const;

/** A preset's name: brand names stay as they are; "Custom" and the China endpoints are said. */
function presetLabel(preset: ApiUpstreamPreset, t: T): string {
  if (preset === "custom") return t("apiOverflow.presetCustom");
  if (preset === "kimi-cn") return t("apiOverflow.presetChina", { name: OVERFLOW_PRESETS.kimi.label });
  if (preset === "glm-cn") return t("apiOverflow.presetChina", { name: "Zhipu GLM" });
  return OVERFLOW_PRESETS[preset].label;
}

/** A cap typed in the field, when it is one main accepts. */
function parseCap(text: string): number | undefined {
  const value = Number(text.replace(",", ".").trim());
  return Number.isFinite(value) && value >= 0.01 && value <= 10_000 ? Math.round(value * 100) / 100 : undefined;
}

/** Whether a base URL can be saved: https, or http on this computer (main checks it again). */
function urlAllowed(text: string): boolean {
  try {
    const url = new URL(text.trim());
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

interface Draft {
  id?: string;
  preset: ApiUpstreamPreset;
  label: string;
  baseUrl: string;
  authStyle: "x-api-key" | "bearer";
  modelMap: OverflowModelMap;
  enabled: boolean;
  key: string;
  priceIn: string;
  priceOut: string;
  keyHint?: string;
}

const draftOf = (upstream: Upstream): Draft => ({
  id: upstream.id,
  preset: upstream.preset,
  label: upstream.label,
  baseUrl: upstream.baseUrl,
  authStyle: upstream.authStyle,
  modelMap: { ...upstream.modelMap },
  enabled: upstream.enabled,
  key: "",
  priceIn: upstream.prices ? String(upstream.prices.input) : "",
  priceOut: upstream.prices ? String(upstream.prices.output) : "",
  ...(upstream.keyHint ? { keyHint: upstream.keyHint } : {}),
});

const freshDraft = (preset: ApiUpstreamPreset, t: T): Draft => ({
  preset,
  label: presetLabel(preset, t),
  baseUrl: OVERFLOW_PRESETS[preset].baseUrl,
  authStyle: OVERFLOW_PRESETS[preset].authStyle,
  modelMap: { ...OVERFLOW_PRESETS[preset].modelMap },
  enabled: true,
  key: "",
  priceIn: "",
  priceOut: "",
});

/** The form for one upstream: a preset fills the address, key header and models; the key is typed once. */
function UpstreamForm({
  draft,
  disabled,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  disabled: boolean;
  onChange: (next: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const isNew = !draft.id;
  const price = (text: string) => (text.trim() === "" ? undefined : Number(text.replace(",", ".")));
  const pricesValid = [draft.priceIn, draft.priceOut].every((text) => {
    const value = price(text);
    return value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1_000);
  });
  const valid =
    draft.label.trim().length > 0 &&
    urlAllowed(draft.baseUrl) &&
    (draft.key.trim() ? /^[\x21-\x7e]{8,512}$/.test(draft.key.trim()) : !isNew) &&
    pricesValid;
  const field = (id: string, label: string, input: ReactNode) => (
    <label key={id} className="grid gap-1 text-xs font-medium" htmlFor={id}>
      {label}
      {input}
    </label>
  );
  const familyLabel = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", default: t("apiOverflow.modelOther") };
  return (
    <div data-slot="overflow-form" className="grid gap-3 rounded-md border bg-muted/30 p-3">
      <div className="grid gap-3 @lg:grid-cols-2">
        {field(
          "overflow-preset",
          t("common.provider"),
          <OptionSelect
            id="overflow-preset"
            value={draft.preset}
            disabled={disabled || !isNew}
            options={OVERFLOW_PRESET_IDS.map((preset) => ({ value: preset, label: presetLabel(preset, t) }))}
            onChange={(preset) => onChange({ ...freshDraft(preset, t), key: draft.key })}
          />,
        )}
        {field(
          "overflow-label",
          t("apiOverflow.name"),
          <Input
            id="overflow-label"
            value={draft.label}
            maxLength={40}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, label: e.target.value })}
          />,
        )}
        {field(
          "overflow-url",
          t("apiOverflow.baseUrl"),
          <Input
            id="overflow-url"
            value={draft.baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://"
            aria-invalid={!urlAllowed(draft.baseUrl)}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          />,
        )}
        {field(
          "overflow-auth",
          t("apiOverflow.keyHeader"),
          <OptionSelect
            id="overflow-auth"
            value={draft.authStyle}
            disabled={disabled}
            options={[
              { value: "x-api-key", label: "x-api-key" },
              { value: "bearer", label: "Authorization: Bearer" },
            ]}
            onChange={(authStyle) => onChange({ ...draft, authStyle })}
          />,
        )}
      </div>
      {field(
        "overflow-key",
        t("apiOverflow.apiKey"),
        <Input
          id="overflow-key"
          type="password"
          value={draft.key}
          spellCheck={false}
          autoComplete="off"
          placeholder={draft.keyHint ? t("apiOverflow.keepSavedKey", { hint: draft.keyHint }) : ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, key: e.target.value })}
        />,
      )}
      <fieldset className="grid gap-2">
        <legend className="pb-1 text-xs font-medium">{t("apiOverflow.models")}</legend>
        <div className="grid gap-2 @lg:grid-cols-4">
          {FAMILIES.map((family) =>
            field(
              `overflow-model-${family}`,
              familyLabel[family],
              <Input
                id={`overflow-model-${family}`}
                value={draft.modelMap[family] ?? ""}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("apiOverflow.sameAsRequested")}
                disabled={disabled}
                onChange={(e) => {
                  const modelMap = { ...draft.modelMap };
                  if (e.target.value.trim()) modelMap[family] = e.target.value.trim();
                  else delete modelMap[family];
                  onChange({ ...draft, modelMap });
                }}
              />,
            ),
          )}
        </div>
      </fieldset>
      {UNPRICED.includes(draft.preset) && (
        <fieldset className="grid gap-2">
          <legend className="pb-1 text-xs font-medium">{t("apiOverflow.pricePerMillion")}</legend>
          <div className="grid grid-cols-2 gap-2 @lg:max-w-sm">
            {field(
              "overflow-price-in",
              t("apiOverflow.priceInput"),
              <Input
                id="overflow-price-in"
                inputMode="decimal"
                value={draft.priceIn}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, priceIn: e.target.value })}
              />,
            )}
            {field(
              "overflow-price-out",
              t("apiOverflow.priceOutput"),
              <Input
                id="overflow-price-out"
                inputMode="decimal"
                value={draft.priceOut}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, priceOut: e.target.value })}
              />,
            )}
          </div>
          <Note>{t("apiOverflow.withoutPricesCostIsUnknown")}</Note>
        </fieldset>
      )}
      {PLAN_KEYS.includes(draft.preset) && <Note>{t("apiOverflow.usePayAsYouGoKey")}</Note>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled || !valid} onClick={onSave}>
          {t("apiOverflow.save")}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** What a saved draft sends: the key only when one was typed, prices only when both were. */
function inputOf(draft: Draft): OverflowUpstreamInput {
  const priceIn = Number(draft.priceIn.replace(",", "."));
  const priceOut = Number(draft.priceOut.replace(",", "."));
  const priced = UNPRICED.includes(draft.preset) && draft.priceIn.trim() !== "" && draft.priceOut.trim() !== "";
  return {
    ...(draft.id ? { id: draft.id } : {}),
    preset: draft.preset,
    label: draft.label.trim(),
    baseUrl: draft.baseUrl.trim(),
    authStyle: draft.authStyle,
    modelMap: draft.modelMap,
    enabled: draft.enabled,
    ...(draft.key.trim() ? { key: draft.key.trim() } : {}),
    ...(priced ? { prices: { input: priceIn, output: priceOut } } : {}),
  };
}

/**
 * Overflow to API keys: when every subscription account is at its limit, Claude Messages requests
 * go to the first enabled upstream (Anthropic's API, OpenRouter, DeepSeek, Kimi, GLM or any
 * Anthropic-compatible URL) until today's spend reaches the cap.
 */
export function OverflowCard({
  status,
  disabled,
  onStatus,
}: {
  status: ProxyStatus;
  disabled: boolean;
  onStatus: (next: ProxyStatus) => void;
}) {
  const { t, language } = useI18n();
  const locale = FORMAT_LOCALE[language];
  const { api, action } = useRelay();
  const overflow: OverflowStatus = status.overflow ?? {
    enabled: false,
    trigger: "limited",
    spentTodayUsd: 0,
    capReached: false,
    upstreams: [],
  };
  const [capDraft, setCapDraft] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [tests, setTests] = useState<Record<string, OverflowTestResult | "running">>({});
  const capText = capDraft ?? String(overflow.dailyCapUsd ?? DEFAULT_OVERFLOW_CAP_USD);
  const cap = parseCap(capText);
  const upstreams = overflow.upstreams;
  const run = (key: string, call: () => Promise<ProxyStatus>) =>
    action(key, async () => onStatus(await call()));
  const configure = (input: Parameters<typeof api.proxyOverflowConfigure>[0]) =>
    run("proxy-overflow", () => api.proxyOverflowConfigure(input));
  const move = (index: number, by: -1 | 1) => {
    const order = upstreams.map((u) => u.id);
    [order[index], order[index + by]] = [order[index + by], order[index]];
    void configure({ order });
  };
  const test = (id: string) => {
    setTests((all) => ({ ...all, [id]: "running" }));
    void api.proxyOverflowTest(id).then(
      (result) => setTests((all) => ({ ...all, [id]: result })),
      (error: unknown) =>
        setTests((all) => ({
          ...all,
          [id]: { ok: false, model: "", message: localizeError(errorMessage(error), language) },
        })),
    );
  };
  const spent = usd(overflow.spentTodayUsd, locale);
  return (
    <Card padded data-slot="overflow">
      <SectionHeading
        title={t("apiOverflow.overflowToApiKeys")}
        description={t("apiOverflow.whenEveryAccountIsAtIts")}
        aside={
          <Switch
            id="overflow-enabled"
            aria-label={t("apiOverflow.useOverflow")}
            checked={overflow.enabled}
            disabled={disabled || (!overflow.enabled && (!upstreams.length || cap === undefined))}
            onCheckedChange={(enabled) =>
              void configure(enabled ? { enabled, dailyCapUsd: cap ?? DEFAULT_OVERFLOW_CAP_USD } : { enabled })
            }
          />
        }
      />
      <div className="grid gap-1 pt-2">
        <SettingRow
          label={t("apiOverflow.dailyCap")}
          htmlFor="overflow-cap"
          description={t("apiOverflow.overflowStopsForTheRestOf")}
        >
          <span className="flex items-center gap-2">
            <Input
              id="overflow-cap"
              inputMode="decimal"
              className="w-24"
              value={capText}
              aria-invalid={cap === undefined}
              disabled={disabled}
              onChange={(e) => setCapDraft(e.target.value)}
            />
            {capDraft !== undefined && cap !== overflow.dailyCapUsd && (
              <Button
                size="sm"
                disabled={disabled || cap === undefined}
                onClick={() =>
                  void configure({ dailyCapUsd: cap! }).then((saved) => saved && setCapDraft(undefined))
                }
              >
                {t("apiOverflow.save")}
              </Button>
            )}
          </span>
        </SettingRow>
        <SettingRow label={t("apiOverflow.whenToUseIt")} htmlFor="overflow-trigger">
          <OptionSelect
            id="overflow-trigger"
            value={overflow.trigger}
            disabled={disabled}
            options={[
              { value: "limited", label: t("apiOverflow.onlyWhenEveryAccountIsLimited") },
              { value: "unavailable", label: t("apiOverflow.alsoWhenNoAccountCanAnswer") },
            ]}
            onChange={(trigger) => void configure({ trigger })}
          />
        </SettingRow>
        <p data-slot="overflow-spend" className="text-2xs text-muted-foreground tabular-nums">
          {overflow.dailyCapUsd !== undefined
            ? t("apiOverflow.todaySpentOfCap", { spent, cap: usd(overflow.dailyCapUsd, locale) })
            : t("apiOverflow.todaySpent", { spent })}
        </p>
        {overflow.capReached && (
          <Note className="text-warn-foreground">{t("apiOverflow.todaysCapIsReached")}</Note>
        )}
      </div>
      <ol aria-label={t("apiOverflow.upstreams")} className="grid pt-2">
        {upstreams.map((upstream, index) => {
          const result = tests[upstream.id];
          return (
            <li key={upstream.id} data-slot="overflow-upstream" className="grid gap-1 border-t py-2 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  aria-label={t("apiOverflow.useUpstream", { name: upstream.label })}
                  checked={upstream.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    void run("proxy-overflow", () =>
                      api.proxyOverflowSaveUpstream({ ...inputOf(draftOf(upstream)), enabled }),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{upstream.label}</span>
                {upstream.keyHint && (
                  <span className="font-mono text-2xs text-muted-foreground">{upstream.keyHint}</span>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("apiOverflow.moveUp")}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("apiOverflow.moveDown")}
                  disabled={disabled || index === upstreams.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button size="sm" variant="outline" disabled={disabled || result === "running"} onClick={() => test(upstream.id)}>
                  {result === "running" ? t("apiOverflow.testing") : t("apiOverflow.test")}
                </Button>
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setDraft(draftOf(upstream))}>
                  {t("apiOverflow.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void run("proxy-overflow", () => api.proxyOverflowRemoveUpstream(upstream.id))}
                >
                  {t("apiOverflow.remove")}
                </Button>
              </div>
              <span className="truncate pl-11 font-mono text-2xs text-muted-foreground">
                {upstream.baseUrl}
                {Object.keys(upstream.modelMap).length
                  ? ` · ${FAMILIES.filter((f) => upstream.modelMap[f]).map((f) => upstream.modelMap[f]).join(", ")}`
                  : ""}
              </span>
              {result && result !== "running" && (
                <span data-slot="overflow-test" className="flex items-center gap-1.5 pl-11 text-2xs">
                  <StatusDot tone={result.ok ? "ok" : "crit"} />
                  {result.ok
                    ? t("apiOverflow.testWorks", { model: result.model })
                    : t("apiOverflow.testFailed", {
                        message: [result.status, result.message].filter((part) => part !== undefined && part !== "").join(" · "),
                      })}
                </span>
              )}
              {draft?.id === upstream.id && (
                <UpstreamForm
                  draft={draft}
                  disabled={disabled}
                  onChange={setDraft}
                  onCancel={() => setDraft(undefined)}
                  onSave={() =>
                    void run("proxy-overflow", () => api.proxyOverflowSaveUpstream(inputOf(draft))).then(
                      (saved) => saved && setDraft(undefined),
                    )
                  }
                />
              )}
            </li>
          );
        })}
      </ol>
      {!upstreams.length && !draft && <Note className="pt-1">{t("apiOverflow.noUpstreamYet")}</Note>}
      {draft && !draft.id ? (
        <div className="pt-2">
          <UpstreamForm
            draft={draft}
            disabled={disabled}
            onChange={setDraft}
            onCancel={() => setDraft(undefined)}
            onSave={() =>
              void run("proxy-overflow", () => api.proxyOverflowSaveUpstream(inputOf(draft))).then(
                (saved) => saved && setDraft(undefined),
              )
            }
          />
        </div>
      ) : (
        <div className="pt-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => setDraft(freshDraft("anthropic", t))}>
            <Plus />
            {t("apiOverflow.addUpstream")}
          </Button>
        </div>
      )}
      <Note className="pt-2">{t("apiOverflow.claudeMessagesOnly")}</Note>
    </Card>
  );
}
