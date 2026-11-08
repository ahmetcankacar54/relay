import http from "node:http";
import type { Command } from "../command";
import { openContext, type CliContext } from "../context";
import { colorEnabled, paint, printJson } from "../output";
import { CliError, EXIT } from "../io";
import { acquireProfileLock } from "../../../electron/core/profile-lock";
import { diagnoseCli } from "../../../electron/core/cli-diagnostics";
import { ProxyServer } from "../../../electron/core/proxy/proxy-server";
import { UsageManager } from "../../../electron/core/usage";
import { UsageError, readCredential } from "../../../electron/core/usage-credentials";
import { UsageCredentialRefresher, anthropicUnreachable } from "../../../electron/core/usage-refresh";
import { DEFAULT_PROXY_CONFIG } from "../../../shared/proxy-types";
import { readsUsage } from "../../../shared/cli-version";
import type { AccountUsage } from "../../../shared/types";

/** How often limits are re-read, so routing follows the real 5-hour and weekly windows. */
const USAGE_REFRESH_MS = 2 * 60_000;
/** How long a read credential is reused before the Keychain is asked again. */
const CREDENTIAL_TTL_MS = 20_000;
const STATUS_TIMEOUT_MS = 3_000;

const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The host a client should dial: a wildcard bind address is reached through loopback. */
const clientHost = (host: string) =>
  host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "[::1]" : bracketed(host);

const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

function parsePort(raw: string | boolean | undefined, t: (tr: string, en: string) => string): number {
  if (raw === undefined) return DEFAULT_PROXY_CONFIG.port;
  const port = typeof raw === "string" && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new CliError(
      t("--port 1 ile 65535 arasında bir sayı olmalı.", "--port must be a number from 1 to 65535."),
      EXIT.usage,
    );
  return port;
}

