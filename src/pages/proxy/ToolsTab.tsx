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
        <Button variant="ghost" size="sm" aria-label={t("toolsTab.copy", { title })} onClick={() => copy.copy(id, copyText)}>
          {copy.copied === id ? <Check className="text-ok" /> : <CopyIcon />}
          {copy.copied === id ? t("toolsTab.copied") : t("common.copy")}
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
      text: t("toolsTab.openOmpOnceFirstItMoves"),
    };
  if (client.blocked === "unsupported-layout")
    return { tone: "warn", text: t("toolsTab.modelsYmlSLayoutNeedsA") };
  if (client.blocked === "inline-providers")
    return { tone: "warn", text: t("toolsTab.modelsYmlWritesProvidersInline") };
  if (client.blocked) return { tone: "warn", text: t("toolsTab.cannotReadItsSettings") };
  if (client.bound) return { tone: "ok", text: t("toolsTab.connected") };
  if (client.stale) return { tone: "warn", text: t("toolsTab.oldAddressOrKey") };
  if (!client.installed)
    return {
      tone: "off",
      text: mac ? t("toolsTab.notFoundOnThisMac") : t("toolsTab.notFoundOnThisComputer"),
    };
  return { tone: "off", text: t("toolsTab.notConnected") };
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
    "claude-code": t("toolsTab.whileConnectedTheGatewayPicksThe"),
    codex: t("toolsTab.relayAddsItsProviderToCodex"),
    omp: t("toolsTab.ompKeepsItsOwnClaudeAnd"),
  };
  return (
    <div className="grid gap-4">
      <Card padded data-slot="clients">
        <SectionHeading
          title={t("toolsTab.connectTools")}
          description={t("toolsTab.relayWritesTheAddressAndKey")}
        />
        <ul className="grid pt-1">
          {(status.clients ?? []).map((client) => {
            const usable = usableFor(status.accounts, client.id);
            const provider = providerName(client.id);
            const word: ReturnType<typeof clientWord> =
              usable === 0 && !client.blocked
                ? client.bound
                  ? { tone: "warn", text: t("toolsTab.connectedNoUsableAccount", { provider }) }
                  : { tone: "off", text: t("toolsTab.noAccountInThePool", { provider }) }
                : client.bound && missingFor(status.accounts, client.id).length
                  ? (() => {
                      const missing = missingFor(status.accounts, client.id).map((p) => PROVIDER_NAMES[p]).join(" / ");
                      return {
                        tone: "warn" as const,
                        text: t("toolsTab.connectedNoUsableAccount2", { missing }),
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
                        {t("toolsTab.recommended")}
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
                      {t("toolsTab.addAAccountFirst", { provider })}
                    </a>
                  </Button>
                ) : client.bound || (client.blocked && client.stale) ? (
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => onUnbind(client.id)}>
                    <Unlink />
                    {t("toolsTab.disconnect")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={client.stale ? "default" : "outline"}
                    disabled={disabled || !!client.blocked}
                    onClick={() => onBind(client.id)}
                  >
                    <Link2 />
                    {client.stale ? t("toolsTab.reconnect") : t("common.connect")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card padded>
        <Disclosure
          title={t("toolsTab.otherToolsManualSetup")}
          summary={t("toolsTab.cursorOpenaiSdkAntigravityCurl")}
        >
          <div className="grid gap-4 pt-2">
            <Note className="text-warn-foreground">
              {t("toolsTab.usingAClaudeSubscriptionInTools")}
            </Note>
            <CodeBlock
              id="openai"
              title={t("toolsTab.openaiCompatibleToolsCursorSdk")}
              shown={openAiSnippet(host, port, key, true)}
              copyText={openAiSnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="antigravity"
              title={t("toolsTab.antigravityModelsCurl")}
              shown={antigravitySnippet(host, port, key, true)}
              copyText={antigravitySnippet(host, port, key)}
              copy={copy}
            />
            <CodeBlock
              id="curl"
              title={t("toolsTab.connectionTestCurl")}
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
