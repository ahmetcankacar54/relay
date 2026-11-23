/** The Proxy Gateway's page: on and off, its settings, bound clients and the API-key overflow. */
import { clipboard } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { clientRisks, gatewayRisks, proxyPatchRisks } from "../../../shared/feature-risk";
import { DEFAULT_OVERFLOW_CAP_USD, type OverflowSettings } from "../../../shared/overflow";
import type { ProxyClientId } from "../../../shared/proxy-types";
import { testOverflowUpstream } from "../../core/proxy/overflow-upstream";
import { bindClient, unbindClient } from "../../core/proxy/proxy-clients";
import {
  apiUpstreamSchema,
  generateProxyKey,
  overflowConfigurePatch,
  overflowSettingsSchema,
  overflowUpstreamInput,
  proxyConfigurePatch,
} from "../../core/proxy/proxy-status";
import { say } from "../../i18n";
import {
  applyProxyConfig,
  clearProxyError,
  clientTarget,
  overflowKeys,
  proxySettings,
  proxyStatus,
  saveProxySettings,
  serializeProxy,
  startProxy,
  stopProxy,
} from "../gateway";
import { service } from "../state";
import { broadcastChanged } from "../windows";
import type { IpcKit } from "./index";
export function registerProxyIpc({ handle, requireRisk }: IpcKit) {
  // The windows show it; every switch, sign-in or recovery rechecks fresh in main.
  handle("proxy-status", () => proxyStatus());
  handle("proxy-toggle", (enabled) =>
    serializeProxy(async () => {
      const on = z.boolean().parse(enabled);
      const config = proxySettings();
      const boundClients = Object.keys(config.clientBindings ?? {}) as ProxyClientId[];
      if (on) requireRisk(gatewayRisks({ ...config, boundClients }, service.store.state.accounts));
      saveProxySettings({ ...config, enabled: on });
      if (on) {
        try {
          await startProxy();
        } catch (error) {
          // Switched back off, so the page does not claim a gateway that is not there.
          saveProxySettings({ ...proxySettings(), enabled: false });
          broadcastChanged();
          throw error;
        }
      } else {
        await stopProxy();
        clearProxyError();
      }
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-configure", (input) =>
    serializeProxy(async () => {
      const patch = proxyConfigurePatch.parse(input);
      requireRisk(proxyPatchRisks(proxySettings(), patch, service.store.state.accounts));
      await applyProxyConfig({ ...proxySettings(), ...patch });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-regenerate-key", () =>
    serializeProxy(async () => {
      await applyProxyConfig({ ...proxySettings(), apiKey: generateProxyKey() });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("copy-text", (text) => {
    clipboard.writeText(z.string().max(16_384).parse(text));
  });
  handle("proxy-bind-client", (input) =>
    serializeProxy(async () => {
      const clientId = z.enum(["claude-code", "codex", "omp"]).parse(input);
      requireRisk(clientRisks(clientId));
      let config = proxySettings();
      if (!config.apiKey) {
        config = { ...config, apiKey: generateProxyKey() };
        saveProxySettings(config);
      }
      const saved = await bindClient(clientId, clientTarget(config)!, config.clientBindings?.[clientId]);
      saveProxySettings({ ...proxySettings(), clientBindings: { ...config.clientBindings, [clientId]: saved } });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  handle("proxy-unbind-client", (input) =>
    serializeProxy(async () => {
      const clientId = z.enum(["claude-code", "codex", "omp"]).parse(input);
      const config = proxySettings();
      await unbindClient(clientId, config.clientBindings?.[clientId]);
      const bindings = { ...config.clientBindings };
      delete bindings[clientId];
      saveProxySettings({ ...config, clientBindings: bindings });
      broadcastChanged();
      return proxyStatus();
    }),
  );
  // API-key overflow (W3-1): R0, an API key is billed per token and allowed for this use.
  const noOverflow: OverflowSettings = { enabled: false, upstreams: [] };
  /** Saves the overflow setup; a running gateway takes it at once, keeping its streams. */
  const saveOverflow = async (next: OverflowSettings) => {
    await applyProxyConfig({ ...proxySettings(), overflow: overflowSettingsSchema.parse(next) });
    broadcastChanged();
    return proxyStatus();
  };
  const upstreamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  handle("proxy-overflow-configure", (input) =>
    serializeProxy(async () => {
      const patch = overflowConfigurePatch.parse(input);
      const next: OverflowSettings = { ...noOverflow, ...proxySettings().overflow };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.trigger) next.trigger = patch.trigger;
      if (patch.dailyCapUsd === null) delete next.dailyCapUsd;
      else if (patch.dailyCapUsd !== undefined) next.dailyCapUsd = patch.dailyCapUsd;
      // Turned on with no cap ever chosen: the default one, so a first day cannot run away.
      else if (patch.enabled && next.dailyCapUsd === undefined) next.dailyCapUsd = DEFAULT_OVERFLOW_CAP_USD;
      if (patch.order) {
        const rank = new Map(patch.order.map((id, index) => [id, index]));
        next.upstreams = [...next.upstreams]
          .sort((a, b) => (rank.get(a.id) ?? rank.size + a.order) - (rank.get(b.id) ?? rank.size + b.order))
          .map((upstream, order) => ({ ...upstream, order }));
      }
      return saveOverflow(next);
    }),
  );
  handle("proxy-overflow-save-upstream", (input) =>
    serializeProxy(async () => {
      const { key, id: given, ...fields } = overflowUpstreamInput.parse(input);
      const keys = overflowKeys();
      if (!keys) throw new Error(say("dataBackup.errorVaultNotReady"));
      const current: OverflowSettings = { ...noOverflow, ...proxySettings().overflow };
      const existing = given ? current.upstreams.find((u) => u.id === given) : undefined;
      if (given && !existing) throw new Error("This overflow upstream no longer exists.");
      if (!existing && !key) throw new Error("Enter this overflow upstream’s API key first.");
      const upstream = apiUpstreamSchema.parse({
        ...fields,
        id: existing?.id ?? randomUUID(),
        order: existing?.order ?? current.upstreams.length,
      });
      // The key is sealed before the upstream is saved: a saved upstream always has its key.
      if (key) await keys.set(upstream.id, key);
      const upstreams = existing
        ? current.upstreams.map((u) => (u.id === upstream.id ? upstream : u))
        : [...current.upstreams, upstream];
      return saveOverflow({ ...current, upstreams });
    }),
  );
  handle("proxy-overflow-remove-upstream", (input) =>
    serializeProxy(async () => {
      const id = upstreamId.parse(input);
      const current = proxySettings().overflow;
      if (!current) return proxyStatus();
      await overflowKeys()?.remove(id);
      const upstreams = current.upstreams
        .filter((u) => u.id !== id)
        .sort((a, b) => a.order - b.order)
        .map((upstream, order) => ({ ...upstream, order }));
      return saveOverflow({ ...current, upstreams, enabled: current.enabled && upstreams.length > 0 });
    }),
  );
  // A one-token request with the saved key; the answer never holds the key.
  handle("proxy-overflow-test", async (input) => {
    const id = upstreamId.parse(input);
    const upstream = proxySettings().overflow?.upstreams.find((u) => u.id === id);
    if (!upstream) throw new Error("This overflow upstream no longer exists.");
    const key = await overflowKeys()?.get(id);
    if (!key) throw new Error("Enter this overflow upstream’s API key first.");
    return testOverflowUpstream(upstream, key);
  });
}
