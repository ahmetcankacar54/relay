/** The Proxy Gateway's settings, sign-ins, start and stop (Settings → Proxy). */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spentToday, type OverflowStatus } from "../../shared/overflow";
import {
  AFFINITY_REVISION,
  currentAffinityTtl,
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
} from "../../shared/proxy-types";
import { gatewayHostAllowed, gatewayUrl } from "../../shared/proxy-url";
import type { Account, ProxyStatus } from "../../shared/types";
import { OverflowKeys } from "../core/overflow-keys";
import { readCodexCredential } from "../core/provider-credentials";
import { GatewaySidecar } from "./gateway-sidecar";
import {
  PROXY_CLIENTS,
  bindClient,
  clientStatuses,
  tailscaleAddress,
  releaseClientSync,
  type ClientTarget,
} from "../core/proxy-clients";
import {
  buildProxyStatus,
  generateProxyKey,
  poolAccounts,
  proxyExtrasSchema,
  type ProxyExtras,
} from "../../shared/proxy-status";
import { readCredential, UsageError } from "../core/usage-credentials";
import { say } from "../i18n";
import { antigravityBridge } from "./antigravity";
import { gatewayRequests } from "./gateway-requests";
import { notifyLoopAlarm } from "./notifications";
import { proxyServer, service, set, usage, vaultSealer } from "./state";
import { scheduleStatusline } from "./statusline";
import { limitCalibrations } from "./tokens-widget";
/** Why the gateway is not running although it is turned on, shown on its page. */
let proxyError: string | undefined;
let proxyQueue: Promise<unknown> = Promise.resolve();
/** How long a read sign-in is reused before the Keychain is asked again. */
const PROXY_CREDENTIAL_TTL_MS = 20_000;
/** Whether the gateway could use each account's sign-in when it last read it, and when. */
const gatewaySignIns = new Map<string, { state: "ok" | "missing" | "expired"; at: number }>();
/** Accounts whose sign-in is being read for the gateway page now. */
const signInChecks = new Set<string>();
/** How long a sign-in the gateway has not read stays as it was last seen on its page. */
const SIGN_IN_CHECK_MS = 10 * 60_000;
/**
 * The sign-in the gateway sends for an account, when it can be used; notes how it stood, so the
 * gateway page can tell a saved sign-in from one the gateway can actually read. Never prompts.
 */
async function gatewayCredential(account: Account): Promise<{ accessToken: string; expiresAt?: number } | undefined> {
  const note = (state: "ok" | "missing" | "expired") => gatewaySignIns.set(account.id, { state, at: Date.now() });
  try {
    const credential =
      account.provider === "codex"
        ? await readCodexCredential(service.store.profile(account.id))
        : await readCredential(service.store.profile(account.id), false);
    if (!credential) {
      note("missing");
      return undefined;
    }
    // An expired token would only earn a 401; leave the account to the others.
    if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
      note("expired");
      return undefined;
    }
    note("ok");
    return credential;
  } catch (error) {
    // A locked Keychain says nothing about the sign-in itself.
    if (error instanceof UsageError && error.issue === "credentials-missing") note("missing");
    return undefined;
  }
}
/**
 * Reads again, in the background, the pool's sign-ins the gateway has not read for a while, so
 * its page shows an account it could not use before a request finds out.
 */
function checkGatewaySignIns(): void {
  if (!proxyServer) return;
  const now = Date.now();
  for (const account of poolAccounts(service.store.state.accounts, proxySettings())) {
    const provider = account.provider ?? "claude";
    if ((provider !== "claude" && provider !== "codex") || !account.auth?.loggedIn) continue;
    const seen = gatewaySignIns.get(account.id);
    if ((seen && now - seen.at < SIGN_IN_CHECK_MS) || signInChecks.has(account.id)) continue;
    signInChecks.add(account.id);
    void gatewayCredential(account)
      .then((credential) => {
        if (!credential && gatewaySignIns.get(account.id)?.state === "expired") renewForGateway(account.id);
      })
      .finally(() => signInChecks.delete(account.id));
  }
}
export const serializeProxy = <T>(task: () => Promise<T>): Promise<T> => {
  const run = proxyQueue.then(task);
  proxyQueue = run.catch(() => {});
  return run;
};
/**
 * The pool order, the accounts left out and the bound clients live in their own file beside the
 * registry: the registry's proxy settings are strict, so 0.18.2 (and older) can still read it.
 */