function parseHost(raw: string | boolean | undefined, t: (tr: string, en: string) => string): string {
  if (raw === undefined) return DEFAULT_PROXY_CONFIG.host;
  if (typeof raw !== "string" || !raw.trim() || /[\s/@?#]/.test(raw))
    throw new CliError(t("--host geçerli bir adres olmalı.", "--host must be a valid address."), EXIT.usage);
  return raw.trim();
}

/** Reads the gateway's /status; rejects when nothing answers or the answer is not JSON. */
function fetchStatus(host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: clientHost(host).replace(/^\[|\]$/g, ""), port, path: "/status", timeout: STATUS_TIMEOUT_MS },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) req.destroy(new Error("response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    // The timeout option only reports; the request has to be ended by hand.
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Reads the limits of every connected account, the same way `relay usage` does. */
function createUsageReader(ctx: CliContext) {
  const explicit = ctx.deps.claude(ctx.store.state.executable);
  const read = (profile: string, allowPrompt: boolean) =>
    readCredential(profile, allowPrompt, ctx.deps.securityTool);
  const refresher = new UsageCredentialRefresher({
    executable: async () => {
      const d = await diagnoseCli(explicit, ctx.paths.data);
      if (!d.executable || d.error || !readsUsage(d.version ?? "")) throw new UsageError("unavailable");
      return d.executable;
    },
    read,
    request: ctx.deps.request,
    profileLock: (id) => acquireProfileLock(ctx.paths.locks, id, "exclusive"),
    unreachable: () => anthropicUnreachable(),
  });
  const manager = new UsageManager(
    ctx.store,
    read,
    ctx.deps.request,
    ctx.io.now,
    () => {},
    (account, credential, force, interaction) =>
      refresher.refresh(account, ctx.store.profile(account.id), credential, force, interaction),
    (account) => refresher.hasPending(ctx.store.profile(account.id)),
  );
  return (id: string) => manager.refresh(id, false);
}

export const proxyCommand: Command = async ({ io, deps, parsed, t }) => {
  const subcommand = parsed.positionals[0] ?? "status";
  if (parsed.positionals.length > 1)
    throw new CliError(
      t("relay proxy tek bir alt komut alır: start, status, env.", "relay proxy takes one subcommand: start, status, env."),
      EXIT.usage,
    );
  if (!["start", "status", "env"].includes(subcommand))
    throw new CliError(
      t(
        `Bilinmeyen proxy alt komutu: ${subcommand}. Beklenen: start, status, env.`,
        `Unknown proxy subcommand: ${subcommand}. Expected: start, status, env.`,
      ),
      EXIT.usage,
    );

  const port = parsePort(parsed.flags.port, t);
  const host = parseHost(parsed.flags.host, t);
  const color = colorEnabled(io, parsed.flags);
  const url = `http://${clientHost(host)}:${port}`;

  if (subcommand === "env") {
    // Plain lines: the output is meant for `eval "$(relay proxy env)"`.
    io.stdout(`export ANTHROPIC_BASE_URL="${url}"`);
    io.stdout(`export CODEX_BASE_URL="${url}"`);
    return EXIT.ok;
  }

  if (subcommand === "status") {
    try {
      const data = await fetchStatus(host, port);
      if (parsed.flags.json) {
        printJson(io, { running: true, ...data });
      } else {
        io.stdout(paint(color, "green", `Relay Proxy Gateway is running on ${host}:${port}`));
        io.stdout(`Status: ${data.state?.status}`);
        io.stdout(`Active Sessions: ${data.state?.activeSessionsCount}`);
        io.stdout(`Total Requests: ${data.metrics?.totalRequests}`);
        io.stdout(`Cache Hit Ratio: ${((data.metrics?.cacheHitRatio ?? 0) * 100).toFixed(1)}%`);
      }
    } catch {
      if (parsed.flags.json) {
        printJson(io, { running: false, port, host });
      } else {
        io.stdout(paint(color, "dim", `Relay Proxy Gateway is NOT running on ${host}:${port}`));
        io.stdout(`Run 'relay proxy start' to start the local gateway.`);
      }
    }
    return EXIT.ok;
  }

  // start
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const store = ctx.store;
  const usageCache: Record<string, AccountUsage | undefined> = {};
  const credentials = new Map<string, { token: string; until: number }>();

  const proxy = new ProxyServer({
    config: { host, port, enabled: true },
    credentialResolver: async (account) => {
      const cached = credentials.get(account.id);
      if (cached && cached.until > io.now()) return cached.token;
      credentials.delete(account.id);
      try {
        const cred = await readCredential(
          ctx.store.profile(account.id),
          false,
          ctx.deps.securityTool,
        );
        // An expired token would only earn a 401; leave the account to the others.
        if (cred.expiresAt !== undefined && cred.expiresAt <= io.now()) return undefined;
        credentials.set(account.id, {
          token: cred.accessToken,
          until: Math.min(io.now() + CREDENTIAL_TTL_MS, cred.expiresAt ?? Infinity),
        });
        return cred.accessToken;
      } catch {
        return undefined;
      }
    },
    usageProvider: () => ({
      accounts: store.state.accounts,
      usageMap: usageCache,
    }),
  });

  io.stdout(paint(color, "cyan", `Starting Relay Proxy Gateway on ${host}:${port}...`));
  let state;
  try {
    state = await proxy.start();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      code === "EADDRINUSE"
        ? t(`${host}:${port} kullanımda. Başka bir --port dene.`, `${host}:${port} is already in use. Try another --port.`)
        : t(`Ağ geçidi başlatılamadı: ${(error as Error).message}`, `The gateway could not start: ${(error as Error).message}`),
      code === "EADDRINUSE" ? EXIT.busy : EXIT.failed,
    );
  }
  io.stdout(paint(color, "green", `✓ Gateway listening on ${state.endpointUrl}`));
  if (!isLoopback(host))
    io.stderr(
      paint(
        color,
        "yellow",
        t(
          `Uyarı: ${host} yerel olmayan bir adres; ağ geçidinin kimlik doğrulaması yok, erişebilen herkes hesaplarını kullanır. Tailscale gibi kapalı bir ağ kullan.`,
          `Warning: ${host} is not a loopback address; the gateway has no authentication, so anyone who can reach it spends your accounts. Keep it on a private network such as Tailscale.`,
        ),
      ),
    );
  io.stdout(paint(color, "yellow", `Set in your environment or remote box via Tailscale:`));
  io.stdout(`  export ANTHROPIC_BASE_URL="${url}"`);
  io.stdout(`  export CODEX_BASE_URL="${url}"`);

  // Keep the limits (and the account list) current in the background.
  let reading = false;
  const readUsage = createUsageReader(ctx);
  const refreshUsage = async () => {
    if (reading) return;
    reading = true;
    try {
      try {
        store.reload();
      } catch {
        // Keep routing on the list already loaded.
      }
      for (const account of store.state.accounts) {
        if (!account.auth?.loggedIn) continue;
        try {
          usageCache[account.id] = await readUsage(account.id);
        } catch {
          // Routing falls back to what it last knew, or to no data for this account.
        }
      }
    } finally {
      reading = false;
    }
  };
  void refreshUsage();
  const timer = setInterval(() => void refreshUsage(), USAGE_REFRESH_MS);
  timer.unref();

  try {
    await new Promise<void>((resolve) => {
      let stopping = false;
      io.onSignal(() => {
        if (stopping) {
          // A second Ctrl+C leaves at once.
          resolve();
          return;
        }
        stopping = true;
        io.stdout(paint(color, "yellow", "\nStopping Relay Proxy Gateway..."));
        proxy.stop().then(resolve, resolve);
      });
    });
  } finally {
    clearInterval(timer);
    io.onSignal(undefined);
    await proxy.stop().catch(() => {});
  }
  return EXIT.ok;
};
