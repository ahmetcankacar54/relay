import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { Preferences } from "../Preferences";

// Temporary: the pre-redesign preferences, mounted inside the new shell until
// the dedicated pages replace them (Tasks 10–13).

export function LegacySettings({
  section,
}: {
  section: "switch" | "usage" | "planning";
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const {
    api,
    data,
    desktop,
    accounts,
    active,
    settings: preferences,
    busy,
    desktopBusy,
    pendingDesktop,
    action,
    setData,
  } = relay;
  const requestDesktop = relay.requestDesktop;
  return (
    <div className="switcher">
      <div className="switcher-main mx-0 max-w-none px-6 pt-0">
        <section className="settings-panel">
          <Preferences
            only={section}
            value={preferences}
            accounts={accounts}
            active={active}
            autoSwitch={data?.autoSwitch}
            continuation={data?.continuation}
            inspectContinuation={() =>
              void action("continuation-check", async () => {
                const checked = await api.inspectContinuation();
                setData((current) =>
                  current ? { ...current, continuation: checked } : current,
                );
              })
            }
            armContinuation={() =>
              void action("continuation-arm", () =>
                api.armContinuation("automatic", "guarded-native-at-most-once"),
              )
            }
            disarmContinuation={() =>
              void action("continuation-disarm", () => api.disarmContinuation())
            }
            reconcileContinuation={() =>
              void action("continuation-reconcile", () =>
                api.reconcileContinuation(),
              )
            }
            abandonContinuation={() =>
              void action("continuation-abandon", () =>
                api.abandonContinuation(),
              )
            }
            fleet={data?.fleet}
            setFleet={(enabled) =>
              void action("fleet", () => api.setFleetContinuation(enabled))
            }
            requestAccessibility={() =>
              void action("continuation-permission", () =>
                api.requestDesktopAccessibility(),
              )
            }
            usage={data?.usage ?? {}}
            statistics={data?.usageStatistics ?? {}}
            keeper={data?.planning}
            updatePlanning={(patch) =>
              void action("planning", () => api.updatePlanning(patch))
            }
            updateAccount={(id, input) =>
              void action(`plan:${id}`, () =>
                api.updateAccountPlanning(id, input),
              )
            }
            platform={data?.diagnostics.platform ?? "unknown"}
            sync={() => requestDesktop(active, "history")}
            syncDisabled={
              !!desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired
            }
            t={t}
            disabled={!!busy || !!desktop?.busy}
            update={(patch) =>
              void action("settings", () => api.updateSettings(patch))
            }
          />
          <details className="connection-info">
            <summary>
              {t(
                "Bağlantı ve teknik bilgiler",
                "Connection and technical details",
              )}
            </summary>
            <dl>
              <div>
                <dt>Claude Desktop</dt>
                <dd>
                  {desktop?.available
                    ? t("Bulundu", "Detected")
                    : t(
                        "Bulunamadı / desteklenmiyor",
                        "Not found / unsupported",
                      )}
                </dd>
              </div>
              <div>
                <dt>Claude Code CLI</dt>
                <dd>
                  {data?.diagnostics.version ?? t("Bulunamadı", "Not found")}
                </dd>
              </div>
            </dl>
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() =>
                void action("executable", () => api.pickExecutable())
              }
            >
              {t("Claude CLI dosyasını seç", "Choose Claude CLI executable")}
            </button>
            <p>
              {t(
                "Desktop geçişi, Claude’un yerel dosya biçimine bağlı deneysel bir entegrasyondur. Code oturumları ve yerel proje kayıtları seçtiğin paylaşım kapsamında birleştirilir. Chat geçmişi ve sunucudaki proje grupları hesaplarına bağlı kalır.",
                "Desktop switching is an experimental integration with Claude’s local file format. Code sessions and local project records merge within your chosen sharing scope. Chat history and server-managed project groups remain account-specific.",
              )}
            </p>
            <p>
              {t(
                "Giriş kayıtları bu cihazda işletim sistemi şifrelemesiyle saklanır. Her geçişten önce yedek alınır. CLI girişi resmi Claude Code üzerinden tamamlanır.",
                "Saved Desktop sign-ins are encrypted on this device using the operating system. Every switch creates a backup. CLI sign-in uses the official Claude Code.",
              )}
            </p>
          </details>
        </section>
      </div>
    </div>
  );
}