const proxyExtrasFile = () => path.join(service.store.root, "proxy-pool.json");
let proxyExtrasCache: ProxyExtras | undefined;
function proxyExtras(): ProxyExtras {
  if (proxyExtrasCache) return proxyExtrasCache;
  try {
    proxyExtrasCache = proxyExtrasSchema.parse(JSON.parse(fs.readFileSync(proxyExtrasFile(), "utf8")));
  } catch {
    // Missing or unreadable: an empty pool setup, every account in, no client bound.
    proxyExtrasCache = {};
  }
  return proxyExtrasCache;
}
export const proxySettings = (): ProxyConfig => {
  const config: ProxyConfig = {
    ...DEFAULT_PROXY_CONFIG,
    ...service.store.state.settings.proxy,
    ...proxyExtras(),
  };
  // A host older Relays accepted (the whole local network) falls back to this computer only.
  return gatewayHostAllowed(config.host) ? config : { ...config, host: DEFAULT_PROXY_CONFIG.host };
};
export const saveProxySettings = (config: ProxyConfig) => {
  const { accountOrder, excludedAccountIds, clientBindings, affinityRevision, subagentOverflow, overflow, ...base } = config;
  const extras: ProxyExtras = {
    ...(accountOrder ? { accountOrder } : {}),
    ...(excludedAccountIds ? { excludedAccountIds } : {}),
    ...(subagentOverflow ? { subagentOverflow } : {}),
    ...(affinityRevision !== undefined ? { affinityRevision } : {}),
    ...(clientBindings ? { clientBindings } : {}),
    ...(overflow ? { overflow } : {}),
  };
  if (JSON.stringify(extras) !== JSON.stringify(proxyExtras())) {
    const temp = `${proxyExtrasFile()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(extras, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, proxyExtrasFile());
    proxyExtrasCache = extras;
  }
  service.store.update((s) => {
    s.settings.proxy = base;
  });
};
/**
 * Moves a saved affinity lifetime that is the old five-minute default to the hour Claude Code's
 * cache lives, once: the revision beside the registry says it was done, so a lifetime chosen
 * afterwards stays. Before the gateway starts.
 */
export function settleProxyAffinity() {
  const extras = proxyExtras();
  if ((extras.affinityRevision ?? 0) >= AFFINITY_REVISION) return;
  const saved = service.store.state.settings.proxy;
  // Never used: nothing is saved, and the gateway takes the default when it is first turned on.
  if (!saved) {
    const next: ProxyExtras = { ...extras, affinityRevision: AFFINITY_REVISION };
    const temp = `${proxyExtrasFile()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, proxyExtrasFile());
    proxyExtrasCache = next;
    return;
  }
  saveProxySettings({
    ...proxySettings(),
    affinityRevision: AFFINITY_REVISION,
    affinityTtlSeconds:
      currentAffinityTtl(saved.affinityTtlSeconds, extras.affinityRevision) ??
      DEFAULT_PROXY_CONFIG.affinityTtlSeconds,
  });
}
/** Where bound clients dial the gateway: the saved address and key (none before the first start). */
export const clientTarget = (config: ProxyConfig): ClientTarget | undefined =>
  config.apiKey ? { url: gatewayUrl(config.host, config.port), key: config.apiKey } : undefined;
