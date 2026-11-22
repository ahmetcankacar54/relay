import { Check, CopyIcon, Link2, Plus, Unlink } from "lucide-react";
import { addAccountHash } from "@/app/routes";
import { Disclosure } from "@/components/Disclosure";
import { Note, SectionHeading } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n, type T } from "@/data/i18n";
import { macWording, usePlatform } from "@/data/platform";
import { antigravitySnippet, openAiSnippet, proxyCurlSnippet } from "@/lib/proxy-ui";
import type { ProxyClientId, ProxyClientStatus, ProxyStatus } from "../../../shared/types";
import type { Copy } from "./hooks";
import { CLIENT_NAMES, CLIENT_PROVIDER, PROVIDER_NAMES, missingFor, providerName, usableFor } from "./shared";

/** A copyable block for the tools Relay cannot set up itself. */
function CodeBlock({
  id,
  title,
  shown,
  copyText,
  copy,
}: {
  id: string;
  title: string;
  shown: string;
  copyText: string;
  copy: Copy;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{title}</h4>
        <Button variant="ghost" size="sm" aria-label={t(`${title} kopyala`, `Copy ${title}`)} onClick={() => copy.copy(id, copyText)}>
          {copy.copied === id ? <Check className="text-ok" /> : <CopyIcon />}
          {copy.copied === id ? t("Kopyalandı", "Copied") : t("Kopyala", "Copy")}
        </Button>
      </div>
      <pre
        data-slot="code-block"
        className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-all"
      >
        {shown}
      </pre>
    </div>
  );
}

/** A client's state in a word. */
function clientWord(client: ProxyClientStatus, t: T, mac: boolean): { tone: "ok" | "warn" | "off"; text: string } {
  if (client.blocked === "legacy-json")
    return {
      tone: "warn",
      text: t("Önce omp’yi bir kez aç: models.json’u models.yml’e taşır", "Open omp once first: it moves models.json to models.yml"),
    };
  if (client.blocked === "unsupported-layout")
    return { tone: "warn", text: t("models.yml’nin düzeni elle düzenleme istiyor", "models.yml's layout needs a manual edit") };
  if (client.blocked === "inline-providers")
    return { tone: "warn", text: t("models.yml’deki providers satır içi yazılmış", "models.yml writes providers inline") };
  if (client.blocked) return { tone: "warn", text: t("Ayar dosyası okunamadı", "Cannot read its settings") };
  if (client.bound) return { tone: "ok", text: t("Bağlı", "Connected") };
  if (client.stale) return { tone: "warn", text: t("Eski adres ya da anahtar", "Old address or key") };
  if (!client.installed)
    return {
      tone: "off",
      text: mac ? t("Bu Mac’te bulunamadı", "Not found on this Mac") : t("Bu bilgisayarda bulunamadı", "Not found on this computer"),
    };
  return { tone: "off", text: t("Bağlı değil", "Not connected") };
}

/**
 * The Tools tab: Claude Code and Codex are pointed at the gateway with one button (Relay writes
 * their settings and restores them on disconnect); other tools get copyable settings.
 */
