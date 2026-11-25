import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeterError } from "../electron/core/meters/common";
import {
  copilotTokenFromFile,
  findCopilotToken,
  ghTokenFromHosts,
  parseCopilotUser,
  readCopilot,
} from "../electron/core/meters/copilot";
import {
  cursorSessionCookie,
  cursorStatePath,
  parseCursorLegacyUsage,
  parseCursorSummary,
  readCursor,
} from "../electron/core/meters/cursor";
import {
  parseGeminiQuota,
  parseLoadCodeAssist,
  readGeminiCli,
} from "../electron/core/meters/gemini-cli";
import { MeterService } from "../electron/core/meters";
import { settingsPatchSchema, settingsSchema } from "../electron/core/store";
import {
  FEATURE_RISKS,
  POLICY_LINKS,
  acknowledgeRisks,
  enabledRisks,
  meterRisks,
  requireRiskAck,
  turnOffSteps,
} from "../shared/feature-risk";
import { isExternalLink } from "../shared/external-links";
import type { MeterProvider, MeterReading } from "../shared/meters";
import { DEFAULT_SETTINGS, type Snapshot } from "../shared/types";
import { en } from "../shared/i18n/catalogs/en";
import { MetersCard } from "../src/pages/overview/MetersCard";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue } from "./i18n";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const GH_TOKEN = "gho_madeUpCopilotTokenForTests0123456789";

async function tempHome(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "relay-meters-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** A local server standing in for the providers: answers by path, records what each request sent. */
async function fakeProvider(
  t: test.TestContext,
  answer: (url: string, body: string) => { status: number; body: unknown },
) {
  const seen: {
    url: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      });
      const out = answer(req.url ?? "", body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(
        typeof out.body === "string" ? out.body : JSON.stringify(out.body),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  // The readers' real URLs, sent to this server instead: path and query kept.
  const fetchVia: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      ...init,
      redirect: "manual",
    });
  };
  return { seen, fetch: fetchVia };
}

/** A JWT with the given claims, unsigned: the readers only decode it. */
const jwt = (claims: object) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

// --- GitHub Copilot ---------------------------------------------------------------------------

const COPILOT_USER = {
  copilot_plan: "individual",
  access_type_sku: "plus_monthly_subscriber_quota",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 114,
      percent_remaining: 38,
      unlimited: false,
      quota_id: "premium_interactions",
    },
    chat: {
      entitlement: 0,
      remaining: 0,
      percent_remaining: 100,
      unlimited: true,
      quota_id: "chat",
    },
    // An org seat's placeholder: nothing to show.
    completions: {
      entitlement: 0,
      remaining: 0,
      unlimited: false,
      quota_id: "completions",
    },
  },
};

