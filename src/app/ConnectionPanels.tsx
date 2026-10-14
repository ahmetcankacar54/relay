import { useEffect, useState } from "react";
import { ArrowUpRight, Globe2, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { duplicateCliAccount } from "../../shared/account-state";
import { ConnectionProgress } from "../ConnectionProgress";
import { localizeError } from "../messages";

/** Desktop sign-in in progress for a profile; shown above every page until saved or cancelled. */
export function DesktopPendingPanel() {
  const relay = useRelay();
  const { t } = useI18n();
  const {
    api,
    desktop,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    setOrg,
    action,
  } = relay;
  if (!pendingDesktop) return null;
  const desktopIdentityReady =
    hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id;
  return (
    <Card
      id="desktop-pending-panel"
      className="connection-panel mx-6 mb-3"
      aria-live="polite"
    >
      <div className="panel-title">
        <Globe2 size={19} />
        <div>
          <h3>
            {pendingDesktop.name} ·{" "}
            {t("Desktop bağlantısı", "Desktop connection")}
          </h3>
          <p>
            {t(
              "Claude’da doğru hesaba giriş yap ve Code sekmesini aç. Sonra buradan bağlantıyı kaydet.",
              "Sign in to the matching account inside Claude and open Code. Then save the connection here.",
            )}
          </p>
        </div>
      </div>
      <ConnectionProgress
        current={desktopIdentityReady ? 2 : 1}
        state={
          desktop?.busy ? "working" : desktop?.error ? "failed" : "waiting"
        }
        label={
          desktop?.busy
            ? t("Bağlantı kaydediliyor", "Saving connection")
            : desktop?.error
              ? t("Bağlantı tamamlanmadı", "Connection incomplete")
              : desktopIdentityReady
                ? targetOrg
                  ? t("Bağlantıyı tamamla", "Complete connection")
                  : t("Code bağlantısı bekleniyor", "Waiting for Code")
                : t(
                    "Claude’da giriş bekleniyor",
                    "Waiting for sign-in in Claude",
                  )
        }
        steps={[
          {
            title: t("Claude açıldı", "Claude opened"),
            detail: t("Giriş ekranı hazır", "Sign-in is ready"),
          },
          {
            title: t("Hesabına giriş yap", "Sign in"),
            detail: t(
              "Bağlayacağın hesabı seç",
              "Choose the account to connect",
            ),
          },
          {
            title: t("Code’u aç ve bağla", "Open Code & connect"),
            detail: t(
              "Bağlantıyı Relay’den kaydet",
              "Save the connection in Relay",
            ),
          },
        ]}
      />
      {desktop?.organizations.length! > 1 && (
        <label>
          {t("Code çalışma alanı", "Code workspace")}
          <select value={targetOrg} onChange={(e) => setOrg(e.target.value)}>
            <option value="">
              {t("Çalışma alanı seç", "Choose a workspace")}
            </option>
            {desktop?.organizations.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="panel-actions">
        <button
          className="secondary"
          disabled={desktopBusy}
          onClick={() => void action("open", () => api.openDesktop())}
        >
          <ArrowUpRight size={14} />
          {t("Claude’u yeniden aç", "Reopen Claude")}
        </button>
        <button
          className="text-button"
          disabled={desktopBusy}
          onClick={() => relay.requestDesktop(pendingDesktop, "cancel")}
        >
          {t(
            "İptal et ve önceki hesaba dön",
            "Cancel and return to previous account",
          )}
        </button>
        {(hasUnclaimedDesktop ||
          desktop?.activeProfileId === pendingDesktop.id) &&
          targetOrg && (
            <button
              className="text-button"
              disabled={desktopBusy}
              onClick={() => relay.requestDesktop(pendingDesktop, "capture")}
            >
              {t("Bağlantıyı tamamla", "Complete connection")}
            </button>
          )}
      </div>
    </Card>
  );
}

/** Browser (CLI) sign-in flow for usage limits; shown above every page. */
export function CliFlowPanel() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, busy, flow, flowAccount, action } = relay;
  const pending = pendingFlow;
  const [code, setCode] = useState("");
  useEffect(() => setCode(""), [flow?.id]);
  if (!flow) return null;
  return (
    <Card
      id="cli-connection-panel"
      className={`connection-panel mx-6 mb-3 ${flow.status === "connected" ? "connected-panel" : ""}`}
      aria-live="polite"
    >
      <div className="panel-title">
        {flow.status === "connected" ? (
          <ShieldCheck size={22} />
        ) : (
          <Globe2 size={22} />
        )}
        <div>
          <h3>
            {flowAccount?.name} ·{" "}
            {t("Tarayıcı bağlantısı", "Browser connection")}
          </h3>
          <p>
            {flow.status === "connected"
              ? t(
                  "Tarayıcı bağlantısı tamamlandı. Bu hesaba ait kullanım limitleri okunabilir.",
                  "Browser sign-in completed. Usage limits for this account can now be read.",
                )
              : flow.status === "verifying"
                ? t(
                    "Tarayıcı onayı alındı. Hesabın doğrulanıyor…",
                    "Browser authorization received. Verifying your account…",
                  )
                : flow.status === "failed"
                  ? localizeError(flow.error ?? "", language)
                  : flow.status === "cancelled"
                    ? t(
                        "Giriş iptal edildi. İstediğinde yeniden bağlanabilirsin.",
                        "Sign-in cancelled. You can reconnect whenever you like.",
                      )
                    : t(
                        "Tarayıcıda seçtiğin hesabı onayla. Bu ekran otomatik güncellenecek.",
                        "Authorize your chosen account in the browser. This screen updates automatically.",
                      )}
          </p>
        </div>
      </div>
      {flow.status === "connected" && flowAccount?.auth?.email && (
        <p className="auth-identity">
          {flowAccount.auth.email}
          {flowAccount.auth.subscription
            ? ` · ${flowAccount.auth.subscription}`
            : ""}
        </p>
      )}
      {flow.status === "connected" &&
        flowAccount &&
        duplicateCliAccount(flowAccount, accounts) && (
          <p className="account-warning">
            {t(
              "Bu hesap başka bir profile de bağlı. İki profil aynı limitleri paylaşır.",
              "This account is connected to another profile too. Both profiles share the same limits.",
            )}
          </p>
        )}
      <ConnectionProgress
        current={
          flow.status === "starting" ? 0 : flow.status === "waiting" ? 1 : 2
        }
        state={
          flow.status === "connected"
            ? "complete"
            : flow.status === "failed"
              ? "failed"
              : flow.status === "cancelled"
                ? "cancelled"
                : flow.status === "waiting"
                  ? "waiting"
                  : "working"
        }
        label={
          flow.status === "connected"
            ? t("Hesap doğrulandı", "Account verified")
            : flow.status === "failed"
              ? t("Bağlantı tamamlanmadı", "Connection incomplete")
              : flow.status === "cancelled"
                ? t("Giriş iptal edildi", "Sign-in cancelled")
                : flow.status === "verifying"
                  ? t("Hesap doğrulanıyor", "Verifying account")
                  : flow.status === "waiting"
                    ? t(
                        "Tarayıcı onayı bekleniyor",
                        "Waiting for browser approval",
                      )
                    : t("Giriş hazırlanıyor", "Preparing sign-in")
        }
        steps={[
          {
            title: t("Girişi başlat", "Start sign-in"),
            detail: t(
              "Güvenli bağlantı hazırlanır",
              "Prepare the sign-in link",
            ),
          },
          {
            title: t("Tarayıcıda onayla", "Approve in browser"),
            detail: t(
              "Hesabını seç ve izin ver",
              "Choose and authorize your account",
            ),
          },
          {
            title: t("Bağlantıyı doğrula", "Verify connection"),
            detail: t(
              "Relay sonucu otomatik kontrol eder",
              "Relay checks the result automatically",
            ),
          },
        ]}
      />
      {flow.codeRequested && (
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = code;
            setCode("");
            relay.submitCode(value);
          }}
        >
          <label>
            {t(
              "Tarayıcı bir kod gösterdiyse buraya yapıştır",
              "If the browser shows a code, paste it here",
            )}
            <input
              type="password"
              autoComplete="off"
              value={code}
              maxLength={4096}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className="secondary" disabled={!!busy || !code.trim()}>
            {t("Kodu gönder", "Submit code")}
          </button>
        </form>
      )}
      <div className="panel-actions">
        {pending(flow) ? (
          <>
            <button
              className="secondary"
              disabled={!!busy || !flow.browserReady}
              onClick={() =>
                void action("reopen", () =>
                  api.reopenLogin(flow.accountId, flow.id),
                )
              }
            >
              <ArrowUpRight size={14} />
              {t("Tarayıcıyı yeniden aç", "Reopen browser")}
            </button>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                void action("cancel", () =>
                  api.cancelLogin(flow.accountId, flow.id),
                )
              }
            >
              {t("İptal et", "Cancel")}
            </button>
          </>
        ) : (
          <>
            {flow.status !== "connected" && (
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => {
                  if (!flowAccount) return;
                  setCode("");
                  void relay.startCli(flowAccount);
                }}
              >
                {t("Yeniden bağlan", "Reconnect")}
              </button>
            )}
            <button
              className="secondary"
              onClick={() => {
                relay.dismissFlow();
              }}
            >
              {t("Tamam", "Done")}
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

export function ConnectionPanels() {
  return (
    <>
      <DesktopPendingPanel />
      <CliFlowPanel />
    </>
  );
}