/** The overflow as the page shows it: today's spend in the planning day, and each key masked. */
function overflowStatus(config: ProxyConfig): OverflowStatus | undefined {
  const overflow = config.overflow;
  if (!overflow) return undefined;
  const spent = spentToday(gatewayRequests().overflowCosts(), Date.now(), service.store.state.settings.planning.timeZone);
  const hints = overflowKeys()?.hints() ?? {};
  return {
    enabled: overflow.enabled,
    trigger: overflow.trigger ?? "limited",
    ...(overflow.dailyCapUsd !== undefined ? { dailyCapUsd: overflow.dailyCapUsd } : {}),
    spentTodayUsd: spent,
    capReached: overflow.dailyCapUsd !== undefined && spent >= overflow.dailyCapUsd,
    upstreams: [...overflow.upstreams]
      .sort((a, b) => a.order - b.order)
      .map((upstream) => ({ ...upstream, ...(hints[upstream.id] ? { keyHint: hints[upstream.id] } : {}) })),
  };
}
export function proxyStatus(): ProxyStatus {
  const config = proxySettings();
  const state = proxyServer?.getState();
  const running = state?.status === "running";
  if (running) checkGatewaySignIns();
  return buildProxyStatus({
    running,
    config: running && state ? { ...config, port: state.port, host: state.host } : config,
    metrics: proxyServer?.getMetrics(),
    accounts: service.store.state.accounts,
    usage: usage?.snapshot() ?? {},
    now: Date.now(),
    error: proxyError,
    recent: proxyServer?.stats.recent() ?? [],
    ...(proxyServer ? { insights: proxyServer.insights } : {}),
    classShare: gatewayRequests().todayByClass(),
    calibrations: limitCalibrations(),
    ...(running && proxyServer ? { nextPick: proxyServer.nextPicks() } : {}),
    gatewaySignIn: (id) => {
      const seen = gatewaySignIns.get(id);
      return seen && seen.state !== "ok" ? seen.state : undefined;
    },
    tailscaleAddress: tailscaleAddress(),
    clients: clientStatuses(clientTarget(config), config),
    cooldownOf: (id) => proxyServer?.router.cooldownOf(id),
    overflow: overflowStatus(config),
  });
}
/**
 * Rewrites the clients Relay bound: after the address or key changed, after a start (quitting
 * put their files back), and when Relay writes more than it used to. A file already right is
 * left alone. The values saved for unbinding grow with what was added.
 */
async function rebindClients(config: ProxyConfig): Promise<void> {
  const target = clientTarget(config);
  if (!target) return;
  const bindings = { ...config.clientBindings };
  let changed = false;
  for (const id of PROXY_CLIENTS) {
    const previous = bindings[id];
    if (!previous) continue;
    const saved = await bindClient(id, target, previous).catch(() => undefined);
    if (saved && JSON.stringify(saved) !== JSON.stringify(previous)) {
      bindings[id] = saved;
      changed = true;
    }
  }
  if (changed) saveProxySettings({ ...proxySettings(), clientBindings: bindings });
}
/** While Relay quits: bound clients get their own settings back, since the gateway goes with it. */
export function releaseClients(): void {
  const bindings = proxySettings().clientBindings ?? {};
  for (const id of PROXY_CLIENTS) {
    const saved = bindings[id];
    if (saved) releaseClientSync(id, saved);
  }
}
/** Asks the usage reader to renew a Claude sign-in the gateway could not use; it backs off on its own. */
function renewForGateway(accountId: string): void {
  const account = service.store.state.accounts.find((a) => a.id === accountId);
  if (!account || (account.provider ?? "claude") !== "claude") return;
  try {
    void usage?.refresh(accountId).catch(() => {});
  } catch {}
}
/** The overflow upstreams' sealed API keys; none until the vault is open. */
let overflowKeyStore: OverflowKeys | undefined;
export function overflowKeys(): OverflowKeys | undefined {
  const sealer = vaultSealer;
  if (!overflowKeyStore && sealer)
    overflowKeyStore = new OverflowKeys(
      path.join(app.getPath("userData"), "desktop-vault"),
      (text) => sealer.seal(text),
      (data) => sealer.unseal(data),
    );
  return overflowKeyStore;
}
/**
 * The `relay` binary the gateway runs as (`relay __gateway`): bundled under the app's resources,
 * or in development `RELAY_GATEWAY_BIN` (an absolute path) or the workspace's debug build.
 */
