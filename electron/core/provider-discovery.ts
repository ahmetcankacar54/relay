import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  Account,
  DetectedProviderSession,
  OneClickCascadeResult,
  OneClickConnectInput,
} from "../../shared/types";
import type { Store } from "./store";
import { directories, identity, readObject, uuid } from "./desktop-files";
import {
  codexAuthFiles,
  readCodexCliSession,
  readOpenAiApiKey,
  tokenExpiry,
  writeCodexCredential,
  type CodexCredential,
} from "./provider-credentials";

export const oneClickConnectSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    name: z.string().trim().min(1).max(64),
    kind: z.enum(["personal", "work"]),
    group: z.string().trim().min(1).max(64).optional(),
    /** Codex only: an OpenAI API key typed by the user. */
    apiKey: z.string().trim().max(16_384).optional(),
  })
  .strict();

export interface ProviderDiscoveryPaths {
  homeDir?: string;
  claudeDesktopRoot?: string;
  env?: NodeJS.ProcessEnv;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The Claude app's current sign-in and its Code workspaces, as Desktop keeps them. */
async function inspectClaude(
  accounts: readonly Account[],
  desktopRoot: string,
): Promise<DetectedProviderSession & { orgs: string[] }> {
  const config = await readObject(desktopRoot, "config.json").catch(() => null);
  const accountUuid = identity(config);
  const oauth =
    config?.oauthAccount && typeof config.oauthAccount === "object"
      ? (config.oauthAccount as Record<string, unknown>)
      : undefined;
  const orgs = accountUuid
    ? await directories(desktopRoot, `claude-code-sessions/${accountUuid}`)
        .then((list) => list.filter((org) => uuid.safeParse(org).success))
        .catch(() => [])
    : [];
  const linked = accountUuid
    ? accounts.find(
        (a) =>
          (a.provider ?? "claude") === "claude" &&
          a.desktop?.accountUuid?.toLowerCase() === accountUuid.toLowerCase(),
      )
    : undefined;
  const email = str(oauth?.emailAddress) ?? str(oauth?.email);
  const orgName = str(oauth?.organizationName);
  return {
    provider: "claude",
    detected: !!accountUuid,
    ...(email ? { email } : {}),
    ...(accountUuid ? { accountUuid } : {}),
    ...(orgs.length === 1 ? { orgId: orgs[0] } : {}),
    ...(orgName ? { orgName } : {}),
    ...(accountUuid ? { source: "Claude Desktop" } : {}),
    ...(linked ? { alreadyLinkedAccountId: linked.id, alreadyLinkedAccountName: linked.name } : {}),
    orgs,
  };
}

/** The Codex CLI's sign-in, or an OpenAI API key it or the environment holds. */
async function inspectCodex(
  accounts: readonly Account[],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<DetectedProviderSession> {
  const files = codexAuthFiles(homeDir);
  const session = await readCodexCliSession(files);
  const tilde = (file: string) =>
    file.startsWith(homeDir) ? `~${file.slice(homeDir.length)}` : file;
  if (session) {
    const expiresAt = tokenExpiry(session.accessToken);
    const usable = expiresAt === undefined || expiresAt > Date.now();
    const linked = accounts.find(
      (a) =>
        a.provider === "codex" &&
        ((session.accountId && a.auth?.accountUuid === session.accountId) ||
          (session.email && a.auth?.email?.toLowerCase() === session.email.toLowerCase())),
    );
    return {
      provider: "codex",
      detected: usable,
      ...(session.email ? { email: session.email } : {}),
      ...(session.plan ? { plan: session.plan } : {}),
      source: tilde(files[0]),
      ...(linked ? { alreadyLinkedAccountId: linked.id, alreadyLinkedAccountName: linked.name } : {}),
    };
  }
  const key = await readOpenAiApiKey(files, env);
  return {
    provider: "codex",
    detected: !!key,
    ...(key ? { plan: "API key", source: env.OPENAI_API_KEY?.trim() === key ? "OPENAI_API_KEY" : tilde(files[0]) } : {}),
  };
}

export async function detectProviders(
  accounts: readonly Account[],
  paths: ProviderDiscoveryPaths = {},
): Promise<DetectedProviderSession[]> {
  const homeDir = paths.homeDir ?? os.homedir();
  const desktopRoot =
    paths.claudeDesktopRoot ??
    path.join(homeDir, "Library", "Application Support", "Claude");
  const env = paths.env ?? process.env;
  const [claude, codex] = await Promise.all([
    inspectClaude(accounts, desktopRoot),
    inspectCodex(accounts, homeDir, env),
  ]);
  const { orgs: _orgs, ...claudeSession } = claude;
  return [claudeSession, codex, { provider: "antigravity", detected: false }];
}

/** Asks OpenAI whether an API key works: one cheap model list. */
export async function checkOpenAiKey(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "rejected" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export interface OneClickCascadeDeps {
  store: Store;
  desktopRoot: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Saves the Claude app's current sign-in (and the workspace) into the profile. */
  captureDesktop?: (accountId: string, orgId: string) => Promise<void>;
  /** Starts a Claude app sign-in for the profile: Claude quits and opens signed out. */
  beginDesktopLogin?: (accountId: string) => Promise<void>;
  /** Saves the sign-in by itself once it and a Code workspace are there. */
  armAutoCapture?: (accountId: string) => void;
  checkTerminal?: () => Promise<unknown>;
  checkExtension?: (accountId: string) => Promise<unknown>;
  refreshUsage?: (accountId: string) => Promise<unknown>;
  checkOpenAiKey?: (key: string) => Promise<"ok" | "rejected" | "unreachable">;
  now?: () => number;
}

/** Thrown before anything is saved: the credential does not work or is already an account. */
export class ConnectError extends Error {}

/**
 * Adds a Claude or Codex account in one step.
 *
 * Claude: the Claude app's current sign-in is saved when it is not an account yet (straight
 * away with one Code workspace, otherwise once the user opens Code or picks one); otherwise a
 * new Claude app sign-in starts. Nothing is copied from the Claude Code CLI: its refresh token
 * rotates, and a second holder would log it out. The sign-in state comes from the capture.
 *
 * Codex: a typed or detected OpenAI API key is checked with OpenAI first; a Codex CLI ChatGPT
 * sign-in is used while it has not expired, without its refresh token. The account is only
 * marked signed in with a credential that passed, and the plan is only what the token says.
 */
export async function executeOneClickCascade(
  rawInput: OneClickConnectInput,
  deps: OneClickCascadeDeps,
): Promise<OneClickCascadeResult> {
  const input = oneClickConnectSchema.parse(rawInput);
  const homeDir = deps.homeDir ?? os.homedir();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  if (input.provider === "claude") {
    const current = await inspectClaude(deps.store.state.accounts, deps.desktopRoot);
    const account = deps.store.create({
      name: input.name,
      kind: input.kind,
      group: input.group,
      provider: "claude",
    });
    const unsaved = !!current.accountUuid && !current.alreadyLinkedAccountId;
    let desktop: OneClickCascadeResult["layers"]["desktop"] = "pending";
    let needsSignIn = false;
    if (unsaved && current.orgs.length === 1 && deps.captureDesktop) {
      try {
        await deps.captureDesktop(account.id, current.orgs[0]);
        desktop = "done";
      } catch {
        deps.armAutoCapture?.(account.id);
      }
    } else if (unsaved) {
      // Code not opened yet, or several workspaces: saved once it is there or one is picked.
      deps.armAutoCapture?.(account.id);
    } else if (deps.beginDesktopLogin) {
      try {
        await deps.beginDesktopLogin(account.id);
      } catch (error) {
        // Claude could not start the sign-in (busy, refused to quit): no empty account is left.
        deps.store.update((s) => {
          s.accounts = s.accounts.filter((a) => a.id !== account.id);
        });
        throw error;
      }
      deps.armAutoCapture?.(account.id);
      needsSignIn = true;
    }

    await deps.checkTerminal?.().catch(() => {});
    await deps.checkExtension?.(account.id).catch(() => {});
    if (desktop === "done") await deps.refreshUsage?.(account.id).catch(() => {});

    const updated = deps.store.account(account.id);
    const linked = !!updated.desktop;
    return {
      account: updated,
      layers: {
        desktop: linked ? "done" : desktop,
        usage: linked ? "done" : "pending",
        terminal: linked ? "done" : "pending",
        extensionAndProxy: linked ? "done" : "pending",
      },
      ...(needsSignIn ? { needsSignIn: true } : {}),
    };
  }

  const check = deps.checkOpenAiKey ?? ((key: string) => checkOpenAiKey(key));
  const files = codexAuthFiles(homeDir);
  let credential: CodexCredential;
  let email: string | undefined;
  let plan: string | undefined;
  const typed = input.apiKey?.trim();
  const session = typed ? undefined : await readCodexCliSession(files);
  const sessionExpiry = session ? tokenExpiry(session.accessToken) : undefined;
  if (session && (sessionExpiry === undefined || sessionExpiry > now())) {
    credential = {
      kind: "chatgpt",
      accessToken: session.accessToken,
      ...(sessionExpiry ? { expiresAt: sessionExpiry } : {}),
      ...(session.accountId ? { accountId: session.accountId } : {}),
    };
    email = session.email;
    plan = session.plan;
  } else {
    const key = typed || (await readOpenAiApiKey(files, env));
    if (!key)
      throw new ConnectError(
        session
          ? "The Codex CLI sign-in has expired. Run codex once to renew it, or enter an OpenAI API key."
          : "No usable credential found for this provider",
      );
    if (!key.startsWith("sk-"))
      throw new ConnectError("An OpenAI API key starts with sk-.");
    const verdict = await check(key);
    if (verdict === "rejected") throw new ConnectError("OpenAI rejected this API key.");
    if (verdict === "unreachable")
      throw new ConnectError("OpenAI could not be reached to check the key. Try again.");
    credential = { kind: "api-key", accessToken: key };
    plan = "API key";
  }

  const existing = deps.store.state.accounts.find(
    (a) =>
      a.provider === "codex" &&
      ((credential.accountId && a.auth?.accountUuid === credential.accountId) ||
        (credential.kind === "chatgpt" && email && a.auth?.email?.toLowerCase() === email.toLowerCase())),
  );
  if (existing) throw new ConnectError(`This sign-in is already the account ${existing.name}.`);

  const account = deps.store.create({
    name: input.name,
    kind: input.kind,
    group: input.group,
    provider: "codex",
  });
  try {
    await writeCodexCredential(deps.store.profile(account.id), credential);
  } catch (error) {
    deps.store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== account.id);
    });
    throw error;
  }
  const accountUuid =
    credential.accountId && uuid.safeParse(credential.accountId).success
      ? credential.accountId
      : undefined;
  deps.store.update((s) => {
    const stored = s.accounts.find((a) => a.id === account.id);
    if (!stored) return;
    stored.auth = {
      loggedIn: true,
      checkedAt: new Date(now()).toISOString(),
      ...(email ? { email } : {}),
      ...(accountUuid ? { accountUuid } : {}),
      ...(plan ? { subscription: plan } : {}),
    };
  });

  return {
    account: deps.store.account(account.id),
    layers: {
      desktop: "skipped",
      usage: "skipped",
      terminal: "skipped",
      extensionAndProxy: "done",
    },
  };
}