test("Copilot: quota snapshots become monthly windows, unlimited and placeholder ones are left out", () => {
  const read = parseCopilotUser(COPILOT_USER, "alto");
  assert.equal(read.label, "individual · alto");
  assert.deepEqual(read.windows, [
    {
      name: "premium",
      kind: "monthly",
      unit: "premium requests",
      usedPercent: 62,
      used: 186,
      limit: 300,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  ]);
  // Copilot Free before quota snapshots: the month's allowance and what is left of it.
  const free = parseCopilotUser({
    copilot_plan: "free",
    limited_user_reset_date: "2026-12-05",
    monthly_quotas: { chat: 50, completions: 2000 },
    limited_user_quotas: { chat: 40, completions: 1500 },
  });
  assert.deepEqual(
    free.windows.map((w) => [
      w.name,
      w.usedPercent,
      w.used,
      w.limit,
      w.resetsAt,
    ]),
    [
      ["chat", 20, 10, 50, "2026-12-05T00:00:00.000Z"],
      ["completions", 25, 500, 2000, "2026-12-05T00:00:00.000Z"],
    ],
  );
  assert.throws(
    () => parseCopilotUser({ access_type_sku: "subscription_ended" }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-available",
  );
});

test("Copilot: the token comes from apps.json, hosts.json, gh's hosts.yml, then gh auth token", async (t) => {
  const home = await tempHome(t);
  const env = { XDG_CONFIG_HOME: path.join(home, ".config") };
  const noGh = async () => undefined;
  assert.equal(
    await findCopilotToken({ home, env, platform: "darwin", ghToken: noGh }),
    undefined,
  );

  // gh's own answer is the last resort.
  assert.deepEqual(
    await findCopilotToken({
      home,
      env,
      platform: "darwin",
      ghToken: async () => GH_TOKEN,
    }),
    { token: GH_TOKEN },
  );

  await mkdir(path.join(home, ".config", "gh"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "gh", "hosts.yml"),
    `github.com:\n    user: alto\n    oauth_token: ${GH_TOKEN}\n    git_protocol: https\n`,
  );
  assert.deepEqual(
    await findCopilotToken({ home, env, platform: "darwin", ghToken: noGh }),
    { token: GH_TOKEN, login: "alto" },
  );

  await mkdir(path.join(home, ".config", "github-copilot"), {
    recursive: true,
  });
  await writeFile(
    path.join(home, ".config", "github-copilot", "apps.json"),
    JSON.stringify({
      "github.com:Iv1.0000000000000000": {
        user: "vertex",
        oauth_token: "ghu_madeUpAppsJsonToken0123456789abc",
        githubAppId: "Iv1.0000000000000000",
      },
    }),
  );
  assert.deepEqual(
    await findCopilotToken({ home, env, platform: "darwin", ghToken: noGh }),
    { token: "ghu_madeUpAppsJsonToken0123456789abc", login: "vertex" },
  );

  // A host other than github.com is not this meter's.
  assert.equal(
    copilotTokenFromFile({ "ghe.example.com": { oauth_token: GH_TOKEN } }),
    undefined,
  );
  assert.equal(
    ghTokenFromHosts(`ghe.example.com:\n    oauth_token: ${GH_TOKEN}\n`),
    undefined,
  );
});

test("Copilot: reads with the token scheme and Copilot Chat's headers", async (t) => {
  const home = await tempHome(t);
  const provider = await fakeProvider(t, () => ({
    status: 200,
    body: COPILOT_USER,
  }));
  const read = await readCopilot({
    home,
    env: {},
    platform: "linux",
    ghToken: async () => GH_TOKEN,
    fetch: provider.fetch,
    now: () => NOW,
  });
  assert.equal(read.windows[0]?.usedPercent, 62);
  const [request] = provider.seen;
  assert.equal(request?.url, "/copilot_internal/user");
  assert.equal(request?.headers.authorization, `token ${GH_TOKEN}`);
  assert.equal(request?.headers["editor-version"], "vscode/1.96.2");
  assert.equal(request?.headers["x-github-api-version"], "2025-04-01");

  // No Copilot on the account; a token GitHub no longer takes; no token at all.
  for (const [status, issue] of [
    [404, "not-available"],
    [401, "expired"],
  ] as const) {
    const refusing = await fakeProvider(t, () => ({
      status,
      body: { message: "x" },
    }));
    await assert.rejects(
      readCopilot({
        home,
        env: {},
        platform: "linux",
        ghToken: async () => GH_TOKEN,
        fetch: refusing.fetch,
      }),
      (e: unknown) => e instanceof MeterError && e.issue === issue,
    );
  }
  await assert.rejects(
    readCopilot({
      home,
      env: {},
      platform: "linux",
      ghToken: async () => undefined,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-signed-in",
  );
});

// --- Cursor -----------------------------------------------------------------------------------

const CURSOR_SUMMARY = {
  billingCycleStart: "2026-11-05T00:00:00.000Z",
  billingCycleEnd: "2026-12-05T00:00:00.000Z",
  membershipType: "pro",
  limitType: "user",
  isUnlimited: false,
  individualUsage: {
    plan: {
      enabled: true,
      used: 1820,
      limit: 2000,
      remaining: 180,
      breakdown: { included: 1820, bonus: 0, total: 1820 },
      autoPercentUsed: 40,
      apiPercentUsed: 51,
      totalPercentUsed: 91,
    },
    onDemand: { enabled: true, used: 250, limit: 1000, remaining: 750 },
  },
};

test("Cursor: the usage summary becomes the month's plan budget, its shares and on-demand spend", () => {
  const read = parseCursorSummary(CURSOR_SUMMARY);
  assert.equal(read.label, "pro");
  assert.deepEqual(
    read.windows.map((w) => [
      w.name,
      w.unit,
      w.usedPercent,
      w.used,
      w.limit,
      w.resetsAt,
    ]),
    [
      ["included", "$", 91, 18.2, 20, "2026-12-05T00:00:00.000Z"],
      ["auto", "$", 40, undefined, undefined, "2026-12-05T00:00:00.000Z"],
      ["api", "$", 51, undefined, undefined, "2026-12-05T00:00:00.000Z"],
      ["on-demand", "$", 25, 2.5, 10, "2026-12-05T00:00:00.000Z"],
    ],
  );
  // An older plan counted in requests.
  assert.deepEqual(
    parseCursorLegacyUsage({
      "gpt-4": { numRequests: 120, maxRequestUsage: 500 },
      startOfMonth: "2026-11-10T00:00:00.000Z",
    }),
    [
      {
        name: "requests",
        kind: "monthly",
        unit: "requests",
        usedPercent: 24,
        used: 120,
        limit: 500,
        resetsAt: "2026-12-10T00:00:00.000Z",
      },
    ],
  );
});

test("Cursor: the session cookie carries the token's user and is refused within a minute of its end", () => {
  const token = jwt({ sub: "auth0|user_01ALTO", exp: NOW / 1000 + 3600 });
  assert.deepEqual(cursorSessionCookie(token, NOW), {
    cookie: `WorkosCursorSessionToken=user_01ALTO%3A%3A${token}`,
    userId: "user_01ALTO",
  });
  assert.throws(
    () =>
      cursorSessionCookie(jwt({ sub: "auth0|u1", exp: NOW / 1000 + 30 }), NOW),
    (e: unknown) => e instanceof MeterError && e.issue === "expired",
  );
  assert.throws(
    () => cursorSessionCookie("not-a-jwt", NOW),
    (e: unknown) => e instanceof MeterError && e.issue === "unsupported",
  );
});

async function cursorState(home: string, value: string) {
  const file = cursorStatePath(home, {}, "darwin");
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "create table if not exists ItemTable (key text unique on conflict replace, value blob)",
  );
  db.prepare("insert into ItemTable (key, value) values (?, ?)").run(
    "cursorAuth/accessToken",
    value,
  );
  db.close();
}

test("Cursor: reads the token from the app's state.vscdb and sends it only as the dashboard cookie", async (t) => {
  const home = await tempHome(t);
  const token = jwt({ sub: "auth0|user_01ALTO", exp: NOW / 1000 + 3600 });
  await assert.rejects(
    readCursor({ home, env: {}, platform: "darwin", now: () => NOW }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-signed-in",
  );
  await cursorState(home, token);
  const provider = await fakeProvider(t, () => ({
    status: 200,
    body: CURSOR_SUMMARY,
  }));
  const read = await readCursor({
    home,
    env: {},
    platform: "darwin",
    now: () => NOW,
    fetch: provider.fetch,
  });
  assert.equal(read.windows.length, 4);
  assert.equal(provider.seen.length, 1);
  assert.equal(provider.seen[0]?.url, "/api/usage-summary");
  assert.equal(
    provider.seen[0]?.headers.cookie,
    `WorkosCursorSessionToken=user_01ALTO%3A%3A${token}`,
  );
  assert.equal(provider.seen[0]?.headers.authorization, undefined);

  // A plan with no budget in the summary falls back to the request count.
  const legacy = await fakeProvider(t, (url) =>
    url.startsWith("/api/usage?")
      ? {
          status: 200,
          body: { "gpt-4": { numRequests: 50, maxRequestUsage: 500 } },
        }
      : { status: 200, body: { membershipType: "pro" } },
  );
  const old = await readCursor({
    home,
    env: {},
    platform: "darwin",
    now: () => NOW,
    fetch: legacy.fetch,
  });
  assert.equal(old.windows[0]?.name, "requests");
  assert.equal(legacy.seen[1]?.url, "/api/usage?user=user_01ALTO");

  // Encrypted with the app's Keychain key: never opened, never sent.
  await cursorState(home, "cursor-safe-storage:v1:djEwAAAA");
  const untouched = await fakeProvider(t, () => ({
    status: 200,
    body: CURSOR_SUMMARY,
  }));
  await assert.rejects(
    readCursor({
      home,
      env: {},
      platform: "darwin",
      now: () => NOW,
      fetch: untouched.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "encrypted",
  );
  assert.equal(untouched.seen.length, 0);
});

// --- Gemini CLI -------------------------------------------------------------------------------

const GEMINI_QUOTA = {
  buckets: [
    {
      modelId: "gemini-3-pro-preview",
      tokenType: "REQUESTS",
      remainingFraction: 0.8,
      resetTime: "2026-11-24T08:00:00Z",
    },
    {
      modelId: "gemini-2.5-pro",
      tokenType: "REQUESTS",
      remainingFraction: 0.66,
      resetTime: "2026-11-24T07:00:00Z",
    },
    {
      modelId: "gemini-2.5-flash",
      tokenType: "REQUESTS",
      remainingFraction: 0.9,
      resetTime: "2026-11-24T07:00:00Z",
    },
    {
      modelId: "gemini-2.5-flash-lite",
      tokenType: "REQUESTS",
      remainingFraction: 1,
      resetTime: "2026-11-24T07:00:00Z",
    },
    { modelId: "text-embedding", tokenType: "REQUESTS", remainingFraction: 0 },
  ],
};

test("Gemini CLI: each model family's least-left bucket becomes a daily window", () => {
  assert.deepEqual(parseGeminiQuota(GEMINI_QUOTA), [
    {
      name: "pro",
      kind: "daily",
      unit: "requests",
      usedPercent: 34,
      resetsAt: "2026-11-24T07:00:00.000Z",
    },
    {
      name: "flash",
      kind: "daily",
      unit: "requests",
      usedPercent: 10,
      resetsAt: "2026-11-24T07:00:00.000Z",
    },
    {
      name: "flash-lite",
      kind: "daily",
      unit: "requests",
      usedPercent: 0,
      resetsAt: "2026-11-24T07:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    parseLoadCodeAssist({
      currentTier: { id: "standard-tier", name: "Standard" },
      cloudaicompanionProject: "alto-project-1",
    }),
    {
      label: "Standard",
      project: "alto-project-1",
    },
  );
  // A personal account since 2026-06-18: no current tier, its tiers ineligible.
  assert.throws(
    () =>
      parseLoadCodeAssist({
        ineligibleTiers: [
          { reasonCode: "UNSUPPORTED_CLIENT", tierId: "free-tier" },
        ],
      }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-available",
  );
});

async function geminiHome(
  t: test.TestContext,
  creds: object,
  settings?: object,
) {
  const home = await tempHome(t);
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  await writeFile(
    path.join(home, ".gemini", "oauth_creds.json"),
    JSON.stringify(creds),
  );
  if (settings)
    await writeFile(
      path.join(home, ".gemini", "settings.json"),
      JSON.stringify(settings),
    );
  return home;
}

test("Gemini CLI: reads the tier then the quota with the saved token, and never renews it", async (t) => {
  const creds = {
    access_token: "ya29.madeUpGeminiToken",
    refresh_token: "1//madeUpRefresh",
    expiry_date: NOW + 3_600_000,
  };
  const home = await geminiHome(t, creds, {
    security: { auth: { selectedType: "oauth-personal" } },
  });
  const provider = await fakeProvider(t, (url) =>
    url.endsWith(":loadCodeAssist")
      ? {
          status: 200,
          body: {
            currentTier: { id: "standard-tier", name: "Standard" },
            cloudaicompanionProject: { id: "alto-project-1" },
          },
        }
      : { status: 200, body: GEMINI_QUOTA },
  );
  const read = await readGeminiCli({
    home,
    now: () => NOW,
    fetch: provider.fetch,
  });
  assert.equal(read.label, "Standard");
  assert.deepEqual(
    read.windows.map((w) => w.name),
    ["pro", "flash", "flash-lite"],
  );
  assert.deepEqual(
    provider.seen.map((r) => [r.method, r.url]),
    [
      ["POST", "/v1internal:loadCodeAssist"],
      ["POST", "/v1internal:retrieveUserQuota"],
    ],
  );
  assert.equal(
    provider.seen[0]?.headers.authorization,
    "Bearer ya29.madeUpGeminiToken",
  );
  assert.deepEqual(JSON.parse(provider.seen[1]?.body ?? ""), {
    project: "alto-project-1",
  });
  // Nothing was sent to Google's token endpoint, and the saved file is untouched.
  assert.ok(provider.seen.every((r) => !r.url.includes("token")));
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(home, ".gemini", "oauth_creds.json"), "utf8"),
    ),
    creds,
  );
});

test("Gemini CLI: a personal account, an API key and an ended token each say why", async (t) => {
  const valid = { access_token: "ya29.madeUp", expiry_date: NOW + 3_600_000 };
  const personal = await fakeProvider(t, () => ({
    status: 200,
    body: { ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }] },
  }));
  await assert.rejects(
    readGeminiCli({
      home: await geminiHome(t, valid),
      now: () => NOW,
      fetch: personal.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-available",
  );
  const refused = await fakeProvider(t, () => ({
    status: 403,
    body: {
      error: { status: "PERMISSION_DENIED", message: "UNSUPPORTED_CLIENT" },
    },
  }));
  await assert.rejects(
    readGeminiCli({
      home: await geminiHome(t, valid),
      now: () => NOW,
      fetch: refused.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-available",
  );

  const untouched = await fakeProvider(t, () => ({ status: 200, body: {} }));
  await assert.rejects(
    readGeminiCli({
      home: await geminiHome(t, valid, {
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
      now: () => NOW,
      fetch: untouched.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "unsupported-auth",
  );
  await assert.rejects(
    readGeminiCli({
      home: await geminiHome(t, { ...valid, expiry_date: NOW + 10_000 }),
      now: () => NOW,
      fetch: untouched.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "expired",
  );
  await assert.rejects(
    readGeminiCli({
      home: await tempHome(t),
      now: () => NOW,
      fetch: untouched.fetch,
    }),
    (e: unknown) => e instanceof MeterError && e.issue === "not-signed-in",
  );
  assert.equal(untouched.seen.length, 0);
});

// --- The service ------------------------------------------------------------------------------

test("the service reads only enabled meters, at most every interval, and keeps the last windows on a failure", async () => {
  let now = NOW;
  let enabled: MeterProvider[] = [];
  const calls: MeterProvider[] = [];
  let fail = false;
  const reader = (provider: MeterProvider) => async () => {
    calls.push(provider);
    if (fail)
      throw new MeterError(
        "rate-limited",
        now + 30 * 60_000,
        `${provider} 429`,
      );
    return {
      label: "pro",
      windows: [
        {
          name: "included" as const,
          kind: "monthly" as const,
          unit: "$" as const,
          usedPercent: 50,
        },
      ],
    };
  };
  const logs: string[] = [];
  let changes = 0;
  const service = new MeterService({
    enabled: () => enabled,
    readers: {
      copilot: reader("copilot"),
      cursor: reader("cursor"),
      "gemini-cli": reader("gemini-cli"),
    },
    now: () => now,
    onChange: () => changes++,
    log: (line) => logs.push(line),
  });
  // Off: nothing is read and nothing is shown.
  await service.tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(service.snapshot(), []);

  enabled = ["cursor"];
  await service.tick();
  assert.deepEqual(calls, ["cursor"]);
  assert.equal(changes, 1);
  assert.deepEqual(service.snapshot(), [
    {
      provider: "cursor",
      label: "pro",
      windows: [
        { name: "included", kind: "monthly", unit: "$", usedPercent: 50 },
      ],
      source: "unofficial",
      readAt: new Date(NOW).toISOString(),
    },
  ]);
  // Within ten minutes, not again; off and on again does not read sooner either.
  now += 9 * 60_000;
  enabled = [];
  await service.tick();
  enabled = ["cursor"];
  await service.tick();
  assert.deepEqual(calls, ["cursor"]);

  now += 60_000;
  fail = true;
  await service.tick();
  assert.deepEqual(calls, ["cursor", "cursor"]);
  const [failed] = service.snapshot();
  assert.equal(failed?.windows.length, 1);
  assert.equal(failed?.readAt, new Date(NOW).toISOString());
  assert.deepEqual(failed?.error, {
    issue: "rate-limited",
    retryAt: new Date(now + 30 * 60_000).toISOString(),
  });
  assert.deepEqual(logs, ["cursor: rate-limited (cursor 429)"]);
  // The provider asked for 30 minutes: ten are not enough.
  now += 10 * 60_000;
  await service.tick();
  assert.deepEqual(calls, ["cursor", "cursor"]);
});

test("a meter's reading carries no token, from the reader to the window's snapshot", async (t) => {
  const home = await tempHome(t);
  const provider = await fakeProvider(t, () => ({
    status: 200,
    body: COPILOT_USER,
  }));
  const service = new MeterService({
    enabled: () => ["copilot"],
    readers: {
      copilot: () =>
        readCopilot({
          home,
          env: {},
          platform: "linux",
          ghToken: async () => GH_TOKEN,
          fetch: provider.fetch,
        }),
    },
    now: () => NOW,
  });
  await service.tick();
  const snapshot = JSON.stringify(service.snapshot());
  assert.match(snapshot, /"premium"/);
  assert.ok(!snapshot.includes(GH_TOKEN));
  assert.ok(!/token|oauth|cookie/i.test(snapshot));
});

// --- Settings and consent ---------------------------------------------------------------------

test("turning a meter on needs its risk accepted, in main and in the window", () => {
  // Each meter is R1 on the limits rung, with its maker's terms, allow-listed, and English text.
  for (const id of [
    "meter-copilot",
    "meter-gemini-cli",
    "meter-cursor",
  ] as const) {
    const risk = FEATURE_RISKS[id];
    assert.equal(risk.level, "R1");
    assert.equal(risk.rung, 2);
    assert.ok(isExternalLink(POLICY_LINKS[risk.links[0]!].href), id);
    assert.ok(en[risk.title] && en[risk.body], id);
  }
  assert.match(
    en["featureRisk.meterCursorBody"],
    /harvesting, scraping or extracting/,
  );
  assert.match(en["featureRisk.meterGeminiCliBody"], /direct violation/);

  assert.deepEqual(meterRisks(undefined, ["cursor", "copilot"]), [
    "meter-cursor",
    "meter-copilot",
  ]);
  assert.deepEqual(meterRisks(["cursor"], ["cursor"]), []);
  assert.deepEqual(meterRisks(["cursor"], []), []);
  const message = (pending: string[]) => `accept ${pending.join("+")}`;
  assert.throws(
    () =>
      requireRiskAck(
        DEFAULT_SETTINGS,
        meterRisks(undefined, ["gemini-cli"]),
        message,
      ),
    /accept meter-gemini-cli/,
  );
  assert.doesNotThrow(() =>
    requireRiskAck(
      { riskAcknowledged: acknowledgeRisks({}, ["meter-gemini-cli"]) },
      meterRisks(undefined, ["gemini-cli"]),
      message,
    ),
  );

  // Main checks the patch before it saves it, and reads only meters whose risk is accepted.
  const main = mainSource();
  const handler =
    /handle\("update-settings"[\s\S]*?(?=\n  handle\()/.exec(main)?.[0] ?? "";
  assert.match(
    handler,
    /requireRisk\(meterRisks\([\s\S]*?service\.store\.update/,
  );
  assert.match(
    main,
    /enabledMeters\(settings\)\.filter\(\(provider\) => !needsRiskAck\(settings, meterRisk\(provider\)\)\)/,
  );

  // A meter turned on without the answer (a restored backup) is asked about, and "Turn it off" keeps the rest.
  const state = {
    earlyStart: false,
    accounts: [],
    meters: ["copilot", "cursor"] as MeterProvider[],
  };
  assert.deepEqual(enabledRisks(state), ["meter-copilot", "meter-cursor"]);
  assert.deepEqual(turnOffSteps(["meter-cursor"], state), [
    { kind: "meters", keep: ["copilot"] },
  ]);
});

test("the meters setting is optional, each meter once, and a patch can carry it", () => {
  const saved = {
    ...DEFAULT_SETTINGS,
    planning: { ...DEFAULT_SETTINGS.planning },
  };
  assert.equal(settingsSchema.parse(saved).meters, undefined);
  assert.deepEqual(
    settingsSchema.parse({ ...saved, meters: ["copilot", "gemini-cli"] })
      .meters,
    ["copilot", "gemini-cli"],
  );
  assert.equal(
    settingsSchema.safeParse({ ...saved, meters: ["copilot", "copilot"] })
      .success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...saved, meters: ["made-up"] }).success,
    false,
  );
  assert.deepEqual(settingsPatchSchema.parse({ meters: ["cursor"] }), {
    meters: ["cursor"],
  });
});

// --- Overview ---------------------------------------------------------------------------------

const READINGS: MeterReading[] = [
  {
    provider: "copilot",
    label: "individual · alto",
    source: "unofficial",
    readAt: new Date(NOW - 4 * 60_000).toISOString(),
    windows: [
      {
        name: "premium",
        kind: "monthly",
        unit: "premium requests",
        usedPercent: 62,
        used: 186,
        limit: 300,
        resetsAt: new Date(NOW + 8 * 86_400_000).toISOString(),
      },
    ],
  },
  {
    provider: "cursor",
    label: "pro",
    source: "unofficial",
    readAt: new Date(NOW - 9 * 60_000).toISOString(),
    windows: [
      {
        name: "included",
        kind: "monthly",
        unit: "$",
        usedPercent: 91,
        used: 18.2,
        limit: 20,
        resetsAt: new Date(NOW + 12 * 86_400_000).toISOString(),
      },
    ],
  },
  {
    provider: "gemini-cli",
    source: "unofficial",
    windows: [],
    error: { issue: "not-available" },
  },
];

const overview = (meters: MeterReading[] | undefined) =>
  renderToStaticMarkup(
    createElement(
      RelayContext.Provider,
      {
        value: {
          data: {
            settings: DEFAULT_SETTINGS,
            usage: {},
            accounts: [],
            ...(meters ? { meters } : {}),
          } as unknown as Snapshot,
        } as unknown as Relay,
      },
      createElement(
        I18nContext.Provider,
        { value: i18nValue("en") },
        createElement(MetersCard, { now: NOW }),
      ),
    ),
  );

test("the Overview shows a row per enabled meter with its plan, its bars and its source", () => {
  assert.equal(overview(undefined), "");
  assert.equal(overview([]), "");
  const html = overview(READINGS);
  const rows = [...html.matchAll(/data-meter="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ["copilot", "cursor", "gemini-cli"]);
  assert.match(html, /GitHub Copilot[\s\S]*?individual · alto/);
  assert.match(html, /Premium requests[\s\S]*?62%/);
  // Its own reset, and the amount, source and age in the tooltip, as a limit line words them.
  assert.match(
    html,
    /title="Premium requests 186 of 300 62% · 8 d\nSource: Unofficial endpoint · 4 min ago"/,
  );
  assert.match(
    html,
    /title="Plan budget \$18\.20 of \$20\.00 91% · 12 d\nSource: Unofficial endpoint · 9 min ago"/,
  );
  // Gemini CLI's refusal says whom it leaves out, inline.
  assert.match(
    html,
    /data-issue="not-available"[^>]*>Not available for personal Google accounts\./,
  );
});