export function gatewayBinary(): string {
  const name = process.platform === "win32" ? "relay.exe" : "relay";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", name);
  const chosen = process.env.RELAY_GATEWAY_BIN;
  if (chosen && path.isAbsolute(chosen)) return chosen;
  return path.join(app.getAppPath(), "target", "debug", name);
}
/** Starts the gateway on the saved port and host; a first start also creates the client key. */
export async function startProxy(): Promise<void> {
  if (proxyServer) return;
  let config = proxySettings();
  if (!config.apiKey) {
    config = { ...config, apiKey: generateProxyKey() };
    saveProxySettings(config);
  }
  const credentials = new Map<string, { token: string; until: number }>();
  const server = new GatewaySidecar({
    binary: gatewayBinary(),
    config,
    // OpenRouter's published prices for its overflow answers, read at most daily, kept on disk.
    openRouterPricesFile: path.join(app.getPath("userData"), "openrouter-prices.json"),
    hooks: {
      overflowKey: async (upstreamId) => overflowKeys()?.get(upstreamId),
      timeZone: () => service.store.state.settings.planning.timeZone,
      antigravity: async (account) => {
        if (account.provider !== "antigravity" || !account.auth?.loggedIn) return undefined;
        const bridge = antigravityBridge(account.id);
        if (!(await bridge.hasCredential())) return undefined;
        await bridge.start();
        return bridge.endpoint;
      },
      credential: async (account) => {
        const cached = credentials.get(account.id);
        if (cached && cached.until > Date.now()) return cached.token;
        credentials.delete(account.id);
        const credential = await gatewayCredential(account);
        if (!credential) return undefined;
        credentials.set(account.id, {
          token: credential.accessToken,
          until: Math.min(Date.now() + PROXY_CREDENTIAL_TTL_MS, credential.expiresAt ?? Infinity),
        });
        return credential.accessToken;
      },
      onCredentialRejected: (accountId) => {
        credentials.delete(accountId);
        // Refused although it read: the page shows it as renewing, not as working.
        gatewaySignIns.delete(accountId);
        renewForGateway(accountId);
      },
      // An expired or unreadable token: the usage reader renews it when it can (never prompts).
      onCredentialMissing: (accountId) => renewForGateway(accountId),
      // Every answer says how full the account's windows are: newer than the last read.
      onLiveLimits: (accountId, live) => {
        usage?.observe(accountId, live);
        // The status line names the account the gateway just used for the session.
        scheduleStatusline();
      },
      onLoopAlarm: (alarm) => notifyLoopAlarm(alarm),
      requestLog: gatewayRequests(),
      // The accounts as saved now and the limits as Relay last read them: quota-aware routing.
      // Only the accounts left in the pool, in its order (strict priority reads the order).
      usage: () => ({
        accounts: poolAccounts(service.store.state.accounts, proxySettings()),
        usageMap: usage?.snapshot() ?? {},
      }),
      // The gateway stopped by itself: the page says why, and a toggle starts it again.
      onExit: (message) => {
        if (proxyServer !== server) return;
        set.proxyServer(undefined);
        proxyError = message;
        scheduleStatusline();
      },
    },
  });
  try {
    await server.start();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    proxyError =
      code === "EADDRINUSE"
        ? say("electronMain.isAlreadyInUseChooseAnother", { configHost: config.host, configPort: config.port })
        : (error as Error).message;
    throw new Error(proxyError);
  }
  set.proxyServer(server);
  proxyError = undefined;
  scheduleStatusline();
  // Quitting put the bound clients' own settings back: they point at the gateway again.
  await rebindClients(proxySettings()).catch(() => {});
}
export async function stopProxy(): Promise<void> {
  const server = proxyServer;
  set.proxyServer(undefined);
  await server?.stop().catch(() => {});
  scheduleStatusline();
}
/**
 * Saves `next`. A running gateway takes a new routing strategy, session time or client key at
 * once, keeping its open streams and sessions; only a new host or port restarts it, and the old
 * settings return if it cannot start there.
 */
export async function applyProxyConfig(next: ProxyConfig): Promise<void> {
  const previous = proxySettings();
  saveProxySettings(next);
  if (next.host !== previous.host || next.port !== previous.port || next.apiKey !== previous.apiKey)
    await rebindClients(next);
  if (!proxyServer) return;
  if (next.host === previous.host && next.port === previous.port) {
    proxyServer.updateConfig({
      routingStrategy: next.routingStrategy,
      affinityTtlSeconds: next.affinityTtlSeconds,
      apiKey: next.apiKey,
      subagentOverflow: next.subagentOverflow === true,
      overflow: next.overflow,
    });
    return;
  }
  await stopProxy();
  try {
    await startProxy();
  } catch (error) {
    saveProxySettings(previous);
    await rebindClients(previous);
    await startProxy().catch(() => {});
    throw error;
  }
}
/** The gateway was turned off: its last start error no longer applies. */
export function clearProxyError() {
  proxyError = undefined;
}
/** proxy-pool.json changed underneath (an account removed): read it again next time. */
export function resetProxyExtrasCache() {
  proxyExtrasCache = undefined;
}
