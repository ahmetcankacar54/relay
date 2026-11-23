import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { readFileSync } from "node:fs";
import { testT } from "./i18n";
import {
  claudeCodeSnippet,
  clientHost,
  codexSnippet,
  gatewayUrl,
  isLoopbackHost,
  maskKey,
  parsePort,
  resetLabel,
  validHost,
} from "../src/lib/proxy-ui";

const KEY = "relay-sec-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const t = testT("tr");
const en = testT("en");

test("the client address is one a client can dial, and the key shows only its tail", () => {
  assert.equal(gatewayUrl("127.0.0.1", 8317), "http://127.0.0.1:8317");
  assert.equal(clientHost("0.0.0.0"), "127.0.0.1");
  assert.equal(clientHost("::"), "[::1]");
  assert.equal(clientHost("fd7a::1"), "[fd7a::1]");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("100.64.0.2"), false);
  assert.equal(maskKey(KEY), "relay-sec-••••••••••••DEFG");
  assert.doesNotMatch(maskKey(KEY), /abcdef/);
  assert.equal(maskKey("relay-sec-ab"), "relay-sec-••");
});

test("the setup snippets carry the address and the key, or a placeholder before there is one", () => {
  assert.equal(
    claudeCodeSnippet("127.0.0.1", 8317, KEY),
    `export ANTHROPIC_BASE_URL=http://127.0.0.1:8317 && export ANTHROPIC_AUTH_TOKEN=${KEY} && export CLAUDE_CODE_PROMPT_CACHE_TTL=1h`,
  );
  assert.match(claudeCodeSnippet("127.0.0.1", 8317, KEY, true), /ANTHROPIC_AUTH_TOKEN=relay-sec-••••/);
  assert.match(claudeCodeSnippet("127.0.0.1", 8317, undefined), /ANTHROPIC_AUTH_TOKEN=<relay-key> /);
  assert.equal(
    codexSnippet("127.0.0.1", 9000, KEY),
    `export OPENAI_BASE_URL=http://127.0.0.1:9000/v1 && export OPENAI_API_KEY=${KEY}`,
  );
});

test("port and host fields accept only what the gateway accepts", () => {
  assert.equal(parsePort("8317"), 8317);
  assert.equal(parsePort(" 65535 "), 65535);
  for (const bad of ["", "0", "65536", "80a", "1.5", "-1", "123456"]) assert.equal(parsePort(bad), undefined, bad);
  assert.equal(validHost("127.0.0.1"), true);
  assert.equal(validHost("::1"), true);
  for (const bad of ["", "  ", "a b", "http://x", "a@b", "x?y"]) assert.equal(validHost(bad), false, bad);
});

test("a reset reads as time left, in both languages", () => {
  assert.equal(resetLabel(undefined, t), "—");
  assert.equal(resetLabel(0, t), "şimdi");
  assert.equal(resetLabel(5, t), "5 dk");
  assert.equal(resetLabel(130, t), "2 sa 10 dk");
  assert.equal(resetLabel(120, en), "2 h");
  assert.equal(resetLabel(3 * 1440 + 125, en), "3 d 2 h");
});

test("main, the preload and the desktop snapshot carry the gateway; quitting stops it", () => {
  const main = mainSource();
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  for (const name of ["proxy-status", "proxy-toggle", "proxy-configure", "proxy-regenerate-key", "proxy-bind-client", "proxy-unbind-client"]) {
    assert.match(main, new RegExp(`handle\\("${name}"`), name);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\("relay:${name}"`), name);
  }
  assert.match(main, /proxyStatus: proxyStatus\(\)/);
  assert.match(main, /settings\.proxy\?\.enabled\)\s*void serializeProxy\(startProxy\)/);
  assert.match(main, /app\.on\("will-quit", \(\) => \{[\s\S]*?proxyServer\?\.stop\(\)/);
});
