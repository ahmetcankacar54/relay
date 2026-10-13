import { Check, LoaderCircle, Pause, Play, ShieldCheck } from "lucide-react";
import type { Account, FleetContinuationState } from "../shared/types";

type T = (tr: string, en: string) => string;

const badge: Record<
  FleetContinuationState["status"],
  [string, string, string]
> = {
  off: ["Kapalı", "Off", "off"],
  watching: ["İzleniyor", "Watching", "armed"],
  waiting: ["Bekliyor", "Waiting", "waiting"],
  switching: ["Geçiliyor", "Switching", "executing"],
  continuing: ["Sürdürülüyor", "Continuing", "executing"],
  attention: ["Dikkat", "Attention", "blocked"],
};

function message(
  value: FleetContinuationState,
  name: (id?: string) => string,
  t: T,
) {
  const reason = value.reason ?? "";
  const n = value.stopped ?? 0;
  if (value.status === "off")
    return t(
      "Kapalı. Açıldığında açık hesabın kotası dolunca, kota yüzünden duran Code konuşmaları uygun başka hesapta sürdürülür.",
      "Off. When on, Code conversations that stop at the active account's limit continue on another eligible account.",
    );
  if (value.status === "switching")
    return t(
      `${name(value.sourceId)} → ${name(value.targetId)} geçiliyor…`,
      `Switching ${name(value.sourceId)} → ${name(value.targetId)}…`,
    );
  if (value.status === "continuing")
    return t(
      `${name(value.targetId)} hesabında ${n} konuşma sürdürülüyor…`,
      `Continuing ${n} conversations on ${name(value.targetId)}…`,
    );
  if (reason === "continued" && value.last)
    return t(
      `İzleniyor. Son geçiş: ${name(value.last.sourceId)} → ${name(value.last.targetId)}, ${value.last.started}/${value.last.conversations} konuşma sürdürüldü.`,
      `Watching. Last handoff: ${name(value.last.sourceId)} → ${name(value.last.targetId)}, ${value.last.started}/${value.last.conversations} conversations continued.`,
    );
  if (reason === "delivery-uncertain" && value.last)
    return t(
      `${value.last.uncertain} konuşmada devam mesajının ulaştığı doğrulanamadı; Claude'da kontrol et. Tekrar gönderilmez.`,
      `Could not confirm the continuation reached ${value.last.uncertain} conversations; check them in Claude. Nothing is resent.`,
    );
  if (reason.startsWith("switch-failed:"))
    return t(
      `Geçiş yapılamadı (${reason.slice(14)}). Bu kota olayı tekrar denenmeyecek.`,
      `The switch failed (${reason.slice(14)}). This limit will not be retried.`,
    );
  if (reason.startsWith("not-quiescent:") || reason === "quiescence-unverified")
    return t(
      `${n} konuşma kota nedeniyle durdu. Başka bir iş çalışıyor; bitince geçilecek.`,
      `${n} conversations stopped at the limit. Other work is running; the switch waits until it finishes.`,
    );
  const fixed: Record<string, [string, string]> = {
    checking: ["Kontrol ediliyor…", "Checking…"],
    "awaiting-quota-stop": [
      `İzleniyor. ${name(value.sourceId)} hesabının kotası dolduğunda geçilecek.`,
      `Watching. Switches when ${name(value.sourceId)} runs out of quota.`,
    ],
    "source-quota-unconfirmed": [
      `${n} konuşma kota nedeniyle durdu; limit verisi kotanın dolduğunu doğrulayınca geçilecek.`,
      `${n} conversations stopped at the limit; switching once usage data confirms it.`,
    ],
    "no-target": [
      "Kotası uygun başka hesap yok; bir hesabın limiti yenilenince geçilecek.",
      "No other account has quota; switching when one resets.",
    ],
    "desktop-busy": [
      "Başka bir Relay işlemi sürüyor.",
      "Another Relay operation is in progress.",
    ],
    "desktop-unavailable": [
      "Claude Desktop bulunamadı.",
      "Claude Desktop was not found.",
    ],
    "source-not-enrolled": [
      "Claude'da açık hesap Relay'de bağlı değil.",
      "The account open in Claude is not connected in Relay.",
    ],
    "accessibility-permission-required": [
      "Konuşmaları sürdürmek için Relay'e macOS Erişilebilirlik izni ver.",
      "Give Relay macOS Accessibility permission to continue conversations.",
    ],
    "context-changed": [
      "Durum değişti; yeniden kontrol ediliyor.",
      "Something changed; checking again.",
    ],
  };
  if (fixed[reason]) return t(...fixed[reason]);
  return t(
    `Claude arayüzü okunamadı (${reason}). Geçiş bekliyor.`,
    `Could not read Claude's interface (${reason}). The switch is waiting.`,
  );
}

export function FleetSettings({
  value,
  accounts,
  busy,
  t,
  onToggle,
  requestAccessibility,
}: {
  value?: FleetContinuationState;
  accounts: Account[];
  busy: boolean;
  t: T;
  onToggle: (enabled: boolean) => void;
  requestAccessibility: () => void;
}) {
  const state = value ?? { enabled: false, status: "off" as const };
  const name = (id?: string) =>
    accounts.find((account) => account.id === id)?.name ?? "—";
  const [tr, en, tone] = badge[state.status];
  const working = state.status === "switching" || state.status === "continuing";
  return (
    <section className="continuation-settings" aria-labelledby="fleet-title">
      <div className="continuation-heading">
        <div>
          <h4 id="fleet-title">
            <ShieldCheck size={19} aria-hidden="true" />
            {t("Kota dolunca geç ve devam et", "Switch and continue at quota")}
          </h4>
          <p>
            {t(
              "Tüm Code konuşmaları için, kapatana kadar açık kalır. İzin modları korunur.",
              "For every Code conversation, until you turn it off. Permission modes are kept.",
            )}
          </p>
        </div>
        <span className={`continuation-badge ${tone}`}>
          {working ? (
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
          ) : state.reason === "continued" ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <span aria-hidden="true" className="continuation-dot" />
          )}
          {t(tr, en)}
        </span>
      </div>
      <div
        className={`continuation-feedback ${tone}`}
        role="status"
        aria-live="polite"
      >
        <p>{message(state, name, t)}</p>
      </div>
      <div className="continuation-actions">
        {state.enabled ? (
          <button
            type="button"
            className="secondary"
            disabled={busy || working}
            onClick={() => onToggle(false)}
          >
            <Pause size={15} aria-hidden="true" />
            {t("Kapat", "Turn off")}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onToggle(true)}
          >
            <Play size={15} aria-hidden="true" />
            {t("Aç", "Turn on")}
          </button>
        )}
        {state.reason === "accessibility-permission-required" && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={requestAccessibility}
          >
            {t(
              "macOS Erişilebilirlik iznini aç",
              "Open macOS Accessibility permission",
            )}
          </button>
        )}
      </div>
      <p className="continuation-footnote">
        {t(
          "Relay açık kalmalı. Çalışan işler bitmeden Claude yeniden başlatılmaz; her konuşmaya en fazla bir devam mesajı gönderilir. Kotası hâlâ dolu hesaba dönülmez.",
          "Relay must stay open. Claude is not restarted while work is running; each conversation gets at most one continuation message. It never returns to an account that is still out of quota.",
        )}
      </p>
    </section>
  );
}