export function ToolsTab({
  status,
  disabled,
  copy,
  onBind,
  onUnbind,
}: {
  status: ProxyStatus;
  disabled: boolean;
  copy: Copy;
  onBind: (id: ProxyClientId) => void;
  onUnbind: (id: ProxyClientId) => void;
}) {
  const { t } = useI18n();
  const mac = macWording(usePlatform());
  const host = status.host;
  const port = status.port;
  const key = status.clientApiKey;
  const hints: Record<ProxyClientId, string> = {
    "claude-code": t(
      "Bağlıyken hangi hesabın kullanılacağını ağ geçidi seçer; terminalde hesap değiştirmen gerekmez. Bağlıyken terminaldeki Claude Code, claude.ai bağlayıcılarını (Gmail, Drive gibi) yüklemez; Claude uygulaması etkilenmez. Relay kapanınca ayar dosyası eski haline döner, açılınca yeniden bağlanır.",
      "While connected, the gateway picks the account; no need to switch accounts in the terminal. While connected, Claude Code in the terminal does not load your claude.ai connectors (Gmail, Drive and the like); the Claude app is not affected. When Relay quits the settings file goes back as it was, and it is connected again when Relay starts.",
    ),
    codex: t(
      "Codex’in config.toml dosyasına Relay sağlayıcısı eklenir; varsa önceki sağlayıcı satırı yorum olarak saklanır.",
      "Relay adds its provider to Codex's config.toml; a provider line already there is kept as a comment.",
    ),
    omp: t(
      "omp kendi Claude ve Codex modelleriyle çalışır; istekleri ağ geçidinden geçer ve hesabı havuz seçer, omp’de giriş yapman gerekmez. Relay models.yml’e kendi bloğunu yazar; senin anthropic ya da openai-codex ayarın varsa yorum olarak saklanır. Ayır deyince dosya eski haline döner.",
      "omp keeps its own Claude and Codex models; their requests go through the gateway, the pool picks the account, and omp needs no sign-in of its own. Relay writes its own block into models.yml; your own anthropic or openai-codex entry is kept as a comment. Disconnect puts the file back as it was.",
    ),
  };
  return (
    <div className="grid gap-4">
      <Card padded data-slot="clients">
        <SectionHeading
          title={t("Araçları bağla", "Connect tools")}
          description={t(
            "Relay aracın kendi ayar dosyasına adresi ve anahtarı yazar. Ayır dediğinde dosyadaki eski değerleri geri koyar.",
            "Relay writes the address and key into the tool's own settings file. Disconnect puts the old values back.",
          )}
        />
        <ul className="grid pt-1">
          {(status.clients ?? []).map((client) => {
            const usable = usableFor(status.accounts, client.id);
            const provider = providerName(client.id);
            const word: ReturnType<typeof clientWord> =
              usable === 0 && !client.blocked
                ? client.bound
                  ? { tone: "warn", text: t(`Bağlı · kullanılabilir ${provider} hesabı yok`, `Connected · no usable ${provider} account`) }
                  : { tone: "off", text: t(`Havuzda ${provider} hesabı yok`, `No ${provider} account in the pool`) }
                : client.bound && missingFor(status.accounts, client.id).length
                  ? (() => {
                      const missing = missingFor(status.accounts, client.id).map((p) => PROVIDER_NAMES[p]).join(" / ");
                      return {
                        tone: "warn" as const,
                        text: t(`Bağlı · kullanılabilir ${missing} hesabı yok`, `Connected · no usable ${missing} account`),
                      };
                    })()
                  : clientWord(client, t, mac);
            return (
              <li
                key={client.id}
                data-client={client.id}
                data-bound={String(client.bound)}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-3 first:border-t-0"
              >
                <div className="grid min-w-[14rem] flex-1 gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {CLIENT_NAMES[client.id]}
                    {client.id === "claude-code" && (
                      <Badge variant="outline" className="text-ok-foreground">
                        {t("Önerilen", "Recommended")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{hints[client.id]}</span>
                  <span className="font-mono text-2xs text-muted-foreground">{client.file}</span>
                </div>
                <span className="flex items-center gap-1.5 text-xs">
                  <StatusDot tone={word.tone} hollow={word.tone === "off"} />
                  {word.text}
                </span>
                {!client.bound && !(client.blocked && client.stale) && usable === 0 ? (
                  // Bound with no account, every request would fail: the account comes first.
                  <Button asChild size="sm" variant="outline">
                    <a href={addAccountHash(CLIENT_PROVIDER(client.id))} data-slot="add-first">
                      <Plus />
                      {t(`Önce ${provider} hesabı ekle`, `Add a ${provider} account first`)}
                    </a>
                  </Button>
                ) : client.bound || (client.blocked && client.stale) ? (
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => onUnbind(client.id)}>
                    <Unlink />
                    {t("Ayır", "Disconnect")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={client.stale ? "default" : "outline"}
                    disabled={disabled || !!client.blocked}
                    onClick={() => onBind(client.id)}
                  >
                    <Link2 />
                    {client.stale ? t("Yeniden bağla", "Reconnect") : t("Bağla", "Connect")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card padded>
        <Disclosure
          title={t("Diğer araçlar (elle kurulum)", "Other tools (manual setup)")}
          summary={t("Cursor, OpenAI SDK, Antigravity, cURL", "Cursor, OpenAI SDK, Antigravity, cURL")}
        >
          <div className="grid gap-4 pt-2">
            <Note className="text-warn-foreground">
              {t(
                "Claude aboneliğini Claude Code dışındaki araçlarda kullanmak hesabını riske atabilir. Abonelik hesaplarını Claude Code ve Codex ile kullan.",
                "Using a Claude subscription in tools other than Claude Code can put the account at risk. Use subscription accounts with Claude Code and Codex.",
              )}
            </Note>
            <CodeBlock
              id="openai"
              title={t("OpenAI uyumlu araçlar (Cursor, SDK)", "OpenAI-compatible tools (Cursor, SDK)")}
              shown={openAiSnippet(host, port, key, true)}
              copyText={openAiSnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="antigravity"
              title={t("Antigravity modelleri · cURL", "Antigravity models · cURL")}
              shown={antigravitySnippet(host, port, key, true)}
              copyText={antigravitySnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="curl"
              title={t("Bağlantı testi · cURL", "Connection test · cURL")}
              shown={proxyCurlSnippet(host, port, key, true)}
              copyText={proxyCurlSnippet(host, port, key)}
              copy={copy}
            />
          </div>
        </Disclosure>
      </Card>
    </div>
  );
}
